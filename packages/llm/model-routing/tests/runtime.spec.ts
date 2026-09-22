import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context, symbols } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents, installModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, ModelSelection, ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { createUserMessage, LlmAdapter, markAgentLoopRequest, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, ImageBlock, LlmResolvedModelInfo, MessageSource, StreamChunk } from '@deepseek-ai/dsh-llm'
import { brandString } from '@deepseek-ai/dsh-brand'
import SessionStore, { Session, SessionId, SessionLogOffset } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createScope } from '@deepseek-ai/dsh-scope'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import { resolveRoutingConfig } from '../src/config.ts'
import type { Config } from '../src/config.ts'
import ModelRoutingRuntime from '../src/runtime.ts'
import type { ResolveDelegationRoutingRequest } from '../src/delegation-types.ts'
import { prepareDelegationRouting, resolvePreparedDelegationRouting } from '../src/delegation.ts'
import type { AutoSelection } from '../src/routing-state.ts'

const roots: Context[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
})

class MemorySettings extends SettingsProvider {
  private readonly doc: Record<string, unknown> = {}
  get writable(): boolean { return true }
  protected load(): Promise<Record<string, unknown>> { return Promise.resolve(this.doc) }
  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc[ns] = section
    return Promise.resolve()
  }
}

function configuration(): Config {
  return resolveRoutingConfig({
    enabled: true,
    policy: {
      candidates: [
        { id: 'small', selection: { provider: 'test', model: 'small' }, quality: 1, relativeCost: 1 },
        { id: 'medium', selection: { provider: 'test', model: 'big', reasoningEffort: ReasoningEffortId('low') }, quality: 2, relativeCost: 3 },
        { id: 'large', selection: { provider: 'test', model: 'big', reasoningEffort: ReasoningEffortId('high') }, quality: 3, relativeCost: 8 },
      ],
      qualityFloors: {
        efficiency: { routine: 1, standard: 1, complex: 3 },
        balanced: { routine: 1, standard: 2, complex: 3 },
        intelligence: { routine: 3, standard: 3, complex: 3 },
      },
      minConfidence: 0.8,
      conservativeCandidateId: 'large',
    },
    classifier: {
      selection: { provider: 'test', model: 'classifier' },
      maxInputBytes: 10_000,
      maxOutputTokens: 200,
      maxOutputBytes: 10_000,
      timeoutMs: 10_000,
    },
  })
}

function providerDefaultConfiguration(): Config {
  const config = configuration()
  if (config.policy === undefined) throw new Error('test policy missing')
  return resolveRoutingConfig({
    enabled: config.enabled,
    ...config.classifier === undefined ? {} : { classifier: config.classifier },
    policy: {
      ...config.policy,
      candidates: config.policy.candidates.map(candidate => candidate.id === 'small'
        ? { ...candidate, selection: { provider: 'test', model: 'big' } } : candidate),
    },
  })
}

function classification(complexity = 'routine', continuity = 'new-task', confidence = 0.9): string {
  return JSON.stringify({ complexity, continuity, confidence, reasonCode: continuity === 'same-task' ? 'continuation' : 'new-task' })
}

async function* textChunks(text: string): AsyncIterable<StreamChunk> {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function modelInfo(provider: string, model: string): LlmResolvedModelInfo {
  return {
    provider, id: model, name: model,
    inputModalities: model === 'big' ? ['text', 'image'] : ['text'],
    ...model !== 'big' ? {} : {
      reasoning: {
        efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }],
        defaultEffort: ReasoningEffortId('low'),
      },
    },
  }
}

async function harness(options: {
  config?: Config
  child?: boolean
  seed?: readonly SessionEvent[]
  inheritedSeed?: boolean
  classifier?: (options: GenerateOptions) => AsyncIterable<StreamChunk>
  metadata?: (provider: string, model: string, signal?: AbortSignal) => Promise<LlmResolvedModelInfo>
} = {}) {
  const ctx = new Context()
  roots.push(ctx)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  const llmFiber = ctx.plugin(LlmRuntime)
  await llmFiber
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(MemorySettings)
  const seen: GenerateOptions[] = []
  let answer = classification()
  const adapterRegistration = ctx.llm.registerAdapter(['test'], new class extends LlmAdapter {
    override resolveModel(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo> {
      return options.metadata?.(provider, model, signal) ?? Promise.resolve(modelInfo(provider, model))
    }
    override async * stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
      seen.push(request)
      yield* request.purpose === 'model-routing'
        ? options.classifier?.(request) ?? textChunks(answer)
        : textChunks('conversation reply')
    }
  }())
  const fiber = ctx.plugin(ModelRoutingRuntime, options.config ?? configuration())
  await fiber
  const session = ctx.sessions.create(SessionId('runtime-owner'), {
    ...options.seed === undefined ? {} : { seed: options.seed },
    meta: {
      ...options.child ? { origin: 'subagent' as const } : {},
      ...options.inheritedSeed ? { isSeeded: true } : {},
    },
    ...options.inheritedSeed ? { inheritedEventCount: SessionLogOffset(options.seed?.length ?? 0) } : {},
  })
  // These event-level tests use the real registry and Session; they do not drive an Agent inbox implementation.
  const agent = { id: session.id, session, options: { provider: 'test', model: 'big' } } as Agent
  const scope = createScope(ctx, agent)
  Object.assign(agent, { ctx: scope.ctx })
  const detach = await ctx.agents.register(agent)
  const selection: ModelSelectionRef = { current: { provider: 'test', model: 'big', reasoningEffort: ReasoningEffortId('high') }, assembled: undefined }
  installModelSelection(scope.ctx, selection)
  const events: SessionEvent[] = []
  ctx.on('session/event', (subject, event) => { if (subject === session) events.push(event) })
  const calls = () => seen.filter(call => call.purpose === 'model-routing')
  const decisions = () => events.flatMap(event => event.type === 'model/routing-decision' ? [event.data] : [])
  const claim = (text: string, source: MessageSource = { kind: 'user' }) => {
    agentEvents(ctx, agent).emit('agent/inbox/claimed', {
      message: createUserMessage({ content: [{ type: 'text', text }], source }), turn: 1,
    })
  }
  const resolve = async (signal = new AbortController().signal) => {
    const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent, signal })
    return { selection: selection.assembled, assembly, signal }
  }
  const dispatch = async (selected: ModelSelection, signal: AbortSignal, marked = true, sessionId = session.id) => {
    const config = await ctx.llm.resolveCallConfig(selected, signal)
    session.append('request/header', { header: { config }, reason: 'initial' })
    const request: GenerateOptions = { ...config, messages: session.deriveMessages(), sessionId, signal }
    for await (const _chunk of ctx.llm.stream(marked ? markAgentLoopRequest(request) : request)) { /* drain the observed dispatch */ }
  }
  return { ctx, fiber, llmFiber, adapterRegistration, session, agent, scope, detach, selection,
    events, seen, calls, decisions, claim, resolve, dispatch,
    answer: (text: string) => { answer = text },
    state: () => ctx.sessionProjections.stateOf(session, 'modelRouting'),
  }
}

function requireSelection(value: ModelSelection | undefined): ModelSelection {
  if (value === undefined) throw new Error('test expected a concrete selection')
  return value
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  signal.throwIfAborted()
  return new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => {
      const reason: unknown = signal.reason
      reject(reason instanceof Error ? reason : new Error('fixture aborted'))
    }, { once: true })
  })
}

type RuntimeHarness = Awaited<ReturnType<typeof harness>>

function delegationRequest(
  h: RuntimeHarness,
  overrides: Partial<ResolveDelegationRoutingRequest> = {},
): ResolveDelegationRoutingRequest {
  const capture = overrides.capture ?? h.ctx.modelRouting.captureDelegation(h.agent)
  if (capture === undefined) throw new Error('test expected a captured delegation preference')
  return {
    parent: h.agent, capture, eligibleCandidateIds: ['small', 'medium', 'large'],
    prompt: [{ type: 'text', text: 'isolated child task' }], signal: new AbortController().signal,
    ...overrides,
  }
}

function autoPreference(mode: AutoSelection['mode'] = 'balanced'): AutoSelection {
  const config = configuration()
  if (config.policy === undefined || config.classifier === undefined) throw new Error('test config missing')
  return { mode, policy: config.policy, classifier: config.classifier }
}

function imageBlock(): ImageBlock {
  return {
    type: 'image',
    attachment: {
      attachmentId: brandString<ImageBlock['attachment']['attachmentId']>('runtime-image'),
      mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    },
  }
}

function classifierTask(options: GenerateOptions): { task: string; previousTask?: string } {
  const text = options.messages[0]?.content[0]
  if (text?.type !== 'text') throw new Error('test expected the classifier JSON frame')
  return JSON.parse(text.text) as { task: string; previousTask?: string }
}

describe('ModelRoutingRuntime opt-in and routing', () => {
  it('does not classify manual or signal-free diagnostic assemblies', async () => {
    const h = await harness()
    h.claim('human task while manual')
    expect((await h.resolve()).selection).toEqual(h.selection.current)
    expect(h.calls()).toHaveLength(0)
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('a real task')
    await h.ctx.systemPrompt.assemble({ scope: h.agent, agent: h.agent })
    expect(h.calls()).toHaveLength(0)
    expect(h.decisions()).toHaveLength(0)
    expect(h.selection.assembled).toEqual(h.selection.current)
  })

  it('rejects disabled configuration and delegated children without appending intent', async () => {
    const disabled = await harness({ config: { enabled: false } })
    expect(disabled.ctx.modelRouting.isAvailable()).toBe(false)
    await expect(disabled.ctx.modelRouting.enable(disabled.agent, 'balanced')).rejects.toThrow('not configured')
    expect(disabled.state()?.intent.kind).toBe('manual')
    const child = await harness({ child: true })
    await expect(child.ctx.modelRouting.enable(child.agent, 'balanced')).rejects.toThrow('delegated children')
    expect(child.state()?.intent.kind).toBe('manual')
  })

  it('preflights classifier and conservative routes without making a classifier call', async () => {
    let missing = 'classifier'
    const h = await harness({ metadata: async (provider, model) => {
      if (model === missing) throw new Error('unavailable')
      return modelInfo(provider, model)
    } })
    await expect(h.ctx.modelRouting.enable(h.agent, 'balanced')).rejects.toThrow()
    expect(h.state()?.intent.kind).toBe('manual')
    missing = 'big'
    await expect(h.ctx.modelRouting.enable(h.agent, 'balanced')).rejects.toThrow()
    missing = ''
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    expect(h.state()?.intent.kind).toBe('auto')
    expect(h.calls()).toHaveLength(0)
  })

  it('captures settings on enabling and leaves both current selection and later settings independent', async () => {
    const h = await harness()
    const original = { ...h.selection.current }
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    const captured = h.state()?.intent
    await h.ctx.settings.update('model-routing', { enabled: false })
    expect(h.ctx.modelRouting.isAvailable()).toBe(false)
    expect(h.state()?.intent).toBe(captured)
    expect(h.selection.current).toEqual(original)
    h.claim('a simple new task')
    expect((await h.resolve()).selection).toEqual({ provider: 'test', model: 'small' })
    await expect(h.ctx.modelRouting.enable(h.agent, 'intelligence')).rejects.toThrow('not configured')
  })

  it('audits classification but records a decision only on the matching actual marked dispatch', async () => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('a routine request')
    const chosen = await h.resolve()
    expect(chosen.assembly.variables).toEqual({ provider: 'test', model: 'small' })
    expect(h.events.some(event => event.type === 'model/routing-request')).toBe(true)
    expect(h.events.some(event => event.type === 'model/routing-result')).toBe(true)
    expect(h.decisions()).toHaveLength(0)
    const selected = requireSelection(chosen.selection)
    await h.dispatch(selected, chosen.signal, false)
    await h.dispatch(selected, new AbortController().signal)
    await h.dispatch(selected, chosen.signal, true, SessionId('other-owner'))
    expect(h.decisions()).toHaveLength(0)
    await h.dispatch(selected, chosen.signal)
    expect(h.decisions()).toHaveLength(1)
    expect(h.decisions()[0]).toMatchObject({ candidateId: 'small', selection: selected, taskText: 'a routine request' })
    await h.dispatch(selected, chosen.signal)
    expect(h.decisions()).toHaveLength(1)
  })

  it('refuses changed model or effort before dispatch and retires the admission at the turn boundary', async () => {
    for (const changed of [
      { provider: 'test', model: 'small' },
      { provider: 'test', model: 'big', reasoningEffort: ReasoningEffortId('low') },
    ]) {
      const h = await harness()
      await h.ctx.modelRouting.enable(h.agent, 'intelligence')
      h.claim('complex work')
      const chosen = await h.resolve()
      expect(chosen.selection?.reasoningEffort).toBe('high')
      await expect(h.dispatch(changed, chosen.signal)).rejects.toThrow('Auto routing selection changed before prepared dispatch')
      expect(h.seen.filter(call => call.purpose === undefined)).toEqual([])
      expect(h.decisions()).toHaveLength(0)
      await agentEvents(h.ctx, h.agent).serial('agent/turn-stopping', { turn: 1, signal: chosen.signal })
      await h.dispatch(requireSelection(chosen.selection), chosen.signal)
      expect(h.decisions()).toHaveLength(0)
    }
  })

  it('pins committed tool/plugin continuations without reclassification', async () => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('first task')
    const chosen = await h.resolve()
    await h.dispatch(requireSelection(chosen.selection), chosen.signal)
    const first = h.decisions()[0]
    h.answer(classification('complex'))
    h.claim('background completion requesting expensive work', { kind: 'plugin', plugin: 'background' })
    const follow = await h.resolve()
    expect(follow.selection).toEqual(chosen.selection)
    await h.dispatch(requireSelection(follow.selection), follow.signal)
    expect(h.calls()).toHaveLength(1)
    expect(h.decisions()).toEqual([first])
  })

  it('preserves same-task binding while committing a distinct new task even on the same model', async () => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('first small task')
    const first = await h.resolve()
    await h.dispatch(requireSelection(first.selection), first.signal)
    h.answer(classification('complex', 'same-task'))
    h.claim('continue the original task')
    const continuation = await h.resolve()
    expect(continuation.selection).toEqual(first.selection)
    await h.dispatch(requireSelection(continuation.selection), continuation.signal)
    expect(h.decisions()[1]?.taskId).toBe(h.decisions()[0]?.taskId)
    expect(h.decisions()[1]?.reason).toBe('same-task')
    h.answer(classification())
    h.claim('a distinct small task')
    const next = await h.resolve()
    await h.dispatch(requireSelection(next.selection), next.signal)
    expect(h.decisions()[2]?.selection).toEqual(h.decisions()[0]?.selection)
    expect(h.decisions()[2]?.taskId).not.toBe(h.decisions()[0]?.taskId)
    expect(h.calls()).toHaveLength(3)
  })

  it.each(['malformed', classification('routine', 'new-task', 0.1)])('uses conservative policy after classification %s', async (answer) => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.answer(answer)
    h.claim('classify conservatively')
    const chosen = await h.resolve()
    expect(chosen.selection).toEqual({ provider: 'test', model: 'big', reasoningEffort: 'high' })
    await h.dispatch(requireSelection(chosen.selection), chosen.signal)
    expect(h.decisions()[0]?.reason).toBe('conservative')
  })

  it('uses conservative fallback without human text and does not classify plugin-only input', async () => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('goal continuation', { kind: 'plugin', plugin: 'goal' })
    const chosen = await h.resolve()
    expect(chosen.selection?.reasoningEffort).toBe('high')
    expect(h.calls()).toHaveLength(0)
    await h.dispatch(requireSelection(chosen.selection), chosen.signal)
    expect(h.decisions()[0]).not.toHaveProperty('taskText')
  })

  it('does not classify or retain an oversized partial human task', async () => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('界'.repeat(4_000))
    const chosen = await h.resolve()
    expect(chosen.selection?.reasoningEffort).toBe('high')
    expect(h.calls()).toHaveLength(0)
    await h.dispatch(requireSelection(chosen.selection), chosen.signal)
    expect(h.decisions()[0]).not.toHaveProperty('taskText')
  })

  it('filters absent candidates and resets effort instead of carrying the prior model effort', async () => {
    let smallMissing = false
    const h = await harness({ metadata: async (provider, model) => {
      if (smallMissing && model === 'small') throw new Error('not offered now')
      return modelInfo(provider, model)
    } })
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('routine work')
    const first = await h.resolve()
    expect(first.selection).toEqual({ provider: 'test', model: 'small' })
    await h.dispatch(requireSelection(first.selection), first.signal)
    smallMissing = true
    h.claim('another routine task')
    expect((await h.resolve()).selection).toEqual({ provider: 'test', model: 'big', reasoningEffort: 'low' })
  })

  it('fails closed when no live candidates remain', async () => {
    let fail = false
    const h = await harness({ metadata: async (provider, model) => {
      if (fail && model !== 'classifier') throw new Error('all candidates unavailable')
      return modelInfo(provider, model)
    } })
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    fail = true
    h.claim('routine work')
    await expect(h.resolve()).rejects.toThrow('no eligible candidate')
    expect(h.decisions()).toHaveLength(0)
  })

  it('requires affirmative image support for staged images and derived image history', async () => {
    for (const stageOnly of [true, false]) {
      const h = await harness({ metadata: async (provider, model) => {
        const info = modelInfo(provider, model)
        if (model === 'small') delete info.inputModalities
        return info
      } })
      await h.ctx.modelRouting.enable(h.agent, 'balanced')
      const message = createUserMessage({ content: [imageBlock()], source: { kind: 'user' } })
      if (stageOnly) agentEvents(h.ctx, h.agent).emit('agent/inbox/claimed', { message, turn: 1 })
      else h.session.append('user/message', message, { surfaceOp: 'append' })
      h.claim('routine work about this image')
      expect((await h.resolve()).selection).toEqual({ provider: 'test', model: 'big', reasoningEffort: 'low' })
    }
  })

  it('preserves configured provider-default identity and records its actual adapter effort', async () => {
    const h = await harness({ config: providerDefaultConfiguration() })
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('routine task')
    const first = await h.resolve()
    expect(first.selection).toEqual({ provider: 'test', model: 'big', reasoningEffort: ReasoningEffortId('low') })
    await h.dispatch(requireSelection(first.selection), first.signal)
    expect(h.decisions()[0]).toMatchObject({ candidateId: 'small', selection: { provider: 'test', model: 'big', reasoningEffort: 'low' } })
    h.answer(classification('complex', 'same-task'))
    h.claim('continue it')
    const follow = await h.resolve()
    expect(follow.selection).toEqual({ provider: 'test', model: 'big', reasoningEffort: 'low' })
    await h.dispatch(requireSelection(follow.selection), follow.signal)
    expect(h.decisions()[1]?.candidateId).toBe('small')
    expect(h.decisions()[1]?.reason).toBe('same-task')
  })
})

describe('ModelRoutingRuntime isolated delegation', () => {
  it('captures no manual preference and returns detached frozen Auto policy that survives later parent changes', async () => {
    const h = await harness()
    expect(h.ctx.modelRouting.captureDelegation(h.agent)).toBeUndefined()
    expect(h.calls()).toHaveLength(0)
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    const request = delegationRequest(h)
    const captured = request.capture
    const intent = h.state()?.intent
    if (intent?.kind !== 'auto') throw new Error('test expected Auto intent')
    expect(captured.selection).not.toBe(intent.selection)
    expect(captured.selection.policy).not.toBe(intent.selection.policy)
    expect(Object.isFrozen(captured)).toBe(true)
    expect(Object.isFrozen(captured.selection.policy.candidates[0]?.selection)).toBe(true)
    expect(Object.isFrozen(captured.selection.classifier.selection)).toBe(true)
    h.session.append('model/selection', { provider: 'test', model: 'big', reasoningEffort: ReasoningEffortId('low') })
    await h.ctx.settings.update('model-routing', { enabled: false })
    expect(h.ctx.modelRouting.captureDelegation(h.agent)).toBeUndefined()
    expect(h.ctx.modelRouting.isAvailable()).toBe(false)
    expect(await h.ctx.modelRouting.resolveDelegation(request)).toMatchObject({ candidateId: 'small' })
    expect(captured.selection.mode).toBe('balanced')
    expect(h.state()).toEqual({ intent: { kind: 'manual' }, activeTask: null })
  })

  it('rejects a foreign capture before invoking any classifier', async () => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    const request = delegationRequest(h)
    expect(() => h.ctx.modelRouting.resolveDelegation({
      ...request, capture: { ...request.capture, parentSessionId: SessionId('foreign-parent') },
    })).toThrow('another parent')
    expect(h.calls()).toHaveLength(0)
    expect(h.events.some(event => event.type === 'model/routing-request')).toBe(false)
  })

  it('classifies only the child task without parent history, images, previous-task text or cache affinity', async () => {
    const h = await harness()
    h.session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'PARENT_PRIVATE_HISTORY' }, imageBlock()], source: { kind: 'user' },
    }), { surfaceOp: 'append' })
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.answer(classification('complex'))
    h.claim('PARENT_ACTIVE_TASK')
    const parent = await h.resolve()
    await h.dispatch(requireSelection(parent.selection), parent.signal)
    const before = h.state()
    const header = h.session.requestHeader()
    expect(before?.activeTask?.candidateId).toBe('large')
    h.answer(classification('routine', 'same-task'))
    const result = await h.ctx.modelRouting.resolveDelegation(delegationRequest(h))
    expect(result).toMatchObject({ candidateId: 'small', selection: { provider: 'test', model: 'small' } })
    const call = h.calls().at(-1)
    if (call === undefined) throw new Error('missing classifier call')
    expect(classifierTask(call)).toEqual({ task: 'isolated child task' })
    expect(call.messages).toHaveLength(1)
    expect(call).not.toHaveProperty('tools')
    expect(JSON.stringify(call.messages)).not.toContain('PARENT_')
    expect(h.state()).toBe(before)
    expect(h.session.requestHeader()).toBe(header)
    expect(h.decisions()).toHaveLength(1)
  })

  it('filters candidates using affirmative CHILD image support rather than parent modalities', async () => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    const result = await h.ctx.modelRouting.resolveDelegation(delegationRequest(h, {
      prompt: [{ type: 'text', text: 'describe the child image' }, imageBlock()],
    }))
    expect(result).toMatchObject({
      candidateId: 'medium', selection: { provider: 'test', model: 'big', reasoningEffort: 'low' },
    })
    const call = h.calls()[0]
    if (call === undefined) throw new Error('missing classifier call')
    expect(classifierTask(call)).toEqual({ task: 'describe the child image' })
    expect(call.messages.flatMap(message => message.content).every(block => block.type === 'text')).toBe(true)
  })

  it.each(['empty', 'unauthorized-conservative', 'unavailable-conservative', 'no-image-conservative'] as const)(
    'refuses %s before paying for classification', async (kind) => {
      let changed = false
      const h = await harness({ metadata: async (provider, model) => {
        if (changed && kind === 'unavailable-conservative' && model === 'big') throw new Error('model unavailable')
        const info = modelInfo(provider, model)
        if (changed && kind === 'no-image-conservative') info.inputModalities = ['text']
        return info
      } })
      await h.ctx.modelRouting.enable(h.agent, 'balanced')
      changed = true
      const request = delegationRequest(h, {
        ...kind === 'empty' ? { eligibleCandidateIds: [] } : {},
        ...kind === 'unauthorized-conservative' ? { eligibleCandidateIds: ['small', 'medium'] } : {},
        ...kind === 'no-image-conservative' ? { prompt: [imageBlock()] } : {},
      })
      await expect(h.ctx.modelRouting.resolveDelegation(request)).rejects.toThrow('conservative combination')
      expect(h.calls()).toHaveLength(0)
      expect(h.events.some(event => event.type === 'model/routing-request')).toBe(false)
      expect(h.decisions()).toHaveLength(0)
    },
  )

  it.each(['not JSON', classification('routine', 'new-task', 0.1)])(
    'uses only the authorized conservative candidate after classifier result %s', async (answer) => {
      const h = await harness()
      await h.ctx.modelRouting.enable(h.agent, 'balanced')
      h.answer(answer)
      expect(await h.ctx.modelRouting.resolveDelegation(delegationRequest(h, { eligibleCandidateIds: ['large'] })))
        .toMatchObject({ candidateId: 'large', reason: 'conservative', selection: { model: 'big', reasoningEffort: 'high' } })
      expect(h.calls()).toHaveLength(1)
      expect(h.state()?.activeTask).toBeNull()
    },
  )

  it.each(['empty', 'oversized'] as const)('uses bounded conservative fallback for an %s child text', async (kind) => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    const prompt: ContentBlock[] = kind === 'empty' ? [] : [{ type: 'text', text: '界'.repeat(4000) }]
    expect(await h.ctx.modelRouting.resolveDelegation(delegationRequest(h, { prompt })))
      .toMatchObject({ candidateId: 'large', reason: 'conservative' })
    expect(h.calls()).toHaveLength(0)
  })

  it.each(['default', 'explicit'] as const)('materializes %s effort and preflights the captured child output cap', async (kind) => {
    const h = await harness({ config: kind === 'default' ? providerDefaultConfiguration() : configuration() })
    await h.ctx.modelRouting.enable(h.agent, kind === 'default' ? 'balanced' : 'intelligence')
    const preflight = vi.spyOn(h.ctx.llm, 'resolveCallConfig')
    try {
      const result = await h.ctx.modelRouting.resolveDelegation(delegationRequest(h, { maxTokens: 321 }))
      expect(result.selection).toEqual({ provider: 'test', model: 'big', reasoningEffort: kind === 'default' ? 'low' : 'high' })
      expect(preflight.mock.calls.map(([config]) => config.maxTokens)).toEqual([321, 321, 321])
      expect(h.calls()[0]?.maxTokens).toBe(200)
      expect(Object.isFrozen(result.selection)).toBe(true)
      expect(h.selection.current?.reasoningEffort).toBe('high')
    } finally {
      preflight.mockRestore()
    }
  })

  it('snapshots caller route, effort, policy, prompt, eligibility and output limits before the first await', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let block = false
    const h = await harness({ metadata: async (provider, model) => {
      if (block && model === 'small') { entered.resolve(undefined); await release.promise }
      return modelInfo(provider, model)
    } })
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    const captured = delegationRequest(h).capture
    const route: ModelSelection = { provider: 'test', model: 'small' }
    const classifierRoute: ModelSelection = { provider: 'test', model: 'classifier' }
    const capture = {
      ...captured,
      selection: {
        ...captured.selection,
        policy: {
          ...captured.selection.policy,
          candidates: captured.selection.policy.candidates.map(candidate => candidate.id === 'small'
            ? { ...candidate, selection: route } : candidate),
        },
        classifier: { ...captured.selection.classifier, selection: classifierRoute },
      },
    }
    const text = { type: 'text' as const, text: 'original isolated task' }
    const prompt: ContentBlock[] = [text]
    const eligible = ['small', 'medium', 'large']
    const request = { ...delegationRequest(h), capture, prompt, eligibleCandidateIds: eligible, maxTokens: 321 }
    const preflight = vi.spyOn(h.ctx.llm, 'resolveCallConfig')
    block = true
    const pending = h.ctx.modelRouting.resolveDelegation(request)
    try {
      await entered.promise
      route.provider = 'missing'
      route.model = 'mutated'
      route.reasoningEffort = ReasoningEffortId('high')
      classifierRoute.model = 'mutated-classifier'
      capture.selection.mode = 'intelligence'
      capture.selection.classifier.maxOutputTokens = 1
      text.text = 'mutated task'
      prompt.push(imageBlock())
      eligible.splice(0)
      request.maxTokens = 9999
      release.resolve(undefined)
      const result = await pending
      expect(result).toMatchObject({ candidateId: 'small', selection: { provider: 'test', model: 'small' } })
      expect(preflight.mock.calls.map(([config]) => config.maxTokens)).toEqual([321, 321, 321])
      const call = h.calls()[0]
      if (call === undefined) throw new Error('missing classifier call')
      expect(call.model).toBe('classifier')
      expect(call.maxTokens).toBe(200)
      expect(classifierTask(call)).toEqual({ task: 'original isolated task' })
    } finally {
      release.resolve(undefined)
      await pending.catch((_error: unknown) => { /* The assertion above owns an unexpected operation failure. */ })
      preflight.mockRestore()
    }
  })

  it('keeps concurrent sibling classifications and audit call ids independent when they settle in reverse order', async () => {
    const entered = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    const release = [Promise.withResolvers<undefined>(), Promise.withResolvers<undefined>()]
    const h = await harness({ classifier: async function* (options) {
      const index = classifierTask(options).task === 'first child' ? 0 : 1
      entered[index]!.resolve(undefined)
      await release[index]!.promise
      yield* textChunks(classification(index === 0 ? 'routine' : 'complex'))
    } })
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    const first = h.ctx.modelRouting.resolveDelegation(delegationRequest(h, { prompt: [{ type: 'text', text: 'first child' }] }))
    const second = h.ctx.modelRouting.resolveDelegation(delegationRequest(h, { prompt: [{ type: 'text', text: 'second child' }] }))
    let firstSettled = false
    void first.then(() => { firstSettled = true }, () => { firstSettled = true })
    try {
      await Promise.all(entered.map(item => item.promise))
      release[1]!.resolve(undefined)
      const secondResult = await second
      expect(secondResult.candidateId).toBe('large')
      expect(firstSettled).toBe(false)
      release[0]!.resolve(undefined)
      const firstResult = await first
      expect(firstResult.candidateId).toBe('small')
      expect(firstResult.classifierCallId).not.toBe(secondResult.classifierCallId)
      expect(h.events.flatMap(event => event.type === 'model/routing-result' ? [event.data.callId] : []))
        .toEqual([secondResult.classifierCallId, firstResult.classifierCallId])
      expect(h.events.flatMap(event => event.type === 'model/routing-request' ? [event.data.taskText] : []).sort())
        .toEqual(['first child', 'second child'])
      expect(h.state()?.activeTask).toBeNull()
      expect(h.decisions()).toHaveLength(0)
    } finally {
      for (const gate of release) gate.resolve(undefined)
      await Promise.allSettled([first, second])
    }
  })

  it.each(['preflight', 'classifier'] as const)('rejects adapter topology changes during %s', async (stage) => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let block = false
    const h = await harness({
      metadata: async (provider, model) => {
        if (block && stage === 'preflight' && model === 'small') { entered.resolve(undefined); await release.promise }
        return modelInfo(provider, model)
      },
      classifier: async function* () {
        if (stage === 'classifier') { entered.resolve(undefined); await release.promise }
        yield* textChunks(classification())
      },
    })
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    block = true
    const pending = h.ctx.modelRouting.resolveDelegation(delegationRequest(h))
    const rejected = expect(pending).rejects.toThrow('LLM routing changed')
    try {
      await entered.promise
      h.adapterRegistration.replace(['test', 'additional-route'])
      release.resolve(undefined)
      await rejected
      expect(h.calls()).toHaveLength(stage === 'preflight' ? 0 : 1)
      expect(h.decisions()).toHaveLength(0)
      expect(h.state()?.activeTask).toBeNull()
    } finally {
      release.resolve(undefined)
      await pending.catch((_error: unknown) => { /* The explicit rejection assertion owns this failure. */ })
    }
  })

  it('preserves first child delegation context on ordinary resume, resets inherited context on fork, and keeps the child fixed', async () => {
    const child = await harness({ child: true })
    expect(child.ctx.modelRouting.captureDelegation(child.agent)).toBeUndefined()
    const first = child.session.append('model/delegation-auto', { selection: autoPreference('balanced') })
    child.session.append('model/delegation-auto', { selection: autoPreference('intelligence') })
    const capture = child.ctx.modelRouting.captureDelegation(child.agent)
    expect(capture).toMatchObject({ parentSessionId: child.agent.id, intentSeq: first.seq, selection: { mode: 'balanced' } })
    child.claim('the child continues its own task')
    expect((await child.resolve()).selection).toEqual(child.selection.current)
    expect(child.calls()).toHaveLength(0)
    expect(child.state()?.intent.kind).toBe('manual')
    expect(await child.ctx.modelRouting.resolveDelegation(delegationRequest(child))).toMatchObject({ candidateId: 'small' })
    const seed = [...child.events]
    const resumed = await harness({ child: true, seed })
    expect(resumed.ctx.modelRouting.captureDelegation(resumed.agent)).toEqual(capture)
    expect((await resumed.resolve()).selection).toEqual(resumed.selection.current)
    expect(resumed.calls()).toHaveLength(0)
    const forked = await harness({ child: true, seed, inheritedSeed: true })
    expect(forked.ctx.modelRouting.captureDelegation(forked.agent)).toBeUndefined()
    const own = forked.session.append('model/delegation-auto', { selection: autoPreference('efficiency') })
    expect(forked.ctx.modelRouting.captureDelegation(forked.agent)).toMatchObject({
      intentSeq: own.seq, selection: { mode: 'efficiency' },
    })
  })

  it('does not enroll a fork in the ordinary parent Auto intent inherited in its seed', async () => {
    const parent = await harness()
    await parent.ctx.modelRouting.enable(parent.agent, 'balanced')
    const restored = await harness({ seed: [...parent.events] })
    expect(restored.ctx.modelRouting.captureDelegation(restored.agent)?.selection.mode).toBe('balanced')
    const forked = await harness({ seed: [...parent.events], inheritedSeed: true })
    expect(forked.ctx.modelRouting.captureDelegation(forked.agent)).toBeUndefined()
    expect(forked.state()?.intent.kind).toBe('manual')
  })
})

describe('ModelRoutingRuntime delegation operation lifetimes', () => {
  it.each(['enable', 'delegation'] as const)('does not cancel %s when an unrelated parent turn stops', async (operation) => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let waiting = false
    let ownedSignal: AbortSignal | undefined
    const h = await harness({
      metadata: async (provider, model, signal) => {
        if (waiting && operation === 'enable' && model === 'classifier') {
          ownedSignal = signal
          entered.resolve(undefined)
          await release.promise
        }
        return modelInfo(provider, model)
      },
      classifier: async function* (options) {
        ownedSignal = options.signal
        entered.resolve(undefined)
        await release.promise
        yield* textChunks(classification())
      },
    })
    if (operation === 'delegation') await h.ctx.modelRouting.enable(h.agent, 'balanced')
    waiting = true
    const pending = operation === 'enable' ? h.ctx.modelRouting.enable(h.agent, 'balanced')
      : h.ctx.modelRouting.resolveDelegation(delegationRequest(h))
    try {
      await entered.promise
      await agentEvents(h.ctx, h.agent).serial('agent/turn-stopping', { turn: 9, signal: new AbortController().signal })
      expect(ownedSignal?.aborted).toBe(false)
      release.resolve(undefined)
      await expect(pending).resolves.not.toBeNull()
      expect(h.state()?.intent.kind).toBe('auto')
      expect(h.calls()).toHaveLength(operation === 'enable' ? 0 : 1)
    } finally {
      release.resolve(undefined)
      await pending.catch((_error: unknown) => { /* The resolution assertion reports unexpected cancellation. */ })
    }
  })

  it.each(['caller', 'service', 'parent-scope', 'llm-service'] as const)(
    'aborts and joins delegated classification on %s cancellation while retaining observed usage before teardown', async (owner) => {
      const entered = Promise.withResolvers<undefined>()
      const cleanupEntered = Promise.withResolvers<undefined>()
      const cleanupRelease = Promise.withResolvers<undefined>()
      const caller = new AbortController()
      const usage = { inputTokens: 9, outputTokens: 1 }
      let closed = false
      const h = await harness({ classifier: async function* (options) {
        yield { type: 'usage', usage }
        entered.resolve(undefined)
        try {
          if (options.signal === undefined) throw new Error('missing test signal')
          await waitForAbort(options.signal)
        } finally {
          cleanupEntered.resolve(undefined)
          await cleanupRelease.promise
          closed = true
        }
      } })
      const runtime = h.ctx.modelRouting
      await runtime.enable(h.agent, 'balanced')
      const pending = runtime.resolveDelegation(delegationRequest(h, { signal: caller.signal }))
      const rejected = expect(pending).rejects.toThrow()
      let completed = false
      void pending.then(() => { completed = true }, () => { completed = true })
      let disposal: Promise<void> | undefined
      let disposed = false
      try {
        await entered.promise
        if (owner === 'caller') caller.abort(new Error('caller stopped delegation'))
        else {
          disposal = (owner === 'service' ? h.fiber.dispose()
            : owner === 'parent-scope' ? h.scope.dispose() : h.llmFiber.dispose()).then(() => {
            disposed = true
            expect(h.events.some(event => event.type === 'model/routing-result' && event.data.outcome === 'aborted')).toBe(true)
          })
        }
        await cleanupEntered.promise
        expect(closed).toBe(false)
        expect(completed).toBe(false)
        expect(disposed).toBe(false)
        expect(h.ctx.sessions.get(h.session.id)).toBe(h.session)
        cleanupRelease.resolve(undefined)
        await rejected
        await disposal
        expect(closed).toBe(true)
        expect(h.events.flatMap(event => event.type === 'model/routing-result' ? [event.data] : []))
          .toEqual([expect.objectContaining({ outcome: 'aborted', usage })])
        expect(h.decisions()).toHaveLength(0)
        if (owner === 'parent-scope') {
          await expect(Promise.resolve().then(() => runtime.resolveDelegation(delegationRequest(h))))
            .rejects.toThrow()
          expect(h.calls()).toHaveLength(1)
        }
        await h.detach()
        expect(() => runtime.captureDelegation(h.agent)).toThrow()
        expect(h.calls()).toHaveLength(1)
      } finally {
        caller.abort()
        cleanupRelease.resolve(undefined)
        await Promise.allSettled([pending, ...disposal === undefined ? [] : [disposal]])
      }
    },
  )

  it('aborts and joins enable preflight when the parent scope is disposed without committing intent', async () => {
    const entered = Promise.withResolvers<undefined>()
    const cleanupEntered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    let closed = false
    const h = await harness({ metadata: async (provider, model, signal) => {
      if (model !== 'classifier') return modelInfo(provider, model)
      entered.resolve(undefined)
      try {
        if (signal === undefined) throw new Error('missing test signal')
        return await waitForAbort(signal)
      } finally {
        cleanupEntered.resolve(undefined)
        await release.promise
        closed = true
      }
    } })
    const pending = h.ctx.modelRouting.enable(h.agent, 'balanced')
    const rejected = expect(pending).rejects.toThrow('parent scope disposed')
    let disposed = false
    let disposal: Promise<void> | undefined
    try {
      await entered.promise
      disposal = h.scope.dispose().then(() => { disposed = true })
      await cleanupEntered.promise
      expect(closed).toBe(false)
      expect(disposed).toBe(false)
      release.resolve(undefined)
      await rejected
      await disposal
      expect(closed).toBe(true)
      expect(h.state()?.intent.kind).toBe('manual')
      expect(h.events.some(event => event.type === 'model/auto-selection')).toBe(false)
      expect(h.calls()).toHaveLength(0)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([pending, ...disposal === undefined ? [] : [disposal]])
    }
  })

  it('still cancels a main-task resolver at its owning turn boundary', async () => {
    const entered = Promise.withResolvers<undefined>()
    let closed = false
    const h = await harness({ classifier: async function* (options) {
      entered.resolve(undefined)
      try {
        if (options.signal === undefined) throw new Error('missing test signal')
        await waitForAbort(options.signal)
      } finally {
        closed = true
      }
    } })
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('turn-owned main task')
    const pending = h.resolve()
    const rejected = expect(pending).rejects.toThrow('Agent activity ended')
    await entered.promise
    await agentEvents(h.ctx, h.agent).serial('agent/turn-stopping', { turn: 1, signal: new AbortController().signal })
    await rejected
    expect(closed).toBe(true)
    expect(h.ctx.modelRouting.captureDelegation(h.agent)).toBeDefined()
    expect(h.decisions()).toHaveLength(0)
  })
})

describe('ModelRoutingRuntime races and disposal', () => {
  it.each(['manual', 'auto', 'unrelated'] as const)('fences enable against a later %s event without using a broad log revision', async (change) => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const h = await harness({ metadata: async (provider, model) => {
      if (model === 'classifier') {
        entered.resolve(undefined)
        await release.promise
      }
      return modelInfo(provider, model)
    } })
    const pending = h.ctx.modelRouting.enable(h.agent, 'balanced')
    const settled = change === 'unrelated'
      ? expect(pending).resolves.toBeUndefined()
      : expect(pending).rejects.toThrow('intent changed during validation')
    try {
      await entered.promise
      if (change === 'manual') h.session.append('model/selection', { provider: 'test', model: 'small' })
      else if (change === 'auto') {
        const config = configuration()
        if (config.policy === undefined || config.classifier === undefined) throw new Error('test config missing')
        h.session.append('model/auto-selection', { mode: 'intelligence', policy: config.policy, classifier: config.classifier })
      } else h.session.append('request/header', { header: { config: { provider: 'test', model: 'small' } }, reason: 'initial' })
      release.resolve(undefined)
      await settled
      const intent = h.state()?.intent
      expect(intent?.kind).toBe(change === 'manual' ? 'manual' : 'auto')
      if (intent?.kind === 'auto') expect(intent.selection.mode).toBe(change === 'auto' ? 'intelligence' : 'balanced')
    } finally {
      release.resolve(undefined)
      await pending.catch(() => {})
    }
  })

  it('keeps the used effort stable when the adapter changes its omitted default mid-task', async () => {
    let defaultEffort = ReasoningEffortId('low')
    const h = await harness({ config: providerDefaultConfiguration(), metadata: async (provider, model) => {
      const info = modelInfo(provider, model)
      if (info.reasoning !== undefined) info.reasoning = { ...info.reasoning, defaultEffort }
      return info
    } })
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('initial routine task')
    const first = await h.resolve()
    await h.dispatch(requireSelection(first.selection), first.signal)
    defaultEffort = ReasoningEffortId('high')
    const toolStep = await h.resolve()
    expect(toolStep.selection?.reasoningEffort).toBe('low')
    await h.dispatch(requireSelection(toolStep.selection), toolStep.signal)
    expect(h.calls()).toHaveLength(1)
    h.answer(classification('complex', 'same-task'))
    h.claim('continue the original task')
    const continuation = await h.resolve()
    expect(continuation.selection?.reasoningEffort).toBe('low')
    await h.dispatch(requireSelection(continuation.selection), continuation.signal)
    expect(h.decisions()[1]?.candidateId).toBe('small')
    h.answer(classification())
    h.claim('new routine task')
    const next = await h.resolve()
    expect(next.selection).toEqual({ provider: 'test', model: 'big', reasoningEffort: ReasoningEffortId('high') })
    await h.dispatch(requireSelection(next.selection), next.signal)
    expect(h.decisions()[2]?.selection.reasoningEffort).toBe('high')
  })

  it('lets a manual change win the next assembly without misattributing an in-flight Auto dispatch', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const h = await harness({ classifier: async function* () {
      entered.resolve(undefined)
      await release.promise
      yield* textChunks(classification())
    } })
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('in-flight task')
    const pending = h.resolve()
    try {
      await entered.promise
      const manual: ModelSelection = { provider: 'test', model: 'big', reasoningEffort: ReasoningEffortId('low') }
      h.session.append('model/selection', manual)
      h.selection.current = manual
      release.resolve(undefined)
      const chosen = await pending
      expect(chosen.selection?.model).toBe('small')
      await h.dispatch(requireSelection(chosen.selection), chosen.signal)
      expect(h.decisions()).toHaveLength(0)
      expect(h.state()).toEqual({ intent: { kind: 'manual' }, activeTask: null })
      expect((await h.resolve()).selection).toEqual(manual)
      expect(h.calls()).toHaveLength(1)
    } finally {
      release.resolve(undefined)
      await pending.catch(() => {})
    }
  })

  it('propagates preflight cancellation instead of treating an aborted candidate as unavailable', async () => {
    const entered = Promise.withResolvers<undefined>()
    let block = false
    const h = await harness({ metadata: async (provider, model, signal) => {
      if (block && model === 'small') {
        entered.resolve(undefined)
        if (signal === undefined) throw new Error('missing test signal')
        return waitForAbort(signal)
      }
      return modelInfo(provider, model)
    } })
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    block = true
    h.claim('cancelled task')
    const controller = new AbortController()
    const result = h.resolve(controller.signal)
    const rejected = expect(result).rejects.toThrow('cancel candidate lookup')
    await entered.promise
    controller.abort(new Error('cancel candidate lookup'))
    await rejected
    expect(h.calls()).toHaveLength(0)
    expect(h.decisions()).toHaveLength(0)
  })

  it('joins in-flight classifier cancellation and removes listeners, settings and projection on disposal', async () => {
    const entered = Promise.withResolvers<undefined>()
    let closed = false
    const h = await harness({ classifier: async function* (options) {
      entered.resolve(undefined)
      try {
        if (options.signal === undefined) throw new Error('missing test signal')
        await waitForAbort(options.signal)
      } finally {
        closed = true
      }
    } })
    const runtime = h.ctx.modelRouting
    await runtime.enable(h.agent, 'balanced')
    h.claim('work cancelled by unloading the plugin')
    const pending = h.resolve()
    const rejected = expect(pending).rejects.toThrow('model routing disposed')
    await entered.promise
    await h.fiber.dispose()
    await rejected
    expect(closed).toBe(true)
    expect(h.ctx.get('modelRouting')).toBeUndefined()
    expect(h.state()).toBeUndefined()
    expect(h.ctx.settings.describe().some(section => section.ns === 'model-routing')).toBe(false)
    expect(runtime.isAvailable()).toBe(false)
    expect((await h.resolve()).selection).toEqual(h.selection.current)
    expect(h.decisions()).toHaveLength(0)
  })

  it('does not commit an unconsumed stream or an already-aborted dispatch', async () => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('a staged task')
    const controller = new AbortController()
    const chosen = await h.resolve(controller.signal)
    const request = markAgentLoopRequest({
      ...requireSelection(chosen.selection), messages: [], sessionId: h.session.id, signal: controller.signal,
    })
    const stream = h.ctx.llm.stream(request)
    expect(h.decisions()).toHaveLength(0)
    controller.abort(new Error('cancel before consuming stream'))
    for await (const _chunk of stream) { /* let the LLM service settle its aborted protocol */ }
    expect(h.decisions()).toHaveLength(0)
  })

  it('clears uncommitted proposals and claimed input at the turn boundary', async () => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('declined before dispatch')
    const first = await h.resolve()
    await agentEvents(h.ctx, h.agent).serial('agent/turn-stopping', { turn: 1, signal: first.signal })
    await h.dispatch(requireSelection(first.selection), first.signal)
    expect(h.decisions()).toHaveLength(0)
    expect((await h.resolve()).selection?.reasoningEffort).toBe('high')
    expect(h.calls()).toHaveLength(1)
  })

  it('removes an Agent proposal when that exact registry entry is disposed', async () => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('unpublished decision')
    const first = await h.resolve()
    await h.detach()
    await h.dispatch(requireSelection(first.selection), first.signal)
    expect(h.decisions()).toHaveLength(0)
    await expect(h.ctx.modelRouting.enable(h.agent, 'balanced')).rejects.toThrow('exact live Agent')
  })
})

describe('core routing edge cases', () => {
  it('rejects incomplete enabled settings before a Session can capture them', () => {
    const config = configuration()
    expect(() => resolveRoutingConfig({ enabled: true })).toThrow('requires a candidate policy and classifier')
    expect(() => resolveRoutingConfig({ enabled: true, policy: config.policy! })).toThrow('requires a candidate policy and classifier')
    expect(() => resolveRoutingConfig({ enabled: true, classifier: config.classifier! })).toThrow('requires a candidate policy and classifier')
    expect(resolveRoutingConfig({ enabled: false, policy: config.policy! })).toEqual({ enabled: false, policy: config.policy })
    expect(resolveRoutingConfig({ enabled: false, classifier: config.classifier! }))
      .toEqual({ enabled: false, classifier: config.classifier })
  })

  it('contains parent-effect cleanup rejection after successful enable without exposing its diagnostics', async () => {
    const h = await harness()
    const effect = h.agent.ctx.effect.bind(h.agent.ctx)
    const warned = Promise.withResolvers<undefined>()
    const warnings = vi.spyOn(h.ctx.logger, 'warn').mockImplementation(() => { warned.resolve(undefined) })
    const spy = vi.spyOn(h.agent.ctx, 'effect').mockImplementationOnce((execute, label) => effect(async () => {
      const dispose = execute()
      if (typeof dispose !== 'function') throw new Error('fixture requires a synchronous effect body')
      return async () => {
        await dispose()
        throw new Error('private cleanup diagnostic')
      }
    }, label))
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    await warned.promise
    expect(h.state()?.intent.kind).toBe('auto')
    expect(warnings).toHaveBeenCalledWith('model routing operation cleanup failed')
    expect(warnings.mock.calls.flat()).not.toContain('private cleanup diagnostic')
    spy.mockRestore()
    warnings.mockRestore()
  })

  it('refuses an unavailable routing projection rather than inventing manual or Auto state', async () => {
    const h = await harness()
    const state = vi.spyOn(h.ctx.sessionProjections, 'stateOf').mockReturnValueOnce(undefined)
    await expect(h.ctx.modelRouting.enable(h.agent, 'balanced')).rejects.toThrow('model routing projection is unavailable')
    state.mockRestore()
    expect(h.events).toEqual([])
    expect(h.calls()).toEqual([])
  })

  it('ignores intent events from an unowned or stale same-id Session without retiring the live admission', async () => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'intelligence')
    h.claim('a task with an exact high-effort admission')
    const chosen = await h.resolve()
    for (const session of [Session.create(SessionId('unowned-session')), Session.create(h.session.id)]) {
      const event = session.append('model/selection', { provider: 'test', model: 'small' })
      h.ctx.emit('session/event', session, event)
    }
    await expect(h.dispatch({ provider: 'test', model: 'small' }, chosen.signal))
      .rejects.toThrow('Auto routing selection changed before prepared dispatch')
    expect(h.decisions()).toEqual([])
    await h.dispatch(requireSelection(chosen.selection), chosen.signal)
    expect(h.decisions()).toHaveLength(1)
    expect(h.decisions()[0]?.selection.reasoningEffort).toBe('high')
  })

  it('joins separately claimed text blocks in order without dropping a newer claim at dispatch', async () => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('first fragment')
    h.claim('second fragment')
    const chosen = await h.resolve()
    expect(classifierTask(h.calls()[0]!)).toEqual({ task: 'first fragment\nsecond fragment' })
    h.claim('arrived after assembly')
    await h.dispatch(requireSelection(chosen.selection), chosen.signal)
    const next = await h.resolve()
    expect(classifierTask(h.calls()[1]!).task).toContain('arrived after assembly')
    await h.dispatch(requireSelection(next.selection), next.signal)
    expect(h.decisions()).toHaveLength(2)
  })

  it.each(['unavailable', 'aborted'] as const)('does not trust a previously pinned route after revalidation is %s', async (failure) => {
    let revalidating = false
    let smallLookups = 0
    const abort = new AbortController()
    const reason = new Error('pin revalidation cancelled')
    const h = await harness({ metadata: async (provider, model) => {
      if (revalidating && model === 'small' && ++smallLookups === 2) {
        if (failure === 'aborted') abort.abort(reason)
        throw new Error('previous pinned selection disappeared')
      }
      return modelInfo(provider, model)
    } })
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    h.claim('initial task')
    const initial = await h.resolve()
    await h.dispatch(requireSelection(initial.selection), initial.signal)
    revalidating = true
    h.answer('invalid classification')
    h.claim('later task')
    if (failure === 'aborted') {
      await expect(h.resolve(abort.signal)).rejects.toBe(reason)
      expect(h.calls()).toHaveLength(1)
    } else {
      expect((await h.resolve()).selection).toEqual({ provider: 'test', model: 'big', reasoningEffort: ReasoningEffortId('high') })
      expect(h.calls()).toHaveLength(2)
    }
    expect(h.decisions()).toHaveLength(1)
  })

  it.each(['main', 'delegation'] as const)('refuses capture when the %s projection is unavailable', async (missing) => {
    const h = await harness()
    const original = h.ctx.sessionProjections.stateOf.bind(h.ctx.sessionProjections)
    const state = vi.spyOn(h.ctx.sessionProjections, 'stateOf').mockImplementation((session, key) => {
      if (key === (missing === 'main' ? 'modelRouting' : 'modelRoutingDelegation')) return undefined
      return original(session, key)
    })
    expect(() => h.ctx.modelRouting.captureDelegation(h.agent)).toThrow('routing projection is unavailable')
    state.mockRestore()
    expect(h.calls()).toEqual([])
  })

  it('joins isolated multi-block prompt text without copying non-text blocks into the classifier', async () => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    await h.ctx.modelRouting.resolveDelegation(delegationRequest(h, {
      prompt: [{ type: 'text', text: 'first fragment' }, imageBlock(), { type: 'text', text: 'second fragment' }],
    }))
    expect(classifierTask(h.calls()[0]!)).toEqual({ task: 'first fragment\nsecond fragment' })
  })

  it.each([false, true])('checks the identity of an unwrapped LLM capability with disappearance=%s', async (disappear) => {
    const h = await harness()
    await h.ctx.modelRouting.enable(h.agent, 'balanced')
    const prepared = prepareDelegationRouting(delegationRequest(h))
    // Cordis metadata contexts may expose an already-unwrapped capability; identity is still mandatory.
    const raw = Reflect.get(h.ctx.llm, symbols.original) as LlmRuntime
    expect(raw).toBeDefined()
    const direct = h.ctx.extend({ llm: raw, get: () => disappear ? undefined : raw })
    const pending = resolvePreparedDelegationRouting(direct, prepared, new AbortController().signal)
    if (disappear) {
      await expect(pending).rejects.toThrow('LLM routing changed')
      expect(h.calls()).toEqual([])
    } else {
      expect((await pending).selection).toEqual({ provider: 'test', model: 'small' })
      expect(h.calls()).toHaveLength(1)
    }
  })
})
