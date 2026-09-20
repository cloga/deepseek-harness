import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import type { ElectronApplication, Page } from 'playwright'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { inspectDesktopVersionMenu, observeDesktopVersionMenu } from './fixtures/desktop-version-menu-smoke.ts'

const version = '0.1.6-alpha.2.cloga.1'
type Electron = Parameters<typeof observeDesktopVersionMenu>[0]
type Command = Parameters<typeof observeDesktopVersionMenu>[1]

function fixture(chinese = false) {
  const originalAbout = vi.fn()
  const app = { getVersion: () => version, showAboutPanel: originalAbout as () => void }
  const window = { id: 7, webContents: { getZoomFactor: () => 1.25 } }
  const about = {
    label: chinese ? `关于 Desktop ${version}…` : `About Desktop ${version}…`,
    enabled: true,
    visible: true,
    role: undefined as string | undefined,
    click: vi.fn(() => { app.showAboutPanel() }) as (() => void) | undefined,
  }
  const originalPopup = vi.fn()
  class Menu {
    static getApplicationMenu(): unknown { return null }
    items = [about]
    popup(options?: Parameters<Electron['Menu']['prototype']['popup']>[0]): void { originalPopup(this, options) }
  }
  const electron = { app, Menu, BrowserWindow: { fromId: (id: number) => id === window.id ? window : null } }
  const arm: Command = {
    action: 'arm', token: 'owned-token', expectedVersion: version, windowId: window.id,
    applicationMenuLabel: chinese ? '应用' : 'Application', x: 48, y: 40,
  }
  const callback = vi.fn()
  const popupOptions = { window, x: 60, y: 50, callback }
  const popupDescriptor = Object.getOwnPropertyDescriptor(Menu.prototype, 'popup')
  const aboutDescriptor = Object.getOwnPropertyDescriptor(app, 'showAboutPanel')
  const read = () => observeDesktopVersionMenu(electron, { action: 'read', token: arm.token })
  const dispose = () => observeDesktopVersionMenu(electron, { action: 'dispose', token: arm.token })
  onTestFinished(async () => { await dispose() })
  const assertRestored = () => {
    expect(Object.getOwnPropertyDescriptor(Menu.prototype, 'popup')).toEqual(popupDescriptor)
    expect(Object.getOwnPropertyDescriptor(app, 'showAboutPanel')).toEqual(aboutDescriptor)
    expect(Object.getOwnPropertySymbols(app)).toEqual([])
    expect(originalAbout).not.toHaveBeenCalled()
  }
  return { electron, app, window, about, Menu, arm, callback, popupOptions, originalPopup, originalAbout, read, dispose, assertRestored }
}

afterEach(() => { vi.useRealTimers() })

describe('packaged Windows caption-menu observation', () => {
  it.each([false, true])('captures the clicked popup model without native UI and restores methods (Chinese=%s)', async (chinese) => {
    const f = fixture(chinese)
    await observeDesktopVersionMenu(f.electron, f.arm)
    new f.Menu().popup(f.popupOptions)
    expect(await f.read()).toEqual({
      applicationMenuLabel: chinese ? '应用' : 'Application', aboutMenuLabel: f.about.label,
      desktopVersion: version, windowId: 7, popupCount: 1, aboutDispatchCount: 1,
      nativePopupOpened: false, nativeModalOpened: false,
    })
    expect(f.originalPopup).not.toHaveBeenCalled()
    expect(f.callback).toHaveBeenCalledExactlyOnceWith()
    expect(f.about.click).toHaveBeenCalledWith({}, f.window, f.window.webContents)
    f.assertRestored()
  })

  it('runs arm and read after function serialization without module-closure helpers', async () => {
    const f = fixture()
    const serialized = runInNewContext(`(${observeDesktopVersionMenu.toString()})`, { setTimeout, clearTimeout }) as typeof observeDesktopVersionMenu
    await serialized(f.electron, f.arm)
    new f.Menu().popup(f.popupOptions)
    expect(await serialized(f.electron, { action: 'read', token: f.arm.token })).toMatchObject({ desktopVersion: version })
    f.assertRestored()
  })

  it.each(['0.1.6-alpha.2', '0.1.6-alpha.1.cloga.12'])('rejects unreviewed running version %s before mutation', async (wrongVersion) => {
    const f = fixture()
    f.app.getVersion = () => wrongVersion
    await expect(observeDesktopVersionMenu(f.electron, f.arm)).rejects.toThrow('differs from the reviewed plan')
    f.assertRestored()
  })

  it.each(['About Desktop 0.1.6-alpha.2…', 'Check for Updates…', `关于 Desktop ${version}…`])('rejects a wrong first label: %s', async (label) => {
    const f = fixture()
    f.about.label = label
    await observeDesktopVersionMenu(f.electron, f.arm)
    new f.Menu().popup(f.popupOptions)
    await expect(f.read()).rejects.toThrow('full running Desktop version')
    expect(f.about.click).not.toHaveBeenCalled()
    expect(f.callback).toHaveBeenCalledOnce()
    f.assertRestored()
  })

  it.each(['enabled', 'visible'] as const)('rejects an inaccessible %s item', async (field) => {
    const f = fixture()
    f.about[field] = false
    await observeDesktopVersionMenu(f.electron, f.arm)
    new f.Menu().popup(f.popupOptions)
    await expect(f.read()).rejects.toThrow('full running Desktop version')
    expect(f.about.click).not.toHaveBeenCalled()
    f.assertRestored()
  })

  it.each(['missing item', 'missing click', 'role override', 'duplicate About'])('rejects %s and settles the renderer invoke', async (fault) => {
    const f = fixture()
    const menu = new f.Menu()
    if (fault === 'missing item') menu.items = []
    if (fault === 'missing click') f.about.click = undefined
    if (fault === 'role override') f.about.role = 'about'
    if (fault === 'duplicate About') menu.items.push({ ...f.about })
    await observeDesktopVersionMenu(f.electron, f.arm)
    menu.popup(f.popupOptions)
    await expect(f.read()).rejects.toThrow('full running Desktop version')
    expect(f.callback).toHaveBeenCalledOnce()
    f.assertRestored()
  })

  it.each([0, 2])('rejects %s About dispatches and restores both interceptors', async (count) => {
    const f = fixture()
    f.about.click = () => { for (let index = 0; index < count; index++) f.app.showAboutPanel() }
    await observeDesktopVersionMenu(f.electron, f.arm)
    new f.Menu().popup(f.popupOptions)
    await expect(f.read()).rejects.toThrow('exactly once')
    f.assertRestored()
  })

  it('preserves a failing About callback and still settles popup completion', async () => {
    const f = fixture()
    const failure = new Error('about callback failed')
    f.about.click = () => { f.app.showAboutPanel(); throw failure }
    await observeDesktopVersionMenu(f.electron, f.arm)
    new f.Menu().popup(f.popupOptions)
    await expect(f.read()).rejects.toBe(failure)
    expect(f.callback).toHaveBeenCalledOnce()
    f.assertRestored()
  })

  it('preserves both callback failures rather than overwriting the primary error', async () => {
    const f = fixture()
    const primary = new Error('about failed')
    const secondary = new Error('popup callback failed')
    f.about.click = () => { f.app.showAboutPanel(); throw primary }
    f.callback.mockImplementation(() => { throw secondary })
    await observeDesktopVersionMenu(f.electron, f.arm)
    new f.Menu().popup(f.popupOptions)
    await expect(f.read()).rejects.toMatchObject({ errors: [primary, secondary] })
    f.assertRestored()
  })

  it('rejects missing popup completion without dispatching About', async () => {
    const f = fixture()
    await observeDesktopVersionMenu(f.electron, f.arm)
    new f.Menu().popup({ ...f.popupOptions, callback: undefined })
    await expect(f.read()).rejects.toThrow('completion callback is missing')
    expect(f.about.click).not.toHaveBeenCalled()
    f.assertRestored()
  })

  it('reports restoration failure alongside the primary callback failure', async () => {
    const f = fixture()
    const primary = new Error('callback failed before cleanup')
    f.about.click = () => {
      f.app.showAboutPanel()
      Object.defineProperty(f.app, 'showAboutPanel', { configurable: false, writable: false })
      throw primary
    }
    await observeDesktopVersionMenu(f.electron, f.arm)
    new f.Menu().popup(f.popupOptions)
    await expect(f.read()).rejects.toMatchObject({ errors: [primary, expect.any(TypeError)] })
    expect(Object.getOwnPropertySymbols(f.app)).toEqual([])
    expect(f.callback).toHaveBeenCalledOnce()
    expect(f.originalAbout).not.toHaveBeenCalled()
  })

  it('reports popup interceptor restoration failure without losing the callback failure', async () => {
    const f = fixture()
    const primary = new Error('About callback failed')
    f.about.click = () => { f.app.showAboutPanel(); throw primary }
    f.callback.mockImplementation(() => {
      Object.defineProperty(f.Menu.prototype, 'popup', { configurable: false, writable: false })
    })
    await observeDesktopVersionMenu(f.electron, f.arm)
    new f.Menu().popup(f.popupOptions)
    await expect(f.read()).rejects.toMatchObject({ errors: [primary, expect.any(TypeError)] })
    expect(f.app.showAboutPanel).toBe(f.originalAbout)
    expect(Object.getOwnPropertySymbols(f.app)).toEqual([])
  })

  it('restores an inherited native method without leaving an own property', async () => {
    const f = fixture()
    const app = Object.create({ showAboutPanel: f.originalAbout }) as typeof f.app
    app.getVersion = () => version
    f.about.click = () => { app.showAboutPanel() }
    const electron = { ...f.electron, app }
    await observeDesktopVersionMenu(electron, f.arm)
    new f.Menu().popup(f.popupOptions)
    await observeDesktopVersionMenu(electron, { action: 'read', token: f.arm.token })
    expect(Object.hasOwn(app, 'showAboutPanel')).toBe(false)
    expect(app.showAboutPanel).toBe(f.originalAbout)
  })

  it.each(['window', 'anchor', 'no options'])('delegates unrelated %s popups and rejects missing owned popup with bounded cleanup', async (kind) => {
    vi.useFakeTimers()
    const f = fixture()
    await observeDesktopVersionMenu(f.electron, f.arm)
    const menu = new f.Menu()
    const options = kind === 'no options' ? undefined : {
      ...f.popupOptions,
      ...(kind === 'window' ? { window: { ...f.window, id: 9 } } : { x: 80 }),
    }
    menu.popup(options)
    expect(f.originalPopup).toHaveBeenCalledExactlyOnceWith(menu, options)
    expect(f.about.click).not.toHaveBeenCalled()
    const observed = kind === 'anchor' ? '(80, 50)' : 'none'
    const rejected = expect(f.read()).rejects.toThrow(`expected anchor (60, 50); last owned-window mismatched anchor ${observed}`)
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    f.assertRestored()
  })

  it('retains only the last finite owned-window mismatch for timeout diagnostics', async () => {
    vi.useFakeTimers()
    const f = fixture()
    await observeDesktopVersionMenu(f.electron, f.arm)
    const menu = new f.Menu()
    menu.popup({ ...f.popupOptions, x: 80 })
    menu.popup({ ...f.popupOptions, x: 105, y: 51 })
    menu.popup({ ...f.popupOptions, window: { id: 99 }, x: 999 })
    menu.popup({ ...f.popupOptions, x: Number.NaN })
    menu.popup({ ...f.popupOptions, x: undefined })
    const rejected = expect(f.read()).rejects.toThrow('expected anchor (60, 50); last owned-window mismatched anchor (105, 51)')
    await vi.advanceTimersByTimeAsync(15_000)
    await rejected
    expect(f.originalPopup).toHaveBeenCalledTimes(5)
    expect(f.about.click).not.toHaveBeenCalled()
    f.assertRestored()
  })

  it('delegates a mismatched popup without poisoning later owned-popup success', async () => {
    const f = fixture()
    await observeDesktopVersionMenu(f.electron, f.arm)
    const menu = new f.Menu()
    const unrelated = { ...f.popupOptions, x: 105 }
    menu.popup(unrelated)
    menu.popup(f.popupOptions)
    expect(f.originalPopup).toHaveBeenCalledExactlyOnceWith(menu, unrelated)
    expect(await f.read()).toMatchObject({ aboutDispatchCount: 1, nativePopupOpened: false, nativeModalOpened: false })
    f.assertRestored()
  })

  it('expires and restores even when the caller never reads the missing popup', async () => {
    vi.useFakeTimers()
    const f = fixture()
    const original = f.Menu.prototype.popup
    await observeDesktopVersionMenu(f.electron, f.arm)
    await vi.advanceTimersByTimeAsync(15_000)
    expect(f.Menu.prototype.popup).toBe(original)
    await expect(f.dispose()).rejects.toThrow('Timed out')
    f.assertRestored()
  })

  it('rejects overlapping owners and wrong tokens without taking over the interceptor', async () => {
    const f = fixture()
    await observeDesktopVersionMenu(f.electron, f.arm)
    const installed = f.Menu.prototype.popup
    await expect(observeDesktopVersionMenu(f.electron, { ...f.arm, token: 'other' })).rejects.toThrow('already has an owner')
    for (const action of ['read', 'dispose'] as const) {
      await expect(observeDesktopVersionMenu(f.electron, { action, token: 'other' })).rejects.toThrow('owner mismatch')
      expect(f.Menu.prototype.popup).toBe(installed)
    }
    await f.dispose()
    await f.dispose()
    f.assertRestored()
  })

  it.each(['window', 'global menu', 'caption label', 'anchor'])('rejects invalid arm %s before mutation', async (fault) => {
    const f = fixture()
    if (fault === 'global menu') f.Menu.getApplicationMenu = () => ({ items: [] })
    const arm = {
      ...f.arm,
      ...(fault === 'window' ? { windowId: 99 } : {}),
      ...(fault === 'caption label' ? { applicationMenuLabel: 'Edit' } : {}),
      ...(fault === 'anchor' ? { x: Number.NaN } : {}),
    }
    await expect(observeDesktopVersionMenu(f.electron, arm)).rejects.toThrow()
    f.assertRestored()
  })
})

function browserFixture(url = 'dsh-app://app/') {
  const f = fixture()
  const calls: string[] = []
  const button = {
    waitFor: vi.fn(async () => { calls.push('caption-visible') }),
    evaluate: vi.fn(async () => ({ applicationMenuLabel: 'Application', x: 48, y: 40 })),
    click: vi.fn(async () => { calls.push('real-click'); new f.Menu().popup(f.popupOptions) }),
  }
  const handle = { evaluate: vi.fn(async () => f.window.id), dispose: vi.fn(async () => {}) }
  const app = {
    browserWindow: vi.fn(async () => handle),
    evaluate: vi.fn(async (fn: typeof observeDesktopVersionMenu, command: Command) => {
      calls.push(command.action)
      return fn(f.electron, command)
    }),
  }
  const page = {
    waitForURL: vi.fn(async (predicate: (url: URL) => boolean) => {
      calls.push('product-origin')
      if (!predicate(new URL(url))) throw new Error('Product origin wait expired')
    }),
    waitForLoadState: vi.fn(async () => { calls.push('domcontentloaded') }),
    locator: vi.fn(() => ({ getByRole: vi.fn(() => button) })),
    waitForFunction: vi.fn(async () => { calls.push('renderer-settled') }),
  }
  const inspect = () => inspectDesktopVersionMenu(app as unknown as ElectronApplication, page as unknown as Page, version)
  return { ...f, calls, button, handle, app, page, inspect }
}

describe('packaged caption-click orchestration', () => {
  it('arms before a real caption click, reads afterwards, and waits for invoke settlement', async () => {
    const f = browserFixture()
    expect(await f.inspect()).toMatchObject({ desktopVersion: version, nativePopupOpened: false, nativeModalOpened: false })
    expect(f.page.locator).toHaveBeenCalledWith('[data-windows-menu]')
    expect(f.page.waitForLoadState).toHaveBeenCalledWith('domcontentloaded')
    expect(f.page.waitForURL).toHaveBeenCalledWith(expect.any(Function), { waitUntil: 'commit', timeout: 30_000 })
    expect(f.calls).toEqual(['product-origin', 'domcontentloaded', 'caption-visible', 'arm', 'real-click', 'read', 'renderer-settled', 'dispose'])
    expect(f.handle.dispose).toHaveBeenCalledOnce()
    f.assertRestored()
  })

  it('admits an owned product route without requiring the application root or Host readiness', async () => {
    const f = browserFixture('dsh-app://app/session/owned?view=loading#caption')
    expect(await f.inspect()).toMatchObject({ desktopVersion: version })
    expect(f.calls.slice(0, 3)).toEqual(['product-origin', 'domcontentloaded', 'caption-visible'])
    f.assertRestored()
  })

  it.each([
    'about:blank', 'dsh-app://shell/', 'https://app/', 'dsh-app://app.example/',
    'dsh-app://app@other/', 'dsh-app://user@app/', 'dsh-app://app:8080/',
  ])('does not inspect or arm on untrusted document %s', async (url) => {
    const f = browserFixture(url)
    await expect(f.inspect()).rejects.toThrow('Product origin wait expired')
    expect(f.calls).toEqual(['product-origin'])
    expect(f.page.waitForLoadState).not.toHaveBeenCalled()
    expect(f.page.locator).not.toHaveBeenCalled()
    expect(f.button.click).not.toHaveBeenCalled()
    expect(f.app.evaluate).not.toHaveBeenCalled()
    expect(f.app.browserWindow).not.toHaveBeenCalled()
    f.assertRestored()
  })

  it('preserves window lookup and handle cleanup failures without installing an interceptor', async () => {
    const f = browserFixture()
    const primary = new Error('window lookup failed')
    const cleanup = new Error('handle disposal failed')
    f.handle.evaluate.mockRejectedValue(primary)
    f.handle.dispose.mockRejectedValue(cleanup)
    await expect(f.inspect()).rejects.toMatchObject({ errors: [primary, cleanup] })
    expect(f.app.evaluate).not.toHaveBeenCalled()
    f.assertRestored()
  })

  it('disposes if the actual UI click fails', async () => {
    const f = browserFixture()
    const failure = new Error('caption button vanished')
    f.button.click.mockRejectedValue(failure)
    await expect(f.inspect()).rejects.toBe(failure)
    expect(f.calls.at(-1)).toBe('dispose')
    f.assertRestored()
  })

  it('attempts disposal if the serialized read transport fails', async () => {
    const f = browserFixture()
    const failure = new Error('read transport failed')
    f.app.evaluate.mockImplementation(async (fn, command) => {
      if (command.action === 'read') throw failure
      return fn(f.electron, command)
    })
    await expect(f.inspect()).rejects.toBe(failure)
    f.assertRestored()
  })

  it('surfaces click and disposal failures together', async () => {
    const f = browserFixture()
    const primary = new Error('click failed')
    const cleanup = new Error('cleanup transport failed')
    f.button.click.mockRejectedValue(primary)
    f.app.evaluate.mockImplementation(async (fn, command) => {
      const result = await fn(f.electron, command)
      if (command.action === 'dispose') throw cleanup
      return result
    })
    await expect(f.inspect()).rejects.toMatchObject({ errors: [primary, cleanup] })
    f.assertRestored()
  })

  it('keeps initial/restart reviewed-version inspection ahead of Host readiness without replacing Core68 behavior', () => {
    const source = readFileSync(new URL('./fixtures/copilot-release-smoke.ts', import.meta.url), 'utf8')
    const observation = source.indexOf('await inspectDesktopVersionMenu(app, page, reviewed.version)')
    expect(observation).toBeGreaterThan(source.indexOf("for (const phase of ['initial', 'restart']"))
    expect(observation).toBeGreaterThan(source.indexOf('page = await app.firstWindow()'))
    expect(observation).toBeLessThan(source.indexOf('await page.waitForFunction(packagedCopilotStartupReady'))
    expect(source).toContain("location.href === 'dsh-app://app/'")
    expect(source).toContain("name: 'Configure later', exact: true")
    expect(source).toContain("transport: 'official Web-backed Desktop Host with packaged Electron dsh-app origin bridge'")
    expect(source).toContain('versionMenus.push(versionMenu)')
  })
})
