import { expect, it, vi } from 'vitest'
import {
  ProfilePackageCancelledError,
  type ProfilePackageTransactions, type ProfilePreparedPackageChange, type ProfilePreparedBundleSelection,
} from '@deepseek-ai/dsh-app-boot'
import { DesktopPackageTransactionIpc } from '../src/package-transaction-ipc.ts'

const transactionId = '11111111-1111-4111-8111-111111111111'
const rpcId = '22222222-2222-4222-8222-222222222222'
const PUBLIC_FAILURE = 'desktop packages: staging request failed'
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

it('never echoes a signed source or backend diagnostic over the Host IPC result', async () => {
  const { backend, ipc } = fixture()
  const source = 'https://example.invalid/plugin.tgz?sig=private-sentinel'
  backend.stage.mockRejectedValue(new Error(`pnpm install ${source} failed: private-sentinel`))
  const result = await ipc.handle(request('stage', { requestId: transactionId,
    mutation: { kind: 'install', source: { schemaVersion: 1, type: 'packageSpec', spec: source } },
  }))
  expect(backend.stage).toHaveBeenCalledOnce()
  expect(result).toMatchObject({ ok: false, errorKind: 'failed', error: PUBLIC_FAILURE })
  expect(JSON.stringify(result)).not.toContain('private-sentinel')
  const malformed = await ipc.handle(request('stage', { requestId: rpcId,
    mutation: { kind: 'install', source: { schemaVersion: 1, type: 'packageSpec', spec: 'package', 'private-sentinel': true } },
  }))
  expect(JSON.stringify(malformed)).not.toContain('private-sentinel')
  expect(backend.stage).toHaveBeenCalledOnce()
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
    backend.status.mockResolvedValue(invalid)
    backend.listPending.mockResolvedValue([invalid])
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

it('acknowledges abort only after the backend confirms post-cleanup cancellation', async () => {
  const { backend, ipc } = fixture()
  const gate = Promise.withResolvers<ProfilePreparedPackageChange>()
  let signal: AbortSignal | undefined
  backend.stage.mockImplementation((_id, _request, abort) => { signal = abort; return gate.promise })
  const staging = ipc.handle(request('stage', { requestId: transactionId, mutation: { kind: 'remove', name: 'plugin' } }))
  const aborting = ipc.handle(request('abort', { transactionId }))
  expect(signal?.aborted).toBe(true)
  let settled = false
  void aborting.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  gate.reject(new ProfilePackageCancelledError())
  expect(await staging).toMatchObject({ ok: false, errorKind: 'cancelled', error: PUBLIC_FAILURE })
  expect(await aborting).toMatchObject({ ok: true, value: null })
  expect(backend.cancel).not.toHaveBeenCalled()
})

it('preserves cleanup failure as failure even when the request signal is aborted', async () => {
  const { backend, ipc } = fixture()
  const gate = Promise.withResolvers<ProfilePreparedPackageChange>()
  backend.stage.mockImplementation(() => gate.promise)
  const staging = ipc.handle(request('stage', { requestId: transactionId, mutation: { kind: 'remove', name: 'plugin' } }))
  const aborting = ipc.handle(request('abort', { transactionId }))
  gate.reject(Object.assign(new Error('EPERM: owned cleanup failed'), { code: 'EPERM' }))
  expect(await staging).toMatchObject({ ok: false, errorKind: 'failed', error: PUBLIC_FAILURE })
  expect(await aborting).toMatchObject({ ok: false, errorKind: 'failed', error: PUBLIC_FAILURE })
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
    .toMatchObject({ ok: false, errorKind: 'failed', error: PUBLIC_FAILURE })
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
  gate.reject(new ProfilePackageCancelledError())
  await disposing
  expect(await staging).toMatchObject({ ok: false, errorKind: 'cancelled' })
  expect(await ipc.handle(request('hello'))).toMatchObject({ ok: false })
})
