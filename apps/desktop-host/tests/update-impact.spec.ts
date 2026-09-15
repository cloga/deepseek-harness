import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { desktopUpdateImpact } from '../src/index.ts'

describe('desktopUpdateImpact', () => {
  it('counts running sessions, queued turns, and unique active jobs', () => {
    const agents = [
      {
        id: 'session-a',
        status: 'running',
        inbox: { nextTurn: [{ id: 1 }], nextStep: [{ id: 2 }, { id: 3 }] },
      },
      {
        id: 'session-b',
        status: 'idle',
        inbox: { nextTurn: [], nextStep: [{ id: 4 }] },
      },
    ]
    const jobs = {
      list: (agent?: { id: string }) => agent === undefined
        ? [{ id: 'global', status: 'running' }, { id: 'done', status: 'succeeded' }]
        : agent.id === 'session-a'
          ? [{ id: 'global', status: 'running' }, { id: 'stopping', status: 'stopping' }]
          : [],
    }
    const ctx = {
      agents: { list: () => agents },
      get: (name: string) => name === 'jobs' ? jobs : undefined,
    } as unknown as Context

    expect(desktopUpdateImpact(ctx)).toEqual({
      runningSessions: 1,
      queuedMessages: 4,
      runningJobs: 2,
    })
  })
})
