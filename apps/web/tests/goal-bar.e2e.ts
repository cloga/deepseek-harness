// Keyless assembled-browser coverage for the goal bar over the shipped Web
// bundles and the fixture Connection RPC. The command creates a projected goal;
// edit round-trips multiline text through the Remote and projection, while
// clear proves the acknowledged tombstone leaves no stale chrome.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./expected/goal-bar', import.meta.url))
const ACTIVE_EXPECTED = join(SNAPSHOT_DIR, 'active.expected.md')
const OVERLAY = fileURLToPath(new URL('./goal-bar.overlay.yml', import.meta.url))
const MODE = webSnapshotMode()
const MULTILINE_OBJECTIVE = 'Guard rapid clear clicks\nPreserve requirement order'

describe('web e2e: goal bar clear convergence', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, welcomeNoticePending: true })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    const login = await page.context().request.get(scaffold.authenticatedUrl, { maxRedirects: 0 })
    expect(login.status()).toBe(303)
    await page.goto(`${scaffold.baseUrl}?fixture`, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('round-trips a multiline edit and clears it without exposing a stale error', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-goal-bar-clear'))
    // Startup reuses the fixture workspace's blank session, keeping this
    // command independent of alpha's running replay and pending question.
    const input = page.locator('[data-composer-input][data-placeholder="Describe what you want to build... / commands, @ files or sessions"]')
    await input.waitFor({ timeout: 10_000 })
    await input.fill('/goal guard rapid clear clicks')
    await input.press('Enter')

    const bar = page.locator('[data-goal-bar]')
    await bar.waitFor({ timeout: 10_000 })
    const snapshot = await captureStableAria(page, '[data-goal-bar]', scaffold.workspaceCwd)
    await compareOrRefreshGolden(ACTIVE_EXPECTED, snapshot, MODE)

    await bar.getByRole('button', { name: 'Edit goal' }).click()
    const editor = bar.getByRole('textbox', { name: 'Goal objective' })
    await editor.fill(MULTILINE_OBJECTIVE)
    await editor.press('Control+Enter')
    await expect.poll(() => bar.textContent(), { timeout: 10_000 }).toContain(MULTILINE_OBJECTIVE)

    await bar.getByRole('button', { name: 'Edit goal' }).click()
    const projectedEditor = bar.getByRole('textbox', { name: 'Goal objective' })
    expect(await projectedEditor.inputValue()).toBe(MULTILINE_OBJECTIVE)
    await projectedEditor.fill('Discarded draft')
    await projectedEditor.press('Escape')
    await bar.getByRole('button', { name: 'Edit goal' }).click()
    expect(await bar.getByRole('textbox', { name: 'Goal objective' }).inputValue()).toBe(MULTILINE_OBJECTIVE)
    await bar.getByRole('button', { name: 'Cancel edit' }).click()

    const clear = bar.getByRole('button', { name: 'Clear goal' })
    await clear.evaluate((button) => {
      const control = button as HTMLButtonElement
      control.click()
      control.click()
    })
    await expect.poll(() => page.locator('[data-goal-bar]').count(), { timeout: 10_000 }).toBe(0)
    expect(await page.getByText(/no current goal/iu).count()).toBe(0)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  }, 60_000)

  it.skipIf(MODE === 'record')('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['active.expected.md'])
  })
})
