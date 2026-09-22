/** Failure-only, content-free startup evidence for an already owned installed Desktop. */
export type StartupFailureCategory = 'unknown' | 'module-resolution' | 'native-addon' | 'missing-file' | 'permission' | 'tls' | 'http' | 'network' | 'timeout'

/** Owned scalar projection, never the bridge's backend message or a DOM/Window object. */
export interface InstalledStartupObservation {
  document: 'baseline-app' | 'candidate-app' | 'startup' | 'other'
  bridgeAvailable: boolean | null
  phase: 'starting' | 'ready' | 'error' | 'unavailable' | 'unknown'
  profileRecovery: boolean | null
  backendCategory: StartupFailureCategory
  backendHttpStatus: number | null
  backendMessageTruncated: boolean
  errorPresent: boolean | null
  errorVisible: boolean | null
  errorNonempty: boolean | null
  errorCategory: StartupFailureCategory
  errorMessageTruncated: boolean
  busy: boolean | null
  diagnosticFailures: string[]
}

/**
 * Serialized renderer callback; all runtime helpers are local methods, without imports or captured loader helpers.
 * Only the existing read-only backend.status bridge may be invoked, on a recognized owned document.
 * @returns Bounded scalar evidence; raw messages, URLs, paths and arbitrary errors never leave the renderer.
 */
export async function inspectInstalledStartup(): Promise<InstalledStartupObservation> {
  const result: InstalledStartupObservation = {
    document: 'other', bridgeAvailable: null, phase: 'unavailable', profileRecovery: null,
    backendCategory: 'unknown', backendHttpStatus: null, backendMessageTruncated: false,
    errorPresent: null, errorVisible: null, errorNonempty: null, errorCategory: 'unknown', errorMessageTruncated: false,
    busy: null, diagnosticFailures: [],
  }
  // Method syntax remains self-contained under the actual tsx keepNames transform.
  const helpers = {
    classify(message: unknown): { category: StartupFailureCategory; httpStatus: number | null; truncated: boolean } {
      const text = typeof message === 'string' ? message.slice(0, 4096) : ''
      let category: StartupFailureCategory = 'unknown'
      let httpStatus: number | null = null
      const http = /\b(?:GitHub request failed with (?:HTTP )?|HTTP (?:status )?|ERR_PNPM_FETCH_)([1-5]\d{2})\b/u.exec(text)
      if (/\b(?:ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|ERR_PACKAGE_PATH_NOT_EXPORTED|ERR_PACKAGE_IMPORT_NOT_DEFINED)\b|Cannot find (?:package|module)/u.test(text)) category = 'module-resolution'
      else if (/\b(?:ERR_DLOPEN_FAILED|NODE_MODULE_VERSION)\b|Module did not self-register/u.test(text)) category = 'native-addon'
      else if (/\bENOENT\b/u.test(text)) category = 'missing-file'
      else if (/\b(?:EACCES|EPERM)\b/u.test(text)) category = 'permission'
      else if (/\b(?:ERR_TLS_CERT_ALTNAME_INVALID|CERT_HAS_EXPIRED|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)\b/u.test(text)) category = 'tls'
      else if (http !== null) { category = 'http'; httpStatus = Number(http[1]) }
      else if (/\b(?:ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|TimeoutError)\b|timed out/u.test(text)) category = 'timeout'
      else if (/\b(?:ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR_SOCKET)\b/u.test(text)) category = 'network'
      return { category, httpStatus, truncated: typeof message === 'string' && message.length > 4096 }
    },
  }
  try {
    const url = new URL(location.href)
    if (url.protocol === 'dsh-app:' && url.username === '' && url.password === '' && url.port === '') {
      if (url.hostname === 'shell' && url.pathname === '/startup.html') result.document = 'startup'
      if (url.hostname === 'app' && url.pathname === '/index.html') result.document = 'baseline-app'
      if (url.hostname === 'app' && url.pathname === '/') result.document = 'candidate-app'
    }
  } catch { result.diagnosticFailures.push('document-location-unavailable') }
  if (result.document === 'other') return result
  try {
    const error = document.querySelector<HTMLElement>('#error')
    result.errorPresent = error !== null
    result.errorVisible = error !== null && !error.hidden && error.getClientRects().length > 0
    const message = error?.textContent
    const prefix = typeof message === 'string' ? message.slice(0, 4096) : ''
    result.errorNonempty = prefix.trim().length > 0 ? true : typeof message === 'string' && message.length > 4096 ? null : false
    const classified = helpers.classify(message)
    result.errorCategory = classified.category
    result.errorMessageTruncated = classified.truncated
    const busy = document.querySelector('main[aria-busy]')?.getAttribute('aria-busy')
    result.busy = busy === 'true' ? true : busy === 'false' ? false : null
  } catch { result.diagnosticFailures.push('document-state-unavailable') }

  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const bridge: unknown = Reflect.get(window, 'dshDesktop')
    const backend: unknown = typeof bridge === 'object' && bridge !== null ? Reflect.get(bridge, 'backend') : undefined
    const status: unknown = typeof backend === 'object' && backend !== null ? Reflect.get(backend, 'status') : undefined
    result.bridgeAvailable = typeof status === 'function'
    if (typeof status !== 'function') return result
    const read = status as (this: unknown) => unknown
    const response = await Promise.race([
      Promise.resolve().then(() => read.call(backend)).then(value => ({ kind: 'value' as const, value })),
      new Promise<{ kind: 'timeout' }>((resolve) => { timer = setTimeout(() => { resolve({ kind: 'timeout' }) }, 1000) }),
    ])
    if (response.kind === 'timeout') {
      result.phase = 'unknown'
      result.diagnosticFailures.push('backend-status-timeout')
    } else {
      const state = response.value
      const phase: unknown = typeof state === 'object' && state !== null ? Reflect.get(state, 'phase') : undefined
      result.phase = phase === 'starting' || phase === 'ready' || phase === 'error' ? phase : 'unknown'
      if (phase === 'error') {
        const recovery: unknown = Reflect.get(state as object, 'profileRecovery')
        result.profileRecovery = typeof recovery === 'boolean' ? recovery : null
        const classified = helpers.classify(Reflect.get(state as object, 'message'))
        result.backendCategory = classified.category
        result.backendHttpStatus = classified.httpStatus
        result.backendMessageTruncated = classified.truncated
      }
    }
  } catch {
    result.phase = 'unknown'
    result.diagnosticFailures.push('backend-status-unavailable')
  } finally { clearTimeout(timer) }
  return result
}

interface OwnedPage {
  isClosed(): boolean
  evaluate(callback: typeof inspectInstalledStartup): Promise<InstalledStartupObservation>
}
interface OwnedApplication {
  process(): { exitCode: number | null; signalCode: string | null }
}

/** Content-free outer-process exit and renderer diagnostics. */
export interface InstalledStartupReport {
  appExited: boolean | null
  appExitCode: number | null
  pageAvailable: boolean
  observation: InstalledStartupObservation | null
  diagnosticFailures: string[]
}

/**
 * Observe only a failed round's retained app/page; no launch, readiness, recovery or close action is performed.
 * @param app - Application handle already owned by the installed fixture, if launch returned it.
 * @param page - Existing owned page, never a newly opened diagnostic window.
 * @returns Owned data within a separate two-second transport budget; diagnostic failures are fixed categories.
 */
export async function collectInstalledStartupDiagnostics(
  app: OwnedApplication | undefined,
  page: OwnedPage | undefined,
): Promise<InstalledStartupReport> {
  const result: InstalledStartupReport = {
    appExited: null, appExitCode: null, pageAvailable: false, observation: null, diagnosticFailures: [],
  }
  try {
    const child = app?.process()
    if (child !== undefined) {
      const code = child.exitCode
      const signal = child.signalCode
      result.appExitCode = typeof code === 'number' && Number.isInteger(code) ? code : null
      result.appExited = typeof code === 'number' || typeof signal === 'string' ? true : code === null && signal === null ? false : null
    }
  } catch { result.diagnosticFailures.push('app-exit-state-unavailable') }
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    result.pageAvailable = page !== undefined && !page.isClosed()
    if (!result.pageAvailable || page === undefined) return result
    const response = await Promise.race([
      page.evaluate(inspectInstalledStartup).then(value => ({ kind: 'value' as const, value })),
      new Promise<{ kind: 'timeout' }>((resolve) => { timer = setTimeout(() => { resolve({ kind: 'timeout' }) }, 2000) }),
    ])
    if (response.kind === 'value') result.observation = response.value
    else result.diagnosticFailures.push('page-observation-timeout')
  } catch { result.diagnosticFailures.push('page-observation-unavailable') }
  finally { clearTimeout(timer) }
  return result
}
