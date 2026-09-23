/** Immutable inputs and decisions for task-aware model selection. */

import type { ModelSelection } from '@deepseek-ai/dsh-agent/types'
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionSeq } from '@deepseek-ai/dsh-session/types'

/** Identity of one task whose selected model and effort remain cache-affine. */
export type RoutingTaskId = Branded<'RoutingTaskId'>
/** Identity of one audited auxiliary classifier dispatch. */
export type RoutingCallId = Branded<'RoutingCallId'>

/** User-selected tradeoff whose quality floors are supplied by the deployment. */
export type ModelRoutingMode = 'efficiency' | 'balanced' | 'intelligence'

/** Task difficulty reported by the classifier, independently of a model name. */
export type TaskComplexity = 'routine' | 'standard' | 'complex'

/** Deployment-assigned ordinal quality; it is not inferred from model metadata. */
export type ModelRoutingQuality = 1 | 2 | 3

/** Bounded classifier explanation; arbitrary model-authored prose is not retained. */
export type TaskClassificationReasonCode = 'continuation' | 'new-task' | 'uncertain'

/** Validated classifier output; uncertainty never authorizes a cheaper route. */
export interface TaskClassification {
  readonly continuity: 'same-task' | 'new-task'
  readonly complexity: TaskComplexity
  /** Finite confidence between zero and one, inclusive. */
  readonly confidence: number
  readonly reasonCode: TaskClassificationReasonCode
}

/** One curated route with an explicit quality rank and relative cost. */
export interface RoutingCandidate {
  /** Nonempty identity unique within the candidate policy, used by eligibility and conservative selection. */
  readonly id: string
  /** Exact provider/model route and optional explicit effort; omitted effort is materialized from provider metadata at admission. */
  readonly selection: Readonly<ModelSelection>
  /** Deployment-assigned ordinal quality rank used to enforce task floors; not inferred model capability. */
  readonly quality: ModelRoutingQuality
  /** Positive finite comparison weight, not a token price or savings estimate. */
  readonly relativeCost: number
}

/** Detached, deeply frozen policy returned by the configuration parser. */
export interface ModelRoutingPolicy {
  /** Configuration order breaks equal cost ties. One entry per provider/model/effort combination. */
  readonly candidates: readonly RoutingCandidate[]
  /** Minimum deployment-assigned candidate quality for each Auto mode and task complexity. */
  readonly qualityFloors: Readonly<Record<ModelRoutingMode, Readonly<Record<TaskComplexity, ModelRoutingQuality>>>>
  /** Minimum classifier confidence in the inclusive zero-to-one range before task-specific selection is trusted. */
  readonly minConfidence: number
  /** Must name a highest-quality configured candidate that meets every floor. */
  readonly conservativeCandidateId: string
}

/** Stable explanation of the policy decision, without a financial claim. */
export type RoutingDecisionReason =
  | 'same-task'
  | 'uncertain-current'
  | 'conservative'
  | 'quality-floor'
  | 'cost-tie-current'

/** Small owned result that the caller can validate against its live adapter and persist. */
export interface RoutingDecision {
  readonly candidateId: string
  readonly selection: Readonly<ModelSelection>
  readonly reason: RoutingDecisionReason
  /** Present when a confident task is selected using its mode's quality floor. */
  readonly qualityFloor?: ModelRoutingQuality
}

/** Browser-safe actual-use facts; private task text and policy internals are excluded. */
export interface RoutingDecisionView {
  readonly taskId: RoutingTaskId
  readonly intentSeq: SessionSeq
  readonly selection: ModelSelection
  readonly candidateId: string
  readonly reason: RoutingDecisionReason
  readonly classifierCallId?: RoutingCallId
}

/** User-visible intent and last confirmed selection. */
export interface ModelRoutingView {
  readonly mode: 'manual' | ModelRoutingMode
  readonly lastDecision: RoutingDecisionView | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Auto mode and actual request route; no raw classifier task text. */
    modelRouting: ModelRoutingView
  }
}

/** Same-process selection inputs; only eligible IDs may be selected. */
export interface SelectAutoModelRequest {
  readonly mode: ModelRoutingMode
  /** Actual effective route, including its request-owned reasoning effort. */
  readonly current?: Readonly<ModelSelection> | undefined
  /** Already-authorized, available candidate IDs; the policy grants no permissions. */
  readonly eligibleCandidateIds: readonly string[]
  /** Omit after an unavailable or malformed classification to select conservatively. */
  readonly classification?: TaskClassification | undefined
}
