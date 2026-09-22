/** Bound renderer error evidence to native composer inspection, not the later owned application shutdown. */
import assert from 'node:assert/strict'
import type { ConsoleMessage, Page } from 'playwright'

/**
 * Observe every renderer error delivered during inspection and seal its evidence before teardown.
 * @param page - Actual inspected page; only this observer's callbacks are removed.
 * @param inspect - Native interactions and final receipt checks that must complete before sealing.
 * @returns Inspection result with an immutable owned error snapshot; any observed error rejects acceptance.
 */
export async function observeNativeComposerErrors<T>(
  page: Pick<Page, 'on' | 'off'>,
  inspect: () => Promise<T>,
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
  const stop = (): void => {
    if (!active) return
    active = false
    let failed = false
    let failure: unknown
    try { page.off('pageerror', onPageError) } catch (error) { failed = true; failure = error }
    try { page.off('console', onConsole) } catch (error) { if (!failed) { failed = true; failure = error } }
    if (failed) throw failure
  }
  let observed: { inspection: T } | undefined
  let failed = false
  let failure: unknown
  try {
    page.on('pageerror', onPageError)
    page.on('console', onConsole)
    observed = { inspection: await inspect() }
  } catch (error) { failed = true; failure = error }
  finally {
    try { stop() } catch (error) { if (!failed) { failed = true; failure = error } }
  }
  if (failed) throw failure
  assert(observed !== undefined)
  const rendererErrors = Object.freeze([...errors])
  assert.deepEqual(rendererErrors, [], 'Native composer acceptance must not produce renderer errors')
  return { inspection: observed.inspection, rendererErrors }
}
