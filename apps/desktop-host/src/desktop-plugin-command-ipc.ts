/** Bounded command control over the owned Electron parent IPC channel; no Fetch or framed transport. */
import type {
  DesktopPluginCommandOperation, DesktopPluginCommandRequest, DesktopPluginCommandResponse,
} from './desktop-plugin-command.ts'

/** Messages emitted only to the owning Electron parent. */
export type DesktopPluginCommandMessage =
  | { readonly type: 'plugin-command-request'; readonly requestId: number; readonly commandId: string; readonly operation: DesktopPluginCommandOperation }
  | { readonly type: 'plugin-command-cancel'; readonly requestId: number }
  | { readonly type: 'plugin-command-settled'; readonly requestId: number; readonly commandId: string }

/** The process entry supplies its exact parent channel; tests use an inert owned port. */
export interface DesktopPluginCommandPort {
  connected(): boolean
  send(message: DesktopPluginCommandMessage): Promise<void>
}

type Reply = {
  readonly type: 'plugin-command-response'
  readonly requestId: number
  readonly result:
    | { readonly kind: 'list'; readonly plugins: readonly { readonly name: string; readonly version: string; readonly enabled: boolean }[] }
    | { readonly kind: 'prepared' }
    | { readonly kind: 'error'; readonly code: 'busy' | 'failed' | 'invalid' | 'stale' | 'unavailable' }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every(key => Object.hasOwn(value, key))
}
function boundedText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value)
}

/**
 * Parse a parent response into owned, minimal leaves before settling a request.
 * @param value - Untrusted process-message data.
 * @returns A validated response; malformed records throw only a fixed diagnostic.
 */
export function parseDesktopPluginCommandResponse(value: unknown): Reply {
  const invalid = (): never => { throw new Error('desktop plugin command: invalid parent response') }
  if (!record(value) || !keys(value, ['type', 'requestId', 'result']) || value.type !== 'plugin-command-response'
    || !Number.isSafeInteger(value.requestId) || Number(value.requestId) < 1 || !record(value.result)) return invalid()
  const requestId = Number(value.requestId)
  const result = value.result
  if (result.kind === 'prepared' && keys(result, ['kind'])) return { type: 'plugin-command-response', requestId, result: { kind: 'prepared' } }
  if (result.kind === 'error' && keys(result, ['kind', 'code'])) {
    switch (result.code) {
      case 'busy': case 'failed': case 'invalid': case 'stale': case 'unavailable':
        return { type: 'plugin-command-response', requestId, result: { kind: 'error', code: result.code } }
      default: return invalid()
    }
  }
  if (result.kind !== 'list' || !keys(result, ['kind', 'plugins']) || !Array.isArray(result.plugins) || result.plugins.length > 4096) return invalid()
  const plugins = Array.from(result.plugins, (item: unknown) => {
    if (!record(item) || !keys(item, ['name', 'version', 'enabled']) || !boundedText(item.name)
      || !boundedText(item.version) || typeof item.enabled !== 'boolean') return invalid()
    return { name: item.name, version: item.version, enabled: item.enabled }
  })
  if (new Set(plugins.map(plugin => plugin.name)).size !== plugins.length) return invalid()
  return { type: 'plugin-command-response', requestId, result: { kind: 'list', plugins } }
}

interface Pending {
  readonly commandId: string
  readonly signal: AbortSignal
  readonly onAbort: () => void
  readonly resolve: (result: DesktopPluginCommandResponse) => void
  readonly reject: (error: unknown) => void
  prepared: boolean
  sent: boolean
  reply?: Reply['result']
}

/** One Host lifetime, with monotonic IDs retained across command-service reactivation. */
export class DesktopPluginCommandIpc {
  private nextRequestId = 0
  private stopped = false
  private readonly pending = new Map<number, Pending>()

  constructor(private readonly port: DesktopPluginCommandPort) {}

  /** Whether parent-channel or Host disposal permanently closed command admission. */
  get closed(): boolean { return this.stopped }

  /** Send through the owned channel, containing asynchronous notification failure without retries. */
  private notify(message: DesktopPluginCommandMessage): void {
    if (!this.port.connected()) return
    try { void this.port.send(message).catch(() => {}) }
    catch (_error) { /* Parent loss cannot prevent local listener/request cleanup. */ }
  }

  private release(requestId: number): Pending | undefined {
    const pending = this.pending.get(requestId)
    if (pending === undefined) return undefined
    this.pending.delete(requestId)
    pending.signal.removeEventListener('abort', pending.onAbort)
    return pending
  }

  /**
   * Send one grammar-validated command and retain cancellation until its prepared lifecycle settles.
   * @param operation - Closed operation produced by the command grammar, never an executable or path.
   * @param commandId - Exact command lifecycle identity.
   * @param signal - The requesting command's cancellation signal.
   * @returns The validated parent result; prepared is not activation or native consent.
   */
  readonly request: DesktopPluginCommandRequest = (operation, commandId, signal) => {
    if (this.stopped || !this.port.connected()) return Promise.reject(new Error('desktop plugin command: parent unavailable'))
    if (!boundedText(commandId) || this.pending.size >= 100 || this.nextRequestId >= Number.MAX_SAFE_INTEGER
      || [...this.pending.values()].some(pending => pending.commandId === commandId)) {
      return Promise.reject(new Error('desktop plugin command: invalid or duplicate request'))
    }
    if (signal.aborted) {
      const reason: unknown = signal.reason
      // Reject immediately with the exact cancellation value, without normalizing it or changing other request timing.
      return new Promise<DesktopPluginCommandResponse>(() => { throw reason })
    }
    const requestId = ++this.nextRequestId
    return new Promise<DesktopPluginCommandResponse>((resolve, reject) => {
      const onAbort = (): void => {
        const pending = this.release(requestId)
        if (pending === undefined) return
        this.notify({ type: 'plugin-command-cancel', requestId })
        pending.reject(signal.reason)
      }
      this.pending.set(requestId, { commandId, signal, onAbort, resolve, reject, prepared: false, sent: false })
      signal.addEventListener('abort', onAbort, { once: true })
      // The signal may have aborted while a custom signal implementation installed the listener.
      if (signal.aborted) { onAbort(); return }
      let sending: Promise<void>
      try { sending = this.port.send({ type: 'plugin-command-request', requestId, commandId, operation }) }
      catch (error) {
        this.release(requestId)?.reject(error)
        this.notify({ type: 'plugin-command-cancel', requestId })
        return
      }
      void sending.then(() => {
        const pending = this.pending.get(requestId)
        if (pending === undefined) return
        pending.sent = true
        this.completeReply(requestId, pending)
      }).catch((error: unknown) => {
        const pending = this.release(requestId)
        if (pending === undefined) return
        this.notify({ type: 'plugin-command-cancel', requestId })
        pending.reject(error)
      })
    })
  }

  /**
   * Accept only this response family from the parent's process-message callback.
   * @param message - Parent IPC payload; other control families remain owned by the Host entry.
   * @returns Whether this command-response family consumed the message.
   */
  receive(message: unknown): boolean {
    if (!record(message) || message.type !== 'plugin-command-response') return false
    if (this.stopped) return true
    let reply: Reply
    try { reply = parseDesktopPluginCommandResponse(message) }
    catch (error) { this.dispose(error instanceof Error ? error : new Error('desktop plugin command: invalid parent response')); return true }
    const pending = this.pending.get(reply.requestId)
    if (pending === undefined || pending.prepared || pending.reply !== undefined) return true
    pending.reply = reply.result
    this.completeReply(reply.requestId, pending)
    return true
  }

  private completeReply(requestId: number, pending: Pending): void {
    const result = pending.reply
    // A reentrant/early parent response cannot bypass a failed local send acknowledgement.
    if (!pending.sent || result === undefined) return
    if (result.kind === 'prepared') {
      pending.prepared = true
      pending.resolve({ type: 'prepared' })
    } else {
      this.release(requestId)
      pending.resolve(result.kind === 'list'
        ? { type: 'list', rows: result.plugins }
        : { type: 'error', code: result.code })
    }
  }

  /**
   * Acknowledge only the runtime's persisted command completion; failures cancel its prepared work.
   * @param commandId - Exact lifecycle ID whose command/done checkpoint settled.
   * @param persisted - True only after the real Session flush succeeded.
   */
  settled(commandId: string, persisted: boolean): void {
    const match = [...this.pending].find(([, pending]) => pending.prepared && pending.commandId === commandId)
    if (match === undefined) return
    const [requestId] = match
    this.release(requestId)
    if (!persisted || this.stopped) {
      this.notify({ type: 'plugin-command-cancel', requestId })
      return
    }
    try {
      void this.port.send({ type: 'plugin-command-settled', requestId, commandId }).catch(() => {
        this.notify({ type: 'plugin-command-cancel', requestId })
      })
    } catch (_error) { this.notify({ type: 'plugin-command-cancel', requestId }) }
  }

  /**
   * Cancel pending work before command-service replacement without reusing request IDs.
   * @param reason - Locally owned lifecycle failure; never included in outgoing control data.
   */
  cancelPending(reason = new Error('desktop plugin command: runtime disposed')): void {
    for (const requestId of [...this.pending.keys()]) {
      const pending = this.release(requestId)
      if (pending === undefined) continue
      this.notify({ type: 'plugin-command-cancel', requestId })
      pending.reject(reason)
    }
  }

  /** @param reason - Host stop or parent loss. Permanently refuse new requests and release every owned listener. */
  dispose(reason = new Error('desktop plugin command: Host stopped')): void {
    if (this.stopped) return
    this.stopped = true
    this.cancelPending(reason)
  }
}
