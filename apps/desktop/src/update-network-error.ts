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

const networkDiagnostics = new WeakMap<object, { stage: DesktopUpdateNetworkStage; failure: NetworkFailure }>()

function errorField(error: unknown, field: 'code' | 'name' | 'message' | 'cause'): unknown {
  if (typeof error !== 'object' || error === null) return undefined
  try { return (error as Record<string, unknown>)[field] }
  catch (_error) {
    // Diagnostics must not replace the primary failure with a getter or proxy failure.
    return undefined
  }
}

function networkFailure(error: unknown): NetworkFailure | undefined {
  const seen = new Set<unknown>()
  let current = error, fetchFailed = false
  for (let depth = 0; depth < 5 && typeof current === 'object' && current !== null && !seen.has(current); depth++) {
    seen.add(current)
    const code = errorField(current, 'code')
    if (typeof code === 'string' && Object.hasOwn(reasonsByCode, code)) {
      const knownCode = code as NetworkCode
      return { reason: reasonsByCode[knownCode], code: knownCode }
    }
    const name = errorField(current, 'name')
    if (name === 'TimeoutError') return { reason: 'timeout' }
    if (name === 'AbortError') return { reason: 'cancelled' }
    if (name === 'TypeError' && errorField(current, 'message') === 'fetch failed') fetchFailed = true
    current = errorField(current, 'cause')
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
  constructor(stage: DesktopUpdateNetworkStage, failure: NetworkFailure, cause: unknown) {
    super(networkMessage(stage, failure, en), { cause })
    networkDiagnostics.set(this, { stage, failure })
    // Build-time discovery sanitizers recognize these standard cancellation names.
    const causeName = errorField(cause, 'name')
    this.name = causeName === 'TimeoutError' || causeName === 'AbortError' ? causeName : 'DesktopUpdateNetworkError'
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
 * Return localized technical details only for a network error wrapped by this module.
 * @param error - Failure caught by the managed update coordinator.
 * @param messages - The shell's selected complete dictionary.
 * @returns Safe stage, reason and advice, or undefined for an unclassified failure.
 */
export function desktopUpdateNetworkDetails(error: unknown, messages: DesktopMessages = en): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const diagnostic = networkDiagnostics.get(error)
  return diagnostic === undefined ? undefined : networkMessage(diagnostic.stage, diagnostic.failure, messages)
}

/**
 * Localize known update network errors while preserving readable existing diagnostics.
 * @param error - Failure caught by the managed update coordinator.
 * @param messages - The shell's selected complete dictionary.
 * @returns Diagnostic text; unreadable error fields use the locale's unknown-error text.
 */
export function describeDesktopUpdateError(error: unknown, messages: DesktopMessages = en): string {
  const details = desktopUpdateNetworkDetails(error, messages)
  if (details !== undefined) return details
  try {
    if (!(error instanceof Error)) return String(error)
    const message = errorField(error, 'message')
    return typeof message === 'string' ? message : messages.unknownError
  } catch (_error) {
    // Unknown prototypes and string conversions can themselves throw private diagnostics.
    return messages.unknownError
  }
}
