/**
 * Task-aware routing policy, audited classification, and captured session intent.
 * @module @deepseek-ai/dsh-model-routing
 */

export * from './types.ts'
export * from './policy.ts'
export * from './classifier-types.ts'
export type * from './delegation-types.ts'
export type * from './learning-provider.ts'
export type { LearningWeightOverlay } from './learning-overlay.ts'
export * from './classifier.ts'
export type { Config } from './config.ts'
export { MODEL_ROUTING_SETTINGS_NAMESPACE, resolveRoutingConfig } from './config.ts'
export { default, ModelRoutingRuntime } from './runtime.ts'
export * from './routing-state.ts'
export * from './projection.ts'
