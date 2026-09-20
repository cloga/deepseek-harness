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

function record(value: unknown): asserts value is Record<string, unknown> {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected audit object')
}

/**
 * Validate a complete started/failed preparation pair against the known inventory.
 * @param values - Parsed, untrusted audit records created during the operation.
 * @param target - Installed plugin selected for the cancelled toggle.
 * @param manifestNames - Nonempty known dependency names from the baseline manifest.
 */
export function validateDesktopPluginCancelAudit(values: readonly unknown[], target: string, manifestNames: readonly string[]): void {
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
    assert.equal(value.operation, 'plugin-toggle')
    assert.equal(value.target, target)
    assert.equal(value.phase, 'preparation')
    assert(value.outcome === 'started' || value.outcome === 'failed', 'Cancel must not commit')
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
