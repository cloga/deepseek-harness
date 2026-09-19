/** One revision-fenced draft for delegation limits and user-authored model defaults. */
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelProviderGroup, SettingsPathOpView } from '@deepseek-ai/dsh-api-remotes/client'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import { numberField, type CardActions, type CardFieldState, type CardShell } from './card-form.ts'

/** Exact routes matched once against the direct parent's effective model. */
export interface SubagentModelRule {
  parent: { provider: string; model: string }
  child: { provider: string; model: string }
}
/** Host-owned delegation defaults and live capacity. */
export interface SubagentLimitsSettings {
  maxDepth: number
  maxActiveSubagents: number
  modelRules?: SubagentModelRule[]
}
/** Model-rule draft and dynamic catalog; saved unavailable IDs remain in rows. */
export interface SubagentRulesState {
  supported: boolean
  rows: readonly SubagentModelRule[]
  dirty: boolean
  incomplete: boolean
  duplicate: boolean
  groups: readonly ModelProviderGroup[]
  catalogStatus: 'idle' | 'loading' | 'ready' | 'error'
  catalogPartial: boolean
}
/** Effective values and drafts presented by the shared card. */
export interface SubagentLimitsCardState extends CardShell {
  maxDepth: CardFieldState
  maxActiveSubagents: CardFieldState
  conflicted: boolean
  rules: SubagentRulesState
}
/** Actions and observable state bound by the slot renderer. */
export interface SubagentLimitsCardFace extends CardActions {
  hooks: { subagentLimitsCard: SnapshotStore<SubagentLimitsCardState> }
  /** Append an incomplete draft without selecting a model implicitly. */
  addRule: () => void
  /** Remove a draft row, including an unavailable saved route. */
  removeRule: (index: number) => void
  /** Stage an exact ID; changing a provider clears its dependent model. */
  editRule: (index: number, side: 'parent' | 'child', field: 'provider' | 'model', value: string) => void
  /** Retry the Host's dynamic model directory. */
  retryRulesCatalog: () => void
}
type Limit = 'maxDepth' | 'maxActiveSubagents'
type SubagentWrite = SettingsPathOpView & { path: [Limit | 'modelRules'] }
type Catalog = () => Promise<{ ok: true; value: { groups: readonly ModelProviderGroup[]; failures: readonly unknown[] } } | { ok: false }>
const limits: readonly Limit[] = ['maxDepth', 'maxActiveSubagents']
function copyRules(rows: readonly SubagentModelRule[]): SubagentModelRule[] {
  return rows.map(row => ({ parent: { ...row.parent }, child: { ...row.child } }))
}
function sameRules(a: readonly SubagentModelRule[], b: readonly SubagentModelRule[]): boolean {
  return a.length === b.length && a.every((row, index) => {
    const other = b[index]
    return other !== undefined && row.parent.provider === other.parent.provider && row.parent.model === other.parent.model
      && row.child.provider === other.child.provider && row.child.model === other.child.model
  })
}
/** Owns one atomic subagent namespace mutation, independent of agent model permission. */
export class SubagentLimitsCardController {
  private readonly edits = new Map<Limit, { text: string; clear: boolean }>()
  private draftRules: SubagentModelRule[] | undefined
  private draftRevision: number | undefined
  private hasDraft = false
  private saving = false
  private failed = false
  private conflicted = false
  private supported = false
  private disposed = false
  private generation = 0
  private catalogGeneration = 0
  private groups: readonly ModelProviderGroup[] = []
  private catalogStatus: SubagentRulesState['catalogStatus'] = 'idle'
  private catalogPartial = false
  private readonly store: SnapshotStore<SubagentLimitsCardState>
  private readonly unsubscribe: () => void

  /**
   * @param scope - Host subagent namespace.
   * @param catalog - Host model directory reader.
   */
  constructor(private readonly scope: SettingsScope<SubagentLimitsSettings>, private readonly catalog?: Catalog) {
    this.store = createSnapshotStore(this.projection())
    this.unsubscribe = scope.subscribe(() => {
      if (this.hasDraft && !this.saving) {
        if (!this.store.getSnapshot().dirty) this.clearDraft()
        else if (scope.getSnapshot().revision !== this.draftRevision) this.conflicted = true
      }
      this.publish()
    })
  }
  /** @returns Renderer-bound namespace draft and staged actions. */
  inject(): SubagentLimitsCardFace {
    return {
      hooks: { subagentLimitsCard: this.store },
      edit: (field, text) => { this.editLimit(field, text, false) },
      resetField: (field) => {
        if (!limits.includes(field as Limit)) return
        const base = this.scope.getSnapshot().base as Partial<SubagentLimitsSettings> | undefined
        this.editLimit(field, numberField(field).format(base?.[field as Limit]), true)
      },
      save: () => { void this.save() },
      discard: () => { if (!this.saving && !this.disposed) { this.clearDraft(); this.publish() } },
      addRule: () => { this.editRules((rows) => { rows.push({ parent: { provider: '', model: '' }, child: { provider: '', model: '' } }) }) },
      removeRule: (index) => { this.editRules((rows) => { rows.splice(index, 1) }) },
      editRule: (index, side, field, value) => {
        this.editRules((rows) => {
          const route = rows[index]?.[side]
          if (!route) return
          if (field === 'provider' && route.provider !== value) route.model = ''
          route[field] = value
        })
      },
      retryRulesCatalog: () => { void this.loadCatalog() },
    }
  }
  /** @param supported - Whether the Host schema declares modelRules. */
  setRulesSupported(supported: boolean): void {
    if (this.disposed || this.supported === supported) return
    this.supported = supported
    if (supported && this.catalogStatus === 'idle') void this.loadCatalog()
    this.publish()
  }
  /** Refresh catalog metadata without replacing staged or stored exact IDs. */
  refreshCatalog(): void {
    if (this.disposed) return
    this.catalogGeneration++
    this.catalogStatus = 'idle'
    if (this.supported) void this.loadCatalog()
    else this.publish()
  }
  /** Discard Host-specific drafts and suppress late settlements after reconnect. */
  resetConnection(): void {
    if (this.disposed) return
    this.generation++
    this.saving = false
    this.clearDraft()
    this.groups = []
    this.refreshCatalog()
  }
  /** Release subscriptions and suppress pending catalog/write settlements. */
  dispose(): void {
    this.disposed = true
    this.generation++
    this.catalogGeneration++
    this.unsubscribe()
  }
  private editable(): boolean {
    const snapshot = this.scope.getSnapshot()
    return !this.disposed && !this.saving && snapshot.status === 'ready' && snapshot.writable
  }
  private beginDraft(): void {
    if (!this.hasDraft) { this.hasDraft = true; this.draftRevision = this.scope.getSnapshot().revision }
    this.failed = false
  }
  private editLimit(field: string, text: string, clear: boolean): void {
    if (!this.editable() || !limits.includes(field as Limit)) return
    this.beginDraft()
    this.edits.set(field as Limit, { text, clear })
    this.publish()
  }
  private currentRules(): SubagentModelRule[] { return this.scope.getSnapshot().value?.modelRules ?? [] }
  private editRules(edit: (rows: SubagentModelRule[]) => void): void {
    if (!this.editable() || !this.supported) return
    this.beginDraft()
    const rows = copyRules(this.draftRules ?? this.currentRules())
    edit(rows)
    this.draftRules = rows
    this.releaseCleanDraft()
    this.publish()
  }
  private releaseCleanDraft(): void {
    if (this.edits.size === 0 && this.operations().length === 0) this.clearDraft()
  }
  private clearDraft(): void {
    this.edits.clear()
    this.draftRules = undefined
    this.hasDraft = false
    this.draftRevision = undefined
    this.conflicted = false
    this.failed = false
  }
  private field(field: Limit): CardFieldState {
    const snapshot = this.scope.getSnapshot()
    const edit = this.edits.get(field)
    const text = edit?.text ?? numberField(field).format(snapshot.value?.[field])
    const write = numberField(field).parse(text)
    const value = write?.kind === 'set' ? write.value as number : undefined
    const invalid = edit !== undefined && !edit.clear && (write === undefined
      || (value !== undefined && (!Number.isSafeInteger(value) || Object.is(value, -0) || value < (field === 'maxDepth' ? 0 : 1))))
    return { text, invalid, overridden: edit === undefined
      ? Object.hasOwn(snapshot.user ?? {}, field) : !edit.clear && write?.kind === 'set' }
  }
  private operations(): SubagentWrite[] {
    const snapshot = this.scope.getSnapshot()
    const ops: SubagentWrite[] = []
    for (const field of limits) {
      const edit = this.edits.get(field)
      if (!edit) continue
      const write = numberField(field).parse(edit.text)
      if (edit.clear || write?.kind === 'clear') {
        if (Object.hasOwn(snapshot.user ?? {}, field)) ops.push({ op: 'unset', path: [field] })
      } else if (write?.kind === 'set' && write.value !== snapshot.value?.[field]) {
        ops.push({ op: 'set', path: [field], value: write.value as number })
      }
    }
    if (this.draftRules !== undefined && !sameRules(this.draftRules, this.currentRules())) {
      ops.push({ op: 'set', path: ['modelRules'], value: this.draftRules.map(row => ({
        parent: { provider: row.parent.provider, model: row.parent.model },
        child: { provider: row.child.provider, model: row.child.model },
      })) })
    }
    return ops
  }
  private projection(): SubagentLimitsCardState {
    const snapshot = this.scope.getSnapshot()
    const rows = this.draftRules ?? this.currentRules()
    const keys = rows.map(row => JSON.stringify([row.parent.provider, row.parent.model]))
    const incomplete = rows.some(row => [row.parent.provider, row.parent.model, row.child.provider, row.child.model].some(id => id.trim() === ''))
    const duplicate = new Set(keys).size !== keys.length
    const maxDepth = this.field('maxDepth')
    const maxActiveSubagents = this.field('maxActiveSubagents')
    const rulesDirty = !sameRules(rows, this.currentRules())
    const fieldInvalid = maxDepth.invalid || maxActiveSubagents.invalid
    return {
      available: snapshot.status === 'ready', writable: snapshot.writable,
      dirty: this.operations().length > 0 || fieldInvalid,
      invalid: fieldInvalid || incomplete || duplicate || this.conflicted || (rulesDirty && !this.supported),
      saving: this.saving, failed: this.failed, conflicted: this.conflicted,
      maxDepth, maxActiveSubagents,
      rules: { supported: this.supported, rows, dirty: rulesDirty, incomplete, duplicate,
        groups: this.groups, catalogStatus: this.catalogStatus, catalogPartial: this.catalogPartial },
    }
  }
  private async save(): Promise<void> {
    const state = this.projection()
    if (!this.editable() || !state.dirty || state.invalid) return
    if (this.scope.getSnapshot().revision !== this.draftRevision) { this.conflicted = true; this.publish(); return }
    const ops = this.operations()
    const desiredRules = copyRules(this.draftRules ?? this.currentRules())
    const generation = this.generation
    this.saving = true
    this.failed = false
    this.publish()
    try {
      await this.scope.mutate(ops, this.draftRevision)
    } catch (_error) {
      // A rejected transport or scope subscriber must not strand the staged form in saving.
      if (generation !== this.generation) return
      this.saving = false
      this.failed = true
      this.conflicted = this.scope.getSnapshot().revision !== this.draftRevision
      this.publish()
      return
    }
    if (generation !== this.generation) return
    const snapshot = this.scope.getSnapshot()
    const user = snapshot.user as Record<string, unknown> | undefined
    const landed = ops.every(op => op.op === 'unset' ? !Object.hasOwn(user ?? {}, op.path[0])
      : op.path[0] === 'modelRules' ? sameRules(this.currentRules(), desiredRules)
        : user?.[op.path[0]] === op.value)
    this.saving = false
    if (landed) this.clearDraft()
    else { this.failed = true; this.conflicted = snapshot.revision !== this.draftRevision }
    this.publish()
  }
  private async loadCatalog(): Promise<void> {
    if (this.disposed || !this.supported || !this.catalog || this.catalogStatus === 'loading') return
    const generation = this.catalogGeneration
    this.catalogStatus = 'loading'
    this.catalogPartial = false
    this.publish()
    let result: Awaited<ReturnType<Catalog>>
    try {
      result = await this.catalog()
    } catch (_error) {
      // Keep exact saved routes editable when the directory transport rejects.
      if (generation !== this.catalogGeneration) return
      this.catalogStatus = 'error'
      this.publish()
      return
    }
    if (generation !== this.catalogGeneration) return
    if (result.ok) { this.groups = result.value.groups; this.catalogPartial = result.value.failures.length > 0; this.catalogStatus = 'ready' }
    else this.catalogStatus = 'error'
    this.publish()
  }
  private publish(): void { this.store.set(this.projection()) }
}
