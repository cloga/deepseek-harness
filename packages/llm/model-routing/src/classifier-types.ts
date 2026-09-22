/** Configuration, audit events, and outcomes of the auxiliary task classifier. */

import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { AssistantStreamRecord, LlmCallConfig, Message, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { Session, SessionSeq } from '@deepseek-ai/dsh-session'
import type { RoutingCallId, TaskClassification } from './types.ts'
export type { RoutingCallId } from './types.ts'

/** Explicit deployment limits; no classifier route or budget is defaulted. */
export interface RoutingClassifierConfig {
  readonly selection: Readonly<ModelSelection>
  /** Maximum UTF-8 bytes of the complete serialized request excluding its AbortSignal. */
  readonly maxInputBytes: number
  readonly maxOutputTokens: number
  /** Maximum accumulated UTF-8 bytes of observed serialized chunks, including JSON wrappers. */
  readonly maxOutputBytes: number
  readonly timeoutMs: number
}

/** Task data and cancellation owned by one resolution attempt. */
export interface RoutingClassificationRequest {
  readonly session: Session
  readonly intentSeq: SessionSeq
  readonly taskText: string
  readonly previousTaskText?: string
  readonly signal: AbortSignal
}

/** Closed, safe outcomes; provider errors and raw validation diagnostics are never exposed. */
export type RoutingClassificationOutcome =
  | 'success'
  | 'input-limit'
  | 'preflight-error'
  | 'provider-error'
  | 'invalid-output'
  | 'max-tokens'
  | 'non-text'
  | 'missing-finish'
  | 'output-limit'
  | 'timeout'
  | 'aborted'

/** A successful parsed classification or an explicit conservative-policy input. */
export type RoutingClassificationResult =
  | { readonly outcome: 'success'; readonly callId: RoutingCallId; readonly classification: TaskClassification; readonly usage?: TokenUsage }
  | { readonly outcome: Exclude<RoutingClassificationOutcome, 'success'>; readonly callId?: RoutingCallId; readonly classification?: never; readonly usage?: TokenUsage }

/** Exact owned model-visible auxiliary request, committed before dispatch. */
export interface RoutingClassifierRequestEvent {
  readonly callId: RoutingCallId
  readonly intentSeq: SessionSeq
  /** Bounded task input used to restore continuity without parsing prompt templates. */
  readonly taskText: string
  readonly config: LlmCallConfig
  readonly system: string
  readonly messages: Message[]
}

/** Settled classifier stream; refused oversized chunks and provider error details are excluded. */
export interface RoutingClassifierResultEvent {
  readonly callId: RoutingCallId
  /** Actual retained prefix, not a fabricated successful stream; outcome explains early termination. */
  readonly stream: readonly AssistantStreamRecord[]
  readonly outcome: RoutingClassificationOutcome
  readonly classification?: TaskClassification
  readonly usage?: TokenUsage
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only exact classifier input, never part of conversation history. */
    'model/routing-request': RoutingClassifierRequestEvent
    /** Log-only classifier settlement, including separately attributable usage. */
    'model/routing-result': RoutingClassifierResultEvent
  }
}
