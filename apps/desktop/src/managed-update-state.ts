/** Packaged capability and durable completion records for Windows managed updates. */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDesktopManagedUpdateCapability, type DesktopManagedUpdateCapability } from './managed-update-protocol.ts'

/** Managed mode selected by a packaged build and its last completed sequence. */
export interface DesktopManagedUpdateConfiguration {
  readonly capability: DesktopManagedUpdateCapability
  readonly installedSequence: number
  readonly operationsRoot: string
  readonly helperBundle: string
  readonly completionPath: string
}

async function readJsonIfPresent(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

function parseCompletedSequence(value: unknown): number {
  if (value === undefined) return 0
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('desktop managed update: completion receipt must be an object')
  }
  const receipt = value as Record<string, unknown>
  if (Object.keys(receipt).sort().join(',') !== 'manifestSha256,schemaVersion,sequence,status'
    || receipt.schemaVersion !== 1 || receipt.status !== 'complete'
    || typeof receipt.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(receipt.manifestSha256)
    || !Number.isSafeInteger(receipt.sequence) || Number(receipt.sequence) < 1) {
    throw new Error('desktop managed update: completion receipt is invalid')
  }
  return Number(receipt.sequence)
}

/**
 * Select managed mode only when a packaged Windows build carries its immutable capability.
 * Native app-update configuration and managed mode are mutually exclusive.
 */
export async function loadDesktopManagedUpdateConfiguration(
  resourcesPath: string,
  userDataPath: string,
  platform: NodeJS.Platform,
): Promise<DesktopManagedUpdateConfiguration | undefined> {
  const capabilityPath = join(resourcesPath, 'managed-update', 'capability.json')
  if (!existsSync(capabilityPath)) return undefined
  if (platform !== 'win32') throw new Error('desktop managed update: packaged capability requires Windows')
  if (existsSync(join(resourcesPath, 'app-update.yml'))) {
    throw new Error('desktop managed update: native and managed update modes cannot both be enabled')
  }
  const capability = parseDesktopManagedUpdateCapability(await readJsonIfPresent(capabilityPath))
  const helperBundle = join(resourcesPath, 'managed-update', 'helper.mjs')
  if (!existsSync(helperBundle)) {
    throw new Error('desktop managed update: packaged capability requires the updater helper')
  }
  const stateRoot = join(userDataPath, 'managed-update')
  const completedSequence = parseCompletedSequence(await readJsonIfPresent(join(stateRoot, 'completion.json')))
  return {
    capability,
    installedSequence: Math.max(capability.currentSequence, completedSequence),
    operationsRoot: join(stateRoot, 'operations'),
    helperBundle,
    completionPath: join(stateRoot, 'completion.json'),
  }
}
