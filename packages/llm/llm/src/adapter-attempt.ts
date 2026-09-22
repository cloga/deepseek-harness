/** Cropped, process-local observation of actual adapter dispatch, never request content. */

import { brandString, type Branded } from '@deepseek-ai/dsh-brand'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import type { GenerateOptions, StreamChunk, TokenUsage } from './types.ts'

/** Runtime-minted identity of one adapter dispatch; not a provider billing receipt. */
export type LlmAdapterAttemptId = Branded<'LlmAdapterAttemptId'>

/** Detached resolved selection captured synchronously before dispatch. */
export interface LlmAdapterAttemptStart {
  readonly attemptId: LlmAdapterAttemptId
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: NonNullable<GenerateOptions['reasoningEffort']>
  readonly sessionId?: NonNullable<GenerateOptions['sessionId']>
  readonly purpose?: NonNullable<GenerateOptions['purpose']>
}

/** Closed projection of a terminal reason, excluding arbitrary provider diagnostics. */
export type LlmAdapterAttemptFinish = 'stop' | 'tool-calls' | 'max-tokens' | 'error' | 'aborted' | 'unknown'

/** How the runtime stopped consuming this adapter iterator. */
export type LlmAdapterAttemptSettlement = 'exhausted' | 'consumer-closed' | 'failed'

/**
 * What teardown the runtime actually joined. An adapter rejection preserves the
 * existing no-return-after-next-failure contract: `adapter-failed` proves only
 * that next() unwound, not that a custom iterator's external work is quiescent.
 * `returned` means its return() promise fulfilled; the existing runtime does not
 * inspect that result's done flag. It is not full stream exhaustion.
 * `not-available`, `not-acquired`, and `failed` likewise attest no complete join.
 */
export type LlmAdapterAttemptTeardown =
  | 'exhausted' | 'returned' | 'not-available' | 'not-acquired' | 'adapter-failed' | 'failed'

/**
 * Immutable observation after the runtime's teardown path has settled. Exhaustion,
 * an observed terminal, and reported usage are independent facts. Usage is the
 * last cumulative provider sample, not a sum or a validated exact token total;
 * missing usage remains absent. Consumers own strict usage normalization.
 */
export interface LlmAdapterAttemptEnd {
  readonly settlement: LlmAdapterAttemptSettlement
  readonly teardown: LlmAdapterAttemptTeardown
  readonly finish?: LlmAdapterAttemptFinish
  readonly usage?: Readonly<TokenUsage>
}

/**
 * Capture correlation synchronously at dispatch and optionally return its terminal
 * observer. Exceptions and accidental Promise rejections cannot affect the call.
 * Removing a registration prevents new starts, but an already captured terminal
 * observer still runs once; it must release its operation-local ownership there.
 */
export type LlmAdapterAttemptObserver = (
  start: Readonly<LlmAdapterAttemptStart>,
) => ((end: Readonly<LlmAdapterAttemptEnd>) => void) | void

/** Internal capture retained only until the adapter stream's finally boundary. */
export interface AdapterAttemptObservation {
  push(chunk: StreamChunk): void
  settle(settlement: LlmAdapterAttemptSettlement, teardown: LlmAdapterAttemptTeardown): void
}

/** Invoke one observer without leaking thrown diagnostics or rejected Promises. */
function notify<T>(callback: () => T): T | undefined {
  try {
    const result = callback()
    // A void callback may be implemented with an async function. Do not await it
    // or let its rejection escape into either the model call or process logging.
    if (typeof result !== 'function') void Promise.resolve(result).catch(() => undefined)
    return result
  } catch (_error: unknown) {
    // Accounting observers are non-vetoing and may throw sensitive diagnostics.
    return undefined
  }
}

/** Copy only the public numeric buckets; do not normalize or invent absent data. */
function cropUsage(usage: TokenUsage): Readonly<TokenUsage> {
  return Object.freeze({
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    ...usage.totalTokens === undefined ? {} : { totalTokens: usage.totalTokens },
    ...usage.cacheReadTokens === undefined ? {} : { cacheReadTokens: usage.cacheReadTokens },
    ...usage.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: usage.cacheWriteTokens },
    ...usage.reasoningTokens === undefined ? {} : { reasoningTokens: usage.reasoningTokens },
  })
}

/** Do not expose arbitrary kinds added by provider-specific finish extensions. */
function cropFinish(kind: string): LlmAdapterAttemptFinish {
  switch (kind) {
    case 'stop':
    case 'tool-calls':
    case 'max-tokens':
    case 'error':
    case 'aborted': return kind
    default: return 'unknown'
  }
}

/** Private observer registry; LlmRuntime owns each registration through ctx.effect. */
export class AdapterAttemptObservers {
  private readonly observers = new Set<{ observer: LlmAdapterAttemptObserver | undefined }>()

  /**
   * Each registration is independent, even for the same callback function.
   * @param observer - Synchronous cropped dispatch observer.
   * @returns An idempotent disposer preventing future starts while captured endings settle.
   */
  add(observer: LlmAdapterAttemptObserver): () => void {
    const registration: { observer: LlmAdapterAttemptObserver | undefined } = { observer }
    this.observers.add(registration)
    return () => {
      this.observers.delete(registration)
      registration.observer = undefined
    }
  }

  /**
   * Called only after preflight and immediately before entering the adapter.
   * @param options - Resolved request; only route and correlation leaves are copied.
   * @returns A terminal observation handle, or undefined when nobody observes dispatch.
   */
  start(options: GenerateOptions): AdapterAttemptObservation | undefined {
    if (this.observers.size === 0) return undefined
    const start: Readonly<LlmAdapterAttemptStart> = Object.freeze({
      attemptId: brandString<LlmAdapterAttemptId>(randomUUID()),
      provider: options.provider,
      model: options.model,
      ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
      ...options.sessionId === undefined ? {} : { sessionId: options.sessionId },
      ...options.purpose === undefined ? {} : { purpose: options.purpose },
    })
    const endings: Array<(end: Readonly<LlmAdapterAttemptEnd>) => void> = []
    // Snapshot membership so reentrant registration cannot extend this dispatch.
    for (const registration of [...this.observers]) {
      const observer = registration.observer
      if (observer === undefined) continue
      const end = notify(() => observer(start))
      if (typeof end === 'function') endings.push(end)
    }
    let usage: Readonly<TokenUsage> | undefined
    let finish: LlmAdapterAttemptFinish | undefined
    return {
      push(chunk) {
        if (chunk.type === 'usage') usage = cropUsage(chunk.usage)
        if (chunk.type === 'finish') finish = cropFinish(chunk.reason.kind)
      },
      settle(settlement, teardown) {
        const end: Readonly<LlmAdapterAttemptEnd> = Object.freeze({
          settlement,
          teardown,
          ...finish === undefined ? {} : { finish },
          ...usage === undefined ? {} : { usage },
        })
        // Release closures before invoking them, including reentrant disposal.
        for (const callback of endings.splice(0)) notify(() => callback(end))
      },
    }
  }
}
