import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { completeDesktopManagedUpdate } from '../src/managed-update-completion.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import {
  MANAGED_COMMIT,
  managedCapability,
  managedManifest,
} from './managed-update-fixture.ts'
import {
  DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
  desktopPluginProvisioningPlanSha256,
} from '../src/plugin-provisioning.ts'

const roots: string[] = []
const sha256 = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it.each(['valid', 'missing-state'] as const)('requires active inventory before completion: %s', async (inventory) => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-completion-'))
  roots.push(root)
  const operation = join(root, 'operations', 'a'.repeat(64), 'stage')
  await mkdir(operation, { recursive: true })
  const executable = Buffer.from('desktop')
  const runtime = Buffer.from('runtime')
  const executablePath = join(root, 'DeepSeek Harness.exe')
  const runtimePath = join(root, 'desktop-runtime.json')
  const provisioningPath = join(root, 'desktop-provisioning.json')
  const provisioning = { schemaVersion: 1 as const, mode: 'exact' as const, plugins: [] }
  await writeFile(executablePath, executable)
  await writeFile(runtimePath, runtime)
  await writeFile(provisioningPath, JSON.stringify(provisioning))
  const profile = join(root, 'profile')
  createPluginProfile(profile)
  if (inventory === 'valid') {
    await writeFile(join(profile, 'desktop-plugin-provisioning-state.json'), JSON.stringify({
      schemaVersion: 1, capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
      planSha256: desktopPluginProvisioningPlanSha256(provisioning),
      composition: 'active', plugins: [], removed: [], rolledBack: false, verified: true,
    }))
  }
  const manifest = managedManifest({
    source: {
      repository: 'cloga/deepseek-harness',
      commit: MANAGED_COMMIT,
      tree: 'b'.repeat(40),
      tag: 'dsh-desktop-v1.2.3',
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
  const completionPath = join(root, 'completion.json')
  const result = await completeDesktopManagedUpdate(
    join(root, 'operations'),
    completionPath,
    managedCapability({
      provisioning: {
        capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
        planSha256: desktopPluginProvisioningPlanSha256(provisioning),
      },
    }),
    1,
    executablePath,
    runtimePath,
    provisioningPath,
    profile,
  )
  if (inventory === 'valid') {
    expect(result).toEqual({ status: 'complete', sequence: 2, version: '1.2.3' })
    expect(JSON.parse(await readFile(completionPath, 'utf8'))).toMatchObject({ status: 'complete', sequence: 2 })
  } else {
    expect(result.status).toBe('recovery-required')
    await expect(readFile(completionPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
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
  await writeFile(join(operation, 'pending-completion.json'), JSON.stringify({
    schemaVersion: 1,
    manifestSha256: 'a'.repeat(64),
    sequence: 2,
    installedEvidence: {},
  }))
  if (result !== undefined) {
    await writeFile(join(operation, 'helper-result.json'), JSON.stringify(result))
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
