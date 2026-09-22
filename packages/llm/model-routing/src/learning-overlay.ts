/** Lower-router defense: a learning owner can supply weights, never a replacement policy or route. */
import type { ModelRoutingMode, ModelRoutingPolicy, TaskClassification } from './types.ts'

/** Cropped versioned weights; the higher owner separately authorizes retained evidence. */
export interface LearningWeightOverlay {
  readonly versionId: string
  readonly basePolicyFingerprint: string
  readonly mode: ModelRoutingMode
  readonly complexity: TaskClassification['complexity']
  readonly validUntil: number
  readonly weights: readonly { readonly candidateId: string; readonly relativeCost: number }[]
}

/** Exact new-task context and reduction ceiling supplied by the lower routing owner. */
export interface LearningOverlayAdmission {
  readonly basePolicyFingerprint: string
  readonly mode: ModelRoutingMode
  readonly classification: TaskClassification | undefined
  readonly eligibleCandidateIds: readonly string[]
  readonly now: number
  readonly maxRelativeWeightChange: number
}

/** Detached validated policy retaining the unchanged human-owned hard constraints. */
export interface AcceptedLearningOverlay {
  readonly versionId: string
  readonly policy: ModelRoutingPolicy
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value)
  return actual.length === keys.length && actual.every(key => typeof key === 'string' && keys.includes(key))
}

/**
 * Validate a cropped, untrusted provider result at genuine new-task admission.
 * The higher learning owner separately authorizes evidence, cohort, config revisions,
 * expiry and active-version state. A matching fingerprint alone grants no authority.
 * Rejection leaves the normal base policy untouched; no callback or model is invoked.
 * @param base - Validated captured human policy whose routes and hard rules remain unchanged.
 * @param admission - Exact new-task context, clock, eligibility and bounded reduction ceiling.
 * @param value - Unknown cropped result returned by the optional learning owner.
 * @returns A detached validated weight overlay, or undefined to keep the base policy.
 */
export function acceptLearningOverlay(
  base: ModelRoutingPolicy,
  admission: LearningOverlayAdmission,
  value: unknown,
): AcceptedLearningOverlay | undefined {
  try {
    return validateLearningOverlay(base, admission, value)
  } catch (_error: unknown) {
    // Optional provider failures cannot interrupt the ordinary base-policy route.
    return undefined
  }
}

function validateLearningOverlay(
  base: ModelRoutingPolicy,
  admission: LearningOverlayAdmission,
  value: unknown,
): AcceptedLearningOverlay | undefined {
  const classification = admission.classification
  if (classification === undefined || classification.continuity !== 'new-task'
    || classification.reasonCode !== 'new-task' || !Number.isFinite(classification.confidence)
    || classification.confidence < base.minConfidence || classification.confidence > 1
    || !Number.isSafeInteger(admission.now) || admission.now < 0
    || !Number.isFinite(admission.maxRelativeWeightChange)
    || admission.maxRelativeWeightChange <= 0 || admission.maxRelativeWeightChange >= 1) return undefined
  if (!record(value) || !exactKeys(value, ['versionId', 'basePolicyFingerprint', 'mode', 'complexity', 'validUntil', 'weights'])
    || typeof value.versionId !== 'string' || value.versionId.trim().length === 0 || value.versionId.length > 128
    || value.basePolicyFingerprint !== admission.basePolicyFingerprint
    || value.mode !== admission.mode || value.complexity !== classification.complexity
    || typeof value.validUntil !== 'number' || !Number.isSafeInteger(value.validUntil) || value.validUntil <= admission.now
    || !Array.isArray(value.weights) || value.weights.length !== base.candidates.length) return undefined
  const weights = new Map<string, number>()
  let changedId: string | undefined
  for (const raw of value.weights as unknown[]) {
    if (!record(raw) || !exactKeys(raw, ['candidateId', 'relativeCost']) || typeof raw.candidateId !== 'string'
      || typeof raw.relativeCost !== 'number' || !Number.isFinite(raw.relativeCost) || raw.relativeCost <= 0
      || weights.has(raw.candidateId)) return undefined
    const candidate = base.candidates.find(candidate => candidate.id === raw.candidateId)
    if (candidate === undefined || raw.relativeCost > candidate.relativeCost) return undefined
    if (raw.relativeCost !== candidate.relativeCost) {
      if (changedId !== undefined || !admission.eligibleCandidateIds.includes(candidate.id)
        || candidate.quality < base.qualityFloors[admission.mode][classification.complexity]) return undefined
      const floor = candidate.relativeCost * (1 - admission.maxRelativeWeightChange)
      if (!Number.isFinite(floor) || floor <= 0 || raw.relativeCost < floor) return undefined
      changedId = candidate.id
    }
    weights.set(candidate.id, raw.relativeCost)
  }
  if (changedId === undefined) return undefined
  const candidates = Object.freeze(base.candidates.map(candidate => Object.freeze({
    id: candidate.id,
    selection: Object.freeze({ ...candidate.selection }),
    quality: candidate.quality,
    relativeCost: weights.get(candidate.id) as number,
  })))
  const qualityFloors = Object.freeze({
    efficiency: Object.freeze({ ...base.qualityFloors.efficiency }),
    balanced: Object.freeze({ ...base.qualityFloors.balanced }),
    intelligence: Object.freeze({ ...base.qualityFloors.intelligence }),
  })
  return Object.freeze({
    versionId: value.versionId,
    policy: Object.freeze({
      candidates, qualityFloors, minConfidence: base.minConfidence,
      conservativeCandidateId: base.conservativeCandidateId,
    }),
  })
}
