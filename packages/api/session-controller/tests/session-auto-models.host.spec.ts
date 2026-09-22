/** Auto intent shares the ordinary Session activation and serialized model-selection path. */

import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { readModelSelection } from '@deepseek-ai/dsh-agent'
import type { Agent, AgentHandle, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import ModelRoutingRuntime, { resolveRoutingConfig } from '@deepseek-ai/dsh-model-routing'
import type { Config as RoutingConfig } from '@deepseek-ai/dsh-model-routing'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createScope } from '@deepseek-ai/dsh-scope'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { createSessionTestRemote } from './test-remote.ts'

function configuration(): RoutingConfig {
  return resolveRoutingConfig({
    enabled: true,
    policy: {
      candidates: [{ id: 'strong', selection: { provider: 'test', model: 'strong' }, quality: 3, relativeCost: 1 }],
      qualityFloors: {
        efficiency: { routine: 3, standard: 3, complex: 3 },
        balanced: { routine: 3, standard: 3, complex: 3 },
        intelligence: { routine: 3, standard: 3, complex: 3 },
      },
      conservativeCandidateId: 'strong',
      minConfidence: 0.8,
    },
    classifier: {
      selection: { provider: 'test', model: 'classifier' },
      maxInputBytes: 10_000,
      maxOutputBytes: 10_000,
      maxOutputTokens: 100,
      timeoutMs: 10_000,
    },
  })
}

async function harness(options: { routing?: 'enabled' | 'disabled' | 'absent'; child?: boolean } = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(AgentRegistry)
  const lookup = vi.fn(async (provider: string, model: string, _signal?: AbortSignal) => ({
    provider, id: model, name: model,
  }))
  const stream = vi.fn()
  ctx.llm.registerAdapter(['test'], new class extends LlmAdapter {
    override resolveModel(provider: string, model: string, signal?: AbortSignal) {
      return lookup(provider, model, signal)
    }

    override async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
      stream()
    }
  }())
  const saveDefault = vi.fn()
  const remote = createSessionTestRemote(ctx, {
    cwd: '/project',
    defaultModelSelection: () => ({ provider: 'test', model: 'default' }),
    saveDefaultModelSelection: saveDefault,
  })
  const routingFiber = options.routing === 'absent' ? undefined
    : ctx.plugin(ModelRoutingRuntime, options.routing === 'disabled' ? { enabled: false } : configuration())
  if (routingFiber !== undefined) await routingFiber
  const session = ctx.sessions.create(SessionId('auto-model-session'), {
    meta: { cwd: '/project', ...options.child ? { origin: 'subagent' as const } : {} },
  })
  const agent = {
    id: session.id, session, status: 'idle', options: { provider: 'test', model: 'default' },
    inbox: { nextTurn: [], nextStep: [] },
  } as unknown as Agent
  const scope = createScope(ctx, agent)
  Object.assign(agent, { ctx: scope.ctx })
  const detach = await ctx.agents.register(agent)
  const events: SessionEvent[] = []
  ctx.on('session/event', (subject, event) => { if (subject === session) events.push(event) })
  return {
    ctx, remote, agent, session, scope, detach, routingFiber, saveDefault, lookup, stream, events,
    modelSelection: () => ctx.sessionProjections.stateOf(session, 'modelSelection'),
    routing: () => ctx.sessionProjections.snapshot(session).values.modelRouting,
  }
}

describe('Session Auto model selection', () => {
  it('preserves a typed route-validation failure without replacing it with Auto unavailability', async () => {
    const h = await harness()
    try {
      const failure = new RemoteError('gateway/internal', 'The route lookup was rejected', {})
      h.lookup.mockRejectedValueOnce(failure)
      expect(await h.remote.selectAutoModel({ sessionId: h.session.id, mode: 'balanced' })).toMatchObject({
        ok: false, error: { code: 'gateway/internal', message: 'The route lookup was rejected', details: {} },
      })
      expect(h.events).toEqual([])
      expect(h.saveDefault).not.toHaveBeenCalled()
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('projects a durable Auto selection after the Agent detaches without consuming a live selection', async () => {
    const h = await harness()
    try {
      await h.detach()
      expect(h.ctx.agents.get(h.session.id)).toBeUndefined()
      const { policy, classifier } = configuration()
      if (policy === undefined || classifier === undefined) throw new Error('fixture requires complete Auto settings')
      expect(() => h.session.append('model/auto-selection', {
        mode: 'balanced', policy, classifier,
      })).not.toThrow()
      expect(h.routing()).toEqual({ mode: 'balanced', lastDecision: null })
      expect(h.events.map(event => event.type)).toEqual(['model/auto-selection'])
      expect(h.saveDefault).not.toHaveBeenCalled()
      expect(h.lookup).not.toHaveBeenCalled()
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it.each(['efficiency', 'balanced', 'intelligence'] as const)(
    'captures %s intent without a fake model, actual request, or global-default write', async (mode) => {
      const h = await harness()
      try {
        expect(await h.remote.selectAutoModel({ sessionId: h.session.id, mode })).toEqual({ ok: true, value: { mode } })
        expect(h.routing()).toEqual({ mode, lastDecision: null })
        expect(h.session.requestHeader()).toBeUndefined()
        expect(h.events.map(event => event.type)).toEqual(['model/auto-selection'])
        expect(h.events[0]).toMatchObject({ data: { mode, policy: configuration().policy, classifier: configuration().classifier } })
        expect(h.saveDefault).not.toHaveBeenCalled()
        expect(h.stream).not.toHaveBeenCalled()
        expect(h.ctx.agentDefaultModel.currentSelection()).toEqual({ provider: 'test', model: 'default' })
      } finally {
        await h.ctx.fiber.dispose()
      }
    },
  )

  it('clears replaced manual intent while preserving actual use, then accepts a later manual override', async () => {
    const h = await harness()
    try {
      h.session.append('request/header', {
        header: { config: { provider: 'test', model: 'used' } }, reason: 'initial',
      })
      expect((await h.remote.selectModel({ sessionId: h.session.id, provider: 'test', model: 'pending' })).ok).toBe(true)
      expect(h.modelSelection()?.pending?.model).toBe('pending')
      expect(readModelSelection(h.agent.ctx, h.agent)?.model).toBe('pending')
      h.saveDefault.mockClear()
      expect((await h.remote.selectAutoModel({ sessionId: h.session.id, mode: 'balanced' })).ok).toBe(true)
      expect(h.modelSelection()).toEqual({ lastUsed: { provider: 'test', model: 'used' }, pending: null })
      expect(readModelSelection(h.agent.ctx, h.agent)).toEqual({ provider: 'test', model: 'used' })
      expect(h.routing()).toEqual({ mode: 'balanced', lastDecision: null })
      expect(h.saveDefault).not.toHaveBeenCalled()
      expect((await h.remote.selectModel({ sessionId: h.session.id, provider: 'test', model: 'manual' })).ok).toBe(true)
      expect(h.modelSelection()).toEqual({
        lastUsed: { provider: 'test', model: 'used' }, pending: { provider: 'test', model: 'manual' },
      })
      expect(readModelSelection(h.agent.ctx, h.agent)).toEqual({ provider: 'test', model: 'manual' })
      expect(h.routing()).toEqual({ mode: 'manual', lastDecision: null })
      expect(h.saveDefault).toHaveBeenCalledExactlyOnceWith({ provider: 'test', model: 'manual' })
      expect(h.ctx.sessionProjections.checkpoint(h.session).modelSelection?.ver).toBe(3)
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it.each(['absent', 'disabled'] as const)('rejects %s routing without changing manual selection', async (routing) => {
    const h = await harness({ routing })
    try {
      expect((await h.remote.selectModel({ sessionId: h.session.id, provider: 'test', model: 'manual' })).ok).toBe(true)
      const before = h.modelSelection()
      const response = await h.remote.selectAutoModel({ sessionId: h.session.id, mode: 'efficiency' })
      expect(response).toMatchObject({
        ok: false, error: { code: 'session/auto-model-unavailable', details: { mode: 'efficiency' } },
      })
      expect(h.modelSelection()).toBe(before)
      expect(h.events.some(event => event.type === 'model/auto-selection')).toBe(false)
      expect(await h.remote.modelCatalog()).toMatchObject({ ok: true, value: { autoRouting: { available: false } } })
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('describes Auto readiness separately from empty provider catalogs and actual default selection', async () => {
    const h = await harness()
    try {
      expect(await h.remote.modelCatalog()).toEqual({
        ok: true,
        value: {
          default: { provider: 'test', model: 'default' },
          routableProviders: ['test'], groups: [], failures: [], autoRouting: { available: true },
        },
      })
      expect((await h.remote.selectAutoModel({ sessionId: h.session.id, mode: 'intelligence' })).ok).toBe(true)
      await h.routingFiber?.dispose()
      await h.ctx.plugin(ModelRoutingRuntime, { enabled: false })
      expect(await h.remote.modelCatalog()).toMatchObject({ ok: true, value: { autoRouting: { available: false } } })
      expect(h.routing()).toEqual({ mode: 'intelligence', lastDecision: null })
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('refuses delegated Session ownership before attempting Auto validation', async () => {
    const h = await harness({ child: true })
    try {
      expect(await h.remote.selectAutoModel({ sessionId: h.session.id, mode: 'balanced' })).toMatchObject({
        ok: false, error: { code: 'session/agent-busy', details: { reason: 'use subagent delivery for this child session' } },
      })
      expect(h.lookup).not.toHaveBeenCalled()
      expect(h.events).toEqual([])
      expect(h.saveDefault).not.toHaveBeenCalled()
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('maps route-validation failure to a safe unavailable response without consuming a pending choice', async () => {
    const h = await harness()
    try {
      await h.remote.selectModel({ sessionId: h.session.id, provider: 'test', model: 'manual' })
      const before = h.modelSelection()
      h.lookup.mockRejectedValueOnce(new Error('secret-provider-credential'))
      const response = await h.remote.selectAutoModel({ sessionId: h.session.id, mode: 'balanced' })
      expect(response).toMatchObject({ ok: false, error: { code: 'session/auto-model-unavailable' } })
      expect(JSON.stringify(response)).not.toContain('secret-provider-credential')
      expect(h.modelSelection()).toBe(before)
      expect(h.routing()).toEqual({ mode: 'manual', lastDecision: null })
    } finally {
      await h.ctx.fiber.dispose()
    }
  })

  it('serializes a later manual selection after pending Auto validation', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    h.lookup.mockImplementation(async (provider, model) => {
      if (model === 'classifier') {
        entered.resolve(undefined)
        await release.promise
      }
      return { provider, id: model, name: model }
    })
    try {
      const auto = h.remote.selectAutoModel({ sessionId: h.session.id, mode: 'balanced' })
      await entered.promise
      const manual = h.remote.selectModel({ sessionId: h.session.id, provider: 'test', model: 'later-manual' })
      expect(h.events).toEqual([])
      release.resolve(undefined)
      expect((await auto).ok).toBe(true)
      expect((await manual).ok).toBe(true)
      expect(h.events.map(event => event.type)).toEqual(['model/auto-selection', 'model/selection'])
      expect(h.routing()?.mode).toBe('manual')
      expect(h.modelSelection()?.pending?.model).toBe('later-manual')
      expect(readModelSelection(h.agent.ctx, h.agent)?.model).toBe('later-manual')
    } finally {
      release.resolve(undefined)
      await h.ctx.fiber.dispose()
    }
  })

  it('does not overwrite a manual intent committed by another caller during validation', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<undefined>()
    const release = Promise.withResolvers<undefined>()
    h.lookup.mockImplementation(async (provider, model) => {
      if (model === 'classifier') {
        entered.resolve(undefined)
        await release.promise
      }
      return { provider, id: model, name: model }
    })
    try {
      const pending = h.remote.selectAutoModel({ sessionId: h.session.id, mode: 'balanced' })
      await entered.promise
      h.session.append('model/selection', { provider: 'test', model: 'concurrent-manual' })
      release.resolve(undefined)
      expect(await pending).toMatchObject({ ok: false, error: { code: 'session/auto-model-unavailable' } })
      expect(h.modelSelection()?.pending?.model).toBe('concurrent-manual')
      expect(h.routing()?.mode).toBe('manual')
      expect(h.events.map(event => event.type)).toEqual(['model/selection'])
    } finally {
      release.resolve(undefined)
      await h.ctx.fiber.dispose()
    }
  })

  it('settles caller cancellation during validation without recording Auto intent', async () => {
    const h = await harness()
    const entered = Promise.withResolvers<undefined>()
    const abort = new AbortController()
    h.lookup.mockImplementation(async (provider, model, signal) => {
      if (model === 'classifier') {
        entered.resolve(undefined)
        if (signal === undefined) throw new Error('missing signal')
        signal.throwIfAborted()
        await new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () => { reject(new Error('validation cancelled', { cause: signal.reason })) }, { once: true })
        })
      }
      return { provider, id: model, name: model }
    })
    try {
      const pending = h.remote.selectAutoModel({ sessionId: h.session.id, mode: 'balanced' }, abort.signal)
      await entered.promise
      abort.abort(new Error('cancelled'))
      expect(await pending).toMatchObject({ ok: false, error: { code: 'gateway/cancelled' } })
      expect(h.events).toEqual([])
      expect(h.saveDefault).not.toHaveBeenCalled()
    } finally {
      abort.abort()
      await h.ctx.fiber.dispose()
    }
  })

  it('resumes an ordinary Session explicitly and preserves its recorded Auto intent until the new choice', async () => {
    const h = await harness()
    try {
      expect((await h.remote.selectAutoModel({ sessionId: h.session.id, mode: 'efficiency' })).ok).toBe(true)
      await h.detach()
      await h.scope.dispose()
      const resume = vi.fn(async (owner: Context, options: ResumeAgentOptions): Promise<AgentHandle> => {
        expect(options.resumeSessionId).toBe(h.session.id)
        expect(h.routing()?.mode).toBe('efficiency')
        const resumed = { ...h.agent } as Agent
        const scope = createScope(owner, resumed)
        Object.assign(resumed, { ctx: scope.ctx })
        await options.setup?.(scope.ctx, resumed)
        const detach = await h.ctx.agents.register(resumed)
        return { agent: resumed, dispose: async () => { await detach(); await scope.dispose() } }
      })
      h.ctx.agents.setFactory({
        createAgent: () => Promise.reject(new Error('test does not create Agents')),
        resume,
      })
      expect(await h.remote.selectAutoModel({ sessionId: h.session.id, mode: 'balanced' })).toEqual({
        ok: true, value: { mode: 'balanced' },
      })
      expect(resume).toHaveBeenCalledTimes(1)
      expect(h.routing()?.mode).toBe('balanced')
      expect(h.saveDefault).not.toHaveBeenCalled()
    } finally {
      await h.ctx.fiber.dispose()
    }
  })
})
