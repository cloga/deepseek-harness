/** Detached Windows updater that validates one handoff before Desktop releases its processes. */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { spawn } from 'node:child_process'
import {
  managedUpdateAssetUrl,
  parseDesktopManagedUpdateHandoff,
  parseDesktopManagedUpdateManifest,
  type DesktopAcceptedManagedUpdateManifest,
  type DesktopManagedUpdateHandoff,
} from './managed-update-protocol.ts'

import {
  ManagedUpdateTransferError,
  managedUpdateTransferDiagnostic,
  readManagedUpdateMetadata,
  withManagedUpdateResponse,
} from './managed-update-network.ts'

const MAX_MANIFEST_BYTES = 1024 * 1024
const MAX_RECEIPT_BYTES = 16 * 1024 * 1024

/** Persisted helper progress; only installer launch permits installed-state reconciliation. */
export type DesktopManagedUpdateHelperPhase =
  | 'manifest-download' | 'manifest-validation' | 'acknowledgement' | 'process-wait'
  | 'receipt-download' | 'receipt-validation' | 'installer-download' | 'stage-promotion'
  | 'installer-verification' | 'installer-launch' | 'result-persistence'

/** Closed diagnostic categories; never persist raw transport or operating-system messages. */
export type DesktopManagedUpdateHelperErrorType =
  | 'timeout' | 'network-reset' | 'http' | 'redirect' | 'integrity'
  | 'cancelled' | 'process-wait' | 'installer-launch' | 'installer-exit' | 'io' | 'unknown'
const SENSITIVE_ENVIRONMENT_NAME = /(?:AUTH|KEY|SECRET|TOKEN|PASSWORD)|^(?:ALL|HTTP|HTTPS|NO)_PROXY$/iu

/** Result persisted for the newly installed Desktop to validate and complete. */
export type DesktopManagedUpdateHelperResult =
  | {
    readonly schemaVersion: 1
    readonly status: 'installer-exited'
    readonly manifestSha256: string
    readonly sequence: number
    readonly installerExitCode: 0
    readonly pendingCompletion: true
  }
  | {
    readonly schemaVersion: 1
    readonly status: 'blocked'
    readonly manifestSha256: string
    readonly sequence: number
    readonly reason: string
    readonly phase: DesktopManagedUpdateHelperPhase
    readonly asset?: string
    readonly errorType: DesktopManagedUpdateHelperErrorType
    readonly installationState: 'not-started' | 'may-have-started'
    readonly installerExitCode?: number
  }

/** Injectable operating-system and network operations used by helper tests. */
export interface DesktopManagedUpdateHelperOperations {
  fetch(this: void, url: string, init: RequestInit): Promise<Response>
  processRunning(pid: number): boolean
  sleep(milliseconds: number): Promise<void>
  now(): number
  verifyAndStartInstaller(
    this: void,
    path: string,
    expected: { readonly bytes: number; readonly sha256: string; readonly sha512: string; readonly signature: 'NotSigned' },
  ): Promise<number>
}

/** Remove credential-shaped variables before starting PowerShell or downloaded installer code. */
export function managedUpdateChildEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(environment)
    .filter(([name]) => !SENSITIVE_ENVIRONMENT_NAME.test(name)))
}

/**
 * Hold a non-writable file handle while PowerShell rehashes and starts the interactive installer.
 * @param path - Validated staged installer path.
 * @param expected - Manifest-owned file evidence and signature state.
 * @returns Installer exit code after the interactive process finishes.
 */
export function verifyAndStartManagedInstaller(
  path: string,
  expected: { readonly bytes: number; readonly sha256: string; readonly sha512: string; readonly signature: 'NotSigned' },
): Promise<number> {
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return new Promise((resolvePromise, reject) => {
    const child = spawn(powershell, [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        '$ErrorActionPreference = "Stop"',
        '$path = $env:DSH_MANAGED_UPDATE_INSTALLER',
        '$expectedBytes = [int64]$env:DSH_MANAGED_UPDATE_BYTES',
        '$expectedSha256 = $env:DSH_MANAGED_UPDATE_SHA256',
        '$expectedSha512 = $env:DSH_MANAGED_UPDATE_SHA512',
        '$expectedSignature = $env:DSH_MANAGED_UPDATE_SIGNATURE',
        '$env:DSH_MANAGED_UPDATE_INSTALLER = $null',
        '$env:DSH_MANAGED_UPDATE_BYTES = $null',
        '$env:DSH_MANAGED_UPDATE_SHA256 = $null',
        '$env:DSH_MANAGED_UPDATE_SHA512 = $null',
        '$env:DSH_MANAGED_UPDATE_SIGNATURE = $null',
        '$stream = [System.IO.File]::Open($path, "Open", "Read", "Read")',
        'try {',
        '  if ($stream.Length -ne $expectedBytes) { throw "installer size changed before launch" }',
        '  $sha256 = [System.Security.Cryptography.SHA256]::Create()',
        '  try { $actualSha256 = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "").ToLowerInvariant() } finally { $sha256.Dispose() }',
        '  $stream.Position = 0',
        '  $sha512 = [System.Security.Cryptography.SHA512]::Create()',
        '  try { $actualSha512 = [Convert]::ToBase64String($sha512.ComputeHash($stream)) } finally { $sha512.Dispose() }',
        '  if ($actualSha256 -ne $expectedSha256 -or $actualSha512 -ne $expectedSha512) { throw "installer hash changed before launch" }',
        '  Import-Module (Join-Path $env:SystemRoot "System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1")',
        '  $actualSignature = (Get-AuthenticodeSignature -LiteralPath $path).Status.ToString()',
        '  if ($actualSignature -ne $expectedSignature) { throw "installer signature state changed before launch" }',
        '  $installer = Start-Process -FilePath $path -PassThru',
        '} finally { $stream.Dispose() }',
        '$installer.WaitForExit()',
        '[Console]::Out.Write((ConvertTo-Json -Compress @{ exitCode = $installer.ExitCode }))',
      ].join('\n'),
    ], {
      env: {
        ...managedUpdateChildEnvironment(process.env),
        DSH_MANAGED_UPDATE_INSTALLER: path,
        DSH_MANAGED_UPDATE_BYTES: String(expected.bytes),
        DSH_MANAGED_UPDATE_SHA256: expected.sha256,
        DSH_MANAGED_UPDATE_SHA512: expected.sha512,
        DSH_MANAGED_UPDATE_SIGNATURE: expected.signature,
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let errorOutput = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => { output += chunk })
    child.stderr.on('data', (chunk: string) => { errorOutput += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`desktop managed update: installer verification or launch failed: ${errorOutput.trim()}`))
        return
      }
      let result: unknown
      try {
        result = JSON.parse(output)
      } catch {
        reject(new Error('desktop managed update: installer launcher returned invalid JSON'))
        return
      }
      if (typeof result !== 'object' || result === null || Array.isArray(result)
        || Object.keys(result).join(',') !== 'exitCode'
        || !Number.isSafeInteger((result as Record<string, unknown>).exitCode)) {
        reject(new Error('desktop managed update: installer launcher returned invalid result'))
        return
      }
      resolvePromise(Number((result as Record<string, unknown>).exitCode))
    })
  })
}

const defaultOperations: DesktopManagedUpdateHelperOperations = {
  fetch: (url, init) => fetch(url, init),
  processRunning(pid) {
    try {
      process.kill(pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  },
  sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
  verifyAndStartInstaller: verifyAndStartManagedInstaller,
}

async function fetchBytes(
  url: string,
  maximum: number,
  operations: DesktopManagedUpdateHelperOperations,
): Promise<Buffer> {
  return withManagedUpdateResponse(url, 'metadata', operations,
    (response, transfer) => readManagedUpdateMetadata(response, maximum, transfer))
}

function sha256(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex')
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}

function verifyBuildReceipt(
  body: Buffer,
  manifest: DesktopAcceptedManagedUpdateManifest,
  handoff: DesktopManagedUpdateHandoff,
): void {
  let value: unknown
  try {
    value = JSON.parse(body.toString('utf8'))
  } catch {
    throw new Error('desktop managed update: build receipt is not JSON')
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop managed update: build receipt must be an object')
  }
  const receipt = value as Record<string, unknown>
  const source = receipt.source
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    throw new Error('desktop managed update: build receipt omits source identity')
  }
  const identity = source as Record<string, unknown>
  const sourceMatches = manifest.owner === 'cloga/deepseek-harness'
    ? identity.commit === manifest.source.commit
      && (identity.tag === manifest.source.tag || identity.version === manifest.version)
    : identity.tag === handoff.capability.migration?.expectedSource.tag
  if (!sourceMatches) {
    throw new Error('desktop managed update: build receipt source does not match the local capability')
  }
  const repositories = manifest.owner === 'cloga/deepseek-harness'
    ? ['cloga/deepseek-harness', 'https://github.com/cloga/deepseek-harness.git']
    : ['deepseek-ai/deepseek-harness', 'https://github.com/deepseek-ai/deepseek-harness.git']
  if (!repositories.includes(String(identity.repository))) {
    throw new Error('desktop managed update: build receipt repository does not match the manifest owner')
  }
  if (manifest.owner === 'cloga/deepseek-harness' && identity.tree !== manifest.source.tree) {
    throw new Error('desktop managed update: build receipt tree does not match the manifest')
  }
  const expectedReceiptHash = manifest.buildReceipt.receiptSha256
  if (receipt.receiptSha256 !== expectedReceiptHash) {
    throw new Error('desktop managed update: build receipt acknowledgement does not match the manifest')
  }
}

async function hashFile(path: string): Promise<{ sha256: string; sha512: string; bytes: number }> {
  const sha256Hash = createHash('sha256')
  const sha512Hash = createHash('sha512')
  let bytes = 0
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new Error('desktop managed update: file hash stream returned text')
    sha256Hash.update(chunk)
    sha512Hash.update(chunk)
    bytes += chunk.length
  }
  return {
    sha256: sha256Hash.digest('hex'),
    sha512: sha512Hash.digest('base64'),
    bytes,
  }
}

async function downloadInstaller(
  url: string,
  path: string,
  expected: { bytes: number; sha256: string; sha512: string },
  operations: DesktopManagedUpdateHelperOperations,
): Promise<void> {
  await withManagedUpdateResponse(url, 'installer', operations, async (response, transfer) => {
    if (response.body === null) throw new ManagedUpdateTransferError('integrity')
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) !== expected.bytes)) {
      throw new ManagedUpdateTransferError('integrity')
    }
    let streamedBytes = 0
    const enforceSize = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        transfer.progress()
        streamedBytes += chunk.length
        if (streamedBytes > expected.bytes) callback(new ManagedUpdateTransferError('integrity'))
        else callback(undefined, chunk)
      },
    })
    // The Node adapter cancels a stalled Web reader on abort; a bare Web async iterator can hang.
    // pipeline settles and closes its writable before a retry can remove the partial file.
    try {
      // Node fetch supplies this Web stream at runtime; DOM and Node declarations differ for BYOB readers.
      const source = Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>)
      await pipeline(source, enforceSize, createWriteStream(path, { flags: 'wx', mode: 0o600 }), {
        signal: transfer.signal,
      })
    } catch (error) {
      await rm(path, { force: true })
      throw error
    }
  })
  const actual = await hashFile(path)
  if (actual.bytes !== expected.bytes || actual.sha256 !== expected.sha256 || actual.sha512 !== expected.sha512) {
    throw new ManagedUpdateTransferError('integrity')
  }
}

/** Wait only for the process ids named by the Electron handoff; never terminates a process. */
export async function waitForDesktopProcesses(
  pids: readonly number[],
  timeoutMs: number,
  operations: Pick<DesktopManagedUpdateHelperOperations, 'processRunning' | 'sleep' | 'now'>,
  cancelled: () => Promise<boolean> = () => Promise.resolve(false),
): Promise<void> {
  const started = operations.now()
  for (;;) {
    if (await cancelled()) throw new Error('desktop managed update: operation was cancelled')
    if (pids.every(pid => !operations.processRunning(pid))) return
    if (operations.now() - started >= timeoutMs) {
      throw new Error('desktop managed update: timed out waiting for Desktop processes to exit')
    }
    await operations.sleep(100)
  }
}

function helperErrorType(error: unknown, phase: DesktopManagedUpdateHelperPhase): DesktopManagedUpdateHelperErrorType {
  const diagnostic = managedUpdateTransferDiagnostic(error)
  if (diagnostic !== undefined) return diagnostic.errorType
  try {
    if (error instanceof Error && error.message === 'desktop managed update: operation was cancelled') return 'cancelled'
  } catch (_error) {
    // Unreadable prototypes or messages cannot prevent a closed phase-based result.
  }
  if (phase === 'installer-launch') return 'installer-launch'
  if (phase === 'manifest-validation' || phase === 'receipt-validation' || phase === 'installer-verification') return 'integrity'
  if (phase === 'process-wait') return 'process-wait'
  if (phase === 'acknowledgement' || phase === 'stage-promotion' || phase === 'result-persistence') return 'io'
  return 'unknown'
}

/**
 * Validate and persist metadata before acknowledgement, then stage and launch the installer.
 * @param handoffValue - Untrusted handoff JSON; invalid handoffs are rejected without writing files.
 * @param operations - Network and operating-system operations.
 * @returns A persisted result; blocked results contain only closed diagnostic categories.
 */
export async function runDesktopManagedUpdateHelper(
  handoffValue: unknown,
  operations: DesktopManagedUpdateHelperOperations = defaultOperations,
): Promise<DesktopManagedUpdateHelperResult> {
  const handoff = parseDesktopManagedUpdateHandoff(handoffValue)
  const manifestUrl = handoff.selection.manifestUrl
  const operationRoot = dirname(handoff.stageRoot)
  await mkdir(operationRoot, { recursive: true })
  let manifest: DesktopAcceptedManagedUpdateManifest | undefined
  let phase: DesktopManagedUpdateHelperPhase = 'manifest-download'
  let asset: string | undefined = 'release.json'
  let installationState: 'not-started' | 'may-have-started' = 'not-started'
  const cancellationPath = join(operationRoot, 'cancelled.json')
  const cancelled = async () => stat(cancellationPath).then(() => true, (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  })
  const temporary = `${handoff.stageRoot}.tmp-${handoff.token}`
  try {
    const manifestBody = await fetchBytes(manifestUrl, MAX_MANIFEST_BYTES, operations)
    phase = 'manifest-validation'
    if (sha256(manifestBody) !== handoff.selection.assetSha256) {
      throw new ManagedUpdateTransferError('integrity')
    }
    const manifestValue: unknown = JSON.parse(manifestBody.toString('utf8'))
    const parsedManifest = parseDesktopManagedUpdateManifest(manifestValue, handoff.capability, handoff.installedSequence)
    if (parsedManifest.manifestSha256 !== handoff.selection.manifestSha256
      || (handoff.selection.kind === 'source') !== (parsedManifest.owner === 'cloga/deepseek-harness')) {
      throw new ManagedUpdateTransferError('integrity')
    }
    manifest = parsedManifest
    phase = 'acknowledgement'
    if (await cancelled()) throw new Error('desktop managed update: operation was cancelled')
    // Completion can independently validate installed evidence even when staging never finishes.
    await writeFile(join(operationRoot, 'release.json'), manifestBody, { flag: 'wx', mode: 0o600 })
    await writeJsonAtomic(join(operationRoot, 'ack.json'), {
      schemaVersion: 1,
      token: handoff.token,
      manifestSha256: manifest.manifestSha256,
      helperPid: process.pid,
    })
    phase = 'process-wait'
    asset = undefined
    await waitForDesktopProcesses(handoff.waitPids, handoff.waitTimeoutMs, operations, cancelled)
    if (await cancelled()) throw new Error('desktop managed update: operation was cancelled')
    await rm(temporary, { recursive: true, force: true })
    await mkdir(temporary, { recursive: true })
    const buildReceipt = manifest.buildReceipt
    phase = 'receipt-download'
    asset = buildReceipt.file
    const receiptBody = await fetchBytes(
      managedUpdateAssetUrl(manifestUrl, buildReceipt.file),
      MAX_RECEIPT_BYTES,
      operations,
    )
    phase = 'receipt-validation'
    if (sha256(receiptBody) !== buildReceipt.sha256) {
      throw new Error('desktop managed update: build receipt file hash does not match the manifest')
    }
    verifyBuildReceipt(receiptBody, manifest, handoff)
    await writeFile(join(temporary, buildReceipt.file), receiptBody, { flag: 'wx', mode: 0o600 })

    phase = 'installer-download'
    asset = manifest.installer.file
    const installer = manifest.installer
    const installerPath = join(temporary, installer.file)
    await downloadInstaller(
      managedUpdateAssetUrl(manifestUrl, installer.file),
      installerPath,
      {
        bytes: 'bytes' in installer ? installer.bytes : installer.size,
        sha256: installer.sha256,
        sha512: installer.sha512,
      },
      operations,
    )
    phase = 'stage-promotion'
    asset = undefined
    await writeFile(join(temporary, 'release.json'), manifestBody, { flag: 'wx', mode: 0o600 })
    await writeJsonAtomic(join(temporary, 'pending-completion.json'), {
      schemaVersion: 1,
      manifestSha256: manifest.manifestSha256,
      sequence: manifest.sequence,
      installedEvidence: manifest.installedEvidence,
    })
    if (await stat(handoff.stageRoot).then(() => true, () => false)) {
      throw new Error('desktop managed update: stage root already exists')
    }
    await rename(temporary, handoff.stageRoot)

    phase = 'installer-verification'
    asset = manifest.installer.file
    const stagedInstaller = join(handoff.stageRoot, installer.file)
    const beforeLaunch = await hashFile(stagedInstaller)
    const expectedBytes = 'bytes' in installer ? installer.bytes : installer.size
    if (beforeLaunch.bytes !== expectedBytes || beforeLaunch.sha256 !== installer.sha256
      || beforeLaunch.sha512 !== installer.sha512 || basename(stagedInstaller) !== installer.file) {
      throw new Error('desktop managed update: staged installer changed before launch')
    }
    if (await cancelled()) throw new Error('desktop managed update: operation was cancelled')
    await writeJsonAtomic(join(operationRoot, 'install-started.json'), {
      schemaVersion: 1,
      token: handoff.token,
      manifestSha256: manifest.manifestSha256,
      sequence: manifest.sequence,
    })
    phase = 'installer-launch'
    // A throw or process interruption after this call cannot establish that the installer never ran.
    installationState = 'may-have-started'
    const installerExitCode = await operations.verifyAndStartInstaller(stagedInstaller, {
      bytes: expectedBytes,
      sha256: installer.sha256,
      sha512: installer.sha512,
      signature: 'NotSigned',
    })
    const result: DesktopManagedUpdateHelperResult = installerExitCode === 0
      ? {
        schemaVersion: 1,
        status: 'installer-exited',
        manifestSha256: manifest.manifestSha256,
        sequence: manifest.sequence,
        installerExitCode: 0,
        pendingCompletion: true,
      }
      : {
        schemaVersion: 1,
        status: 'blocked',
        manifestSha256: manifest.manifestSha256,
        sequence: manifest.sequence,
        reason: `installer-exit-${String(installerExitCode)}`,
        phase,
        asset,
        errorType: 'installer-exit',
        installationState,
        installerExitCode,
      }
    phase = 'result-persistence'
    asset = undefined
    await writeJsonAtomic(join(handoff.stageRoot, 'helper-result.json'), result)
    return result
  } catch (error) {
    await rm(temporary, { recursive: true, force: true })
    const errorType = helperErrorType(error, phase)
    const result: DesktopManagedUpdateHelperResult = {
      schemaVersion: 1,
      status: 'blocked',
      manifestSha256: handoff.selection.manifestSha256,
      sequence: manifest?.sequence ?? handoff.installedSequence,
      phase,
      ...(asset === undefined ? {} : { asset }),
      errorType,
      installationState,
      reason: `desktop managed update: ${phase}: ${errorType}`,
    }
    await writeJsonAtomic(join(operationRoot, 'helper-result.json'), result)
    return result
  }
}

async function main(): Promise<void> {
  const handoffPath = process.argv[2]
  if (handoffPath === undefined || !isAbsolute(handoffPath) || basename(handoffPath) !== 'handoff.json') {
    throw new Error('desktop managed update: helper expects one absolute handoff.json path')
  }
  const details = await stat(handoffPath)
  if (!details.isFile() || details.size > MAX_MANIFEST_BYTES) {
    throw new Error('desktop managed update: handoff file is invalid')
  }
  const handoff: unknown = JSON.parse(await readFile(handoffPath, 'utf8'))
  const parsedHandoff = parseDesktopManagedUpdateHandoff(handoff)
  if (resolve(parsedHandoff.stageRoot) !== resolve(dirname(handoffPath), 'stage')) {
    throw new Error('desktop managed update: handoff stage root is outside its operation directory')
  }
  const result = await runDesktopManagedUpdateHelper(handoff)
  if (result.status === 'blocked') process.exitCode = 1
}

if (import.meta.main) {
  main().catch((_error: unknown) => {
    // Handoff/parser/filesystem errors may contain operation tokens or credential-bearing paths.
    process.stderr.write('desktop managed update: helper failed before a result could be persisted\n')
    process.exitCode = 1
  })
}
