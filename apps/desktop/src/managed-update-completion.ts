/** Classify retained helper transactions and verify installed evidence before recording completion. */

import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import {
  parseDesktopManagedUpdateHandoff,
  parseDesktopManagedUpdateManifest,
  type DesktopManagedUpdateCapability,
  type DesktopManagedUpdateHandoff,
  type DesktopManagedUpdateManifest,
} from './managed-update-protocol.ts'
import { managedUpdateRecoveryCommand } from './managed-update-recovery.ts'
import {
  desktopPluginProvisioningPlanSha256,
  parseDesktopPluginProvisioningPlan,
} from './plugin-provisioning.ts'
import { assertDesktopProvisioningInventory } from './project-manager.ts'

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

function helperProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true
    throw error
  }
}

async function stageExists(path: string): Promise<boolean> {
  let details
  try {
    details = await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
  if (!details.isDirectory() || details.isSymbolicLink()) {
    throw new Error('desktop managed update: final stage is not a regular directory')
  }
  return true
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

/** Validate retained identity without making an old capability eligible to launch an updater. */
function retainedHandoffIdentity(
  value: Record<string, unknown>,
  currentCapability: DesktopManagedUpdateCapability,
): Pick<DesktopManagedUpdateHandoff, 'token' | 'stageRoot' | 'selection' | 'installedSequence'> {
  let normalized = value
  const capability = value.capability
  if (typeof capability === 'object' && capability !== null && !Array.isArray(capability)
    && 'schemaVersion' in capability && (capability.schemaVersion === 2 || capability.schemaVersion === 3)) {
    const historical = capability as Record<string, unknown>
    const schema2 = historical.schemaVersion === 2
    if (schema2) {
      exactKeys(historical, ['schemaVersion', 'mode', 'owner', 'tagPrefix', 'manifestAsset', 'currentSequence',
        'minimumSequence', ...(historical.migration === undefined ? [] : ['migration'])], 'historical capability')
    }
    let migration = historical.migration
    if (migration !== undefined) {
      if (typeof migration !== 'object' || migration === null || Array.isArray(migration)) {
        throw new Error('desktop managed update: historical migration must be an object')
      }
      const legacy = migration as Record<string, unknown>
      const source = legacy.expectedSource
      if (typeof source !== 'object' || source === null || Array.isArray(source)) {
        throw new Error('desktop managed update: historical migration source must be an object')
      }
      const expectedSource = source as Record<string, unknown>
      if (schema2 || 'commit' in expectedSource) {
        exactKeys(expectedSource, ['version', 'commit'], 'historical migration source')
        if (typeof expectedSource.commit !== 'string' || !/^[a-f0-9]{40}$/u.test(expectedSource.commit)) {
          throw new Error('desktop managed update: historical migration source commit is invalid')
        }
        migration = { ...legacy, expectedSource: {
          version: expectedSource.version, tag: `dsh-v${String(expectedSource.version)}`,
        } }
      }
    }
    // Supply only parser metadata missing from schema 2; never return this synthetic capability.
    normalized = { ...value, capability: {
      ...historical, schemaVersion: 3, ...(schema2 ? { provisioning: currentCapability.provisioning } : {}),
      ...(migration === undefined ? {} : { migration }),
    } }
  }
  const parsed = parseDesktopManagedUpdateHandoff(normalized)
  return { token: parsed.token, stageRoot: parsed.stageRoot, selection: parsed.selection, installedSequence: parsed.installedSequence }
}

function identity(value: Record<string, unknown>, label: string, minimumSequence = 1): { manifestSha256: string; sequence: number } {
  if (value.schemaVersion !== 1 || typeof value.manifestSha256 !== 'string'
    || !/^[a-f0-9]{64}$/u.test(value.manifestSha256)
    || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < minimumSequence) {
    throw new Error(`desktop managed update: ${label} has invalid release identity`)
  }
  return { manifestSha256: value.manifestSha256, sequence: value.sequence }
}

function blockedResult(value: Record<string, unknown>, minimumSequence = 1): void {
  const diagnosticKeys = value.installationState === undefined ? [] : [
    'phase', 'errorType', 'installationState', ...(value.asset === undefined ? [] : ['asset']),
  ]
  exactKeys(value, [
    'schemaVersion', 'status', 'manifestSha256', 'sequence', 'reason',
    ...(value.installerExitCode === undefined ? [] : ['installerExitCode']), ...diagnosticKeys,
  ], 'blocked helper result')
  identity(value, 'blocked helper result', minimumSequence)
  if (value.status !== 'blocked' || typeof value.reason !== 'string' || value.reason === ''
    || (value.installerExitCode !== undefined && (!Number.isSafeInteger(value.installerExitCode)
      || value.installerExitCode === 0))
    || (diagnosticKeys.length > 0 && (typeof value.phase !== 'string' || value.phase === ''
      || typeof value.errorType !== 'string' || value.errorType === ''
      || (value.asset !== undefined && (typeof value.asset !== 'string' || value.asset === ''))
      || !['not-started', 'may-have-started'].includes(String(value.installationState))))) {
    throw new Error('desktop managed update: invalid blocked helper result')
  }
}

interface PendingFailure {
  readonly sequence: number
  readonly manifestSha256: string
  readonly message: string
}

interface OperationClassification {
  readonly status: 'none' | 'pre-install-failed' | 'pending'
  readonly candidate?: DesktopManagedUpdateManifest
  readonly failure?: PendingFailure
}

async function classifyOperation(
  operationRoot: string,
  token: string,
  capability: DesktopManagedUpdateCapability,
  completedSequence: number,
  helperRunning: (pid: number) => boolean,
): Promise<OperationClassification> {
  const stage = join(operationRoot, 'stage')
  const [hasStage, cancellation, acknowledgement, rootResult, started, handoffValue] = await Promise.all([
    stageExists(stage),
    readJsonIfExists(join(operationRoot, 'cancelled.json')),
    readJsonIfExists(join(operationRoot, 'ack.json')),
    readJsonIfExists(join(operationRoot, 'helper-result.json')),
    readJsonIfExists(join(operationRoot, 'install-started.json')),
    readJsonIfExists(join(operationRoot, 'handoff.json')),
  ])
  const handoff = handoffValue === undefined ? undefined : retainedHandoffIdentity(handoffValue, capability)
  if (handoff !== undefined && (handoff.token !== token || resolve(handoff.stageRoot) !== resolve(stage))) {
    throw new Error('desktop managed update: handoff does not match its operation')
  }
  if (acknowledgement !== undefined) {
    exactKeys(acknowledgement, ['schemaVersion', 'token', 'manifestSha256', 'helperPid'], 'helper acknowledgement')
    if (acknowledgement.schemaVersion !== 1 || acknowledgement.token !== token
      || !Number.isSafeInteger(acknowledgement.helperPid) || Number(acknowledgement.helperPid) <= 0
      || typeof acknowledgement.manifestSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(acknowledgement.manifestSha256)
      || (handoff !== undefined && handoff.selection.manifestSha256 !== acknowledgement.manifestSha256)) {
      throw new Error('desktop managed update: helper acknowledgement does not match its operation')
    }
  }
  const bindIdentity = (value: { readonly manifestSha256?: unknown }): void => {
    if ((acknowledgement !== undefined && value.manifestSha256 !== acknowledgement.manifestSha256)
      || (handoff !== undefined && value.manifestSha256 !== handoff.selection.manifestSha256)) {
      throw new Error('desktop managed update: recorded release does not match the acknowledged handoff')
    }
  }
  const readManifest = async (path: string): Promise<ReturnType<typeof parseDesktopManagedUpdateManifest>> => {
    const body = await readFile(path)
    if (handoff !== undefined && createHash('sha256').update(body).digest('hex') !== handoff.selection.assetSha256) {
      throw new Error('desktop managed update: retained manifest file hash does not match the handoff')
    }
    const value: unknown = JSON.parse(body.toString('utf8'))
    const recordedSequence = typeof value === 'object' && value !== null && 'sequence' in value ? value.sequence : undefined
    // The discovery floor cannot invalidate history already covered by a verified completion receipt.
    const historical = typeof recordedSequence === 'number' && Number.isSafeInteger(recordedSequence)
      && recordedSequence >= 1 && recordedSequence <= completedSequence && recordedSequence < capability.minimumSequence
    const manifest = parseDesktopManagedUpdateManifest(value,
      historical ? { ...capability, minimumSequence: recordedSequence } : capability, 0)
    bindIdentity(manifest)
    if (handoff !== undefined && ((handoff.selection.kind === 'source') !== (manifest.owner === 'cloga/deepseek-harness'))) {
      throw new Error('desktop managed update: retained manifest owner does not match the handoff')
    }
    return manifest
  }
  if (started !== undefined) {
    exactKeys(started, ['schemaVersion', 'token', 'manifestSha256', 'sequence'], 'installer start marker')
    identity(started, 'installer start marker')
    bindIdentity(started)
    if (started.token !== token || !hasStage) {
      throw new Error('desktop managed update: installer start marker does not match its final stage')
    }
  }
  if (cancellation !== undefined) {
    exactKeys(cancellation, ['schemaVersion', 'token'], 'cancellation marker')
    if (cancellation.schemaVersion !== 1 || cancellation.token !== token || hasStage || started !== undefined) {
      throw new Error('desktop managed update: cancellation marker does not establish an unstarted operation')
    }
    if (rootResult?.installationState === 'may-have-started' || rootResult?.installerExitCode !== undefined) {
      throw new Error('desktop managed update: cancellation conflicts with installer evidence')
    }
    return { status: 'none' }
  }
  if (rootResult !== undefined) {
    blockedResult(rootResult, acknowledgement === undefined ? 0 : 1)
    bindIdentity(rootResult)
    if (acknowledgement === undefined) {
      if (!hasStage && handoff !== undefined && rootResult.installationState === 'not-started'
        && ['manifest-download', 'manifest-validation'].includes(String(rootResult.phase))
        && rootResult.sequence === handoff.installedSequence && rootResult.installerExitCode === undefined) {
        // Before validation the helper records the discovery floor, not the target sequence.
        return { status: 'pre-install-failed' }
      }
      throw new Error('desktop managed update: blocked helper result has no acknowledgement')
    }
  }
  if (!hasStage) {
    if (rootResult === undefined) {
      if (acknowledgement !== undefined) {
        throw new Error('The managed update helper acknowledged the handoff but did not record a terminal result.')
      }
      return { status: 'none' }
    }
    if (rootResult.installationState === 'may-have-started' || rootResult.installerExitCode !== undefined
      || ['installer-launch', 'result-persistence'].includes(String(rootResult.phase))) {
      throw new Error('desktop managed update: installer evidence exists without its final stage')
    }
    // Schema-1 helpers also promoted the final stage before invoking any installer.
    const manifestValue = await readJsonIfExists(join(operationRoot, 'release.json'))
    if (manifestValue === undefined) return { status: 'pre-install-failed' }
    const manifest = await readManifest(join(operationRoot, 'release.json'))
    if (rootResult.manifestSha256 !== manifest.manifestSha256 || rootResult.sequence !== manifest.sequence) {
      throw new Error('desktop managed update: blocked result does not match the validated manifest')
    }
    return {
      status: 'pre-install-failed',
      ...(manifest.owner === 'cloga/deepseek-harness' && manifest.sequence > completedSequence
        && manifest.sequence === capability.currentSequence ? { candidate: manifest } : {}),
    }
  }
  const [result, pending] = await Promise.all([
    readJsonIfExists(join(stage, 'helper-result.json')),
    readJsonIfExists(join(stage, 'pending-completion.json')),
  ])
  if (result !== undefined) {
    identity(result, 'helper result')
    bindIdentity(result)
    if (result.status === 'blocked') blockedResult(result)
    else {
      exactKeys(result, ['schemaVersion', 'status', 'manifestSha256', 'sequence', 'installerExitCode', 'pendingCompletion'], 'helper result')
      if (result.status !== 'installer-exited' || result.installerExitCode !== 0 || result.pendingCompletion !== true) {
        throw new Error('desktop managed update: helper result is not completable')
      }
    }
  }
  if (pending !== undefined) {
    exactKeys(pending, ['schemaVersion', 'manifestSha256', 'sequence', 'installedEvidence'], 'pending completion')
    identity(pending, 'pending completion')
    bindIdentity(pending)
  }
  if (pending === undefined) throw new Error('The managed update final stage has no pending completion receipt.')
  const manifest = await readManifest(join(stage, 'release.json'))
  for (const record of [pending, result, rootResult, started]) {
    if (record !== undefined && (record.manifestSha256 !== manifest.manifestSha256 || record.sequence !== manifest.sequence)) {
      throw new Error('desktop managed update: operation records do not match the staged manifest')
    }
  }
  if (JSON.stringify(pending.installedEvidence) !== JSON.stringify(manifest.installedEvidence)) {
    throw new Error('desktop managed update: pending completion does not match the staged manifest')
  }
  if (manifest.sequence <= completedSequence) return { status: 'none' }
  if (manifest.owner !== 'cloga/deepseek-harness') {
    throw new Error('desktop managed update: legacy release requires Windows Ops Complete')
  }
  if (result === undefined && rootResult === undefined && acknowledgement !== undefined
    && helperRunning(Number(acknowledgement.helperPid))) {
    throw new Error('The acknowledged managed update helper is still running without a terminal result.')
  }
  if (result?.status === 'installer-exited' && rootResult === undefined) return { status: 'pending', candidate: manifest }
  return {
    status: 'pending',
    failure: {
      sequence: manifest.sequence,
      manifestSha256: manifest.manifestSha256,
      message: typeof rootResult?.reason === 'string' ? rootResult.reason
        : typeof result?.reason === 'string' ? result.reason
          : 'The managed update was interrupted before the installer result was recorded.',
    },
  }
}

/**
 * Reconcile retained operations without treating pre-install failures as incomplete installations.
 * Only installed executable/runtime hashes and active plugin inventory can advance the completion receipt.
 * @param operationsRoot - Desktop-owned operation directory.
 * @param completionPath - Durable sequence receipt path.
 * @param capability - Build-carried immutable channel selection.
 * @param completedSequence - Last verified receipt sequence, excluding the packaged discovery floor.
 * @param executable - Running installed Desktop executable.
 * @param runtimeDescriptor - Installed Desktop runtime descriptor.
 * @param provisioningPlan - Installed release-owned Desktop plugin plan.
 * @param activeProfile - Final-location profile, after its Host has reached readiness.
 * @param helperRunning - Read-only liveness probe for acknowledged helpers without terminal results.
 * @returns Verified completion, no pending installation, or actionable recovery diagnostics.
 */
export async function completeDesktopManagedUpdate(
  operationsRoot: string,
  completionPath: string,
  capability: DesktopManagedUpdateCapability,
  completedSequence: number,
  executable: string,
  runtimeDescriptor: string,
  provisioningPlan: string,
  activeProfile: string,
  helperRunning: (pid: number) => boolean = helperProcessRunning,
): Promise<DesktopManagedUpdateCompletion> {
  const recovery = (error: unknown): DesktopManagedUpdateCompletion => ({
    status: 'recovery-required',
    message: error instanceof Error ? error.message : String(error),
    command: managedUpdateRecoveryCommand(executable),
  })
  let operationNames: string[]
  try {
    operationNames = await readdir(operationsRoot)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'none' }
    return recovery(error)
  }
  try {
    const operations: OperationClassification[] = []
    for (const name of operationNames.sort()) {
      if (!/^[a-f0-9]{64}$/u.test(name)) continue
      operations.push(await classifyOperation(join(operationsRoot, name), name, capability, completedSequence, helperRunning))
    }
    if (!operations.some(operation => operation.status === 'pending')) return { status: 'none' }
    const candidates = operations.flatMap(operation => operation.candidate === undefined ? [] : [operation.candidate])
    const failures = operations.flatMap(operation => operation.failure === undefined ? [] : [operation.failure])
    if (candidates.length === 0) {
      throw new Error(failures[0]?.message ?? 'The managed update has no verified completion candidate.')
    }
    const [executableSha256, runtimeSha256] = await Promise.all([sha256File(executable), sha256File(runtimeDescriptor)])
    const matching = candidates.filter(manifest => manifest.installedEvidence.executableSha256 === executableSha256
      && manifest.installedEvidence.runtimeSha256 === runtimeSha256)
    const selected = matching.sort((left, right) => right.sequence - left.sequence)[0]
    if (selected === undefined) throw new Error('desktop managed update: installed application evidence does not match the release')
    if (selected.sequence !== capability.currentSequence) {
      throw new Error('desktop managed update: installed release sequence does not match the build capability')
    }
    if (candidates.some(manifest => manifest.sequence === selected.sequence && manifest.manifestSha256 !== selected.manifestSha256)) {
      throw new Error('desktop managed update: installed evidence identifies conflicting release manifests')
    }
    // A different transaction may supersede an older failure, never a newer or conflicting release.
    if (failures.some(failure => failure.sequence > selected.sequence
      || (failure.sequence === selected.sequence && failure.manifestSha256 !== selected.manifestSha256))
      || candidates.some(candidate => candidate.sequence > selected.sequence)) {
      throw new Error('A newer or conflicting managed update still requires recovery.')
    }
    const installedPlan = parseDesktopPluginProvisioningPlan(await readJson(provisioningPlan))
    if (desktopPluginProvisioningPlanSha256(installedPlan) !== capability.provisioning.planSha256) {
      throw new Error('desktop managed update: installed plugin provisioning plan does not match the release')
    }
    assertDesktopProvisioningInventory(activeProfile, installedPlan)
    await writeJsonAtomic(completionPath, {
      schemaVersion: 1,
      status: 'complete',
      sequence: selected.sequence,
      manifestSha256: selected.manifestSha256,
    })
    return { status: 'complete', sequence: selected.sequence, version: selected.version }
  } catch (error) {
    return recovery(error)
  }
}
