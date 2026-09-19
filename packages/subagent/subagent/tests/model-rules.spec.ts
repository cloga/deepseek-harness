import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmCallConfig, LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SubagentRuntime, { type Config, type ResolvedSubagentStartRequest, type SubagentProvider } from '../src/index.ts'

const rule = { parent: { provider: 'parent-provider', model: 'parent-model' }, child: { provider: 'child-provider', model: 'child-model' } }

class MemorySettings extends SettingsProvider {
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> { return Promise.resolve() }
}

async function setup(config: Config = {}) {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(MemorySettings)
  await ctx.plugin(SubagentRuntime, config)
  const parent = {
    id: SessionId('parent'),
    ctx,
    session: Session.create(SessionId('parent')),
    options: { ...rule.parent, reasoningEffort: ReasoningEffortId('parent-effort'), maxTokens: 200 },
  } as unknown as Agent
  const start = vi.fn(async (_request: ResolvedSubagentStartRequest) => ({
    id: SessionId('child'), localAgent: undefined,
    result: Promise.resolve({ output: [], stopReason: 'completed' as const }),
    async dispose() {},
  }))
  const provider: SubagentProvider = {
    name: 'spawn', inheritsParentContext: false,
    capabilities: { agentOptions: true, depthLimit: true, outputSchema: true, toolFilter: true, persona: true },
    start,
  }
  const remove = ctx.subagents.registerProvider(provider)
  const request = (agentOptions?: AgentOptions, signal = new AbortController().signal) => ({
    parent, prompt: [{ type: 'text' as const, text: 'task' }], signal,
    ...agentOptions === undefined ? {} : { agentOptions },
  })
  return { ctx, parent, start, provider, remove, request }
}

function mountPreflight(ctx: Context) {
  const resolveCallConfig = vi.fn(async (config: LlmCallConfig) => config)
  ctx.provide('llm', { resolveCallConfig } as never)
  return resolveCallConfig
}

describe('creation-time subagent model rules', () => {
  it('preserves omitted settings defaults and makes no LLM read without a rule', async () => {
    const { ctx, start, request } = await setup({ maxDepth: 3, maxActiveSubagents: 2 })
    const get = vi.spyOn(ctx, 'get')
    await ctx.subagents.start('spawn', request())
    expect(ctx.subagents.resolveMaxDepth()).toBe(3)
    expect(start.mock.calls[0]![0]).not.toHaveProperty('resolvedAgentOptions')
    expect(start.mock.calls[0]![0]).not.toHaveProperty('agentOptions')
    expect(get.mock.calls.some(([name]) => name === 'llm')).toBe(false)
  })

  it('maps exact parent route and keeps maxTokens while clearing route-owned effort', async () => {
    const { ctx, start, request, parent } = await setup({ modelRules: [rule] })
    const preflight = mountPreflight(ctx)
    const input = request({ maxTokens: 77 })
    await ctx.subagents.start('spawn', input)
    expect(preflight).toHaveBeenCalledWith({ ...rule.child, maxTokens: 77 }, input.signal)
    expect(start.mock.calls[0]![0].resolvedAgentOptions).toMatchObject({ ...rule.child, maxTokens: 77 })
    expect(start.mock.calls[0]![0].resolvedAgentOptions).not.toHaveProperty('reasoningEffort')
    expect(input.agentOptions).toEqual({ maxTokens: 77 })
    expect(parent.options.provider).toBe(rule.parent.provider)
  })

  it.each([
    { provider: 'explicit' }, { model: 'explicit' }, { reasoningEffort: ReasoningEffortId('explicit') },
  ])('preserves explicit child values %j without preflight or remapping', async (options) => {
    const { ctx, start, request } = await setup({ modelRules: [rule] })
    const preflight = mountPreflight(ctx)
    await ctx.subagents.start('spawn', request(options))
    expect(preflight).not.toHaveBeenCalled()
    expect(start.mock.calls[0]![0].agentOptions).toEqual(options)
    expect(start.mock.calls[0]![0]).not.toHaveProperty('resolvedAgentOptions')
  })

  it('leaves externally model-managed one-shot providers unchanged without an LLM lookup', async () => {
    const { ctx, start, request, provider, remove } = await setup({ modelRules: [rule] })
    remove()
    ctx.subagents.registerProvider({ ...provider, capabilities: { ...provider.capabilities, agentOptions: false } })
    const get = vi.spyOn(ctx, 'get')
    await ctx.subagents.start('spawn', request())
    expect(start.mock.calls[0]![0]).not.toHaveProperty('resolvedAgentOptions')
    expect(start.mock.calls[0]![0]).not.toHaveProperty('agentOptions')
    expect(get.mock.calls.some(([name]) => name === 'llm')).toBe(false)
    await expect(ctx.subagents.start('spawn', request({ provider: 'explicit', model: 'explicit' })))
      .rejects.toMatchObject({ code: 'UNSUPPORTED_CAPABILITY' })
    expect(start).toHaveBeenCalledTimes(1)
  })

  it('does not map provider-owned child route defaults', async () => {
    const { ctx, start, request, provider, remove } = await setup({ modelRules: [rule] })
    remove()
    ctx.subagents.registerProvider({ ...provider, agentRouteDefaults: rule.child })
    await ctx.subagents.start('spawn', request())
    expect(start.mock.calls[0]![0]).not.toHaveProperty('resolvedAgentOptions')
  })

  it.each([
    { provider: 'different-provider', model: rule.parent.model },
    { provider: rule.parent.provider, model: 'different-model' },
  ])('does not match partial route %j', async (parentRoute) => {
    const { ctx, parent, start, request } = await setup({ modelRules: [rule] })
    vi.spyOn(parent.session, 'requestHeader').mockReturnValue({ config: parentRoute } as never)
    await ctx.subagents.start('spawn', request())
    expect(start.mock.calls[0]![0]).not.toHaveProperty('resolvedAgentOptions')
  })

  it('uses the direct parent request route rather than its creation route', async () => {
    const selected = { provider: 'selected-provider', model: 'selected-model' }
    const { ctx, parent, start, request } = await setup({ modelRules: [{ parent: selected, child: rule.child }] })
    vi.spyOn(parent.session, 'requestHeader').mockReturnValue({ config: selected } as never)
    mountPreflight(ctx)
    await ctx.subagents.start('spawn', request())
    expect(start.mock.calls[0]![0].resolvedAgentOptions).toMatchObject(rule.child)
  })

  it('rejects a matched rule when LLM is missing before starting a child', async () => {
    const { ctx, start, request } = await setup({ modelRules: [rule] })
    await expect(ctx.subagents.start('spawn', request())).rejects.toThrow('llm')
    expect(start).not.toHaveBeenCalled()
  })

  it('rejects unavailable targets without publishing or retrying another route', async () => {
    const { ctx, start, request } = await setup({ modelRules: [rule] })
    const preflight = mountPreflight(ctx)
    preflight.mockRejectedValue(new Error('target unavailable'))
    await expect(ctx.subagents.start('spawn', request())).rejects.toThrow('target unavailable')
    expect(preflight).toHaveBeenCalledTimes(1)
    expect(start).not.toHaveBeenCalled()
  })

  it.each(['cancel', 'replace'] as const)('rejects %s during preflight before provider startup', async (action) => {
    const { ctx, start, request, remove, provider } = await setup({ modelRules: [rule] })
    const gate = Promise.withResolvers<LlmCallConfig>()
    mountPreflight(ctx).mockReturnValue(gate.promise)
    const controller = new AbortController()
    const pending = ctx.subagents.start('spawn', request(undefined, controller.signal))
    if (action === 'cancel') controller.abort()
    else { remove(); ctx.subagents.registerProvider({ ...provider }) }
    gate.resolve(rule.child)
    await expect(pending).rejects.toThrow()
    expect(start).not.toHaveBeenCalled()
  })

  it('captures rule and effective options before preflight, including absent child effort', async () => {
    const { ctx, parent, start, request } = await setup({ modelRules: [rule] })
    const gate = Promise.withResolvers<LlmCallConfig>()
    mountPreflight(ctx).mockReturnValue(gate.promise)
    const pending = ctx.subagents.start('spawn', request())
    vi.spyOn(parent.session, 'requestHeader').mockReturnValue({
      config: { ...rule.child, reasoningEffort: ReasoningEffortId('later-parent-effort') },
    } as never)
    await ctx.settings.update('subagent', { modelRules: [] })
    gate.resolve(rule.child)
    await pending
    expect(start.mock.calls[0]![0].resolvedAgentOptions).toEqual({ ...rule.child, maxTokens: 200 })
  })

  it('rejects replacement of the real LLM service during preflight', async () => {
    const { ctx, start, request } = await setup({ modelRules: [rule] })
    const llmFiber = await ctx.plugin(LlmRuntime)
    const entered = Promise.withResolvers<undefined>()
    const gate = Promise.withResolvers<LlmResolvedModelInfo>()
    const adapter = new MockAdapter([])
    vi.spyOn(adapter, 'resolveModel').mockImplementation(() => { entered.resolve(undefined); return gate.promise })
    ctx.llm.registerAdapter([rule.child.provider], adapter)
    const pending = ctx.subagents.start('spawn', request())
    await entered.promise
    await llmFiber.dispose()
    await ctx.plugin(LlmRuntime)
    gate.resolve({ provider: rule.child.provider, id: rule.child.model, name: 'Child' })
    await expect(pending).rejects.toThrow('catalog/provider changed')
    expect(start).not.toHaveBeenCalled()
  })

  it('rejects duplicate parent pairs in composition before mounting', async () => {
    const ctx = new Context()
    onTestFinished(() => ctx.fiber.dispose())
    await expect(ctx.plugin(SubagentRuntime, { modelRules: [rule, rule] })).rejects.toThrow('repeats parent route')
  })

  it('rejects malformed and duplicate rule settings without changing depth settings', async () => {
    const { ctx } = await setup({ maxDepth: 4 })
    for (const modelRules of [
      [rule, { ...rule, child: { provider: 'other', model: 'other' } }],
      [{ ...rule, child: { provider: '', model: 'x' } }],
      [{ ...rule, parent: { provider: 'x', model: '' } }],
    ]) {
      await expect(ctx.settings.update('subagent', { modelRules })).rejects.toThrow()
    }
    expect(ctx.subagents.resolveMaxDepth()).toBe(4)
    await ctx.settings.update('subagent', { modelRules: [rule] })
    expect(ctx.subagents.resolveMaxDepth()).toBe(4)
  })
})
