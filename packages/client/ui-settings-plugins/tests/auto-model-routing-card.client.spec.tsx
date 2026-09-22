// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { autoRoutingSettingsScope, deferred } from './auto-model-routing-test-helpers.client.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { AutoModelRoutingCard, type AutoModelRoutingCardProps } from '../src/client/AutoModelRoutingCard.tsx'
import { AutoModelRoutingCardController } from '../src/client/auto-model-routing-card-controller.ts'
import type { AutoModelRoutingCardFace, AutoModelRoutingCardState } from '../src/client/auto-model-routing-card-controller.ts'
import { autoRoutingDraft, autoRoutingModelKey } from '../src/client/auto-model-routing-form.ts'
import type { AutoRoutingFormError, AutoRoutingModelOption, AutoRoutingSettings } from '../src/client/auto-model-routing-form.ts'
import { en, zh, type PluginsSettingsLocaleKey } from '../src/client/locales.ts'

afterEach(cleanup)

const modelA = { provider: 'provider-a', model: 'model-a' }
const modelB = { provider: 'provider-b', model: 'model-b' }
const settings: AutoRoutingSettings = {
  enabled: false,
  policy: {
    candidates: [
      { id: 'fast', selection: { ...modelA, reasoningEffort: 'low' }, quality: 1, relativeCost: 0.5 },
      { id: 'careful', selection: modelB, quality: 3, relativeCost: 2 },
    ],
    conservativeCandidateId: 'careful',
    minConfidence: 0.7,
    qualityFloors: {
      efficiency: { routine: 1, standard: 1, complex: 2 },
      balanced: { routine: 1, standard: 2, complex: 3 },
      intelligence: { routine: 2, standard: 3, complex: 3 },
    },
  },
  classifier: { selection: modelA, maxInputBytes: 8000, maxOutputTokens: 128, maxOutputBytes: 4000, timeoutMs: 5000 },
}
const models: readonly AutoRoutingModelOption[] = [
  {
    ...modelA, key: autoRoutingModelKey(modelA), providerName: 'Provider A', modelName: 'Model A', available: true,
    efforts: [{ id: 'low', name: 'Low effort' }, { id: 'high', name: 'High effort' }], defaultEffort: 'low',
  },
  {
    ...modelB, key: autoRoutingModelKey(modelB), providerName: 'Provider B', modelName: 'Model B', available: true,
    efforts: [{ id: 'deep', name: 'Deep effort' }],
  },
]

function fixture(overrides: Partial<AutoModelRoutingCardState> = {}, locale = en) {
  const store = createSnapshotStore<AutoModelRoutingCardState>({
    available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false,
    draft: autoRoutingDraft(settings), models, catalogStatus: 'ready', catalogPartial: false,
    conflicted: false, resetPending: false, ...overrides,
  })
  const actions = {
    toggleEnabled: vi.fn(), addCandidate: vi.fn(), removeCandidate: vi.fn(), editCandidate: vi.fn(),
    selectCandidateModel: vi.fn(), selectCandidateEffort: vi.fn(), editPolicy: vi.fn(), editFloor: vi.fn(),
    selectClassifierModel: vi.fn(), selectClassifierEffort: vi.fn(), editBudget: vi.fn(), applySuggestions: vi.fn(),
    reset: vi.fn(), retryCatalog: vi.fn(), save: vi.fn(), discard: vi.fn(),
  } satisfies Omit<AutoModelRoutingCardFace, 'hooks'>
  const props = {
    ...actions, t: (key: PluginsSettingsLocaleKey) => locale[key], useAutoModelRoutingCard: bindSnapshotSelector(store),
  } as unknown as AutoModelRoutingCardProps
  const view = render(<AutoModelRoutingCard {...props} />)
  const open = () => { fireEvent.click(screen.getByRole('button', { name: `${locale.expand}: ${locale.autoRoutingTitle}` })) }
  return { actions, store, open, ...view }
}

function change(control: HTMLElement, value: string) {
  fireEvent.change(control, { target: { value } })
}

const errorCases: readonly [AutoRoutingFormError, PluginsSettingsLocaleKey][] = [
  ['required', 'autoRoutingErrorRequired'], ['candidate-id', 'autoRoutingErrorCandidateId'],
  ['candidate-route', 'autoRoutingErrorCandidateRoute'], ['duplicate', 'autoRoutingErrorDuplicate'],
  ['quality', 'autoRoutingErrorQuality'], ['cost', 'autoRoutingErrorCost'],
  ['conservative', 'autoRoutingErrorConservative'], ['floors', 'autoRoutingErrorFloors'],
  ['confidence', 'autoRoutingErrorConfidence'], ['classifier-route', 'autoRoutingErrorClassifierRoute'],
  ['budgets', 'autoRoutingErrorBudgets'], ['effort', 'autoRoutingErrorEffort'],
]

describe('AutoModelRoutingCard', () => {
  it('saves user edits through the real staged controller as one exact revision-fenced document', async () => {
    const host = autoRoutingSettingsScope()
    const write = deferred<undefined>()
    host.publish({ status: 'ready', writable: true, revision: 7, value: settings, user: settings, base: { enabled: false } })
    host.mutate.mockImplementation(async (ops) => {
      await write.promise
      const operation = ops[0]
      if (operation?.op !== 'set') throw new Error('expected a complete staged write')
      host.publish({ value: operation.value as unknown as AutoRoutingSettings, user: operation.value, revision: 8 })
    })
    const catalog = vi.fn().mockResolvedValue({ ok: true, value: {
      groups: models.map(model => ({
        id: model.provider, name: model.providerName,
        models: [{ id: model.model, name: model.modelName, reasoning: {
          efforts: model.efforts, ...model.defaultEffort === undefined ? {} : { defaultEffort: model.defaultEffort },
        } }],
      })), failures: [],
    } })
    const controller = new AutoModelRoutingCardController(host.scope, { remote: { session: { modelCatalog: catalog } } } as never)
    const { hooks, ...actions } = controller.inject()
    try {
      await Promise.resolve()
      const props = {
        ...actions, t: (key: PluginsSettingsLocaleKey) => en[key],
        useAutoModelRoutingCard: bindSnapshotSelector(hooks.autoModelRoutingCard),
      } as unknown as AutoModelRoutingCardProps
      render(<AutoModelRoutingCard {...props} />)
      fireEvent.click(screen.getByRole('button', { name: `${en.expand}: ${en.autoRoutingTitle}` }))
      fireEvent.click(screen.getByRole('switch', { name: en.autoRoutingEnabled }))
      const candidate = within(screen.getByRole('group', { name: `${en.autoRoutingCandidate} 1` }))
      change(candidate.getByLabelText(en.autoRoutingCost), '1.25')
      change(screen.getByLabelText(en.autoRoutingTimeoutMs), '7500')
      expect(host.mutate).not.toHaveBeenCalled()
      fireEvent.click(screen.getByRole('button', { name: en.save }))
      expect(screen.getByRole('button', { name: en.saving })).toHaveProperty('disabled', true)
      await act(async () => { write.resolve(undefined); await write.promise })
      expect(host.mutate).toHaveBeenCalledExactlyOnceWith([{ op: 'set', path: [], value: {
        ...settings, enabled: true,
        policy: {
          ...settings.policy,
          candidates: settings.policy!.candidates.map((item, index) => index === 0 ? { ...item, relativeCost: 1.25 } : item),
        },
        classifier: { ...settings.classifier, timeoutMs: 7500 },
      } }], 7)
      expect(catalog).toHaveBeenCalledTimes(1)
      expect(screen.queryByLabelText(en.autoRoutingTimeoutMs)).toBeNull()
    } finally {
      write.resolve(undefined)
      controller.dispose()
    }
  })

  it('hides unavailable settings and keeps available cards collapsed until opened', () => {
    const unavailable = fixture({ available: false })
    expect(screen.queryByText(en.autoRoutingTitle)).toBeNull()
    unavailable.unmount()
    const { open } = fixture()
    expect(screen.getByText(en.autoRoutingDescription)).toBeTruthy()
    expect(screen.queryByLabelText(en.autoRoutingEnabled)).toBeNull()
    open()
    expect(screen.getByRole('switch', { name: en.autoRoutingEnabled }).getAttribute('aria-checked')).toBe('false')
    expect(screen.getByRole('group', { name: en.autoRoutingClassifier })).toBeTruthy()
    expect(screen.getByRole('group', { name: en.autoRoutingFloors })).toBeTruthy()
    expect(screen.getByText(en.autoRoutingDisabledHint)).toBeTruthy()
    expect(screen.getByText(en.autoRoutingScopeHint)).toBeTruthy()
    expect(screen.getByText(en.autoRoutingSafetyHint)).toBeTruthy()
    expect(screen.getByText(en.autoRoutingWeightsHint)).toBeTruthy()
    expect(screen.getByText(en.autoRoutingSuggestionsHint)).toBeTruthy()
  })

  it('dispatches the enable action without classifying or saving, then renders the new snapshot', () => {
    const { open, actions, store } = fixture()
    open()
    fireEvent.click(screen.getByRole('switch', { name: en.autoRoutingEnabled }))
    expect(actions.toggleEnabled).toHaveBeenCalledOnce()
    expect(actions.save).not.toHaveBeenCalled()
    act(() => { store.set({ ...store.getSnapshot(), draft: { ...store.getSnapshot().draft, enabled: true }, dirty: true }) })
    expect(screen.getByRole('switch', { name: en.autoRoutingEnabled }).getAttribute('aria-checked')).toBe('true')
    expect(screen.queryByText(en.autoRoutingDisabledHint)).toBeNull()
    expect(screen.getByText(en.unsaved)).toBeTruthy()
  })

  it('addresses candidate edits and routes by the controller-owned row and model keys', () => {
    const { open, actions } = fixture()
    open()
    const row = within(screen.getByRole('group', { name: `${en.autoRoutingCandidate} 1` }))
    expect(row.getByLabelText(en.autoRoutingModel)).toHaveProperty('value', autoRoutingModelKey(modelA))
    expect(row.getByLabelText(en.autoRoutingEffort)).toHaveProperty('value', 'low')
    expect(row.getByRole('option', { name: `${en.autoRoutingProviderDefault} (Low effort)` })).toHaveProperty('value', '')
    expect(row.queryByRole('option', { name: 'Deep effort' })).toBeNull()
    change(row.getByLabelText(en.autoRoutingCandidateId), 'quick')
    change(row.getByLabelText(en.autoRoutingModel), autoRoutingModelKey(modelB))
    change(row.getByLabelText(en.autoRoutingEffort), 'high')
    change(row.getByLabelText(en.autoRoutingEffort), '')
    change(row.getByLabelText(en.autoRoutingQuality), '2')
    change(row.getByLabelText(en.autoRoutingCost), '1.25')
    expect(actions.editCandidate.mock.calls).toEqual([
      ['stored-0', 'id', 'quick'], ['stored-0', 'quality', '2'], ['stored-0', 'relativeCost', '1.25'],
    ])
    expect(actions.selectCandidateModel).toHaveBeenCalledExactlyOnceWith('stored-0', autoRoutingModelKey(modelB))
    expect(actions.selectCandidateEffort.mock.calls).toEqual([['stored-0', 'high'], ['stored-0', '']])
    fireEvent.click(row.getByRole('button', { name: en.autoRoutingRemoveCandidate }))
    fireEvent.click(screen.getByRole('button', { name: en.autoRoutingAddCandidate }))
    expect(actions.removeCandidate).toHaveBeenCalledExactlyOnceWith('stored-0')
    expect(actions.addCandidate).toHaveBeenCalledOnce()
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('dispatches classifier model, effort, and every numeric budget without coercing text', () => {
    const { open, actions } = fixture()
    open()
    const classifier = within(screen.getByRole('group', { name: en.autoRoutingClassifier }))
    change(classifier.getByLabelText(en.autoRoutingModel), autoRoutingModelKey(modelB))
    change(classifier.getByLabelText(en.autoRoutingEffort), 'high')
    change(classifier.getByLabelText(en.autoRoutingEffort), '')
    change(classifier.getByLabelText(en.autoRoutingMaxInputBytes), '12000')
    change(classifier.getByLabelText(en.autoRoutingMaxOutputTokens), '256')
    change(classifier.getByLabelText(en.autoRoutingMaxOutputBytes), '16000')
    change(classifier.getByLabelText(en.autoRoutingTimeoutMs), '')
    expect(actions.selectClassifierModel).toHaveBeenCalledExactlyOnceWith(autoRoutingModelKey(modelB))
    expect(actions.selectClassifierEffort.mock.calls).toEqual([['high'], ['']])
    expect(actions.editBudget.mock.calls).toEqual([
      ['maxInputBytes', '12000'], ['maxOutputTokens', '256'], ['maxOutputBytes', '16000'], ['timeoutMs', ''],
    ])
    expect(actions.save).not.toHaveBeenCalled()
  })

  it('dispatches all nine floor choices, the conservative candidate, and confidence', () => {
    const { open, actions } = fixture()
    open()
    const modes = [['efficiency', en.autoRoutingEfficiency], ['balanced', en.autoRoutingBalanced], ['intelligence', en.autoRoutingIntelligence]] as const
    const complexities = [['routine', en.autoRoutingRoutine], ['standard', en.autoRoutingStandard], ['complex', en.autoRoutingComplex]] as const
    for (const [mode, modeLabel] of modes) {
      for (const [complexity, complexityLabel] of complexities) {
        change(screen.getByRole('combobox', { name: `${modeLabel} / ${complexityLabel}` }), '2')
        expect(actions.editFloor).toHaveBeenLastCalledWith(mode, complexity, '2')
      }
    }
    expect(actions.editFloor).toHaveBeenCalledTimes(9)
    change(screen.getByLabelText(en.autoRoutingConservative), 'fast')
    change(screen.getByLabelText(en.autoRoutingMinConfidence), '0.85')
    expect(actions.editPolicy.mock.calls).toEqual([['conservativeCandidateId', 'fast'], ['minConfidence', '0.85']])
  })

  it('requests suggestions and reset only on explicit clicks, with separate save and discard', () => {
    const { open, actions, store } = fixture({ dirty: true })
    open()
    expect(actions.applySuggestions).not.toHaveBeenCalled()
    expect(actions.reset).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.autoRoutingSuggestions }))
    expect(actions.applySuggestions).toHaveBeenCalledOnce()
    expect(actions.selectCandidateModel).not.toHaveBeenCalled()
    expect(actions.editCandidate).not.toHaveBeenCalled()
    expect(actions.selectClassifierModel).not.toHaveBeenCalled()
    expect(actions.save).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: en.autoRoutingReset }))
    expect(actions.reset).toHaveBeenCalledOnce()
    expect(actions.save).not.toHaveBeenCalled()
    act(() => { store.set({ ...store.getSnapshot(), resetPending: true }) })
    expect(screen.getByRole('status')).toHaveProperty('textContent', en.autoRoutingResetPending)
    fireEvent.click(screen.getByRole('button', { name: en.save }))
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    expect(actions.save).toHaveBeenCalledOnce()
    expect(actions.discard).toHaveBeenCalledOnce()
  })

  it('retains unavailable model and effort selections while offering repair choices', () => {
    const missing = { provider: 'removed-provider', model: 'removed-model', reasoningEffort: 'obsolete' }
    const draft = autoRoutingDraft(settings)
    draft.candidates[0].selection = missing
    draft.classifierSelection = { ...modelA, reasoningEffort: 'retired' }
    const { open, actions } = fixture({
      draft,
      models: [...models, {
        ...missing, key: autoRoutingModelKey(missing), providerName: missing.provider,
        modelName: missing.model, available: false, efforts: [],
      }],
    })
    open()
    const row = within(screen.getByRole('group', { name: `${en.autoRoutingCandidate} 1` }))
    const classifier = within(screen.getByRole('group', { name: en.autoRoutingClassifier }))
    expect(row.getByLabelText(en.autoRoutingModel)).toHaveProperty('value', autoRoutingModelKey(missing))
    expect(row.getByLabelText(en.autoRoutingEffort)).toHaveProperty('value', 'obsolete')
    expect(row.getByRole('option', { name: `obsolete · ${en.autoRoutingUnavailable}` })).toBeTruthy()
    expect(classifier.getByLabelText(en.autoRoutingEffort)).toHaveProperty('value', 'retired')
    expect(classifier.getByRole('option', { name: `retired · ${en.autoRoutingUnavailable}` })).toBeTruthy()
    expect(screen.getAllByText(en.autoRoutingUnavailableHint)).toHaveLength(2)
    change(row.getByLabelText(en.autoRoutingModel), autoRoutingModelKey(modelA))
    change(classifier.getByLabelText(en.autoRoutingEffort), '')
    expect(actions.selectCandidateModel).toHaveBeenCalledExactlyOnceWith('stored-0', autoRoutingModelKey(modelA))
    expect(actions.selectClassifierEffort).toHaveBeenCalledExactlyOnceWith('')
  })

  it('retains a removed conservative candidate as a visibly repairable selection', () => {
    const draft = autoRoutingDraft(settings)
    draft.conservativeCandidateId = 'removed'
    const { open, actions } = fixture({ draft, error: 'conservative', invalid: true, dirty: true })
    open()
    const choice = screen.getByLabelText(en.autoRoutingConservative)
    expect(choice).toHaveProperty('value', 'removed')
    expect(within(choice).getByRole('option', { name: `removed · ${en.autoRoutingUnavailable}` })).toBeTruthy()
    change(choice, 'careful')
    expect(actions.editPolicy).toHaveBeenCalledExactlyOnceWith('conservativeCandidateId', 'careful')
  })

  it('shows model catalog loading, partial failures, empty results and safe retry errors', () => {
    const { open, store, actions } = fixture({ catalogStatus: 'loading' })
    open()
    expect(screen.getByRole('status')).toHaveProperty('textContent', en.autoRoutingLoading)
    expect(screen.getByRole('button', { name: en.autoRoutingRetry })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.autoRoutingConservative)).toHaveProperty('disabled', false)
    act(() => { store.set({ ...store.getSnapshot(), catalogStatus: 'error' }) })
    expect(screen.getByRole('alert')).toHaveProperty('textContent', en.autoRoutingLoadFailed)
    fireEvent.click(screen.getByRole('button', { name: en.autoRoutingRetry }))
    expect(actions.retryCatalog).toHaveBeenCalledOnce()
    act(() => { store.set({ ...store.getSnapshot(), catalogStatus: 'ready', catalogPartial: true }) })
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toHaveProperty('textContent', en.autoRoutingPartial)
    act(() => { store.set({ ...store.getSnapshot(), models: [], catalogPartial: false, draft: autoRoutingDraft({ enabled: false }) }) })
    expect(screen.getByText(en.autoRoutingEmpty)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.autoRoutingAddCandidate })).toHaveProperty('disabled', false)
    expect(screen.getByLabelText(en.autoRoutingModel)).toHaveProperty('value', autoRoutingModelKey({ provider: '', model: '' }))
    expect(screen.getByLabelText(en.autoRoutingEffort)).toHaveProperty('value', '')
    expect(screen.getByLabelText(en.autoRoutingConservative)).toHaveProperty('value', '')
  })

  it.each(['readonly', 'saving'] as const)('disables all editable fields and mutation actions while %s', (mode) => {
    const { open, container } = fixture({ dirty: true, writable: mode !== 'readonly', invalid: mode === 'readonly', saving: mode === 'saving' })
    open()
    expect(screen.getByRole('switch', { name: en.autoRoutingEnabled })).toHaveProperty('disabled', true)
    for (const control of container.querySelectorAll('input, select')) expect(control).toHaveProperty('disabled', true)
    for (const label of [en.autoRoutingAddCandidate, en.autoRoutingSuggestions, en.autoRoutingReset, en.autoRoutingRetry]) {
      expect(screen.getByRole('button', { name: label })).toHaveProperty('disabled', true)
    }
    for (const button of screen.getAllByRole('button', { name: en.autoRoutingRemoveCandidate })) expect(button).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: mode === 'saving' ? en.saving : en.save })).toHaveProperty('disabled', true)
    if (mode === 'readonly') expect(screen.getByText(en.readOnly)).toBeTruthy()
    else expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', true)
  })

  it('shows conflicts and safe save failures without erasing editable drafts', () => {
    const { open, actions } = fixture({ dirty: true, invalid: true, conflicted: true, failed: true })
    open()
    expect(screen.getByText(en.autoRoutingConflict)).toBeTruthy()
    expect(screen.getByText(en.saveFailed)).toBeTruthy()
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByLabelText(en.autoRoutingMinConfidence)).toHaveProperty('disabled', false)
    fireEvent.click(screen.getByRole('button', { name: en.discard }))
    expect(actions.discard).toHaveBeenCalledOnce()
  })

  it.each(errorCases)('localizes validation code %s and blocks saving', (error, key) => {
    const { open } = fixture({ dirty: true, invalid: true, error })
    open()
    expect(screen.getByRole('alert')).toHaveProperty('textContent', en[key])
    expect(screen.getByRole('button', { name: en.save })).toHaveProperty('disabled', true)
    expect(screen.getByRole('button', { name: en.discard })).toHaveProperty('disabled', false)
  })

  it('renders Chinese labels, accessibility names, statuses, and every validation diagnostic', () => {
    const { open, store } = fixture({ dirty: true, invalid: true, error: 'required', catalogStatus: 'error', conflicted: true, resetPending: true }, zh)
    open()
    expect(screen.getByRole('switch', { name: zh.autoRoutingEnabled })).toBeTruthy()
    expect(screen.getByRole('group', { name: zh.autoRoutingClassifier })).toBeTruthy()
    expect(screen.getByRole('combobox', { name: `${zh.autoRoutingBalanced} / ${zh.autoRoutingComplex}` })).toBeTruthy()
    expect(screen.getByLabelText(zh.autoRoutingMaxInputBytes)).toBeTruthy()
    expect(screen.getByText(zh.autoRoutingScopeHint)).toBeTruthy()
    expect(screen.getByText(zh.autoRoutingSafetyHint)).toBeTruthy()
    expect(screen.getByText(zh.autoRoutingWeightsHint)).toBeTruthy()
    expect(screen.getByText(zh.autoRoutingConflict)).toBeTruthy()
    expect(screen.getByText(zh.autoRoutingResetPending)).toBeTruthy()
    expect(screen.getByText(zh.autoRoutingLoadFailed)).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.autoRoutingRetry })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.autoRoutingSuggestions })).toBeTruthy()
    expect(screen.getByRole('button', { name: zh.autoRoutingReset })).toBeTruthy()
    for (const [error, key] of errorCases) {
      act(() => { store.set({ ...store.getSnapshot(), error }) })
      expect(screen.getByText(zh[key])).toBeTruthy()
      expect(zh[key]).not.toBe(en[key])
    }
    expect(screen.queryByText(en.autoRoutingTitle)).toBeNull()
  })
})
