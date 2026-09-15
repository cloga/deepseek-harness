import { afterEach, expect, it, vi } from 'vitest'
import { DESKTOP_IPC, type DshDesktopStartupApi } from '../src/ipc.ts'

const electron = vi.hoisted(() => ({
  contextBridge: { exposeInMainWorld: vi.fn() },
  ipcRenderer: { invoke: vi.fn(), on: vi.fn(), off: vi.fn(), send: vi.fn() },
}))
vi.mock('electron', () => electron)

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); vi.resetModules() })

it.each(['dsh-app://app/index.html', 'https://shell/startup.html'])('exposes the carrier marker and fixed update-impact bridge to %s', async (url) => {
  vi.stubGlobal('location', new URL(url))
  await import('../src/preload-app.ts')
  const api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as {
    protocolVersion: number
    updates: { reportImpact(value: unknown): void }
  }
  expect(api.protocolVersion).toBe(2)
  api.updates.reportImpact({ hasDraft: true, attachmentCount: 2, submitting: false })
  expect(electron.ipcRenderer.send).toHaveBeenCalledWith(DESKTOP_IPC.updatesImpactReport, {
    hasDraft: true,
    attachmentCount: 2,
    submitting: false,
  })
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
