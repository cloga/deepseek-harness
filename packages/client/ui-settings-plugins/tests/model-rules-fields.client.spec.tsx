// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { bindSnapshotSelector, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { SubagentCard, type SubagentCardProps } from '../src/client/SubagentCard.tsx'
import { SubagentLimitsCardController, type SubagentLimitsSettings } from '../src/client/subagent-limits-card-controller.ts'
import { SubagentModelSelectionCardController } from '../src/client/subagent-model-selection-card-controller.ts'
import type { SubagentModelSelectionSettings } from '../src/client/subagent-model-selection-card-controller.ts'
import { subagentCardFace } from '../src/client/subagent-card-controller.ts'
import { en } from '../src/client/locales.ts'

const t = (key: keyof typeof en) => en[key]
afterEach(cleanup)
function bench(rows: SubagentLimitsSettings['modelRules'] = []) {
  const host = stubSettingsScope<SubagentLimitsSettings>()
  host.publish({ status: 'ready', writable: true, revision: 1,
    value: { maxDepth: 3, maxActiveSubagents: 8, modelRules: rows }, user: {} })
  const permission = stubSettingsScope<SubagentModelSelectionSettings>()
  permission.publish({ status: 'ready', writable: true, revision: 2, value: { enabled: false, allowedModels: [] } })
  const catalog = vi.fn(async () => ({ ok: true as const, value: { groups: [
    { id: 'alpha', name: 'Alpha', models: [{ id: 'large', name: 'Large' }] },
    { id: 'beta', name: 'Beta', models: [{ id: 'small', name: 'Small' }] },
  ], failures: [] } }))
  const limits = new SubagentLimitsCardController(host.scope, catalog)
  limits.setRulesSupported(true)
  const models = new SubagentModelSelectionCardController(permission.scope,
    { remote: { session: { modelCatalog: catalog } } } as never)
  onTestFinished(() => { limits.dispose(); models.dispose() })
  const face = subagentCardFace(limits.inject(), models.inject())
  const { hooks, ...actions } = face
  const props = { ...actions, t, view: 'page',
    useSubagentLimitsCard: bindSnapshotSelector(hooks.subagentLimitsCard),
    useSubagentModelSelectionCard: bindSnapshotSelector(hooks.subagentModelSelectionCard),
  } as unknown as SubagentCardProps
  render(<SubagentCard {...props} />)
  return { host, permission, limits, face }
}
describe('Native Subagent rule fields', () => {
  it('explains inheritance and permission independently within one card', async () => {
    bench()
    await act(async () => { await Promise.resolve() })
    expect(screen.getByText(en.subagentRulesEmpty)).toBeTruthy()
    expect(screen.getByText(en.subagentRulesPriority)).toBeTruthy()
    expect(screen.getByText(en.subagentRulesForkHint)).toBeTruthy()
    expect(screen.getByRole('heading', { name: en.subagentLimitsTitle })).toBeTruthy()
    expect(screen.getByRole('switch', { name: en.subagentModelSelectionToggle }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getAllByRole('button', { name: en.save })).toHaveLength(1)
    await screen.findByText(en.subagentRulesSaved)
  })
  it('adds, edits all four selectors, removes rows, and keeps permission untouched', async () => {
    const { host, permission } = bench()
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: en.subagentRulesAdd }))
    expect(screen.getByText(en.subagentRulesIncomplete)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    const parent = within(screen.getByRole('group', { name: en.subagentRulesParent }))
    const child = within(screen.getByRole('group', { name: en.subagentRulesChild }))
    fireEvent.change(parent.getByLabelText(en.subagentRulesProvider), { target: { value: 'alpha' } })
    fireEvent.change(parent.getByLabelText(en.subagentRulesModel), { target: { value: 'large' } })
    fireEvent.change(child.getByLabelText(en.subagentRulesProvider), { target: { value: 'beta' } })
    fireEvent.change(child.getByLabelText(en.subagentRulesModel), { target: { value: 'small' } })
    expect(screen.getByText(en.subagentRulesUnsaved)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: en.subagentRulesRemove }))
    expect(screen.getByText(en.subagentRulesEmpty)).toBeTruthy()
    expect(host.mutate).not.toHaveBeenCalled()
    expect(permission.mutate).not.toHaveBeenCalled()
  })
  it('shows exact missing IDs, duplicate errors, and permits explicit removal', async () => {
    const row = { parent: { provider: 'missing-provider', model: 'missing-model' }, child: { provider: 'beta', model: 'small' } }
    bench([row, row])
    await act(async () => { await Promise.resolve() })
    expect(screen.getAllByRole('option', { name: `missing-provider — ${en.subagentModelSelectionUnavailable}` })).toHaveLength(2)
    expect(screen.getAllByRole('option', { name: `missing-model — ${en.subagentModelSelectionUnavailable}` })).toHaveLength(2)
    expect(screen.getByText(en.subagentRulesDuplicate)).toBeTruthy()
    fireEvent.click(screen.getAllByRole('button', { name: en.subagentRulesRemove })[0]!)
    expect(screen.queryByText(en.subagentRulesDuplicate)).toBeNull()
    expect(screen.getAllByRole('button', { name: en.subagentRulesRemove })).toHaveLength(1)
  })
  it('distinguishes unsaved and saving states and retains rejected drafts', async () => {
    const row = { parent: { provider: 'alpha', model: 'large' }, child: { provider: 'beta', model: 'small' } }
    const { host } = bench([row])
    await act(async () => { await Promise.resolve() })
    fireEvent.click(screen.getByRole('button', { name: en.subagentRulesRemove }))
    let settle!: () => void
    host.mutate.mockImplementation(() => new Promise<void>((resolve) => { settle = resolve }))
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    expect(screen.getAllByText(en.saving).length).toBeGreaterThan(0)
    expect(screen.getByRole('button', { name: en.subagentRulesAdd })).toHaveProperty('disabled', true)
    await act(async () => { settle(); await Promise.resolve() })
    expect(screen.getByText(en.saveFailed)).toBeTruthy()
    expect(screen.getByText(en.subagentRulesUnsaved)).toBeTruthy()
  })
  it('disables rule edits without Host support or document write permission', async () => {
    const { host, limits } = bench()
    await act(async () => { await Promise.resolve() })
    act(() => { limits.setRulesSupported(false) })
    expect(screen.getByText(en.subagentRulesUnsupported)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.subagentRulesAdd })).toHaveProperty('disabled', true)
    act(() => { limits.setRulesSupported(true) })
    fireEvent.change(screen.getByLabelText(en.subagentMaxDepth), { target: { value: '4' } })
    act(() => { host.publish({ writable: false }) })
    expect(screen.getByRole('button', { name: en.subagentRulesAdd })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
  })
})
