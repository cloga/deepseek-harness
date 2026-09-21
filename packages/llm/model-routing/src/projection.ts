/** Session-local routing intent and actual-use projection with a cropped client view. */

import type { Context } from '@deepseek-ai/cordis'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { parseRoutingPolicy } from './policy.ts'
import { parseRoutingClassifierConfig } from './classifier.ts'
import { applyModelRoutingState, initialModelRoutingState } from './routing-state.ts'
import type { ModelRoutingState, RoutingTaskDecision } from './routing-state.ts'
import type { ModelRoutingMode } from './types.ts'

/** User-visible intent and last confirmed selection, without classifier inputs or policy internals. */
export interface ModelRoutingView {
  readonly mode: 'manual' | ModelRoutingMode
  readonly lastDecision: Omit<RoutingTaskDecision, 'taskText'> | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    /** Captured Auto intent and actual task binding. */
    modelRouting: ModelRoutingState
  }
  interface SessionProjectionMap {
    /** Auto mode and actual request route; no raw classifier task text. */
    modelRouting: ModelRoutingView
  }
}

const decisionSchema = z.object({
  taskId: z.string().min(1),
  intentSeq: z.number().int().nonnegative(),
  selection: z.object({
    provider: z.string().min(1),
    model: z.string().min(1),
    reasoningEffort: z.string().min(1).optional(),
  }).strict(),
  candidateId: z.string().min(1),
  reason: z.enum(['same-task', 'uncertain-current', 'conservative', 'quality-floor', 'cost-tie-current']),
  classifierCallId: z.string().min(1).optional(),
  taskText: z.string().optional(),
}).strict()
const modeSchema = z.enum(['efficiency', 'balanced', 'intelligence'])

const stateSchema = z.object({
  intent: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('manual') }).strict(),
    z.object({
      kind: z.literal('auto'),
      seq: z.number().int().nonnegative(),
      selection: z.object({
        mode: modeSchema,
        policy: z.unknown().transform(parseRoutingPolicy),
        classifier: z.unknown().transform(parseRoutingClassifierConfig),
      }).strict(),
    }).strict(),
  ]),
  activeTask: decisionSchema.nullable(),
}).strict() as unknown as z.ZodType<ModelRoutingState>

const viewSchema = z.object({
  mode: z.union([z.literal('manual'), modeSchema]),
  lastDecision: decisionSchema.omit({ taskText: true }).nullable(),
}).strict() as unknown as z.ZodType<ModelRoutingView>

/**
 * Crop routing state for UI transport without exposing private classifier input.
 * @param state - Validated Host routing projection.
 * @returns A mode and actual decision snapshot without task text.
 */
export function modelRoutingView(state: ModelRoutingState): ModelRoutingView {
  const decision = state.activeTask
  const lastDecision = decision === null ? null : {
    taskId: decision.taskId,
    intentSeq: decision.intentSeq,
    selection: { ...decision.selection },
    candidateId: decision.candidateId,
    reason: decision.reason,
    ...decision.classifierCallId === undefined ? {} : { classifierCallId: decision.classifierCallId },
  }
  return { mode: state.intent.kind === 'manual' ? 'manual' : state.intent.selection.mode, lastDecision }
}

/** One durable fold shared by live routing, cold-session state and UI reads. */
export const modelRoutingProjection = {
  key: 'modelRouting',
  stateSchema,
  init: initialModelRoutingState,
  apply: applyModelRoutingState,
  stateVersion: 1,
  wire: { viewSchema, view: modelRoutingView },
} satisfies ProjectionDefinition<'modelRouting', ModelRoutingState>

/**
 * Register the routing projection for the current plugin lifetime.
 * @param ctx - Host context with a declared sessionProjections dependency.
 */
export function installModelRoutingProjection(ctx: Context): void {
  ctx.sessionProjections.register(modelRoutingProjection)
}
