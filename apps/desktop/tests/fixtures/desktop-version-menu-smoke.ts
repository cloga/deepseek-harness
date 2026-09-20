/** Packaged Windows caption-menu model observation, not rendered native popup/dialog acceptance. */
import { randomUUID } from 'node:crypto'
import type { MenuItem } from 'electron'
import type { ElectronApplication, Page } from 'playwright'

interface ObservedWindow {
  readonly id: number
  readonly webContents: { getZoomFactor(): number }
}
interface ObservedMenu {
  readonly items: readonly {
    readonly label: string
    readonly enabled: boolean
    readonly visible: boolean
    readonly role?: string
    readonly click?: MenuItem['click']
  }[]
}
interface PopupOptions {
  readonly window?: { readonly id: number }
  readonly x?: number
  readonly y?: number
  readonly callback?: () => void
}
/** Structural Electron subset keeps source tests independent of a running Electron process. */
interface VersionMenuElectron {
  readonly app: { getVersion(): string; showAboutPanel(): void }
  readonly BrowserWindow: { fromId(id: number): ObservedWindow | null }
  readonly Menu: {
    getApplicationMenu(): unknown
    readonly prototype: { popup(this: ObservedMenu, options?: PopupOptions): void }
  }
}

/** Owned leaf evidence; interception deliberately opens neither native UI surface. */
export interface DesktopVersionMenuEvidence {
  readonly applicationMenuLabel: string
  readonly aboutMenuLabel: string
  readonly desktopVersion: string
  readonly windowId: number
  readonly popupCount: number
  readonly aboutDispatchCount: number
  readonly nativePopupOpened: false
  readonly nativeModalOpened: false
}

interface ObserverState {
  readonly token: string
  readonly done: Promise<void>
  readonly errors: unknown[]
  evidence?: DesktopVersionMenuEvidence
  complete(): void
  dispose(): void
}

type ObserverCommand = {
  readonly action: 'arm'
  readonly token: string
  readonly expectedVersion: string
  readonly windowId: number
  readonly applicationMenuLabel: string
  readonly x: number
  readonly y: number
} | { readonly action: 'read' | 'dispose'; readonly token: string }

/**
 * Arm/read/dispose an owned observer across Playwright's serialized main-process evaluations.
 * All runtime helpers are local: ElectronApplication.evaluate cannot retain module closures.
 * @param electron - Real main-process Electron objects (structural substitutes only in unit tests).
 * @param command - Unique caller token and, when arming, the actual caption button's window/anchor.
 * @returns Minimal evidence on read; arm/dispose return null and never invoke business IPC.
 */
export async function observeDesktopVersionMenu(
  { app, BrowserWindow, Menu }: VersionMenuElectron,
  command: ObserverCommand,
): Promise<DesktopVersionMenuEvidence | null> {
  const key = Symbol.for('dsh.acceptance.windows-caption-version-menu')
  const owner = app as typeof app & { [key: symbol]: ObserverState | undefined }
  const existing = owner[key]
  if (command.action !== 'arm') {
    if (existing === undefined && command.action === 'dispose') return null
    if (existing === undefined || existing.token !== command.token) throw new Error('Caption observer owner mismatch')
    if (command.action === 'read') await existing.done
    existing.dispose()
    if (existing.errors.length === 1) throw existing.errors[0]
    if (existing.errors.length > 1) throw new AggregateError(existing.errors, 'Caption observation and cleanup failed')
    return command.action === 'read' ? existing.evidence ?? null : null
  }
  if (existing !== undefined) throw new Error('Caption observer already has an owner')
  const desktopVersion = app.getVersion()
  if (desktopVersion !== command.expectedVersion) throw new Error('Packaged Desktop version differs from the reviewed plan')
  if (!['Application', '应用'].includes(command.applicationMenuLabel)) throw new Error('Unexpected Application caption label')
  if (Menu.getApplicationMenu() !== null) throw new Error('Windows must not install a global application menu')
  const window = BrowserWindow.fromId(command.windowId)
  if (window === null) throw new Error('Caption observer window is missing')
  const zoom = window.webContents.getZoomFactor()
  const x = Math.round(command.x * zoom)
  const y = Math.round(command.y * zoom)
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw new Error('Invalid caption anchor')
  const popupDescriptor = Object.getOwnPropertyDescriptor(Menu.prototype, 'popup')
  const originalPopup = Menu.prototype.popup
  const errors: unknown[] = []
  let resolveDone!: () => void
  let completed = false
  let popupInstalled = false
  let lastMismatchedAnchor: { x: number; y: number } | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const restore = (target: object, name: string, descriptor: PropertyDescriptor | undefined): void => {
    if (descriptor === undefined) {
      if (!Reflect.deleteProperty(target, name)) throw new Error(`Cannot restore ${name}`)
    } else Object.defineProperty(target, name, descriptor)
  }
  const state: ObserverState = {
    token: command.token,
    errors,
    done: new Promise<void>((resolve) => { resolveDone = resolve }),
    complete() {
      if (completed) return
      completed = true
      clearTimeout(timer)
      if (popupInstalled) {
        try { restore(Menu.prototype, 'popup', popupDescriptor) } catch (error) { errors.push(error) }
        popupInstalled = false
      }
      resolveDone()
    },
    dispose() {
      state.complete()
      try {
        if (owner[key] !== state) throw new Error('Caption observer ownership changed during cleanup')
        if (!Reflect.deleteProperty(owner, key)) throw new Error('Cannot remove caption observer')
      } catch (error) { errors.push(error) }
    },
  }
  // One token owns the process-wide interceptor, with an expiry even if the renderer click fails.
  Object.defineProperty(owner, key, { value: state, configurable: true })
  try {
    Menu.prototype.popup = function (options) {
      // Coordinates are obtained from the real Application button, not inferred from a menu label.
      // Other windows, context menus, and Edit popups retain their original behavior.
      if (options?.window !== window || options.x !== x || options.y !== y) {
        if (options?.window === window && typeof options.x === 'number' && typeof options.y === 'number'
          && Number.isFinite(options.x) && Number.isFinite(options.y)) {
          lastMismatchedAnchor = { x: options.x, y: options.y }
        }
        return Reflect.apply(originalPopup, this, [options])
      }
      try {
        const about = this.items[0]
        const expectedLabel = command.applicationMenuLabel === '应用'
          ? `关于 Desktop ${desktopVersion}…` : `About Desktop ${desktopVersion}…`
        if (about === undefined || about.label !== expectedLabel || !about.enabled || !about.visible
          || about.role !== undefined || typeof about.click !== 'function'
          || this.items.filter(item => /^(?:About Desktop |关于 Desktop )/u.test(item.label)).length !== 1) {
          throw new Error('The first Application menu item must expose the full running Desktop version with an explicit callback')
        }
        if (typeof options.callback !== 'function') throw new Error('Caption popup completion callback is missing')
        const aboutDescriptor = Object.getOwnPropertyDescriptor(app, 'showAboutPanel')
        let aboutDispatchCount = 0
        try {
          app.showAboutPanel = () => { aboutDispatchCount++ }
          Reflect.apply(about.click, about, [{}, window, window.webContents])
        } catch (error) { errors.push(error) }
        finally {
          try { restore(app, 'showAboutPanel', aboutDescriptor) } catch (error) { errors.push(error) }
        }
        if (aboutDispatchCount !== 1) errors.push(new Error('The version menu must dispatch About exactly once'))
        state.evidence = {
          applicationMenuLabel: command.applicationMenuLabel,
          aboutMenuLabel: about.label,
          desktopVersion,
          windowId: window.id,
          popupCount: 1,
          aboutDispatchCount,
          nativePopupOpened: false,
          nativeModalOpened: false,
        }
      } catch (error) { errors.push(error) }
      finally {
        // Settle the real main handler's Promise so preload restores aria-expanded/focus semantics.
        try { options.callback?.() } catch (error) { errors.push(error) }
        state.complete()
      }
    }
    popupInstalled = true
    timer = setTimeout(() => {
      const observed = lastMismatchedAnchor === undefined ? 'none' : `(${lastMismatchedAnchor.x}, ${lastMismatchedAnchor.y})`
      errors.push(new Error(`Timed out observing the owned Application caption popup; expected anchor (${x}, ${y}); last owned-window mismatched anchor ${observed}`))
      state.complete()
    }, 15_000)
  } catch (error) {
    errors.push(error)
    state.dispose()
    if (errors.length === 1) throw errors[0]
    throw new AggregateError(errors, 'Caption observer setup and cleanup failed')
  }
  return null
}

/**
 * Click the actual preload caption control before the caller waits for Host/application readiness.
 * @param app - Owned packaged Electron application.
 * @param page - Its first BrowserWindow page, possibly still showing the loading document.
 * @param expectedVersion - Exact reviewed release version, including its fork suffix.
 * @returns Caption-triggered menu model and intercepted native About dispatch evidence, not OS rendering.
 */
export async function inspectDesktopVersionMenu(
  app: ElectronApplication,
  page: Page,
  expectedVersion: string,
): Promise<DesktopVersionMenuEvidence> {
  // Admit only the product document; origin commitment does not imply Host or AppFrame readiness.
  await page.waitForURL(url => url.protocol === 'dsh-app:' && url.hostname === 'app'
    && url.port === '' && url.username === '' && url.password === '', { waitUntil: 'commit', timeout: 30_000 })
  await page.waitForLoadState('domcontentloaded')
  const button = page.locator('[data-windows-menu]').getByRole('menuitem', { name: /^(Application|应用)$/u })
  await button.waitFor({ state: 'visible', timeout: 30_000 })
  const anchor = await button.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return { applicationMenuLabel: element.textContent ?? '', x: rect.left, y: rect.bottom }
  })
  const handle = await app.browserWindow(page)
  let windowId: number
  let windowFailure: unknown
  try { windowId = await handle.evaluate(window => window.id) }
  catch (error) { windowFailure = error; throw error }
  finally {
    try { await handle.dispose() }
    catch (error) {
      throw new AggregateError([...(windowFailure === undefined ? [] : [windowFailure]), error], 'Caption window lookup and handle cleanup failed')
    }
  }
  const token = randomUUID()
  let failure: unknown
  try {
    await app.evaluate(observeDesktopVersionMenu, { action: 'arm', token, expectedVersion, windowId, ...anchor } satisfies ObserverCommand)
    await button.click({ timeout: 10_000 })
    // read disposes even when observation fails; it waits only for this owned popup or its deadline.
    const evidence = await app.evaluate(observeDesktopVersionMenu, { action: 'read', token } satisfies ObserverCommand)
    if (evidence === null) throw new Error('Caption observer returned no evidence')
    await page.waitForFunction(() => {
      const buttons = document.querySelector('[data-windows-menu]')?.shadowRoot?.querySelectorAll('[role=menuitem]')
      return buttons !== undefined && Array.from(buttons).some(button =>
        /^(Application|应用)$/u.test(button.textContent ?? '') && button.getAttribute('aria-expanded') === 'false')
    }, undefined, { timeout: 10_000 })
    return evidence
  } catch (error) {
    failure = error
    throw error
  } finally {
    try { await app.evaluate(observeDesktopVersionMenu, { action: 'dispose', token } satisfies ObserverCommand) }
    catch (error) {
      throw new AggregateError([...(failure === undefined ? [] : [failure]), error], 'Caption click and observer cleanup failed')
    }
  }
}
