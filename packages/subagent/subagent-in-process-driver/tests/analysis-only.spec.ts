/** Negative execution regressions for the closed native analysis policy; no external model calls. */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ReasoningEffortId, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SubagentRuntime, { recordSubagentModelSelection, snapshotSubagentDescriptor } from '@deepseek-ai/dsh-subagent'
import type { ContinuableStartSpec, NativeAnalysisPolicy, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { autoSelection } from '../../subagent/tests/native-model-selection-fixtures.ts'
import { startInProcessRun } from '../src/index.ts'
import { attachAnalysisOnly } from '../src/analysis-only.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })
const POLICY: NativeAnalysisPolicy = { kind: 'analysis-only', maxModelCalls: 2, maxOutputBytes: 32_000 }

async function setup(script: ConstructorParameters<typeof MockAdapter>[0], mode: 'native' | 'ptc' = 'native', reasoning = true) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode } })
  const ptcRun = vi.fn(async () => ({ logs: [] }))
  if (mode === 'ptc') ctx.provide('ptcRuntime', {
    language: 'typescript', isolation: 'test',
    resolve: (request: object) => request, run: ptcRun,
  } as never)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(SubagentRuntime, { modelRules: [
    { parent: { provider: 'mock', model: 'parent' }, child: { provider: 'mock', model: 'forbidden' } },
  ] })
  const adapter = new MockAdapter(script, reasoning ? {
    efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }],
    defaultEffort: ReasoningEffortId('low'),
  } : undefined)
  ctx.llm.registerAdapter(['mock'], adapter)
  ctx.subagents.registerProvider({
    name: 'analysis-spawn', nativeModelSelection: 'spawn', inheritsParentContext: false,
    capabilities: { agentOptions: true, outputSchema: true, depthLimit: true, toolFilter: true, persona: true },
    start: request => startInProcessRun(request, {}),
    prepareContinuable: () => Promise.resolve({}),
  })
  const parent = await ctx.agentLoop.create(SessionId('analysis-parent'), {
    provider: 'mock', model: 'parent', reasoningEffort: ReasoningEffortId('high'),
  })
  recordSubagentModelSelection(ctx.sessionProjections, parent.session, [{ provider: 'mock', model: 'reviewer' }, { provider: 'mock', model: 'parent' }])
  const request = (extra: Partial<SubagentStartRequest> = {}): SubagentStartRequest => ({
    parent, prompt: [{ type: 'text', text: 'Only this immutable evidence is supplied.' }],
    signal: new AbortController().signal,
    agentOptions: { provider: 'mock', model: 'reviewer', reasoningEffort: ReasoningEffortId('low'), maxTokens: 128 },
    analysisPolicy: POLICY, ...extra,
  })
  const start = (extra: Partial<SubagentStartRequest> = {}) => ctx.subagents.start('analysis-spawn', request(extra))
  return { ctx, parent, adapter, ptcRun, request, start }
}

describe('native analysis-only admission', () => {
  it.each([0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])('rejects invalid limits %s before allocating or invoking a model', async (limit) => {
    const h = await setup([])
    for (const field of ['maxModelCalls', 'maxOutputBytes'] as const) {
      await expect(h.start({ analysisPolicy: { ...POLICY, [field]: limit } })).rejects.toThrow('positive safe-integer')
    }
    await expect(h.start({ agentOptions: { provider: 'mock', model: 'reviewer', maxTokens: limit } })).rejects.toThrow('positive maxTokens')
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.ctx.agents.list()).toEqual([h.parent])
  })

  it('refuses an omitted output cap and incomplete setup without allocating or invoking a model', async () => {
    const h = await setup([])
    await expect(h.start({ agentOptions: { provider: 'mock', model: 'reviewer' } })).rejects.toThrow('explicit positive maxTokens')
    expect(() => { attachAnalysisOnly(h.parent.ctx, h.parent, POLICY, { provider: 'mock' }) })
      .toThrow('complete preflighted route and token cap')
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.ctx.agents.list()).toEqual([h.parent])
  })

  it('keeps effort omitted for a model with no reasoning controls', async () => {
    const h = await setup([textResponse('plain model finding')], 'native', false)
    const run = await h.start({ agentOptions: { provider: 'mock', model: 'reviewer', maxTokens: 128 } })
    try {
      expect((await run.result).stopReason).toBe('completed')
      expect(h.adapter.requests).toHaveLength(1)
      expect(h.adapter.requests[0]).not.toHaveProperty('reasoningEffort')
      expect(h.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'reviewer', maxTokens: 128 })
    } finally { await run.dispose() }
  })

  it('refuses absent/unauthorized explicit routes without applying a wider parent rule', async () => {
    const h = await setup([])
    await expect(h.start({ agentOptions: { maxTokens: 128 } })).rejects.toThrow('explicit fixed')
    await expect(h.start({ agentOptions: { provider: 'mock', model: 'forbidden', maxTokens: 128 } })).rejects.toThrow('captured parent policy')
    const other = await h.ctx.agentLoop.create(SessionId('no-analysis-permission'), { provider: 'mock', model: 'parent' })
    await expect(h.start({ parent: other })).rejects.toThrow('captured parent policy')
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.ctx.agents.list()).toHaveLength(2)
  })

  it('refuses unsupported effort in exact live preflight rather than inheriting or downgrading', async () => {
    const h = await setup([])
    await expect(h.start({ agentOptions: { provider: 'mock', model: 'reviewer', reasoningEffort: ReasoningEffortId('invented'), maxTokens: 128 } }))
      .rejects.toThrow('does not support reasoning effort')
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.ctx.agents.list()).toEqual([h.parent])
  })

  it('does not re-inherit effort when the complete analysis route equals the parent route', async () => {
    const h = await setup([textResponse('independent answer')])
    const run = await h.start({ agentOptions: { provider: 'mock', model: 'parent', maxTokens: 64 } })
    try {
      expect((await run.result).stopReason).toBe('completed')
      expect(h.adapter.requests[0]).toMatchObject({ provider: 'mock', model: 'parent', reasoningEffort: 'low', maxTokens: 64 })
      expect(h.parent.options.reasoningEffort).toBe('high')
    } finally { await run.dispose() }
  })

  it('refuses permission Auto before child allocation or model use, without rejecting model-selection Auto', async () => {
    const h = await setup([textResponse('independent answer')])
    // The permission service answer is the admission input; no experimental reviewer is installed.
    let permission = 'auto'
    h.ctx.provide('permissionPresets', { current: () => permission })
    await expect(h.start()).rejects.toThrow('Auto permission preset')
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.ctx.agents.list()).toEqual([h.parent])
    permission = 'danger-full-access'
    h.parent.session.append('model/auto-selection', autoSelection())
    const run = await h.start()
    try {
      expect((await run.result).stopReason).toBe('completed')
      expect(h.adapter.requests).toHaveLength(1)
      expect(h.adapter.requests[0]).toMatchObject({ model: 'reviewer', reasoningEffort: 'low' })
    } finally { await run.dispose() }
  })

  it('rejects structured output, external/fork providers, continuable starts and seeded driver escape', async () => {
    const h = await setup([])
    await expect(h.start({ outputSchema: { type: 'object', properties: {} } })).rejects.toThrow('structured-output')
    const spawn = h.ctx.subagents.getProvider('analysis-spawn')
    if (spawn === undefined) throw new Error('fixture provider missing')
    h.ctx.subagents.registerProvider({ ...spawn, name: 'analysis-fork', nativeModelSelection: 'fork', inheritsParentContext: true })
    const { nativeModelSelection: _native, ...external } = spawn
    h.ctx.subagents.registerProvider({ ...external, name: 'analysis-external' })
    for (const provider of ['analysis-fork', 'analysis-external']) {
      await expect(h.ctx.subagents.start(provider, h.request())).rejects.toThrow('fresh native spawn')
    }
    const forged = { provider: 'analysis-spawn', label: 'not continuable', request: h.request(), signal: new AbortController().signal }
    await expect(h.ctx.subagents.startContinuable(forged as unknown as ContinuableStartSpec)).rejects.toThrow('cannot be continuable')
    h.ctx.subagents.registerProvider({ ...spawn, name: 'seeded-escape', start: request => startInProcessRun(request, { seed: [] }) })
    await expect(h.ctx.subagents.start('seeded-escape', h.request())).rejects.toThrow('fixed fresh native creation')
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.ctx.agents.list()).toEqual([h.parent])
  })
})

describe('analysis-only actual dispatcher and request budgets', () => {
  it('denies child-owned tools before ordinary pre-policy listeners perform work', async () => {
    const h = await setup([toolCallResponse('early-denial', 'child_owned_write', {}), textResponse('finding without tools')])
    const body = vi.fn(async () => [{ type: 'text' as const, text: 'must not run' }])
    const laterPrePolicy = vi.fn(() => Promise.resolve({ kind: 'allow' as const }))
    h.ctx.on('agent/created', ({ agent }) => {
      if (agent === h.parent) return
      agent.ctx.tools.register(defineContentToolFixture({ name: 'child_owned_write', description: 'negative fixture', parameters: {}, execute: body }))
      agent.ctx.on('tools/pre-execute', laterPrePolicy)
    })
    const denied: boolean[] = []
    h.ctx.on('tools/result', (exec, result) => { if (exec.name === 'child_owned_write') denied.push(result.isError) })
    const run = await h.start()
    try {
      expect((await run.result).stopReason).toBe('completed')
      expect(denied).toEqual([true])
      expect(body).not.toHaveBeenCalled()
      expect(laterPrePolicy).not.toHaveBeenCalled()
      expect(h.adapter.requests).toHaveLength(2)
    } finally { await run.dispose() }
  })

  it('does not apply a retained child restriction to its parent request', async () => {
    const h = await setup([textResponse('child finding'), textResponse('parent continues')])
    const run = await h.start()
    try {
      const childResult = await run.result
      h.parent.followup(createUserMessage({ content: [{ type: 'text', text: 'parent task' }], source: { kind: 'user' } }))
      await h.parent.whenIdle()
      expect(h.adapter.requests).toHaveLength(2)
      expect(h.adapter.requests[0]).toMatchObject({ sessionId: run.id, model: 'reviewer', reasoningEffort: 'low' })
      expect(h.adapter.requests[1]).toMatchObject({ sessionId: h.parent.id, model: 'parent', reasoningEffort: 'high' })
      expect(childResult.analysis?.admittedModelCalls).toBe(1)
    } finally { await run.dispose() }
  })

  const changedRequests: readonly Partial<GenerateOptions>[] = [
    { provider: 'other' }, { model: 'other' }, { reasoningEffort: ReasoningEffortId('high') }, { maxTokens: 256 },
    { tools: [{ name: 'unexpected_tool', description: 'must not be advertised', parameters: {} }] },
  ]
  it.each(changedRequests)('rejects fixed-request drift %j before reaching the adapter', async (changed) => {
    const h = await setup([textResponse('child finding')])
    const run = await h.start()
    try {
      await run.result
      const chunks: StreamChunk[] = []
      const dispatch = async () => {
        for await (const chunk of h.ctx.llm.stream({
          provider: 'mock', model: 'reviewer', reasoningEffort: ReasoningEffortId('low'), maxTokens: 128,
          sessionId: run.id, messages: [], ...changed,
        })) chunks.push(chunk)
      }
      await expect(dispatch()).rejects.toThrow('changed its fixed route, effort, token cap or empty tool surface')
      expect(chunks).toEqual([])
      expect(h.adapter.requests).toHaveLength(1)
    } finally { await run.dispose() }
  })

  it.each(['native', 'ptc'] as const)('denies invented child-owned tools and PTC while sending zero tool schemas under %s defaults', async (mode) => {
    const h = await setup([toolCallResponse('attack', 'child_owned_write', {}), textResponse('only a finding')], mode)
    const body = vi.fn(async () => [{ type: 'text' as const, text: 'must never run' }])
    const denied: boolean[] = []
    h.ctx.on('agent/created', ({ agent }) => {
      if (agent === h.parent) return
      agent.ctx.tools.register(defineContentToolFixture({ name: 'child_owned_write', description: 'negative fixture', parameters: {}, execute: body }))
      // Later pre-policy must not undo the creation-owned final guard.
      agent.ctx.on('tools/pre-execute', () => Promise.resolve({ kind: 'allow' as const }), { prepend: true })
    })
    h.ctx.on('tools/result', (exec, result) => { if (exec.name === 'child_owned_write') denied.push(result.isError) })
    const run = await h.start()
    try {
      const result = await run.result
      expect(result.stopReason).toBe('completed')
      expect(denied).toEqual([true])
      expect(body).not.toHaveBeenCalled()
      expect(h.adapter.requests).toHaveLength(2)
      expect(h.adapter.requests.every(request => (request.tools?.length ?? 0) === 0)).toBe(true)
      expect(h.adapter.requests.every(request => request.provider === 'mock' && request.model === 'reviewer' && request.reasoningEffort === 'low' && request.maxTokens === 128)).toBe(true)
      const child = run.localAgent
      if (child === undefined) throw new Error('native child missing')
      expect(child.session.header.isSeeded).toBe(false)
      expect(h.ctx.tools.get('child_owned_write', child)).toBeDefined()
      for (const name of ['child_owned_write', 'run_code', 'structured_output']) {
        const attempted = await h.ctx.tools.execute({ name, arguments: {}, callId: ToolCallId(`invented-${name}`), agent: child, signal: new AbortController().signal })
        expect(attempted.isError).toBe(true)
      }
      expect(body).not.toHaveBeenCalled()
      expect(h.ptcRun).not.toHaveBeenCalled()
      expect(result.analysis?.admittedModelCalls).toBe(2)
    } finally { await run.dispose() }
    expect(h.ctx.agents.list()).toEqual([h.parent])
    // Disposal removes the child-owned tool, not a process-global guard residue.
    expect(h.ctx.tools.get('child_owned_write', h.parent)).toBeUndefined()
  })

  it('reserves each retry before downstream streaming and refuses the attempt after the cap', async () => {
    const error: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'fixture provider failure' } } }]
    const h = await setup([error, textResponse('must not be requested')])
    h.ctx.on('agent/request-error', () => Promise.resolve({ kind: 'retry' as const }))
    const run = await h.start({ analysisPolicy: { ...POLICY, maxModelCalls: 1 } })
    try {
      const result = await run.result
      expect(result.stopReason).toBe('error')
      expect(result.analysis).toMatchObject({ admittedModelCalls: 1, limitHit: 'model-calls' })
      expect(h.adapter.requests).toHaveLength(1)
    } finally { await run.dispose() }
  })

  it('refuses an oversized chunk without retaining it or claiming completed analysis', async () => {
    const h = await setup([[{ type: 'block-start', index: 0, blockType: 'text' }, { type: 'text-delta', index: 0, text: 'x'.repeat(2000) }]])
    const run = await h.start({ analysisPolicy: { ...POLICY, maxOutputBytes: 100 } })
    try {
      const result = await run.result
      expect(result.stopReason).toBe('error')
      expect(result.analysis).toMatchObject({ admittedModelCalls: 1, limitHit: 'output-bytes' })
      expect(result.analysis?.retainedOutputBytes).toBeLessThanOrEqual(100)
      expect(result.analysis?.rejectedChunkBytes).toBeGreaterThan(2000)
      expect(result.output).toEqual([])
    } finally { await run.dispose() }
  })

  it('rejects and joins an explicitly registry-owned creation signal aborted at factory handoff', async () => {
    const h = await setup([])
    const creation = new AbortController()
    const beforeAgents = h.ctx.agents.list().length
    const beforeSessions = h.ctx.sessions.list().length
    const parentWithAbortAtHandoff = {
      options: h.parent.options,
      session: h.parent.session,
      ctx: {
        get: () => undefined,
        agents: {
          create: async (options: Parameters<typeof h.ctx.agents.create>[0]) => {
            const handle = await h.ctx.agents.create(options)
            creation.abort(new Error('registry admission ended'))
            return handle
          },
        },
      },
    } as unknown as Agent
    await expect(startInProcessRun({
      parent: parentWithAbortAtHandoff,
      prompt: [{ type: 'text', text: 'must not be submitted' }],
      signal: new AbortController().signal,
      resolvedCreationSignal: creation.signal,
      descriptor: snapshotSubagentDescriptor({ mode: 'one-shot', provider: 'analysis-spawn' }),
    }, {})).rejects.toThrow('aborted before child publication')
    expect(h.adapter.requests).toHaveLength(0)
    expect(h.ctx.agents.list()).toHaveLength(beforeAgents)
    expect(h.ctx.sessions.list()).toHaveLength(beforeSessions)
  })

  it('propagates cancellation before allocation and joins a streaming child on disposal', async () => {
    const h = await setup(['hang-slow'])
    await expect(h.start({ signal: AbortSignal.abort(new Error('caller stopped')) })).rejects.toThrow('aborted before child publication')
    expect(h.adapter.requests).toHaveLength(0)
    const run = await h.start()
    await vi.waitFor(() => { expect(h.adapter.requests).toHaveLength(1) })
    await run.dispose()
    expect((await run.result).stopReason).toBe('aborted')
    expect(h.ctx.agents.get(run.id)).toBeUndefined()
    expect(h.ctx.agents.list()).toEqual([h.parent])
  })
})
