// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import { DesktopUpdateAdapter, desktopUpdateBridge } from '../src/client/desktop-update-adapter.ts'
import type { DesktopUpdateState } from '../src/client/desktop-update-adapter.ts'

function fixture(initial: Promise<DesktopUpdateState> = Promise.resolve({ phase: 'idle' })) {
  let listener: (state: DesktopUpdateState) => void = () => {}
  const off = vi.fn()
  const review = vi.fn(async () => {})
  const bridge = {
    status: vi.fn(() => initial),
    subscribe: vi.fn((next: typeof listener) => { listener = next; return off }),
    review,
  }
  const adapter = new DesktopUpdateAdapter(bridge)
  return { adapter, bridge, off, emit: (state: DesktopUpdateState) => { listener(state) } }
}

describe('Desktop update adapter', () => {
  it.each([
    undefined,
    { protocolVersion: 1 },
    { protocolVersion: 2 },
    { protocolVersion: 2, updates: { reportImpact: () => {} } },
    { protocolVersion: 2, updates: { status: () => Promise.resolve({ phase: 'idle' }), subscribe: () => () => {} } },
  ])('ignores ordinary Web and incomplete preload methods: %j', (desktop) => {
    const browser = { dshDesktop: desktop } as unknown as Window
    expect(desktopUpdateBridge(browser)).toBeUndefined()
    const adapter = new DesktopUpdateAdapter(desktopUpdateBridge(browser))
    const notify = vi.fn()
    adapter.subscribe(notify)
    const dispose = adapter.connect()
    expect(adapter.getSnapshot()).toEqual({ state: null, reviewing: false, reviewFailed: false })
    dispose()
    expect(notify).not.toHaveBeenCalled()
  })

  it('selects the complete bridge without binding component subscriptions', () => {
    const { bridge } = fixture()
    expect(desktopUpdateBridge({ dshDesktop: { protocolVersion: 2, updates: bridge } } as unknown as Window)).toBe(bridge)
    expect(bridge.subscribe).not.toHaveBeenCalled()
    expect(bridge.status).not.toHaveBeenCalled()
  })

  it('subscribes before reading status and keeps source and snapshot identities stable', async () => {
    const f = fixture(Promise.resolve({ phase: 'available', version: '2.0.0' }))
    const source = f.adapter
    const original = source.getSnapshot()
    const notify = vi.fn()
    const off = source.subscribe(notify)
    const dispose = source.connect()
    try {
      expect(f.bridge.subscribe.mock.invocationCallOrder[0]).toBeLessThan(f.bridge.status.mock.invocationCallOrder[0]!)
      expect(source.getSnapshot()).toBe(original)
      await Promise.resolve()
      const available = source.getSnapshot()
      expect(available.state).toEqual({ phase: 'available', version: '2.0.0' })
      expect(f.adapter).toBe(source)
      expect(source.getSnapshot()).toBe(available)
      f.emit({ phase: 'available', version: '2.0.0' })
      expect(source.getSnapshot()).toBe(available)
      expect(notify).toHaveBeenCalledOnce()
      off()
      f.emit({ phase: 'installing', version: '2.0.0' })
      expect(notify).toHaveBeenCalledOnce()
    } finally { dispose() }
    expect(f.off).toHaveBeenCalledOnce()
  })

  it('lets an event win over a delayed initial snapshot, even with no renderer mounted', async () => {
    const initial = Promise.withResolvers<DesktopUpdateState>()
    const f = fixture(initial.promise)
    const dispose = f.adapter.connect()
    try {
      f.emit({ phase: 'available', version: '2.0.0' })
      initial.resolve({ phase: 'idle' })
      await initial.promise
      expect(f.adapter.getSnapshot().state).toEqual({ phase: 'available', version: '2.0.0' })
    } finally { dispose() }
  })

  it('recovers from an initial snapshot rejection through events', async () => {
    const f = fixture(Promise.reject(new Error('private status error')))
    const dispose = f.adapter.connect()
    try {
      await Promise.resolve()
      await Promise.resolve()
      expect(f.adapter.getSnapshot().state).toBeNull()
      f.emit({ phase: 'available', version: '2.0.0' })
      expect(f.adapter.getSnapshot().state?.version).toBe('2.0.0')
    } finally { dispose() }
  })

  it('deduplicates explicit review across subscribers and retains the update after Later', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<undefined>()
    f.bridge.review.mockImplementation(() => pending.promise)
    const dispose = f.adapter.connect()
    try {
      f.emit({ phase: 'available', version: '2.0.0' })
      const first = f.adapter.review()
      const second = f.adapter.review()
      expect(f.bridge.review).toHaveBeenCalledOnce()
      expect(f.adapter.getSnapshot().reviewing).toBe(true)
      pending.resolve(undefined)
      await Promise.all([first, second])
      expect(f.adapter.getSnapshot()).toEqual({ state: { phase: 'available', version: '2.0.0' }, reviewing: false, reviewFailed: false })
      await f.adapter.review()
      expect(f.bridge.review).toHaveBeenCalledTimes(2)
    } finally { dispose() }
  })

  it('projects only a failure flag and clears it on events or retry', async () => {
    const f = fixture()
    const dispose = f.adapter.connect()
    try {
      f.emit({ phase: 'available', version: '2.0.0' })
      f.bridge.review.mockRejectedValueOnce(new Error('private review details'))
      await f.adapter.review()
      expect(f.adapter.getSnapshot()).toEqual({ state: { phase: 'available', version: '2.0.0' }, reviewing: false, reviewFailed: true })
      f.emit({ phase: 'error', version: '2.0.0' })
      expect(f.adapter.getSnapshot().reviewFailed).toBe(false)
      f.bridge.review.mockRejectedValueOnce(new Error('retry'))
      await f.adapter.review()
      const retry = f.adapter.review()
      expect(f.adapter.getSnapshot().reviewFailed).toBe(false)
      await retry
    } finally { dispose() }
  })

  it.each([
    { phase: 'idle', version: '2.0.0' }, { phase: 'checking', version: '2.0.0' },
    { phase: 'installing', version: '2.0.0' }, { phase: 'ready', version: '2.0.0' }, { phase: 'error' },
  ] as const)('does not review a non-actionable state: %j', async (state) => {
    const f = fixture()
    await f.adapter.review()
    const dispose = f.adapter.connect()
    try {
      await f.adapter.review()
      f.emit(state)
      await f.adapter.review()
      expect(f.bridge.review).not.toHaveBeenCalled()
    } finally { dispose() }
  })

  it.each([false, true])('ignores late initial snapshots and review settlement after disposal (reject=%s)', async (reject) => {
    const initial = Promise.withResolvers<DesktopUpdateState>()
    const f = fixture(initial.promise)
    const pending = Promise.withResolvers<undefined>()
    f.bridge.review.mockImplementation(() => pending.promise)
    const dispose = f.adapter.connect()
    f.emit({ phase: 'available', version: '2.0.0' })
    const review = f.adapter.review()
    const notify = vi.fn()
    f.adapter.subscribe(notify)
    const before = f.adapter.getSnapshot()
    dispose()
    initial.resolve({ phase: 'available', version: '3.0.0' })
    if (reject) pending.reject(new Error('closed'))
    else pending.resolve(undefined)
    await Promise.all([initial.promise, review])
    f.emit({ phase: 'available', version: '4.0.0' })
    await f.adapter.review()
    expect(f.adapter.getSnapshot()).toBe(before)
    expect(notify).not.toHaveBeenCalled()
    expect(f.off).toHaveBeenCalledOnce()
    expect(f.bridge.review).toHaveBeenCalledOnce()
  })

  it('ignores a status reply after disposal without any update event', async () => {
    const initial = Promise.withResolvers<DesktopUpdateState>()
    const f = fixture(initial.promise)
    const dispose = f.adapter.connect()
    const before = f.adapter.getSnapshot()
    dispose()
    initial.resolve({ phase: 'available', version: '2.0.0' })
    await initial.promise
    expect(f.adapter.getSnapshot()).toBe(before)
  })
})
