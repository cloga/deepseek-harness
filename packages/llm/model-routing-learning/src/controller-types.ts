/** Controller-only authority, read-only dependencies and cropped local learning views. */

import type { ModelRoutingMode, ModelRoutingPolicy, TaskComplexity } from '@deepseek-ai/dsh-model-routing/types'
import type {
  AdaptiveCohortKey, AdaptiveEvidenceSummary, AdaptiveNoProposalReason, AdaptivePolicyConfig,
} from '@deepseek-ai/dsh-model-routing/adaptive-types'
import type {
  LearningProposalId, LearningResolvedSelection, LearningScopeId, LearningStore,
  LearningTaskCategory, LearningTaskRole, LearningVersionId,
} from './types.ts'

/** Explicit controller settings; revision changes even when settings revert to earlier values. */
export interface LearningControllerConfig {
  readonly revision: string
  readonly enabled: boolean
  readonly guards: AdaptivePolicyConfig
  readonly proposalTtlMs: number
  readonly versionTtlMs: number
}

/** One currently authorized and available exact candidate, including materialized defaults. */
export interface LearningEligibleCandidate {
  readonly candidateId: string
  readonly resolvedSelection: LearningResolvedSelection
}

/** Server-owned ready context, never assembled from mutation request fields. */
export interface LearningCurrentContext {
  readonly profileKey: string
  readonly scopeId: LearningScopeId
  /** Changes on every base/cohort/classifier/metric/eligibility revision, including ABA changes. */
  readonly contextRevision: string
  readonly cohort: AdaptiveCohortKey
  readonly category: LearningTaskCategory
  readonly role: LearningTaskRole
  readonly mode: ModelRoutingMode
  readonly complexity: TaskComplexity
  /** Stable human-authored policy; active learned weights must not be supplied as this base. */
  readonly basePolicy: ModelRoutingPolicy
  readonly classifierRevision: string
  readonly metricRevision: string
  readonly eligibleCandidates: readonly LearningEligibleCandidate[]
}

/** Explicit side-effect ownership; callbacks read already-resolved local state, never run a model or network query. */
export interface LearningControllerDependencies {
  readonly store: LearningStore
  readonly config: () => LearningControllerConfig
  /** Return undefined while the local scope or its live eligibility is unavailable. */
  readonly context: (scopeId: LearningScopeId) => LearningCurrentContext | undefined
  readonly now: () => number
  /** Fresh lowercase UUID; identities must not be reused after clearing the ledger. */
  readonly proposalId: () => LearningProposalId
  readonly versionId: () => LearningVersionId
}

/** Optimistic concurrency stamps supplied by the explicit mutation caller. */
export interface LearningMutationStamp {
  readonly expectedRevision: number
  readonly expectedEpoch: number
}

/** Closed controller refusal; messages contain no record bodies or underlying exception prose. */
export type LearningControllerErrorCode =
  | 'invalid-request' | 'invalid-config' | 'invalid-context' | 'invalid-clock'
  | 'disabled' | 'revision-conflict' | 'epoch-conflict' | 'unknown-scope' | 'context-unavailable'
  | 'unknown-proposal' | 'unknown-version' | 'already-approved' | 'id-conflict'
  | 'stale-config' | 'stale-context' | 'stale-base' | 'stale-source' | 'expired'
  | 'missing-evidence' | 'invalid-evidence' | 'invalid-version' | 'store-unavailable' | 'store-rejected'

/** Safe usability state; invalid records are never returned as policy authority. */
export type LearningRecordStatus = 'ready' | 'approved' | LearningControllerErrorCode

/** Cropped proposal without observations, Session IDs, raw policies, scope keys or revision tokens. */
export interface LearningProposalView {
  readonly id: LearningProposalId
  readonly scopeId: LearningScopeId
  readonly status: LearningRecordStatus
  readonly createdAt: number
  readonly expiresAt: number
  readonly baselineCandidateId: string
  readonly winnerCandidateId: string
  readonly change: { readonly candidateId: string; readonly before: number; readonly after: number }
  readonly samples: { readonly baseline: number; readonly winner: number }
  /** Observed work reduction, not money or a prediction of future savings. */
  readonly relativeWorkImprovement: number
}

/** Immutable-version history without exporting retained evidence or source configuration. */
export interface LearningVersionView {
  readonly id: LearningVersionId
  readonly scopeId: LearningScopeId
  readonly proposalId: LearningProposalId
  readonly parentVersionId: LearningVersionId | null
  readonly createdAt: number
  readonly validUntil: number
  readonly active: boolean
  readonly status: LearningRecordStatus
}

/** One profile's bounded local management view; never an upload/export request. */
export interface LearningControllerView {
  readonly revision: number
  readonly epoch: number
  readonly enabled: boolean
  readonly scopes: readonly {
    readonly id: LearningScopeId
    readonly activeVersionId: LearningVersionId | null
    readonly activeStatus: LearningRecordStatus | 'none'
  }[]
  readonly proposals: readonly LearningProposalView[]
  readonly versions: readonly LearningVersionView[]
}

/** Evaluation commits a proposal only; activation requires a separate ID-only approval operation. */
export type LearningControllerEvaluation =
  | { readonly kind: 'proposal'; readonly proposal: LearningProposalView; readonly revision: number; readonly epoch: number }
  | {
    readonly kind: 'no-proposal'
    readonly reasonCode: AdaptiveNoProposalReason
    readonly summary: AdaptiveEvidenceSummary
    readonly revision: number
    readonly epoch: number
  }
