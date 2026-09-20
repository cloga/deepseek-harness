import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { describe, expect, it, vi } from 'vitest'
import { registerDesktopPluginCommandRuntime } from '../src/desktop-plugin-command.ts'

describe('Desktop plugin command Session lifecycle', () => {
  it.each(['persisted', 'storage-failure', 'no-storage'] as const)(
    'acknowledges the real command registry only after the %s checkpoint', async (mode) => {
      const ctx = new Context()
      let resolveCheckpoint!: () => void
      let rejectCheckpoint!: (error: Error) => void
      const checkpoint = new Promise<void>((resolve, reject) => {
        resolveCheckpoint = resolve
        rejectCheckpoint = reject
      })
      try {
        await ctx.plugin(SessionStore)
        await ctx.plugin(CommandRuntime)
        const session = ctx.sessions.create(SessionId('desktop-plugin-lifecycle'))
        const agent = { id: session.id, session } as Agent
        const persistedEvents: string[] = []
        if (mode !== 'no-storage') {
          ctx.on('session/flush', async (subject) => {
            expect(subject).toBe(session)
            await checkpoint
            persistedEvents.push(...subject.snapshotEvents()
              .filter(event => event.type === 'command/run' || event.type === 'command/done')
              .map(event => event.type))
          })
        }
        const settled = vi.fn()
        const request = vi.fn(async () => ({ type: 'prepared' as const }))
        registerDesktopPluginCommandRuntime({
          commands: ctx.commands,
          effect: (register) => { ctx.effect(register) },
          onSessionEvent: (listener) => {
            ctx.on('session/event', (subject, event) => {
              if (event.type === 'command/done') {
                listener({ type: event.type, data: event.data }, () => ctx.sessions.flush(subject))
              }
            })
          },
        }, request, settled)
        expect(ctx.commands.list(agent).some(command => command.name === 'desktop-plugin')).toBe(true)
        const execution = await ctx.commands.execute(agent, '/desktop-plugin disable example-plugin', [], new AbortController().signal)
        expect(execution?.result.kind).toBe('success')
        expect(request).toHaveBeenCalledOnce()
        const events = session.snapshotEvents().filter(event => event.type === 'command/run' || event.type === 'command/done')
        expect(events.map(event => event.type)).toEqual(['command/run', 'command/done'])
        expect(events.map(event => event.data.commandId)).toEqual([execution?.commandId, execution?.commandId])
        if (mode === 'persisted') {
          expect(settled).not.toHaveBeenCalled()
          resolveCheckpoint()
          await vi.waitFor(() => { expect(settled).toHaveBeenCalledWith(execution?.commandId, true) })
          expect(persistedEvents).toEqual(['command/run', 'command/done'])
        } else {
          if (mode === 'storage-failure') rejectCheckpoint(new Error('storage unavailable'))
          await vi.waitFor(() => { expect(settled).toHaveBeenCalledWith(execution?.commandId, false) })
          expect(settled).not.toHaveBeenCalledWith(execution?.commandId, true)
        }
      } finally {
        resolveCheckpoint()
        await ctx.fiber.dispose()
      }
    },
  )
})
