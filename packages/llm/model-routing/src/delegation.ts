/** Isolated child policy capture and resolution; the native registry alone creates children. */

import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { contentHasImage } from '@deepseek-ai/dsh-llm'
import { SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { z } from 'zod'
import { classifyRoutingTask } from './classifier.ts'
import { resolveEligibleCombinations } from './eligibility.ts'
import { selectAutoModel } from './policy.ts'
import { autoSelectionSchema } from './schemas.ts'
import type {
  DelegationRoutingCapture, DelegationRoutingContext, ResolveDelegationRoutingRequest, ResolvedDelegationRouting,
} from './delegation-types.ts'
import type {} from './projection.ts'

const contextSchema: z.ZodType<DelegationRoutingContext | null> = z.object({
  intentSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq),
  selection: autoSelectionSchema,
}).strict().nullable()

/** Child delegation preference is independent of that child's fixed conversation model. */
export const delegationRoutingProjection = {
  key: 'modelRoutingDelegation',
  stateVersion: 1,
  stateSchema: contextSchema,
  init: () => null,
  apply: (state, event) => {
    if (event.type === 'session/end-seed' && event.data.inherited === true) return null
    if (state === null && event.type === 'model/delegation-auto') {
      return { intentSeq: event.seq, selection: event.data.selection }
    }
    return state
  },
} satisfies ProjectionDefinition<'modelRoutingDelegation', DelegationRoutingContext | null>

/**
 * Capture the exact direct parent's current Auto preference without a model call.
 * An ordinary manual Session has none; a child may have a creation-owned delegation context.
 * @param ctx - Host context with routing projections registered.
 * @param parent - Live direct parent supplied by the owning runtime.
 * @returns Detached immutable preference and its parent-local event identity, when applicable.
 */
export function captureDelegationRouting(ctx: Context, parent: Agent): DelegationRoutingCapture | undefined {
  const main = ctx.sessionProjections.stateOf(parent.session, 'modelRouting')
  if (main === undefined) throw new Error('model routing projection is unavailable')
  const child = ctx.sessionProjections.stateOf(parent.session, 'modelRoutingDelegation')
  if (child === undefined) throw new Error('delegation routing projection is unavailable')
  const context = parent.session.header.origin === 'subagent'
    ? child
    : main.intent.kind === 'auto' ? { intentSeq: main.intent.seq, selection: main.intent.selection } : null
  if (context === null) return undefined
  return Object.freeze({
    parentSessionId: parent.id,
    intentSeq: context.intentSeq,
    selection: Object.freeze(autoSelectionSchema.parse(context.selection)),
  })
}

/** Owned pre-await inputs; text is absent rather than truncated when over budget. */
export interface PreparedDelegationRouting {
  readonly parent: Agent
  readonly capture: DelegationRoutingCapture
  readonly eligibleCandidateIds: readonly string[]
  readonly text: string | undefined
  readonly images: boolean
  readonly maxTokens?: number
}

/**
 * Snapshot operation-local input before any provider or classifier await.
 * @param request - Native owner's captured authority and isolated child prompt.
 * @returns Detached scalar/policy inputs, retaining only the explicit live parent reference.
 */
export function prepareDelegationRouting(request: ResolveDelegationRoutingRequest): PreparedDelegationRouting {
  if (request.capture.parentSessionId !== request.parent.id) throw new Error('delegation Auto capture belongs to another parent')
  const capture = Object.freeze({
    parentSessionId: request.capture.parentSessionId,
    intentSeq: request.capture.intentSeq,
    selection: Object.freeze(autoSelectionSchema.parse(request.capture.selection)),
  })
  let text = ''
  let oversized = false
  for (const block of request.prompt) {
    if (block.type !== 'text') continue
    const nextBytes = Buffer.byteLength(text, 'utf8') + Buffer.byteLength(block.text, 'utf8') + (text.length === 0 ? 0 : 1)
    if (nextBytes > capture.selection.classifier.maxInputBytes) {
      oversized = true
      break
    }
    text = text.length === 0 ? block.text : `${text}\n${block.text}`
  }
  return Object.freeze({
    parent: request.parent,
    capture,
    eligibleCandidateIds: Object.freeze([...request.eligibleCandidateIds]),
    text: oversized ? undefined : text,
    images: contentHasImage(request.prompt),
    ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
  })
}

/**
 * Resolve a fresh delegated task without parent history, affinity or conversation-state mutation.
 * Authorization is supplied by the native owner and rechecked there before creation.
 * @param ctx - Host LLM capability; changes during resolution invalidate the proposal.
 * @param request - Owned capture prepared synchronously by the runtime.
 * @param signal - Child-start, service and parent-scope cancellation combined by the runtime.
 * @returns Materialized model/effort proposal and parent-audit attribution, not dispatch evidence.
 */
export async function resolvePreparedDelegationRouting(
  ctx: Context,
  request: PreparedDelegationRouting,
  signal: AbortSignal,
): Promise<ResolvedDelegationRouting> {
  signal.throwIfAborted()
  const llm = ctx.llm
  const identity: unknown = Reflect.get(llm, symbols.original) ?? llm
  const topology = { changed: false }
  const dispose = ctx.on('llm/adapters-updated', () => { topology.changed = true })
  const assertTopology = () => {
    signal.throwIfAborted()
    const current = ctx.get('llm')
    const currentIdentity: unknown = current === undefined ? undefined : Reflect.get(current, symbols.original) ?? current
    if (topology.changed || currentIdentity !== identity) {
      throw new Error('LLM routing changed during delegated model selection; retry delegation')
    }
  }
  try {
    const allowed = new Set(request.eligibleCandidateIds)
    const policy = request.capture.selection.policy
    if (!allowed.has(policy.conservativeCandidateId)) {
      throw new Error('Auto delegation requires an authorized conservative combination')
    }
    const candidates = policy.candidates.filter(candidate => allowed.has(candidate.id))
    const available = await resolveEligibleCombinations(llm, candidates, {
      images: request.images,
      ...request.maxTokens === undefined ? {} : { maxTokens: request.maxTokens },
    }, signal)
    assertTopology()
    if (!available.has(policy.conservativeCandidateId)) {
      throw new Error('Auto delegation requires an available conservative combination')
    }
    const classified = request.text === undefined || request.text.length === 0
      ? undefined
      : await classifyRoutingTask(ctx, request.capture.selection.classifier, {
        session: request.parent.session,
        intentSeq: request.capture.intentSeq,
        taskText: request.text,
        signal,
      })
    assertTopology()
    const selected = selectAutoModel(policy, {
      mode: request.capture.selection.mode,
      eligibleCandidateIds: [...available.keys()],
      ...classified?.outcome !== 'success' ? {} : { classification: classified.classification },
    })
    // The pure selector only returns an eligible candidate, whose materialized value is captured above.
    const selection = available.get(selected.candidateId) as ModelSelection
    return Object.freeze({
      selection: Object.freeze({ ...selection }),
      candidateId: selected.candidateId,
      reason: selected.reason,
      ...classified?.callId === undefined ? {} : { classifierCallId: classified.callId },
    })
  } finally {
    dispose()
  }
}
