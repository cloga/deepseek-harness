/** Creation-owned no-tools execution and conservative local budgets for one fixed analysis child. */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { NativeAnalysisPolicy, NativeAnalysisUsage } from '@deepseek-ai/dsh-subagent'

/** Owned counters survive run settlement without retaining live Agent objects. */
export interface AnalysisAttachment {
  /** @returns A detached accounting snapshot; admissions are not paid-dispatch or task-success facts. */
  snapshot(): NativeAnalysisUsage
}

/**
 * Install the analysis restriction before child publication and its first prompt.
 * Caller signal/deadline and handle disposal remain the native driver's lifecycle owners.
 * @param ctx - Unpublished child's exact scoped Context.
 * @param child - Child whose requests are admitted by this attachment.
 * @param policy - Detached validated local limits from native admission.
 * @param options - Complete preflighted fixed route and explicit output-token cap.
 * @returns Small accounting closure for the holder's settled run result.
 */
export function attachAnalysisOnly(
  ctx: Context,
  child: Agent,
  policy: NativeAnalysisPolicy,
  options: Readonly<AgentOptions>,
): AnalysisAttachment {
  const { provider, model, reasoningEffort, maxTokens } = options
  if (provider === undefined || model === undefined || maxTokens === undefined) {
    throw new Error('analysis-only setup requires a complete preflighted route and token cap')
  }
  const route = { provider, model, maxTokens, ...reasoningEffort === undefined ? {} : { reasoningEffort } }
  let admittedModelCalls = 0
  let retainedOutputBytes = 0
  let rejectedChunkBytes: number | undefined
  let limitHit: NativeAnalysisUsage['limitHit']

  ctx.tools.presentAs('native')
  // Avoid ordinary pre-policy work, while the monotonic guard remains the
  // authority if another listener attempts to replace this denial with allow.
  ctx.on('tools/pre-execute', () => Promise.resolve({
    kind: 'deny' as const, reason: 'analysis-only children cannot execute tools',
  }), { prepend: true })
  ctx.tools.guard(() => 'analysis-only children cannot execute tools')
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => ({
    ...await next(), tools: [],
  }), { prepend: true })
  ctx.on('agent/request', async (_payload, next) => {
    const { reasoningEffort: _inheritedEffort, ...other } = await next()
    return { ...other, ...route }
  }, { prepend: true })

  ctx.on('llm/stream', async function* (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>) {
    if (options.sessionId !== child.id) { yield* next(); return }
    options.signal?.throwIfAborted()
    // No silent schema/default drift after assembly or during provider preparation.
    if ((options.tools?.length ?? 0) !== 0 || options.provider !== provider || options.model !== model
      || options.reasoningEffort !== reasoningEffort || options.maxTokens !== maxTokens) {
      throw new Error('analysis-only request changed its fixed route, effort, token cap or empty tool surface')
    }
    if (admittedModelCalls >= policy.maxModelCalls) {
      limitHit = 'model-calls'
      throw new Error('analysis-only model-call budget exhausted')
    }
    // Reserve before next(): retries and continuations cannot enter another
    // downstream stream once this limit is spent, even if earlier calls failed.
    admittedModelCalls += 1
    for await (const chunk of next()) {
      options.signal?.throwIfAborted()
      const bytes = Buffer.byteLength(JSON.stringify(chunk), 'utf8')
      if (bytes > policy.maxOutputBytes - retainedOutputBytes) {
        rejectedChunkBytes = bytes
        limitHit = 'output-bytes'
        throw new Error('analysis-only output-byte budget exhausted')
      }
      retainedOutputBytes += bytes
      yield chunk
    }
  }, { global: true, prepend: true })

  return {
    snapshot: () => ({
      admittedModelCalls, retainedOutputBytes,
      ...rejectedChunkBytes === undefined ? {} : { rejectedChunkBytes },
      ...limitHit === undefined ? {} : { limitHit },
    }),
  }
}
