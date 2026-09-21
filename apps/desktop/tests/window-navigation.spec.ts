import { EventEmitter } from 'node:events'
import type { WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDesktopWindowNavigation } from '../src/window-navigation.ts'

function fixture(currentUrl = 'dsh-app://app/index.html') {
  const events = new EventEmitter()
  const setWindowOpenHandler = vi.fn<WebContents['setWindowOpenHandler']>()
  const actions = {
    openExternal: vi.fn<(url: string) => Promise<void>>(async () => {}),
    openFailed: vi.fn<() => void>(),
  }
  installDesktopWindowNavigation({
    setWindowOpenHandler,
    getURL: () => currentUrl,
    on: (event, listener) => events.on(event, listener),
  }, actions)
  return {
    actions,
    popup(url: string) {
      const handler = setWindowOpenHandler.mock.calls.at(-1)![0]
      return handler({
        url, frameName: '', features: '', disposition: 'new-window',
        referrer: { url: 'dsh-app://app/index.html', policy: 'no-referrer' },
      })
    },
    navigate(url: string) {
      const event = { preventDefault: vi.fn() }
      events.emit('will-navigate', event, url)
      return event
    },
  }
}

// OS opening is replaced by an already-settled Promise; a turn drains its dispatch and rejection handlers.
async function settledTurn(): Promise<void> {
  await new Promise<void>(resolve => setImmediate(resolve))
}

afterEach(() => { vi.restoreAllMocks() })

describe('Desktop window navigation', () => {
  it.each(['http://example.com/page', 'https://example.com/page?code=synthetic'])('opens %s exactly once per popup without creating an Electron window', async (url) => {
    const view = fixture()
    expect(view.popup(url)).toEqual({ action: 'deny' })
    await settledTurn()
    expect(view.actions.openExternal).toHaveBeenCalledExactlyOnceWith(url)
    expect(view.actions.openFailed).not.toHaveBeenCalled()
  })

  it.each(['http://example.com/page', 'https://example.com/page?code=synthetic'])('prevents application replacement when opening %s', async (url) => {
    const view = fixture()
    expect(view.navigate(url).preventDefault).toHaveBeenCalledOnce()
    await settledTurn()
    expect(view.actions.openExternal).toHaveBeenCalledExactlyOnceWith(url)
  })

  it.each([
    '', 'not a URL', 'https://', 'file:///private/config', 'javascript:alert(1)',
    'data:text/html,hello', 'mailto:user@example.com', 'custom-app://launch',
  ])('blocks malformed or unsupported destination %j on both paths', async (url) => {
    const view = fixture()
    expect(view.popup(url)).toEqual({ action: 'deny' })
    expect(view.navigate(url).preventDefault).toHaveBeenCalledOnce()
    await settledTurn()
    expect(view.actions.openExternal).not.toHaveBeenCalled()
    expect(view.actions.openFailed).not.toHaveBeenCalled()
  })

  it('keeps owned application navigation internal but still denies an application popup', async () => {
    const view = fixture()
    expect(view.navigate('dsh-app://app/session/one').preventDefault).not.toHaveBeenCalled()
    expect(view.popup('dsh-app://app/session/one')).toEqual({ action: 'deny' })
    await settledTurn()
    expect(view.actions.openExternal).not.toHaveBeenCalled()
  })

  it.each(['restart', 'plugins', 'reset'])('blocks recovery URL %s without granting navigation any recovery authority', async (action) => {
    const view = fixture()
    const url = `dsh-recovery://${action}/`
    expect(view.popup(url)).toEqual({ action: 'deny' })
    expect(view.navigate(url).preventDefault).toHaveBeenCalledOnce()
    await settledTurn()
    expect(view.actions.openExternal).not.toHaveBeenCalled()
    expect(view.actions.openFailed).not.toHaveBeenCalled()
  })

  it('preserves same-origin HTTP application navigation while still denying its popup', async () => {
    const view = fixture('http://127.0.0.1:19387/app/')
    const destination = 'http://127.0.0.1:19387/session/one'
    expect(view.navigate(destination).preventDefault).not.toHaveBeenCalled()
    await settledTurn()
    expect(view.actions.openExternal).not.toHaveBeenCalled()
    expect(view.popup(destination)).toEqual({ action: 'deny' })
    await settledTurn()
    expect(view.actions.openExternal).toHaveBeenCalledExactlyOnceWith(destination)
  })

  it.each(['http://127.0.0.1:19388/app/', 'http://localhost:19387/app/', 'https://127.0.0.1:19387/app/'])(
    'does not extend the owned HTTP origin to %s', async (destination) => {
      const view = fixture('http://127.0.0.1:19387/app/')
      expect(view.navigate(destination).preventDefault).toHaveBeenCalledOnce()
      await settledTurn()
      expect(view.actions.openExternal).toHaveBeenCalledExactlyOnceWith(destination)
    },
  )

  it.each(['', 'not a URL', 'about:blank', 'https://127.0.0.1:19387/app/'])(
    'does not treat current URL %j as an owned HTTP origin', async (currentUrl) => {
      const view = fixture(currentUrl)
      const destination = 'http://127.0.0.1:19387/session/one'
      expect(view.navigate(destination).preventDefault).toHaveBeenCalledOnce()
      await settledTurn()
      expect(view.actions.openExternal).toHaveBeenCalledExactlyOnceWith(destination)
    },
  )

  it('dispatches the parsed canonical HTTP URL rather than a differently interpreted input', async () => {
    const view = fixture()
    view.popup('HTTPS://EXAMPLE.COM/path?code=synthetic#section')
    await settledTurn()
    expect(view.actions.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/path?code=synthetic#section')
  })

  it.each(['rejection', 'throw'] as const)('contains an OS %s without retrying or exposing the URL to the reporter', async (failure) => {
    const view = fixture()
    const error = new Error('https://example.com/?private=must-not-escape')
    if (failure === 'rejection') view.actions.openExternal.mockRejectedValue(error)
    else view.actions.openExternal.mockImplementation(() => { throw error })
    view.popup('https://example.com/?private=must-not-escape')
    await settledTurn()
    expect(view.actions.openFailed).toHaveBeenCalledExactlyOnceWith()
    await settledTurn()
    expect(view.actions.openExternal).toHaveBeenCalledOnce()
  })

  it('contains failure-reporting errors without leaking either error payload', async () => {
    const view = fixture()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    view.actions.openExternal.mockRejectedValue(new Error('private open error'))
    view.actions.openFailed.mockImplementation(() => { throw new Error('private report error') })
    view.navigate('https://example.com/?secret=synthetic')
    await settledTurn()
    expect(warn).toHaveBeenCalledExactlyOnceWith('Desktop could not display the browser-opening error.')
  })

  it('keeps each window bound to its own operations', async () => {
    const first = fixture()
    const second = fixture()
    first.popup('https://example.com/first')
    second.navigate('https://example.com/second')
    await settledTurn()
    expect(first.actions.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/first')
    expect(second.actions.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/second')
  })
})
