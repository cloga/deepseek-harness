/** One captured native child route, resolved before creation and never recomputed on resume. */

import { symbols, type Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { AutoSelection, RoutingCallId } from '@deepseek-ai/dsh-model-routing'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  captureDelegatedPolicyOverrides, mergeChildAgentOptions, parentAgentOptionsForDelegation, resolveChildDepth,
} from './child-agent.ts'
import type { DelegatedPolicyOverrides } from './child-agent.ts'
import { captureSubagentModelRule } from './model-rules.ts'
import type { SubagentModelRule } from './model-rules.ts'
import type { AllowedModelRoute } from './model-selection-policy.ts'
import { recordSubagentModelSelection, subagentModelSelectionPolicy } from './model-selection-state.ts'
import type { SubagentProvider, SubagentStartRequest } from './types.ts'

/** A resolved creation choice; actual model dispatch is recorded by request/header. */
export interface ChildModelSelection {
  readonly source: 'request' | 'parent-rule' | 'auto' | 'inheritance'
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: ReasoningEffortId
  readonly candidateId?: string
  readonly parentClassifierCallId?: RoutingCallId
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Child-local resolved creation decision, not a claim that a request was dispatched. */
    'subagent/model-selection': ChildModelSelection
  }
}

/** Child-local evidence and captured authority seeded before its tools are composed. */
export interface NativeChildModelSelection {
  readonly decision: ChildModelSelection
  readonly allowedModels?: readonly AllowedModelRoute[]
  /** Delegation preference only: this does not enable Auto for the child's own requests. */
  readonly delegationAuto?: AutoSelection
}

/** Complete native creation options; absence of effort must never inherit again. */
export interface ResolvedNativeChildSelection {
  readonly agentOptions: AgentOptions
  readonly delegatedPolicies: DelegatedPolicyOverrides
  readonly modelSelection: NativeChildModelSelection
}

/** Synchronous captured inputs plus one asynchronous resolution owned by native creation. */
export interface CapturedNativeChildSelection {
  /** Recheck captured provider and LLM ownership immediately before native creation. */
  assertCurrent(): void
  /** Remove the creation-owned topology observer after success or rollback. */
  dispose(): void
  /**
   * Resolve and preflight without reading new parent options, settings or permission state.
   * @param signal - Child-start cancellation covering classifier work and target validation.
   * @returns Complete options and creation evidence.
   */
  resolve(signal: AbortSignal): Promise<ResolvedNativeChildSelection>
}

function hasLlmSelection(options: AgentOptions | undefined): boolean {
  return options?.provider !== undefined || options?.model !== undefined || options?.reasoningEffort !== undefined
}

function identity(value: object | undefined): unknown {
  return value === undefined ? undefined : Reflect.get(value, symbols.original) ?? value
}

function selectedRoute(options: AgentOptions): Pick<ChildModelSelection, 'provider' | 'model' | 'reasoningEffort'> {
  return {
    ...options.provider === undefined ? {} : { provider: options.provider },
    ...options.model === undefined ? {} : { model: options.model },
    ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
  }
}

/**
 * Capture native precedence and authority synchronously, before classifier or adapter awaits.
 * The provider marker, not its registry name or generic AgentOptions capability, admits Auto.
 * @param ctx - Registry-owned Host context.
 * @param provider - Exact native provider captured by the registry.
 * @param request - Original consumer intent; no caller-supplied resolved fields are consulted.
 * @param rules - Current validated deterministic parent rules.
 * @param assertProvider - Verify the captured provider still owns its registry name.
 * @returns One independent child resolution, or undefined for an external provider.
 */
export function captureNativeChildSelection(
  ctx: Context,
  provider: SubagentProvider,
  request: Omit<SubagentStartRequest, 'signal'>,
  rules: readonly SubagentModelRule[] | undefined,
  assertProvider: () => void,
): CapturedNativeChildSelection | undefined {
  if (provider.nativeModelSelection === undefined) return undefined
  const parent = request.parent
  resolveChildDepth(parent, request.maxDepth)
  const parentOptions = parentAgentOptionsForDelegation(parent)
  const requested = request.agentOptions === undefined ? undefined : { ...request.agentOptions }
  const delegatedPolicies = captureDelegatedPolicyOverrides(parent)
  const projections = ctx.get('sessionProjections')
  const allowedModels = projections === undefined ? undefined : subagentModelSelectionPolicy(projections, parent.session)
  const providerDefaults = provider.agentRouteDefaults
  const { reasoningEffort: _parentEffort, ...withoutParentEffort } = parentOptions
  const baseline = providerDefaults === undefined ? parentOptions : { ...withoutParentEffort, ...providerDefaults }
  const inherited = mergeChildAgentOptions(baseline, requested)
  const explicit = hasLlmSelection(requested) || providerDefaults !== undefined
  const ruleOptions = explicit ? undefined : captureSubagentModelRule(rules, parentOptions, requested)
  const modelRouting = ctx.get('modelRouting')
  // Preference propagates independently from permission and from this invocation's selected source.
  const delegationCapture = modelRouting?.captureDelegation(parent)
  const autoCapture = !explicit && ruleOptions === undefined && provider.nativeModelSelection === 'spawn'
    && request.disableAutoModelSelection !== true && allowedModels !== undefined
    ? delegationCapture
    : undefined
  const eligibleCandidateIds = autoCapture?.selection.policy.candidates.filter(candidate => allowedModels?.some(route =>
    route.provider === candidate.selection.provider && route.model === candidate.selection.model)).map(candidate => candidate.id)
  // The start request owns its content; detach the classifier-relevant text and image references before awaits.
  const prompt = request.prompt.map(block => block.type === 'text' ? { ...block }
    : block.type === 'image' ? { ...block, attachment: { ...block.attachment } } : block)
  const llm = ctx.get('llm')
  const llmIdentity = identity(llm)
  const routingIdentity = identity(modelRouting)
  const topology = { changed: false }
  const dispose = ctx.on('llm/adapters-updated', () => { topology.changed = true })
  const assertCurrent = (): void => {
    assertProvider()
    if ((explicit || ruleOptions !== undefined || autoCapture !== undefined)
      && (topology.changed || identity(ctx.get('llm')) !== llmIdentity)) {
      throw new Error('LLM catalog/provider changed during native child model selection; retry delegation')
    }
    if (autoCapture !== undefined && identity(ctx.get('modelRouting')) !== routingIdentity) {
      throw new Error('Auto routing service changed during native child model selection; retry delegation')
    }
  }
  return {
    assertCurrent,
    dispose,
    async resolve(signal) {
      signal.throwIfAborted()
      assertCurrent()
      try {
        let source: ChildModelSelection['source'] = explicit ? 'request' : ruleOptions === undefined ? 'inheritance' : 'parent-rule'
        let options = { ...ruleOptions ?? inherited }
        let candidateId: string | undefined
        let parentClassifierCallId: RoutingCallId | undefined
        if (autoCapture !== undefined && modelRouting !== undefined) {
          if (eligibleCandidateIds === undefined || eligibleCandidateIds.length === 0) {
            throw new Error('native child Auto has no candidates authorized by the captured parent policy')
          }
          if (!eligibleCandidateIds.includes(autoCapture.selection.policy.conservativeCandidateId)) {
            throw new Error('native child Auto conservative candidate is not authorized by the captured parent policy')
          }
          if (llm === undefined) throw new Error('native child model selection requires the llm service')
          const choice = await modelRouting.resolveDelegation({
            parent, capture: autoCapture, eligibleCandidateIds, prompt, signal,
            ...inherited.maxTokens === undefined ? {} : { maxTokens: inherited.maxTokens },
          })
          signal.throwIfAborted()
          if (!allowedModels?.some(route => route.provider === choice.selection.provider && route.model === choice.selection.model)) {
            throw new Error('native child Auto returned a route outside the captured parent policy')
          }
          const candidate = autoCapture.selection.policy.candidates.find(entry => entry.id === choice.candidateId)
          if (candidate === undefined || !eligibleCandidateIds.includes(choice.candidateId)
            || candidate.selection.provider !== choice.selection.provider || candidate.selection.model !== choice.selection.model
            || (candidate.selection.reasoningEffort !== undefined
              && candidate.selection.reasoningEffort !== choice.selection.reasoningEffort)) {
            throw new Error('native child Auto returned a selection outside its captured candidate')
          }
          const { provider: _provider, model: _model, reasoningEffort: _effort, ...nonRoute } = inherited
          options = { ...nonRoute, ...choice.selection }
          source = 'auto'
          candidateId = choice.candidateId
          parentClassifierCallId = choice.classifierCallId
        }
        if (source !== 'inheritance') {
          if (llm === undefined) throw new Error('native child model selection requires the llm service')
          if (options.provider === undefined || options.model === undefined) {
            throw new Error('native child model selection requires an effective provider and model')
          }
          const effective = await llm.resolveCallConfig({
            provider: options.provider, model: options.model,
            ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
            ...options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens },
          }, signal)
          signal.throwIfAborted()
          const { reasoningEffort: _priorEffort, ...withoutEffort } = options
          options = { ...withoutEffort, ...selectedRoute(effective) }
        }
        signal.throwIfAborted()
        assertCurrent()
        return Object.freeze({
          agentOptions: Object.freeze(options),
          delegatedPolicies: Object.freeze(delegatedPolicies),
          modelSelection: Object.freeze({
            decision: Object.freeze({
              source, ...selectedRoute(options),
              ...candidateId === undefined ? {} : { candidateId },
              ...parentClassifierCallId === undefined ? {} : { parentClassifierCallId },
            }),
            ...allowedModels === undefined ? {} : {
              allowedModels: Object.freeze(allowedModels.map(route => Object.freeze(route))),
            },
            ...delegationCapture === undefined ? {} : { delegationAuto: delegationCapture.selection },
          }),
        })
      } catch (error: unknown) {
        dispose()
        throw error
      }
    },
  }
}

/**
 * Append captured authority and resolved choice within unpublished child setup.
 * @param ctx - Child creation context.
 * @param session - Child Session after its inherited marker.
 * @param captured - Registry-owned resolved selection evidence.
 */
export function appendNativeChildSelection(ctx: Context, session: Session, captured: NativeChildModelSelection): void {
  if (captured.allowedModels !== undefined) {
    const projections = ctx.get('sessionProjections')
    if (projections === undefined) throw new Error('captured child model authority requires sessionProjections')
    recordSubagentModelSelection(projections, session, captured.allowedModels)
  }
  session.append('subagent/model-selection', captured.decision)
  if (captured.delegationAuto !== undefined) session.append('model/delegation-auto', { selection: captured.delegationAuto })
}
