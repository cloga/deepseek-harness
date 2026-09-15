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
