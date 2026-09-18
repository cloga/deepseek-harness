/** Origin-scoped boot, native directory selection, and update presentation with native confirmation actions. */

import { contextBridge, ipcRenderer } from 'electron'
import { DESKTOP_IPC, SCHEME, type DshDesktopProductApi, type DesktopUpdatePresentation, type DesktopRendererUpdateImpact } from './ipc.ts'
import { markDocumentPlatform } from './preload-platform.ts'
import { syncNativeTheme } from './preload-theme.ts'
import { syncWindowsAppearance } from './preload-windows.ts'

let impactGeneration: number | undefined
let latestImpact: DesktopRendererUpdateImpact | undefined
const publishImpact = (): void => {
  if (impactGeneration !== undefined && latestImpact !== undefined) {
    ipcRenderer.send(DESKTOP_IPC.updatesImpact, impactGeneration, latestImpact)
  }
}

const product: DshDesktopProductApi = {
  protocolVersion: 1,
  updates: {
    status: () => ipcRenderer.invoke(DESKTOP_IPC.updatesStatus) as Promise<DesktopUpdatePresentation>,
    open: () => ipcRenderer.invoke(DESKTOP_IPC.updatesOpen) as Promise<void>,
    reportImpact: impact => { latestImpact = impact; publishImpact() },
    subscribe(listener) {
      const handle = (_event: Electron.IpcRendererEvent, state: DesktopUpdatePresentation): void => { listener(state) }
      ipcRenderer.on(DESKTOP_IPC.updatesPresentation, handle)
      return () => { ipcRenderer.off(DESKTOP_IPC.updatesPresentation, handle) }
    },
  },
}

if (location.protocol === `${SCHEME}:` && location.hostname === 'app') {
  ipcRenderer.on(DESKTOP_IPC.updatesImpactRequest, (_event, generation: unknown) => {
    if (typeof generation !== 'number' || !Number.isSafeInteger(generation) || generation <= 0) return
    impactGeneration = generation
    publishImpact()
  })
  syncWindowsAppearance()
  contextBridge.exposeInMainWorld('__DSH_DIRECTORY_PICKER__', {
    pick: () => ipcRenderer.invoke(DESKTOP_IPC.directoryPick) as Promise<string | null>,
  })
  contextBridge.exposeInMainWorld('dshDesktopBoot', {
    ready: () => ipcRenderer.invoke(DESKTOP_IPC.boot) as Promise<unknown>,
    failed: (message: string) => ipcRenderer.invoke(DESKTOP_IPC.bootFailed, message) as Promise<void>,
  })
}

markDocumentPlatform()
syncNativeTheme()
// Main-process IPC also verifies the owning window and top frame.
contextBridge.exposeInMainWorld('dshDesktop', location.protocol === `${SCHEME}:` && location.hostname === 'app' ? product : { protocolVersion: 1 })
