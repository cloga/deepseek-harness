/** Session-owned Auto resolution and dispatch-confirmed task bindings. */

import { randomUUID } from 'node:crypto'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection, ModelSelectionResolution } from '@deepseek-ai/dsh-agent'
import { brandString } from '@deepseek-ai/dsh-brand'
import { contentHasImage, isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmCallConfig, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionSeq, UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-settings'
import { classifyRoutingTask } from './classifier.ts'
import { Config, MODEL_ROUTING_SETTINGS_NAMESPACE, resolveRoutingConfig } from './config.ts'
import { selectAutoModel } from './policy.ts'
import { installModelRoutingProjection } from './projection.ts'
import { resolveEligibleCombinations } from './eligibility.ts'
import {
  captureDelegationRouting, delegationRoutingProjection, prepareDelegationRouting, resolvePreparedDelegationRouting,
} from './delegation.ts'
import type { DelegationRoutingCapture, ResolveDelegationRoutingRequest, ResolvedDelegationRouting } from './delegation-types.ts'
import type { AutoSelection, ModelRoutingState, RoutingTaskDecision, RoutingTaskId } from './routing-state.ts'
import type { ModelRoutingMode, RoutingCandidate } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Explicit Session Auto opt-in and task-aware request resolution. */
    modelRouting: ModelRoutingRuntime
  }
}

interface ClaimedInput {
  readonly intentSeq: SessionSeq
  /** Undefined when complete task text exceeded the captured classifier budget. */
  readonly text: string | undefined
  readonly image: boolean
}

interface PendingDecision {
  readonly proposal: Readonly<ModelSelection>
  readonly decision: RoutingTaskDecision
  readonly signal: AbortSignal
  readonly input: ClaimedInput | undefined
}

interface OwnedWork {
  readonly agent: Agent
  readonly lifetime: 'turn' | 'agent'
  readonly promise: Promise<unknown>
}

function selectionOf(config: LlmCallConfig): ModelSelection {
  return {
    provider: config.provider,
    model: config.model,
    ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
  }
}

function sameSelection(left: Readonly<ModelSelection>, right: Readonly<ModelSelection>): boolean {
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

/** Host service whose durable policies change only through an explicit Session choice. */
export class ModelRoutingRuntime extends Service {
  static inject = ['agents', 'llm', 'sessionProjections']
  static Config = Config

  private source: () => Config
  private readonly lifetime = new AbortController()
  private readonly work = new Map<AbortController, OwnedWork>()
  private readonly claimed = new Map<Agent, ClaimedInput>()
  private readonly pending = new Map<Agent, PendingDecision>()

  constructor(ctx: Context, config: Config) {
    super(ctx, 'modelRouting')
    const entry = resolveRoutingConfig(config)
    this.source = () => entry
    installModelRoutingProjection(ctx)
    ctx.sessionProjections.register(delegationRoutingProjection)
    ctx.inject(['settings'], (settingsCtx) => {
      settingsCtx.settings.installSection(ctx, MODEL_ROUTING_SETTINGS_NAMESPACE, Config, entry, {
        setSource: (source) => { this.source = source },
        validate: (value) => { resolveRoutingConfig(value) },
        // Only enable() captures the settings source; committed Sessions keep their policy.
        onChange: () => {},
      })
    })
    ctx.on('agent/inbox/claimed', ({ agent, message }) => { this.stage(agent, message) })
    ctx.on('model-selection/resolve', (payload, next) => {
      const state = this.state(payload.agent)
      if (state.intent.kind !== 'auto' || payload.signal === undefined
        || payload.agent.session.header.origin === 'subagent') return next()
      const intent = state.intent
      const input = this.claimed.get(payload.agent)
      const capturedInput = input?.intentSeq === intent.seq ? input : undefined
      return this.own(payload.agent, payload.signal, signal => this.resolve(
        payload, intent, state.activeTask, capturedInput, signal,
      ))
    })
    ctx.on('llm/stream', (options, next) => this.observeDispatch(options, next), { global: true, prepend: true })
    ctx.on('agent/turn-stopping', ({ agent }) => { this.clearAgent(agent) })
    ctx.on('agent/disposed', ({ agent }) => { this.clearAgent(agent, true) })
    ctx.effect(() => async () => {
      this.lifetime.abort(new Error('model routing disposed'))
      this.claimed.clear()
      this.pending.clear()
      await Promise.allSettled([...this.work.values()].map(item => item.promise))
      this.work.clear()
    }, 'model-routing: cancel and join resolution')
  }

  /**
   * Report configuration readiness without network access or predicting a model.
   * @returns Whether future explicit Auto selections have the required configuration.
   */
  isAvailable(): boolean {
    const current = this.source()
    return !this.lifetime.signal.aborted && current.enabled && current.policy !== undefined && current.classifier !== undefined
  }

  /**
   * Validate classifier/conservative routes, then capture the current policy for one Session.
   * Subsequent settings edits do not replace this durable selection.
   * @param agent - Exact live top-level Agent receiving the user's opt-in.
   * @param mode - Selected policy tradeoff.
   * @param signal - Optional cancellation before the intent commit.
   * @returns Fulfillment after the Auto intent is appended; no model call is made.
   */
  async enable(agent: Agent, mode: ModelRoutingMode, signal?: AbortSignal): Promise<void> {
    if (agent.session.header.origin === 'subagent') throw new Error('Auto routing is unavailable for delegated children')
    this.assertLive(agent)
    const priorIntent = this.state(agent).intent
    const current = resolveRoutingConfig(this.source())
    if (!current.enabled || current.policy === undefined || current.classifier === undefined) {
      throw new Error('Auto routing is not configured or enabled')
    }
    const selection: AutoSelection = { mode, policy: current.policy, classifier: current.classifier }
    await this.own(agent, signal, async (ownedSignal) => {
      await this.ctx.llm.resolveCallConfig({ ...selection.classifier.selection }, ownedSignal)
      ownedSignal.throwIfAborted()
      // parseRoutingPolicy validated this exact referent before enable() could capture it.
      const conservative = selection.policy.candidates.find(
        candidate => candidate.id === selection.policy.conservativeCandidateId,
      ) as RoutingCandidate
      await this.ctx.llm.resolveCallConfig({ ...conservative.selection }, ownedSignal)
      ownedSignal.throwIfAborted()
      this.assertLive(agent)
      if (this.state(agent).intent !== priorIntent) throw new Error('model routing intent changed during validation; retry the selection')
      agent.session.append('model/auto-selection', selection)
    }, 'agent')
  }

  /**
   * Capture an ordinary parent's Auto intent or a child's creation-owned delegation preference.
   * @param parent - Exact live direct parent of the proposed delegation.
   * @returns Detached policy and parent-local identity, or undefined when Auto is inapplicable.
   */
  captureDelegation(parent: Agent): DelegationRoutingCapture | undefined {
    this.assertLive(parent)
    return captureDelegationRouting(this.ctx, parent)
  }

  /**
   * Resolve an isolated child proposal without changing the parent's conversation route.
   * The native owner separately enforces authorization and child-creation admission.
   * @param request - Captured parent policy, authorized IDs and isolated child input.
   * @returns A materialized model/effort proposal with classifier-audit attribution.
   */
  resolveDelegation(request: ResolveDelegationRoutingRequest): Promise<ResolvedDelegationRouting> {
    this.assertLive(request.parent)
    request.signal.throwIfAborted()
    const prepared = prepareDelegationRouting(request)
    return this.own(request.parent, request.signal, async (signal) => {
      const result = await resolvePreparedDelegationRouting(this.ctx, prepared, signal)
      signal.throwIfAborted()
      this.assertLive(prepared.parent)
      return result
    }, 'agent')
  }

  private state(agent: Agent): ModelRoutingState {
    const state = this.ctx.sessionProjections.stateOf(agent.session, 'modelRouting')
    if (state === undefined) throw new Error('model routing projection is unavailable')
    return state
  }

  private assertLive(agent: Agent): void {
    this.lifetime.signal.throwIfAborted()
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error('model routing requires the exact live Agent')
  }

  private own<T>(
    agent: Agent,
    signal: AbortSignal | undefined,
    run: (signal: AbortSignal) => Promise<T>,
    lifetime: 'turn' | 'agent' = 'turn',
  ): Promise<T> {
    this.assertLive(agent)
    const controller = new AbortController()
    const ownedSignal = AbortSignal.any([this.lifetime.signal, controller.signal, ...signal === undefined ? [] : [signal]])
    ownedSignal.throwIfAborted()
    // Register before scheduling work, so an already-unloading parent cannot start a paid call.
    const disposeParent = lifetime === 'agent' ? agent.ctx.effect(() => async () => {
      controller.abort(new Error('model routing parent scope disposed'))
      await Promise.allSettled([promise])
    }, 'model-routing: join agent-scoped operation') : undefined
    const promise = Promise.resolve().then(() => {
      ownedSignal.throwIfAborted()
      return run(ownedSignal)
    })
    this.work.set(controller, { agent, lifetime, promise })
    const release = async () => {
      this.work.delete(controller)
      await disposeParent?.()
    }
    void promise.then(release, release).catch((_error: unknown) => {
      // Cleanup never exposes provider diagnostics through this lifecycle logger.
      this.ctx.logger.warn('model routing operation cleanup failed')
    })
    return promise
  }

  private clearAgent(agent: Agent, includeAgentLifetime = false): void {
    this.claimed.delete(agent)
    this.pending.delete(agent)
    for (const [controller, item] of this.work) {
      if (item.agent === agent && (includeAgentLifetime || item.lifetime === 'turn')) {
        controller.abort(new Error('model routing Agent activity ended'))
      }
    }
  }

  private stage(agent: Agent, message: UserMessage): void {
    if (this.lifetime.signal.aborted || agent.session.header.origin === 'subagent' || message.source.kind !== 'user') return
    const state = this.state(agent)
    if (state.intent.kind !== 'auto') return
    const previous = this.claimed.get(agent)
    const sameIntent = previous?.intentSeq === state.intent.seq ? previous : undefined
    let text = sameIntent?.text ?? ''
    let overLimit = sameIntent !== undefined && sameIntent.text === undefined
    for (const block of message.content) {
      if (block.type !== 'text' || overLimit) continue
      const bytes = Buffer.byteLength(text, 'utf8') + Buffer.byteLength(block.text, 'utf8') + (text.length === 0 ? 0 : 1)
      if (bytes > state.intent.selection.classifier.maxInputBytes) overLimit = true
      else text = text.length === 0 ? block.text : `${text}\n${block.text}`
    }
    this.claimed.set(agent, {
      intentSeq: state.intent.seq,
      text: overLimit ? undefined : text,
      image: sameIntent?.image === true || contentHasImage(message.content),
    })
  }

  private async candidates(
    agent: Agent,
    intent: AutoSelection,
    input: ClaimedInput | undefined,
    signal: AbortSignal,
  ): Promise<Map<string, ModelSelection>> {
    const image = input?.image === true || agent.session.deriveMessages().some(message => contentHasImage(message.content))
    return resolveEligibleCombinations(this.ctx.llm, intent.policy.candidates, { images: image }, signal)
  }

  private async resolve(
    payload: ModelSelectionResolution,
    intent: Extract<ModelRoutingState['intent'], { kind: 'auto' }>,
    active: RoutingTaskDecision | null,
    input: ClaimedInput | undefined,
    signal: AbortSignal,
  ): Promise<ModelSelection> {
    const agent = payload.agent
    this.pending.delete(agent)
    const available = await this.candidates(agent, intent.selection, input, signal)
    signal.throwIfAborted()
    const priorCandidate = active === null ? undefined
      : intent.selection.policy.candidates.find(candidate => candidate.id === active.candidateId)
    const latest = agent.session.requestHeader()?.config
    let priorStillActual = false
    if (active !== null && priorCandidate !== undefined && available.has(active.candidateId)
      && active.selection.provider === priorCandidate.selection.provider && active.selection.model === priorCandidate.selection.model
      && (priorCandidate.selection.reasoningEffort === undefined
        || active.selection.reasoningEffort === priorCandidate.selection.reasoningEffort)
      && (latest === undefined || sameSelection(active.selection, latest))) {
      try {
        // A captured provider default may now differ; validate and pin the already-used actual effort.
        const pinned = await this.ctx.llm.resolveCallConfig({ ...active.selection }, signal)
        signal.throwIfAborted()
        priorStillActual = sameSelection(active.selection, pinned)
      } catch (_error: unknown) {
        signal.throwIfAborted()
      }
    }
    if (input === undefined && priorStillActual && active !== null) {
      // Tool/plugin continuations do not classify or create a new task boundary.
      return { ...active.selection }
    }
    const classified = input?.text !== undefined && input.text.length > 0
      ? await classifyRoutingTask(this.ctx, intent.selection.classifier, {
        session: agent.session,
        intentSeq: intent.seq,
        taskText: input.text,
        ...active?.taskText === undefined ? {} : { previousTaskText: active.taskText },
        signal,
      })
      : undefined
    signal.throwIfAborted()
    const classification = classified?.outcome === 'success' ? classified.classification : undefined
    const selected = selectAutoModel(intent.selection.policy, {
      mode: intent.selection.mode,
      ...priorStillActual && priorCandidate !== undefined ? { current: priorCandidate.selection } : {},
      eligibleCandidateIds: [...available.keys()],
      ...classification === undefined ? {} : { classification },
    })
    const retainsBinding = active !== null && priorStillActual
      && (selected.reason === 'same-task' || selected.reason === 'uncertain-current')
    const proposal = retainsBinding ? active.selection : selected.selection
    const resolved = retainsBinding ? active.selection : available.get(selected.candidateId) as ModelSelection
    const sameTask = active !== null && classification !== undefined
      && classification.confidence >= intent.selection.policy.minConfidence
      && classification.reasonCode !== 'uncertain' && classification.continuity === 'same-task'
    const decision: RoutingTaskDecision = {
      taskId: sameTask ? active.taskId : brandString<RoutingTaskId>(randomUUID()),
      intentSeq: intent.seq,
      selection: { ...resolved },
      candidateId: selected.candidateId,
      reason: selected.reason,
      ...classified?.callId === undefined ? {} : { classifierCallId: classified.callId },
      ...input?.text === undefined || input.text.length === 0
        ? {}
        : { taskText: sameTask && active.taskText !== undefined ? active.taskText : input.text },
    }
    signal.throwIfAborted()
    this.assertLive(agent)
    // signal was required by the event entry before resolution started.
    this.pending.set(agent, { proposal, decision, signal: payload.signal as AbortSignal, input })
    return { ...proposal }
  }

  private async * observeDispatch(options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> {
    if (!this.lifetime.signal.aborted && isAgentLoopRequest(options) && options.sessionId !== undefined) {
      const agent = this.ctx.agents.get(options.sessionId)
      const pending = agent === undefined ? undefined : this.pending.get(agent)
      if (agent !== undefined && pending !== undefined && options.signal === pending.signal) {
        this.pending.delete(agent)
        if (this.claimed.get(agent) === pending.input) this.claimed.delete(agent)
        if (!pending.signal.aborted && options.provider === pending.proposal.provider && options.model === pending.proposal.model
          && (pending.proposal.reasoningEffort === undefined || options.reasoningEffort === pending.proposal.reasoningEffort)) {
          agent.session.append('model/routing-decision', {
            ...pending.decision,
            selection: selectionOf(options),
          })
        }
      }
    }
    yield* next()
  }
}

export default ModelRoutingRuntime
