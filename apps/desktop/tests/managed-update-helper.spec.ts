import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { completeDesktopManagedUpdate } from '../src/managed-update-completion.ts'
import { ManagedUpdateTransferError } from '../src/managed-update-network.ts'
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

async function transferFixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-managed-transfer-'))
  temporaryRoots.push(root)
  const installer = Buffer.from('complete installer')
  const receipt = Buffer.from(JSON.stringify({
    source: { repository: 'cloga/deepseek-harness', tag: MANAGED_TAG, version: '1.2.3', commit: MANAGED_COMMIT, tree: MANAGED_TREE },
    receiptSha256: '1'.repeat(64),
  }))
  const manifestValue = managedManifest({
    installer: {
      file: 'installer.exe', bytes: installer.byteLength, sha256: sha256(installer),
      sha512: createHash('sha512').update(installer).digest('base64'), signature: 'NotSigned',
    },
    buildReceipt: { file: 'build-receipt.json', sha256: sha256(receipt), receiptSha256: '1'.repeat(64) },
  })
  const manifest = Buffer.from(JSON.stringify(manifestValue))
  const handoff = {
    schemaVersion: 1, token: 'e'.repeat(64), capability: managedCapability(),
    selection: {
      kind: 'source', manifestUrl: `https://github.com/cloga/deepseek-harness/releases/download/${MANAGED_TAG}/release.json`,
      manifestSha256: manifestValue.manifestSha256, assetSha256: sha256(manifest),
    },
    stageRoot: join(root, 'stage'), waitPids: [12], waitTimeoutMs: 1000, installedSequence: 1,
  }
  const operations: DesktopManagedUpdateHelperOperations = {
    fetch: vi.fn(async (url: string) => response(url.endsWith('release.json') ? manifest
      : url.endsWith('build-receipt.json') ? receipt : installer)),
    processRunning: () => false, sleep: vi.fn(async () => {}), now: () => 0,
    verifyAndStartInstaller: vi.fn(async () => 0),
  }
  return { root, installer, receipt, manifest, manifestValue, handoff, operations }
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe.each(['manifest', 'receipt', 'installer', 'launch'] as const)('closed helper %s diagnostics', (at) => {
  it.each(['name', 'code', 'cause', 'message', 'prototype', 'revoked', 'forged', 'owned'] as const)(
    'persists a closed blocked result when the error has hostile %s access', async (kind) => {
      const fixture = await transferFixture()
      const secret = `private-error-${fixture.handoff.token}-https://user:password@example.test/?secret=value`
      const readOwned = vi.fn(() => secret)
      let failure: object = new Error('unclassified')
      if (kind === 'prototype') failure = new Proxy({}, { getPrototypeOf() { throw new Error(secret) } })
      else if (kind === 'revoked') {
        const revocable = Proxy.revocable({}, {})
        revocable.revoke()
        failure = revocable.proxy
      } else if (kind === 'forged') {
        failure = Object.setPrototypeOf({ errorType: secret, retryable: false }, ManagedUpdateTransferError.prototype)
      } else if (kind === 'owned') {
        failure = new ManagedUpdateTransferError('integrity')
        Object.defineProperties(failure, { errorType: { get: readOwned }, retryable: { get: readOwned }, status: { get: readOwned } })
      } else Object.defineProperty(failure, kind, { get() { throw new Error(secret) } })
      const target = at === 'manifest' ? 'release.json' : at === 'receipt' ? 'build-receipt.json' : 'installer.exe'
      if (at === 'launch') fixture.operations.verifyAndStartInstaller = vi.fn().mockRejectedValue(failure)
      else fixture.operations.fetch = vi.fn(async (requested: string) => {
        if (requested.endsWith(target)) throw failure
        return response(requested.endsWith('release.json') ? fixture.manifest : fixture.receipt)
      })
      const phase = at === 'launch' ? 'installer-launch' : `${at}-download`
      const errorType = kind === 'owned' ? 'integrity' : at === 'launch' ? 'installer-launch' : 'unknown'
      const result = await runDesktopManagedUpdateHelper(fixture.handoff, fixture.operations)
      expect(result).toMatchObject({ status: 'blocked', phase, asset: target, errorType,
        reason: `desktop managed update: ${phase}: ${errorType}`,
        installationState: at === 'launch' ? 'may-have-started' : 'not-started' })
      const persisted = await readFile(join(fixture.root, 'helper-result.json'), 'utf8')
      expect(JSON.parse(persisted)).toEqual(result)
      for (const privateText of [secret, fixture.handoff.token, 'https://', 'password', 'private-error']) expect(persisted).not.toContain(privateText)
      expect(readOwned).not.toHaveBeenCalled()
      expect(fixture.operations.fetch).toHaveBeenCalledTimes({ manifest: 1, receipt: 2, installer: 3, launch: 3 }[at])
      expect(fixture.operations.sleep).not.toHaveBeenCalled()
      if (at === 'launch') expect(fixture.operations.verifyAndStartInstaller).toHaveBeenCalledOnce()
      else {
        expect(fixture.operations.verifyAndStartInstaller).not.toHaveBeenCalled()
        await expect(readFile(join(fixture.root, 'install-started.json'))).rejects.toMatchObject({ code: 'ENOENT' })
      }
    },
  )
})

describe('Desktop managed update helper recovery diagnostics', () => {
  it('classifies a cancellation message once for both persisted diagnostic fields', async () => {
    const fixture = await transferFixture()
    const message = vi.fn().mockReturnValueOnce('desktop managed update: operation was cancelled')
      .mockImplementation(() => { throw new Error(`private second read ${fixture.handoff.token}`) })
    const failure = Object.defineProperty(new Error('original'), 'message', { get: message })
    fixture.operations.fetch = vi.fn().mockRejectedValue(failure)
    const result = await runDesktopManagedUpdateHelper(fixture.handoff, fixture.operations)
    expect(result).toMatchObject({ status: 'blocked', phase: 'manifest-download', errorType: 'cancelled',
      reason: 'desktop managed update: manifest-download: cancelled', installationState: 'not-started' })
    expect(message).toHaveBeenCalledOnce()
    expect(JSON.parse(await readFile(join(fixture.root, 'helper-result.json'), 'utf8'))).toEqual(result)
    expect(fixture.operations.fetch).toHaveBeenCalledOnce()
    expect(fixture.operations.verifyAndStartInstaller).not.toHaveBeenCalled()
  })

  it('replays a real helper download-timeout record on cold startup without a fake completion receipt', async () => {
    const fixture = await transferFixture()
    const operationsRoot = join(fixture.root, 'operations')
    fixture.handoff.stageRoot = join(operationsRoot, fixture.handoff.token, 'stage')
    fixture.operations.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('release.json')) return response(fixture.manifest)
      throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
    })
    const result = await runDesktopManagedUpdateHelper(fixture.handoff, fixture.operations)
    if (result.status !== 'blocked') throw new Error('Fixture must fail before installation')
    expect({ phase: result.phase, asset: result.asset, errorType: result.errorType,
      installationState: result.installationState, reason: result.reason }).toMatchInlineSnapshot(`
      {
        "asset": "build-receipt.json",
        "errorType": "timeout",
        "installationState": "not-started",
        "phase": "receipt-download",
        "reason": "desktop managed update: receipt-download: timeout",
      }
    `)
    const resultPath = join(operationsRoot, fixture.handoff.token, 'helper-result.json')
    const original = await readFile(resultPath, 'utf8')
    const completionPath = join(fixture.root, 'completion.json')
    for (let startup = 0; startup < 2; startup++) {
      await expect(completeDesktopManagedUpdate(operationsRoot, completionPath, managedCapability(), 0,
        join(fixture.root, 'existing.exe'), join(fixture.root, 'runtime.json'),
        join(fixture.root, 'plan.json'), join(fixture.root, 'profile'))).resolves.toEqual({ status: 'none' })
    }
    expect(await readFile(resultPath, 'utf8')).toBe(original)
    await expect(readFile(completionPath)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(fixture.operations.verifyAndStartInstaller).not.toHaveBeenCalled()
  })

  it.each(['TimeoutError', 'ECONNRESET'])('restarts a partial installer after a body %s without appending bytes', async (kind) => {
    const fixture = await transferFixture()
    let installerAttempts = 0
    fixture.operations.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('release.json')) return response(fixture.manifest)
      if (url.endsWith('build-receipt.json')) return response(fixture.receipt)
      installerAttempts++
      if (installerAttempts > 1) return response(fixture.installer)
      let pulls = 0
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(Buffer.from('partial'))
          else controller.error(kind === 'TimeoutError' ? new DOMException('signed query secret', 'TimeoutError')
            : Object.assign(new Error('reset with credentials'), { code: kind }))
        },
      }))
    })
    const result = await runDesktopManagedUpdateHelper(fixture.handoff, fixture.operations)
    expect(result.status).toBe('installer-exited')
    expect(installerAttempts).toBe(2)
    expect(await readFile(join(fixture.handoff.stageRoot, 'installer.exe'))).toEqual(fixture.installer)
    expect(fixture.operations.verifyAndStartInstaller).toHaveBeenCalledOnce()
  })

  it('aborts a stalled installer body, closes the partial file, and retries successfully', async () => {
    const fixture = await transferFixture()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    let reachedStall!: () => void
    const stalled = new Promise<void>((resolve) => { reachedStall = resolve })
    const cancelled = vi.fn()
    let installerAttempts = 0
    fixture.operations.fetch = vi.fn(async (url: string) => {
      if (url.endsWith('release.json')) return response(fixture.manifest)
      if (url.endsWith('build-receipt.json')) return response(fixture.receipt)
      installerAttempts++
      if (installerAttempts > 1) return response(fixture.installer)
      let pulls = 0
      return new Response(new ReadableStream<Uint8Array>({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(Buffer.from('partial'))
          else reachedStall()
        },
        cancel: cancelled,
      }))
    })
    try {
      const pending = runDesktopManagedUpdateHelper(fixture.handoff, fixture.operations)
      await stalled
      await vi.advanceTimersByTimeAsync(60_000)
      expect(await pending).toMatchObject({ status: 'installer-exited' })
      expect(cancelled).toHaveBeenCalledOnce()
      expect(installerAttempts).toBe(2)
      expect(await readFile(join(fixture.handoff.stageRoot, 'installer.exe'))).toEqual(fixture.installer)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it.each(['manifest', 'receipt', 'installer'])('persists sanitized %s network failure diagnostics and limits retries', async (asset) => {
    const fixture = await transferFixture()
    const target = asset === 'manifest' ? 'release.json' : asset === 'receipt' ? 'build-receipt.json' : 'installer.exe'
    fixture.operations.fetch = vi.fn(async (url: string) => {
      if (url.endsWith(target)) {
        throw new TypeError(`https://user:password@release-assets.githubusercontent.com/file?sig=private ${fixture.handoff.token}`, {
          cause: { code: 'ECONNRESET' },
        })
      }
      return response(url.endsWith('release.json') ? fixture.manifest : fixture.receipt)
    })
    const result = await runDesktopManagedUpdateHelper(fixture.handoff, fixture.operations)
    expect(result).toMatchObject({
      status: 'blocked', phase: `${asset}-download`, asset: target, errorType: 'network-reset', installationState: 'not-started',
    })
    const persisted = await readFile(join(fixture.root, 'helper-result.json'), 'utf8')
    for (const secret of ['user', 'password', 'private', fixture.handoff.token, 'https://']) expect(persisted).not.toContain(secret)
    expect(JSON.parse(persisted)).toEqual(result)
    expect(fixture.operations.fetch).toHaveBeenCalledTimes(asset === 'manifest' ? 3 : asset === 'receipt' ? 4 : 5)
    expect(fixture.operations.verifyAndStartInstaller).not.toHaveBeenCalled()
    await expect(readFile(join(fixture.root, 'install-started.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    if (asset === 'manifest') await expect(readFile(join(fixture.root, 'ack.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    else expect(await readFile(join(fixture.root, 'release.json'))).toEqual(fixture.manifest)
  })

  it('persists manifest integrity failures before acknowledgement without retrying', async () => {
    const fixture = await transferFixture()
    fixture.operations.fetch = vi.fn(async () => response(Buffer.from('invalid manifest with secret')))
    const result = await runDesktopManagedUpdateHelper(fixture.handoff, fixture.operations)
    expect(result).toMatchObject({ status: 'blocked', phase: 'manifest-validation', asset: 'release.json', errorType: 'integrity', installationState: 'not-started' })
    expect(fixture.operations.fetch).toHaveBeenCalledOnce()
    await expect(readFile(join(fixture.root, 'ack.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(fixture.root, 'helper-result.json'), 'utf8'))).toEqual(result)
  })

  it('retains the installed sequence floor when a parsed manifest differs from the selection', async () => {
    const fixture = await transferFixture()
    fixture.handoff.selection.manifestSha256 = 'f'.repeat(64)
    const result = await runDesktopManagedUpdateHelper(fixture.handoff, fixture.operations)
    expect(result).toMatchObject({
      status: 'blocked', phase: 'manifest-validation', errorType: 'integrity', installationState: 'not-started',
      sequence: fixture.handoff.installedSequence, manifestSha256: fixture.handoff.selection.manifestSha256,
    })
    expect(fixture.operations.fetch).toHaveBeenCalledOnce()
    expect(fixture.operations.verifyAndStartInstaller).not.toHaveBeenCalled()
    await expect(readFile(join(fixture.root, 'ack.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(fixture.root, 'release.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(join(fixture.root, 'helper-result.json'), 'utf8'))).toEqual(result)
  })

  it.each(['throw', 'nonzero'])('records interrupted installer %s as potentially started with durable evidence', async (mode) => {
    const fixture = await transferFixture()
    fixture.operations.verifyAndStartInstaller = vi.fn(async () => {
      expect(JSON.parse(await readFile(join(fixture.root, 'install-started.json'), 'utf8'))).toEqual({
        schemaVersion: 1, token: fixture.handoff.token, manifestSha256: fixture.manifestValue.manifestSha256,
        sequence: fixture.manifestValue.sequence,
      })
      expect(await readFile(join(fixture.handoff.stageRoot, 'release.json'))).toEqual(fixture.manifest)
      if (mode === 'throw') throw new Error(`launch uncertain ${fixture.handoff.token} https://user:password@example.test?sig=secret`)
      return 7
    })
    const result = await runDesktopManagedUpdateHelper(fixture.handoff, fixture.operations)
    expect(result).toMatchObject({ status: 'blocked', phase: 'installer-launch', asset: 'installer.exe', installationState: 'may-have-started',
      errorType: mode === 'throw' ? 'installer-launch' : 'installer-exit' })
    const persisted = await readFile(join(mode === 'throw' ? fixture.root : fixture.handoff.stageRoot, 'helper-result.json'), 'utf8')
    expect(persisted).not.toContain(fixture.handoff.token)
    expect(persisted).not.toContain('secret')
    expect(JSON.parse(persisted)).toEqual(result)
  })
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
      expect(await readFile(join(root, 'release.json'))).toEqual(manifest)
      expect(JSON.parse(await readFile(join(root, 'install-started.json'), 'utf8'))).toEqual({
        schemaVersion: 1,
        token: 'e'.repeat(64),
        manifestSha256: manifestValue.manifestSha256,
        sequence: manifestValue.sequence,
      })
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
      reason: /integrity/u,
    },
    {
      name: 'lengthless response exceeds the declared size',
      servedInstaller: Buffer.from('installer-extra'),
      expectedSha256: sha256(Buffer.from('installer')),
      reason: /integrity/u,
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
    expect(operations.fetch).toHaveBeenCalledTimes(3)
    expect(result).toMatchObject({ phase: 'installer-download', asset: 'installer.exe', errorType: 'integrity', installationState: 'not-started' })
    await expect(readFile(join(root, 'install-started.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
