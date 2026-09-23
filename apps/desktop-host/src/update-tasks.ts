/** Authenticated HTTP /api admission and task inspection; WebSocket/direct RPC need separate owner fencing. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-jobs'
import type {} from '@deepseek-ai/dsh-client-connection'

/**
 * Register update admission on the owning Host context.
 * @param ctx - Desktop profile owner; registration may precede services, but inspection requires them to be ready.
 * @param initiallyLocked - Launcher's generation-spanning API barrier, installed before profile entries mount.
 * @returns HTTP /api admission control and work inspection. During initial locked preparation,
 * observed direct Agent/job work stays visible until unlock; this observer does not pause or veto plugin work.
 */
export function installDesktopUpdateTaskControl(ctx: Context, initiallyLocked = false): (action: 'inspect' | 'lock' | 'unlock') => Promise<boolean> {
  let locked = initiallyLocked
  let preparing = initiallyLocked
  let observedPreparationWork = false
  // Observe, never veto, direct Agent work; rejecting a pre-step can consume claimed inbox messages.
  ctx.on('agent/status', ({ status }) => { if (preparing && status === 'running') observedPreparationWork = true })
  ctx.on('agent/inbox/inserted', () => { if (preparing) observedPreparationWork = true })
  ctx.inject(['agents', 'jobs'], (scope) => {
    const registry = scope.jobs
    const observe = (owner?: Parameters<typeof registry.list>[0]): void => {
      if (preparing && registry.list(owner).length > 0) observedPreparationWork = true
    }
    scope.effect(() => {
      const off = registry.onJobsChanged(observe)
      if (preparing) for (const owner of [undefined, ...scope.agents.list()]) observe(owner)
      return off
    }, 'desktop update: direct work observation')
  })
  let lockGeneration = 0
  let stopped = false
  ctx.effect(() => () => { stopped = true })
  const pendingRequests = new Set<Promise<void>>()
  ctx.on('connection/request', async (_request, response, next) => {
    if (locked) {
      response.writeHead(503)
      response.end()
      return
    }
    const finished = Promise.withResolvers<void>()
    pendingRequests.add(finished.promise)
    try { await next() }
    finally { pendingRequests.delete(finished.promise); finished.resolve() }
  })
  return async (action) => {
    if (stopped) throw new Error('desktop update: Host is stopping')
    // A lock request closes admission synchronously, including when a service
    // disappears before task inspection can finish; a failed unlock never opens it.
    const generation = action === 'lock' ? ++lockGeneration : undefined
    if (action === 'lock') locked = true
    const agents = ctx.get('agents')
    const jobs = ctx.get('jobs')
    if (agents === undefined || jobs === undefined) throw new Error('desktop update: task services are unavailable')
    if (action === 'lock') {
      // Read requests are not tasks; admitted writes must finish before the final work check.
      await Promise.all(pendingRequests)
      if (stopped) throw new Error('desktop update: Host is stopping')
      if (generation !== lockGeneration) throw new Error('desktop update: admission lock was superseded')
    }
    const liveAgents = agents.list()
    const agentWork = liveAgents.some(agent => agent.status === 'running'
      || agent.inbox.nextTurn.length > 0 || agent.inbox.nextStep.length > 0)
    let jobWork = false
    // Observe every owner before an unlock: an unavailable later registry view
    // must not be hidden by an earlier active Agent or job.
    for (const owner of [undefined, ...liveAgents]) {
      if (jobs.list(owner).some(job => job.status === 'running' || job.status === 'stopping')) jobWork = true
    }
    const active = (preparing && observedPreparationWork) || agentWork || jobWork
    if (action === 'unlock') { locked = false; preparing = false; lockGeneration++ }
    return active
  }
}
