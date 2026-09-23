import type { ModelCatalog } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ModelRoutingView, ModelSelectionProjection } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { ModelCatalogDirectory } from '../src/client/catalog.ts'
import { ModelDirectory } from '../src/client/directory.ts'

const subjects: ModelDirectory[] = []
afterEach(() => { for (const subject of subjects.splice(0)) subject.dispose() })

const catalog = (model: string): ModelCatalog => ({
  default: { provider: 'fixture', model },
  routableProviders: ['fixture'],
  groups: [{ id: 'fixture', name: 'Fixture', models: [{ id: model, name: model }] }],
  failures: [],
})

function directory(models: () => Promise<unknown>): ModelCatalogDirectory {
  // The providing plugin's context, scripted down to the one method it calls.
  return new ModelCatalogDirectory({ remote: { session: { modelCatalog: models } } } as never)
}

describe('ModelCatalogDirectory', () => {
  it('shares one failing request, exposes the RPC error, and permits a retry', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce({
        ok: false, error: new RemoteError('gateway/internal', 'catalog offline', {}),
      })
      .mockResolvedValueOnce({ ok: true, value: catalog('recovered') })
    const subject = directory(models)

    const first = subject.load()
    expect(subject.load()).toBe(first)
    await expect(first).rejects.toThrow('gateway/internal: catalog offline')
    expect(subject.store.getSnapshot()).toMatchObject({ status: 'error', error: 'gateway/internal: catalog offline' })
    await expect(subject.load()).resolves.toEqual(catalog('recovered'))
    expect(models).toHaveBeenCalledTimes(2)
  })

  it('does not publish a successful result from an invalidated generation', async () => {
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const subject = directory(models)

    const stale = subject.load()
    subject.resetGeneration()
    first.resolve({ ok: true, value: catalog('stale') })
    await expect(stale).resolves.toEqual(catalog('stale'))
    expect(subject.store.getSnapshot()).toMatchObject({ value: null, status: 'loading' })
    second.resolve({ ok: true, value: catalog('fresh') })
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('fresh'), status: 'ready' })
    })
  })

  it('does not publish a failure from an invalidated generation', async () => {
    const first = Promise.withResolvers<unknown>()
    const second = Promise.withResolvers<unknown>()
    const models = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    const subject = directory(models)

    const stale = subject.load()
    subject.resetGeneration()
    first.reject(new Error('stale failure'))
    await expect(stale).rejects.toThrow('stale failure')
    expect(subject.store.getSnapshot()).toMatchObject({ value: null, status: 'loading', error: null })
    second.resolve({ ok: true, value: catalog('fresh') })
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toMatchObject({ value: catalog('fresh'), status: 'ready' })
    })
  })

  it('contains refresh failures while retaining old data and clears it on a failed Host reset', async () => {
    const models = vi.fn()
      .mockResolvedValueOnce({ ok: true, value: catalog('old') })
      .mockRejectedValueOnce('refresh failed')
      .mockRejectedValueOnce(new Error('reset failed'))
    const subject = directory(models)
    await subject.load()

    subject.refresh()
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toEqual({
        value: catalog('old'), status: 'error', error: 'refresh failed',
      })
    })

    subject.resetGeneration()
    await vi.waitFor(() => {
      expect(subject.store.getSnapshot()).toEqual({
        value: null, status: 'error', error: 'reset failed',
      })
    })
  })
})

type SessionFace = ConstructorParameters<typeof ModelDirectory>[0]
async function modelDirectory() {
  const shared = directory(async () => ({ ok: true, value: { ...catalog('default-prediction'), autoRouting: { available: true } } }))
  await shared.load()
  const selectModel = vi.fn<SessionFace['selectModel']>().mockResolvedValue({
    ok: true, value: { selected: { provider: 'fixture', model: 'manual' } },
  })
  const selectAutoModel = vi.fn<SessionFace['selectAutoModel']>().mockResolvedValue({ ok: true, value: { mode: 'balanced' } })
  const projected = createSnapshotStore<ModelSelectionProjection | undefined>({ lastUsed: null, next: null })
  const routing = createSnapshotStore<ModelRoutingView | undefined>({ mode: 'manual', lastDecision: null })
  const subject = new ModelDirectory({ selectModel, selectAutoModel }, 'subject' as SessionId, () => true, shared, projected, routing)
  subjects.push(subject)
  return { subject, shared, projected, routing, selectModel, selectAutoModel }
}

describe('ModelDirectory durable Auto intent', () => {
  it('uses last actual selection rather than pending/manual/default predictions', async () => {
    const h = await modelDirectory()
    h.projected.set({ lastUsed: { provider: 'used', model: 'actual', reasoningEffort: 'high' }, next: { provider: 'pending', model: 'not-used' } })
    h.routing.set({ mode: 'balanced', lastDecision: null })
    expect(h.subject.store.getSnapshot()).toMatchObject({ current: { provider: 'used', model: 'actual', reasoningEffort: 'high' }, routable: null })
    h.projected.set({ lastUsed: null, next: { provider: 'pending', model: 'not-used' } })
    expect(h.subject.store.getSnapshot().current).toBeNull()
    type Decision = NonNullable<ModelRoutingView['lastDecision']>
    h.routing.set({ mode: 'balanced', lastDecision: {
      taskId: 'actual-task' as Decision['taskId'], intentSeq: 1 as Decision['intentSeq'],
      selection: { provider: 'confirmed', model: 'confirmed-model' }, candidateId: 'actual', reason: 'quality-floor',
    } })
    expect(h.subject.store.getSnapshot().current).toEqual({ provider: 'confirmed', model: 'confirmed-model' })
  })

  it('waits for the durable Auto projection instead of locally predicting Host acceptance', async () => {
    const h = await modelDirectory()
    await h.subject.selectAuto('balanced')
    expect(h.selectAutoModel).toHaveBeenCalledWith({ sessionId: 'subject', mode: 'balanced' })
    expect(h.subject.store.getSnapshot().autoRouting?.mode).toBe('manual')
    h.routing.set({ mode: 'balanced', lastDecision: null })
    expect(h.subject.store.getSnapshot()).toMatchObject({ current: null, autoRouting: { mode: 'balanced' } })
  })

  it('clears old-provider blocking immediately when manual intent becomes Auto during catalog refresh', async () => {
    const h = await modelDirectory()
    h.projected.set({ lastUsed: { provider: 'retired', model: 'used' }, next: { provider: 'retired', model: 'manual' } })
    expect(h.subject.store.getSnapshot().routable).toBe(false)
    const value = h.shared.store.getSnapshot().value
    h.shared.store.set({ value, status: 'loading', error: null })
    h.routing.set({ mode: 'efficiency', lastDecision: null })
    expect(h.subject.store.getSnapshot()).toMatchObject({
      current: { provider: 'retired', model: 'used' }, autoRouting: { mode: 'efficiency' }, routable: null, status: 'loading',
    })
    h.shared.store.set({ value, status: 'error', error: 'catalog offline' })
    expect(h.subject.store.getSnapshot()).toMatchObject({ routable: null, status: 'error', error: 'catalog offline' })
  })

  it('does not authorize new Auto choices from the previous Host catalog after reset', async () => {
    const h = await modelDirectory()
    h.routing.set({ mode: 'intelligence', lastDecision: null })
    h.shared.store.set({ value: null, status: 'loading', error: null })
    h.subject.resetConnected()
    expect(h.subject.store.getSnapshot()).toMatchObject({ autoRouting: { mode: 'intelligence', available: false }, routable: null })
    await expect(h.subject.selectAuto('balanced')).rejects.toThrow()
    expect(h.selectAutoModel).not.toHaveBeenCalled()
  })

  it('surfaces structured Auto failures and transport rejections without remaining selecting', async () => {
    const h = await modelDirectory()
    h.selectAutoModel.mockResolvedValueOnce({ ok: false, error: new RemoteError('gateway/internal', 'route unavailable', {}) })
    await expect(h.subject.selectAuto('balanced')).rejects.toThrow('route unavailable')
    expect(h.subject.store.getSnapshot()).toMatchObject({ status: 'error', error: 'gateway/internal: route unavailable' })
    h.selectAutoModel.mockRejectedValueOnce(new Error('transport lost'))
    await expect(h.subject.selectAuto('efficiency')).rejects.toThrow('transport lost')
    expect(h.subject.store.getSnapshot()).toMatchObject({ status: 'error', error: 'transport lost' })
  })

  it.each(['success', 'error', 'throw'] as const)('ignores a late Auto %s after a newer manual selection', async (outcome) => {
    const h = await modelDirectory()
    const response = Promise.withResolvers<Awaited<ReturnType<SessionFace['selectAutoModel']>>>()
    h.selectAutoModel.mockReturnValueOnce(response.promise)
    const first = h.subject.selectAuto('balanced')
    const settlement = outcome === 'success' ? expect(first).resolves.toBeUndefined() : expect(first).rejects.toThrow('late')
    h.projected.set({ lastUsed: null, next: { provider: 'fixture', model: 'manual' } })
    await h.subject.select({ provider: 'fixture', model: 'manual' })
    if (outcome === 'success') response.resolve({ ok: true, value: { mode: 'balanced' } })
    else if (outcome === 'error') response.resolve({ ok: false, error: new RemoteError('gateway/internal', 'late', {}) })
    else response.reject(new Error('late'))
    await settlement
    expect(h.subject.store.getSnapshot()).toMatchObject({ current: { model: 'manual' }, autoRouting: { mode: 'manual' }, status: 'ready', error: null })
  })

  it.each(['success', 'error', 'throw'] as const)('does not publish an Auto %s settling after disposal', async (outcome) => {
    const h = await modelDirectory()
    const response = Promise.withResolvers<Awaited<ReturnType<SessionFace['selectAutoModel']>>>()
    h.selectAutoModel.mockReturnValueOnce(response.promise)
    const pending = h.subject.selectAuto('balanced')
    const settlement = outcome === 'success' ? expect(pending).resolves.toBeUndefined() : expect(pending).rejects.toThrow('disposed')
    h.subject.dispose()
    const snapshot = h.subject.store.getSnapshot()
    if (outcome === 'success') response.resolve({ ok: true, value: { mode: 'balanced' } })
    else if (outcome === 'error') response.resolve({ ok: false, error: new RemoteError('gateway/internal', 'disposed', {}) })
    else response.reject(new Error('disposed'))
    await settlement
    expect(h.subject.store.getSnapshot()).toBe(snapshot)
  })

  it('ignores a prior-generation transport failure and does not mutate a disposed directory', async () => {
    const h = await modelDirectory()
    const response = Promise.withResolvers<Awaited<ReturnType<SessionFace['selectAutoModel']>>>()
    h.selectAutoModel.mockReturnValueOnce(response.promise)
    const first = h.subject.selectAuto('balanced')
    const rejected = expect(first).rejects.toThrow('previous Host')
    h.subject.resetConnected()
    response.reject(new Error('previous Host'))
    await rejected
    expect(h.subject.store.getSnapshot()).toMatchObject({ status: 'ready', error: null })
    const snapshot = h.subject.store.getSnapshot()
    h.subject.dispose()
    h.routing.set({ mode: 'balanced', lastDecision: null })
    h.projected.set({ lastUsed: { provider: 'fixture', model: 'late' }, next: null })
    h.shared.store.set({ value: null, status: 'error', error: 'late catalog' })
    expect(h.subject.store.getSnapshot()).toBe(snapshot)
  })
})
