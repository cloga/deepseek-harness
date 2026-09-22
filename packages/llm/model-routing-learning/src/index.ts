/**
 * Local-only evidence and adaptive strategy management for task-aware routing.
 * @module @deepseek-ai/dsh-model-routing-learning
 */

export type * from './types.ts'
export type * from './controller-types.ts'
export { LearningController, LearningControllerError } from './controller.ts'
export { openLearningStore, learningDomainName } from './store.ts'
export { LearningStoreError, parseLearningStoreConfig } from './schema.ts'
export { TaskWorkAccounting } from './work-accounting.ts'
export type { TaskWorkSummary, WorkCall, WorkGap, WorkMetric, WorkOperation, WorkRoute, WorkSource } from './work-accounting.ts'
