/** Closed local-learning records and store handles; no prompts, code, feedback-export triggers, or Host imports. */

import type { Branded } from '@deepseek-ai/dsh-brand'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { ModelRoutingMode, ModelRoutingPolicy, TaskComplexity } from '@deepseek-ai/dsh-model-routing/types'
import type {
  AdaptiveBasePolicyFingerprint, AdaptiveCohortKey, AdaptiveEvaluationInput,
  AdaptivePolicyConfig, AdaptivePolicyProposal, AdaptiveTaskId,
} from '@deepseek-ai/dsh-model-routing/adaptive-types'

/** Server-created identity of one learning scope. */
export type LearningScopeId = Branded<'LearningScopeId'>
/** Server-created task identity shared with the adaptive evidence evaluator. */
export type LearningTaskId = AdaptiveTaskId
/** Server-created immutable proposal identity. */
export type LearningProposalId = Branded<'LearningProposalId'>
/** Server-created immutable approved-version identity. */
export type LearningVersionId = Branded<'LearningVersionId'>

/** A bounded declared task category; null on a record means not attributable yet. */
export type LearningTaskCategory = 'code-edit' | 'debugging' | 'tests' | 'review' | 'documentation' | 'research' | 'other'
/** Task execution role, independent from its outcome authority. */
export type LearningTaskRole = 'main' | 'child' | 'review'
/** Safe incompleteness diagnostics, never arbitrary provider or model prose. */
export type LearningIncompleteReason =
  | 'not-sealed' | 'unattributed-profile' | 'unattributed-scope' | 'unattributed-cohort'
  | 'unattributed-route' | 'missing-revision' | 'missing-usage' | 'pending-calls'
  | 'unknown-auxiliary-work' | 'unknown-child-work' | 'unknown-review-work' | 'interrupted' | 'unsupported-source'

/** Deployment-owned storage bounds; every limit is explicit. */
export interface LearningStoreLimits {
  readonly maxScopes: number
  readonly maxTasks: number
  readonly maxProposals: number
  readonly maxVersions: number
  readonly maxObservationsPerProposal: number
  /** UTF-8 bytes of the complete logical ledger JSON, including its identity and revision fields. */
  readonly maxLedgerBytes: number
}

/** Explicit profile isolation and sole-writer lease, with no environment-derived identity. */
export interface LearningStoreConfig {
  readonly profileKey: string
  /** Absolute base path passed to withFileLock; the actual guard is this path plus .lock. */
  readonly ownershipLockPath: string
  readonly ownershipWaitMs: number
  readonly limits: LearningStoreLimits
}

/** One scope's active pointer; publishing or changing it is the higher runtime's decision. */
export interface LearningScopeRecord {
  readonly id: LearningScopeId
  readonly cohort: AdaptiveCohortKey | null
  readonly activeVersionId: LearningVersionId | null
}

/** Plain actual provider/model/effort identity, never a guessed or virtual Auto model. */
export interface LearningResolvedSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Server-owned task facts; work completeness and human/validator outcome evidence are independent. */
export interface LearningTaskRecord {
  readonly id: LearningTaskId
  readonly sessionId: SessionId
  readonly scopeId: LearningScopeId | null
  readonly cohort: AdaptiveCohortKey | null
  readonly category: LearningTaskCategory | null
  readonly complexity: TaskComplexity | null
  readonly mode: ModelRoutingMode | null
  readonly role: LearningTaskRole | null
  readonly candidateId: string | null
  readonly resolvedSelection: LearningResolvedSelection | null
  readonly basePolicy: ModelRoutingPolicy | null
  readonly basePolicyFingerprint: AdaptiveBasePolicyFingerprint | null
  readonly classifierRevision: string | null
  readonly metricRevision: string | null
  readonly revision: number
  readonly state: 'pending' | 'sealed'
  readonly createdAt: number
  readonly completedAt: number | null
  /** Complete measured work only; incomplete work is null, never a fabricated zero. */
  readonly observedRelativeWork: number | null
  readonly workComplete: boolean
  readonly incompleteReasons: readonly LearningIncompleteReason[]
  readonly outcome: 'unknown' | 'success' | 'failure'
  readonly evidence: 'user-confirmed' | 'validator' | 'unverified'
}

/** Immutable server evidence captured when one proposal was created. */
export interface LearningProposalRecord {
  readonly id: LearningProposalId
  readonly scopeId: LearningScopeId
  readonly cohort: AdaptiveCohortKey
  readonly basePolicyFingerprint: AdaptiveBasePolicyFingerprint
  /** Server-owned 1–128 character token; changes on every config revision, including disable/re-enable. */
  readonly configRevision: string
  /** Server-owned 1–128 character token binding base policy, cohort, classifier, metric and eligibility revisions. */
  readonly contextRevision: string
  readonly guardConfig: AdaptivePolicyConfig
  readonly evaluationInput: AdaptiveEvaluationInput
  readonly proposal: AdaptivePolicyProposal
  readonly sourceTaskRevisions: readonly { readonly taskId: LearningTaskId; readonly revision: number }[]
  readonly createdAt: number
  readonly expiresAt: number
}

/** Immutable approved weights; the store does not evaluate, approve, or automatically apply them. */
export interface LearningVersionRecord {
  readonly id: LearningVersionId
  readonly scopeId: LearningScopeId
  readonly cohort: AdaptiveCohortKey
  readonly proposalId: LearningProposalId
  readonly parentVersionId: LearningVersionId | null
  readonly basePolicyFingerprint: AdaptiveBasePolicyFingerprint
  readonly weights: readonly { readonly candidateId: string; readonly relativeCost: number }[]
  readonly createdAt: number
  readonly validUntil: number
}

/** The only data an owner may replace in a transaction. */
export interface LearningLedgerData {
  readonly scopes: readonly LearningScopeRecord[]
  readonly tasks: readonly LearningTaskRecord[]
  readonly proposals: readonly LearningProposalRecord[]
  readonly versions: readonly LearningVersionRecord[]
}

/** One authoritative profile ledger; identity and concurrency stamps belong to the store. */
export interface LearningLedger extends LearningLedgerData {
  readonly schemaVersion: 1
  readonly profileKey: string
  readonly revision: number
  readonly epoch: number
}

/** Safe store-level failure codes; no record body is included in diagnostics. */
export type LearningStoreErrorCode = 'closed' | 'revision-conflict' | 'epoch-conflict' | 'invalid-ledger' | 'limit-exceeded'

/** Caller-owned store lifetime over one exclusive profile lease and one queued ledger row. */
export interface LearningStore {
  /** @returns A detached deeply frozen view of the latest durably committed ledger. */
  read(): LearningLedger
  /**
   * Compare revision and epoch inside the domain write queue, validate, then durably commit one complete next row.
   * @param expectedRevision - Ledger revision captured by the initiating operation.
   * @param expectedEpoch - Epoch captured before any clear could invalidate the operation.
   * @param transform - Synchronous pure transform over an owned frozen view; returns only record arrays.
   * @returns A detached frozen committed ledger; identity/revision/epoch cannot be supplied by the transform.
   */
  update(
    expectedRevision: number,
    expectedEpoch: number,
    transform: (current: LearningLedger) => LearningLedgerData,
  ): Promise<LearningLedger>
  /**
   * Remove local records and pointers while advancing both concurrency stamps.
   * @param expectedRevision - Observed ledger revision.
   * @param expectedEpoch - Observed clear epoch.
   * @returns The committed empty ledger; no Session or settings document is touched.
   */
  clear(expectedRevision: number, expectedEpoch: number): Promise<LearningLedger>
  /** Close write admission immediately, drain the domain, then release profile ownership. */
  close(): Promise<void>
}

/** A contender does not receive a usable store while another owner retains the lock. */
export type LearningStoreOpenResult =
  | { readonly available: true; readonly store: LearningStore }
  | { readonly available: false; readonly reason: 'ownership-unavailable' }
