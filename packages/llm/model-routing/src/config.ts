/** Deployment and user settings for opt-in task-aware routing. */

import z from '@deepseek-ai/schemastery'
import type { ModelRoutingPolicy } from './types.ts'
import type { RoutingClassifierConfig } from './classifier-types.ts'
import { parseRoutingPolicy } from './policy.ts'
import { parseRoutingClassifierConfig } from './classifier.ts'

/** Settings namespace containing curated routes, never provider credentials. */
export const MODEL_ROUTING_SETTINGS_NAMESPACE = 'model-routing'

/** Auto is unavailable until both a candidate policy and classifier are configured. */
export interface Config {
  /** Allow new explicit Session Auto selections; enabling requires both policy and classifier configuration. */
  readonly enabled: boolean
  /** Curated model/effort candidates and hard selection rules, captured when a Session opts into Auto. */
  readonly policy?: ModelRoutingPolicy
  /** Independent auxiliary classifier route and explicit budgets; required when routing is enabled. */
  readonly classifier?: RoutingClassifierConfig
}

const modelSelectionSchema = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
  reasoningEffort: z.string().min(1),
})
const qualitySchema = z.union([1, 2, 3])
const qualityFloorsSchema = z.object({
  routine: qualitySchema.required(),
  standard: qualitySchema.required(),
  complex: qualitySchema.required(),
})

/** Discovery schema; the parser also enforces referents, uniqueness and conservative quality. */
export const Config: z<Config> = z.object({
  enabled: z.boolean().default(false),
  // A union leaves absent sections unset instead of applying object's implicit {} default.
  policy: z.union([z.object({
    candidates: z.array(z.object({
      id: z.string().min(1).required(),
      selection: modelSelectionSchema.required(),
      quality: qualitySchema.required(),
      relativeCost: z.number().min(0).required(),
    })).min(1).required(),
    qualityFloors: z.object({
      efficiency: qualityFloorsSchema.required(),
      balanced: qualityFloorsSchema.required(),
      intelligence: qualityFloorsSchema.required(),
    }).required(),
    minConfidence: z.number().min(0).max(1).required(),
    conservativeCandidateId: z.string().min(1).required(),
  })]),
  classifier: z.union([z.object({
    selection: modelSelectionSchema.required(),
    maxInputBytes: z.number().step(1).min(1).required(),
    maxOutputTokens: z.number().step(1).min(1).required(),
    maxOutputBytes: z.number().step(1).min(1).required(),
    timeoutMs: z.number().step(1).min(1).required(),
  })]),
}) as unknown as z<Config>

/**
 * Validate and detach one settings revision before exposing it to a session.
 * @param value - Schema-validated deployment or settings value.
 * @returns Frozen settings with strict policy and classifier validation.
 * @throws When enabled without both required policies, or either policy is malformed.
 */
export function resolveRoutingConfig(value: Config): Config {
  const policy = value.policy === undefined ? undefined : parseRoutingPolicy(value.policy)
  const classifier = value.classifier === undefined ? undefined : parseRoutingClassifierConfig(value.classifier)
  if (value.enabled && (policy === undefined || classifier === undefined)) {
    throw new Error('enabled model routing requires a candidate policy and classifier configuration')
  }
  return Object.freeze({
    enabled: value.enabled,
    ...policy === undefined ? {} : { policy },
    ...classifier === undefined ? {} : { classifier },
  })
}
