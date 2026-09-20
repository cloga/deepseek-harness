import { WINDOWS_TITLEBAR_HEIGHT } from './windows-layout.ts'
/** Electron shell: desktop project ownership, custom protocol, windows, and lifecycle. */

import { readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  powerMonitor,
  nativeTheme,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from 'electron'
import { resolveDesktopPaths } from './paths.ts'
import { DesktopProjectManager } from './project-manager.ts'
import { DesktopHostProcess, DesktopHostUncleanExitError } from './host-process.ts'
import { installDesktopDirectoryPicker } from './directory-picker.ts'
import { DesktopBackendController } from './backend-controller.ts'
import { DESKTOP_IPC, SCHEME, assertDesktopSender, type DesktopBaselineNotice, type DesktopUpdateState } from './ipc.ts'
import { formatDesktopMessage, resolveDesktopLocale } from './locale.ts'
import { claimDesktopSingleInstance } from './single-instance.ts'
import { DesktopUpdateCoordinator } from './update-coordinator.ts'
import { serveWebDocument, authenticateWebHost, forwardWebRequest } from './web-document.ts'
import { DesktopFatalRecovery } from './fatal-recovery.ts'
import { DesktopUpdateJournal } from './update-journal.ts'
import { DesktopUpdatePreparationError } from './update-error.ts'
import { DesktopUpdateInputGuard } from './update-input-guard.ts'
import { createDesktopPackageBackend, loadDesktopPackagePolicy } from './profile-package-runtime.ts'
import { createDesktopProfilePackageActivation, pendingDesktopActivationTransactions } from './profile-package-activation.ts'
import { commitDesktopPackageReceipt } from './profile-package-receipt.ts'
import { mayAuthorizeDesktopStartupPackage } from './profile-package-startup-consent.ts'
import { desktopRegistryConfirmationDetail } from './profile-package-confirmation.ts'
import type { DesktopProvisioningAssessment } from './profile-package-staging.ts'
import type { DesktopPluginProvisioningState } from './plugin-provisioning.ts'
import { assertDesktopPackageHealth, qualifyDesktopPackageProfile } from './profile-package-qualification.ts'
import type { ProfilePackageHealth } from '@deepseek-ai/dsh-app-boot'
import { DesktopManagedUpdateCoordinator } from './managed-update-coordinator.ts'
import { loadDesktopManagedUpdateConfiguration } from './managed-update-state.ts'
import { isDesktopManagedUpdateHelperQuiescent, launchDesktopManagedUpdate, type DesktopManagedUpdateAcknowledgement } from './managed-update-launcher.ts'
import { resolveDesktopManagedNode } from './managed-update-node.ts'
import { completeDesktopManagedUpdate, type DesktopManagedUpdateCompletion } from './managed-update-completion.ts'
import { MANAGED_UPDATE_RECOVERY_ARGUMENT, managedUpdateRecoveryCommand } from './managed-update-recovery.ts'
import { DesktopUpdateSchedule, resolveDesktopUpdateScheduleConfig } from './update-schedule.ts'
import { desktopUpdateErrorSummary, presentDesktopUpdate } from './update-presentation.ts'
import { desktopErrorState } from './startup-error.ts'
import { DesktopMandatoryUpdatePolicy, resolveDesktopPolicyConfig, type DesktopPolicyState } from './mandatory-update-policy.ts'
import { DesktopMandatoryUpdateWindow } from './mandatory-update-window.ts'
import { DesktopPolicyTestAuth } from './policy-test-auth.ts'
import { DesktopUpdateDialog, type UpdateDialogOptions } from './update-dialog.ts'
import { readDesktopRuntime } from './runtime-tree.ts'

let focusPrimaryWindow = (): void => {}
let managedRecoveryRequested = process.argv.includes(MANAGED_UPDATE_RECOVERY_ARGUMENT)
let requestManagedRecovery = (): void => { managedRecoveryRequested = true }
let stopForRecovery = async (): Promise<void> => {}
let cancelPendingConsentForRecovery = (): void => {}
let shuttingDown = false
let windowsLanguage: string | undefined

function currentDesktopLocale(): ReturnType<typeof resolveDesktopLocale> {
  return resolveDesktopLocale(windowsLanguage ?? app.getLocale())
}
const recovery = new DesktopFatalRecovery({
  messages: () => currentDesktopLocale().messages,
  show: options => dialog.showMessageBox(options),
  stop: () => { shuttingDown = true; return stopForRecovery() },
  disablePlugins: async () => {
    const manager = new DesktopProjectManager(resolveDesktopPaths(), runtimeResources())
    const backupPath = await manager.disableAllPlugins()
    console.info('Desktop profile recovery completed:', { profilePatchBackup: backupPath ?? null, homePatch: 'unchanged' })
  },
  exit: () => { app.quit() },
  restart: () => { app.relaunch(); app.quit() },
})

function reportFatal(error: unknown): void {
  console.error(error)
  if (shuttingDown) return
  cancelPendingConsentForRecovery()
  void recovery.report(error).catch((failure: unknown) => { console.error(failure); app.exit(1) })
}

protocol.registerSchemesAsPrivileged([{
  scheme: SCHEME,
  privileges: {
    standard: true,
    secure: true,
    supportFetchAPI: true,
    corsEnabled: true,
    stream: true,
    codeCache: true,
  },
}])

interface RuntimeResources {
  readonly nodeBin: string
  readonly node: string
  readonly pnpm: string
  readonly dsh: string
}

function runtimeResources(): RuntimeResources {
  const development = !app.isPackaged
  const node = process.execPath
  const nodeBin = development ? join(app.getAppPath(), 'scripts', 'node-bin') : join(process.resourcesPath, 'runtime', 'bin')
  const pnpm = (development ? process.env.DSH_DESKTOP_PNPM_ENTRY : undefined)
    ?? (development ? join(app.getAppPath(), 'node_modules', 'pnpm', 'bin', 'pnpm.mjs')
      : join(process.resourcesPath, 'runtime', 'pnpm', 'bin', 'pnpm.mjs'))
  const dsh = (development ? process.env.DSH_DESKTOP_DSH_DIR : undefined)
    ?? (development ? join(app.getAppPath(), '.desktop-build', 'development', 'project') : join(app.getAppPath(), 'dsh'))
  return { node, nodeBin, pnpm, dsh }
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

function createWindow(preload: string, show = false, primary = false): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 880,
    minHeight: 600,
    show,
    ...(process.platform === 'win32' && primary ? {
      titleBarStyle: 'hidden' as const,
      titleBarOverlay: { height: WINDOWS_TITLEBAR_HEIGHT, color: nativeTheme.shouldUseDarkColors ? '#1b1b1c' : '#f9fafb',
        symbolColor: nativeTheme.shouldUseDarkColors ? '#f9fafb' : '#0f1115' },
    } : {}),
    // hiddenInset places traffic lights inside the sidebar; sidebar vibrancy
    // needs a transparent window background to show through the page.
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 16, y: 18 },
      vibrancy: 'sidebar' as const,
      // 'active' keeps the vibrancy material stable when the window blurs;
      // 'followWindow' washes the sidebar out behind an unfocused window.
      visualEffectState: 'active' as const,
      backgroundColor: '#00000000',
    } : {}),
    webPreferences: {
      preload,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
    },
  })
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (['http:', 'https:'].includes(new URL(url).protocol)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('context-menu', (_event, { isEditable, selectionText, editFlags }) => {
    const items: MenuItemConstructorOptions[] = []
    if (isEditable) {
      items.push(
        { role: 'undo', enabled: editFlags.canUndo },
        { role: 'redo', enabled: editFlags.canRedo },
        { type: 'separator' },
        { role: 'cut', enabled: editFlags.canCut },
        { role: 'copy', enabled: editFlags.canCopy },
        { role: 'paste', enabled: editFlags.canPaste },
        { type: 'separator' },
        { role: 'selectAll', enabled: editFlags.canSelectAll },
      )
    } else if (selectionText.length > 0) {
      items.push({ role: 'copy', enabled: editFlags.canCopy })
    }
    // Empty accelerators suppress Electron's default shortcut labels for native roles.
    if (items.length > 0) {
      const messages = currentDesktopLocale().messages
      Menu.buildFromTemplate(items.map(item => ({
        ...item,
        ...(process.platform === 'win32' && item.role !== undefined && item.role in messages
          ? { label: messages[item.role as keyof typeof messages] } : {}),
        accelerator: '',
      }))).popup({ window })
    }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const destination = new URL(url)
    const current = new URL(window.webContents.getURL())
    if (destination.protocol !== `${SCHEME}:`
      && !(destination.protocol === 'http:' && destination.origin === current.origin)) {
      event.preventDefault()
      if (['http:', 'https:'].includes(destination.protocol)) void shell.openExternal(url)
    }
  })
  return window
}

async function main(): Promise<void> {
  const journalDirectory = process.env.DSH_DESKTOP_UPDATE_JOURNAL_DIR
  const updateJournal = journalDirectory === undefined ? undefined : new DesktopUpdateJournal(journalDirectory, app.getVersion())
  const resources = runtimeResources()
  const paths = resolveDesktopPaths()
  const development = !app.isPackaged
  const activeProject = paths.profile
  const managedUpdate = development ? undefined
    : await loadDesktopManagedUpdateConfiguration(process.resourcesPath, app.getPath('userData'), process.platform)
  const packagePolicy = managedUpdate === undefined ? undefined : loadDesktopPackagePolicy(process.resourcesPath, managedUpdate.capability)
  const manager = new DesktopProjectManager(paths, resources)
  let managedCompletedSequence = managedUpdate?.completedSequence ?? 0
  let quitting = false
  let quitDrainComplete = false
  let lifecycleDrain: Promise<void> | undefined
  let managedHandoffOperation: Promise<boolean> | undefined
  let managedCompletionOperation: Promise<DesktopManagedUpdateCompletion | undefined> | undefined
  let managedRecoveryOperation: Promise<boolean> | undefined
  let managedRecoveryReady = false
  let managedCompletionIssue: Extract<DesktopManagedUpdateCompletion, { status: 'recovery-required' }> | undefined
  let managedCompletionBootGate: PromiseWithResolvers<undefined> | undefined
  // Only confirmed abandonment or installer-owned transfer clears possible detached-helper ownership.
  let managedHelperMayRun = false
  let startup: Promise<void> | undefined
  let workspaceRecovery: Promise<void> | undefined
  let mainWindow: BrowserWindow | undefined
  let shellInstallerOwnsQuit = false
  let requireCleanStop = false
  let updateStoppedHost = false
  let updateStopFailure: DesktopHostUncleanExitError | undefined
  let updateState: DesktopUpdateState = { phase: 'idle' }
  let baselineNotice: DesktopBaselineNotice | undefined
  let startupProvisioningAttempted = false
  const baselineAbort = new AbortController()
  const updatePresentation = (state: DesktopUpdateState) => ({ ...presentDesktopUpdate(state),
    ...(baselineNotice === undefined ? {} : { baseline: baselineNotice }) })
  const updateInput = new DesktopUpdateInputGuard()
  let inputDocumentGeneration = 0
  let inputDocumentReady = false
  const invalidateInputDocument = (): void => {
    inputDocumentGeneration++
    inputDocumentReady = false
    updateInput.reset()
  }
  let mandatoryPolicy: DesktopMandatoryUpdatePolicy | undefined
  let mandatoryUI: DesktopMandatoryUpdateWindow | undefined
  let policyAuth: DesktopPolicyTestAuth | undefined
  const isQuitting = (): boolean => quitting
  const lifecycleUnavailable = (): boolean => shuttingDown || quitting || recovery.active
  const currentMainWindow = (): BrowserWindow | undefined => mainWindow
  const ordinaryDialogs = new Set<AbortController>()
  const locale = resolveDesktopLocale(app.getLocale())
  const messages = locale.messages
  const updateDialog = new DesktopUpdateDialog(fileURLToPath(new URL('./preload-update-dialog.cjs', import.meta.url)), locale)
  const isMandatory = (): boolean => mandatoryPolicy?.state.blocking === true
  const ordinaryMessageBox = async (options: UpdateDialogOptions): Promise<Electron.MessageBoxReturnValue> => {
    const controller = new AbortController()
    ordinaryDialogs.add(controller)
    try {
      if (lifecycleUnavailable() || mainWindow === undefined) return { response: options.cancelId ?? 0, checkboxChecked: false }
      return await updateDialog.show(mainWindow, { ...options, signal: controller.signal })
    }
    finally { ordinaryDialogs.delete(controller) }
  }
  const appPreload = fileURLToPath(new URL('./preload-app.cjs', import.meta.url))
  const applicationUrl = `${SCHEME}://app/`
  let hostUrl: string | undefined
  let hostCookie: string | undefined
  let injections: readonly unknown[] = []
  const assertProductSender = (event: IpcMainInvokeEvent): void => {
    assertDesktopSender(event, ['app'])
    if (mainWindow === undefined || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents
      || event.senderFrame === null || event.senderFrame !== mainWindow.webContents.mainFrame) {
      throw new Error('dsh desktop: rejected IPC from an unowned renderer')
    }
  }
  let navigation: { window: BrowserWindow; url: string; promise: Promise<void> } | undefined
  const navigateMain = (url: string): Promise<void> => {
    const window = mainWindow
    if (lifecycleUnavailable() || window === undefined || window.isDestroyed()) return Promise.resolve()
    if (navigation?.window === window && navigation.url === url) return navigation.promise
    const next = { window, url, promise: Promise.resolve() }
    next.promise = window.loadURL(url).catch((error: unknown) => {
      if (quitting || shuttingDown || window.isDestroyed() || navigation !== next
        || (error instanceof Error && 'code' in error && error.code === 'ERR_ABORTED')) return
      navigation = undefined
      throw error
    })
    navigation = next
    return next.promise
  }
  let packageTransactions: ReturnType<typeof createDesktopPackageBackend> | undefined
  let packageAdmissionId: string | undefined
  let packageOperation: Promise<void> | undefined
  let everStartedHost = false
  const hasEverStartedHost = (): boolean => everStartedHost
  const backend = new DesktopBackendController((onFailure) => {
    if (packagePolicy !== undefined) {
      packageTransactions ??= createDesktopPackageBackend(activeProject, resources, packagePolicy, undefined, manager.createdProfile)
    }
    const hostInspectPort = developmentHostInspectPort(development)
    let packageHealth: readonly ProfilePackageHealth[] | undefined
    everStartedHost = true
    const host = new DesktopHostProcess(resources.node, resources.dsh, activeProject,
      hostInspectPort, process.env, onFailure,
      development ? join(app.getAppPath(), '.desktop-build', 'targets', `${process.platform === 'darwin' ? 'mac' : 'win'}-${process.arch}`, 'runtime', 'primary-runtime')
        : join(process.resourcesPath, 'runtime', 'primary-runtime'),
      development ? 'link' : 'runtime', resources, packageTransactions, packageAdmissionId !== undefined)
    return {
      start: async () => {
        const ready = await host.start()
        hostCookie = await authenticateWebHost(ready.url)
        hostUrl = ready.url
        if (ready.injections === undefined) throw new Error('Desktop Host did not provide boot injections')
        injections = ready.injections
        packageHealth = ready.packages
      },
      stop: async () => {
        try { await host.stop(requireCleanStop) }
        catch (error) {
          if (!requireCleanStop || !(error instanceof DesktopHostUncleanExitError)) throw error
          // Backend cleanup succeeded; installation still rejects the unsuccessful task teardown.
          updateStopFailure = error
        }
      },
      updateTasks: (action: 'inspect' | 'lock' | 'unlock') => host.updateTasks(action),
      get processId() { return host.pid },
      get packageHealth() { return packageHealth },
    }
  }, (state) => {
    if (state.phase === 'error' && packageAdmissionId === undefined) reportFatal(new Error(state.message))
  })

  let managedCompletionAdmission: {
    id: string
    host: NonNullable<typeof backend.host>
    window: BrowserWindow
    documentGeneration: number
  } | undefined
  const completionOwnsAdmission = (): boolean => managedCompletionOperation !== undefined || managedRecoveryOperation !== undefined
  const completionBootBlocked = (): boolean => managedCompletionAdmission !== undefined
    || packageAdmissionId !== undefined || managedCompletionIssue !== undefined
  const reviewPackageChanges = (initialRecovery = false, startupTransactionId?: string): Promise<void> => {
    if (!initialRecovery && (!managedRecoveryReady || startup !== undefined)) return Promise.resolve()
    if (lifecycleUnavailable() || managedHandoffOperation !== undefined || managedHelperMayRun || completionOwnsAdmission()) {
      return Promise.resolve()
    }
    if (packageOperation !== undefined) return packageOperation
    packageOperation = (async () => {
      if (development || packagePolicy === undefined) throw new Error('Package graph activation requires a packaged staging capability')
      if (shellInstallerOwnsQuit || updateState.phase === 'installing') throw new Error('An application update already owns restart admission')
      if (!initialRecovery && backend.host === undefined && packageAdmissionId === undefined) {
        throw new Error(messages.updateTasksUnavailable)
      }
      const recovering = pendingDesktopActivationTransactions(activeProject)
      packageTransactions ??= createDesktopPackageBackend(activeProject, resources, packagePolicy, recovering[0])
      const transactions = packageTransactions
      const ids = startupTransactionId === undefined
        ? recovering.length > 0 ? recovering : (await transactions.listPending()).map(item => item.transactionId)
        : [startupTransactionId]
      if (ids.length === 0) {
        await ordinaryMessageBox({ type: 'info', title: messages.packageReview, message: messages.packageNone })
        return
      }
      if (ids.length > 8) throw new Error('Review at most eight prepared changes at once; discard other stages through Plugin Manager first')
      const selected = ids.length === 1 ? 0 : (await ordinaryMessageBox({ type: 'question', title: messages.packageReview,
        message: messages.packageChoose, buttons: [...ids, messages.updateLater], cancelId: ids.length, defaultId: ids.length })).response
      const id = ids[selected]
      if (id === undefined) return
      let approved: { host: typeof backend.host; revision: number | undefined; active: boolean } | undefined
      // Once admitted, activation owns candidate/rollback teardown until it settles, even after quit intent.
      let admitted = false
      const activation = createDesktopProfilePackageActivation({
        profile: activeProject, backend: transactions,
        confirm: async (input) => {
          if (lifecycleUnavailable() || isMandatory()) return false
          const host = backend.host
          const preparedPlanSha256 = input.owner.provisioningPlanResource?.planSha256
          const packagedPlanSha256 = managedUpdate?.capability.provisioning.planSha256
          if (mayAuthorizeDesktopStartupPackage({ transactionId: id, initialRecovery,
            everStartedHost, hostPresent: host !== undefined, recoveryTransactionIds: recovering,
            privateProvisioning: input.provisioning !== undefined,
            ...(startupTransactionId === undefined ? {} : { startupTransactionId }),
            ...(preparedPlanSha256 === undefined ? {} : { preparedPlanSha256 }),
            ...(packagedPlanSha256 === undefined ? {} : { packagedPlanSha256 }) })) {
            approved = { host: undefined, revision: undefined, active: false }
            return true
          }
          const revision = initialRecovery && !everStartedHost ? undefined : updateInput.check(messages.updateUnsentInput)
          const active = host === undefined ? packageAdmissionId !== undefined : await host.updateTasks('inspect')
          const detail = desktopRegistryConfirmationDetail(input.registryTarget, messages)
          const answer = await ordinaryMessageBox({ type: active ? 'warning' : 'question', title: messages.packageReview,
            message: formatDesktopMessage(messages.packageConfirm, { name: input.prepared.packageName, id }),
            ...(detail === undefined ? {} : { detail }),
            buttons: [recovering.includes(id) ? messages.packageRecover : messages.packageActivate, messages.updateLater],
            defaultId: 1, cancelId: 1 })
          if (answer.response !== 0 || lifecycleUnavailable() || isMandatory()) return false
          approved = { host, revision, active }
          return true
        },
        acquireAdmission: async () => {
          if (lifecycleUnavailable() || isMandatory()) throw new Error('Desktop shutdown or recovery prevents package admission')
          const consent = approved
          if (consent === undefined || (packageAdmissionId !== undefined && packageAdmissionId !== id)) throw new Error('Package activation consent is unavailable')
          const alreadyHeld = packageAdmissionId === id
          packageAdmissionId = id
          mainWindow?.setEnabled(false)
          try {
            if (backend.host !== consent.host) throw new Error(messages.updateTasksUnavailable)
            if (consent.revision !== undefined) updateInput.check(messages.updateUnsentInput, consent.revision)
            const active = await consent.host?.updateTasks('lock') ?? false
            if (active && !consent.active) throw new Error(messages.updateTasksChanged)
            if (backend.host !== consent.host) throw new Error(messages.updateTasksUnavailable)
            if (consent.revision !== undefined) updateInput.check(messages.updateUnsentInput, consent.revision)
            if (lifecycleUnavailable() || isMandatory()) throw new Error('Desktop shutdown or recovery prevents package admission')
            admitted = true
          } catch (error) {
            if (!alreadyHeld && !lifecycleUnavailable()) {
              await consent.host?.updateTasks('unlock')
              packageAdmissionId = undefined
            }
            throw error
          }
          return async () => {
            // Shutdown owns the next action; never reopen API admission or the old document.
            if (lifecycleUnavailable()) return
            const current = backend.host
            if (current === undefined) throw new Error(messages.updateTasksUnavailable)
            // Initial activation/recovery keeps the generation-spanning gate until
            // baseline qualification and managed completion finish in reconcileBackend.
            if (!initialRecovery) {
              await current.updateTasks('unlock')
              if (lifecycleUnavailable()) return
              packageAdmissionId = undefined
            }
            if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.setEnabled(true)
            if (!initialRecovery) {
              navigation = undefined
              await navigateMain(applicationUrl)
            }
          }
        },
        // Qualification failures must reject the async activation callback without delaying validation.
        // oxlint-disable-next-line typescript/require-await
        qualify: async (input, location) => {
          const expected = qualifyDesktopPackageProfile(input, location === 'candidate' ? input.candidateDir : activeProject)
          if (input.mutation.kind === 'install' && input.mutation.enabled !== undefined
            && expected.some(item => item.name === input.prepared.packageName) !== input.mutation.enabled) {
            throw new Error('Prepared bundle selection does not match the approved package operation')
          }
        },
        stopHost: async () => {
          requireCleanStop = true
          updateStopFailure = undefined
          try {
            await backend.stop()
            const failed = updateStopFailure as DesktopHostUncleanExitError | undefined
            if (failed !== undefined) throw failed
          } finally { requireCleanStop = false }
        },
        startHost: async () => {
          if (lifecycleUnavailable() && !admitted) throw new Error('Desktop is quitting before package admission')
          await backend.start(async () => {})
        },
        verifyHost: async (input, role) => {
          const current = backend.host
          if (current === undefined) throw new Error(messages.updateTasksUnavailable)
          const expected = qualifyDesktopPackageProfile(input, activeProject)
          const required = role === 'candidate' && input.mutation.kind === 'install'
            && expected.some(item => item.name === input.prepared.packageName) ? [input.prepared.packageName] : []
          assertDesktopPackageHealth(expected, current.packageHealth, required)
          if (role === 'candidate' && await current.updateTasks('inspect')) {
            throw new Error('Background or Agent work was observed before package activation verification; no new receipt is committed')
          }
        },
        commitReceipt: commitDesktopPackageReceipt,
      })
      const result = recovering.includes(id) ? await activation.recover(id) : await activation.activate(id)
      if (result.status === 'cancelled' && initialRecovery) throw new Error(messages.packageRefused)
    })().catch(async (error: unknown) => {
      if (!lifecycleUnavailable() && mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.setEnabled(true)
      // The generation-spanning API barrier remains held after an unverified failure.
      if (initialRecovery) throw error
      console.error(error)
      await ordinaryMessageBox({ type: 'error', title: messages.packageReview, message: messages.packageFailed,
        detail: (error instanceof Error ? error.message : String(error)).slice(0, 1200) })
    }).finally(() => { packageOperation = undefined })
    return packageOperation
  }

  const updateErrors = new WeakMap<DesktopUpdateState, Promise<void>>()
  const showUpdateFailure = (state: DesktopUpdateState): Promise<void> => {
    if (state.phase !== 'error') return Promise.resolve()
    if (isMandatory()) { mandatoryUI?.sync(); return Promise.resolve() }
    let shown = updateErrors.get(state)
    if (shown === undefined) {
      shown = ordinaryMessageBox({ type: 'error', title: messages.updateFailedTitle,
        message: desktopUpdateErrorSummary(state, messages),
        technicalDetails: state.technicalDetails ?? state.message ?? '' }).then(() => {})
      updateErrors.set(state, shown)
    }
    return shown
  }
  const publishUpdate = (state: DesktopUpdateState): DesktopUpdateState => {
    updateJournal?.state(state)
    updateState = state
    mandatoryUI?.sync()
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.updatesPresentation, updatePresentation(state))
    }
    if (state.phase === 'error' && state.failedOperation !== 'check') {
      const restoreHost = state.failedOperation === 'install' && updateStoppedHost && !managedHelperMayRun && !lifecycleUnavailable()
      shellInstallerOwnsQuit = false
      if (!managedHelperMayRun && !lifecycleUnavailable() && mainWindow !== undefined && !mainWindow.isDestroyed()) {
        mainWindow.setEnabled(true)
      }
      updateStoppedHost = false
      if (restoreHost) {
        // Only confirmed process exit permits replacement before another installation confirmation.
        const hostReady = backend.start(async () => {})
        startup = hostReady
        const recovery = hostReady.then(async () => {
          if (quitting) return
          // A replacement Host can have a new port, cookie, or boot injections even at the same URL.
          navigation = undefined
          await navigateMain(applicationUrl)
          if (backend.host !== undefined) updateJournal?.action('workspace-ready')
        })
        workspaceRecovery = recovery
        void recovery.catch(reportFatal).finally(() => {
          if (startup === hostReady) startup = undefined
          if (workspaceRecovery === recovery) workspaceRecovery = undefined
        })
      }
      void showUpdateFailure(state).catch((error: unknown) => { console.error(error) })
    }
    return state
  }

  const cancelLifecycleConsent = (): void => {
    baselineAbort.abort()
    managedRecoveryRequested = false
    managedCompletionBootGate?.resolve(undefined)
    for (const pending of ordinaryDialogs) pending.abort()
  }
  cancelPendingConsentForRecovery = cancelLifecycleConsent
  const drainLifecycle = (): Promise<void> => {
    lifecycleDrain ??= (async () => {
      // Keep the owned Host alive through activation/rollback and helper acknowledgement/abandonment.
      const operations = await Promise.allSettled([
        packageOperation, managedHandoffOperation, managedCompletionOperation, managedRecoveryOperation,
      ])
      for (const operation of operations) if (operation.status === 'rejected') console.error(operation.reason)
      if (managedHelperMayRun) throw new Error('Desktop cannot exit: managed helper cancellation is unconfirmed')
      const results = await Promise.allSettled([backend.close(), startup])
      if (results[0].status === 'rejected') throw results[0].reason
      if (results[1].status === 'rejected') console.error(results[1].reason)
    })()
    return lifecycleDrain
  }
  stopForRecovery = () => {
    cancelLifecycleConsent()
    return drainLifecycle()
  }

  const publishBaseline = (notice: DesktopBaselineNotice | undefined): void => {
    baselineNotice = notice
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(DESKTOP_IPC.updatesPresentation, updatePresentation(updateState))
    }
  }
  const assessBaseline = async (): Promise<DesktopProvisioningAssessment | undefined> => {
    if (packageTransactions === undefined) return undefined
    const assessment = await packageTransactions.assessProvisioning()
    if (assessment.status === 'invalid-evidence') throw new Error(assessment.diagnostic)
    if (assessment.status === 'preserved-user-choice') {
      publishBaseline({ status: 'preserved-user-choice', packageName: assessment.packageName })
    } else publishBaseline({ status: 'pending', packageName: assessment.packageName })
    return assessment
  }
  const verifyBaseline = async (): Promise<void> => {
    if (packageTransactions === undefined || packagePolicy === undefined) return
    const assessment = await assessBaseline()
    if (assessment?.status !== 'exact-satisfied') return
    const current = backend.host
    if (current === undefined) throw new Error(messages.updateTasksUnavailable)
    const expected = packagePolicy.provisioningPlan.plugins[0]?.source
    const observed = current.packageHealth?.filter(item => item.name === assessment.packageName)
    if (expected === undefined || observed?.length !== 1 || !observed[0]?.enabled || !observed[0].healthy
      || observed[0].version !== expected.version) return
    // Readiness snapshots cannot qualify a graph after observable work has run.
    // Keep this deliberately narrower than a global Agent/plugin-effects barrier.
    if (packageAdmissionId === undefined || await current.updateTasks('inspect')) return
    let state: DesktopPluginProvisioningState
    try { state = await packageTransactions.commitSatisfiedProvisioning(assessment.assessmentFingerprint) }
    catch (error) {
      // A stale assessment or failed evidence-only write is not a reason to discard a usable profile.
      // A fresh invalid-evidence classification still propagates through assessBaseline.
      console.error('Desktop baseline evidence remains pending:', error)
      await assessBaseline()
      return
    }
    if (state.planSha256 !== assessment.planSha256) throw new Error('Desktop baseline evidence belongs to another packaged plan')
    publishBaseline(undefined)
  }

  const readManagedCompletion = (
    claimStartupAdmission = false,
    manualRecovery = false,
  ): Promise<DesktopManagedUpdateCompletion | undefined> => {
    if (managedCompletionOperation !== undefined) return managedCompletionOperation
    const host = backend.host
    if (managedUpdate === undefined || host === undefined || lifecycleUnavailable()) return Promise.resolve(undefined)
    const window = mainWindow
    const documentGeneration = inputDocumentGeneration
    const admissionId = packageAdmissionId
    const current = (): boolean => !lifecycleUnavailable() && backend.host === host && mainWindow === window
      && (claimStartupAdmission || inputDocumentGeneration === documentGeneration) && packageAdmissionId === admissionId
    const operation: Promise<DesktopManagedUpdateCompletion | undefined> = Promise.resolve().then(async () => {
      if (!current()) return undefined
      let completion: DesktopManagedUpdateCompletion
      try {
        completion = await completeDesktopManagedUpdate(managedUpdate.operationsRoot, managedUpdate.completionPath,
          managedUpdate.capability, managedCompletedSequence, process.execPath,
          join(resources.dsh, 'desktop-runtime.json'), join(process.resourcesPath, 'desktop-provisioning', 'plan.json'), activeProject,
          baselineNotice?.status, undefined, manualRecovery ? {
            version: app.getVersion(), capabilityPath: join(process.resourcesPath, 'managed-update', 'capability.json'),
          } : undefined)
      } catch (error) {
        completion = { status: 'recovery-required', message: desktopErrorState(error).message,
          command: managedUpdateRecoveryCommand(process.execPath) }
      }
      if (!current()) return undefined
      if (completion.status === 'recovery-required') {
        managedCompletionIssue = completion
        if (claimStartupAdmission && admissionId !== undefined && packageOperation === undefined) {
          if (window === undefined) throw new Error(messages.updateTasksUnavailable)
          managedCompletionAdmission = { id: admissionId, host, window, documentGeneration: inputDocumentGeneration }
          managedCompletionBootGate ??= Promise.withResolvers<undefined>()
        }
        return completion
      }
      const owned = managedCompletionAdmission
      if (owned !== undefined) {
        if (owned.host !== host || owned.id !== admissionId || owned.window !== window
          || owned.documentGeneration !== documentGeneration || packageOperation !== undefined) return undefined
        await host.updateTasks('unlock')
        if (!current()) return undefined
        packageAdmissionId = undefined
        managedCompletionAdmission = undefined
        managedCompletionBootGate?.resolve(undefined)
        managedCompletionBootGate = undefined
      }
      managedCompletionIssue = undefined
      if (completion.status === 'complete') managedCompletedSequence = Math.max(managedCompletedSequence, completion.sequence)
      return completion
    }).finally(() => { if (managedCompletionOperation === operation) managedCompletionOperation = undefined })
    managedCompletionOperation = operation
    return operation
  }
  const showManagedCompletionIssue = async (): Promise<boolean> => {
    const issue = managedCompletionIssue
    if (issue === undefined || lifecycleUnavailable()) return false
    const answer = await ordinaryMessageBox({ type: 'warning', title: messages.updateFailedTitle,
      message: messages.updateFailedTitle, detail: `${issue.message}\n\n${issue.command}`,
      buttons: [messages.checkUpdatesMenu, messages.updateLater], defaultId: 1, cancelId: 1 })
    return answer.response === 0 && !lifecycleUnavailable() && managedCompletionIssue === issue
  }

  const reconcileBackend = (): Promise<void> => {
    if (lifecycleUnavailable()) return Promise.resolve()
    startup ??= (async () => {
      await navigateMain(applicationUrl)
      if (lifecycleUnavailable()) return
      if (pendingDesktopActivationTransactions(activeProject).length > 0) {
        await reviewPackageChanges(true)
        if (backend.host === undefined) throw new Error(messages.packageRefused)
      } else if (!everStartedHost && packagePolicy !== undefined && !startupProvisioningAttempted) {
        // No Host has existed in this launch. Initialization authority is captured before any baseline staging.
        startupProvisioningAttempted = true
        await manager.applyRelease(app.isPackaged)
        packageTransactions ??= createDesktopPackageBackend(activeProject, resources, packagePolicy, undefined, manager.createdProfile)
        const assessment = await assessBaseline()
        if (assessment?.status === 'provisionable') {
          try {
            const prepared = await packageTransactions.stageProvisioning(randomUUID(), baselineAbort.signal)
            await reviewPackageChanges(true, prepared.transactionId)
          } catch (error) {
            // Never mask an uncertain activation/rollback or execute an unrepaired damaged release-owned graph.
            if (hasEverStartedHost() || pendingDesktopActivationTransactions(activeProject).length > 0
              || assessment.reason === 'release-owned-repair' || baselineAbort.signal.aborted) throw error
            console.error('Desktop baseline preparation remains pending:', error)
            publishBaseline({ status: 'pending', packageName: assessment.packageName })
          }
        }
        if (backend.host === undefined) {
          if (assessment?.status === 'exact-satisfied') packageAdmissionId = randomUUID()
          await backend.start(async () => {})
        }
      } else {
        await backend.start(async () => { await manager.applyRelease(app.isPackaged) })
      }
      await verifyBaseline()
      if (managedUpdate !== undefined) {
        const completion = await readManagedCompletion(true)
        if (completion === undefined && !lifecycleUnavailable()) throw new Error(messages.updateTasksUnavailable)
      }
      if (!lifecycleUnavailable() && managedCompletionIssue === undefined && packageAdmissionId !== undefined
        && packageOperation === undefined && backend.host !== undefined) {
        await backend.host.updateTasks('unlock')
        packageAdmissionId = undefined
      }
      if (backend.host !== undefined) updateJournal?.action('workspace-ready')
      // Runtime readiness is independent of a preserved-user-choice or pending release baseline.
      // The existing Web document resumes through the boot IPC response.
    })().catch((error: unknown) => {
      updateJournal?.action('workspace-failed')
      reportFatal(error)
      throw error
    }).finally(() => {
      startup = undefined
      managedRecoveryReady = !lifecycleUnavailable() && backend.host !== undefined
    })
    return startup
  }

  // Read current ownership at every await boundary; other lifecycle callbacks can change these values.
  const helperOwnsRestartAdmission = (): boolean => managedHelperMayRun
  const packageOwnsRestartAdmission = (): boolean => packageOperation !== undefined || packageAdmissionId !== undefined
  const completionRequiresRecovery = (): boolean => managedCompletionIssue !== undefined
  const prepareRestart = async (beforeStop?: (hostPid: number | undefined) => Promise<void>): Promise<boolean> => {
    if (lifecycleUnavailable()) throw new Error('Desktop shutdown or recovery already owns restart admission')
    if (completionOwnsAdmission()) throw new Error('Managed completion recheck already owns admission')
    if (completionRequiresRecovery()) throw new Error('Managed update completion requires recovery before restart')
    if (helperOwnsRestartAdmission()) throw new Error('A managed helper already owns restart admission')
    if (packageOwnsRestartAdmission()) throw new Error('A package activation already owns restart admission')
    await workspaceRecovery
    await startup?.catch(() => undefined)
    if (lifecycleUnavailable() || packageOwnsRestartAdmission() || completionOwnsAdmission() || completionRequiresRecovery()) {
      throw new Error('Desktop lifecycle changed before restart admission')
    }
    const host = backend.host
    if (host === undefined) throw new DesktopUpdatePreparationError('tasks-unavailable', messages.updateTasksUnavailable)
    const inputRevision = updateInput.check(messages.updateUnsentInput)
    const active = await host.updateTasks('inspect')
    const confirmation: Electron.MessageBoxOptions = {
      type: active ? 'warning' : 'info', title: messages.updateTitle,
      message: active ? messages.updateActiveTasks : formatDesktopMessage(
        managedUpdate === undefined ? messages.updateDownloadedTitle : messages.managedHandoffTitle, { version: updates.state.version ?? '' }),
      detail: [active ? messages.updateActiveTasksDetail : '',
        managedUpdate === undefined ? messages.updateDownloadedDetail : messages.managedHandoffDetail].filter(Boolean).join('\n\n'),
      buttons: active ? [messages.updateStopTasks, messages.updateLater]
        : [managedUpdate === undefined ? messages.installAndRestart : messages.managedReview],
      defaultId: 1, cancelId: 1,
    }
    if (isMandatory()) {
      if (!await mandatoryUI?.confirm(updates.state.version ?? '', active)) return false
    } else {
      if (mainWindow === undefined) return false
      const result = await ordinaryMessageBox(confirmation)
      if (result.response !== 0 || isMandatory()) return false
    }
    if (lifecycleUnavailable()) return false
    if (backend.host !== host) throw new DesktopUpdatePreparationError('tasks-unavailable', messages.updateTasksUnavailable)
    const inputWindow = mainWindow
    inputWindow?.setEnabled(false)
    try {
      updateInput.check(messages.updateUnsentInput, inputRevision)
      const stillActive = await host.updateTasks('lock')
      updateInput.check(messages.updateUnsentInput, inputRevision)
      if (stillActive && !active) throw new DesktopUpdatePreparationError('tasks-changed', messages.updateTasksChanged)
      if (lifecycleUnavailable()) throw new Error('Desktop shutdown or recovery prevents restart')
      await beforeStop?.(host.processId)
      if (backend.host !== host) throw new DesktopUpdatePreparationError('tasks-unavailable', messages.updateTasksUnavailable)
      if (lifecycleUnavailable()) throw new Error('Desktop shutdown or recovery prevents restart')
      updateInput.check(messages.updateUnsentInput, inputRevision)
      mandatoryUI?.preparingRestart(stillActive)
      requireCleanStop = true
      updateStopFailure = undefined
      await backend.stop()
      updateStoppedHost = true
      // The backend's async cleanup callback can assign this after the reset above.
      const stopFailure = updateStopFailure as DesktopHostUncleanExitError | undefined
      if (stopFailure !== undefined) throw new DesktopUpdatePreparationError('stop-failed', messages.updateStopFailed, stopFailure.message)
      if (lifecycleUnavailable()) throw new Error('Desktop shutdown or recovery prevents installer handoff')
      updateJournal?.action('install-confirmed')
      shellInstallerOwnsQuit = true
    } catch (error) {
      if (!updateStoppedHost && !helperOwnsRestartAdmission() && !lifecycleUnavailable()) {
        await host.updateTasks('unlock').catch((unlockError: unknown) => { console.error(unlockError) })
      }
      throw error
    } finally {
      requireCleanStop = false
      if (!shellInstallerOwnsQuit && !helperOwnsRestartAdmission() && !lifecycleUnavailable()
        && inputWindow !== undefined && !inputWindow.isDestroyed()) {
        inputWindow.setEnabled(true)
      }
    }
    return true
  }
  const updates = managedUpdate === undefined
    ? new DesktopUpdateCoordinator(publishUpdate, () => prepareRestart())
    : new DesktopManagedUpdateCoordinator(managedUpdate.capability, () => managedUpdate.installedSequence,
      publishUpdate, (selection) => {
        if (managedHandoffOperation !== undefined) return managedHandoffOperation
        const operation = (async () => {
          let acknowledgement: DesktopManagedUpdateAcknowledgement | undefined
          const handoff: { host: typeof backend.host } = { host: undefined }
          try {
            const approved = await prepareRestart(async (hostPid) => {
              if (hostPid === undefined || !Number.isSafeInteger(hostPid) || hostPid <= 0) throw new Error('Managed update Host identity is unavailable')
              const node = resolveDesktopManagedNode(resources.dsh, join(process.resourcesPath, 'runtime', 'primary-runtime'))
              handoff.host = backend.host
              managedHelperMayRun = true
              acknowledgement = await launchDesktopManagedUpdate({
                operationsRoot: managedUpdate.operationsRoot,
                nodeExecutable: node.path, nodeSha256: node.sha256,
                helperBundle: managedUpdate.helperBundle,
                capability: managedUpdate.capability,
                selection: { kind: selection.kind, manifestUrl: selection.manifestUrl,
                  manifestSha256: selection.manifestSha256, assetSha256: selection.assetSha256 },
                installedSequence: managedUpdate.installedSequence,
                waitPids: [process.pid, hostPid],
              })
            })
            if (!approved) return false
            // prepareRestart has verified clean stop and transferred quit ownership. This bypass avoids self-wait.
            managedHelperMayRun = false
            app.quit()
            return true
          } catch (error) {
            let failure = error
            if (acknowledgement !== undefined) {
              try {
                await acknowledgement.abandon()
                managedHelperMayRun = false
              } catch (abandonError) {
                if (isDesktopManagedUpdateHelperQuiescent(abandonError)) managedHelperMayRun = false
                failure = new AggregateError([error, abandonError], 'Managed update handoff failed and helper cancellation failed')
              }
            } else if (isDesktopManagedUpdateHelperQuiescent(error)) managedHelperMayRun = false
            // Rejection alone cannot clear ownership; only the launcher can attest no child or confirmed exit.
            const handoffHost = handoff.host
            if (!managedHelperMayRun && handoffHost !== undefined && !lifecycleUnavailable()) {
              try {
                if (!updateStoppedHost && backend.host === handoffHost) await handoffHost.updateTasks('unlock')
                if (!lifecycleUnavailable() && mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.setEnabled(true)
              } catch (restoreError) {
                throw new AggregateError([failure, restoreError], 'Managed helper stopped but restart admission restoration failed')
              }
            }
            throw failure
          }
        })()
        managedHandoffOperation = operation
        return operation.finally(() => { if (managedHandoffOperation === operation) managedHandoffOperation = undefined })
      }, undefined, messages)

  const updateSchedule = new DesktopUpdateSchedule(updates, resolveDesktopUpdateScheduleConfig(process.env))

  const downloadUpdate = async (version: string): Promise<DesktopUpdateState> => {
    updateJournal?.action('download-requested')
    const state = await updates.download(version)
    if (state.phase !== 'ready' || quitting) return state
    // Only a completed user-driven download opens this prompt; cancelling installation does not reopen it.
    return updates.install(version)
  }

  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url)
    if (url.hostname === 'app') {
      if (url.pathname === '/' || url.pathname === '/index.html' || url.pathname.startsWith('/assets/')
        || ['/favicon.svg', '/manifest.webmanifest'].includes(url.pathname)) {
        return serveWebDocument(request, join(resources.dsh, 'node_modules', '@deepseek-ai', 'dsh-web-frontend', 'dist'))
      }
      if (backend.host === undefined || hostUrl === undefined || hostCookie === undefined) {
        return Promise.resolve(new Response(null, { status: 503 }))
      }
      return forwardWebRequest(request, hostUrl, hostCookie)
    }
    return Promise.resolve(new Response(null, { status: 404 }))
  })

  installDesktopDirectoryPicker(() => mainWindow)

  ipcMain.handle(DESKTOP_IPC.boot, async (event) => {
    assertDesktopSender(event, ['app'])
    await startup
    const held = managedCompletionAdmission
    if (held !== undefined) {
      const frame = event.senderFrame
      const documentCurrent = (): boolean => mainWindow === held.window && !held.window.isDestroyed()
        && event.sender === held.window.webContents && frame === held.window.webContents.mainFrame
        && inputDocumentGeneration === held.documentGeneration && backend.host === held.host
      if (!documentCurrent()) throw new Error('Desktop completion boot document is unavailable')
      await managedCompletionBootGate?.promise
      if (lifecycleUnavailable() || !documentCurrent() || completionBootBlocked()) {
        throw new Error('Desktop completion boot document is unavailable')
      }
    }
    if (lifecycleUnavailable() || backend.host === undefined || hostUrl === undefined) throw new Error('Desktop Host is unavailable')
    return { injections, streamBaseUrl: new URL(hostUrl).origin }
  })

  ipcMain.handle(DESKTOP_IPC.bootFailed, (event, message: unknown) => {
    assertDesktopSender(event, ['app'])
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('dsh desktop: rejected startup failure from a non-primary frame')
    }
    if (typeof message !== 'string') throw new Error('dsh desktop: startup failure must be text')
    reportFatal(new Error(message))
  })

  session.defaultSession.webRequest.onBeforeSendHeaders({ urls: ['ws://127.0.0.1/*'] }, (details, callback) => {
    if (hostUrl === undefined || hostCookie === undefined || details.webContentsId !== mainWindow?.webContents.id) {
      callback({})
      return
    }
    const target = new URL(hostUrl)
    const requested = new URL(details.url)
    if (requested.host !== target.host) { callback({}); return }
    const headers = Object.fromEntries(Object.entries(details.requestHeaders).map(([name, value]) => [name.toLowerCase(), value]))
    if (headers.origin !== 'dsh-app://app') { callback({ cancel: true }); return }
    callback({ requestHeaders: { ...headers, origin: target.origin, cookie: hostCookie, 'sec-fetch-site': 'same-origin' } })
  })

  // Only the main window may synchronize its palette with the native material.
  ipcMain.on(DESKTOP_IPC.nativeThemeSet, (event, source: unknown) => {
    if (mainWindow === undefined || event.sender !== mainWindow.webContents) return
    if (source === 'light' || source === 'dark' || source === 'system') nativeTheme.themeSource = source
  })
  ipcMain.on(DESKTOP_IPC.updatesImpact, (event, generation: unknown, impact: unknown) => {
    if (!inputDocumentReady || generation !== inputDocumentGeneration
      || mainWindow === undefined || event.sender !== mainWindow.webContents
      || event.senderFrame !== mainWindow.webContents.mainFrame) return
    try {
      assertDesktopSender(event, ['app'])
      updateInput.report(impact)
    } catch (error) { updateInput.reset(); console.error(error) }
  })
  ipcMain.handle(DESKTOP_IPC.updatesStatus, (event) => {
    assertProductSender(event)
    return updatePresentation(updates.state)
  })
  ipcMain.handle(DESKTOP_IPC.updatesOpen, async (event) => {
    assertProductSender(event)
    if (completionRequiresRecovery()) { await recoverManagedCompletion(); return }
    if (baselineNotice !== undefined && updates.state.phase === 'idle') {
      await ordinaryMessageBox({ type: 'warning', title: messages.baselineTitle,
        message: baselineNotice.status === 'preserved-user-choice' ? messages.baselinePreserved : messages.baselinePending,
        detail: formatDesktopMessage(messages.baselineDetail, { name: baselineNotice.packageName }),
        buttons: [messages.updateAcknowledge], cancelId: 0 })
      return
    }
    await openUpdatePrompt()
  })

  let promptOperation: Promise<void> | undefined
  let policyAuthenticationQueued = false
  const openUpdatePrompt = (manual = false): Promise<void> => {
    if (authenticationOperation !== undefined) {
      policyAuth?.focus(); updateDialog.focus()
    }
    let failedOperation: 'check' | 'download' | 'install' = 'check'
    promptOperation ??= Promise.resolve().then(async () => {
      if (manual) updateJournal?.action('check-requested')
      const joinedPolicyAuthentication = authenticationOperation !== undefined
      if (joinedPolicyAuthentication) await authenticatePolicy()
      if (isMandatory()) {
        mandatoryUI?.focus()
        if (manual) await Promise.all([checkPolicyManually(), updateSchedule.check(true)])
        return
      }
      let state = updates.state
      if (manual || state.phase === 'idle' || (state.phase === 'error' && state.failedOperation === 'check')) {
        const controller = new AbortController()
        ordinaryDialogs.add(controller)
        const progress = mainWindow === undefined ? Promise.resolve() : updateDialog.show(mainWindow, { type: 'info', title: messages.updateCheckTitle,
          message: messages.updateChecking, buttons: [messages.later], cancelId: 0, signal: controller.signal })
        try {
          if (!joinedPolicyAuthentication) {
            void checkPolicyManually('deferred').catch((error: unknown) => { console.error(error) })
          }
          state = await updateSchedule.check(true)
        } finally { controller.abort(); ordinaryDialogs.delete(controller); await progress }
      }
      if (lifecycleUnavailable() || completionRequiresRecovery()) return
      if (isMandatory()) { mandatoryUI?.focus(); return }
      if (state.phase === 'error' && state.failedOperation === 'check') { await showUpdateFailure(state); return }
      if (state.phase === 'idle') {
        await ordinaryMessageBox({ type: 'info', title: messages.updateCheckTitle,
          message: formatDesktopMessage(messages.updateCurrent, { version: app.getVersion() }) })
        return
      }
      if (state.phase === 'ready' || (state.phase === 'error' && state.failedOperation === 'install')) {
        if (state.version !== undefined) {
          failedOperation = 'install'
          await showUpdateFailure(await updates.install(state.version))
        }
        return
      }
      if (state.phase !== 'available' && !(state.phase === 'error' && state.failedOperation === 'download')) return
      if (manual) {
        const result = await ordinaryMessageBox({ title: messages.updateCheckTitle, message: messages.updateAvailable,
          detail: managedUpdate === undefined ? formatDesktopMessage(messages.updateDetail, { version: state.version ?? '' })
            : `${formatDesktopMessage(messages.managedHandoffTitle, { version: state.version ?? '' })}\n\n${messages.managedHandoffDetail}`,
          buttons: [managedUpdate === undefined ? messages.updateDownload : messages.managedReview], cancelId: 1 })
        if (result.response !== 0) return
      }
      if (!isMandatory() && state.version !== undefined) {
        failedOperation = 'download'
        await showUpdateFailure(await downloadUpdate(state.version))
      }
    }).catch((error: unknown) => showUpdateFailure({ phase: 'error', failedOperation,
      message: desktopErrorState(error).message }))
      .finally(() => { promptOperation = undefined; flushQueuedPolicyAuthentication() })
    return promptOperation
  }

  const managedRecoveryAvailable = (): boolean => {
    const owned = managedCompletionAdmission
    const ownsHeldAdmission = packageAdmissionId === undefined || (owned !== undefined && owned.id === packageAdmissionId
      && owned.host === backend.host && owned.window === mainWindow && owned.documentGeneration === inputDocumentGeneration)
    return managedRecoveryReady && managedUpdate !== undefined && !lifecycleUnavailable() && startup === undefined
      && backend.host !== undefined && packageOperation === undefined && managedHandoffOperation === undefined
      && !managedHelperMayRun && !shellInstallerOwnsQuit && updateState.phase !== 'installing' && ownsHeldAdmission
  }
  const recoverManagedCompletion = (): Promise<void> => {
    if (managedRecoveryOperation !== undefined) return managedRecoveryOperation.then(() => {})
    if (!managedRecoveryAvailable()) return Promise.resolve()
    const operation: Promise<boolean> = Promise.resolve().then(async () => {
      if (!managedRecoveryAvailable()) return false
      const completion = await readManagedCompletion(false, true)
      if (completion === undefined || !managedRecoveryAvailable()) return false
      return showManagedCompletionIssue()
    }).catch((error: unknown) => {
      console.error('Desktop managed completion recheck failed', error)
      return false
    }).finally(() => { if (managedRecoveryOperation === operation) managedRecoveryOperation = undefined })
    managedRecoveryOperation = operation
    return operation.then(async (checkUpdates) => {
      // This authorizes a metadata review only; normal restart admission still rejects an unresolved issue or held token.
      if (checkUpdates && managedRecoveryAvailable()) await openUpdatePrompt(true)
    })
  }
  requestManagedRecovery = () => {
    if (lifecycleUnavailable()) { managedRecoveryRequested = false; return }
    if (!managedRecoveryReady) { managedRecoveryRequested = true; return }
    managedRecoveryRequested = false
    void recoverManagedCompletion().catch((error: unknown) => { console.error(error) })
  }

  let authenticationOperation: Promise<DesktopPolicyState | undefined> | undefined
  const authenticatePolicy = () => {
    if (authenticationOperation !== undefined) { policyAuth?.focus(); updateDialog.focus() }
    authenticationOperation ??= runPolicyAuthentication().finally(() => { authenticationOperation = undefined })
    return authenticationOperation
  }
  const flushQueuedPolicyAuthentication = (): void => {
    if (!policyAuthenticationQueued || promptOperation !== undefined || authenticationOperation !== undefined
      || isMandatory() || quitting) return
    policyAuthenticationQueued = false
    void authenticatePolicy().catch((error: unknown) => { console.error(error) })
  }
  const queuePolicyAuthentication = (): void => {
    if (authenticationOperation !== undefined) {
      policyAuth?.focus(); updateDialog.focus()
      return
    }
    policyAuthenticationQueued = true
    flushQueuedPolicyAuthentication()
  }
  const runPolicyAuthentication = async () => {
    if (policyAuth === undefined || mandatoryPolicy === undefined || quitting) return undefined
    const parent = mandatoryUI?.confirmationWindow ?? mainWindow
    if (parent === undefined) return undefined
    const consent = await updateDialog.show(parent, { type: 'info', title: messages.policyLoginTitle,
      message: messages.policyLoginRequired, buttons: [messages.policyLogin, messages.later], cancelId: 1 })
    if (consent.response !== 0 || isQuitting()) return undefined
    const outcome = await policyAuth.login()
    if (isQuitting() || outcome === 'cancelled') return undefined
    if (outcome === 'failed') {
      await updateDialog.show(parent, { type: 'error', title: messages.policyLoginTitle,
        message: messages.policyLoginFailed, buttons: [messages.updateAcknowledge], cancelId: 0 })
      return undefined
    }
    // Drain a pre-login request before asking the server to evaluate the new cookies.
    await mandatoryPolicy.check('login-return')
    if (isQuitting()) return undefined
    return mandatoryPolicy.check('login-return', true)
  }

  const checkPolicyManually = async (authentication: 'immediate' | 'deferred' = 'immediate') => {
    if (authenticationOperation !== undefined) return authenticatePolicy()
    const policy = await mandatoryPolicy?.check('manual', true)
    if (policy?.error !== 'authentication-required') return policy
    if (authentication === 'immediate') return authenticatePolicy()
    queuePolicyAuthentication()
    return policy
  }

  const automaticCheck = (): void => {
    if (!quitting) void mandatoryPolicy?.check('foreground-or-resume').catch((error: unknown) => { console.error(error) })
    if (!quitting) void updateSchedule.check().catch((error: unknown) => { console.error(error) })
  }
  powerMonitor.on('resume', automaticCheck)
  app.on('will-quit', () => {
    updateSchedule.dispose()
    powerMonitor.off('resume', automaticCheck)
    updates.dispose()
  })

  const desktopVersion = app.getVersion()
  app.setAboutPanelOptions({
    applicationName: 'DeepSeek Harness',
    applicationVersion: desktopVersion,
    // The release has no separate build number; omit Electron's bundle version.
    version: '',
    copyright: '',
    iconPath: development ? join(app.getAppPath(), 'resources', 'icon-windows.png')
      : join(process.resourcesPath, 'icon.png'),
  })
  // A custom application menu replaces Electron's default menu, so macOS needs
  // its standard menus and application hide commands declared explicitly.
  const darwin = process.platform === 'darwin'
  const platformMenus: MenuItemConstructorOptions[] = darwin
    ? [{ role: 'fileMenu' }, { role: 'editMenu' }, { role: 'windowMenu' }]
    : [{ role: 'editMenu' }]
  const hideCommands: MenuItemConstructorOptions[] = darwin
    ? [{ role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }]
    : []
  const applicationItems = (): MenuItemConstructorOptions[] => [
    { label: formatDesktopMessage(currentDesktopLocale().messages.aboutMenu, { version: desktopVersion }),
      click: () => { app.showAboutPanel() } },
    { type: 'separator' },
    { label: currentDesktopLocale().messages.checkUpdatesMenu, click: () => { void openUpdatePrompt(true) } },
    ...packagePolicy === undefined ? [] : [{
      label: currentDesktopLocale().messages.packageReview, click: () => { void reviewPackageChanges() },
    }],
    { type: 'separator' },
    ...hideCommands,
    { role: 'quit', ...(process.platform === 'win32' ? { label: currentDesktopLocale().messages.exitApplication } : {}) },
  ]
  Menu.setApplicationMenu(process.platform === 'win32' ? null : Menu.buildFromTemplate([{
    label: darwin ? app.name : currentDesktopLocale().messages.application,
    submenu: applicationItems(),
  }, ...platformMenus]))

  if (process.platform === 'win32') {
    ipcMain.handle(DESKTOP_IPC.windowsMenu, (event, name: unknown, x: unknown, y: unknown) => {
      assertDesktopSender(event, ['app'])
      if (mainWindow === undefined || event.sender !== mainWindow.webContents
        || event.senderFrame !== mainWindow.webContents.mainFrame) throw new Error('desktop menu: rejected sender')
      if ((name !== 'application' && name !== 'edit')
        || typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y)
        || x < 0 || y < 0 || x > 100_000 || y > 100_000) throw new Error('desktop menu: invalid popup request')
      const window = mainWindow
      // Editor-owned history listens to key events rather than Chromium's native undo stack.
      const editItem = (label: string, keyCode: string, modifiers: Array<'control'>, accelerator?: string): MenuItemConstructorOptions => ({
        label,
        ...(accelerator === undefined ? {} : { accelerator }),
        click: () => {
          window.webContents.focus()
          window.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
          window.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
        },
      })
      const items: MenuItemConstructorOptions[] = name === 'application' ? applicationItems() : [
        editItem(currentDesktopLocale().messages.undo, 'Z', ['control'], 'Ctrl+Z'),
        editItem(currentDesktopLocale().messages.redo, 'Y', ['control'], 'Ctrl+Y'),
        { type: 'separator' },
        editItem(currentDesktopLocale().messages.cut, 'X', ['control'], 'Ctrl+X'),
        editItem(currentDesktopLocale().messages.copy, 'C', ['control'], 'Ctrl+C'),
        editItem(currentDesktopLocale().messages.paste, 'V', ['control'], 'Ctrl+V'),
        editItem(currentDesktopLocale().messages.delete, 'Delete', []),
        { type: 'separator' },
        editItem(currentDesktopLocale().messages.selectAll, 'A', ['control'], 'Ctrl+A'),
      ]
      const zoom = mainWindow.webContents.getZoomFactor()
      return new Promise<void>((resolve) => {
        Menu.buildFromTemplate(items).popup({ window, x: Math.round(x * zoom), y: Math.round(y * zoom), callback: resolve })
      })
    })
    ipcMain.on(DESKTOP_IPC.windowsAppearance, (event, language: unknown, color: unknown, symbolColor: unknown) => {
      if (mainWindow === undefined || event.sender !== mainWindow.webContents
        || event.senderFrame !== mainWindow.webContents.mainFrame) return
      if (!event.senderFrame.url.startsWith(`${SCHEME}://app/`)) return
      if (typeof language === 'string' && /^[a-zA-Z]+(?:-[a-zA-Z0-9]+)*$/u.test(language)) {
        windowsLanguage = language
      }
      // Empty colors precede client stylesheet installation; only CSS color values cross IPC.
      const validColor = (value: unknown): value is string => typeof value === 'string'
        && /^(?:#[\da-f]{3,8}|rgba?\([\d.,%\s]+\))$/iu.test(value)
      if (validColor(color) && validColor(symbolColor)) mainWindow.setTitleBarOverlay({ color, symbolColor })
    })
  }

  const createMainWindow = (): BrowserWindow => {
    const window = createWindow(appPreload, true, true)
    mainWindow = window
    invalidateInputDocument()
    window.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
      if (mainWindow === window && isMainFrame && !inPlace) invalidateInputDocument()
    })
    window.webContents.on('did-finish-load', () => {
      if (mainWindow !== window || window.isDestroyed() || !window.webContents.getURL().startsWith(`${SCHEME}://app/`)) return
      invalidateInputDocument()
      inputDocumentReady = true
      window.webContents.send(DESKTOP_IPC.updatesImpactRequest, inputDocumentGeneration)
    })
    window.on('focus', automaticCheck)
    window.on('closed', () => { if (mainWindow === window) { mainWindow = undefined; invalidateInputDocument() } })
    window.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
      if (mainWindow === window && isMainFrame) invalidateInputDocument()
      if (isMainFrame && code !== -3 && !quitting && !window.isDestroyed()) {
        reportFatal(new Error(`Desktop page failed to load: ${url} (${String(code)}: ${description})`))
      }
    })
    window.webContents.on('preload-error', (_event, _path, error) => {
      if (mainWindow === window) invalidateInputDocument()
      if (!quitting && !window.isDestroyed()) reportFatal(error)
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      if (mainWindow === window) invalidateInputDocument()
      navigation = undefined
      if (!quitting && !window.isDestroyed() && details.reason !== 'clean-exit') {
        reportFatal(new Error(`Desktop renderer exited: ${details.reason}`))
      }
    })
    return window
  }
  focusPrimaryWindow = () => {
    if (quitting) return
    if (isMandatory()) { mandatoryUI?.focus(); return }
    const window = mainWindow
    if (window === undefined || window.isDestroyed()) {
      try { createMainWindow() } catch (error) { reportFatal(error); return }
      void navigateMain(applicationUrl).catch(reportFatal)
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
    shuttingDown = true
    baselineAbort.abort()
    updateJournal?.action('quit-requested')
    if (shellInstallerOwnsQuit) {
      updateDialog.dispose()
      mandatoryUI?.dispose()
      return
    }
    if (quitDrainComplete) return
    event.preventDefault()
    if (quitting) return
    quitting = true
    cancelLifecycleConsent()
    mainWindow?.hide()
    updateSchedule.dispose()
    updateDialog.dispose()
    mandatoryUI?.dispose()
    void Promise.allSettled([Promise.resolve(mandatoryPolicy?.dispose()).then(() => policyAuth?.dispose()),
      drainLifecycle()]).then((results) => {
      for (const result of results) if (result.status === 'rejected') console.error(result.reason)
      // Rejection is not proof that a detached helper stopped; keep the shell PID alive and every quit vetoed.
      if (managedHelperMayRun) {
        if (mainWindow !== undefined && !mainWindow.isDestroyed()) mainWindow.show()
        return
      }
      quitDrainComplete = true
      app.quit()
    })
  })

  mainWindow = createMainWindow()
  const manifestText = await readFile(join(app.getAppPath(), 'package.json'), 'utf8')
  if (lifecycleUnavailable()) return
  const manifest: unknown = JSON.parse(manifestText)
  if (typeof manifest !== 'object' || manifest === null) throw new Error('desktop policy: invalid application manifest')
  const developmentPolicy = app.isPackaged ? undefined : process.env.DSH_DESKTOP_MANDATORY_UPDATE_CONFIG
  const policyInput: unknown = app.isPackaged
    ? ('dshMandatoryUpdatePolicy' in manifest ? manifest.dshMandatoryUpdatePolicy : undefined)
    : developmentPolicy === undefined ? undefined : JSON.parse(developmentPolicy) as unknown
  const policyConfig = resolveDesktopPolicyConfig(policyInput, !app.isPackaged)
  if (policyConfig !== undefined) {
    if (policyConfig.authentication === 'feishu-test') {
      policyAuth = new DesktopPolicyTestAuth(policyConfig.origin, locale, () => mandatoryUI?.confirmationWindow ?? mainWindow,
        (event) => { console.info(`desktop policy authentication: ${event}`); updateJournal?.action(`policy-login-${event}`) })
    }
    const bundleId = app.isPackaged
      ? ('dshDesktopAppId' in manifest ? manifest.dshDesktopAppId : undefined)
      : process.env.DSH_DESKTOP_APP_ID
    if (typeof bundleId !== 'string' || bundleId.trim() === '') throw new Error('desktop policy: missing application bundle ID')
    if (!['win32', 'darwin'].includes(process.platform) || !['x64', 'arm64'].includes(process.arch)) throw new Error('desktop policy: unsupported platform')
    let wasBlocking = false
    mandatoryPolicy = new DesktopMandatoryUpdatePolicy(policyConfig, {
      platform: process.platform === 'win32' ? 'desktop-win' : 'desktop-mac', arch: process.arch as 'x64' | 'arm64',
      version: app.getVersion(), bundledDshVersion: app.isPackaged ? readDesktopRuntime(resources.dsh).release.version : app.getVersion(),
      bundleId, locale: locale.id,
    }, (state) => {
      if (state.error !== 'authentication-required') policyAuthenticationQueued = false
      if (state.blocking) {
        for (const controller of ordinaryDialogs) controller.abort()
        if (!wasBlocking) updateDialog.cancel()
      }
      mandatoryUI?.sync()
      if (state.blocking && !wasBlocking) void updateSchedule.check(false, true).catch((error: unknown) => { console.error(error) })
      wasBlocking = state.blocking
    }, policyAuth?.request)
    const policy = mandatoryPolicy
    mandatoryUI = new DesktopMandatoryUpdateWindow({
      preload: fileURLToPath(new URL('./preload-mandatory.cjs', import.meta.url)), locale,
      allowedPageOrigins: policyConfig.allowedPageOrigins, parent: () => mainWindow,
      policy: () => policy.state, update: () => updates.state,
      refresh: async () => { await Promise.all([checkPolicyManually(), updateSchedule.check(true)]) },
      download: downloadUpdate, install: version => updates.install(version),
    })
    void mandatoryPolicy.check('launch').then((state) => {
      if (app.isPackaged && state.error === 'authentication-required' && !isQuitting()) queuePolicyAuthentication()
    }).catch((error: unknown) => { console.error(error) })
  }
  automaticCheck()
  await reconcileBackend().catch(() => undefined)
  // Window lifecycle callbacks run while backend startup is pending.
  if (lifecycleUnavailable()) return
  if (managedRecoveryRequested) requestManagedRecovery()
  else if (managedCompletionIssue !== undefined && managedRecoveryOperation === undefined) {
    void showManagedCompletionIssue().then(async (checkUpdates) => {
      if (checkUpdates && managedRecoveryAvailable()) await openUpdatePrompt(true)
    }).catch((error: unknown) => { console.error(error) })
  }
  const window = currentMainWindow()
  if (window !== undefined && development && process.env.DSH_DESKTOP_OPEN_DEVTOOLS !== '0') {
    window.webContents.openDevTools({ mode: 'detach' })
  }
  publishUpdate(updateState)
}

const ownsDesktopInstance = claimDesktopSingleInstance(app, () => { focusPrimaryWindow() })
if (ownsDesktopInstance) app.on('second-instance', (_event, argv: string[]) => {
  if (argv.includes(MANAGED_UPDATE_RECOVERY_ARGUMENT)) requestManagedRecovery()
})

if (ownsDesktopInstance) void app.whenReady().then(main).catch(async (error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(error)
  const diagnosticFile = process.env.DSH_DESKTOP_DIAGNOSTIC_FILE
  if (diagnosticFile !== undefined) {
    await writeFile(diagnosticFile, `${error instanceof Error ? error.stack ?? message : message}\n`).catch(() => undefined)
  }
  reportFatal(error)
}).catch((error: unknown) => {
  console.error(error)
  app.exit(1)
})
