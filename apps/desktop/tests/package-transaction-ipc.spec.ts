import { expect, it, vi } from 'vitest'
import type { ProfilePackageTransactions, ProfilePreparedPackageChange, ProfilePreparedBundleSelection } from '@deepseek-ai/dsh-app-boot'
import { DesktopPackageTransactionIpc } from '../src/package-transaction-ipc.ts'

const transactionId = '11111111-1111-4111-8111-111111111111'
const rpcId = '22222222-2222-4222-8222-222222222222'
const prepared: ProfilePreparedPackageChange = { transactionId, state: 'prepared', packageName: 'plugin', baseFingerprint: 'a'.repeat(64), health: 'pending' }
const request = (operation: string, fields: object = {}) => ({ type: 'package-transaction', protocolVersion: 1, rpcId, operation, ...fields })
function fixture() {
  const backend = {
    protocolVersion: 1 as const,
    stage: vi.fn<ProfilePackageTransactions['stage']>().mockResolvedValue(prepared),
    status: vi.fn<ProfilePackageTransactions['status']>().mockResolvedValue(prepared),
    listPending: vi.fn<ProfilePackageTransactions['listPending']>().mockResolvedValue([prepared]),
    cancel: vi.fn<ProfilePackageTransactions['cancel']>().mockResolvedValue(undefined),
  }
  return { backend, ipc: new DesktopPackageTransactionIpc(backend) }
}

it('handshakes without touching the profile or reacquiring the activation lease', async () => {
  const { backend, ipc } = fixture()
  expect(await ipc.handle(request('hello'))).toMatchObject({ ok: true, value: 1 })
  expect(backend.listPending).not.toHaveBeenCalled()
  expect(backend.status).not.toHaveBeenCalled()
  expect(backend.stage).not.toHaveBeenCalled()
})

it('rejects unversioned, path-directed, and unknown requests before backend invocation', async () => {
  const { backend, ipc } = fixture()
  for (const value of [
    { ...request('hello'), protocolVersion: 2 },
    request('list', { profile: 'foreign-profile' }),
    request('execute', { command: 'arbitrary' }),
    request('status', { transactionId: '../other' }),
    request('stage', { requestId: transactionId, mutation: { kind: 'install', source: { schemaVersion: 1, type: 'packageSpec', spec: 'plugin' }, executable: 'arbitrary' } }),
  ]) expect(await ipc.handle(value)).toMatchObject({ ok: false })
  expect(backend.stage).not.toHaveBeenCalled()
  expect(backend.status).not.toHaveBeenCalled()
  expect(backend.listPending).not.toHaveBeenCalled()
})

it('forwards only a validated staged mutation and keeps its request identity', async () => {
  const { backend, ipc } = fixture()
  const mutation = { kind: 'install', source: { schemaVersion: 1, type: 'packageSpec', spec: 'plugin' }, enabled: false } as const
  expect(await ipc.handle(request('stage', { requestId: transactionId, mutation }))).toMatchObject({ ok: true, value: prepared })
  expect(backend.stage).toHaveBeenCalledExactlyOnceWith(transactionId, mutation, expect.any(AbortSignal))
})

it('exposes versioned selection pending state without widening the public stage request or result', async () => {
  const { backend, ipc } = fixture()
  const selection: ProfilePreparedBundleSelection = {
    schemaVersion: 2, kind: 'selection', transactionId, state: 'prepared', packageNames: ['first', 'second'],
    baseFingerprint: 'b'.repeat(64), health: 'pending',
  }
  backend.status.mockResolvedValue(selection)
  backend.listPending.mockResolvedValue([prepared, selection])
  expect(await ipc.handle(request('status', { transactionId }))).toMatchObject({ ok: true, value: selection })
  expect(await ipc.handle(request('list'))).toMatchObject({ ok: true, value: [prepared, selection] })
  expect(await ipc.handle(request('stage', { requestId: transactionId, mutation: { kind: 'selection', packageNames: ['first'], enabled: false } })))
    .toMatchObject({ ok: false })
  expect(backend.stage).not.toHaveBeenCalled()
  // A faulty JavaScript backend cannot smuggle a selection result through the unchanged install/remove method.
  backend.stage.mockResolvedValue(selection as unknown as ProfilePreparedPackageChange)
  expect(await ipc.handle(request('stage', { requestId: transactionId, mutation: { kind: 'remove', name: 'first' } })))
    .toMatchObject({ ok: false })
})

it('rejects malformed or foreign selection pending records rather than relabeling a package', async () => {
  const { backend, ipc } = fixture()
  const selection = { schemaVersion: 2, kind: 'selection', transactionId, state: 'prepared', packageNames: ['first'],
    baseFingerprint: 'b'.repeat(64), health: 'pending' } as const
  for (const invalid of [
    { ...selection, packageNames: [] }, { ...selection, packageNames: ['second', 'first'] },
    { ...selection, packageName: 'fake-target' }, { ...selection, generation: 'untrusted-authority' },
  ]) {
    backend.status.mockResolvedValue(invalid as unknown as ProfilePreparedBundleSelection)
    backend.listPending.mockResolvedValue([invalid as unknown as ProfilePreparedBundleSelection])
    expect(await ipc.handle(request('status', { transactionId }))).toMatchObject({ ok: false })
    expect(await ipc.handle(request('list'))).toMatchObject({ ok: false })
  }
  backend.status.mockResolvedValue({ ...selection, transactionId: rpcId })
  expect(await ipc.handle(request('status', { transactionId }))).toMatchObject({ ok: false })
})

it('aborts in-flight work without cancelling a durable prepare that wins the race', async () => {
  const { backend, ipc } = fixture()
  const gate = Promise.withResolvers<ProfilePreparedPackageChange>()
  let signal: AbortSignal | undefined
  backend.stage.mockImplementation((_id, _request, abort) => { signal = abort; return gate.promise })
  const staging = ipc.handle(request('stage', { requestId: transactionId, mutation: { kind: 'remove', name: 'plugin' } }))
  const aborting = ipc.handle(request('abort', { transactionId }))
  expect(signal?.aborted).toBe(true)
  gate.resolve(prepared)
  expect(await staging).toMatchObject({ ok: true, value: prepared })
  expect(await aborting).toMatchObject({ ok: true, value: null })
  expect(backend.cancel).not.toHaveBeenCalled()
  expect(await ipc.handle(request('status', { transactionId }))).toMatchObject({ ok: true, value: prepared })
})

it('preserves cleanup failure as failure even when the request signal is aborted', async () => {
  const { backend, ipc } = fixture()
  const gate = Promise.withResolvers<ProfilePreparedPackageChange>()
  backend.stage.mockImplementation(() => gate.promise)
  const staging = ipc.handle(request('stage', { requestId: transactionId, mutation: { kind: 'remove', name: 'plugin' } }))
  const aborting = ipc.handle(request('abort', { transactionId }))
  gate.reject(Object.assign(new Error('EPERM: owned cleanup failed'), { code: 'EPERM' }))
  expect(await staging).toMatchObject({ ok: false, errorKind: 'failed', error: 'EPERM: owned cleanup failed' })
  expect(await aborting).toMatchObject({ ok: false, errorKind: 'failed', error: 'EPERM: owned cleanup failed' })
  expect(backend.cancel).not.toHaveBeenCalled()
})

it('reports incomplete cleanup rather than accepting Host disposal as clean', async () => {
  const { backend, ipc } = fixture()
  const gate = Promise.withResolvers<ProfilePreparedPackageChange>()
  backend.stage.mockImplementation(() => gate.promise)
  const staging = ipc.handle(request('stage', { requestId: transactionId, mutation: { kind: 'remove', name: 'plugin' } }))
  const disposing = ipc.dispose()
  const rejected = expect(disposing).rejects.toThrow('cleanup failed during Host disposal')
  gate.reject(new Error('EPERM: cleanup refused'))
  await rejected
  expect(await staging).toMatchObject({ ok: false, errorKind: 'failed' })
})

it('keeps explicit prepared cancellation separate from request abortion', async () => {
  const { backend, ipc } = fixture()
  backend.cancel.mockImplementation(async () => { backend.status.mockResolvedValue(undefined) })
  expect(await ipc.handle(request('cancel', { transactionId }))).toMatchObject({ ok: true })
  expect(backend.cancel).toHaveBeenCalledExactlyOnceWith(transactionId)
})

it('does not turn an in-flight discard into deletion of a later prepared winner', async () => {
  const { backend, ipc } = fixture()
  const gate = Promise.withResolvers<ProfilePreparedPackageChange>()
  let signal: AbortSignal | undefined
  backend.stage.mockImplementation((_id, _request, abort) => { signal = abort; return gate.promise })
  const staging = ipc.handle(request('stage', { requestId: transactionId, mutation: { kind: 'remove', name: 'plugin' } }))
  const rejected = await ipc.handle(request('cancel', { transactionId }))
  expect(rejected).toMatchObject({ ok: false, errorKind: 'failed' })
  expect(signal?.aborted).toBe(false)
  expect(backend.cancel).not.toHaveBeenCalled()
  gate.resolve(prepared)
  expect(await staging).toMatchObject({ ok: true, value: prepared })
  expect(await ipc.handle(request('status', { transactionId }))).toMatchObject({ ok: true, value: prepared })
})

it('refuses discard acknowledgement when the backend still exposes the prepared record', async () => {
  const { ipc } = fixture()
  expect(await ipc.handle(request('cancel', { transactionId })))
    .toMatchObject({ ok: false, errorKind: 'failed', error: 'desktop packages: prepared discard was not confirmed' })
})

it('disconnect waits for owned staging cleanup and refuses new calls', async () => {
  const { backend, ipc } = fixture()
  const gate = Promise.withResolvers<ProfilePreparedPackageChange>()
  let signal: AbortSignal | undefined
  backend.stage.mockImplementation((_id, _request, abort) => { signal = abort; return gate.promise })
  const staging = ipc.handle(request('stage', { requestId: transactionId, mutation: { kind: 'remove', name: 'plugin' } }))
  let disposed = false
  const disposing = ipc.dispose().then(() => { disposed = true })
  expect(signal?.aborted).toBe(true)
  expect(disposed).toBe(false)
  gate.reject(signal!.reason)
  await disposing
  expect(await staging).toMatchObject({ ok: false })
  expect(await ipc.handle(request('hello'))).toMatchObject({ ok: false })
})
