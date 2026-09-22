/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { delimiter, join } from 'node:path'
import { loadLayeredEnv, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import * as desktopOffice from './office.ts'

import { installDesktopUpdateTaskControl } from './update-tasks.ts'
import { provideDesktopPackageTransactions } from './package-transactions.ts'
import { readDesktopPackageHealth } from './package-health.ts'
import { installDesktopPluginCommands, type DesktopPluginCommandInstallation } from './desktop-plugin-command-runtime.ts'

async function main(): Promise<void> {
  const runtimeDir = process.argv[2] as string
  const projectDir = process.argv[3] as string
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  const control: {
    updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl>
    commands?: DesktopPluginCommandInstallation
  } = {}
  let stopping: Promise<void> | undefined
  const isStopping = (): boolean => stopping !== undefined
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolutionMode: process.argv[5] === 'runtime' ? 'runtime' : 'link',
    resolvedProfile: { profile, installAnchor },
    stagedPackageTransactions: process.env.DSH_DESKTOP_STAGED_PACKAGES === '1',
    prepare: async (ctx) => {
      control.updateTasks = installDesktopUpdateTaskControl(ctx, process.env.DSH_DESKTOP_ADMISSION_LOCKED === '1')
      control.commands = installDesktopPluginCommands(ctx, {
        connected: () => process.connected === true && process.send !== undefined,
        send,
      })
      if (isStopping()) control.commands.bridge.dispose()
      if (process.env.DSH_DESKTOP_STAGED_PACKAGES === '1') await provideDesktopPackageTransactions(ctx)
    },
    patchFiles: [],
    args: ['--no-open', '--port', '19387'],
    ...(process.argv[6] === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', process.argv[6]],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${process.argv[7] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  const stop = (): Promise<void> => stopping ??= (async () => {
    control.commands?.bridge.dispose()
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
  })()
  process.on('message', (message: unknown) => {
    if (control.commands?.bridge.receive(message) === true) return
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await send({ type: 'update-tasks', requestId: message.requestId, active })
      } catch (error) {
        await send({ type: 'update-tasks', requestId: message.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  if (isStopping()) { await stopping; return }
  if (control.commands === undefined) throw new Error('desktop plugin command: runtime preparation was not installed')
  await control.commands.ready()
  await ctx.plugin(desktopOffice, {
    source: process.argv[4] ?? join(runtimeDir, '..', 'runtime', 'primary-runtime'),
    root: join(resolveDshHome(), 'dsh-runtimes', 'dsh-primary-runtime'),
  })
  if (isStopping()) { await stopping; return }
  const url = ctx.connection.authenticatedUrl(`http://127.0.0.1:${String(ctx.webServer.port)}`)
  const packages = await readDesktopPackageHealth(ctx)
  if (isStopping()) { await stopping; return }
  if (process.connected) process.send?.({ type: 'ready', url, injections: ctx.webServer.collectIndexInjections(),
    ...(packages === undefined ? {} : { packages }) }, (error) => { if (error !== null) console.error(error) })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    if (process.connected) process.send?.({ type: 'fatal', message }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
