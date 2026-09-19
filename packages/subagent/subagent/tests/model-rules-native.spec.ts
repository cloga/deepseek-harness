import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { createUserMessage, ReasoningEffortId, type LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import SandboxPolicyService, { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy'
import ApprovalService, { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval'
import JsonlSessionPersistence from '@deepseek-ai/dsh-session-persistence-jsonl'
import { SettingsProvider, type SettingsNamespace } from '@deepseek-ai/dsh-settings'
import * as SubagentSpawn from '@deepseek-ai/dsh-subagent-spawn-in-process'
import * as SubagentFork from '@deepseek-ai/dsh-subagent-fork-in-process'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { MockAdapter, textResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'
import SubagentRuntime, { type SubagentModelRule } from '../src/index.ts'
import { TestSessionQuery } from './test-session-query.ts'
import { loadStoredSession } from './persistence-helpers.ts'

const source = { provider: 'source', model: 'source-model' }
const target = { provider: 'target', model: 'target-model' }
const grandchild = { provider: 'target', model: 'grandchild-model' }
const rule: SubagentModelRule = { parent: source, child: target }
const high = ReasoningEffortId('high')

class MemorySettings extends SettingsProvider {
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve({}) }
  protected persist(_ns: SettingsNamespace, _section: Record<string, unknown>): Promise<void> { return Promise.resolve() }
}

class GatedAdapter extends MockAdapter {
  readonly entered = Promise.withResolvers<undefined>()
  gate: Promise<undefined> | undefined
  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    this.entered.resolve(undefined)
    await this.gate
    return super.resolveModel(provider, model)
  }
}

async function setup(rules: SubagentModelRule[] = [rule], options: { completeParentTurn?: boolean } = {}) {
  const ctx = new Context()
  const root = mkdtempSync(join(tmpdir(), 'dsh-model-rules-'))
  onTestFinished(async () => {
    await ctx.fiber.dispose()
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(MemorySettings)
  await ctx.plugin(JsonlSessionPersistence, { root })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TestSessionQuery)
  await ctx.plugin(SubagentRuntime, { modelRules: rules })
  await ctx.plugin(SubagentSpawn, { providerName: 'spawn' })
  const adapter = new GatedAdapter(Array.from({ length: 8 }, () => textResponse('done')), {
    efforts: [{ id: high, name: 'High' }],
  })
  const registration = ctx.llm.registerAdapter(['source', 'target'], adapter)
  const parent = await ctx.agentLoop.create(SessionId('parent'), {
    provider: 'creation-provider', model: 'creation-model', maxTokens: 123,
  })
  if (options.completeParentTurn) {
    installModelSelection(parent.ctx, { current: { ...source, reasoningEffort: high }, assembled: undefined })
    parent.followup(createUserMessage({ content: [{ type: 'text', text: 'completed parent work' }], source: { kind: 'user' } }))
    await parent.whenIdle()
    expect(parent.session.requestHeader()?.config).toMatchObject({ ...source, reasoningEffort: high })
  } else {
    parent.session.append('request/header', { header: { config: { ...source, reasoningEffort: high } }, reason: 'initial' })
  }
  const request = { parent, prompt: [{ type: 'text' as const, text: 'task' }] }
  return { ctx, root, parent, adapter, registration, request }
}

async function settled(ctx: Context, childId: SessionId) {
  await vi.waitFor(() => { expect(ctx.agents.get(childId)).toBeUndefined() }, { timeout: 15000 })
  return loadStoredSession(ctx.sessionPersistence, childId)
}

describe('native model rule creation and continuation', () => {
  it.each([
    { provider: 'spawn', before: 'read-only', after: 'danger-full-access', approvalBefore: 'ask', approvalAfter: 'never' },
    { provider: 'spawn', before: 'danger-full-access', after: 'read-only', approvalBefore: 'never', approvalAfter: 'ask' },
    { provider: 'fork', before: 'read-only', after: 'danger-full-access', approvalBefore: 'ask', approvalAfter: 'never' },
    { provider: 'fork', before: 'danger-full-access', after: 'read-only', approvalBefore: 'never', approvalAfter: 'ask' },
  ] as const)('captures $provider delegated permissions before $before changes to $after during model preflight', async ({
    provider, before, after, approvalBefore, approvalAfter,
  }) => {
    const { ctx, root, parent, adapter, request } = await setup([rule], { completeParentTurn: provider === 'fork' })
    await ctx.plugin(SandboxPolicyService, { mode: 'workspace-write', workspaceRoot: root })
    await ctx.plugin(ApprovalService)
    if (provider === 'fork') await ctx.plugin(SubagentFork, { providerName: 'fork' })
    setSandboxMode(parent.session, before)
    setApprovalPolicy(parent.session, approvalBefore)
    let preset: 'custom' | 'danger-full-access' = before === 'danger-full-access' ? 'danger-full-access' : 'custom'
    const currentPreset = vi.fn(() => preset)
    ctx.provide('permissionPresets', { current: currentPreset } as never)
    const gate = Promise.withResolvers<undefined>()
    const entered = Promise.withResolvers<undefined>()
    const resolveModel = adapter.resolveModel.bind(adapter)
    adapter.gate = gate.promise
    vi.spyOn(adapter, 'resolveModel').mockImplementation((route, model) => {
      entered.resolve(undefined)
      return resolveModel(route, model)
    })
    const pending = ctx.subagents.start(provider, { ...request, signal: new AbortController().signal })
    await entered.promise
    setSandboxMode(parent.session, after)
    setApprovalPolicy(parent.session, approvalAfter)
    preset = after === 'danger-full-access' ? 'danger-full-access' : 'custom'
    gate.resolve(undefined)
    const run = await pending
    const child = run.localAgent!
    expect(ctx.sandboxPolicy.overrideOf(child.session)).toBe(before)
    expect(ctx.approval.overrideOf(child.session)).toBe('never')
    expect(ctx.sandboxPolicy.overrideOf(parent.session)).toBe(after)
    expect(ctx.approval.overrideOf(parent.session)).toBe(approvalAfter)
    expect(currentPreset).toHaveBeenCalledTimes(1)
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    await run.dispose()
    const stored = await loadStoredSession(ctx.sessionPersistence, run.id)
    const policies = stored.events.slice(stored.inheritedEventCount).filter(event =>
      event.type === 'sandbox/mode' || event.type === 'approval/policy' || event.type === 'permission/preset')
    expect(policies.map(event => ({ type: event.type, data: event.data }))).toEqual([
      { type: 'sandbox/mode', data: { mode: before, source: 'delegation' } },
      { type: 'approval/policy', data: { policy: 'never', source: 'delegation' } },
      ...before === 'danger-full-access' ? [{ type: 'permission/preset', data: { preset: 'danger-full-access' } }] : [],
    ])
  })

  it.each(['one-shot', 'continuable'] as const)('captures %s options before settings and parent change during preflight', { timeout: 20000 }, async (mode) => {
    const { ctx, parent, adapter, request } = await setup()
    const gate = Promise.withResolvers<undefined>()
    adapter.gate = gate.promise
    let child: Agent | undefined
    ctx.on('agent/created', ({ agent }) => { if (agent !== parent) child = agent })
    const signal = new AbortController().signal
    const pending = mode === 'one-shot'
      ? ctx.subagents.start('spawn', { ...request, signal })
      : ctx.subagents.startContinuable({ provider: 'spawn', label: 'mapped child', request, signal })
    await adapter.entered.promise
    parent.session.append('request/header', { header: { config: { ...target, reasoningEffort: high } }, reason: 'change' })
    await ctx.settings.update('subagent', { modelRules: [{ parent: source, child: grandchild }] })
    gate.resolve(undefined)
    const started = await pending
    expect(child?.options).toMatchObject({ ...target, maxTokens: 123, subagentDepth: 1 })
    expect(child?.options).not.toHaveProperty('reasoningEffort')
    if ('result' in started) {
      await expect(started.result).resolves.toMatchObject({ stopReason: 'completed' })
      expect(child?.session.requestHeader()?.config).toMatchObject(target)
      expect(child?.session.requestHeader()?.config.reasoningEffort).toBeUndefined()
      await started.dispose()
    } else {
      const stored = await settled(ctx, started.childId)
      expect(stored.events.find(event => event.type === 'subagent/descriptor')?.data).toMatchObject({
        mode: 'continuable', agentProvider: target.provider, agentModel: target.model,
      })
      expect(stored.events.find(event => event.type === 'subagent/descriptor')?.data).not.toHaveProperty('agentReasoningEffort')
      await ctx.settings.update('subagent', { modelRules: [{ parent: target, child: grandchild }] })
      await ctx.subagents.sendMessage(parent, started.childId, [{ type: 'text', text: 'continue' }], { signal })
      const resumed = await settled(ctx, started.childId)
      const configs = resumed.events.flatMap(event => event.type === 'request/header' ? [event.data.header.config] : [])
      expect(configs.length).toBeGreaterThan(0)
      expect(configs.every(config => config.provider === target.provider
        && config.model === target.model && config.reasoningEffort === undefined)).toBe(true)
    }
    expect(adapter.requests.every(call => call.provider === target.provider
      && call.model === target.model && call.reasoningEffort === undefined)).toBe(true)
  })

  it.each([
    { mode: 'one-shot', mapped: true },
    { mode: 'continuable', mapped: true },
    { mode: 'one-shot', mapped: false },
    { mode: 'continuable', mapped: false },
  ] as const)('fork $mode preserves completed history with mapped=$mapped', { timeout: 20000 }, async ({ mode, mapped }) => {
    const { ctx, parent, adapter, request } = await setup(mapped ? [rule] : [], { completeParentTurn: true })
    await ctx.plugin(SubagentFork, { providerName: 'fork' })
    const expectedRoute = mapped ? target : source
    const expectedEffort = mapped ? undefined : high
    const signal = new AbortController().signal
    let childId: SessionId
    if (mode === 'one-shot') {
      const run = await ctx.subagents.start('fork', { ...request, signal })
      childId = run.id
      await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
      expect(run.localAgent?.session.inheritedEventCount).toBeGreaterThan(0)
      expect(run.localAgent?.session.requestHeader()?.config).toMatchObject(expectedRoute)
      expect(run.localAgent?.session.requestHeader()?.config.reasoningEffort).toBe(expectedEffort)
      await run.dispose()
    } else {
      const started = await ctx.subagents.startContinuable({ provider: 'fork', label: 'forked child', request, signal })
      childId = started.childId
      const stored = await settled(ctx, started.childId)
      expect(stored.inheritedEventCount).toBeGreaterThan(0)
      const own = stored.events.slice(stored.inheritedEventCount)
      const header = own.find(event => event.type === 'request/header')
      expect(header?.data.header.config).toMatchObject(expectedRoute)
      expect(header?.data.header.config.reasoningEffort).toBe(expectedEffort)
      const descriptor = own.find(event => event.type === 'subagent/descriptor')
      expect(descriptor?.data).toMatchObject({ agentProvider: expectedRoute.provider, agentModel: expectedRoute.model })
      expect(descriptor?.data.mode === 'continuable' ? descriptor.data.agentReasoningEffort : undefined).toBe(expectedEffort)
    }
    await parent.whenIdle()
    // Continuable settlement independently wakes the parent; identify the child's own request.
    const childRequests = adapter.requests.filter(call => call.sessionId === childId)
    expect(childRequests).toHaveLength(1)
    const childRequest = childRequests[0]!
    expect(childRequest).toMatchObject(expectedRoute)
    expect(childRequest.reasoningEffort).toBe(expectedEffort)
    expect(childRequest.messages.some(message => message.content.some(block =>
      block.type === 'text' && block.text === 'completed parent work'))).toBe(true)
    const parentRequests = adapter.requests.filter(call => call.sessionId === parent.id)
    expect(parentRequests).toHaveLength(mode === 'continuable' ? 2 : 1)
    expect(parentRequests.every(call => call.provider === source.provider
      && call.model === source.model && call.reasoningEffort === high)).toBe(true)
    expect(parent.session.requestHeader()?.config).toMatchObject({ ...source, reasoningEffort: high })
    expect(parent.options).toMatchObject({ provider: 'creation-provider', model: 'creation-model' })
  })

  it('maps manager-owned continuable children independently of one-shot option capabilities', async () => {
    const { ctx, adapter, request } = await setup()
    ctx.subagents.registerProvider({
      name: 'manager-owned', inheritsParentContext: false,
      capabilities: { agentOptions: false, depthLimit: false, outputSchema: false, toolFilter: false, persona: false },
      async start() { throw new Error('one-shot startup must not run') },
      async prepareContinuable() { return {} },
    })
    const started = await ctx.subagents.startContinuable({
      provider: 'manager-owned', label: 'mapped child', request, signal: new AbortController().signal,
    })
    const stored = await settled(ctx, started.childId)
    expect(stored.events.find(event => event.type === 'subagent/descriptor')?.data).toMatchObject({
      agentProvider: target.provider, agentModel: target.model,
    })
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]).toMatchObject(target)
  })

  it('matches grandchildren against their actual direct parent, not the root', async () => {
    const { ctx, parent, request } = await setup([rule, { parent: target, child: grandchild }])
    const signal = new AbortController().signal
    const child = await ctx.subagents.start('spawn', { ...request, signal })
    await child.result
    const nextParent = child.localAgent!
    const nested = await ctx.subagents.start('spawn', { ...request, parent: nextParent, signal })
    await nested.result
    expect(nested.localAgent?.options).toMatchObject({ ...grandchild, subagentDepth: 2 })
    expect(nested.localAgent?.session.header.parentSession).toBe(nextParent.id)
    expect(parent.options).toMatchObject({ provider: 'creation-provider', model: 'creation-model' })
    await nested.dispose()
    await child.dispose()
  })

  it.each(['one-shot', 'continuable'] as const)('does not publish a %s child after cancellation during native preflight', async (mode) => {
    const { ctx, adapter, request } = await setup()
    const gate = Promise.withResolvers<undefined>()
    adapter.gate = gate.promise
    const controller = new AbortController()
    const created = vi.fn()
    ctx.on('agent/created', created)
    const pending = mode === 'one-shot'
      ? ctx.subagents.start('spawn', { ...request, signal: controller.signal })
      : ctx.subagents.startContinuable({ provider: 'spawn', label: 'child', request, signal: controller.signal })
    await adapter.entered.promise
    controller.abort()
    gate.resolve(undefined)
    await expect(pending).rejects.toThrow()
    expect(created).not.toHaveBeenCalled()
    expect(adapter.requests).toEqual([])
  })

  it('rejects an adapter replacement during preflight and permits a later explicit retry', async () => {
    const { ctx, adapter, registration, request } = await setup()
    const gate = Promise.withResolvers<undefined>()
    adapter.gate = gate.promise
    const pending = ctx.subagents.start('spawn', { ...request, signal: new AbortController().signal })
    await adapter.entered.promise
    registration()
    ctx.llm.registerAdapter(['source', 'target'], new MockAdapter([textResponse('retry')]))
    gate.resolve(undefined)
    await expect(pending).rejects.toThrow('catalog/provider changed')
    expect(adapter.requests).toEqual([])
    const retry = await ctx.subagents.start('spawn', { ...request, signal: new AbortController().signal })
    await expect(retry.result).resolves.toMatchObject({ stopReason: 'completed' })
    await retry.dispose()
  })

  it.each(['one-shot', 'continuable'] as const)('rejects an unavailable %s target before publication', async (mode) => {
    const { ctx, registration, request } = await setup()
    registration.replace(['source'])
    const created = vi.fn()
    ctx.on('agent/created', created)
    const signal = new AbortController().signal
    const pending = mode === 'one-shot'
      ? ctx.subagents.start('spawn', { ...request, signal })
      : ctx.subagents.startContinuable({ provider: 'spawn', label: 'child', request, signal })
    await expect(pending).rejects.toThrow('no adapter registered')
    expect(created).not.toHaveBeenCalled()
  })

  it('rejects renamed exact model metadata before child publication', async () => {
    const { ctx, adapter, request } = await setup()
    vi.spyOn(adapter, 'resolveModel').mockResolvedValue({ provider: target.provider, id: 'renamed-model', name: 'Renamed' })
    const created = vi.fn()
    ctx.on('agent/created', created)
    await expect(ctx.subagents.start('spawn', { ...request, signal: new AbortController().signal }))
      .rejects.toThrow('invalid exact model metadata')
    expect(created).not.toHaveBeenCalled()
  })
})
