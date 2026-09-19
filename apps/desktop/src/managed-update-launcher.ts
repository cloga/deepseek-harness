/** Electron-side creation and acknowledgement of one detached updater helper. */

import { createHash, randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { Socket } from 'node:net'
import type { DesktopManagedUpdateCapability, DesktopManagedUpdateHandoff } from './managed-update-protocol.ts'

/** Fixed inputs owned by the packaged Electron main process. */
export interface DesktopManagedUpdateLaunch {
  readonly operationsRoot: string
  readonly nodeExecutable: string
  /** Expected standalone Node bytes bound by the installed Desktop runtime inventory. */
  readonly nodeSha256: string
  readonly helperBundle: string
  readonly capability: DesktopManagedUpdateCapability
  readonly selection: {
    readonly kind: 'source' | 'migration'
    readonly manifestUrl: string
    readonly manifestSha256: string
    readonly assetSha256: string
  }
  readonly installedSequence: number
  readonly waitPids: readonly number[]
}

/** Detached helper acknowledgement required before Desktop may exit. */
export interface DesktopManagedUpdateAcknowledgement {
  readonly operationRoot: string
  readonly helperPid: number
  readonly token: string
  /** Confirms owned helper exit; query isDesktopManagedUpdateHelperQuiescent on a rejection. */
  readonly abandon: () => Promise<void>
}

const quiescentFailures = new WeakSet<object>()

/**
 * Read launcher-owned evidence attached to this exact failure, never an error message or caller flag.
 * @param error - Failure returned by helper launch or its owned abandonment operation.
 * @returns Whether no helper started, or the owned helper is confirmed exited.
 */
export function isDesktopManagedUpdateHelperQuiescent(error: unknown): boolean {
  return typeof error === 'object' && error !== null && quiescentFailures.has(error)
}

function helperFailure(error: unknown, quiescent: boolean): unknown {
  if (typeof error === 'object' && error !== null) {
    if (quiescent) quiescentFailures.add(error)
    else quiescentFailures.delete(error)
  }
  return error
}

/** Actual process exit, not the ChildProcess.killed termination-request flag. */
function helperExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null
}

interface LaunchOperations {
  readonly spawn: (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess
  readonly sleep: (milliseconds: number) => Promise<void>
  readonly now: () => number
  readonly platform: NodeJS.Platform
  readonly waitForExit: (child: ChildProcess, timeoutMs: number) => Promise<boolean>
}

const defaultOperations: LaunchOperations = {
  spawn,
  sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
  platform: process.platform,
  waitForExit(child, timeoutMs) {
    if (helperExited(child)) return Promise.resolve(true)
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        child.removeListener('exit', onExit)
        resolve(false)
      }, timeoutMs)
      const onExit = () => {
        clearTimeout(timeout)
        resolve(true)
      }
      child.once('exit', onExit)
    })
  },
}

function helperEnvironment(): NodeJS.ProcessEnv {
  const names = ['SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HTTPS_PROXY', 'NO_PROXY']
  return Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
}

const STDERR_LIMIT = 16 * 1024

function diagnosticText(text: string, token: string): string {
  return text.replaceAll(token, '[operation]')
    .replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/giu, '$1[redacted]@')
    .replace(/(https?:\/\/[^?\s"'<>]+)\?[^\s"'<>]*/gu, '$1?[redacted]')
    .replace(/((?:authorization|token|password|secret|api[_-]?key)\s*[:=]\s*)(?:bearer\s+)?[^\s"',;]+/giu, '$1[redacted]')
}

async function readAcknowledgement(
  path: string,
  token: string,
  expectedManifestSha256: string,
  expectedHelperPid: number,
): Promise<number | undefined> {
  let value: unknown
  try {
    value = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop managed update: helper acknowledgement is invalid')
  }
  const acknowledgement = value as Record<string, unknown>
  if (Object.keys(acknowledgement).sort().join(',') !== 'helperPid,manifestSha256,schemaVersion,token'
    || acknowledgement.schemaVersion !== 1 || acknowledgement.token !== token
    || acknowledgement.manifestSha256 !== expectedManifestSha256
    || acknowledgement.helperPid !== expectedHelperPid) {
    throw new Error('desktop managed update: helper acknowledgement is invalid')
  }
  return acknowledgement.helperPid
}

async function abandonHelper(
  operationRoot: string,
  token: string,
  child: ChildProcess,
  operations: LaunchOperations,
): Promise<void> {
  try {
    await writeFile(join(operationRoot, 'cancelled.json'), `${JSON.stringify({
      schemaVersion: 1,
      token,
    }, undefined, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
  }
  if (helperExited(child)) return
  child.kill()
  if (!await operations.waitForExit(child, 5_000)) {
    throw new Error('desktop managed update: owned helper did not exit after cancellation')
  }
}

/**
 * Copy the runtime needed after Electron exits, start it detached, and wait for its one-time acknowledgement.
 * @param launch - Main-process-owned paths and validated update selection.
 * @param operations - Process and clock operations replaceable by tests.
 * @returns Claimed operation identity after the helper validates its handoff.
 * @throws Failure retaining its causes; isDesktopManagedUpdateHelperQuiescent distinguishes confirmed safe exit from uncertainty.
 */
export async function launchDesktopManagedUpdate(
  launch: DesktopManagedUpdateLaunch,
  operations: LaunchOperations = defaultOperations,
): Promise<DesktopManagedUpdateAcknowledgement> {
  const ownership = { quiescent: true }
  try { return await launchOwnedHelper(launch, operations, ownership) }
  catch (error) { throw helperFailure(error, ownership.quiescent) }
}

async function launchOwnedHelper(
  launch: DesktopManagedUpdateLaunch,
  operations: LaunchOperations,
  ownership: { quiescent: boolean },
): Promise<DesktopManagedUpdateAcknowledgement> {
  if (operations.platform !== 'win32') throw new Error('desktop managed update: helper launch requires Windows')
  const token = randomBytes(32).toString('hex')
  const operationRoot = join(launch.operationsRoot, token)
  await mkdir(launch.operationsRoot, { recursive: true })
  await mkdir(operationRoot, { recursive: false })
  const node = join(operationRoot, 'node.exe')
  const helper = join(operationRoot, 'helper.mjs')
  await Promise.all([
    copyFile(launch.nodeExecutable, node),
    copyFile(launch.helperBundle, helper),
  ])
  if (!/^[a-f0-9]{64}$/u.test(launch.nodeSha256)
    || createHash('sha256').update(await readFile(node)).digest('hex') !== launch.nodeSha256) {
    throw new Error('desktop managed update: copied standalone Node failed release verification')
  }
  const handoff: DesktopManagedUpdateHandoff = {
    schemaVersion: 1,
    token,
    capability: launch.capability,
    selection: launch.selection,
    stageRoot: join(operationRoot, 'stage'),
    waitPids: launch.waitPids,
    waitTimeoutMs: 120_000,
    installedSequence: launch.installedSequence,
  }
  const handoffPath = join(operationRoot, 'handoff.json')
  await writeFile(handoffPath, `${JSON.stringify(handoff, undefined, 2)}\n`, { flag: 'wx', mode: 0o600 })
  const expectedManifestSha256 = launch.selection.manifestSha256
  let spawnFailure: Error | undefined
  let stderr = Buffer.alloc(0)
  const capture = { truncated: false }
  const child = operations.spawn(node, [helper, handoffPath], {
    cwd: operationRoot,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
    env: helperEnvironment(),
  })
  ownership.quiescent = child.pid === undefined
  try {
    child.on('error', (error) => { spawnFailure = error })
    child.unref()
    child.stderr?.on('data', (chunk: Buffer) => {
      const combined = Buffer.concat([stderr, chunk])
      capture.truncated ||= combined.byteLength > STDERR_LIMIT
      stderr = combined.subarray(Math.max(0, combined.byteLength - STDERR_LIMIT))
    })
    if (child.stderr instanceof Socket) child.stderr.unref()
    if (child.pid === undefined) throw new Error('desktop managed update: helper process did not start')
    // Three bounded metadata attempts plus backoff fit within 181.5 seconds; wait-PIDs stay owned until acknowledgement.
    const deadline = operations.now() + 185_000
    for (;;) {
      if (spawnFailure !== undefined) throw spawnFailure
      const helperPid = await readAcknowledgement(
        join(operationRoot, 'ack.json'),
        token,
        expectedManifestSha256,
        child.pid,
      )
      if (helperPid !== undefined) {
        return {
          operationRoot,
          helperPid,
          token,
          abandon: async () => {
            try {
              await abandonHelper(operationRoot, token, child, operations)
              ownership.quiescent = true
            } catch (error) {
              ownership.quiescent ||= helperExited(child)
              throw helperFailure(error, ownership.quiescent)
            }
          },
        }
      }
      if (helperExited(child)) throw new Error(`desktop managed update: helper exited before acknowledgement (${String(child.exitCode)})`)
      if (operations.now() >= deadline) throw new Error('desktop managed update: helper did not acknowledge the handoff')
      await operations.sleep(50)
    }
  } catch (error) {
    try {
      if (child.pid !== undefined) await abandonHelper(operationRoot, token, child, operations)
      ownership.quiescent = true
    } catch (cancellationError) {
      ownership.quiescent ||= helperExited(child)
      throw new AggregateError(
        [error, cancellationError],
        'desktop managed update: helper handoff failed and cancellation did not complete',
      )
    }
    try { child.stderr?.destroy() } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'desktop managed update: helper failed and diagnostic stream cleanup failed')
    }
    const diagnosticPath = join(operationRoot, 'helper-startup-error.json')
    const captured = stderr.toString('utf8')
    const completeLines = capture.truncated
      ? (captured.includes('\n') ? captured.slice(captured.indexOf('\n') + 1) : '')
      : captured
    try {
      await writeFile(diagnosticPath, `${JSON.stringify({
        schemaVersion: 1,
        phase: 'before-acknowledgement',
        exitCode: child.exitCode,
        reason: diagnosticText(error instanceof Error ? error.message : String(error), token),
        stderr: diagnosticText(completeLines, token),
        stderrTruncated: capture.truncated,
      }, undefined, 2)}\n`, { flag: 'wx', mode: 0o600 })
    } catch (diagnosticError) {
      throw new AggregateError([error, diagnosticError], 'desktop managed update: helper failed and startup diagnostic could not be written')
    }
    throw new Error(`${diagnosticText(error instanceof Error ? error.message : String(error), token)}; `
      + 'see helper-startup-error.json in the managed-update operation directory', { cause: error })
  }
}

/**
 * Preserve the handoff order: claim updater-owned quit only after acknowledgement, then stop Host and quit Electron.
 * @param acknowledge - Detached helper launch and acknowledgement.
 * @param claimQuit - Transfer before-quit ownership to the updater path and return its rollback.
 * @param stopHost - Graceful application-owned Host teardown.
 * @param quit - Electron quit request.
 */
export async function completeDesktopManagedUpdateHandoff(
  acknowledge: () => Promise<DesktopManagedUpdateAcknowledgement>,
  claimQuit: () => () => void,
  stopHost: () => Promise<void>,
  quit: () => void,
): Promise<void> {
  const handoff = await acknowledge()
  const releaseQuit = claimQuit()
  try {
    await stopHost()
  } catch (error) {
    releaseQuit()
    try {
      await handoff.abandon()
    } catch (cancellationError) {
      throw new AggregateError(
        [error, cancellationError],
        'desktop managed update: Host stop failed and helper cancellation did not complete',
      )
    }
    throw error
  }
  quit()
}
