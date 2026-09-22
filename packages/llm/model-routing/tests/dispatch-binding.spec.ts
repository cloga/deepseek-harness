/** Materialized Auto decisions stay exact through real assembly, prepareCall and same-step retries. */
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
import type { LearningWeightRequest } from '../src/learning-provider.ts'
import ModelRoutingRuntime from '../src/runtime.ts'

const roots: Context[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose())) })

class DriftingAdapter extends LlmAdapter {
  defaultEffort: ReasoningEffortId | undefined = ReasoningEffortId('low')
  continuity: 'new-task' | 'same-task' = 'new-task'
  supportsLow = true
  retryOnce = false
  readonly calls: GenerateOptions[] = []

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider, id: model, name: model, inputModalities: ['text'],
      reasoning: {
        efforts: [
          ...this.supportsLow || model !== 'alternative' ? [{ id: ReasoningEffortId('low'), name: 'Low' }] : [],
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
      ? JSON.stringify({
        continuity: this.continuity, complexity: 'standard', confidence: 1,
        reasonCode: this.continuity === 'new-task' ? 'new-task' : 'continuation',
      })
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

async function harness(learning: boolean, retryOnce = false, absentDefault = false) {
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
  adapter.retryOnce = retryOnce
  if (absentDefault) adapter.defaultEffort = undefined
  ctx.llm.registerAdapter(['fixture'], adapter)
  await ctx.plugin(ModelRoutingRuntime, resolveRoutingConfig({
    enabled: true,
    policy: {
      candidates: [
        { id: 'base', selection: { provider: 'fixture', model: 'base', reasoningEffort: ReasoningEffortId('low') },
          quality: 2, relativeCost: learning ? 1 : 2 },
        { id: 'alternative', selection: { provider: 'fixture', model: 'alternative' }, quality: 2, relativeCost: 1.1 },
        { id: 'safe', selection: { provider: 'fixture', model: 'safe', reasoningEffort: ReasoningEffortId('high') },
          quality: 3, relativeCost: 8 },
      ],
      qualityFloors: {
        efficiency: { routine: 1, standard: 2, complex: 3 },
        balanced: { routine: 2, standard: 2, complex: 3 },
        intelligence: { routine: 3, standard: 3, complex: 3 },
      },
      conservativeCandidateId: 'safe', minConfidence: 0.8,
    },
    classifier: {
      selection: { provider: 'fixture', model: 'classifier', reasoningEffort: ReasoningEffortId('low') },
      maxInputBytes: 10000, maxOutputTokens: 300, maxOutputBytes: 10000, timeoutMs: 1000,
    },
  }))
  const evidence: LearningWeightRequest[] = []
  if (learning) {
    ctx.modelRouting.registerLearningWeights({ maxRelativeWeightChange: 0.3, resolve(request) {
      evidence.push(request)
      return {
        versionId: 'verified-low-evidence', basePolicyFingerprint: request.basePolicyFingerprint,
        mode: request.mode, complexity: request.classification.complexity, validUntil: request.now + 10000,
        weights: request.basePolicy.candidates.map(candidate => ({
          candidateId: candidate.id, relativeCost: candidate.id === 'alternative' ? 0.9 : candidate.relativeCost,
        })),
      }
    } })
  }
  const events: SessionEvent[] = []
  const errors: unknown[] = []
  ctx.on('session/event', (_session, event) => { events.push(event) })
  ctx.on('agent/error', ({ error }) => { errors.push(error) })
  ctx.systemPrompt.section({ name: 'exact-route', order: 0, text: 'Selected {{provider}}/{{model}}.' })
  const selection: ModelSelectionRef = { current: { provider: 'fixture', model: 'safe' }, assembled: undefined }
  let pendingLatch: ReturnType<typeof latch> | undefined
  let retries = 0
  const handle = await ctx.agents.create({
    sessionId: SessionId('auto-dispatch-binding'),
    agentOptions: { provider: 'fixture', model: 'safe' },
    setup(agentCtx) {
      installModelSelection(agentCtx, selection)
      agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
        const assembled = await next()
        const gate = pendingLatch
        if (gate !== undefined) {
          gate.entered.resolve(undefined)
          await gate.release.promise
        }
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
    ctx, agent, adapter, selection, evidence, events, errors,
    gate(value: ReturnType<typeof latch> | undefined) { pendingLatch = value },
    send(text: string, human = true) {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }], source: human ? { kind: 'user' } : { kind: 'plugin', plugin: 'fixture-continuation' },
      }))
      return agent.whenIdle()
    },
    conversations: () => adapter.calls.filter(call => call.purpose === undefined),
    decisions: () => events.flatMap(event => event.type === 'model/routing-decision' ? [event.data] : []),
  }
}

function observedEffort(request: LearningWeightRequest | undefined) {
  return request?.eligibleCandidates.find(candidate => candidate.candidateId === 'alternative')?.selection.reasoningEffort
}

function expectPromptRoute(request: GenerateOptions): void {
  const prompt = request.messages.filter(message => message.role === 'system').flatMap(message => message.content)
    .filter(block => block.type === 'text').map(block => block.text).join('\n')
  expect(prompt).toContain(`Selected fixture/${request.model}.`)
}

describe('Auto dispatch materialized effort binding', () => {
  it('rejects a newly introduced default when the first admission explicitly materialized no effort', async () => {
    const h = await harness(true, false, true)
    const gate = latch()
    h.gate(gate)
    const pending = h.send('task admitted without a default effort')
    try {
      await gate.entered.promise
      expect(h.evidence[0]?.eligibleCandidates.find(candidate => candidate.candidateId === 'alternative')?.selection)
        .toEqual({ provider: 'fixture', model: 'alternative' })
      h.adapter.defaultEffort = ReasoningEffortId('high')
      gate.release.resolve(undefined)
      await pending
    } finally {
      gate.release.resolve(undefined)
      await pending
      h.gate(undefined)
    }
    expect(h.conversations()).toEqual([])
    expect(h.decisions()).toEqual([])
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toMatchObject({ message: 'Auto routing selection changed before prepared dispatch' })
  })

  it('retains absent-effort admission after the first decision is consumed so a retry cannot redefault', async () => {
    const h = await harness(true, true, true)
    await h.send('retry must not introduce a default effort')
    expect(h.evidence).toHaveLength(1)
    expect(observedEffort(h.evidence[0])).toBeUndefined()
    expect(h.conversations()).toHaveLength(1)
    expect(h.conversations()[0]).not.toHaveProperty('reasoningEffort')
    expect(h.decisions()).toHaveLength(1)
    expect(h.decisions()[0]?.selection).not.toHaveProperty('reasoningEffort')
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toMatchObject({ message: 'Auto routing selection changed before prepared dispatch' })
    expect(h.events.filter(event => event.type === 'step/start')).toHaveLength(1)
  })

  it.each([false, true])('preserves an active absent-effort binding on a continuation, human=%s', async (human) => {
    const h = await harness(true, false, true)
    await h.send('initial task without effort')
    expect(h.errors).toEqual([])
    h.adapter.defaultEffort = ReasoningEffortId('high')
    h.adapter.continuity = 'same-task'
    await h.send('continue the current task', human)
    expect(h.evidence).toHaveLength(1)
    expect(h.conversations()).toHaveLength(1)
    expect(h.decisions()).toHaveLength(1)
    expect(h.decisions()[0]?.selection).not.toHaveProperty('reasoningEffort')
    expect(h.errors).toHaveLength(1)
    expect(h.errors[0]).toMatchObject({ message: 'Auto routing selection changed before prepared dispatch' })
    // The rejected request already logged a prepared high-effort header. It is not actual-use authority.
    expect(h.agent.session.requestHeader()?.config.reasoningEffort).toBe('high')
    await h.send('continue the same task again after the refusal', human)
    expect(h.evidence).toHaveLength(1)
    expect(h.conversations()).toHaveLength(1)
    expect(h.decisions()).toHaveLength(1)
    expect(h.decisions()[0]?.selection).not.toHaveProperty('reasoningEffort')
    expect(h.errors).toHaveLength(2)
    expect(h.errors[1]).toMatchObject({ message: 'Auto routing selection changed before prepared dispatch' })
    // A genuine new task may capture the new default; the failed turn's expectation must not survive.
    h.adapter.continuity = 'new-task'
    await h.send('a distinct task admitted under the new default')
    expect(h.conversations().map(call => call.reasoningEffort)).toEqual([undefined, 'high'])
    expect(h.decisions().map(decision => decision.selection.reasoningEffort)).toEqual([undefined, 'high'])
    expect(observedEffort(h.evidence.at(-1))).toBe('high')
    expect(h.errors).toHaveLength(2)
  })

  it('retires a prepared Auto expectation when the user chooses manual during assembly', async () => {
    const h = await harness(true, false, true)
    const gate = latch()
    h.gate(gate)
    const pending = h.send('task before the manual choice')
    try {
      await gate.entered.promise
      h.adapter.defaultEffort = ReasoningEffortId('high')
      h.selection.current = { provider: 'fixture', model: 'alternative', reasoningEffort: ReasoningEffortId('high') }
      h.agent.session.append('model/selection', h.selection.current)
      gate.release.resolve(undefined)
      await pending
    } finally {
      gate.release.resolve(undefined)
      await pending
      h.gate(undefined)
    }
    await h.send('next manual task')
    expect(h.errors).toEqual([])
    expect(h.conversations().map(call => call.reasoningEffort)).toEqual(['high', 'high'])
    expect(h.decisions()).toEqual([])
    expect(h.evidence).toHaveLength(1)
    expect(h.ctx.sessionProjections.stateOf(h.agent.session, 'modelRouting')?.intent.kind).toBe('manual')
  })

  it.each([false, true])('pins first and subsequent new tasks across post-lookup default drift, learning=%s', async (learning) => {
    const h = await harness(learning)
    for (const text of ['first task', 'a separate new task']) {
      h.adapter.defaultEffort = ReasoningEffortId('low')
      const gate = latch()
      h.gate(gate)
      const pending = h.send(text)
      try {
        await gate.entered.promise
        if (learning) expect(observedEffort(h.evidence.at(-1))).toBe('low')
        h.adapter.defaultEffort = ReasoningEffortId('high')
        gate.release.resolve(undefined)
        await pending
      } finally {
        gate.release.resolve(undefined)
        await pending
        h.gate(undefined)
      }
      expect(h.errors).toEqual([])
      expect(h.selection.assembled).toEqual({ provider: 'fixture', model: 'alternative', reasoningEffort: 'low' })
      expect(h.agent.session.requestHeader()?.config).toMatchObject({ model: 'alternative', reasoningEffort: 'low' })
      expect(h.agent.session.requestHeader()?.adapterDefaults?.reasoningEffort).not.toBe(true)
    }
    expect(h.conversations().map(call => call.reasoningEffort)).toEqual(['low', 'low'])
    expect(h.decisions().map(decision => decision.selection.reasoningEffort)).toEqual(['low', 'low'])
    expect(new Set(h.decisions().map(decision => decision.taskId)).size).toBe(2)
    expect(h.evidence).toHaveLength(learning ? 2 : 0)
    const state = h.ctx.sessionProjections.stateOf(h.agent.session, 'modelRouting')
    if (state?.intent.kind !== 'auto') throw new Error('missing Auto state')
    expect(state.intent.selection.policy.candidates.find(candidate => candidate.id === 'alternative')?.selection)
      .not.toHaveProperty('reasoningEffort')
    for (const request of h.conversations()) expectPromptRoute(request)

    // An explicit return to manual still restores the provider's current default.
    h.selection.current = { provider: 'fixture', model: 'alternative' }
    h.agent.session.append('model/selection', h.selection.current)
    await h.send('manual task using the provider default')
    expect(h.conversations().at(-1)?.reasoningEffort).toBe('high')
    expect(h.decisions()).toHaveLength(2)
    expect(h.evidence).toHaveLength(learning ? 2 : 0)
  })

  it('fails before first conversation dispatch if the evidenced effort loses support after lookup', async () => {
    const h = await harness(true)
    const gate = latch()
    h.gate(gate)
    const pending = h.send('task whose low effort becomes unavailable')
    try {
      await gate.entered.promise
      expect(observedEffort(h.evidence[0])).toBe('low')
      h.adapter.defaultEffort = ReasoningEffortId('high')
      h.adapter.supportsLow = false
      gate.release.resolve(undefined)
      await pending
    } finally {
      gate.release.resolve(undefined)
      await pending
      h.gate(undefined)
    }
    expect(h.conversations()).toEqual([])
    expect(h.decisions()).toEqual([])
    expect(h.errors).toHaveLength(1)
    expect(h.events.findLast(event => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'error', error: { code: 'UNSUPPORTED_REASONING_EFFORT' } } },
    })
    expect(h.agent.session.requestHeader()).toBeUndefined()
  })

  it('keeps every real same-step retry on the evidenced effort despite a changed default', async () => {
    const h = await harness(true, true)
    await h.send('retry one transient failure without changing the selected effort')
    expect(h.errors).toEqual([])
    expect(observedEffort(h.evidence[0])).toBe('low')
    expect(h.evidence).toHaveLength(1)
    expect(h.adapter.defaultEffort).toBe('high')
    expect(h.conversations().map(call => [call.model, call.reasoningEffort])).toEqual([
      ['alternative', 'low'], ['alternative', 'low'],
    ])
    expect(h.events.filter(event => event.type === 'step/start')).toHaveLength(1)
    expect(h.events.filter(event => event.type === 'assistant/attempt')).toHaveLength(1)
    expect(h.decisions()).toHaveLength(1)
    expect(h.decisions()[0]?.selection).toEqual({ provider: 'fixture', model: 'alternative', reasoningEffort: 'low' })
    expect(h.agent.session.requestHeader()?.config).toMatchObject({ model: 'alternative', reasoningEffort: 'low' })
    for (const request of h.conversations()) expectPromptRoute(request)
  })
})
