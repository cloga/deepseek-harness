import { describe, expect, it, vi } from 'vitest'
import { inspectDesktopVersionMenu } from './fixtures/desktop-version-menu-smoke.ts'

const version = '0.1.6-alpha.1.cloga.12'

function fixture(chinese = false) {
  const original = vi.fn()
  const app = { getVersion: () => version, showAboutPanel: original }
  const about = {
    label: chinese ? `关于 Desktop ${version}…` : `About Desktop ${version}…`,
    enabled: true,
    visible: true,
    click: () => { app.showAboutPanel() },
  }
  const menu = { items: [{ label: chinese ? '应用' : 'Application', submenu: { items: [about] } }] }
  const electron = { app, Menu: { getApplicationMenu: () => menu } }
  return { electron, original, about, menu }
}

describe('packaged Desktop version menu observation', () => {
  it.each([false, true])('records the full version and restores native About without opening it (Chinese=%s)', (chinese) => {
    const { electron, original, about } = fixture(chinese)
    expect(inspectDesktopVersionMenu(electron, version)).toEqual({
      applicationMenuLabel: chinese ? '应用' : 'Application',
      aboutMenuLabel: about.label,
      desktopVersion: version,
      aboutDispatchCount: 1,
      nativeModalOpened: false,
    })
    expect(electron.app.showAboutPanel).toBe(original)
    expect(original).not.toHaveBeenCalled()
  })

  it('rejects the Core version before dispatching a menu action', () => {
    const { electron, original } = fixture()
    electron.app.getVersion = () => '0.1.6-alpha.1'
    expect(() => inspectDesktopVersionMenu(electron, version)).toThrow('differs from the reviewed plan')
    expect(electron.app.showAboutPanel).toBe(original)
    expect(original).not.toHaveBeenCalled()
  })

  it.each(['About Desktop 0.1.6-alpha.1…', 'Check for Updates…'])('rejects a wrong first item: %s', (label) => {
    const { electron, about } = fixture()
    const click = vi.fn()
    about.label = label
    about.click = click
    expect(() => inspectDesktopVersionMenu(electron, version)).toThrow('full running Desktop version')
    expect(click).not.toHaveBeenCalled()
  })

  it.each(['enabled', 'visible'] as const)('rejects an inaccessible %s item without dispatch', (field) => {
    const { electron, about } = fixture()
    const click = vi.fn()
    about[field] = false
    about.click = click
    expect(() => inspectDesktopVersionMenu(electron, version)).toThrow('full running Desktop version')
    expect(click).not.toHaveBeenCalled()
  })

  it('rejects a missing application menu', () => {
    const { electron } = fixture()
    expect(() => inspectDesktopVersionMenu({ ...electron, Menu: { getApplicationMenu: () => null } }, version))
      .toThrow('full running Desktop version')
  })

  it.each([0, 2])('rejects %s About dispatches and restores the native method', (count) => {
    const { electron, original, about } = fixture()
    about.click = () => { for (let index = 0; index < count; index++) electron.app.showAboutPanel() }
    expect(() => inspectDesktopVersionMenu(electron, version)).toThrow('exactly once')
    expect(electron.app.showAboutPanel).toBe(original)
    expect(original).not.toHaveBeenCalled()
  })

  it('restores native About and preserves a failing menu callback error', () => {
    const { electron, original, about } = fixture()
    const error = new Error('menu callback failed')
    about.click = () => { throw error }
    expect(() => inspectDesktopVersionMenu(electron, version)).toThrow(error)
    expect(electron.app.showAboutPanel).toBe(original)
    expect(original).not.toHaveBeenCalled()
  })
})
