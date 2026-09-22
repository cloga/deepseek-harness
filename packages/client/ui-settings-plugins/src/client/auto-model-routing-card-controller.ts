/** Revision-fenced Auto configuration editor; all model choices remain user-owned. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { ModelProviderGroup, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { CardShell } from './card-form.ts'
import {
  autoRoutingDraft, autoRoutingModelKey, autoRoutingModelOptions, resolveAutoRoutingDraft,
} from './auto-model-routing-form.ts'
import type {
  AutoRoutingBudget, AutoRoutingComplexity, AutoRoutingDraft, AutoRoutingFormError,
  AutoRoutingMode, AutoRoutingModelOption, AutoRoutingSelection, AutoRoutingSettings,
} from './auto-model-routing-form.ts'

/** Host-owned credential-free settings namespace. */
export const AUTO_MODEL_ROUTING_NS = 'model-routing'

/** Card-owned staged state, never a second owner of Host settings. */
export interface AutoModelRoutingCardState extends CardShell {
  readonly draft: AutoRoutingDraft
  readonly models: readonly AutoRoutingModelOption[]
  readonly catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  readonly catalogPartial: boolean
  readonly conflicted: boolean
  readonly error?: AutoRoutingFormError
  readonly resetPending: boolean
}

/** Plain callbacks plus one private observable bound by the Slot renderer. */
export interface AutoModelRoutingCardFace {
  readonly hooks: { readonly autoModelRoutingCard: SnapshotStore<AutoModelRoutingCardState> }
  readonly toggleEnabled: () => void
  readonly addCandidate: () => void
  readonly removeCandidate: (key: string) => void
  readonly editCandidate: (key: string, field: 'id' | 'quality' | 'relativeCost', text: string) => void
  readonly selectCandidateModel: (key: string, modelKey: string) => void
  readonly selectCandidateEffort: (key: string, effort: string) => void
  readonly editPolicy: (field: 'conservativeCandidateId' | 'minConfidence', text: string) => void
  readonly editFloor: (mode: AutoRoutingMode, complexity: AutoRoutingComplexity, text: string) => void
  readonly selectClassifierModel: (modelKey: string) => void
  readonly selectClassifierEffort: (effort: string) => void
  readonly editBudget: (field: AutoRoutingBudget, text: string) => void
  readonly applySuggestions: () => void
  readonly reset: () => void
  readonly retryCatalog: () => void
  readonly save: () => void
  readonly discard: () => void
}

function signature(draft: AutoRoutingDraft): string {
  return JSON.stringify({
    ...draft,
    candidates: draft.candidates.map(({ key: _key, ...candidate }) => candidate),
  })
}

function withEffort(route: AutoRoutingSelection, effort: string): AutoRoutingSelection {
  return { provider: route.provider, model: route.model, ...effort === '' ? {} : { reasoningEffort: effort } }
}

/** Owns staged edits, catalog refreshes, and atomic settings writes for one card lifetime. */
export class AutoModelRoutingCardController {
  private draft: AutoRoutingDraft | undefined
  private draftRevision: number | undefined
  private resetPending = false
  private nextCandidate = 0
  private groups: readonly ModelProviderGroup[] = []
  private catalogStatus: AutoModelRoutingCardState['catalogStatus'] = 'idle'
  private catalogPartial = false
  private catalogGeneration = 0
  private lifetime = 0
  private disposed = false
  private saving = false
  private failed = false
  private conflicted = false
  private readonly store: SnapshotStore<AutoModelRoutingCardState>
  private readonly unsubscribe: () => void

  /**
   * @param scope - Host settings mirror bound to model-routing.
   * @param ctx - Registration-side Client context exposing the read-only model catalog.
   */
  constructor(private readonly scope: SettingsScope<AutoRoutingSettings>, private readonly ctx: ClientContext) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      if (this.disposed) return
      if (!this.saving && this.draft !== undefined && this.draftRevision !== scope.getSnapshot().revision) {
        if (signature(this.draft) === signature(this.current())) this.clear()
        else this.conflicted = true
      }
      if (scope.getSnapshot().status === 'ready' && this.catalogStatus === 'idle') void this.loadCatalog()
      this.publish()
    })
    if (scope.getSnapshot().status === 'ready') void this.loadCatalog()
  }

  /** Release the settings subscription and invalidate all pending asynchronous settlements. */
  dispose(): void {
    this.disposed = true
    this.lifetime += 1
    this.catalogGeneration += 1
    this.unsubscribe()
  }

  /** @returns Renderer-owned hook source and explicit staged edit callbacks. */
  inject(): AutoModelRoutingCardFace {
    return {
      hooks: { autoModelRoutingCard: this.store },
      toggleEnabled: () => { this.change((draft) => { draft.enabled = !draft.enabled }) },
      addCandidate: () => {
        this.change((draft) => {
          draft.hasPolicy = true
          const key = `new-${String(++this.nextCandidate)}`
          draft.candidates.push({ key, id: '', selection: { provider: '', model: '' }, quality: '', relativeCost: '' })
        })
      },
      removeCandidate: (key) => {
        this.change((draft) => { draft.candidates = draft.candidates.filter(candidate => candidate.key !== key) })
      },
      editCandidate: (key, field, text) => {
        this.change((draft) => {
          const candidate = draft.candidates.find(candidate => candidate.key === key)
          if (candidate !== undefined) candidate[field] = text
        })
      },
      selectCandidateModel: (key, modelKey) => {
        const model = this.model(modelKey)
        if (model === undefined) return
        this.change((draft) => {
          const candidate = draft.candidates.find(candidate => candidate.key === key)
          if (candidate !== undefined && autoRoutingModelKey(candidate.selection) !== model.key) {
            candidate.selection = { provider: model.provider, model: model.model }
          }
        })
      },
      selectCandidateEffort: (key, effort) => {
        this.change((draft) => {
          const candidate = draft.candidates.find(candidate => candidate.key === key)
          if (candidate !== undefined && this.effortAllowed(candidate.selection, effort)) {
            candidate.selection = withEffort(candidate.selection, effort)
          }
        })
      },
      editPolicy: (field, text) => { this.change((draft) => { draft.hasPolicy = true; draft[field] = text }) },
      editFloor: (mode, complexity, text) => {
        this.change((draft) => {
          draft.hasPolicy = true
          draft.qualityFloors[mode][complexity] = text
        })
      },
      selectClassifierModel: (modelKey) => {
        const model = this.model(modelKey)
        if (model === undefined) return
        this.change((draft) => {
          draft.hasClassifier = true
          if (autoRoutingModelKey(draft.classifierSelection) !== model.key) {
            draft.classifierSelection = { provider: model.provider, model: model.model }
          }
        })
      },
      selectClassifierEffort: (effort) => {
        this.change((draft) => {
          if (!this.effortAllowed(draft.classifierSelection, effort)) return
          draft.hasClassifier = true
          draft.classifierSelection = withEffort(draft.classifierSelection, effort)
        })
      },
      editBudget: (field, text) => { this.change((draft) => { draft.hasClassifier = true; draft.budgets[field] = text }) },
      applySuggestions: () => {
        this.change((draft) => {
          draft.hasPolicy = true
          draft.hasClassifier = true
          // Explicit user action stages these visible starting values; no route or quality rank is guessed.
          draft.qualityFloors = {
            efficiency: { routine: '1', standard: '2', complex: '3' },
            balanced: { routine: '2', standard: '2', complex: '3' },
            intelligence: { routine: '3', standard: '3', complex: '3' },
          }
          draft.minConfidence = '0.8'
          draft.budgets = { maxInputBytes: '16000', maxOutputTokens: '256', maxOutputBytes: '16000', timeoutMs: '10000' }
        })
      },
      reset: () => {
        if (!this.canEdit()) return
        this.captureRevision()
        this.draft = autoRoutingDraft(this.scope.getSnapshot().base)
        this.resetPending = true
        this.failed = false
        this.publish()
      },
      retryCatalog: () => { void this.loadCatalog() },
      save: () => { void this.save() },
      discard: () => {
        if (this.disposed || this.saving) return
        this.clear()
        this.publish()
      },
    }
  }

  /** Refresh directory metadata without replacing a staged policy. */
  refreshCatalog(): void {
    if (this.disposed) return
    this.catalogGeneration += 1
    this.catalogStatus = 'idle'
    this.catalogPartial = false
    if (this.scope.getSnapshot().status === 'ready') void this.loadCatalog()
    else this.publish()
  }

  /** Host revisions are generation-local; discard drafts and stale catalog work on reconnect. */
  resetConnection(): void {
    if (this.disposed) return
    this.lifetime += 1
    this.saving = false
    this.clear()
    this.groups = []
    this.refreshCatalog()
  }

  private current(): AutoRoutingDraft {
    return autoRoutingDraft(this.scope.getSnapshot().value)
  }

  private models(): AutoRoutingModelOption[] {
    const current = this.current()
    const draft = this.draft ?? current
    return autoRoutingModelOptions(this.groups, [
      ...current.candidates.map(candidate => candidate.selection), current.classifierSelection,
      ...draft.candidates.map(candidate => candidate.selection), draft.classifierSelection,
    ])
  }

  private model(key: string): AutoRoutingModelOption | undefined {
    return this.models().find(model => model.key === key)
  }

  private effortAllowed(route: AutoRoutingSelection, effort: string): boolean {
    return effort === '' || this.model(autoRoutingModelKey(route))?.efforts.some(option => option.id === effort) === true
  }

  private canEdit(): boolean {
    const snapshot = this.scope.getSnapshot()
    return !this.disposed && !this.saving && snapshot.status === 'ready' && snapshot.writable
  }

  private captureRevision(): void {
    if (this.draft === undefined) this.draftRevision = this.scope.getSnapshot().revision
  }

  private change(edit: (draft: AutoRoutingDraft) => void): void {
    if (!this.canEdit()) return
    this.captureRevision()
    const draft = structuredClone(this.draft ?? this.current())
    edit(draft)
    if (signature(draft) === signature(this.current())) this.clear()
    else {
      this.draft = draft
      this.resetPending = false
      this.failed = false
    }
    this.publish()
  }

  private clear(): void {
    this.draft = undefined
    this.draftRevision = undefined
    this.resetPending = false
    this.failed = false
    this.conflicted = false
  }

  private projection(): AutoModelRoutingCardState {
    const snapshot = this.scope.getSnapshot()
    const current = this.current()
    const draft = this.draft ?? current
    const models = this.models()
    const resolved = resolveAutoRoutingDraft(draft, models)
    return {
      available: snapshot.status === 'ready', writable: snapshot.writable,
      dirty: this.resetPending || signature(draft) !== signature(current),
      invalid: resolved.error !== undefined || this.conflicted || !snapshot.writable,
      saving: this.saving, failed: this.failed, draft, models,
      catalogStatus: this.catalogStatus, catalogPartial: this.catalogPartial,
      conflicted: this.conflicted, resetPending: this.resetPending,
      ...resolved.error === undefined ? {} : { error: resolved.error },
    }
  }

  private publish(): void {
    if (!this.disposed) this.store.set(this.projection())
  }

  /** Re-read lifecycle and directory generation at the asynchronous settlement point. */
  private catalogIsCurrent(generation: number): boolean {
    return !this.disposed && generation === this.catalogGeneration
  }

  private async loadCatalog(): Promise<void> {
    if (this.disposed || this.catalogStatus === 'loading' || this.scope.getSnapshot().status !== 'ready') return
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.publish()
    try {
      const response = await this.ctx.remote.session.modelCatalog()
      if (!this.catalogIsCurrent(generation)) return
      if (response.ok) {
        this.groups = response.value.groups
        this.catalogPartial = response.value.failures.length > 0
        this.catalogStatus = 'ready'
      } else this.catalogStatus = 'error'
    } catch (_error: unknown) {
      // Provider and transport messages may expose connection details; the card uses safe locale copy.
      if (!this.catalogIsCurrent(generation)) return
      this.catalogStatus = 'error'
    }
    this.publish()
  }

  private async save(): Promise<void> {
    if (!this.canEdit()) return
    const state = this.projection()
    if (!state.dirty || state.invalid) return
    const snapshot = this.scope.getSnapshot()
    if (snapshot.revision === undefined || snapshot.revision !== this.draftRevision) {
      this.conflicted = true
      this.publish()
      return
    }
    const resolved = resolveAutoRoutingDraft(state.draft, state.models)
    if (resolved.settings === undefined) return
    const expected = JSON.stringify(resolved.settings)
    const ops: SettingsPathOpView[] = this.resetPending ? [{ op: 'unset', path: [] }] : [{
      op: 'set', path: [],
      // The form resolver constructs only credential-free JSON fields and arrays.
      value: resolved.settings as unknown as Extract<SettingsPathOpView, { op: 'set' }>['value'],
    }]
    const generation = this.lifetime
    this.saving = true
    this.failed = false
    this.publish()
    try {
      await this.scope.mutate(ops, this.draftRevision)
    } catch (_error: unknown) {
      // SettingsScope normally reports through its mirror; custom scopes may reject without safe text.
      if (this.disposed || generation !== this.lifetime) return
      this.failed = true
    }
    if (this.disposed || generation !== this.lifetime) return
    this.saving = false
    const landed = resolveAutoRoutingDraft(this.current(), [])
    if (!this.failed && landed.settings !== undefined && JSON.stringify(landed.settings) === expected) this.clear()
    else {
      this.failed = true
      this.conflicted = this.scope.getSnapshot().revision !== this.draftRevision
    }
    this.publish()
  }
}
