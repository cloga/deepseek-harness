/** Direct-child observation controls use owned emitters, never a diagnostic subprocess. */
import { EventEmitter } from 'node:events'
import { dirname } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  runDesktopPackagePnpm,
  type DesktopPnpmChildObservation,
  type DesktopPnpmChildObserver,
} from '../src/profile-package-pnpm.ts'

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }))
vi.mock('node:child_process', () => ({ spawn }))

const runtime = { node: process.execPath, nodeBin: dirname(process.execPath), pnpm: 'PRIVATE_PNPM_PATH' }
const pending: Promise<unknown>[] = []
const children: { child: EventEmitter; closed: boolean }[] = []

function start(observe?: DesktopPnpmChildObserver, controller = new AbortController()) {
  const child = Object.assign(new EventEmitter(), {
    pid: 2468,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(() => true),
  })
  const owned = { child, closed: false }
  children.push(owned)
  child.once('close', () => { owned.closed = true })
  spawn.mockReturnValueOnce(child)
  const run = runDesktopPackagePnpm(runtime, {
    cwd: 'PRIVATE_CWD', args: ['PRIVATE_ARGUMENT'], env: { PRIVATE_ENV: 'PRIVATE_VALUE' }, signal: controller.signal,
  }, observe)
  const settled = run.then(value => ({ kind: 'success' as const, value }), (error: unknown) => ({ kind: 'failure' as const, error }))
  pending.push(settled)
  return { child, controller, run, settled }
}

function collector() {
  const events: DesktopPnpmChildObservation[] = []
  const observe: DesktopPnpmChildObserver = (event) => { events.push(event); return undefined }
  return { events, observe }
}

afterEach(async () => {
  for (const owned of children.splice(0)) if (!owned.closed) owned.child.emit('close', 1, null)
  await Promise.all(pending.splice(0))
  spawn.mockReset()
  vi.restoreAllMocks()
})

describe('optional pnpm direct-child observations', () => {
  it.each(['exit-first', 'stdio-first'] as const)('settles only at close with %s observations', async (order) => {
    const captured = collector()
    const f = start(captured.observe)
    f.child.emit('spawn')
    if (order === 'exit-first') f.child.emit('exit', 0, null)
    f.child.stdout.emit('close')
    f.child.stderr.emit('close')
    if (order === 'stdio-first') f.child.emit('exit', 0, null)
    let settled = false
    void f.settled.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    f.child.emit('close', 0, null)
    await expect(f.run).resolves.toEqual({ exitCode: 0 })
    expect(captured.events.map(event => event.event)).toEqual(order === 'exit-first'
      ? ['spawn', 'exit', 'stdout-close', 'stderr-close', 'close']
      : ['spawn', 'stdout-close', 'stderr-close', 'exit', 'close'])
    expect(captured.events.map(event => event.ordinal)).toEqual([1, 2, 3, 4, 5])
    for (const [index, event] of captured.events.entries()) {
      expect(event.childPid).toBe(2468)
      expect(event.parentPid).toBe(process.pid)
      expect(Number.isFinite(event.observedElapsedMs)).toBe(true)
      expect(event.observedElapsedMs).toBeGreaterThanOrEqual(captured.events[index - 1]?.observedElapsedMs ?? 0)
      expect(Object.keys(event).every(key => ['event', 'ordinal', 'childPid', 'parentPid', 'observedElapsedMs', 'exitCode', 'signal', 'errorCode'].includes(key))).toBe(true)
    }
    expect(captured.events.at(-1)).toMatchObject({ event: 'close', exitCode: 0, signal: null })
    for (const text of ['PRIVATE_PNPM_PATH', 'PRIVATE_CWD', 'PRIVATE_ARGUMENT', 'PRIVATE_ENV', 'PRIVATE_VALUE']) {
      expect(JSON.stringify(captured.events)).not.toContain(text)
    }
  })

  it('does not register optional listeners or project unknown error fields without an observer', async () => {
    const code = vi.fn(() => 'EPERM')
    const failure = Object.defineProperty(new Error('PRIVATE_ERROR'), 'code', { get: code })
    const f = start()
    expect(f.child.listenerCount('spawn')).toBe(0)
    expect(f.child.listenerCount('exit')).toBe(0)
    expect(f.child.stdout.listenerCount('close')).toBe(0)
    expect(f.child.stderr.listenerCount('close')).toBe(0)
    expect(f.child.listenerCount('error')).toBe(1)
    f.child.emit('error', failure)
    f.child.emit('close', 1, null)
    await expect(f.run).rejects.toBe(failure)
    expect(code).not.toHaveBeenCalled()
  })

  it.each(['known', 'unknown', 'throws'] as const)('reads an emitted error code once and preserves identity: %s', async (kind) => {
    const code = vi.fn(() => {
      if (kind === 'throws') throw new Error('PRIVATE_GETTER_FAILURE')
      return kind === 'known' ? 'EPERM' : 'PRIVATE_UNKNOWN_CODE'
    })
    const failure = Object.defineProperty(new Error('PRIVATE_ERROR_MESSAGE'), 'code', { get: code })
    const captured = collector()
    const f = start(captured.observe)
    f.child.emit('error', failure)
    f.child.emit('close', 1, null)
    await expect(f.run).rejects.toBe(failure)
    expect(code).toHaveBeenCalledOnce()
    expect(captured.events[0]).toMatchObject({ event: 'error', errorCode: kind === 'known' ? 'EPERM' : 'OTHER' })
    expect(JSON.stringify(captured.events)).not.toContain('PRIVATE_')
    expect(() => f.child.emit('error', new Error('later error'))).toThrow('later error')
  })

  it('uses event signal values, not another child signalCode read, and closes observation ownership', async () => {
    const signalCode = vi.fn(() => 'PRIVATE_SIGNAL_PROPERTY')
    const captured = collector()
    const f = start(captured.observe)
    Object.defineProperty(f.child, 'signalCode', { get: signalCode })
    f.child.emit('exit', null, 'FUTURE_PLATFORM_SIGNAL')
    f.child.emit('close', 0, 'SIGTERM')
    await f.run
    expect(captured.events[0]).toMatchObject({ event: 'exit', exitCode: null, signal: 'OTHER' })
    expect(captured.events[1]).toMatchObject({ event: 'close', signal: 'SIGTERM' })
    expect(signalCode).not.toHaveBeenCalled()
    const count = captured.events.length
    f.child.emit('spawn'); f.child.emit('exit', 0, null)
    f.child.stdout.emit('close'); f.child.stderr.emit('close'); f.child.emit('close', 0, null)
    f.controller.abort(new Error('late cancellation'))
    expect(captured.events).toHaveLength(count)
    expect(f.child.kill).not.toHaveBeenCalled()
    expect(f.child.listenerCount('spawn')).toBe(0)
    expect(f.child.listenerCount('exit')).toBe(0)
    expect(f.child.stdout.listenerCount('close')).toBe(0)
    expect(f.child.stderr.listenerCount('close')).toBe(0)
  })

  it.each([
    { label: 'Error', fault: new Error('observer failure') },
    { label: 'string', fault: 'observer failure' },
    { label: 'undefined', fault: undefined },
  ])('contains a synchronous observer fault without replacing the result: $label', async ({ fault }) => {
    const observe: DesktopPnpmChildObserver = () => { throw fault }
    const success = start(observe)
    success.child.emit('spawn'); success.child.emit('close', 0, null)
    await expect(success.run).resolves.toEqual({ exitCode: 0 })
    const primary = new Error('primary child failure')
    const failed = start(observe)
    failed.child.emit('error', primary); failed.child.emit('close', 1, null)
    await expect(failed.run).rejects.toBe(primary)
  })

  it.each([
    { label: 'Error', primary: new Error('spawn failure') },
    { label: 'string', primary: 'spawn failure' },
    { label: 'undefined', primary: undefined },
  ])('retains a synchronous spawn rejection with no invented child observations: $label', async ({ primary }) => {
    spawn.mockImplementationOnce(() => { throw primary })
    const captured = collector()
    await expect(runDesktopPackagePnpm(runtime, {
      cwd: 'PRIVATE_CWD', args: [], env: {}, signal: new AbortController().signal,
    }, captured.observe)).rejects.toBe(primary)
    expect(captured.events).toEqual([])
  })

  it.each([
    { label: 'user-error', reason: new Error('pre-aborted') },
    { label: 'native-timeout', reason: new DOMException('pre-deadline', 'TimeoutError') },
    { label: 'string', reason: 'pre-aborted' },
  ])('rejects an already-aborted request before observing or spawning: $label', async ({ reason }) => {
    const controller = new AbortController()
    controller.abort(reason)
    const captured = collector()
    await expect(runDesktopPackagePnpm(runtime, {
      cwd: 'PRIVATE_CWD', args: [], env: {}, signal: controller.signal,
    }, captured.observe)).rejects.toBe(reason)
    expect(spawn).not.toHaveBeenCalled()
    expect(captured.events).toEqual([])
  })

  it.each(['user', 'deadline', 'user-named-timeout'] as const)('keeps %s cancellation priority through direct-child close', async (mode) => {
    const captured = collector()
    const f = start((event) => { captured.observe(event); throw new Error('observer fault') })
    const reason = mode === 'deadline' ? new DOMException('deadline', 'TimeoutError')
      : Object.assign(new Error('user cancelled'), mode === 'user-named-timeout' ? { name: 'TimeoutError' } : {})
    f.child.emit('error', new Error('child failure before abort'))
    f.controller.abort(reason)
    expect(f.child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    f.child.emit('exit', 0, null)
    let settled = false
    void f.settled.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    f.child.emit('close', 0, null)
    const outcome = await f.settled
    expect(outcome.kind).toBe('failure')
    if (outcome.kind !== 'failure') throw new Error('expected cancellation')
    if (mode === 'deadline') {
      expect(outcome.error).not.toBe(reason)
      expect(outcome.error).toBeInstanceOf(Error)
      expect((outcome.error as Error).cause).toBe(reason)
    } else expect(outcome.error).toBe(reason)
    expect(captured.events.filter(event => event.event === 'abort-request')).toHaveLength(1)
  })

  it('keeps the native deadline reason as the close-time wrapper cause without an observer timer', async () => {
    const captured = collector()
    const signal = AbortSignal.timeout(1)
    const aborted = new Promise<void>((resolve) => {
      signal.addEventListener('abort', () => { resolve() }, { once: true })
    })
    const child = Object.assign(new EventEmitter(), {
      pid: 2468, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => true),
    })
    const owned = { child, closed: false }
    children.push(owned)
    child.once('close', () => { owned.closed = true })
    spawn.mockReturnValueOnce(child)
    const run = runDesktopPackagePnpm(runtime, { cwd: 'PRIVATE_CWD', args: [], env: {}, signal }, captured.observe)
    const settled = run.then(() => ({ kind: 'success' as const }), (error: unknown) => ({ kind: 'failure' as const, error }))
    pending.push(settled)
    await aborted
    expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGTERM')
    child.emit('close', 0, null)
    const outcome = await settled
    if (outcome.kind !== 'failure' || !(outcome.error instanceof Error)) throw new Error('expected deadline failure')
    expect(signal.reason).toBeInstanceOf(DOMException)
    expect(outcome.error.cause).toBe(signal.reason)
    expect(captured.events.map(event => event.event)).toEqual(['abort-request', 'close'])
  })

  it('leaves existing combined stdout/stderr failure bounds and redaction unchanged', async () => {
    const captured = collector()
    const f = start(captured.observe)
    f.child.stdout.emit('data', Buffer.from('x'.repeat(10000) + '\nERR_FIXTURE token=fixture-secret\n'))
    f.child.stderr.emit('data', Buffer.from('final stderr\n'))
    f.child.emit('close', 7, null)
    const outcome = await f.settled
    if (outcome.kind !== 'failure' || !(outcome.error instanceof Error)) throw new Error('expected nonzero child failure')
    expect(outcome.error.message).toContain('pnpm failed (7)')
    expect(outcome.error.message).toContain('ERR_FIXTURE')
    expect(outcome.error.message).toContain('final stderr')
    expect(outcome.error.message).not.toContain('fixture-secret')
    expect(Buffer.byteLength(outcome.error.message)).toBeLessThan(8400)
    expect(JSON.stringify(captured.events)).not.toContain('ERR_FIXTURE')
    expect(captured.events).toHaveLength(1)
  })
})
