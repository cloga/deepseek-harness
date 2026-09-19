/** Bounded, correlated reads of the currently loaded application document's composer state. */
import type { IpcMain, IpcMainEvent, WebContents } from 'electron'
import { DESKTOP_IPC, parseDesktopRendererUpdateImpact, type DesktopRendererUpdateImpact } from './ipc.ts'

let nextRequest = 0
const IMPACT_TIMEOUT_MS = 5000

/**
 * Ask the current preload for a fresh snapshot without exposing request authority to the page.
 * @param contents - Exact active application WebContents.
 * @param ipc - Main-process event transport.
 * @param signal - Optional caller-owned cancellation and deadline.
 * @returns Validated current-document impact; rejects on missing reports, navigation, exit or timeout.
 */
export function requestDesktopRendererImpact(
  contents: WebContents,
  ipc: Pick<IpcMain, 'on' | 'removeListener'>,
  signal?: AbortSignal,
): Promise<DesktopRendererUpdateImpact> {
  try {
    const url = new URL(contents.getURL())
    if (contents.isDestroyed() || url.protocol !== 'dsh-app:' || url.hostname !== 'app') {
      return Promise.reject(new Error('Desktop application impact is unavailable'))
    }
  } catch (_error) { return Promise.reject(new Error('Desktop application impact is unavailable')) }
  const frame = contents.mainFrame
  const requestId = `plugin-impact-${++nextRequest}`
  return new Promise((resolve, reject) => {
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', unavailable)
      ipc.removeListener(DESKTOP_IPC.pluginImpactResponse, response)
      contents.removeListener('destroyed', unavailable)
      contents.removeListener('render-process-gone', unavailable)
      contents.removeListener('did-start-loading', unavailable)
    }
    const unavailable = (): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(new Error('Desktop application impact is unavailable'))
    }
    const response = (event: IpcMainEvent, id: unknown, value: unknown): void => {
      if (settled || id !== requestId || event.sender !== contents || event.senderFrame !== frame) return
      try {
        const url = new URL(event.senderFrame.url)
        if (url.protocol !== 'dsh-app:' || url.hostname !== 'app' || contents.mainFrame !== frame) return
        const impact = parseDesktopRendererUpdateImpact(value)
        settled = true
        cleanup()
        resolve(impact)
      } catch (_error) { unavailable() }
    }
    ipc.on(DESKTOP_IPC.pluginImpactResponse, response)
    contents.on('destroyed', unavailable)
    contents.on('render-process-gone', unavailable)
    contents.on('did-start-loading', unavailable)
    const timer = setTimeout(unavailable, IMPACT_TIMEOUT_MS)
    signal?.addEventListener('abort', unavailable, { once: true })
    if (signal?.aborted === true) { unavailable(); return }
    try { contents.send(DESKTOP_IPC.pluginImpactRequest, requestId) } catch (_error) { unavailable() }
  })
}
