/** Boolean task presence for the new Web-backed Host; master numeric impact remains separately tested. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installDesktopUpdateTaskControl } from '../src/update-tasks.ts'

type AgentState = { status: 'idle' | 'running'; inbox: { nextTurn: object[]; nextStep: object[] } }
type JobState = { id: string; status: 'running' | 'stopping' | 'succeeded' }
let ctx: Context
let inspect: ReturnType<typeof installDesktopUpdateTaskControl>
const agents: AgentState[] = []
const jobs = new Map<AgentState | undefined, JobState[]>()

beforeEach(async () => {
  agents.length = 0
  jobs.clear()
  ctx = new Context()
  // Narrow service doubles retain real Cordis effects and the public startup/disposal barrier.
  ctx.provide('agents', { list: () => agents } as unknown as Context['agents'])
  ctx.provide('jobs', { list: (owner?: AgentState) => jobs.get(owner) ?? [], onJobsChanged: () => () => {} } as unknown as Context['jobs'])
  inspect = installDesktopUpdateTaskControl(ctx)
  await ctx.plugin(function desktopImpactTestReady() {})
})

afterEach(async () => { await ctx.fiber.dispose() })

function idleAgent(): AgentState { return { status: 'idle', inbox: { nextTurn: [], nextStep: [] } } }

function request(owner: Context, next: () => Promise<void> = async () => {}): {
  response: { status?: number }
  settled: Promise<void>
} {
  const response: { status?: number } = {}
  const nodeResponse = { writeHead(status: number) { response.status = status; return this }, end() {} } as unknown as ServerResponse
  return { response, settled: owner.waterfall('connection/request', {} as IncomingMessage, nodeResponse, next) }
}

describe('Desktop Web-backed update task presence', () => {
  it('reports idle when no Agent, inbox or active job is present', async () => {
    agents.push(idleAgent())
    jobs.set(undefined, [{ id: 'done', status: 'succeeded' }])
    expect(await inspect('inspect')).toBe(false)
  })

  it.each(['running', 'nextTurn', 'nextStep'] as const)('reports %s Agent work until it settles', async (kind) => {
    const agent = idleAgent()
    agents.push(agent)
    if (kind === 'running') agent.status = 'running'
    else agent.inbox[kind].push({ id: 1 })
    expect(await inspect('inspect')).toBe(true)
    agent.status = 'idle'
    agent.inbox.nextTurn.length = 0
    agent.inbox.nextStep.length = 0
    expect(await inspect('inspect')).toBe(false)
  })

  it.each(['running', 'stopping'] as const)('reports global and Agent-owned %s jobs until terminal', async (status) => {
    const agent = idleAgent()
    agents.push(agent)
    for (const owner of [undefined, agent]) {
      jobs.set(owner, [{ id: 'job', status }])
      expect(await inspect('inspect')).toBe(true)
      jobs.set(owner, [{ id: 'job', status: 'succeeded' }])
      expect(await inspect('inspect')).toBe(false)
    }
  })

  it('returns boolean presence for overlapping job views rather than legacy numeric counts', async () => {
    const first = idleAgent()
    const second = idleAgent()
    first.status = 'running'
    first.inbox.nextTurn.push({ id: 1 })
    first.inbox.nextStep.push({ id: 2 }, { id: 3 })
    second.inbox.nextStep.push({ id: 4 })
    agents.push(first, second)
    const shared: JobState = { id: 'global', status: 'running' }
    jobs.set(undefined, [shared, { id: 'done', status: 'succeeded' }])
    jobs.set(first, [shared, { id: 'stopping', status: 'stopping' }])
    expect(await inspect('inspect')).toBe(true)
    jobs.clear()
    first.status = 'idle'
    expect(await inspect('inspect')).toBe(true)
    for (const agent of agents) {
      agent.inbox.nextTurn.length = 0
      agent.inbox.nextStep.length = 0
    }
    expect(await inspect('inspect')).toBe(false)
  })
})

describe('Web-backed update admission barrier', () => {
  it('closes new API requests before waiting for an already admitted response', async () => {
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    let delegated = 0
    const first = request(ctx, async () => { delegated++; entered.resolve(undefined); await finish.promise })
    await entered.promise
    let settled = false
    const lock = inspect('lock').then((value) => { settled = true; return value })
    const refused = request(ctx, async () => { delegated++ })
    await refused.settled
    expect(refused.response.status).toBe(503)
    expect(delegated).toBe(1)
    expect(settled).toBe(false)
    finish.resolve(undefined)
    await first.settled
    expect(await lock).toBe(false)
    expect(settled).toBe(true)
    expect(await inspect('unlock')).toBe(false)
    const allowed = request(ctx, async () => { delegated++ })
    await allowed.settled
    expect(allowed.response.status).toBeUndefined()
    expect(delegated).toBe(2)
  })

  it('supersedes an overlapping lock without opening admission', async () => {
    const entered = Promise.withResolvers<undefined>()
    const finish = Promise.withResolvers<undefined>()
    const pending = request(ctx, async () => { entered.resolve(undefined); await finish.promise })
    await entered.promise
    const first = expect(inspect('lock')).rejects.toThrow('superseded')
    const second = inspect('lock')
    const refused = request(ctx)
    await refused.settled
    expect(refused.response.status).toBe(503)
    finish.resolve(undefined)
    await pending.settled
    await first
    await expect(second).resolves.toBe(false)
    const stillLocked = request(ctx)
    await stillLocked.settled
    expect(stillLocked.response.status).toBe(503)
  })

  it('never unlocks admission after a missing task service or failed task query', async () => {
    const owner = new Context()
    const gate = installDesktopUpdateTaskControl(owner, true)
    await owner.plugin(function taskBarrierReady() {})
    try {
      await expect(gate('unlock')).rejects.toThrow('task services are unavailable')
      const refused = request(owner)
      await refused.settled
      expect(refused.response.status).toBe(503)
      owner.provide('agents', { list: () => { throw new Error('task registry failed') } } as unknown as Context['agents'])
      owner.provide('jobs', { list: () => [], onJobsChanged: () => () => {} } as unknown as Context['jobs'])
      await expect(gate('unlock')).rejects.toThrow('task registry failed')
      const stillRefused = request(owner)
      await stillRefused.settled
      expect(stillRefused.response.status).toBe(503)
    } finally { await owner.fiber.dispose() }
    await expect(gate('unlock')).rejects.toThrow('Host is stopping')
  })

  it('keeps an owned HTTP gate closed when a later job view fails despite observed active work', async () => {
    const owner = new Context()
    const running = idleAgent()
    running.status = 'running'
    let broken = false
    owner.provide('agents', { list: () => [running] } as unknown as Context['agents'])
    owner.provide('jobs', { list: (agent?: AgentState) => {
      if (broken && agent === running) throw new Error('owned job view failed')
      return agent === undefined ? [{ id: 'active', status: 'running' }] : []
    }, onJobsChanged: () => () => {} } as unknown as Context['jobs'])
    const gate = installDesktopUpdateTaskControl(owner, true)
    await owner.plugin(function taskViewReady() {})
    try {
      broken = true
      await expect(gate('unlock')).rejects.toThrow('owned job view failed')
      const refused = request(owner)
      await refused.settled
      expect(refused.response.status).toBe(503)
    } finally { await owner.fiber.dispose() }
  })
})
