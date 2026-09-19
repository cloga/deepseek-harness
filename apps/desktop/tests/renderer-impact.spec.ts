import { EventEmitter } from 'node:events'
import type { IpcMain, WebContents } from 'electron'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DESKTOP_IPC } from '../src/ipc.ts'
import { requestDesktopRendererImpact } from '../src/renderer-impact.ts'

const reported = { hasDraft: true, attachmentCount: 2, submitting: false }
function fixture() {
  const ipc = new EventEmitter()
  const frame = { url: 'dsh-app://app/index.html' }
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: frame, isDestroyed: () => false, getURL: () => frame.url,
    send: vi.fn<(channel: string, id: string) => void>(),
  })
  const request = (signal?: AbortSignal) => requestDesktopRendererImpact(contents as unknown as WebContents, ipc as unknown as Pick<IpcMain, 'on' | 'removeListener'>, signal)
  const reply = (
    value: unknown = reported, id: unknown = contents.send.mock.calls.at(-1)?.[1],
    sender: unknown = contents, senderFrame: unknown = frame,
  ) => {
    ipc.emit(DESKTOP_IPC.pluginImpactResponse, { sender, senderFrame }, id, value)
  }
  return { ipc, contents, frame, request, reply }
}
afterEach(() => vi.useRealTimers())

describe('fresh renderer impact request', () => {
  it('accepts only the exact current main frame and request id, then removes listeners', async () => {
    const f = fixture(), pending = f.request()
    let settled = false
    void pending.then(() => { settled = true })
    f.reply(reported, 'stale-id')
    f.reply(reported, undefined, {})
    f.reply(reported, undefined, f.contents, { url: f.frame.url })
    await Promise.resolve()
    expect(settled).toBe(false)
    f.reply()
    await expect(pending).resolves.toEqual(reported)
    expect(f.ipc.listenerCount(DESKTOP_IPC.pluginImpactResponse)).toBe(0)
    for (const event of ['destroyed', 'render-process-gone', 'did-start-loading']) expect(f.contents.listenerCount(event)).toBe(0)
    const next = f.request()
    expect(f.contents.send.mock.calls[0]?.[1]).not.toBe(f.contents.send.mock.calls[1]?.[1])
    f.reply()
    await next
  })

  it.each([null, {}, { ...reported, attachmentCount: -1 }])('rejects unavailable or malformed report %s instead of assuming empty work', async (value) => {
    const f = fixture(), pending = f.request()
    const failure = expect(pending).rejects.toThrow('unavailable')
    f.reply(value)
    await failure
    expect(f.ipc.listenerCount(DESKTOP_IPC.pluginImpactResponse)).toBe(0)
  })

  it.each(['destroyed', 'render-process-gone', 'did-start-loading'])('rejects when the document becomes unavailable through %s', async (event) => {
    const f = fixture(), pending = f.request()
    const failure = expect(pending).rejects.toThrow('unavailable')
    f.contents.emit(event)
    await failure
    expect(f.ipc.listenerCount(DESKTOP_IPC.pluginImpactResponse)).toBe(0)
  })

  it('bounds a nonresponsive renderer and clears the request', async () => {
    vi.useFakeTimers()
    const f = fixture(), pending = f.request()
    const failure = expect(pending).rejects.toThrow('unavailable')
    await vi.advanceTimersByTimeAsync(5000)
    await failure
    expect(f.ipc.listenerCount(DESKTOP_IPC.pluginImpactResponse)).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([false, true])('cleans up on caller cancellation: alreadyAborted=%s', async (alreadyAborted) => {
    vi.useFakeTimers()
    const controller = new AbortController(), f = fixture()
    if (alreadyAborted) controller.abort()
    const failure = expect(f.request(controller.signal)).rejects.toThrow('unavailable')
    controller.abort()
    await failure
    expect(f.ipc.listenerCount(DESKTOP_IPC.pluginImpactResponse)).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    if (alreadyAborted) expect(f.contents.send).not.toHaveBeenCalled()
  })

  it('rejects an untrusted active URL without sending an internal request', async () => {
    const f = fixture()
    f.frame.url = 'https://example.invalid/'
    await expect(f.request()).rejects.toThrow('unavailable')
    expect(f.contents.send).not.toHaveBeenCalled()
  })
})
