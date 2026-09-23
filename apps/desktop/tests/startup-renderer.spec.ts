import { readFileSync } from 'node:fs'
import { runInContext } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'
import { expect, it, onTestFinished, vi } from 'vitest'
import type { DesktopBackendState } from '../src/backend-controller.ts'
import type { DshDesktopStartupApi } from '../src/ipc.ts'
import { resolveDesktopLocale } from '../src/locale.ts'
import { startupFailureDocument } from '../src/startup-document.ts'

function startup(locale = 'en', status: Promise<DesktopBackendState> = Promise.resolve({ phase: 'starting' })) {
  const dom = new JSDOM(readFileSync(new URL('../renderer/startup.html', import.meta.url), 'utf8'), { runScripts: 'outside-only' })
  onTestFinished(() => {
    dom.window.dispatchEvent(new dom.window.Event('pagehide'))
    dom.window.close()
  })
  const listeners = new Set<(state: DesktopBackendState) => void>()
  const unsubscribe = vi.fn(() => { listeners.clear() })
  const disablePlugins = vi.fn(async () => {})
  const resetConfiguration = vi.fn(async () => {})
  const restorePlannedSource = vi.fn(async () => {})
  const restart = vi.fn(async () => {})
  const queried = Promise.withResolvers<undefined>()
  const api: DshDesktopStartupApi = {
    protocolVersion: 2,
    locale: async () => resolveDesktopLocale(locale),
    backend: {
      status: () => { queried.resolve(undefined); return status },
      subscribe: (listener) => { listeners.add(listener); return unsubscribe },
    },
    disablePlugins, restorePlannedSource, resetConfiguration, restart,
  }
  Object.defineProperty(dom.window, 'dshDesktop', { value: api })
  runInContext(readFileSync(new URL('../renderer/startup.js', import.meta.url), 'utf8'), dom.getInternalVMContext())
  const document = dom.window.document
  const element = (selector: string): HTMLElement => {
    const result = document.querySelector<HTMLElement>(selector)
    if (result === null) throw new Error(`Missing startup element: ${selector}`)
    return result
  }
  const button = (selector: string): HTMLButtonElement => {
    const result = document.querySelector<HTMLButtonElement>(selector)
    if (result === null) throw new Error(`Missing startup button: ${selector}`)
    return result
  }
  const publish = (state: DesktopBackendState): void => { for (const listener of listeners) listener(state) }
  const copy = (): string => [element('#title').textContent, element('#description').textContent,
    ...['#reset-advice', '#reinstall-advice', '#error', '#actions'].filter(selector => !element(selector).hidden)
      .flatMap(selector => selector === '#actions'
        ? [...document.querySelectorAll<HTMLButtonElement>('#actions button')].filter(button => !button.hidden).map(button => button.textContent)
        : [element(selector).textContent]),
  ].join('\n')
  return { dom, document, element, button, publish, copy,
    disablePlugins, restorePlannedSource, resetConfiguration, restart, unsubscribe, queried: queried.promise }
}

it('shows English loading and recovery actions without a Host document', async () => {
  const page = startup()
  await expect.poll(() => page.element('#title').textContent).not.toBe('')
  expect(page.copy()).toMatchInlineSnapshot(`
    "Starting DeepSeek Harness…
    Your workspace will open when it is ready."
  `)
  expect(page.element('main').getAttribute('aria-busy')).toBe('true')
  expect(page.element('#spinner').hidden).toBe(false)
  expect(page.element('#actions').hidden).toBe(true)
  expect(page.button('#restart').disabled).toBe(true)
  expect(page.button('#disable-plugins').disabled).toBe(true)
  page.publish({ phase: 'error', profileRecovery: true, message: 'Plugin failed to load' })
  expect(page.copy()).toMatchInlineSnapshot(`
    "DeepSeek Harness could not start
    Choose a recovery action below. Disabling third-party plugins retains their files.
    Reset first saves a verified copy of configuration and plugin artifacts under the Harness home (desktop/profile-recovery), then removes the active Desktop configuration and plugins. node_modules is excluded; restoration is manual. If copying fails, nothing is deleted. Shared tasks and settings are retained.
    If application files are missing or damaged, close the application and reinstall it. Your tasks are stored separately.
    Plugin failed to load
    Close and restart
    Disable all third-party plugins and retry
    Reset Desktop and retry"
  `)
  expect(page.element('main').getAttribute('aria-busy')).toBe('false')
  expect(page.element('#spinner').hidden).toBe(true)
  page.button('#restart').click()
  expect(page.restart).toHaveBeenCalledOnce()
  expect(page.element('#actions').hidden).toBe(true)
  expect(page.element('#error').textContent).toBe('')
  expect(page.element('main').getAttribute('aria-busy')).toBe('true')
})

it('shows Chinese loading and recovery copy', async () => {
  const page = startup('zh-CN')
  await expect.poll(() => page.element('#title').textContent).not.toBe('')
  expect(page.document.documentElement.lang).toBe('zh-CN')
  expect(page.copy()).toMatchInlineSnapshot(`
    "正在启动 DeepSeek Harness…
    准备就绪后将自动打开工作区。"
  `)
  page.publish({ phase: 'error', profileRecovery: true, message: '插件加载失败' })
  expect(page.copy()).toMatchInlineSnapshot(`
    "DeepSeek Harness 无法启动
    请选择下方的恢复操作。禁用第三方插件会保留插件文件。
    重置会先将配置和插件制品的已校验副本保存在 Harness 数据目录下的 desktop/profile-recovery，再清除当前 Desktop 配置和插件。副本不含 node_modules，需手动还原；复制失败时不会删除原文件。共享任务和设置保留。
    如果应用文件缺失或损坏，请关闭应用并重新安装。任务数据存储在独立位置。
    插件加载失败
    关闭并重启
    禁用全部第三方插件并重试
    重置 Desktop 并重试"
  `)
})

it('offers only the retained package-specific planned-source recovery', async () => {
  const page = startup()
  await expect.poll(() => page.element('#title').textContent).not.toBe('')
  page.publish({ phase: 'error', profileRecovery: true, message: 'override failed', recovery: {
    type: 'restore-planned-source', packageName: 'provider', requestedVersion: '1.0.0',
  } })
  expect(page.button('#restore-planned-source').hidden).toBe(false)
  expect(page.button('#restore-planned-source').textContent).toContain('provider@1.0.0')
  page.button('#restore-planned-source').click()
  expect(page.restorePlannedSource).toHaveBeenCalledOnce()
  page.publish({ phase: 'error', profileRecovery: true, message: 'other failure' })
  expect(page.button('#restore-planned-source').hidden).toBe(true)
  page.publish({ phase: 'error', profileRecovery: false, message: 'unavailable', recovery: {
    type: 'restore-planned-source', packageName: 'provider', requestedVersion: '1.0.0',
  } })
  expect(page.button('#restore-planned-source').hidden).toBe(true)
})

it('renders diagnostic markup as text and exposes failures from recovery actions', async () => {
  const page = startup()
  await expect.poll(() => page.element('#title').textContent).not.toBe('')
  const diagnostic = '<img src=x onerror="window.compromised=true">'
  page.publish({ phase: 'error', profileRecovery: true, message: diagnostic })
  expect(page.element('#error').textContent).toBe(diagnostic)
  expect(page.element('#error').childElementCount).toBe(0)
  page.restart.mockRejectedValueOnce(new page.dom.window.Error('Retry failed'))
  page.button('#restart').click()
  await expect.poll(() => page.element('#error').textContent).toBe('Retry failed')
  expect(page.button('#restart').disabled).toBe(false)
  expect(page.button('#disable-plugins').disabled).toBe(false)
})

it('keeps subscribed state when initial status arrives late and detaches on pagehide', async () => {
  const initial = Promise.withResolvers<DesktopBackendState>()
  const page = startup('en', initial.promise)
  await page.queried
  page.publish({ phase: 'error', profileRecovery: true, message: 'Fresh startup failure' })
  initial.resolve({ phase: 'starting' })
  await initial.promise
  expect(page.element('#error').textContent).toBe('Fresh startup failure')
  expect(page.element('#actions').hidden).toBe(false)
  page.dom.window.dispatchEvent(new page.dom.window.Event('pagehide'))
  expect(page.unsubscribe).toHaveBeenCalledOnce()
  page.publish({ phase: 'starting' })
  expect(page.element('#error').textContent).toBe('Fresh startup failure')
  page.dom.window.dispatchEvent(new page.dom.window.Event('pagehide'))
  expect(page.unsubscribe).toHaveBeenCalledOnce()
})

it.each(['en', 'zh-CN'])('offers recovery actions with %s guidance and preserves diagnostic text', async (locale) => {
  const page = startup(locale)
  await expect.poll(() => page.button('#restart').disabled).toBe(true)
  page.publish({ phase: 'error', profileRecovery: true, message: 'Failure details' })
  await expect(`${page.copy()}\n`).toMatchFileSnapshot(fileURLToPath(new URL(`./expected/startup-${locale}-profile.txt`, import.meta.url)))
  for (const action of ['#disable-plugins', '#reset-configuration', '#restart']) {
    page.publish({ phase: 'error', profileRecovery: true, message: 'Failure details' })
    page.button(action).click()
    expect(page.element('#actions').hidden).toBe(true)
  }
  expect(page.disablePlugins).toHaveBeenCalledOnce()
  expect(page.resetConfiguration).toHaveBeenCalledOnce()
  expect(page.restart).toHaveBeenCalledOnce()
  page.publish({ phase: 'error', profileRecovery: false, message: 'Failure details' })
  expect(page.button('#disable-plugins').hidden).toBe(true)
  expect(page.button('#reset-configuration').hidden).toBe(true)
  await expect(`${page.copy()}\n`).toMatchFileSnapshot(fileURLToPath(new URL(`./expected/startup-${locale}-restart.txt`, import.meta.url)))
})

it('keeps emergency diagnostics inert without shell assets', () => {
  const html = startupFailureDocument(resolveDesktopLocale('zh-CN'), '<script>alert(1)</script>', true)
  const dom = new JSDOM(html)
  expect(dom.window.document.querySelector('script')).toBeNull()
  expect(dom.window.document.querySelector('pre')?.textContent).toBe('<script>alert(1)</script>')
  expect(dom.window.document.querySelector('p')?.textContent).toContain('重新安装')
  expect([...dom.window.document.querySelectorAll('form')].map(form => form.action)).toEqual([
    'dsh-recovery://restart', 'dsh-recovery://plugins', 'dsh-recovery://reset',
  ])
  dom.window.close()
})

it('offers retained planned-source recovery in the emergency document', () => {
  const html = startupFailureDocument(resolveDesktopLocale('en'), 'Override failed', true, {
    type: 'restore-planned-source', packageName: 'provider', requestedVersion: '1.0.0',
  })
  const dom = new JSDOM(html)
  expect([...dom.window.document.querySelectorAll('form')].map(form => form.action)).toEqual([
    'dsh-recovery://restart', 'dsh-recovery://restore', 'dsh-recovery://plugins', 'dsh-recovery://reset',
  ])
  expect(dom.window.document.body.textContent).toContain('provider@1.0.0')
  dom.window.close()
})

it('offers only restart before emergency profile recovery is available', () => {
  const dom = new JSDOM(startupFailureDocument(resolveDesktopLocale('en'), 'Resources unavailable'))
  expect([...dom.window.document.querySelectorAll('form')].map(form => form.action)).toEqual(['dsh-recovery://restart'])
  dom.window.close()
})
