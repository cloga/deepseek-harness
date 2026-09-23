/** Exact Auto model/effort admission through the existing AgentLoop; no additional routing or observation services. */
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { resolveRoutingConfig } from '../src/config.ts'
import ModelRoutingRuntime from '../src/runtime.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

class DriftingAdapter extends LlmAdapter {
  defaultEffort: ReasoningEffortId | undefined = ReasoningEffortId('low')
  supportsLow = true
  retryOnce = false
  continuity: 'new-task' | 'same-task' = 'new-task'
  readonly calls: GenerateOptions[] = []
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider, id: model, name: model, inputModalities: ['text'],
      reasoning: {
        efforts: [
          ...this.supportsLow || model !== 'work' ? [{ id: ReasoningEffortId('low'), name: 'Low' }] : [],
          { id: ReasoningEffortId('high'), name: 'High' },
        ],
        ...this.defaultEffort === undefined ? {} : { defaultEffort: this.defaultEffort },
      },
    }
  }
  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    if (options.purpose === undefined && this.retryOnce) {
      this.retryOnce = false
      this.defaultEffort = ReasoningEffortId('high')
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'fixture retry' } } }
      return
    }
    const text = options.purpose === 'model-routing'
      ? JSON.stringify({ continuity: this.continuity, complexity: 'standard', confidence: 1,
        reasonCode: this.continuity === 'new-task' ? 'new-task' : 'continuation' })
      : 'Fixture response'
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
function latch() {
  return { entered: Promise.withResolvers<undefined>(), release: Promise.withResolvers<undefined>() }
}
async function harness(absentDefault = false, retryOnce = false) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(AgentLoop)
  const adapter = new DriftingAdapter()
  if (absentDefault) adapter.defaultEffort = undefined
  adapter.retryOnce = retryOnce
  ctx.llm.registerAdapter(['fixture'], adapter)
  await ctx.plugin(ModelRoutingRuntime, resolveRoutingConfig({
    enabled: true,
    policy: {
      candidates: [{ id: 'work', selection: { provider: 'fixture', model: 'work' }, quality: 3, relativeCost: 1 }],
      qualityFloors: {
        efficiency: { routine: 1, standard: 2, complex: 3 },
        balanced: { routine: 2, standard: 2, complex: 3 },
        intelligence: { routine: 3, standard: 3, complex: 3 },
      },
      conservativeCandidateId: 'work', minConfidence: 0.8,
    },
    classifier: {
      selection: { provider: 'fixture', model: 'classifier', reasoningEffort: ReasoningEffortId('low') },
      maxInputBytes: 10000, maxOutputTokens: 300, maxOutputBytes: 10000, timeoutMs: 1000,
    },
  }))
  const events: SessionEvent[] = []
  const errors: unknown[] = []
  ctx.on('session/event', (_session, event) => { events.push(event) })
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  ctx.systemPrompt.section({ name: 'selected-route', order: 0, text: 'Selected {{provider}}/{{model}}.' })
  const selection: ModelSelectionRef = {
    current: { provider: 'fixture', model: 'work', reasoningEffort: ReasoningEffortId('high') }, assembled: undefined,
  }
  let pendingLatch: ReturnType<typeof latch> | undefined
  let retries = 0
  const handle = await ctx.agents.create({
    sessionId: SessionId('auto-dispatch-binding'), agentOptions: { provider: 'fixture', model: 'work' },
    setup(agentCtx) {
      installModelSelection(agentCtx, selection)
      agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembled = await next()
        const gate = pendingLatch
        if (gate !== undefined) { gate.entered.resolve(undefined); await gate.release.promise }
        return assembled
      })
      agentCtx.on('agent/request-error', async (_payload, next) => {
        if (retryOnce && retries++ === 0) return { kind: 'retry' }
        return next()
      })
    },
  })
  const agent = handle.agent
  await ctx.modelRouting.enable(agent, 'balanced')
  return {
    ctx, agent, adapter, selection, events, errors,
    gate(value: ReturnType<typeof latch> | undefined) { pendingLatch = value },
    send(text: string, human = true) {
      agent.followup(createUserMessage({ content: [{ type: 'text', text }],
        source: human ? { kind: 'user' } : { kind: 'plugin', plugin: 'fixture-continuation' } }))
      return agent.whenIdle()
    },
    conversations: () => adapter.calls.filter(call => call.purpose === undefined),
    decisions: () => events.flatMap(event => event.type === 'model/routing-decision' ? [event.data] : []),
  }
}

describe('Auto prepared model and effort binding', () => {
  it('pins the first and subsequent new tasks across a default change after assembly', async () => {
    const h = await harness()
    for (const text of ['first task', 'a separate new task']) {
      h.adapter.defaultEffort = ReasoningEffortId('low')
      const gate = latch()
      h.gate(gate)
      const pending = h.send(text)
      try {
        await gate.entered.promise
        h.adapter.defaultEffort = ReasoningEffortId('high')
        gate.release.resolve(undefined)
        await pending
      } finally { gate.release.resolve(undefined); await pending; h.gate(undefined) }
      expect(h.errors).toEqual([])
      expect(h.selection.assembled).toEqual({ provider: 'fixture', model: 'work', reasoningEffort: 'low' })
      expect(h.agent.session.requestHeader()?.config).toMatchObject({ model: 'work', reasoningEffort: 'low' })
      expect(h.agent.session.requestHeader()?.adapterDefaults?.reasoningEffort).not.toBe(true)
    }
    expect(h.conversations().map(call => call.reasoningEffort)).toEqual(['low', 'low'])
    expect(h.decisions().map(decision => decision.selection.reasoningEffort)).toEqual(['low', 'low'])
    expect(new Set(h.decisions().map(decision => decision.taskId)).size).toBe(2)
    for (const request of h.conversations()) {
      const prompt = request.messages.filter(message => message.role === 'system').flatMap(message => message.content)
        .filter(block => block.type === 'text').map(block => block.text).join('\n')
      expect(prompt).toContain('Selected fixture/work.')
    }
    const state = h.ctx.sessionProjections.stateOf(h.agent.session, 'modelRouting')
    if (state?.intent.kind !== 'auto') throw new Error('missing Auto state')
    expect(state.intent.selection.policy.candidates[0]?.selection).not.toHaveProperty('reasoningEffort')
    h.selection.current = { provider: 'fixture', model: 'work' }
    h.agent.session.append('model/selection', h.selection.current)
    await h.send('manual task using current defaults')
    expect(h.conversations().at(-1)?.reasoningEffort).toBe('high')
    expect(h.decisions()).toHaveLength(2)
  })

  it.each(['absent-default', 'unsupported-low'] as const)('refuses %s drift before the first adapter dispatch', async (kind) => {
    const h = await harness(kind === 'absent-default')
    const gate = latch()
    h.gate(gate)
    const pending = h.send('task before model metadata changes')
    try {
      await gate.entered.promise
      h.adapter.defaultEffort = ReasoningEffortId('high')
      if (kind === 'unsupported-low') h.adapter.supportsLow = false
      gate.release.resolve(undefined)
      await pending
    } finally { gate.release.resolve(undefined); await pending; h.gate(undefined) }
    expect(h.conversations()).toEqual([])
    expect(h.decisions()).toEqual([])
    expect(h.errors).toHaveLength(1)
    if (kind === 'absent-default') expect(h.errors[0]).toMatchObject({ message: 'Auto routing selection changed before prepared dispatch' })
    else expect(h.events.findLast(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error', error: { code: 'UNSUPPORTED_REASONING_EFFORT' } } },
    })
  })

  it.each([false, true])('keeps same-step retries on the admitted tuple, absent=%s', async (absent) => {
    const h = await harness(absent, true)
    await h.send('retry without changing the admitted effort')
    expect(h.events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(h.decisions()).toHaveLength(1)
    expect(h.conversations().map(call => call.reasoningEffort)).toEqual(absent ? [undefined] : ['low', 'low'])
    expect(h.errors).toHaveLength(absent ? 1 : 0)
    if (absent) expect(h.errors[0]).toMatchObject({ message: 'Auto routing selection changed before prepared dispatch' })
  })

  it.each([false, true])('keeps refusing repeated same-task default drift, human=%s', async (human) => {
    const h = await harness(true)
    await h.send('initial task without effort')
    expect(h.errors).toEqual([])
    h.adapter.defaultEffort = ReasoningEffortId('high')
    h.adapter.continuity = 'same-task'
    for (const text of ['continue the task', 'continue again after refusal']) {
      await h.send(text, human)
      expect(h.conversations()).toHaveLength(1)
      expect(h.decisions()).toHaveLength(1)
      expect(h.decisions()[0]?.selection).not.toHaveProperty('reasoningEffort')
      expect(h.agent.session.requestHeader()?.config.reasoningEffort).toBe('high')
    }
    expect(h.errors).toHaveLength(2)
    h.adapter.continuity = 'new-task'
    await h.send('a genuinely new task')
    expect(h.conversations().map(call => call.reasoningEffort)).toEqual([undefined, 'high'])
    expect(h.decisions().map(decision => decision.selection.reasoningEffort)).toEqual([undefined, 'high'])
    expect(h.errors).toHaveLength(2)
  })

  it('lets a later manual choice retire the old Auto expectation and audit', async () => {
    const h = await harness(true)
    const gate = latch()
    h.gate(gate)
    const pending = h.send('task before the manual choice')
    try {
      await gate.entered.promise
      h.adapter.defaultEffort = ReasoningEffortId('high')
      h.selection.current = { provider: 'fixture', model: 'work', reasoningEffort: ReasoningEffortId('high') }
      h.agent.session.append('model/selection', h.selection.current)
      gate.release.resolve(undefined)
      await pending
    } finally { gate.release.resolve(undefined); await pending; h.gate(undefined) }
    await h.send('next manual task')
    expect(h.errors).toEqual([])
    expect(h.conversations().map(call => call.reasoningEffort)).toEqual(['high', 'high'])
    expect(h.decisions()).toEqual([])
    expect(h.ctx.sessionProjections.stateOf(h.agent.session, 'modelRouting')?.intent.kind).toBe('manual')
  })
})
