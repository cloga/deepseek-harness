/** Own command settlement and cancellation without replacing the profile transaction authority. */
import { randomUUID } from 'node:crypto'
import type { DesktopPackageCommandOrigin } from './profile-package-staging.ts'
import type {
  DesktopPluginCommandEvent, DesktopPluginCommandListRow, DesktopPluginCommandOperation, DesktopPluginCommandResponse,
} from './desktop-plugin-command-protocol.ts'

/** Exact child reply surface; no renderer or enumerated process can act as a Host. */
export interface DesktopPluginCommandHost {
  pluginCommandResponse(requestId: number, result: DesktopPluginCommandResponse): Promise<void>
}

/** Shell-only capability passed to one activation call, never exposed through IPC or pending records. */
export interface DesktopPluginCommandActivation {
  readonly transactionId: string
  readonly origin: DesktopPackageCommandOrigin
  readonly signal: AbortSignal
  /** Recheck the persisted origin immediately before confirmation and admission. */
  authorize(origin: DesktopPackageCommandOrigin, transactionId: string): void
  /** Drop cancellation routing only when an admitted activation intentionally stops its Host. */
  interrupt(): void
}

/** Fixed shell services; preparation must remain data-only and activation owns native consent. */
export interface DesktopPluginCommandCoordinatorOptions {
  available(): boolean
  busy(): boolean
  list(): Promise<readonly DesktopPluginCommandListRow[]>
  stage(transactionId: string, operation: Exclude<DesktopPluginCommandOperation, { readonly type: 'list' }>,
    origin: DesktopPackageCommandOrigin, signal: AbortSignal): Promise<{ readonly transactionId: string }>
  discard(transactionId: string): Promise<void>
  activate(authority: DesktopPluginCommandActivation): Promise<void>
  /** Diagnostics are not command transcript text. */
  report(error: unknown): void
}

interface HostGeneration { readonly host: DesktopPluginCommandHost; readonly id: string; lastRequestId: number }
interface PendingCommand {
  readonly owner: HostGeneration
  readonly origin: DesktopPackageCommandOrigin
  readonly transactionId: string
  readonly abort: AbortController
  readonly settlement: PromiseWithResolvers<undefined>
  prepared: boolean
  acknowledged: boolean
  interrupted: boolean
}

/** One shell-owned command coordinator, independent of Host replacement and the package staging engine. */
export class DesktopPluginCommandCoordinator {
  private current: HostGeneration | undefined
  private readonly pending = new Map<number, PendingCommand>()
  private readonly work = new Set<Promise<void>>()
  private readonly cleanupFailures: unknown[] = []
  private disposed = false

  constructor(private readonly options: DesktopPluginCommandCoordinatorOptions) {}

  /** @param host - Newly constructed exact Host child. Previous requests are cancelled, never transferred. */
  bind(host: DesktopPluginCommandHost): void {
    if (this.disposed) throw new Error('Desktop command coordinator is disposed')
    this.cancel(new Error('Desktop command Host replaced'))
    this.current = { host, id: randomUUID(), lastRequestId: 0 }
  }

  /** @param host - Failed or disconnected child. Other generations are unaffected. */
  close(host: DesktopPluginCommandHost): void {
    for (const state of this.pending.values()) {
      if (state.owner.host === host) state.abort.abort(new Error('Desktop command Host disconnected'))
    }
    if (this.current?.host === host) this.current = undefined
  }

  /** @param reason - Shell-owned quit, update or recovery reason. Admitted interruption retains its activation owner. */
  cancel(reason: Error): void {
    for (const state of this.pending.values()) state.abort.abort(reason)
  }

  /** Await all owned preparation/discard work; an admitted activation retains its existing transaction lifetime. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.cancel(new Error('Desktop command coordinator disposed'))
    this.current = undefined
    await Promise.allSettled([...this.work])
    if (this.cleanupFailures.length > 0) throw new AggregateError(this.cleanupFailures, 'Desktop command preparation cleanup failed')
  }

  /** @param host - Exact child identified by its transport. @param event - Validated closed command message. */
  handle(host: DesktopPluginCommandHost, event: DesktopPluginCommandEvent): void {
    const owner = this.current
    if (this.disposed || owner?.host !== host) return
    if (event.type === 'plugin-command-cancel') {
      this.pending.get(event.requestId)?.abort.abort(new Error('Desktop plugin command cancelled'))
      return
    }
    if (event.type === 'plugin-command-settled') {
      const state = this.pending.get(event.requestId)
      if (state?.owner === owner && state.prepared && state.origin.commandId === event.commandId && !state.abort.signal.aborted) {
        state.acknowledged = true
        state.settlement.resolve(undefined)
      }
      return
    }
    if (event.requestId <= owner.lastRequestId) {
      this.track(this.reply(host, event.requestId, { kind: 'error', code: 'stale' }))
      return
    }
    owner.lastRequestId = event.requestId
    if (!this.options.available()) {
      this.track(this.reply(host, event.requestId, { kind: 'error', code: 'unavailable' }))
      return
    }
    if (this.options.busy() || this.pending.size > 0 || this.cleanupFailures.length > 0) {
      this.track(this.reply(host, event.requestId, { kind: 'error', code: 'busy' }))
      return
    }
    if (event.operation.type === 'list') {
      this.track((async () => {
        try {
          const plugins = await this.options.list()
          if (this.current === owner && !this.disposed) await this.reply(host, event.requestId, { kind: 'list', plugins })
        } catch (error) {
          this.report(error)
          if (this.current === owner && !this.disposed) await this.reply(host, event.requestId, { kind: 'error', code: 'failed' })
        }
      })())
      return
    }
    const state: PendingCommand = {
      owner, transactionId: randomUUID(), abort: new AbortController(), settlement: Promise.withResolvers<undefined>(),
      origin: Object.freeze({ kind: 'desktop-command', generation: owner.id, requestId: event.requestId, commandId: event.commandId }),
      prepared: false, acknowledged: false, interrupted: false,
    }
    this.pending.set(event.requestId, state)
    this.track(this.execute(state, event.operation))
  }

  private report(error: unknown): void {
    try { this.options.report(error) } catch (_reportFailure) { /* Reporting never replaces owned settlement or cleanup. */ }
  }

  private track(work: Promise<void>): void {
    this.work.add(work)
    void work.catch((error: unknown) => { this.report(error) }).finally(() => { this.work.delete(work) })
  }

  private async reply(host: DesktopPluginCommandHost, id: number, result: DesktopPluginCommandResponse): Promise<void> {
    try { await host.pluginCommandResponse(id, result) } catch (error) { this.report(error) }
  }

  private assertCurrent(state: PendingCommand): void {
    state.abort.signal.throwIfAborted()
    if (this.disposed || this.current !== state.owner || this.pending.get(state.origin.requestId) !== state) {
      throw new Error('Desktop plugin command no longer owns this Host generation')
    }
  }

  private async waitForSettlement(state: PendingCommand): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    let rejectAbort: ((error: unknown) => void) | undefined
    const onAbort = (): void => { rejectAbort?.(state.abort.signal.reason) }
    try {
      await Promise.race([
        state.settlement.promise,
        new Promise<never>((_resolve, reject) => {
          rejectAbort = reject
          state.abort.signal.addEventListener('abort', onAbort, { once: true })
          if (state.abort.signal.aborted) onAbort()
        }),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => { reject(new Error('Desktop plugin command settlement timed out')) }, 10_000)
          timer.unref()
        }),
      ])
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      state.abort.signal.removeEventListener('abort', onAbort)
    }
  }

  private async execute(state: PendingCommand, operation: Exclude<DesktopPluginCommandOperation, { readonly type: 'list' }>): Promise<void> {
    try {
      this.assertCurrent(state)
      const prepared = await this.options.stage(state.transactionId, operation, state.origin, state.abort.signal)
      this.assertCurrent(state)
      if (prepared.transactionId !== state.transactionId) throw new Error('Desktop command preparation returned another transaction')
      state.prepared = true
      // A failed send is a failed preparation handoff, not permission to wait for a forged acknowledgement.
      await state.owner.host.pluginCommandResponse(state.origin.requestId, { kind: 'prepared' })
      await this.waitForSettlement(state)
      this.assertCurrent(state)
      const authority: DesktopPluginCommandActivation = Object.freeze({
        transactionId: state.transactionId, origin: state.origin, signal: state.abort.signal,
        authorize: (origin: DesktopPackageCommandOrigin, transactionId: string): void => {
          this.assertCurrent(state)
          // Persisted/untyped callers must still pass the runtime discriminator check.
          const originKind: unknown = origin.kind
          if (!state.acknowledged || transactionId !== state.transactionId || originKind !== state.origin.kind
            || origin.generation !== state.origin.generation || origin.commandId !== state.origin.commandId
            || origin.requestId !== state.origin.requestId) throw new Error('Desktop command activation authority does not match its prepared origin')
        },
        interrupt: (): void => {
          this.assertCurrent(state)
          if (!state.acknowledged) throw new Error('Desktop command cannot interrupt before durable settlement')
          state.interrupted = true
          this.pending.delete(state.origin.requestId)
        },
      })
      await this.options.activate(authority)
    } catch (error) {
      if (!state.abort.signal.aborted) this.report(error)
      if (!state.prepared && this.current === state.owner && !this.disposed && !state.abort.signal.aborted) {
        await this.reply(state.owner.host, state.origin.requestId, { kind: 'error', code: 'failed' })
      }
    } finally {
      if (!state.interrupted) {
        try { await this.options.discard(state.transactionId) } catch (error) { this.cleanupFailures.push(error); this.report(error) }
      }
      if (this.pending.get(state.origin.requestId) === state) this.pending.delete(state.origin.requestId)
    }
  }
}
