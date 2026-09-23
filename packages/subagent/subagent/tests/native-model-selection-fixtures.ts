/** Explicit policy fixtures shared by native selection unit and lifecycle tests. */

import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { AutoSelection } from '@deepseek-ai/dsh-model-routing'
import type { AllowedModelRoute } from '../src/index.ts'

/** Exact route permission captured in the parent test Session. */
export const ALL_ALLOWED: AllowedModelRoute[] = [{ provider: 'models', model: 'cheap' }, { provider: 'models', model: 'strong' }]

/**
 * Construct an explicit Auto policy without route-name inference.
 * @returns The policy and classifier budgets used by each isolated test context.
 */
export function autoSelection(): AutoSelection {
  return {
    mode: 'balanced',
    policy: {
      candidates: [
        { id: 'cheap', selection: { provider: 'models', model: 'cheap', reasoningEffort: ReasoningEffortId('low') }, quality: 1, relativeCost: 1 },
        { id: 'strong', selection: { provider: 'models', model: 'strong', reasoningEffort: ReasoningEffortId('high') }, quality: 3, relativeCost: 3 },
      ],
      qualityFloors: {
        efficiency: { routine: 1, standard: 1, complex: 3 },
        balanced: { routine: 1, standard: 2, complex: 3 },
        intelligence: { routine: 3, standard: 3, complex: 3 },
      },
      minConfidence: 0.8,
      conservativeCandidateId: 'strong',
    },
    classifier: {
      selection: { provider: 'models', model: 'classifier' }, maxInputBytes: 10_000,
      maxOutputTokens: 100, maxOutputBytes: 10_000, timeoutMs: 10_000,
    },
  }
}

/**
 * Supply exact metadata for the test adapter.
 * @param provider - Requested provider route.
 * @param model - Requested model id.
 * @returns Supported effort levels and an explicit default.
 */
export function nativeModelInfo(provider: string, model: string): LlmResolvedModelInfo {
  return { provider, id: model, name: model, inputModalities: model === 'cheap' ? ['text'] : ['text', 'image'], reasoning: {
    efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }],
    defaultEffort: ReasoningEffortId('low'),
  } }
}
