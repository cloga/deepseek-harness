/** Bound renderer error evidence to native composer inspection, not the later owned application shutdown. */
import assert from 'node:assert/strict'
import type { ConsoleMessage, Page } from 'playwright'

/**
 * Observe every renderer error delivered during inspection and seal its evidence before teardown.
 * @param page - Actual inspected page; only this observer's callbacks are removed.
 * @param inspect - Native interactions and final receipt checks that must complete before sealing.
 * @param onCleanupError - Secondary-only listener-removal report; the owner must obtain its primary error from this call's rejection.
 * @returns Inspection result with an immutable owned error snapshot; observation or cleanup failure rejects acceptance.
 */
export async function observeNativeComposerErrors<T>(
  page: Pick<Page, 'on' | 'off'>,
  inspect: () => Promise<T>,
  onCleanupError?: (error: unknown) => void,
): Promise<{
  inspection: T
  rendererErrors: readonly string[]
}> {
  const errors: string[] = []
  let active = true
  const onPageError = (error: Error): void => { if (active) errors.push(error.message) }
  const onConsole = (message: ConsoleMessage): void => {
    if (active && message.type() === 'error') errors.push(message.text())
  }
  let failed = false
  let failure: unknown
  const retain = (error: unknown): void => {
    if (!failed) { failed = true; failure = error }
  }
  let observation: { inspection: T; rendererErrors: readonly string[] } | undefined
  try {
    page.on('pageerror', onPageError)
    page.on('console', onConsole)
    const inspection = await inspect()
    active = false
    const rendererErrors = Object.freeze([...errors])
    assert.deepEqual(rendererErrors, [], 'Native composer acceptance must not produce renderer errors')
    observation = { inspection, rendererErrors }
  } catch (error) {
    retain(error)
  } finally {
    // Deactivate first: even a failed removal cannot let queued callbacks mutate the sealed observation.
    active = false
    const removals = [() => page.off('pageerror', onPageError), () => page.off('console', onConsole)]
    for (const remove of removals) {
      try { remove() } catch (error) {
        retain(error)
        try { onCleanupError?.(error) } catch (reportError) { retain(reportError) }
      }
    }
  }
  if (failed) throw failure
  assert(observation !== undefined, 'Successful native inspection must produce an observation')
  return observation
}
