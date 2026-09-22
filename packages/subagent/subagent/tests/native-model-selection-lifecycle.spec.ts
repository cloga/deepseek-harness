import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { LlmAdapter, ReasoningEffortId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import ModelRoutingRuntime from '@deepseek-ai/dsh-model-routing'
import type { AutoSelection } from '@deepseek-ai/dsh-model-routing'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import * as Spawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as Fork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { queueHostSubagentPrompt } from '@deepseek-ai/dsh-subagent/internal'
import SubagentRuntime, { foldSubagentDescriptor, recordSubagentModelSelection } from '../src/index.ts'
import type { SubagentModelRule } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { loadStoredSession } from './persistence-helpers.ts'
import { autoSelection, ALL_ALLOWED, nativeModelInfo } from './native-model-selection-fixtures.ts'
import { continuationActivations } from './continuation-internals.ts'

const contexts: Context[] = []
const directories: string[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  for (const root of directories.splice(0)) rmSync(root, { recursive: true, force: true })
})

async function* text(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

async function setup(options: {
  rules?: SubagentModelRule[]
  selection?: AutoSelection
  metadata?: typeof nativeModelInfo
  consent?: boolean
} = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  const root = mkdtempSync(join(tmpdir(), 'native-auto-selection-'))
  directories.push(root)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime, { modelRules: options.rules ?? [] })
  await ctx.plugin(Spawn, { providerName: 'native-spawn-alias' })
  await ctx.plugin(Fork, { providerName: 'native-fork-alias' })
  const selection = options.selection ?? autoSelection()
  const classifierHook = { before: async (_options: GenerateOptions) => {} }
  const seen: GenerateOptions[] = []
  ctx.llm.registerAdapter(['models'], new class extends LlmAdapter {
    override resolveModel(provider: string, model: string) {
      return Promise.resolve((options.metadata ?? nativeModelInfo)(provider, model))
    }
    override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      seen.push(options)
      if (options.purpose === 'model-routing') {
        await classifierHook.before(options)
        yield* text(JSON.stringify({ continuity: 'new-task', complexity: 'routine', confidence: 0.9, reasonCode: 'new-task' }))
      } else yield* text('child completed')
    }
  }())
  await ctx.plugin(ModelRoutingRuntime, { enabled: true, policy: selection.policy, classifier: selection.classifier })
  const parent = await ctx.agentLoop.create(SessionId('native-auto-parent'), {
    provider: 'models', model: 'strong', reasoningEffort: ReasoningEffortId('high'), maxTokens: 128,
  })
  if (options.consent !== false) recordSubagentModelSelection(ctx.sessionProjections, parent.session, ALL_ALLOWED)
  await ctx.modelRouting.enable(parent, 'balanced')
  const events = new Map<string, SessionEvent[]>()
  ctx.on('session/event', (session, event) => {
    const list = events.get(session.id) ?? []
    list.push(event)
    events.set(session.id, list)
  })
  const created: Agent[] = []
  ctx.on('agent/created', ({ agent }) => { if (agent !== parent) created.push(agent) })
  const request = (from = parent) => ({
    parent: from, prompt: [{ type: 'text' as const, text: 'isolated child task' }], signal: new AbortController().signal,
  })
  const start = (from = parent) => ctx.subagents.start('native-spawn-alias', request(from))
  const startContinuable = (from = parent) => ctx.subagents.startContinuable({
    provider: 'native-spawn-alias', label: 'isolated child', request: request(from), signal: new AbortController().signal,
  })
  return { ctx, root, parent, events, seen, created, classifierHook, start, startContinuable, request }
}

function classifierCount(seen: readonly GenerateOptions[]): number {
  return seen.filter(request => request.purpose === 'model-routing').length
}

async function waitUnloaded(ctx: Context, id: SessionId): Promise<void> {
  await vi.waitFor(() => { expect(ctx.agents.get(id)).toBeUndefined() }, { timeout: 15_000 })
}

describe('native Auto creation and fixed resume', () => {
  it('refuses a provider that withdraws continuation preparation during model preflight', async () => {
    const h = await setup()
    const provider = h.ctx.subagents.getProvider('native-spawn-alias')
    if (provider === undefined) throw new Error('fixture native provider missing')
    h.classifierHook.before = async () => {
      Object.defineProperty(provider, 'prepareContinuable', { value: undefined, configurable: true })
    }
    await expect(h.startContinuable()).rejects.toThrow('does not support continuable children')
    expect(h.created).toHaveLength(0)
    expect(h.ctx.agents.list()).toEqual([h.parent])
    expect(h.seen.every(request => request.purpose === 'model-routing')).toBe(true)
  })

  it('writes child-local resolved evidence before its actual first request without changing the parent route', async () => {
    const h = await setup()
    const run = await h.start()
    try {
      await run.result
      const child = run.localAgent
      if (child === undefined) throw new Error('native child missing')
      expect(child.options).toMatchObject({ provider: 'models', model: 'cheap', reasoningEffort: 'low', maxTokens: 128 })
      expect(child.session.requestHeader()?.config).toMatchObject({ provider: 'models', model: 'cheap', reasoningEffort: 'low' })
      // Closing the owned run joins its persistence writer before comparing the complete durable log.
      await run.dispose()
      const loaded = await loadStoredSession(h.ctx.sessionPersistence, child.id)
      const records = loaded.events
      const selection = records.find(event => event.type === 'subagent/model-selection')
      expect(selection).toMatchObject({ data: { source: 'auto', provider: 'models', model: 'cheap', reasoningEffort: 'low', candidateId: 'cheap' } })
      expect(records.findIndex(event => event.type === 'subagent/model-selection'))
        .toBeLessThan(records.findIndex(event => event.type === 'request/header'))
      expect(records.filter(event => event.type === 'model/delegation-auto')).toHaveLength(1)
      expect(h.ctx.sessionProjections.stateOf(child.session, 'subagentModelSelectionPolicy')).toEqual(ALL_ALLOWED)
      expect(h.ctx.sessionProjections.stateOf(child.session, 'modelRouting')?.intent.kind).toBe('manual')
      expect(h.parent.options.model).toBe('strong')
      expect(h.parent.session.requestHeader()).toBeUndefined()
      expect(foldSubagentDescriptor(records)).toMatchObject({ mode: 'one-shot' })
      expect(foldSubagentDescriptor(records)).not.toHaveProperty('agentModel')
      expect(classifierCount(h.seen)).toBe(1)
      const classifier = h.seen.find(request => request.purpose === 'model-routing')
      expect(classifier?.sessionId).toBe(h.parent.id)
    } finally { await run.dispose() }
  })

  it('persists the chosen continuation descriptor and resumes without recapturing Auto or parent options', async () => {
    const h = await setup()
    const started = await h.startContinuable()
    await waitUnloaded(h.ctx, started.childId)
    const loaded = await loadStoredSession(h.ctx.sessionPersistence, started.childId)
    expect(foldSubagentDescriptor(loaded.events)).toMatchObject({
      mode: 'continuable', agentProvider: 'models', agentModel: 'cheap', agentReasoningEffort: 'low',
    })
    expect(loaded.events.filter(event => event.type === 'subagent/model-selection')).toHaveLength(1)
    h.parent.session.append('model/selection', { provider: 'models', model: 'strong', reasoningEffort: ReasoningEffortId('high') })
    h.parent.session.append('request/header', { reason: 'change', header: { config: { provider: 'models', model: 'strong', reasoningEffort: ReasoningEffortId('high') } } })
    h.classifierHook.before = async () => { throw new Error('resume must not classify') }
    await queueHostSubagentPrompt(h.ctx.subagents, h.parent, started.childId, [{ type: 'text', text: 'continue fixed child' }],
      { kind: 'user' }, new AbortController().signal)
    await waitUnloaded(h.ctx, started.childId)
    const resumed = await loadStoredSession(h.ctx.sessionPersistence, started.childId)
    expect(resumed.events.filter(event => event.type === 'subagent/model-selection')).toHaveLength(1)
    expect(classifierCount(h.seen)).toBe(1)
    expect(h.seen.filter(request => request.sessionId === started.childId).every(request => request.model === 'cheap' && request.reasoningEffort === 'low'))
      .toBe(true)
  })

  it('captures a separate delegation preference for grandchildren while the child itself stays fixed', async () => {
    const h = await setup()
    const run = await h.start()
    try {
      await run.result
      const child = run.localAgent
      if (child === undefined) throw new Error('child missing')
      expect(h.ctx.modelRouting.captureDelegation(child)?.parentSessionId).toBe(child.id)
      const grandchild = await h.start(child)
      try {
        await grandchild.result
        expect(grandchild.localAgent?.session.header.parentSession).toBe(child.id)
        expect(classifierCount(h.seen)).toBe(2)
        expect(h.seen.filter(request => request.purpose === 'model-routing').map(request => request.sessionId)).toEqual([h.parent.id, child.id])
        expect(h.ctx.sessionProjections.stateOf(child.session, 'modelRouting')?.intent.kind).toBe('manual')
        expect(grandchild.localAgent?.options.model).toBe('cheap')
      } finally { await grandchild.dispose() }
    } finally { await run.dispose() }
  })

  it.each(['parent-rule', 'request', 'denied', 'fork'] as const)(
    'keeps a %s child fixed but passes preference separately to its authorized fresh grandchild', async (source) => {
      const h = await setup(source === 'parent-rule'
        ? { rules: [{ parent: { provider: 'models', model: 'strong' }, child: { provider: 'models', model: 'rule' } }] }
        : {})
      if (source === 'fork') {
        h.parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent context' }], source: { kind: 'user' } }))
        await h.parent.whenIdle()
      }
      const run = await h.ctx.subagents.start(source === 'fork' ? 'native-fork-alias' : 'native-spawn-alias', {
        ...h.request(),
        ...source === 'request' ? { agentOptions: { model: 'explicit-child' } } : {},
        ...source === 'denied' ? { disableAutoModelSelection: true as const } : {},
      })
      try {
        await run.result
        const child = run.localAgent
        if (child === undefined) throw new Error('child missing')
        const expectedModel = source === 'parent-rule' ? 'rule' : source === 'request' ? 'explicit-child' : 'strong'
        expect(child.session.requestHeader()?.config.model).toBe(expectedModel)
        expect(h.ctx.sessionProjections.stateOf(child.session, 'modelRouting')?.intent.kind).toBe('manual')
        expect(h.ctx.modelRouting.captureDelegation(child)?.selection.mode).toBe('balanced')
        expect(h.ctx.sessionProjections.stateOf(child.session, 'subagentModelSelectionPolicy')).toEqual(ALL_ALLOWED)
        expect(classifierCount(h.seen)).toBe(0)
        const grandchild = await h.start(child)
        try {
          await grandchild.result
          expect(grandchild.localAgent?.session.requestHeader()?.config.model).toBe('cheap')
          expect(child.session.requestHeader()?.config.model).toBe(expectedModel)
          expect(h.seen.filter(request => request.purpose === 'model-routing').map(request => request.sessionId)).toEqual([child.id])
        } finally { await grandchild.dispose() }
      } finally { await run.dispose() }
    },
  )

  it('propagates preference without granting missing child-selection permission', async () => {
    const h = await setup({ consent: false })
    const run = await h.start()
    try {
      await run.result
      const child = run.localAgent
      if (child === undefined) throw new Error('child missing')
      expect(child.options.model).toBe('strong')
      expect(h.ctx.modelRouting.captureDelegation(child)?.selection.mode).toBe('balanced')
      expect(h.ctx.sessionProjections.stateOf(child.session, 'subagentModelSelectionPolicy')).toBeNull()
      const grandchild = await h.start(child)
      try {
        await grandchild.result
        expect(grandchild.localAgent?.options.model).toBe('strong')
        expect(classifierCount(h.seen)).toBe(0)
      } finally { await grandchild.dispose() }
    } finally { await run.dispose() }
  })

  it('does not re-inherit parent effort when Auto selects omitted effort on the SAME provider/model', async () => {
    const selection = autoSelection()
    const h = await setup({
      selection: { ...selection, policy: { ...selection.policy, candidates: selection.policy.candidates.map(candidate =>
        candidate.id === 'cheap' ? { ...candidate, selection: { provider: 'models', model: 'strong' } } : candidate) } },
      metadata: (provider, model) => {
        const result = nativeModelInfo(provider, model)
        if (model === 'strong' && result.reasoning !== undefined) delete result.reasoning.defaultEffort
        return result
      },
    })
    const run = await h.start()
    try {
      await run.result
      expect(h.parent.options.reasoningEffort).toBe('high')
      expect(run.localAgent?.options).toMatchObject({ provider: 'models', model: 'strong' })
      expect(run.localAgent?.options).not.toHaveProperty('reasoningEffort')
      expect(run.localAgent?.session.requestHeader()?.config).not.toHaveProperty('reasoningEffort')
      await run.dispose()
      const stored = await loadStoredSession(h.ctx.sessionPersistence, run.id)
      const selected = stored.events.find(event => event.type === 'subagent/model-selection')
      expect(selected).toMatchObject({ data: { source: 'auto', provider: 'models', model: 'strong', candidateId: 'cheap' } })
      expect(selected?.data).not.toHaveProperty('reasoningEffort')
    } finally { await run.dispose() }
  })

  it('uses the actual direct child route for a grandchild rule rather than the original root route', async () => {
    const h = await setup({ rules: [{ parent: { provider: 'models', model: 'cheap' }, child: { provider: 'models', model: 'rule' } }] })
    const childRun = await h.start()
    try {
      await childRun.result
      const child = childRun.localAgent
      if (child === undefined) throw new Error('child missing')
      const grandchild = await h.start(child)
      try {
        await grandchild.result
        expect(h.parent.options.model).toBe('strong')
        expect(child.session.requestHeader()?.config.model).toBe('cheap')
        expect(grandchild.localAgent?.options.model).toBe('rule')
        expect(classifierCount(h.seen)).toBe(1)
        const createdGrandchild = grandchild.localAgent
        if (createdGrandchild === undefined) throw new Error('grandchild missing')
        expect(h.ctx.modelRouting.captureDelegation(createdGrandchild)?.selection.mode).toBe('balanced')
      } finally { await grandchild.dispose() }
    } finally { await childRun.dispose() }
  })

  it('keeps native forks on the direct parent route without a classifier call', async () => {
    const h = await setup()
    h.parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent context' }], source: { kind: 'user' } }))
    await h.parent.whenIdle()
    const before = classifierCount(h.seen)
    const run = await h.ctx.subagents.start('native-fork-alias', h.request())
    try {
      await run.result
      expect(run.localAgent?.options).toMatchObject({ provider: 'models', model: 'strong', reasoningEffort: 'high' })
      expect(classifierCount(h.seen)).toBe(before)
      await run.dispose()
      const loaded = await loadStoredSession(h.ctx.sessionPersistence, run.id)
      expect(loaded.events.find(event => event.type === 'subagent/model-selection')).toMatchObject({ data: { source: 'inheritance' } })
    } finally { await run.dispose() }
  })

  it('validates a malformed continuation composition before paid classification or child publication', async () => {
    const h = await setup()
    const before = h.created.length
    await expect(h.ctx.subagents.startContinuable({
      provider: 'native-spawn-alias', label: 'invalid',
      request: { ...h.request(), persona: (() => 'not JSON') as unknown as string }, signal: new AbortController().signal,
    })).rejects.toThrow('losslessly JSON')
    expect(classifierCount(h.seen)).toBe(0)
    expect(h.created).toHaveLength(before)
  })

  it('holds a continuable parent ownership reservation while its child is being classified', async () => {
    const h = await setup()
    const parentStarted = await h.startContinuable()
    await waitUnloaded(h.ctx, parentStarted.childId)
    const resumed = Promise.withResolvers<Agent>()
    const gate = Promise.withResolvers<undefined>()
    h.ctx.on('agent/pre-step', async ({ agent }, next) => {
      if (agent.id === parentStarted.childId) { resumed.resolve(agent); await gate.promise }
      return next()
    })
    await queueHostSubagentPrompt(h.ctx.subagents, h.parent, parentStarted.childId,
      [{ type: 'text', text: 'resume and delegate' }], { kind: 'user' }, new AbortController().signal)
    const directParent = await resumed.promise
    const classifierEntered = Promise.withResolvers<undefined>()
    const classifierRelease = Promise.withResolvers<undefined>()
    h.classifierHook.before = async () => { classifierEntered.resolve(undefined); await classifierRelease.promise }
    const starting = h.startContinuable(directParent)
    try {
      await classifierEntered.promise
      const activation = continuationActivations(h.ctx).get(directParent.id)
      expect(activation?.ownedChildren.size).toBe(1)
      gate.resolve(undefined)
      await directParent.whenIdle()
      expect(h.ctx.agents.get(directParent.id)).toBe(directParent)
      classifierRelease.resolve(undefined)
      const grandchild = await starting
      await waitUnloaded(h.ctx, grandchild.childId)
      await waitUnloaded(h.ctx, directParent.id)
    } finally {
      gate.resolve(undefined)
      classifierRelease.resolve(undefined)
      await starting.catch(() => {})
    }
  })
})
