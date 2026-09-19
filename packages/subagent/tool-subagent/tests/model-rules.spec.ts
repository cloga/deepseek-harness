/** Native tool authorization remains separate from user-owned child defaults. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { Config as SubagentConfig, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { MockAdapter } from '../../../core/agent-loop/tests/mock-adapter.ts'
import { callSubagent, fakeAgent, modelSelectionSetupAgent, setup, text } from './harness.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

const parentRoute = { provider: 'alpha', model: 'parent-model' }
const childRoute = { provider: 'alpha', model: 'rule-model' }
const modelRules: NonNullable<SubagentConfig['modelRules']> = [{ parent: parentRoute, child: childRoute }]
const task = { description: 'Delegate implementation', prompt: 'Inspect the requested change.' }
const reasoning = {
  efforts: [
    { id: ReasoningEffortId('low'), name: 'Low' },
    { id: ReasoningEffortId('high'), name: 'High' },
  ],
  defaultEffort: ReasoningEffortId('high'),
} as const

async function fixture(options: { allow?: boolean; configured?: AgentOptions; rules?: NonNullable<SubagentConfig['modelRules']> } = {}) {
  const requests: SubagentStartRequest[] = []
  const parentOptions: AgentOptions = { ...parentRoute, reasoningEffort: ReasoningEffortId('high'), maxTokens: 512 }
  const ctx = await setup({
    provider: 'mock',
    withModelSelection: options.allow ?? false,
    parentAgentOptions: parentOptions,
    subagentConfig: { modelRules: options.rules ?? modelRules },
    ...options.configured === undefined ? {} : { agentOptions: options.configured },
  }, { onStart: (request) => { requests.push(request) } })
  contexts.push(ctx)
  ctx.llm.registerAdapter(['alpha'], new MockAdapter([], reasoning))
  const parent = options.allow
    ? modelSelectionSetupAgent(ctx)
    : Object.assign(fakeAgent(), { options: parentOptions })
  return { ctx, parent, requests, call: (args: unknown = task) => callSubagent(ctx, args, { agent: parent }) }
}

describe('native subagent tool with model rules', () => {
  it('uses a user-owned default without exposing or enabling model-facing selection', async () => {
    const f = await fixture()
    const schema = f.ctx.tools.schemas(f.parent).find(entry => entry.name === 'subagent')!
    expect(schema.parameters.properties).not.toHaveProperty('provider')
    expect(schema.parameters.properties).not.toHaveProperty('model')
    expect(f.ctx.tools.get('list_subagent_models', f.parent)).toBeUndefined()
    const guard = vi.fn((_exec: ToolExecution) => undefined)
    f.ctx.tools.guard(guard)
    const preflight = vi.spyOn(f.ctx.llm, 'resolveCallConfig')

    const result = await f.call()

    expect(result.isError).toBe(false)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]?.agentOptions).toMatchObject({ ...childRoute, maxTokens: 512 })
    expect(f.requests[0]?.agentOptions?.reasoningEffort).toBeUndefined()
    expect(preflight).toHaveBeenCalledTimes(1)
    expect(guard).toHaveBeenCalledTimes(1)
    expect(guard.mock.calls[0]?.[0]).toMatchObject({ name: 'subagent', arguments: task })
    expect(f.parent.options).toMatchObject(parentRoute)
  })

  it('still rejects an explicit route when native model selection is disabled', async () => {
    const f = await fixture()
    const result = await f.call({ ...task, provider: 'alpha', model: 'fast-model' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('child model selection is disabled')
    expect(f.requests).toHaveLength(0)
  })

  it('prefers a permitted explicit model over a matching rule', async () => {
    const f = await fixture({ allow: true })
    const preflight = vi.spyOn(f.ctx.llm, 'resolveCallConfig')
    const result = await f.call({ ...task, provider: 'alpha', model: 'fast-model' })
    expect(result.isError).toBe(false)
    expect(f.requests).toHaveLength(1)
    expect(f.requests[0]?.agentOptions).toMatchObject({ provider: 'alpha', model: 'fast-model' })
    expect(preflight).toHaveBeenCalledTimes(1)
  })

  it('does not turn a disallowed explicit choice into a permitted rule', async () => {
    const f = await fixture({ allow: true })
    const result = await f.call({ ...task, provider: 'alpha', model: 'not-authorized' })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('is not allowed for this Session')
    expect(f.requests).toHaveLength(0)
  })

  it.each([{ provider: 'alpha' }, { model: 'fast-model' }])('preserves malformed explicit-route rejection: %j', async (choice) => {
    const f = await fixture({ allow: true })
    const result = await f.call({ ...task, ...choice })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('must be supplied together')
    expect(f.requests).toHaveLength(0)
  })

  it('keeps an authorized effort-only request on its validated route', async () => {
    const f = await fixture({ allow: true })
    const result = await f.call({ ...task, reasoning_effort: 'low' })
    expect(result.isError).toBe(false)
    expect(f.requests[0]?.agentOptions).toEqual({ reasoningEffort: 'low' })
  })

  it('preserves a configured child route instead of remapping it', async () => {
    const configured = { provider: 'alpha', model: 'configured-model', maxTokens: 123 }
    const f = await fixture({ configured })
    const result = await f.call()
    expect(result.isError).toBe(false)
    expect(f.requests[0]?.agentOptions).toEqual(configured)
  })

  it('matches the direct parent request header rather than its activation model', async () => {
    const f = await fixture({ allow: true, rules: [{ parent: { provider: 'alpha', model: 'current-model' }, child: childRoute }] })
    f.parent.session.append('request/header', {
      header: { config: { provider: 'alpha', model: 'current-model' } },
      reason: 'initial',
    })
    const result = await f.call()
    expect(result.isError).toBe(false)
    expect(f.requests[0]?.agentOptions).toMatchObject(childRoute)
    expect(f.parent.options).toMatchObject(parentRoute)
    expect(f.parent.session.requestHeader()?.config.model).toBe('current-model')
  })

  it('leaves ordinary inheritance untouched without a matching rule', async () => {
    const f = await fixture({ rules: [] })
    const preflight = vi.spyOn(f.ctx.llm, 'resolveCallConfig')
    const result = await f.call()
    expect(result.isError).toBe(false)
    expect(f.requests[0]?.agentOptions).toBeUndefined()
    expect(preflight).not.toHaveBeenCalled()
  })

  it('does not substitute inheritance when a configured target is unavailable', async () => {
    const f = await fixture({ rules: [{ parent: parentRoute, child: { provider: 'unavailable-provider', model: 'fast-model' } }] })
    const result = await f.call()
    expect(result.isError).toBe(true)
    expect(f.requests).toHaveLength(0)
  })
})
