import { describe, expect, it } from 'vitest'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import {
  ModelRoutingSelectionError,
  parseRoutingPolicy,
  parseTaskClassification,
  parseTaskClassificationJson,
  selectAutoModel,
} from '../src/policy.ts'
import type {
  ModelRoutingMode,
  SelectAutoModelRequest,
  TaskClassification,
  TaskComplexity,
} from '../src/types.ts'

function configuration() {
  const candidates: { id: string; selection: ModelSelection; quality: number; relativeCost: number }[] = [
    { id: 'small', selection: { provider: 'provider-a', model: 'opaque-1' }, quality: 1, relativeCost: 1 },
    { id: 'medium', selection: { provider: 'provider-a', model: 'opaque-2' }, quality: 2, relativeCost: 3 },
    { id: 'large', selection: { provider: 'provider-b', model: 'opaque-3' }, quality: 3, relativeCost: 8 },
  ]
  return {
    candidates,
    qualityFloors: {
      efficiency: { routine: 1, standard: 1, complex: 3 },
      balanced: { routine: 1, standard: 2, complex: 3 },
      intelligence: { routine: 3, standard: 3, complex: 3 },
    },
    minConfidence: 0.8,
    conservativeCandidateId: 'large',
  }
}

function classification(overrides: Partial<TaskClassification> = {}): TaskClassification {
  return { continuity: 'new-task', complexity: 'routine', confidence: 0.9, reasonCode: 'new-task', ...overrides }
}

function request(overrides: Partial<SelectAutoModelRequest> = {}): SelectAutoModelRequest {
  return {
    mode: 'balanced',
    eligibleCandidateIds: ['small', 'medium', 'large'],
    classification: classification(),
    ...overrides,
  }
}

describe('routing policy configuration', () => {
  it('detaches and deeply freezes every retained input', () => {
    const input = configuration()
    const parsed = parseRoutingPolicy(input)
    input.candidates[0]!.selection.model = 'changed'
    input.qualityFloors.balanced.routine = 3
    input.candidates.reverse()
    expect(parsed.candidates[0]?.selection.model).toBe('opaque-1')
    expect(parsed.qualityFloors.balanced.routine).toBe(1)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(Object.isFrozen(parsed.candidates)).toBe(true)
    expect(parsed.candidates.every(candidate => Object.isFrozen(candidate) && Object.isFrozen(candidate.selection))).toBe(true)
    expect(Object.isFrozen(parsed.qualityFloors)).toBe(true)
    expect(Object.values(parsed.qualityFloors).every(Object.isFrozen)).toBe(true)
  })

  it('accepts fractional positive cost weights and inclusive confidence endpoints', () => {
    for (const minConfidence of [0, 1]) {
      const input = configuration()
      input.minConfidence = minConfidence
      input.candidates[0]!.relativeCost = 0.25
      expect(parseRoutingPolicy(input).candidates[0]?.relativeCost).toBe(0.25)
    }
  })

  it('preserves exact opaque IDs without inferring quality from their names', () => {
    const input = configuration()
    input.candidates[0]!.selection.model = 'most-intelligent-expensive-pro'
    input.candidates[2]!.selection.model = 'cheap-mini'
    expect(selectAutoModel(parseRoutingPolicy(input), request()).selection.model).toBe('most-intelligent-expensive-pro')
  })

  it('rejects duplicate candidate IDs even when routes differ', () => {
    const input = configuration()
    input.candidates[1]!.id = 'small'
    expect(() => parseRoutingPolicy(input)).toThrow('repeats candidate id')
  })

  it.each([undefined, 'low'])('rejects duplicate full provider/model/effort combinations (%s)', (reasoningEffort) => {
    const input = configuration()
    const first = input.candidates[0]!
    expect(() => parseRoutingPolicy({
      ...input,
      candidates: [
        { ...first, selection: { ...first.selection, reasoningEffort } },
        { ...first, id: 'duplicate', selection: { ...first.selection, reasoningEffort } },
        ...input.candidates.slice(1),
      ],
    })).toThrow('repeats provider/model/effort combination')
  })

  it('allows different effort combinations and distinguishes omitted provider default from explicit effort', () => {
    const input = configuration()
    const first = input.candidates[0]!
    const policy = parseRoutingPolicy({
      ...input,
      candidates: [
        first,
        { ...first, id: 'low', selection: { ...first.selection, reasoningEffort: 'low' } },
        { ...first, id: 'high', selection: { ...first.selection, reasoningEffort: 'high' } },
        ...input.candidates.slice(1),
      ],
    })
    expect(policy.candidates.slice(0, 3).map(candidate => candidate.selection.reasoningEffort)).toEqual([undefined, 'low', 'high'])
  })

  it('distinguishes routes whose opaque IDs contain separator characters', () => {
    const input = configuration()
    input.candidates[0]!.selection = { provider: 'a\u0000b', model: 'c' }
    input.candidates[1]!.selection = { provider: 'a', model: 'b\u0000c' }
    expect(parseRoutingPolicy(input).candidates).toHaveLength(3)
  })

  it('requires a configured conservative candidate at highest quality', () => {
    expect(() => parseRoutingPolicy({ ...configuration(), conservativeCandidateId: 'missing' }))
      .toThrow('must name a configured candidate')
    expect(() => parseRoutingPolicy({ ...configuration(), conservativeCandidateId: 'small' }))
      .toThrow('must have the highest configured quality')
  })

  it('rejects unavailable quality floors instead of silently lowering them', () => {
    const input = configuration()
    input.candidates.pop()
    input.conservativeCandidateId = 'medium'
    expect(() => parseRoutingPolicy(input)).toThrow('quality floor 3 has no configured candidate')
  })

  it('allows an available higher quality to satisfy a skipped intermediate floor', () => {
    const input = configuration()
    input.candidates.splice(1, 1)
    expect(selectAutoModel(parseRoutingPolicy(input), request({ classification: classification({ complexity: 'standard' }) })))
      .toMatchObject({ candidateId: 'large', qualityFloor: 2 })
  })

  it.each([NaN, Infinity, -Infinity, -0.1, 1.1, '0.8', null])('rejects invalid confidence threshold %s', (minConfidence) => {
    expect(() => parseRoutingPolicy({ ...configuration(), minConfidence })).toThrow()
  })

  it.each([NaN, Infinity, -Infinity, 0, -1, '1', null])('rejects invalid relative cost %s', (relativeCost) => {
    const input = configuration()
    expect(() => parseRoutingPolicy({
      ...input,
      candidates: [{ ...input.candidates[0], relativeCost }, ...input.candidates.slice(1)],
    })).toThrow()
  })

  it.each([0, 4, 1.5, NaN, Infinity, '2', null])('rejects invalid candidate quality and floor %s', (quality) => {
    const input = configuration()
    expect(() => parseRoutingPolicy({
      ...input,
      candidates: [{ ...input.candidates[0], quality }, ...input.candidates.slice(1)],
    })).toThrow()
    expect(() => parseRoutingPolicy({
      ...input,
      qualityFloors: { ...input.qualityFloors, balanced: { ...input.qualityFloors.balanced, routine: quality } },
    })).toThrow()
  })

  it.each(['', '   ', '\n'])('rejects blank candidate and route identifiers %j', (blank) => {
    const input = configuration()
    const first = input.candidates[0]!
    expect(() => parseRoutingPolicy({ ...input, conservativeCandidateId: blank })).toThrow()
    expect(() => parseRoutingPolicy({ ...input, candidates: [{ ...first, id: blank }, ...input.candidates.slice(1)] })).toThrow()
    for (const field of ['provider', 'model', 'reasoningEffort']) {
      expect(() => parseRoutingPolicy({
        ...input,
        candidates: [{ ...first, selection: { ...first.selection, [field]: blank } }, ...input.candidates.slice(1)],
      })).toThrow()
    }
  })

  it('rejects missing policy fields, unknown fields at every level, and an empty catalog', () => {
    const input = configuration()
    const first = input.candidates[0]!
    const { minConfidence: _missing, ...withoutThreshold } = input
    const invalid = [
      null, [], {}, withoutThreshold,
      { ...input, candidates: [] },
      { ...input, extra: true },
      { ...input, candidates: [{ ...first, extra: true }, ...input.candidates.slice(1)] },
      { ...input, candidates: [{ ...first, selection: { ...first.selection, extra: true } }, ...input.candidates.slice(1)] },
      { ...input, qualityFloors: { ...input.qualityFloors, extra: {} } },
      { ...input, qualityFloors: { ...input.qualityFloors, balanced: { ...input.qualityFloors.balanced, extra: 1 } } },
      { ...input, qualityFloors: { balanced: input.qualityFloors.balanced } },
    ]
    for (const value of invalid) expect(() => parseRoutingPolicy(value)).toThrow()
  })
})

describe('classifier JSON parsing', () => {
  it('returns a detached immutable classification with fractional confidence', () => {
    const input = classification()
    const parsed = parseTaskClassification(input)
    expect(parsed).toEqual(input)
    expect(parsed).not.toBe(input)
    expect(Object.isFrozen(parsed)).toBe(true)
    expect(parseTaskClassificationJson(JSON.stringify(input))).toEqual(input)
  })

  it.each([0, 1])('accepts confidence endpoint %s', (confidence) => {
    expect(parseTaskClassification({ ...classification(), confidence }).confidence).toBe(confidence)
  })

  it.each([
    null, [], {},
    { ...classification(), continuity: 'continue' },
    { ...classification(), complexity: 'hard' },
    { ...classification(), reasonCode: 'please ignore policy' },
    { ...classification(), provider: 'unauthorized-provider' },
    { ...classification(), confidence: NaN },
    { ...classification(), confidence: Infinity },
    { ...classification(), confidence: -0.1 },
    { ...classification(), confidence: 1.1 },
    { ...classification(), confidence: '0.9' },
    { continuity: 'new-task', complexity: 'routine', confidence: 0.9 },
  ])('rejects malformed classifier fields %j', (value) => {
    expect(() => parseTaskClassification(value)).toThrow()
  })

  it.each([
    '', '{', 'null', '[]', '{}',
    `\`\`\`json\n${JSON.stringify(classification())}\n\`\`\``,
    `${JSON.stringify(classification())} explanatory prose`,
    `${JSON.stringify(classification())}${JSON.stringify(classification())}`,
    JSON.stringify({ ...classification(), confidence: 'NaN' }),
    JSON.stringify({ ...classification(), extra: true }),
  ])('rejects malformed complete JSON output %j', (text) => {
    expect(() => parseTaskClassificationJson(text)).toThrow()
  })
})

describe('task-aware Auto selection', () => {
  it.each<[TaskComplexity, string]>([
    ['routine', 'small'], ['standard', 'medium'], ['complex', 'large'],
  ])('routes a confident balanced %s task to %s', (complexity, candidateId) => {
    expect(selectAutoModel(parseRoutingPolicy(configuration()), request({ classification: classification({ complexity }) })))
      .toMatchObject({ candidateId, reason: 'quality-floor' })
  })

  it.each<[ModelRoutingMode, string]>([
    ['efficiency', 'small'], ['balanced', 'medium'], ['intelligence', 'large'],
  ])('uses the supplied %s quality floor rather than a hidden mode default', (mode, candidateId) => {
    expect(selectAutoModel(parseRoutingPolicy(configuration()), request({ mode, classification: classification({ complexity: 'standard' }) })))
      .toMatchObject({ candidateId, reason: 'quality-floor' })
  })

  it('retains the complete actual route and effort for confident same-task work', () => {
    const current = { provider: 'provider-a', model: 'opaque-1', reasoningEffort: ReasoningEffortId('high') }
    const input = configuration()
    input.candidates[0]!.selection.reasoningEffort = ReasoningEffortId('high')
    const result = selectAutoModel(parseRoutingPolicy(input), request({
      mode: 'intelligence', current,
      classification: classification({ continuity: 'same-task', complexity: 'complex', reasonCode: 'continuation' }),
    }))
    expect(result).toEqual({ candidateId: 'small', selection: current, reason: 'same-task' })
    expect(result.selection).not.toBe(current)
    expect(Object.isFrozen(result)).toBe(true)
    expect(Object.isFrozen(result.selection)).toBe(true)
    current.model = 'mutated-later'
    expect(result.selection.model).toBe('opaque-1')
  })

  it('does not preserve an ineligible same-task route', () => {
    expect(selectAutoModel(parseRoutingPolicy(configuration()), request({
      current: { provider: 'provider-a', model: 'opaque-1' },
      eligibleCandidateIds: ['medium', 'large'],
      classification: classification({ continuity: 'same-task', reasonCode: 'continuation' }),
    }))).toMatchObject({ candidateId: 'medium', reason: 'quality-floor' })
  })

  it('uses the quality floor for same-task output when no curated current route exists', () => {
    for (const current of [undefined, { provider: 'unlisted', model: 'opaque-1' }]) {
      expect(selectAutoModel(parseRoutingPolicy(configuration()), request({
        current, classification: classification({ continuity: 'same-task', reasonCode: 'continuation' }),
      }))).toMatchObject({ candidateId: 'small', reason: 'quality-floor' })
    }
  })

  it.each([
    undefined,
    classification({ confidence: 0.79 }),
    classification({ confidence: 1, reasonCode: 'uncertain' }),
    classification({ confidence: 0.1, continuity: 'same-task', reasonCode: 'continuation' }),
  ])('uses conservative selection for uncertainty %j', (classified) => {
    expect(selectAutoModel(parseRoutingPolicy(configuration()), request({
      current: { provider: 'provider-a', model: 'opaque-1' }, classification: classified,
    }))).toMatchObject({ candidateId: 'large', reason: 'conservative' })
  })

  it('treats the configured confidence threshold itself as confident', () => {
    expect(selectAutoModel(parseRoutingPolicy(configuration()), request({ classification: classification({ confidence: 0.8 }) })))
      .toMatchObject({ candidateId: 'small', reason: 'quality-floor' })
  })

  it('keeps an eligible equally conservative current route and effort under uncertainty', () => {
    const input = configuration()
    input.candidates.push({
      id: 'peer', selection: { provider: 'provider-c', model: 'opaque-4', reasoningEffort: ReasoningEffortId('extra-high') },
      quality: 3, relativeCost: 9,
    })
    const current = { provider: 'provider-c', model: 'opaque-4', reasoningEffort: ReasoningEffortId('extra-high') }
    expect(selectAutoModel(parseRoutingPolicy(input), request({
      current, classification: undefined, eligibleCandidateIds: ['small', 'peer'],
    }))).toEqual({ candidateId: 'peer', selection: current, reason: 'uncertain-current' })
  })

  it('keeps the current conservative candidate effort rather than resetting it', () => {
    const current = { provider: 'provider-b', model: 'opaque-3', reasoningEffort: ReasoningEffortId('high') }
    const input = configuration()
    input.candidates[2]!.selection.reasoningEffort = ReasoningEffortId('high')
    expect(selectAutoModel(parseRoutingPolicy(input), request({ current, classification: undefined })))
      .toEqual({ candidateId: 'large', selection: current, reason: 'uncertain-current' })
  })

  it('refuses uncertainty when neither the conservative nor an eligible equally strong current route is available', () => {
    const policy = parseRoutingPolicy(configuration())
    for (const eligibleCandidateIds of [[], ['unknown'], ['small', 'medium']]) {
      expect(() => selectAutoModel(policy, request({
        eligibleCandidateIds, classification: undefined,
        current: { provider: 'provider-b', model: 'opaque-3' },
      }))).toThrow(expect.objectContaining({ name: 'ModelRoutingSelectionError', code: 'conservative-unavailable' }))
    }
  })

  it('does not replace an unavailable conservative route with an arbitrary alternative during uncertainty', () => {
    const input = configuration()
    input.candidates.push({ id: 'peer', selection: { provider: 'provider-c', model: 'opaque-4' }, quality: 3, relativeCost: 9 })
    expect(() => selectAutoModel(parseRoutingPolicy(input), request({
      eligibleCandidateIds: ['peer'], classification: undefined,
    }))).toThrow(ModelRoutingSelectionError)
  })

  it('refuses confident tasks when no eligible candidate meets the configured quality floor', () => {
    for (const eligibleCandidateIds of [[], ['unknown'], ['small', 'medium']]) {
      expect(() => selectAutoModel(parseRoutingPolicy(configuration()), request({
        eligibleCandidateIds, classification: classification({ complexity: 'complex' }),
      }))).toThrow(expect.objectContaining({ code: 'no-suitable-candidate' }))
    }
  })

  it('selects only eligible IDs and never authorizes a candidate by its model name', () => {
    expect(() => selectAutoModel(parseRoutingPolicy(configuration()), request({ eligibleCandidateIds: ['opaque-1'] })))
      .toThrow(ModelRoutingSelectionError)
    expect(selectAutoModel(parseRoutingPolicy(configuration()), request({ eligibleCandidateIds: ['unknown', 'medium'] })))
      .toMatchObject({ candidateId: 'medium' })
  })

  it('uses the least cost above the quality floor regardless of configuration order', () => {
    const input = configuration()
    input.candidates.reverse()
    expect(selectAutoModel(parseRoutingPolicy(input), request())).toMatchObject({ candidateId: 'small' })
  })

  it('retains the exact current selection when eligible minimal-cost candidates tie', () => {
    const input = configuration()
    input.candidates[1]!.relativeCost = 1
    const current = { provider: 'provider-a', model: 'opaque-2' }
    expect(selectAutoModel(parseRoutingPolicy(input), request({ current })))
      .toEqual({ candidateId: 'medium', selection: current, reason: 'cost-tie-current', qualityFloor: 1 })
  })

  it('uses configuration order when tied candidates have no exact current selection', () => {
    const input = configuration()
    input.candidates[1]!.relativeCost = 1
    const policy = parseRoutingPolicy(input)
    for (const current of [
      undefined,
      { provider: 'provider-a', model: 'opaque-2', reasoningEffort: ReasoningEffortId('high') },
      { provider: 'provider-b', model: 'opaque-3' },
    ]) {
      expect(selectAutoModel(policy, request({ current })))
        .toMatchObject({ candidateId: 'small', reason: 'quality-floor' })
    }
    input.candidates.reverse()
    expect(selectAutoModel(parseRoutingPolicy(input), request())).toMatchObject({ candidateId: 'medium' })
  })

  it('does not retain a more costly current selection on a new confident task', () => {
    expect(selectAutoModel(parseRoutingPolicy(configuration()), request({ current: { provider: 'provider-b', model: 'opaque-3' } })))
      .toMatchObject({ candidateId: 'small' })
  })

  it('uses only the selected candidate effort on a route change', () => {
    const input = configuration()
    const policy = parseRoutingPolicy({
      ...input,
      candidates: input.candidates.map(candidate => candidate.id === 'large'
        ? { ...candidate, selection: { ...candidate.selection, reasoningEffort: 'low' } }
        : candidate),
    })
    const current = { provider: 'provider-a', model: 'opaque-2', reasoningEffort: ReasoningEffortId('high') }
    expect(selectAutoModel(policy, request({ current })).selection)
      .toEqual({ provider: 'provider-a', model: 'opaque-1' })
    expect(selectAutoModel(policy, request({ current, classification: classification({ complexity: 'complex' }) })).selection)
      .toEqual({ provider: 'provider-b', model: 'opaque-3', reasoningEffort: 'low' })
    expect(selectAutoModel(policy, request({ current, classification: undefined })).selection)
      .toEqual({ provider: 'provider-b', model: 'opaque-3', reasoningEffort: 'low' })
  })

  it('chooses low versus high effort on the same model according to task complexity', () => {
    const input = configuration()
    input.candidates[0]!.selection = { provider: 'one-provider', model: 'one-model', reasoningEffort: ReasoningEffortId('low') }
    input.candidates[2]!.selection = { provider: 'one-provider', model: 'one-model', reasoningEffort: ReasoningEffortId('high') }
    const policy = parseRoutingPolicy(input)
    expect(selectAutoModel(policy, request()).selection)
      .toEqual({ provider: 'one-provider', model: 'one-model', reasoningEffort: 'low' })
    expect(selectAutoModel(policy, request({ classification: classification({ complexity: 'complex' }) })).selection)
      .toEqual({ provider: 'one-provider', model: 'one-model', reasoningEffort: 'high' })
    expect(() => selectAutoModel(policy, request({
      eligibleCandidateIds: ['small', 'medium'], classification: classification({ complexity: 'complex' }),
    }))).toThrow(expect.objectContaining({ code: 'no-suitable-candidate' }))
  })

  it('does not assign a different current effort the cost or quality of a curated combination', () => {
    const input = configuration()
    input.candidates[0]!.selection.reasoningEffort = ReasoningEffortId('low')
    input.candidates[2]!.selection.reasoningEffort = ReasoningEffortId('high')
    const policy = parseRoutingPolicy(input)
    const sameTask = classification({ continuity: 'same-task', complexity: 'complex', reasonCode: 'continuation' })
    expect(selectAutoModel(policy, request({
      current: { provider: 'provider-a', model: 'opaque-1', reasoningEffort: ReasoningEffortId('high') },
      classification: sameTask,
    }))).toMatchObject({ candidateId: 'large', reason: 'quality-floor' })
    for (const reasoningEffort of [undefined, ReasoningEffortId('low')]) {
      expect(selectAutoModel(policy, request({
        current: { provider: 'provider-b', model: 'opaque-3', ...reasoningEffort === undefined ? {} : { reasoningEffort } },
        classification: undefined,
      }))).toMatchObject({ candidateId: 'large', reason: 'conservative', selection: { reasoningEffort: 'high' } })
    }
  })

  it('uses exact effort when preferring the current model in a cost tie', () => {
    const input = configuration()
    input.candidates[0]!.selection = { provider: 'one-provider', model: 'one-model', reasoningEffort: ReasoningEffortId('low') }
    input.candidates[2]!.selection = { provider: 'one-provider', model: 'one-model', reasoningEffort: ReasoningEffortId('high') }
    input.candidates[2]!.relativeCost = 1
    const policy = parseRoutingPolicy(input)
    expect(selectAutoModel(policy, request({ current: input.candidates[2]!.selection })))
      .toMatchObject({ candidateId: 'large', reason: 'cost-tie-current' })
    expect(selectAutoModel(policy, request({ current: { provider: 'one-provider', model: 'one-model' } })))
      .toMatchObject({ candidateId: 'small', reason: 'quality-floor' })
  })

  it('does not mutate supplied eligible IDs or share policy selections with its result', () => {
    const policy = parseRoutingPolicy(configuration())
    const eligibleCandidateIds = Object.freeze(['large', 'small', 'medium'])
    const result = selectAutoModel(policy, request({ eligibleCandidateIds }))
    expect(eligibleCandidateIds).toEqual(['large', 'small', 'medium'])
    expect(result.selection).not.toBe(policy.candidates[0]?.selection)
    expect(result).not.toHaveProperty('savings')
  })
})
