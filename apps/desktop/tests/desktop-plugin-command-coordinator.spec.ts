import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopPluginCommandCoordinator,
  type DesktopPluginCommandActivation,
  type DesktopPluginCommandCoordinatorOptions,
  type DesktopPluginCommandHost,
} from '../src/desktop-plugin-command-coordinator.ts'
import type { DesktopPluginCommandOperation } from '../src/desktop-plugin-command-protocol.ts'

const owners: DesktopPluginCommandCoordinator[] = []
const releaseGates: (() => void)[] = []
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u
const mutation = { type: 'disable', name: 'owned-plugin' } as const

function gate() {
  const value = Promise.withResolvers<undefined>()
  releaseGates.push(() => { value.resolve(undefined) })
  return value
}

function host() {
  return { pluginCommandResponse: vi.fn<DesktopPluginCommandHost['pluginCommandResponse']>(async () => {}) }
}

function fixture() {
  const order: string[] = []
  const prepared = gate()
  const activated = Promise.withResolvers<DesktopPluginCommandActivation>()
  const discarded = gate()
  const child = host()
  child.pluginCommandResponse.mockImplementation(async (_id, response) => {
    order.push(`reply:${response.kind}`)
    if (response.kind === 'prepared') prepared.resolve(undefined)
  })
  const options = {
    available: vi.fn(() => true), busy: vi.fn(() => false),
    list: vi.fn<DesktopPluginCommandCoordinatorOptions['list']>(async () => [
      { name: 'owned-plugin', version: '1.2.3', enabled: true },
    ]),
    stage: vi.fn<DesktopPluginCommandCoordinatorOptions['stage']>(async (transactionId) => {
      order.push('stage')
      return { transactionId }
    }),
    discard: vi.fn<DesktopPluginCommandCoordinatorOptions['discard']>(async () => {
      order.push('discard')
      discarded.resolve(undefined)
    }),
    activate: vi.fn<DesktopPluginCommandCoordinatorOptions['activate']>(async (authority) => {
      order.push('activate')
      activated.resolve(authority)
    }),
    report: vi.fn<DesktopPluginCommandCoordinatorOptions['report']>(),
  }
  const coordinator = new DesktopPluginCommandCoordinator(options)
  owners.push(coordinator)
  coordinator.bind(child)
  const request = (requestId = 1, commandId = 'command-1', operation: DesktopPluginCommandOperation = mutation,
    source: DesktopPluginCommandHost = child): void => {
    coordinator.handle(source, { type: 'plugin-command-request', requestId, commandId, operation })
  }
  const ack = (requestId = 1, commandId = 'command-1', source: DesktopPluginCommandHost = child): void => {
    coordinator.handle(source, { type: 'plugin-command-settled', requestId, commandId })
  }
  const cancel = (requestId = 1, source: DesktopPluginCommandHost = child): void => {
    coordinator.handle(source, { type: 'plugin-command-cancel', requestId })
  }
  return { coordinator, child, options, request, ack, cancel, order, prepared, activated, discarded }
}

afterEach(async () => {
  for (const release of releaseGates.splice(0)) release()
  await Promise.all(owners.splice(0).map(owner => owner.dispose()))
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('Desktop command coordinator ownership and settlement', () => {
  it('uses the real stage/reply/settlement ordering and passes one frozen activation capability', async () => {
    const b = fixture()
    const staging = gate()
    const activation = gate()
    b.options.stage.mockImplementation(async (transactionId) => {
      b.order.push('stage')
      await staging.promise
      return { transactionId }
    })
    b.options.activate.mockImplementation(async (authority) => {
      b.order.push('activate')
      b.activated.resolve(authority)
      await activation.promise
    })
    b.request()
    expect(b.options.stage).toHaveBeenCalledOnce()
    const [id, operation, origin, signal] = b.options.stage.mock.calls[0]!
    expect(id).toMatch(uuid)
    expect(operation).toEqual(mutation)
    expect(origin.generation).toMatch(uuid)
    expect(origin).toEqual({ kind: 'desktop-command', generation: origin.generation, requestId: 1, commandId: 'command-1' })
    expect(Object.isFrozen(origin)).toBe(true)
    expect(signal.aborted).toBe(false)
    b.ack() // Before a prepared response this cannot stand in for persisted command completion.
    expect(b.child.pluginCommandResponse).not.toHaveBeenCalled()
    staging.resolve(undefined)
    await b.prepared.promise
    expect(b.options.activate).not.toHaveBeenCalled()
    b.ack(1, 'wrong-command')
    b.ack(2)
    b.ack(1, 'command-1', host())
    expect(b.options.activate).not.toHaveBeenCalled()
    b.ack()
    const authority = await b.activated.promise
    expect(b.order).toEqual(['stage', 'reply:prepared', 'activate'])
    expect(authority.origin).toBe(origin)
    expect(authority.signal).toBe(signal)
    expect(authority.transactionId).toBe(id)
    expect(Object.isFrozen(authority)).toBe(true)
    expect(() => { authority.authorize(origin, id) }).not.toThrow()
    expect(() => { authority.authorize({ ...origin }, id) }).not.toThrow()
    for (const changed of [
      { ...origin, generation: 'another-generation' }, { ...origin, requestId: 2 },
      { ...origin, commandId: 'another-command' },
    ]) expect(() => { authority.authorize(changed, id) }).toThrow('does not match')
    expect(() => { authority.authorize(origin, 'another-transaction') }).toThrow('does not match')
    // Deliberate corruption at the persisted-origin boundary, not an admitted typed operation.
    const foreignKind: unknown = { ...origin, kind: 'manual' }
    expect(() => { authority.authorize(foreignKind as typeof origin, id) }).toThrow('does not match')
    b.ack()
    expect(b.options.activate).toHaveBeenCalledOnce()
    activation.resolve(undefined)
    await b.discarded.promise
    expect(b.options.discard).toHaveBeenCalledExactlyOnceWith(id)
  })

  it.each([
    { type: 'install', source: { type: 'npm', spec: 'owned-plugin@1.2.3' } },
    { type: 'install', source: { type: 'github', spec: 'owner/plugin#ref' } },
    { type: 'install', source: { type: 'release', release: { schemaVersion: 1 } } },
    { type: 'remove', name: 'owned-plugin' }, { type: 'update', name: 'owned-plugin', version: '2.0.0' },
    { type: 'enable', name: 'owned-plugin' }, mutation, { type: 'disable-all' },
  ] satisfies Exclude<DesktopPluginCommandOperation, { type: 'list' }>[])('stages one complete %j operation', async (operation) => {
    const b = fixture()
    b.request(1, 'one-operation', operation)
    await b.prepared.promise
    b.ack(1, 'one-operation')
    await b.activated.promise
    await b.discarded.promise
    expect(b.options.stage).toHaveBeenCalledOnce()
    expect(b.options.stage.mock.calls[0]?.[1]).toBe(operation)
    expect(b.options.activate).toHaveBeenCalledOnce()
    expect(b.options.discard).toHaveBeenCalledOnce()
  })

  it('uses monotonic per-generation request IDs and does not let a foreign Host advance them', async () => {
    const b = fixture()
    const foreign = host()
    b.request(99, 'foreign', { type: 'list' }, foreign)
    b.request(3, 'list', { type: 'list' })
    await vi.waitFor(() => { expect(b.child.pluginCommandResponse).toHaveBeenCalledWith(3, { kind: 'list', plugins: [
      { name: 'owned-plugin', version: '1.2.3', enabled: true },
    ] }) })
    b.request(3, 'replay', { type: 'list' })
    b.request(2, 'older', { type: 'list' })
    await vi.waitFor(() => { expect(b.child.pluginCommandResponse).toHaveBeenCalledTimes(3) })
    expect(b.child.pluginCommandResponse.mock.calls.slice(1)).toEqual([
      [3, { kind: 'error', code: 'stale' }], [2, { kind: 'error', code: 'stale' }],
    ])
    expect(b.options.list).toHaveBeenCalledOnce()
    expect(b.options.stage).not.toHaveBeenCalled()
    expect(foreign.pluginCommandResponse).not.toHaveBeenCalled()
  })

  it.each(['unavailable', 'busy'] as const)('sends only the safe %s result before preparation', async (code) => {
    const b = fixture()
    if (code === 'unavailable') b.options.available.mockReturnValue(false)
    else b.options.busy.mockReturnValue(true)
    b.request()
    await vi.waitFor(() => { expect(b.child.pluginCommandResponse).toHaveBeenCalledWith(1, { kind: 'error', code }) })
    expect(b.options.stage).not.toHaveBeenCalled()
    expect(b.options.activate).not.toHaveBeenCalled()
    expect(b.options.discard).not.toHaveBeenCalled()
  })

  it('rejects concurrent list and mutation requests as busy while the first stage owns the coordinator', async () => {
    const b = fixture()
    const staging = gate()
    b.options.stage.mockImplementation(async (transactionId) => { await staging.promise; return { transactionId } })
    b.request()
    b.request(2, 'second', { type: 'list' })
    b.request(3, 'third', { type: 'disable-all' })
    await vi.waitFor(() => { expect(b.child.pluginCommandResponse).toHaveBeenCalledTimes(2) })
    expect(b.child.pluginCommandResponse.mock.calls).toEqual([
      [2, { kind: 'error', code: 'busy' }], [3, { kind: 'error', code: 'busy' }],
    ])
    expect(b.options.stage).toHaveBeenCalledOnce()
    expect(b.options.list).not.toHaveBeenCalled()
    b.cancel()
    staging.resolve(undefined)
    await b.discarded.promise
    expect(b.options.activate).not.toHaveBeenCalled()
  })

  it('ignores late list results from a replaced Host and resets request IDs only with a new generation', async () => {
    const b = fixture()
    const listing = gate()
    b.options.list.mockImplementation(async () => { await listing.promise; return [] })
    b.request(50, 'old-list', { type: 'list' })
    const replacement = host()
    b.coordinator.bind(replacement)
    listing.resolve(undefined)
    await vi.waitFor(() => { expect(b.options.list).toHaveResolved() })
    expect(b.child.pluginCommandResponse).not.toHaveBeenCalled()
    b.request(1, 'new-command', mutation, replacement)
    await vi.waitFor(() => { expect(replacement.pluginCommandResponse).toHaveBeenCalledWith(1, { kind: 'prepared' }) })
    b.cancel(1, replacement)
    await b.discarded.promise
  })

  it('creates distinct UUID generations even when rebinding the same Host object', async () => {
    const b = fixture()
    b.options.stage.mockRejectedValue(new Error('owned failed stage'))
    b.request()
    await vi.waitFor(() => { expect(b.options.discard).toHaveBeenCalledOnce() })
    const first = b.options.stage.mock.calls[0]![2].generation
    b.coordinator.bind(b.child)
    b.request()
    await vi.waitFor(() => { expect(b.options.discard).toHaveBeenCalledTimes(2) })
    const second = b.options.stage.mock.calls[1]![2].generation
    expect(first).toMatch(uuid)
    expect(second).toMatch(uuid)
    expect(second).not.toBe(first)
  })

  it.each(['stage-error', 'foreign-transaction', 'prepared-send'] as const)('fails closed after %s without activation', async (failure) => {
    const b = fixture()
    const primary = new Error(failure)
    if (failure === 'stage-error') b.options.stage.mockRejectedValue(primary)
    if (failure === 'foreign-transaction') b.options.stage.mockResolvedValue({ transactionId: 'another-transaction' })
    if (failure === 'prepared-send') b.child.pluginCommandResponse.mockImplementation(async (_id, result) => {
      if (result.kind === 'prepared') { b.ack(); throw primary }
    })
    b.request()
    await b.discarded.promise
    expect(b.options.activate).not.toHaveBeenCalled()
    expect(b.options.discard).toHaveBeenCalledExactlyOnceWith(b.options.stage.mock.calls[0]![0])
    if (failure !== 'foreign-transaction') expect(b.options.report).toHaveBeenCalledWith(primary)
    if (failure === 'prepared-send') expect(b.child.pluginCommandResponse).toHaveBeenCalledOnce()
    else expect(b.child.pluginCommandResponse).toHaveBeenCalledWith(1, { kind: 'error', code: 'failed' })
  })

  it.each(['cancel', 'close', 'replace', 'dispose'] as const)('awaits staged ownership after %s', async (action) => {
    const b = fixture()
    const staging = gate()
    const cleanup = gate()
    b.options.stage.mockImplementation(async (transactionId) => { await staging.promise; return { transactionId } })
    b.options.discard.mockImplementation(async () => { b.discarded.resolve(undefined); await cleanup.promise })
    b.request()
    const signal = b.options.stage.mock.calls[0]![3]
    let disposal: Promise<void> | undefined
    if (action === 'cancel') b.cancel()
    if (action === 'close') b.coordinator.close(b.child)
    if (action === 'replace') b.coordinator.bind(host())
    if (action === 'dispose') disposal = b.coordinator.dispose()
    expect(signal.aborted).toBe(true)
    expect(b.options.discard).not.toHaveBeenCalled()
    staging.resolve(undefined)
    await b.discarded.promise
    let drained = false
    disposal ??= b.coordinator.dispose()
    const observedDisposal = disposal.then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    cleanup.resolve(undefined)
    await observedDisposal
    expect(b.options.activate).not.toHaveBeenCalled()
    expect(b.child.pluginCommandResponse).not.toHaveBeenCalled()
  })

  it('models failed durable Session settlement as cancellation, discarding without a second reply or activation', async () => {
    const b = fixture()
    b.request()
    await b.prepared.promise
    const origin = b.options.stage.mock.calls[0]![2]
    const signal = b.options.stage.mock.calls[0]![3]
    b.cancel()
    b.ack(origin.requestId, origin.commandId)
    await b.discarded.promise
    expect(signal.aborted).toBe(true)
    expect(b.options.activate).not.toHaveBeenCalled()
    expect(b.child.pluginCommandResponse.mock.calls).toEqual([[1, { kind: 'prepared' }]])
  })

  it('releases settlement timer work exactly at ten seconds and rejects a late acknowledgement', async () => {
    vi.useFakeTimers()
    const b = fixture()
    b.request()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    await vi.advanceTimersByTimeAsync(9_999)
    expect(b.options.activate).not.toHaveBeenCalled()
    expect(b.options.discard).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await b.discarded.promise
    expect(b.options.report).toHaveBeenCalledWith(expect.objectContaining({ message: 'Desktop plugin command settlement timed out' }))
    b.ack()
    await vi.advanceTimersByTimeAsync(0)
    expect(b.options.activate).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each(['acknowledgement', 'cancellation'] as const)('removes the settlement timer after %s', async (outcome) => {
    vi.useFakeTimers()
    const b = fixture()
    b.request()
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.getTimerCount()).toBe(1)
    if (outcome === 'acknowledgement') b.ack()
    else b.cancel()
    await vi.advanceTimersByTimeAsync(0)
    await b.discarded.promise
    expect(vi.getTimerCount()).toBe(0)
    expect(b.options.activate).toHaveBeenCalledTimes(outcome === 'acknowledgement' ? 1 : 0)
  })

  it('invalidates authorization after cancellation while an activation callback remains pending', async () => {
    const b = fixture()
    const activation = gate()
    b.options.activate.mockImplementation(async (authority) => { b.activated.resolve(authority); await activation.promise })
    b.request()
    await b.prepared.promise
    b.ack()
    const authority = await b.activated.promise
    b.cancel()
    expect(authority.signal.aborted).toBe(true)
    expect(() => { authority.authorize(authority.origin, authority.transactionId) }).toThrow()
    expect(() => { authority.interrupt() }).toThrow()
    activation.resolve(undefined)
    await b.discarded.promise
  })

  it('retains admitted activation across intentional Host interruption without routing a later cancel to it', async () => {
    const b = fixture()
    const activation = gate()
    b.options.activate.mockImplementation(async (authority) => { b.activated.resolve(authority); await activation.promise })
    b.request()
    await b.prepared.promise
    b.ack()
    const authority = await b.activated.promise
    authority.authorize(authority.origin, authority.transactionId)
    authority.interrupt()
    b.cancel()
    b.coordinator.close(b.child)
    b.coordinator.bind(host())
    expect(authority.signal.aborted).toBe(false)
    expect(() => { authority.authorize(authority.origin, authority.transactionId) }).toThrow('no longer owns')
    let disposed = false
    const disposal = b.coordinator.dispose().then(() => { disposed = true })
    await Promise.resolve()
    expect(disposed).toBe(false)
    activation.resolve(undefined)
    await disposal
    expect(b.options.discard).not.toHaveBeenCalled()
    expect(b.options.report).not.toHaveBeenCalled()
  })

  it('contains diagnostic callback failures while reporting a safe inventory error', async () => {
    const b = fixture()
    const primary = new Error('private inventory detail')
    b.options.list.mockRejectedValue(primary)
    b.options.report.mockImplementation(() => { throw new Error('report failed') })
    b.request(1, 'list', { type: 'list' })
    await vi.waitFor(() => { expect(b.child.pluginCommandResponse).toHaveBeenCalledWith(1, { kind: 'error', code: 'failed' }) })
    expect(b.options.report).toHaveBeenCalledWith(primary)
    expect(b.child.pluginCommandResponse.mock.calls[0]![1]).not.toHaveProperty('message')
  })

  it.each([new Error('discard failed'), undefined])('retains cleanup failure %s through disposal without losing sender reporting', async (discardFailure) => {
    const b = fixture()
    const sendFailure = new Error('sender failed')
    b.child.pluginCommandResponse.mockRejectedValue(sendFailure)
    b.options.discard.mockRejectedValue(discardFailure)
    b.options.report.mockImplementation(() => { throw new Error('report failed') })
    b.request()
    await vi.waitFor(() => { expect(b.options.discard).toHaveBeenCalledOnce() })
    b.child.pluginCommandResponse.mockResolvedValue(undefined)
    b.request(2, 'blocked-after-cleanup', { type: 'list' })
    await vi.waitFor(() => { expect(b.child.pluginCommandResponse).toHaveBeenCalledWith(2, { kind: 'error', code: 'busy' }) })
    const disposing = b.coordinator.dispose()
    owners.splice(owners.indexOf(b.coordinator), 1)
    await expect(disposing).rejects.toMatchObject({ errors: [discardFailure] })
    expect(b.options.report).toHaveBeenCalledWith(sendFailure)
    expect(b.options.report).toHaveBeenCalledWith(discardFailure)
    expect(b.options.activate).not.toHaveBeenCalled()
  })

  it('contains a failed list reply without changing it into activation or retrying the sender', async () => {
    const b = fixture()
    const failure = new Error('list sender failed')
    b.child.pluginCommandResponse.mockRejectedValue(failure)
    b.options.report.mockImplementation(() => { throw undefined })
    b.request(1, 'list', { type: 'list' })
    await vi.waitFor(() => { expect(b.options.report).toHaveBeenCalledWith(failure) })
    await b.coordinator.dispose()
    expect(b.child.pluginCommandResponse).toHaveBeenCalledOnce()
    expect(b.options.activate).not.toHaveBeenCalled()
    expect(b.options.discard).not.toHaveBeenCalled()
  })

  it('retains activation recovery ownership when failure follows intentional interruption', async () => {
    const b = fixture()
    const activation = gate()
    b.options.activate.mockImplementation(async (authority) => {
      b.activated.resolve(authority)
      await activation.promise
    })
    b.request()
    await b.prepared.promise
    b.ack()
    const authority = await b.activated.promise
    authority.interrupt()
    const failure = new Error('admitted activation failed')
    activation.reject(failure)
    await b.coordinator.dispose()
    expect(authority.signal.aborted).toBe(false)
    expect(b.options.report).toHaveBeenCalledWith(failure)
    expect(b.options.discard).not.toHaveBeenCalled()
  })

  it('does not let closing another Host abort a live request, and refuses work after disposal', async () => {
    const b = fixture()
    b.request()
    await b.prepared.promise
    b.coordinator.close(host())
    expect(b.options.stage.mock.calls[0]![3].aborted).toBe(false)
    await b.coordinator.dispose()
    const calls = b.options.stage.mock.calls.length
    b.request(2, 'late')
    expect(b.options.stage).toHaveBeenCalledTimes(calls)
    expect(() => { b.coordinator.bind(host()) }).toThrow('disposed')
  })
})
