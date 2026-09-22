import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import * as LlmInvariant from '@deepseek-ai/dsh-llm/invariant'
import { AdapterAttemptObservers } from '../src/adapter-attempt.ts'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmAdapterAttemptEnd, LlmAdapterAttemptObserver, LlmAdapterAttemptStart,
  LlmResolvedModelInfo, StreamChunk, TokenUsage,
} from '@deepseek-ai/dsh-llm'

const options: GenerateOptions = { provider: 'test', model: 'model', messages: [] }
const stop: StreamChunk = { type: 'finish', reason: { kind: 'stop' } }
const sample: TokenUsage = { inputTokens: 3, outputTokens: 2, cacheReadTokens: 7, totalTokens: 12 }
const usage: StreamChunk = { type: 'usage', usage: sample }

class Adapter extends LlmAdapter {
  constructor(private readonly run: (request: GenerateOptions) => AsyncIterable<StreamChunk>) { super() }
  stream(request: GenerateOptions): AsyncIterable<StreamChunk> { return this.run(request) }
}

async function setup(adapter = new Adapter(async function* () { yield usage; yield stop })) {
  const ctx = new Context()
  await ctx.plugin(LlmRuntime)
  const registration = ctx.llm.registerAdapter(['test'], adapter)
  const starts: Readonly<LlmAdapterAttemptStart>[] = []
  const ends: Readonly<LlmAdapterAttemptEnd>[] = []
  const dispose = ctx.llm.observeAdapterAttempts((start) => {
    starts.push(start)
    return (end) => { ends.push(end) }
  })
  return { ctx, starts, ends, dispose, registration }
}

async function setupWithInvariants(adapter?: Adapter) {
  const fixture = await setup(adapter)
  await fixture.ctx.plugin(InvariantRegistry, { enabled: true })
  await fixture.ctx.plugin(LlmInvariant)
  return fixture
}

async function collect(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

describe('adapter dispatch observation', () => {
  it('captures the resolved selection synchronously without exposing request content', async () => {
    let captured = false
    let task = 'task-one'
    const owners: string[] = []
    const adapter = new class extends Adapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        return Promise.resolve({
          provider, id: model, name: model,
          reasoning: { efforts: [{ id: ReasoningEffortId('high'), name: 'High' }], defaultEffort: ReasoningEffortId('high') },
        })
      }
    }(() => {
      expect(captured).toBe(true)
      task = 'task-two'
      return (async function* () { yield usage; yield stop })()
    })
    const { ctx, starts, ends } = await setup(adapter)
    ctx.llm.observeAdapterAttempts(() => {
      captured = true
      const owner = task
      return () => { owners.push(owner) }
    })
    const request: GenerateOptions = {
      ...options,
      system: 'PRIVATE SYSTEM',
      messages: [createUserMessage({ content: [{ type: 'text', text: 'PRIVATE PROMPT' }], source: { kind: 'user' } })],
      sessionId: brandString<NonNullable<GenerateOptions['sessionId']>>('session-one'),
      purpose: 'compaction',
      maxTokens: 30,
      signal: new AbortController().signal,
    }
    await collect(ctx.llm.stream(request))
    expect(starts).toEqual([{
      attemptId: expect.any(String), provider: 'test', model: 'model', reasoningEffort: 'high',
      sessionId: 'session-one', purpose: 'compaction',
    }])
    expect(ends).toEqual([{ settlement: 'exhausted', teardown: 'exhausted', finish: 'stop', usage: sample }])
    expect(owners).toEqual(['task-one'])
    expect(Object.isFrozen(starts[0])).toBe(true)
    expect(Object.isFrozen(ends[0])).toBe(true)
    expect(Object.isFrozen(ends[0]?.usage)).toBe(true)
    expect(ends[0]?.usage).not.toBe(sample)
  })

  it('matches public file projection text without exposing it to attempt observers', async () => {
    let dispatchedText: string | undefined
    const { ctx, starts } = await setup(new Adapter(async function* (request) {
      const block = request.messages[0]?.content[0]
      if (block?.type === 'text') dispatchedText = block.text
      yield stop
    }))
    const attachment = { attachmentId: AttachmentId(`sha256:${'ab'.repeat(32)}`), name: 'private-notes.txt', bytes: 3 }
    const expected = ctx.llm.fileRequestText(attachment)
    await collect(ctx.llm.stream({ ...options, messages: [createUserMessage({
      content: [{ type: 'file', attachment }], source: { kind: 'user' },
    })] }))
    expect(dispatchedText).toBe(expected)
    expect(starts).toEqual([{ attemptId: expect.any(String), provider: 'test', model: 'model' }])
  })

  it('does not observe an unconsumed stream or logical replay short circuit', async () => {
    const dispatch = vi.fn(() => (async function* () { yield stop })())
    const { ctx, starts, ends } = await setup(new Adapter(dispatch))
    ctx.llm.stream(options)
    expect(starts).toEqual([])
    ctx.on('llm/stream', () => (async function* () { yield usage; yield stop })())
    expect(await collect(ctx.llm.stream(options))).toEqual([usage, stop])
    expect(dispatch).not.toHaveBeenCalled()
    expect(starts).toEqual([])
    expect(ends).toEqual([])
  })

  it.each(['missing-route', 'model-resolution', 'prepared-mismatch'] as const)('does not count %s preflight failure', async (boundary) => {
    const adapter = new class extends Adapter {
      override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
        if (boundary === 'model-resolution') throw new Error('private preflight error')
        return super.resolveModel(provider, model)
      }
    }(async function* () { throw new Error('must not dispatch') })
    const { ctx, starts, ends } = await setup(adapter)
    if (boundary === 'prepared-mismatch') {
      const prepared = await ctx.llm.prepareCall(options)
      expect(() => prepared.stream({ ...options, model: 'other' })).toThrow()
    } else {
      await collect(ctx.llm.stream({ ...options, provider: boundary === 'missing-route' ? 'missing' : 'test' }))
    }
    expect(starts).toEqual([])
    expect(ends).toEqual([])
  })

  it('observes each actual retry dispatch, including a failure with no usage', async () => {
    let calls = 0
    const { ctx, starts, ends } = await setup(new Adapter(async function* () {
      calls += 1
      if (calls === 1) throw new Error('provider failure')
      yield usage
      yield stop
    }))
    await collect(ctx.llm.stream(options))
    await collect(ctx.llm.stream(options))
    expect(starts).toHaveLength(2)
    expect(starts[0]?.attemptId).not.toBe(starts[1]?.attemptId)
    expect(ends).toEqual([
      { settlement: 'failed', teardown: 'adapter-failed', finish: 'error' },
      { settlement: 'exhausted', teardown: 'exhausted', finish: 'stop', usage: sample },
    ])
    expect(starts[0]).not.toHaveProperty('sessionId')
    expect(starts[0]).not.toHaveProperty('purpose')
  })

  it.each(['dispatch', 'iterator'] as const)('retains a started attempt when %s acquisition throws', async (boundary) => {
    const failure = new LlmError('PRIVATE DIAGNOSTIC', 'PRIVATE_CODE', { offloadImages: 1 })
    const { ctx, starts, ends } = await setup(new Adapter(() => {
      if (boundary === 'dispatch') throw failure
      return { [Symbol.asyncIterator]() { throw failure } }
    }))
    const chunks = await collect(ctx.llm.stream(options))
    expect(chunks).toEqual([{ type: 'finish', reason: { kind: 'error', failure: failure.failure } }])
    expect(starts).toHaveLength(1)
    expect(ends).toEqual([{ settlement: 'failed', teardown: 'not-acquired', finish: 'error' }])
  })

  it.each(['next', 'done', 'value'] as const)('preserves no return lookup after a throwing %s', async (boundary) => {
    const failure = new Error('private iteration error')
    let returns = 0
    const iterator: AsyncIterator<StreamChunk> = {
      next() {
        if (boundary === 'next') return Promise.reject(failure)
        const result = boundary === 'done' ? {} : { done: false }
        Object.defineProperty(result, boundary, { get() { throw failure } })
        return Promise.resolve(result as IteratorResult<StreamChunk>)
      },
    }
    Object.defineProperty(iterator, 'return', { get() { returns += 1; throw new Error('must not look up') } })
    const { ctx, ends } = await setup(new Adapter(() => ({ [Symbol.asyncIterator]: () => iterator })))
    await collect(ctx.llm.stream(options))
    expect(returns).toBe(0)
    expect(ends).toEqual([{ settlement: 'failed', teardown: 'adapter-failed', finish: 'error' }])
  })

  it('settles only after consumer-close has awaited adapter cleanup', async () => {
    const closing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const { ctx, ends } = await setup(new Adapter(async function* () {
      try { yield usage; yield stop } finally { closing.resolve(undefined); await release.promise }
    }))
    const run = (async () => { for await (const _chunk of ctx.llm.stream(options)) break })()
    await closing.promise
    expect(ends).toEqual([])
    release.resolve(undefined)
    await run
    expect(ends).toEqual([{ settlement: 'consumer-closed', teardown: 'returned', usage: sample }])
  })

  it('retains finish separately when the consumer closes on the terminal chunk', async () => {
    const { ctx, ends } = await setup()
    for await (const chunk of ctx.llm.stream(options)) if (chunk.type === 'finish') break
    expect(ends).toEqual([{ settlement: 'consumer-closed', teardown: 'returned', finish: 'stop', usage: sample }])
  })

  it('joins an aborting generator finally before reporting its failed attempt', async () => {
    const controller = new AbortController()
    const started = Promise.withResolvers<undefined>()
    const closing = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const { ctx, ends } = await setup(new Adapter(async function* (request) {
      try {
        yield usage
        await new Promise<void>((resolve) => {
          request.signal?.addEventListener('abort', () => resolve(), { once: true })
          started.resolve(undefined)
        })
        throw new Error('private cancellation detail')
      } finally {
        closing.resolve(undefined)
        await release.promise
      }
    }))
    const run = collect(ctx.llm.stream({ ...options, signal: controller.signal }))
    await started.promise
    controller.abort()
    await closing.promise
    expect(ends).toEqual([])
    release.resolve(undefined)
    await run
    expect(ends).toEqual([{ settlement: 'failed', teardown: 'adapter-failed', finish: 'aborted', usage: sample }])
  })

  it.each(['return-call', 'return-getter'] as const)('reports failed teardown without swallowing %s failure', async (boundary) => {
    const failure = new Error('private cleanup failure')
    const iterator: AsyncIterator<StreamChunk> = {
      next: () => Promise.resolve({ done: false, value: usage }),
    }
    Object.defineProperty(iterator, 'return', {
      get() {
        if (boundary === 'return-getter') throw failure
        return () => Promise.reject(failure)
      },
    })
    const { ctx, ends } = await setup(new Adapter(() => ({ [Symbol.asyncIterator]: () => iterator })))
    await expect((async () => { for await (const _chunk of ctx.llm.stream(options)) break })()).rejects.toBe(failure)
    expect(ends).toEqual([{ settlement: 'failed', teardown: 'failed', usage: sample }])
  })

  it('does not claim cleanup when a custom iterator has no return', async () => {
    const { ctx, ends } = await setup(new Adapter(() => ({
      [Symbol.asyncIterator]: () => ({ next: () => Promise.resolve({ done: false, value: usage }) }),
    })))
    for await (const _chunk of ctx.llm.stream(options)) break
    expect(ends).toEqual([{ settlement: 'consumer-closed', teardown: 'not-available', usage: sample }])
  })

  it('distinguishes missing finish and missing usage from exhaustion', async () => {
    const missingFinish = await setupWithInvariants(new Adapter(async function* () { yield usage }))
    await expect(collect(missingFinish.ctx.llm.stream(options)))
      .rejects.toThrow('LLM stream ended without a terminal finish chunk')
    expect(missingFinish.ends).toEqual([{ settlement: 'exhausted', teardown: 'exhausted', usage: sample }])
    const missingUsage = await setup(new Adapter(async function* () { yield stop }))
    await collect(missingUsage.ctx.llm.stream(options))
    expect(missingUsage.ends).toEqual([{ settlement: 'exhausted', teardown: 'exhausted', finish: 'stop' }])
  })

  it.each(['stop', 'tool-calls', 'max-tokens', 'error', 'aborted', 'extension-private'] as const)('crops %s finish details', async (kind) => {
    const terminal = { type: 'finish', reason: { kind, failure: { message: 'PRIVATE', code: 'PRIVATE' } } } as StreamChunk
    const { ctx, ends } = await setup(new Adapter(async function* () { yield terminal }))
    await collect(ctx.llm.stream(options))
    expect(ends).toEqual([{
      settlement: 'exhausted', teardown: 'exhausted', finish: kind === 'extension-private' ? 'unknown' : kind,
    }])
  })

  it('keeps the last cumulative sample detached and never invents missing cache or total counts', async () => {
    const cumulative = { inputTokens: 8, outputTokens: 4, totalTokens: 22, cacheReadTokens: 10, private: 'PRIVATE' }
    // The observer's raw sample projection is independent of the stream grammar:
    // the invariant wrapper rejects repeated usage before a consumer can accept it.
    const observers = new AdapterAttemptObservers()
    const ends: Readonly<LlmAdapterAttemptEnd>[] = []
    observers.add(() => (end) => { ends.push(end) })
    const observation = observers.start(options)!
    observation.push(usage)
    observation.push({ type: 'usage', usage: cumulative })
    cumulative.inputTokens = 900
    cumulative.cacheReadTokens = 900
    observation.push(stop)
    observation.settle('exhausted', 'exhausted')
    expect(ends[0]?.usage).toEqual({ inputTokens: 8, outputTokens: 4, totalTokens: 22, cacheReadTokens: 10 })
    const unknown = await setup(new Adapter(async function* () {
      yield { type: 'usage', usage: { inputTokens: 2, outputTokens: 1 } }
      yield stop
    }))
    await collect(unknown.ctx.llm.stream(options))
    expect(unknown.ends[0]?.usage).toEqual({ inputTokens: 2, outputTokens: 1 })
  })

  it('preserves explicit zero buckets and inconsistent totals for the strict owner to validate', async () => {
    const reported = { inputTokens: 8, outputTokens: 4, totalTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 }
    const { ctx, ends } = await setup(new Adapter(async function* () { yield { type: 'usage', usage: reported }; yield stop }))
    await collect(ctx.llm.stream(options))
    expect(ends[0]?.usage).toEqual(reported)
  })

  it('isolates observer throws, rejected Promises and frozen-payload mutations', async () => {
    const { ctx, starts, ends } = await setup()
    ctx.llm.observeAdapterAttempts(() => { throw new Error('PRIVATE BEGIN ERROR') })
    ctx.llm.observeAdapterAttempts((async () => { throw new Error('PRIVATE ASYNC BEGIN ERROR') }) as unknown as LlmAdapterAttemptObserver)
    ctx.llm.observeAdapterAttempts((start) => { Object.assign(start, { model: 'changed' }) })
    ctx.llm.observeAdapterAttempts(() => () => { throw new Error('PRIVATE END ERROR') })
    ctx.llm.observeAdapterAttempts(() => async () => { throw new Error('PRIVATE ASYNC END ERROR') })
    ctx.llm.observeAdapterAttempts(() => (end) => {
      if (end.usage !== undefined) Object.assign(end.usage, { inputTokens: 900 })
    })
    const following = vi.fn()
    ctx.llm.observeAdapterAttempts(() => following)
    expect(await collect(ctx.llm.stream(options))).toEqual([usage, stop])
    await Promise.resolve()
    expect(starts).toHaveLength(1)
    expect(ends[0]?.usage).toEqual(sample)
    expect(following).toHaveBeenCalledTimes(1)
  })

  it('disposes future registration through its Fiber but settles an already captured callback once', async () => {
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    const { ctx } = await setup(new Adapter(async function* () { entered.resolve(undefined); await release.promise; yield stop }))
    const callback = vi.fn()
    const begin = vi.fn(() => callback)
    const owner = await ctx.plugin(Object.assign((inner: Context) => {
      inner.llm.observeAdapterAttempts(begin)
    }, { inject: ['llm'] }))
    const pending = collect(ctx.llm.stream(options))
    await entered.promise
    expect(begin).toHaveBeenCalledTimes(1)
    await owner.dispose()
    expect(callback).not.toHaveBeenCalled()
    release.resolve(undefined)
    await pending
    expect(callback).toHaveBeenCalledTimes(1)
    await collect(ctx.llm.stream(options))
    expect(begin).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledTimes(1)
  })

  it('keeps duplicate registrations independent and snapshots reentrant starts', async () => {
    const { ctx, dispose } = await setup()
    dispose()
    const end = vi.fn()
    const begin = vi.fn(() => end)
    const first = ctx.llm.observeAdapterAttempts(begin)
    ctx.llm.observeAdapterAttempts(begin)
    first()
    first()
    const added = vi.fn()
    let addOnce = true
    ctx.llm.observeAdapterAttempts(() => {
      if (addOnce) { addOnce = false; ctx.llm.observeAdapterAttempts(() => added) }
    })
    await collect(ctx.llm.stream(options))
    expect(begin).toHaveBeenCalledTimes(1)
    expect(end).toHaveBeenCalledTimes(1)
    expect(added).not.toHaveBeenCalled()
    await collect(ctx.llm.stream(options))
    expect(added).toHaveBeenCalledTimes(1)
  })

  it('observes a registration-bound prepared dispatch after adapter replacement', async () => {
    const { ctx, starts, ends, registration } = await setup()
    const prepared = await ctx.llm.prepareCall(options)
    registration()
    ctx.llm.registerAdapter(['test'], new Adapter(async function* () { throw new Error('replacement must not run') }))
    await collect(prepared.stream({ ...options, ...prepared.config }))
    expect(starts).toHaveLength(1)
    expect(ends[0]?.settlement).toBe('exhausted')
  })

  it('settles an error injected into the raw adapter boundary after returning its iterator', async () => {
    const { ctx, ends } = await setupWithInvariants()
    let adapterBoundary: AsyncIterator<StreamChunk> | undefined
    // Capture the innermost existing waterfall seam, without removing wrappers.
    ctx.on('llm/stream', (_request, next) => {
      const source = next()
      adapterBoundary = source[Symbol.asyncIterator]()
      return source
    })
    const outer = ctx.llm.stream(options)[Symbol.asyncIterator]()
    await outer.next()
    const failure = new Error('private consumer failure')
    await expect(adapterBoundary!.throw!(failure)).rejects.toBe(failure)
    await outer.return?.()
    expect(ends).toEqual([{ settlement: 'failed', teardown: 'returned', usage: sample }])
  })

  it('records consumer-close when the invariant wrapper forwards throw as iterator return', async () => {
    const { ctx, ends } = await setupWithInvariants()
    const outer = ctx.llm.stream(options)[Symbol.asyncIterator]()
    await outer.next()
    const failure = new Error('private outer consumer failure')
    await expect(outer.throw!(failure)).rejects.toBe(failure)
    expect(ends).toEqual([{ settlement: 'consumer-closed', teardown: 'returned', usage: sample }])
  })

  it('retains the last observed sample but reports partial settlement when invariants reject duplicate usage', async () => {
    const cumulative = { inputTokens: 8, outputTokens: 4, totalTokens: 22, cacheReadTokens: 10 }
    const { ctx, ends } = await setupWithInvariants(new Adapter(async function* () {
      yield usage
      yield { type: 'usage', usage: cumulative }
      yield stop
    }))
    await expect(collect(ctx.llm.stream(options))).rejects.toThrow('LLM stream emitted usage more than once')
    expect(ends).toEqual([{ settlement: 'consumer-closed', teardown: 'returned', usage: cumulative }])
  })

  it('skips a registration removed reentrantly before its start callback', async () => {
    const { ctx } = await setup()
    let remove: () => void = () => undefined
    ctx.llm.observeAdapterAttempts(() => { remove() })
    const late = vi.fn()
    remove = ctx.llm.observeAdapterAttempts(late)
    await collect(ctx.llm.stream(options))
    expect(late).not.toHaveBeenCalled()
  })
})
