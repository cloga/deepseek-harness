// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '../src/client/index.ts'
import { DesktopUpdateNotice } from '../src/client/DesktopUpdateNotice.tsx'
import { en } from '../src/client/locales.ts'

type State = { phase: 'idle' | 'checking' | 'available' | 'installing' | 'ready' | 'error'; version?: string }
const t: PropsLocale<'layout'>['t'] = key => Object.hasOwn(en, key) ? en[key as keyof typeof en] : key
let original: PropertyDescriptor | undefined

beforeEach(() => {
  original = Object.getOwnPropertyDescriptor(window, 'dshDesktop')
  Reflect.deleteProperty(window, 'dshDesktop')
})

afterEach(() => {
  cleanup()
  if (original === undefined) Reflect.deleteProperty(window, 'dshDesktop')
  else Object.defineProperty(window, 'dshDesktop', original)
  vi.restoreAllMocks()
})

function attach(initial: Promise<State> = Promise.resolve({ phase: 'idle' })) {
  let listener: (state: State) => void = () => {}
  const off = vi.fn()
  const review = vi.fn(async () => {})
  const status = vi.fn(() => initial)
  const subscribe = vi.fn((next: (state: State) => void) => { listener = next; return off })
  Object.defineProperty(window, 'dshDesktop', {
    configurable: true,
    value: { protocolVersion: 2, updates: { status, subscribe, review } },
  })
  return { off, review, status, subscribe, emit: (state: State) => { act(() => { listener(state) }) } }
}

async function mount() {
  const result = render(<DesktopUpdateNotice t={t} />)
  await act(async () => { await Promise.resolve() })
  return result
}

describe('Desktop update notice', () => {
  it('occupies no space on plain Web or an older report-only Desktop bridge', async () => {
    const plain = await mount()
    expect(plain.container.childElementCount).toBe(0)
    plain.unmount()
    Object.defineProperty(window, 'dshDesktop', { configurable: true, value: { protocolVersion: 2, updates: { reportImpact: vi.fn() } } })
    const old = await mount()
    expect(old.container.childElementCount).toBe(0)
  })

  it('shows a late-mount available snapshot without installing or stealing focus', async () => {
    const api = attach(Promise.resolve({ phase: 'available', version: '0.1.5-rc.3.cloga.7' }))
    const focused = document.activeElement
    await mount()
    expect(screen.getByRole('status').textContent).toContain('Update available')
    expect(screen.getByRole('status').textContent).toContain('0.1.5-rc.3.cloga.7')
    expect(screen.getByRole('button', { name: 'Review update' }).hasAttribute('disabled')).toBe(false)
    expect(api.review).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(focused)
    expect(api.subscribe.mock.invocationCallOrder[0]).toBeLessThan(api.status.mock.invocationCallOrder[0]!)
  })

  it('lets a newer event beat a delayed initial snapshot', async () => {
    const pending = Promise.withResolvers<State>()
    const api = attach(pending.promise)
    await mount()
    api.emit({ phase: 'available', version: '2.0.0' })
    await act(async () => { pending.resolve({ phase: 'idle' }); await pending.promise })
    expect(screen.getByRole('status').textContent).toContain('2.0.0')
  })

  it('recovers from an initial snapshot failure using later events', async () => {
    const api = attach(Promise.reject(new Error('offline')))
    const result = await mount()
    expect(result.container.childElementCount).toBe(0)
    api.emit({ phase: 'available', version: '2.0.0' })
    expect(screen.getByRole('status').textContent).toContain('2.0.0')
  })

  it('hides idle/checking states and disables review during installation', async () => {
    const api = attach()
    const result = await mount()
    expect(result.container.childElementCount).toBe(0)
    api.emit({ phase: 'checking', version: '2.0.0' })
    expect(result.container.childElementCount).toBe(0)
    api.emit({ phase: 'installing', version: '2.0.0' })
    expect(screen.getByRole('status').textContent).toContain('Preparing update')
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
    api.emit({ phase: 'ready', version: '2.0.0' })
    expect(screen.getByRole('status').textContent).toContain('Update ready')
    api.emit({ phase: 'idle' })
    expect(result.container.childElementCount).toBe(0)
  })

  it('opens only explicit review and retains the notice after Later', async () => {
    const pending = Promise.withResolvers<undefined>()
    const api = attach(Promise.resolve({ phase: 'available', version: '2.0.0' }))
    api.review.mockImplementation(() => pending.promise)
    await mount()
    fireEvent.click(screen.getByRole('button', { name: 'Review update' }))
    fireEvent.click(screen.getByRole('button'))
    expect(api.review).toHaveBeenCalledOnce()
    expect(screen.getByRole('button').hasAttribute('disabled')).toBe(true)
    await act(async () => { pending.resolve(undefined); await pending.promise })
    expect(screen.getByRole('status').textContent).toContain('2.0.0')
    expect(screen.getByRole('button', { name: 'Review update' }).hasAttribute('disabled')).toBe(false)
  })

  it('reports review failure without leaking the raw error and allows retry', async () => {
    const api = attach(Promise.resolve({ phase: 'available', version: '2.0.0' }))
    api.review.mockRejectedValueOnce(new Error('private error detail'))
    await mount()
    await act(async () => { fireEvent.click(screen.getByRole('button')); await Promise.resolve() })
    expect(screen.getByRole('alert').textContent).toContain(en['desktopUpdate.reviewFailed'])
    expect(document.body.textContent).not.toContain('private error detail')
    api.emit({ phase: 'error', version: '2.0.0' })
    expect(screen.getByRole('status').textContent).toContain('Update incomplete')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('disposes its subscription and ignores late snapshot/event/review completion', async () => {
    const pending = Promise.withResolvers<State>()
    const api = attach(pending.promise)
    const result = await mount()
    api.emit({ phase: 'available', version: '2.0.0' })
    const review = Promise.withResolvers<undefined>()
    api.review.mockImplementation(() => review.promise)
    fireEvent.click(screen.getByRole('button'))
    result.unmount()
    expect(api.off).toHaveBeenCalledOnce()
    await act(async () => { pending.resolve({ phase: 'available', version: '3.0.0' }); review.reject(new Error('closed')); await Promise.resolve() })
    api.emit({ phase: 'available', version: '4.0.0' })
    expect(result.container.childElementCount).toBe(0)
  })
})
