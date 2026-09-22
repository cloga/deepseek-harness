/**
 * ui-model-selection browser half on a real cordis Context with fake command/slots/
 * connection faces and real session scopes: the plugin mounts ModelDirectoryResolver
 * as `models`, the /model contribution and the conversation.input.model
 * seat both register, and BOTH entries resolve the SAME per-session
 * directory through the service — a selection submitted through the seat's
 * inject face is the current the popup's next options pass marks active
 * (and the reverse), the one-shared-state contract of the dual entry.
 * Scope disposal drops the directory (HMR safety).
 */
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createScope } from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import type { ModelRoutingMode, ModelRoutingView, ModelSelection, ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { CommandContribution, PopupSelectSpec, SelectOption } from '@deepseek-ai/dsh-client-ui-commands/client'
import type { ModelSelectInjection } from '../src/client/slots.ts'
import { apply, inject } from '../src/client/index.ts'
import { zh } from '../src/client/locales.ts'

const sid = (k: string): SessionId => k as SessionId
const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

const GROUPS = [{
  id: 'deepseek-official',
  name: 'DeepSeek',
  models: [
    {
      id: 'deepseek-v4-flash',
      name: 'DeepSeek-V4-Flash',
      description: 'Fast, efficient, and economical; suited to focused, routine, or parallel tasks.',
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
        defaultEffort: 'high',
      },
    },
    {
      id: 'deepseek-v4-pro',
      name: 'DeepSeek-V4-Pro',
      description: 'Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.',
      reasoning: {
        efforts: [
          { id: 'off', name: 'Off' },
          { id: 'high', name: 'High' },
          { id: 'max', name: 'Max' },
        ],
        defaultEffort: 'high',
      },
    },
  ],
}, {
  id: 'external',
  name: 'External Provider',
  models: [{
    id: 'deepseek-v4-flash',
    name: 'External Flash',
    description: 'Provider-authored description.',
  }],
}]

/** Boot the plugin over fake faces + a stateful fake host (current moves on selectModel). */
async function bench(locale: 'zh' | 'en' = 'zh', autoAvailable = false) {
  const ctx = new Context()
  roots.push(ctx)
  let defaultSelection: ModelSelection = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }
  let selected = defaultSelection
  const calls = { models: 0, select: 0, auto: 0 }
  const projections = new Map<SessionId, SnapshotStore<ModelSelectionProjection | undefined>>()
  const routing = new Map<SessionId, SnapshotStore<ModelRoutingView | undefined>>()
  // Whether the Host reports an adapter for the current route; the composer
  // block follows this, never catalog membership.
  let routable = true
  const sessionRemote = {
    modelCatalog: () => {
      calls.models += 1
      return Promise.resolve({
        ok: true as const,
        value: {
          default: defaultSelection,
          autoRouting: { available: autoAvailable },
          routableProviders: routable ? ['deepseek-official'] : [],
          groups: GROUPS,
          failures: [],
        },
      })
    },
    selectModel: (payload: { sessionId: SessionId; provider: string; model: string; reasoningEffort?: string }) => {
      calls.select += 1
      selected = {
        provider: payload.provider,
        model: payload.model,
        ...payload.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: payload.reasoningEffort },
      }
      projections.get(payload.sessionId)?.set({ lastUsed: null, next: selected })
      routing.get(payload.sessionId)?.set({ mode: 'manual', lastDecision: null })
      return Promise.resolve({ ok: true as const, value: { selected } })
    },
    selectAutoModel: (payload: { sessionId: SessionId; mode: ModelRoutingMode }) => {
      calls.auto += 1
      routing.get(payload.sessionId)?.set({ mode: payload.mode, lastDecision: null })
      return Promise.resolve({ ok: true as const, value: { mode: payload.mode } })
    },
  }
  const remote = Object.assign(new TestRemote(ctx), { session: sessionRemote })
  ctx.reflect.provide('remote.session', sessionRemote)
  const blocks = new Map<SessionId, { reason: string } | undefined>()
  ctx.provide('conversation', {
    blocks: {
      set: (id: SessionId, block: { reason: string } | undefined) => { blocks.set(id, block) },
    },
  })
  let contribution: CommandContribution | undefined
  ctx.provide('commandUi', {
    register(c: CommandContribution) {
      contribution = c
      return () => { contribution = undefined }
    },
  })
  const seats = new Map<string, {
    inject: ((sessionId: SessionId) => ModelSelectInjection) | undefined
    locale: string | undefined
  }>()
  ctx.provide('slots', {
    inject(_name: string, callback: () => () => void) { return callback() },
    register(options: { name: string; locale?: string; inject?: (sessionId: SessionId) => ModelSelectInjection }) {
      seats.set(options.name, { inject: options.inject, locale: options.locale })
      return () => { seats.delete(options.name) }
    },
  })
  const localeRuntime = new LocaleRuntime(ctx)
  // There is no jsdom `window` in this lane, so browser-language detection
  // never runs. Each bench states the locale its assertions require.
  localeRuntime.setLocale(locale)
  ctx.provide('locale', localeRuntime)
  const scopes = new Map<SessionId, Context>()
  const addressed = new Set<SessionId>()
  ctx.provide('sessions', {
    scope: (id: SessionId) => scopes.get(id),
    binding: (id: SessionId) => {
      const scope = scopes.get(id)
      const projection = projections.get(id)
      const routingProjection = routing.get(id)
      return scope === undefined || projection === undefined || routingProjection === undefined
        ? undefined
        : {
          sessionId: id,
          session: { projections: { faceOf: (key: string) => key === 'modelRouting' ? routingProjection : projection } },
          ctx: scope,
        }
    },
    subagentAddress: (id: SessionId) => addressed.has(id)
      ? { parentSessionId: sid('parent'), childSessionId: id, mode: 'continuable' as const }
      : undefined,
  })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  await fiber.await()
  await ctx.plugin(function probe() {}).await()
  const mint = (key: string) => {
    const id = sid(key)
    const handle = createScope(ctx, id)
    scopes.set(id, handle.ctx)
    projections.set(id, createSnapshotStore<ModelSelectionProjection | undefined>({
      lastUsed: null,
      next: null,
    }))
    routing.set(id, createSnapshotStore<ModelRoutingView | undefined>({ mode: 'manual', lastDecision: null }))
    return handle
  }
  return {
    ctx, fiber, mint, calls, remote,
    contribution: () => contribution!,
    popup: (): PopupSelectSpec => {
      const ui = contribution!.ui
      if (ui.kind !== 'popupSelect') throw new Error('expected the popupSelect kind')
      return ui
    },
    seat: () => seats.get('conversation.input.model')!,
    hostCurrent: () => selected,
    setHostCurrent: (selection: ModelSelection) => { defaultSelection = selection },
    setProjected: (id: SessionId, value: ModelSelectionProjection) => { projections.get(id)?.set(value) },
    setRouting: (id: SessionId, value: ModelRoutingView) => { routing.get(id)?.set(value) },
    setAutoAvailable: (value: boolean) => { autoAvailable = value },
    address: (id: SessionId) => { addressed.add(id) },
    setRoutable: (next: boolean) => { routable = next },
    blockOf: (key: string) => blocks.get(sid(key)),
  }
}

const projection = (id: string) => ({ sessionId: sid(id) })
function actualRouting(selection: ModelSelection, mode: ModelRoutingMode = 'balanced'): ModelRoutingView {
  type Decision = NonNullable<ModelRoutingView['lastDecision']>
  return { mode, lastDecision: {
    taskId: 'task-actual' as Decision['taskId'], intentSeq: 1 as Decision['intentSeq'],
    selection: selection as Decision['selection'], candidateId: 'actual-candidate', reason: 'quality-floor',
  } }
}

describe('ui-model-selection dual entry', () => {
  it('registers the /model contribution and the composer model seat', async () => {
    const b = await bench()
    expect(b.contribution().name).toBe('model')
    expect(b.contribution().ui.kind).toBe('popupSelect')
    expect(b.seat().inject).toBeTypeOf('function')
    // Copy rides the standard locale seat.
    expect(b.seat().locale).toBe('model')
  })

  it('localizes built-in descriptions and preserves external provider descriptions', async () => {
    const b = await bench()
    b.mint('s1')
    const options = await b.popup().options(projection('s1'), new AbortController().signal)
    expect(options.map((o: SelectOption) => o.label)).toEqual([
      'DeepSeek-V4-Flash', 'DeepSeek-V4-Pro', 'External Flash',
    ])
    expect(options[0]).toMatchObject({
      active: true,
      detail: 'DeepSeek · 快速、高效且经济；适合目标明确、常规或并行任务。',
    })
    expect(options[1]?.detail)
      .toBe('DeepSeek · 更强的自主编码、知识与复杂推理能力；适合复杂或质量优先的任务，但成本更高。')
    expect(options[2]?.detail).toBe('External Provider · Provider-authored description.')
    expect(options[1]?.active).toBeUndefined()
  })

  it('keeps built-in descriptions unchanged in English', async () => {
    const b = await bench('en')
    b.mint('s1')
    const options = await b.popup().options(projection('s1'), new AbortController().signal)
    expect(options[0]?.detail)
      .toBe('DeepSeek · Fast, efficient, and economical; suited to focused, routine, or parallel tasks.')
    expect(options[1]?.detail)
      .toBe('DeepSeek · Stronger agentic coding, knowledge, and difficult reasoning; suited to complex or quality-critical tasks at higher cost.')
  })

  it('a seat selection is the current the popup marks active next — one shared state', async () => {
    const b = await bench()
    b.mint('s1')
    const seatFace = b.seat().inject!(sid('s1'))
    // Switch through the SEAT entry.
    expect(await seatFace.select({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    })).toBe(true)
    expect(b.hostCurrent()).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    })
    expect(seatFace.hooks.directory.getSnapshot().current).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
    })
    // The POPUP's next options pass reflects it without a seat-side reload.
    const options = await b.popup().options(projection('s1'), new AbortController().signal)
    expect(options.find((o: SelectOption) => o.label === 'DeepSeek-V4-Pro')).toMatchObject({ active: true })
  })

  it('a popup selection lands on the seat store — the reverse direction of the same state', async () => {
    const b = await bench()
    b.mint('s1')
    const seatFace = b.seat().inject!(sid('s1'))
    const options = await b.popup().options(projection('s1'), new AbortController().signal)
    const pro = options.find((o: SelectOption) => o.label === 'DeepSeek-V4-Pro')!
    await b.popup().onSelect(pro, projection('s1'))
    expect(seatFace.hooks.directory.getSnapshot().current).toEqual({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'high',
    })
  })

  it('both entries share one directory instance per session, isolated across sessions', async () => {
    const b = await bench()
    b.mint('a')
    b.mint('b')
    const faceA = b.seat().inject!(sid('a'))
    const faceA2 = b.seat().inject!(sid('a'))
    const faceB = b.seat().inject!(sid('b'))
    expect(faceA.hooks.directory).toBe(faceA2.hooks.directory)
    expect(faceA.hooks.directory).not.toBe(faceB.hooks.directory)
    expect(faceA).not.toHaveProperty('directory')
    expect(faceA).not.toHaveProperty('useDirectory')
    // The service face resolves the raw source the renderer binds, not a component-owned subscription.
    expect(b.ctx.modelDirectories.directoryFor(sid('a')).store).toBe(faceA.hooks.directory)
    await Promise.all([
      b.popup().options(projection('a'), new AbortController().signal),
      b.popup().options(projection('b'), new AbortController().signal),
    ])
    expect(b.calls.models).toBe(1)
  })

  it('keeps the durable projected selection while the eager catalog reconnects', async () => {
    const b = await bench()
    b.mint('s1')
    const face = b.seat().inject!(sid('s1'))
    await face.select({ provider: 'deepseek-official', model: 'deepseek-v4-pro' })
    b.setHostCurrent({ provider: 'deepseek-official', model: 'deepseek-v4-flash' })

    b.ctx.emit('connection/reset')
    expect(face.hooks.directory.getSnapshot()).toMatchObject({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      status: 'loading', routable: null,
    })
    face.load()
    expect(face.hooks.directory.getSnapshot()).toMatchObject({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      status: 'loading', routable: null,
    })
    await vi.waitFor(() => { expect(face.hooks.directory.getSnapshot().status).toBe('ready') })
  })

  it('applies durable selection changes during catalog refresh without asserting stale routability', async () => {
    const b = await bench()
    b.mint('s1')
    const face = b.seat().inject!(sid('s1'))
    face.load()
    expect(face.hooks.directory.getSnapshot().current?.model).toBe('deepseek-v4-flash')

    b.remote.emit('settings/document-updated', ['llm-deepseek', 1])
    b.setProjected(sid('s1'), {
      lastUsed: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
      next: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
    })
    expect(face.hooks.directory.getSnapshot()).toMatchObject({
      current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
      status: 'loading', routable: null,
    })

    await vi.waitFor(() => {
      expect(face.hooks.directory.getSnapshot()).toMatchObject({
        current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
        status: 'ready',
      })
    })
  })

  it('scope disposal drops the directory; a reborn scope gets a fresh one', async () => {
    const b = await bench()
    const first = b.mint('s1')
    const face1 = b.seat().inject!(sid('s1'))
    await first.fiber.dispose()
    b.mint('s1')
    const face2 = b.seat().inject!(sid('s1'))
    expect(face2.hooks.directory).not.toBe(face1.hooks.directory)
  })

  it('blocks the composer only once the Host reports the route unservable', async () => {
    const b = await bench()
    b.mint('s1')
    const face = b.seat().inject!(sid('s1'))

    // Before the first load nothing is known. `null` is not `false`: a slow
    // or unreachable Host must never lock a working composer.
    expect(b.blockOf('s1')).toBeUndefined()
    face.load()
    await Promise.resolve()
    await Promise.resolve()
    expect(b.blockOf('s1')).toBeUndefined()
    expect(b.calls.models).toBe(1)

    b.setRoutable(false)
    b.remote.emit('settings/document-updated', ['llm-deepseek', 1])
    await Promise.resolve()
    await Promise.resolve()
    expect(b.blockOf('s1')?.reason).toBe(zh['blocked.composer'])
    expect(b.calls.models).toBe(2)

    // Recovering clears it without a reload of the surface.
    b.setRoutable(true)
    b.remote.emit('llm/adapters-updated', [])
    await Promise.resolve()
    await Promise.resolve()
    expect(b.blockOf('s1')).toBeUndefined()
    expect(b.calls.models).toBe(3)
  })

  it('never blocks on catalog membership alone', async () => {
    const b = await bench()
    b.mint('s1')
    const face = b.seat().inject!(sid('s1'))
    // A model the route serves but no longer advertises: the seat prompts for
    // a selection, the composer stays usable. Blocking here would break a
    // supported configuration (a narrowed `models` list over a live route).
    b.setHostCurrent({ provider: 'deepseek-official', model: 'unlisted' })
    face.load()
    await Promise.resolve()
    await Promise.resolve()
    const snapshot = face.hooks.directory.getSnapshot()
    expect(snapshot.groups.flatMap(group => group.models.map(model => model.id))).not.toContain('unlisted')
    expect(b.blockOf('s1')).toBeUndefined()
  })

  it('clears its block when the session scope goes', async () => {
    const b = await bench()
    const scope = b.mint('s1')
    b.setRoutable(false)
    const face = b.seat().inject!(sid('s1'))
    face.load()
    b.remote.emit('llm/adapters-updated', [])
    await vi.waitFor(() => { expect(b.blockOf('s1')).toBeDefined() })

    await scope.fiber.dispose()
    expect(b.blockOf('s1')).toBeUndefined()
  })

  it('an unknown session fails loud at the seat inject', async () => {
    const b = await bench()
    expect(() => b.seat().inject!(sid('ghost'))).toThrow(/resolved no scope/)
  })

  it('withholds both model entries from addressed subagent sessions without Agent-bound RPCs', async () => {
    const b = await bench()
    b.mint('child')
    b.address(sid('child'))

    expect(b.contribution().available(projection('child'))).toBe(false)
    await expect(b.popup().options(
      projection('child'),
      new AbortController().signal,
    )).rejects.toThrow(/unavailable for addressed subagent/)

    const face = b.seat().inject!(sid('child'))
    expect(face.available).toBe(false)
    face.load()
    await expect(face.select({ provider: 'deepseek', model: 'deepseek-v4-pro' })).resolves.toBe(false)
    await expect(b.ctx.modelDirectories.directoryFor(sid('child')).load())
      .rejects.toThrow(/unavailable for addressed subagent/)
    await expect(b.ctx.modelDirectories.directoryFor(sid('child')).select({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
    })).rejects.toThrow(/unavailable for addressed subagent/)
    b.ctx.emit('connection/reset')
    await Promise.resolve()
    expect(b.calls).toEqual({ models: 2, select: 0, auto: 0 })
    await expect(face.selectAuto('balanced')).resolves.toBe(false)
    expect(b.calls.auto).toBe(0)
  })
})

describe('ui-model-selection shared Auto intent', () => {
  it('shares slash and composer Auto modes without predicting a model and keeps other Sessions manual', async () => {
    const b = await bench('en', true)
    b.mint('a')
    b.mint('b')
    const a = b.seat().inject!(sid('a'))
    const other = b.seat().inject!(sid('b'))
    expect(await a.selectAuto('balanced')).toBe(true)
    expect(a.hooks.directory.getSnapshot()).toMatchObject({ current: null, autoRouting: { mode: 'balanced', available: true } })
    let options = await b.popup().options(projection('a'), new AbortController().signal)
    expect(options.filter(option => option.active).map(option => option.label)).toEqual(['Auto · Balance'])
    const efficiency = options.find(option => option.label === 'Auto · Efficiency')
    if (efficiency === undefined) throw new Error('missing Auto option')
    await b.popup().onSelect(efficiency, projection('a'))
    expect(a.hooks.directory.getSnapshot().autoRouting?.mode).toBe('efficiency')
    expect(await a.selectAuto('intelligence')).toBe(true)
    options = await b.popup().options(projection('a'), new AbortController().signal)
    expect(options.filter(option => option.active).map(option => option.label)).toEqual(['Auto · Intelligence'])
    expect(other.hooks.directory.getSnapshot()).toMatchObject({ autoRouting: { mode: 'manual' }, current: { model: 'deepseek-v4-flash' } })
    expect(b.calls.auto).toBe(3)
  })

  it.each([undefined, 'max'])('pins the same used model and actual effort %s through slash selection', async (reasoningEffort) => {
    const b = await bench('en', true)
    b.mint('s1')
    const face = b.seat().inject!(sid('s1'))
    const actual = { provider: 'deepseek-official', model: 'deepseek-v4-flash',
      ...reasoningEffort === undefined ? {} : { reasoningEffort } }
    b.setProjected(sid('s1'), { lastUsed: actual, next: { provider: 'external', model: 'not-used' } })
    b.setRouting(sid('s1'), actualRouting(actual))
    const options = await b.popup().options(projection('s1'), new AbortController().signal)
    const manual = options.find(option => option.label === 'DeepSeek-V4-Flash')
    if (manual === undefined) throw new Error('missing concrete option')
    expect(manual.active).toBeUndefined()
    expect(face.hooks.directory.getSnapshot().current).toEqual(actual)
    await b.popup().onSelect(manual, projection('s1'))
    expect(b.calls.select).toBe(1)
    expect(b.hostCurrent()).toEqual(actual)
    expect(face.hooks.directory.getSnapshot()).toMatchObject({ current: actual, autoRouting: { mode: 'manual' } })
  })

  it('omits unavailable Auto options and rejects a stale option before sending an RPC', async () => {
    const b = await bench('en', true)
    b.mint('s1')
    const face = b.seat().inject!(sid('s1'))
    const initial = await b.popup().options(projection('s1'), new AbortController().signal)
    const stale = initial.find(option => option.label === 'Auto · Balance')
    if (stale === undefined) throw new Error('missing initial Auto option')
    b.setAutoAvailable(false)
    b.remote.emit('settings/document-updated', ['model-routing', 2])
    await vi.waitFor(() => { expect(face.hooks.directory.getSnapshot().autoRouting?.available).toBe(false) })
    const next = await b.popup().options(projection('s1'), new AbortController().signal)
    expect(next.some(option => option.label.startsWith('Auto ·'))).toBe(false)
    await expect(b.popup().onSelect(stale, projection('s1'))).rejects.toThrow('Configure and enable')
    expect(await face.selectAuto('balanced')).toBe(false)
    expect(face.selectionError()).not.toBeNull()
    expect(b.calls.auto).toBe(0)
  })

  it('does not block Auto on a previously used provider that is no longer routable', async () => {
    const b = await bench('en', true)
    b.mint('s1')
    const face = b.seat().inject!(sid('s1'))
    b.setProjected(sid('s1'), { lastUsed: { provider: 'retired', model: 'used' }, next: { provider: 'retired', model: 'not-used' } })
    b.setRouting(sid('s1'), { mode: 'balanced', lastDecision: null })
    expect(face.hooks.directory.getSnapshot()).toMatchObject({ current: { provider: 'retired', model: 'used' }, routable: null })
    expect(b.blockOf('s1')).toBeUndefined()
    b.setAutoAvailable(false)
    b.remote.emit('settings/document-updated', ['model-routing', 3])
    await vi.waitFor(() => { expect(face.hooks.directory.getSnapshot().autoRouting?.available).toBe(false) })
    expect(b.blockOf('s1')).toBeUndefined()
  })

  it('preserves Auto intent and actual-use evidence through catalog reconnect and session scope disposal', async () => {
    const b = await bench('en', true)
    const scope = b.mint('s1')
    const face = b.seat().inject!(sid('s1'))
    const actual = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }
    b.setRouting(sid('s1'), actualRouting(actual))
    b.setHostCurrent({ provider: 'external', model: 'new-default-prediction' })
    b.ctx.emit('connection/reset')
    expect(face.hooks.directory.getSnapshot()).toMatchObject({ current: actual, autoRouting: { mode: 'balanced' } })
    await vi.waitFor(() => { expect(b.calls.models).toBe(2) })
    expect(face.hooks.directory.getSnapshot().current).toEqual(actual)
    const retained = face.hooks.directory.getSnapshot()
    await scope.fiber.dispose()
    b.setRouting(sid('s1'), { mode: 'manual', lastDecision: null })
    expect(face.hooks.directory.getSnapshot()).toBe(retained)
  })
})
