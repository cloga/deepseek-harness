/** Electron-side creation and acknowledgement of one detached updater helper. */

import { randomBytes } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { spawn } from 'node:child_process'
import type { DesktopManagedUpdateCapability, DesktopManagedUpdateHandoff } from './managed-update-protocol.ts'

/** Fixed inputs owned by the packaged Electron main process. */
export interface DesktopManagedUpdateLaunch {
  readonly operationsRoot: string
  readonly nodeExecutable: string
  readonly helperBundle: string
  readonly capability: DesktopManagedUpdateCapability
  readonly selectedManifest: 'source' | 'migration'
  readonly installedSequence: number
  readonly waitPids: readonly number[]
}

/** Detached helper acknowledgement required before Desktop may exit. */
export interface DesktopManagedUpdateAcknowledgement {
  readonly operationRoot: string
  readonly helperPid: number
  readonly token: string
}

interface LaunchOperations {
  readonly spawn: typeof spawn
  readonly sleep: (milliseconds: number) => Promise<void>
  readonly now: () => number
  readonly platform: NodeJS.Platform
}

const defaultOperations: LaunchOperations = {
  spawn,
  sleep: milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
  now: () => Date.now(),
  platform: process.platform,
}

function helperEnvironment(): NodeJS.ProcessEnv {
  const names = ['SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'HTTPS_PROXY', 'NO_PROXY']
  return Object.fromEntries(names.flatMap(name => process.env[name] === undefined ? [] : [[name, process.env[name]]]))
}

async function readAcknowledgement(
  path: string,
  token: string,
  expectedManifestSha256: string,
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
    || !Number.isSafeInteger(acknowledgement.helperPid) || Number(acknowledgement.helperPid) < 1) {
    throw new Error('desktop managed update: helper acknowledgement is invalid')
  }
  return Number(acknowledgement.helperPid)
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
    selectedManifest: launch.selectedManifest,
    stageRoot: join(operationRoot, 'stage'),
    waitPids: launch.waitPids,
    waitTimeoutMs: 120_000,
    installedSequence: launch.installedSequence,
  }
  const handoffPath = join(operationRoot, 'handoff.json')
  await writeFile(handoffPath, `${JSON.stringify(handoff, undefined, 2)}\n`, { flag: 'wx', mode: 0o600 })
  const child = operations.spawn(node, [helper, handoffPath], {
    cwd: operationRoot,
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
    env: helperEnvironment(),
  })
  child.unref()
  const expectedManifestSha256 = launch.selectedManifest === 'source'
    ? launch.capability.manifestSha256
    : launch.capability.migration?.manifestSha256
  if (expectedManifestSha256 === undefined) {
    throw new Error('desktop managed update: selected migration has no locked manifest')
  }
  const deadline = operations.now() + 15_000
  for (;;) {
    const helperPid = await readAcknowledgement(
      join(operationRoot, 'ack.json'),
      token,
      expectedManifestSha256,
    )
    if (helperPid !== undefined) return { operationRoot, helperPid, token }
    if (child.exitCode !== null) throw new Error(`desktop managed update: helper exited before acknowledgement (${String(child.exitCode)})`)
    if (operations.now() >= deadline) throw new Error('desktop managed update: helper did not acknowledge the handoff')
    await operations.sleep(50)
  }
}

/**
 * Preserve the handoff order: claim updater-owned quit only after acknowledgement, then stop Host and quit Electron.
 * @param acknowledge - Detached helper launch and acknowledgement.
 * @param claimQuit - Transfer before-quit ownership to the updater path.
 * @param stopHost - Graceful application-owned Host teardown.
 * @param quit - Electron quit request.
 */
export async function completeDesktopManagedUpdateHandoff(
  acknowledge: () => Promise<DesktopManagedUpdateAcknowledgement>,
  claimQuit: () => void,
  stopHost: () => Promise<void>,
  quit: () => void,
): Promise<void> {
  await acknowledge()
  claimQuit()
  await stopHost()
  quit()
}
