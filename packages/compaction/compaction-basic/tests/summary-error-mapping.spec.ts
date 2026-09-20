import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isCompactCheckpointSource, ManualCompactionError } from '@deepseek-ai/dsh-compaction'
import LlmRuntime, { createUserMessage, LlmAdapter, LlmError } from '@deepseek-ai/dsh-llm'
import type { FinishReason, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { compactSurfaceRegion } from '../src/region.ts'
import { summarizeWithLlm } from '../src/summarizer.ts'
import type { SummarizationInput } from '../src/summarizer.ts'

class FinishAdapter extends LlmAdapter {
  finish: FinishReason = { kind: 'max-tokens' }

  override async * stream(): AsyncIterable<StreamChunk> {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'checkpoint' } }
    yield { type: 'finish', reason: this.finish }
  }
}

const contexts: Context[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

/** Real summary assembly and transaction, with only the provider stream scripted. */
function harness() {
  const ctx = new Context()
  contexts.push(ctx)
  new LlmRuntime(ctx)
  new SessionStore(ctx)
  new SessionProjectionRegistry(ctx)
  const meter = new TokenMeter(ctx)
  const adapter = new FinishAdapter()
  ctx.llm.registerAdapter(['summary-test'], adapter)
  const session = Session.create(SessionId('summary-error-mapping'))
  const source = session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'older conversation history '.repeat(200) }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
  const agent = { session, options: { provider: 'summary-test', model: 'summary-test' } } as Agent
  const summarize = vi.fn((input: SummarizationInput, owner: Agent, signal?: AbortSignal) =>
    summarizeWithLlm(ctx, { summarizationProvider: '', summarizationModel: '', maxTokens: 128 }, input, owner, signal))
  const recover = vi.fn(() => false)
  const flush = vi.fn(async () => {})
  const controller = new AbortController()
  const run = (owner: 'current-turn' | null = null) => compactSurfaceRegion(
    { meter, summarize, recover }, session, source.seq, source.seq, agent,
    { owner, stability: 'selected-span', flush }, controller.signal,
  )
  return { adapter, session, source, agent, summarize, recover, flush, controller, run }
}

/** Obtain the emitted error independently of transaction-stage classification. */
async function summaryError(test: ReturnType<typeof harness>): Promise<Error> {
  try {
    await test.summarize({ messages: test.session.deriveMessages() }, test.agent)
  } catch (error: unknown) {
    if (error instanceof Error) return error
    throw error
  }
  throw new Error('expected the scripted summary to fail')
}

function expectNoCheckpoint(session: Session): void {
  expect(session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(false)
  expect(session.snapshotEvents().some(event => event.type === 'user/message'
    && isCompactCheckpointSource(event.data.source))).toBe(false)
}

describe('named summary truncation failures', () => {
  it('emits a named error only for the max-tokens terminal finish', async () => {
    const test = harness()
    const error = await summaryError(test)
    expect(error).toMatchObject({ name: 'SummaryTruncatedError', code: 'MAX_TOKENS' })
    expect(error.constructor.name).toBe('SummaryTruncatedError')
  })

  it('classifies a truncated summary without committing its partial checkpoint or retrying', async () => {
    const test = harness()
    await expect(test.run()).rejects.toMatchObject({
      name: 'ManualCompactionError', code: 'summary-truncated',
      cause: { name: 'SummaryTruncatedError', code: 'MAX_TOKENS' },
    })
    expect(test.summarize).toHaveBeenCalledTimes(1)
    expect(test.flush).toHaveBeenCalledTimes(1)
    expectNoCheckpoint(test.session)
    expect(test.session.snapshotEvents().filter(event => event.type.startsWith('compaction/'))
      .map(event => event.type)).toEqual(['compaction/start', 'compaction/end'])
    expect(test.session.snapshotEvents().findLast(event => event.type === 'compaction/end')?.data)
      .toMatchObject({ error: 'summarization truncated at the token cap (incomplete checkpoint)' })
    expect(test.session.surface.nodes).toEqual([test.source.seq])
  })

  it.each(['error', 'aborted'] as const)('keeps a provider %s with MAX_TOKENS code as a generic summary failure', async (kind) => {
    const test = harness()
    test.adapter.finish = { kind, failure: { code: 'MAX_TOKENS', message: 'provider diagnostic' } }
    const error = await summaryError(test)
    expect(error).toBeInstanceOf(LlmError)
    expect(error.name).not.toBe('SummaryTruncatedError')
    await expect(test.run()).rejects.toMatchObject({ code: 'summary', cause: { code: 'MAX_TOKENS' } })
    expectNoCheckpoint(test.session)
  })

  it('does not classify arbitrary errors by their name, message, or code', async () => {
    const test = harness()
    const imitation = Object.assign(new Error('summarization truncated at the token cap (incomplete checkpoint)'), {
      name: 'SummaryTruncatedError', code: 'MAX_TOKENS',
    })
    test.summarize.mockRejectedValue(imitation)
    await expect(test.run()).rejects.toMatchObject({ code: 'summary', cause: imitation })
  })

  it('preserves a changed selected span over a simultaneous truncation', async () => {
    const test = harness()
    const truncated = await summaryError(test)
    test.summarize.mockImplementation(async () => {
      test.session.append('user/message', createUserMessage({
        content: [{ type: 'text', text: 'replacement history' }],
        source: { kind: 'plugin', plugin: 'competing-change' },
      }), {
        surfaceOp: { op: 'replace', startSeq: test.source.seq, endSeq: test.source.seq },
        sourceEventSeqs: [test.source.seq],
      })
      throw truncated
    })
    await expect(test.run()).rejects.toMatchObject({ code: 'changed' })
    expectNoCheckpoint(test.session)
  })

  it('preserves cancellation over truncation and a secondary flush failure', async () => {
    const test = harness()
    const truncated = await summaryError(test)
    const abort = new Error('operator cancelled')
    test.summarize.mockImplementation(async () => {
      test.controller.abort(abort)
      throw truncated
    })
    test.flush.mockRejectedValue(new Error('disk full'))
    await expect(test.run()).rejects.toBe(abort)
    expect(test.flush).toHaveBeenCalledTimes(1)
    expectNoCheckpoint(test.session)
  })

  it('preserves the summary failure over a secondary durability failure', async () => {
    const test = harness()
    test.flush.mockRejectedValue(new Error('disk full'))
    await expect(test.run()).rejects.toMatchObject({ code: 'summary-truncated' })
    expect(test.flush).toHaveBeenCalledTimes(1)
    expectNoCheckpoint(test.session)
  })

  it.each(['compaction/summary', 'compaction/end'] as const)('keeps a named error thrown by %s classified as commit failure', async (eventType) => {
    const test = harness()
    const truncated = await summaryError(test)
    test.adapter.finish = { kind: 'stop' }
    const append = test.session.append.bind(test.session)
    vi.spyOn(test.session, 'append').mockImplementation(((type: string, ...rest: never[]) => {
      if (type === eventType) throw truncated
      return (append as (...args: never[]) => unknown)(type as never, ...rest)
    }) as never)
    await expect(test.run()).rejects.toMatchObject({ code: 'commit', cause: truncated })
  })

  it('preserves a failed error-close over the original truncation', async () => {
    const test = harness()
    const closeError = new Error('cannot close compaction')
    const append = test.session.append.bind(test.session)
    vi.spyOn(test.session, 'append').mockImplementation(((type: string, ...rest: never[]) => {
      if (type === 'compaction/end') throw closeError
      return (append as (...args: never[]) => unknown)(type as never, ...rest)
    }) as never)
    await expect(test.run()).rejects.toMatchObject({ code: 'commit', cause: closeError })
    expect(test.flush).not.toHaveBeenCalled()
    expectNoCheckpoint(test.session)
  })

  it('keeps a named error thrown only by flush classified as persistence failure', async () => {
    const test = harness()
    const truncated = await summaryError(test)
    test.adapter.finish = { kind: 'stop' }
    test.flush.mockRejectedValue(truncated)
    await expect(test.run()).rejects.toMatchObject({ code: 'persistence', cause: truncated })
    expect(test.session.snapshotEvents().some(event => event.type === 'compaction/summary')).toBe(true)
  })

  it('does not apply manual classification to automatic compaction', async () => {
    const test = harness()
    test.session.append('turn/start', { turn: 1 })
    const operation = test.run('current-turn')
    await expect(operation).rejects.toMatchObject({ name: 'SummaryTruncatedError', code: 'MAX_TOKENS' })
    await expect(operation).rejects.not.toBeInstanceOf(ManualCompactionError)
    expectNoCheckpoint(test.session)
  })
})
