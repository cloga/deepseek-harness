/** Pure acceptance guards; importing these must never load native bindings or start a process. */
import assert from 'node:assert/strict'

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

/**
 * Validate a complete started/failed preparation pair against the known inventory.
 * @param values - Parsed, untrusted audit records created during the operation.
 * @param target - Installed plugin selected for the cancelled toggle.
 * @param manifestNames - Nonempty known dependency names from the baseline manifest.
 * @param operation - Cancelled mutation kind; plugin-toggle retains the historical target-on-start contract.
 */
export function validateDesktopPluginCancelAudit(
  values: readonly unknown[],
  target: string,
  manifestNames: readonly string[],
  operation: 'plugin-toggle' | 'plugin-install' = 'plugin-toggle',
): void {
  assert(manifestNames.length > 0 && manifestNames.every(name => typeof name === 'string' && name.length > 0), 'Known manifest dependencies required')
  const names = [...manifestNames].sort()
  assert.equal(new Set(names).size, names.length)
  assert(names.includes(target), 'Target must be a known manifest dependency')
  assert.equal(values.length, 2, 'Cancel requires exactly one started and one failed preparation receipt')
  const records = values.map((value) => { record(value); return value })
  const inventory = (value: unknown): void => {
    record(value)
    assert.deepEqual(Object.keys(value).sort(), ['names', 'sha256'], 'Inventory schema mismatch')
    assert(typeof value.sha256 === 'string' && /^[a-f0-9]{64}$/u.test(value.sha256), 'Inventory digest must be SHA-256')
    assert(Array.isArray(value.names) && value.names.length > 0, 'Inventory names must be nonempty')
    assert.deepEqual(value.names, names, 'Inventory names must be sorted known manifest dependencies')
  }
  for (const value of records) {
    assert.equal(value.schemaVersion, 1, 'Audit schemaVersion required')
    assert(typeof value.recordedAt === 'string' && Number.isFinite(Date.parse(value.recordedAt)), 'Audit recordedAt required')
    assert(typeof value.transaction === 'string' && /^\.desktop-transaction-[a-zA-Z0-9]+$/u.test(value.transaction), 'Audit transaction required')
    assert.equal(value.operation, operation)
    assert.equal(value.phase, 'preparation')
    assert(value.outcome === 'started' || value.outcome === 'failed', 'Cancel must not commit')
    if (operation === 'plugin-install' && value.outcome === 'started') {
      assert.equal(Object.hasOwn(value, 'target'), false, 'Install start must not invent a target before acquisition')
    } else {
      assert.equal(value.target, target)
    }
    inventory(value.before)
  }
  const started = records.filter(value => value.outcome === 'started')
  const failed = records.filter(value => value.outcome === 'failed')
  assert.equal(started.length, 1, 'One started receipt required')
  assert.equal(failed.length, 1, 'One failed receipt required')
  assert.equal(started[0]!.transaction, failed[0]!.transaction, 'Preparation transaction mismatch')
  assert.equal(started[0]!.after, null, 'Started preparation has explicit null after')
  inventory(failed[0]!.after)
  assert.deepEqual(started[0]!.before, failed[0]!.before)
  assert.deepEqual(failed[0]!.before, failed[0]!.after, 'Cancel must retain the inventory')
  assert(Date.parse(started[0]!.recordedAt as string) <= Date.parse(failed[0]!.recordedAt as string), 'Failed receipt must follow started')
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
