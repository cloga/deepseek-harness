/** Strict configuration/classifier parsing and deterministic task-aware selection. */

import { z } from 'zod'
import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  ModelRoutingPolicy,
  ModelRoutingQuality,
  RoutingCandidate,
  RoutingDecision,
  RoutingDecisionReason,
  SelectAutoModelRequest,
  TaskClassification,
} from './types.ts'

const nonEmptyId = z.string().refine(value => value.trim().length > 0, 'identifier must be non-empty')
const qualitySchema = z.union([z.literal(1), z.literal(2), z.literal(3)])
const floorsSchema = z.object({
  routine: qualitySchema,
  standard: qualitySchema,
  complex: qualitySchema,
}).strict()
const selectionSchema = z.object({
  provider: nonEmptyId,
  model: nonEmptyId,
  reasoningEffort: nonEmptyId.optional(),
}).strict()
const policySchema = z.object({
  candidates: z.array(z.object({
    id: nonEmptyId,
    selection: selectionSchema,
    quality: qualitySchema,
    relativeCost: z.number().positive(),
  }).strict()).min(1),
  qualityFloors: z.object({
    efficiency: floorsSchema,
    balanced: floorsSchema,
    intelligence: floorsSchema,
  }).strict(),
  minConfidence: z.number().min(0).max(1),
  conservativeCandidateId: nonEmptyId,
}).strict()
const classificationSchema = z.object({
  continuity: z.enum(['same-task', 'new-task']),
  complexity: z.enum(['routine', 'standard', 'complex']),
  confidence: z.number().min(0).max(1),
  reasonCode: z.enum(['continuation', 'new-task', 'uncertain']),
}).strict()

/**
 * Validate configuration once and detach/freeze every retained policy value.
 * Provider/model/effort combinations have independent cost and quality estimates.
 * An omitted provider-default effort is distinct from every explicit effort.
 * @param value - Untrusted configuration or durable policy JSON.
 * @returns An immutable policy with an existing highest-quality conservative route.
 * @throws When fields are malformed, routes repeat, or a quality floor is unavailable.
 */
export function parseRoutingPolicy(value: unknown): ModelRoutingPolicy {
  const parsed = policySchema.parse(value)
  const ids = new Set<string>()
  const routes = new Set<string>()
  for (const candidate of parsed.candidates) {
    if (ids.has(candidate.id)) throw new Error(`model routing repeats candidate id "${candidate.id}"`)
    ids.add(candidate.id)
    const route = JSON.stringify([candidate.selection.provider, candidate.selection.model, candidate.selection.reasoningEffort ?? null])
    if (routes.has(route)) throw new Error(`model routing repeats provider/model/effort combination ${route}`)
    routes.add(route)
  }
  const conservative = parsed.candidates.find(candidate => candidate.id === parsed.conservativeCandidateId)
  if (conservative === undefined) throw new Error('model routing conservativeCandidateId must name a configured candidate')
  if (parsed.candidates.some(candidate => candidate.quality > conservative.quality)) {
    throw new Error('model routing conservative candidate must have the highest configured quality')
  }
  for (const floors of Object.values(parsed.qualityFloors)) {
    for (const floor of Object.values(floors)) {
      if (!parsed.candidates.some(candidate => candidate.quality >= floor)) {
        throw new Error(`model routing quality floor ${floor} has no configured candidate`)
      }
    }
  }
  return Object.freeze({
    candidates: Object.freeze(parsed.candidates.map(candidate => Object.freeze({
      id: candidate.id,
      selection: Object.freeze({
        provider: candidate.selection.provider,
        model: candidate.selection.model,
        ...candidate.selection.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: ReasoningEffortId(candidate.selection.reasoningEffort) },
      }),
      quality: candidate.quality,
      relativeCost: candidate.relativeCost,
    }))),
    qualityFloors: Object.freeze({
      efficiency: Object.freeze(parsed.qualityFloors.efficiency),
      balanced: Object.freeze(parsed.qualityFloors.balanced),
      intelligence: Object.freeze(parsed.qualityFloors.intelligence),
    }),
    minConfidence: parsed.minConfidence,
    conservativeCandidateId: parsed.conservativeCandidateId,
  })
}

/**
 * Validate only the classifier's closed JSON fields, without guessing missing values.
 * @param value - Untrusted decoded classifier output.
 * @returns A detached immutable classification.
 * @throws When any field is missing, unknown, or outside its permitted values.
 */
export function parseTaskClassification(value: unknown): TaskClassification {
  return Object.freeze(classificationSchema.parse(value))
}

/**
 * Parse one complete JSON classifier response; Markdown fences and trailing prose reject.
 * @param text - Raw model-produced JSON text.
 * @returns A validated immutable classification.
 * @throws When JSON syntax or the classifier fields are malformed.
 */
export function parseTaskClassificationJson(text: string): TaskClassification {
  const value: unknown = JSON.parse(text)
  return parseTaskClassification(value)
}

/** Selection refusal when available authorized routes cannot meet the policy. */
export class ModelRoutingSelectionError extends Error {
  /**
   * Construct a refusal without exposing classifier text or credential data.
   * @param code - Whether the conservative route or a quality-qualified route is unavailable.
   */
  constructor(readonly code: 'conservative-unavailable' | 'no-suitable-candidate') {
    super(code === 'conservative-unavailable'
      ? 'model routing has no eligible conservative candidate'
      : 'model routing has no eligible candidate meeting the quality floor')
    this.name = 'ModelRoutingSelectionError'
  }
}

function sameSelection(left: Readonly<ModelSelection>, right: Readonly<ModelSelection>): boolean {
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

function decision(
  candidate: RoutingCandidate,
  reason: RoutingDecisionReason,
  selection: Readonly<ModelSelection> = candidate.selection,
  qualityFloor?: ModelRoutingQuality,
): RoutingDecision {
  return Object.freeze({
    candidateId: candidate.id,
    selection: Object.freeze({ ...selection }),
    reason,
    ...qualityFloor === undefined ? {} : { qualityFloor },
  })
}

/**
 * Select only from caller-authorized candidates without mutating policy or inputs.
 * Confident same-task work retains its eligible exact route/effort combination.
 * Uncertain work retains an eligible current combination of conservative quality, otherwise uses
 * the configured conservative candidate or refuses. Other work minimizes relative
 * cost above the mode's floor; exact current selection wins a tied minimum, then
 * configuration order wins. A changed route uses only its own configured effort.
 * @param policy - Immutable validated policy from parseRoutingPolicy.
 * @param request - Mode, actual current route, eligible IDs, and optional classification.
 * @returns An owned concrete selection and stable explanation.
 * @throws ModelRoutingSelectionError when eligibility leaves no acceptable route.
 */
export function selectAutoModel(policy: ModelRoutingPolicy, request: SelectAutoModelRequest): RoutingDecision {
  const eligibleIds = new Set(request.eligibleCandidateIds)
  const eligible = policy.candidates.filter(candidate => eligibleIds.has(candidate.id))
  const current = request.current
  const currentCandidate = current === undefined
    ? undefined
    : eligible.find(candidate => sameSelection(candidate.selection, current))
  const classification = request.classification
  if (classification === undefined || classification.confidence < policy.minConfidence
    || classification.reasonCode === 'uncertain') {
    // The configuration parser guarantees this referent; only the Array.find type needs narrowing.
    const conservative = policy.candidates.find(candidate => candidate.id === policy.conservativeCandidateId) as RoutingCandidate
    if (currentCandidate !== undefined && current !== undefined && currentCandidate.quality >= conservative.quality) {
      return decision(currentCandidate, 'uncertain-current', current)
    }
    if (!eligibleIds.has(conservative.id)) throw new ModelRoutingSelectionError('conservative-unavailable')
    return decision(conservative, 'conservative')
  }
  if (classification.continuity === 'same-task' && currentCandidate !== undefined && current !== undefined) {
    return decision(currentCandidate, 'same-task', current)
  }
  const qualityFloor = policy.qualityFloors[request.mode][classification.complexity]
  const suitable = eligible.filter(candidate => candidate.quality >= qualityFloor)
  if (suitable.length === 0) throw new ModelRoutingSelectionError('no-suitable-candidate')
  const cheapest = suitable.reduce((best, candidate) => candidate.relativeCost < best.relativeCost ? candidate : best)
  const tied = suitable.filter(candidate => candidate.relativeCost === cheapest.relativeCost)
  const exactCurrent = current === undefined
    ? undefined
    : tied.find(candidate => sameSelection(candidate.selection, current))
  if (tied.length > 1 && exactCurrent !== undefined) {
    return decision(exactCurrent, 'cost-tie-current', current, qualityFloor)
  }
  return decision(cheapest, 'quality-floor', cheapest.selection, qualityFloor)
}
