/** Startup controls for shell documents; application documents receive only the carrier marker. */

import { contextBridge, ipcRenderer } from 'electron'
import {
  DESKTOP_IPC,
  type DesktopRendererUpdateImpact,
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

const application: DshDesktopApplicationApi = {
  protocolVersion: 2,
  updates: {
    reportImpact(impact: DesktopRendererUpdateImpact): void {
      ipcRenderer.send(DESKTOP_IPC.updatesImpactReport, impact)
    },
  },
}

contextBridge.exposeInMainWorld('dshDesktop', location.protocol === 'dsh-app:' && location.hostname === 'shell'
  ? startup : application)
