/** Fixed JSON staging proxy; Electron owns acquisition and survives Host replacement. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import {
  parseProfilePendingChange, parseProfilePreparedChange, parseProfileTransactionId, ProfilePackageCancelledError,
  type ProfilePackageMutation, type ProfilePackageTransactions, type ProfilePreparedPackageChange,
} from '@deepseek-ai/dsh-app-boot'

/**
 * Register the staging proxy before any profile entry can expose plugin management.
 * @param ctx - Boot-preparation owner; its Fiber disposes listeners and pending calls.
 */
export async function provideDesktopPackageTransactions(ctx: Context): Promise<void> {
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>()
  let disposed = false
  const fail = (error: Error): void => {
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(error) }
    pending.clear()
  }
  const receive = (message: unknown): void => {
    if (typeof message !== 'object' || message === null || !('type' in message) || message.type !== 'package-transaction-result') return
    const response = message as Record<string, unknown>
    if (typeof response.rpcId !== 'string') return
    const call = pending.get(response.rpcId)
    if (call === undefined) return
    pending.delete(response.rpcId)
    clearTimeout(call.timer)
    if (response.protocolVersion !== 1) call.reject(new Error('desktop packages: unsupported staging protocol'))
    else if (response.ok === true) call.resolve(response.value)
    else if (response.errorKind === 'cancelled') call.reject(new ProfilePackageCancelledError())
    else call.reject(new Error(typeof response.error === 'string' ? response.error : 'desktop packages: staging request failed'))
  }
  const disconnect = (): void => { disposed = true; fail(new Error('desktop packages: shell disconnected')) }
  ctx.effect(() => {
    process.on('message', receive)
    process.on('disconnect', disconnect)
    return () => {
      disposed = true
      process.off('message', receive)
      process.off('disconnect', disconnect)
      fail(new Error('desktop packages: proxy disposed; query pending status after reconnect'))
    }
  }, 'desktop package staging proxy')

  const call = (operation: 'hello' | 'stage' | 'status' | 'list' | 'cancel' | 'abort', fields: object = {}): Promise<unknown> => {
    const send = process.send?.bind(process)
    if (disposed || !process.connected || send === undefined) return Promise.reject(new Error('desktop packages: shell unavailable'))
    if (pending.size >= 100) return Promise.reject(new Error('desktop packages: too many pending shell requests'))
    const rpcId = randomUUID()
    return new Promise((resolve, reject) => {
      // The boot-time hello must settle before any profile entry mounts. Keep the
      // ten-minute ambiguity window only for real staging writes and status reads.
      const timer = setTimeout(() => {
        pending.delete(rpcId)
        reject(new Error(operation === 'hello'
          ? 'desktop packages: shell staging handshake deadline exceeded'
          : 'desktop packages: response deadline exceeded; query pending status before retrying'))
      }, operation === 'hello' ? 5000 : 600000)
      timer.unref()
      pending.set(rpcId, { resolve, reject, timer })
      send({ type: 'package-transaction', protocolVersion: 1, rpcId, operation, ...fields }, (error) => {
        if (error === null) return
        pending.delete(rpcId)
        clearTimeout(timer)
        reject(error)
      })
    })
  }
  const service: ProfilePackageTransactions = {
    protocolVersion: 1,
    async stage(requestId: string, mutation: ProfilePackageMutation, signal: AbortSignal): Promise<ProfilePreparedPackageChange> {
      parseProfileTransactionId(requestId)
      signal.throwIfAborted()
      let cancellation: Promise<unknown> | undefined
      const abort = (): void => {
        cancellation ??= call('abort', { transactionId: requestId })
        // Settlement is observed below even if stage has already prepared successfully.
        void cancellation.catch(() => {})
      }
      signal.addEventListener('abort', abort, { once: true })
      try {
        const result = parseProfilePreparedChange(await call('stage', { requestId, mutation }))
        if (result.transactionId !== requestId) throw new Error('desktop packages: response identifies another transaction')
        return result
      } finally {
        signal.removeEventListener('abort', abort)
        if (cancellation !== undefined) await cancellation
      }
    },
    async status(transactionId) {
      const result = await call('status', { transactionId: parseProfileTransactionId(transactionId) })
      return result === null ? undefined : parseProfilePendingChange(result)
    },
    async listPending() {
      const result = await call('list')
      if (!Array.isArray(result) || result.length > 100) throw new Error('desktop packages: invalid pending list')
      return result.map(parseProfilePendingChange)
    },
    async cancel(transactionId) { await call('cancel', { transactionId: parseProfileTransactionId(transactionId) }) },
  }
  // Validate the actual shell peer before publishing a capability to the profile tree.
  if (await call('hello') !== 1) throw new Error('desktop packages: unsupported shell staging protocol')
  ctx.provide('profilePackageTransactions', service)
}
