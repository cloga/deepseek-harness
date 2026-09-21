/** Geometry acceptance of the real packaged InputBar, native StatsPills, and released Copilot entry. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'

interface Box { x: number; y: number; width: number; height: number }
interface PillStyle { fontSize: string; lineHeight: string; color: string }
interface DialogObservation { opened: boolean; closedOnEscape: boolean; focusReturned: boolean }

/** One measured viewport of the actual native composer. */
export interface NativeComposerGeometry {
  readonly viewportWidth: number
  readonly dock: Box
  readonly time: Box
  readonly usage: Box
  readonly copilot: Box
  readonly nativeStyle: PillStyle
  readonly copilotStyle: PillStyle
}

/** Native geometry plus observed signed-out Copilot dialog behavior. */
export interface NativeComposerInspection {
  readonly geometry: readonly NativeComposerGeometry[]
  readonly nativeDialogs: { readonly time: DialogObservation; readonly usage: DialogObservation }
  readonly copilotDialog: {
    readonly signedOutObserved: boolean
    readonly sessionCreditsCount: number
    readonly resetCount: number
    readonly epochTextCount: number
    readonly focusReturned: boolean
  }
}

/**
 * Reject missing, overlapping, overflowing, or incorrectly stacked wide-layout controls.
 * @param geometry - Browser-measured rectangles, not synthetic CSS expectations.
 * @param inline - Whether all three controls must occupy one row.
 */
export function assertNativeComposerGeometry(geometry: NativeComposerGeometry, inline: boolean): void {
  assert.match(geometry.nativeStyle.fontSize, /px$/u)
  assert.match(geometry.nativeStyle.lineHeight, /px$/u)
  assert.deepEqual(geometry.copilotStyle, geometry.nativeStyle, 'Copilot must match the native statistics typography and text color')
  const boxes = [geometry.time, geometry.usage, geometry.copilot]
  for (const box of boxes) {
    assert(box.width > 0 && box.height > 0, 'Each actual statistics control must be visible')
    assert(box.x >= geometry.dock.x - 1 && box.x + box.width <= geometry.dock.x + geometry.dock.width + 1,
      'Statistics controls must remain within the dock')
    assert(box.x >= -1 && box.x + box.width <= geometry.viewportWidth + 1, 'Statistics controls must remain within the viewport')
  }
  for (let index = 0; index < boxes.length; index++) {
    for (const other of boxes.slice(index + 1)) {
      const box = boxes[index]!
      assert(box.x + box.width <= other.x + 1 || other.x + other.width <= box.x + 1
        || box.y + box.height <= other.y + 1 || other.y + other.height <= box.y + 1,
      'Statistics controls must not overlap')
    }
  }
  if (inline) {
    const center = geometry.usage.y + geometry.usage.height / 2
    assert(Math.abs(geometry.time.y + geometry.time.height / 2 - center) <= 1, 'Native statistics must share a row')
    assert(Math.abs(geometry.copilot.y + geometry.copilot.height / 2 - center) <= 1, 'Copilot usage must share the native Cache hit row')
    assert(geometry.copilot.x >= geometry.usage.x + geometry.usage.width, 'Copilot usage must follow native Cache hit')
  }
}

async function rectangle(locator: Locator): Promise<Box> {
  const box = await locator.boundingBox()
  assert(box !== null, 'Expected an actual rendered statistics control')
  return box
}

async function pillStyle(locator: Locator): Promise<PillStyle> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element)
    return { fontSize: style.fontSize, lineHeight: style.lineHeight, color: style.color }
  })
}

async function observeNativeDialog(page: Page, trigger: Locator, title: string, screenshot: string): Promise<DialogObservation> {
  await trigger.click()
  const dialog = page.getByRole('dialog', { name: title, exact: true })
  await dialog.waitFor({ state: 'visible' })
  const opened = await dialog.isVisible()
  if (title === 'Token usage') await dialog.getByText('Cache hit', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(opened, true, 'Native statistics dialog must open')
  await page.screenshot({ path: screenshot })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  const closedOnEscape = await dialog.isHidden()
  const focusReturned = await trigger.evaluate(element => document.activeElement === element)
  assert.equal(closedOnEscape, true, 'Escape must close the native statistics dialog')
  assert.equal(focusReturned, true, 'Closing native statistics must retain its actual trigger focus')
  return { opened, closedOnEscape, focusReturned }
}

/**
 * Reveal the actual sidebar before selecting the test-owned persisted Session.
 * @param page - Actual packaged page, including a restored collapsed navigation rail.
 */
export async function openNativeComposerFixture(page: Page): Promise<void> {
  const reveal = page.getByRole('button', { name: 'Open sidebar', exact: true })
  if (await reveal.isVisible()) await reveal.click()
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
  const workspace = page.locator('[role="treeitem"][aria-expanded]').filter({
    has: page.getByText('synthetic-composer-workspace', { exact: true }),
  })
  await workspace.waitFor({ state: 'visible', timeout: 15_000 })
  assert.equal(await workspace.count(), 1, 'Exactly one test-owned workspace row must match')
  const expanded = await workspace.getAttribute('aria-expanded')
  assert(expanded === 'true' || expanded === 'false', 'The actual workspace row must expose its expansion state')
  if (expanded === 'false') await workspace.click()
  // Cold lists do not fold missing title projections: the persisted row can
  // legitimately show its cwd basename until opening materializes its title.
  const seeded = page.locator('[role="treeitem"][aria-selected]').filter({
    has: page.getByText(/^(?:DESKTOP_INLINE_STATS_SYNTHETIC|synthetic-composer-workspace)$/u),
  })
  await seeded.waitFor({ state: 'visible', timeout: 15_000 })
  assert.equal(await seeded.count(), 1, 'Exactly one nonblank test-owned Session row must match')
  await seeded.click()
  await page.getByText('Synthetic settled reply; no inference occurred.', { exact: true }).waitFor({ state: 'visible', timeout: 15_000 })
}

/**
 * Open only the test-owned seeded Session and measure the shipped composer without submitting input.
 * The real signed-out Host supplies quota state; synthetic history supplies native token counts.
 * @param page - Actual packaged application page in the isolated acceptance home.
 * @param output - Destination for wide, narrow, and native-dialog screenshots.
 * @returns Measured rectangles, native typography, and signed-out dialog observations.
 */
export async function inspectNativeComposerGeometry(page: Page, output: string): Promise<NativeComposerInspection> {
  await openNativeComposerFixture(page)
  const stats = page.locator('[data-composer-stats]')
  const time = stats.getByRole('button', { name: '1 turns 1 steps', exact: true })
  const usage = stats.getByRole('button', { name: '105 tok · Cache hit 90%', exact: true })
  const copilot = page.locator('[data-copilot-usage-trigger]')
  await time.waitFor({ state: 'visible' })
  await usage.waitFor({ state: 'visible' })
  await copilot.waitFor({ state: 'visible' })
  const result: NativeComposerGeometry[] = []
  for (const viewportWidth of [1280, 400]) {
    await page.setViewportSize({ width: viewportWidth, height: 900 })
    await page.mouse.move(0, 0)
    // Wait for measured layout stability, not a fixed delay or an assumed CSS class.
    let previous = ''
    let settled = 0
    const deadline = performance.now() + 10_000
    let geometry: NativeComposerGeometry | undefined
    while (settled < 3) {
      assert(performance.now() < deadline, 'Composer geometry must settle after viewport change')
      await page.evaluate(() => new Promise<void>((resolve) => { requestAnimationFrame(() => { resolve() }) }))
      geometry = { viewportWidth, dock: await rectangle(stats.locator('..')),
        time: await rectangle(time), usage: await rectangle(usage), copilot: await rectangle(copilot),
        nativeStyle: await pillStyle(usage), copilotStyle: await pillStyle(copilot) }
      const current = JSON.stringify(geometry)
      settled = current === previous ? settled + 1 : 0
      previous = current
    }
    assert(geometry !== undefined)
    assertNativeComposerGeometry(geometry, viewportWidth === 1280)
    result.push(geometry)
    await page.screenshot({ path: join(output, `native-composer-${String(viewportWidth)}.png`) })
  }
  const nativeDialogs = {
    time: await observeNativeDialog(page, time, 'Session statistics', join(output, 'native-composer-time-dialog.png')),
    usage: await observeNativeDialog(page, usage, 'Token usage', join(output, 'native-composer-token-dialog.png')),
  }
  await copilot.click()
  const copilotDialog = page.getByRole('dialog').filter({
    has: page.getByRole('button', { name: 'Close usage details', exact: true }),
  })
  const signedOut = copilotDialog.getByText('Sign in to Copilot in Models to view account usage.', { exact: true })
  await signedOut.waitFor({ state: 'visible' })
  const signedOutObserved = await signedOut.isVisible()
  assert.equal(signedOutObserved, true, 'Copilot dialog must report actual signed-out state')
  const sessionCreditsCount = await copilotDialog.getByText(/Session credits|会话额度/u).count()
  const resetCount = await copilotDialog.getByText(/^(?:Resets|重置时间):/u).count()
  assert.equal(sessionCreditsCount, 0, 'Unavailable Session credits section must remain retired')
  assert.equal(resetCount, 0, 'Signed-out usage must not invent a reset date')
  const epochTextCount = await copilotDialog.getByText(/\b1970\b/u).count()
  assert.equal(epochTextCount, 0, 'Copilot usage must not display an epoch reset date')
  await page.screenshot({ path: join(output, 'native-composer-copilot-dialog.png') })
  await page.keyboard.press('Escape')
  await copilotDialog.waitFor({ state: 'hidden' })
  const focusReturned = await copilot.evaluate(element => document.activeElement === element)
  assert.equal(focusReturned, true, 'Closing Copilot usage must return focus to its actual trigger')
  return { geometry: result, nativeDialogs,
    copilotDialog: { signedOutObserved, sessionCreditsCount, resetCount, epochTextCount, focusReturned } }
}
