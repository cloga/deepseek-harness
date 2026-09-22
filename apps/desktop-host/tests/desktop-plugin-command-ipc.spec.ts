import { describe, expect, it, vi } from 'vitest'
import { DesktopPluginCommandIpc, parseDesktopPluginCommandResponse, type DesktopPluginCommandMessage } from '../src/desktop-plugin-command-ipc.ts'

function fixture() {
  let connected = true
  const send = vi.fn<(message: DesktopPluginCommandMessage) => Promise<void>>(async () => {})
  const bridge = new DesktopPluginCommandIpc({ connected: () => connected, send })
  return { bridge, send, disconnect() { connected = false; bridge.dispose(new Error('owned disconnect')) } }
}
const response = (requestId: number, result: unknown) => ({ type: 'plugin-command-response', requestId, result })
const controller = () => new AbortController()

it.each([
  { kind: 'prepared' },
  { kind: 'list', plugins: [] },
  { kind: 'list', plugins: [{ name: '@scope/plugin', version: '1.2.3', enabled: false }] },
  ...['busy', 'failed', 'invalid', 'stale', 'unavailable'].map(code => ({ kind: 'error', code })),
])('accepts only the exact parent result %j', (result) => {
  expect(parseDesktopPluginCommandResponse(response(1, result))).toEqual(response(1, result))
})

it.each([
  null, [], {}, { type: 'shutdown' },
  { ...response(1, { kind: 'prepared' }), extra: true },
  ...[0, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1, '1'].map(id => response(id as number, { kind: 'prepared' })),
  response(1, null), response(1, []), response(1, { kind: 'prepared', extra: true }),
  response(1, { kind: 'error', code: 'private diagnostic' }), response(1, { kind: 'error', code: 'failed', detail: 'secret' }),
  response(1, { kind: 'list', plugins: {} }), response(1, { kind: 'list', plugins: new Array(1) }),
  response(1, { kind: 'list', plugins: [{ name: 'addon', version: '1', enabled: 'true' }] }),
  response(1, { kind: 'list', plugins: [{ name: '', version: '1', enabled: true }] }),
  response(1, { kind: 'list', plugins: [{ name: 'addon\nsecret', version: '1', enabled: true }] }),
  response(1, { kind: 'list', plugins: [{ name: 'a'.repeat(257), version: '1', enabled: true }] }),
  response(1, { kind: 'list', plugins: [{ name: 'addon', version: '', enabled: true }] }),
  response(1, { kind: 'list', plugins: [{ name: 'addon', version: 'v'.repeat(257), enabled: true }] }),
  response(1, { kind: 'list', plugins: [{ name: 'addon', version: '1', enabled: true, extra: true }] }),
  response(1, { kind: 'list', plugins: [{ name: 'addon', version: '1', enabled: true }, { name: 'addon', version: '2', enabled: false }] }),
  response(1, { kind: 'list', plugins: Array.from({ length: 4097 }, (_, i) => ({ name: `addon${String(i)}`, version: '1', enabled: true })) }),
])('rejects malformed parent result %# without echoing its input', (value) => {
  expect(() => parseDesktopPluginCommandResponse(value)).toThrow('desktop plugin command: invalid parent response')
})

describe('owned Host command IPC', () => {
  it('settles list and safe failure once, releasing their abort listeners', async () => {
    const { bridge, send } = fixture()
    const first = controller()
    const removed = vi.spyOn(first.signal, 'removeEventListener')
    const result = bridge.request({ type: 'list' }, 'command-list', first.signal)
    expect(send).toHaveBeenCalledWith({ type: 'plugin-command-request', requestId: 1, commandId: 'command-list', operation: { type: 'list' } })
    bridge.receive(response(1, { kind: 'list', plugins: [{ name: 'addon', version: '1', enabled: true }] }))
    await expect(result).resolves.toEqual({ type: 'list', rows: [{ name: 'addon', version: '1', enabled: true }] })
    expect(removed).toHaveBeenCalledOnce()
    first.abort()
    expect(send.mock.calls.filter(([message]) => message.type === 'plugin-command-cancel')).toHaveLength(0)
    const second = bridge.request({ type: 'disable-all' }, 'command-second', controller().signal)
    bridge.receive(response(2, { kind: 'error', code: 'busy' }))
    await expect(second).resolves.toEqual({ type: 'error', code: 'busy' })
    bridge.receive(response(2, { kind: 'prepared' }))
    bridge.settled('command-second', true)
    expect(send.mock.calls.filter(([message]) => message.type === 'plugin-command-settled')).toHaveLength(0)
    bridge.dispose()
  })

  it.each([true, false])('retains prepared ownership until actual persisted=%s settlement', async (persisted) => {
    const { bridge, send } = fixture()
    const abort = controller()
    const removed = vi.spyOn(abort.signal, 'removeEventListener')
    const result = bridge.request({ type: 'disable', name: 'addon' }, 'command-one', abort.signal)
    bridge.receive(response(1, { kind: 'prepared' }))
    await expect(result).resolves.toEqual({ type: 'prepared' })
    expect(removed).not.toHaveBeenCalled()
    expect(send).toHaveBeenCalledTimes(1)
    bridge.settled('another-command', true)
    expect(send).toHaveBeenCalledTimes(1)
    bridge.settled('command-one', persisted)
    expect(send).toHaveBeenLastCalledWith(persisted
      ? { type: 'plugin-command-settled', requestId: 1, commandId: 'command-one' }
      : { type: 'plugin-command-cancel', requestId: 1 })
    expect(removed).toHaveBeenCalledOnce()
    bridge.settled('command-one', persisted)
    abort.abort()
    expect(send).toHaveBeenCalledTimes(2)
    bridge.dispose()
  })

  it.each(['before', 'pending', 'prepared'] as const)('cancels at %s response without late settlement', async (phase) => {
    const { bridge, send } = fixture()
    const abort = controller()
    const reason = new Error('owned cancellation')
    if (phase === 'before') abort.abort(reason)
    const result = bridge.request({ type: 'disable', name: 'addon' }, 'command-one', abort.signal)
    if (phase === 'prepared') {
      bridge.receive(response(1, { kind: 'prepared' }))
      await expect(result).resolves.toEqual({ type: 'prepared' })
    }
    abort.abort(reason)
    if (phase !== 'prepared') await expect(result).rejects.toBe(reason)
    bridge.receive(response(1, { kind: 'prepared' }))
    bridge.settled('command-one', true)
    expect(send.mock.calls.filter(([message]) => message.type === 'plugin-command-settled')).toHaveLength(0)
    expect(send.mock.calls.filter(([message]) => message.type === 'plugin-command-cancel')).toHaveLength(phase === 'before' ? 0 : 1)
    bridge.dispose()
  })

  it.each(['sync', 'async'] as const)('preserves %s send failure and removes its abort listener', async (mode) => {
    const { bridge, send } = fixture()
    const failure = new Error('owned send failure')
    if (mode === 'sync') send.mockImplementationOnce(() => { throw failure })
    else send.mockRejectedValueOnce(failure)
    const abort = controller()
    const removed = vi.spyOn(abort.signal, 'removeEventListener')
    await expect(bridge.request({ type: 'list' }, 'command-one', abort.signal)).rejects.toBe(failure)
    expect(removed).toHaveBeenCalledOnce()
    bridge.receive(response(1, { kind: 'prepared' }))
    bridge.settled('command-one', true)
    expect(send.mock.calls.filter(([message]) => message.type === 'plugin-command-settled')).toHaveLength(0)
    bridge.dispose()
  })

  it('cannot accept an early prepared response before the original send succeeds', async () => {
    const { bridge, send } = fixture()
    const sent = Promise.withResolvers<undefined>()
    send.mockImplementationOnce(() => sent.promise)
    let resolved = false
    const result = bridge.request({ type: 'disable-all' }, 'command-one', controller().signal)
    const observed = result.then(() => { resolved = true }, () => {})
    bridge.receive(response(1, { kind: 'prepared' }))
    await Promise.resolve()
    expect(resolved).toBe(false)
    bridge.settled('command-one', true)
    expect(send).toHaveBeenCalledTimes(1)
    const failure = new Error('late send failure')
    sent.reject(failure)
    await expect(result).rejects.toBe(failure)
    await observed
    expect(resolved).toBe(false)
    expect(send).toHaveBeenLastCalledWith({ type: 'plugin-command-cancel', requestId: 1 })
    bridge.dispose()
  })

  it.each(['pending', 'prepared'] as const)('disposal clears %s work and refuses any new request', async (phase) => {
    const { bridge, send } = fixture()
    const abort = controller()
    const removed = vi.spyOn(abort.signal, 'removeEventListener')
    const result = bridge.request({ type: 'disable-all' }, 'command-one', abort.signal)
    if (phase === 'prepared') { bridge.receive(response(1, { kind: 'prepared' })); await result }
    const failure = new Error('owned stop')
    bridge.dispose(failure)
    if (phase === 'pending') await expect(result).rejects.toBe(failure)
    expect(removed).toHaveBeenCalledOnce()
    expect(bridge.closed).toBe(true)
    await expect(bridge.request({ type: 'list' }, 'next', controller().signal)).rejects.toThrow('parent unavailable')
    bridge.dispose()
    bridge.receive(response(1, { kind: 'prepared' }))
    bridge.settled('command-one', true)
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('keeps request IDs monotonic across service replacement and ignores old valid replies', async () => {
    const { bridge, send } = fixture()
    const pending = bridge.request({ type: 'list' }, 'first', controller().signal)
    bridge.cancelPending()
    await expect(pending).rejects.toThrow('runtime disposed')
    expect(bridge.closed).toBe(false)
    const next = bridge.request({ type: 'list' }, 'second', controller().signal)
    bridge.receive(response(1, { kind: 'list', plugins: [] }))
    bridge.receive(response(2, { kind: 'list', plugins: [] }))
    await expect(next).resolves.toEqual({ type: 'list', rows: [] })
    expect(send.mock.calls.filter(([message]) => message.type === 'plugin-command-request').map(([message]) => message.requestId)).toEqual([1, 2])
    bridge.dispose()
  })

  it('discriminates other control families and fails closed on malformed owned responses', async () => {
    const { bridge } = fixture()
    expect(bridge.receive({ type: 'shutdown' })).toBe(false)
    expect(bridge.receive({ type: 'update-tasks', requestId: 1 })).toBe(false)
    expect(bridge.receive(null)).toBe(false)
    const pending = bridge.request({ type: 'list' }, 'first', controller().signal)
    expect(bridge.receive(response(1, { kind: 'error', code: 'private token content' }))).toBe(true)
    await expect(pending).rejects.toThrow('invalid parent response')
    expect(bridge.closed).toBe(true)
  })

  it('disconnect releases pending work without attempting sends on the closed parent', async () => {
    const f = fixture()
    const pending = f.bridge.request({ type: 'list' }, 'first', controller().signal)
    f.disconnect()
    await expect(pending).rejects.toThrow('owned disconnect')
    expect(f.send).toHaveBeenCalledTimes(1)
  })

  it('bounds concurrent requests and cleans every rejected request on stop', async () => {
    const { bridge, send } = fixture()
    const pending = Array.from({ length: 100 }, (_, index) =>
      bridge.request({ type: 'list' }, `command-${String(index)}`, controller().signal))
    const completed = Promise.allSettled(pending)
    await expect(bridge.request({ type: 'list' }, 'over-limit', controller().signal)).rejects.toThrow('invalid or duplicate')
    expect(send).toHaveBeenCalledTimes(100)
    bridge.dispose()
    expect((await completed).every(result => result.status === 'rejected')).toBe(true)
    expect(send.mock.calls.filter(([message]) => message.type === 'plugin-command-cancel')).toHaveLength(100)
  })

  it('rejects invalid or duplicate lifecycle IDs before a second request is sent', async () => {
    const { bridge, send } = fixture()
    for (const id of ['', 'x'.repeat(257), 'bad\ncommand']) {
      await expect(bridge.request({ type: 'list' }, id, controller().signal)).rejects.toThrow('invalid or duplicate')
    }
    const pending = bridge.request({ type: 'list' }, 'first', controller().signal)
    await expect(bridge.request({ type: 'list' }, 'first', controller().signal)).rejects.toThrow('invalid or duplicate')
    expect(send).toHaveBeenCalledTimes(1)
    bridge.dispose()
    await expect(pending).rejects.toThrow('Host stopped')
  })

  it.each(['sync', 'async'] as const)('failed %s settlement notification sends only best-effort cancellation', async (mode) => {
    const { bridge, send } = fixture()
    const pending = bridge.request({ type: 'disable-all' }, 'first', controller().signal)
    bridge.receive(response(1, { kind: 'prepared' }))
    await pending
    if (mode === 'sync') send.mockImplementationOnce(() => { throw new Error('lost parent') })
    else send.mockRejectedValueOnce(new Error('lost parent'))
    bridge.settled('first', true)
    await Promise.resolve()
    expect(send).toHaveBeenLastCalledWith({ type: 'plugin-command-cancel', requestId: 1 })
    bridge.settled('first', true)
    expect(send).toHaveBeenCalledTimes(3)
    bridge.dispose()
  })
})
