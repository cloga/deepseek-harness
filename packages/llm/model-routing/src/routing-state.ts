/** Durable Auto intent and confirmed task-route state, separate from manual model selection. */

import type { SessionEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { RoutingClassifierConfig } from './classifier-types.ts'
import type { ModelRoutingMode, ModelRoutingPolicy, RoutingDecisionView } from './types.ts'
export type { RoutingTaskId } from './types.ts'

/** Policy captured by an explicit Auto selection; later settings changes do not replace it. */
export interface AutoSelection {
  readonly mode: ModelRoutingMode
  readonly policy: ModelRoutingPolicy
  readonly classifier: RoutingClassifierConfig
}

/** Concrete route observed on a conversation request, not a classifier's proposal. */
export interface RoutingTaskDecision extends RoutingDecisionView {
  /** Bounded classified task text used only for the next continuity check, never in the wire view. */
  readonly taskText?: string
}

/** Current session routing intent; old sessions remain manual without an explicit Auto event. */
export type RoutingIntent =
  | { readonly kind: 'manual' }
  | { readonly kind: 'auto'; readonly seq: SessionSeq; readonly selection: AutoSelection }

/** Minimal durable state restored independently for each session. */
export interface ModelRoutingState {
  readonly intent: RoutingIntent
  readonly activeTask: RoutingTaskDecision | null
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Explicit opt-in with a captured, credential-free routing policy. */
    'model/auto-selection': AutoSelection
    /** An actual conversation dispatch used this task's model and effort. */
    'model/routing-decision': RoutingTaskDecision
  }
}

/**
 * Restore an initially manual session without an inferred global Auto preference.
 * @returns Fresh empty routing state.
 */
export function initialModelRoutingState(): ModelRoutingState {
  return { intent: { kind: 'manual' }, activeTask: null }
}

/**
 * Fold committed routing events without consuming future manual choices.
 * A decision from an earlier intent remains historical evidence but cannot bind
 * the active task after the user selects a new mode or a manual model.
 * @param state - Previously folded routing state.
 * @param event - Next committed session event.
 * @returns The unchanged or advanced state.
 */
export function applyModelRoutingState(state: ModelRoutingState, event: SessionEvent): ModelRoutingState {
  if (event.type === 'model/selection'
    || (event.type === 'session/end-seed' && event.data.inherited === true)) return initialModelRoutingState()
  if (event.type === 'model/auto-selection') {
    return { intent: { kind: 'auto', seq: event.seq, selection: event.data }, activeTask: null }
  }
  if (event.type === 'model/routing-decision' && state.intent.kind === 'auto'
    && event.data.intentSeq === state.intent.seq) {
    return { intent: state.intent, activeTask: event.data }
  }
  return state
}
