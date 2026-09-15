import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  managedUpdateChildEnvironment,
  runDesktopManagedUpdateHelper,
  waitForDesktopProcesses,
  type DesktopManagedUpdateHelperOperations,
} from '../src/managed-update-helper.ts'
import { managedUpdateJsonSha256 } from '../src/managed-update-protocol.ts'

function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

function response(body: Uint8Array, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers })
}

const temporaryRoots: string[] = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Desktop managed update helper', () => {
  it('waits only for the handed-off process ids and fails closed on timeout', async () => {
    let checks = 0
    const operations = {
      processRunning: vi.fn((pid: number) => {
        checks++
        return pid === 12 && checks < 3
      }),
      sleep: vi.fn(async () => {}),
      now: () => checks,
    }
    await expect(waitForDesktopProcesses([12, 34], 1000, operations)).resolves.toBeUndefined()
    expect(operations.processRunning).toHaveBeenCalledWith(12)
    expect(operations.processRunning).toHaveBeenCalledWith(34)

    let now = 0
    await expect(waitForDesktopProcesses([12], 20, {
      processRunning: () => true,
      sleep: async () => { now = 20 },
      now: () => now,
    })).rejects.toThrow(/timed out/u)
  })

  it('removes inherited credentials from installer subprocesses', () => {
    expect(managedUpdateChildEnvironment({
      SystemRoot: 'C:\\Windows',
      GH_TOKEN: 'github-secret',
      DEEPSEEK_API_KEY: 'model-secret',
      DESKTOP_PASSWORD: 'desktop-secret',
    })).toEqual({ SystemRoot: 'C:\\Windows' })
  })

  it('acknowledges validated metadata before waiting, stages verified files, and passes no installer arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-managed-update-'))
    temporaryRoots.push(root)
    const stageRoot = join(root, 'stage')
    const installer = Buffer.from('installer')
    const receiptValue = {
      source: { repository: 'cloga/deepseek-harness', tag: 'dsh-v1.2.3', commit: 'a'.repeat(40) },
      receiptSha256: '1'.repeat(64),
    }
    const receipt = Buffer.from(JSON.stringify(receiptValue))
    const payload = {
      schemaVersion: 2,
      owner: 'cloga/deepseek-harness',
      mode: 'interactive-windows-installer',
      version: '1.2.3',
      sequence: 2,
      source: { repository: 'cloga/deepseek-harness', commit: 'a'.repeat(40), tag: 'dsh-v1.2.3' },
      installer: {
        file: 'installer.exe',
        bytes: installer.byteLength,
        sha256: sha256(installer),
        sha512: createHash('sha512').update(installer).digest('base64'),
        signature: 'NotSigned',
      },
      buildReceipt: {
        file: 'build-receipt.json',
        sha256: sha256(receipt),
        receiptSha256: receiptValue.receiptSha256,
      },
      installedEvidence: { executableSha256: 'b'.repeat(64), runtimeSha256: 'c'.repeat(64) },
      pluginProvisioning: {
        capability: 'verified-github-release',
        source: {
          schemaVersion: 1,
          type: 'githubRelease',
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
        },
        receiptSha256: 'd'.repeat(64),
      },
    }
    const manifestValue = { ...payload, manifestSha256: managedUpdateJsonSha256(payload) }
    const manifest = Buffer.from(JSON.stringify(manifestValue))
    const base = 'https://github.com/cloga/deepseek-harness/releases/download/dsh-v1.2.3/'
    const fetch = vi.fn(async (url: string) => {
      if (url === `${base}release.json`) return response(manifest)
      if (url === `${base}build-receipt.json`) return response(receipt)
      if (url === `${base}installer.exe`) return response(installer, 200, { 'content-length': String(installer.length) })
      return response(Buffer.alloc(0), 404)
    })
    let acknowledged = false
    const startInstaller = vi.fn(async (path: string, args: readonly string[]) => {
      expect(acknowledged).toBe(true)
      expect(await readFile(path)).toEqual(installer)
      expect(args).toEqual([])
      return 0
    })
    const operations: DesktopManagedUpdateHelperOperations = {
      fetch,
      processRunning: () => {
        acknowledged = true
        return false
      },
      sleep: async () => {},
      now: () => 0,
      getInstallerSignature: async () => 'NotSigned',
      startInstaller,
    }
    const handoff = {
      schemaVersion: 1,
      token: 'e'.repeat(64),
      capability: {
        schemaVersion: 1,
        mode: 'windows-ops-managed',
        manifestUrl: `${base}release.json`,
        manifestSha256: manifestValue.manifestSha256,
        minimumSequence: 2,
        expectedSource: { version: '1.2.3', commit: 'a'.repeat(40) },
      },
      selectedManifest: 'source',
      stageRoot,
      waitPids: [12],
      waitTimeoutMs: 1000,
      installedSequence: 1,
    }
    await expect(runDesktopManagedUpdateHelper(handoff, operations)).resolves.toMatchObject({
      status: 'installer-exited',
      pendingCompletion: true,
    })
    expect(startInstaller).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(join(root, 'ack.json'), 'utf8'))).toMatchObject({
      token: 'e'.repeat(64),
      manifestSha256: manifestValue.manifestSha256,
    })
    expect(JSON.parse(await readFile(join(stageRoot, 'helper-result.json'), 'utf8')))
      .toMatchObject({ status: 'installer-exited' })
  })

  it('does not start an installer whose bytes fail the manifest hash', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-managed-update-hash-'))
    temporaryRoots.push(root)
    const installer = Buffer.from('installer')
    const receipt = Buffer.from(JSON.stringify({
      source: { repository: 'cloga/deepseek-harness', tag: 'dsh-v1.2.3', commit: 'a'.repeat(40) },
      receiptSha256: '1'.repeat(64),
    }))
    const payload = {
      schemaVersion: 2,
      owner: 'cloga/deepseek-harness',
      mode: 'interactive-windows-installer',
      version: '1.2.3',
      sequence: 2,
      source: { repository: 'cloga/deepseek-harness', commit: 'a'.repeat(40), tag: 'dsh-v1.2.3' },
      installer: {
        file: 'installer.exe',
        bytes: installer.byteLength,
        sha256: 'f'.repeat(64),
        sha512: createHash('sha512').update(installer).digest('base64'),
        signature: 'NotSigned',
      },
      buildReceipt: { file: 'build-receipt.json', sha256: sha256(receipt), receiptSha256: '1'.repeat(64) },
      installedEvidence: { executableSha256: 'b'.repeat(64), runtimeSha256: 'c'.repeat(64) },
      pluginProvisioning: {
        capability: 'verified-github-release',
        source: {
          schemaVersion: 1,
          type: 'githubRelease',
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
        },
        receiptSha256: 'd'.repeat(64),
      },
    }
    const manifestValue = { ...payload, manifestSha256: managedUpdateJsonSha256(payload) }
    const manifest = Buffer.from(JSON.stringify(manifestValue))
    const startInstaller = vi.fn(async () => 0)
    const operations: DesktopManagedUpdateHelperOperations = {
      fetch: vi.fn(async (url: string) => url.endsWith('release.json')
        ? response(manifest)
        : url.endsWith('build-receipt.json') ? response(receipt) : response(installer)),
      processRunning: () => false,
      sleep: async () => {},
      now: () => 0,
      getInstallerSignature: async () => 'NotSigned',
      startInstaller,
    }
    const result = await runDesktopManagedUpdateHelper({
      schemaVersion: 1,
      token: 'e'.repeat(64),
      capability: {
        schemaVersion: 1,
        mode: 'windows-ops-managed',
        manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/download/dsh-v1.2.3/release.json',
        manifestSha256: manifestValue.manifestSha256,
        minimumSequence: 2,
        expectedSource: { version: '1.2.3', commit: 'a'.repeat(40) },
      },
      selectedManifest: 'source',
      stageRoot: join(root, 'stage'),
      waitPids: [12],
      waitTimeoutMs: 1000,
      installedSequence: 1,
    }, operations)
    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') throw new Error('expected blocked helper result')
    expect(result.reason).toMatch(/hash or size/u)
    const persisted: unknown = JSON.parse(await readFile(join(root, 'helper-result.json'), 'utf8'))
    expect(persisted).toEqual(expect.objectContaining({ status: 'blocked' }))
    expect(startInstaller).not.toHaveBeenCalled()
  })
})
