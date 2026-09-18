/** The replacement Host's API barrier observes direct work; it does not pause the AgentLoop. */

import type { IncomingMessage, ServerResponse } from 'node:http'
import { Readable } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { mountAgentLoopTestDependencies, mountAgentLoopTestHarness } from '@deepseek-ai/dsh-agent-loop-testkit'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import LocalJobRegistry from '@deepseek-ai/dsh-jobs-local'
import { createUserMessage, LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import { describe, expect, it, vi } from 'vitest'
import type { TestContext } from 'vitest'
import { installDesktopUpdateTaskControl } from '../../desktop-host/src/update-tasks.ts'

function gate() {
  return {
    entered: Promise.withResolvers<void>(),
    release: Promise.withResolvers<void>(),
  }
}

type ScriptEntry = { chunks: StreamChunk[]; gate?: ReturnType<typeof gate> }

/** Only the provider wire is scripted; registry, Inbox, tools, log, and loop are production code. */
class ScriptedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []

  constructor(private readonly script: ScriptEntry[]) { super() }

  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const entry = this.script[this.requests.length]
    this.requests.push(options)
    if (entry === undefined) throw new Error('desktop direct-work script exhausted')
    if (entry.gate !== undefined) {
      entry.gate.entered.resolve()
      await entry.gate.release.promise
    }
    for (const chunk of entry.chunks) {
      options.signal?.throwIfAborted()
      yield chunk
    }
  }
}

function textResponse(text: string): StreamChunk[] {
  return [
    { type: 'block-start', index: 0, blockType: 'text' },
    { type: 'text-delta', index: 0, text },
    { type: 'block-end', index: 0, block: { type: 'text', text } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

function message(text: string) {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

async function harness(test: TestContext, script: ScriptEntry[] = [], initiallyLocked = true) {
  const ctx = new Context()
  // Release provider barriers before disposal awaits AgentLoop quiescence, including on timeout.
  test.onTestFinished(async () => {
    for (const entry of script) entry.gate?.release.resolve()
    await ctx.fiber.dispose()
  })
  const control = installDesktopUpdateTaskControl(ctx, initiallyLocked)
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } })
  await ctx.plugin(LocalJobRegistry)
  ctx.jobs.attachController('desktop-direct-work-test')
  const adapter = new ScriptedAdapter(script)
  ctx.llm.registerAdapter(['desktop-test'], adapter)
  const loop = await mountAgentLoopTestHarness(ctx)
  const agent = await loop.create(SessionId('desktop-direct-work'), { provider: 'desktop-test', model: 'scripted' })
  return { ctx, control, adapter, agent }
}

/** Exercise the real request waterfall without a listener, socket, or HTTP client. */
async function request(ctx: Context) {
  const incoming = Readable.from([])
  const response = { writeHead: vi.fn(), end: vi.fn() }
  const next = vi.fn(async () => {})
  try {
    await ctx.waterfall('connection/request', incoming as unknown as IncomingMessage, response as unknown as ServerResponse, next)
    return { response, next }
  } finally {
    incoming.destroy()
  }
}

async function expectApiLocked(ctx: Context): Promise<void> {
  const { response, next } = await request(ctx)
  expect(response.writeHead).toHaveBeenCalledExactlyOnceWith(503)
  expect(response.end).toHaveBeenCalledOnce()
  expect(next).not.toHaveBeenCalled()
}

describe('Desktop replacement Host direct-work detection with the real AgentLoop', () => {
  it('keeps a clean replacement idle while refusing API requests', async (test) => {
    const { ctx, control, adapter, agent } = await harness(test)
    const history = agent.session.snapshotEvents()

    await expectApiLocked(ctx)
    expect(await control('inspect')).toBe(false)
    expect(await control('lock')).toBe(false)
    expect(ctx.agents.list()).toEqual([agent])
    expect(agent.status).toBe('idle')
    expect(agent.inbox.nextTurn).toEqual([])
    expect(agent.inbox.nextStep).toEqual([])
    expect(agent.session.snapshotEvents()).toEqual(history)
    expect(adapter.requests).toEqual([])
  })

  it('allows direct followup and tool effects during HTTP 503 without vetoing or losing the claimed input', async (test) => {
    const held = gate()
    const callId = ToolCallId('direct-effect')
    const { ctx, control, adapter, agent } = await harness(test, [
      { gate: held, chunks: [
        { type: 'block-start', index: 0, blockType: 'tool-call' },
        { type: 'tool-call-delta', index: 0, id: callId, name: 'record_effect', argumentsDelta: '{}' },
        { type: 'block-end', index: 0, block: { type: 'tool-call', id: callId, name: 'record_effect', arguments: '{}' } },
        { type: 'finish', reason: { kind: 'tool-calls' } },
      ] },
      { chunks: textResponse('direct work finished') },
    ])
    const effects: string[] = []
    ctx.tools.register(defineContentToolFixture({
      name: 'record_effect',
      description: 'Record an owned in-memory side effect.',
      parameters: {},
      async execute() {
        effects.push('plugin effect')
        return [{ type: 'text', text: 'effect recorded' }]
      },
    }))
    const input = message('run directly, not through HTTP')
    const claimed: string[] = []
    const errors: unknown[] = []
    ctx.on('agent/inbox/claimed', ({ message: pending }) => { claimed.push(pending.id) })
    ctx.on('agent/error', ({ error }) => { errors.push(error) })

    await expectApiLocked(ctx)
    agent.followup(input)
    // A regressed pre-step veto must fail assertions, not strand the provider-entry wait.
    await Promise.race([held.entered.promise, agent.whenIdle()])
    expect(agent.status).toBe('running')
    expect(claimed).toEqual([input.id])
    expect(adapter.requests).toHaveLength(1)
    expect(adapter.requests[0]?.messages).toContainEqual(input)
    const historyWhileHeld = agent.session.snapshotEvents()
    expect(await control('inspect')).toBe(true)
    expect(await control('lock')).toBe(true)
    await expectApiLocked(ctx)
    expect(agent.session.snapshotEvents()).toEqual(historyWhileHeld)
    expect(agent.status).toBe('running')
    expect(adapter.requests[0]?.signal?.aborted).toBe(false)
    expect(effects).toEqual([])

    held.release.resolve()
    await agent.whenIdle()
    expect(errors).toEqual([])
    expect(agent.status).toBe('idle')
    expect(agent.inbox.nextTurn).toEqual([])
    expect(agent.inbox.nextStep).toEqual([])
    expect(claimed).toEqual([input.id])
    expect(adapter.requests).toHaveLength(2)
    expect(effects).toEqual(['plugin effect'])
    const finishedHistory = agent.session.snapshotEvents()
    expect(finishedHistory.flatMap(event => event.type === 'user/message' ? [event.data.id] : []))
      .toEqual([input.id])
    expect(finishedHistory.flatMap(event => event.type === 'turn/end' ? [event.data.reason] : []))
      .toEqual([{ kind: 'completed' }])
    expect(agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: 'direct work finished' }])
    expect(await control('inspect')).toBe(true)
    expect(agent.session.snapshotEvents()).toEqual(finishedHistory)
    expect(await control('unlock')).toBe(false)
    expect((await request(ctx)).next).toHaveBeenCalledOnce()
    // Detection is not rollback: the tool ran and neither inspection nor unlock reverses it.
    expect(effects).toEqual(['plugin effect'])
  })

  it('remembers a direct turn that has finished before the first inspection', async (test) => {
    const { ctx, control, adapter, agent } = await harness(test, [{ chunks: textResponse('already finished') }])
    const input = message('finish before the health check')
    agent.followup(input)
    await agent.whenIdle()

    expect(adapter.requests).toHaveLength(1)
    expect(agent.status).toBe('idle')
    expect(agent.inbox.nextTurn).toEqual([])
    expect(agent.inbox.nextStep).toEqual([])
    expect(agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: 'already finished' }])
    const history = agent.session.snapshotEvents()
    expect(await control('inspect')).toBe(true)
    expect(await control('lock')).toBe(true)
    await expectApiLocked(ctx)
    expect(agent.session.snapshotEvents()).toEqual(history)
    expect(await control('unlock')).toBe(false)
    expect(await control('inspect')).toBe(false)
  })

  it('observes a running transition even when the input was inserted before observation began', async (test) => {
    const held = gate()
    const { ctx, control: normalControl, adapter, agent } = await harness(test, [
      { gate: held, chunks: textResponse('latched wake finished') },
    ], false)
    // Real maintenance latches the followup wake, letting observation start after insertion.
    const maintenance = agent.runMaintenance(async () => { await held.release.promise })
    const input = message('queued before observer registration')
    agent.followup(input)
    expect(agent.status).toBe('idle')
    expect(agent.inbox.nextTurn).toEqual([input])
    const control = installDesktopUpdateTaskControl(ctx, true)
    const inserted = vi.fn()
    ctx.on('agent/inbox/inserted', inserted)
    await expectApiLocked(ctx)

    held.release.resolve()
    await maintenance
    await agent.whenIdle()
    expect(inserted).not.toHaveBeenCalled()
    expect(adapter.requests).toHaveLength(1)
    expect(agent.status).toBe('idle')
    expect(agent.inbox.nextTurn).toEqual([])
    expect(agent.inbox.nextStep).toEqual([])
    expect(agent.session.deriveMessages().at(-1)?.content).toEqual([{ type: 'text', text: 'latched wake finished' }])
    expect(await control('inspect')).toBe(true)
    // A normal, non-preparation inspector has no sticky observation to retain.
    expect(await normalControl('inspect')).toBe(false)
    expect(await control('unlock')).toBe(false)
  })

  it('limitation: API 503 and false inspection do not imply maintenance quiescence', async (test) => {
    const { ctx, control, adapter, agent } = await harness(test)
    const held = gate()
    const history = agent.session.snapshotEvents()
    const statuses: string[] = []
    const effects: string[] = []
    ctx.on('agent/status', ({ status }) => { statuses.push(status) })
    const maintenance = agent.runMaintenance(async (signal) => {
      // TestContext-owned Agent disposal also releases this gate if the test times out.
      const releaseOnAbort = (): void => { held.release.resolve() }
      signal.addEventListener('abort', releaseOnAbort, { once: true })
      try {
        effects.push('maintenance started')
        held.entered.resolve()
        await held.release.promise
        if (!signal.aborted) effects.push('maintenance continued')
      } finally {
        signal.removeEventListener('abort', releaseOnAbort)
      }
    })
    try {
      await held.entered.promise
      await expectApiLocked(ctx)
      expect(effects).toEqual(['maintenance started'])
      expect(agent.status).toBe('idle')
      expect(agent.inbox.nextTurn).toEqual([])
      expect(agent.inbox.nextStep).toEqual([])
      expect(ctx.jobs.list()).toEqual([])
      expect(ctx.jobs.list(agent)).toEqual([])
      expect(await control('inspect')).toBe(false)
      expect(await control('lock')).toBe(false)
      expect(agent.session.snapshotEvents()).toEqual(history)
      expect(effects).toEqual(['maintenance started'])

      held.release.resolve()
      await maintenance
      await agent.whenIdle()
      expect(effects).toEqual(['maintenance started', 'maintenance continued'])
      expect(statuses).toEqual([])
      expect(adapter.requests).toEqual([])
      expect(agent.session.snapshotEvents()).toEqual(history)
      expect(await control('inspect')).toBe(false)
      await expectApiLocked(ctx)
      // Only public running/inbox/job work is observed; maintenance was neither paused nor undone.
      expect(effects).toEqual(['maintenance started', 'maintenance continued'])
    } finally {
      held.release.resolve()
      await maintenance
      await agent.whenIdle()
    }
  })

  for (const target of ['next-turn', 'next-step'] as const) {
    it(`notices ${target} input without claiming, waking, or rewriting it`, async (test) => {
      const { ctx, control, adapter, agent } = await harness(test)
      const input = message(`parked ${target} input`)
      const claimed = vi.fn()
      ctx.on('agent/inbox/claimed', claimed)
      agent.send(input, target, false)
      const history = agent.session.snapshotEvents()

      expect(await control('inspect')).toBe(true)
      expect(await control('lock')).toBe(true)
      await expectApiLocked(ctx)
      expect(agent.inbox.nextTurn).toEqual(target === 'next-turn' ? [input] : [])
      expect(agent.inbox.nextStep).toEqual(target === 'next-step' ? [input] : [])
      expect(agent.session.snapshotEvents()).toEqual(history)
      expect(agent.status).toBe('idle')
      expect(claimed).not.toHaveBeenCalled()
      expect(adapter.requests).toEqual([])

      // Only the caller removes this input; its insertion remains observed after both lists empty.
      expect(agent.inbox.remove(input.id)).toBe(true)
      const removedHistory = agent.session.snapshotEvents()
      expect(await control('inspect')).toBe(true)
      expect(agent.session.snapshotEvents()).toEqual(removedHistory)
      expect(claimed).not.toHaveBeenCalled()
      expect(await control('unlock')).toBe(false)
    })
  }

  for (const ownership of ['unowned', 'agent-owned'] as const) {
    it(`remembers completed ${ownership} jobs without consuming output or cancelling the producer`, async (test) => {
      const { ctx, control, adapter, agent } = await harness(test)
      const owner = ownership === 'agent-owned' ? agent : undefined
      const done = Promise.withResolvers<JobOutcome>()
      const settled = Promise.withResolvers<void>()
      const cancel = vi.fn(() => { done.resolve({ status: 'killed' }) })
      const readOutput = vi.fn(() => 'unconsumed output')
      ctx.jobs.onJobDone(() => { settled.resolve() })
      const run = vi.fn(() => ({ done: done.promise, cancel, readOutput }))
      const id = ctx.jobs.start({ kind: 'subagent', label: 'controlled producer', ...(owner === undefined ? {} : { owner }), run })
      const history = agent.session.snapshotEvents()
      const running = ctx.jobs.get(id, owner)
      await expectApiLocked(ctx)
      expect(run).toHaveBeenCalledOnce()
      expect(running).toMatchObject({ status: 'running', reported: false })
      expect(cancel).not.toHaveBeenCalled()

      // No inspector call until the real registry has committed and notified completion.
      done.resolve({ status: 'completed' })
      await settled.promise
      const completed = ctx.jobs.get(id, owner)
      expect(completed).toMatchObject({ status: 'completed', reported: false })
      expect(await control('inspect')).toBe(true)
      expect(await control('lock')).toBe(true)
      expect(ctx.jobs.get(id, owner)).toEqual(completed)
      expect(cancel).not.toHaveBeenCalled()
      expect(readOutput).not.toHaveBeenCalled()
      expect(agent.session.snapshotEvents()).toEqual(history)
      expect(agent.status).toBe('idle')
      expect(adapter.requests).toEqual([])
      expect(await control('unlock')).toBe(false)
      expect(ctx.jobs.read(id, owner).text).toBe('unconsumed output')
      expect(readOutput).toHaveBeenCalledOnce()
    })
  }
})
