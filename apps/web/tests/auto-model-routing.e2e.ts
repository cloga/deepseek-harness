/** Keyless shipped-Web acceptance for Auto intent, actual model use, and revision-fenced settings. */

import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, ConsoleMessage, Locator, Page, Request, Response } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmModelInfo, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import { parseRoutingClassifierConfig, parseRoutingPolicy } from '@deepseek-ai/dsh-model-routing'
import type { Config } from '@deepseek-ai/dsh-model-routing'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-session-projection'
import { launchWebScaffold, webSnapshotMode, type WebScaffold } from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, writeComposerDraft } from './support.ts'

const PROVIDER = 'auto-routing-browser-test'
const MODELS = [
  { id: 'small', name: 'Auto Test Small' },
  { id: 'large', name: 'Auto Test Large' },
  { id: 'alternate', name: 'Auto Test Alternate' },
  { id: 'classifier', name: 'Auto Test Classifier' },
] as const
const REPLY = 'The real Host selected the small model with low effort.'
const MANUAL_REPLY = 'The same concrete model now answers in manual mode.'
const ARTIFACTS = fileURLToPath(new URL('../../../.artifacts/auto-model-routing', import.meta.url))

/** Only the external model boundary is substituted; selection, audit, transport and rendering stay real. */
class AutoRoutingAdapter extends LlmAdapter {
  readonly calls: { purpose: GenerateOptions['purpose']; provider: string; model: string; effort: string | undefined }[] = []

  override providerInfo(provider: string) { return { id: provider, name: 'Auto Routing Test' } }

  override listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    return Promise.resolve(MODELS.map(model => ({ ...model, provider })))
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    const listed = MODELS.find(entry => entry.id === model)
    if (listed === undefined) return Promise.reject(new Error(`unexpected fixture model: ${model}`))
    return Promise.resolve({
      provider, ...listed, context: { contextWindow: 128_000 }, inputModalities: ['text'],
      reasoning: {
        efforts: [
          { id: ReasoningEffortId('low'), name: 'Low' },
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        defaultEffort: ReasoningEffortId('high'),
      },
    })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    options.signal?.throwIfAborted()
    this.calls.push({ purpose: options.purpose, provider: options.provider, model: options.model, effort: options.reasoningEffort })
    const ordinary = this.calls.filter(call => call.purpose !== 'model-routing').length
    const text = options.purpose === 'model-routing'
      ? JSON.stringify({ continuity: 'new-task', complexity: 'routine', confidence: 1, reasonCode: 'new-task' })
      : ordinary === 1 ? REPLY : MANUAL_REPLY
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

function routingConfig(): Config {
  return {
    enabled: true,
    policy: parseRoutingPolicy({
      candidates: [
        { id: 'small-low', selection: { provider: PROVIDER, model: 'small', reasoningEffort: 'low' }, quality: 1, relativeCost: 1 },
        { id: 'large-high', selection: { provider: PROVIDER, model: 'large', reasoningEffort: 'high' }, quality: 3, relativeCost: 5 },
      ],
      qualityFloors: {
        efficiency: { routine: 1, standard: 1, complex: 3 },
        balanced: { routine: 1, standard: 3, complex: 3 },
        intelligence: { routine: 3, standard: 3, complex: 3 },
      },
      conservativeCandidateId: 'large-high', minConfidence: 0.8,
    }),
    classifier: parseRoutingClassifierConfig({
      selection: { provider: PROVIDER, model: 'classifier', reasoningEffort: 'low' },
      maxInputBytes: 16_000, maxOutputTokens: 256, maxOutputBytes: 16_000, timeoutMs: 10_000,
    }),
  }
}

/** Own every observer through the last interaction, then detach and seal before deliberate teardown. */
function observeBrowser(page: Page) {
  const errors: string[] = []
  let sealed: readonly string[] | undefined
  const onPageError = (error: Error) => { errors.push(`page: ${error.message}`) }
  const onConsole = (message: ConsoleMessage) => { if (message.type() === 'error') errors.push(`console: ${message.text()}`) }
  const onResponse = (response: Response) => {
    if (response.status() >= 400) errors.push(`http: ${response.status()} ${response.url()}`)
  }
  const onRequestFailed = (request: Request) => { errors.push(`request: ${request.url()} ${request.failure()?.errorText ?? 'failed'}`) }
  page.on('pageerror', onPageError)
  page.on('console', onConsole)
  page.on('response', onResponse)
  page.on('requestfailed', onRequestFailed)
  return {
    seal(): readonly string[] {
      if (sealed !== undefined) return sealed
      page.off('pageerror', onPageError)
      page.off('console', onConsole)
      page.off('response', onResponse)
      page.off('requestfailed', onRequestFailed)
      sealed = Object.freeze([...errors])
      return sealed
    },
  }
}

async function componentShot(component: Locator, name: string): Promise<void> {
  expect(await component.count()).toBe(1)
  await mkdir(ARTIFACTS, { recursive: true })
  await component.screenshot({ path: join(ARTIFACTS, `${name}.png`) })
}

// Never enter the scaffold's real-provider record mode, even when a developer has credentials.
describe.skipIf(webSnapshotMode() === 'record')('web e2e: Auto model routing', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page
  let observation: ReturnType<typeof observeBrowser> | undefined
  let adapter: AutoRoutingAdapter

  beforeEach(async () => {
    scaffold = await launchWebScaffold()
    adapter = new AutoRoutingAdapter()
    const world = scaffold
    world.ctx.effect(() => world.ctx.llm.registerAdapter([PROVIDER], adapter), 'Auto routing browser fixture adapter')
    await world.ctx.settings.replace('model-routing', routingConfig())
    await world.ctx.agentDefaultModel.saveSelection({ provider: PROVIDER, model: 'large', reasoningEffort: ReasoningEffortId('high') })
    // CI uses pinned Chromium; local acceptance may use an explicitly selected installed browser.
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await newEnglishPage(browser)
    observation = observeBrowser(page)
    await page.goto(world.authenticatedUrl, { waitUntil: 'load' })
    await connectFreshWorkspace(page, world.workspaceCwd)
  }, 120_000)

  afterEach(async () => {
    const errors = observation?.seal() ?? []
    observation = undefined
    // Inspect the sealed interval, not errors caused by closing the test's own transport.
    const browserClosed = await Promise.allSettled([browser?.close()])
    const hostClosed = await Promise.allSettled([scaffold?.close()])
    browser = undefined
    scaffold = undefined
    expect(errors).toEqual([])
    expect([...browserClosed, ...hostClosed].filter(result => result.status === 'rejected')).toEqual([])
  })

  function world(): WebScaffold {
    if (scaffold === undefined) throw new Error('Auto routing browser scaffold is not running')
    return scaffold
  }

  async function chooseAuto(label: 'Efficiency' | 'Balance' | 'Intelligence'): Promise<void> {
    const trigger = page.getByRole('button', { name: /^(Select model, current|Automatic model selection, current strategy)/ })
    await trigger.waitFor({ timeout: 15_000 })
    expect(await trigger.count()).toBe(1)
    await trigger.click()
    const menu = page.getByRole('menu', { name: 'Model and reasoning effort', exact: true })
    await menu.getByRole('menuitem', { name: /^Auto / }).click()
    for (const mode of ['Efficiency', 'Balance', 'Intelligence']) {
      expect(await menu.getByRole('menuitemradio', { name: mode, exact: true }).isEnabled()).toBe(true)
    }
    await menu.getByRole('menuitemradio', { name: label, exact: true }).click()
    await page.getByRole('button', { name: `Automatic model selection, current strategy ${label}`, exact: true }).waitFor()
  }

  it('keeps Auto intent separate from actual use and exits Auto when the same concrete model is selected', async () => {
    for (const label of ['Efficiency', 'Intelligence', 'Balance'] as const) await chooseAuto(label)
    const automatic = page.getByRole('button', { name: 'Automatic model selection, current strategy Balance', exact: true })
    expect(await automatic.getAttribute('title')).toBe('Model and effort are selected when the task starts')
    expect(await automatic.textContent()).not.toContain('Auto Test Large')
    expect(adapter.calls).toEqual([])
    expect(world().ctx.agentDefaultModel.currentSelection()).toMatchObject({ provider: PROVIDER, model: 'large', reasoningEffort: 'high' })
    expect(world().ctx.llm.listProviders().map(provider => provider.id)).not.toContain('auto')

    const input = page.locator('[data-composer-input][contenteditable="true"]')
    expect(await input.count()).toBe(1)
    await writeComposerDraft(page, input, 'Explain a small, routine change.')
    const [sessionId] = await Promise.all([world().whenTurnSettled(30_000), input.press('Enter')])
    const session = world().ctx.sessions.get(sessionId)
    if (session === undefined) throw new Error('Browser prompt did not create its live Session')
    await page.getByText(REPLY, { exact: true }).waitFor({ timeout: 15_000 })
    expect(session.requestHeader()?.config).toMatchObject({ provider: PROVIDER, model: 'small', reasoningEffort: 'low' })
    expect(adapter.calls).toEqual([
      { purpose: 'model-routing', provider: PROVIDER, model: 'classifier', effort: 'low' },
      { purpose: undefined, provider: PROVIDER, model: 'small', effort: 'low' },
    ])
    await expect.poll(() => automatic.getAttribute('title')).toBe('Last used: Auto Test Small · Low')
    const routing = world().ctx.sessionProjections.stateOf(session, 'modelRouting')
    expect(routing?.intent.kind).toBe('auto')
    expect(routing?.activeTask?.selection).toEqual({ provider: PROVIDER, model: 'small', reasoningEffort: 'low' })
    await componentShot(automatic, 'actual-auto-selection')

    await automatic.click()
    const menu = page.getByRole('menu', { name: 'Model and reasoning effort', exact: true })
    expect(await menu.getByRole('menuitem', { name: 'Effort Auto', exact: true }).isDisabled()).toBe(true)
    await menu.getByRole('menuitem', { name: 'Model Auto Test Small', exact: true }).click()
    const sameModel = menu.getByRole('group', { name: 'Auto Routing Test', exact: true })
      .getByRole('menuitemradio', { name: 'Auto Test Small', exact: true })
    expect(await sameModel.getAttribute('aria-checked')).toBe('false')
    await sameModel.click()
    await page.getByRole('button', { name: 'Select model, current Auto Test Small, reasoning effort Low', exact: true }).waitFor()
    expect(world().ctx.sessionProjections.stateOf(session, 'modelRouting')?.intent.kind).toBe('manual')
    await expect.poll(() => world().ctx.agentDefaultModel.currentSelection(), { timeout: 10_000 })
      .toEqual({ provider: PROVIDER, model: 'small', reasoningEffort: 'low' })
    expect(adapter.calls).toHaveLength(2)

    await writeComposerDraft(page, input, 'Answer once more on the selected manual model.')
    const [manualSessionId] = await Promise.all([world().whenTurnSettled(30_000), input.press('Enter')])
    expect(manualSessionId).toBe(sessionId)
    await page.getByText(MANUAL_REPLY, { exact: true }).waitFor({ timeout: 15_000 })
    expect(adapter.calls).toHaveLength(3)
    expect(adapter.calls[2]).toEqual({ purpose: undefined, provider: PROVIDER, model: 'small', effort: 'low' })
    expect(session.requestHeader()?.config).toMatchObject({ provider: PROVIDER, model: 'small', reasoningEffort: 'low' })
  }, 90_000)

  it('stages candidate model and effort edits, saves through Remote, and retains drafts across a competing revision', async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.getByRole('button', { name: 'Plugins', exact: true }).click()
    await dialog.getByRole('tab', { name: 'Plugin configuration', exact: true }).click()
    await dialog.getByRole('button', { name: 'Show settings: Auto model routing', exact: true }).click()
    const card = dialog.getByRole('listitem').filter({ has: page.getByRole('button', { name: 'Hide settings: Auto model routing', exact: true }) })
    expect(await card.count()).toBe(1)
    const candidate = card.getByRole('group', { name: 'Candidate 1', exact: true })
    const model = candidate.getByRole('combobox', { name: 'Provider and model', exact: true })
    const effort = candidate.getByRole('combobox', { name: 'Reasoning effort', exact: true })
    await expect.poll(() => model.locator('option').allTextContents()).toContain(`Auto Routing Test · Auto Test Alternate (${PROVIDER}/alternate)`)
    expect(await effort.inputValue()).toBe('low')
    await model.selectOption({ label: `Auto Routing Test · Auto Test Alternate (${PROVIDER}/alternate)` })
    expect(await effort.inputValue()).toBe('')
    await effort.selectOption('high')
    expect(world().ctx.settings.get('model-routing')).toMatchObject({ policy: { candidates: [
      { id: 'small-low', selection: { model: 'small', reasoningEffort: 'low' } },
      { id: 'large-high' },
    ] } })
    expect(adapter.calls).toEqual([])
    await card.getByRole('button', { name: 'Save', exact: true }).click()
    await dialog.getByRole('button', { name: 'Show settings: Auto model routing', exact: true }).waitFor()
    expect(world().ctx.settings.get('model-routing')).toMatchObject({ policy: { candidates: [
      { id: 'small-low', selection: { provider: PROVIDER, model: 'alternate', reasoningEffort: 'high' } },
      { id: 'large-high' },
    ] } })

    await dialog.getByRole('button', { name: 'Show settings: Auto model routing', exact: true }).click()
    await effort.selectOption('low')
    await card.getByRole('button', { name: 'Discard', exact: true }).click()
    expect(await effort.inputValue()).toBe('high')
    expect(await card.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)

    const cost = candidate.getByRole('spinbutton', { name: 'Relative cost weight', exact: true })
    await cost.fill('2')
    const saved = world().ctx.settings.get('model-routing') as Config
    if (saved.policy === undefined) throw new Error('Saved Auto policy is missing')
    // A second real Host writer advances the namespace revision; the browser's draft must not overwrite it.
    await world().ctx.settings.replace('model-routing', {
      enabled: saved.enabled,
      ...saved.classifier === undefined ? {} : { classifier: saved.classifier },
      policy: { ...saved.policy, candidates: saved.policy.candidates.map(entry => entry.id === 'small-low' ? { ...entry, relativeCost: 3 } : entry) },
    })
    await card.getByRole('status').filter({ hasText: 'Settings changed elsewhere. Discard this draft to load the latest settings before saving again.' }).waitFor()
    expect(await cost.inputValue()).toBe('2')
    expect(await card.getByRole('button', { name: 'Save', exact: true }).isDisabled()).toBe(true)
    await componentShot(candidate, 'conflicted-candidate-draft')
    await card.getByRole('button', { name: 'Discard', exact: true }).click()
    expect(await cost.inputValue()).toBe('3')
    expect(await effort.inputValue()).toBe('high')
    expect(await card.getByRole('status').filter({ hasText: 'Settings changed elsewhere.' }).count()).toBe(0)
    expect(adapter.calls).toEqual([])
  }, 90_000)
})
