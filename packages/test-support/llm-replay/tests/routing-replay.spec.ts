import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import LlmRuntime, {
  AssistantStreamAccumulator, BlockAssembler, createAssistantMessage, createUserMessage, LlmAdapter, ToolCallId,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId, SessionSeq } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { classifyRoutingTask } from '@deepseek-ai/dsh-model-routing'
import type { RoutingClassifierResultEvent, TaskClassification } from '@deepseek-ai/dsh-model-routing'
import { deriveReplayScript, installLlmReplay, loadReplayScript } from '../src/index.ts'
import type { ReplayEntry } from '../src/index.ts'

const CLASSIFICATION: TaskClassification = { continuity: 'new-task', complexity: 'routine', confidence: 0.9, reasonCode: 'new-task' }
const USAGE = { inputTokens: 10, outputTokens: 8, cacheReadTokens: 2 }
let directory: string
const roots: Context[] = []
beforeEach(() => { directory = mkdtempSync(join(tmpdir(), 'routing-replay-')) })
afterEach(async () => {
  await Promise.all(roots.splice(0).map(ctx => ctx.fiber.dispose()))
  rmSync(directory, { recursive: true, force: true })
})

function event(type: string, data: unknown): SessionEvent {
  // Fixtures deliberately enter the same unknown durable-data boundary as projected JSONL.
  return { type, data, seq: SessionSeq(0), time: 0 } as SessionEvent
}

function chunks(text = JSON.stringify(CLASSIFICATION)): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text: text.slice(0, 3) },
    { type: 'text-delta', index: 0, text: text.slice(3) },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'usage', usage: USAGE },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function compact(values: StreamChunk[]) {
  const stream = new AssistantStreamAccumulator()
  values.forEach((chunk, index) => { stream.push({ time: index, chunk }) })
  return stream.snapshot()
}

function request(callId = 'classifier-1', taskText = 'explain a small change'): SessionEvent {
  return event('model/routing-request', {
    callId, intentSeq: 0, taskText,
    config: { provider: 'test', model: 'same', maxTokens: 200 },
    system: 'recorded classifier instruction',
    messages: [createUserMessage({ content: [{ type: 'text', text: taskText }], source: { kind: 'plugin', plugin: 'dsh-model-routing' } })],
  })
}

function result(
  callId = 'classifier-1',
  outcome: RoutingClassifierResultEvent['outcome'] = 'success',
  values = chunks(),
  classification = CLASSIFICATION,
): SessionEvent {
  const usage = values.findLast(chunk => chunk.type === 'usage')
  return event('model/routing-result', {
    callId, outcome, stream: compact(values),
    ...outcome === 'success' ? { classification } : {},
    ...usage?.type === 'usage' ? { usage: usage.usage } : {},
  })
}

function assistant(values = chunks('ordinary response'), position = { turn: 1, step: 1 }): SessionEvent {
  const finish = values.at(-1)
  if (finish?.type !== 'finish') return event('assistant/attempt', { ...position, stream: compact(values) })
  const assembler = new BlockAssembler()
  values.forEach((chunk) => { assembler.push(chunk) })
  return {
    type: 'assistant/message',
    seq: SessionSeq(0),
    time: 0,
    data: {
      ...position, stream: [...compact(values)], usage: USAGE,
      message: createAssistantMessage({ content: assembler.blocks(), source: { provider: 'test', model: 'same' } }),
    },
    surfaceOp: 'append',
  }
}

function fixture(audit: SessionEvent[], ordinary = chunks('ordinary response'), duringStep = false): string {
  const file = join(directory, `session.v${SESSION_FORMAT_VERSION}.jsonl`)
  const start = event('step/start', { turn: 1, step: 1 })
  const events = [event('turn/start', { turn: 1 }), ...duringStep ? [start, ...audit] : [...audit, start],
    assistant(ordinary), event('step/end', { turn: 1, step: 1 }), event('turn/end', { turn: 1, reason: { kind: 'completed' } })]
  const header = { type: 'session', version: SESSION_FORMAT_VERSION, id: 'recorded-session', createdAt: 0, isSeeded: false, delegationDepth: 0 }
  writeFileSync(file, [JSON.stringify(header), ...events.map((value, seq) => JSON.stringify({ ...value, seq }))].join('\n') + '\n')
  return file
}

function override(patches: { at: number; entry: ReplayEntry }[]): string {
  const file = join(directory, 'replay.override.json')
  writeFileSync(file, JSON.stringify({ patches }))
  return file
}

function runClassification(ctx: Context, session: Session, intentSeq = SessionSeq(0)) {
  return classifyRoutingTask(ctx, {
    selection: { provider: 'test', model: 'same' },
    maxInputBytes: 10_000, maxOutputTokens: 200, maxOutputBytes: 10_000, timeoutMs: 10_000,
  }, { session, intentSeq, taskText: 'explain a small change', signal: new AbortController().signal })
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const values: StreamChunk[] = []
  for await (const chunk of stream) values.push(chunk)
  return values
}

describe('audited classifier replay derivation', () => {
  it('reserves the classifier call before the ordinary response even on the same model', () => {
    expect(deriveReplayScript([request(), result(), event('step/start', { turn: 1, step: 1 }), assistant()])).toEqual([
      { kind: 'chunks', chunks: chunks() }, { kind: 'chunks', chunks: chunks('ordinary response') },
    ])
  })

  it('uses request order instead of reversed settlement order', () => {
    const second: TaskClassification = { ...CLASSIFICATION, complexity: 'complex' }
    const secondChunks = chunks(JSON.stringify(second))
    expect(deriveReplayScript([
      request('first'), request('second'), result('second', 'success', secondChunks, second), result('first'),
      event('step/start', { turn: 1, step: 1 }), assistant(),
    ])).toEqual([
      { kind: 'chunks', chunks: chunks() }, { kind: 'chunks', chunks: secondChunks }, { kind: 'chunks', chunks: chunks('ordinary response') },
    ])
  })

  it('preserves compacted reasoning/text boundaries and usage before the classifier terminator', () => {
    const values: StreamChunk[] = [
      { type: 'block-start', index: 1, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 1, text: 'check ' },
      { type: 'reasoning-delta', index: 1, text: 'complexity' },
      { type: 'block-end', index: 1, block: { type: 'reasoning', text: 'check complexity' } },
      ...chunks(),
    ]
    expect(deriveReplayScript([request(), result('classifier-1', 'success', values)]))
      .toEqual([{ kind: 'chunks', chunks: values }])
  })

  it.each([
    'not JSON', JSON.stringify({ ...CLASSIFICATION, confidence: 9 }), JSON.stringify({ ...CLASSIFICATION, extra: true }),
  ])('replays exact invalid classifier output %s without substituting a successful classification', (text) => {
    const values = chunks(text)
    expect(deriveReplayScript([request(), result('classifier-1', 'invalid-output', values)]))
      .toEqual([{ kind: 'chunks', chunks: values }])
  })

  it('preserves an explicit uncertain classification rather than choosing a route', () => {
    const uncertain: TaskClassification = { ...CLASSIFICATION, confidence: 0.1, reasonCode: 'uncertain' }
    const values = chunks(JSON.stringify(uncertain))
    expect(deriveReplayScript([request(), result('classifier-1', 'success', values, uncertain)]))
      .toEqual([{ kind: 'chunks', chunks: values }])
  })

  it('replays max-token termination and a non-text stopping prefix without inventing a stop finish', () => {
    const limited: StreamChunk[] = [...chunks().slice(0, -1), { type: 'finish', reason: { kind: 'max-tokens' } }]
    const nonText: StreamChunk[] = [{ type: 'usage', usage: USAGE }, { type: 'block-start', index: 0, blockType: 'tool-call' }]
    expect(deriveReplayScript([request(), result('classifier-1', 'max-tokens', limited)]))
      .toEqual([{ kind: 'chunks', chunks: limited }])
    expect(deriveReplayScript([request(), result('classifier-1', 'non-text', nonText)]))
      .toEqual([{ kind: 'chunks', chunks: nonText }])
    const toolDelta: StreamChunk[] = [{ type: 'tool-call-delta', index: 0, id: ToolCallId('call'), argumentsDelta: '{}' }]
    expect(deriveReplayScript([request(), result('classifier-1', 'non-text', toolDelta)]))
      .toEqual([{ kind: 'chunks', chunks: toolDelta }])
  })

  it('retains provider-error prefix usage and appends only a canonical redacted failure', () => {
    const prefix = chunks().slice(0, -1)
    const script = deriveReplayScript([request(), result('classifier-1', 'provider-error', prefix)])
    expect(script).toEqual([{ kind: 'chunks', chunks: [...prefix, {
      type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'Recorded classifier provider failure (diagnostic redacted).' } },
    }] }])
  })

  it.each([
    'output-limit', 'missing-finish', 'timeout', 'aborted', 'input-limit', 'preflight-error',
  ] as const)('requires an explicit override for %s instead of claiming a successful replay', (outcome) => {
    expect(() => deriveReplayScript([request(), result('classifier-1', outcome, chunks().slice(0, -1))]))
      .toThrow(`outcome ${outcome} requires an explicit replay.override.json entry`)
  })

  it.each([
    [[request()], 'has no result'],
    [[result()], 'has no preceding request'],
    [[result(), request()], 'has no preceding request'],
    [[request(), request(), result()], 'duplicate classifier request'],
    [[request(), result(), result()], 'duplicate classifier result'],
    [[request(), result('different')], 'has no preceding request'],
  ] as const)('rejects unmatched or duplicate audit records', (events, message) => {
    expect(() => deriveReplayScript([...events])).toThrow(message)
  })

  it('rejects malformed or extra audit fields instead of shifting the script cursor', () => {
    const req = request()
    const res = result()
    const malformed = [
      { ...req, data: { ...req.data, extra: true } },
      { ...req, data: { ...req.data, callId: '' } },
      { ...req, data: { ...req.data, intentSeq: 0.5 } },
      { ...req, data: { ...req.data, messages: {} } },
      { ...res, data: { ...res.data, extra: true } },
      { ...res, data: { ...res.data, outcome: ['success'] } },
      { ...res, data: { ...res.data, classification: { ...CLASSIFICATION, complexity: ['routine'] } } },
      { ...res, data: { ...res.data, classification: { ...CLASSIFICATION, extra: true } } },
      { ...res, data: { ...res.data, stream: {} } },
      { ...res, data: { ...res.data, usage: { ...USAGE, secret: 'not usage' } } },
    ]
    for (const bad of malformed) {
      const events = bad.type === 'model/routing-request' ? [bad, res] : [req, bad]
      expect(() => deriveReplayScript(events as SessionEvent[])).toThrow(/malformed model\/routing-/)
    }
  })

  it('rejects outcome/content contradictions and extra chunks after the classifier stopped', () => {
    const contradictions = [
      result('classifier-1', 'success', chunks('not JSON')),
      result('classifier-1', 'success', []),
      result('classifier-1', 'success', [{ type: 'finish', reason: { kind: 'max-tokens' } }]),
      result('classifier-1', 'success', chunks(), { ...CLASSIFICATION, complexity: 'complex' }),
      result('classifier-1', 'invalid-output', chunks()),
      result('classifier-1', 'max-tokens', chunks()),
      result('classifier-1', 'non-text', chunks()),
      result('classifier-1', 'provider-error', chunks()),
      result('classifier-1', 'success', [...chunks(), { type: 'usage', usage: USAGE }]),
    ]
    for (const invalid of contradictions) expect(() => deriveReplayScript([request(), invalid])).toThrow(/contradicts|stopping member/)
  })
})

describe('classifier replay installation and explicit override rescue', () => {
  it('serves real audited classification and ordinary calls keylessly without shifting a same-model cursor', async () => {
    const file = fixture([request(), result()])
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(LlmRuntime)
    const observed: GenerateOptions[] = []
    ctx.on('llm/stream', (options, next) => { observed.push(options); return next() }, { prepend: true })
    const replay = installLlmReplay(ctx, { file, providers: [{ id: 'test', models: [{ id: 'same' }] }] })
    const session = Session.create(SessionId('fresh-live-session'))
    const classified = await runClassification(ctx, session)
    expect(classified).toMatchObject({ outcome: 'success', classification: CLASSIFICATION, usage: USAGE })
    expect(await drain(ctx.llm.stream({ provider: 'test', model: 'same', sessionId: session.id, messages: [] })))
      .toEqual(chunks('ordinary response'))
    expect(observed.map(options => ({
      purpose: options.purpose, provider: options.provider, model: options.model, sessionId: options.sessionId,
    }))).toEqual([
      { purpose: 'model-routing', provider: 'test', model: 'same', sessionId: 'fresh-live-session' },
      { purpose: undefined, provider: 'test', model: 'same', sessionId: 'fresh-live-session' },
    ])
    replay.assertConsumed()
    replay.dispose()
  })

  it.each(['invalid-output', 'provider-error', 'max-tokens', 'non-text'] as const)
  ('reproduces the real classifier %s outcome and retained usage', async (outcome) => {
    const values: StreamChunk[] = outcome === 'invalid-output' ? chunks('malformed JSON')
      : outcome === 'provider-error' ? chunks().slice(0, -1)
        : outcome === 'max-tokens' ? [...chunks().slice(0, -1), { type: 'finish', reason: { kind: 'max-tokens' } }]
          : [{ type: 'usage', usage: USAGE }, { type: 'block-start', index: 0, blockType: 'tool-call' }]
    const file = fixture([request(), result('classifier-1', outcome, values)])
    const ctx = new Context()
    roots.push(ctx)
    await ctx.plugin(LlmRuntime)
    const replay = installLlmReplay(ctx, { file, providers: [{ id: 'test', models: [{ id: 'same' }] }] })
    const session = Session.create(SessionId('fresh-outcome-session'))
    expect(await runClassification(ctx, session)).toMatchObject({ outcome, usage: USAGE })
    expect(await drain(ctx.llm.stream({ provider: 'test', model: 'same', sessionId: session.id, messages: [] })))
      .toEqual(chunks('ordinary response'))
    replay.assertConsumed()
    replay.dispose()
  })

  it('allows a positional override to replace a refused classifier slot without replacing ordinary calls', () => {
    const file = fixture([request(), result('classifier-1', 'output-limit', chunks().slice(0, -1))])
    expect(() => loadReplayScript({ file })).toThrow('requires an explicit')
    const replacement: ReplayEntry = { kind: 'chunks', chunks: [{ type: 'text-delta', index: 0, text: 'explicit oversized chunk' }] }
    expect(loadReplayScript({ file, overrideFile: override([{ at: 0, entry: replacement }]) }))
      .toEqual([replacement, { kind: 'chunks', chunks: chunks('ordinary response') }])
    expect(() => loadReplayScript({ file, overrideFile: override([{ at: 1, entry: { kind: 'chunks', chunks: [] } }]) }))
      .toThrow('requires an explicit')
  })

  it('preserves direct ordinary thrown-stream refusal while allowing an explicit patch rescue', () => {
    const prefix = chunks('partial response').slice(0, -1)
    expect(() => deriveReplayScript([assistant(prefix)])).toThrow('ended without a finish chunk')
    const file = fixture([], prefix)
    expect(() => loadReplayScript({ file })).toThrow('ended without a finish chunk')
    const replacement: ReplayEntry = { kind: 'throw', chunks: prefix, message: 'explicit test failure', code: 'UNKNOWN' }
    expect(loadReplayScript({ file, overrideFile: override([{ at: 0, entry: replacement }]) })).toEqual([replacement])
  })

  it('does not let positional or whole-script overrides hide an unpaired classifier audit', () => {
    const file = fixture([request()])
    const overrideFile = override([{ at: 0, entry: { kind: 'chunks', chunks: [] } }])
    expect(() => loadReplayScript({ file, overrideFile })).toThrow('has no result')
    writeFileSync(overrideFile, JSON.stringify([{ kind: 'chunks', chunks: [] }]))
    expect(() => loadReplayScript({ file, overrideFile })).toThrow('has no result')
  })

  it('refuses mixed overlap whose settlement order cannot determine dispatch order', () => {
    const file = fixture([request(), result()], chunks('ordinary already streaming'), true)
    expect(() => loadReplayScript({ file })).toThrow(/ambiguous.*whole-script/)
    const overrideFile = override([{ at: 0, entry: { kind: 'chunks', chunks: chunks('guessed ordinary first') } }])
    expect(() => loadReplayScript({ file, overrideFile })).toThrow(/ambiguous.*whole-script/)
    const explicit: ReplayEntry[] = [
      { kind: 'chunks', chunks: chunks('ordinary already streaming') }, { kind: 'chunks', chunks: chunks() },
    ]
    writeFileSync(overrideFile, JSON.stringify(explicit))
    expect(loadReplayScript({ file, overrideFile })).toEqual(explicit)
  })

  it.each([false, true])('never uses an optional request/header (%s) to order mixed calls', (header) => {
    const records = [event('step/start', { turn: 1, step: 1 }),
      ...header ? [event('request/header', { reason: 'initial', header: { config: { provider: 'test', model: 'same' } } })] : [],
      request(), result(), assistant()]
    expect(() => deriveReplayScript(records)).toThrow(/ambiguous.*whole-script/)
  })

  it('refuses a mixed partial event list that omits the conversation step lower bound', () => {
    expect(() => deriveReplayScript([request(), result(), assistant()])).toThrow(/ambiguous.*whole-script/)
  })

  it('conservatively rejects classifiers between two attempts in one step', () => {
    const attempt = event('assistant/attempt', { turn: 1, step: 1, stream: compact([
      { type: 'finish', reason: { kind: 'error', failure: { code: 'UNKNOWN', message: 'retryable fixture failure' } } },
    ]) })
    expect(() => deriveReplayScript([
      event('step/start', { turn: 1, step: 1 }), attempt, request(), result(), assistant(),
    ])).toThrow(/ambiguous.*whole-script/)
  })

  it('preserves a tool-phase classifier after the prior settlement and before the next step', () => {
    const records = [event('step/start', { turn: 1, step: 1 }), assistant(chunks('prior')),
      request(), result(), event('step/end', { turn: 1, step: 1 }),
      event('step/start', { turn: 1, step: 2 }), assistant(chunks('next'), { turn: 1, step: 2 })]
    expect(deriveReplayScript(records)).toEqual([
      { kind: 'chunks', chunks: chunks('prior') }, { kind: 'chunks', chunks: chunks() }, { kind: 'chunks', chunks: chunks('next') },
    ])
  })

  it('refuses mixed local compaction without a durable call-start bound, but retains completed compaction before classifiers', () => {
    const summary = event('compaction/summary', { llmStreamCall: true, rawOutput: [{ type: 'text', text: 'summary' }] })
    expect(() => deriveReplayScript([request(), result(), summary])).toThrow(/ambiguous.*compaction.*whole-script/)
    expect(deriveReplayScript([summary, request(), result()]).map(entry => entry.kind)).toEqual(['chunks', 'chunks'])
    expect(deriveReplayScript([request(), result(), event('compaction/summary', { llmStreamCall: false })]))
      .toEqual([{ kind: 'chunks', chunks: chunks() }])
  })

  it('refuses empty ordinary settlements in a mixed log instead of guessing whether they consumed a call', () => {
    const empty = event('assistant/attempt', { turn: 1, step: 1, stream: [] })
    expect(() => deriveReplayScript([request(), result(), empty])).toThrow(/ambiguous.*whole-script/)
    expect(() => deriveReplayScript([empty, request(), result()])).toThrow(/ambiguous.*whole-script/)
    expect(deriveReplayScript([empty])).toEqual([])
  })

  it.each(['streaming', 'preparing'] as const)(
    'refuses genuine loop/classifier overlap while the conversation is %s despite identical durable order', async (boundary) => {
      const ctx = new Context()
      roots.push(ctx)
      await mountAgentLoopTestDependencies(ctx)
      await ctx.plugin(AgentLoop, { agents: [] })
      const entered = Promise.withResolvers<undefined>()
      const release = Promise.withResolvers<undefined>()
      const dispatches: string[] = []
      let conversationCalls = 0
      ctx.llm.registerAdapter(['test'], new class extends LlmAdapter {
        override resolveModel(provider: string, model: string) { return Promise.resolve({ provider, id: model, name: model }) }
        override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
          if (options.purpose === 'model-routing') {
            dispatches.push('B')
            yield* chunks()
            return
          }
          conversationCalls += 1
          const name = `A${conversationCalls}`
          dispatches.push(name)
          if (conversationCalls === 2 && boundary === 'streaming') {
            entered.resolve(undefined)
            await release.promise
          }
          yield* chunks(name)
        }
      }())
      const parent = await ctx.agentLoop.create(SessionId(`live-overlap-${boundary}`), { provider: 'test', model: 'same' })
      const records: SessionEvent[] = []
      ctx.on('session/event', (session, recorded) => { if (session === parent.session) records.push(recorded) })
      const floor = { routine: 3, standard: 3, complex: 3 } as const
      const intent = parent.session.append('model/auto-selection', { mode: 'balanced', policy: {
        candidates: [{ id: 'only', selection: { provider: 'test', model: 'same' }, quality: 3, relativeCost: 1 }],
        qualityFloors: { efficiency: floor, balanced: floor, intelligence: floor }, minConfidence: 0.8, conservativeCandidateId: 'only',
      }, classifier: { selection: { provider: 'test', model: 'same' }, maxInputBytes: 10_000,
        maxOutputTokens: 200, maxOutputBytes: 10_000, timeoutMs: 10_000 } })
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'warm up the unchanged request header' }], source: { kind: 'user' } }))
      await parent.whenIdle()
      if (boundary === 'preparing') {
        parent.ctx.on('agent/request', async (_payload, next) => {
          entered.resolve(undefined)
          await release.promise
          return next()
        })
      }
      parent.followup(createUserMessage({ content: [{ type: 'text', text: 'second conversation call' }], source: { kind: 'user' } }))
      try {
        await entered.promise
        expect(dispatches).toEqual(boundary === 'streaming' ? ['A1', 'A2'] : ['A1'])
        // This independent call is the same audited producer used by background child routing.
        const classification = await runClassification(ctx, parent.session, intent.seq)
        expect(classification).toMatchObject({ outcome: 'success', classification: CLASSIFICATION })
        release.resolve(undefined)
        await parent.whenIdle()
        expect(dispatches).toEqual(boundary === 'streaming' ? ['A1', 'A2', 'B'] : ['A1', 'B', 'A2'])
        const starts = records.filter(recorded => recorded.type === 'step/start')
        const secondStart = starts[1]
        if (secondStart === undefined) throw new Error('second conversation step was not recorded')
        const relevant = records.slice(records.indexOf(secondStart)).filter(recorded => [
          'step/start', 'request/header', 'model/routing-request', 'model/routing-result', 'assistant/message',
        ].includes(recorded.type))
        expect(relevant.map(recorded => recorded.type)).toEqual([
          'step/start', 'model/routing-request', 'model/routing-result', 'assistant/message',
        ])
        expect(() => deriveReplayScript(records)).toThrow(/ambiguous.*whole-script/)
      } finally {
        release.resolve(undefined)
        await parent.whenIdle()
      }
    },
  )

  it('allows a whole-script override to replace a paired but unsupported classifier outcome', () => {
    const file = fixture([request(), result('classifier-1', 'timeout', [])])
    const overrideFile = join(directory, 'replacement.json')
    const replacement: ReplayEntry[] = [{ kind: 'hang' }]
    writeFileSync(overrideFile, JSON.stringify(replacement))
    expect(loadReplayScript({ file, overrideFile })).toEqual(replacement)
  })
})
