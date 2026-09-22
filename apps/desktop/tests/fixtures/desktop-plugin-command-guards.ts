/** Pure acceptance guards; importing these must never load native bindings or start a process. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'

/** First failure presence is independent of its value, including thrown undefined. */
export interface DesktopPluginCommandOutcome {
  readonly failed: boolean
  readonly primary: unknown
  readonly secondary: readonly unknown[]
  retain(error: unknown): void
}

/** @returns One fixture-owned failure ledger; later diagnostics never replace its first error. */
export function createDesktopPluginCommandOutcome(): DesktopPluginCommandOutcome {
  let failed = false
  let primary: unknown
  const secondary: unknown[] = []
  return {
    get failed() { return failed },
    get primary() { return primary },
    secondary,
    retain(error) {
      if (failed) secondary.push(error)
      else { failed = true; primary = error }
    },
  }
}

/**
 * Publish command acceptance only after the caller has completed all owned cleanup.
 * @param outcome - Actual owner failure ledger.
 * @param cleanupVerified - Complete Job, helper, handle, connection and home cleanup observation.
 * @param publish - Exclusive final success writer.
 * @param reportFailure - Best-effort failure writer; errors remain secondary.
 */
export function finalizeDesktopPluginCommandAcceptance(
  outcome: DesktopPluginCommandOutcome, cleanupVerified: boolean, publish: () => void,
  reportFailure: (primary: unknown, secondary: readonly unknown[]) => void,
): void {
  if (!cleanupVerified) outcome.retain(new Error('Command acceptance cleanup is unconfirmed'))
  if (!outcome.failed) {
    try { publish() } catch (error) { outcome.retain(error) }
  }
  if (outcome.failed) {
    try { reportFailure(outcome.primary, outcome.secondary) } catch (error) { outcome.retain(error) }
    throw outcome.primary
  }
}

/**
 * Admit only the exact hosted checkout identity before any fixture allocation or application launch.
 * @param sourceCommit - Independently observed checkout HEAD.
 * @param sourceTree - Independently observed checkout tree.
 * @param environment - Workflow environment, never the child application environment.
 * @returns Owned source and workflow identity leaves.
 */
export function validateDesktopPluginCommandRun(sourceCommit: string, sourceTree: string, environment: NodeJS.ProcessEnv): {
  sourceCommit: string
  sourceTree: string
  runId: string
  runAttempt: string
} {
  assert.equal(environment.GITHUB_ACTIONS, 'true')
  assert.equal(environment.GITHUB_REPOSITORY, 'cloga/deepseek-harness')
  assert.equal(environment.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(environment.RUNNER_OS, 'Windows')
  for (const value of [sourceCommit, sourceTree]) assert(value.length === 40 && /^[a-f0-9]{40}$/u.test(value))
  assert.equal(environment.GITHUB_SHA, sourceCommit, 'Command fixture must identify the exact workflow source')
  const runId = environment.GITHUB_RUN_ID
  const runAttempt = environment.GITHUB_RUN_ATTEMPT
  for (const value of [runId, runAttempt]) {
    assert(typeof value === 'string' && value.length <= 20 && value.trim() === value && /^[1-9]\d*$/u.test(value))
  }
  assert(runId !== undefined && runAttempt !== undefined)
  return { sourceCommit, sourceTree, runId, runAttempt }
}

/**
 * Calculate the remaining monotonic-time budget.
 * @param deadline - Absolute performance-clock deadline.
 * @param now - Current performance-clock time.
 * @returns Positive remaining milliseconds, or throws when expired.
 */
export function remainingDeadline(deadline: number, now = performance.now()): number {
  assert(Number.isFinite(deadline) && Number.isFinite(now) && deadline > now, 'Operation deadline exceeded')
  return Math.max(1, Math.ceil(deadline - now))
}

/**
 * Bound transport waits and reject responses that settle after the deadline.
 * @param deadline - Absolute performance-clock deadline.
 * @param operation - Operation receiving its remaining cancellation budget.
 * @returns The result only if it arrives before the deadline.
 */
export async function withinDeadline<T>(deadline: number, operation: (remaining: number) => Promise<T>): Promise<T> {
  const remaining = remainingDeadline(deadline)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reject(new Error('Operation deadline exceeded')) }, remaining)
    })
    const result = await Promise.race([operation(remaining), timeout])
    remainingDeadline(deadline)
    return result
  } finally { clearTimeout(timer) }
}

/**
 * Validate the browser websocket path and numeric loopback port in the private launch file.
 * @param text - Exact DevToolsActivePort file contents.
 * @returns Validated local browser endpoint and its components.
 */
export function parseDesktopDevToolsPort(text: string): { port: number; path: string; endpoint: string } {
  const match = /^([1-9][0-9]{0,4})\r?\n(\/devtools\/browser\/[a-zA-Z0-9-]+)\r?\n?$/u.exec(text)
  assert(match, 'Invalid private DevToolsActivePort')
  const port = Number(match[1])
  assert(port <= 65535, 'Invalid loopback DevTools port')
  const path = match[2]!
  return { port, path, endpoint: `ws://127.0.0.1:${port}${path}` }
}

/** Bounded leaf observations from the native helper's complete owned EnumWindows scan. */
export interface OwnedDesktopWindow {
  readonly hwnd: string
  readonly pid: number
  readonly title: string
  readonly owner: string
  readonly rootOwner: string
  readonly width: number
  readonly height: number
  readonly visible: boolean
  readonly minimized: boolean
}

/**
 * Require an actual bounded title; never normalize it into a different HWND identity.
 * @param title - Value read from the already-owned CDP app page.
 */
export function validateDesktopPageTitle(title: unknown): asserts title is string {
  assert(typeof title === 'string' && title.trim().length > 0 && title.length <= 1024 &&
    !/[\u0000-\u001f\u007f]/u.test(title), 'Expected bounded nonempty actual CDP page title')
}

/**
 * Select from native observations without treating visibility or enumeration order as identity.
 * This validates helper evidence, not a replacement for native re-enumeration before actions.
 * @param candidates - Complete bounded observations returned by the owned native enumeration.
 * @param pid - Retained Job-created root PID, already checked against creation/executable identity.
 * @param title - Exact title observed on its owned CDP page.
 * @returns Unique unowned root with a nonempty client area, or undefined while none is observable.
 */
export function selectOwnedDesktopWindow(candidates: unknown, pid: number, title: string): OwnedDesktopWindow | undefined {
  validateDesktopPageTitle(title)
  assert(Array.isArray(candidates) && candidates.length <= 256, 'Expected bounded window observations')
  const windows = candidates.map((value: unknown) => {
    assert(value !== null && typeof value === 'object', 'Expected native window observation')
    const window = value as OwnedDesktopWindow
    for (const handle of [window.hwnd, window.owner, window.rootOwner]) {
      assert(typeof handle === 'string' && /^(?:0|[1-9][0-9]{0,18})$/u.test(handle), 'Invalid observed HWND')
    }
    assert(Number.isSafeInteger(window.pid) && window.pid > 0, 'Invalid observed PID')
    assert(typeof window.title === 'string' && window.title.length <= 1024, 'Invalid observed title')
    assert(Number.isSafeInteger(window.width) && Number.isSafeInteger(window.height), 'Invalid observed client rectangle')
    assert(typeof window.visible === 'boolean' && typeof window.minimized === 'boolean', 'Missing observed visibility')
    return window
  })
  const matches = windows.filter(window => window.pid === pid && window.title === title && window.hwnd !== '0' &&
    window.owner === '0' && window.rootOwner === window.hwnd && window.width > 0 && window.height > 0)
  assert(matches.length <= 1, 'Ambiguous owned root windows matching actual CDP page title')
  return matches[0]
}

/**
 * Bind capture evidence to both the actual CDP title and the same initially observed HWND.
 * @param evidence - Untrusted JSON returned by the native capture helper.
 * @param pid - Verified root PID.
 * @param title - Actual CDP app title, not an application-name guess.
 * @param hwnd - Exact HWND retained for later verify, Cancel and close requests.
 */
export function validateDesktopWindowCapture(evidence: unknown, pid: number, title: string, hwnd: string): void {
  assert(evidence !== null && typeof evidence === 'object', 'Missing native window evidence')
  const capture = evidence as Record<string, unknown>
  assert.equal(capture.title, title, 'Captured title differs from CDP page title')
  assert.equal(capture.hwnd, hwnd, 'Captured HWND evidence mismatch')
  assert.equal(typeof capture.showRequested, 'boolean', 'Missing show-request evidence')
  const initial = selectOwnedDesktopWindow(capture.initialCandidates, pid, title)
  const ready = selectOwnedDesktopWindow(capture.readyCandidates, pid, title)
  assert(initial !== undefined && ready !== undefined, 'Missing unique owned root observation')
  assert.equal(initial.hwnd, hwnd, 'Initial HWND differs from captured HWND')
  assert.equal(ready.hwnd, hwnd, 'Ready HWND differs from initially observed HWND')
  assert(ready.visible && !ready.minimized, 'Captured owned root is not visible and unminimized')
}

function record(value: unknown): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected audit object')
}

/** Cancellation evidence from the real alpha2 private staging journal, not a legacy manager audit. */
export interface DesktopPluginCancelAudit {
  readonly owner: unknown
  readonly prepared: unknown
  readonly discarded: unknown
  readonly retainedEntries: readonly string[]
}
/** Independently observed pre-command identity and exact active-profile metadata bytes. */
export interface DesktopPluginCancelContext {
  readonly transactionId: string
  readonly commandId: string
  readonly target: string
  readonly profile: string
  readonly runtimeDir: string
  readonly manifestText: string
  readonly baseline: Readonly<Record<string, string | null>>
}
/**
 * Bind the explicit discard to one actual native command-owned selection preparation.
 * @param audit - Journals retained after native Cancel and preparation quiescence.
 * @param expected - Pre-command observations, never values inferred from those journals.
 */
export function validateDesktopPluginCancelAudit(audit: DesktopPluginCancelAudit, expected: DesktopPluginCancelContext): void {
  const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
  const keys = (value: Record<string, unknown>, names: string[]): void => { assert.deepEqual(Object.keys(value).sort(), names.sort()) }
  const digest = (value: unknown): void => { assert(typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value)) }
  const uuid = (value: unknown): void => { assert(typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(value)) }
  uuid(expected.transactionId)
  const { owner, prepared, discarded } = audit
  record(owner); record(prepared); record(discarded)
  keys(owner, ['profile', 'runtimeDir', 'installAnchor', 'runtimeFingerprint', 'dependencyRegistry', 'configPaths',
    ...(Object.hasOwn(owner, 'provisioningPlanResource') ? ['provisioningPlanResource'] : [])])
  assert.equal(owner.profile, expected.profile)
  assert.equal(owner.runtimeDir, expected.runtimeDir)
  assert(typeof owner.installAnchor === 'string' && owner.installAnchor.length > 0)
  digest(owner.runtimeFingerprint)
  assert(typeof owner.dependencyRegistry === 'string' && owner.dependencyRegistry.length > 0)
  assert(Array.isArray(owner.configPaths) && owner.configPaths.every(path => typeof path === 'string'))
  keys(prepared, ['schemaVersion', 'owner', 'requestFingerprint', 'result', 'baseFiles', 'baseInputs',
    'baseGraphFingerprint', 'candidateFingerprint', 'mutation', 'commandOrigin', 'commandRequest', 'selectionBaseManifest'])
  assert.equal(prepared.schemaVersion, 2)
  assert.deepEqual(prepared.owner, owner)
  const { commandOrigin, commandRequest, mutation, result } = prepared
  record(commandOrigin); record(commandRequest); record(mutation); record(result)
  keys(commandOrigin, ['kind', 'generation', 'requestId', 'commandId'])
  assert.equal(commandOrigin.kind, 'desktop-command')
  uuid(commandOrigin.generation)
  assert(Number.isSafeInteger(commandOrigin.requestId) && (commandOrigin.requestId as number) > 0)
  assert.equal(commandOrigin.commandId, expected.commandId)
  assert.deepEqual(commandRequest, { kind: 'selection', names: [expected.target], enabled: false })
  assert.deepEqual(mutation, { kind: 'selection', packageNames: [expected.target], enabled: false })
  keys(result, ['schemaVersion', 'kind', 'transactionId', 'state', 'packageNames', 'baseFingerprint', 'health'])
  assert.deepEqual(result, { schemaVersion: 2, kind: 'selection', transactionId: expected.transactionId,
    state: 'prepared', packageNames: [expected.target], baseFingerprint: result.baseFingerprint, health: 'pending' })
  assert.equal(prepared.selectionBaseManifest, expected.manifestText, 'Selection must bind exact original manifest bytes')
  const manifest: unknown = JSON.parse(expected.manifestText)
  record(manifest); record(manifest.dependencies); record(manifest.dsh); record(manifest.dsh.profile)
  assert(Object.hasOwn(manifest.dependencies, expected.target), 'Target must be an actual installed dependency')
  assert(Array.isArray(manifest.dsh.profile.bundles) && manifest.dsh.profile.bundles.includes(expected.target), 'Disable target must be selected')
  assert(Array.isArray(prepared.baseFiles) && prepared.baseFiles.length > 0 && prepared.baseFiles.length <= 100_000)
  const files = new Map<string, Record<string, unknown>>()
  for (const item of prepared.baseFiles) {
    record(item)
    assert(typeof item.path === 'string' && item.path.length > 0 && !files.has(item.path))
    assert(item.kind === 'file' || item.kind === 'directory')
    keys(item, item.kind === 'file' ? ['path', 'kind', 'sha256'] : ['path', 'kind'])
    if (item.kind === 'file') digest(item.sha256)
    files.set(item.path, item)
  }
  assert.equal(files.get('package.json')?.sha256, hash(expected.manifestText))
  for (const [path, sha256] of Object.entries(expected.baseline)) {
    const actual = files.get(path.endsWith('/') ? path.slice(0, -1) : path)
    if (sha256 === null) assert.equal(actual, undefined, `Unexpected baseline file ${path}`)
    else if (sha256 === 'directory') assert.equal(actual?.kind, 'directory')
    else { assert(actual !== undefined); assert.equal(actual.kind, 'file'); assert.equal(actual.sha256, sha256, `Baseline bytes differ: ${path}`) }
  }
  assert(Array.isArray(prepared.baseInputs))
  for (const input of prepared.baseInputs) {
    record(input); keys(input, ['path', 'sha256'])
    assert(typeof input.path === 'string' && input.path.length > 0)
    if (input.sha256 !== null) digest(input.sha256)
  }
  for (const value of [prepared.baseGraphFingerprint, prepared.candidateFingerprint,
    prepared.requestFingerprint, result.baseFingerprint]) digest(value)
  assert.equal(result.baseFingerprint, hash(JSON.stringify({ owner, files: prepared.baseFiles, inputs: prepared.baseInputs })))
  assert.equal(prepared.requestFingerprint, hash(JSON.stringify({ mutation, commandOrigin, commandRequest })))
  keys(discarded, ['schemaVersion', 'transactionId', 'ownerFingerprint', 'requestFingerprint', 'candidateFingerprint', 'state'])
  assert.deepEqual(discarded, { schemaVersion: 1, transactionId: expected.transactionId,
    ownerFingerprint: hash(JSON.stringify(owner)), requestFingerprint: prepared.requestFingerprint,
    candidateFingerprint: prepared.candidateFingerprint, state: 'discarded' })
  assert.deepEqual([...audit.retainedEntries].sort(), ['DISCARDED.json', 'PREPARED.json', 'owner.json'],
    'Cancel must retain only bound journals: no candidate, acquisition cache or activation/rollback state')
}

/**
 * Await root-process exit and zero active processes in its retained Job Object.
 * @param deadline - Absolute performance-clock cleanup deadline.
 * @param pollExit - Read exit status through the owned process handle.
 * @param isEmpty - Query active-process accounting through the owned Job handle.
 * @param delay - Await the next bounded observation.
 * @returns The root exit code once the Job contains no active descendants.
 */
export async function waitForOwnedJobExit(
  deadline: number, pollExit: () => number | undefined, isEmpty: () => boolean,
  delay: (milliseconds: number) => Promise<void> = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
): Promise<number> {
  for (;;) {
    remainingDeadline(deadline)
    const exit = pollExit()
    const empty = isEmpty()
    remainingDeadline(deadline)
    if (exit !== undefined && empty) return exit
    await delay(Math.min(50, remainingDeadline(deadline)))
  }
}
