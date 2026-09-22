/** Optional learning results cannot replace hard routing policy or affect an existing task. */
import { describe, expect, it } from 'vitest'
import { acceptLearningOverlay } from '../src/learning-overlay.ts'
import type { LearningOverlayAdmission } from '../src/learning-overlay.ts'
import { parseRoutingPolicy } from '../src/policy.ts'

function fixture() {
  const base = parseRoutingPolicy({
    candidates: [
      { id: 'small', selection: { provider: 'p', model: 's', reasoningEffort: 'low' }, quality: 2, relativeCost: 3 },
      { id: 'strong', selection: { provider: 'p', model: 'l', reasoningEffort: 'high' }, quality: 3, relativeCost: 10 },
    ],
    qualityFloors: {
      efficiency: { routine: 1, standard: 2, complex: 3 },
      balanced: { routine: 2, standard: 2, complex: 3 },
      intelligence: { routine: 3, standard: 3, complex: 3 },
    },
    minConfidence: 0.8, conservativeCandidateId: 'strong',
  })
  const classification = { continuity: 'new-task', reasonCode: 'new-task', complexity: 'standard', confidence: 0.9 } as const
  const admission: LearningOverlayAdmission = {
    basePolicyFingerprint: 'fixed-base', mode: 'balanced', classification,
    eligibleCandidateIds: ['small', 'strong'], now: 100, maxRelativeWeightChange: 0.2,
  }
  const overlay = {
    versionId: 'v1', basePolicyFingerprint: 'fixed-base', mode: 'balanced', complexity: 'standard', validUntil: 200,
    weights: [{ candidateId: 'strong', relativeCost: 10 }, { candidateId: 'small', relativeCost: 2.5 }],
  }
  return { base, admission, overlay, classification }
}
function rejectsOverlay(patch: Record<string, unknown>): void {
  const f = fixture()
  expect(acceptLearningOverlay(f.base, f.admission, { ...f.overlay, ...patch })).toBeUndefined()
}
function rejectsAdmission(patch: Partial<LearningOverlayAdmission>): void {
  const f = fixture()
  expect(acceptLearningOverlay(f.base, { ...f.admission, ...patch }, f.overlay)).toBeUndefined()
}

describe('new-task learning weight admission', () => {
  it('changes one bounded weight while preserving every hard rule and original candidate order', () => {
    const { base, admission, overlay } = fixture()
    const accepted = acceptLearningOverlay(base, admission, overlay)
    expect(accepted?.versionId).toBe('v1')
    expect(accepted?.policy).toEqual({
      ...base, candidates: base.candidates.map(candidate => ({
        ...candidate, relativeCost: candidate.id === 'small' ? 2.5 : candidate.relativeCost,
      })),
    })
    expect(base.candidates.map(candidate => candidate.relativeCost)).toEqual([3, 10])
    expect(Object.isFrozen(accepted?.policy.candidates[0]?.selection)).toBe(true)
    expect(Object.isFrozen(accepted?.policy.qualityFloors.balanced)).toBe(true)
    overlay.weights = []
    expect(accepted?.policy.candidates[0]?.relativeCost).toBe(2.5)
  })
  it('refuses same-task, uncertain, missing and invalid-confidence classifications', () => {
    const { classification } = fixture()
    rejectsAdmission({ classification: undefined })
    rejectsAdmission({ classification: { ...classification, continuity: 'same-task' } })
    rejectsAdmission({ classification: { ...classification, reasonCode: 'uncertain' } })
    for (const confidence of [0.79, NaN, 1.1]) rejectsAdmission({ classification: { ...classification, confidence } })
  })
  it('refuses expired or context-mismatched overlays', () => {
    for (const validUntil of [100, Infinity]) rejectsOverlay({ validUntil })
    rejectsOverlay({ basePolicyFingerprint: 'stale' })
    rejectsOverlay({ mode: 'intelligence' })
    rejectsOverlay({ complexity: 'routine' })
  })
  it('cannot add, remove, duplicate, rename or alter more than one candidate', () => {
    const strong = { candidateId: 'strong', relativeCost: 10 }
    const small = { candidateId: 'small', relativeCost: 2.5 }
    for (const weights of [
      [strong, small, { candidateId: 'new', relativeCost: 1 }], [strong], [strong, strong],
      [strong, { candidateId: 'new', relativeCost: 1 }], [{ ...strong, relativeCost: 9 }, small],
    ]) rejectsOverlay({ weights })
  })
  it('refuses increases, no-ops, nonfinite weights and reductions beyond the bound', () => {
    for (const relativeCost of [0, -1, NaN, Infinity, 2.39, 3, 4]) {
      rejectsOverlay({ weights: [{ candidateId: 'strong', relativeCost: 10 }, { candidateId: 'small', relativeCost }] })
    }
    const f = fixture()
    f.overlay.weights = [
      { candidateId: 'strong', relativeCost: 10 },
      { candidateId: 'small', relativeCost: 3 * (1 - f.admission.maxRelativeWeightChange) },
    ]
    expect(acceptLearningOverlay(f.base, f.admission, f.overlay)).toBeDefined()
    for (const maxRelativeWeightChange of [0, 1, -0.1, NaN, Infinity]) rejectsAdmission({ maxRelativeWeightChange })
  })
  it('cannot reduce a currently ineligible or below-floor candidate', () => {
    rejectsAdmission({ eligibleCandidateIds: ['strong'] })
    const f = fixture()
    const base = { ...f.base, candidates: f.base.candidates.map(candidate => ({ ...candidate, quality: 1 as const })) }
    expect(acceptLearningOverlay(base, f.admission, f.overlay)).toBeUndefined()
  })
  it('rejects extra properties that smuggle policy, quality, effort or routes', () => {
    rejectsOverlay({ policy: fixture().base })
    rejectsOverlay({ weights: [
      { candidateId: 'strong', relativeCost: 10 },
      { candidateId: 'small', relativeCost: 2.5, selection: { provider: 'rogue', model: 'cheap' } },
    ] })
    rejectsOverlay({ weights: [
      { candidateId: 'strong', relativeCost: 10 }, { candidateId: 'small', relativeCost: 2.5, quality: 3 },
    ] })
    rejectsOverlay({ [Symbol('unexpected')]: true })
  })
  it('rejects malformed IDs, clocks, arrays and provider values', () => {
    rejectsOverlay({ versionId: ' ' })
    rejectsOverlay({ versionId: 'x'.repeat(129) })
    rejectsOverlay({ weights: null })
    rejectsAdmission({ now: -1 })
    rejectsAdmission({ now: 1.5 })
    const f = fixture()
    for (const value of [undefined, null, false, [], 'text', 5]) {
      expect(acceptLearningOverlay(f.base, f.admission, value)).toBeUndefined()
    }
  })
  it('contains optional provider getter/proxy failures rather than breaking base routing', () => {
    const f = fixture()
    Object.defineProperty(f.overlay, 'weights', { get() { throw new Error('private provider details') } })
    expect(acceptLearningOverlay(f.base, f.admission, f.overlay)).toBeUndefined()
    const proxy = Proxy.revocable({}, {})
    proxy.revoke()
    expect(acceptLearningOverlay(f.base, f.admission, proxy.proxy)).toBeUndefined()
  })
})
