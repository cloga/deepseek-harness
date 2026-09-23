/** INTERNAL alpha2 Desktop entry. Shipped Electron still selects lib/index.js. Do not switch before
 * WS logical-OPEN/direct-RPC and pending /api/$events/result completion are owned, or before
 * physical ASAR package-root and installed-byte/receipt acceptance succeeds. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadLayeredEnv, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import { createAlpha2ParentStop } from './alpha2-parent-stop.ts'
import { assertAlpha2ProfileOwnership } from './alpha2-profile-ownership.ts'
import { Alpha2TransportAdmission } from './alpha2-admission.ts'
import { assertAlpha2Injections } from './alpha2-injections.ts'
import { alpha2OwnerCompositionGuard } from './alpha2-owner-composition.ts'
import { installDesktopPluginCommands, type DesktopPluginCommandInstallation } from './desktop-plugin-command-runtime.ts'
import { readDesktopPackageHealth } from './package-health.ts'
import { provideDesktopPackageTransactions } from './package-transactions.ts'
import { installDesktopUpdateTaskControl } from './update-tasks.ts'

type Booted = Awaited<ReturnType<typeof runProfile>>
const OWNER_PATCH = fileURLToPath(new URL('../config/alpha2-desktop.cordis.patch.yml', import.meta.url))

/** The URL containing a launch token must travel only through the owning parent IPC channel. */
function sendToParent(message: object): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) {
      reject(new Error('desktop alpha2: private parent IPC is unavailable'))
      return
    }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
}

/**
 * Start a side-by-side profile with an actual shell v1 staging owner, never the old framed Host.
 * No published entry or Electron path selects this until native receipts and private transport are qualified.
 */
export async function runAlpha2DesktopHost(): Promise<void> {
  // Refuse before resolving profile paths, environment, or packages if no owning shell is present.
  if (!process.connected || process.send === undefined) throw new Error('desktop alpha2: private shell IPC is required')
  const runtimeDir = process.argv[2]
  const projectDir = process.argv[3]
  if (runtimeDir === undefined || projectDir === undefined) throw new Error('desktop alpha2: runtime and project paths are required')

  const control: {
    updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl>
    commands?: DesktopPluginCommandInstallation
  } = {}
  let application: ReturnType<typeof runProfile> | undefined
  let stopping: Promise<void> | undefined
  const admission = new Alpha2TransportAdmission()
  let detached = false
  const detach = (): void => {
    if (detached) return
    detached = true
    process.off('message', receive)
    process.off('disconnect', onDisconnect)
  }
  const stopOwner = createAlpha2ParentStop({
    closeBridge: () => { control.commands?.bridge.dispose() },
    application: () => application,
    acknowledge: () => sendToParent({ type: 'shutdown-complete' }),
    connected: () => process.connected,
    disconnect: () => { process.disconnect() },
    detach,
  })
  const stop = (): Promise<void> => stopping ??= stopOwner()
  const onDisconnect = (): void => { void stop().catch(() => {}) }
  const receive = (message: unknown): void => {
    try { if (control.commands?.bridge.receive(message) === true) return }
    catch { void stop().catch(() => {}); return }
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'shutdown') { void stop().catch(() => {}); return }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !('action' in message)) return
    const requestId = message.requestId
    if (typeof requestId !== 'number' || !Number.isSafeInteger(requestId) || requestId < 1
      || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined
          || (message.action === 'unlock' && !admission.mayUnlock('generationId' in message ? message.generationId : undefined))) {
          throw new Error('unavailable')
        }
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await sendToParent({ type: 'update-tasks', requestId, active })
      } catch {
        await sendToParent({ type: 'update-tasks', requestId, active: true,
          error: 'desktop alpha2: task control is unavailable' }).catch(() => {})
      }
    })().catch(() => {})
  }
  process.on('message', receive)
  process.once('disconnect', onDisconnect)
  try {
    const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
    const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
    assertAlpha2ProfileOwnership(runtimeDir, projectDir, profile.layers)
    if (stopping !== undefined) { await stopping; return }
    application = runProfile({
      environment: loadLayeredEnv('dsh'),
      profile: 'desktop',
      resolutionMode: 'runtime',
      resolvedProfile: { profile, installAnchor },
      stagedPackageTransactions: true,
      // This owner overlay outranks the profile and home layers: their Web rows
      // cannot turn URL logging or an all-interface bind back on before boot.
      // No anonymous pnpm fallback or module-reload watcher is supplied.
      patchFiles: [OWNER_PATCH],
      validateComposition: alpha2OwnerCompositionGuard,
      args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
      prepare: async (ctx) => {
        // Prepare runs before ANY profile row. The shell must answer hello before
        // the v1 capability is published; a missing owner refuses the whole boot.
        control.updateTasks = installDesktopUpdateTaskControl(ctx, true)
        control.commands = installDesktopPluginCommands(ctx, {
          connected: () => process.connected && process.send !== undefined,
          send: sendToParent,
        })
        if (stopping !== undefined) control.commands.bridge.dispose()
        await provideDesktopPackageTransactions(ctx)
      },
    })
    const { ctx } = await application
    ctx.effect(() => () => { detach() }, 'desktop alpha2: parent IPC lifetime')
    if (stopping !== undefined) { await stopping; return }
    // Neither an installed package nor a profile name establishes an active Manager.
    if (ctx.get('pluginManager') === undefined) throw new Error('desktop alpha2: Manager is not active')
    if (ctx.get('commands') === undefined || ctx.get('sessions') === undefined || control.commands === undefined) {
      throw new Error('desktop alpha2: command services are unavailable')
    }
    await control.commands.ready()
    const server = ctx.get('webServer')
    const connection = ctx.get('connection')
    if (server === undefined || connection === undefined || server.host !== '127.0.0.1'
      || !Number.isSafeInteger(server.port) || server.port < 1 || server.port > 65535) {
      throw new Error('desktop alpha2: private loopback Web carrier is unavailable')
    }
    const packages = await readDesktopPackageHealth(ctx)
    if (packages === undefined) throw new Error('desktop alpha2: package inventory is unavailable')
    const injections = server.collectIndexInjections()
    assertAlpha2Injections(injections)
    if (stopping !== undefined) { await stopping; return }
    // This is TRANSPORT preparation, never proof that required Core packages,
    // optional Copilot acquisition, native receipts, or source hashes passed.
    // Only Electron may evaluate those facts and later admit the client. Never
    // log/persist the token URL: BrowserAuth redirects it to a clean root/cookie.
    const url = connection.authenticatedUrl(`http://127.0.0.1:${String(server.port)}`)
    // A stale or premature unlock is rejected until the parent's send callback
    // acknowledges this exact generation. Native Core/receipt checks still belong
    // to Electron, not to this transport-level admission indicator.
    await admission.publish(() => sendToParent({
      type: 'alpha2-transport-ready', generationId: admission.generationId,
      url, injections, packages,
    }))
  } catch (error) {
    detach()
    if (stopping !== undefined) { await stopping.catch(() => {}); return }
    try {
      const running: Booted | undefined = await application?.catch(() => undefined)
      await running?.shutdown.shutdown(1)
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'desktop alpha2: startup and cleanup failed')
    }
    throw error
  }
}

if (import.meta.main) {
  runAlpha2DesktopHost().catch(async () => {
    // Never print a profile's plugin spec, argv, launch URL or raw exception.
    if (process.connected) await sendToParent({ type: 'fatal', message: 'desktop alpha2: Host startup refused' }).catch(() => {})
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
