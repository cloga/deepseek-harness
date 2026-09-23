/** Captured Auto preference for isolated native child creation, not the child's own conversation route. */

import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { AutoSelection } from './routing-state.ts'
import type { RoutingCallId } from './classifier-types.ts'
import type { RoutingDecisionReason } from './types.ts'

/** Credential-free policy identity captured synchronously from the exact direct parent. */
export interface DelegationRoutingCapture {
  readonly parentSessionId: SessionId
  /** Parent-local Auto or delegation-context event sequence. */
  readonly intentSeq: SessionSeq
  readonly selection: AutoSelection
}

/** Already-authorized isolated child input; the native owner retains creation authority. */
export interface ResolveDelegationRoutingRequest {
  readonly parent: Agent
  readonly capture: DelegationRoutingCapture
  /** Captured candidate IDs intersected with the parent's separate child-model authorization. */
  readonly eligibleCandidateIds: readonly string[]
  readonly prompt: readonly ContentBlock[]
  /** Output cap from the captured complete child options, when supplied. */
  readonly maxTokens?: number
  /** Child-start cancellation, not an unrelated later parent turn. */
  readonly signal: AbortSignal
}

/** Resolved creation proposal; the native owner validates it before publishing a child. */
export interface ResolvedDelegationRouting {
  /** Materialized effort pins the selected adapter default rather than inheriting a parent effort. */
  readonly selection: ModelSelection
  readonly candidateId: string
  readonly reason: RoutingDecisionReason
  readonly classifierCallId?: RoutingCallId
}

/** Child-local captured preference used only when that child later delegates. */
export interface DelegationRoutingContext {
  readonly intentSeq: SessionSeq
  readonly selection: AutoSelection
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Captured child delegation preference; never enables Auto for the child's own conversation. */
    'model/delegation-auto': { readonly selection: AutoSelection }
  }
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Child-owned delegation preference, or null before an explicit creation record. */
    modelRoutingDelegation: DelegationRoutingContext | null
  }
}
