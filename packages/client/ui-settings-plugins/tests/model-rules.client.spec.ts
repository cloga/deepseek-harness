/** Native Subagent defaults remain separate from model-selection permission. */
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime/src/settings-scope.ts'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { SubagentLimitsCardController, type SubagentLimitsSettings } from '../src/client/subagent-limits-card-controller.ts'

const rule = { parent: { provider: 'alpha', model: 'large' }, child: { provider: 'beta', model: 'small' } }
const groups = [
  { id: 'alpha', name: 'Alpha', models: [{ id: 'large', name: 'Large' }] },
  { id: 'beta', name: 'Beta', models: [{ id: 'small', name: 'Small' }] },
]
function bench(modelRules?: SubagentLimitsSettings['modelRules']) {
  const source = stubSettingsScope<SubagentLimitsSettings>()
  const mutate = vi.fn<typeof source.scope.mutate>(() => Promise.resolve())
  const host = { ...source, scope: { ...source.scope, mutate }, mutate }
  host.publish({ status: 'ready', writable: true, revision: 2,
    value: { maxDepth: 3, maxActiveSubagents: 8, ...(modelRules === undefined ? {} : { modelRules }) }, user: {} })
  const catalog = vi.fn<NonNullable<ConstructorParameters<typeof SubagentLimitsCardController>[1]>>(
    () => Promise.resolve({ ok: true, value: { groups, failures: [] } }),
  )
  const controller = new SubagentLimitsCardController(host.scope, catalog)
  onTestFinished(() => { controller.dispose() })
  controller.setRulesSupported(true)
  const face = controller.inject()
  const state = () => face.hooks.subagentLimitsCard.getSnapshot()
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
    const value = { ...host.scope.getSnapshot().value! }
    const user: Record<string, unknown> = { ...host.scope.getSnapshot().user as object }
    for (const op of ops) {
      if (op.op === 'set') { Object.assign(value, { [op.path[0]!]: op.value }); user[op.path[0]!] = op.value }
    }
    host.publish({ value, user, revision: 3 })
    return Promise.resolve()
  })
  return { host, controller, face, state, catalog }
}
function add(face: ReturnType<SubagentLimitsCardController['inject']>) {
  face.addRule()
  for (const side of ['parent', 'child'] as const) {
    face.editRule(0, side, 'provider', rule[side].provider)
    face.editRule(0, side, 'model', rule[side].model)
  }
}
describe('Subagent model rules', () => {
  it('ignores stale row edits and never treats another namespace leaf as a limit', () => {
    const { face, host, state } = bench([rule])
    face.resetField('enabled')
    face.edit('allowedModels', 'other')
    expect(state().dirty).toBe(false)
    face.removeRule(0)
    face.editRule(0, 'child', 'model', 'stale-selection')
    expect(state().rules.rows).toEqual([])
    expect(state().dirty).toBe(true)
    expect(host.mutate).not.toHaveBeenCalled()
  })
  it('ignores numeric edits while loading or read-only without dropping the rule draft', () => {
    const { host, face, state } = bench([])
    add(face)
    for (const update of [{ status: 'loading' as const }, { status: 'ready' as const, writable: false }]) {
      host.publish(update)
      face.edit('maxDepth', '99')
      face.resetField('maxActiveSubagents')
      expect(state().maxDepth.text).toBe('3')
      expect(state().maxActiveSubagents.text).toBe('8')
      expect(state().rules.rows).toEqual([rule])
    }
    expect(host.mutate).not.toHaveBeenCalled()
  })
  it('does not write a reset when the Host has no user-layer override', () => {
    const { host, face, state } = bench([])
    host.publish({ user: undefined, base: { maxDepth: 3, maxActiveSubagents: 8 } })
    face.resetField('maxDepth')
    expect(state()).toMatchObject({ dirty: false, maxDepth: { text: '3', overridden: false } })
    face.edit('maxActiveSubagents', '')
    expect(state()).toMatchObject({ dirty: false, invalid: false, maxActiveSubagents: { text: '', overridden: false } })
    face.save()
    expect(host.mutate).not.toHaveBeenCalled()
  })
  it('accepts a reset whose readback removes the entire user layer and preserves rules', async () => {
    const { host, face, state } = bench([rule])
    host.publish({ value: { maxDepth: 4, maxActiveSubagents: 8, modelRules: [rule] },
      base: { maxDepth: 3, maxActiveSubagents: 8, modelRules: [rule] }, user: { maxDepth: 4 } })
    host.mutate.mockImplementationOnce(() => {
      host.publish({ value: { maxDepth: 3, maxActiveSubagents: 8, modelRules: [rule] }, user: undefined, revision: 3 })
      return Promise.resolve()
    })
    face.resetField('maxDepth')
    face.save()
    await vi.waitFor(() => { expect(state().saving).toBe(false) })
    expect(host.mutate).toHaveBeenCalledWith([{ op: 'unset', path: ['maxDepth'] }], 2)
    expect(state()).toMatchObject({ dirty: false, failed: false, rules: { rows: [rule] } })
  })
  it('fences a newer snapshot even before its subscription notification arrives', () => {
    const { host, face, state } = bench([])
    add(face)
    const changed = { ...host.scope.getSnapshot(), revision: 9 }
    const getSnapshot = vi.spyOn(host.scope, 'getSnapshot').mockReturnValue(changed)
    try {
      expect(state().conflicted).toBe(false)
      face.save()
      expect(state()).toMatchObject({ conflicted: true, dirty: true, saving: false })
      expect(host.mutate).not.toHaveBeenCalled()
      expect(state().rules.rows).toEqual([rule])
    } finally {
      getSnapshot.mockRestore()
    }
  })
  it('keeps catalog invalidations inactive while the Host no longer supports rules', async () => {
    const { controller, face, state, catalog, host } = bench([rule])
    await vi.waitFor(() => { expect(state().rules.catalogStatus).toBe('ready') })
    controller.setRulesSupported(false)
    controller.refreshCatalog()
    face.retryRulesCatalog()
    face.removeRule(0)
    expect(state().rules).toMatchObject({ supported: false, catalogStatus: 'idle', rows: [rule] })
    expect(catalog).toHaveBeenCalledOnce()
    expect(host.mutate).not.toHaveBeenCalled()
    controller.setRulesSupported(true)
    await vi.waitFor(() => { expect(state().rules.catalogStatus).toBe('ready') })
    expect(catalog).toHaveBeenCalledTimes(2)
  })
  it('withdraws all callbacks and the scope subscription with its controller', async () => {
    const { host, controller, face, state, catalog } = bench([])
    await vi.waitFor(() => { expect(state().rules.catalogStatus).toBe('ready') })
    expect(host.listenerCount()).toBe(1)
    controller.dispose()
    const settled = state()
    controller.refreshCatalog()
    controller.resetConnection()
    controller.setRulesSupported(false)
    face.retryRulesCatalog()
    face.edit('maxDepth', '9')
    face.save()
    face.discard()
    host.publish({ revision: 9 })
    expect(state()).toBe(settled)
    expect(host.listenerCount()).toBe(0)
    expect(catalog).toHaveBeenCalledOnce()
    expect(host.mutate).not.toHaveBeenCalled()
  })
  it.each(['reset', 'dispose'] as const)('ignores a late rejected write after %s', async (action) => {
    const { host, controller, face, state } = bench([])
    await vi.waitFor(() => { expect(state().rules.catalogStatus).toBe('ready') })
    const pending = Promise.withResolvers<undefined>()
    host.mutate.mockImplementationOnce(() => pending.promise)
    add(face)
    face.save()
    if (action === 'reset') {
      controller.resetConnection()
      await vi.waitFor(() => { expect(state().rules.catalogStatus).toBe('ready') })
    } else controller.dispose()
    const settled = state()
    pending.reject(new Error('late write rejection'))
    await expect(pending.promise).rejects.toThrow('late write rejection')
    expect(state()).toBe(settled)
    expect(host.mutate).toHaveBeenCalledOnce()
  })
  it.each(['reset', 'dispose'] as const)('ignores a late rejected catalog after %s', async (action) => {
    const { controller, face, state, catalog } = bench([rule])
    await vi.waitFor(() => { expect(state().rules.catalogStatus).toBe('ready') })
    const pending = Promise.withResolvers<Awaited<ReturnType<typeof catalog>>>()
    catalog.mockImplementationOnce(() => pending.promise)
    controller.refreshCatalog()
    if (action === 'reset') {
      controller.resetConnection()
      await vi.waitFor(() => { expect(state().rules.catalogStatus).toBe('ready') })
    } else controller.dispose()
    const settled = state()
    pending.reject(new Error('late catalog rejection'))
    await expect(pending.promise).rejects.toThrow('late catalog rejection')
    expect(state()).toBe(settled)
    expect(state().rules.rows).toEqual([rule])
    face.save()
  })
  it('retains drafts on a returned catalog error and accepts a partial retry', async () => {
    const { controller, face, state, catalog, host } = bench([])
    await vi.waitFor(() => { expect(state().rules.catalogStatus).toBe('ready') })
    add(face)
    catalog.mockResolvedValueOnce({ ok: false })
    controller.refreshCatalog()
    await vi.waitFor(() => { expect(state().rules.catalogStatus).toBe('error') })
    expect(state().rules.rows).toEqual([rule])
    catalog.mockResolvedValueOnce({ ok: true, value: { groups, failures: [{ id: 'offline-provider' }] } })
    face.retryRulesCatalog()
    await vi.waitFor(() => { expect(state().rules).toMatchObject({ catalogStatus: 'ready', catalogPartial: true }) })
    expect(state().rules.rows).toEqual([rule])
    expect(host.mutate).not.toHaveBeenCalled()
  })
  it('renders missing rules as empty without inferring Host support', () => {
    const { controller, state, face } = bench()
    controller.setRulesSupported(false)
    expect(state().rules).toMatchObject({ rows: [], supported: false, dirty: false })
    face.addRule()
    expect(state().rules.rows).toEqual([])
  })
  it('stages exact provider and model choices and saves only modelRules', async () => {
    const { host, face, state } = bench()
    add(face)
    expect(state()).toMatchObject({ dirty: true, invalid: false, rules: { rows: [rule] } })
    expect(host.mutate).not.toHaveBeenCalled()
    face.save()
    expect(state().saving).toBe(true)
    await vi.waitFor(() => { expect(state().saving).toBe(false) })
    expect(host.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['modelRules'], value: [rule] }], 2)
    expect(host.scope.getSnapshot().value).toEqual({ maxDepth: 3, maxActiveSubagents: 8, modelRules: [rule] })
    expect(state().rules.dirty).toBe(false)
    expect(host.set).not.toHaveBeenCalled()
  })
  it('writes dirty limits and rules in one namespace CAS', async () => {
    const { host, face, state } = bench([])
    add(face)
    face.edit('maxDepth', '4')
    face.edit('maxActiveSubagents', '12')
    face.save()
    await vi.waitFor(() => { expect(state().saving).toBe(false) })
    expect(host.mutate).toHaveBeenCalledOnce()
    expect(host.mutate.mock.calls[0]).toEqual([[
      { op: 'set', path: ['maxDepth'], value: 4 },
      { op: 'set', path: ['maxActiveSubagents'], value: 12 },
      { op: 'set', path: ['modelRules'], value: [rule] },
    ], 2])
  })
  it('rejects incomplete and duplicate parents and clears the model on provider edit', () => {
    const { face, state, host } = bench([rule])
    face.addRule()
    expect(state().rules.incomplete).toBe(true)
    face.editRule(1, 'parent', 'provider', 'alpha')
    face.editRule(1, 'parent', 'model', 'large')
    face.editRule(1, 'child', 'provider', 'beta')
    face.editRule(1, 'child', 'model', 'small')
    expect(state().rules.duplicate).toBe(true)
    face.save()
    expect(host.mutate).not.toHaveBeenCalled()
    face.removeRule(1)
    face.editRule(0, 'parent', 'provider', 'beta')
    expect(state().rules.rows[0]?.parent).toEqual({ provider: 'beta', model: '' })
  })
  it('retains unavailable exact IDs through catalog changes and allows removal', async () => {
    const missing = { parent: { provider: 'gone', model: 'old' }, child: rule.child }
    const { face, state, controller, catalog } = bench([missing])
    await vi.waitFor(() => { expect(state().rules.catalogStatus).toBe('ready') })
    expect(state().rules.rows).toEqual([missing])
    catalog.mockResolvedValue({ ok: true, value: { groups: [], failures: [] } })
    controller.refreshCatalog()
    await vi.waitFor(() => { expect(state().rules.groups).toEqual([]) })
    expect(state().rules.rows).toEqual([missing])
    face.removeRule(0)
    face.save()
    await vi.waitFor(() => { expect(state().rules.dirty).toBe(false) })
    expect(state().rules.rows).toEqual([])
  })
  it('retains failed drafts and rejects stale revisions until discarded', async () => {
    const { host, face, state } = bench([])
    add(face)
    host.mutate.mockResolvedValue(undefined)
    face.save()
    await vi.waitFor(() => { expect(state().failed).toBe(true) })
    expect(state().rules.rows).toEqual([rule])
    host.publish({ revision: 4 })
    face.save()
    expect(host.mutate).toHaveBeenCalledTimes(1)
    expect(state().conflicted).toBe(true)
    face.discard()
    expect(state()).toMatchObject({ dirty: false, conflicted: false })
  })
  it('blocks loading and read-only edits while preserving an existing draft', () => {
    const { host, face, state } = bench([])
    add(face)
    for (const update of [{ status: 'loading' as const }, { status: 'ready' as const, writable: false }]) {
      host.publish(update)
      face.addRule(); face.removeRule(0); face.editRule(0, 'parent', 'model', 'other'); face.save()
      expect(state().rules.rows).toEqual([rule])
    }
    expect(host.mutate).not.toHaveBeenCalled()
  })
  it('does not retain a stale revision for a limit edit restored to its saved value', async () => {
    const { host, face, state } = bench([])
    face.edit('maxDepth', '4')
    face.edit('maxDepth', '3')
    expect(state().dirty).toBe(false)
    host.publish({ revision: 3, value: { maxDepth: 5, maxActiveSubagents: 8, modelRules: [] } })
    expect(state()).toMatchObject({ conflicted: false, dirty: false, maxDepth: { text: '5' } })
    add(face)
    face.save()
    await vi.waitFor(() => { expect(state().saving).toBe(false) })
    expect(host.mutate).toHaveBeenCalledWith([{ op: 'set', path: ['modelRules'], value: [rule] }], 3)
  })
  it('publishes a concurrent revision conflict when a pending write rejects', async () => {
    const { host, face, state } = bench([])
    let reject!: (error: Error) => void
    host.mutate.mockImplementationOnce(() => new Promise<void>((_resolve, fail) => { reject = fail }))
    add(face)
    face.save()
    host.publish({ revision: 4 })
    reject(new Error('write rejected after concurrent update'))
    await vi.waitFor(() => { expect(state()).toMatchObject({ saving: false, failed: true, conflicted: true }) })
    expect(state().rules.rows).toEqual([rule])
    face.save()
    expect(host.mutate).toHaveBeenCalledOnce()
  })
  it('retains rule drafts after a rejected scope write and allows retry', async () => {
    const { host, face, state } = bench([])
    add(face)
    host.mutate.mockImplementationOnce(() => Promise.reject(new Error('disconnected')))
    face.save()
    await vi.waitFor(() => { expect(state()).toMatchObject({ saving: false, failed: true, dirty: true }) })
    expect(state().rules.rows).toEqual([rule])
    face.save()
    await vi.waitFor(() => { expect(state()).toMatchObject({ saving: false, failed: false, dirty: false }) })
  })
  it('reports directory failure without removing saved IDs and retries after rejection', async () => {
    const { controller, catalog, face, state } = bench([rule])
    await vi.waitFor(() => { expect(state().rules.catalogStatus).toBe('ready') })
    catalog.mockRejectedValueOnce(new Error('offline'))
    controller.refreshCatalog()
    await vi.waitFor(() => { expect(state().rules.catalogStatus).toBe('error') })
    expect(state().rules.rows).toEqual([rule])
    face.retryRulesCatalog()
    await vi.waitFor(() => { expect(state().rules.catalogStatus).toBe('ready') })
  })
  it('ignores stale catalog replies after disposal', async () => {
    const { controller, catalog, face, state } = bench([rule])
    await vi.waitFor(() => { expect(state().rules.catalogStatus).toBe('ready') })
    let resolve!: (value: Awaited<ReturnType<typeof catalog>>) => void
    catalog.mockImplementationOnce(() => new Promise((accept) => { resolve = accept }))
    controller.refreshCatalog()
    face.retryRulesCatalog()
    expect(catalog).toHaveBeenCalledTimes(2)
    controller.dispose()
    const before = state()
    resolve({ ok: true, value: { groups: [], failures: [] } })
    await Promise.resolve()
    expect(state()).toBe(before)
  })
  it('blocks duplicate saves and edits during settlement, and drops drafts on connection reset', async () => {
    const { host, face, state, controller } = bench([])
    let settle!: () => void
    host.mutate.mockImplementation(() => new Promise<void>((resolve) => { settle = resolve }))
    add(face)
    face.save(); face.save(); face.removeRule(0); face.discard()
    expect(state().rules.rows).toEqual([rule])
    expect(host.mutate).toHaveBeenCalledOnce()
    controller.resetConnection()
    settle()
    await Promise.resolve()
    expect(state()).toMatchObject({ dirty: false, saving: false, failed: false })
    controller.dispose()
    face.addRule()
    expect(state().rules.rows).toEqual([])
  })
})
