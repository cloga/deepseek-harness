/** Task presence through the Web-backed Host API; the retired numeric impact payload is not restored. */
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

describe('Desktop update task presence', () => {
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
