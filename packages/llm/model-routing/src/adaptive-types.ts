/** Owned local evidence and bounded relative-weight proposals; no runtime publication authority. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ModelRoutingMode, TaskComplexity } from './types.ts'

/**
 * Opaque comparability identity produced by the trusted local collector. It must
 * bind local workspace/profile, task kind/complexity, main/child role, mode, and
 * all compared routes' resolved model/effort/default and classifier revisions.
 * Equal strings assert that comparability; this foundation does not infer it.
 */
export type AdaptiveCohortKey = Branded<'AdaptiveCohortKey'>
/** Identity of one collector-owned outcome record. */
export type AdaptiveObservationId = Branded<'AdaptiveObservationId'>
/** Task identity used to prevent retries or repeated verdicts becoming extra samples. */
export type AdaptiveTaskId = Branded<'AdaptiveTaskId'>
/** SHA-256 of the canonical complete base policy, not an authorization credential. */
export type AdaptiveBasePolicyFingerprint = Branded<'AdaptiveBasePolicyFingerprint'>

/** Explicit statistical and operational limits; none have library defaults. */
export interface AdaptivePolicyConfig {
  readonly minSamplesPerCandidate: number
  /** Inclusive lookback from the caller-supplied evaluation time, in milliseconds. */
  readonly observationWindowMs: number
  /** Hard input-record cap; the collector must read a bounded recent window. */
  readonly maxObservations: number
  readonly minRelativeImprovement: number
  /** Maximum permitted Wilson upper bound for the alternative's failure proportion. */
  readonly maxFailureRate: number
  /** Maximum permitted alternative upper bound minus baseline lower bound. */
  readonly maxFailureRateRegression: number
  /** Explicit positive Wilson z-score; these bounds are guards, not causal evidence. */
  readonly confidenceZ: number
  /** Fractional reduction limit strictly between zero and one. */
  readonly maxRelativeWeightChange: number
}

/** One task outcome; the closed record admits no prompt, code, or arbitrary error-prose field. */
export interface AdaptiveObservation {
  readonly observationId: AdaptiveObservationId
  readonly taskId: AdaptiveTaskId
  readonly candidateId: string
  /** Includes local scope, role, task class, mode, and relevant route/classifier revisions. */
  readonly cohort: AdaptiveCohortKey
  readonly evidence: 'user-confirmed' | 'validator' | 'unverified'
  readonly outcome: 'success' | 'failure' | 'unknown'
  /** Comparable measured/weighted work, not money; null means unknown. */
  readonly observedRelativeWork: number | null
  /** True only when retry, classifier, child, and review overhead is included by the collector. */
  readonly workComplete: boolean
  readonly completedAt: number
}

/** Durable/wire input parsed by the evaluator; eligibility remains caller authority. */
export interface AdaptiveEvaluationInput {
  readonly cohort: AdaptiveCohortKey
  readonly mode: ModelRoutingMode
  readonly complexity: TaskComplexity
  readonly now: number
  readonly eligibleCandidateIds: readonly string[]
  readonly observations: readonly AdaptiveObservation[]
}

/** Mutually exclusive exclusion counts, in evaluator filtering order. */
export interface AdaptiveExclusions {
  readonly uncorrelated: number
  readonly expired: number
  readonly future: number
  readonly ineligible: number
  readonly belowQualityFloor: number
  readonly unverified: number
  readonly unknownOutcome: number
  readonly incompleteWork: number
}

/** Accounting for the entire bounded input, including unusable observations. */
export interface AdaptiveEvidenceSummary {
  readonly received: number
  readonly accepted: number
  readonly windowStart: number
  readonly windowEnd: number
  readonly excluded: AdaptiveExclusions
}

/** Verified complete comparable samples for one exact configured candidate identity. */
export interface AdaptiveCandidateEvidence {
  readonly samples: number
  readonly failures: number
  /** Verified successful tasks; zero-success cohorts cannot support a proposal. */
  readonly successes: number
  /** Total observed work for successes AND failures divided by verified successful tasks, not money. */
  readonly relativeWorkPerSuccess: number
  readonly failureLowerBound: number
  readonly failureUpperBound: number
  readonly observationIds: readonly AdaptiveObservationId[]
}

/** The only mutable policy property supported by this foundation. */
export interface AdaptiveWeightChange {
  readonly candidateId: string
  readonly before: number
  readonly after: number
}

/** Immutable auditable proposal; runtime versioning, CAS, promotion, and rollback are separate owners. */
export interface AdaptivePolicyProposal {
  readonly schemaVersion: 1
  readonly basePolicyFingerprint: AdaptiveBasePolicyFingerprint
  readonly cohort: AdaptiveCohortKey
  readonly mode: ModelRoutingMode
  readonly complexity: TaskComplexity
  readonly evaluatedAt: number
  readonly baselineCandidateId: string
  readonly winnerCandidateId: string
  /** One winner-only reduction; candidate routes, quality ranks, and every hard rule remain unchanged. */
  readonly changes: readonly [AdaptiveWeightChange]
  readonly evidence: {
    readonly summary: AdaptiveEvidenceSummary
    readonly baseline: AdaptiveCandidateEvidence
    readonly winner: AdaptiveCandidateEvidence
    /** Observed total-work-per-success reduction, not a predicted saving or causal estimate. */
    readonly relativeWorkImprovement: number
  }
  readonly reasonCode: 'verified-work-improvement'
}

/** Why the evidence cannot authorize a useful bounded proposal. */
export type AdaptiveNoProposalReason =
  | 'no-eligible-baseline'
  | 'no-qualified-alternative'
  | 'no-comparable-observations'
  | 'insufficient-baseline-evidence'
  | 'insufficient-alternative-evidence'
  | 'no-baseline-successes'
  | 'no-alternative-successes'
  | 'failure-risk'
  | 'no-work-improvement'
  | 'bounded-patch-no-effect'
  | 'arithmetic-limit'

/** Deterministic evaluation without automatic activation or network calls. */
export type AdaptiveEvaluationResult =
  | { readonly kind: 'proposal'; readonly proposal: AdaptivePolicyProposal }
  | {
    readonly kind: 'no-proposal'
    readonly reasonCode: AdaptiveNoProposalReason
    readonly summary: AdaptiveEvidenceSummary
    readonly baselineCandidateId?: string
  }
