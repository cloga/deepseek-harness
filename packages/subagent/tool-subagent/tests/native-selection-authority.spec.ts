import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { callSubagent, modelSelectionSetupAgent, setup, text } from './harness.ts'
import * as tool from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose() })

async function nativeFixture() {
  const ctx = await setup({ provider: 'mock', withModelSelection: true,
    parentAgentOptions: { provider: 'alpha', model: 'parent-model' } })
  contexts.push(ctx)
  const provider = ctx.subagents.getProvider('mock')
  if (provider === undefined) throw new Error('missing scripted provider')
  // The scripted transport records native registry inputs without starting another model turn.
  Object.assign(provider, { nativeModelSelection: 'spawn' as const })
  const captureDelegation = vi.fn(() => undefined)
  const resolveDelegation = vi.fn(() => { throw new Error('unexpected Auto classification') })
  ctx.provide('modelRouting', { captureDelegation, resolveDelegation })
  return { ctx, captureDelegation, resolveDelegation, parent: modelSelectionSetupAgent(ctx) }
}

describe('native tool selection authority', () => {
  it('rejects an explicit disallowed request before native Auto can capture or classify', async () => {
    const h = await nativeFixture()
    const result = await callSubagent(h.ctx, {
      description: 'denied explicit route', prompt: 'task', provider: 'forbidden', model: 'outside-policy',
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('is not allowed for this Session')
    expect(h.captureDelegation).not.toHaveBeenCalled()
    expect(h.resolveDelegation).not.toHaveBeenCalled()
  })

  it('passes a deny-only opt-out for a fixed-route tool even when another tool captured Session consent', async () => {
    const h = await nativeFixture()
    await h.parent.ctx.plugin(tool, {
      provider: 'mock', toolName: 'fixed-native', enableRunInBackground: false, modelSelectionSettings: false,
    })
    const result = await h.ctx.tools.execute({
      name: 'fixed-native', callId: ToolCallId('fixed-native-call'), agent: h.parent,
      signal: new AbortController().signal,
      arguments: { description: 'fixed child', prompt: 'task' },
    })
    expect(result.isError).not.toBe(true)
    // Passive preference capture is not authorization to classify this denied invocation.
    expect(h.captureDelegation).toHaveBeenCalledExactlyOnceWith(h.parent)
    expect(h.resolveDelegation).not.toHaveBeenCalled()
  })
})
