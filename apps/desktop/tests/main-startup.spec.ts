import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { DESKTOP_IPC, type DesktopUpdateState } from '../src/ipc.ts'
import type { DesktopManagedUpdateSelection } from '../src/managed-update-coordinator.ts'
import type { DesktopManagedUpdateLaunch } from '../src/managed-update-launcher.ts'
import { managedManifest } from './managed-update-fixture.ts'

const harness = await vi.hoisted(async () => {
  const { EventEmitter } = await import('node:events')
  function deferred() {
    let resolve!: () => void
    let reject!: (error: Error) => void
    const promise = new Promise<void>((accept, decline) => { resolve = accept; reject = decline })
    return { promise, resolve, reject }
  }
  const windows: FakeWindow[] = []
  const hosts: FakeHost[] = []
  const managerRuntimes: unknown[] = []
  const managedHandoffs: Array<(selection: DesktopManagedUpdateSelection) => Promise<void>> = []
  const handlers = new Map<string, (event: { senderFrame: { url: string } }) => unknown>()
  let pluginsEnabled = false
  let preparing = deferred()
  let prepared = deferred()
  let hostStarted = deferred()
  let navigated = deferred()
  let errorPublished = deferred()
  let quitCompleted = deferred()
  let managedUpdates = false
  let updatePublisher = (state: DesktopUpdateState): DesktopUpdateState => state
  let beforeNativeRestart = async (): Promise<void> => {}
  let hostImpacts = [{ runningSessions: 0, queuedMessages: 0, runningJobs: 0 }]
  class FakeWindow extends EventEmitter {
    destroyed = false
    readonly urls: string[] = []
    readonly webContents = Object.assign(new EventEmitter(), {
      setWindowOpenHandler: vi.fn(),
      openDevTools: vi.fn(),
      getURL: () => this.urls.at(-1) ?? '',
      send: vi.fn((channel: string, state: { phase?: string }) => {
        if (channel === 'dsh-desktop:backend-state' && state.phase === 'error') errorPublished.resolve()
      }),
    })
    readonly show = vi.fn()
    readonly focus = vi.fn()
    readonly restore = vi.fn()
    constructor(readonly options: { show: boolean; icon: string }) { super(); windows.push(this) }
    isDestroyed() { return this.destroyed }
    isMinimized() { return false }
    async loadURL(url: string) {
      this.urls.push(url)
      if (url === 'dsh-app://app/index.html') navigated.resolve()
    }
    static getAllWindows() { return windows.filter(window => !window.destroyed) }
    close() { this.destroyed = true; this.emit('closed') }
  }
  class FakeHost {
    readonly pid = 321
    readonly ready = deferred()
    readonly exited = deferred()
    readonly stopping = deferred()
    readonly start = vi.fn(() => { hostStarted.resolve(); return this.ready.promise })
    readonly stop = vi.fn(() => {
      this.stopping.resolve()
      this.ready.reject(new Error('child stopped'))
      return this.exited.promise
    })
    readonly updateImpact = vi.fn(async () => hostImpacts.shift()
      ?? { runningSessions: 0, queuedMessages: 0, runningJobs: 0 })
    constructor(readonly node: string, readonly runtime: string, readonly profile: string) { hosts.push(this) }
  }
  const app = Object.assign(new EventEmitter(), {
    isPackaged: true,
    name: 'Desktop test',
    whenReady: () => Promise.resolve(),
    getLocale: () => 'en-US',
    getVersion: () => '1.0.0',
    getAppPath: () => 'desktop-test-app',
    getPath: () => 'desktop-test-user-data',
    requestSingleInstanceLock: () => true,
    exit: vi.fn(),
    relaunch: vi.fn(),
    quit: vi.fn(() => {
      const event = { preventDefault: vi.fn() }
      app.emit('before-quit', event)
      if (event.preventDefault.mock.calls.length === 0) quitCompleted.resolve()
    }),
  })
  return {
    windows, hosts, managerRuntimes, managedHandoffs, handlers, app, FakeWindow, FakeHost,
    launchUpdate: vi.fn(async (_options: DesktopManagedUpdateLaunch) => { throw new Error('helper fixture stopped') }),
    dialog: { showErrorBox: vi.fn(), showMessageBox: vi.fn() },
    menu: { setApplicationMenu: vi.fn(), buildFromTemplate: vi.fn() },
    publishUpdate: (state: DesktopUpdateState) => updatePublisher(state),
    setUpdatePublisher(publish: typeof updatePublisher) { updatePublisher = publish },
    setBeforeNativeRestart(callback: typeof beforeNativeRestart) { beforeNativeRestart = callback },
    beforeNativeRestart: () => beforeNativeRestart(),
    managedCheck: vi.fn<() => Promise<DesktopUpdateState>>(async () => ({
      phase: 'available' as const,
      mode: 'github-release-managed' as const,
      version: '1.2.3',
    })),
    managedInstall: vi.fn<() => Promise<DesktopUpdateState>>(async () => ({
      phase: 'installing' as const,
      mode: 'github-release-managed' as const,
      version: '1.2.3',
    })),
    applyRelease: vi.fn(() => { preparing.resolve(); return prepared.promise }),
    completeUpdate: vi.fn(async (..._args: unknown[]) => ({ status: 'none' as const })),
    assertProfileRuntime: vi.fn(),
    canRecoverProfile: vi.fn(() => true),
    get preparing() { return preparing }, get prepared() { return prepared },
    get hostStarted() { return hostStarted }, get navigated() { return navigated },
    get errorPublished() { return errorPublished }, get quitCompleted() { return quitCompleted },
    nextHostStart() { hostStarted = deferred(); return hostStarted.promise },
    get pluginsEnabled() { return pluginsEnabled },
    set pluginsEnabled(value: boolean) { pluginsEnabled = value },
    get managedUpdates() { return managedUpdates },
    set managedUpdates(value: boolean) { managedUpdates = value },
    setHostImpacts(value: typeof hostImpacts) { hostImpacts = [...value] },
    reset() {
      windows.length = 0; hosts.length = 0; managerRuntimes.length = 0; managedHandoffs.length = 0
      handlers.clear(); app.removeAllListeners()
      app.isPackaged = true
      pluginsEnabled = false
      managedUpdates = false
      hostImpacts = [{ runningSessions: 0, queuedMessages: 0, runningJobs: 0 }]
      preparing = deferred(); prepared = deferred(); hostStarted = deferred()
      navigated = deferred(); errorPublished = deferred(); quitCompleted = deferred()
    },
  }
})

vi.mock('electron', () => ({
  app: harness.app,
  BrowserWindow: harness.FakeWindow,
  dialog: harness.dialog,
  ipcMain: {
    handle: (channel: string, handler: (event: { senderFrame: { url: string } }) => unknown) => { harness.handlers.set(channel, handler) },
    on: vi.fn(),
  },
  Menu: harness.menu,
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) =>
      (String(path).includes('desktop-provisioning') && harness.managedUpdates) || actual.existsSync(path),
  }
})
vi.mock('../src/paths.ts', () => ({ resolveDesktopPaths: () => ({ profile: 'desktop-test-profile' }) }))
vi.mock('../src/project-manager.ts', () => ({
  DesktopProjectManager: class {
    readonly paths = { profile: 'desktop-test-profile' }
    readonly applyRelease = harness.applyRelease
    readonly assertProfileRuntime = harness.assertProfileRuntime
    canRecoverProfile = harness.canRecoverProfile
    constructor(_paths: unknown, runtime: unknown) { harness.managerRuntimes.push(runtime) }
    async reconcileProvisioning() {}
    async mutate(_mutation: unknown, hooks: { beforeChange(): Promise<void>; afterChange(): Promise<void> }) {
      await hooks.beforeChange()
      harness.pluginsEnabled = false
      await hooks.afterChange()
    }
    async resetConfiguration(hooks: { beforeChange(): Promise<void>; afterChange(): Promise<void> }) {
      await this.mutate(undefined, hooks)
    }
  },
}))
vi.mock('../src/plugin-provisioning.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/plugin-provisioning.ts')>()
  return {
    ...actual,
    readDesktopPluginProvisioningPlan: () => ({ schemaVersion: 1, mode: 'exact', plugins: [] }),
  }
})
vi.mock('../src/host-process.ts', () => ({ DesktopHostProcess: harness.FakeHost }))
vi.mock('../src/managed-update-completion.ts', () => ({ completeDesktopManagedUpdate: harness.completeUpdate }))
vi.mock('../src/update-coordinator.ts', () => ({
  DesktopUpdateCoordinator: class {
    constructor(publish: (state: DesktopUpdateState) => DesktopUpdateState, beforeRestart: () => Promise<void>) {
      harness.setUpdatePublisher(publish)
      harness.setBeforeNativeRestart(beforeRestart)
    }
    async check() { return harness.publishUpdate(await harness.managedCheck()) }
    async install() { return harness.publishUpdate(await harness.managedInstall()) }
  },
}))
vi.mock('../src/managed-update-state.ts', () => ({
  loadDesktopManagedUpdateConfiguration: () => harness.managedUpdates
    ? {
      capability: {
        schemaVersion: 2,
        mode: 'github-release-managed',
        owner: 'cloga/deepseek-harness',
        tagPrefix: 'dsh-desktop-v',
        manifestAsset: 'release.json',
        currentSequence: 2,
        minimumSequence: 2,
      },
      installedSequence: 2,
      completedSequence: 1,
      operationsRoot: 'desktop-test-operations',
      completionPath: 'desktop-test-completion.json',
      helperBundle: 'desktop-test-helper.mjs',
    }
    : undefined,
}))
vi.mock('../src/managed-update-launcher.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/managed-update-launcher.ts')>()
  return { ...actual, launchDesktopManagedUpdate: harness.launchUpdate }
})
vi.mock('../src/managed-update-coordinator.ts', () => ({
  DesktopManagedUpdateCoordinator: class {
    constructor(_capability: unknown, _sequence: unknown, publish: (state: DesktopUpdateState) => DesktopUpdateState,
      install: (selection: DesktopManagedUpdateSelection) => Promise<void>) {
      harness.setUpdatePublisher(publish)
      harness.managedHandoffs.push(install)
    }
    async check() {
      harness.publishUpdate({ phase: 'checking', mode: 'github-release-managed' })
      return harness.publishUpdate(await harness.managedCheck())
    }
    async install() {
      harness.publishUpdate({ phase: 'installing', version: '1.2.3', mode: 'github-release-managed' })
      return harness.publishUpdate(await harness.managedInstall())
    }
  },
}))

function invoke(channel: string, url = 'dsh-app://shell/startup.html'): unknown {
  const handler = harness.handlers.get(channel)
  if (handler === undefined) throw new Error(`missing handler ${channel}`)
  return handler({ senderFrame: { url } })
}

async function startApplication(): Promise<void> {
  await import('../src/main.ts')
  await harness.preparing.promise
  harness.prepared.resolve()
  await harness.hostStarted.promise
  harness.hosts[0]!.ready.resolve()
  await harness.navigated.promise
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  vi.useFakeTimers()
  harness.reset()
  harness.dialog.showMessageBox.mockReset()
  harness.managedCheck.mockReset().mockResolvedValue({ phase: 'available', mode: 'github-release-managed', version: '1.2.3' })
  harness.managedInstall.mockReset().mockResolvedValue({ phase: 'installing', mode: 'github-release-managed', version: '1.2.3' })
  vi.stubEnv('DSH_DESKTOP_NODE_BINARY', 'test-node')
  vi.stubEnv('DSH_DESKTOP_PNPM_ENTRY', 'test-pnpm')
  vi.stubEnv('DSH_DESKTOP_DSH_DIR', 'test-runtime')
  vi.stubGlobal('process', { ...process, resourcesPath: 'desktop-test-resources' })
  vi.stubEnv('DSH_DESKTOP_HOST_INSPECT_PORT', undefined)
})

afterEach(async () => {
  harness.prepared.resolve()
  for (const host of harness.hosts) { host.ready.resolve(); host.exited.resolve() }
  harness.app.quit()
  await harness.quitCompleted.promise
  vi.restoreAllMocks()
  harness.canRecoverProfile.mockReturnValue(true)
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
})

describe('desktop main startup', () => {
  it('uses the packaged whale icon before the Host is ready', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    expect(harness.windows[0]!.options.icon).toBe(join(harness.app.getAppPath(), 'assets', 'whale.png'))
  })

  it.each([false, true])('silently discovers updates at ten seconds and every six hours while open: managed=%s', async (managed) => {
    harness.managedUpdates = managed
    await startApplication()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(harness.managedCheck).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.managedCheck).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000 - 1)
    expect(harness.managedCheck).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(1)
    expect(harness.managedCheck).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(harness.managedCheck).toHaveBeenCalledTimes(3)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(harness.managedInstall).not.toHaveBeenCalled()
    expect(harness.app.quit).not.toHaveBeenCalled()
    expect(harness.app.relaunch).not.toHaveBeenCalled()
  })

  it.each([
    { managed: true, response: 0 }, { managed: true, response: 1 },
    { managed: false, response: 0 }, { managed: false, response: 1 },
  ])('requires explicit review consent and retains availability after Later: $managed / $response', async ({ managed, response }) => {
    harness.managedUpdates = managed
    harness.managedCheck.mockResolvedValue({ phase: 'available', version: '1.2.3', mode: managed ? 'github-release-managed' : 'native' })
    harness.dialog.showMessageBox.mockResolvedValue({ response })
    await startApplication()
    await vi.advanceTimersByTimeAsync(10_000)
    await Promise.resolve(invoke(DESKTOP_IPC.updatesInstall, 'dsh-app://app/index.html'))
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    const prompt = harness.dialog.showMessageBox.mock.calls[0]?.[0] as { detail: string; cancelId: number } | undefined
    expect(prompt?.detail).toContain(managed ? 'Running Sessions: 0' : '1.2.3')
    expect(prompt?.cancelId).toBe(1)
    expect(harness.managedInstall).toHaveBeenCalledTimes(response === 0 ? 1 : 0)
    expect(invoke(DESKTOP_IPC.updatesStatus, 'dsh-app://app/index.html')).toMatchObject({
      phase: response === 0 ? 'installing' : 'available', version: '1.2.3',
    })
    expect(harness.managedCheck).toHaveBeenCalledOnce()
  })

  it('serves late mounts and reloads the retained notification without replacing it on transient errors or older versions', async () => {
    harness.managedUpdates = true
    await startApplication()
    await vi.advanceTimersByTimeAsync(10_000)
    const available = { phase: 'available', mode: 'github-release-managed', version: '1.2.3' }
    await harness.windows[0]!.loadURL('dsh-app://app/index.html')
    expect(invoke(DESKTOP_IPC.updatesStatus, 'dsh-app://app/index.html')).toEqual(available)
    const shell = new harness.FakeWindow({ show: true, icon: '' })
    await shell.loadURL('dsh-app://shell/plugin-manager.html')
    const pending = Promise.withResolvers<DesktopUpdateState>()
    harness.managedCheck.mockReturnValueOnce(pending.promise)
    const checking = Promise.resolve(invoke(DESKTOP_IPC.updatesCheck))
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke(DESKTOP_IPC.updatesStatus)).toEqual(available)
    pending.resolve({ phase: 'error', message: 'offline', mode: 'github-release-managed' })
    await checking
    expect(invoke(DESKTOP_IPC.updatesStatus)).toEqual(available)
    expect(harness.windows[0]!.webContents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.updatesState, available)
    expect(shell.webContents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.updatesState, {
      phase: 'error', message: 'offline', mode: 'github-release-managed',
    })
    for (const version of ['1.2.2', '1.2.3']) {
      harness.managedCheck.mockResolvedValueOnce({ phase: 'available', version, mode: 'github-release-managed' })
      await Promise.resolve(invoke(DESKTOP_IPC.updatesCheck))
      expect(invoke(DESKTOP_IPC.updatesStatus)).toEqual(available)
    }
    harness.managedCheck.mockResolvedValueOnce({ phase: 'available', version: '1.3.0', mode: 'github-release-managed' })
    await Promise.resolve(invoke(DESKTOP_IPC.updatesCheck))
    expect(invoke(DESKTOP_IPC.updatesStatus)).toMatchObject({ phase: 'available', version: '1.3.0' })
    harness.managedCheck.mockResolvedValueOnce({ phase: 'idle', mode: 'github-release-managed' })
    await Promise.resolve(invoke(DESKTOP_IPC.updatesCheck))
    expect(invoke(DESKTOP_IPC.updatesStatus)).toEqual({ phase: 'idle', mode: 'github-release-managed' })
  })

  it('coalesces a pending automatic check across timer ticks and a manual shell check', async () => {
    harness.managedUpdates = true
    const pending = Promise.withResolvers<DesktopUpdateState>()
    harness.managedCheck.mockReturnValueOnce(pending.promise)
    await startApplication()
    await vi.advanceTimersByTimeAsync(10_000)
    const manual = Promise.resolve(invoke(DESKTOP_IPC.updatesCheck))
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000)
    expect(harness.managedCheck).toHaveBeenCalledOnce()
    pending.resolve({ phase: 'available', version: '1.2.3' })
    await manual
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(harness.managedCheck).toHaveBeenCalledTimes(2)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
  })

  it('reports an initial check failure without a modal or an unhandled rejection', async () => {
    harness.managedUpdates = true
    harness.managedCheck.mockRejectedValueOnce(new Error('initial check failed'))
    await startApplication()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(invoke(DESKTOP_IPC.updatesStatus)).toEqual({ phase: 'error', message: 'initial check failed' })
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(harness.managedInstall).not.toHaveBeenCalled()
  })

  it('rejects a failed explicit review without clearing availability and permits another review', async () => {
    harness.managedUpdates = true
    await startApplication()
    await vi.advanceTimersByTimeAsync(10_000)
    harness.dialog.showMessageBox.mockRejectedValueOnce(new Error('dialog unavailable'))
    await expect(Promise.resolve(invoke(DESKTOP_IPC.updatesInstall, 'dsh-app://app/index.html'))).rejects.toThrow('dialog unavailable')
    expect(invoke(DESKTOP_IPC.updatesStatus)).toMatchObject({ phase: 'available', version: '1.2.3' })
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    await Promise.resolve(invoke(DESKTOP_IPC.updatesInstall, 'dsh-app://app/index.html'))
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(harness.managedInstall).not.toHaveBeenCalled()
  })

  it('rejects app review when refreshing a retained available release resolves an error', async () => {
    harness.managedUpdates = true
    await startApplication()
    await vi.advanceTimersByTimeAsync(10_000)
    harness.managedCheck.mockResolvedValue({ phase: 'error', message: 'release check unavailable', mode: 'github-release-managed' })
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    await expect(Promise.resolve(invoke(DESKTOP_IPC.updatesInstall, 'dsh-app://app/index.html')))
      .rejects.toThrow('release check unavailable')
    expect(invoke(DESKTOP_IPC.updatesStatus, 'dsh-app://app/index.html')).toMatchObject({ phase: 'available', version: '1.2.3' })
    await vi.advanceTimersByTimeAsync(1000)
    expect(harness.managedCheck).toHaveBeenCalledTimes(3)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(harness.managedInstall).not.toHaveBeenCalled()
    expect(harness.app.quit).not.toHaveBeenCalled()
  })

  it('rejects app review and retains the failed installation version when its resolved error omits the version', async () => {
    harness.managedUpdates = true
    await startApplication()
    await vi.advanceTimersByTimeAsync(10_000)
    const shell = new harness.FakeWindow({ show: true, icon: '' })
    await shell.loadURL('dsh-app://shell/plugin-manager.html')
    const failure: DesktopUpdateState = { phase: 'error', message: 'managed handoff failed', mode: 'github-release-managed' }
    harness.managedInstall.mockResolvedValueOnce(failure)
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 })
    await expect(Promise.resolve(invoke(DESKTOP_IPC.updatesInstall, 'dsh-app://app/index.html')))
      .rejects.toThrow('managed handoff failed')
    expect(invoke(DESKTOP_IPC.updatesStatus, 'dsh-app://app/index.html')).toEqual({ ...failure, version: '1.2.3' })
    expect(harness.windows[0]!.webContents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.updatesState, { ...failure, version: '1.2.3' })
    expect(shell.webContents.send).toHaveBeenLastCalledWith(DESKTOP_IPC.updatesState, failure)
    await vi.advanceTimersByTimeAsync(1000)
    expect(harness.managedCheck).toHaveBeenCalledOnce()
    expect(harness.managedInstall).toHaveBeenCalledOnce()
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(harness.app.quit).not.toHaveBeenCalled()
    harness.managedCheck.mockResolvedValueOnce({ phase: 'error', message: 'offline', mode: 'github-release-managed' })
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(invoke(DESKTOP_IPC.updatesStatus)).toMatchObject({ phase: 'error', version: '1.2.3', message: 'offline' })
    expect(harness.managedInstall).toHaveBeenCalledOnce()
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
  })

  it('continues to show the manual menu installation error in a native dialog', async () => {
    harness.managedUpdates = true
    await startApplication()
    const template = harness.menu.buildFromTemplate.mock.calls[0]?.[0] as { submenu: { click?: () => void }[] }[]
    harness.managedInstall.mockResolvedValueOnce({ phase: 'error', message: 'installer unavailable', mode: 'github-release-managed' })
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 0 }).mockResolvedValueOnce({ response: 1 })
    template[0]!.submenu[1]!.click!()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    expect(harness.dialog.showMessageBox).toHaveBeenLastCalledWith(expect.objectContaining({ type: 'error', message: 'installer unavailable' }))
    expect(harness.managedInstall).toHaveBeenCalledOnce()
    expect(invoke(DESKTOP_IPC.updatesStatus)).toMatchObject({ phase: 'error', version: '1.2.3' })
  })

  it('does not install after quitting while a review dialog is pending', async () => {
    harness.managedUpdates = true
    const consent = Promise.withResolvers<{ response: number }>()
    harness.dialog.showMessageBox.mockReturnValueOnce(consent.promise)
    await startApplication()
    await vi.advanceTimersByTimeAsync(10_000)
    const review = Promise.resolve(invoke(DESKTOP_IPC.updatesInstall, 'dsh-app://app/index.html'))
    await vi.advanceTimersByTimeAsync(0)
    harness.hosts[0]!.exited.resolve()
    harness.app.quit()
    await harness.quitCompleted.promise
    consent.resolve({ response: 0 })
    await review
    expect(harness.managedInstall).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('contains rejected automatic checks, retains availability, and recovers on a later check', async () => {
    harness.managedUpdates = true
    await startApplication()
    await vi.advanceTimersByTimeAsync(10_000)
    harness.managedCheck.mockRejectedValueOnce(new Error('network failed'))
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(invoke(DESKTOP_IPC.updatesStatus)).toMatchObject({ phase: 'available', version: '1.2.3' })
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(harness.managedInstall).not.toHaveBeenCalled()
    harness.managedCheck.mockResolvedValueOnce({ phase: 'idle' })
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(invoke(DESKTOP_IPC.updatesStatus)).toEqual({ phase: 'idle' })
  })

  it('skips automatic checks during review and installation', async () => {
    harness.managedUpdates = true
    const consent = Promise.withResolvers<{ response: number }>()
    const installation = Promise.withResolvers<DesktopUpdateState>()
    harness.dialog.showMessageBox.mockReturnValueOnce(consent.promise)
    harness.managedInstall.mockReturnValueOnce(installation.promise)
    await startApplication()
    await vi.advanceTimersByTimeAsync(10_000)
    const review = Promise.resolve(invoke(DESKTOP_IPC.updatesInstall, 'dsh-app://app/index.html'))
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(harness.managedCheck).toHaveBeenCalledOnce()
    consent.resolve({ response: 0 })
    await vi.advanceTimersByTimeAsync(0)
    expect(invoke(DESKTOP_IPC.updatesStatus)).toMatchObject({ phase: 'installing' })
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(harness.managedCheck).toHaveBeenCalledOnce()
    installation.resolve({ phase: 'ready', version: '1.2.3' })
    await review
    await vi.advanceTimersByTimeAsync(6 * 60 * 60 * 1000)
    expect(harness.managedCheck).toHaveBeenCalledOnce()
  })

  it.each([false, true])('clears startup and periodic timers on ordinary quit: afterInitialCheck=%s', async (afterInitialCheck) => {
    harness.managedUpdates = true
    await startApplication()
    if (afterInitialCheck) await vi.advanceTimersByTimeAsync(10_000)
    harness.hosts[0]!.exited.resolve()
    harness.app.quit()
    await harness.quitCompleted.promise
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000)
    expect(harness.managedCheck).toHaveBeenCalledTimes(afterInitialCheck ? 1 : 0)
  })

  it('clears periodic timers when the native updater owns quit', async () => {
    await startApplication()
    await vi.advanceTimersByTimeAsync(10_000)
    harness.hosts[0]!.exited.resolve()
    await harness.beforeNativeRestart()
    harness.app.quit()
    await harness.quitCompleted.promise
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(12 * 60 * 60 * 1000)
    expect(harness.managedCheck).toHaveBeenCalledOnce()
  })

  it('suppresses a late automatic result after quit and never prompts or installs', async () => {
    harness.managedUpdates = true
    const pending = Promise.withResolvers<DesktopUpdateState>()
    harness.managedCheck.mockReturnValueOnce(pending.promise)
    await startApplication()
    await vi.advanceTimersByTimeAsync(10_000)
    harness.hosts[0]!.exited.resolve()
    harness.app.quit()
    await harness.quitCompleted.promise
    const sends = harness.windows[0]!.webContents.send.mock.calls.length
    pending.resolve({ phase: 'available', version: '2.0.0' })
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.windows[0]!.webContents.send).toHaveBeenCalledTimes(sends)
    expect(harness.dialog.showMessageBox).not.toHaveBeenCalled()
    expect(harness.managedInstall).not.toHaveBeenCalled()
  })

  it.each(['https://app/index.html', 'dsh-app://evil/index.html', 'dsh-app://app.evil/index.html', 'file:///app/index.html'])(
    'rejects update status, review, and check IPC from %s', async (url) => {
      await startApplication()
      for (const channel of [DESKTOP_IPC.updatesStatus, DESKTOP_IPC.updatesInstall, DESKTOP_IPC.updatesCheck]) {
        await expect(Promise.resolve().then(() => invoke(channel, url))).rejects.toThrow('unowned renderer')
      }
      expect(harness.managedCheck).not.toHaveBeenCalled()
      expect(harness.managedInstall).not.toHaveBeenCalled()
    },
  )

  it('allows app and shell status but keeps explicit checking shell-only and rejects absent frames', async () => {
    await startApplication()
    for (const url of ['dsh-app://app/index.html', 'dsh-app://shell/startup.html']) {
      expect(invoke(DESKTOP_IPC.updatesStatus, url)).toEqual({ phase: 'idle' })
    }
    await expect(Promise.resolve(invoke(DESKTOP_IPC.updatesCheck, 'dsh-app://app/index.html'))).rejects.toThrow('unowned renderer')
    const handler = harness.handlers.get(DESKTOP_IPC.updatesStatus)!
    expect(() => handler({ senderFrame: null } as unknown as Parameters<typeof handler>[0])).toThrow('without a sender frame')
  })

  it('keeps the manual menu check interactive and contains a rejected native dialog', async () => {
    harness.managedUpdates = true
    await startApplication()
    const template = harness.menu.buildFromTemplate.mock.calls[0]?.[0] as { submenu: { label?: string; click?: () => void }[] }[]
    const check = template[0]!.submenu.find(item => item.label === 'Check for updates…')
      ?? template[0]!.submenu[1]!
    harness.dialog.showMessageBox.mockResolvedValueOnce({ response: 1 })
    check.click!()
    await vi.advanceTimersByTimeAsync(0)
    expect(harness.dialog.showMessageBox).toHaveBeenCalledOnce()
    expect(harness.managedInstall).not.toHaveBeenCalled()
    const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
    const failure = new Error('dialog unavailable')
    harness.dialog.showMessageBox.mockRejectedValueOnce(failure)
    check.click!()
    await vi.advanceTimersByTimeAsync(0)
    expect(diagnostic).toHaveBeenCalledWith('desktop update review failed', failure)
  })

  it.each(['ready', 'failed'] as const)('records managed completion only after final Host readiness: %s', async (outcome) => {
    harness.managedUpdates = true
    await import('../src/main.ts')
    await harness.preparing.promise
    expect(harness.completeUpdate).not.toHaveBeenCalled()
    harness.prepared.resolve()
    await harness.hostStarted.promise
    expect(harness.completeUpdate).not.toHaveBeenCalled()
    const host = harness.hosts[0]!
    if (outcome === 'failed') {
      host.exited.resolve()
      host.ready.reject(new Error('final-location Host failed'))
      await harness.errorPublished.promise
      expect(harness.completeUpdate).not.toHaveBeenCalled()
    } else {
      host.ready.resolve()
      await harness.navigated.promise
      expect(harness.completeUpdate).toHaveBeenCalledOnce()
      expect(harness.completeUpdate.mock.calls[0]?.[3]).toBe(1)
      expect(harness.completeUpdate.mock.calls[0]?.at(-1)).toBe('desktop-test-profile')
    }
  })

  it('requires a fresh managed-update confirmation when active work changes in the dialog', async () => {
    harness.managedUpdates = true
    harness.setHostImpacts([
      { runningSessions: 0, queuedMessages: 0, runningJobs: 0 },
      { runningSessions: 1, queuedMessages: 0, runningJobs: 0 },
      { runningSessions: 1, queuedMessages: 0, runningJobs: 0 },
    ])
    harness.dialog.showMessageBox.mockResolvedValue({ response: 0 })
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise

    await Promise.resolve(invoke(DESKTOP_IPC.updatesInstall))

    expect(harness.dialog.showMessageBox).toHaveBeenCalledTimes(2)
    const firstDialog = harness.dialog.showMessageBox.mock.calls[0]?.[0] as { detail: string } | undefined
    const secondDialog = harness.dialog.showMessageBox.mock.calls[1]?.[0] as { detail: string } | undefined
    expect(firstDialog?.detail).toContain('Running Sessions: 0')
    expect(secondDialog?.detail).toContain('Running Sessions: 1')
    expect(harness.managedInstall).toHaveBeenCalledOnce()
  })

  it('exits with a diagnostic when both initialization and emergency navigation fail', async () => {
    const exited = Promise.withResolvers<undefined>()
    vi.spyOn(harness.app, 'getLocale').mockImplementationOnce(() => { throw new Error('locale unavailable') })
    vi.spyOn(harness.FakeWindow.prototype, 'loadURL').mockRejectedValueOnce(new Error('emergency navigation failed'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    harness.app.exit.mockImplementationOnce(() => { exited.resolve(undefined) })
    await import('../src/main.ts')
    await exited.promise
    expect(harness.app.exit).toHaveBeenCalledWith(1)
    expect(console.error).toHaveBeenCalledWith(expect.objectContaining({ message: 'emergency navigation failed' }))
  })

  it('withholds profile recovery after application resources fail to load', async () => {
    harness.canRecoverProfile.mockReturnValue(false)
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.reject(new Error('runtime resources missing'))
    await harness.errorPublished.promise
    expect(invoke(DESKTOP_IPC.backendStatus)).toMatchObject({ phase: 'error', profileRecovery: false })
    const window = harness.windows[0]!
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    const html = decodeURIComponent(window.urls.at(-1)!)
    expect(html).toContain('dsh-recovery://restart')
    expect(html).not.toContain('dsh-recovery://reset')
    expect(html).not.toContain('dsh-recovery://plugins')
  })

  it('reloads a crashed startup renderer in the same window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    await harness.errorPublished.promise
    expect(window.urls).toEqual(['dsh-app://shell/startup.html', 'dsh-app://shell/startup.html'])
    expect(invoke(DESKTOP_IPC.backendStatus)).toMatchObject({ phase: 'error', message: 'Desktop renderer exited: crashed' })
  })

  it.each(['plugins', 'reset'])('runs %s recovery from a document with a broken preload', async (action) => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.backendRetry))
    const started = harness.nextHostStart()
    const event = { preventDefault: vi.fn() }
    window.webContents.emit('will-navigate', event, `dsh-recovery://${action}/?`)
    await harness.hosts[0]!.stopping.promise
    harness.hosts[0]!.exited.resolve()
    await started
    harness.hosts[1]!.ready.resolve()
    await harness.navigated.promise
    expect(event.preventDefault).toHaveBeenCalled()
    expect(window.urls.at(-1)).toBe('dsh-app://app/index.html')
  })

  it('allows a full profile reset for an unclassified startup failure', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.exited.resolve()
    harness.hosts[0]!.ready.reject(new Error('Unknown startup failure'))
    await harness.errorPublished.promise
    const started = harness.nextHostStart()
    const reset = Promise.resolve(invoke(DESKTOP_IPC.configurationReset))
    await started
    harness.hosts[1]!.ready.resolve()
    await reset
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'ready' })
  })

  it('keeps a self-contained reinstall document in the main window after preload failure', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    const window = harness.windows[0]!
    window.webContents.emit('preload-error', {}, 'preload-app.cjs', new Error('preload unavailable'))
    expect(window.urls.at(-1)).toContain('data:text/html')
    expect(decodeURIComponent(window.urls.at(-1)!)).toContain('preload unavailable')
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await Promise.resolve(invoke(DESKTOP_IPC.backendRetry))
    expect(harness.windows).toHaveLength(1)
    expect(window.urls.at(-1)).toContain('data:text/html')
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('offers plugin recovery and disables plugins before restarting in the same window', async () => {
    harness.pluginsEnabled = true
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.exited.resolve()
    harness.hosts[0]!.ready.reject(new Error('Plugin initialization failed'))
    await harness.errorPublished.promise
    expect(invoke(DESKTOP_IPC.backendStatus)).toMatchObject({ phase: 'error', profileRecovery: true })
    const nextStarted = harness.nextHostStart()
    const recovery = Promise.resolve(invoke(DESKTOP_IPC.pluginsDisableAll))
    await nextStarted
    expect(harness.pluginsEnabled).toBe(false)
    harness.hosts[1]!.ready.resolve()
    await recovery
    expect(harness.windows).toHaveLength(1)
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'ready' })
  })

  it('waits for Host exit before relaunching the application', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    const restart = Promise.resolve(invoke(DESKTOP_IPC.applicationRestart))
    await harness.hosts[0]!.stopping.promise
    expect(harness.app.relaunch).not.toHaveBeenCalled()
    harness.hosts[0]!.exited.resolve()
    await restart
    expect(harness.app.relaunch).toHaveBeenCalledOnce()
  })

  it('shows the loading window before profile preparation and starts one actual Host', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    expect(harness.windows).toHaveLength(1)
    const window = harness.windows[0]!
    expect(window.options.show).toBe(true)
    expect(window.urls).toEqual(['dsh-app://shell/startup.html'])
    expect(harness.hosts).toHaveLength(0)
    const retry = invoke(DESKTOP_IPC.backendRetry)
    const secondRetry = invoke(DESKTOP_IPC.backendRetry)
    harness.prepared.resolve()
    await harness.hostStarted.promise
    expect(harness.hosts).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://shell/startup.html'])
    harness.hosts[0]!.ready.resolve()
    await Promise.all([retry, secondRetry, harness.navigated.promise])
    expect(harness.applyRelease).toHaveBeenCalledTimes(1)
    expect(harness.assertProfileRuntime).toHaveBeenCalledWith('desktop-test-profile')
    expect(harness.hosts[0]).toMatchObject({
      node: process.execPath,
      runtime: join(harness.app.getAppPath(), 'dsh'),
      profile: 'desktop-test-profile',
    })
    expect(harness.managerRuntimes[0]).toMatchObject({ profileResolution: 'runtime' })
    expect(harness.hosts[0]!.start).toHaveBeenCalledTimes(1)
    expect(harness.windows).toHaveLength(1)
    expect(window.urls).toEqual(['dsh-app://shell/startup.html', 'dsh-app://app/index.html'])
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'ready' })
  })

  it('keeps Electron Host execution separate from the bundled Node used by pnpm and the copied helper', async () => {
    harness.managedUpdates = true
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    const bundledNode = join(process.resourcesPath, 'runtime', 'node', process.platform === 'win32' ? 'node.exe' : 'node')
    expect(harness.managerRuntimes[0]).toMatchObject({
      node: bundledNode,
      dsh: join(harness.app.getAppPath(), 'dsh'),
      profileResolution: 'runtime',
    })
    expect(harness.hosts[0]!.node).toBe(process.execPath)
    const manifest = managedManifest()
    await expect(harness.managedHandoffs[0]!({
      kind: 'source',
      manifest,
      manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/download/example/release.json',
      manifestSha256: manifest.manifestSha256,
      assetSha256: manifest.installer.sha256,
    })).rejects.toThrow('helper fixture stopped')
    expect(harness.launchUpdate).toHaveBeenCalledWith(expect.objectContaining({
      nodeExecutable: bundledNode,
      helperBundle: 'desktop-test-helper.mjs',
    }))
    expect(harness.hosts[0]!.stop).not.toHaveBeenCalled()
  })

  it('starts the unpackaged Host from the application development directory', async () => {
    harness.app.isPackaged = false
    await import('../src/main.ts')
    await harness.hostStarted.promise
    const project = join(harness.app.getAppPath(), '.desktop-build', 'development', 'project')
    expect(harness.hosts[0]).toMatchObject({ node: 'test-node', runtime: project, profile: project })
    expect(harness.applyRelease).not.toHaveBeenCalled()
    expect(harness.assertProfileRuntime).not.toHaveBeenCalled()
    harness.hosts[0]!.ready.resolve()
    await harness.navigated.promise
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
  })

  it('keeps startup errors and a successful retry in the same window', async () => {
    await import('../src/main.ts')
    await harness.preparing.promise
    harness.prepared.resolve()
    await harness.hostStarted.promise
    const first = harness.hosts[0]!
    const failedRetry = expect(Promise.resolve(invoke(DESKTOP_IPC.backendRetry))).rejects.toThrow('plugin composition failed')
    first.exited.resolve()
    first.ready.reject(new Error('plugin composition failed'))
    await harness.errorPublished.promise
    await failedRetry
    expect(invoke(DESKTOP_IPC.backendStatus)).toEqual({ phase: 'error', message: 'plugin composition failed', profileRecovery: true })
    expect(harness.windows[0]!.urls).toEqual(['dsh-app://shell/startup.html'])
    const nextStarted = harness.nextHostStart()
    const retry = Promise.resolve(invoke(DESKTOP_IPC.backendRetry))
    await nextStarted
    expect(harness.hosts).toHaveLength(2)
    harness.hosts[1]!.ready.resolve()
    await retry
    expect(harness.windows).toHaveLength(1)
    expect(harness.windows[0]!.urls.at(-1)).toBe('dsh-app://app/index.html')
    expect(harness.dialog.showErrorBox).not.toHaveBeenCalled()
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
    expect(window.urls).toEqual(['dsh-app://shell/startup.html'])
    expect(harness.windows).toHaveLength(1)
  })
})
