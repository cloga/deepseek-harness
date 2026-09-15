/** Strict post-installer evidence checks and durable managed-update completion. */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  parseDesktopManagedUpdateManifest,
  type DesktopManagedUpdateCapability,
} from './managed-update-protocol.ts'

const RECOVERY_COMMAND = 'pwsh -NoProfile -File .\\Install-DshOfficialDesktop.ps1 -Action Complete'

/** Startup result shown by Desktop instead of claiming an incomplete update succeeded. */
export type DesktopManagedUpdateCompletion =
  | { readonly status: 'none' }
  | { readonly status: 'complete'; readonly sequence: number; readonly version: string }
  | { readonly status: 'recovery-required'; readonly message: string; readonly command: string }

async function sha256File(path: string): Promise<string> {
  const digest = createHash('sha256')
  for await (const chunk of createReadStream(path)) {
    if (!Buffer.isBuffer(chunk)) throw new Error('desktop managed update: file hash stream returned text')
    digest.update(chunk)
  }
  return digest.digest('hex')
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  const value: unknown = JSON.parse(await readFile(path, 'utf8'))
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`)
  }
  return value as Record<string, unknown>
}

async function readJsonIfExists(path: string): Promise<Record<string, unknown> | undefined> {
  try {
    return await readJson(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`
  await writeFile(temporary, `${JSON.stringify(value, undefined, 2)}\n`, { flag: 'wx', mode: 0o600 })
  await rename(temporary, path)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`desktop managed update: ${label} has unsupported fields`)
  }
}

/**
 * Complete one helper operation after verifying the installed executable, runtime descriptor, and plugin transaction.
 * @param operationsRoot - Desktop-owned operation directory.
 * @param completionPath - Durable sequence receipt path.
 * @param capability - Build-carried immutable channel selection.
 * @param installedSequence - Last previously completed sequence.
 * @param executable - Running installed Desktop executable.
 * @param runtimeDescriptor - Installed Desktop runtime descriptor.
 */
export async function completeDesktopManagedUpdate(
  operationsRoot: string,
  completionPath: string,
  capability: DesktopManagedUpdateCapability,
  installedSequence: number,
  executable: string,
  runtimeDescriptor: string,
): Promise<DesktopManagedUpdateCompletion> {
  let operationNames: string[]
  try {
    operationNames = await readdir(operationsRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'none' }
    throw error
  }
  const candidates: { root: string; result: Record<string, unknown> }[] = []
  for (const name of operationNames) {
    if (!/^[a-f0-9]{64}$/u.test(name)) continue
    const operationRoot = join(operationsRoot, name)
    const root = join(operationRoot, 'stage')
    try {
      const cancellation = await readJsonIfExists(join(operationRoot, 'cancelled.json'))
      if (cancellation !== undefined) {
        exactKeys(cancellation, ['schemaVersion', 'token'], 'cancellation marker')
        if (cancellation.schemaVersion !== 1 || cancellation.token !== name) {
          throw new Error('desktop managed update: cancellation marker does not match its operation')
        }
        continue
      }
      const blocked = await readJsonIfExists(join(operationRoot, 'helper-result.json'))
      if (blocked?.status === 'blocked'
        && Number.isSafeInteger(blocked.sequence) && Number(blocked.sequence) > installedSequence) {
        return {
          status: 'recovery-required',
          message: typeof blocked.reason === 'string' ? blocked.reason : 'The managed update helper could not continue.',
          command: RECOVERY_COMMAND,
        }
      }
      const [acknowledgement, result, pending] = await Promise.all([
        readJsonIfExists(join(operationRoot, 'ack.json')),
        readJsonIfExists(join(root, 'helper-result.json')),
        readJsonIfExists(join(root, 'pending-completion.json')),
      ])
      if (acknowledgement !== undefined) {
        exactKeys(acknowledgement, ['schemaVersion', 'token', 'manifestSha256', 'helperPid'], 'helper acknowledgement')
        const acknowledgedManifest = acknowledgement.manifestSha256
        if (acknowledgement.schemaVersion !== 1 || acknowledgement.token !== name
          || !Number.isSafeInteger(acknowledgement.helperPid) || Number(acknowledgement.helperPid) <= 0
          || typeof acknowledgedManifest !== 'string' || !/^[a-f0-9]{64}$/u.test(acknowledgedManifest)) {
          throw new Error('desktop managed update: helper acknowledgement does not match its operation')
        }
        if (result === undefined && pending === undefined) {
          return {
            status: 'recovery-required',
            message: 'The managed update helper acknowledged the handoff but did not record a terminal result.',
            command: RECOVERY_COMMAND,
          }
        }
      }
      const resultSequence = Number.isSafeInteger(result?.sequence) ? Number(result?.sequence) : undefined
      const pendingSequence = Number.isSafeInteger(pending?.sequence) ? Number(pending?.sequence) : undefined
      if (result?.status === 'blocked' && resultSequence !== undefined && resultSequence > installedSequence) {
        return {
          status: 'recovery-required',
          message: typeof result.reason === 'string' ? result.reason : 'The managed update installer did not complete.',
          command: RECOVERY_COMMAND,
        }
      }
      if (pendingSequence !== undefined && pendingSequence > installedSequence && result === undefined) {
        return {
          status: 'recovery-required',
          message: 'The managed update was interrupted before the installer result was recorded.',
          command: RECOVERY_COMMAND,
        }
      }
      if (result?.status === 'installer-exited' && resultSequence !== undefined && resultSequence > installedSequence) {
        if (pending === undefined) {
          return {
            status: 'recovery-required',
            message: 'The managed update helper result has no pending completion receipt.',
            command: RECOVERY_COMMAND,
          }
        }
        candidates.push({ root, result })
      } else if (pendingSequence !== undefined && pendingSequence > installedSequence) {
        return {
          status: 'recovery-required',
          message: 'The managed update operation has an invalid terminal result.',
          command: RECOVERY_COMMAND,
        }
      }
    } catch (error) {
      return {
        status: 'recovery-required',
        message: error instanceof Error ? error.message : String(error),
        command: RECOVERY_COMMAND,
      }
    }
  }
  if (candidates.length === 0) return { status: 'none' }
  if (candidates.length !== 1) {
    return { status: 'recovery-required', message: 'Multiple pending managed updates require recovery.', command: RECOVERY_COMMAND }
  }
  try {
    const candidate = candidates[0]
    if (candidate === undefined) {
      throw new Error('desktop managed update: pending operation disappeared')
    }
    exactKeys(candidate.result, [
      'schemaVersion',
      'status',
      'manifestSha256',
      'sequence',
      'installerExitCode',
      'pendingCompletion',
    ], 'helper result')
    if (candidate.result.schemaVersion !== 1 || candidate.result.status !== 'installer-exited'
      || candidate.result.installerExitCode !== 0 || candidate.result.pendingCompletion !== true) {
      throw new Error('desktop managed update: helper result is not completable')
    }
    const manifestValue = await readJson(join(candidate.root, 'release.json'))
    const manifest = parseDesktopManagedUpdateManifest(manifestValue, capability, installedSequence)
    if (manifest.owner !== 'cloga/deepseek-harness') {
      throw new Error('desktop managed update: legacy release requires Windows Ops Complete')
    }
    if (candidate.result.manifestSha256 !== manifest.manifestSha256
      || candidate.result.sequence !== manifest.sequence) {
      throw new Error('desktop managed update: helper result does not match the staged manifest')
    }
    const pending = await readJson(join(candidate.root, 'pending-completion.json'))
    exactKeys(pending, ['schemaVersion', 'manifestSha256', 'sequence', 'installedEvidence'], 'pending completion')
    if (pending.schemaVersion !== 1 || pending.manifestSha256 !== manifest.manifestSha256
      || pending.sequence !== manifest.sequence
      || JSON.stringify(pending.installedEvidence) !== JSON.stringify(manifest.installedEvidence)) {
      throw new Error('desktop managed update: pending completion does not match the staged manifest')
    }
    const [executableSha256, runtimeSha256] = await Promise.all([
      sha256File(executable),
      sha256File(runtimeDescriptor),
    ])
    if (executableSha256 !== manifest.installedEvidence.executableSha256
      || runtimeSha256 !== manifest.installedEvidence.runtimeSha256) {
      throw new Error('desktop managed update: installed application evidence does not match the release')
    }
    await writeJsonAtomic(completionPath, {
      schemaVersion: 1,
      status: 'complete',
      sequence: manifest.sequence,
      manifestSha256: manifest.manifestSha256,
    })
    return { status: 'complete', sequence: manifest.sequence, version: manifest.version }
  } catch (error) {
    return {
      status: 'recovery-required',
      message: error instanceof Error ? error.message : String(error),
      command: RECOVERY_COMMAND,
    }
  }
}
