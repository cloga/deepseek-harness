import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { JSDOM } from 'jsdom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopLocale } from '../src/locale.ts'
import type { DesktopPluginRecord } from '../src/project-manager.ts'

it('keeps disabled packages visible and offers recovery without a running backend', async () => {
  const dom = new JSDOM(readFileSync(new URL('../renderer/plugin-manager.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  let enabled = true
  let ready = false
  const disableAll = vi.fn(async () => { enabled = false; ready = true })
  const toggle = vi.fn(async (_name: string, active: boolean) => { enabled = active })
  const api = {
    locale: async () => resolveDesktopLocale('en'),
    backend: { status: async () => ready ? { phase: 'ready' } : { phase: 'error', message: 'plugin requires Cordis ^2.0.0' }, retry: vi.fn() },
    plugins: { list: async () => [{ name: 'example-plugin', version: '1.0.0', enabled }], disableAll, toggle },
  }
  Object.defineProperty(dom.window, 'dshDesktop', { value: api })
  try {
    runInContext(readFileSync(new URL('../renderer/plugin-manager.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
    const document = dom.window.document
    await expect.poll(() => document.querySelector('#plugins li')?.textContent).toContain('example-plugin')
    expect(document.querySelector<HTMLElement>('#recovery')?.hidden).toBe(false)
    expect(document.querySelector('#startup-error')?.textContent).toBe('plugin requires Cordis ^2.0.0')
    document.querySelector<HTMLButtonElement>('#disable-all')?.click()
    await expect.poll(() => document.querySelector<HTMLElement>('#recovery')?.hidden).toBe(true)
    expect(disableAll).toHaveBeenCalledOnce()
    expect(document.querySelector('#plugins li')?.textContent).toMatchInlineSnapshot('"example-plugin1.0.0 · DisabledEnableUpdateRemove"')
    document.querySelector<HTMLButtonElement>('#plugins li button')?.click()
    await expect.poll(() => toggle.mock.calls).toEqual([['example-plugin', true]])
    await expect.poll(() => document.querySelector('#plugins li')?.textContent).toBe('example-plugin1.0.0DisableUpdateRemove')
  } finally { dom.window.close() }
})

const windows: JSDOM[] = []
const commit = '0123456789abcdef0123456789abcdef01234567'
const sha256 = 'a'.repeat(64)
const registryPlugin = { name: 'example-plugin', version: '1.0.0', enabled: true } as const

function sourcePlugin(spec = 'github:example/plugin#stable', resolved = `https://github.com/example/plugin/archive/${commit}.tar.gz`, sourceCommit: string | undefined = resolved.startsWith('https://github.com/') ? commit : undefined): DesktopPluginRecord {
  return {
    ...registryPlugin,
    source: { schemaVersion: 1, type: 'packageSpec', spec },
    resolution: { resolved, sha256, integrity: `sha512-${'a'.repeat(86)}==`, ...(sourceCommit === undefined ? {} : { commit: sourceCommit }) },
  }
}

async function mount(plugins: readonly DesktopPluginRecord[], locale = 'en') {
  const dom = new JSDOM(readFileSync(new URL('../renderer/plugin-manager.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  windows.push(dom)
  const api = {
    locale: async () => resolveDesktopLocale(locale),
    backend: { status: async () => ({ phase: 'ready' }), retry: vi.fn() },
    plugins: {
      list: vi.fn(async () => plugins),
      add: vi.fn(async (_spec: string) => {}),
      update: vi.fn(async (_name: string, _version: string) => {}),
      remove: vi.fn(), toggle: vi.fn(), disableAll: vi.fn(),
    },
  }
  Object.defineProperty(dom.window, 'dshDesktop', { value: api })
  const document = dom.window.document
  const dialog = document.querySelector<HTMLDialogElement>('#package-dialog')!
  // jsdom implements dialog elements, but not Chromium's modal activation methods.
  if (typeof dialog.showModal !== 'function') Object.defineProperty(dialog, 'showModal', { value: () => { dialog.open = true } })
  if (typeof dialog.close !== 'function') Object.defineProperty(dialog, 'close', { value: () => { dialog.open = false } })
  runInContext(readFileSync(new URL('../renderer/plugin-manager.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
  await expect.poll(() => document.querySelectorAll('#plugins li').length).toBe(plugins.length)
  await expect.poll(() => document.querySelector('#source-help')?.textContent).toBe(resolveDesktopLocale(locale).messages.pluginSourceHelp)
  return { dom, document, api }
}

function action(document: Document, label: string): HTMLButtonElement {
  const button = [...document.querySelectorAll<HTMLButtonElement>('#plugins button')].find(element => element.textContent === label)
  if (!button) throw new Error(`missing action ${label}`)
  return button
}

function dialogInput(document: Document): HTMLInputElement {
  return document.querySelector<HTMLInputElement>('#package-dialog-input')!
}

function answerDialog(document: Document, answer: string | null): void {
  if (answer === null) {
    document.querySelector<HTMLButtonElement>('#package-dialog-cancel')!.click()
  } else {
    dialogInput(document).value = answer
    document.querySelector<HTMLButtonElement>('#package-dialog-confirm')!.click()
  }
}

afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
})

describe('source-aware plugin manager', () => {
  it.each(['en', 'zh-CN'])('localizes general source inputs and prebuilt-output guidance in %s', async (locale) => {
    const { document } = await mount([], locale)
    const { messages } = resolveDesktopLocale(locale)
    expect(document.querySelector('#package-label')?.textContent).toBe(messages.pluginSource)
    expect(document.querySelector<HTMLInputElement>('#package-spec')?.placeholder).toBe(messages.pluginSourcePlaceholder)
    expect(document.querySelector('#source-build-notice')?.textContent).toBe(messages.pluginSourceBuildNotice)
    expect(document.querySelector<HTMLInputElement>('#package-spec')?.getAttribute('aria-describedby')).toBe('source-help source-build-notice')
  })

  it('keeps npm version updates on the registry update API', async () => {
    const { document, api } = await mount([registryPlugin])
    action(document, 'Update').click()
    expect(document.querySelector('#package-dialog-label')?.textContent).toBe('Enter the target version for example-plugin')
    expect(dialogInput(document).value).toBe('1.0.0')
    expect(document.querySelector('#package-dialog-confirm')?.textContent).toBe('Update')
    answerDialog(document, ' 2.0.0 ')
    await expect.poll(() => api.plugins.update.mock.calls).toEqual([['example-plugin', '2.0.0']])
    expect(api.plugins.add).not.toHaveBeenCalled()
  })

  it.each([null, '', '1.0.0'])('keeps registry prompt %s a no-op', async (answer) => {
    const { document, api } = await mount([registryPlugin])
    action(document, 'Update').click()
    answerDialog(document, answer)
    await Promise.resolve()
    expect(api.plugins.update).not.toHaveBeenCalled()
    expect(api.plugins.add).not.toHaveBeenCalled()
  })

  it('reinstalls an unchanged GitHub source spec rather than issuing a registry update', async () => {
    const plugin = sourcePlugin()
    const { document, api } = await mount([plugin])
    action(document, 'Reinstall from source').click()
    expect(document.querySelector('#package-dialog-label')?.textContent).toContain('Original source: github:example/plugin#stable')
    expect(dialogInput(document).value).toBe('github:example/plugin#stable')
    expect(document.querySelector('#package-dialog-confirm')?.textContent).toBe('Reinstall from source')
    answerDialog(document, dialogInput(document).value)
    await expect.poll(() => api.plugins.add.mock.calls).toEqual([['github:example/plugin#stable']])
    expect(api.plugins.update).not.toHaveBeenCalled()
    expect([...document.querySelectorAll('#plugins button')].some(button => button.textContent === 'Update')).toBe(false)
  })

  it('allows editing a stored source before reinstalling', async () => {
    const { document, api } = await mount([sourcePlugin()])
    action(document, 'Reinstall from source').click()
    answerDialog(document, ' github:example/plugin#next ')
    await expect.poll(() => api.plugins.add.mock.calls).toEqual([['github:example/plugin#next']])
    expect(api.plugins.update).not.toHaveBeenCalled()
  })

  it.each([null, '', '   '])('makes canceled or empty source prompt %s a no-op', async (answer) => {
    const { document, api } = await mount([sourcePlugin()])
    action(document, 'Reinstall from source').click()
    answerDialog(document, answer)
    await Promise.resolve()
    expect(api.plugins.add).not.toHaveBeenCalled()
    expect(api.plugins.update).not.toHaveBeenCalled()
  })

  it.each([
    ['file:///C:/Plugins/my%20plugin', 'file:C:/Plugins/my plugin'],
    ['file:///home/user/my%20plugin', 'file:/home/user/my plugin'],
    ['file://server/share/my%20plugin', 'file:\\\\server\\share\\my plugin'],
    ['file:///C:/Plugins/%E6%8F%92%E4%BB%B6%23one.tgz', 'file:C:/Plugins/插件#one.tgz'],
  ])('uses canonical local resolution %s instead of replaying a relative source', async (resolved, expected) => {
    const { document, api } = await mount([sourcePlugin('link:../plugin', resolved, undefined)])
    action(document, 'Reinstall from source').click()
    expect(dialogInput(document).value).toBe(expected)
    expect(document.querySelector('#package-dialog-label')?.textContent).toContain('Original source: link:../plugin')
    answerDialog(document, dialogInput(document).value)
    await expect.poll(() => api.plugins.add.mock.calls).toEqual([[expected]])
    expect(api.plugins.update).not.toHaveBeenCalled()
  })

  it.each(['file:///bad%2fpath/plugin', 'file:///bad%5cpath/plugin', 'file:///bad%ZZ/plugin', 'file:///local/plugin?other=path'])('requires explicit local re-entry for unsafe file resolution %s', async (resolved) => {
    const { document, api } = await mount([sourcePlugin('../plugin', resolved, undefined)])
    action(document, 'Reinstall from source').click()
    expect(dialogInput(document).value).toBe('')
    answerDialog(document, '')
    await Promise.resolve()
    expect(api.plugins.add).not.toHaveBeenCalled()
  })

  it('requires explicit re-entry when a relative local source has no canonical resolution', async () => {
    const plugin: DesktopPluginRecord = { ...registryPlugin, source: { schemaVersion: 1, type: 'packageSpec', spec: '../plugin' } }
    const { document, api } = await mount([plugin])
    action(document, 'Reinstall from source').click()
    expect(dialogInput(document).value).toBe('')
    answerDialog(document, null)
    await Promise.resolve()
    expect(api.plugins.add).not.toHaveBeenCalled()
  })

  it('focuses and selects the dialog input, then restores focus on Cancel', async () => {
    const { document, api } = await mount([sourcePlugin()])
    const opener = action(document, 'Reinstall from source')
    opener.click()
    const input = dialogInput(document)
    expect(document.querySelector<HTMLDialogElement>('#package-dialog')?.open).toBe(true)
    expect(document.activeElement).toBe(input)
    expect(input.selectionStart).toBe(0)
    expect(input.selectionEnd).toBe(input.value.length)
    answerDialog(document, null)
    await Promise.resolve()
    expect(document.querySelector<HTMLDialogElement>('#package-dialog')?.open).toBe(false)
    expect(document.activeElement).toBe(opener)
    expect(api.plugins.add).not.toHaveBeenCalled()
  })

  it('handles the dialog Escape cancel event without performing an update', async () => {
    const { dom, document, api } = await mount([registryPlugin])
    const opener = action(document, 'Update')
    opener.click()
    const dialog = document.querySelector<HTMLDialogElement>('#package-dialog')!
    dialog.dispatchEvent(new dom.window.Event('cancel', { cancelable: true }))
    await Promise.resolve()
    expect(dialog.open).toBe(false)
    expect(document.activeElement).toBe(opener)
    expect(api.plugins.update).not.toHaveBeenCalled()
  })

  it('submits through the form event used by Enter and permits only one prompt at a time', async () => {
    const { dom, document, api } = await mount([registryPlugin, { ...sourcePlugin(), name: 'source-plugin' }])
    action(document, 'Reinstall from source').click()
    action(document, 'Update').click()
    await Promise.resolve()
    expect(document.querySelector('#package-dialog-label')?.textContent).toContain('Reinstall source-plugin from source')
    const form = document.querySelector<HTMLFormElement>('#package-dialog-form')!
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await expect.poll(() => api.plugins.add.mock.calls).toEqual([['github:example/plugin#stable']])
    expect(api.plugins.update).not.toHaveBeenCalled()
    expect(document.querySelector<HTMLDialogElement>('#package-dialog')?.open).toBe(false)
  })

  it('localizes the editable dialog and Cancel action in Chinese', async () => {
    const { document } = await mount([sourcePlugin()], 'zh-CN')
    action(document, '从来源重新安装').click()
    expect(document.querySelector('#package-dialog-label')?.textContent).toContain('原始来源：github:example/plugin#stable')
    expect(document.querySelector('#package-dialog-confirm')?.textContent).toBe('从来源重新安装')
    expect(document.querySelector('#package-dialog-cancel')?.textContent).toBe('取消')
    answerDialog(document, null)
  })

  it('does not rely on unsupported Electron native prompts', () => {
    const script = readFileSync(new URL('../renderer/plugin-manager.js', import.meta.url), 'utf8')
    expect(script).not.toContain('window.prompt')
  })

  it('discloses requested source and immutable commit/hash without claiming verification', async () => {
    const { document } = await mount([sourcePlugin()])
    const disclosure = document.querySelector('.package-source')
    expect(disclosure?.textContent).toContain('GitHub source: github:example/plugin#stable')
    expect(disclosure?.textContent).toContain(`Commit ${commit.slice(0, 12)}`)
    expect(disclosure?.textContent).toContain(`SHA-256 ${sha256.slice(0, 12)}`)
    expect(disclosure?.textContent).not.toMatch(/verified|attested/iu)
    const details = disclosure?.querySelector<HTMLElement>('.package-source')
    expect(details?.title).toContain(commit)
    expect(details?.title).toContain(sha256)
    expect(details?.title).toContain(`https://github.com/example/plugin/archive/${commit}.tar.gz`)
  })

  it.each([
    ['file:C:/plugin', 'file:///C:/plugin', 'Local snapshot'],
    ['https://example.test/plugin.tgz', 'https://example.test/plugin.tgz', 'HTTPS archive'],
  ])('discloses source category for %s', async (spec, resolved, category) => {
    const { document } = await mount([sourcePlugin(spec, resolved, undefined)])
    expect(document.querySelector('.package-source')?.textContent).toContain(category)
  })

  it('renders source strings as text rather than HTML', async () => {
    const { document } = await mount([sourcePlugin('<img src=x onerror="alert(1)">')])
    expect(document.querySelector('.package-source')?.textContent).toContain('<img src=x onerror="alert(1)">')
    expect(document.querySelector('#plugins img')).toBeNull()
  })

  it('does not offer an npm update for a verified-release plugin', async () => {
    const plugin: DesktopPluginRecord = {
      ...registryPlugin,
      source: {
        schemaVersion: 1, type: 'githubRelease', owner: 'example', repo: 'release-plugin', tag: 'v1.0.0', asset: 'plugin.tgz', assetId: 1,
        packageName: registryPlugin.name, version: registryPlugin.version, size: 100, sha256, targetCommit: commit,
      },
    }
    const { document, api } = await mount([plugin])
    expect([...document.querySelectorAll('#plugins button')].map(button => button.textContent)).toEqual(['Disable', 'Remove'])
    expect(document.querySelector('.package-source')?.textContent).toContain('GitHub Release: example/release-plugin@v1.0.0')
    expect(document.querySelector('.package-source')?.textContent).toContain('Update this plugin through its verified release source')
    document.querySelector<HTMLButtonElement>('#refresh')?.click()
    await expect.poll(() => api.plugins.list.mock.calls.length).toBe(2)
    expect([...document.querySelectorAll('#plugins button')].map(button => button.textContent)).toEqual(['Disable', 'Remove'])
    expect(api.plugins.update).not.toHaveBeenCalled()
  })

  it('preserves source-install errors and re-enables controls without falling back to npm', async () => {
    const { dom, document, api } = await mount([sourcePlugin()])
    api.plugins.add.mockRejectedValueOnce(new dom.window.Error('missing prebuilt output lib/index.js'))
    action(document, 'Reinstall from source').click()
    answerDialog(document, 'github:example/plugin#stable')
    await expect.poll(() => document.querySelector('#status')?.textContent).toBe('missing prebuilt output lib/index.js')
    expect(action(document, 'Reinstall from source').disabled).toBe(false)
    expect(api.plugins.update).not.toHaveBeenCalled()
    expect(document.querySelector('#plugins li')?.textContent).toContain('example-plugin')
  })

  it('passes the entered source to add and clears it only after success', async () => {
    const { dom, document, api } = await mount([])
    const input = document.querySelector<HTMLInputElement>('#package-spec')!
    const form = document.querySelector<HTMLFormElement>('#install-form')!
    input.value = ' github:example/plugin#stable '
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await expect.poll(() => api.plugins.add.mock.calls).toEqual([['github:example/plugin#stable']])
    await expect.poll(() => input.value).toBe('')
    api.plugins.add.mockRejectedValueOnce(new dom.window.Error('unsafe source URL'))
    input.value = 'http://example.test/plugin.tgz'
    form.dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true }))
    await expect.poll(() => document.querySelector('#status')?.textContent).toBe('unsafe source URL')
    expect(input.value).toBe('http://example.test/plugin.tgz')
  })
})
