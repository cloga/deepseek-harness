/** Verified local work can propose only a bounded, reproducible winner-weight reduction. */

import { describe, expect, it } from 'vitest'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { parseRoutingPolicy, selectAutoModel } from '../src/policy.ts'
import type { ModelRoutingMode, ModelRoutingPolicy, TaskComplexity } from '../src/types.ts'
import {
  applyAdaptivePolicyPatch, evaluateAdaptivePolicy, fingerprintAdaptiveBasePolicy, parseAdaptiveEvaluationInput, parseAdaptivePolicyConfig,
} from '../src/adaptive-policy.ts'
import type { AdaptiveEvaluationResult, AdaptivePolicyConfig, AdaptivePolicyProposal } from '../src/adaptive-types.ts'

const NOW = 1_000_000
const COHORT = 'local-workspace-profile-main-standard-balanced-route-and-classifier-v1'

interface Observation {
  observationId: string
  taskId: string
  candidateId: string
  cohort: string
  evidence: 'user-confirmed' | 'validator' | 'unverified'
  outcome: 'success' | 'failure' | 'unknown'
  observedRelativeWork: number | null
  workComplete: boolean
  completedAt: number
}

function policy(): ModelRoutingPolicy {
  return parseRoutingPolicy({
    candidates: [
      { id: 'base', selection: { provider: 'p', model: 'opaque', reasoningEffort: 'low' }, quality: 2, relativeCost: 1 },
      { id: 'alternative', selection: { provider: 'p', model: 'opaque', reasoningEffort: 'high' }, quality: 2, relativeCost: 1.2 },
      { id: 'strong', selection: { provider: 'p', model: 'strong' }, quality: 3, relativeCost: 3 },
      { id: 'below-floor', selection: { provider: 'p', model: 'small' }, quality: 1, relativeCost: 0.1 },
    ],
    qualityFloors: {
      efficiency: { routine: 1, standard: 1, complex: 3 },
      balanced: { routine: 2, standard: 2, complex: 3 },
      intelligence: { routine: 3, standard: 3, complex: 3 },
    },
    conservativeCandidateId: 'strong', minConfidence: 0.8,
  })
}

function configuration(overrides: Partial<AdaptivePolicyConfig> = {}): AdaptivePolicyConfig {
  return parseAdaptivePolicyConfig({
    minSamplesPerCandidate: 100, observationWindowMs: 10_000, maxObservations: 1000,
    minRelativeImprovement: 0.2, maxFailureRate: 0.1, maxFailureRateRegression: 0.1,
    confidenceZ: 1.96, maxRelativeWeightChange: 0.5, ...overrides,
  })
}

function samples(candidateId: string, count = 100, relativeWork = 100, failures = 0): Observation[] {
  return Array.from({ length: count }, (_unused, index) => ({
    observationId: `${candidateId}-observation-${String(index)}`,
    taskId: `${candidateId}-task-${String(index)}`,
    candidateId, cohort: COHORT,
    evidence: index % 2 === 0 ? 'validator' : 'user-confirmed',
    outcome: index < failures ? 'failure' : 'success',
    observedRelativeWork: relativeWork, workComplete: true, completedAt: NOW - 1000 + index,
  }))
}

function input(overrides: Partial<{
  cohort: string
  mode: ModelRoutingMode
  complexity: TaskComplexity
  now: number
  eligibleCandidateIds: readonly string[]
  observations: readonly Observation[]
}> = {}) {
  return {
    cohort: COHORT, mode: 'balanced' as ModelRoutingMode, complexity: 'standard' as TaskComplexity, now: NOW,
    eligibleCandidateIds: ['base', 'alternative', 'strong', 'below-floor'],
    observations: [...samples('base'), ...samples('alternative', 100, 50)],
    ...overrides,
  }
}

function proposal(result: AdaptiveEvaluationResult): AdaptivePolicyProposal {
  if (result.kind !== 'proposal') throw new Error(`expected proposal, got ${result.reasonCode}`)
  return result.proposal
}

function changeWeights(base: ModelRoutingPolicy, weights: Record<string, number>): ModelRoutingPolicy {
  return parseRoutingPolicy({
    ...base,
    candidates: base.candidates.map(candidate => ({
      ...candidate, relativeCost: weights[candidate.id] ?? candidate.relativeCost,
    })),
  })
}

describe('adaptive configuration and evidence parsing', () => {
  it('requires every explicit guard and returns a detached frozen configuration', () => {
    const source = { ...configuration() }
    const parsed = parseAdaptivePolicyConfig(source)
    source.minSamplesPerCandidate = 1
    expect(parsed.minSamplesPerCandidate).toBe(100)
    expect(Object.isFrozen(parsed)).toBe(true)
    for (const key of Object.keys(source)) {
      const missing = Object.fromEntries(Object.entries(source).filter(([field]) => field !== key))
      expect(() => parseAdaptivePolicyConfig(missing)).toThrow()
    }
    expect(() => parseAdaptivePolicyConfig({ ...source, prompt: 'edit this policy' })).toThrow()
  })

  it('rejects malformed budgets, fractions and unsafe z-score arithmetic', () => {
    for (const key of ['minSamplesPerCandidate', 'observationWindowMs', 'maxObservations'] as const) {
      for (const value of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1]) {
        expect(() => configuration({ [key]: value })).toThrow()
      }
    }
    for (const key of ['minRelativeImprovement', 'maxFailureRate', 'maxFailureRateRegression'] as const) {
      for (const value of [-0.1, 1.1, Infinity, NaN]) expect(() => configuration({ [key]: value })).toThrow()
    }
    for (const value of [0, 1, -1, Infinity, NaN]) expect(() => configuration({ maxRelativeWeightChange: value })).toThrow()
    for (const value of [0, -1, Infinity, 1e200, Number.MIN_VALUE]) expect(() => configuration({ confidenceZ: value })).toThrow()
    expect(() => configuration({ maxObservations: 199 })).toThrow(/two compared candidates/)
  })

  it('rejects malformed observations, extra prompt/code/error fields and oversized input windows', () => {
    const base = policy()
    const config = configuration()
    const observation = samples('base', 1)[0]!
    for (const patch of [
      { observedRelativeWork: Infinity }, { observedRelativeWork: -1 }, { observedRelativeWork: NaN },
      { completedAt: -1 }, { completedAt: 0.5 }, { evidence: 'self-reported' }, { outcome: 'probably' },
      { observationId: '' }, { taskId: '' }, { cohort: '' }, { candidateId: '' }, { workComplete: 'yes' },
      { prompt: 'private task' }, { code: 'private source' }, { error: 'provider secret' },
    ]) {
      expect(() => evaluateAdaptivePolicy(base, config, input({ observations: [{ ...observation, ...patch } as Observation] }))).toThrow()
    }
    expect(() => evaluateAdaptivePolicy(base, config, { ...input(), manualChoice: 'another-route' })).toThrow()
    expect(() => evaluateAdaptivePolicy(base, config, { ...input(), mode: 'manual' })).toThrow()
    expect(() => evaluateAdaptivePolicy(base, config, { ...input(), observations: null })).toThrow()
    expect(() => evaluateAdaptivePolicy(base, config, input({ observations: samples('base', 1001) }))).toThrow(/maxObservations/)
  })

  it('orders equal-time observations by codepoint identity independently of input ordering or locale', () => {
    const observations = samples('base', 4).map((row, index) => ({
      ...row, observationId: ['z', 'a', 'Z', 'A'][index]!, completedAt: NOW,
    }))
    const parsed = parseAdaptiveEvaluationInput(input({ observations }), configuration())
    expect(parsed.observations.map(row => row.observationId)).toEqual(['A', 'Z', 'a', 'z'])
    expect(parseAdaptiveEvaluationInput(input({ observations: [...observations].reverse() }), configuration())).toEqual(parsed)
    expect(Object.isFrozen(parsed.observations)).toBe(true)
    expect(observations.map(row => row.observationId)).toEqual(['z', 'a', 'Z', 'A'])
  })

  it('rejects duplicate observation ids and duplicate tasks even when the duplicate would be excluded', () => {
    const source = input()
    const first = source.observations[0]!
    const duplicateId = { ...first, taskId: 'different-task' }
    const duplicateTask = { ...first, observationId: 'different-observation', cohort: 'unrelated-old-cohort' }
    expect(() => evaluateAdaptivePolicy(policy(), configuration(), {
      ...source, observations: [...source.observations, duplicateId],
    })).toThrow(/observation id/)
    expect(() => evaluateAdaptivePolicy(policy(), configuration(), {
      ...source, observations: [...source.observations, duplicateTask],
    })).toThrow(/task id/)
  })
})

describe('guarded adaptive evaluation', () => {
  it('proposes one bounded reduction with observed evidence and changes only that candidate weight', () => {
    const base = policy()
    const config = configuration()
    const source = input()
    const result = proposal(evaluateAdaptivePolicy(base, config, source))
    expect(result).toMatchObject({
      schemaVersion: 1, cohort: COHORT, mode: 'balanced', complexity: 'standard', evaluatedAt: NOW,
      baselineCandidateId: 'base', winnerCandidateId: 'alternative', reasonCode: 'verified-work-improvement',
      changes: [{ candidateId: 'alternative', before: 1.2, after: 0.6 }],
      evidence: {
        summary: { received: 200, accepted: 200, windowStart: NOW - 10_000, windowEnd: NOW },
        baseline: { samples: 100, failures: 0, successes: 100, relativeWorkPerSuccess: 100 },
        winner: { samples: 100, failures: 0, successes: 100, relativeWorkPerSuccess: 50 }, relativeWorkImprovement: 0.5,
      },
    })
    expect(result.evidence.winner.failureUpperBound).toBeGreaterThan(0)
    expect(result.evidence.winner.failureUpperBound).toBeLessThan(0.1)
    expect(result.basePolicyFingerprint).toBe(fingerprintAdaptiveBasePolicy(base))
    const applied = applyAdaptivePolicyPatch(base, config, source, result)
    for (const candidate of base.candidates) {
      expect(applied.candidates.find(value => value.id === candidate.id)).toEqual({
        ...candidate, relativeCost: candidate.id === 'alternative' ? 0.6 : candidate.relativeCost,
      })
    }
    expect(applied.qualityFloors).toEqual(base.qualityFloors)
    expect(applied.conservativeCandidateId).toBe(base.conservativeCandidateId)
    expect(applied.minConfidence).toBe(base.minConfidence)
    expect(selectAutoModel(applied, {
      mode: 'balanced', eligibleCandidateIds: source.eligibleCandidateIds,
      current: base.candidates[0]!.selection,
      classification: { continuity: 'new-task', complexity: 'standard', confidence: 1, reasonCode: 'new-task' },
    }).candidateId).toBe('alternative')
  })

  it('accounts for excluded samples without converting unknown work or unverified outcomes into successes', () => {
    const extra = samples('base-extra', 9).map((row, index) => ({ ...row, candidateId: 'base', observationId: `extra-${index}` }))
    extra[0]!.cohort = 'different-workspace-or-role'
    extra[1]!.completedAt = NOW - 10_001
    extra[2]!.completedAt = NOW + 1
    extra[3]!.candidateId = 'unseen'
    extra[4]!.candidateId = 'below-floor'
    extra[5]!.evidence = 'unverified'
    extra[6]!.outcome = 'unknown'
    extra[7]!.workComplete = false
    extra[8]!.observedRelativeWork = null
    const result = proposal(evaluateAdaptivePolicy(policy(), configuration(), input({
      observations: [...input().observations, ...extra],
    })))
    expect(result.evidence.summary).toMatchObject({
      received: 209, accepted: 200,
      excluded: {
        uncorrelated: 1, expired: 1, future: 1, ineligible: 1,
        belowQualityFloor: 1, unverified: 1, unknownOutcome: 1, incompleteWork: 2,
      },
    })
    expect(result.evidence.baseline.samples).toBe(100)
  })

  it('uses inclusive clock boundaries and no ambient time source', () => {
    const source = input()
    source.observations[0]!.completedAt = NOW - 10_000
    source.observations[1]!.completedAt = NOW
    const result = proposal(evaluateAdaptivePolicy(policy(), configuration(), source))
    expect(result.evidence.summary.accepted).toBe(200)
    expect(evaluateAdaptivePolicy(policy(), configuration(), { ...source, now: NOW + 100_000 })).toMatchObject({
      kind: 'no-proposal', reasonCode: 'no-comparable-observations', summary: { accepted: 0 },
    })
  })

  it('requires sufficient comparable samples for both the baseline and an alternative', () => {
    const base = policy()
    const config = configuration()
    expect(evaluateAdaptivePolicy(base, config, input({ observations: [] }))).toMatchObject({ reasonCode: 'no-comparable-observations' })
    expect(evaluateAdaptivePolicy(base, config, input({ observations: samples('alternative', 100, 10) })))
      .toMatchObject({ reasonCode: 'insufficient-baseline-evidence' })
    expect(evaluateAdaptivePolicy(base, config, input({ observations: [...samples('base'), ...samples('alternative', 99, 10)] })))
      .toMatchObject({ reasonCode: 'insufficient-alternative-evidence' })
    const unknown = samples('alternative')
    unknown[0]!.observedRelativeWork = null
    expect(evaluateAdaptivePolicy(base, config, input({ observations: [...samples('base'), ...unknown] })))
      .toMatchObject({ reasonCode: 'insufficient-alternative-evidence' })
  })

  it('keeps sample minimum necessary but insufficient under conservative failure bounds', () => {
    const result = evaluateAdaptivePolicy(policy(), configuration({ minSamplesPerCandidate: 10 }), input({
      observations: [...samples('base', 10), ...samples('alternative', 10, 10)],
    }))
    expect(result).toMatchObject({ kind: 'no-proposal', reasonCode: 'failure-risk' })
    expect(evaluateAdaptivePolicy(policy(), configuration({ maxFailureRateRegression: 0 }), input()))
      .toMatchObject({ reasonCode: 'failure-risk' })
    expect(evaluateAdaptivePolicy(policy(), configuration({ maxFailureRateRegression: 0 }), input({
      observations: [...samples('base', 100, 100, 20), ...samples('alternative', 100, 50)],
    })).kind).toBe('proposal')
  })

  it('rejects cheaper failure-prone alternatives rather than easing the failure guard', () => {
    expect(evaluateAdaptivePolicy(policy(), configuration(), input({
      observations: [...samples('base'), ...samples('alternative', 100, 1, 50)],
    }))).toMatchObject({ reasonCode: 'failure-risk' })
  })

  it('rejects cheaper attempts whose failed work makes each verified success more expensive', () => {
    const config = configuration({ minRelativeImprovement: 0.05, maxFailureRate: 0.5, maxFailureRateRegression: 0.5 })
    const source = input({
      observations: [...samples('base', 100, 100, 1), ...samples('alternative', 100, 90, 15)],
    })
    // The lower attempt cost hides a higher total per success: 9000/85 exceeds 10000/99.
    expect(evaluateAdaptivePolicy(policy(), config, source)).toMatchObject({
      kind: 'no-proposal', reasonCode: 'no-work-improvement', summary: { accepted: 200 },
    })
  })

  it('includes failed-task work in the numerator and only verified successes in the denominator', () => {
    const config = configuration({ maxFailureRate: 0.5, maxFailureRateRegression: 0.5 })
    const alternative = samples('alternative', 100, 50, 10)
    for (const row of alternative) {
      if (row.outcome === 'failure') row.observedRelativeWork = 150
    }
    const source = input({ observations: [...samples('base', 100, 100, 20), ...alternative] })
    const result = proposal(evaluateAdaptivePolicy(policy(), config, source))
    expect(result.evidence.baseline).toMatchObject({ samples: 100, failures: 20, successes: 80, relativeWorkPerSuccess: 125 })
    expect(result.evidence.winner).toMatchObject({ samples: 100, failures: 10, successes: 90 })
    expect(result.evidence.winner.relativeWorkPerSuccess).toBeCloseTo((90 * 50 + 10 * 150) / 90)
    expect(result.evidence.winner.observationIds).toHaveLength(100)
    expect(result.evidence.relativeWorkImprovement).toBeCloseTo(1 - (6000 / 90) / (10000 / 80))
    expect(applyAdaptivePolicyPatch(policy(), config, source, result).candidates[1]!.relativeCost).toBe(0.6)
  })

  it.each(['base', 'alternative'] as const)('refuses a zero-success %s even with permissive failure guards', (failed) => {
    const config = configuration({ minRelativeImprovement: 0, maxFailureRate: 1, maxFailureRateRegression: 1 })
    const source = input({ observations: [
      ...samples('base', 100, 100, failed === 'base' ? 100 : 0),
      ...samples('alternative', 100, 1, failed === 'alternative' ? 100 : 0),
    ] })
    expect(evaluateAdaptivePolicy(policy(), config, source)).toMatchObject({
      kind: 'no-proposal',
      reasonCode: failed === 'base' ? 'no-baseline-successes' : 'no-alternative-successes',
      summary: { received: 200, accepted: 200 },
    })
  })

  it('skips an all-failure cheap alternative instead of letting it outrank a successful candidate', () => {
    const base = changeWeights(policy(), { strong: 1.3 })
    const config = configuration({ maxFailureRate: 1, maxFailureRateRegression: 1 })
    const result = proposal(evaluateAdaptivePolicy(base, config, input({ observations: [
      ...samples('base'), ...samples('alternative', 100, 1, 100), ...samples('strong', 100, 50),
    ] })))
    expect(result.winnerCandidateId).toBe('strong')
    expect(result.evidence.winner.successes).toBe(100)
    expect(result.changes).toEqual([{ candidateId: 'strong', before: 1.3, after: 0.65 }])
  })

  it.each(['base', 'alternative'] as const)('fails closed when total work per success overflows for the %s', (overflow) => {
    const config = configuration({ maxFailureRate: 1, maxFailureRateRegression: 1 })
    const source = input({ observations: [
      ...samples('base', 100, overflow === 'base' ? Number.MAX_VALUE : 100, overflow === 'base' ? 99 : 0),
      ...samples('alternative', 100, overflow === 'alternative' ? Number.MAX_VALUE : 50, overflow === 'alternative' ? 99 : 0),
    ] })
    expect(evaluateAdaptivePolicy(policy(), config, source)).toMatchObject({ kind: 'no-proposal', reasonCode: 'arithmetic-limit' })
  })

  it('fails closed if a structural caller bypasses validation with an overflowing confidence coefficient', () => {
    const malformed: AdaptivePolicyConfig = { ...configuration(), confidenceZ: Number.MAX_VALUE }
    expect(() => parseAdaptivePolicyConfig(malformed)).toThrow()
    expect(evaluateAdaptivePolicy(policy(), malformed, input())).toMatchObject({
      kind: 'no-proposal', reasonCode: 'arithmetic-limit',
    })
  })

  it('avoids intermediate total overflow when work per success remains representable despite failures', () => {
    const config = configuration({ maxFailureRate: 1, maxFailureRateRegression: 1 })
    const source = input({ observations: [
      ...samples('base', 100, Number.MAX_VALUE / 4, 50),
      ...samples('alternative', 100, Number.MAX_VALUE / 16, 25),
    ] })
    const result = proposal(evaluateAdaptivePolicy(policy(), config, source))
    expect(result.evidence.baseline.successes).toBe(50)
    expect(result.evidence.winner.successes).toBe(75)
    expect(result.evidence.baseline.relativeWorkPerSuccess / Number.MAX_VALUE).toBeCloseTo(0.5)
    expect(result.evidence.winner.relativeWorkPerSuccess / Number.MAX_VALUE).toBeCloseTo(1 / 12)
    expect(Number.isFinite(result.evidence.baseline.relativeWorkPerSuccess)).toBe(true)
    expect(Number.isFinite(result.evidence.winner.relativeWorkPerSuccess)).toBe(true)
    expect(applyAdaptivePolicyPatch(policy(), config, source, result).candidates[1]!.relativeCost).toBe(0.6)
  })

  it('does not invent measured work improvements or unseen-model counterfactuals', () => {
    for (const alternativeWork of [100, 120, 90]) {
      expect(evaluateAdaptivePolicy(policy(), configuration(), input({
        observations: [...samples('base'), ...samples('alternative', 100, alternativeWork)],
      }))).toMatchObject({ reasonCode: 'no-work-improvement' })
    }
    expect(evaluateAdaptivePolicy(policy(), configuration(), input({
      observations: [...samples('base'), ...samples('unseen', 100, 1)],
    }))).toMatchObject({ reasonCode: 'insufficient-alternative-evidence', summary: { excluded: { ineligible: 100 } } })
    expect(evaluateAdaptivePolicy(policy(), configuration(), input({
      observations: [...samples('base', 100, 0), ...samples('alternative', 100, 0)],
    }))).toMatchObject({ reasonCode: 'no-work-improvement' })
  })

  it('does not relax caller eligibility or task quality floors', () => {
    expect(evaluateAdaptivePolicy(policy(), configuration(), input({ eligibleCandidateIds: [] })))
      .toMatchObject({ reasonCode: 'no-eligible-baseline' })
    expect(evaluateAdaptivePolicy(policy(), configuration(), input({ eligibleCandidateIds: ['base'] })))
      .toMatchObject({ reasonCode: 'no-qualified-alternative' })
    expect(evaluateAdaptivePolicy(policy(), configuration(), input({ complexity: 'complex' })))
      .toMatchObject({ reasonCode: 'no-qualified-alternative', baselineCandidateId: 'strong' })
    const disallowed = evaluateAdaptivePolicy(policy(), configuration(), input({ eligibleCandidateIds: ['base', 'strong'] }))
    expect(disallowed).toMatchObject({ reasonCode: 'insufficient-alternative-evidence', summary: { excluded: { ineligible: 100 } } })
  })

  it('separates exact model-effort identities and collector-owned scope/revision cohorts', () => {
    const base = policy()
    const result = proposal(evaluateAdaptivePolicy(base, configuration(), input()))
    expect(base.candidates[0]!.selection.model).toBe(base.candidates[1]!.selection.model)
    expect(base.candidates[0]!.selection.reasoningEffort).not.toBe(base.candidates[1]!.selection.reasoningEffort)
    expect(result.baselineCandidateId).not.toBe(result.winnerCandidateId)
    expect(evaluateAdaptivePolicy(base, configuration(), input({ cohort: 'child-role-or-resolved-default-v2' })))
      .toMatchObject({ reasonCode: 'no-comparable-observations', summary: { excluded: { uncorrelated: 200 } } })
    const changed = parseRoutingPolicy({
      ...base,
      candidates: base.candidates.map(candidate => candidate.id === 'base'
        ? { ...candidate, selection: { provider: 'p', model: 'opaque' } } : candidate),
    })
    expect(fingerprintAdaptiveBasePolicy(changed)).not.toBe(fingerprintAdaptiveBasePolicy(base))
  })

  it('refuses an ineffective bounded patch and never compensates by raising another weight', () => {
    const base = changeWeights(policy(), { alternative: 4 })
    expect(evaluateAdaptivePolicy(base, configuration(), input())).toMatchObject({ reasonCode: 'bounded-patch-no-effect' })
    expect(base.candidates.find(candidate => candidate.id === 'base')?.relativeCost).toBe(1)
    const tied = changeWeights(policy(), { alternative: 2 })
    const alternativeFirst = parseRoutingPolicy({
      ...tied, candidates: [tied.candidates[1], tied.candidates[0], ...tied.candidates.slice(2)],
    })
    expect(evaluateAdaptivePolicy(alternativeFirst, configuration(), input()))
      .toMatchObject({ reasonCode: 'bounded-patch-no-effect' })
  })

  it('can select the next measured improvement when the cheapest observed alternative cannot cross the weight bound', () => {
    const result = proposal(evaluateAdaptivePolicy(policy(), configuration(), input({
      observations: [...input().observations, ...samples('strong', 100, 20)],
    })))
    expect(result.winnerCandidateId).toBe('alternative')
    expect(result.changes).toHaveLength(1)
  })

  it('handles extreme finite work and weights without overflowing summed work', () => {
    const base = changeWeights(policy(), { base: Number.MAX_VALUE / 2, alternative: Number.MAX_VALUE })
    const config = configuration({ maxRelativeWeightChange: 0.75 })
    const source = input({
      eligibleCandidateIds: ['base', 'alternative'],
      observations: [...samples('base', 100, Number.MAX_VALUE), ...samples('alternative', 100, Number.MAX_VALUE / 2)],
    })
    const result = proposal(evaluateAdaptivePolicy(base, config, source))
    expect(Number.isFinite(result.evidence.baseline.relativeWorkPerSuccess)).toBe(true)
    expect(Number.isFinite(result.changes[0].after)).toBe(true)
    expect(result.changes[0].after).toBeGreaterThan(0)
    expect(applyAdaptivePolicyPatch(base, config, source, result).candidates[1]!.relativeCost).toBe(result.changes[0].after)
    const extremeZ = evaluateAdaptivePolicy(policy(), configuration({ confidenceZ: 1e154 }), input())
    expect(extremeZ).toMatchObject({ reasonCode: 'failure-risk' })
  })

  it('refuses underflowed per-success ratios or zero weights rather than serializing invalid arithmetic', () => {
    const tiny = changeWeights(policy(), { base: Number.MIN_VALUE, alternative: Number.MIN_VALUE })
    expect(evaluateAdaptivePolicy(tiny, configuration({ maxRelativeWeightChange: 0.9 }), input()))
      .toMatchObject({ reasonCode: 'arithmetic-limit' })
    for (const candidate of ['base', 'alternative']) {
      const rows = samples(candidate, 100, 0)
      rows[0]!.observedRelativeWork = Number.MIN_VALUE
      const observations = candidate === 'base'
        ? [...rows, ...samples('alternative', 100, 0)] : [...samples('base'), ...rows]
      expect(evaluateAdaptivePolicy(policy(), configuration(), input({ observations })))
        .toMatchObject({ reasonCode: 'arithmetic-limit' })
    }
  })
})

describe('adaptive fingerprints and patch admission', () => {
  it('fingerprints canonical fields rather than object insertion order, including tie order and hard rules', () => {
    const base = policy()
    const reordered = {
      conservativeCandidateId: base.conservativeCandidateId, minConfidence: base.minConfidence,
      qualityFloors: base.qualityFloors, candidates: base.candidates.map(candidate => ({
        relativeCost: candidate.relativeCost, quality: candidate.quality, selection: candidate.selection, id: candidate.id,
      })),
    }
    expect(fingerprintAdaptiveBasePolicy(reordered)).toBe(fingerprintAdaptiveBasePolicy(base))
    const variants: ModelRoutingPolicy[] = [
      parseRoutingPolicy({ ...base, minConfidence: 0.7 }),
      parseRoutingPolicy({ ...base, candidates: [...base.candidates].reverse() }),
      parseRoutingPolicy({ ...base, qualityFloors: { ...base.qualityFloors, balanced: { routine: 3, standard: 3, complex: 3 } } }),
      parseRoutingPolicy({ ...base, candidates: base.candidates.map(candidate => candidate.id === 'alternative'
        ? { ...candidate, selection: { provider: 'other', model: 'opaque', reasoningEffort: ReasoningEffortId('high') } } : candidate) }),
    ]
    for (const changed of variants) expect(fingerprintAdaptiveBasePolicy(changed)).not.toBe(fingerprintAdaptiveBasePolicy(base))
  })

  it('rejects stale bases, old weights, nonpositive/nonfinite results, and changes beyond the cap', () => {
    const base = policy()
    const config = configuration()
    const source = input()
    const good = proposal(evaluateAdaptivePolicy(base, config, source))
    expect(() => applyAdaptivePolicyPatch(changeWeights(base, { alternative: 1.3 }), config, source, good)).toThrow(/stale base/)
    for (const after of [0, -1, NaN, Infinity, 0.59, 1.2, 2]) {
      const bad = { ...good, changes: [{ ...good.changes[0], after }] }
      expect(() => applyAdaptivePolicyPatch(base, config, source, bad)).toThrow()
    }
    expect(() => applyAdaptivePolicyPatch(base, config, source, {
      ...good, changes: [{ ...good.changes[0], before: 1.3 }],
    })).toThrow(/weight-only/)
  })

  it('rejects extra policy fields and rehashed semantic counterexamples against eligibility and quality', () => {
    const base = policy()
    const config = configuration()
    const source = input()
    const good = proposal(evaluateAdaptivePolicy(base, config, source))
    for (const extra of [
      { qualityFloors: base.qualityFloors }, { candidates: [] }, { permissions: ['all'] }, { prompt: 'choose me' },
    ]) expect(() => applyAdaptivePolicyPatch(base, config, source, { ...good, ...extra })).toThrow()
    expect(() => applyAdaptivePolicyPatch(base, config, source, {
      ...good, changes: [{ ...good.changes[0], selection: { provider: 'unauthorized', model: 'new' } }],
    })).toThrow()
    const rehashed = {
      ...good, basePolicyFingerprint: fingerprintAdaptiveBasePolicy(base), winnerCandidateId: 'below-floor',
      changes: [{ candidateId: 'below-floor', before: 0.1, after: 0.05 }],
    }
    expect(() => applyAdaptivePolicyPatch(base, config, source, rehashed)).toThrow(/weight-only/)
    expect(() => applyAdaptivePolicyPatch(base, config, { ...source, eligibleCandidateIds: ['base', 'strong'] }, good))
      .toThrow(/weight-only/)
    expect(() => applyAdaptivePolicyPatch(base, config, source, { ...good, changes: [good.changes[0], good.changes[0]] })).toThrow()
  })

  it('recomputes evidence and rejects plausible-looking tampered proposals instead of trusting their metadata', () => {
    const base = policy()
    const config = configuration()
    const source = input()
    const good = proposal(evaluateAdaptivePolicy(base, config, source))
    for (const bad of [
      { ...good, changes: [{ ...good.changes[0], after: 0.7 }] },
      { ...good, cohort: 'different-cohort' },
      { ...good, evaluatedAt: NOW + 1 },
      { ...good, baselineCandidateId: 'strong' },
      { ...good, evidence: { ...good.evidence, relativeWorkImprovement: 0.9 } },
      { ...good, evidence: { ...good.evidence, winner: { ...good.evidence.winner, failureUpperBound: 0 } } },
    ]) expect(() => applyAdaptivePolicyPatch(base, config, source, bad)).toThrow(/guarded evidence/)
    expect(() => applyAdaptivePolicyPatch(base, config, input({ observations: [] }), good)).toThrow(/guarded evidence/)
  })

  it('rejects attempt-mean evidence fields and forged success counts under the strict proposal schema', () => {
    const base = policy()
    const config = configuration()
    const source = input()
    const good = proposal(evaluateAdaptivePolicy(base, config, source))
    const { relativeWorkPerSuccess: _metric, ...legacyWinner } = good.evidence.winner
    expect(() => applyAdaptivePolicyPatch(base, config, source, {
      ...good, evidence: { ...good.evidence, winner: { ...legacyWinner, meanRelativeWork: 50 } },
    })).toThrow()
    for (const successes of [0, 99]) {
      expect(() => applyAdaptivePolicyPatch(base, config, source, {
        ...good, evidence: { ...good.evidence, winner: { ...good.evidence.winner, successes } },
      })).toThrow()
    }
    expect(() => applyAdaptivePolicyPatch(base, config, source, {
      ...good, evidence: { ...good.evidence, winner: { ...good.evidence.winner, relativeWorkPerSuccess: 40 } },
    })).toThrow(/guarded evidence/)
  })

  it('is deterministic across input order and immutable, while separate evidence snapshots remain distinguishable', () => {
    const base = policy()
    const config = configuration()
    const source = deepFreeze(input())
    const before = JSON.stringify({ base, config, source })
    const first = proposal(evaluateAdaptivePolicy(base, config, source))
    expect(evaluateAdaptivePolicy(base, config, { ...source, observations: [...source.observations].reverse() }))
      .toEqual({ kind: 'proposal', proposal: first })
    const secondInput = {
      ...source,
      observations: source.observations.map(row => ({ ...row, observationId: `${row.observationId}-run2`, taskId: `${row.taskId}-run2` })),
    }
    const second = proposal(evaluateAdaptivePolicy(base, config, secondInput))
    expect(second.changes).toEqual(first.changes)
    expect(second.evidence).not.toEqual(first.evidence)
    expect(() => applyAdaptivePolicyPatch(base, config, secondInput, first)).toThrow(/guarded evidence/)
    const next = applyAdaptivePolicyPatch(base, config, source, JSON.parse(JSON.stringify(first)))
    expect(JSON.stringify({ base, config, source })).toBe(before)
    expect(Object.isFrozen(first)).toBe(true)
    expect(Object.isFrozen(first.changes)).toBe(true)
    expect(Object.isFrozen(first.evidence.winner.observationIds)).toBe(true)
    expect(Object.isFrozen(next.candidates)).toBe(true)
    expect(next).not.toBe(base)
  })
})
