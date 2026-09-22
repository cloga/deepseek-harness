/** Live model/effort validation shared by ordinary and isolated delegation routing. */

import type { ModelSelection } from '@deepseek-ai/dsh-agent'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import type { RoutingCandidate } from './types.ts'

/** Request-owned requirements, not permissions or inferred model quality. */
export interface ModelRoutingRequirements {
  readonly images: boolean
  readonly maxTokens?: number
}

/**
 * Resolve already-authorized combinations through the live LLM registry.
 * An unavailable/unsupported combination is ineligible; cancellation propagates.
 * @param llm - Registry that owns exact model and effort validation.
 * @param candidates - Candidates already restricted by the caller's authority.
 * @param requirements - Actual input modalities and captured output cap.
 * @param signal - Owning operation's cancellation.
 * @returns Owned materialized selections keyed by candidate identity.
 */
export async function resolveEligibleCombinations(
  llm: LlmRuntime,
  candidates: readonly RoutingCandidate[],
  requirements: ModelRoutingRequirements,
  signal: AbortSignal,
): Promise<Map<string, ModelSelection>> {
  const available = new Map<string, ModelSelection>()
  for (const candidate of candidates) {
    signal.throwIfAborted()
    try {
      const config = await llm.resolveCallConfig({
        ...candidate.selection,
        ...requirements.maxTokens === undefined ? {} : { maxTokens: requirements.maxTokens },
      }, signal)
      signal.throwIfAborted()
      if (requirements.images) {
        const info = await llm.resolveModelInfo(candidate.selection.provider, candidate.selection.model, signal)
        signal.throwIfAborted()
        if (info.inputModalities?.includes('image') !== true) continue
      }
      available.set(candidate.id, {
        provider: config.provider,
        model: config.model,
        ...config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort },
      })
    } catch (_error: unknown) {
      // Selection never treats cancellation as permission to try another model.
      signal.throwIfAborted()
    }
  }
  return available
}
