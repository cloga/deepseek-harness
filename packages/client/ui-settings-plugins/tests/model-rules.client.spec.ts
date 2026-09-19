/** Native Subagent defaults remain separate from model-selection permission. */
import { describe, expect, it, vi } from 'vitest'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime/src/settings-scope.ts'
import type { SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { SubagentLimitsCardController, type SubagentLimitsSettings } from '../src/client/subagent-limits-card-controller.ts'

const rule = { parent: { provider: 'alpha', model: 'large' }, child: { provider: 'beta', model: 'small' } }
const groups = [
  { id: 'alpha', name: 'Alpha', models: [{ id: 'large', name: 'Large' }] },
  { id: 'beta', name: 'Beta', models: [{ id: 'small', name: 'Small' }] },
]
function bench(modelRules?: SubagentLimitsSettings['modelRules']) {
  const host = stubSettingsScope<SubagentLimitsSettings>()
  host.publish({ status: 'ready', writable: true, revision: 2,
    value: { maxDepth: 3, maxActiveSubagents: 8, ...(modelRules === undefined ? {} : { modelRules }) }, user: {} })
  const catalog = vi.fn(async () => ({ ok: true as const, value: { groups, failures: [] } }))
  const controller = new SubagentLimitsCardController(host.scope, catalog)
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
    await vi.waitFor(() => expect(state().saving).toBe(false))
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
    await vi.waitFor(() => expect(state().saving).toBe(false))
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
    await vi.waitFor(() => expect(state().rules.catalogStatus).toBe('ready'))
    expect(state().rules.rows).toEqual([missing])
    catalog.mockResolvedValue({ ok: true, value: { groups: [], failures: [] } })
    controller.refreshCatalog()
    await vi.waitFor(() => expect(state().rules.groups).toEqual([]))
    expect(state().rules.rows).toEqual([missing])
    face.removeRule(0)
    face.save()
    await vi.waitFor(() => expect(state().rules.dirty).toBe(false))
    expect(state().rules.rows).toEqual([])
  })
  it('retains failed drafts and rejects stale revisions until discarded', async () => {
    const { host, face, state } = bench([])
    add(face)
    host.mutate.mockImplementation(() => {})
    face.save()
    await vi.waitFor(() => expect(state().failed).toBe(true))
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
    await vi.waitFor(() => expect(state().saving).toBe(false))
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
    await vi.waitFor(() => expect(state()).toMatchObject({ saving: false, failed: true, conflicted: true }))
    expect(state().rules.rows).toEqual([rule])
    face.save()
    expect(host.mutate).toHaveBeenCalledOnce()
  })
  it('retains rule drafts after a rejected scope write and allows retry', async () => {
    const { host, face, state } = bench([])
    add(face)
    host.mutate.mockImplementationOnce(() => Promise.reject(new Error('disconnected')))
    face.save()
    await vi.waitFor(() => expect(state()).toMatchObject({ saving: false, failed: true, dirty: true }))
    expect(state().rules.rows).toEqual([rule])
    face.save()
    await vi.waitFor(() => expect(state()).toMatchObject({ saving: false, failed: false, dirty: false }))
  })
  it('reports directory failure without removing saved IDs and retries after rejection', async () => {
    const { controller, catalog, face, state } = bench([rule])
    await vi.waitFor(() => expect(state().rules.catalogStatus).toBe('ready'))
    catalog.mockRejectedValueOnce(new Error('offline'))
    controller.refreshCatalog()
    await vi.waitFor(() => expect(state().rules.catalogStatus).toBe('error'))
    expect(state().rules.rows).toEqual([rule])
    face.retryRulesCatalog()
    await vi.waitFor(() => expect(state().rules.catalogStatus).toBe('ready'))
  })
  it('ignores stale catalog replies after disposal', async () => {
    const { controller, catalog, face, state } = bench([rule])
    await vi.waitFor(() => expect(state().rules.catalogStatus).toBe('ready'))
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
