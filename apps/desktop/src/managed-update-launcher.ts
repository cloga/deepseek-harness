/** Electron-side creation and acknowledgement of one detached updater helper. */

import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import type { DesktopManagedUpdateCapability, DesktopManagedUpdateHandoff } from './managed-update-protocol.ts'

/** Fixed inputs owned by the packaged Electron main process. */
export interface DesktopManagedUpdateLaunch {
  readonly operationsRoot: string
  readonly nodeExecutable: string
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
  readonly abandon: () => Promise<void>
}

interface LaunchOperations {
  readonly spawn: typeof spawn
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
    if (child.exitCode !== null) return Promise.resolve(true)
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
  if (child.exitCode !== null) return
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
 */
export async function launchDesktopManagedUpdate(
  launch: DesktopManagedUpdateLaunch,
  operations: LaunchOperations = defaultOperations,
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
  const child = operations.spawn(node, [helper, handoffPath], {
    cwd: operationRoot,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: helperEnvironment(),
  })
  if (child.pid === undefined) {
    child.kill()
    throw new Error('desktop managed update: helper process did not start')
  }
  child.unref()
  try {
    const deadline = operations.now() + 15_000
    for (;;) {
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
          abandon: () => abandonHelper(operationRoot, token, child, operations),
        }
      }
      if (child.exitCode !== null) throw new Error(`desktop managed update: helper exited before acknowledgement (${String(child.exitCode)})`)
      if (operations.now() >= deadline) throw new Error('desktop managed update: helper did not acknowledge the handoff')
      await operations.sleep(50)
    }
  } catch (error) {
    try {
      await abandonHelper(operationRoot, token, child, operations)
    } catch (cancellationError) {
      throw new AggregateError(
        [error, cancellationError],
        'desktop managed update: helper handoff failed and cancellation did not complete',
      )
    }
    throw error
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
