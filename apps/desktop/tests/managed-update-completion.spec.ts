import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  completeDesktopManagedUpdate,
  managedPluginProvisionReceiptSha256,
} from '../src/managed-update-completion.ts'
import { managedUpdateJsonSha256 } from '../src/managed-update-protocol.ts'

const roots: string[] = []
const sha256 = (body: Uint8Array): string => createHash('sha256').update(body).digest('hex')

afterEach(async () => {
  await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

it('verifies installed evidence and plugin provisioning before recording completion', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-completion-'))
  roots.push(root)
  const operation = join(root, 'operations', 'a'.repeat(64), 'stage')
  await mkdir(operation, { recursive: true })
  const executable = Buffer.from('desktop')
  const runtime = Buffer.from('runtime')
  const executablePath = join(root, 'DeepSeek Harness.exe')
  const runtimePath = join(root, 'desktop-runtime.json')
  await writeFile(executablePath, executable)
  await writeFile(runtimePath, runtime)
  const pluginSource = {
    schemaVersion: 1 as const,
    type: 'githubRelease' as const,
    owner: 'cloga',
    repo: 'dsh-github-copilot',
    tag: 'v0.4.0-alpha.18',
    asset: 'dsh-github-copilot-0.4.0-alpha.18.tgz',
    packageName: 'dsh-github-copilot',
    version: '0.4.0-alpha.18',
    size: 1,
    sha256: '2'.repeat(64),
    integrity: `sha512-${'A'.repeat(86)}==`,
    targetCommit: '3'.repeat(40),
  }
  const provisionReceipt = {
    schemaVersion: 1 as const,
    capability: {
      id: 'desktopNativeVerifiedRelease' as const,
      schemaVersion: 1 as const,
      sourceSchemaVersion: 1 as const,
      receiptSchemaVersion: 1 as const,
    },
    source: pluginSource,
    releaseId: 10,
    assetId: 20,
    packageName: pluginSource.packageName,
    version: pluginSource.version,
    artifactSha256: pluginSource.sha256,
    states: { staged: true as const, health: 'passed' as const, activated: true as const, rolledBack: false as const, verified: true as const },
  }
  const payload = {
    schemaVersion: 2,
    owner: 'cloga/deepseek-harness',
    mode: 'interactive-windows-installer',
    version: '1.2.3',
    sequence: 2,
    source: { repository: 'cloga/deepseek-harness', commit: 'b'.repeat(40), tag: 'dsh-v1.2.3' },
    installer: {
      file: 'installer.exe',
      bytes: 1,
      sha256: 'c'.repeat(64),
      sha512: 'YQ'.padEnd(86, 'A') + '==',
      signature: 'NotSigned',
    },
    buildReceipt: { file: 'build-receipt.json', sha256: 'd'.repeat(64), receiptSha256: 'e'.repeat(64) },
    installedEvidence: { executableSha256: sha256(executable), runtimeSha256: sha256(runtime) },
    pluginProvisioning: {
      capability: 'verified-github-release',
      source: pluginSource,
      receiptSha256: managedPluginProvisionReceiptSha256(provisionReceipt),
    },
  }
  const manifest = { ...payload, manifestSha256: managedUpdateJsonSha256(payload) }
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
    pluginProvisioning: manifest.pluginProvisioning,
  }))
  const provision = vi.fn(async () => provisionReceipt)
  const completionPath = join(root, 'completion.json')
  await expect(completeDesktopManagedUpdate(
    join(root, 'operations'),
    completionPath,
    {
      schemaVersion: 1,
      mode: 'windows-ops-managed',
      manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/download/dsh-v1.2.3/release.json',
      manifestSha256: manifest.manifestSha256,
      minimumSequence: 2,
      expectedSource: { version: '1.2.3', commit: 'b'.repeat(40) },
    },
    1,
    executablePath,
    runtimePath,
    provision,
  )).resolves.toEqual({ status: 'complete', sequence: 2, version: '1.2.3' })
  expect(provision).toHaveBeenCalledOnce()
  expect(JSON.parse(await readFile(completionPath, 'utf8'))).toMatchObject({ status: 'complete', sequence: 2 })
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
    {
      schemaVersion: 1,
      mode: 'windows-ops-managed',
      manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/download/dsh-v1.2.3/release.json',
      manifestSha256: 'b'.repeat(64),
      minimumSequence: 2,
      expectedSource: { version: '1.2.3', commit: 'c'.repeat(40) },
    },
    1,
    join(root, 'unused.exe'),
    join(root, 'unused-runtime.json'),
    async () => { throw new Error('provisioning must not run') },
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
    pluginProvisioning: {},
  }))
  if (result !== undefined) {
    await writeFile(join(operation, 'helper-result.json'), JSON.stringify(result))
  }

  await expect(completeDesktopManagedUpdate(
    join(root, 'operations'),
    join(root, 'completion.json'),
    {
      schemaVersion: 1,
      mode: 'windows-ops-managed',
      manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/download/dsh-v1.2.3/release.json',
      manifestSha256: 'a'.repeat(64),
      minimumSequence: 2,
      expectedSource: { version: '1.2.3', commit: 'b'.repeat(40) },
    },
    1,
    join(root, 'unused.exe'),
    join(root, 'unused-runtime.json'),
    async () => { throw new Error('provisioning must not run') },
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
    {
      schemaVersion: 1,
      mode: 'windows-ops-managed',
      manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/download/dsh-v1.2.3/release.json',
      manifestSha256: 'b'.repeat(64),
      minimumSequence: 2,
      expectedSource: { version: '1.2.3', commit: 'c'.repeat(40) },
    },
    1,
    join(root, 'unused.exe'),
    join(root, 'unused-runtime.json'),
    async () => { throw new Error('provisioning must not run') },
  )).resolves.toEqual({ status: 'none' })
})
