import { expect, vi } from 'vitest'
import type { Session, SessionSeqCursor } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import type SessionProjectionCache from '../src/index.ts'

const COVERAGE_TEST_TIMEOUT_ENV = 'DSH_COVERAGE_TEST_TIMEOUT_MS'
const LOCAL_TIMEOUT_FLOOR_MS = 5_000
const TIMEOUT_CEILING_MS = 300_000

/**
 * Resolve the durable-write observation budget for projection-cache tests.
 * @param env - Environment carrying the optional coverage-lane test budget.
 * @returns Vitest wait options with the local floor or bounded coverage budget.
 */
export function projectionDurableObservationOptions(
  env: NodeJS.ProcessEnv = process.env,
): { readonly timeout: number } {
  const raw = env[COVERAGE_TEST_TIMEOUT_ENV]
  if (raw === undefined || raw === '') return { timeout: LOCAL_TIMEOUT_FLOOR_MS }
  const timeout = Number.parseInt(raw, 10)
  if (!Number.isSafeInteger(timeout) || timeout < 1 || String(timeout) !== raw) {
    throw new Error(`${COVERAGE_TEST_TIMEOUT_ENV} must be a positive integer, got ${JSON.stringify(raw)}`)
  }
  if (timeout > TIMEOUT_CEILING_MS) {
    throw new Error(`${COVERAGE_TEST_TIMEOUT_ENV} must not exceed ${String(TIMEOUT_CEILING_MS)}`)
  }
  return { timeout: Math.max(LOCAL_TIMEOUT_FLOOR_MS, timeout) }
}

/**
 * Wait for the domain's post-durability watermark without opening the JSON file.
 * Repeatedly opening the target can race the pending atomic replacement on Windows.
 * @param cache - Cache whose mandatory or throttled write is under observation.
 * @param session - Session identity bound to the expected checkpoint.
 * @param expected - Exact committed cut or case-specific committed-state predicate.
 * @returns Resolution after the expected checkpoint is visible in committed memory.
 */
export async function waitForProjectionCheckpoint(
  cache: Pick<SessionProjectionCache, 'cachedSnapshot'>,
  session: Pick<Session, 'header' | 'inheritedEventCount'>,
  expected: SessionSeqCursor | ((snapshot: ProjectionSnapshot | undefined) => boolean),
): Promise<void> {
  const matches = typeof expected === 'function'
    ? expected
    : (snapshot: ProjectionSnapshot | undefined): boolean => snapshot?.asOfSeq === expected
  await vi.waitFor(() => {
    expect(matches(cache.cachedSnapshot(session.header, session.inheritedEventCount))).toBe(true)
  }, projectionDurableObservationOptions())
}
