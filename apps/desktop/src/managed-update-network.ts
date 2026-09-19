/** Bounded, credential-free release transfers; retries never include artifact validation. */

import { assertManagedUpdateRedirect } from './managed-update-protocol.ts'

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const TRANSIENT_HTTP = new Set([408, 429, 500, 502, 503, 504])
const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'])
const RESET_CODES = new Set(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET'])

/** Per-attempt deadlines include redirects and the entire body, not just headers. */
export const managedUpdateTransferPolicy = {
  metadata: { totalMs: 60_000, inactivityMs: 15_000 },
  installer: { totalMs: 30 * 60_000, inactivityMs: 60_000 },
} as const

/** Constructor-owned transfer facts, independent of public Error properties. */
interface TransferDiagnostic {
  readonly errorType: 'timeout' | 'network-reset' | 'http' | 'redirect' | 'integrity'
  readonly retryable: boolean
  readonly status?: number
}
const transferDiagnostics = new WeakMap<object, TransferDiagnostic>()

/** Closed diagnostics avoid persisting fetch messages, URLs, headers, or nested causes. */
export class ManagedUpdateTransferError extends Error {
  constructor(
    readonly errorType: TransferDiagnostic['errorType'],
    readonly retryable = false,
    readonly status?: number,
  ) {
    super(`desktop managed update: ${errorType}${status === undefined ? '' : ` HTTP ${String(status)}`}`)
    transferDiagnostics.set(this, Object.freeze({ errorType, retryable, ...(status === undefined ? {} : { status }) }))
  }
}

/**
 * Read immutable facts only for errors constructed by this module, without inspecting unknown prototypes or getters.
 * @param error - Original caught failure.
 * @returns Owned classification, or undefined for any other thrown value.
 */
export function managedUpdateTransferDiagnostic(error: unknown): TransferDiagnostic | undefined {
  return typeof error === 'object' && error !== null ? transferDiagnostics.get(error) : undefined
}

function transferErrorField(error: object, field: 'name' | 'code' | 'cause'): unknown {
  try { return (error as Record<string, unknown>)[field] } catch (_error) {
    // Diagnostic access must not replace the original transfer failure.
    return undefined
  }
}

function classifiedTransferError(error: unknown): unknown {
  if (managedUpdateTransferDiagnostic(error) !== undefined) return error
  let current = error
  const seen = new Set<object>()
  for (let depth = 0; depth < 4; depth++) {
    if (typeof current !== 'object' || current === null || seen.has(current)) break
    seen.add(current)
    const name = transferErrorField(current, 'name')
    if (name === 'TimeoutError') return new ManagedUpdateTransferError('timeout', true)
    const code = transferErrorField(current, 'code')
    if (typeof code === 'string' && TIMEOUT_CODES.has(code)) return new ManagedUpdateTransferError('timeout', true)
    if (typeof code === 'string' && RESET_CODES.has(code)) return new ManagedUpdateTransferError('network-reset', true)
    current = transferErrorField(current, 'cause')
  }
  return error
}

/** Operations required by release transfer attempts and bounded retry backoff. */
export interface ManagedUpdateNetworkOperations {
  fetch(url: string, init: RequestInit): Promise<Response>
  sleep(milliseconds: number): Promise<void>
}

/** A transfer's signal and progress callback remain active until body consumption finishes. */
export interface ManagedUpdateTransfer {
  readonly signal: AbortSignal
  progress(): void
}

/**
 * Fetch and consume an allowlisted release asset with at most three total attempts.
 * @param url - Validated GitHub release asset URL; never a credential-bearing URL.
 * @param kind - Metadata or large-installer deadline policy.
 * @param operations - Fetch and bounded backoff implementation.
 * @param consume - Consume one response; any partial file must be removed before this callback returns an error.
 * @returns The successfully consumed response value.
 */
export async function withManagedUpdateResponse<T>(
  url: string,
  kind: keyof typeof managedUpdateTransferPolicy,
  operations: ManagedUpdateNetworkOperations,
  consume: (response: Response, transfer: ManagedUpdateTransfer) => Promise<T>,
): Promise<T> {
  const policy = managedUpdateTransferPolicy[kind]
  for (let attempt = 1; ; attempt++) {
    const controller = new AbortController()
    const timeout = () => { controller.abort(new ManagedUpdateTransferError('timeout', true)) }
    const total = setTimeout(timeout, policy.totalMs)
    let inactivity = setTimeout(timeout, policy.inactivityMs)
    const progress = () => {
      clearTimeout(inactivity)
      inactivity = setTimeout(timeout, policy.inactivityMs)
    }
    let response: Response | undefined
    let failure: unknown
    try {
      let current = url
      for (let redirects = 0; ; redirects++) {
        response = await operations.fetch(current, {
          method: 'GET', redirect: 'manual', credentials: 'omit', signal: controller.signal,
        })
        controller.signal.throwIfAborted()
        progress()
        if (!REDIRECTS.has(response.status)) break
        const location = response.headers.get('location')
        await response.body?.cancel()
        if (location === null || redirects === 5) throw new ManagedUpdateTransferError('redirect')
        try {
          assertManagedUpdateRedirect(current, location)
        } catch {
          throw new ManagedUpdateTransferError('redirect')
        }
        current = new URL(location, current).href
      }
      if (!response.ok) throw new ManagedUpdateTransferError('http', TRANSIENT_HTTP.has(response.status), response.status)
      return await consume(response, { signal: controller.signal, progress })
    } catch (error) {
      failure = classifiedTransferError(controller.signal.aborted ? controller.signal.reason : error)
    } finally {
      clearTimeout(total)
      clearTimeout(inactivity)
      controller.abort()
      // Readers and pipelines release their locks before returning; cancel unread HTTP/error bodies too.
      if (response?.body !== undefined && response.body !== null && !response.body.locked) {
        await response.body.cancel().catch(() => { /* Failed transport bodies are already closed. */ })
      }
    }
    if (managedUpdateTransferDiagnostic(failure)?.retryable !== true || attempt === 3) throw failure
    await operations.sleep(attempt * 500)
  }
}

/**
 * Read a metadata body with streaming size enforcement and abortable inactivity waits.
 * @param response - Successful response belonging to the active attempt.
 * @param maximum - Maximum permitted bytes.
 * @param transfer - Attempt signal and body-progress callback.
 * @returns The bounded metadata buffer.
 */
export async function readManagedUpdateMetadata(
  response: Response,
  maximum: number,
  transfer: ManagedUpdateTransfer,
): Promise<Buffer> {
  const declared = response.headers.get('content-length')
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > maximum)) {
    throw new ManagedUpdateTransferError('integrity')
  }
  if (response.body === null) throw new ManagedUpdateTransferError('integrity')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  const abort = () => { void reader.cancel(transfer.signal.reason).catch(() => { /* The failed stream is already closed. */ }) }
  transfer.signal.addEventListener('abort', abort, { once: true })
  try {
    for (;;) {
      transfer.signal.throwIfAborted()
      const part = await reader.read()
      transfer.signal.throwIfAborted()
      if (part.done) break
      transfer.progress()
      bytes += part.value.byteLength
      if (bytes > maximum) throw new ManagedUpdateTransferError('integrity')
      chunks.push(part.value)
    }
    return Buffer.concat(chunks)
  } finally {
    transfer.signal.removeEventListener('abort', abort)
    await reader.cancel().catch(() => { /* Transport failure already errored this reader. */ })
    reader.releaseLock()
  }
}
