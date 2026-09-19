import { WINDOWS_TITLEBAR_HEIGHT } from '../src/windows-layout.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { IpcMainInvokeEvent } from 'electron'
import { join } from 'node:path'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import type { MenuItemConstructorOptions, MessageBoxOptions } from 'electron'
import { DESKTOP_IPC, type DesktopUpdateState } from '../src/ipc.ts'
import { MANDATORY_IPC } from '../src/mandatory-update-ipc.ts'
import { DesktopHostUncleanExitError } from '../src/host-process.ts'
import { en, zh, type DesktopMessages } from '../src/locale.ts'
import { DesktopUpdatePreparationError } from '../src/update-error.ts'
import type { DesktopManagedUpdateConfiguration } from '../src/managed-update-state.ts'
import type { DesktopManagedUpdateSelection } from '../src/managed-update-coordinator.ts'
import type { DesktopManagedUpdateAcknowledgement } from '../src/managed-update-launcher.ts'
import { managedCapability, managedManifest } from './managed-update-fixture.ts'
import type { DesktopPreparedPackageActivation, DesktopProvisioningAssessment } from '../src/profile-package-staging.ts'
import type { DesktopProfilePackageActivationOptions } from '../src/profile-package-activation.ts'
import type { ProfilePackageHealth } from '@deepseek-ai/dsh-app-boot'

const manifestRead = vi.hoisted(() => ({ read: undefined as (() => Promise<string>) | undefined }))

const baseline = vi.hoisted(() => ({
  assess: vi.fn<() => Promise<DesktopProvisioningAssessment>>(),
  commit: vi.fn(), stage: vi.fn(), create: vi.fn(), completion: vi.fn(),
  createdProfile: false,
}))

const packageReview = vi.hoisted(() => ({
  input: undefined as DesktopPreparedPackageActivation | undefined,
  confirmed: undefined as ((accepted: boolean) => void) | undefined,
  run: undefined as ((
    options: DesktopProfilePackageActivationOptions,
    input: DesktopPreparedPackageActivation,
  ) => Promise<void>) | undefined,
  beforeConfirm: undefined as (() => Promise<void>) | undefined,
  cleanup: undefined as (() => void | Promise<void>) | undefined,
}))

vi.mock('../src/profile-package-activation.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/profile-package-activation.ts')>()
  return { ...original, createDesktopProfilePackageActivation: (options: DesktopProfilePackageActivationOptions) => {
    const input = packageReview.input
    if (input === undefined) return original.createDesktopProfilePackageActivation(options)
    return {
      activate: async (transactionId: string) => {
        await packageReview.beforeConfirm?.()
        const accepted = await options.confirm(input)
        packageReview.confirmed?.(accepted)
        if (accepted) {
          if (packageReview.run === undefined) throw new Error('review-only fixture must not activate')
          await packageReview.run(options, input)
        }
        return { status: accepted ? 'committed' as const : 'cancelled' as const, transactionId }
      },
      recover: async () => { throw new Error('review-only fixture must not recover') },
    }
  } }
})

const managed = vi.hoisted(() => ({
  config: undefined as DesktopManagedUpdateConfiguration | undefined,
  messages: undefined as DesktopMessages | undefined,
  launch: undefined as ((selection: DesktopManagedUpdateSelection) => Promise<boolean>) | undefined,
  acknowledge: vi.fn<() => Promise<DesktopManagedUpdateAcknowledgement>>(),
  realLaunch: undefined as typeof import('../src/managed-update-launcher.ts').launchDesktopManagedUpdate | undefined,
  abandon: vi.fn(async () => {}),
}))

type InvokeEvent = { sender?: unknown; senderFrame: { url: string } }
type InvokeHandler = (event: InvokeEvent, ...args: unknown[]) => unknown

vi.mock('../src/web-document.ts', () => ({ authenticateWebHost: async () => 'test-cookie', serveWebDocument: vi.fn(), forwardWebRequest: vi.fn() }))

const harness = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
    return { promise, resolve, reject }
  }
  const windows: FakeWindow[] = []
  let windowFailure: Error | undefined
  const powerMonitor = new EventEmitter()
  const hosts: FakeHost[] = []
  const handlers = new Map<string, InvokeHandler>()
  let pluginsEnabled = false
  let prepareUpdate: (() => Promise<boolean>) | undefined
  let publishUpdate: ((state: DesktopUpdateState) => DesktopUpdateState) | undefined
  let preparing = deferred()
  let prepared = deferred()
  let hostStarted = deferred()
  let navigated = deferred()
  let dialogShown = deferred()
  let quitCompleted = deferred()
  let policyBlocked = deferred()
  let embeddedPolicy: unknown
  let closeWindowsOnQuit = false
  let drainingHosts = false
  let updateState: DesktopUpdateState = { phase: 'idle' }
  const updateCheck = vi.fn(async (_manual?: boolean): Promise<DesktopUpdateState> => updateState)
  const updateDownload = vi.fn(async (_version: string): Promise<DesktopUpdateState> => updateState)
  const updateInstall = vi.fn(async (_version: string): Promise<DesktopUpdateState> => updateState)
  const popup = vi.fn<(options: { window: FakeWindow; x?: number; y?: number; callback?: () => void }) => void>()
  const menuBuilder = vi.fn<(template: MenuItemConstructorOptions[]) => { popup: typeof popup }>(() => ({ popup }))
  const menu = Object.assign(menuBuilder, { buildFromTemplate: menuBuilder, setApplicationMenu: vi.fn() })
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly urls: string[] = []
    readonly webContents = Object.assign(new EventEmitter(), {
      id: 42,
      setWindowOpenHandler: vi.fn(),
      insertCSS: vi.fn(async () => 'blur'),
      removeInsertedCSS: vi.fn(async () => {}),
      openDevTools: vi.fn(),
      getURL: () => this.urls.at(-1) ?? '',
      mainFrame: { url: '' },
      getZoomFactor: () => 1,
      focus: vi.fn(),
      sendInputEvent: vi.fn(),
      send: vi.fn(),
    })
    readonly show = vi.fn()
    readonly hide = vi.fn()
    readonly focus = vi.fn()
    readonly restore = vi.fn()
    readonly setSize = vi.fn()
    readonly setEnabled = vi.fn()
    readonly setTitleBarOverlay = vi.fn()
    constructor(readonly options: { show: boolean; modal?: boolean }) {
      super(); if (windowFailure !== undefined) throw windowFailure; windows.push(this); if (options.modal) policyBlocked.resolve()
    }
    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    isFocused() { return true }
    async loadURL(url: string) {
      this.urls.push(url)
      this.webContents.mainFrame.url = url
      if (url === 'dsh-app://app/') navigated.resolve()
    }
    static getAllWindows() { return windows.filter(window => !window.destroyed) }
    setMenu() {}
    getContentBounds() { return { x: 0, y: 0, width: 900, height: 650 } }
    setBounds() {}
    setTitle = vi.fn()
    destroy() { this.destroyed = true; this.emit('closed') }
    close() {
      const event = { preventDefault: vi.fn() }
      this.emit('close', event)
      if (event.preventDefault.mock.calls.length === 0) this.destroy()
    }
  }
  class FakeHost {
    readonly pid = 456
    readonly updateTasks = vi.fn(async (_action: 'inspect' | 'lock' | 'unlock') => false)
    url = 'http://127.0.0.1:3080/?token=test'
    readonly ready = deferred()
    readonly exited = deferred()
    readonly stopping = deferred()
    packages: readonly ProfilePackageHealth[] = []
    readonly start = vi.fn(() => {
      hostStarted.resolve()
      return this.ready.promise.then(() => ({ url: this.url, injections: [], packages: this.packages }))
    })
    readonly stop = vi.fn(() => {
      this.stopping.resolve()
      this.ready.reject(new Error('child stopped'))
      return this.exited.promise
    })
    constructor(
      readonly node: string, readonly runtime: string, readonly profile: string,
      readonly inspectPort?: number, readonly environment?: NodeJS.ProcessEnv, readonly onFailure?: (error: Error) => void,
      readonly primaryRuntime?: string, readonly profileResolution?: string,
      readonly packageManager?: { pnpm: string; nodeBin: string },
      readonly packageTransactions?: unknown,
      readonly initiallyLocked?: boolean,
    ) {
      hosts.push(this)
      if (drainingHosts) { this.ready.resolve(); this.exited.resolve() }
    }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    getPath: () => 'desktop-test-userdata',
    name: 'Desktop test',
    whenReady: () => Promise.resolve(),
    getLocale: (): string => 'en-US',
    getVersion: () => '1.0.0',
    getAppPath: () => 'desktop-test-app',
    setAboutPanelOptions: vi.fn<(options: Electron.AboutPanelOptionsOptions) => void>(),
    requestSingleInstanceLock: () => true,
    exit: vi.fn(),
    relaunch: vi.fn(),
    quit: vi.fn(() => {
      const event = { preventDefault: vi.fn() }
      app.emit('before-quit', event)
      if (event.preventDefault.mock.calls.length === 0) {
        if (closeWindowsOnQuit) for (const window of [...windows]) if (!window.isDestroyed()) window.close()
        if (!closeWindowsOnQuit || windows.every(window => window.isDestroyed())) quitCompleted.resolve()
      }
    }),
  })
  return {
    failWindow(error: Error) { windowFailure = error },
    windows, hosts, handlers, app, FakeWindow, FakeHost, powerMonitor,
    menu, popup, socketHeaders: vi.fn(), updateCheck, updateDownload, updateInstall,
    ipcOn: vi.fn<(channel: string, listener: (event: { sender: unknown; senderFrame: unknown }, ...args: unknown[]) => void) => void>(),
    get updateState() { return updateState },
    set updateState(value: DesktopUpdateState) { updateState = value },
    get prepareUpdate() { return prepareUpdate! },
    set prepareUpdate(value: () => Promise<boolean>) { prepareUpdate = value },
    get publishUpdate() { return publishUpdate! },
    set publishUpdate(value: (state: DesktopUpdateState) => DesktopUpdateState) { publishUpdate = value },
    dialog: { showOpenDialog: vi.fn(), showErrorBox: vi.fn(), showMessageBox: vi.fn() },
    openExternal: vi.fn(),
    applyRelease: vi.fn(() => { preparing.resolve(); return prepared.promise }),
    disableAllPlugins: vi.fn(async () => {
      pluginsEnabled = false
      return 'desktop-test-profile/cordis.patch.yml.bak-1789555200000'
    }),
    get preparing() { return preparing }, get prepared() { return prepared },
    get hostStarted() { return hostStarted }, get navigated() { return navigated },
    get dialogShown() { return dialogShown }, get quitCompleted() { return quitCompleted },
    get policyBlocked() { return policyBlocked },
    get embeddedPolicy() { return embeddedPolicy },
    set embeddedPolicy(value: unknown) { embeddedPolicy = value },
    nextNavigation() { navigated = deferred(); return navigated.promise },
    nextHostStart() { hostStarted = deferred(); return hostStarted.promise },
    get pluginsEnabled() { return pluginsEnabled },
    set pluginsEnabled(value: boolean) { pluginsEnabled = value },
    set closeWindowsOnQuit(value: boolean) { closeWindowsOnQuit = value },
    drainHosts() {
      drainingHosts = true
      for (const host of hosts) { host.ready.resolve(); host.exited.resolve() }
    },
    reset() {
      windows.length = 0; hosts.length = 0; handlers.clear(); app.removeAllListeners()
      powerMonitor.removeAllListeners()
      app.isPackaged = true
      windowFailure = undefined
      pluginsEnabled = false
      closeWindowsOnQuit = false
      drainingHosts = false
      prepareUpdate = undefined
      publishUpdate = undefined
      updateState = { phase: 'idle' }
      updateCheck.mockReset().mockImplementation(async () => updateState)
      updateDownload.mockReset().mockImplementation(async () => updateState)
      updateInstall.mockReset().mockImplementation(async () => updateState)
      preparing = deferred(); prepared = deferred(); hostStarted = deferred()
      navigated = deferred(); dialogShown = deferred(); quitCompleted = deferred()
      policyBlocked = deferred()
      embeddedPolicy = undefined
    },
  }
})

const testAuth = vi.hoisted(() => ({ login: vi.fn<() => Promise<'returned' | 'cancelled' | 'failed'>>(),
  focus: vi.fn(), dispose: vi.fn(async () => {}) }))
vi.mock('../src/policy-test-auth.ts', () => ({ DesktopPolicyTestAuth: class {
  readonly login = testAuth.login
  readonly focus = testAuth.focus
  readonly dispose = testAuth.dispose
  readonly request: typeof fetch = (input, init) => fetch(input, init)
} }))

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: harness.FakeWindow,
  dialog: harness.dialog,
  shell: { openExternal: harness.openExternal },
  nativeTheme: { themeSource: 'system' },
  ipcMain: {
    on: harness.ipcOn,
    handle: (channel: string, handler: InvokeHandler) => {
      if (harness.handlers.has(channel)) throw new Error(`duplicate IPC handler ${channel}`)
      harness.handlers.set(channel, handler)
    },
    removeHandler: (channel: string) => { harness.handlers.delete(channel) },
  },
  Menu: { setApplicationMenu: harness.menu.setApplicationMenu, buildFromTemplate: harness.menu },
  session: { defaultSession: { webRequest: { onBeforeSendHeaders: harness.socketHeaders } } },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
  powerMonitor: harness.powerMonitor,
}))
vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>()
  return { ...original, readFile: vi.fn((path: Parameters<typeof original.readFile>[0], encoding?: 'utf8') => {
    if (path === join('desktop-test-app', 'package.json')) {
      return manifestRead.read?.() ?? Promise.resolve(JSON.stringify({ dshDesktopAppId: 'com.deepseek.dsh', dshMandatoryUpdatePolicy: harness.embeddedPolicy }))
    }
    return encoding === undefined ? original.readFile(path) : original.readFile(path, encoding)
  }) }
})
vi.mock('../src/runtime-tree.ts', () => ({ readDesktopRuntime: () => ({ release: { version: '1.0.0' } }) }))
vi.mock('../src/paths.ts', () => ({ resolveDesktopPaths: () => ({ profile: 'desktop-test-profile' }) }))
vi.mock('../src/managed-update-state.ts', () => ({ loadDesktopManagedUpdateConfiguration: async () => managed.config }))
vi.mock('../src/managed-update-node.ts', () => ({ resolveDesktopManagedNode: () => ({ path: 'verified-primary-node.exe', sha256: 'a'.repeat(64) }) }))
vi.mock('../src/managed-update-launcher.ts', async (importOriginal) => {
  const original = await importOriginal<typeof import('../src/managed-update-launcher.ts')>()
  managed.realLaunch = original.launchDesktopManagedUpdate
  return { ...original, launchDesktopManagedUpdate: managed.acknowledge }
})
vi.mock('../src/managed-update-completion.ts', () => ({ completeDesktopManagedUpdate: baseline.completion }))
vi.mock('../src/managed-update-coordinator.ts', () => ({ DesktopManagedUpdateCoordinator: class {
  constructor(_capability: unknown, _sequence: unknown, publish: (state: DesktopUpdateState) => DesktopUpdateState,
    launch: (selection: DesktopManagedUpdateSelection) => Promise<boolean>, _operations?: unknown, messages?: DesktopMessages) {
    managed.messages = messages
    managed.launch = launch
    harness.publishUpdate = publish
  }
  get state() { return harness.updateState }
  readonly check = harness.updateCheck
  readonly download = harness.updateDownload
  readonly install = harness.updateInstall
  readonly dispose = vi.fn()
} }))
vi.mock('../src/profile-package-runtime.ts', () => ({
  loadDesktopPackagePolicy: () => ({ dependencyRegistry: 'https://registry.example.test/', provisioningPlan: { schemaVersion: 1, mode: 'exact',
    plugins: [{ required: true, source: { packageName: 'fixture-provider', version: '1.0.0' } }] }, provisioningPlanFile: 'fixture-plan.json' }),
  createDesktopPackageBackend: baseline.create,
}))
vi.mock('../src/project-manager.ts', () => ({
  DesktopProjectManager: class {
    readonly applyRelease = harness.applyRelease
    get createdProfile() { return baseline.createdProfile }
    disableAllPlugins = harness.disableAllPlugins

  },
}))
vi.mock('../src/host-process.ts', async importOriginal => ({
  ...await importOriginal<typeof import('../src/host-process.ts')>(), DesktopHostProcess: harness.FakeHost,
}))
vi.mock('../src/update-dialog.ts', () => ({ DesktopUpdateDialog: class {
  show(owner: { options: { modal?: boolean } }, options: unknown) {
    return (owner.options.modal ? harness.dialog.showMessageBox(owner, options)
      : harness.dialog.showMessageBox(options)) as Promise<Electron.MessageBoxReturnValue>
  }
  cancel() {}
  focus() {}
  dispose() {}
} }))
vi.mock('../src/update-coordinator.ts', () => ({ DesktopUpdateCoordinator: class {
  constructor(publish: (state: DesktopUpdateState) => DesktopUpdateState, beforeRestart: () => Promise<boolean>) {
    harness.prepareUpdate = beforeRestart
    harness.publishUpdate = publish
  }
  get state() { return harness.updateState }
  readonly check = harness.updateCheck
  readonly download = harness.updateDownload
  readonly install = harness.updateInstall
  readonly dispose = vi.fn()
} }))

function invoke(channel: string, origin = channel === DESKTOP_IPC.boot ? 'app' : 'shell', ...args: unknown[]): unknown {
  const handler = harness.handlers.get(channel)
  if (handler === undefined) throw new Error(`missing handler ${channel}`)
  if (origin === 'app') {
    const sender = harness.windows[0]!.webContents
    return handler({ sender, senderFrame: sender.mainFrame }, ...args)
  }
  return handler({ senderFrame: { url: `dsh-app://${origin}/index.html` } }, ...args)
}

function applicationMenuItems(): MenuItemConstructorOptions[] {
  const native = harness.menu.mock.calls[0]?.[0][0]?.submenu
  if (Array.isArray(native)) return native
  const sender = harness.windows[0]!.webContents
  void harness.handlers.get(DESKTOP_IPC.windowsMenu)!({ sender, senderFrame: sender.mainFrame }, 'application', 0, 0)
  return harness.menu.mock.lastCall![0]
}

beforeEach(() => {
  manifestRead.read = undefined
  managed.config = undefined
  managed.messages = undefined
  managed.launch = undefined
  managed.acknowledge.mockReset()
  managed.abandon.mockClear()
  vi.resetModules()
  vi.clearAllMocks()
  baseline.createdProfile = false
  packageReview.input = undefined
  packageReview.confirmed = undefined
  packageReview.run = undefined
  packageReview.beforeConfirm = undefined
  packageReview.cleanup = undefined
  baseline.assess.mockReset().mockResolvedValue({ status: 'preserved-user-choice', reason: 'ambiguous-legacy', packageName: 'fixture-provider',
    planSha256: 'a'.repeat(64), planResourceSha256: 'b'.repeat(64) })
  baseline.stage.mockReset()
  baseline.commit.mockReset().mockResolvedValue({ planSha256: 'a'.repeat(64) })
  baseline.completion.mockReset().mockResolvedValue({ status: 'none' })
  baseline.create.mockReset().mockImplementation(() => ({ protocolVersion: 1, stage: vi.fn(), status: vi.fn(), cancel: vi.fn(),
    listPending: async () => packageReview.input === undefined ? [] : [packageReview.input.prepared],
    assessProvisioning: baseline.assess, commitSatisfiedProvisioning: baseline.commit, stageProvisioning: baseline.stage,
  }))
  harness.dialog.showMessageBox.mockReset()
  harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
  testAuth.login.mockReset()
  testAuth.login.mockResolvedValue('cancelled')
  vi.useFakeTimers()
  harness.reset()
  harness.dialog.showMessageBox.mockImplementation((options: { title?: string }) => {
    if (options.title !== en.startupFailed) return Promise.resolve({ response: 1 })
    harness.dialogShown.resolve()
    return new Promise(() => {})
  })
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', 'test-pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', 'test-runtime')
  vi.stubGlobal('process', { ...process, platform: 'win32', resourcesPath: 'desktop-test-resources' })
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
  vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', undefined)
  vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', undefined)
})

afterEach(async () => {
  harness.prepared.resolve()
  harness.drainHosts()
  await packageReview.cleanup?.()
  harness.app.quit()
  await harness.quitCompleted.promise
  vi.restoreAllMocks()
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('desktop main startup', () => {
  it.each([
    ['darwin', true, 'en-US'],
    ['darwin', false, 'zh-CN'],
    ['win32', true, 'zh-CN'],
    ['win32', false, 'en-US'],
  ] as const)('offers the native About panel before other commands on %s (packaged=%s, locale=%s)', async (platform, packaged, locale) => {
    vi.stubGlobal('process', { ...process, platform })
    harness.app.isPackaged = packaged
    vi.spyOn(harness.app, 'getLocale').mockReturnValue(locale)
    await readyForUpdate()
    const submenu = applicationMenuItems()
    const options = harness.app.setAboutPanelOptions.mock.calls[0]![0]
    const expected = JSON.parse(readFileSync(new URL('./expected/about-panel.json', import.meta.url), 'utf8')) as Record<string, unknown>
    expect({ menu: submenu.slice(0, 2), options: { ...options, iconPath: '<app icon>' } }).toEqual(expected[locale])
    expect(options.iconPath).toBe(packaged ? join('desktop-test-resources', 'icon.png')
      : join('desktop-test-app', 'resources', 'icon-windows.png'))
  })

  it('shows one explained startup login before Host readiness and joins concurrent checks without reopening it', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', authentication: 'feishu-test',
      allowedPageOrigins: ['https://downloads.example.com'], intervalMs: 1000, jitter: 0 }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 })))
    const explanation = Promise.withResolvers<{ response: number }>()
    const explained = Promise.withResolvers<undefined>()
    const login = Promise.withResolvers<'cancelled'>()
    const entered = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementationOnce(() => { explained.resolve(undefined); return explanation.promise })
    testAuth.login.mockImplementationOnce(() => { entered.resolve(undefined); return login.promise })
    const checks: Promise<unknown>[] = []
    try {
      await import('../src/main.ts')
      await explained.promise
      expect(harness.hosts).toHaveLength(0)
      expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
      expect(harness.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
        message: en.policyLoginRequired, buttons: [en.policyLogin, en.later], cancelId: 1,
      }))
      checks.push(Promise.resolve(invoke(DESKTOP_IPC.updatesOpen, 'app')))
      expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
      expect(testAuth.login).not.toHaveBeenCalled()
      explanation.resolve({ response: 0 })
      await entered.promise
      checks.push(Promise.resolve(invoke(DESKTOP_IPC.updatesOpen, 'app')))
      expect(testAuth.focus).toHaveBeenCalled()
      expect(testAuth.login).toHaveBeenCalledOnce()
      expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
      login.resolve('cancelled')
      await Promise.all(checks)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(testAuth.login).toHaveBeenCalledOnce()
      const messages = harness.dialog.showMessageBox.mock.calls.map(call => (call.at(-1) as { message: string }).message)
      expect(messages.filter(message => message === en.policyLoginRequired)).toHaveLength(1)
      expect(messages).toContain('No updates available. Current version: V1.0.0')
    } finally {
      explanation.resolve({ response: 1 })
      login.resolve('cancelled')
      await Promise.allSettled(checks)
    }
  })

  it.each(['returned', 'cancelled', 'failed'] as const)('requires explicit test login and handles %s without downloading', async (outcome) => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', authentication: 'feishu-test',
      allowedPageOrigins: ['https://downloads.example.com'], intervalMs: 10_000, jitter: 0 }
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 }))
    vi.stubGlobal('fetch', request)
    await readyForUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(testAuth.login).not.toHaveBeenCalled()
    expect(harness.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({ message: en.policyLoginRequired }))
    harness.dialog.showMessageBox.mockClear()
    testAuth.login.mockImplementationOnce(async () => {
      request.mockImplementation(async () => Response.json({ code: 0, data: { biz_code: 0, biz_data: null } }))
      return outcome
    })
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(testAuth.login).toHaveBeenCalledOnce()
    expect(harness.dialog.showMessageBox.mock.calls.map(call => call.at(-1) as unknown)).toContainEqual(expect.objectContaining({
      message: en.policyLoginRequired, buttons: [en.policyLogin, en.later],
    }))
    expect(harness.updateDownload).not.toHaveBeenCalled()
    expect(harness.updateInstall).not.toHaveBeenCalled()
    const messages = harness.dialog.showMessageBox.mock.calls.map(call => (call.at(-1) as { message: string }).message)
    const expected = JSON.parse(readFileSync(new URL('./expected/policy-login-en.json', import.meta.url), 'utf8')) as Record<string, string[]>
    expect(messages).toEqual(expected[outcome])
  })

  it('does not open Feishu when the user declines test login', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', authentication: 'feishu-test',
      allowedPageOrigins: ['https://downloads.example.com'] }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 })))
    await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(testAuth.login).not.toHaveBeenCalled()
  })

  it('does not require gateway login to download an already available ordinary update', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', authentication: 'feishu-test',
      allowedPageOrigins: ['https://downloads.example.com'] }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 })))
    await readyForUpdate()
    await vi.advanceTimersByTimeAsync(0)
    harness.updateState = { phase: 'available', version: '1.0.1-nightly.1' }
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.updateDownload).toHaveBeenCalledWith('1.0.1-nightly.1')
    expect(testAuth.login).not.toHaveBeenCalled()
  })

  it('retains the same blocking window and running Host after expired test login is cancelled', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', authentication: 'feishu-test',
      allowedPageOrigins: ['https://downloads.example.com'], intervalMs: 1000, jitter: 0 }
    const request = vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ code: 40005, data: { show_content: { title: 'Update', detail: 'Required' },
        desktop_app_link: 'https://downloads.example.com/' } }))
    vi.stubGlobal('fetch', request)
    const host = await readyForUpdate()
    await harness.policyBlocked.promise
    await vi.advanceTimersByTimeAsync(1000)
    const modal = harness.windows.find(window => window.options.modal)!
    const owned = { sender: modal.webContents, senderFrame: modal.webContents.mainFrame }
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    testAuth.login.mockResolvedValueOnce('cancelled')
    await harness.handlers.get(MANDATORY_IPC.action)!(owned, 'refresh')
    expect(testAuth.login).toHaveBeenCalledOnce()
    expect(harness.handlers.get(MANDATORY_IPC.status)!(owned)).toMatchObject({
      policy: { blocking: true, error: 'authentication-required' },
    })
    expect(modal.isDestroyed()).toBe(false)
    expect(host.stop).not.toHaveBeenCalled()
    expect(harness.updateDownload).not.toHaveBeenCalled()
  })

  it('persists opt-in update evidence from the real main entry without private diagnostics', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'dsh-main-update-journal-'))
    try {
      vi.stubEnv('DSH_DESKTOP_UPDATE_JOURNAL_DIR', directory)
      await readyForUpdate()
      harness.publishUpdate({ phase: 'error', failedOperation: 'download', version: '1.2.3', message: 'ENOSPC secret-url' })
      const checkUpdates = applicationMenuItems().find(item => item.label === en.checkUpdatesMenu)!.click as () => void
      checkUpdates()
      await vi.advanceTimersByTimeAsync(0)
      for (const host of harness.hosts) host.exited.resolve()
      harness.app.quit()
      await harness.quitCompleted.promise
      const files = readdirSync(directory)
      expect(files).toHaveLength(1)
      const contents = readFileSync(join(directory, files[0]!), 'utf8')
      const records = contents.trim().split('\n').map(line => JSON.parse(line) as { event: string })
      expect(records.map(row => row.event)).toEqual(expect.arrayContaining(['started', 'workspace-ready', 'state', 'check-requested', 'quit-requested']))
      expect(contents).toContain('ENOSPC')
      expect(contents).not.toContain('secret-url')
    } finally {
      // The existing teardown calls quit again; retain its journal until listeners are removed.
      harness.app.removeAllListeners('before-quit')
      rmSync(directory, { recursive: true, force: true })
    }
  })

  it('accepts update IPC only from the current application top frame in the owned main window', async () => {
    await readyForUpdate()
    const handler = harness.handlers.get(DESKTOP_IPC.updatesStatus)!
    const sender = harness.windows[0]!.webContents
    expect(() => handler({ sender, senderFrame: sender.mainFrame })).not.toThrow()
    for (const event of [
      { sender: {}, senderFrame: sender.mainFrame },
      { sender, senderFrame: { url: sender.mainFrame.url } },
      { sender, senderFrame: { url: 'http://127.0.0.1:40000/' } },
    ]) expect(() => handler(event)).toThrow('unowned renderer')
    const original = sender.mainFrame.url
    sender.mainFrame.url = 'http://127.0.0.1:40000/'
    expect(() => handler({ sender, senderFrame: sender.mainFrame })).toThrow('unowned renderer')
    sender.mainFrame.url = original
  })

  it.each(['darwin', 'win32', 'linux'] as const)('limits native titlebar styling to macOS on %s', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    expect(window.urls).toEqual(['dsh-app://app/'])
    if (platform === 'darwin') {
      expect(window.options).toMatchObject({ titleBarStyle: 'hiddenInset', vibrancy: 'sidebar', backgroundColor: '#00000000' })
    } else if (platform === 'win32') {
      expect(window.options).toMatchObject({ titleBarStyle: 'hidden', titleBarOverlay: { height: WINDOWS_TITLEBAR_HEIGHT } })
      expect(window.options).not.toHaveProperty('vibrancy')
      expect(harness.menu.setApplicationMenu).toHaveBeenCalledWith(null)
    } else {
      expect(window.options).not.toHaveProperty('titleBarStyle')
      expect(window.options).not.toHaveProperty('vibrancy')
    }
    expect(harness.hosts).toHaveLength(0)
  })

  it('follows the Windows primary document language and palette without trusting other frames', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const listener = harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.windowsAppearance)![1]
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    listener({ ...event, senderFrame: { url: 'dsh-app://app/' } }, 'zh-CN', '#ffffff', '#000000')
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    listener(event, 'zh-CN', 'rgb(249, 250, 251)', '#0f1115')
    expect(window.setTitleBarOverlay).toHaveBeenCalledWith({ color: 'rgb(249, 250, 251)', symbolColor: '#0f1115' })
    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: 'text', editFlags: { canCopy: true } })
    expect(harness.menu.buildFromTemplate).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, label: '复制', accelerator: '' }])
    listener(event, 'en', '#1b1b1c', '#f9fafb')
    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: 'text', editFlags: { canCopy: true } })
    expect(harness.menu.buildFromTemplate).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, label: 'Copy', accelerator: '' }])
    window.setTitleBarOverlay.mockClear()
    listener(event, 'en', 'url(file:///bad)', '#fff')
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    listener(event, {}, '#fff', '#000')
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith({ color: '#fff', symbolColor: '#000' })
    window.setTitleBarOverlay.mockClear()
    window.webContents.mainFrame.url = 'dsh-app://unowned/index.html'
    listener(event, 'zh-CN', '#fff', '#000')
    expect(window.setTitleBarOverlay).not.toHaveBeenCalled()
    expect(harness.menu.setApplicationMenu).toHaveBeenCalledExactlyOnceWith(null)
  })

  it('maps Windows caption menus to localized native commands and rejects foreign popup requests', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame }
    const appearance = harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.windowsAppearance)![1]
    appearance(event, 'zh-CN', '#fff', '#000')
    const handler = harness.handlers.get(DESKTOP_IPC.windowsMenu)!
    const foreignEvent = { ...event, sender: {} }
    expect(() => handler(foreignEvent, 'application', 48, 34)).toThrow('rejected sender')
    expect(() => handler(event, 'arbitrary-command', 48, 34)).toThrow('invalid popup request')
    expect(() => handler(event, 'application', NaN, 34)).toThrow('invalid popup request')
    const application = handler(event, 'application', 48, 34)
    expect(harness.menu.buildFromTemplate.mock.lastCall![0].map(item => item.label ?? item.type)).toEqual([
      '关于 DeepSeek Harness', 'separator', '检查更新…', 'separator', '退出',
    ])
    expect(harness.popup.mock.lastCall![0]).toMatchObject({ window, x: 48, y: 34 })
    expect(harness.popup.mock.lastCall![0].callback).toBeTypeOf('function')
    harness.popup.mock.lastCall![0].callback!()
    await application
    const edit = handler(event, 'edit', 104, 34)
    expect(harness.menu.buildFromTemplate.mock.lastCall![0].map(item => item.label ?? item.type)).toEqual([
      '撤销', '重做', 'separator', '剪切', '复制', '粘贴', '删除', 'separator', '全选',
    ])
    const commands = harness.menu.buildFromTemplate.mock.lastCall![0].filter(item => item.type !== 'separator')
    for (const [index, keyCode] of ['Z', 'Y', 'X', 'C', 'V', 'Delete', 'A'].entries()) {
      const click = commands[index]!.click as () => void
      click()
      const modifiers = keyCode === 'Delete' ? [] : ['control']
      expect(window.webContents.sendInputEvent).toHaveBeenNthCalledWith(index * 2 + 1, { type: 'keyDown', keyCode, modifiers })
      expect(window.webContents.sendInputEvent).toHaveBeenNthCalledWith(index * 2 + 2, { type: 'keyUp', keyCode, modifiers })
    }
    harness.popup.mock.lastCall![0].callback!()
    await edit
  })

  it.each(['darwin', 'linux'] as const)('adds the standard macOS window commands only on macOS (%s)', async (platform) => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue(platform)
    await import('../src/main.ts')
    await harness.preparing.promise
    const describeItem = (item: MenuItemConstructorOptions): string | undefined =>
      item.role ?? (item.type === 'separator' ? 'separator' : item.label)
    const template = harness.menu.buildFromTemplate.mock.calls
      .map(call => call[0])
      .find(items => items.some(item => item.role === 'editMenu'))
    if (template === undefined) throw new Error('application menu missing')
    expect(template.map(describeItem)).toEqual(platform === 'darwin'
      ? ['Desktop test', 'fileMenu', 'editMenu', 'windowMenu']
      : ['Application', 'editMenu'])
    const application = template[0]!.submenu as MenuItemConstructorOptions[]
    expect(application.map(describeItem)).toEqual(platform === 'darwin'
      ? ['about', 'separator', en.checkUpdatesMenu, 'separator', 'hide', 'hideOthers', 'unhide', 'separator', 'quit']
      : ['about', 'separator', en.checkUpdatesMenu, 'separator', 'quit'])
    expect(harness.menu.setApplicationMenu).toHaveBeenCalledOnce()
  })

  it('attaches Host socket credentials only to the owned application origin and window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    const handler = harness.socketHeaders.mock.calls[0]![1] as (
      details: { url: string; webContentsId: number; requestHeaders: Record<string, string> },
      callback: (result: unknown) => void,
    ) => void
    const callback = vi.fn()
    const details = { url: 'ws://127.0.0.1:3080/api/remote.mux', webContentsId: 42, requestHeaders: { Origin: 'dsh-app://app' } }
    handler(details, callback)
    expect(callback).toHaveBeenLastCalledWith({ requestHeaders: {
      origin: 'http://127.0.0.1:3080', cookie: 'test-cookie', 'sec-fetch-site': 'same-origin',
    } })
    handler({ ...details, requestHeaders: { Origin: 'https://other.example' } }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    handler({ ...details, webContentsId: 43 }, callback)
    expect(callback).toHaveBeenLastCalledWith({})
    handler({ ...details, url: 'ws://127.0.0.1:9999/api/remote.mux' }, callback)
    expect(callback).toHaveBeenLastCalledWith({})
  })

  it('registers the window-owned directory picker during startup and rejects foreign callers', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const handler = harness.handlers.get(DESKTOP_IPC.directoryPick) as (event: IpcMainInvokeEvent) => Promise<string | null>
    expect(handler).toBeTypeOf('function')
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame } as unknown as IpcMainInvokeEvent
    harness.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/workspace'] })
    await expect(handler(event)).resolves.toBe('/workspace')
    expect(harness.dialog.showOpenDialog).toHaveBeenCalledExactlyOnceWith(window, { properties: ['openDirectory', 'createDirectory'] })
    window.webContents.mainFrame.url = 'https://other.example/'
    await expect(handler(event)).rejects.toThrow('unowned renderer')
  })

  it('holds boot injections until the Host is ready and rejects foreign boot callers', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const handler = harness.handlers.get(DESKTOP_IPC.boot)!
    await expect(handler({ senderFrame: { url: 'https://other.example/' } })).rejects.toThrow('unowned renderer')
    let settled = false
    const boot = Promise.resolve(handler({ senderFrame: { url: 'dsh-app://app/' } })).then((value) => { settled = true; return value })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
    harness.prepared.resolve()
    await harness.hostStarted.promise
    expect(settled).toBe(false)
    harness.hosts[0]!.ready.resolve()
    await expect(boot).resolves.toEqual({ injections: [], streamBaseUrl: 'http://127.0.0.1:3080' })
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
  })

  it('retains macOS native editing actions on right-click and only copy for selected read-only text', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin')
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const editFlags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canSelectAll: true }
    harness.menu.mockClear()

    window.webContents.emit('context-menu', {}, { isEditable: true, selectionText: 'text', editFlags })
    expect(harness.menu).toHaveBeenLastCalledWith([
      { role: 'undo', enabled: true, accelerator: '' }, { role: 'redo', enabled: false, accelerator: '' },
      { type: 'separator', accelerator: '' },
      { role: 'cut', enabled: true, accelerator: '' }, { role: 'copy', enabled: true, accelerator: '' },
      { role: 'paste', enabled: true, accelerator: '' }, { type: 'separator', accelerator: '' },
      { role: 'selectAll', enabled: true, accelerator: '' },
    ])
    expect(harness.popup).toHaveBeenCalledWith({ window })

    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: 'text', editFlags })
    expect(harness.menu).toHaveBeenLastCalledWith([{ role: 'copy', enabled: true, accelerator: '' }])

    harness.menu.mockClear()
    window.webContents.emit('context-menu', {}, { isEditable: false, selectionText: '', editFlags })
    expect(harness.menu).not.toHaveBeenCalled()
  })

  it('opens message links externally while retaining same-origin application navigation', async () => {
    await readyForUpdate()
    const window = harness.windows[0]!
    const openWindow = window.webContents.setWindowOpenHandler.mock.calls[0]![0] as
      (details: { url: string }) => { action: string }
    const source = 'https://example.com/source?q=reference'
    expect(openWindow({ url: source })).toEqual({ action: 'deny' })
    expect(harness.openExternal).toHaveBeenCalledWith(source)
    harness.openExternal.mockClear()
    const external = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', external, 'https://example.com/document')
    expect(external.preventDefault).toHaveBeenCalledOnce()
    expect(harness.openExternal).toHaveBeenCalledWith('https://example.com/document')
    harness.openExternal.mockClear()
    const internal = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', internal, 'dsh-app://app/session/task-1')
    expect(internal.preventDefault).not.toHaveBeenCalled()
    expect(harness.openExternal).not.toHaveBeenCalled()
  })

  function reportInput(impact: unknown) {
    const sender = harness.windows[0]!.webContents
    const listener = harness.ipcOn.mock.calls.find(([channel]) => channel === DESKTOP_IPC.updatesImpact)![1]
    const generation: unknown = sender.send.mock.calls.findLast(([channel]) => channel === DESKTOP_IPC.updatesImpactRequest)?.[1]
    listener({ sender, senderFrame: sender.mainFrame }, generation, impact)
  }

  async function readyForUpdate() {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    harness.windows[0]!.webContents.emit('did-finish-load')
    reportInput({ hasDraft: false, attachmentCount: 0, submitting: false })
    return harness.hosts[0]!
  }

  it('hides the workspace before intentional Host shutdown can look like reconnection', async () => {
    const host = await readyForUpdate()
    const window = harness.windows[0]!
    window.show.mockClear()
    window.focus.mockClear()
    harness.app.quit()
    expect(window.hide).toHaveBeenCalledOnce()
    await host.stopping.promise
    harness.app.emit('second-instance')
    expect(window.show).not.toHaveBeenCalled()
    expect(window.focus).not.toHaveBeenCalled()
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('shares the failed-check deadline across focus and resume, while explicit checks reset polling', async () => {
    vi.stubEnv('DSH_DESKTOP_UPDATE_CHECK_INTERVAL_MS', '1000')
    vi.stubEnv('DSH_DESKTOP_UPDATE_CHECK_MAX_BACKOFF_MS', '4000')
    vi.stubEnv('DSH_DESKTOP_UPDATE_CHECK_JITTER', '0')
    harness.updateCheck.mockResolvedValue({ phase: 'error', failedOperation: 'check', message: 'offline' })
    const host = await readyForUpdate()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.updateCheck).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1999)
    harness.windows[0]!.emit('focus')
    harness.powerMonitor.emit('resume')
    expect(harness.updateCheck).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.updateCheck).toHaveBeenCalledTimes(2)
    harness.updateCheck.mockResolvedValue({ phase: 'idle' })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.updateCheck).toHaveBeenLastCalledWith(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(harness.updateCheck).toHaveBeenCalledTimes(4)
    harness.app.quit()
    try {
      await host.stopping.promise
      await vi.advanceTimersByTimeAsync(10_000)
      harness.powerMonitor.emit('resume')
      expect(harness.updateCheck).toHaveBeenCalledTimes(4)
      expect(vi.getTimerCount()).toBe(0)
    } finally { host.exited.resolve(); await harness.quitCompleted.promise }
  })

  it('blocks subsequent product operations without stopping the Host and clears only on a fresh no-force policy', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com',
      allowedPageOrigins: ['https://downloads.example.com'], intervalMs: 10_000, jitter: 0 }
    vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_CONFIG', '{invalid environment override}')
    const request = vi.fn<typeof fetch>().mockImplementation(async () => Response.json({ code: 40005,
      data: { show_content: { title: 'Update required', detail: 'Please update' }, desktop_app_link: 'https://downloads.example.com/' } }))
    vi.stubGlobal('fetch', request)
    const host = await readyForUpdate()
    await harness.policyBlocked.promise
    const modal = harness.windows.find(window => window.options.modal)!
    expect(modal).toBeDefined()
    const status = harness.handlers.get(MANDATORY_IPC.status)!
    const action = harness.handlers.get(MANDATORY_IPC.action)!
    const owned = { sender: modal.webContents, senderFrame: modal.webContents.mainFrame }
    expect(status(owned)).toMatchObject({ policy: { blocking: true } })
    const unowned = [
      { ...owned, sender: harness.windows[0]!.webContents },
      { ...owned, senderFrame: { url: 'dsh-app://app/index.html' } },
      { ...owned, senderFrame: { url: 'https://untrusted.example.com/' } },
    ]
    for (const event of unowned) {
      expect(() => status(event)).toThrow('unowned renderer')
      expect(() => action(event, 'download', '1.0.1-nightly.1')).toThrow('unowned renderer')
    }
    expect(() => action(owned, 'open-arbitrary-url')).toThrow('invalid action')
    expect(() => action(owned, 'download')).toThrow('missing confirmed version')
    expect(() => action(owned, 'install', 123)).toThrow('missing confirmed version')
    expect(harness.updateDownload).not.toHaveBeenCalled()
    expect(harness.updateInstall).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
    expect(harness.updateDownload).not.toHaveBeenCalled()
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    request.mockImplementationOnce(async () => Response.json({ code: 500 }, { status: 503 }))
    await vi.advanceTimersByTimeAsync(10_000)
    expect(modal.isDestroyed()).toBe(false)
    expect(host.stop).not.toHaveBeenCalled()
    request.mockImplementationOnce(async () => Response.json({ code: 0, data: { biz_code: 0, biz_data: null } }))
    await vi.advanceTimersByTimeAsync(20_000)
    expect(modal.isDestroyed()).toBe(true)
    expect(host.stop).not.toHaveBeenCalled()
    expect(request.mock.calls[0]![1]!.headers).toMatchObject({ 'x-client-bundle-id': 'com.deepseek.dsh', 'x-client-version': '1.0.0' })
  })

  it('keeps one checking dialog open until the manual check settles, then reports the current version', async () => {
    await readyForUpdate()
    const checked = Promise.withResolvers<DesktopUpdateState>()
    const checking = Promise.withResolvers<AbortSignal>()
    const requested = Promise.withResolvers<undefined>()
    harness.updateCheck.mockImplementationOnce(() => { requested.resolve(undefined); return checked.promise })
    harness.dialog.showMessageBox.mockImplementationOnce(({ signal }: { signal: AbortSignal }) => {
      checking.resolve(signal)
      return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve({ response: 0 }) }, { once: true }) })
    }).mockResolvedValueOnce({ response: 0 })
    const submenu = applicationMenuItems()
    const action = submenu.find(item => item.label === 'Check for Updates…')
    expect(action?.click).toBeTypeOf('function')
    // Electron supplies menu arguments that this callback does not consume.
    Reflect.apply(action!.click!, undefined, [])
    const prompt = Promise.resolve(invoke(DESKTOP_IPC.updatesOpen, 'app'))
    const signal = await checking.promise
    await requested.promise
    expect(signal.aborted).toBe(false)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(1)
    expect(harness.updateCheck).toHaveBeenLastCalledWith(true)
    checked.resolve({ phase: 'idle' })
    await prompt
    expect(signal.aborted).toBe(true)
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      message: 'No updates available. Current version: V1.0.0',
    }))
  })

  it('reports a manual check failure without offering a download', async () => {
    await readyForUpdate()
    harness.updateCheck.mockResolvedValueOnce({ phase: 'error', failedOperation: 'check', message: 'Feed unavailable' })
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error',
      message: 'Could not check for updates. Please try again later.', technicalDetails: 'Feed unavailable' }))
    expect(harness.updateDownload).not.toHaveBeenCalled()
  })

  it.each([
    ['en-US', en, 'Could not download the update manifest: the connection was reset (ECONNRESET).\nCheck your network connection and try again.'],
    ['zh-CN', zh, '下载更新清单时连接被重置（ECONNRESET）。\n请检查网络连接后重试。'],
  ] as const)('keeps %s managed network details in the native dialog and sends only semantic Web status', async (locale, messages, technicalDetails) => {
    managedFixture()
    harness.updateState = { phase: 'idle', mode: 'github-release-managed' }
    vi.spyOn(harness.app, 'getLocale').mockReturnValue(locale)
    const host = await readyForUpdate()
    expect(managed.messages).toEqual(messages)
    const failed: DesktopUpdateState = { phase: 'error', mode: 'github-release-managed', failedOperation: 'check',
      message: 'Could not download the update manifest: the connection was reset (ECONNRESET).\nCheck your network connection and try again.',
      technicalDetails }
    harness.updateCheck.mockImplementationOnce(async () => {
      harness.updateState = failed
      return harness.publishUpdate(failed)
    })
    const shown = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementation((options: { type?: string }) => {
      if (options.type === 'error') shown.resolve(undefined)
      return Promise.resolve({ response: 0 })
    })
    // The status indicator owns the preserved-baseline notice; the menu still checks updates.
    const action = applicationMenuItems().find(item => item.label === messages.checkUpdatesMenu)
    expect(action?.click).toBeTypeOf('function')
    Reflect.apply(action!.click!, undefined, [])
    await shown.promise
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({
      type: 'error', message: messages.updateCheckFailed, technicalDetails,
    }))
    const presentation = await invoke(DESKTOP_IPC.updatesStatus, 'app')
    expect(presentation).toMatchObject({ phase: 'error', mode: 'github-release-managed', failure: 'check' })
    expect(presentation).not.toHaveProperty('message')
    expect(presentation).not.toHaveProperty('technicalDetails')
    expect(harness.windows[0]!.webContents.send).toHaveBeenCalledWith(DESKTOP_IPC.updatesPresentation, presentation)
    expect(harness.updateDownload).not.toHaveBeenCalled()
    expect(harness.updateInstall).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('reports a stale download confirmation as a download failure', async () => {
    await readyForUpdate()
    harness.updateCheck.mockResolvedValueOnce({ phase: 'available', version: '1.0.1-nightly.1' })
    harness.updateDownload.mockRejectedValueOnce(new Error('desktop update: download confirmation is stale'))
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error',
      message: en.updateDownloadFailed, technicalDetails: 'desktop update: download confirmation is stale' }))
  })

  it('keeps policy failures silent while an ordinary update proceeds', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com',
      allowedPageOrigins: ['https://downloads.example.com'] }
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(async () =>
      Response.json({ code: 500 }, { status: 503 })))
    await readyForUpdate()
    await vi.advanceTimersByTimeAsync(0)
    harness.dialog.showMessageBox.mockClear()
    harness.updateCheck.mockResolvedValueOnce({ phase: 'available', version: '1.0.1-nightly.1' })
    await invoke(DESKTOP_IPC.updatesOpen, 'app')
    const messages = harness.dialog.showMessageBox.mock.calls.map(call => (call.at(-1) as { message: string }).message)
    expect(messages).not.toContain(en.mandatoryUnavailable)
    expect(harness.updateDownload).toHaveBeenCalledExactlyOnceWith('1.0.1-nightly.1')
  })

  it('does not wait for a pending policy request before proceeding with an ordinary update', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com',
      allowedPageOrigins: ['https://downloads.example.com'] }
    const policy = Promise.withResolvers<Response>()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(() => policy.promise))
    harness.updateCheck.mockResolvedValue({ phase: 'available', version: '1.0.1-nightly.1' })
    const operation = Promise.resolve().then(async () => {
      await readyForUpdate()
      await invoke(DESKTOP_IPC.updatesOpen, 'app')
    })
    try {
      await vi.waitFor(() => { expect(harness.updateDownload).toHaveBeenCalledWith('1.0.1-nightly.1') })
    } finally {
      policy.resolve(Response.json({ code: 500 }, { status: 503 }))
      await operation
    }
  })

  it('lets a confirmed mandatory policy preempt an ordinary result dialog', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com',
      allowedPageOrigins: ['https://downloads.example.com'] }
    const policy = Promise.withResolvers<Response>()
    const available = Promise.withResolvers<AbortSignal>()
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockImplementation(() => policy.promise))
    harness.updateCheck.mockResolvedValue({ phase: 'available', version: '1.0.1-nightly.1' })
    harness.dialog.showMessageBox.mockImplementation(({ signal, message }: { signal?: AbortSignal; message: string }) => {
      if (message !== en.updateAvailable || signal === undefined) return Promise.resolve({ response: 1 })
      available.resolve(signal)
      return new Promise((resolve) => { signal.addEventListener('abort', () => { resolve({ response: 0 }) }, { once: true }) })
    })
    await readyForUpdate()
    const submenu = applicationMenuItems()
    const action = submenu.find(item => item.label === 'Check for Updates…')
    Reflect.apply(action!.click!, undefined, [])
    const operation = Promise.resolve(invoke(DESKTOP_IPC.updatesOpen, 'app'))
    try {
      const signal = await available.promise
      policy.resolve(Response.json({ code: 40005,
        data: { show_content: { title: 'Update required', detail: 'Please update' },
          desktop_app_link: 'https://downloads.example.com/' } }))
      await harness.policyBlocked.promise
      expect(signal.aborted).toBe(true)
      await operation
      expect(harness.updateDownload).not.toHaveBeenCalled()
    } finally {
      policy.resolve(Response.json({ code: 500 }, { status: 503 }))
      await operation
    }
  })

  it('queues policy authentication until the ordinary result dialog closes', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', authentication: 'feishu-test',
      allowedPageOrigins: ['https://downloads.example.com'], intervalMs: 10_000, jitter: 0 }
    const request = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ code: 0, data: { biz_code: 0, biz_data: null } }))
      .mockResolvedValue(Response.json({ error: { code: 'UNAUTHENTICATED' } }, { status: 401 }))
    vi.stubGlobal('fetch', request)
    await readyForUpdate()
    await vi.advanceTimersByTimeAsync(0)
    const ordinaryResult = Promise.withResolvers<{ response: number }>()
    const ordinaryShown = Promise.withResolvers<undefined>()
    const policyShown = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementation(({ message }: { message: string }) => {
      if (message.startsWith('No updates available.')) {
        ordinaryShown.resolve(undefined)
        return ordinaryResult.promise
      }
      if (message === en.policyLoginRequired) policyShown.resolve(undefined)
      return Promise.resolve({ response: 1 })
    })
    const operation = Promise.resolve(invoke(DESKTOP_IPC.updatesOpen, 'app'))
    await ordinaryShown.promise
    expect(harness.dialog.showMessageBox.mock.calls.map(call => (call.at(-1) as { message: string }).message))
      .not.toContain(en.policyLoginRequired)
    ordinaryResult.resolve({ response: 0 })
    await operation
    await policyShown.promise
    expect(testAuth.login).not.toHaveBeenCalled()
  })

  it('downloads on the first click and opens installation confirmation only after readiness', async () => {
    await readyForUpdate()
    harness.updateState = { phase: 'available', version: '1.0.1-nightly.1' }
    const downloading = Promise.withResolvers<DesktopUpdateState>()
    const started = Promise.withResolvers<undefined>()
    harness.updateDownload.mockImplementationOnce(async (version) => {
      harness.updateState = { phase: 'downloading', version }
      started.resolve(undefined)
      return downloading.promise
    })
    const action = invoke(DESKTOP_IPC.updatesOpen, 'app')
    await started.promise
    const repeated = invoke(DESKTOP_IPC.updatesOpen, 'app')
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(harness.updateDownload).toHaveBeenCalledExactlyOnceWith('1.0.1-nightly.1')
    expect(harness.updateInstall).not.toHaveBeenCalled()
    downloading.resolve({ phase: 'ready', version: '1.0.1-nightly.1' })
    await Promise.all([action, repeated])
    expect(harness.updateInstall).toHaveBeenCalledExactlyOnceWith('1.0.1-nightly.1')
    await harness.updateCheck()
    expect(harness.updateInstall).toHaveBeenCalledOnce()
  })

  it.each([
    { hasDraft: true, attachmentCount: 0, submitting: false },
    { hasDraft: false, attachmentCount: 1, submitting: false },
    { hasDraft: false, attachmentCount: 0, submitting: true },
  ])('does not stop the Host while unsent input remains: %j', async (impact) => {
    const host = await readyForUpdate()
    reportInput(impact)
    await expect(harness.prepareUpdate()).rejects.toThrow('unsent or unconfirmed input')
    expect(host.updateTasks).not.toHaveBeenCalled()
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('rechecks unsent input after task admission and restores the main window on rejection', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    host.updateTasks.mockImplementation(async (action) => {
      if (action === 'lock') reportInput({ hasDraft: true, attachmentCount: 0, submitting: false })
      return false
    })
    await expect(harness.prepareUpdate()).rejects.toThrow('unsent or unconfirmed input')
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
    expect(host.stop).not.toHaveBeenCalled()
    expect(harness.windows[0]!.setEnabled.mock.calls).toEqual([[false], [true]])
  })

  it.each(['load', 'preload', 'renderer'] as const)('invalidates a formerly clear input report after %s failure', async (failure) => {
    const host = await readyForUpdate()
    const sender = harness.windows[0]!.webContents
    if (failure === 'load') sender.emit('did-fail-load', {}, -2, 'fixture load failure', 'dsh-app://app/', true)
    if (failure === 'preload') sender.emit('preload-error', {}, 'preload-app.cjs', new Error('fixture preload failure'))
    if (failure === 'renderer') sender.emit('render-process-gone', {}, { reason: 'clean-exit' })
    reportInput({ hasDraft: false, attachmentCount: 0, submitting: false })
    // Load/preload failures reserve fatal recovery; a clean renderer exit only invalidates input evidence.
    const expectedReason = failure === 'renderer' ? 'unsent or unconfirmed input'
      : 'Desktop shutdown or recovery already owns restart admission'
    await expect(harness.prepareUpdate()).rejects.toThrow(expectedReason)
    expect(host.stop).not.toHaveBeenCalled()
    expect(host.updateTasks).not.toHaveBeenCalled()
  })

  it('rejects old input reports throughout navigation until the replacement document answers its challenge', async () => {
    const host = await readyForUpdate()
    const sender = harness.windows[0]!.webContents
    sender.emit('did-start-navigation', {}, 'dsh-app://app/', false, true)
    reportInput({ hasDraft: false, attachmentCount: 0, submitting: false })
    await expect(harness.prepareUpdate()).rejects.toThrow('unsent or unconfirmed input')
    expect(host.updateTasks).not.toHaveBeenCalled()
    sender.emit('did-finish-load')
    await expect(harness.prepareUpdate()).rejects.toThrow('unsent or unconfirmed input')
    reportInput({ hasDraft: false, attachmentCount: 0, submitting: false })
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(harness.prepareUpdate()).resolves.toBe(false)
    expect(host.updateTasks.mock.calls).toEqual([['inspect']])
  })

  function managedFixture(): DesktopManagedUpdateSelection {
    const manifest = managedManifest()
    managed.config = { capability: managedCapability(), installedSequence: 1, completedSequence: 0,
      operationsRoot: 'managed-operations', helperBundle: 'managed-helper.mjs', completionPath: 'managed-completion.json' }
    harness.updateState = { phase: 'ready', version: manifest.version, mode: 'github-release-managed' }
    return { kind: 'source', manifest, manifestUrl: `https://github.com/cloga/deepseek-harness/releases/download/${manifest.source.tag}/release.json`,
      manifestSha256: manifest.manifestSha256, assetSha256: 'b'.repeat(64) }
  }

  it.each(['removed', 'installed-override', 'disabled', 'ambiguous-legacy'] as const)(
    'boots preserved user choice without staging or certifying the baseline: %s', async (reason) => {
      managedFixture()
      baseline.assess.mockResolvedValue({ status: 'preserved-user-choice', reason, packageName: 'fixture-provider',
        planSha256: 'a'.repeat(64), planResourceSha256: 'b'.repeat(64) })
      const host = await readyForUpdate()
      await expect(invoke(DESKTOP_IPC.boot)).resolves.toMatchObject({ streamBaseUrl: 'http://127.0.0.1:3080' })
      expect(baseline.stage).not.toHaveBeenCalled()
      expect(baseline.commit).not.toHaveBeenCalled()
      expect(host.initiallyLocked).toBe(false)
      expect(baseline.completion.mock.lastCall?.[8]).toBe('preserved-user-choice')
      expect(harness.windows[0]!.webContents.send).toHaveBeenCalledWith(DESKTOP_IPC.updatesPresentation,
        expect.objectContaining({ baseline: { status: 'preserved-user-choice', packageName: 'fixture-provider' } }))
    })

  it.each(['qualified', 'unhealthy', 'work-observed', 'stale-assessment'] as const)(
    'qualifies exact user-owned baseline only under readiness admission: %s', async (mode) => {
      managedFixture()
      baseline.assess.mockResolvedValue({ status: 'exact-satisfied', packageOwner: 'user', qualification: 'pending',
        packageName: 'fixture-provider', planSha256: 'a'.repeat(64), planResourceSha256: 'b'.repeat(64),
        owner: { profile: 'desktop-test-profile', runtimeDir: 'runtime', installAnchor: 'runtime', runtimeFingerprint: 'c'.repeat(64),
          dependencyRegistry: 'https://registry.example.test/', configPaths: [] },
        baseFingerprint: 'd'.repeat(64), baseGraphFingerprint: 'e'.repeat(64), assessmentFingerprint: 'f'.repeat(64) })
      if (mode === 'stale-assessment') baseline.commit.mockRejectedValue(new Error('stale assessment'))
      await import('../src/main.ts')
      await harness.preparing.promise
      harness.prepared.resolve()
      await harness.hostStarted.promise
      const host = harness.hosts[0]!
      host.packages = [{ name: 'fixture-provider', version: '1.0.0', enabled: true, healthy: mode !== 'unhealthy' }]
      if (mode === 'work-observed') host.updateTasks.mockImplementation(async action => action === 'inspect')
      host.ready.resolve()
      await expect(invoke(DESKTOP_IPC.boot)).resolves.toMatchObject({ streamBaseUrl: 'http://127.0.0.1:3080' })
      expect(host.initiallyLocked).toBe(true)
      expect(baseline.stage).not.toHaveBeenCalled()
      expect(baseline.completion.mock.lastCall?.[8]).toBe(mode === 'qualified' ? undefined : 'pending')
      if (mode === 'qualified' || mode === 'stale-assessment') {
        expect(baseline.commit).toHaveBeenCalledExactlyOnceWith('f'.repeat(64))
      } else expect(baseline.commit).not.toHaveBeenCalled()
      expect(host.updateTasks).toHaveBeenLastCalledWith('unlock')
    })

  it('keeps fresh usable Core available when private baseline preparation fails', async () => {
    managedFixture()
    baseline.createdProfile = true
    baseline.assess.mockResolvedValue({ status: 'provisionable', reason: 'fresh-profile', packageName: 'fixture-provider',
      planSha256: 'a'.repeat(64), planResourceSha256: 'b'.repeat(64) })
    baseline.stage.mockRejectedValue(new Error('fixture registry unavailable'))
    await readyForUpdate()
    await expect(invoke(DESKTOP_IPC.boot)).resolves.toMatchObject({ streamBaseUrl: 'http://127.0.0.1:3080' })
    expect(baseline.create.mock.calls[0]?.[4]).toBe(true)
    expect(baseline.stage).toHaveBeenCalledOnce()
    expect(baseline.commit).not.toHaveBeenCalled()
    expect(baseline.completion.mock.lastCall?.[8]).toBe('pending')
  })

  it.each(['invalid-evidence', 'failed-release-repair'] as const)('does not relabel damaged baseline evidence as a user choice: %s', async (mode) => {
    managedFixture()
    const identity = { packageName: 'fixture-provider', planSha256: 'a'.repeat(64), planResourceSha256: 'b'.repeat(64) }
    baseline.assess.mockResolvedValue(mode === 'invalid-evidence'
      ? { ...identity, status: 'invalid-evidence', diagnostic: 'fixture corrupt ownership evidence' }
      : { ...identity, status: 'provisionable', reason: 'release-owned-repair' })
    baseline.stage.mockRejectedValue(new Error('fixture repair unavailable'))
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.dialogShown.promise
    expect(harness.hosts).toHaveLength(0)
    expect(baseline.completion).not.toHaveBeenCalled()
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail)
      .toContain(mode === 'invalid-evidence' ? 'corrupt ownership evidence' : 'repair unavailable')
  })

  it('keeps managed executable corruption fatal even when the baseline preserves user choice', async () => {
    managedFixture()
    baseline.completion.mockResolvedValue({ status: 'recovery-required', message: 'fixture executable mismatch', command: 'fixture recover' })
    await readyForUpdate()
    await harness.dialogShown.promise
    expect(baseline.completion.mock.lastCall?.[8]).toBe('preserved-user-choice')
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('fixture executable mismatch')
  })

  it('shows the sealed registry identity before native refusal without stopping the Host', async () => {
    managedFixture()
    const host = await readyForUpdate()
    await invoke(DESKTOP_IPC.boot)
    const transactionId = '12345678-1234-4234-8234-123456789abc'
    const integrity = `sha512-${Buffer.alloc(64, 1).toString('base64')}`
    packageReview.input = {
      transactionDir: 'fixture-stage', candidateDir: 'fixture-stage/profile', rollbackDir: 'fixture-stage/rollback',
      owner: { profile: 'desktop-test-profile', runtimeDir: 'fixture-runtime', installAnchor: 'fixture-anchor',
        runtimeFingerprint: 'a'.repeat(64), dependencyRegistry: 'https://registry.example.test/', configPaths: [] },
      baseGraphFingerprint: 'b'.repeat(64), candidateFingerprint: 'c'.repeat(64), intentFingerprint: 'd'.repeat(64),
      mutation: { kind: 'install', source: { schemaVersion: 1, type: 'npmRegistry', spec: '@example/plugin@^1.0.0' } },
      prepared: { transactionId, state: 'prepared', packageName: '@example/plugin', baseFingerprint: 'e'.repeat(64), health: 'pending' },
      registryTarget: { schemaVersion: 1, requestedSpec: '@example/plugin@^1.0.0', registry: 'https://registry.example.test/',
        packageName: '@example/plugin', version: '1.2.3', integrity, packageKey: '@example/plugin@1.2.3',
        tarball: 'https://artifacts.example.test/private/plugin.tgz?token=fixture-secret' },
    }
    const reviewed = Promise.withResolvers<boolean>()
    packageReview.confirmed = reviewed.resolve
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    const action = applicationMenuItems().find(item => item.label === en.packageReview)
    expect(action?.click).toBeTypeOf('function')
    Reflect.apply(action!.click!, undefined, [])
    expect(await reviewed.promise).toBe(false)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      title: en.packageReview, detail: expect.stringContaining('@example/plugin@1.2.3') as unknown, defaultId: 1, cancelId: 1,
    }))
    const detail = (harness.dialog.showMessageBox.mock.lastCall?.[0] as MessageBoxOptions).detail!
    expect(detail).toContain(integrity)
    expect(detail).toContain('https://artifacts.example.test')
    expect(detail).not.toContain('fixture-secret')
    expect(host.stop).not.toHaveBeenCalled()
    expect(baseline.commit).not.toHaveBeenCalled()
  })

  async function readyForPackageLifecycle() {
    managedFixture()
    const host = await readyForUpdate()
    await invoke(DESKTOP_IPC.boot)
    packageReview.input = {
      transactionDir: 'fixture-stage', candidateDir: 'fixture-stage/profile', rollbackDir: 'fixture-stage/rollback',
      owner: { profile: 'desktop-test-profile', runtimeDir: 'fixture-runtime', installAnchor: 'fixture-anchor',
        runtimeFingerprint: 'a'.repeat(64), dependencyRegistry: 'https://registry.example.test/', configPaths: [] },
      baseGraphFingerprint: 'b'.repeat(64), candidateFingerprint: 'c'.repeat(64), intentFingerprint: 'd'.repeat(64),
      mutation: { kind: 'install', source: { schemaVersion: 1, type: 'npmRegistry', spec: '@example/plugin@1.2.3' } },
      prepared: { transactionId: '12345678-1234-4234-8234-123456789abc', state: 'prepared',
        packageName: '@example/plugin', baseFingerprint: 'e'.repeat(64), health: 'pending' },
    }
    const action = applicationMenuItems().find(item => item.label === en.packageReview)!
    return { host, review: () => { Reflect.apply(action.click!, undefined, []) } }
  }

  it('does not create policy work or reconcile a profile when the manifest read finishes after quit', async () => {
    const entered = Promise.withResolvers<undefined>()
    const loaded = Promise.withResolvers<string>()
    const manifest = JSON.stringify({ dshDesktopAppId: 'com.deepseek.dsh', dshMandatoryUpdatePolicy: {
      origin: 'https://policy.example.com', allowedPageOrigins: ['https://downloads.example.com'],
      intervalMs: 10_000, jitter: 0,
    } })
    manifestRead.read = () => { entered.resolve(undefined); return loaded.promise }
    packageReview.cleanup = () => { loaded.resolve(manifest) }
    const request = vi.fn(() => { throw new Error('manifest continuation must not make policy requests') })
    vi.stubGlobal('fetch', request)
    await import('../src/main.ts')
    await entered.promise
    harness.app.quit()
    await harness.quitCompleted.promise
    loaded.resolve(manifest)
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.applyRelease).not.toHaveBeenCalled()
    expect(baseline.create).not.toHaveBeenCalled()
    expect(harness.hosts).toEqual([])
    expect(request).not.toHaveBeenCalled()
    expect(harness.updateCheck).not.toHaveBeenCalled()
  })

  it('vetoes every repeated quit until the owned Host has exited', async () => {
    const host = await readyForUpdate()
    harness.app.quit()
    await host.stopping.promise
    const repeated = { preventDefault: vi.fn() }
    harness.app.emit('before-quit', repeated)
    expect(repeated.preventDefault).toHaveBeenCalledOnce()
    expect(host.stop).toHaveBeenCalledOnce()
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it.each(['staging', 'confirmation'] as const)('cancels package %s on quit before admission or navigation', async (phase) => {
    const f = await readyForPackageLifecycle()
    const entered = Promise.withResolvers<undefined>()
    const proceed = Promise.withResolvers<undefined>()
    const answer = Promise.withResolvers<Electron.MessageBoxReturnValue>()
    const confirmed = Promise.withResolvers<boolean>()
    packageReview.cleanup = () => { proceed.resolve(undefined); answer.resolve({ response: 1, checkboxChecked: false }) }
    packageReview.confirmed = confirmed.resolve
    if (phase === 'staging') packageReview.beforeConfirm = () => { entered.resolve(undefined); return proceed.promise }
    harness.dialog.showMessageBox.mockImplementation((options: MessageBoxOptions) => {
      entered.resolve(undefined)
      options.signal?.addEventListener('abort', () => { answer.resolve({ response: 1, checkboxChecked: false }) }, { once: true })
      return answer.promise
    })
    const urls = [...harness.windows[0]!.urls]
    f.review()
    await entered.promise
    harness.app.quit()
    if (phase === 'staging') {
      expect(f.host.stop).not.toHaveBeenCalled()
      proceed.resolve(undefined)
    }
    expect(await confirmed.promise).toBe(false)
    await f.host.stopping.promise
    expect(f.host.updateTasks.mock.calls.some(([action]) => action === 'lock')).toBe(false)
    expect(harness.windows[0]!.urls).toEqual(urls)
    f.host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it.each(['admitted', 'candidate', 'rollback'] as const)('drains %s package activation on repeated quit before closing its replacement Host', async (phase) => {
    const f = await readyForPackageLifecycle()
    const admitted = Promise.withResolvers<undefined>()
    const proceed = Promise.withResolvers<undefined>()
    const finished = Promise.withResolvers<undefined>()
    packageReview.cleanup = () => { proceed.resolve(undefined) }
    packageReview.run = async (options, input) => {
      const release = await options.acquireAdmission(input)
      admitted.resolve(undefined)
      await proceed.promise
      await options.stopHost()
      await options.startHost()
      if (phase === 'rollback') {
        await options.stopHost()
        await options.startHost()
      }
      await release()
      finished.resolve(undefined)
    }
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    const urls = [...harness.windows[0]!.urls]
    f.review()
    await admitted.promise
    const candidateStarted = harness.nextHostStart()
    if (phase === 'admitted') {
      harness.app.quit()
      expect(f.host.stop).not.toHaveBeenCalled()
    }
    proceed.resolve(undefined)
    await f.host.stopping.promise
    f.host.exited.resolve()
    await candidateStarted
    const candidate = harness.hosts[1]!
    expect(candidate.initiallyLocked).toBe(true)
    let last = candidate
    if (phase === 'rollback') {
      candidate.ready.resolve()
      await candidate.stopping.promise
      harness.app.quit()
      const rollbackStarted = harness.nextHostStart()
      candidate.exited.resolve()
      await rollbackStarted
      last = harness.hosts[2]!
      expect(last.initiallyLocked).toBe(true)
    }
    if (phase === 'candidate') harness.app.quit()
    const repeated = { preventDefault: vi.fn() }
    harness.app.emit('before-quit', repeated)
    expect(repeated.preventDefault).toHaveBeenCalledOnce()
    expect(last.stop).not.toHaveBeenCalled()
    last.ready.resolve()
    await finished.promise
    await last.stopping.promise
    expect(last.updateTasks).not.toHaveBeenCalledWith('unlock')
    expect(harness.windows[0]!.urls).toEqual(urls)
    expect(harness.windows[0]!.setEnabled).not.toHaveBeenCalledWith(true)
    last.exited.resolve()
    await harness.quitCompleted.promise
    expect(last.stop).toHaveBeenCalledOnce()
  })

  it('refuses a package admission whose Host lock completes after quit intent without reopening the API', async () => {
    const f = await readyForPackageLifecycle()
    const entered = Promise.withResolvers<undefined>()
    const locked = Promise.withResolvers<boolean>()
    packageReview.cleanup = () => { locked.resolve(false) }
    f.host.updateTasks.mockImplementation((action) => {
      if (action !== 'lock') return Promise.resolve(false)
      entered.resolve(undefined)
      return locked.promise
    })
    packageReview.run = async (options, input) => { await options.acquireAdmission(input) }
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    f.review()
    await entered.promise
    harness.app.quit()
    expect(f.host.stop).not.toHaveBeenCalled()
    locked.resolve(false)
    await f.host.stopping.promise
    expect(f.host.updateTasks).not.toHaveBeenCalledWith('unlock')
    expect(harness.hosts).toHaveLength(1)
    f.host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('cancels pending package consent when fatal recovery opens without interrupting before a recovery choice', async () => {
    const f = await readyForPackageLifecycle()
    const consentShown = Promise.withResolvers<undefined>()
    const consent = Promise.withResolvers<Electron.MessageBoxReturnValue>()
    const recoveryAnswer = Promise.withResolvers<Electron.MessageBoxReturnValue>()
    const confirmed = Promise.withResolvers<boolean>()
    packageReview.confirmed = confirmed.resolve
    packageReview.cleanup = () => {
      consent.resolve({ response: 1, checkboxChecked: false })
      recoveryAnswer.resolve({ response: 0, checkboxChecked: false })
    }
    harness.dialog.showMessageBox.mockImplementation((options: MessageBoxOptions) => {
      if (options.title === en.startupFailed) return recoveryAnswer.promise
      consentShown.resolve(undefined)
      options.signal?.addEventListener('abort', () => { consent.resolve({ response: 1, checkboxChecked: false }) }, { once: true })
      return consent.promise
    })
    f.review()
    await consentShown.promise
    harness.windows[0]!.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('fixture preload failure'))
    expect(await confirmed.promise).toBe(false)
    expect(f.host.stop).not.toHaveBeenCalled()
    expect(f.host.updateTasks).not.toHaveBeenCalledWith('lock')
    recoveryAnswer.resolve({ response: 0, checkboxChecked: false })
    await f.host.stopping.promise
    f.host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('excludes new package and restart admission during fatal recovery while draining an admitted activation', async () => {
    const f = await readyForPackageLifecycle()
    const selected = managedFixture()
    const admitted = Promise.withResolvers<undefined>()
    const proceed = Promise.withResolvers<undefined>()
    const recoveryShown = Promise.withResolvers<undefined>()
    const recoveryAnswer = Promise.withResolvers<Electron.MessageBoxReturnValue>()
    packageReview.cleanup = () => { proceed.resolve(undefined); recoveryAnswer.resolve({ response: 0, checkboxChecked: false }) }
    const confirmed = vi.fn()
    packageReview.confirmed = confirmed
    packageReview.run = async (options, input) => {
      const release = await options.acquireAdmission(input)
      admitted.resolve(undefined)
      await proceed.promise
      await options.stopHost()
      await options.startHost()
      await release()
    }
    harness.dialog.showMessageBox.mockImplementation((options: MessageBoxOptions) => {
      if (options.title !== en.startupFailed) return Promise.resolve({ response: 0, checkboxChecked: false })
      recoveryShown.resolve(undefined)
      return recoveryAnswer.promise
    })
    f.review()
    await admitted.promise
    harness.windows[0]!.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('fixture preload failure'))
    await recoveryShown.promise
    f.review()
    await expect(managed.launch!(selected)).rejects.toThrow('already owns restart admission')
    expect(confirmed).toHaveBeenCalledOnce()
    recoveryAnswer.resolve({ response: 1, checkboxChecked: false })
    await vi.advanceTimersByTimeAsync(0)
    expect(f.host.stop).not.toHaveBeenCalled()
    const urls = [...harness.windows[0]!.urls]
    const next = harness.nextHostStart()
    proceed.resolve(undefined)
    await f.host.stopping.promise
    f.host.exited.resolve()
    await next
    const replacement = harness.hosts[1]!
    expect(replacement.initiallyLocked).toBe(true)
    replacement.ready.resolve()
    await replacement.stopping.promise
    expect(replacement.updateTasks).not.toHaveBeenCalledWith('unlock')
    expect(harness.windows[0]!.urls).toEqual(urls)
    replacement.exited.resolve()
    await harness.quitCompleted.promise
    expect(harness.app.relaunch).toHaveBeenCalledOnce()
  })

  it('keeps the Host alive until managed helper acknowledgement and passes only fixed handoff fields', async () => {
    const selected = managedFixture()
    const entered = Promise.withResolvers<undefined>()
    const acknowledgement = Promise.withResolvers<DesktopManagedUpdateAcknowledgement>()
    managed.acknowledge.mockImplementation(() => { entered.resolve(undefined); return acknowledgement.promise })
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const handoff = managed.launch!(selected)
    await entered.promise
    expect(host.stop).not.toHaveBeenCalled()
    expect(managed.acknowledge).toHaveBeenCalledWith(expect.objectContaining({
      nodeExecutable: 'verified-primary-node.exe', nodeSha256: 'a'.repeat(64), waitPids: [process.pid, host.pid],
      selection: { kind: selected.kind, manifestUrl: selected.manifestUrl,
        manifestSha256: selected.manifestSha256, assetSha256: selected.assetSha256 },
    }))
    acknowledgement.resolve({ operationRoot: 'owned-operation', helperPid: 789, token: 'fixture', abandon: managed.abandon })
    await host.stopping.promise
    host.exited.resolve()
    await expect(handoff).resolves.toBe(true)
    expect(managed.abandon).not.toHaveBeenCalled()
    expect(harness.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      detail: expect.stringContaining('installer has not been downloaded') as unknown,
    }))
  })

  it('keeps both wait PIDs alive through a quit during helper acknowledgement and pending abandonment', async () => {
    const selected = managedFixture()
    const entered = Promise.withResolvers<undefined>()
    const acknowledged = Promise.withResolvers<DesktopManagedUpdateAcknowledgement>()
    const abandoning = Promise.withResolvers<undefined>()
    const abandoned = Promise.withResolvers<undefined>()
    managed.acknowledge.mockImplementation(() => { entered.resolve(undefined); return acknowledged.promise })
    const abandon = vi.fn(() => { abandoning.resolve(undefined); return abandoned.promise })
    packageReview.cleanup = () => {
      acknowledged.resolve({ operationRoot: 'owned-operation', helperPid: 789, token: 'fixture', abandon })
      abandoned.resolve(undefined)
    }
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const handoff = managed.launch!(selected)
    const rejected = expect(handoff).rejects.toThrow('shutdown or recovery prevents restart')
    await entered.promise
    harness.app.quit()
    expect(host.stop).not.toHaveBeenCalled()
    const repeated = { preventDefault: vi.fn() }
    harness.app.emit('before-quit', repeated)
    expect(repeated.preventDefault).toHaveBeenCalledOnce()
    acknowledged.resolve({ operationRoot: 'owned-operation', helperPid: 789, token: 'fixture', abandon })
    await abandoning.promise
    expect(host.stop).not.toHaveBeenCalled()
    expect(harness.app.quit).toHaveBeenCalledOnce()
    abandoned.resolve(undefined)
    await rejected
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(abandon).toHaveBeenCalledOnce()
  })

  it('refuses ordinary exit after an acknowledged helper fails to confirm abandonment', async () => {
    const selected = managedFixture()
    const entered = Promise.withResolvers<undefined>()
    const acknowledged = Promise.withResolvers<DesktopManagedUpdateAcknowledgement>()
    managed.acknowledge.mockImplementation(() => { entered.resolve(undefined); return acknowledged.promise })
    const abandon = vi.fn(async () => { throw new Error('fixture helper is still alive') })
    // This is a deliberately non-quiescent fake shell. Retire its event listeners only after proving the veto;
    // production must not infer helper exit from a rejected cancellation Promise.
    const operation: { handoff: Promise<boolean> | undefined } = { handoff: undefined }
    packageReview.cleanup = async () => {
      acknowledged.resolve({ operationRoot: 'owned-operation', helperPid: 789, token: 'fixture', abandon })
      await operation.handoff?.catch(() => undefined)
      harness.app.removeAllListeners('before-quit')
    }
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const handoff = managed.launch!(selected)
    operation.handoff = handoff
    const rejected = expect(handoff).rejects.toThrow('helper cancellation failed')
    await entered.promise
    harness.app.quit()
    acknowledged.resolve({ operationRoot: 'owned-operation', helperPid: 789, token: 'fixture', abandon })
    await rejected
    await vi.advanceTimersByTimeAsync(0)
    expect(host.stop).not.toHaveBeenCalled()
    expect(host.updateTasks).not.toHaveBeenCalledWith('unlock')
    expect(harness.app.quit).toHaveBeenCalledOnce()
    const repeated = { preventDefault: vi.fn() }
    harness.app.emit('before-quit', repeated)
    expect(repeated.preventDefault).toHaveBeenCalledOnce()
    expect(harness.windows[0]!.setEnabled).not.toHaveBeenCalledWith(true)
  })

  it('restores input and normal exit after a launcher-proven no-child failure', async () => {
    const selected = managedFixture()
    const launcher = await import('../src/managed-update-launcher.ts')
    // Use the same actual module instance as the mocked export's private evidence predicate across resetModules.
    const safeFailure: unknown = await managed.realLaunch!({
      operationsRoot: 'unused', nodeExecutable: 'unused', nodeSha256: 'a'.repeat(64), helperBundle: 'unused',
      capability: managedCapability(), selection: selected, installedSequence: 1, waitPids: [12],
    }, { platform: 'linux', spawn: vi.fn() as unknown as typeof import('node:child_process').spawn,
      now: () => 0, sleep: async () => {}, waitForExit: async () => true }).catch((error: unknown) => error)
    expect(launcher.isDesktopManagedUpdateHelperQuiescent(safeFailure)).toBe(true)
    managed.acknowledge.mockRejectedValue(safeFailure)
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(managed.launch!(selected)).rejects.toBe(safeFailure)
    expect(host.stop).not.toHaveBeenCalled()
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
    expect(harness.windows[0]!.setEnabled.mock.calls).toEqual([[false], [true]])
    harness.app.quit()
    await host.stopping.promise
    host.exited.resolve()
    await harness.quitCompleted.promise
  })

  it('does not treat a rejected helper launch as evidence that an owned helper cannot run', async () => {
    const selected = managedFixture()
    managed.acknowledge.mockRejectedValue(new Error('helper acknowledgement failed'))
    packageReview.cleanup = () => { harness.app.removeAllListeners('before-quit') }
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(managed.launch!(selected)).rejects.toThrow('helper acknowledgement failed')
    expect(host.stop).not.toHaveBeenCalled()
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock']])
    expect(harness.windows[0]!.setEnabled.mock.calls).toEqual([[false]])
    harness.app.quit()
    await vi.advanceTimersByTimeAsync(0)
    expect(host.stop).not.toHaveBeenCalled()
    expect(harness.app.quit).toHaveBeenCalledOnce()
    const repeated = { preventDefault: vi.fn() }
    harness.app.emit('before-quit', repeated)
    expect(repeated.preventDefault).toHaveBeenCalledOnce()
  })

  it('abandons an acknowledged helper when graceful Host teardown is not accepted', async () => {
    const selected = managedFixture()
    managed.acknowledge.mockResolvedValue({ operationRoot: 'owned-operation', helperPid: 789, token: 'fixture', abandon: managed.abandon })
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const handoff = managed.launch!(selected)
    const rejected = expect(handoff).rejects.toThrow(en.updateStopFailed)
    await host.stopping.promise
    host.exited.reject(new DesktopHostUncleanExitError('teardown rejected'))
    await rejected
    expect(managed.abandon).toHaveBeenCalledOnce()
    expect(harness.windows[0]!.setEnabled).toHaveBeenLastCalledWith(true)
  })

  it('does not lock or stop tasks when restart confirmation is dismissed', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await expect(harness.prepareUpdate()).resolves.toBe(false)
    expect(host.updateTasks.mock.calls).toEqual([['inspect']])
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('rechecks admission after approval and rejects work that started during confirmation', async () => {
    const host = await readyForUpdate()
    host.updateTasks.mockResolvedValueOnce(false).mockResolvedValueOnce(true)
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(harness.prepareUpdate()).rejects.toThrow(/New tasks/u)
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
    expect(host.stop).not.toHaveBeenCalled()
  })

  it('warns about active tasks and waits for a graceful Host exit after approval', async () => {
    const host = await readyForUpdate()
    host.updateTasks.mockResolvedValue(true)
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    await host.stopping.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      message: 'Tasks are still in progress', buttons: ['Stop tasks and update', 'Update later'],
    }))
    expect(host.stop).toHaveBeenCalledWith(true)
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
  })

  it('unlocks admission without stopping the Host when request draining fails', async () => {
    const host = await readyForUpdate()
    host.updateTasks.mockResolvedValueOnce(false).mockRejectedValueOnce(new Error('task inspection timed out'))
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(harness.prepareUpdate()).rejects.toThrow('task inspection timed out')
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
    expect(host.stop).not.toHaveBeenCalled()
  })

  async function answerMandatory(action: 'install' | 'later') {
    const modal = harness.windows.find(window => window.options.modal && !window.isDestroyed())!
    const event = { sender: modal.webContents, senderFrame: modal.webContents.mainFrame }
    await vi.waitFor(() => {
      expect(harness.handlers.get(MANDATORY_IPC.status)!(event)).toHaveProperty('confirmation')
    })
    const view = harness.handlers.get(MANDATORY_IPC.status)!(event) as { confirmation: { version: string; revision: number } }
    await harness.handlers.get(MANDATORY_IPC.action)!(event, action, view.confirmation.version, view.confirmation.revision)
  }

  it('releases the mandatory modal when the confirmed installer quits Electron', async () => {
    harness.embeddedPolicy = { origin: 'https://policy.example.com', allowedPageOrigins: ['https://downloads.example.com'] }
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 40005, data: {
      show_content: { title: 'Update required', detail: 'Please update' }, desktop_app_link: 'https://downloads.example.com/',
    } })))
    const host = await readyForUpdate()
    await harness.policyBlocked.promise
    const modal = harness.windows.find(window => window.options.modal)!
    const preparing = harness.prepareUpdate()
    await answerMandatory('install')
    await host.stopping.promise
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
    harness.closeWindowsOnQuit = true
    harness.app.quit()
    await harness.quitCompleted.promise
    expect(modal.isDestroyed()).toBe(true)
    expect(harness.app.quit).toHaveBeenCalledOnce()
  })

  it.each([false, true])('restores a cleanly stopped Host after installer failure and retains mandatory blocking: %s', async (mandatory) => {
    if (mandatory) {
      harness.embeddedPolicy = { origin: 'https://policy.example.com', allowedPageOrigins: ['https://downloads.example.com'] }
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 40005, data: {
        show_content: { title: 'Update required', detail: 'Please update' }, desktop_app_link: 'https://downloads.example.com/',
      } })))
    }
    const host = await readyForUpdate()
    if (mandatory) await harness.policyBlocked.promise
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    if (mandatory) await answerMandatory('install')
    await host.stopping.promise
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const restarted = harness.nextHostStart()
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'Installer failed' })
    await restarted
    const replacement = harness.hosts[1]!
    replacement.url = 'http://127.0.0.1:3099/?token=replacement'
    if (mandatory) replacement.updateTasks.mockResolvedValue(true)
    const retry = harness.prepareUpdate()
    expect(replacement.updateTasks).not.toHaveBeenCalled()
    replacement.ready.resolve()
    await vi.waitFor(() => { expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/', 'dsh-app://app/']) })
    await expect(Promise.resolve(invoke(DESKTOP_IPC.boot))).resolves.toEqual({ injections: [], streamBaseUrl: 'http://127.0.0.1:3099' })
    if (mandatory) await answerMandatory('later')
    await expect(retry).resolves.toBe(false)
    expect(replacement.updateTasks.mock.calls).toEqual([['inspect']])
    expect(replacement.stop).not.toHaveBeenCalled()
    if (mandatory) expect(harness.windows.find(window => window.options.modal)?.isDestroyed()).toBe(false)
  })

  it.each([false, true])('restores a confirmed non-graceful exit without approving installation, mandatory: %s', async (mandatory) => {
    if (mandatory) {
      harness.embeddedPolicy = { origin: 'https://policy.example.com', allowedPageOrigins: ['https://downloads.example.com'] }
      vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 40005, data: {
        show_content: { title: 'Update required', detail: 'Please update' }, desktop_app_link: 'https://downloads.example.com/',
      } })))
    }
    const host = await readyForUpdate()
    if (mandatory) await harness.policyBlocked.promise
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    const rejected = expect(preparing).rejects.toMatchObject(new DesktopUpdatePreparationError('stop-failed', en.updateStopFailed, 'Task teardown failed after child exit'))
    if (mandatory) await answerMandatory('install')
    await host.stopping.promise
    host.exited.reject(new DesktopHostUncleanExitError('Task teardown failed after child exit'))
    await rejected
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock']])
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const restarted = harness.nextHostStart()
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'Task teardown failed' })
    await restarted
    const replacement = harness.hosts[1]!
    if (mandatory) replacement.updateTasks.mockResolvedValue(true)
    const retry = harness.prepareUpdate()
    expect(replacement.updateTasks).not.toHaveBeenCalled()
    replacement.ready.resolve()
    await vi.waitFor(() => { expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/', 'dsh-app://app/']) })
    if (mandatory) await answerMandatory('later')
    await expect(retry).resolves.toBe(false)
    expect(replacement.updateTasks.mock.calls).toEqual([['inspect']])
    expect(replacement.stop).not.toHaveBeenCalled()
    if (mandatory) expect(harness.windows.find(window => window.options.modal)?.isDestroyed()).toBe(false)
  })

  it('does not replace a Host whose failed stop has not confirmed process exit', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    const rejected = expect(preparing).rejects.toThrow('child did not exit')
    await host.stopping.promise
    host.exited.reject(new Error('child did not exit'))
    await rejected
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'child did not exit' })
    await expect(harness.prepareUpdate()).rejects.toThrow('Task status is unavailable')
    expect(harness.hosts).toHaveLength(1)
    expect(host.updateTasks.mock.calls).toEqual([['inspect'], ['lock'], ['unlock']])
  })

  it('reports replacement startup failure without authorizing installation or retrying automatically', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    const rejected = expect(preparing).rejects.toMatchObject(new DesktopUpdatePreparationError('stop-failed', en.updateStopFailed, 'Task teardown failed after child exit'))
    await host.stopping.promise
    host.exited.reject(new DesktopHostUncleanExitError('Task teardown failed after child exit'))
    await rejected
    harness.dialog.showMessageBox.mockResolvedValue({ response: 1 })
    const restarted = harness.nextHostStart()
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'Task teardown failed' })
    await restarted
    const replacement = harness.hosts[1]!
    harness.dialog.showMessageBox.mockImplementation(() => { harness.dialogShown.resolve(); return new Promise(() => {}) })
    replacement.ready.reject(new Error('replacement startup failed'))
    replacement.exited.resolve()
    await harness.dialogShown.promise
    expect(harness.dialog.showMessageBox.mock.calls.some(call =>
      (call.at(-1) as MessageBoxOptions).detail?.includes('replacement startup failed'))).toBe(true)
    const taskChecks = harness.hosts.map(current => current.updateTasks.mock.calls.length)
    const stops = harness.hosts.map(current => current.stop.mock.calls.length)
    await expect(harness.prepareUpdate()).rejects.toThrow('Desktop shutdown or recovery already owns restart admission')
    expect(harness.hosts.map(current => current.updateTasks.mock.calls.length)).toEqual(taskChecks)
    expect(harness.hosts.map(current => current.stop.mock.calls.length)).toEqual(stops)
    expect(harness.hosts).toHaveLength(2)
  })

  it('opens fatal recovery when the replacement page cannot reload', async () => {
    const host = await readyForUpdate()
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    const preparing = harness.prepareUpdate()
    await host.stopping.promise
    host.exited.resolve()
    await expect(preparing).resolves.toBe(true)
    const window = harness.windows[0]!
    vi.spyOn(window, 'loadURL').mockRejectedValueOnce(new Error('replacement page failed to load'))
    harness.dialog.showMessageBox.mockImplementation((options: MessageBoxOptions) => {
      if (options.detail?.includes('replacement page failed to load')) {
        harness.dialogShown.resolve()
        return new Promise(() => {})
      }
      return Promise.resolve({ response: 1 })
    })
    const restarted = harness.nextHostStart()
    harness.publishUpdate({ phase: 'error', version: '1.0.1-nightly.1', failedOperation: 'install', message: 'Installer failed' })
    await restarted
    harness.hosts[1]!.ready.resolve()
    await harness.dialogShown.promise
    expect(harness.dialog.showMessageBox.mock.calls.some(call =>
      (call.at(-1) as MessageBoxOptions).detail?.includes('replacement page failed to load'))).toBe(true)
  })

  it('reports a window construction failure without requiring a window', async () => {
    const shown = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementation(() => { shown.resolve(undefined); return new Promise(() => {}) })
    harness.failWindow(new Error('window creation failed'))
    await import('../src/main.ts')
    await shown.promise
    expect(harness.windows).toHaveLength(0)
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('window creation failed')
  })

  it('accepts Web fatal reports only from the primary application frame', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    const frame = { url: 'dsh-app://app/' }
    Object.assign(window.webContents, { mainFrame: frame })
    const handler = harness.handlers.get(DESKTOP_IPC.bootFailed)! as unknown as (event: unknown, message: unknown) => void
    const event = { sender: window.webContents, senderFrame: frame }
    expect(() => { handler({ ...event, senderFrame: { url: 'https://other.example/' } }, 'untrusted') }).toThrow('unowned renderer')
    expect(() => { handler({ ...event, senderFrame: { ...frame } }, 'subframe') }).toThrow('non-primary frame')
    expect(() => { handler(event, {}) }).toThrow('must be text')
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    handler(event, 'client mount failed')
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('client mount failed')
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('ignores subresource failures and navigation cancellation but reports a failed main document', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('did-fail-load', {}, -2, 'failed', 'dsh-app://app/image.png', false)
    window.webContents.emit('did-fail-load', {}, -3, 'aborted', 'dsh-app://app/', true)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    window.webContents.emit('did-fail-load', {}, -2, 'failed', 'dsh-app://app/', true)
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('Desktop page failed to load')
  })

  it('offers all recovery choices when resources fail before the Host starts', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.reject(new Error('runtime resources missing'))
    await harness.dialogShown.promise
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('runtime resources missing')
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).buttons).toEqual(['Exit', 'Restart', 'Disable third-party plugins, back up profile patch, and restart'])
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
  })

  it.each(['preload', 'renderer'])('retains the document after a fatal %s failure and reports only the first error', async (kind) => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    if (kind === 'preload') window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    else window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('secondary failure'))
    harness.prepared.reject(new Error('backend also failed'))
    await harness.dialogShown.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).not.toContain('secondary failure')
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('ignores clean renderer exits and exits of a closed window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('render-process-gone', {}, { reason: 'clean-exit' })
    window.close()
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('reports a rejected document load without navigating to a recovery page', async () => {
    const shown = Promise.withResolvers<undefined>()
    harness.dialog.showMessageBox.mockImplementation(() => { shown.resolve(undefined); return new Promise(() => {}) })
    vi.spyOn(harness.FakeWindow.prototype, 'loadURL').mockRejectedValueOnce(new Error('document missing'))
    await import('../src/main.ts')
    await shown.promise
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect((harness.dialog.showMessageBox.mock.calls[0]![0] as MessageBoxOptions).detail).toContain('document missing')
    expect(harness.hosts).toHaveLength(0)
  })

  it.each([0, 1, 2])('waits for Host exit before recovery action %s', async (response) => {
    harness.dialog.showMessageBox.mockResolvedValue({ response, checkboxChecked: false })
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const host = harness.hosts[0]!
    host.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.boot))
    host.onFailure!(new Error('backend exited'))
    await host.stopping.promise
    expect(harness.app.relaunch).not.toHaveBeenCalled()
    expect(harness.disableAllPlugins).not.toHaveBeenCalled()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(harness.app.relaunch).toHaveBeenCalledTimes(response === 0 ? 0 : 1)
    expect(harness.disableAllPlugins).toHaveBeenCalledTimes(response === 2 ? 1 : 0)
    if (response === 2) {
      expect(console.info).toHaveBeenCalledWith('Desktop profile recovery completed:', {
        profilePatchBackup: 'desktop-test-profile/cordis.patch.yml.bak-1789555200000', homePatch: 'unchanged',
      })
    } else {
      expect(console.info).not.toHaveBeenCalled()
    }
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
  })

  it('shows the loading window before profile preparation and starts one actual Host', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    expect(harness.windows).toHaveLength(1)
    const window = harness.windows[0]!
    expect(window.options.show).toBe(true)
    expect(window.urls).toEqual(['dsh-app://app/'])
    expect(harness.hosts).toHaveLength(0)
    const retry = invoke(DESKTOP_IPC.boot)
    const secondRetry = invoke(DESKTOP_IPC.boot)
    harness.prepared.resolve()
    await harness.hostStarted.promise
    expect(harness.hosts).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
    harness.hosts[0]!.ready.resolve()
    await Promise.all([retry, secondRetry, harness.navigated.promise])
    expect(harness.applyRelease).toHaveBeenCalledTimes(1)
    expect(harness.hosts[0]).toMatchObject({
      node: process.execPath,
      runtime: join(harness.app.getAppPath(), 'dsh'),
      primaryRuntime: join('desktop-test-resources', 'runtime', 'primary-runtime'),
      profileResolution: 'runtime',
      profile: 'desktop-test-profile',
    })
    expect(harness.hosts[0]!.environment).toBe(process.env)
    expect(harness.hosts[0]!.start).toHaveBeenCalledTimes(1)
    expect(harness.windows).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
  })

  it('prepares an independent plugin profile for the unpackaged Host', async () => {
    harness.app.isPackaged = false
    vi.stubEnv('DSH_DESKTOP_DSH_DIR', undefined)
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const project = join(harness.app.getAppPath(), '.desktop-build', 'development', 'project')
    expect(harness.hosts[0]).toMatchObject({ node: process.execPath, runtime: project, profile: 'desktop-test-profile' })
    expect(harness.applyRelease).toHaveBeenCalledOnce()
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('keeps startup errors in the existing window without a retry handler', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const first = harness.hosts[0]!
    first.exited.resolve()
    first.ready.reject(new Error('plugin composition failed'))
    await harness.dialogShown.promise
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://app/'])
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(harness.handlers.has('dsh-desktop:backend-retry')).toBe(false)
    expect(harness.hosts).toHaveLength(1)
  })

  it('waits for a pending child to exit on quit without late window navigation', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const window = harness.windows[0]!
    const host = harness.hosts[0]!
    host.stop.mockImplementation(() => { host.stopping.resolve(); return host.exited.promise })
    window.close()
    harness.app.quit()
    await host.stopping.promise
    expect(harness.app.quit).toHaveBeenCalledTimes(1)
    host.ready.resolve()
    host.exited.resolve()
    await harness.quitCompleted.promise
    expect(host.stop).toHaveBeenCalledTimes(1)
    expect(window.urls).toEqual(['dsh-app://app/'])
    expect(harness.windows).toHaveLength(1)
  })
})
