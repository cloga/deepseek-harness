/** Deterministic local evidence evaluation and winner-only relative-weight patches. */

import { createHash } from 'node:crypto'
import { brandString } from '@deepseek-ai/dsh-brand'
import { deepEqualJson, deepFreeze } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { parseRoutingPolicy, selectAutoModel } from './policy.ts'
import type { ModelRoutingPolicy, RoutingCandidate } from './types.ts'
import type {
  AdaptiveBasePolicyFingerprint, AdaptiveCandidateEvidence, AdaptiveCohortKey,
  AdaptiveEvaluationInput, AdaptiveEvaluationResult, AdaptiveEvidenceSummary,
  AdaptiveNoProposalReason, AdaptiveObservationId, AdaptivePolicyConfig,
  AdaptivePolicyProposal, AdaptiveTaskId, AdaptiveWeightChange,
} from './adaptive-types.ts'

const identifier = z.string().refine(value => value.trim().length > 0, 'identifier must be non-empty')
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const positiveCount = count.positive()
const fraction = z.number().min(0).max(1)
const work = z.number().nonnegative()
const mode = z.enum(['efficiency', 'balanced', 'intelligence'])
const complexity = z.enum(['routine', 'standard', 'complex'])
const cohort = identifier.transform(value => brandString<AdaptiveCohortKey>(value))
const observationId = identifier.transform(value => brandString<AdaptiveObservationId>(value))
const configSchema = z.object({
  minSamplesPerCandidate: positiveCount,
  observationWindowMs: positiveCount,
  maxObservations: positiveCount,
  minRelativeImprovement: fraction,
  maxFailureRate: fraction,
  maxFailureRateRegression: fraction,
  confidenceZ: z.number().positive().refine(
    value => Number.isFinite(value * value) && value * value > 0,
    'confidenceZ must have a positive finite square',
  ),
  maxRelativeWeightChange: z.number().gt(0).lt(1),
}).strict().refine(
  value => value.minSamplesPerCandidate <= value.maxObservations / 2,
  'maxObservations must hold the minimum samples for two compared candidates',
)
const observationSchema = z.object({
  observationId,
  taskId: identifier.transform(value => brandString<AdaptiveTaskId>(value)),
  candidateId: identifier,
  cohort,
  evidence: z.enum(['user-confirmed', 'validator', 'unverified']),
  outcome: z.enum(['success', 'failure', 'unknown']),
  observedRelativeWork: work.nullable(),
  workComplete: z.boolean(),
  completedAt: count,
}).strict()
const inputSchema = z.object({
  cohort,
  mode,
  complexity,
  now: count,
  eligibleCandidateIds: z.array(identifier),
  observations: z.unknown(),
}).strict()
const summarySchema = z.object({
  received: count,
  accepted: count,
  windowStart: count,
  windowEnd: count,
  excluded: z.object({
    uncorrelated: count, expired: count, future: count, ineligible: count,
    belowQualityFloor: count, unverified: count, unknownOutcome: count, incompleteWork: count,
  }).strict(),
}).strict()
const evidenceSchema = z.object({
  samples: positiveCount,
  failures: count,
  successes: positiveCount,
  relativeWorkPerSuccess: work,
  failureLowerBound: fraction,
  failureUpperBound: fraction,
  observationIds: z.array(observationId),
}).strict().refine(value => value.successes + value.failures === value.samples, 'success and failure counts must cover the samples')
const proposalSchema = z.object({
  schemaVersion: z.literal(1),
  basePolicyFingerprint: z.string().regex(/^[a-f0-9]{64}$/)
    .transform(value => brandString<AdaptiveBasePolicyFingerprint>(value)),
  cohort,
  mode,
  complexity,
  evaluatedAt: count,
  baselineCandidateId: identifier,
  winnerCandidateId: identifier,
  changes: z.tuple([z.object({
    candidateId: identifier,
    before: z.number().positive(),
    after: z.number().positive(),
  }).strict()]),
  evidence: z.object({
    summary: summarySchema,
    baseline: evidenceSchema,
    winner: evidenceSchema,
    relativeWorkImprovement: fraction,
  }).strict(),
  reasonCode: z.literal('verified-work-improvement'),
}).strict()

/**
 * Validate every adaptive guard and budget without supplying defaults.
 * @param value - Unknown deployment policy for local evidence evaluation.
 * @returns A detached frozen configuration that can compare at least two candidates.
 * @throws When a field, arithmetic limit, or minimum window capacity is invalid.
 */
export function parseAdaptivePolicyConfig(value: unknown): AdaptivePolicyConfig {
  return deepFreeze(configSchema.parse(value))
}

/**
 * Fingerprint every effective base-policy field, preserving candidate tie order.
 * This hash identifies content; it grants no permission to apply a proposal.
 * @param policy - Validated immutable routing policy.
 * @returns SHA-256 of an explicitly ordered owned JSON representation.
 */
export function fingerprintAdaptiveBasePolicy(policy: ModelRoutingPolicy): AdaptiveBasePolicyFingerprint {
  const floors = policy.qualityFloors
  const owned = {
    candidates: policy.candidates.map(candidate => ({
      id: candidate.id,
      selection: {
        provider: candidate.selection.provider,
        model: candidate.selection.model,
        ...candidate.selection.reasoningEffort === undefined ? {} : { reasoningEffort: candidate.selection.reasoningEffort },
      },
      quality: candidate.quality,
      relativeCost: candidate.relativeCost,
    })),
    qualityFloors: {
      efficiency: { routine: floors.efficiency.routine, standard: floors.efficiency.standard, complex: floors.efficiency.complex },
      balanced: { routine: floors.balanced.routine, standard: floors.balanced.standard, complex: floors.balanced.complex },
      intelligence: { routine: floors.intelligence.routine, standard: floors.intelligence.standard, complex: floors.intelligence.complex },
    },
    minConfidence: policy.minConfidence,
    conservativeCandidateId: policy.conservativeCandidateId,
  }
  return brandString<AdaptiveBasePolicyFingerprint>(createHash('sha256').update(JSON.stringify(owned)).digest('hex'))
}

/**
 * Validate and freeze a bounded local evidence snapshot without evaluating it.
 * @param value - Unknown stored or queued evaluation input.
 * @param config - Validated limits for the evidence snapshot.
 * @returns Detached records with deterministic order and unique task/observation identities.
 */
export function parseAdaptiveEvaluationInput(value: unknown, config: AdaptivePolicyConfig): AdaptiveEvaluationInput {
  const input = inputSchema.parse(value)
  if (!Array.isArray(input.observations) || input.observations.length > config.maxObservations) {
    throw new Error('adaptive observations must be an array within maxObservations')
  }
  const observations = z.array(observationSchema).parse(input.observations)
  const ids = new Set<AdaptiveObservationId>()
  const tasks = new Set<AdaptiveTaskId>()
  for (const observation of observations) {
    if (ids.has(observation.observationId)) throw new Error('adaptive observations repeat an observation id')
    if (tasks.has(observation.taskId)) throw new Error('adaptive observations repeat a task id')
    ids.add(observation.observationId)
    tasks.add(observation.taskId)
  }
  observations.sort((left, right) => left.completedAt - right.completedAt
    || Number(left.observationId > right.observationId) - Number(left.observationId < right.observationId))
  return deepFreeze({ ...input, observations })
}

/**
 * Validate a stored proposal's closed fields without granting publication authority.
 * @param value - Unknown persisted or transported proposal.
 * @returns A detached frozen proposal; application still requires authoritative evidence reevaluation.
 */
export function parseAdaptivePolicyProposal(value: unknown): AdaptivePolicyProposal {
  return deepFreeze(proposalSchema.parse(value))
}

interface ComparableObservation {
  readonly observationId: AdaptiveObservationId
  readonly outcome: 'success' | 'failure'
  readonly work: number
}

function candidateEvidence(
  rows: readonly ComparableObservation[],
  config: AdaptivePolicyConfig,
): AdaptiveCandidateEvidence | undefined {
  const samples = rows.length
  const failures = rows.filter(row => row.outcome === 'failure').length
  // Both callers admitted at least one verified success before computing evidence.
  const successes = samples - failures
  const maximum = rows.reduce((largest, row) => Math.max(largest, row.work), 0)
  // Every verified outcome's complete work is paid toward successful tasks, including failed work.
  // Normalize the sum before dividing to avoid overflow when the final ratio is representable.
  const relativeWorkPerSuccess = maximum === 0 ? 0
    : maximum * (rows.reduce((total, row) => total + row.work / maximum, 0) / successes)
  if (!Number.isFinite(relativeWorkPerSuccess) || (maximum > 0 && relativeWorkPerSuccess === 0)) return undefined
  const proportion = failures / samples
  const scale = config.confidenceZ * config.confidenceZ / samples
  const denominator = 1 + scale
  const center = (proportion + scale / 2) / denominator
  const halfWidth = (config.confidenceZ / Math.sqrt(samples) / denominator)
    * Math.sqrt(proportion * (1 - proportion) + scale / 4)
  if (!Number.isFinite(center) || !Number.isFinite(halfWidth)) return undefined
  return {
    samples, failures, successes, relativeWorkPerSuccess,
    failureLowerBound: Math.max(0, center - halfWidth),
    failureUpperBound: Math.min(1, center + halfWidth),
    observationIds: rows.map(row => row.observationId),
  }
}

function winner(policy: ModelRoutingPolicy, input: AdaptiveEvaluationInput): string {
  return selectAutoModel(policy, {
    mode: input.mode,
    eligibleCandidateIds: input.eligibleCandidateIds,
    classification: { continuity: 'new-task', complexity: input.complexity, confidence: 1, reasonCode: 'new-task' },
  }).candidateId
}

function patchedPolicy(base: ModelRoutingPolicy, change: AdaptiveWeightChange): ModelRoutingPolicy {
  return parseRoutingPolicy({
    ...base,
    candidates: base.candidates.map(candidate => candidate.id === change.candidateId
      ? { ...candidate, relativeCost: change.after }
      : candidate),
  })
}

function evaluate(
  base: ModelRoutingPolicy,
  config: AdaptivePolicyConfig,
  input: AdaptiveEvaluationInput,
): AdaptiveEvaluationResult {
  const floor = base.qualityFloors[input.mode][input.complexity]
  const eligible = new Set(input.eligibleCandidateIds)
  const pool = new Map(base.candidates.map(candidate => [candidate.id, candidate]))
  const qualified = base.candidates.filter(candidate => eligible.has(candidate.id) && candidate.quality >= floor)
  const byCandidate = new Map<string, ComparableObservation[]>()
  const excluded = {
    uncorrelated: 0, expired: 0, future: 0, ineligible: 0,
    belowQualityFloor: 0, unverified: 0, unknownOutcome: 0, incompleteWork: 0,
  }
  const windowStart = Math.max(0, input.now - config.observationWindowMs)
  let accepted = 0
  for (const observation of input.observations) {
    const candidate = pool.get(observation.candidateId)
    if (observation.cohort !== input.cohort) { excluded.uncorrelated += 1; continue }
    if (observation.completedAt < windowStart) { excluded.expired += 1; continue }
    if (observation.completedAt > input.now) { excluded.future += 1; continue }
    if (candidate === undefined || !eligible.has(candidate.id)) { excluded.ineligible += 1; continue }
    if (candidate.quality < floor) { excluded.belowQualityFloor += 1; continue }
    if (observation.evidence === 'unverified') { excluded.unverified += 1; continue }
    if (observation.outcome === 'unknown') { excluded.unknownOutcome += 1; continue }
    if (!observation.workComplete || observation.observedRelativeWork === null) { excluded.incompleteWork += 1; continue }
    const rows = byCandidate.get(candidate.id) ?? []
    rows.push({ observationId: observation.observationId, outcome: observation.outcome, work: observation.observedRelativeWork })
    byCandidate.set(candidate.id, rows)
    accepted += 1
  }
  const summary: AdaptiveEvidenceSummary = {
    received: input.observations.length, accepted, windowStart, windowEnd: input.now, excluded,
  }
  const baselineCandidateId = qualified.length === 0 ? undefined : winner(base, input)
  const none = (reasonCode: AdaptiveNoProposalReason): AdaptiveEvaluationResult => deepFreeze({
    kind: 'no-proposal', reasonCode, summary,
    ...baselineCandidateId === undefined ? {} : { baselineCandidateId },
  })
  if (baselineCandidateId === undefined) return none('no-eligible-baseline')
  if (qualified.length === 1) return none('no-qualified-alternative')
  if (accepted === 0) return none('no-comparable-observations')
  const baselineRows = byCandidate.get(baselineCandidateId) ?? []
  if (baselineRows.length < config.minSamplesPerCandidate) return none('insufficient-baseline-evidence')
  if (!baselineRows.some(row => row.outcome === 'success')) return none('no-baseline-successes')
  const baseline = candidateEvidence(baselineRows, config)
  if (baseline === undefined) return none('arithmetic-limit')
  // The selected id is owned by the qualified base pool; only Map.get's type needs narrowing.
  const baselineCandidate = pool.get(baselineCandidateId) as RoutingCandidate
  const alternatives = qualified.filter(candidate => candidate.id !== baselineCandidateId
    && (byCandidate.get(candidate.id)?.length ?? 0) >= config.minSamplesPerCandidate)
  if (alternatives.length === 0) return none('insufficient-alternative-evidence')
  const withSuccesses = alternatives.filter(candidate => byCandidate.get(candidate.id)?.some(row => row.outcome === 'success'))
  if (withSuccesses.length === 0) return none('no-alternative-successes')
  const measured = withSuccesses.flatMap((candidate) => {
    const evidence = candidateEvidence(byCandidate.get(candidate.id) as ComparableObservation[], config)
    return evidence === undefined ? [] : [{ candidate, evidence }]
  })
  if (measured.length === 0) return none('arithmetic-limit')
  const safe = measured.filter(({ evidence }) => evidence.failureUpperBound <= config.maxFailureRate
    && evidence.failureUpperBound - baseline.failureLowerBound <= config.maxFailureRateRegression)
  if (safe.length === 0) return none('failure-risk')
  const improved = safe.filter(({ evidence }) => baseline.relativeWorkPerSuccess > 0
    && evidence.relativeWorkPerSuccess < baseline.relativeWorkPerSuccess
    && 1 - evidence.relativeWorkPerSuccess / baseline.relativeWorkPerSuccess >= config.minRelativeImprovement)
    .sort((left, right) => left.evidence.relativeWorkPerSuccess - right.evidence.relativeWorkPerSuccess)
  if (improved.length === 0) return none('no-work-improvement')
  let arithmeticLimit = false
  for (const alternative of improved) {
    const before = alternative.candidate.relativeCost
    const lower = before * (1 - config.maxRelativeWeightChange)
    const target = baselineCandidate.relativeCost * (alternative.evidence.relativeWorkPerSuccess / baseline.relativeWorkPerSuccess)
    const after = Math.max(lower, target)
    if (!Number.isFinite(after) || lower <= 0 || after <= 0) { arithmeticLimit = true; continue }
    // A tied weight could retain an existing route through the selector's current-route tie rule.
    if (after >= before || after >= baselineCandidate.relativeCost
      || winner(patchedPolicy(base, { candidateId: alternative.candidate.id, before, after }), input)
      !== alternative.candidate.id) continue
    const proposal: AdaptivePolicyProposal = {
      schemaVersion: 1,
      basePolicyFingerprint: fingerprintAdaptiveBasePolicy(base),
      cohort: input.cohort, mode: input.mode, complexity: input.complexity, evaluatedAt: input.now,
      baselineCandidateId, winnerCandidateId: alternative.candidate.id,
      changes: [{ candidateId: alternative.candidate.id, before, after }],
      evidence: {
        summary, baseline, winner: alternative.evidence,
        relativeWorkImprovement: 1 - alternative.evidence.relativeWorkPerSuccess / baseline.relativeWorkPerSuccess,
      },
      reasonCode: 'verified-work-improvement',
    }
    return deepFreeze({ kind: 'proposal', proposal })
  }
  return none(arithmeticLimit ? 'arithmetic-limit' : 'bounded-patch-no-effect')
}

/**
 * Evaluate only verified, complete, comparable local work for a future Auto task.
 * Duplicate task/observation ids reject before filtering; unknown work is never zero.
 * The objective is total complete work across successes and failures per verified success,
 * not cheap attempts. A compared candidate must have at least one verified success.
 * Cohort truth and eligibility belong to the caller, not a hash or model-generated verdict.
 * @param base - Validated captured routing policy; no fields are mutated.
 * @param config - Explicit validated evaluation guards and input limits.
 * @param value - Unknown bounded local evidence snapshot, including a deterministic clock.
 * @returns An immutable winner-only proposal or an explicit no-proposal reason with exclusion counts.
 * @throws When evidence fields, duplicate identities, or the input-record cap are invalid.
 */
export function evaluateAdaptivePolicy(
  base: ModelRoutingPolicy,
  config: AdaptivePolicyConfig,
  value: unknown,
): AdaptiveEvaluationResult {
  return evaluate(base, config, parseAdaptiveEvaluationInput(value, config))
}

/**
 * Revalidate a proposed weight patch against its exact base and trusted evidence snapshot.
 * Returns a new policy only: it neither publishes a version nor changes any Session,
 * manual choice, parent rule, authorization, prompt, or active task. The caller must
 * bind evidence and cohort to trusted local state, enforce proposal expiry with a
 * current clock, and admit promotion only for new tasks; UI-supplied evidence is not authority.
 * @param base - Current validated policy that must match the proposal's complete fingerprint.
 * @param config - Current explicit guards, including the maximum relative weight reduction.
 * @param inputValue - Authoritative collector snapshot used to independently recompute the proposal.
 * @param proposalValue - Unknown persisted proposal; extra fields and semantic tampering reject.
 * @returns A frozen policy with only the validated winner's relativeCost changed.
 * @throws When the base, old weight, eligibility, evidence, bounds, or exact recomputed proposal differs.
 */
export function applyAdaptivePolicyPatch(
  base: ModelRoutingPolicy,
  config: AdaptivePolicyConfig,
  inputValue: unknown,
  proposalValue: unknown,
): ModelRoutingPolicy {
  const proposal = parseAdaptivePolicyProposal(proposalValue)
  if (proposal.basePolicyFingerprint !== fingerprintAdaptiveBasePolicy(base)) throw new Error('adaptive patch has a stale base policy')
  const input = parseAdaptiveEvaluationInput(inputValue, config)
  const change = proposal.changes[0]
  const candidate = base.candidates.find(candidate => candidate.id === change.candidateId)
  if (candidate === undefined || candidate.relativeCost !== change.before
    || !input.eligibleCandidateIds.includes(candidate.id)
    || candidate.quality < base.qualityFloors[input.mode][input.complexity]
    || change.candidateId !== proposal.winnerCandidateId
    || change.after >= change.before
    || change.after < change.before * (1 - config.maxRelativeWeightChange)) {
    throw new Error('adaptive patch does not satisfy the allowed weight-only change')
  }
  const expected = evaluate(base, config, input)
  if (expected.kind !== 'proposal' || !deepEqualJson(proposal, expected.proposal)) {
    throw new Error('adaptive patch does not match the guarded evidence evaluation')
  }
  return patchedPolicy(base, change)
}
