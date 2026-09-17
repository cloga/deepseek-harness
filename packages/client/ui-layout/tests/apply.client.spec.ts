// @vitest-environment jsdom

import { Context, type Fiber } from '@deepseek-ai/cordis'
import { bindSnapshotSelector, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { DesktopUpdateNotice } from '../src/client/DesktopUpdateNotice.tsx'
import type { DesktopUpdateInject, DesktopUpdateState } from '../src/client/desktop-update-adapter.ts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import type { SlotRendererHost } from '@deepseek-ai/dsh-client-ui-slots'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { apply as themeApply, inject as themeInject, ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import { apply, inject, LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import { apply as nodeApply } from '@deepseek-ai/dsh-client-ui-layout'
import type { MainPanelId } from '../src/client/service.ts'
import type { createLayoutStore } from '../src/client/stores.ts'

const owners = new Set<Fiber>()
let originalRootStyle: string | null
let originalBodyStyle: string | null
let originalDarkTheme: string | null
let originalThemeMetadata: Element[]

beforeEach(() => {
  originalRootStyle = document.documentElement.getAttribute('style')
  originalBodyStyle = document.body.getAttribute('style')
  originalDarkTheme = document.body.getAttribute('data-ds-dark-theme')
  originalThemeMetadata = [...document.head.querySelectorAll('meta[name="theme-color"]')]
  originalThemeMetadata.forEach((node) => { node.remove() })
  vi.stubGlobal('innerWidth', 1920)
})

afterEach(async () => {
  try {
    cleanup()
    for (const owner of owners) await owner.dispose()
  } finally {
    owners.clear()
    restoreAttribute(document.documentElement, 'style', originalRootStyle)
    restoreAttribute(document.body, 'style', originalBodyStyle)
    restoreAttribute(document.body, 'data-ds-dark-theme', originalDarkTheme)
    document.head.querySelectorAll('meta[name="theme-color"]').forEach((node) => { node.remove() })
    document.head.append(...originalThemeMetadata)
    vi.unstubAllGlobals()
  }
})

function restoreAttribute(element: Element, name: string, value: string | null): void {
  if (value === null) element.removeAttribute(name)
  else element.setAttribute(name, value)
}

async function bench() {
  const root = new Context()
  let ctx: Context | undefined
  const owner = root.plugin((ownedContext: Context) => { ctx = ownedContext })
  owners.add(owner)
  await owner.await()
  if (ctx === undefined) throw new Error('the fixture owner did not activate')
  const slotsFiber = ctx.plugin(SlotRegistry)
  // Theme registers its Appearance settings row and requires the connection
  // seam for persistence; model this bench as a remote, memory-only browser.
  ctx.provide('locale', new LocaleRuntime(ctx))
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  // ui-theme's Appearance row binds a durable scope through these two.
  ctx.provide('remote', { $on: () => () => {} } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: themeInject, apply: themeApply }).await()
  await slotsFiber.await()
  const slots = ctx.get('slots') as SlotRegistry
  let host: SlotRendererHost | undefined
  slots.install({ renderRoot: (value) => { host = value; return null } })
  const rendererHost = (): SlotRendererHost => {
    slots.renderSlot('root', {})
    if (host === undefined) throw new Error('the root renderer did not receive its host')
    return host
  }
  return { ctx, slots, rendererHost }
}

describe('ui-layout client apply', () => {
  it('declares its service dependencies', () => {
    expect(inject).toEqual(['slots', 'theme', 'locale'])
  })

  it('owns and removes the Desktop notification dictionary with the layout fiber', async () => {
    const { ctx } = await bench()
    const locale = ctx.get('locale') as LocaleRuntime
    const t = locale.bind('layout')
    expect(t('desktopUpdate.review')).toBe('desktopUpdate.review')
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(t('desktopUpdate.review')).not.toBe('desktopUpdate.review')
    await fiber.dispose()
    expect(t('desktopUpdate.review')).toBe('desktopUpdate.review')
  })

  it('owns the update source across renderer remounts and removes IPC with its Fiber', async () => {
    const initial = Promise.withResolvers<DesktopUpdateState>()
    const pendingReview = Promise.withResolvers<undefined>()
    let emit: (state: DesktopUpdateState) => void = () => {}
    const off = vi.fn()
    const updates = {
      status: vi.fn(() => initial.promise),
      subscribe: vi.fn((listener: typeof emit) => { emit = listener; return off }),
      review: vi.fn(() => pendingReview.promise),
    }
    vi.stubGlobal('dshDesktop', { protocolVersion: 2, updates })
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(updates.subscribe).toHaveBeenCalledOnce()
    expect(updates.subscribe.mock.invocationCallOrder[0]).toBeLessThan(updates.status.mock.invocationCallOrder[0]!)
    const entry = slots.entries('root')[0]!
    const injected = entry.inject!() as unknown as DesktopUpdateInject
    expect((entry.inject!() as unknown as DesktopUpdateInject).hooks.desktopUpdate).toBe(injected.hooks.desktopUpdate)
    expect(Object.keys(injected).sort()).toEqual(['hooks', 'reviewDesktopUpdate'])
    const useDesktopUpdate = bindSnapshotSelector(injected.hooks.desktopUpdate)
    const t = (ctx.get('locale') as LocaleRuntime).bind('layout')
    const Notice = () => createElement(DesktopUpdateNotice, {
      notice: useDesktopUpdate(state => state), review: injected.reviewDesktopUpdate, t,
    })
    emit({ phase: 'available', version: '2.0.0' })
    const first = render(createElement(Notice))
    expect(screen.getByRole('status').textContent).toContain('2.0.0')
    await act(async () => { initial.resolve({ phase: 'idle' }); await initial.promise })
    expect(screen.getByRole('status').textContent).toContain('2.0.0')
    fireEvent.click(screen.getByRole('button'))
    first.unmount()
    expect(off).not.toHaveBeenCalled()
    const second = render(createElement(Notice))
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
    fireEvent.click(screen.getByRole('button'))
    expect(updates.review).toHaveBeenCalledOnce()
    await act(async () => { pendingReview.resolve(undefined); await pendingReview.promise })
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(false)
    act(() => { emit({ phase: 'installing', version: '2.0.0' }) })
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
    second.unmount()
    const before = injected.hooks.desktopUpdate.getSnapshot()
    await fiber.dispose()
    expect(off).toHaveBeenCalledOnce()
    emit({ phase: 'available', version: '3.0.0' })
    await injected.reviewDesktopUpdate()
    expect(injected.hooks.desktopUpdate.getSnapshot()).toBe(before)
    expect(slots.entries('root')).toHaveLength(0)
  })

  it('provides ctx.layout and declares the four root-scoped frame slots', async () => {
    const { ctx, slots } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.get('layout')).toBeInstanceOf(LayoutController)
    expect(slots.entries('root')).toHaveLength(1)
    expect(slots.spec('sidebar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('main')).toEqual({ kind: 'keyed', scope: 'root' })
    expect(slots.spec('rightbar')).toEqual({ kind: 'single', scope: 'root' })
    expect(slots.spec('shell.overlay')).toEqual({ kind: 'list', scope: 'root' })
  })

  it('shares a pre-created instance between service actions, root rendering, and panelInfo', async () => {
    const { ctx, slots, rendererHost } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const entry = slots.entries('root')[0]!
    expect(entry.inject).toBeTypeOf('function')
    const handle = entry.store as ReturnType<typeof createLayoutStore>
    const instance = handle.create()
    expect(handle.create()).toBe(instance)
    const layout = ctx.get('layout') as LayoutController
    expect(() => { layout.selectPanel('missing' as MainPanelId) }).toThrow('main panel "missing" is not registered')
    layout.toggleSidebar()
    expect(instance.getSnapshot().layoutInfo.sidebar).toBe(0)
    const host = rendererHost()
    expect(host.storeOf(entry, undefined)).toBe(instance)
    const panelInfo = host.root.getSnapshot().hooks.panelInfo!
    expect(panelInfo.getSnapshot()).toBe(instance.getSnapshot().panelInfo)
    const panelId = 'panel-a' as MainPanelId
    const disposePanel = slots.register({ name: 'main', key: panelId }, () => null)
    layout.selectPanel(panelId)
    expect(panelInfo.getSnapshot()).toEqual({ activePanelId: panelId })
    disposePanel()
    await vi.waitFor(() => { expect(panelInfo.getSnapshot()).toEqual({ activePanelId: null }) })
    expect(() => { layout.selectPanel(panelId) }).toThrow('main panel "panel-a" is not registered')
    expect(instance.getSnapshot().layoutInfo.sidebar).toBe(0)
    const pending = layout.beginNavigation()
    await fiber.dispose()
    expect(pending.aborted).toBe(true)
  })

  it('theme presenter applies the initial snapshot, follows theme/change, and unwinds on dispose', async () => {
    const { ctx } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    // Initial getter application: jsdom has no matchMedia, system resolves light.
    expect(document.documentElement.style.colorScheme).toBe('light')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    const themeColorMeta = document.head.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    expect(themeColorMeta).not.toBeNull()
    const theme = ctx.get('theme') as ThemeRuntime
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('dark')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(true)
    expect(document.head.querySelector('meta[name="theme-color"]')).toBe(themeColorMeta)
    await fiber.dispose()
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
    expect(themeColorMeta?.isConnected).toBe(false)
    // Listener is off: further theme changes no longer reach the document.
    theme.setTheme('light')
    theme.setTheme('dark')
    expect(document.documentElement.style.colorScheme).toBe('')
    expect(document.body.hasAttribute('data-ds-dark-theme')).toBe(false)
  })

  it('teardown unwinds the service, the root registration, and the child declarations', async () => {
    const { ctx, slots, rendererHost } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const host = rendererHost()
    expect(host.root.getSnapshot().hooks.panelInfo).toBeDefined()
    await fiber.dispose()
    expect(ctx.get('layout')).toBeUndefined()
    expect(slots.entries('root')).toHaveLength(0)
    expect(slots.spec('sidebar')).toBeUndefined()
    expect(slots.spec('main')).toBeUndefined()
    expect(slots.spec('rightbar')).toBeUndefined()
    expect(slots.spec('shell.overlay')).toBeUndefined()
    expect(host.root.getSnapshot().hooks.panelInfo).toBeUndefined()
    // The built-in root declaration survives entry teardown (renderer-owned).
    expect(slots.spec('root')).toEqual({ kind: 'single', scope: 'root' })
  })
})

describe('node half', () => {
  it('node apply is an intentional no-op (loader-managed lifecycle only)', () => {
    nodeApply()
    expect(true).toBe(true) // reaching here without throw is the contract
  })
})
