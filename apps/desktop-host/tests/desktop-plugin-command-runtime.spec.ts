import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import Commands from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { installDesktopPluginCommands } from '../src/desktop-plugin-command-runtime.ts'
import type { DesktopPluginCommandMessage } from '../src/desktop-plugin-command-ipc.ts'

function port() {
  const messages: DesktopPluginCommandMessage[] = []
  return {
    connected: () => true,
    send: vi.fn(async (message: DesktopPluginCommandMessage) => { messages.push(message) }),
    messages,
  }
}

describe('effect-owned Desktop command installation', () => {
  it('waits for real services and never advertises a registry before they exist', async () => {
    const ctx = new Context()
    const channel = port()
    const installed = installDesktopPluginCommands(ctx, channel)
    try {
      await expect(installed.ready()).rejects.toThrow('registry did not become ready')
      await ctx.plugin(SessionStore)
      await ctx.plugin(Commands)
      await installed.ready()
      const session = ctx.sessions.create(SessionId('command-bootstrap'))
      const agent = { id: session.id, session } as Agent
      expect(ctx.commands.list(agent).filter(command => command.name === 'desktop-plugin')).toHaveLength(1)
      await installed.ready()
      expect(ctx.commands.list(agent).filter(command => command.name === 'desktop-plugin')).toHaveLength(1)
      const execution = ctx.commands.execute(agent, '/desktop-plugin list', [], new AbortController().signal)
      await vi.waitFor(() => { expect(channel.messages).toHaveLength(1) })
      installed.bridge.receive({ type: 'plugin-command-response', requestId: 1, result: { kind: 'list', plugins: [] } })
      await expect(execution).resolves.toMatchObject({ result: { kind: 'success', text: 'No Desktop plugins installed.' } })
    } finally { await ctx.fiber.dispose() }
    expect(installed.bridge.closed).toBe(true)
    await expect(installed.ready()).rejects.toThrow()
  })

  it.each(['persisted', 'storage-failure', 'no-storage', 'disposed-before-flush'] as const)(
    'sends settlement only after the actual command/done flush: %s', async (mode) => {
      const ctx = new Context()
      const channel = port()
      const installed = installDesktopPluginCommands(ctx, channel)
      const checkpoint = Promise.withResolvers<undefined>()
      let disposed = false
      try {
        await ctx.plugin(SessionStore)
        await ctx.plugin(Commands)
        await installed.ready()
        const session = ctx.sessions.create(SessionId('command-flush'))
        const agent = { id: session.id, session } as Agent
        if (mode !== 'no-storage') ctx.on('session/flush', async (subject) => {
          expect(subject).toBe(session)
          expect(subject.snapshotEvents().filter(event => event.type === 'command/run' || event.type === 'command/done')
            .map(event => event.type)).toEqual(['command/run', 'command/done'])
          await checkpoint.promise
        })
        const execution = ctx.commands.execute(agent, '/desktop-plugin disable example-plugin', [], new AbortController().signal)
        await vi.waitFor(() => { expect(channel.messages).toHaveLength(1) })
        const request = channel.messages[0]!
        expect(request.type).toBe('plugin-command-request')
        installed.bridge.receive({ type: 'plugin-command-response', requestId: request.requestId, result: { kind: 'prepared' } })
        const completed = await execution
        expect(completed?.result.kind).toBe('success')
        if (mode !== 'no-storage') expect(channel.messages).toHaveLength(1)
        if (mode === 'disposed-before-flush') {
          await ctx.fiber.dispose()
          disposed = true
          checkpoint.resolve(undefined)
        } else if (mode === 'storage-failure') checkpoint.reject(new Error('private storage error'))
        else checkpoint.resolve(undefined)
        await vi.waitFor(() => { expect(channel.messages).toHaveLength(2) })
        expect(channel.messages[1]).toEqual(mode === 'persisted'
          ? { type: 'plugin-command-settled', requestId: request.requestId, commandId: completed?.commandId }
          : { type: 'plugin-command-cancel', requestId: request.requestId })
        expect(session.snapshotEvents().filter(event => event.type === 'command/done')).toHaveLength(1)
      } finally {
        checkpoint.resolve(undefined)
        if (!disposed) await ctx.fiber.dispose()
      }
    },
  )

  it('reactivates once after command-service replacement without reusing correlation identities', async () => {
    const ctx = new Context()
    const channel = port()
    const installed = installDesktopPluginCommands(ctx, channel)
    try {
      await ctx.plugin(SessionStore)
      const firstCommands = await ctx.plugin(Commands)
      await installed.ready()
      const session = ctx.sessions.create(SessionId('command-service-replacement'))
      const agent = { id: session.id, session } as Agent
      const firstRegistry = ctx.commands
      const first = firstRegistry.execute(agent, '/desktop-plugin list', [], new AbortController().signal)
      await vi.waitFor(() => { expect(channel.messages).toHaveLength(1) })
      await firstCommands.dispose()
      await expect(first).resolves.toMatchObject({ result: { kind: 'error' } })
      await expect(installed.ready()).rejects.toThrow('registry did not become ready')
      expect(firstRegistry.list(agent).some(command => command.name === 'desktop-plugin')).toBe(false)
      await ctx.plugin(Commands)
      await installed.ready()
      expect(ctx.commands.list(agent).filter(command => command.name === 'desktop-plugin')).toHaveLength(1)
      const next = ctx.commands.execute(agent, '/desktop-plugin list', [], new AbortController().signal)
      await vi.waitFor(() => { expect(channel.messages).toHaveLength(3) })
      expect(channel.messages[2]).toMatchObject({ type: 'plugin-command-request', requestId: 2 })
      installed.bridge.receive({ type: 'plugin-command-response', requestId: 1, result: { kind: 'prepared' } })
      installed.bridge.receive({ type: 'plugin-command-response', requestId: 2, result: { kind: 'list', plugins: [] } })
      await expect(next).resolves.toMatchObject({ result: { kind: 'success' } })
      expect(channel.messages.filter(message => message.type === 'plugin-command-settled')).toHaveLength(0)
    } finally { await ctx.fiber.dispose() }
  })

  it('disposes the command registry and pending request effects with its installation owner', async () => {
    const root = new Context()
    const channel = port()
    try {
      await root.plugin(SessionStore)
      await root.plugin(Commands)
      let installation: ReturnType<typeof installDesktopPluginCommands> | undefined
      const child = await root.plugin((ctx: Context) => { installation = installDesktopPluginCommands(ctx, channel) })
      expect(installation).toBeDefined()
      await installation!.ready()
      const session = root.sessions.create(SessionId('command-child-owner'))
      const agent = { id: session.id, session } as Agent
      const execution = root.commands.execute(agent, '/desktop-plugin list', [], new AbortController().signal)
      await vi.waitFor(() => { expect(channel.messages).toHaveLength(1) })
      await child.dispose()
      await expect(execution).resolves.toMatchObject({ result: { kind: 'error', text: 'Desktop plugin request failed.' } })
      expect(root.commands.list(agent).some(command => command.name === 'desktop-plugin')).toBe(false)
      expect(installation!.bridge.closed).toBe(true)
      installation!.bridge.receive({ type: 'plugin-command-response', requestId: 1, result: { kind: 'prepared' } })
      expect(channel.messages.filter(message => message.type === 'plugin-command-settled')).toHaveLength(0)
    } finally { await root.fiber.dispose() }
  })
})
