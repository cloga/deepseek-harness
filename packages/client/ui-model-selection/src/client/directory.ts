/**
 * Per-session model directory: the ONE state both selection entries share.
 * The /model popup and composer seat combine one shared Host catalog with the
 * Session's durable selection projection, then submit through the same
 * selectModel call. A switch made in either entry updates this shared state.
 */
import type {
  ModelCatalogFailure, ModelProviderGroup, ModelSelection, ModelSelectionProjection, ModelRoutingMode, ModelRoutingView,
} from '@deepseek-ai/dsh-api-session-controller/types'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import type { TypertClientRemote } from '@deepseek-ai/dsh-typert-protocol'
import type { ObservableSnapshot, SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { ModelCatalogDirectory } from './catalog.ts'

/** Directory snapshot both entries render from. */
export interface ModelDirectoryState {
  /** Effective selection: durable next-request projection, then Host default. */
  current: ModelSelection | null
  /** Separate Auto intent and actual-use evidence, absent before capability discovery. */
  autoRouting?: ModelRoutingView & { available: boolean }
  /**
   * Whether an adapter serves the current selection's provider, as the host reports
   * it — null before the first load, which is NOT the same as blocked. Read
   * this rather than "current matches no group": catalog membership is
   * advisory, so a route serving a model it stopped advertising is missing
   * from the groups yet perfectly usable.
   */
  routable: boolean | null
  /** Successfully loaded provider groups (last good load). */
  groups: readonly ModelProviderGroup[]
  /** Provider-local failures from the last load; usable groups stay usable. */
  failures: readonly ModelCatalogFailure[]
  /** Lifecycle of the in-flight operation. */
  status: 'idle' | 'loading' | 'ready' | 'selecting' | 'error'
  /** Whole-request or selection failure text; null when none. */
  error: string | null
}

/** One session's shared directory controller; disposed with the session scope. */
export class ModelDirectory {
  /** The shared snapshot both entries render from (uSES-safe store). */
  readonly store: SnapshotStore<ModelDirectoryState> = createSnapshotStore<ModelDirectoryState>({
    current: null, routable: null, groups: [], failures: [], status: 'idle', error: null,
  })

  /** Latest selection operation wins; an older response never overwrites a newer one. */
  private generation = 0
  private disposed = false
  private resolved = false
  private readonly unsubscribeCatalog: () => void
  private readonly unsubscribeSelection: () => void
  private readonly unsubscribeRouting: () => void

  /**
   * @param sessions - the session wire face (captured from the plugin's root connection).
   * @param sessionId - the owning session.
   * @param available - whether this session may use Agent-bound model RPCs.
   * @param catalog - Host-generation catalog shared by every Session.
   * @param projected - durable model selection projected from Session history.
   */
  constructor(
    private readonly sessions: Pick<TypertClientRemote['session'], 'selectModel' | 'selectAutoModel'>,
    private readonly sessionId: SessionId,
    private readonly available: () => boolean,
    private readonly catalog: ModelCatalogDirectory,
    private readonly projected: ObservableSnapshot<unknown>,
    private readonly routing: ObservableSnapshot<unknown>,
  ) {
    this.unsubscribeCatalog = catalog.store.subscribe(() => { this.syncInputs() })
    this.unsubscribeSelection = projected.subscribe(() => { this.syncInputs() })
    this.unsubscribeRouting = routing.subscribe(() => { this.syncInputs() })
    this.syncInputs()
  }

  /**
   * Ensure the Host generation's shared advisory catalog is loaded.
   * @returns the fresh directory value.
   */
  async load(): Promise<ModelDirectoryState> {
    this.assertAvailable()
    await this.catalog.load()
    this.syncInputs()
    return this.store.getSnapshot()
  }

  /**
   * Select the complete provider/model/reasoning selection. The durable
   * projection frame updates the shared current; failures surface on the store
   * and throw so each entry's own retry surface engages.
   * @param selection - provider, provider-owned model id, and optional adapter-owned effort.
 */
  async select(selection: ModelSelection): Promise<void> {
    await this.submit(() => this.sessions.selectModel({
      sessionId: this.sessionId,
      provider: selection.provider,
      model: selection.model,
      ...selection.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: selection.reasoningEffort },
    }), 'session.selectModel')
  }

  /**
   * Select Auto intent; the actual route remains a separate durable projection.
   * @param mode - user-selected quality/cost tradeoff.
   * @returns fulfillment after Host acceptance, without predicting a concrete model.
   */
  async selectAuto(mode: ModelRoutingMode): Promise<void> {
    this.assertAvailable()
    if (this.store.getSnapshot().autoRouting?.available !== true) {
      this.store.update((state) => { state.status = 'error'; state.error = 'session/auto-model-unavailable' })
      throw new Error('session/auto-model-unavailable')
    }
    await this.submit(() => this.sessions.selectAutoModel({ sessionId: this.sessionId, mode }), 'session.selectAutoModel')
  }

  private async submit(
    operation: () => Promise<{ readonly ok: true } | { readonly ok: false; readonly error: { code: string; message: string } }>,
    name: string,
  ): Promise<void> {
    this.assertAvailable()
    const generation = ++this.generation
    this.store.update((s) => { s.status = 'selecting'; s.error = null })
    let result: Awaited<ReturnType<typeof operation>>
    try {
      result = await operation()
    } catch (error: unknown) {
      if (!this.disposed && generation === this.generation) {
        this.store.update((state) => {
          state.status = 'error'
          state.error = error instanceof Error ? error.message : String(error)
        })
      }
      throw error
    }
    if (this.disposed || generation !== this.generation) {
      if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
      return
    }
    if (!result.ok) {
      this.store.update((s) => { s.status = 'error'; s.error = `${result.error.code}: ${result.error.message}` })
      throw new Error(`${name} failed: ${result.error.code}: ${result.error.message}`)
    }
    this.store.update((s) => { s.status = 'ready'; s.error = null })
    this.syncInputs()
  }

  /**
   * Invalidate an in-flight selection response from the previous Host generation.
   */
  resetConnected(): void {
    if (this.disposed) return
    ++this.generation
    this.store.update((state) => {
      if (state.status === 'selecting') state.status = 'idle'
      state.error = null
    })
    this.syncInputs()
  }

  /** Scope teardown: late settlements lose write access to the store. */
  dispose(): void {
    this.disposed = true
    this.unsubscribeSelection()
    this.unsubscribeRouting()
    this.unsubscribeCatalog()
  }

  private assertAvailable(): void {
    if (!this.available()) {
      throw new Error('model selection is unavailable for addressed subagent sessions')
    }
  }

  private syncInputs(): void {
    if (this.disposed) return
    const catalog = this.catalog.store.getSnapshot()
    const projected = modelSelectionProjection(this.projected.getSnapshot())
    if (catalog.value === null || projected === undefined) {
      if (this.resolved) {
        this.store.update((state) => {
          state.routable = null
          if (state.autoRouting !== undefined) state.autoRouting.available = false
          state.status = catalog.status === 'error' ? 'error' : 'loading'
          state.error = catalog.error
        })
        return
      }
      this.store.set({
        current: null,
        routable: null,
        groups: [],
        failures: [],
        status: catalog.status === 'error' ? 'error' : 'loading',
        error: catalog.error,
      })
      return
    }
    const routing = modelRoutingProjection(this.routing.getSnapshot())
    const autoRouting = catalog.value.autoRouting === undefined && routing === undefined ? undefined : {
      mode: routing?.mode ?? 'manual' as const,
      lastDecision: routing?.lastDecision ?? null,
      available: catalog.value.autoRouting?.available === true,
    }
    const automatic = autoRouting !== undefined && autoRouting.mode !== 'manual'
    const current = automatic
      ? routing?.lastDecision?.selection ?? projected.lastUsed
      : projected.next ?? catalog.value.default
    this.resolved = true
    this.store.set({
      current,
      ...autoRouting === undefined ? {} : { autoRouting },
      // Auto resolves its route when work starts; an old/default route cannot block the composer.
      routable: automatic || current === null || catalog.status !== 'ready'
        ? null : catalog.value.routableProviders.includes(current.provider),
      groups: catalog.value.groups,
      failures: catalog.value.failures,
      status: this.store.getSnapshot().status === 'selecting' ? 'selecting' : catalog.status,
      error: catalog.error,
    })
  }
}

function modelSelectionProjection(value: unknown): ModelSelectionProjection | undefined {
  return value === undefined ? undefined : value as ModelSelectionProjection
}

function modelRoutingProjection(value: unknown): ModelRoutingView | undefined {
  return value === undefined ? undefined : value as ModelRoutingView
}
