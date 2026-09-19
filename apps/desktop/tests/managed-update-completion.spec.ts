import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { completeDesktopManagedUpdate } from '../src/managed-update-completion.ts'
import { parseDesktopManagedUpdateHandoff } from '../src/managed-update-protocol.ts'
import { loadDesktopManagedUpdateConfiguration } from '../src/managed-update-state.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import {
  MANAGED_COMMIT,
  managedCapability,
  managedManifest,
} from './managed-update-fixture.ts'
import {
  DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
  desktopPluginProvisioningPlanSha256,
  parseDesktopPluginProvisioningPlan,
  type DesktopPluginProvisioningResult,
} from '../src/plugin-provisioning.ts'
import { DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY } from '../src/plugin-source.ts'

const roots: string[] = []
const sha256 = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex')

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function completionFixture(sequence = 2) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-reconciliation-'))
  roots.push(root)
  const operationsRoot = join(root, 'operations')
  await mkdir(operationsRoot)
  const executable = join(root, 'desktop.exe')
  const runtime = join(root, 'desktop-runtime.json')
  const planPath = join(root, 'desktop-provisioning.json')
  const profile = join(root, 'profile')
  const completionPath = join(root, 'completion.json')
  const plan = parseDesktopPluginProvisioningPlan({ schemaVersion: 1, mode: 'exact', plugins: [] })
  const planSha256 = desktopPluginProvisioningPlanSha256(plan)
  const capability = managedCapability({ currentSequence: sequence, provisioning: {
    capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY, planSha256,
  } })
  const manifest = managedManifest({
    sequence,
    installedEvidence: {
      executableSha256: sha256(Buffer.from('installed desktop')),
      runtimeSha256: sha256(Buffer.from('installed runtime')),
    },
  })
  await writeFile(executable, 'installed desktop')
  await writeFile(runtime, 'installed runtime')
  await writeFile(planPath, JSON.stringify(plan))
  createPluginProfile(profile)
  await writeFile(join(profile, 'desktop-plugin-provisioning-state.json'), JSON.stringify({
    schemaVersion: 1, capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
    planSha256, composition: 'active', plugins: [], removed: [], rolledBack: false, verified: true,
  }))
  const complete = (completedSequence = 0) => completeDesktopManagedUpdate(
    operationsRoot, completionPath, capability, completedSequence, executable, runtime, planPath, profile, () => false,
  )
  const operation = async (
    character: string,
    state: 'legacy-pre-install' | 'pre-install' | 'success' | 'blocked' | 'interrupted',
    release = manifest,
  ) => {
    const token = character.repeat(64)
    const path = join(operationsRoot, token)
    const stage = join(path, 'stage')
    await mkdir(path)
    const body = JSON.stringify(release)
    await writeFile(join(path, 'handoff.json'), JSON.stringify({
      schemaVersion: 1, token, capability,
      selection: {
        kind: 'source', manifestUrl: `https://github.com/cloga/deepseek-harness/releases/download/${release.source.tag}/release.json`,
        manifestSha256: release.manifestSha256, assetSha256: sha256(Buffer.from(body)),
      },
      stageRoot: stage, waitPids: [123], waitTimeoutMs: 1000, installedSequence: 0,
    }))
    await writeFile(join(path, 'ack.json'), JSON.stringify({
      schemaVersion: 1, token, manifestSha256: release.manifestSha256, helperPid: 123,
    }))
    const identity = { schemaVersion: 1, manifestSha256: release.manifestSha256, sequence: release.sequence }
    if (state === 'legacy-pre-install' || state === 'pre-install') {
      await writeFile(join(path, 'helper-result.json'), JSON.stringify({
        ...identity, status: 'blocked', reason: 'receipt download failed',
        ...(state === 'pre-install' ? {
          phase: 'receipt-download', asset: 'build-receipt', errorType: 'network', installationState: 'not-started',
        } : {}),
      }))
      if (state === 'pre-install') await writeFile(join(path, 'release.json'), body)
    } else {
      await mkdir(stage)
      await writeFile(join(stage, 'release.json'), body)
      await writeFile(join(stage, 'pending-completion.json'), JSON.stringify({ ...identity, installedEvidence: release.installedEvidence }))
      await writeFile(join(path, 'install-started.json'), JSON.stringify({ ...identity, token }))
      if (state !== 'interrupted') await writeFile(join(stage, 'helper-result.json'), JSON.stringify(state === 'success'
        ? { ...identity, status: 'installer-exited', installerExitCode: 0, pendingCompletion: true }
        : { ...identity, status: 'blocked', reason: 'installer-exit-1', installerExitCode: 1 }))
    }
    return path
  }
  return { root, operationsRoot, executable, runtime, planPath, profile, completionPath, capability, manifest, complete, operation }
}

async function patchRecord(path: string, fields: Record<string, unknown>): Promise<void> {
  const value = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
  await writeFile(path, JSON.stringify({ ...value, ...fields }))
}

function historicalCapability(current: ReturnType<typeof managedCapability>, migration = false): Record<string, unknown> {
  const value: Record<string, unknown> = { ...current, schemaVersion: 2 }
  delete value.provisioning
  if (migration) value.migration = {
    owner: 'cloga/dsh-windows-ops',
    manifestUrl: 'https://github.com/cloga/dsh-windows-ops/releases/download/dsh-v1.2.3/release.json',
    manifestSha256: 'c'.repeat(64), assetSha256: 'd'.repeat(64), maximumSequence: 1,
    expectedSource: { version: '1.2.3', commit: MANAGED_COMMIT },
  }
  return value
}

it.each([false, true])('reads a cancelled historical schema2 handoff without launch eligibility (migration %s)', async (migration) => {
  const fixture = await completionFixture()
  const operation = await fixture.operation('a', 'legacy-pre-install')
  await patchRecord(join(operation, 'handoff.json'), { capability: historicalCapability(fixture.capability, migration) })
  await writeFile(join(operation, 'cancelled.json'), JSON.stringify({ schemaVersion: 1, token: 'a'.repeat(64) }))
  const bytes = await readFile(join(operation, 'handoff.json'), 'utf8')
  expect(() => parseDesktopManagedUpdateHandoff(JSON.parse(bytes))).toThrow(/capability/u)
  await expect(fixture.complete()).resolves.toEqual({ status: 'none' })
  expect(await readFile(join(operation, 'handoff.json'), 'utf8')).toBe(bytes)
  await expect(readFile(fixture.completionPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each([false, true])('retains verified completed schema2 history without rewriting completion (migration %s)', async (migration) => {
  const fixture = await completionFixture()
  const operation = await fixture.operation('a', 'success')
  await expect(fixture.complete()).resolves.toMatchObject({ status: 'complete', sequence: 2 })
  const receipt = await readFile(fixture.completionPath, 'utf8')
  await patchRecord(join(operation, 'handoff.json'), { capability: historicalCapability(fixture.capability, migration) })
  await expect(fixture.complete(2)).resolves.toEqual({ status: 'none' })
  expect(await readFile(fixture.completionPath, 'utf8')).toBe(receipt)
})

it('recognizes two old-schema pre-install failures without promoting the installed sequence', async () => {
  const fixture = await completionFixture()
  for (const token of ['a', 'b']) {
    const operation = await fixture.operation(token, 'legacy-pre-install')
    await patchRecord(join(operation, 'handoff.json'), { capability: historicalCapability(fixture.capability) })
  }
  await expect(fixture.complete()).resolves.toEqual({ status: 'none' })
  await expect(readFile(fixture.completionPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['interrupted', 'blocked', 'cancelled-stage', 'invalid-cancellation', 'ack-hash', 'raw-manifest-hash'] as const)(
  'retained schema2 handoffs still require recovery for %s', async (kind) => {
    const fixture = await completionFixture()
    const state = kind === 'blocked' ? 'blocked' : kind === 'invalid-cancellation' ? 'legacy-pre-install' : 'interrupted'
    const operation = await fixture.operation('a', state)
    await patchRecord(join(operation, 'handoff.json'), { capability: historicalCapability(fixture.capability) })
    if (kind === 'cancelled-stage' || kind === 'invalid-cancellation') {
      await writeFile(join(operation, 'cancelled.json'), JSON.stringify({
        schemaVersion: 1, token: (kind === 'invalid-cancellation' ? 'b' : 'a').repeat(64),
      }))
    }
    if (kind === 'ack-hash') await patchRecord(join(operation, 'ack.json'), { manifestSha256: 'b'.repeat(64) })
    if (kind === 'raw-manifest-hash') await writeFile(join(operation, 'stage', 'release.json'), `${JSON.stringify(fixture.manifest)}\n`)
    await expect(fixture.complete()).resolves.toMatchObject({ status: 'recovery-required' })
    await expect(readFile(fixture.completionPath)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it.each(['missing', 'unknown-version', 'old-unknown-version', 'current-missing-provisioning', 'old-extra-provisioning',
  'old-owner', 'old-floor', 'old-migration-commit', 'old-migration-extra-source', 'wait-pids', 'timeout', 'installed-sequence',
  'selection-url', 'selection-digest', 'handoff-schema'] as const)(
  'does not use historical compatibility to bypass invalid handoff fields: %s', async (kind) => {
    const fixture = await completionFixture()
    const operation = await fixture.operation('a', 'legacy-pre-install')
    const capability = historicalCapability(fixture.capability, kind.startsWith('old-migration'))
    const fields: Record<string, unknown> = { capability }
    if (kind === 'missing') fields.capability = undefined
    if (kind === 'unknown-version') capability.schemaVersion = 4
    if (kind === 'old-unknown-version') capability.schemaVersion = 1
    if (kind === 'current-missing-provisioning') capability.schemaVersion = 3
    if (kind === 'old-extra-provisioning') capability.provisioning = fixture.capability.provisioning
    if (kind === 'old-owner') capability.owner = 'untrusted/repository'
    if (kind === 'old-floor') capability.minimumSequence = -1
    if (kind === 'old-migration-commit' || kind === 'old-migration-extra-source') {
      const migration = capability.migration as Record<string, unknown>
      const expectedSource = migration.expectedSource as Record<string, unknown>
      if (kind === 'old-migration-commit') expectedSource.commit = 'invalid'
      else expectedSource.tag = 'dsh-v1.2.3'
    }
    if (kind === 'wait-pids') fields.waitPids = [0]
    if (kind === 'timeout') fields.waitTimeoutMs = -1
    if (kind === 'installed-sequence') fields.installedSequence = -1
    if (kind === 'handoff-schema') fields.schemaVersion = 2
    if (kind === 'selection-url' || kind === 'selection-digest') fields.selection = {
      kind: 'source',
      manifestUrl: kind === 'selection-url' ? 'https://untrusted.example/release.json'
        : `https://github.com/cloga/deepseek-harness/releases/download/${fixture.manifest.source.tag}/release.json`,
      manifestSha256: fixture.manifest.manifestSha256,
      assetSha256: kind === 'selection-digest' ? 'invalid' : sha256(Buffer.from(JSON.stringify(fixture.manifest))),
    }
    await patchRecord(join(operation, 'handoff.json'), fields)
    await writeFile(join(operation, 'cancelled.json'), JSON.stringify({ schemaVersion: 1, token: 'a'.repeat(64) }))
    await expect(fixture.complete()).resolves.toMatchObject({ status: 'recovery-required' })
  },
)

const inventories = [
  'valid', 'missing-state', 'required-valid', 'required-artifact-drift',
  'required-receipt-drift', 'required-first-install', 'required-already-higher',
] as const
it.each(inventories)('requires active inventory before completion: %s', async (inventory) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-completion-'))
  roots.push(root)
  const userData = join(root, 'user-data')
  const operationsRoot = join(userData, 'managed-update', 'operations')
  const operation = join(operationsRoot, 'a'.repeat(64), 'stage')
  await mkdir(operation, { recursive: true })
  const executable = Buffer.from('desktop')
  const runtime = Buffer.from('runtime')
  const executablePath = join(root, 'DeepSeek Harness.exe')
  const runtimePath = join(root, 'desktop-runtime.json')
  const provisioningPath = join(root, 'desktop-provisioning.json')
  const required = inventory.startsWith('required-')
  const sequence = required ? 3 : 2
  const version = required ? '0.1.5-rc.3.cloga.2' : '1.2.3'
  const artifact = Buffer.from('completion fixture artifact')
  const provisioning = parseDesktopPluginProvisioningPlan({
    schemaVersion: 1, mode: 'exact',
    plugins: required ? [{
      required: true,
      source: {
        schemaVersion: 1, type: 'githubRelease', owner: 'cloga', repo: 'fixture-plugin',
        tag: 'v1.0.0', asset: 'fixture-plugin.tgz', assetId: 1,
        packageName: 'fixture-plugin', version: '1.0.0', size: artifact.length,
        sha256: sha256(artifact), targetCommit: MANAGED_COMMIT,
        checksumManifest: {
          format: 'sha256sums', asset: 'SHA256SUMS', assetId: 2,
          url: 'https://github.com/cloga/fixture-plugin/releases/download/v1.0.0/SHA256SUMS',
          size: 1, sha256: 'f'.repeat(64),
        },
      },
    }] : [],
  })
  await writeFile(executablePath, executable)
  await writeFile(runtimePath, runtime)
  await writeFile(provisioningPath, JSON.stringify(provisioning))
  const profile = join(root, 'profile')
  createPluginProfile(profile)
  const results: DesktopPluginProvisioningResult[] = []
  if (required) {
    const source = provisioning.plugins[0]!.source
    const receipt = {
      schemaVersion: 1, capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
      source, releaseId: 1, assetId: source.assetId,
      packageName: source.packageName, version: source.version, artifactSha256: source.sha256,
      states: { staged: true, health: 'passed', activated: true, rolledBack: false, verified: true },
    } as const
    const artifactDirectory = join(profile, '.desktop-plugin-artifacts')
    await mkdir(artifactDirectory)
    await writeFile(join(artifactDirectory, `${source.sha256}.tgz`),
      inventory === 'required-artifact-drift' ? Buffer.from('changed artifact') : artifact)
    await writeFile(join(profile, 'desktop-plugin-receipts.json'), JSON.stringify({
      schemaVersion: 1, receipts: { [source.packageName]: receipt },
    }))
    const profileManifest = JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    profileManifest.dependencies[source.packageName] = `file:.desktop-plugin-artifacts/${source.sha256}.tgz`
    profileManifest.dsh.profile.bundles.push(source.packageName)
    await writeFile(join(profile, 'package.json'), JSON.stringify(profileManifest))
    const plugin = join(profile, 'node_modules', source.packageName)
    await mkdir(plugin, { recursive: true })
    await writeFile(join(plugin, 'package.json'), JSON.stringify({
      name: source.packageName, version: source.version, dsh: { bundle: { patch: 'cordis.patch.yml' } },
    }))
    await writeFile(join(plugin, 'cordis.patch.yml'), '[]\n')
    results.push({
      name: source.packageName, version: source.version, required: true,
      status: 'active', source, receipt,
    })
  }
  if (inventory !== 'missing-state') {
    await writeFile(join(profile, 'desktop-plugin-provisioning-state.json'), JSON.stringify({
      schemaVersion: 1, capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
      planSha256: desktopPluginProvisioningPlanSha256(provisioning),
      composition: 'active', plugins: results, removed: [], rolledBack: false, verified: true,
    }))
  }
  if (inventory === 'required-receipt-drift') {
    await writeFile(join(profile, 'desktop-plugin-receipts.json'), JSON.stringify({ schemaVersion: 1, receipts: {} }))
  }
  const manifest = managedManifest({
    version, sequence, upstreamVersion: required ? '0.1.5-rc.2' : '1.2.2',
    source: {
      repository: 'cloga/deepseek-harness',
      commit: MANAGED_COMMIT,
      tree: 'b'.repeat(40),
      tag: `dsh-desktop-v${version}`,
    },
    installer: {
      file: 'installer.exe',
      bytes: 1,
      sha256: 'c'.repeat(64),
      sha512: 'YQ'.padEnd(86, 'A') + '==',
      signature: 'NotSigned',
    },
    buildReceipt: { file: 'build-receipt.json', sha256: 'd'.repeat(64), receiptSha256: 'e'.repeat(64) },
    installedEvidence: { executableSha256: sha256(executable), runtimeSha256: sha256(runtime) },
  })
  await writeFile(join(operation, 'release.json'), JSON.stringify(manifest))
  await writeFile(join(operation, 'helper-result.json'), JSON.stringify({
    schemaVersion: 1,
    status: 'installer-exited',
    manifestSha256: manifest.manifestSha256,
    sequence,
    installerExitCode: 0,
    pendingCompletion: true,
  }))
  await writeFile(join(operation, 'pending-completion.json'), JSON.stringify({
    schemaVersion: 1,
    manifestSha256: manifest.manifestSha256,
    sequence,
    installedEvidence: manifest.installedEvidence,
  }))
  const resources = join(root, 'resources')
  await mkdir(join(resources, 'managed-update'), { recursive: true })
  await writeFile(join(resources, 'managed-update', 'helper.mjs'), 'export {}\n')
  await writeFile(join(resources, 'managed-update', 'capability.json'), JSON.stringify(managedCapability({
    currentSequence: sequence,
    provisioning: {
      capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
      planSha256: desktopPluginProvisioningPlanSha256(provisioning),
    },
  })))
  const completionPath = join(userData, 'managed-update', 'completion.json')
  const previousSequence = inventory === 'required-first-install' ? 0
    : inventory === 'required-already-higher' ? 4 : sequence - 1
  if (previousSequence > 0) {
    await writeFile(completionPath, JSON.stringify({
      schemaVersion: 1, status: 'complete', sequence: previousSequence, manifestSha256: 'f'.repeat(64),
    }))
  }
  const configuration = await loadDesktopManagedUpdateConfiguration(resources, userData, 'win32')
  if (configuration === undefined) throw new Error('Fixture must select managed updates')
  expect(configuration.installedSequence).toBe(Math.max(sequence, previousSequence))
  expect(configuration.completedSequence).toBe(previousSequence)
  const result = await completeDesktopManagedUpdate(
    configuration.operationsRoot,
    completionPath,
    configuration.capability,
    configuration.completedSequence,
    executablePath,
    runtimePath,
    provisioningPath,
    profile,
  )
  if (inventory === 'valid' || inventory === 'required-valid' || inventory === 'required-first-install') {
    expect(result).toEqual({ status: 'complete', sequence, version })
    expect(JSON.parse(await readFile(completionPath, 'utf8'))).toMatchObject({ status: 'complete', sequence })
    const completedBytes = await readFile(completionPath, 'utf8')
    const restarted = await loadDesktopManagedUpdateConfiguration(resources, userData, 'win32')
    if (restarted === undefined) throw new Error('Restart must retain managed updates')
    expect(restarted.completedSequence).toBe(sequence)
    await expect(completeDesktopManagedUpdate(
      restarted.operationsRoot, restarted.completionPath, restarted.capability, restarted.completedSequence,
      executablePath, runtimePath, provisioningPath, profile,
    )).resolves.toEqual({ status: 'none' })
    expect(await readFile(completionPath, 'utf8')).toBe(completedBytes)
  } else if (inventory === 'required-already-higher') {
    expect(result).toEqual({ status: 'none' })
    expect(JSON.parse(await readFile(completionPath, 'utf8'))).toMatchObject({ status: 'complete', sequence: 4 })
  } else {
    expect(result.status).toBe('recovery-required')
    expect(JSON.parse(await readFile(completionPath, 'utf8'))).toMatchObject({
      status: 'complete', sequence: previousSequence,
    })
  }
})

it('requires recovery when the installed provisioning plan differs from the build capability', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-completion-'))
  roots.push(root)
  const operation = join(root, 'operations', 'a'.repeat(64), 'stage')
  await mkdir(operation, { recursive: true })
  const executable = Buffer.from('desktop')
  const runtime = Buffer.from('runtime')
  const executablePath = join(root, 'DeepSeek Harness.exe')
  const runtimePath = join(root, 'desktop-runtime.json')
  const provisioningPath = join(root, 'desktop-provisioning.json')
  await writeFile(executablePath, executable)
  await writeFile(runtimePath, runtime)
  await writeFile(provisioningPath, JSON.stringify({ schemaVersion: 1, mode: 'exact', plugins: [] }))
  const manifest = managedManifest({
    installer: {
      file: 'installer.exe',
      bytes: 1,
      sha256: 'c'.repeat(64),
      sha512: 'YQ'.padEnd(86, 'A') + '==',
      signature: 'NotSigned',
    },
    buildReceipt: { file: 'build-receipt.json', sha256: 'd'.repeat(64), receiptSha256: 'e'.repeat(64) },
    installedEvidence: { executableSha256: sha256(executable), runtimeSha256: sha256(runtime) },
  })
  await writeFile(join(operation, 'release.json'), JSON.stringify(manifest))
  await writeFile(join(operation, 'helper-result.json'), JSON.stringify({
    schemaVersion: 1,
    status: 'installer-exited',
    manifestSha256: manifest.manifestSha256,
    sequence: 2,
    installerExitCode: 0,
    pendingCompletion: true,
  }))
  await writeFile(join(operation, 'pending-completion.json'), JSON.stringify({
    schemaVersion: 1,
    manifestSha256: manifest.manifestSha256,
    sequence: 2,
    installedEvidence: manifest.installedEvidence,
  }))
  await expect(completeDesktopManagedUpdate(
    join(root, 'operations'),
    join(root, 'completion.json'),
    managedCapability({ provisioning: { ...managedCapability().provisioning, planSha256: 'f'.repeat(64) } }),
    1,
    executablePath,
    runtimePath,
    provisioningPath,
    join(root, 'profile'),
  )).resolves.toMatchObject({
    status: 'recovery-required',
    message: /provisioning plan does not match/u,
  })
})

it('requires recovery when a helper acknowledgement has no terminal state', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-completion-'))
  roots.push(root)
  const token = 'a'.repeat(64)
  const operation = join(root, 'operations', token)
  await mkdir(operation, { recursive: true })
  await writeFile(join(operation, 'ack.json'), JSON.stringify({
    schemaVersion: 1,
    token,
    manifestSha256: 'b'.repeat(64),
    helperPid: 123,
  }))

  await expect(completeDesktopManagedUpdate(
    join(root, 'operations'),
    join(root, 'completion.json'),
    managedCapability(),
    1,
    join(root, 'unused.exe'),
    join(root, 'unused-runtime.json'),
    join(root, 'unused-provisioning.json'),
    join(root, 'profile'),
  )).resolves.toMatchObject({
    status: 'recovery-required',
    message: /acknowledged the handoff/u,
  })
})

it.each([
  {
    name: 'missing terminal result',
    result: undefined,
    message: /interrupted/u,
  },
  {
    name: 'blocked installer result',
    result: {
      schemaVersion: 1,
      status: 'blocked',
      manifestSha256: 'a'.repeat(64),
      sequence: 2,
      reason: 'installer-exit-1',
      installerExitCode: 1,
    },
    message: /installer-exit-1/u,
  },
])('requires recovery for $name after staging', async ({ result, message }) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-completion-'))
  roots.push(root)
  const operation = join(root, 'operations', 'a'.repeat(64), 'stage')
  await mkdir(operation, { recursive: true })
  const manifest = managedManifest()
  await writeFile(join(operation, 'release.json'), JSON.stringify(manifest))
  await writeFile(join(operation, 'pending-completion.json'), JSON.stringify({
    schemaVersion: 1,
    manifestSha256: manifest.manifestSha256,
    sequence: 2,
    installedEvidence: manifest.installedEvidence,
  }))
  if (result !== undefined) {
    await writeFile(join(operation, 'helper-result.json'), JSON.stringify({ ...result, manifestSha256: manifest.manifestSha256 }))
  }

  await expect(completeDesktopManagedUpdate(
    join(root, 'operations'),
    join(root, 'completion.json'),
    managedCapability(),
    1,
    join(root, 'unused.exe'),
    join(root, 'unused-runtime.json'),
    join(root, 'unused-provisioning.json'),
    join(root, 'profile'),
  )).resolves.toMatchObject({ status: 'recovery-required', message })
})

it('ignores an operation explicitly cancelled by its owning Desktop process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-completion-'))
  roots.push(root)
  const token = 'a'.repeat(64)
  const operation = join(root, 'operations', token)
  await mkdir(operation, { recursive: true })
  await writeFile(join(operation, 'cancelled.json'), JSON.stringify({ schemaVersion: 1, token }))
  await writeFile(join(operation, 'helper-result.json'), JSON.stringify({
    schemaVersion: 1,
    status: 'blocked',
    manifestSha256: 'b'.repeat(64),
    sequence: 2,
    reason: 'desktop managed update: operation was cancelled',
  }))

  await expect(completeDesktopManagedUpdate(
    join(root, 'operations'),
    join(root, 'completion.json'),
    managedCapability(),
    1,
    join(root, 'unused.exe'),
    join(root, 'unused-runtime.json'),
    join(root, 'unused-provisioning.json'),
    join(root, 'profile'),
  )).resolves.toEqual({ status: 'none' })
})

it.each(['legacy-pre-install', 'pre-install'] as const)(
  'retains two %s failures without poisoning repeated cold startup or promoting the packaged sequence', async (state) => {
    const fixture = await completionFixture()
    const first = await fixture.operation('a', state)
    const second = await fixture.operation('b', state)
    await mkdir(join(first, `stage.tmp-${'a'.repeat(64)}`))
    const before = await Promise.all([first, second].map(path => readFile(join(path, 'helper-result.json'), 'utf8')))
    for (let startup = 0; startup < 2; startup++) {
      await expect(fixture.complete()).resolves.toEqual({ status: 'none' })
      await expect(readFile(fixture.completionPath)).rejects.toMatchObject({ code: 'ENOENT' })
    }
    expect(await Promise.all([first, second].map(path => readFile(join(path, 'helper-result.json'), 'utf8')))).toEqual(before)
  },
)

it.each(['a', 'f'])('completes a valid candidate despite multiple earlier or later root failures (%s)', async (successToken) => {
  const fixture = await completionFixture()
  await fixture.operation('c', 'legacy-pre-install')
  await fixture.operation('d', 'pre-install')
  await fixture.operation(successToken, 'success')
  await expect(fixture.complete()).resolves.toEqual({ status: 'complete', sequence: 2, version: fixture.manifest.version })
  await expect(fixture.complete(2)).resolves.toEqual({ status: 'none' })
})

it('does not let an unstarted future release block a verified current candidate', async () => {
  const fixture = await completionFixture()
  await fixture.operation('a', 'success')
  await fixture.operation('f', 'pre-install', managedManifest({ sequence: 3 }))
  await expect(fixture.complete()).resolves.toEqual({ status: 'complete', sequence: 2, version: fixture.manifest.version })
})

it('reconciles duplicate successful operations for the same independently verified release', async () => {
  const fixture = await completionFixture()
  await fixture.operation('a', 'success')
  await fixture.operation('b', 'success')
  await expect(fixture.complete()).resolves.toMatchObject({ status: 'complete', sequence: 2 })
})

it.each(['blocked', 'interrupted'] as const)('does not infer independent installation from a %s transaction alone', async (state) => {
  const fixture = await completionFixture()
  await fixture.operation('a', state)
  await expect(fixture.complete()).resolves.toMatchObject({ status: 'recovery-required' })
  await expect(readFile(fixture.completionPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it.each(['success', 'pre-install'] as const)('supersedes multiple failed stages using a verified %s candidate', async (state) => {
  const fixture = await completionFixture(3)
  const old = managedManifest({ sequence: 2 })
  const first = await fixture.operation('a', 'blocked', old)
  const second = await fixture.operation('b', 'interrupted', old)
  await fixture.operation('f', state)
  const before = await readFile(join(first, 'stage', 'helper-result.json'), 'utf8')
  await expect(fixture.complete()).resolves.toEqual({ status: 'complete', sequence: 3, version: fixture.manifest.version })
  expect(await readFile(join(first, 'stage', 'helper-result.json'), 'utf8')).toBe(before)
  expect(await readdir(join(second, 'stage'))).toContain('pending-completion.json')
  await expect(fixture.complete(3)).resolves.toEqual({ status: 'none' })
})

it.each(['interrupted', 'success'] as const)('checks live helper only without a terminal result: %s', async (state) => {
  const fixture = await completionFixture()
  const operation = await fixture.operation('a', state)
  await patchRecord(join(operation, 'ack.json'), { helperPid: process.pid })
  await fixture.operation('b', 'pre-install')
  const result = await completeDesktopManagedUpdate(
    fixture.operationsRoot, fixture.completionPath, fixture.capability, 0,
    fixture.executable, fixture.runtime, fixture.planPath, fixture.profile,
  )
  if (state === 'interrupted') {
    expect(result).toMatchObject({ status: 'recovery-required', message: /helper is still running/u })
    await expect(readFile(fixture.completionPath)).rejects.toMatchObject({ code: 'ENOENT' })
  } else expect(result).toMatchObject({ status: 'complete', sequence: 2 })
})

it.each(['EPERM', 'ESRCH', 'EIO'])('handles read-only helper liveness errors conservatively: %s', async (code) => {
  const fixture = await completionFixture()
  await fixture.operation('a', 'interrupted')
  await fixture.operation('b', 'pre-install')
  const probe = vi.spyOn(process, 'kill').mockImplementation(() => {
    throw Object.assign(new Error('liveness probe failure'), { code })
  })
  const result = await completeDesktopManagedUpdate(
    fixture.operationsRoot, fixture.completionPath, fixture.capability, 0,
    fixture.executable, fixture.runtime, fixture.planPath, fixture.profile,
  )
  expect(probe).toHaveBeenCalledTimes(1)
  expect(probe).toHaveBeenCalledWith(123, 0)
  expect(result.status).toBe(code === 'ESRCH' ? 'complete' : 'recovery-required')
})

it('accepts an independent same-version installation only after matching all installed evidence', async () => {
  const fixture = await completionFixture()
  await fixture.operation('a', 'blocked')
  await fixture.operation('b', 'pre-install')
  await expect(fixture.complete()).resolves.toMatchObject({ status: 'complete', sequence: 2, version: fixture.manifest.version })
  expect(JSON.parse(await readFile(fixture.completionPath, 'utf8'))).toEqual({
    schemaVersion: 1, status: 'complete', sequence: 2, manifestSha256: fixture.manifest.manifestSha256,
  })
})

it.each(['executable', 'runtime', 'plan', 'inventory', 'capability-sequence'] as const)(
  'rejects same-version independent installation with mismatched %s', async (mismatch) => {
    const fixture = await completionFixture()
    await fixture.operation('a', 'blocked')
    await fixture.operation('b', 'pre-install')
    if (mismatch === 'executable') await writeFile(fixture.executable, 'wrong executable, same reported version')
    if (mismatch === 'runtime') await writeFile(fixture.runtime, 'wrong runtime')
    if (mismatch === 'plan') await writeFile(fixture.planPath, '{}')
    if (mismatch === 'inventory') await rm(join(fixture.profile, 'desktop-plugin-provisioning-state.json'))
    const result = mismatch === 'capability-sequence'
      ? await completeDesktopManagedUpdate(fixture.operationsRoot, fixture.completionPath,
        { ...fixture.capability, currentSequence: 3 }, 0, fixture.executable, fixture.runtime, fixture.planPath, fixture.profile)
      : await fixture.complete()
    expect(result.status).toBe('recovery-required')
    await expect(readFile(fixture.completionPath)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it.each(['token', 'schema', 'extra-field', 'stage', 'start-marker', 'may-have-started'] as const)(
  'does not let invalid cancellation (%s) bypass installation checks', async (kind) => {
    const fixture = await completionFixture()
    const operation = await fixture.operation('a', kind === 'stage' ? 'interrupted' : 'legacy-pre-install')
    await writeFile(join(operation, 'cancelled.json'), JSON.stringify({ schemaVersion: kind === 'schema' ? 2 : 1,
      token: (kind === 'token' ? 'b' : 'a').repeat(64), ...(kind === 'extra-field' ? { ignored: true } : {}),
    }))
    if (kind === 'start-marker') await writeFile(join(operation, 'install-started.json'), JSON.stringify({
      schemaVersion: 1, token: 'a'.repeat(64), manifestSha256: fixture.manifest.manifestSha256, sequence: 2,
    }))
    if (kind === 'may-have-started') await patchRecord(join(operation, 'helper-result.json'), { installationState: 'may-have-started' })
    await fixture.operation('f', 'success')
    await expect(fixture.complete()).resolves.toMatchObject({ status: 'recovery-required' })
  },
)

it.each(['ack-token', 'ack-hash', 'missing-ack', 'result-hash', 'result-schema', 'result-sequence',
  'manifest-hash', 'handoff-token', 'handoff-stage', 'handoff-asset', 'modern-state'] as const)(
  'fails closed on invalid pre-install identity: %s, even alongside a successful candidate', async (kind) => {
    const fixture = await completionFixture()
    const operation = await fixture.operation('a', 'pre-install')
    if (kind === 'ack-token') await patchRecord(join(operation, 'ack.json'), { token: 'b'.repeat(64) })
    if (kind === 'ack-hash') await patchRecord(join(operation, 'ack.json'), { manifestSha256: 'b'.repeat(64) })
    if (kind === 'missing-ack') await rm(join(operation, 'ack.json'))
    if (kind === 'result-hash') await patchRecord(join(operation, 'helper-result.json'), { manifestSha256: 'b'.repeat(64) })
    if (kind === 'result-schema') await patchRecord(join(operation, 'helper-result.json'), { schemaVersion: 9 })
    if (kind === 'result-sequence') await patchRecord(join(operation, 'helper-result.json'), { sequence: 3 })
    if (kind === 'manifest-hash') await patchRecord(join(operation, 'release.json'), { sequence: 3 })
    if (kind === 'handoff-token') await patchRecord(join(operation, 'handoff.json'), { token: 'b'.repeat(64) })
    if (kind === 'handoff-stage') await patchRecord(join(operation, 'handoff.json'), { stageRoot: fixture.root })
    if (kind === 'handoff-asset') await writeFile(join(operation, 'release.json'), `${JSON.stringify(fixture.manifest)}\n`)
    if (kind === 'modern-state') await patchRecord(join(operation, 'helper-result.json'), { installationState: 'may-have-started' })
    await fixture.operation('f', 'success')
    await expect(fixture.complete()).resolves.toMatchObject({ status: 'recovery-required' })
    await expect(readFile(fixture.completionPath)).rejects.toMatchObject({ code: 'ENOENT' })
  },
)

it.each(['pending-hash', 'pending-sequence', 'pending-evidence', 'result-hash', 'start-hash', 'manifest-raw', 'empty-stage'] as const)(
  'does not supersede a corrupt staged transaction: %s', async (kind) => {
    const fixture = await completionFixture()
    const operation = await fixture.operation('a', 'blocked')
    const stage = join(operation, 'stage')
    if (kind === 'pending-hash') await patchRecord(join(stage, 'pending-completion.json'), { manifestSha256: 'b'.repeat(64) })
    if (kind === 'pending-sequence') await patchRecord(join(stage, 'pending-completion.json'), { sequence: 3 })
    if (kind === 'pending-evidence') await patchRecord(join(stage, 'pending-completion.json'), { installedEvidence: {} })
    if (kind === 'result-hash') await patchRecord(join(stage, 'helper-result.json'), { manifestSha256: 'b'.repeat(64) })
    if (kind === 'start-hash') await patchRecord(join(operation, 'install-started.json'), { manifestSha256: 'b'.repeat(64) })
    if (kind === 'manifest-raw') await writeFile(join(stage, 'release.json'), `${JSON.stringify(fixture.manifest)}\n`)
    if (kind === 'empty-stage') {
      await rm(stage, { recursive: true })
      await mkdir(stage)
    }
    await fixture.operation('f', 'success')
    await expect(fixture.complete()).resolves.toMatchObject({ status: 'recovery-required' })
  },
)

it.each(['newer-failure', 'same-sequence-conflict', 'newer-candidate', 'same-sequence-candidate-conflict'] as const)(
  'does not use verified installed bytes to bypass %s', async (kind) => {
    const fixture = await completionFixture()
    await fixture.operation('a', 'success')
    const other = managedManifest({ sequence: kind.startsWith('same-sequence') ? 2 : 3 })
    await fixture.operation('f', kind.includes('candidate') ? 'success' : 'blocked', other)
    await expect(fixture.complete()).resolves.toMatchObject({ status: 'recovery-required' })
  },
)

it.each(['manifest-download', 'manifest-validation'])('recognizes validated pre-ack %s failure without promoting sequence zero', async (phase) => {
  const fixture = await completionFixture()
  const operation = await fixture.operation('a', 'pre-install')
  await rm(join(operation, 'ack.json'))
  await rm(join(operation, 'release.json'))
  await patchRecord(join(operation, 'helper-result.json'), { phase, asset: 'release.json', sequence: 0 })
  await expect(fixture.complete()).resolves.toEqual({ status: 'none' })
  await expect(readFile(fixture.completionPath)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('accepts valid pre-ack cancellation without trusting its unvalidated target sequence', async () => {
  const fixture = await completionFixture()
  const operation = await fixture.operation('a', 'pre-install')
  await rm(join(operation, 'ack.json'))
  await patchRecord(join(operation, 'helper-result.json'), { phase: 'manifest-download', sequence: 0 })
  await writeFile(join(operation, 'cancelled.json'), JSON.stringify({ schemaVersion: 1, token: 'a'.repeat(64) }))
  await expect(fixture.complete()).resolves.toEqual({ status: 'none' })
})

it('keeps root blocked results with a final stage unresolved even when they claim not-started', async () => {
  const fixture = await completionFixture()
  const operation = await fixture.operation('a', 'blocked')
  await writeFile(join(operation, 'helper-result.json'), JSON.stringify({
    schemaVersion: 1, status: 'blocked', manifestSha256: fixture.manifest.manifestSha256, sequence: 2,
    reason: 'prelaunch verification failed', phase: 'installer-verification', errorType: 'integrity', installationState: 'not-started',
  }))
  await expect(fixture.complete()).resolves.toMatchObject({ status: 'recovery-required' })
})

it('requires no installed files when a fresh startup has no managed operations', async () => {
  const fixture = await completionFixture()
  await rm(fixture.operationsRoot, { recursive: true })
  await rm(fixture.executable)
  await expect(fixture.complete()).resolves.toEqual({ status: 'none' })
})

it.each([0, 2])('applies a raised discovery floor only to uncompleted transactions (completed %s)', async (completedSequence) => {
  const fixture = await completionFixture()
  await fixture.operation('a', 'success')
  await fixture.operation('b', 'pre-install')
  if (completedSequence === 2) await expect(fixture.complete()).resolves.toMatchObject({ status: 'complete', sequence: 2 })
  const result = await completeDesktopManagedUpdate(fixture.operationsRoot, fixture.completionPath,
    { ...fixture.capability, minimumSequence: 3, currentSequence: 3 }, completedSequence,
    fixture.executable, fixture.runtime, fixture.planPath, fixture.profile)
  expect(result.status).toBe(completedSequence === 2 ? 'none' : 'recovery-required')
})

it.each(['installer-launch', 'result-persistence'])('rejects impossible unstarted %s results without a stage', async (phase) => {
  const fixture = await completionFixture()
  const operation = await fixture.operation('a', 'pre-install')
  await patchRecord(join(operation, 'helper-result.json'), { phase })
  await expect(fixture.complete()).resolves.toMatchObject({ status: 'recovery-required' })
})
