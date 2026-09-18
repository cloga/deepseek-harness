/** Real compiled Web acceptance with simulated updater state only at the official preload boundary. */
import { strict as assert } from 'node:assert'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { Page } from 'playwright'
import type { DesktopUpdatePresentation, DshDesktopProductApi } from '../src/ipc.ts'

interface UpdateNoticeFixtureWindow extends Window {
  dshDesktop: DshDesktopProductApi
  __dshDesktopUpdateNoticeFixture: {
    readonly reviewCalls: number
    readonly snapshotReads: number
    readonly subscriberCount: number
    publish(state: DesktopUpdatePresentation): void
  }
}

/**
 * Install the official product API fixture; serialized by Playwright without module dependencies.
 * No check, download, install, restart, plugins, or raw IPC methods are exposed.
 * @param availableVersion - Simulated version retained across reload by a fixture-only sessionStorage flag.
 */
export function installDesktopUpdateNoticeFixture(availableVersion: string): void {
  const fixtureWindow = window as unknown as UpdateNoticeFixtureWindow
  const fixtureSnapshotKey = '__dshDesktopUpdateNoticeFixture.availableOnReload'
  let fixtureState: DesktopUpdatePresentation = sessionStorage.getItem(fixtureSnapshotKey) === 'true'
    ? { phase: 'available', version: availableVersion }
    : { phase: 'idle' }
  let fixtureReviewCalls = 0
  let fixtureSnapshotReads = 0
  const fixtureListeners = new Set<(state: DesktopUpdatePresentation) => void>()
  fixtureWindow.dshDesktop = {
    protocolVersion: 1,
    updates: {
      async status() { fixtureSnapshotReads++; return fixtureState },
      subscribe(listener) {
        fixtureListeners.add(listener)
        return () => { fixtureListeners.delete(listener) }
      },
      async open() { fixtureReviewCalls++ },
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
 * Verify official indicator and collapsed badge in the full compiled composition.
 * Only Electron's product API is simulated; this never checks for or installs an update.
 * @param page - Separate fresh page, closed by the caller even when acceptance fails.
 * @param origin - Existing isolated Web-backed Desktop Host origin.
 * @param timeout - Bound for each observable UI transition.
 * @param evidenceDirectory - Optional run-owned screenshots, published only after the complete smoke passes.
 */
export async function assertDesktopUpdateNoticeInBrowser(
  page: Page,
  origin: string,
  timeout = 30_000,
  evidenceDirectory?: string,
): Promise<void> {
  page.setDefaultTimeout(timeout)
  const fixtureVersion = '0.1.6-alpha.2.cloga.fixture'
  await page.addInitScript(installDesktopUpdateNoticeFixture, fixtureVersion)
  await page.goto(origin, { waitUntil: 'load' })
  await page.waitForFunction(() => {
    const fixture = (window as unknown as UpdateNoticeFixtureWindow).__dshDesktopUpdateNoticeFixture
    return fixture.subscriberCount > 0 && fixture.snapshotReads > 0
  }, undefined, { timeout })
  const indicator = page.getByRole('button', { name: 'Update', exact: true })
  const composer = page.locator('[data-composer-input]').first()
  await composer.waitFor({ state: 'visible' })
  assert.equal(await indicator.count(), 0, 'idle updater must not render the official indicator')
  await composer.focus()
  await page.evaluate(version => {
    (window as unknown as UpdateNoticeFixtureWindow).__dshDesktopUpdateNoticeFixture.publish({ phase: 'available', version })
  }, fixtureVersion)
  await indicator.waitFor({ state: 'visible' })
  assert.equal(await composer.evaluate(element => element === document.activeElement), true,
    'publishing an update must not steal composer focus')
  const calls = () => page.evaluate(() => (window as unknown as UpdateNoticeFixtureWindow)
    .__dshDesktopUpdateNoticeFixture.reviewCalls)
  assert.equal(await calls(), 0, 'receiving an update must not open confirmation automatically')
  await indicator.hover()
  await page.getByRole('tooltip').filter({ hasText: fixtureVersion }).waitFor({ state: 'visible' })
  await indicator.click()
  await page.waitForFunction(() => (window as unknown as UpdateNoticeFixtureWindow)
    .__dshDesktopUpdateNoticeFixture.reviewCalls === 1, undefined, { timeout })
  await indicator.waitFor({ state: 'visible' })
  assert.equal(await calls(), 1, 'one click must open confirmation exactly once')
  if (evidenceDirectory !== undefined) {
    mkdirSync(evidenceDirectory, { recursive: true })
    await page.screenshot({ path: join(evidenceDirectory, '03-desktop-update-indicator.png'), animations: 'disabled' })
  }
  await page.reload({ waitUntil: 'load' })
  await indicator.waitFor({ state: 'visible' })
  assert.equal(await calls(), 0, 'reload must restore availability without opening confirmation')
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await page.getByRole('img', { name: 'Update', exact: true }).waitFor({ state: 'visible' })
  await page.getByRole('button', { name: 'Open sidebar', exact: true }).click()
  await indicator.waitFor({ state: 'visible' })
  await page.evaluate(() => {
    (window as unknown as UpdateNoticeFixtureWindow).__dshDesktopUpdateNoticeFixture.publish({ phase: 'error', failure: 'check-network' })
  })
  const retry = page.getByRole('button', { name: 'Retry update', exact: true })
  await retry.waitFor({ state: 'visible' })
  assert.equal(await retry.getAttribute('data-error'), 'true')
  assert.equal(await calls(), 0, 'an error must not retry automatically')
  await page.emulateMedia({ colorScheme: 'dark' })
  try {
    await page.locator('body[data-ds-dark-theme]').waitFor({ state: 'attached' })
    if (evidenceDirectory !== undefined) {
      await page.screenshot({ path: join(evidenceDirectory, '04-desktop-update-error-dark.png'), animations: 'disabled' })
    }
  } finally { await page.emulateMedia({ colorScheme: 'light' }) }
  await page.evaluate(() => {
    (window as unknown as UpdateNoticeFixtureWindow).__dshDesktopUpdateNoticeFixture.publish({ phase: 'idle' })
  })
  await retry.waitFor({ state: 'detached' })
}
