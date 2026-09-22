/** Closed native analysis admission; higher owners retain task consent and durable budgets. */

import type {} from '@deepseek-ai/dsh-permission-presets'
import type { NativeAnalysisPolicy, SubagentProvider, SubagentStartRequest } from './types.ts'

/**
 * Capture one no-tools, fixed-route native creation policy before asynchronous work.
 * The native model selector separately intersects its route with parent authority.
 * @param provider - Exact registered provider selected for this start.
 * @param request - Trusted caller intent; no resolved provider fields are accepted.
 * @returns Detached policy, or undefined for ordinary delegation.
 */
export function captureNativeAnalysisPolicy(
  provider: SubagentProvider,
  request: SubagentStartRequest,
): NativeAnalysisPolicy | undefined {
  const policy = request.analysisPolicy
  if (policy === undefined) return undefined
  if (policy.kind !== 'analysis-only' || provider.nativeModelSelection !== 'spawn' || provider.inheritsParentContext) {
    throw new Error('analysis-only requires a fresh native spawn provider')
  }
  // Permission Auto is an authorization reviewer, not model-routing Auto.
  // Its pre-tool paid calls are outside this child's request budget. Refuse
  // rather than changing inherited permission or silently bypassing review.
  if (request.parent.ctx.get('permissionPresets')?.current(request.parent.session) === 'auto') {
    throw new Error('analysis-only is unavailable under the Auto permission preset')
  }
  if (request.outputSchema !== undefined) throw new Error('analysis-only does not admit structured-output tools')
  const options = request.agentOptions
  if (options?.provider === undefined || options.model === undefined
    || options.provider.length === 0 || options.model.length === 0) {
    throw new Error('analysis-only requires an explicit fixed provider and model')
  }
  if (options.maxTokens === undefined || !Number.isSafeInteger(options.maxTokens) || options.maxTokens <= 0) {
    throw new Error('analysis-only requires an explicit positive maxTokens')
  }
  if (!Number.isSafeInteger(policy.maxModelCalls) || policy.maxModelCalls <= 0
    || !Number.isSafeInteger(policy.maxOutputBytes) || policy.maxOutputBytes <= 0) {
    throw new Error('analysis-only requires positive safe-integer call and output-byte limits')
  }
  return Object.freeze({
    kind: 'analysis-only', maxModelCalls: policy.maxModelCalls, maxOutputBytes: policy.maxOutputBytes,
  })
}
