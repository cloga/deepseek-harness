import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  managedUpdateChildEnvironment,
  runDesktopManagedUpdateHelper,
  verifyAndStartManagedInstaller,
  waitForDesktopProcesses,
  type DesktopManagedUpdateHelperOperations,
} from '../src/managed-update-helper.ts'
import {
  MANAGED_COMMIT,
  MANAGED_TAG,
  MANAGED_TREE,
  managedCapability,
  managedManifest,
} from './managed-update-fixture.ts'

function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

function response(body: Uint8Array, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(Buffer.from(body), { status, headers })
}

const temporaryRoots: string[] = []
const execFileAsync = promisify(execFile)

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

    await expect(waitForDesktopProcesses([12], 20, {
      processRunning: () => true,
      sleep: async () => {},
      now: () => 0,
    }, async () => true)).rejects.toThrow(/cancelled/u)
  })

  it('removes inherited credentials from installer subprocesses', () => {
    expect(managedUpdateChildEnvironment({
      SystemRoot: 'C:\\Windows',
      GH_TOKEN: 'github-secret',
      DEEPSEEK_API_KEY: 'model-secret',
      DESKTOP_PASSWORD: 'desktop-secret',
      HTTPS_PROXY: 'https://proxy-user:proxy-password@example.test',
    })).toEqual({ SystemRoot: 'C:\\Windows' })
  })

  const windowsIt = process.platform === 'win32' ? it : it.skip
  windowsIt('rehashes and starts an unsigned executable through the locked Windows path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-managed-installer-launch-'))
    temporaryRoots.push(root)
    const executable = join(root, 'fixture.exe')
    const source = join(root, 'fixture.cs')
    await writeFile(source, 'public static class Program { public static int Main() { return 7; } }\n')
    const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    await execFileAsync(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -Path $env:DSH_TEST_SOURCE -OutputAssembly $env:DSH_TEST_EXECUTABLE -OutputType ConsoleApplication',
    ], {
      env: {
        ...process.env,
        DSH_TEST_SOURCE: source,
        DSH_TEST_EXECUTABLE: executable,
      },
    })
    const body = await readFile(executable)

    await expect(verifyAndStartManagedInstaller(executable, {
      bytes: body.byteLength,
      sha256: createHash('sha256').update(body).digest('hex'),
      sha512: createHash('sha512').update(body).digest('base64'),
      signature: 'NotSigned',
    })).resolves.toBe(7)
  }, 30_000)

  it('acknowledges validated metadata before waiting, stages verified files, and passes no installer arguments', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-managed-update-'))
    temporaryRoots.push(root)
    const stageRoot = join(root, 'stage')
    const installer = Buffer.from('installer')
    const receiptValue = {
      source: {
        repository: 'cloga/deepseek-harness',
        tag: MANAGED_TAG,
        version: '1.2.3',
        commit: MANAGED_COMMIT,
        tree: MANAGED_TREE,
      },
      receiptSha256: '1'.repeat(64),
    }
    const receipt = Buffer.from(JSON.stringify(receiptValue))
    const manifestValue = managedManifest({
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
    })
    const manifest = Buffer.from(JSON.stringify(manifestValue))
    const base = `https://github.com/cloga/deepseek-harness/releases/download/${MANAGED_TAG}/`
    const fetch = vi.fn(async (url: string, init: RequestInit) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      if (url === `${base}release.json`) return response(manifest)
      if (url === `${base}build-receipt.json`) return response(receipt)
      if (url === `${base}installer.exe`) return response(installer, 200, { 'content-length': String(installer.length) })
      return response(Buffer.alloc(0), 404)
    })
    let acknowledged = false
    const verifyAndStartInstaller = vi.fn(async (
      path: string,
      expected: { bytes: number; sha256: string; sha512: string; signature: 'NotSigned' },
    ) => {
      expect(acknowledged).toBe(true)
      expect(await readFile(path)).toEqual(installer)
      expect(expected).toEqual({
        bytes: installer.byteLength,
        sha256: sha256(installer),
        sha512: createHash('sha512').update(installer).digest('base64'),
        signature: 'NotSigned',
      })
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
      verifyAndStartInstaller,
    }
    const handoff = {
      schemaVersion: 1,
      token: 'e'.repeat(64),
      capability: managedCapability(),
      selection: {
        kind: 'source',
        manifestUrl: `${base}release.json`,
        manifestSha256: manifestValue.manifestSha256,
        assetSha256: sha256(manifest),
      },
      stageRoot,
      waitPids: [12],
      waitTimeoutMs: 1000,
      installedSequence: 1,
    }
    await expect(runDesktopManagedUpdateHelper(handoff, operations)).resolves.toMatchObject({
      status: 'installer-exited',
      pendingCompletion: true,
    })
    expect(verifyAndStartInstaller).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(join(root, 'ack.json'), 'utf8'))).toMatchObject({
      token: 'e'.repeat(64),
      manifestSha256: manifestValue.manifestSha256,
    })
    expect(JSON.parse(await readFile(join(stageRoot, 'helper-result.json'), 'utf8')))
      .toMatchObject({ status: 'installer-exited' })
  })

  it.each([
    {
      name: 'hash does not match',
      servedInstaller: Buffer.from('installer'),
      expectedSha256: 'f'.repeat(64),
      reason: /hash or size/u,
    },
    {
      name: 'lengthless response exceeds the declared size',
      servedInstaller: Buffer.from('installer-extra'),
      expectedSha256: sha256(Buffer.from('installer')),
      reason: /stream exceeds/u,
    },
  ])('does not start an installer when its $name', async ({ servedInstaller, expectedSha256, reason }) => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-managed-update-hash-'))
    temporaryRoots.push(root)
    const installer = Buffer.from('installer')
    const receipt = Buffer.from(JSON.stringify({
      source: {
        repository: 'cloga/deepseek-harness',
        tag: MANAGED_TAG,
        version: '1.2.3',
        commit: MANAGED_COMMIT,
        tree: MANAGED_TREE,
      },
      receiptSha256: '1'.repeat(64),
    }))
    const manifestValue = managedManifest({
      installer: {
        file: 'installer.exe',
        bytes: installer.byteLength,
        sha256: expectedSha256,
        sha512: createHash('sha512').update(installer).digest('base64'),
        signature: 'NotSigned',
      },
      buildReceipt: { file: 'build-receipt.json', sha256: sha256(receipt), receiptSha256: '1'.repeat(64) },
    })
    const manifest = Buffer.from(JSON.stringify(manifestValue))
    const verifyAndStartInstaller = vi.fn(async () => 0)
    const operations: DesktopManagedUpdateHelperOperations = {
      fetch: vi.fn(async (url: string) => url.endsWith('release.json')
        ? response(manifest)
        : url.endsWith('build-receipt.json') ? response(receipt) : response(servedInstaller)),
      processRunning: () => false,
      sleep: async () => {},
      now: () => 0,
      verifyAndStartInstaller,
    }
    const result = await runDesktopManagedUpdateHelper({
      schemaVersion: 1,
      token: 'e'.repeat(64),
      capability: managedCapability(),
      selection: {
        kind: 'source',
        manifestUrl: `https://github.com/cloga/deepseek-harness/releases/download/${MANAGED_TAG}/release.json`,
        manifestSha256: manifestValue.manifestSha256,
        assetSha256: sha256(manifest),
      },
      stageRoot: join(root, 'stage'),
      waitPids: [12],
      waitTimeoutMs: 1000,
      installedSequence: 1,
    }, operations)
    expect(result.status).toBe('blocked')
    if (result.status !== 'blocked') throw new Error('expected blocked helper result')
    expect(result.reason).toMatch(reason)
    const persisted: unknown = JSON.parse(await readFile(join(root, 'helper-result.json'), 'utf8'))
    expect(persisted).toEqual(expect.objectContaining({ status: 'blocked' }))
    expect(verifyAndStartInstaller).not.toHaveBeenCalled()
  })
})
