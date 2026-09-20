/** Manual compact follows the accepted composer selection without another model turn. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-commands/types'
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, parseSeedFixture, selectedSessionFixture, watchConsole, webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/manual-compact-model-selection', import.meta.url))
const FIXTURE = join(SNAPSHOT_DIR, 'session.v3.jsonl')
const CHECKPOINT_EXPECTED = join(SNAPSHOT_DIR, 'checkpoint.expected.md')
const OVERLAY = fileURLToPath(new URL('./manual-compact-model-selection.overlay.yml', import.meta.url))
const MODE = webSnapshotMode()
const PROVIDER = 'deepseek-official'
const FLASH = 'deepseek-v4-flash'
const PRO = 'deepseek-v4-pro'
const PRO_NAME = 'DeepSeek-V4-Pro'

// This authored model script never enables the real adapter, including record mode.
describe.skipIf(MODE === 'record')('web e2e: manual compact model selection', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let fixtureText: string

  beforeAll(async () => {
    const fixture = await selectedSessionFixture(FIXTURE)
    fixtureText = await readFile(fixture, 'utf8')
    scaffold = await launchWebScaffold({
      extraOverlayPath: OVERLAY,
      replayFixture: fixture,
      compareReplaySession: true,
      paceMs: 5,
      replayProviders: [{
        id: PROVIDER,
        name: 'DeepSeek',
        models: [
          { id: FLASH, name: 'DeepSeek-V4-Flash', contextWindow: 128_000 },
          { id: PRO, name: PRO_NAME, contextWindow: 128_000 },
        ],
      }],
    })
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
    await connectFreshWorkspace(page, scaffold.workspaceCwd)
  })

  afterAll(async () => {
    try { await browser?.close() } finally { await scaffold?.close() }
    // close() owns Session/prompt/schema refresh; inventory is checked only afterwards.
    if (scaffold !== undefined) {
      await assertFixtureInventory(SNAPSHOT_DIR, [
        'session.v3.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json', 'checkpoint.expected.md',
      ])
    }
  })

  it('uses the selected model for manual compact without another conversation request', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-manual-compact-model-selection'))
    const prompts = fixtureUserPrompts(fixtureText)
    expect(prompts).toHaveLength(2)
    const seed = parseSeedFixture(fixtureText).events
    const seedSummary = seed.find(event => event.type === 'compaction/summary')
    if (seedSummary?.type !== 'compaction/summary') throw new Error('manual compact fixture requires one summary call')
    const input = page.locator('[data-composer-input]').first()
    await input.waitFor({ timeout: 10_000 })
    let sessionId: SessionId | undefined
    for (const prompt of prompts) {
      await input.fill(prompt)
      const settled = scaffold.whenTurnSettled()
      await input.press('Enter')
      const endedSession = await settled
      if (sessionId !== undefined) expect(endedSession).toBe(sessionId)
      sessionId = endedSession
      const current = scaffold.ctx.agents.get(sessionId)
      if (current === undefined) throw new Error('the browser-created Agent must remain live')
      await current.whenIdle()
    }
    if (sessionId === undefined) throw new Error('the two prompts must create one Session')
    const agent = scaffold.ctx.agents.get(sessionId)
    if (agent === undefined) throw new Error('the browser-created Agent must remain live')
    const session = agent.session
    const originalHeader = session.requestHeader()
    expect(originalHeader?.config).toMatchObject({ provider: PROVIDER, model: FLASH })
    expect(session.snapshotEvents().filter(event => event.type === 'request/header')).toHaveLength(1)

    const model = page.getByRole('button', { name: /^Select model, current/ })
    await model.click()
    await page.getByRole('menuitem', { name: /^Model\b/ }).click()
    await page.getByRole('menuitemradio', { name: PRO_NAME, exact: true }).click()
    await expect.poll(() => model.getAttribute('aria-label'), { timeout: 10_000 }).toContain(PRO_NAME)
    await expect.poll(() => model.getAttribute('aria-expanded'), { timeout: 10_000 }).toBe('false')
    const pending = () => scaffold.ctx.sessionProjections.stateOf(session, 'modelSelection')?.pending
    await expect.poll(pending, { timeout: 10_000 }).toEqual({ provider: PROVIDER, model: PRO })
    expect(session.requestHeader()).toBe(originalHeader)
    expect(session.snapshotEvents().filter(event => event.type === 'turn/start')).toHaveLength(2)

    await input.fill('/compact')
    const suggestions = page.getByRole('listbox', { name: 'Trigger suggestions' })
    await suggestions.waitFor({ timeout: 10_000 })
    // Dismiss completion without changing the command, then submit the actual UI command plane.
    await input.press('Escape')
    await expect.poll(() => suggestions.count(), { timeout: 10_000 }).toBe(0)
    expect(await input.textContent()).toBe('/compact')
    await input.press('Enter')
    await expect.poll(() => session.snapshotEvents().filter(event => event.type === 'command/done').length,
      { timeout: 30_000 }).toBe(1)
    await agent.whenIdle()
    await scaffold.ctx.sessions.flush(session)

    const events = session.snapshotEvents()
    expect(events.filter(event => event.type === 'turn/start')).toHaveLength(2)
    expect(events.filter(event => event.type === 'step/start')).toHaveLength(2)
    expect(events.filter(event => event.type === 'assistant/message')).toHaveLength(2)
    expect(events.filter(event => event.type === 'assistant/attempt')).toHaveLength(0)
    expect(events.filter(event => event.type === 'request/header')).toHaveLength(1)
    expect(events.filter(event => event.type === 'turn/end').map(event => event.data.reason.kind))
      .toEqual(['completed', 'completed'])
    expect(session.requestHeader()).toBe(originalHeader)
    expect(pending()).toEqual({ provider: PROVIDER, model: PRO })

    const summaries = events.filter(event => event.type === 'compaction/summary')
    expect(summaries).toHaveLength(1)
    const summary = summaries[0]
    if (summary === undefined) throw new Error('the real command must commit its summary')
    expect(summary.data).toMatchObject({ provider: PROVIDER, model: PRO, maxTokens: 256, llmStreamCall: true })
    expect(summary.data.summary).toEqual(seedSummary.data.summary)
    expect(summary.data.rawOutput).toEqual(seedSummary.data.rawOutput)
    const starts = events.filter(event => event.type === 'compaction/start')
    const ends = events.filter(event => event.type === 'compaction/end')
    const commands = events.filter(event => event.type === 'command/run')
    const completed = events.filter(event => event.type === 'command/done')
    expect(starts).toHaveLength(1)
    expect(ends).toHaveLength(1)
    expect(commands).toHaveLength(1)
    expect(completed).toHaveLength(1)
    const identity = { compactionId: summary.data.compactionId, sourceCommandId: summary.data.sourceCommandId }
    expect(starts[0]?.data).toMatchObject({ ...identity, turn: null })
    expect(ends[0]?.data).toEqual({ ...identity, turn: null })
    expect(commands[0]?.data).toMatchObject({ commandId: identity.sourceCommandId, name: 'compact', args: '', source: { kind: 'user' } })
    expect(completed[0]?.data).toMatchObject({ commandId: identity.sourceCommandId, kind: 'success', sourceEventSeq: summary.seq })
    const checkpoints = events.filter(event => event.type === 'user/message')
      .filter(event => event.data.source.kind === 'plugin' && event.data.source.plugin === 'compact')
    expect(checkpoints).toHaveLength(1)
    expect(checkpoints[0]?.data.source).toMatchObject({ kind: 'plugin', plugin: 'compact', ...identity })
    expect(checkpoints[0]?.sourceEventSeqs).toContain(summary.seq)
    expect(session.surface.nodes).toContain(checkpoints[0]?.seq)

    const marker = page.getByRole('button', { name: /Compacted \d+ history items/ })
    await marker.waitFor({ timeout: 15_000 })
    expect(await marker.getAttribute('aria-expanded')).toBe('false')
    await marker.click()
    await expect.poll(() => marker.getAttribute('aria-expanded')).toBe('true')
    await expect.poll(() => input.textContent(), { timeout: 10_000 }).toBe('')
    expect(await model.getAttribute('aria-label')).toContain(PRO_NAME)
    expect(await input.isEnabled()).toBe(true)
    await compareOrRefreshGolden(CHECKPOINT_EXPECTED,
      await captureStableAria(page, '[class*="compactionRow"]', scaffold.workspaceCwd), MODE)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
  })
})
