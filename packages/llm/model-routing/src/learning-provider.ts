/** Optional synchronous learning lookup; the lower router still owns eligibility and every hard rule. */
import type { ModelSelection } from '@deepseek-ai/dsh-agent/types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RoutingClassifierConfig } from './classifier-types.ts'
import type { ModelRoutingMode, ModelRoutingPolicy, RoutingTaskId, TaskClassification } from './types.ts'

/** Owned admission facts; no task text, conversation, live Session, or permission object is exposed. */
export interface LearningWeightRequest {
  readonly sessionId: SessionId
  /** Proposed new task identity; dispatch confirmation remains the routing-decision owner's job. */
  readonly taskId: RoutingTaskId
  readonly role: 'main'
  readonly mode: ModelRoutingMode
  readonly classification: TaskClassification
  readonly basePolicy: ModelRoutingPolicy
  readonly basePolicyFingerprint: string
  readonly classifier: RoutingClassifierConfig
  readonly eligibleCandidates: readonly {
    readonly candidateId: string
    readonly selection: Readonly<ModelSelection>
  }[]
  readonly now: number
}

/** A higher owner authorizes evidence and returns only the cropped weight-overlay vocabulary. */
export interface LearningWeightProvider {
  /** Captured admission ceiling; changing the provider requires disposal and registration. */
  readonly maxRelativeWeightChange: number
  /** Synchronous local-only read. The runtime validates unknown output and falls back on failure. */
  resolve(request: LearningWeightRequest): unknown
}
