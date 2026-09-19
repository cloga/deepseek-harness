/** Fresh New Session creation and folding with another writer holding a blank Session. */

import { readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import type { SessionHandle } from '@deepseek-ai/dsh-session-persistence'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  launchWebScaffold,
  seedSession,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const EXPECTED_DIR = fileURLToPath(new URL('./expected/workspace-new-session-folding', import.meta.url))
const SIDEBAR_EXPECTED = join(EXPECTED_DIR, 'sidebar.expected.md')
const SEED = fileURLToPath(new URL('../../../snapshots/web/message-feedback-protocol/session.v3.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const EXISTING_SESSION_COUNT = 6

describe('web e2e: blank New Session folding quota', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let otherWriter: Context
  let occupied: SessionHandle
  const occupiedId = SessionId('workspace-new-session-occupied-blank')
  const selectedId = (): Promise<string | null> => page.evaluate(() => {
    const current = localStorage.getItem('dsh.sessions.current')
    return current === null ? null : (JSON.parse(current) as { sessionId: string }).sessionId
  })

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const fixture = await readFile(SEED, 'utf8')
    const sessionIds = []
    for (let index = 1; index <= EXISTING_SESSION_COUNT; index += 1) {
      sessionIds.push(await seedSession(
        scaffold,
        fixture,
        `workspace-new-session-folding-${String(index).padStart(2, '0')}`,
      ))
    }
    const workspace = await scaffold.ctx.workspaceRegistry.create(scaffold.workspaceCwd)
    for (const sessionId of sessionIds) await workspace.attachSession(sessionId)

    // A separate persistence instance holds the kernel lease without publishing
    // an Agent in the serving Host, as a second Desktop instance would.
    otherWriter = new Context()
    await otherWriter.plugin(JsonlSessionPersistence, { root: scaffold.persistenceRoot })
    occupied = await otherWriter.sessionPersistence.create({
      id: occupiedId,
      version: SESSION_FORMAT_VERSION,
      createdAt: Date.now(),
      isSeeded: false,
      cwd: scaffold.workspaceCwd,
    })
    await occupied.flush()
    await workspace.attachSession(occupiedId)
    scaffold.ctx.sessionProjectionCache.coldSnapshot(occupied.header, occupied.inheritedEventCount, [])
  }, 120_000)

  const openFreshSessionFromOccupiedBlank = async (): Promise<void> => {
    await expect.poll(async () => {
      const rows = await scaffold.ctx.sessionController.list({}, new AbortController().signal)
      return rows.items.find(row => row.sessionId === occupiedId)
    }).toMatchObject({ blank: true, running: false })
    await expect(scaffold.ctx.sessionPersistence.open(occupiedId, 'write'))
      .rejects.toThrow('already owned by an active write handle')

    const ownershipFailures: string[] = []
    scaffold.ctx.on('api-session/error', (sessionId, message) => {
      if (sessionId === occupiedId) ownershipFailures.push(message)
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await expect.poll(() => ownershipFailures.some(message =>
      message.includes('already owned by an active write handle')), { timeout: 15_000 }).toBe(true)
    expect(scaffold.ctx.agents.get(occupiedId)).toBeUndefined()
    await expect.poll(selectedId).toBe(occupiedId)

    const workspaceTitle = basename(scaffold.workspaceCwd)
    const workspaceRow = page.getByText(workspaceTitle, { exact: true }).first()
      .locator('xpath=ancestor::*[@role="treeitem"][1]')
    await workspaceRow.waitFor({ timeout: 15_000 })
    if (await workspaceRow.getAttribute('aria-expanded') !== 'true') await workspaceRow.click()
    await workspaceRow.hover()
    await page.getByRole('button', { name: `New session in ${workspaceTitle}` }).click()
    await page.getByRole('tree', { name: 'Sessions' })
      .getByText('New Session', { exact: true }).waitFor({ timeout: 15_000 })
    await expect.poll(() => scaffold.ctx.sessions.list().map(session => session.id), { timeout: 15_000 })
      .toHaveLength(1)
    const fresh = scaffold.ctx.sessions.list()[0]!
    expect(fresh.id).not.toBe(occupiedId)
    await expect.poll(selectedId).toBe(fresh.id)
    expect(scaffold.ctx.agents.get(fresh.id)).toBeDefined()
  }

  afterAll(async () => {
    try {
      await browser?.close()
    } finally {
      try {
        await occupied?.close()
      } finally {
        try {
          await otherWriter?.fiber.dispose()
        } finally {
          await scaffold?.close()
        }
      }
    }
  })

  it('creates fresh Sessions beside an occupied blank and keeps the folding quota', async () => {
    onTestFailed(async () => {
      if (page !== undefined) await saveFailureShot(page, 'web-e2e-workspace-new-session-folding')
    })
    await openFreshSessionFromOccupiedBlank()
    const sidebar = page.getByRole('tree', { name: 'Sessions' })
    await expect.poll(() => sidebar.getByRole('treeitem').count(), { timeout: 15_000 }).toBe(7)
    expect(await sidebar.getByText('New Session', { exact: true }).count()).toBe(1)
    expect(await sidebar.getByText(basename(scaffold.workspaceCwd), { exact: true }).count()).toBe(6)
    const showMore = sidebar.getByRole('button', { name: 'Show 1 more sessions' })
    await showMore.waitFor({ timeout: 15_000 })
    await compareOrRefreshGolden(
      SIDEBAR_EXPECTED,
      await captureStableAria(page, '[role="tree"][aria-label="Sessions"]', scaffold.workspaceCwd),
      MODE,
    )

    await showMore.click()
    await expect.poll(() => sidebar.getByRole('treeitem').count(), { timeout: 10_000 }).toBe(8)
    expect(await sidebar.getByText(basename(scaffold.workspaceCwd), { exact: true }).count()).toBe(7)
    await sidebar.getByRole('button', { name: 'Show less' }).click()
    await expect.poll(() => sidebar.getByRole('treeitem').count()).toBe(7)
    const firstId = scaffold.ctx.sessions.list()[0]!.id
    await page.getByRole('button', { name: 'New session', exact: true }).last().click()
    await expect.poll(() => scaffold.ctx.sessions.list().map(session => session.id), { timeout: 15_000 })
      .toHaveLength(2)
    const freshIds = scaffold.ctx.sessions.list().map(session => session.id)
    expect(new Set(freshIds).size).toBe(2)
    expect(freshIds).toContain(firstId)
    expect(freshIds).not.toContain(occupiedId)
    const secondId = freshIds.find(id => id !== firstId)!
    await expect.poll(selectedId).toBe(secondId)
    expect(scaffold.ctx.agents.get(secondId)).toBeDefined()
    await expect.poll(() => sidebar.getByText('New Session', { exact: true }).count()).toBe(1)
    expect((await occupied.read()).events).toEqual([])
    await expect(scaffold.ctx.sessionPersistence.open(occupiedId, 'write'))
      .rejects.toThrow('already owned by an active write handle')
    await assertFixtureInventory(EXPECTED_DIR, ['sidebar.expected.md'])
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
