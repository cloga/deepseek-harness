/** Effect-owned command registration for the Web-backed Desktop profile. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session'
import { registerDesktopPluginCommandRuntime } from './desktop-plugin-command.ts'
import { DesktopPluginCommandIpc, type DesktopPluginCommandPort } from './desktop-plugin-command-ipc.ts'

/** Command bridge and its explicit pre-ready composition check. */
export interface DesktopPluginCommandInstallation {
  readonly bridge: DesktopPluginCommandIpc
  /** Wait for current registration work, then reject unless the actual command and Session services are mounted. */
  ready(): Promise<void>
}

/**
 * Install before profile loading; dependencies activate registration without changing runProfile ownership.
 * @param ctx - Profile preparation Context owning all registry, event and cancellation effects.
 * @param port - Exact parent IPC channel supplied by the process entry.
 * @returns Bridge plus the check that must succeed before reporting Host ready.
 */
export function installDesktopPluginCommands(ctx: Context, port: DesktopPluginCommandPort): DesktopPluginCommandInstallation {
  const bridge = new DesktopPluginCommandIpc(port)
  let registration: object | undefined
  ctx.effect(() => () => { registration = undefined; bridge.dispose() }, 'desktop command parent bridge')
  const installed = ctx.inject(['commands', 'sessions'], (scope) => {
    if (bridge.closed) throw new Error('desktop plugin command: parent bridge is closed')
    const commands = scope.get('commands')
    const sessions = scope.get('sessions')
    if (commands === undefined || sessions === undefined) throw new Error('desktop plugin command: required services unavailable')
    registerDesktopPluginCommandRuntime({
      commands,
      effect: (register) => { scope.effect(register) },
      onSessionEvent: (listener) => {
        scope.on('session/event', (session, event) => {
          if (event.type === 'command/done') listener({ type: event.type, data: event.data }, () => sessions.flush(session))
        })
      },
    }, bridge.request, (commandId, persisted) => { bridge.settled(commandId, persisted) })
    const current = {}
    registration = current
    scope.effect(() => () => {
      if (registration !== current) return
      registration = undefined
      bridge.cancelPending(new Error('desktop plugin command: command services unavailable'))
    }, 'desktop command service generation')
  })
  return {
    bridge,
    async ready() {
      await installed
      if (registration === undefined || bridge.closed) throw new Error('desktop plugin command: registry did not become ready')
    },
  }
}
