import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, ImageBlock, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { DelegationRoutingCapture, ResolveDelegationRoutingRequest, ResolvedDelegationRouting } from '@deepseek-ai/dsh-model-routing'
import { ALL_ALLOWED, autoSelection, nativeModelInfo as info } from './native-model-selection-fixtures.ts'
import SessionStore, { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import SubagentRuntime, { recordSubagentModelSelection } from '../src/index.ts'
import type { AllowedModelRoute, ResolvedSubagentStartRequest, SubagentProvider, SubagentResult } from '../src/index.ts'
import { assertSubagentModelRules, captureSubagentModelRule } from '../src/model-rules.ts'
import { appendNativeChildSelection } from '../src/native-model-selection.ts'
import { continuationManager } from './continuation-internals.ts'
import type { SubagentModelRule } from '../src/model-rules.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })

class MemorySettings extends SettingsProvider {
  private doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(this.doc) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = section
    return Promise.resolve()
  }
}

const RULE: SubagentModelRule = { parent: { provider: 'models', model: 'parent' }, child: { provider: 'models', model: 'rule' } }

async function setup(options: {
  native?: 'spawn' | 'fork' | false
  allowed?: readonly AllowedModelRoute[] | false
  rules?: SubagentModelRule[]
  defaults?: { provider: string; model: string }
  auto?: boolean
  llm?: boolean
  projections?: boolean
} = {}) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SessionStore)
  if (options.projections !== false) await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  if (options.llm !== false) await ctx.plugin(LlmRuntime)
  await ctx.plugin(MemorySettings)
  const service = ctx.plugin(SubagentRuntime, { modelRules: options.rules ?? [] })
  await service
  const resolveModel = vi.fn(async (provider: string, model: string, _signal?: AbortSignal) => info(provider, model))
  class Adapter extends LlmAdapter {
    override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
      return resolveModel(provider, model, signal)
    }
    override async * stream(): AsyncIterable<StreamChunk> { yield { type: 'finish', reason: { kind: 'stop' } } }
  }
  const offAdapter = ctx.get('llm')?.registerAdapter(['models', 'other'], new Adapter()) ?? (() => {})
  const parentOptions: AgentOptions = { provider: 'models', model: 'parent', reasoningEffort: ReasoningEffortId('high'), maxTokens: 128 }
  const session = ctx.sessions.create(SessionId('parent'))
  // The selection transaction only consumes these real registry/Session fields; the provider below records its creation input.
  const parent = { id: session.id, session, options: parentOptions, ctx } as Agent
  await ctx.agents.register(parent)
  if (options.allowed !== false && options.projections !== false) {
    recordSubagentModelSelection(ctx.sessionProjections, session, options.allowed ?? ALL_ALLOWED)
  }
  let auto = options.auto !== false
  const captureDelegation = vi.fn((agent: Agent): DelegationRoutingCapture | undefined => auto ? {
    parentSessionId: agent.id, intentSeq: SessionSeq(0), selection: autoSelection(),
  } : undefined)
  const resolveDelegation = vi.fn(async (_request: ResolveDelegationRoutingRequest): Promise<ResolvedDelegationRouting> => ({
    selection: { provider: 'models', model: 'cheap', reasoningEffort: ReasoningEffortId('low') },
    candidateId: 'cheap', reason: 'quality-floor',
  }))
  const routing = ctx.plugin(function routingFixture(inner: Context) { inner.provide('modelRouting', { captureDelegation, resolveDelegation }) })
  await routing
  const requests: ResolvedSubagentStartRequest[] = []
  const disposeRun = vi.fn(async () => {})
  const done = Promise.withResolvers<SubagentResult>()
  done.resolve({ output: [], stopReason: 'completed' })
  const provider: SubagentProvider = {
    name: 'native-alias',
    capabilities: { agentOptions: true, depthLimit: true, toolFilter: true, persona: true, outputSchema: true },
    inheritsParentContext: options.native === 'fork',
    ...options.native === false ? {} : { nativeModelSelection: options.native ?? 'spawn' },
    ...options.defaults === undefined ? {} : { agentRouteDefaults: options.defaults },
    start: async (request) => {
      requests.push(request)
      return { id: SessionId(`child-${requests.length}`), localAgent: undefined, result: done.promise, dispose: disposeRun }
    },
  }
  const offProvider = ctx.subagents.registerProvider(provider)
  const start = (
    agentOptions?: AgentOptions,
    extra: { disableAutoModelSelection?: true; signal?: AbortSignal } = {},
  ) => ctx.subagents.start(provider.name, {
    parent, prompt: [{ type: 'text', text: 'isolated task' }], signal: extra.signal ?? new AbortController().signal,
    ...agentOptions === undefined ? {} : { agentOptions },
    ...extra.disableAutoModelSelection === undefined ? {} : { disableAutoModelSelection: extra.disableAutoModelSelection },
  })
  return { ctx, service, routing, parent, parentOptions, provider, requests, start, resolveModel, captureDelegation, resolveDelegation,
    offProvider, offAdapter, Adapter, disposeRun, setAuto: (value: boolean) => { auto = value } }
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  signal.throwIfAborted()
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      reject(signal.reason instanceof Error ? signal.reason : new Error('native selection cancelled'))
    }, { once: true })
  })
}

describe('exact deterministic native model rules', () => {
  it('validates unique exact parent pairs and does not require a live target for unmatched rules', () => {
    expect(() => { assertSubagentModelRules(undefined) }).not.toThrow()
    expect(() => { assertSubagentModelRules({}) }).toThrow('must be an array')
    expect(() => { assertSubagentModelRules([RULE, RULE]) }).toThrow('repeats parent route')
    expect(() => { assertSubagentModelRules([{ ...RULE, child: { provider: '', model: 'bad' } }]) }).toThrow()
    expect(captureSubagentModelRule([RULE], { provider: 'different', model: 'parent' }, undefined)).toBeUndefined()
    expect(captureSubagentModelRule([], { provider: 'models', model: 'parent' }, undefined)).toBeUndefined()
    expect(captureSubagentModelRule([RULE], { provider: 'models', model: 'parent' }, { reasoningEffort: ReasoningEffortId('low') }))
      .toBeUndefined()
  })

  it('chooses a matching user rule before Auto even outside the model-authored allowlist', async () => {
    const h = await setup({ rules: [RULE] })
    await h.start()
    expect(h.requests[0]?.resolvedAgentOptions).toMatchObject({ provider: 'models', model: 'rule', reasoningEffort: 'low', maxTokens: 128 })
    expect(h.requests[0]?.resolvedModelSelection?.decision.source).toBe('parent-rule')
    expect(h.resolveDelegation).not.toHaveBeenCalled()
  })

  it('matches the actual request header instead of parent creation options', async () => {
    const h = await setup({ rules: [RULE] })
    h.parentOptions.model = 'stale-creation'
    h.parent.session.append('request/header', { reason: 'initial', header: { config: { provider: 'models', model: 'parent', reasoningEffort: ReasoningEffortId('low') } } })
    await h.start()
    expect(h.requests[0]?.resolvedAgentOptions?.model).toBe('rule')
  })

  it('does not recover a failed matching rule with Auto or inheritance', async () => {
    const h = await setup({ rules: [RULE] })
    h.resolveModel.mockImplementation(async (provider, model) => {
      if (model === 'rule') throw new Error('rule target unavailable')
      return info(provider, model)
    })
    await expect(h.start()).rejects.toThrow('rule target unavailable')
    expect(h.requests).toHaveLength(0)
    expect(h.resolveDelegation).not.toHaveBeenCalled()
  })

  it('captures the rule before settings and parent values change during target preflight', async () => {
    const h = await setup({ rules: [RULE] })
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    h.resolveModel.mockImplementation(async (provider, model) => {
      entered.resolve(undefined)
      await release.promise
      return info(provider, model)
    })
    const starting = h.start()
    try {
      await entered.promise
      h.parentOptions.model = 'new-parent'
      await h.ctx.settings.update('subagent', { modelRules: [{ ...RULE, child: { provider: 'models', model: 'new-rule' } }] })
      release.resolve(undefined)
      await starting
      expect(h.requests[0]?.resolvedAgentOptions?.model).toBe('rule')
    } finally { release.resolve(undefined); await starting.catch(() => {}) }
  })
})

describe('native creation precedence and exact Auto authority', () => {
  it.each([
    { model: 'explicit' }, { provider: 'other' }, { reasoningEffort: ReasoningEffortId('low') },
  ])('preserves explicit partial LLM options %j ahead of parent rules and Auto', async (agentOptions) => {
    const h = await setup({ rules: [RULE] })
    await h.start(agentOptions)
    expect(h.requests[0]?.resolvedModelSelection?.decision.source).toBe('request')
    expect(h.resolveDelegation).not.toHaveBeenCalled()
    expect(h.requests[0]?.resolvedAgentOptions).toMatchObject(agentOptions)
  })

  it('honors provider defaults instead of parent rules or Auto without inheriting parent effort', async () => {
    const h = await setup({ rules: [RULE], defaults: { provider: 'models', model: 'default-child' } })
    await h.start()
    expect(h.requests[0]?.resolvedAgentOptions).toMatchObject({ provider: 'models', model: 'default-child', reasoningEffort: 'low' })
    expect(h.resolveDelegation).not.toHaveBeenCalled()
  })

  it.each(['absent-policy', 'no-auto', 'caller-denial', 'fork'] as const)('inherits without Auto when %s', async (cause) => {
    const h = await setup({
      ...cause === 'absent-policy' ? { allowed: false as const } : {},
      ...cause === 'no-auto' ? { auto: false } : {},
      ...cause === 'fork' ? { native: 'fork' as const } : {},
    })
    await h.start(undefined, cause === 'caller-denial' ? { disableAutoModelSelection: true } : {})
    expect(h.requests[0]?.resolvedAgentOptions).toEqual(h.parentOptions)
    expect(h.requests[0]?.resolvedModelSelection?.decision.source).toBe('inheritance')
    expect(h.resolveDelegation).not.toHaveBeenCalled()
    expect(h.resolveModel).not.toHaveBeenCalled()
  })

  it('permits an explicit user rule for a native fork while excluding implicit fork Auto', async () => {
    const h = await setup({ native: 'fork', rules: [RULE] })
    await h.start()
    expect(h.requests[0]?.resolvedAgentOptions?.model).toBe('rule')
    expect(h.resolveDelegation).not.toHaveBeenCalled()
  })

  it('resolves Auto from the authorized pool and forwards the captured output cap', async () => {
    const h = await setup()
    await h.start({ maxTokens: 64 })
    expect(h.resolveDelegation.mock.calls[0]?.[0]).toMatchObject({ eligibleCandidateIds: ['cheap', 'strong'], prompt: [{ type: 'text', text: 'isolated task' }], maxTokens: 64 })
    expect(h.requests[0]?.resolvedAgentOptions).toEqual({ provider: 'models', model: 'cheap', reasoningEffort: 'low', maxTokens: 64 })
    expect(h.requests[0]?.resolvedModelSelection).toMatchObject({ decision: { source: 'auto', candidateId: 'cheap' }, allowedModels: ALL_ALLOWED, delegationAuto: { mode: 'balanced' } })
    const captured = h.requests[0]
    expect(Object.isFrozen(captured?.resolvedAgentOptions)).toBe(true)
    expect(Object.isFrozen(captured?.resolvedDelegatedPolicies)).toBe(true)
    expect(Object.isFrozen(captured?.resolvedModelSelection)).toBe(true)
    expect(Object.isFrozen(captured?.resolvedModelSelection?.decision)).toBe(true)
    expect(Object.isFrozen(captured?.resolvedModelSelection?.allowedModels)).toBe(true)
    expect(captured?.resolvedModelSelection?.allowedModels?.every(route => Object.isFrozen(route))).toBe(true)
    expect(Object.isFrozen(captured)).toBe(false)
    expect(Object.isFrozen(h.parent)).toBe(false)
    expect(Object.isFrozen(h.parentOptions)).toBe(false)
    expect(Object.isFrozen(h.ctx)).toBe(false)
    expect(Object.isFrozen(captured?.signal)).toBe(false)
  })

  it.each([
    { allowed: [{ provider: 'models', model: 'unlisted' }] },
    { allowed: [{ provider: 'models', model: 'cheap' }] },
  ])('fails closed before classification for an unusable authorized pool %j', async ({ allowed }) => {
    const h = await setup({ allowed })
    await expect(h.start()).rejects.toThrow(/no candidates authorized|conservative candidate is not authorized/)
    expect(h.resolveDelegation).not.toHaveBeenCalled()
    expect(h.requests).toHaveLength(0)
  })

  it('does not trust a selector that returns an unauthorized route or mismatched candidate', async () => {
    const h = await setup()
    h.resolveDelegation.mockResolvedValueOnce({ selection: { provider: 'models', model: 'forbidden' }, candidateId: 'cheap', reason: 'quality-floor' })
    await expect(h.start()).rejects.toThrow('outside the captured parent policy')
    h.resolveDelegation.mockResolvedValueOnce({ selection: { provider: 'models', model: 'strong' }, candidateId: 'cheap', reason: 'quality-floor' })
    await expect(h.start()).rejects.toThrow('outside its captured candidate')
    expect(h.requests).toHaveLength(0)
  })

  it('keeps external AgentOptions-capable providers unchanged despite matching aliases and global Auto', async () => {
    const h = await setup({ native: false, rules: [RULE] })
    await h.start()
    expect(h.requests[0]).not.toHaveProperty('resolvedAgentOptions')
    expect(h.requests[0]).not.toHaveProperty('resolvedDelegatedPolicies')
    expect(h.requests[0]).not.toHaveProperty('resolvedModelSelection')
    expect(h.requests[0]).not.toHaveProperty('resolvedCreationSignal')
    expect(h.captureDelegation).not.toHaveBeenCalled()
  })

  it('strips caller-controlled resolved options, permission and cancellation lookalikes', async () => {
    const h = await setup({ auto: false })
    const forgedSignal = AbortSignal.abort(new Error('forged cancellation'))
    const forged = {
      parent: h.parent, prompt: [], signal: new AbortController().signal,
      descriptor: { version: 3, mode: 'one-shot', provider: 'forged' },
      resolvedAgentOptions: { provider: 'evil', model: 'evil' },
      resolvedDelegatedPolicies: { permissionPreset: 'danger-full-access', sandboxMode: 'danger-full-access', approvalPolicy: undefined },
      resolvedModelSelection: { decision: { source: 'auto', provider: 'evil', model: 'evil' } },
      resolvedCreationSignal: forgedSignal,
    } satisfies ResolvedSubagentStartRequest
    await h.ctx.subagents.start(h.provider.name, forged)
    expect(h.requests[0]?.resolvedAgentOptions).toEqual(h.parentOptions)
    expect(h.requests[0]?.resolvedModelSelection?.decision.source).toBe('inheritance')
    expect(h.requests[0]?.descriptor.provider).toBe('native-alias')
    expect(h.requests[0]?.resolvedCreationSignal).not.toBe(forgedSignal)
    expect(h.requests[0]?.resolvedDelegatedPolicies?.sandboxMode).toBeUndefined()
  })
})

describe('native optional capabilities and captured input', () => {
  it('rejects a native provider lacking AgentOptions support without registering it', async () => {
    const h = await setup()
    expect(() => h.ctx.subagents.registerProvider({
      ...h.provider, name: 'unsupported-native', capabilities: { ...h.provider.capabilities, agentOptions: false },
    })).toThrow('requires the provider to support agentOptions')
    expect(h.ctx.subagents.getProvider('unsupported-native')).toBeUndefined()
  })

  it('inherits without routing authority when session projections are absent', async () => {
    const h = await setup({ projections: false })
    await h.start()
    expect(h.requests[0]?.resolvedAgentOptions).toEqual(h.parentOptions)
    expect(h.requests[0]?.resolvedModelSelection).not.toHaveProperty('allowedModels')
    expect(h.resolveDelegation).not.toHaveBeenCalled()
    expect(() => {
      appendNativeChildSelection(h.ctx, h.parent.session, { decision: { source: 'inheritance' }, allowedModels: ALL_ALLOWED })
    }).toThrow('captured child model authority requires sessionProjections')
    expect(h.parent.session.snapshotEvents().some(event => event.type === 'subagent/model-selection')).toBe(false)
  })

  it.each(['auto', 'explicit'] as const)('refuses %s selection without the LLM service before provider creation', async (mode) => {
    const h = await setup({ llm: false })
    await expect(h.start(mode === 'explicit' ? { model: 'cheap' } : undefined)).rejects.toThrow('requires the llm service')
    expect(h.requests).toHaveLength(0)
    expect(h.resolveDelegation).not.toHaveBeenCalled()
  })

  it('refuses an explicit partial route when no effective model is inherited', async () => {
    const h = await setup()
    delete h.parentOptions.model
    await expect(h.start({ provider: 'models' })).rejects.toThrow('requires an effective provider and model')
    expect(h.resolveModel).not.toHaveBeenCalled()
    expect(h.requests).toHaveLength(0)
  })

  it('detaches text and image attachment data before classifier awaits and retains other block kinds', async () => {
    const h = await setup()
    const attachment = {
      attachmentId: brandString<ImageBlock['attachment']['attachmentId']>('captured-image'),
      mediaType: 'image/png' as const, bytes: 1, width: 1, height: 1,
    }
    const image: ImageBlock = { type: 'image', attachment }
    const text = { type: 'text' as const, text: 'original task' }
    const reasoning = { type: 'reasoning' as const, text: 'opaque caller block' }
    const prompt: ContentBlock[] = [text, image, reasoning]
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    h.resolveDelegation.mockImplementation(async (request) => {
      entered.resolve(undefined)
      await release.promise
      expect(request.prompt).toEqual([
        { type: 'text', text: 'original task' },
        { type: 'image', attachment: { attachmentId: 'captured-image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } },
        reasoning,
      ])
      expect(request.prompt[0]).not.toBe(text)
      expect(request.prompt[1]).not.toBe(image)
      expect(request.prompt[2]).toBe(reasoning)
      return { selection: { provider: 'models', model: 'cheap', reasoningEffort: ReasoningEffortId('low') }, candidateId: 'cheap', reason: 'quality-floor' }
    })
    const starting = h.ctx.subagents.start(h.provider.name, { parent: h.parent, prompt, signal: new AbortController().signal })
    try {
      await entered.promise
      text.text = 'changed after admission'
      attachment.bytes = 999
      release.resolve(undefined)
      await starting
      expect(h.requests).toHaveLength(1)
    } finally { release.resolve(undefined); await starting.catch(() => {}) }
  })

  it('settles a synchronous continuation admission fault and releases native startup ownership', async () => {
    const h = await setup({ auto: false })
    h.provider.prepareContinuable = () => Promise.resolve({})
    const failure = new Error('continuation admission failed synchronously')
    const start = vi.spyOn(continuationManager(h.ctx), 'startContinuable').mockImplementation(() => { throw failure })
    try {
      await expect(h.ctx.subagents.startContinuable({
        provider: h.provider.name, label: 'failed admission', request: { parent: h.parent, prompt: [] }, signal: new AbortController().signal,
      })).rejects.toBe(failure)
      await h.service.dispose()
      expect(h.requests).toHaveLength(0)
    } finally { start.mockRestore() }
  })

  it('joins an unpublished provider run when cancellation wins its return race and consumes its rejected result', async () => {
    const h = await setup({ auto: false })
    const controller = new AbortController()
    const entered = Promise.withResolvers<undefined>()
    const releaseProvider = Promise.withResolvers<undefined>()
    const disposing = Promise.withResolvers<undefined>()
    const releaseDisposal = Promise.withResolvers<undefined>()
    const lifecycle = vi.fn()
    h.ctx.on('subagent/start', lifecycle)
    h.ctx.on('subagent/end', lifecycle)
    h.offProvider()
    const dispose = vi.fn(async () => { disposing.resolve(undefined); await releaseDisposal.promise })
    h.ctx.subagents.registerProvider({ ...h.provider, start: async () => {
      entered.resolve(undefined)
      await releaseProvider.promise
      return { id: SessionId('unpublished-child'), localAgent: undefined,
        result: Promise.reject(new Error('unpublished run failed')), dispose }
    } })
    const starting = h.start(undefined, { signal: controller.signal })
    const rejected = expect(starting).rejects.toThrow('admission cancelled')
    let settled = false
    void starting.then(() => { settled = true }, () => { settled = true })
    try {
      await entered.promise
      controller.abort(new Error('admission cancelled'))
      releaseProvider.resolve(undefined)
      await disposing.promise
      expect(settled).toBe(false)
      expect(lifecycle).not.toHaveBeenCalled()
      releaseDisposal.resolve(undefined)
      await rejected
      expect(dispose).toHaveBeenCalledTimes(1)
      expect(lifecycle).not.toHaveBeenCalled()
    } finally {
      releaseProvider.resolve(undefined)
      releaseDisposal.resolve(undefined)
      await starting.catch(() => {})
    }
  })
})

describe('native creation snapshots and cancellation', () => {
  it('captures parent options, route authority and sandbox before classification awaits', async () => {
    const h = await setup()
    let sandboxMode: 'workspace-write' | 'danger-full-access' = 'workspace-write'
    h.ctx.provide('sandboxPolicy', { overrideOf: () => sandboxMode })
    h.ctx.provide('approval', {})
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    h.resolveDelegation.mockImplementation(async () => {
      entered.resolve(undefined)
      await release.promise
      return { selection: { provider: 'models', model: 'cheap', reasoningEffort: ReasoningEffortId('low') }, candidateId: 'cheap', reason: 'quality-floor' }
    })
    const starting = h.start()
    try {
      await entered.promise
      h.parentOptions.maxTokens = 999
      h.parentOptions.model = 'changed-parent'
      sandboxMode = 'danger-full-access'
      h.parent.session.append('subagent/model-selection-policy', { allowedModels: [{ provider: 'evil', model: 'later' }] })
      h.setAuto(false)
      release.resolve(undefined)
      await starting
      expect(h.requests[0]?.resolvedAgentOptions?.maxTokens).toBe(128)
      expect(h.requests[0]?.resolvedDelegatedPolicies).toMatchObject({ sandboxMode: 'workspace-write', approvalPolicy: 'never' })
      expect(h.requests[0]?.resolvedModelSelection?.allowedModels).toEqual(ALL_ALLOWED)
    } finally { release.resolve(undefined); await starting.catch(() => {}) }
  })

  it.each(['provider', 'llm', 'routing'] as const)('refuses %s replacement during classification before publishing', async (changed) => {
    const h = await setup()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    h.resolveDelegation.mockImplementation(async () => {
      entered.resolve(undefined); await release.promise
      return { selection: { provider: 'models', model: 'cheap', reasoningEffort: ReasoningEffortId('low') }, candidateId: 'cheap', reason: 'quality-floor' }
    })
    const starting = h.start()
    const rejected = expect(starting).rejects.toThrow(/changed during/)
    try {
      await entered.promise
      if (changed === 'provider') { h.offProvider(); h.ctx.subagents.registerProvider({ ...h.provider }) }
      else if (changed === 'llm') { h.offAdapter(); h.ctx.llm.registerAdapter(['models', 'other'], new h.Adapter()) }
      else await h.routing.dispose()
      release.resolve(undefined)
      await rejected
      expect(h.requests).toHaveLength(0)
    } finally { release.resolve(undefined); await starting.catch(() => {}) }
  })

  it.each(['caller', 'service'] as const)('cancels and joins pending classification when %s ends startup', async (owner) => {
    const h = await setup()
    const entered = Promise.withResolvers<undefined>()
    let closed = false
    h.resolveDelegation.mockImplementation(async (request) => {
      entered.resolve(undefined)
      try { return await waitForAbort(request.signal) } finally { closed = true }
    })
    const controller = new AbortController()
    const starting = h.start(undefined, { signal: controller.signal })
    const rejected = expect(starting).rejects.toThrow(/cancelled|disposed/)
    await entered.promise
    if (owner === 'caller') controller.abort(new Error('caller cancelled'))
    else await h.service.dispose()
    await rejected
    expect(closed).toBe(true)
    expect(h.requests).toHaveLength(0)
  })

  it('does not retroactively cancel a returned one-shot run on registry unload', async () => {
    const h = await setup({ auto: false })
    const controller = new AbortController()
    const run = await h.start(undefined, { signal: controller.signal })
    await h.service.dispose()
    expect(h.requests[0]?.resolvedCreationSignal?.aborted).toBe(true)
    expect(h.requests[0]?.signal).toBe(controller.signal)
    expect(controller.signal.aborted).toBe(false)
    expect(h.disposeRun).not.toHaveBeenCalled()
    await run.dispose()
  })

  it('resolves siblings independently when classifier replies settle out of order', async () => {
    const h = await setup()
    const first = Promise.withResolvers<ResolvedDelegationRouting>()
    const second = Promise.withResolvers<ResolvedDelegationRouting>()
    h.resolveDelegation.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    const a = h.start({ maxTokens: 10 })
    const b = h.start({ maxTokens: 20 })
    second.resolve({ selection: { provider: 'models', model: 'strong', reasoningEffort: ReasoningEffortId('high') }, candidateId: 'strong', reason: 'quality-floor' })
    await b
    first.resolve({ selection: { provider: 'models', model: 'cheap', reasoningEffort: ReasoningEffortId('low') }, candidateId: 'cheap', reason: 'quality-floor' })
    await a
    expect(h.requests.map(request => request.resolvedAgentOptions)).toEqual([
      { provider: 'models', model: 'strong', reasoningEffort: 'high', maxTokens: 20 },
      { provider: 'models', model: 'cheap', reasoningEffort: 'low', maxTokens: 10 },
    ])
  })
})
