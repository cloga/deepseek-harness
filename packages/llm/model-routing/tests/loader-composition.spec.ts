import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry, { installModelSelection } from '@deepseek-ai/dsh-agent'
import type { ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import LlmRuntime, { createUserMessage, LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as routing from '../src/index.ts'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  try {
    await context?.fiber.dispose()
  } finally {
    context = undefined
    if (root !== undefined) await rm(root, { recursive: true, force: true })
    root = undefined
  }
})

class FixtureAdapter extends LlmAdapter {
  readonly calls: GenerateOptions[] = []

  override async resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return {
      provider, id: model, name: model, inputModalities: ['text'],
      reasoning: {
        efforts: [{ id: ReasoningEffortId('low'), name: 'Low' }, { id: ReasoningEffortId('high'), name: 'High' }],
      },
    }
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.calls.push(options)
    const input = options.messages.flatMap(message => message.content)
      .filter(block => block.type === 'text').map(block => block.text).join('\n')
    const complex = input.includes('complex task')
    const text = options.purpose === 'model-routing'
      ? JSON.stringify({
        continuity: 'new-task', complexity: complex ? 'complex' : 'routine', confidence: 1, reasonCode: 'new-task',
      })
      : `Completed with ${options.model}/${options.reasoningEffort}`
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function loadFixture(): Promise<Context> {
  root = await mkdtemp(join(tmpdir(), 'dsh-auto-loader-'))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, await readFile(new URL('./fixtures/cordis.yml', import.meta.url), 'utf8'))
  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-llm', LlmRuntime],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-session-projection', SessionProjectionRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['@deepseek-ai/dsh-model-routing', routing],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected fixture import ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await context.loader.await()
  return context
}

describe('Auto through real Loader composition and AgentLoop', () => {
  it('keeps prompt, actual route, effort and durable decision aligned across task and manual boundaries', async () => {
    const ctx = await loadFixture()
    expect([...ctx.loader.entries()].filter(entry => entry.fiber === undefined && !entry.disabled)).toEqual([])
    const adapter = new FixtureAdapter()
    ctx.llm.registerAdapter(['fixture'], adapter)
    ctx.systemPrompt.section({ name: 'fixture-model', order: 0, text: 'Selected {{provider}}/{{model}}.' })
    const events: SessionEvent[] = []
    const errors: unknown[] = []
    ctx.on('session/event', (_session, event) => { events.push(event) })
    ctx.on('agent/error', ({ error }) => { errors.push(error) })
    const selection: ModelSelectionRef = {
      current: { provider: 'fixture', model: 'strong', reasoningEffort: ReasoningEffortId('high') },
      assembled: undefined,
    }
    const handle = await ctx.agents.create({
      sessionId: SessionId('auto-real-loader'),
      agentOptions: { provider: 'fixture', model: 'strong' },
      setup(agentCtx) { installModelSelection(agentCtx, selection) },
    })
    const agent = handle.agent
    await ctx.modelRouting.enable(agent, 'balanced')
    const send = async (text: string, human = true) => {
      agent.followup(createUserMessage({
        content: [{ type: 'text', text }],
        source: human ? { kind: 'user' } : { kind: 'plugin', plugin: 'fixture-continuation' },
      }))
      await agent.whenIdle()
      expect(errors).toEqual([])
    }

    await send('routine task')
    expect(agent.session.requestHeader()?.config).toMatchObject({ model: 'light', reasoningEffort: 'low' })
    expect(events.filter(event => event.type === 'model/routing-decision')).toHaveLength(1)
    await send('Continue implementation', false)
    expect(adapter.calls.filter(call => call.purpose === 'model-routing')).toHaveLength(1)
    await send('complex task')
    expect(agent.session.requestHeader()?.config).toMatchObject({ model: 'strong', reasoningEffort: 'high' })
    expect(events.filter(event => event.type === 'model/routing-decision')).toHaveLength(2)

    selection.current = { provider: 'fixture', model: 'light', reasoningEffort: ReasoningEffortId('low') }
    agent.session.append('model/selection', selection.current)
    await send('complex task, explicitly pinned')
    expect(adapter.calls.filter(call => call.purpose === 'model-routing')).toHaveLength(2)
    expect(ctx.sessionProjections.stateOf(agent.session, 'modelRouting')?.intent.kind).toBe('manual')
    const conversations = adapter.calls.filter(call => call.purpose === undefined)
    expect(conversations.map(call => [call.model, call.reasoningEffort])).toEqual([
      ['light', 'low'], ['light', 'low'], ['strong', 'high'], ['light', 'low'],
    ])
    for (const call of conversations) {
      const systems = call.messages.filter(message => message.role === 'system').flatMap(message => message.content)
      const systemText = systems.filter(block => block.type === 'text').map(block => block.text).join('\n')
      expect(systemText).toContain(`Selected fixture/${call.model}.`)
      expect(systemText).not.toContain(`Selected fixture/${call.model === 'light' ? 'strong' : 'light'}.`)
    }
  })
})
