/** Real compiled Web acceptance with simulated updater state only at the Electron preload boundary. */
import { strict as assert } from 'node:assert'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import type { DesktopUpdateState, DshDesktopApplicationApi } from '../src/ipc.ts'

interface UpdateNoticeFixtureWindow extends Window {
  dshDesktop: DshDesktopApplicationApi
  __dshDesktopUpdateNoticeFixture: {
    readonly reviewCalls: number
    readonly snapshotReads: number
    readonly subscriberCount: number
    publish(state: DesktopUpdateState): void
  }
}

/**
 * Install the fixture-only preload API; serialized by Playwright, so it has no module dependencies.
 * No check, download, install, restart, plugins, or raw IPC methods are exposed.
 * @param availableVersion - Simulated version retained across reload by a fixture-only sessionStorage flag.
 */
export function installDesktopUpdateNoticeFixture(availableVersion: string): void {
  const fixtureWindow = window as unknown as UpdateNoticeFixtureWindow
  const fixtureSnapshotKey = '__dshDesktopUpdateNoticeFixture.availableOnReload'
  let fixtureState: DesktopUpdateState = sessionStorage.getItem(fixtureSnapshotKey) === 'true'
    ? { phase: 'available', version: availableVersion }
    : { phase: 'idle' }
  let fixtureReviewCalls = 0
  let fixtureSnapshotReads = 0
  const fixtureListeners = new Set<(state: DesktopUpdateState) => void>()
  fixtureWindow.dshDesktop = {
    protocolVersion: 2,
    updates: {
      reportImpact() {},
      async status() {
        fixtureSnapshotReads++
        return fixtureState
      },
      subscribe(listener) {
        fixtureListeners.add(listener)
        return () => { fixtureListeners.delete(listener) }
      },
      async review() {
        fixtureReviewCalls++
        // Simulate choosing Later in the native dialog: leave the notification unchanged.
      },
    },
  }
  fixtureWindow.__dshDesktopUpdateNoticeFixture = {
    get reviewCalls() { return fixtureReviewCalls },
    get snapshotReads() { return fixtureSnapshotReads },
    get subscriberCount() { return fixtureListeners.size },
    publish(state) {
      fixtureState = state
      sessionStorage.setItem(fixtureSnapshotKey, String(state.phase === 'available'))
      for (const listener of fixtureListeners) listener(state)
    },
  }
}

/**
 * Verify notification behavior in the full compiled composition on a caller-owned fresh page.
 * Only Electron's preload API is simulated; this never checks for or installs an update.
 * @param page - Separate fresh page, closed by the caller even when acceptance fails.
 * @param origin - Existing isolated Desktop Host byte-pipe carrier origin.
 * @param timeout - Bound for each observable UI transition.
 * @param evidenceDirectory - Optional run-owned screenshot directory, published only after the complete smoke passes.
 */
export async function assertDesktopUpdateNoticeInBrowser(
  page: Page,
  origin: string,
  timeout = 30_000,
  evidenceDirectory?: string,
): Promise<void> {
  page.setDefaultTimeout(timeout)
  const fixtureVersion = '0.1.5-rc.3.cloga.7'
  await page.addInitScript(installDesktopUpdateNoticeFixture, fixtureVersion)
  await page.goto(origin, { waitUntil: 'load' })
  await page.waitForFunction(() => {
    const fixture = (window as unknown as UpdateNoticeFixtureWindow).__dshDesktopUpdateNoticeFixture
    return fixture.subscriberCount > 0 && fixture.snapshotReads > 0
  }, undefined, { timeout })
  const notice = page.locator('[data-desktop-update-notice]')
  const composer = page.locator('[data-composer-input]')
  await composer.waitFor({ state: 'visible' })
  assert.equal(await notice.count(), 0, 'idle updater must not render a notice')
  await composer.focus()
  assert.equal(await composer.evaluate(element => element === document.activeElement), true)
  await page.evaluate((version) => {
    (window as unknown as UpdateNoticeFixtureWindow).__dshDesktopUpdateNoticeFixture.publish({ phase: 'available', version })
  }, fixtureVersion)
  await notice.waitFor({ state: 'visible' })
  await notice.getByRole('status').getByText('Update available', { exact: true }).waitFor({ state: 'visible' })
  await notice.getByRole('status').getByText(fixtureVersion, { exact: true }).waitFor({ state: 'visible' })
  await notice.getByText('No automatic installation or restart', { exact: true }).waitFor({ state: 'visible' })
  assert.equal(await composer.evaluate(element => element === document.activeElement), true,
    'publishing an update must not steal composer focus')
  assert.equal(await page.evaluate(() => (window as unknown as UpdateNoticeFixtureWindow)
    .__dshDesktopUpdateNoticeFixture.reviewCalls), 0, 'receiving an update must not review it automatically')

  const assertPlacement = async (): Promise<void> => {
    await composer.waitFor({ state: 'visible' })
    const placement = await notice.evaluate((element) => {
      const main = element.nextElementSibling
      const center = element.parentElement
      if (main === null || center === null) throw new Error('notice must precede the main panel in the center column')
      const strip = element.getBoundingClientRect()
      const panel = main.getBoundingClientRect()
      const column = center.getBoundingClientRect()
      const occupants = Array.from(main.querySelectorAll('[data-composer-card], [data-conversation-header-corner]'))
        .map(occupant => occupant.getBoundingClientRect())
        .filter(rect => rect.width > 0 && rect.height > 0)
      return {
        aboveMain: strip.bottom <= panel.top + 1,
        atColumnTop: Math.abs(strip.top - column.top) <= 1,
        visibleMain: panel.width > 0 && panel.height > 0,
        composerInMain: main.querySelector('[data-composer-input]') !== null,
        overlapsOccupant: occupants.some(rect => strip.left < rect.right && strip.right > rect.left
          && strip.top < rect.bottom && strip.bottom > rect.top),
      }
    })
    assert.deepEqual(placement, {
      aboveMain: true, atColumnTop: true, visibleMain: true, composerInMain: true, overlapsOccupant: false,
    }, 'notice must occupy normal flow above the main panel without covering composer/header')
  }
  await assertPlacement()

  const review = notice.getByRole('button', { name: 'Review update', exact: true })
  await review.click()
  await page.waitForFunction(() => (window as unknown as UpdateNoticeFixtureWindow)
    .__dshDesktopUpdateNoticeFixture.reviewCalls === 1, undefined, { timeout })
  await review.waitFor({ state: 'visible' })
  assert.equal(await review.isEnabled(), true, 'Later must finish review without dismissing the notice')
  assert.equal(await notice.isVisible(), true, 'Later must retain the available notice')
  assert.equal(await page.evaluate(() => (window as unknown as UpdateNoticeFixtureWindow)
    .__dshDesktopUpdateNoticeFixture.reviewCalls), 1, 'one click must cause exactly one review')
  if (evidenceDirectory !== undefined) {
    mkdirSync(evidenceDirectory, { recursive: true })
    await page.screenshot({ path: join(evidenceDirectory, '03-desktop-update-notice.png'), animations: 'disabled' })
  }

  await page.reload({ waitUntil: 'load' })
  await notice.waitFor({ state: 'visible' })
  await notice.getByRole('status').getByText(fixtureVersion, { exact: true }).waitFor({ state: 'visible' })
  assert.equal(await page.evaluate(() => (window as unknown as UpdateNoticeFixtureWindow)
    .__dshDesktopUpdateNoticeFixture.reviewCalls), 0, 'remount must restore the snapshot without initiating review')
  await page.emulateMedia({ colorScheme: 'dark' })
  try {
    // Observe the real theme service's media-query response, not fixture-injected styles or tokens.
    await page.locator('body[data-ds-dark-theme]').waitFor({ state: 'attached' })
    await notice.waitFor({ state: 'visible' })
    await assertPlacement()
    if (evidenceDirectory !== undefined) {
      await page.screenshot({ path: join(evidenceDirectory, '04-desktop-update-notice-dark.png'), animations: 'disabled' })
    }
  } finally {
    await page.emulateMedia({ colorScheme: 'light' })
  }
  await page.locator('body:not([data-ds-dark-theme])').waitFor({ state: 'attached' })
  const mainPanel = await notice.evaluateHandle(element => element.nextElementSibling!)
  try {
    await page.evaluate(() => {
      (window as unknown as UpdateNoticeFixtureWindow).__dshDesktopUpdateNoticeFixture.publish({ phase: 'idle' })
    })
    await notice.waitFor({ state: 'detached' })
    assert.equal(await mainPanel.evaluate((panel) => {
      const rect = panel.getBoundingClientRect()
      const center = panel.parentElement!.getBoundingClientRect()
      return Math.abs(rect.top - center.top) <= 1 && Math.abs(rect.height - center.height) <= 1
    }), true, 'idle must restore the full main panel without reserved notice space')
  } finally {
    await mainPanel.dispose()
  }
  console.log('desktop smoke: update notice passed in real compiled Web composition; '
    + 'simulated Electron updater state and Later review only; no real check, download, install, or restart')
}
