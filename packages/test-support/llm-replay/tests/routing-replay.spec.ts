import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  AssistantStreamAccumulator, BlockAssembler, createAssistantMessage, createUserMessage, ToolCallId,
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

function assistant(values = chunks('ordinary response')): SessionEvent {
  const finish = values.at(-1)
  if (finish?.type !== 'finish') return event('assistant/attempt', { turn: 1, step: 1, stream: compact(values) })
  const assembler = new BlockAssembler()
  values.forEach((chunk) => { assembler.push(chunk) })
  return {
    type: 'assistant/message',
    seq: SessionSeq(0),
    time: 0,
    data: {
      turn: 1, step: 1, stream: [...compact(values)], usage: USAGE,
      message: createAssistantMessage({ content: assembler.blocks(), source: { provider: 'test', model: 'same' } }),
    },
    surfaceOp: 'append',
  }
}

function fixture(audit: SessionEvent[], ordinary = chunks('ordinary response')): string {
  const file = join(directory, `session.v${SESSION_FORMAT_VERSION}.jsonl`)
  const events = [event('turn/start', { turn: 1 }), ...audit, event('step/start', { turn: 1, step: 1 }),
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

function runClassification(ctx: Context, session: Session) {
  return classifyRoutingTask(ctx, {
    selection: { provider: 'test', model: 'same' },
    maxInputBytes: 10_000, maxOutputTokens: 200, maxOutputBytes: 10_000, timeoutMs: 10_000,
  }, { session, intentSeq: SessionSeq(0), taskText: 'explain a small change', signal: new AbortController().signal })
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const values: StreamChunk[] = []
  for await (const chunk of stream) values.push(chunk)
  return values
}

describe('audited classifier replay derivation', () => {
  it('reserves the classifier call before the ordinary response even on the same model', () => {
    expect(deriveReplayScript([request(), result(), assistant()])).toEqual([
      { kind: 'chunks', chunks: chunks() }, { kind: 'chunks', chunks: chunks('ordinary response') },
    ])
  })

  it('uses request order instead of reversed settlement order', () => {
    const second: TaskClassification = { ...CLASSIFICATION, complexity: 'complex' }
    const secondChunks = chunks(JSON.stringify(second))
    expect(deriveReplayScript([
      request('first'), request('second'), result('second', 'success', secondChunks, second), result('first'), assistant(),
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

  it('allows a whole-script override to replace a paired but unsupported classifier outcome', () => {
    const file = fixture([request(), result('classifier-1', 'timeout', [])])
    const overrideFile = join(directory, 'replacement.json')
    const replacement: ReplayEntry[] = [{ kind: 'hang' }]
    writeFileSync(overrideFile, JSON.stringify(replacement))
    expect(loadReplayScript({ file, overrideFile })).toEqual(replacement)
  })
})
