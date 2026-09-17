/** Safe, locale-owned diagnostics for network failures during managed update checks. */
import { en, formatDesktopMessage, type DesktopMessages } from './locale.ts'

/** The update-check operation whose network request failed. */
export type DesktopUpdateNetworkStage = 'release-list' | 'release-tag' | 'manifest-download'

type NetworkReason = 'reset' | 'interrupted' | 'timeout' | 'dns' | 'unreachable' | 'certificate' | 'cancelled' | 'network'
const reasonsByCode = {
  ECONNRESET: 'reset', UND_ERR_SOCKET: 'interrupted',
  ETIMEDOUT: 'timeout', UND_ERR_CONNECT_TIMEOUT: 'timeout', UND_ERR_HEADERS_TIMEOUT: 'timeout', UND_ERR_BODY_TIMEOUT: 'timeout',
  ENOTFOUND: 'dns', EAI_AGAIN: 'dns',
  ENETUNREACH: 'unreachable', EHOSTUNREACH: 'unreachable', ECONNREFUSED: 'unreachable',
  CERT_HAS_EXPIRED: 'certificate', UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'certificate',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'certificate', SELF_SIGNED_CERT_IN_CHAIN: 'certificate',
  ERR_TLS_CERT_ALTNAME_INVALID: 'certificate', CERT_SIGNATURE_FAILURE: 'certificate',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'certificate',
} as const satisfies Record<string, NetworkReason>
type NetworkCode = keyof typeof reasonsByCode
interface NetworkFailure { readonly reason: NetworkReason; readonly code?: NetworkCode }
const stageKeys = { 'release-list': 'updateStageReleaseList', 'release-tag': 'updateStageReleaseTag', 'manifest-download': 'updateStageManifest' } as const
const reasonKeys = {
  reset: 'updateReasonReset', interrupted: 'updateReasonInterrupted', timeout: 'updateReasonTimeout',
  dns: 'updateReasonDns', unreachable: 'updateReasonUnreachable', certificate: 'updateReasonCertificate',
  cancelled: 'updateReasonCancelled', network: 'updateReasonNetwork',
} as const

function networkFailure(error: unknown): NetworkFailure | undefined {
  const seen = new Set<unknown>()
  let current = error, fetchFailed = false
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null && !seen.has(current); depth++) {
    seen.add(current)
    const value = current as { code?: unknown; name?: unknown; message?: unknown; cause?: unknown }
    if (typeof value.code === 'string' && Object.hasOwn(reasonsByCode, value.code)) {
      const code = value.code as NetworkCode
      return { reason: reasonsByCode[code], code }
    }
    if (value.name === 'TimeoutError') return { reason: 'timeout' }
    if (value.name === 'AbortError') return { reason: 'cancelled' }
    if (value.name === 'TypeError' && value.message === 'fetch failed') fetchFailed = true
    current = value.cause
  }
  return fetchFailed ? { reason: 'network' } : undefined
}

function networkMessage(stage: DesktopUpdateNetworkStage, failure: NetworkFailure, messages: DesktopMessages): string {
  return formatDesktopMessage(messages.updateNetworkFailure, {
    stage: messages[stageKeys[stage]], reason: messages[reasonKeys[failure.reason]],
    code: failure.code === undefined ? '' : formatDesktopMessage(messages.updateNetworkCode, { code: failure.code }),
    advice: failure.reason === 'certificate' ? messages.updateCertificateAdvice
      : failure.reason === 'cancelled' ? messages.updateCancelledAdvice : messages.updateNetworkAdvice,
  })
}

class DesktopUpdateNetworkError extends Error {
  constructor(readonly stage: DesktopUpdateNetworkStage, readonly failure: NetworkFailure, cause: unknown) {
    super(networkMessage(stage, failure, en), { cause })
    this.name = 'DesktopUpdateNetworkError'
  }
}

/**
 * Describe a network failure without changing requests, retries or validation errors.
 * @param stage - Operation used in the displayed diagnostic, never a request URL.
 * @param operation - The existing single operation to run unchanged.
 * @returns The original successful result.
 */
export async function withDesktopUpdateNetworkError<T>(stage: DesktopUpdateNetworkStage, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    const failure = networkFailure(error)
    if (failure === undefined) throw error
    throw new DesktopUpdateNetworkError(stage, failure, error)
  }
}

/**
 * Localize known update network errors while preserving other existing diagnostics.
 * @param error - Failure caught by the managed update coordinator.
 * @param messages - The shell's selected complete dictionary.
 * @returns User-facing text; network failures contain no raw error messages or URLs.
 */
export function describeDesktopUpdateError(error: unknown, messages: DesktopMessages = en): string {
  return error instanceof DesktopUpdateNetworkError
    ? networkMessage(error.stage, error.failure, messages)
    : error instanceof Error ? error.message : String(error)
}
