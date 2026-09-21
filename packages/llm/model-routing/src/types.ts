/** Immutable inputs and decisions for task-aware model selection. */

import type { ModelSelection } from '@deepseek-ai/dsh-agent'

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
  readonly id: string
  readonly selection: Readonly<ModelSelection>
  readonly quality: ModelRoutingQuality
  /** Positive finite comparison weight, not a token price or savings estimate. */
  readonly relativeCost: number
}

/** Detached, deeply frozen policy returned by the configuration parser. */
export interface ModelRoutingPolicy {
  /** Configuration order breaks equal cost ties. One entry per provider/model/effort combination. */
  readonly candidates: readonly RoutingCandidate[]
  readonly qualityFloors: Readonly<Record<ModelRoutingMode, Readonly<Record<TaskComplexity, ModelRoutingQuality>>>>
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
