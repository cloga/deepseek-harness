import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC, type DshDesktopApplicationApi, type DshDesktopStartupApi } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: {
    invoke: vi.fn(),
    on: vi.fn<(channel: string, handler: (event: unknown, state: unknown) => void) => void>(),
    off: vi.fn(),
    send: vi.fn(),
  },
}))
vi.mock('electron', () => electron)

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules() })

it.each(['dsh-app://app/index.html', 'https://shell/startup.html'])('exposes only fixed notification and impact operations to %s', async (url) => {
  vi.stubGlobal('location', new URL(url))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DshDesktopApplicationApi
  expect(Object.keys(api)).toEqual(['protocolVersion', 'updates'])
  expect(Object.keys(api.updates).sort()).toEqual(['reportImpact', 'review', 'status', 'subscribe'])
  expect(api.protocolVersion).toBe(2)
  expect(api).not.toHaveProperty('plugins')
  expect(api.updates).not.toHaveProperty('install')
  expect(api.updates).not.toHaveProperty('check')
  const available = { phase: 'available', version: '1.2.3' }
  electron.ipcRenderer.invoke.mockResolvedValueOnce(available)
  expect(await api.updates.status()).toEqual(available)
  await api.updates.review()
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    [DESKTOP_IPC.updatesStatus], [DESKTOP_IPC.updatesInstall],
  ])
  const listener = vi.fn()
  const dispose = api.updates.subscribe(listener)
  const handler = electron.ipcRenderer.on.mock.calls[0]?.[1] as (event: unknown, state: unknown) => void
  handler({ sender: 'not exposed' }, available)
  expect(listener).toHaveBeenCalledExactlyOnceWith(available)
  dispose()
  expect(electron.ipcRenderer.off).toHaveBeenCalledWith(DESKTOP_IPC.updatesState, handler)
  api.updates.reportImpact({ hasDraft: true, attachmentCount: 2, submitting: false })
  expect(electron.ipcRenderer.send).toHaveBeenCalledWith(DESKTOP_IPC.updatesImpactReport, {
    hasDraft: true,
    attachmentCount: 2,
    submitting: false,
  })
})

it('contains update subscriber failures without starving another subscriber', async () => {
  vi.stubGlobal('location', new URL('dsh-app://app/index.html'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DshDesktopApplicationApi
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  const failure = new Error('subscriber failed')
  api.updates.subscribe(() => { throw failure })
  const listener = vi.fn()
  api.updates.subscribe(listener)
  for (const [, handler] of electron.ipcRenderer.on.mock.calls) handler({}, { phase: 'available', version: '1.2.3' })
  expect(diagnostic).toHaveBeenCalledWith('desktop update notification listener failed', failure)
  expect(listener).toHaveBeenCalledOnce()
  diagnostic.mockRestore()
})

it('provides startup controls and a removable state subscription to shell documents', async () => {
  vi.stubGlobal('location', new URL('dsh-app://shell/startup.html'))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as DshDesktopStartupApi
  await api.locale()
  await api.backend.status()
  await api.disablePlugins()
  await api.resetConfiguration()
  await api.restart()
  expect(electron.ipcRenderer.invoke.mock.calls).toEqual([
    [DESKTOP_IPC.localeGet], [DESKTOP_IPC.backendStatus],
    [DESKTOP_IPC.pluginsDisableAll], [DESKTOP_IPC.configurationReset], [DESKTOP_IPC.applicationRestart],
  ])
  const listener = vi.fn()
  const dispose = api.backend.subscribe(listener)
  const handler = electron.ipcRenderer.on.mock.calls[0]?.[1] as (event: unknown, state: unknown) => void
  handler({}, { phase: 'error', message: 'startup failed' })
  expect(listener).toHaveBeenCalledWith({ phase: 'error', message: 'startup failed' })
  dispose()
  expect(electron.ipcRenderer.off).toHaveBeenCalledWith(DESKTOP_IPC.backendState, handler)
  expect(api).not.toHaveProperty('plugins')
})
