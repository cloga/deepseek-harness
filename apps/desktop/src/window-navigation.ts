/** Desktop-owned navigation keeps application documents local and opens HTTP(S) through the OS. */
import type { WebContents } from 'electron'

interface DesktopNavigationContents extends Pick<WebContents, 'setWindowOpenHandler' | 'getURL'> {
  on(event: 'will-navigate', listener: (event: { preventDefault(): void }, url: string) => void): unknown
}

interface DesktopNavigationActions {
  readonly openExternal: (url: string) => Promise<void>
  readonly openFailed: () => void
}

function parseNavigationUrl(input: string): URL | undefined {
  try { return new URL(input) }
  catch { return undefined }
}

/**
 * Install the navigation policy for one owned window. The window owns these listeners until destruction.
 * Retains alpha2's same-origin HTTP document navigation; legacy recovery URLs never grant an action.
 * @param contents - Web contents created by the Desktop shell, never a renderer-supplied object.
 * @param actions - OS opening and redacted failure reporting for this window.
 */
export function installDesktopWindowNavigation(
  contents: DesktopNavigationContents,
  actions: DesktopNavigationActions,
): void {
  const openExternal = (url: URL): boolean => {
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false
    void Promise.resolve().then(() => actions.openExternal(url.href)).catch(() => {
      try { actions.openFailed() }
      catch {
        // The native failure dialog can itself become unavailable; neither error may expose the URL.
        console.warn('Desktop could not display the browser-opening error.')
      }
    })
    return true
  }

  contents.setWindowOpenHandler(({ url }) => {
    const destination = parseNavigationUrl(url)
    if (destination !== undefined) openExternal(destination)
    return { action: 'deny' }
  })
  contents.on('will-navigate', (event, input) => {
    const destination = parseNavigationUrl(input)
    let current: URL | undefined
    try { current = parseNavigationUrl(contents.getURL()) } catch { /* An unavailable owned document fails closed. */ }
    if (destination === undefined || current === undefined) { event.preventDefault(); return }
    if (destination.protocol === 'dsh-app:' || (destination.protocol === 'http:' && destination.origin === current.origin)) return
    event.preventDefault()
    openExternal(destination)
  })
}
