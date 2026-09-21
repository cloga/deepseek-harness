/** Geometry acceptance of the real packaged InputBar, native StatsPills, and released Copilot entry. */
import assert from 'node:assert/strict'
import { join } from 'node:path'
import type { Locator, Page } from 'playwright'

interface Box { x: number; y: number; width: number; height: number }
interface PillStyle { fontSize: string; lineHeight: string; color: string }

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
  readonly copilotDialog: {
    readonly signedOutObserved: true
    readonly sessionCreditsCount: number
    readonly resetCount: number
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

/**
 * Open only the test-owned seeded Session and measure the shipped composer without submitting input.
 * The real signed-out Host supplies quota state; synthetic history supplies native token counts.
 * @param page - Actual packaged application page in the isolated acceptance home.
 * @param output - Destination for wide, narrow, and native-dialog screenshots.
 * @returns Measured rectangles, native typography, and signed-out dialog observations.
 */
export async function inspectNativeComposerGeometry(page: Page, output: string): Promise<NativeComposerInspection> {
  const workspace = page.getByRole('treeitem').filter({ hasText: 'synthetic-composer-workspace' }).first()
  const seeded = page.getByRole('treeitem').filter({ hasText: 'DESKTOP_INLINE_STATS_SYNTHETIC' })
  await workspace.waitFor({ state: 'visible' })
  if (!await seeded.isVisible()) await workspace.click()
  await seeded.click()
  await page.getByText('Synthetic settled reply; no inference occurred.', { exact: true }).waitFor({ state: 'visible' })
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
  await time.click()
  const timeDialog = page.getByRole('dialog', { name: 'Session statistics', exact: true })
  await timeDialog.waitFor({ state: 'visible' })
  await page.screenshot({ path: join(output, 'native-composer-time-dialog.png') })
  await page.keyboard.press('Escape')
  await timeDialog.waitFor({ state: 'hidden' })
  await usage.click()
  const dialog = page.getByRole('dialog', { name: 'Token usage', exact: true })
  await dialog.waitFor({ state: 'visible' })
  await dialog.getByText('Cache hit', { exact: true }).waitFor({ state: 'visible' })
  await page.screenshot({ path: join(output, 'native-composer-token-dialog.png') })
  await page.keyboard.press('Escape')
  await dialog.waitFor({ state: 'hidden' })
  await copilot.click()
  const copilotDialog = page.getByRole('dialog').filter({
    has: page.getByRole('button', { name: 'Close usage details', exact: true }),
  })
  await copilotDialog.getByText('Sign in to Copilot in Models to view account usage.', { exact: true }).waitFor({ state: 'visible' })
  const sessionCreditsCount = await copilotDialog.getByText(/Session credits|会话额度/u).count()
  const resetCount = await copilotDialog.getByText(/^(?:Resets|重置时间):/u).count()
  assert.equal(sessionCreditsCount, 0, 'Unavailable Session credits section must remain retired')
  assert.equal(resetCount, 0, 'Signed-out usage must not invent a reset date')
  assert.doesNotMatch(await copilotDialog.innerText(), /\b1970\b/u)
  await page.screenshot({ path: join(output, 'native-composer-copilot-dialog.png') })
  await page.keyboard.press('Escape')
  await copilotDialog.waitFor({ state: 'hidden' })
  const focusReturned = await copilot.evaluate(element => document.activeElement === element)
  assert.equal(focusReturned, true, 'Closing Copilot usage must return focus to its actual trigger')
  return { geometry: result, copilotDialog: { signedOutObserved: true, sessionCreditsCount, resetCount, focusReturned } }
}
