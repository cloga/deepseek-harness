// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installWindowsMenu } from '../src/preload-menu.ts'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { WINDOWS_TITLEBAR_HEIGHT } from '../src/windows-layout.ts'

const invoke = vi.hoisted(() => vi.fn<(...args: unknown[]) => Promise<void>>())
vi.mock('electron', () => ({ ipcRenderer: { invoke } }))
let menu: ReturnType<typeof installWindowsMenu> | undefined

beforeEach(() => {
  const appSeat = document.createElement('div')
  appSeat.dataset.shellOverlay = ''
  document.body.append(appSeat)
  document.documentElement.lang = 'en'
  invoke.mockResolvedValue(undefined)
})

it('opens the caption menu during loading and retains the same host when AppFrame arrives', async () => {
  document.body.replaceChildren()
  const loading = document.createElement('div')
  loading.dataset.dshBoot = ''
  document.body.append(loading)
  const input = document.createElement('input')
  loading.append(input)
  input.focus()
  menu = installWindowsMenu()
  const host = document.querySelector('[data-windows-menu]')!
  expect(document.activeElement).toBe(input)
  expect(document.querySelector('[data-shell-overlay]')).toBeNull()
  expect(host.parentElement).toBe(document.body)
  const button = host.shadowRoot!.querySelector('button')!
  expect(button.textContent).toBe('Application')
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(48, 6, 90, 28))
  button.click()
  expect(invoke).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.windowsMenu, 'application', 48, 34)
  await vi.waitFor(() => { expect(button.getAttribute('aria-expanded')).toBe('false') })
  const appSeat = document.createElement('div')
  appSeat.dataset.shellOverlay = ''
  loading.replaceWith(appSeat)
  await new Promise<void>((resolve) => { queueMicrotask(resolve) })
  expect(document.querySelectorAll('[data-windows-menu]')).toHaveLength(1)
  expect(document.querySelector('[data-windows-menu]')).toBe(host)
  expect(host.shadowRoot!.querySelector('button')).toBe(button)
  button.click()
  expect(invoke).toHaveBeenCalledTimes(2)
})

it('removes the loading menu and its focus listener without remounting after disposal', async () => {
  document.body.replaceChildren()
  const added = vi.spyOn(document, 'addEventListener')
  const removed = vi.spyOn(document, 'removeEventListener')
  menu = installWindowsMenu()
  expect(document.querySelector('[data-windows-menu]')).not.toBeNull()
  const listener = added.mock.calls.find(([type]) => type === 'focusout')![1]
  menu.dispose()
  expect(removed).toHaveBeenCalledWith('focusout', listener, true)
  const appSeat = document.createElement('div')
  appSeat.dataset.shellOverlay = ''
  document.body.append(appSeat)
  await new Promise<void>((resolve) => { queueMicrotask(resolve) })
  expect(document.querySelector('[data-windows-menu]')).toBeNull()
})
afterEach(() => {
  menu?.dispose()
  menu = undefined
  document.body.replaceChildren()
  document.body.removeAttribute('style')
  document.body.removeAttribute('data-ds-dark-theme')
  document.documentElement.lang = ''
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('localizes caption entries and removes the menu on disposal', () => {
  menu = installWindowsMenu()
  const host = document.querySelector('[data-windows-menu]')!
  const bar = host.shadowRoot!.querySelector('[role=menubar]')!
  expect(bar.outerHTML).toMatchSnapshot('english')
  document.documentElement.lang = 'zh-CN'
  menu.update()
  expect(bar.outerHTML).toMatchSnapshot('chinese')
  menu.dispose()
  menu = undefined
  expect(document.querySelector('[data-windows-menu]')).toBeNull()
})

it('provides caption geometry, system font and paired system colors before theme delivery', () => {
  document.body.replaceChildren()
  menu = installWindowsMenu()
  const css = document.querySelector('[data-windows-menu]')!.shadowRoot!.querySelector('style')!.textContent!
  expect(css).toContain(`var(--dsh-windows-titlebar-height, ${WINDOWS_TITLEBAR_HEIGHT}px)`)
  expect(css).toContain('var(--dsh-windows-menu-start, 48px)')
  expect(css).toContain('var(--dsw-font-family, system-ui, sans-serif)')
  expect(css).toContain('var(--dsw-specific-sidebar-fill, Canvas)')
  expect(css).toContain('var(--dsw-alias-label-secondary, CanvasText)')
  expect(css).toContain('var(--dsw-alias-interactive-bg-hover, ButtonFace)')
  expect(css).toContain('var(--dsw-alias-label-primary, ButtonText)')
})

it.each([
  { language: 'zh-CN', dark: true, label: '应用', background: '#181818', foreground: '#eeeeee' },
  { language: 'en', dark: false, label: 'Application', background: '#fafafa', foreground: '#222222' },
])('retains one caption menu across $language locale and dark=$dark theme updates', ({ language, dark, label, background, foreground }) => {
  document.body.replaceChildren()
  menu = installWindowsMenu()
  const host = document.querySelector('[data-windows-menu]')!
  const style = host.shadowRoot!.querySelector('style')!
  const rules = style.textContent
  document.documentElement.lang = language
  document.body.toggleAttribute('data-ds-dark-theme', dark)
  document.body.style.setProperty('--dsw-specific-sidebar-fill', background)
  document.body.style.setProperty('--dsw-alias-label-secondary', foreground)
  menu.update()
  expect(document.querySelectorAll('[data-windows-menu]')).toHaveLength(1)
  expect(document.querySelector('[data-windows-menu]')).toBe(host)
  expect(host.shadowRoot!.querySelector('button')!.textContent).toBe(label)
  // Palette references stay live CSS; jsdom does not establish rendered shadow-tree contrast.
  expect(host.shadowRoot!.querySelector('style')).toBe(style)
  expect(style.textContent).toBe(rules)
  expect(host.getAttribute('style')).toBeNull()
})

it('opens native menus without stealing pointer focus and resets popup state when closed', async () => {
  let close!: () => void
  invoke.mockImplementation(() => new Promise<void>((resolve) => { close = resolve }))
  menu = installWindowsMenu()
  const button = document.querySelector('[data-windows-menu]')!.shadowRoot!.querySelector('button')!
  vi.spyOn(button, 'getBoundingClientRect').mockReturnValue(new DOMRect(48, 6, 90, 28))
  const pointer = new MouseEvent('pointerdown', { cancelable: true })
  button.dispatchEvent(pointer)
  expect(pointer.defaultPrevented).toBe(true)
  const mouse = new MouseEvent('mousedown', { cancelable: true })
  button.dispatchEvent(mouse)
  expect(mouse.defaultPrevented).toBe(true)
  button.click()
  expect(invoke).toHaveBeenCalledExactlyOnceWith(DESKTOP_IPC.windowsMenu, 'application', 48, 34)
  expect(button.getAttribute('aria-expanded')).toBe('true')
  close()
  await vi.waitFor(() => { expect(button.getAttribute('aria-expanded')).toBe('false') })
})

it('moves between menu entries with arrow keys and opens the focused entry with ArrowDown', () => {
  menu = installWindowsMenu()
  const buttons = document.querySelector('[data-windows-menu]')!.shadowRoot!.querySelectorAll('button')
  buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }))
  expect(buttons[0]!.tabIndex).toBe(-1)
  expect(buttons[1]!.tabIndex).toBe(0)
  buttons[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))
  expect(invoke).toHaveBeenCalledWith(DESKTOP_IPC.windowsMenu, 'edit', 0, 0)
})

it('restores a text input and its selection before opening a keyboard menu', async () => {
  const input = document.createElement('input')
  input.value = 'editor text'
  document.body.append(input)
  menu = installWindowsMenu()
  const button = document.querySelector('[data-windows-menu]')!.shadowRoot!.querySelector('button')!
  input.focus()
  input.setSelectionRange(2, 6, 'backward')
  button.focus()
  input.setSelectionRange(0, 0)
  button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))
  expect(document.activeElement).toBe(input)
  expect([input.selectionStart, input.selectionEnd, input.selectionDirection]).toEqual([2, 6, 'backward'])
  await vi.waitFor(() => { expect(button.getAttribute('aria-expanded')).toBe('false') })
})

it('reports a failed popup request and clears the active menu', async () => {
  const error = new Error('popup rejected')
  const log = vi.spyOn(console, 'error').mockImplementation(() => {})
  invoke.mockRejectedValue(error)
  menu = installWindowsMenu()
  const button = document.querySelector('[data-windows-menu]')!.shadowRoot!.querySelector('button')!
  button.click()
  await vi.waitFor(() => { expect(log).toHaveBeenCalledWith('Desktop caption menu failed', error) })
  expect(button.getAttribute('aria-expanded')).toBe('false')
})

it('restores a contenteditable selection before opening Edit with the keyboard', async () => {
  const editor = document.createElement('div')
  editor.contentEditable = 'true'
  editor.setAttribute('contenteditable', 'true')
  editor.tabIndex = 0
  editor.textContent = 'editable text'
  document.body.append(editor)
  menu = installWindowsMenu()
  const buttons = document.querySelector('[data-windows-menu]')!.shadowRoot!.querySelectorAll('button')
  editor.focus()
  const range = document.createRange()
  range.setStart(editor.firstChild!, 2)
  range.setEnd(editor.firstChild!, 8)
  document.getSelection()!.removeAllRanges()
  document.getSelection()!.addRange(range)
  buttons[0]!.focus()
  document.getSelection()!.removeAllRanges()
  buttons[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true }))
  buttons[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true }))
  expect(document.activeElement).toBe(editor)
  expect(document.getSelection()!.toString()).toBe('itable')
  await vi.waitFor(() => { expect(buttons[1]!.getAttribute('aria-expanded')).toBe('false') })
})
