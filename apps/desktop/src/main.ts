/** Electron shell: desktop project ownership, custom protocol, windows, and lifecycle. */

import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { gt, valid } from 'semver'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from 'electron'
import { resolveDesktopPaths } from './paths.ts'
import { DesktopProjectManager, type DesktopProjectHooks } from './project-manager.ts'
import { DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, parseDesktopPluginSource } from './plugin-source.ts'
import {
  DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
  DESKTOP_PLUGIN_PROVISIONING_PLAN_FILE,
  readDesktopPluginProvisioningPlan,
} from './plugin-provisioning.ts'
import { DesktopHostProcess, type DesktopUpdateImpact } from './host-process.ts'
import { DesktopBackendController, type DesktopBackendState } from './backend-controller.ts'
import {
  DESKTOP_IPC,
  parseDesktopRendererUpdateImpact,
  type DesktopRendererUpdateImpact,
  type DesktopUpdateState,
} from './ipc.ts'
import { formatDesktopMessage, resolveDesktopLocale } from './locale.ts'
import { claimDesktopSingleInstance } from './single-instance.ts'
import { DesktopUpdateCoordinator } from './update-coordinator.ts'
import { DesktopManagedUpdateCoordinator } from './managed-update-coordinator.ts'
import { completeDesktopManagedUpdateHandoff, launchDesktopManagedUpdate } from './managed-update-launcher.ts'
import { loadDesktopManagedUpdateConfiguration } from './managed-update-state.ts'
import { completeDesktopManagedUpdate } from './managed-update-completion.ts'
import { MANAGED_UPDATE_RECOVERY_ARGUMENT } from './managed-update-recovery.ts'
import { desktopErrorState } from './startup-error.ts'
import { startupFailureDocument } from './startup-document.ts'
import { confirmDesktopPluginMutation } from './plugin-mutation-confirmation.ts'
import { requestDesktopRendererImpact } from './renderer-impact.ts'
import { installDesktopWindowNavigation } from './window-navigation.ts'

const SCHEME = 'dsh-app'
class DesktopOperationBusy extends Error {}
let focusPrimaryWindow = (): void => {}
let managedRecoveryRequested = process.argv.includes(MANAGED_UPDATE_RECOVERY_ARGUMENT)
let requestManagedRecovery = (): void => { managedRecoveryRequested = true }
type RecoveryAction = 'restart' | 'plugins' | 'reset'
let profileRecoveryAvailable = (): boolean => false
const emergencyPages = new WeakMap<BrowserWindow, { url: string; message: string; busy: boolean }>()
let recoverApplication = (action: RecoveryAction): Promise<void> => {
  if (action !== 'restart') return Promise.reject(new Error('Desktop recovery could not initialize; reinstall the application'))
  app.relaunch()
  app.quit()
  return Promise.resolve()
}

async function showEmergencyDocument(window: BrowserWindow, message: string): Promise<void> {
  const document = startupFailureDocument(resolveDesktopLocale(app.getLocale()), message, profileRecoveryAvailable())
  const url = `data:text/html;charset=utf-8,${encodeURIComponent(document)}`
  emergencyPages.set(window, { url, message, busy: false })
  await window.loadURL(url)
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: false,
    stream: true,
    codeCache: true,
  },
}])

const MIME: Readonly<Record<string, string>> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
}

interface RuntimeResources {
  readonly node: string
  readonly hostExecutable: string
  readonly pnpm: string
  readonly dsh: string
  readonly profileResolution?: 'runtime'
  readonly provisioning?: string
}

function runtimeResources(): RuntimeResources {
  const development = !app.isPackaged
  const node = (development ? process.env.DSH_DESKTOP_NODE_BINARY : undefined)
    ?? join(process.resourcesPath, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
  const hostExecutable = development ? node : process.execPath
  const pnpm = (development ? process.env.DSH_DESKTOP_PNPM_ENTRY : undefined)
    ?? join(process.resourcesPath, 'runtime', 'pnpm', 'bin', 'pnpm.mjs')
  const dsh = (development ? process.env.DSH_DESKTOP_DSH_DIR : undefined)
    ?? (development ? join(process.resourcesPath, 'dsh') : join(app.getAppPath(), 'dsh'))
  const provisioning = development
    ? undefined
    : join(process.resourcesPath, 'desktop-provisioning', DESKTOP_PLUGIN_PROVISIONING_PLAN_FILE)
  return {
    node,
    hostExecutable,
    pnpm,
    dsh,
    ...(development ? {} : { profileResolution: 'runtime' as const }),
    ...(provisioning !== undefined && existsSync(provisioning) ? { provisioning } : {}),
  }
}

function developmentHostInspectPort(enabled: boolean): number | undefined {
  const configured = process.env.DSH_DESKTOP_HOST_INSPECT_PORT
  if (!enabled || configured === undefined || configured === '') return undefined
  const port = Number(configured)
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('dsh desktop: DSH_DESKTOP_HOST_INSPECT_PORT must be an integer from 1 through 65535')
  }
  return port
}

function createWindow(preload: string, show = false): BrowserWindow {
  const window = new BrowserWindow({
    icon: join(app.getAppPath(), 'assets', 'whale.png'),
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    show,
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  installDesktopWindowNavigation(window.webContents, {
    openExternal: url => shell.openExternal(url),
    openFailed: () => {
      if (window.isDestroyed()) return
      const messages = resolveDesktopLocale(app.getLocale()).messages
      dialog.showErrorBox(messages.externalLinkFailedTitle, messages.externalLinkFailedAdvice)
    },
    recover: (action) => {
      const page = emergencyPages.get(window)
      if (page === undefined || page.busy || window.webContents.getURL() !== page.url) return
      if (!['restart', 'plugins', 'reset'].includes(action.hostname)) return
      if (action.hostname !== 'restart' && !profileRecoveryAvailable()) return
      page.busy = true
      void recoverApplication(action.hostname as RecoveryAction).catch(async (error: unknown) => {
        if (!(error instanceof DesktopOperationBusy) && !window.isDestroyed()) await showEmergencyDocument(window, `${page.message}\n${desktopErrorState(error).message}`)
      }).catch((error: unknown) => { console.error(error) }).finally(() => { page.busy = false })
    },
  })
  return window
}

function assertDesktopSender(event: IpcMainEvent | IpcMainInvokeEvent, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('dsh desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('dsh desktop: rejected IPC from an unowned renderer')
  }
}

async function serveShellAsset(request: Request): Promise<Response> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return new Response(null, { status: 405 })
  const root = resolve(app.getAppPath(), 'renderer')
  const url = new URL(request.url)
  let pathname: string
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return new Response(null, { status: 400 })
  }
  const target = resolve(normalize(join(root, pathname)))
  if (target !== root && !target.startsWith(root + sep)) return new Response(null, { status: 403 })
  try {
    const body = request.method === 'HEAD' ? null : await readFile(target)
    return new Response(body, { headers: { 'content-type': MIME[extname(target)] ?? 'application/octet-stream' } })
  } catch {
    return new Response(null, { status: 404 })
  }
}

async function main(): Promise<void> {
  const resources = runtimeResources()
  const paths = resolveDesktopPaths()
  const development = app.isPackaged ? undefined : join(app.getAppPath(), '.desktop-build', 'development', 'project')
  const activeProject = development ?? paths.profile
  const manager = new DesktopProjectManager(paths, resources)
  const provisioning = resources.provisioning === undefined
    ? undefined
    : readDesktopPluginProvisioningPlan(resources.provisioning)
  const managedUpdate = app.isPackaged
    ? await loadDesktopManagedUpdateConfiguration(process.resourcesPath, app.getPath('userData'), process.platform)
    : undefined
  let managedInstalledSequence = managedUpdate?.installedSequence ?? 0
  profileRecoveryAvailable = () => development === undefined && manager.canRecoverProfile()
  let pageError: Extract<DesktopBackendState, { phase: 'error' }> | undefined
  let quitting = false
  let startup: Promise<void> | undefined
  let mainWindow: BrowserWindow | undefined
  let pluginWindow: BrowserWindow | undefined
  let shellInstallerOwnsQuit = false
  const hasQuitStarted = (): boolean => quitting || shellInstallerOwnsQuit
  let updateState: DesktopUpdateState = { phase: 'idle' }
  let notificationState: DesktopUpdateState = updateState
  let updateCheck: Promise<DesktopUpdateState> | undefined
  let startupUpdateTimer: ReturnType<typeof setTimeout> | undefined
  let periodicUpdateTimer: ReturnType<typeof setInterval> | undefined
  const clearUpdateTimers = (): void => {
    clearTimeout(startupUpdateTimer)
    clearInterval(periodicUpdateTimer)
    startupUpdateTimer = undefined
    periodicUpdateTimer = undefined
  }
  let rendererUpdateImpact = { hasDraft: false, attachmentCount: 0, submitting: false }
  let updateConfirmation: Promise<DesktopUpdateState | undefined> | undefined
  let quitDrainComplete = false
  let pluginMutationBusy = false
  let mutationPending: ReturnType<DesktopProjectManager['mutate']> | undefined
  let mutationAbort: AbortController | undefined
  let recoveryPending: Promise<void> | undefined
  let resetConfirmationAbort: AbortController | undefined
  let rendererImpactGeneration = 0
  let managedCompletionChecked = false
  const locale = resolveDesktopLocale(app.getLocale())
  const messages = locale.messages
  const appPreload = fileURLToPath(new URL('./preload-app.cjs', import.meta.url))
  const managementPreload = fileURLToPath(new URL('./preload.cjs', import.meta.url))
  const startupUrl = `${SCHEME}://shell/startup.html`
  const applicationUrl = `${SCHEME}://app/index.html`
  let navigation: { window: BrowserWindow; url: string; promise: Promise<void> } | undefined
  let emergencyDocument = false

  const showEmergencyError = async (error: unknown): Promise<void> => {
    if (quitting || emergencyDocument) return
    emergencyDocument = true
    const diagnostic = desktopErrorState(error).message
    pageError = { phase: 'error', message: diagnostic }
    if (mainWindow !== undefined) await showEmergencyDocument(mainWindow, diagnostic)
  }

  const navigateMain = (url: string): Promise<void> => {
    const window = mainWindow
    if (quitting || emergencyDocument || window === undefined || window.isDestroyed()) return Promise.resolve()
    if (navigation?.window === window && navigation.url === url) return navigation.promise
    const next = { window, url, promise: Promise.resolve() }
    next.promise = window.loadURL(url).catch((error: unknown) => {
      if (quitting || window.isDestroyed() || navigation !== next) return
      navigation = undefined
      throw error
    })
    navigation = next
    return next.promise
  }
  const backendState = (): DesktopBackendState => {
    const state = pageError ?? backend.state
    return state.phase === 'error' ? { ...state, profileRecovery: profileRecoveryAvailable() } : state
  }
  const publishBackend = (state: DesktopBackendState): void => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.backendState, state)
    }
  }
  const backend = new DesktopBackendController((onFailure) => {
    if (development === undefined) manager.assertProfileRuntime(activeProject)
    const hostInspectPort = developmentHostInspectPort(development !== undefined)
    const host = new DesktopHostProcess(resources.hostExecutable, development ?? resources.dsh, activeProject,
      hostInspectPort, process.env, onFailure)
    return {
      start: () => host.start(),
      stop: () => host.stop(),
      fetch: (request: Request) => host.fetch(request),
      get pid() { return host.pid },
      updateImpact: (signal?: AbortSignal) => host.updateImpact(signal),
    }
  }, (state) => {
    if (state.phase === 'starting' && !emergencyDocument) pageError = undefined
    publishBackend(backendState())
    if (state.phase === 'error') void navigateMain(startupUrl).catch((error: unknown) => { console.error(error) })
  })

  const publishUpdate = (state: DesktopUpdateState): DesktopUpdateState => {
    if (quitting) return state
    updateState = state
    // A failed refresh must not erase a release the application already advertised.
    const failedInstallation = notificationState.phase === 'installing' || notificationState.phase === 'error'
    if (failedInstallation && notificationState.version !== undefined && state.phase === 'error') {
      notificationState = { ...state, version: state.version ?? notificationState.version }
    } else if (notificationState.phase === 'error' && notificationState.version !== undefined && state.phase === 'checking') {
      // Keep the failed release actionable while a later check is pending.
    } else if (notificationState.phase !== 'available'
      || !['checking', 'error', 'available'].includes(state.phase)) {
      notificationState = state
    } else if (state.phase === 'available'
      && state.version !== undefined && notificationState.version !== undefined
      && valid(state.version) !== null && valid(notificationState.version) !== null
      && gt(state.version, notificationState.version)) {
      notificationState = state
    }
    for (const window of BrowserWindow.getAllWindows()) {
      const applicationDocument = window.webContents.getURL().startsWith(`${SCHEME}://app/`)
      window.webContents.send(DESKTOP_IPC.updatesState, applicationDocument ? notificationState : state)
    }
    return state
  }

  const hooks: DesktopProjectHooks = {
    beforeChange: () => backend.stop(),
    healthCheck: async (projectDir) => {
      manager.assertProfileRuntime(projectDir)
      const host = new DesktopHostProcess(resources.hostExecutable, resources.dsh, projectDir)
      try {
        await host.start()
      } finally {
        await host.stop()
      }
    },
    afterChange: () => backend.start(async () => {}),
  }
  const assertRecoveryAvailable = (): void => {
    if (pluginMutationBusy || recoveryPending !== undefined || updateConfirmation !== undefined || hasQuitStarted()
      || updateState.phase === 'installing' || updateState.phase === 'ready') throw new DesktopOperationBusy(messages.pluginMutationBusy)
  }
  const runRecovery = async (operation: () => Promise<void>): Promise<void> => {
    assertRecoveryAvailable()
    const pending = Promise.resolve().then(operation)
    recoveryPending = pending
    try { await pending } finally { if (recoveryPending === pending) recoveryPending = undefined }
  }
  recoverApplication = (action): Promise<void> => runRecovery(async () => {
    await startup?.catch(() => undefined)
    if (action === 'reset') {
      if (!profileRecoveryAvailable()) throw new Error(messages.startupReinstallAdvice)
      const window = mainWindow
      if (window === undefined || window.isDestroyed() || hasQuitStarted()) return
      const cancellation = new AbortController()
      resetConfirmationAbort = cancellation
      const onClosed = (): void => { cancellation.abort() }
      window.once('closed', onClosed)
      try {
        const result = await dialog.showMessageBox(window, {
          type: 'warning',
          title: messages.resetConfiguration,
          message: messages.resetConfigurationPrompt,
          detail: `${messages.startupConfigurationAdvice}\n\n${messages.resetConfigurationWarning}`,
          buttons: [messages.confirmConfigurationReset, messages.cancel],
          defaultId: 1,
          cancelId: 1,
          noLink: true,
          signal: cancellation.signal,
        })
        if (result.response !== 0 || cancellation.signal.aborted || hasQuitStarted() || window.isDestroyed()) {
          if (!hasQuitStarted() && !window.isDestroyed()) publishBackend(backendState())
          return
        }
      } finally {
        window.removeListener('closed', onClosed)
        if (resetConfirmationAbort === cancellation) resetConfirmationAbort = undefined
      }
    }
    await backend.stop()
    if (action === 'restart') {
      app.relaunch()
      app.quit()
      return
    }
    if (!profileRecoveryAvailable()) throw new Error(messages.startupReinstallAdvice)
    if (action === 'reset') await manager.resetConfiguration(hooks)
    else await manager.mutate({ type: 'plugins-disable-all' }, hooks)
    emergencyDocument = false
    pageError = undefined
    navigation = undefined
    await navigateMain(applicationUrl)
  })

  const showStartupError = async (error: unknown): Promise<void> => {
    if (quitting) return
    pageError = desktopErrorState(error)
    try { await navigateMain(startupUrl) }
    catch (navigationError) {
      await showEmergencyError(new AggregateError([error, navigationError], messages.startupFailed))
    }
    publishBackend(backendState())
  }
  const checkManagedCompletion = async (manualRecovery = false): Promise<void> => {
    if (managedUpdate === undefined || managedCompletionChecked) return
    if (resources.provisioning === undefined) {
      throw new Error('desktop managed update: packaged plugin provisioning plan is missing')
    }
    const completion = await completeDesktopManagedUpdate(
      managedUpdate.operationsRoot,
      managedUpdate.completionPath,
      managedUpdate.capability,
      managedUpdate.completedSequence,
      process.execPath,
      join(resources.dsh, 'desktop-runtime.json'),
      resources.provisioning,
      manager.paths.profile,
      undefined,
      manualRecovery ? {
        version: app.getVersion(),
        capabilityPath: join(process.resourcesPath, 'managed-update', 'capability.json'),
      } : undefined,
    )
    if (completion.status === 'recovery-required') {
      throw new Error(`${completion.message}\n\nRecovery: ${completion.command}`)
    }
    if (completion.status === 'complete') {
      managedInstalledSequence = Math.max(managedInstalledSequence, completion.sequence)
    }
    managedCompletionChecked = true
  }
  const reconcileBackend = (): Promise<void> => {
    startup ??= (async () => {
      pageError = undefined
      await navigateMain(startupUrl)
      if (development === undefined) {
        await manager.applyRelease(hooks, provisioning)
      }
      if (quitting) return
      await backend.start(async () => {})
      if (development === undefined) await checkManagedCompletion()
      if (backend.host !== undefined) await navigateMain(applicationUrl)
    })().catch(async (error: unknown) => {
      await showStartupError(error)
      throw error
    }).finally(() => { startup = undefined })
    return startup
  }

  const updates = managedUpdate === undefined
    ? new DesktopUpdateCoordinator(
      publishUpdate,
      async () => {
        shellInstallerOwnsQuit = true
        await backend.stop()
      },
    )
    : new DesktopManagedUpdateCoordinator(
      managedUpdate.capability,
      () => managedInstalledSequence,
      publishUpdate,
      async (selection) => {
        const host = backend.host
        const hostPid = host?.pid
        if (host === undefined || hostPid === undefined) {
          throw new Error('desktop managed update: Desktop Host is not running')
        }
        await completeDesktopManagedUpdateHandoff(
          () => launchDesktopManagedUpdate({
            operationsRoot: managedUpdate.operationsRoot,
            nodeExecutable: resources.node,
            helperBundle: managedUpdate.helperBundle,
            capability: managedUpdate.capability,
            selection: {
              kind: selection.kind,
              manifestUrl: selection.manifestUrl,
              manifestSha256: selection.manifestSha256,
              assetSha256: selection.assetSha256,
            },
            installedSequence: managedInstalledSequence,
            waitPids: [process.pid, hostPid],
          }),
          () => {
            shellInstallerOwnsQuit = true
            return () => { shellInstallerOwnsQuit = false }
          },
          () => backend.stop(),
          () => { app.quit() },
        )
      },
      undefined,
      messages,
    )

  const checkUpdates = (): Promise<DesktopUpdateState> => {
    if (hasQuitStarted() || updateState.phase === 'installing' || updateState.phase === 'ready') {
      return Promise.resolve(updateState)
    }
    updateCheck ??= Promise.resolve().then(() => (
      hasQuitStarted() ? updateState : updates.check()
    )).catch((error: unknown) => publishUpdate({
      phase: 'error',
      message: error instanceof Error ? error.message : String(error),
    })).finally(() => { updateCheck = undefined })
    return updateCheck
  }
  const automaticallyCheckUpdates = (): void => {
    if (updateConfirmation !== undefined) return
    void checkUpdates().catch((error: unknown) => { console.error('desktop automatic update check failed', error) })
  }

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'shell') return serveShellAsset(request).then((response) => {
      if (response.status >= 400 && ['/startup.html', '/startup.js', '/startup.css'].includes(url.pathname)) {
        void showEmergencyError(new Error(`Desktop recovery resource could not be loaded: ${url.pathname} (HTTP ${response.status})`))
          .catch((error: unknown) => { console.error(error) })
      }
      return response
    })
    if (url.hostname !== 'app') return Promise.resolve(new Response(null, { status: 404 }))
    const active = backend.host
    if (active === undefined) return Promise.resolve(new Response('backend unavailable', { status: 503 }))
    return active.fetch(request)
  })

  const mutate = async (
    event: IpcMainInvokeEvent,
    mutation: Parameters<DesktopProjectManager['mutate']>[0],
  ): ReturnType<DesktopProjectManager['mutate']> => {
    assertDesktopSender(event, ['shell'])
    if (development !== undefined) {
      throw new Error('dsh desktop: plugin package changes require a packaged application')
    }
    if (pluginMutationBusy || recoveryPending !== undefined || updateConfirmation !== undefined || hasQuitStarted()
      || updateState.phase === 'installing' || updateState.phase === 'ready') throw new Error(messages.pluginMutationBusy)
    pluginMutationBusy = true
    const cancellation = new AbortController()
    mutationAbort = cancellation
    let interrupted = false
    const hasStartedInterruption = (): boolean => interrupted
    const pending = (async () => {
      try {
        await startup?.catch(() => undefined)
        const receipt = await manager.mutate(mutation, {
          ...hooks,
          beforeChange: async () => {
            // This hook runs under the transaction lock after staging; rollback must not ask again.
            if (!hasStartedInterruption()) {
              await confirmDesktopPluginMutation({
                messages, signal: cancellation.signal, cancelled: hasQuitStarted,
                readImpact: async (signal) => {
                  const active = backend.host
                  const window = mainWindow
                  const generation = rendererImpactGeneration
                  if (active === undefined && backend.state.phase !== 'error') throw new Error('Host impact unavailable')
                  const host = active === undefined
                    ? { runningSessions: 0, queuedMessages: 0, runningJobs: 0 } : await active.updateImpact(signal)
                  const url = window?.webContents.getURL()
                  const isEmergencyPage = window !== undefined && url === emergencyPages.get(window)?.url
                  const renderer = url === startupUrl || isEmergencyPage
                    ? { hasDraft: false, attachmentCount: 0, submitting: false }
                    : window === undefined ? undefined : await requestDesktopRendererImpact(window.webContents, ipcMain, signal)
                  if (renderer === undefined) throw new Error('Application impact unavailable')
                  if (active !== backend.host || window !== mainWindow || generation !== rendererImpactGeneration) {
                    throw new Error('Desktop changed during impact read')
                  }
                  return { host, renderer, hostIdentity: active, rendererIdentity: generation }
                },
                confirm: async (detail) => {
                  const window = mainWindow
                  if (window === undefined || window.isDestroyed()) throw new Error(messages.pluginImpactUnavailable)
                  return (await dialog.showMessageBox(window, {
                    type: 'warning', title: messages.pluginMutationTitle, message: messages.pluginMutationPrompt,
                    detail, buttons: [messages.applyPluginChange, messages.cancel], defaultId: 1, cancelId: 1,
                    signal: cancellation.signal,
                  })).response === 0
                },
              })
              interrupted = true
            }
            await hooks.beforeChange()
          },
          healthCheck: async (projectDir) => {
            // Navigation failure stays inside the transaction's active-Host restoration path.
            pageError = undefined
            await navigateMain(startupUrl)
            await hooks.healthCheck(projectDir)
          },
        })
        await navigateMain(applicationUrl)
        return receipt
      } catch (error) {
        if (hasStartedInterruption()) await showStartupError(error)
        throw error
      }
    })()
    mutationPending = pending
    try { return await pending } finally {
      pluginMutationBusy = false
      if (mutationPending === pending) { mutationPending = undefined; mutationAbort = undefined }
    }
  }
  ipcMain.handle(DESKTOP_IPC.localeGet, (event) => {
    assertDesktopSender(event, ['shell'])
    return locale
  })
  ipcMain.handle(DESKTOP_IPC.pluginsList, (event) => {
    assertDesktopSender(event, ['shell'])
    if (development !== undefined) return []
    return manager.listPlugins()
  })
  ipcMain.handle(DESKTOP_IPC.pluginsAdd, (event, spec: unknown) => {
    if (typeof spec !== 'string') throw new Error('dsh desktop: plugin spec must be a string')
    return mutate(event, { type: 'plugin-add', spec })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsInstall, (event, source: unknown) => {
    assertDesktopSender(event, ['shell'])
    return mutate(event, { type: 'plugin-install', source: parseDesktopPluginSource(source) })
  })
  ipcMain.handle(DESKTOP_IPC.capabilitiesGet, (event) => {
    assertDesktopSender(event, ['shell'])
    return [DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY] as const
  })
  ipcMain.handle(DESKTOP_IPC.pluginsRemove, (event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('dsh desktop: plugin name must be a string')
    return mutate(event, { type: 'plugin-remove', name })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsUpdate, (event, name: unknown, version: unknown) => {
    if (typeof name !== 'string' || typeof version !== 'string') {
      throw new Error('dsh desktop: plugin name and version must be strings')
    }
    return mutate(event, { type: 'plugin-update', name, version })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsToggle, (event, name: unknown, enabled: unknown) => {
    if (typeof name !== 'string' || typeof enabled !== 'boolean') throw new Error('dsh desktop: invalid plugin activation request')
    return mutate(event, { type: 'plugin-toggle', name, enabled })
  })
  ipcMain.handle(DESKTOP_IPC.pluginsDisableAll, event => mutate(event, { type: 'plugins-disable-all' }))
  ipcMain.handle(DESKTOP_IPC.backendStatus, (event) => {
    assertDesktopSender(event, ['shell'])
    return backendState()
  })
  ipcMain.handle(DESKTOP_IPC.backendRetry, async (event) => {
    assertDesktopSender(event, ['shell'])
    await runRecovery(async () => {
      await reconcileBackend()
      focusPrimaryWindow()
    })
  })
  ipcMain.handle(DESKTOP_IPC.applicationRestart, async (event) => {
    assertDesktopSender(event, ['shell'])
    assertRecoveryAvailable()
    try {
      await recoverApplication('restart')
    } catch (error) {
      await showStartupError(error)
    }
  })
  ipcMain.handle(DESKTOP_IPC.configurationReset, async (event) => {
    assertDesktopSender(event, ['shell'])
    if (development !== undefined) throw new Error('Desktop configuration reset requires a packaged application')
    const failure = backendState()
    if (failure.phase !== 'error') {
      throw new Error('Desktop profile reset requires a startup failure')
    }
    assertRecoveryAvailable()
    try {
      await recoverApplication('reset')
    } catch (error) {
      await showStartupError(error)
    }
  })
  ipcMain.handle(DESKTOP_IPC.updatesStatus, (event) => {
    assertDesktopSender(event, ['app', 'shell'])
    return notificationState
  })
  ipcMain.handle(DESKTOP_IPC.updatesCheck, async (event) => {
    assertDesktopSender(event, ['shell'])
    return updateConfirmation === undefined ? checkUpdates() : updateState
  })
  ipcMain.handle(DESKTOP_IPC.updatesInstall, async (event) => {
    assertDesktopSender(event, ['app', 'shell'])
    const result = await confirmAndInstallUpdate()
    if (result?.phase === 'error') throw new Error(result.message ?? messages.unknownError)
  })
  ipcMain.on(DESKTOP_IPC.updatesImpactReport, (event, value: unknown) => {
    try {
      assertDesktopSender(event, ['app'])
      rendererUpdateImpact = parseDesktopRendererUpdateImpact(value)
    } catch (error) {
      console.error('desktop update impact report rejected', error)
    }
  })

  const confirmAndInstallUpdate = (): Promise<DesktopUpdateState | undefined> => {
    if (pluginMutationBusy || recoveryPending !== undefined) return Promise.reject(new Error(messages.pluginMutationBusy))
    if (updateConfirmation !== undefined) return updateConfirmation
    updateConfirmation = (async () => {
      await updateCheck
      if (hasQuitStarted()) return undefined
      const state = updateState.phase === 'available' ? updateState : await checkUpdates()
      if (hasQuitStarted() || state.phase !== 'available') return state
      if (state.mode !== 'github-release-managed') {
        const result = await dialog.showMessageBox({
          type: 'info',
          title: messages.updateTitle,
          message: messages.updateAvailable,
          detail: formatDesktopMessage(messages.updateDetail, { version: state.version ?? '' }),
          buttons: [messages.installAndRestart, messages.later],
          defaultId: 0,
          cancelId: 1,
        })
        if (result.response !== 0 || hasQuitStarted()) return undefined
        return updates.install()
      }
      const readImpact = async (): Promise<{
        host: DesktopUpdateImpact
        renderer: DesktopRendererUpdateImpact
      }> => ({
        host: await backend.host?.updateImpact() ?? {
          runningSessions: 0,
          queuedMessages: 0,
          runningJobs: 0,
        },
        renderer: rendererUpdateImpact,
      })
      const sameImpact = (
        left: { host: DesktopUpdateImpact; renderer: DesktopRendererUpdateImpact },
        right: { host: DesktopUpdateImpact; renderer: DesktopRendererUpdateImpact },
      ): boolean => left.host.runningSessions === right.host.runningSessions
        && left.host.queuedMessages === right.host.queuedMessages
        && left.host.runningJobs === right.host.runningJobs
        && left.renderer.hasDraft === right.renderer.hasDraft
        && left.renderer.attachmentCount === right.renderer.attachmentCount
        && left.renderer.submitting === right.renderer.submitting
      let impact = await readImpact()
      for (;;) {
        if (hasQuitStarted()) return undefined
        const detail = formatDesktopMessage(messages.managedUpdateDetail, {
          version: state.version ?? '',
          runningSessions: String(impact.host.runningSessions),
          queuedMessages: String(impact.host.queuedMessages),
          runningJobs: String(impact.host.runningJobs),
          draft: impact.renderer.hasDraft ? messages.yes : messages.no,
          attachments: String(impact.renderer.attachmentCount),
          submitting: impact.renderer.submitting ? messages.yes : messages.no,
        })
        const result = await dialog.showMessageBox({
          type: 'info',
          title: messages.updateTitle,
          message: messages.updateAvailable,
          detail,
          buttons: [messages.installInteractive, messages.later],
          defaultId: 0,
          cancelId: 1,
        })
        if (result.response !== 0 || hasQuitStarted()) return undefined
        const currentImpact = await readImpact()
        if (hasQuitStarted()) return undefined
        if (sameImpact(impact, currentImpact)) return updates.install()
        impact = currentImpact
      }
    })().finally(() => { updateConfirmation = undefined })
    return updateConfirmation
  }

  const checkAndPrompt = async (): Promise<void> => {
    if (hasQuitStarted() || pluginMutationBusy || recoveryPending !== undefined || updateConfirmation !== undefined
      || updateState.phase === 'installing' || updateState.phase === 'ready') return
    const state = await checkUpdates()
    if (hasQuitStarted()) return
    if (state.phase === 'error') {
      await dialog.showMessageBox({
        type: 'error',
        title: messages.updateCheckFailedTitle,
        message: state.message ?? messages.unknownError,
      })
      return
    }
    if (state.phase !== 'available') {
      await dialog.showMessageBox({
        type: 'info',
        title: messages.updateCheckTitle,
        message: state.message ?? messages.updateCurrent,
      })
      return
    }
    const installed = await confirmAndInstallUpdate()
    if (installed === undefined || hasQuitStarted()) return
    if (installed.phase === 'error') {
      await dialog.showMessageBox({
        type: 'error',
        title: messages.updateFailedTitle,
        message: installed.message ?? messages.unknownError,
      })
    }
  }

  const recoverManagedUpdate = async (): Promise<void> => {
    if (managedUpdate === undefined) return
    await startup?.catch(() => undefined)
    try {
      await runRecovery(async () => {
        // Completion needs the existing ready Host's inventory; never restart it for a recheck.
        if (backend.state.phase !== 'ready') throw new Error(messages.startupReinstallAdvice)
        await checkManagedCompletion(true)
        pageError = undefined
        emergencyDocument = false
        await navigateMain(applicationUrl)
      })
    } catch (error) {
      if (error instanceof DesktopOperationBusy) return
      await showStartupError(error)
      const result = await dialog.showMessageBox({
        type: 'warning', title: messages.updateFailedTitle,
        message: desktopErrorState(error).message,
        buttons: [messages.checkUpdatesMenu, messages.later], defaultId: 1, cancelId: 1,
      })
      // The normal update path reads active-work impact and obtains consent before stopping Host.
      if (result.response === 0) await checkAndPrompt()
    }
  }
  requestManagedRecovery = () => {
    void recoverManagedUpdate().catch((error: unknown) => { console.error('desktop managed recovery failed', error) })
  }

  const openPluginWindow = (): void => {
    if (pluginWindow !== undefined && !pluginWindow.isDestroyed()) {
      pluginWindow.focus()
      return
    }
    pluginWindow = createWindow(managementPreload)
    pluginWindow.setSize(900, 620)
    pluginWindow.setTitle(messages.pluginWindowTitle)
    pluginWindow.once('ready-to-show', () => { pluginWindow?.show() })
    pluginWindow.once('closed', () => { pluginWindow = undefined })
    void pluginWindow.loadURL(`${SCHEME}://shell/plugin-manager.html`)
  }

  const desktopVersion = app.getVersion()
  app.setAboutPanelOptions({
    applicationName: messages.aboutDesktopTitle,
    applicationVersion: desktopVersion,
  })
  Menu.setApplicationMenu(Menu.buildFromTemplate([{
    label: process.platform === 'darwin' ? app.name : messages.application,
    submenu: [
      {
        label: formatDesktopMessage(messages.aboutDesktopMenu, { version: desktopVersion }),
        click: () => { app.showAboutPanel() },
      },
      { type: 'separator' },
      {
        label: development === undefined ? messages.pluginsMenu : messages.pluginsMenuPackagedOnly,
        accelerator: 'CmdOrCtrl+,',
        enabled: development === undefined,
        click: openPluginWindow,
      },
      {
        label: messages.checkUpdatesMenu,
        click: () => { void checkAndPrompt().catch((error: unknown) => { console.error('desktop update review failed', error) }) },
      },
      { type: 'separator' },
      { role: 'quit' },
    ],
  }]))

  const createMainWindow = (): BrowserWindow => {
    const window = createWindow(appPreload, true)
    mainWindow = window
    rendererImpactGeneration++
    window.on('closed', () => {
      if (mainWindow === window) { mainWindow = undefined; rendererImpactGeneration++ }
    })
    window.webContents.on('did-start-loading', () => { rendererImpactGeneration++ })
    window.webContents.on('preload-error', (_event, _path, error) => {
      void showEmergencyError(error).catch((failure: unknown) => { console.error(failure) })
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      rendererImpactGeneration++
      rendererUpdateImpact = { hasDraft: false, attachmentCount: 0, submitting: false }
      navigation = undefined
      emergencyDocument = false
      void showStartupError(new Error(`Desktop renderer exited: ${details.reason}`))
        .catch((failure: unknown) => { console.error(failure) })
    })
    return window
  }
  focusPrimaryWindow = () => {
    const window = mainWindow
    if (window === undefined || window.isDestroyed()) {
      createMainWindow()
      void navigateMain(backendState().phase === 'ready' ? applicationUrl : startupUrl)
        .catch((error: unknown) => { console.error(error) })
      return
    }
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) focusPrimaryWindow()
  })
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })
  app.on('before-quit', (event) => {
    clearUpdateTimers()
    if (shellInstallerOwnsQuit) {
      quitting = true
      return
    }
    if (quitDrainComplete) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    mutationAbort?.abort()
    resetConfirmationAbort?.abort()
    const drain = mutationPending !== undefined || recoveryPending !== undefined
      ? Promise.allSettled([mutationPending, recoveryPending]).then(() => backend.close())
      : backend.close()
    void Promise.allSettled([drain, startup]).then((results) => {
      for (const result of results) {
        if (result.status === 'rejected') console.error(result.reason)
      }
    }).finally(() => { quitDrainComplete = true; app.quit() })
  })

  mainWindow = createMainWindow()
  await reconcileBackend().catch(() => undefined)
  // Window lifecycle callbacks run while backend startup is pending.
  const startupWasCancelled = (): boolean => quitting
  if (startupWasCancelled()) return
  if (managedRecoveryRequested) {
    managedRecoveryRequested = false
    requestManagedRecovery()
  }
  const startupWindow = (): BrowserWindow | undefined => mainWindow
  const window = startupWindow()
  if (window !== undefined && development !== undefined && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== '0') {
    window.webContents.openDevTools({ mode: 'detach' })
  }
  publishUpdate(updateState)
  startupUpdateTimer = setTimeout(() => {
    startupUpdateTimer = undefined
    periodicUpdateTimer = setInterval(automaticallyCheckUpdates, 6 * 60 * 60 * 1000)
    automaticallyCheckUpdates()
  }, 10_000)
}

const ownsDesktopInstance = claimDesktopSingleInstance(app, () => { focusPrimaryWindow() })
if (ownsDesktopInstance) app.on('second-instance', (_event, argv) => {
  if (argv.includes(MANAGED_UPDATE_RECOVERY_ARGUMENT)) requestManagedRecovery()
})

if (ownsDesktopInstance) void app.whenReady().then(main).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error)
  const diagnosticFile = process.env.DSH_DESKTOP_DIAGNOSTIC_FILE
  if (diagnosticFile !== undefined) {
    await writeFile(diagnosticFile, `${error instanceof Error ? error.stack ?? message : message}\n`).catch(() => undefined)
  }
  const window = BrowserWindow.getAllWindows()[0] ?? createWindow(fileURLToPath(new URL('./preload-app.cjs', import.meta.url)), true)
  window.once('closed', () => { app.quit() })
  await showEmergencyDocument(window, message)
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
