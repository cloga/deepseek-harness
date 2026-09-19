/** Startup controls for shell documents; application documents receive fixed update notification controls. */

import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_IPC,
  parseDesktopRendererUpdateImpact,
  type DesktopRendererUpdateImpact,
  type DesktopUpdateState,
  type DshDesktopApplicationApi,
  type DshDesktopStartupApi,
} from './ipc.ts'
import type { DesktopBackendState } from './backend-controller.ts'

const startup: DshDesktopStartupApi = {
  protocolVersion: 2,
  locale: () => ipcRenderer.invoke(DESKTOP_IPC.localeGet) as ReturnType<DshDesktopStartupApi['locale']>,
  backend: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.backendStatus) as ReturnType<DshDesktopStartupApi['backend']['status']>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopBackendState): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.backendState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.backendState, handle) }
    },
  },
  disablePlugins: () => ipcRenderer.invoke(DESKTOP_IPC.pluginsDisableAll) as Promise<void>,
  restart: () => ipcRenderer.invoke(DESKTOP_IPC.applicationRestart) as Promise<void>,
  resetConfiguration: () => ipcRenderer.invoke(DESKTOP_IPC.configurationReset) as Promise<void>,
}

let currentImpact: DesktopRendererUpdateImpact | undefined
if (location.protocol === 'dsh-app:' && location.hostname === 'app') {
  ipcRenderer.on(DESKTOP_IPC.pluginImpactRequest, (_event, requestId: unknown) => {
    if (typeof requestId !== 'string' || !/^plugin-impact-[0-9]+$/u.test(requestId)) return
    ipcRenderer.send(DESKTOP_IPC.pluginImpactResponse, requestId, currentImpact ?? null)
  })
}

const application: DshDesktopApplicationApi = {
  protocolVersion: 2,
  updates: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.updatesStatus) as Promise<DesktopUpdateState>,
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState): void => {
        try { listener(state) }
        catch (error) { console.error('desktop update notification listener failed', error) }
      }
      ipcRenderer.on(DESKTOP_IPC.updatesState, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.updatesState, handle) }
    },
    review: () => ipcRenderer.invoke(DESKTOP_IPC.updatesInstall) as Promise<void>,
    reportImpact(impact: DesktopRendererUpdateImpact): void {
      currentImpact = parseDesktopRendererUpdateImpact(impact)
      ipcRenderer.send(DESKTOP_IPC.updatesImpactReport, currentImpact)
    },
  },
}

contextBridge.exposeInMainWorld('dshDesktop', location.protocol === 'dsh-app:' && location.hostname === 'shell'
  ? startup : application)
