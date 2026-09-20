/** Packaged Electron menu observation; native modal rendering is deliberately not automated. */
import type { App, MenuItem } from 'electron'

/** Only the Electron members needed by the serializable main-process observation. */
interface VersionMenuElectron {
  readonly app: Pick<App, 'getVersion' | 'showAboutPanel'>
  readonly Menu: {
    getApplicationMenu(): {
      readonly items: readonly {
        readonly label: string
        readonly submenu?: {
          readonly items: readonly Pick<MenuItem, 'label' | 'enabled' | 'visible' | 'click'>[]
        }
      }[]
    } | null
  }
}

/** Safe observations of the running application and the intercepted About dispatch. */
export interface DesktopVersionMenuEvidence {
  readonly applicationMenuLabel: string
  readonly aboutMenuLabel: string
  readonly desktopVersion: string
  readonly aboutDispatchCount: number
  readonly nativeModalOpened: false
}

/**
 * Inspect the actual application menu and intercept only the native modal invocation.
 * @param electron - Main-process Electron objects supplied by Playwright's ElectronApplication.evaluate.
 * @param expectedVersion - Exact fork version from the reviewed release plan, including its suffix.
 * @returns Menu/version evidence; callback dispatch does not establish native dialog rendering.
 */
export function inspectDesktopVersionMenu(
  { app, Menu }: VersionMenuElectron,
  expectedVersion: string,
): DesktopVersionMenuEvidence {
  const desktopVersion = app.getVersion()
  if (desktopVersion !== expectedVersion) throw new Error('Packaged Desktop version differs from the reviewed plan')
  const applicationMenu = Menu.getApplicationMenu()?.items[0]
  const about = applicationMenu?.submenu?.items[0]
  if (applicationMenu === undefined || about === undefined
    || !['Application', '应用'].includes(applicationMenu.label)
    || ![`About Desktop ${desktopVersion}…`, `关于 Desktop ${desktopVersion}…`].includes(about.label)
    || !about.enabled || !about.visible) {
    throw new Error('The first Application menu item must expose the full running Desktop version')
  }
  const original = app.showAboutPanel
  let aboutDispatchCount = 0
  try {
    app.showAboutPanel = () => { aboutDispatchCount++ }
    // Electron's MenuItem.click takes an event, focused window, and focused web contents.
    Reflect.apply(about.click, about, [{}, undefined, undefined])
  } finally {
    app.showAboutPanel = original
  }
  if (aboutDispatchCount !== 1) throw new Error('The version menu must dispatch About exactly once')
  return {
    applicationMenuLabel: applicationMenu.label,
    aboutMenuLabel: about.label,
    desktopVersion,
    aboutDispatchCount,
    nativeModalOpened: false,
  }
}
