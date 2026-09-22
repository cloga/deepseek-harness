/** Complete staged Auto JSON, model/effort choices, and revision-fenced settings writes. */

import { describe, expect, it, vi } from 'vitest'
import { autoRoutingSettingsScope, deferred } from './auto-model-routing-test-helpers.client.ts'
import type { ModelProviderGroup, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { AutoModelRoutingCardController } from '../src/client/auto-model-routing-card-controller.ts'
import {
  autoRoutingDraft, autoRoutingModelKey, autoRoutingModelOptions, resolveAutoRoutingDraft,
} from '../src/client/auto-model-routing-form.ts'
import type { AutoRoutingSettings } from '../src/client/auto-model-routing-form.ts'

const GROUPS: readonly ModelProviderGroup[] = [{
  id: 'alpha', name: 'Alpha', models: [
    { id: 'smart', name: 'Smart', reasoning: {
      efforts: [{ id: 'low', name: 'Low' }, { id: 'high', name: 'High' }], defaultEffort: 'low',
    } },
    { id: 'plain', name: 'Plain' },
    { id: 'classifier', name: 'Classifier' },
  ],
}]

function complete(): AutoRoutingSettings {
  return {
    enabled: true,
    policy: {
      candidates: [
        { id: 'economy', selection: { provider: 'alpha', model: 'smart' }, quality: 1, relativeCost: 1 },
        { id: 'strong', selection: { provider: 'alpha', model: 'smart', reasoningEffort: 'high' }, quality: 3, relativeCost: 4 },
      ],
      conservativeCandidateId: 'strong', minConfidence: 0.8,
      qualityFloors: {
        efficiency: { routine: 1, standard: 2, complex: 3 },
        balanced: { routine: 2, standard: 2, complex: 3 },
        intelligence: { routine: 3, standard: 3, complex: 3 },
      },
    },
    classifier: {
      selection: { provider: 'alpha', model: 'classifier' },
      maxInputBytes: 16000, maxOutputTokens: 256, maxOutputBytes: 16000, timeoutMs: 10000,
    },
  }
}

function harness(value: AutoRoutingSettings = { enabled: false }) {
  const host = autoRoutingSettingsScope()
  host.publish({ status: 'ready', writable: true, revision: 3, value, user: value, base: { enabled: false } })
  host.mutate.mockImplementation((ops: readonly SettingsPathOpView[]) => {
    const operation = ops[0]
    const next = operation?.op === 'set' ? operation.value as unknown as AutoRoutingSettings : { enabled: false }
    host.publish({ value: next, user: operation?.op === 'set' ? next : {}, revision: 4 })
    return Promise.resolve()
  })
  const models = vi.fn().mockResolvedValue({ ok: true, value: { groups: GROUPS, failures: [] } })
  const controller = new AutoModelRoutingCardController(host.scope, { remote: { session: { modelCatalog: models } } } as never)
  const face = controller.inject()
  return { host, models, controller, face, state: () => face.hooks.autoModelRoutingCard.getSnapshot() }
}

const modelKey = (model: string) => autoRoutingModelKey({ provider: 'alpha', model })

async function ready(h: ReturnType<typeof harness>): Promise<void> {
  await vi.waitFor(() => { expect(h.state().catalogStatus).toBe('ready') })
}

describe('Auto routing form validation', () => {
  const options = autoRoutingModelOptions(GROUPS, [])

  it('rejects blank confidence and unsupported classifier effort independently of candidate validity', () => {
    const draft = autoRoutingDraft(complete())
    draft.minConfidence = '  '
    expect(resolveAutoRoutingDraft(draft, options)).toEqual({ error: 'confidence' })
    draft.minConfidence = '0.8'
    draft.classifierSelection = { provider: 'alpha', model: 'smart', reasoningEffort: 'unsupported' }
    expect(resolveAutoRoutingDraft(draft, options)).toEqual({ error: 'effort' })
    draft.classifierSelection = { provider: 'alpha', model: 'smart', reasoningEffort: 'low' }
    expect(resolveAutoRoutingDraft(draft, options).settings?.classifier?.selection.reasoningEffort).toBe('low')
  })

  it('keeps missing configuration blank and permits disabled-empty settings only', () => {
    const draft = autoRoutingDraft({ enabled: false })
    expect(draft.budgets).toEqual({ maxInputBytes: '', maxOutputTokens: '', maxOutputBytes: '', timeoutMs: '' })
    expect(draft.candidates).toEqual([])
    expect(resolveAutoRoutingDraft(draft, options)).toEqual({ settings: { enabled: false } })
    draft.enabled = true
    expect(resolveAutoRoutingDraft(draft, options)).toEqual({ error: 'required' })
    draft.enabled = false
    draft.hasClassifier = true
    expect(resolveAutoRoutingDraft(draft, options)).toEqual({ error: 'classifier-route' })
    expect(autoRoutingDraft({ policy: { candidates: 'bad' }, classifier: { selection: null } }).candidates).toEqual([])
  })

  it('allows joint model/effort combinations but rejects duplicate exact triples', () => {
    const draft = autoRoutingDraft(complete())
    expect(resolveAutoRoutingDraft(draft, options)).toEqual({ settings: complete() })
    draft.candidates[1]!.selection = { provider: 'alpha', model: 'smart' }
    expect(resolveAutoRoutingDraft(draft, options)).toEqual({ error: 'duplicate' })
    draft.candidates[1]!.selection = { provider: 'alpha', model: 'smart', reasoningEffort: 'low' }
    expect(resolveAutoRoutingDraft(draft, options).settings?.policy?.candidates).toHaveLength(2)
  })

  it('validates ids, routes, quality, cost and the strongest conservative referent', () => {
    const draft = autoRoutingDraft(complete())
    draft.candidates[1]!.id = 'economy'
    expect(resolveAutoRoutingDraft(draft, options).error).toBe('candidate-id')
    draft.candidates[1]!.id = 'strong'
    draft.candidates[1]!.selection = { provider: '', model: 'smart' }
    expect(resolveAutoRoutingDraft(draft, options).error).toBe('candidate-route')
    draft.candidates[1]!.selection = { provider: 'alpha', model: 'smart', reasoningEffort: 'high' }
    draft.candidates[1]!.quality = '4'
    expect(resolveAutoRoutingDraft(draft, options).error).toBe('quality')
    draft.candidates[1]!.quality = '3'
    for (const cost of ['0', '-1', 'Infinity', '', 'NaN']) {
      draft.candidates[1]!.relativeCost = cost
      expect(resolveAutoRoutingDraft(draft, options).error).toBe('cost')
    }
    draft.candidates[1]!.relativeCost = '4'
    draft.conservativeCandidateId = 'economy'
    expect(resolveAutoRoutingDraft(draft, options).error).toBe('conservative')
    draft.conservativeCandidateId = 'missing'
    expect(resolveAutoRoutingDraft(draft, options).error).toBe('conservative')
  })

  it('validates visible floors, confidence, all positive integer budgets and timer range', () => {
    const draft = autoRoutingDraft(complete())
    draft.qualityFloors.efficiency.routine = ''
    expect(resolveAutoRoutingDraft(draft, options).error).toBe('floors')
    draft.qualityFloors.efficiency.routine = '1'
    draft.minConfidence = '1.1'
    expect(resolveAutoRoutingDraft(draft, options).error).toBe('confidence')
    draft.minConfidence = '0.8'
    for (const field of ['maxInputBytes', 'maxOutputTokens', 'maxOutputBytes', 'timeoutMs'] as const) {
      const original = draft.budgets[field]
      for (const value of ['0', '', '0.5', 'Infinity']) {
        draft.budgets[field] = value
        expect(resolveAutoRoutingDraft(draft, options).error).toBe('budgets')
      }
      draft.budgets[field] = original
    }
    draft.budgets.timeoutMs = '2147483648'
    expect(resolveAutoRoutingDraft(draft, options).error).toBe('budgets')
  })

  it('keeps unavailable saved routes repairable while validating known explicit efforts', () => {
    const draft = autoRoutingDraft(complete())
    draft.candidates[1]!.selection = { provider: 'removed', model: 'old', reasoningEffort: 'old-effort' }
    const retained = autoRoutingModelOptions(GROUPS, draft.candidates.map(candidate => candidate.selection))
    expect(retained.at(-1)).toMatchObject({ provider: 'removed', model: 'old', available: false })
    expect(resolveAutoRoutingDraft(draft, retained).error).toBeUndefined()
    draft.candidates[1]!.selection = { provider: 'alpha', model: 'smart', reasoningEffort: 'unsupported' }
    expect(resolveAutoRoutingDraft(draft, options).error).toBe('effort')
    draft.enabled = false
    expect(resolveAutoRoutingDraft(draft, options).error).toBeUndefined()
  })
})

describe('AutoModelRoutingCardController', () => {
  it('ignores stale candidate keys, removes retained candidates, and preserves classifier effort on unchanged routes', async () => {
    const h = harness(complete())
    try {
      await ready(h)
      const initial = h.state().draft
      h.face.editCandidate('removed-key', 'id', 'ignored')
      h.face.selectCandidateModel('removed-key', modelKey('plain'))
      h.face.selectCandidateEffort('removed-key', 'high')
      expect(h.state().draft).toEqual(initial)
      h.face.selectClassifierEffort('unsupported')
      expect(h.state().draft.classifierSelection).toEqual(initial.classifierSelection)
      h.face.selectClassifierModel(modelKey('smart'))
      h.face.selectClassifierEffort('high')
      h.face.selectClassifierModel(modelKey('smart'))
      expect(h.state().draft.classifierSelection.reasoningEffort).toBe('high')
      h.face.selectClassifierEffort('')
      expect(h.state().draft.classifierSelection).toEqual({ provider: 'alpha', model: 'smart' })
      const removed = h.state().draft.candidates[1]!.key
      h.face.removeCandidate(removed)
      expect(h.state().draft.candidates.map(candidate => candidate.id)).toEqual(['economy'])
      expect(h.state().error).toBe('conservative')
      h.face.save()
      expect(h.host.mutate).not.toHaveBeenCalled()
      h.face.removeCandidate(h.state().draft.candidates[0]!.key)
      expect(h.state().error).toBe('required')
    } finally {
      h.controller.dispose()
    }
  })

  it.each(['resolve', 'reject'] as const)('ignores an old save %s after reconnect without disturbing the new draft', async (settlement) => {
    const h = harness(complete())
    const write = deferred<undefined>()
    try {
      await ready(h)
      h.host.mutate.mockImplementationOnce(() => write.promise)
      h.face.toggleEnabled()
      h.face.save()
      h.controller.resetConnection()
      await ready(h)
      h.face.editPolicy('minConfidence', '0.9')
      const current = h.state()
      if (settlement === 'resolve') write.resolve(undefined)
      else write.reject(new Error('old connection private error'))
      await Promise.allSettled([write.promise])
      await Promise.resolve()
      expect(h.state()).toBe(current)
      expect(h.state()).toMatchObject({ saving: false, failed: false, dirty: true, draft: { minConfidence: '0.9' } })
    } finally {
      write.resolve(undefined)
      h.controller.dispose()
    }
  })

  it('ignores a rejected save after disposal without publishing private diagnostics', async () => {
    const h = harness(complete())
    const write = deferred<undefined>()
    try {
      await ready(h)
      h.host.mutate.mockImplementationOnce(() => write.promise)
      h.face.toggleEnabled()
      h.face.save()
      const pending = h.state()
      h.controller.dispose()
      h.face.discard()
      h.face.retryCatalog()
      write.reject(new Error('disposed private error'))
      await Promise.allSettled([write.promise])
      await Promise.resolve()
      expect(h.state()).toBe(pending)
      expect(h.models).toHaveBeenCalledTimes(1)
    } finally {
      write.resolve(undefined)
      h.controller.dispose()
    }
  })

  it('waits for readiness on refresh and rejects writes without a Host revision', async () => {
    const host = autoRoutingSettingsScope()
    const models = vi.fn().mockResolvedValue({ ok: true, value: { groups: GROUPS, failures: [] } })
    const controller = new AutoModelRoutingCardController(host.scope, { remote: { session: { modelCatalog: models } } } as never)
    const face = controller.inject()
    try {
      controller.refreshCatalog()
      face.retryCatalog()
      expect(models).not.toHaveBeenCalled()
      host.publish({ status: 'ready', writable: true, value: complete() })
      await vi.waitFor(() => { expect(face.hooks.autoModelRoutingCard.getSnapshot().catalogStatus).toBe('ready') })
      face.toggleEnabled()
      face.save()
      expect(face.hooks.autoModelRoutingCard.getSnapshot()).toMatchObject({ conflicted: true, dirty: true, saving: false })
      expect(host.mutate).not.toHaveBeenCalled()
    } finally {
      controller.dispose()
    }
  })

  it('ignores a settings notification already captured when an earlier subscriber disposes the card', () => {
    const host = autoRoutingSettingsScope()
    const dispose = vi.fn<() => void>()
    const unsubscribe = host.scope.subscribe(dispose)
    const models = vi.fn()
    const controller = new AutoModelRoutingCardController(host.scope, { remote: { session: { modelCatalog: models } } } as never)
    dispose.mockImplementation(() => { controller.dispose() })
    const state = controller.inject().hooks.autoModelRoutingCard
    const before = state.getSnapshot()
    try {
      host.publish({ status: 'ready', writable: true, revision: 1, value: complete() })
      expect(state.getSnapshot()).toBe(before)
      expect(models).not.toHaveBeenCalled()
      expect(host.listenerCount()).toBe(1)
    } finally {
      unsubscribe()
      controller.dispose()
    }
  })

  it('stops the remaining publication when the loading snapshot subscriber disposes the card', async () => {
    const host = autoRoutingSettingsScope()
    const models = vi.fn().mockResolvedValue({ ok: true, value: { groups: GROUPS, failures: [] } })
    const controller = new AutoModelRoutingCardController(host.scope, { remote: { session: { modelCatalog: models } } } as never)
    const state = controller.inject().hooks.autoModelRoutingCard
    const observe = vi.fn(() => { controller.dispose() })
    const unsubscribe = state.subscribe(observe)
    try {
      host.publish({ status: 'ready', writable: true, revision: 1, value: complete() })
      const disposed = state.getSnapshot()
      await Promise.resolve()
      expect(disposed.catalogStatus).toBe('loading')
      expect(state.getSnapshot()).toBe(disposed)
      expect(observe).toHaveBeenCalledTimes(1)
      expect(host.listenerCount()).toBe(0)
    } finally {
      unsubscribe()
      controller.dispose()
    }
  })

  it('stages every basic field and writes exact complete settings with the captured revision', async () => {
    const h = harness()
    try {
      await ready(h)
      expect(h.state().draft.budgets.timeoutMs).toBe('')
      h.face.applySuggestions()
      h.face.addCandidate()
      const key = h.state().draft.candidates[0]!.key
      expect(h.state().draft.candidates[0]).toMatchObject({ id: '', quality: '', relativeCost: '', selection: { provider: '', model: '' } })
      h.face.editCandidate(key, 'id', 'strong')
      h.face.selectCandidateModel(key, modelKey('smart'))
      h.face.selectCandidateEffort(key, 'high')
      h.face.editCandidate(key, 'quality', '3')
      h.face.editCandidate(key, 'relativeCost', '2.5')
      h.face.editPolicy('conservativeCandidateId', 'strong')
      h.face.editPolicy('minConfidence', '0.9')
      h.face.editFloor('efficiency', 'standard', '1')
      h.face.selectClassifierModel(modelKey('classifier'))
      h.face.editBudget('timeoutMs', '5000')
      h.face.toggleEnabled()
      expect(h.state()).toMatchObject({ dirty: true, invalid: false })
      expect(h.host.mutate).not.toHaveBeenCalled()
      h.face.save()
      await vi.waitFor(() => { expect(h.state().dirty).toBe(false) })
      const expected: AutoRoutingSettings = {
        enabled: true,
        policy: {
          candidates: [{ id: 'strong', selection: { provider: 'alpha', model: 'smart', reasoningEffort: 'high' }, quality: 3, relativeCost: 2.5 }],
          conservativeCandidateId: 'strong', minConfidence: 0.9,
          qualityFloors: {
            efficiency: { routine: 1, standard: 1, complex: 3 },
            balanced: { routine: 2, standard: 2, complex: 3 },
            intelligence: { routine: 3, standard: 3, complex: 3 },
          },
        },
        classifier: {
          selection: { provider: 'alpha', model: 'classifier' },
          maxInputBytes: 16000, maxOutputTokens: 256, maxOutputBytes: 16000, timeoutMs: 5000,
        },
      }
      expect(h.host.mutate).toHaveBeenCalledExactlyOnceWith([{ op: 'set', path: [], value: expected }], 3)
      expect(h.models).toHaveBeenCalledTimes(1)
    } finally {
      h.controller.dispose()
    }
  })

  it('uses omission for provider-default effort and clears route-owned effort after changing model', async () => {
    const h = harness(complete())
    try {
      await ready(h)
      const key = h.state().draft.candidates[1]!.key
      h.face.selectCandidateEffort(key, '')
      expect(h.state().error).toBe('duplicate')
      h.face.selectCandidateEffort(key, 'unsupported')
      expect(h.state().draft.candidates[1]!.selection).not.toHaveProperty('reasoningEffort')
      h.face.selectCandidateEffort(key, 'high')
      h.face.selectCandidateModel(key, modelKey('smart'))
      expect(h.state().draft.candidates[1]!.selection.reasoningEffort).toBe('high')
      h.face.selectCandidateModel(key, modelKey('plain'))
      expect(h.state().draft.candidates[1]!.selection).toEqual({ provider: 'alpha', model: 'plain' })
      h.face.selectClassifierModel(modelKey('smart'))
      h.face.selectClassifierEffort('high')
      h.face.selectClassifierModel(modelKey('classifier'))
      expect(h.state().draft.classifierSelection).toEqual({ provider: 'alpha', model: 'classifier' })
      h.face.selectCandidateModel(key, 'unknown')
      h.face.selectClassifierModel('unknown')
      expect(h.state().draft.classifierSelection.model).toBe('classifier')
    } finally {
      h.controller.dispose()
    }
  })

  it('retains configuration when disabling and refuses to drop an invalid partial draft', async () => {
    const h = harness(complete())
    try {
      await ready(h)
      h.face.toggleEnabled()
      h.face.save()
      await vi.waitFor(() => { expect(h.state().saving).toBe(false) })
      expect(h.host.mutate).toHaveBeenCalledWith([{ op: 'set', path: [], value: { ...complete(), enabled: false } }], 3)
      h.face.editBudget('timeoutMs', '')
      h.face.save()
      expect(h.state()).toMatchObject({ invalid: true, dirty: true, error: 'budgets' })
      expect(h.host.mutate).toHaveBeenCalledTimes(1)
      h.face.discard()
      expect(h.state().draft.budgets.timeoutMs).toBe('10000')
    } finally {
      h.controller.dispose()
    }
  })

  it('stages reset to the deployment layer and allows discard without any write', async () => {
    const h = harness(complete())
    try {
      await ready(h)
      h.face.reset()
      expect(h.state()).toMatchObject({ resetPending: true, dirty: true, draft: { enabled: false, hasPolicy: false } })
      expect(h.host.mutate).not.toHaveBeenCalled()
      h.face.discard()
      expect(h.state()).toMatchObject({ resetPending: false, dirty: false, draft: { enabled: true } })
      h.face.reset()
      h.face.save()
      await vi.waitFor(() => { expect(h.state().dirty).toBe(false) })
      expect(h.host.mutate).toHaveBeenCalledExactlyOnceWith([{ op: 'unset', path: [] }], 3)
    } finally {
      h.controller.dispose()
    }
  })

  it('fences stale edits, retains them for repair, and clears drafts on connection reset', async () => {
    const h = harness(complete())
    try {
      await ready(h)
      h.face.editPolicy('minConfidence', '0.9')
      h.host.publish({ revision: 4, value: complete() })
      expect(h.state()).toMatchObject({ conflicted: true, invalid: true, dirty: true })
      h.face.save()
      expect(h.host.mutate).not.toHaveBeenCalled()
      h.controller.resetConnection()
      expect(h.state()).toMatchObject({ conflicted: false, dirty: false, draft: { minConfidence: '0.8' } })
      await ready(h)
    } finally {
      h.controller.dispose()
    }
  })

  it('retires a draft already committed by another writer rather than sending it again', async () => {
    const h = harness(complete())
    try {
      await ready(h)
      h.face.toggleEnabled()
      h.host.publish({ revision: 4, value: { ...complete(), enabled: false } })
      expect(h.state()).toMatchObject({ conflicted: false, dirty: false })
      h.face.save()
      expect(h.host.mutate).not.toHaveBeenCalled()
    } finally {
      h.controller.dispose()
    }
  })

  it('retains safe save diagnostics and detects a conflicting recovery read', async () => {
    const h = harness(complete())
    try {
      await ready(h)
      h.host.mutate.mockRejectedValueOnce(new Error('secret-error-text'))
      h.face.toggleEnabled()
      h.face.save()
      await vi.waitFor(() => { expect(h.state().failed).toBe(true) })
      expect(JSON.stringify(h.state())).not.toContain('secret-error-text')
      expect(h.state().dirty).toBe(true)
      h.host.mutate.mockImplementationOnce(() => {
        h.host.publish({ revision: 4, value: complete() })
        return Promise.resolve()
      })
      h.face.save()
      await vi.waitFor(() => { expect(h.state()).toMatchObject({ failed: true, conflicted: true }) })
    } finally {
      h.controller.dispose()
    }
  })

  it('retains saved unavailable choices and draft edits across partial and changing catalogs', async () => {
    const h = harness(complete())
    try {
      await ready(h)
      h.face.editPolicy('minConfidence', '0.9')
      h.models.mockResolvedValueOnce({ ok: true, value: { groups: [], failures: [{ id: 'alpha', name: 'Alpha', message: 'not displayed' }] } })
      h.controller.refreshCatalog()
      await ready(h)
      expect(h.state()).toMatchObject({ dirty: true, catalogPartial: true })
      expect(h.state().models.every(model => !model.available)).toBe(true)
      expect(h.state().draft.minConfidence).toBe('0.9')
      h.models.mockResolvedValueOnce({ ok: true, value: { groups: [{ ...GROUPS[0], models: [{
        id: 'smart', name: 'Smart', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' },
      }] }], failures: [] } })
      h.controller.refreshCatalog()
      await ready(h)
      expect(h.state().models.find(model => model.model === 'smart')?.defaultEffort).toBe('high')
      expect(h.state().draft.candidates[0]!.selection).not.toHaveProperty('reasoningEffort')
      expect(h.state().draft.candidates[1]!.selection.reasoningEffort).toBe('high')
    } finally {
      h.controller.dispose()
    }
  })

  it.each(['resolve', 'reject'] as const)('ignores a late catalog %s after disposal while preserving safe retry errors', async (settlement) => {
    const h = harness()
    try {
      await ready(h)
      h.models.mockRejectedValueOnce(new Error('secret-provider-detail'))
      h.controller.refreshCatalog()
      await vi.waitFor(() => { expect(h.state().catalogStatus).toBe('error') })
      expect(JSON.stringify(h.state())).not.toContain('secret-provider-detail')
      h.face.retryCatalog()
      await ready(h)
      const pending = deferred<unknown>()
      h.models.mockReturnValueOnce(pending.promise)
      h.controller.refreshCatalog()
      const snapshot = h.state()
      h.face.retryCatalog()
      h.controller.dispose()
      if (settlement === 'resolve') {
        pending.resolve({ ok: true, value: { groups: [], failures: [] } })
        await pending.promise
      } else {
        pending.reject(new Error('late provider failure'))
        await expect(pending.promise).rejects.toThrow('late provider failure')
      }
      await Promise.resolve()
      expect(h.state()).toBe(snapshot)
      h.face.toggleEnabled()
      h.face.save()
      h.controller.refreshCatalog()
      h.controller.resetConnection()
      expect(h.host.mutate).not.toHaveBeenCalled()
    } finally {
      h.controller.dispose()
    }
  })

  it('clears a conflict when the user restores the current saved values', async () => {
    const h = harness(complete())
    try {
      await ready(h)
      h.face.editPolicy('minConfidence', '0.9')
      h.host.publish({ revision: 4, value: complete() })
      expect(h.state().conflicted).toBe(true)
      h.face.editPolicy('minConfidence', '0.8')
      expect(h.state()).toMatchObject({ conflicted: false, dirty: false })
      h.face.editPolicy('minConfidence', '0.7')
      h.face.save()
      await vi.waitFor(() => { expect(h.state().dirty).toBe(false) })
      expect(h.host.mutate.mock.calls[0]?.[1]).toBe(4)
    } finally {
      h.controller.dispose()
    }
  })

  it('serializes one pending save and suppresses its settlement after disposal', async () => {
    const h = harness(complete())
    const write = deferred<undefined>()
    try {
      await ready(h)
      h.host.mutate.mockImplementationOnce(() => write.promise)
      h.face.toggleEnabled()
      h.face.save()
      expect(h.state().saving).toBe(true)
      const pending = h.state()
      h.face.toggleEnabled()
      h.face.addCandidate()
      h.face.save()
      h.face.reset()
      h.face.discard()
      expect(h.state()).toBe(pending)
      h.controller.dispose()
      write.resolve(undefined)
      await write.promise
      await Promise.resolve()
      expect(h.state()).toBe(pending)
      expect(h.host.mutate).toHaveBeenCalledTimes(1)
    } finally {
      write.resolve(undefined)
      h.controller.dispose()
    }
  })

  it('loads nothing until the namespace is ready and treats a rejected catalog response safely', async () => {
    const host = autoRoutingSettingsScope()
    const models = vi.fn().mockResolvedValue({ ok: false, error: { message: 'secret-provider-detail' } })
    const controller = new AutoModelRoutingCardController(host.scope, { remote: { session: { modelCatalog: models } } } as never)
    const face = controller.inject()
    try {
      expect(models).not.toHaveBeenCalled()
      face.toggleEnabled()
      face.save()
      expect(host.mutate).not.toHaveBeenCalled()
      host.publish({ status: 'ready', writable: true, revision: 1, value: { enabled: false } })
      await vi.waitFor(() => { expect(face.hooks.autoModelRoutingCard.getSnapshot().catalogStatus).toBe('error') })
      expect(JSON.stringify(face.hooks.autoModelRoutingCard.getSnapshot())).not.toContain('secret-provider-detail')
      controller.dispose()
      host.publish({ value: complete() })
      expect(face.hooks.autoModelRoutingCard.getSnapshot().draft.enabled).toBe(false)
    } finally {
      controller.dispose()
    }
  })

  it('blocks read-only mutations and preserves prior snapshots while editing', async () => {
    const h = harness(complete())
    try {
      await ready(h)
      const prior = h.state()
      h.face.editPolicy('minConfidence', '0.9')
      expect(prior.draft.minConfidence).toBe('0.8')
      h.host.publish({ writable: false })
      h.face.toggleEnabled()
      h.face.addCandidate()
      h.face.reset()
      h.face.save()
      expect(h.state().draft.enabled).toBe(true)
      expect(h.state().draft.candidates).toHaveLength(2)
      expect(h.host.mutate).not.toHaveBeenCalled()
    } finally {
      h.controller.dispose()
    }
  })
})
