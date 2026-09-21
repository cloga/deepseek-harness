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
    page.off('pageerror', onPageError)
    page.off('console', onConsole)
  }
  try {
    page.on('pageerror', onPageError)
    page.on('console', onConsole)
    const inspection = await inspect()
    stop()
    const rendererErrors = Object.freeze([...errors])
    assert.deepEqual(rendererErrors, [], 'Native composer acceptance must not produce renderer errors')
    return { inspection, rendererErrors }
  } finally {
    stop()
  }
}
