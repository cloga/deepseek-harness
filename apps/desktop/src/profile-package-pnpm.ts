/** Fixed bundled-pnpm operations; directory packing preserves pnpm's file selection without running hooks. */
import { spawn } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { desktopNodeEnvironment } from './node-environment.ts'

/** Executables selected by the shell, never a package or renderer. */
export interface DesktopPackagePnpmRuntime {
  readonly node: string
  readonly pnpm: string
  readonly nodeBin: string
}

const OBSERVED_ERROR_CODES = ['EPERM', 'EACCES', 'ENOENT', 'ESRCH', 'EPIPE', 'ECONNRESET', 'EINVAL', 'ENOMEM', 'ENOSYS', 'ETIMEDOUT', 'EIO', 'ENOTDIR'] as const
const OBSERVED_SIGNALS = ['SIGTERM', 'SIGKILL', 'SIGINT', 'SIGABRT', 'SIGSEGV', 'SIGHUP', 'SIGBREAK'] as const

/** JavaScript observations of the direct child only, not OS creation time or descendant quiescence. */
export interface DesktopPnpmChildObservation {
  readonly event: 'spawn' | 'error' | 'exit' | 'stdout-close' | 'stderr-close' | 'close' | 'abort-request'
  readonly childPid?: number
  readonly parentPid: number
  readonly ordinal: number
  readonly observedElapsedMs: number
  readonly exitCode?: number | null
  readonly signal?: typeof OBSERVED_SIGNALS[number] | 'OTHER' | null
  readonly errorCode?: typeof OBSERVED_ERROR_CODES[number] | 'OTHER'
}

/**
 * Trusted, bounded synchronous memory collection only; no I/O, timers, promises, or asynchronous work.
 * @param event - Owned closed facts without errors, command lines, environment or paths.
 * @returns Undefined; observer faults cannot replace the operation outcome.
 */
export type DesktopPnpmChildObserver = (event: Readonly<DesktopPnpmChildObservation>) => undefined

function observedErrorCode(error: unknown): NonNullable<DesktopPnpmChildObservation['errorCode']> {
  let code: unknown
  try {
    code = typeof error === 'object' && error !== null ? Reflect.get(error, 'code') : undefined
  } catch (_error) {
    // A diagnostic accessor failure must not replace the original child error.
    return 'OTHER'
  }
  return OBSERVED_ERROR_CODES.find(allowed => allowed === code) ?? 'OTHER'
}

function observedSignal(signal: unknown): NonNullable<DesktopPnpmChildObservation['signal']> | null {
  return signal === null ? null : OBSERVED_SIGNALS.find(allowed => allowed === signal) ?? 'OTHER'
}

/** One bounded-lifetime operation on a caller-owned private working tree. */
export interface DesktopPackagePnpmRequest {
  readonly cwd: string
  readonly args: readonly string[]
  readonly env: Readonly<NodeJS.ProcessEnv>
  readonly signal: AbortSignal
}

/**
 * Run only the supplied bundled package manager and await exit even when aborted.
 * @param runtime - Fixed application-owned executables.
 * @param request - Validated staging or source-pack operation.
 * @param observe - Optional trusted synchronous observer; bounded work does not guarantee a wall-clock deadline.
 * @returns Exit outcome after all owned stdio closes.
 */
export function runDesktopPackagePnpm(
  runtime: DesktopPackagePnpmRuntime, request: DesktopPackagePnpmRequest, observe?: DesktopPnpmChildObserver,
): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    request.signal.throwIfAborted()
    let environment = { ...request.env }
    if (process.platform === 'win32') {
      const entries = Object.entries(environment)
      const path = entries.find(([name]) => name.toUpperCase() === 'PATH')?.[1]
      environment = Object.fromEntries(entries.filter(([name]) => name.toUpperCase() !== 'PATH'))
      if (path !== undefined) environment.PATH = path
    }
    // pnpm 11 recognizes its built-in-only sentinel only at argv[0]; flags must not precede `pm`.
    const args = request.args[0] === 'pm'
      ? ['pm', '--config.update-notifier=false', ...request.args.slice(1)]
      : ['--config.update-notifier=false', ...request.args]
    const observationStart = observe === undefined ? 0 : performance.now()
    const child = spawn(runtime.node, ['--expose-internals', runtime.pnpm, ...args], {
      cwd: request.cwd,
      env: desktopNodeEnvironment(runtime.node, runtime.nodeBin, { ...environment, ELECTRON_RUN_AS_NODE: '1', COREPACK_ENABLE_PROJECT_SPEC: '0', CI: 'true', NO_UPDATE_NOTIFIER: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let observationClosed = false
    let ordinal = 0
    let observedElapsedMs = 0
    const record = (event: DesktopPnpmChildObservation['event'], code?: number | null, signal?: unknown, error?: unknown): void => {
      if (observe === undefined || observationClosed) return
      if (event === 'close') observationClosed = true
      try {
        const elapsed = performance.now() - observationStart
        if (Number.isFinite(elapsed)) observedElapsedMs = Math.max(observedElapsedMs, elapsed)
        const childPid = child.pid
        observe({ event, parentPid: process.pid, ordinal: ++ordinal, observedElapsedMs,
          ...(childPid !== undefined && Number.isSafeInteger(childPid) && childPid > 0 ? { childPid } : {}),
          ...(event === 'exit' || event === 'close' ? {
            exitCode: code !== undefined && code !== null && Number.isSafeInteger(code) ? code : null,
            signal: observedSignal(signal),
          } : {}),
          ...(event === 'abort-request' ? { signal: 'SIGTERM' as const } : {}),
          ...(event === 'error' ? { errorCode: observedErrorCode(error) } : {}),
        })
      } catch (_error) {
        // Observations are best-effort and cannot change error identity or child settlement.
      }
    }
    const onSpawn = (): void => { record('spawn') }
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => { record('exit', code, signal) }
    const onStdoutClose = (): void => { record('stdout-close') }
    const onStderrClose = (): void => { record('stderr-close') }
    if (observe !== undefined) {
      child.once('spawn', onSpawn)
      child.once('exit', onExit)
      child.stdout.once('close', onStdoutClose)
      child.stderr.once('close', onStderrClose)
    }
    let diagnostics = Buffer.alloc(0)
    let truncated = false
    const append = (chunk: Buffer): void => {
      const next = Buffer.concat([diagnostics, chunk])
      if (next.byteLength > 8192) truncated = true
      diagnostics = Buffer.from(next.subarray(Math.max(0, next.byteLength - 8192)))
    }
    child.stdout.on('data', append)
    child.stderr.on('data', append)
    const failureText = (): string => {
      const decoded = diagnostics.toString('utf8')
      const text = truncated ? (decoded.includes('\n') ? decoded.slice(decoded.indexOf('\n') + 1) : '[diagnostic line exceeded bound]') : decoded
      const redacted = text.replace(/(https?:\/\/)[^/\s@]+:[^/\s@]+@/giu, '$1[redacted]@')
        .replace(/(https?:\/\/[^?\s"'<>]+)\?[^\s"'<>]*/gu, '$1?[redacted]')
        .replace(/((?:authorization|token|password|secret|api[_-]?key)\s*[:=]\s*)(?:bearer\s+)?[^\s"',;]+/giu, '$1[redacted]')
      let bounded = Buffer.from(redacted).subarray(0, 8192).toString('utf8')
      while (Buffer.byteLength(bounded) > 8192) bounded = bounded.slice(0, -1)
      return bounded
    }
    const abort = (): void => { record('abort-request'); child.kill('SIGTERM') }
    request.signal.addEventListener('abort', abort, { once: true })
    let failure: Error | undefined
    child.once('error', (error) => { failure = error; record('error', undefined, undefined, error) })
    child.once('close', (code, signal) => {
      if (observe !== undefined) {
        child.removeListener('spawn', onSpawn)
        child.removeListener('exit', onExit)
        child.stdout.removeListener('close', onStdoutClose)
        child.stderr.removeListener('close', onStderrClose)
      }
      record('close', code, signal)
      request.signal.removeEventListener('abort', abort)
      if (request.signal.aborted) {
        const reason: unknown = request.signal.reason
        if (reason instanceof DOMException && reason.name === 'TimeoutError') {
          reject(new Error(`desktop package operation: pnpm deadline exceeded: ${failureText()}`, { cause: reason }))
        } else {
          // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve AbortSignal.reason identity.
          reject(reason)
        }
      }
      else if (failure !== undefined) reject(failure)
      else if (code !== 0) reject(new Error(`desktop package operation: pnpm failed (${String(code)}): ${failureText()}`))
      else resolve({ exitCode: 0 })
    })
  })
}

/**
 * Pack an already-built source through the pinned pnpm pm command with scripts, pnpmfile, and workspace hooks disabled.
 * @param runtime - Fixed application-owned executable selection.
 * @param directory - Source package, not modified by this operation.
 * @param archivePath - Private acquisition-owned output archive path.
 * @param signal - Cancellation delivered to the sole pack process and awaited through exit.
 */
export async function packDesktopSourceDirectory(
  runtime: DesktopPackagePnpmRuntime, directory: string, archivePath: string, signal: AbortSignal,
): Promise<void> {
  signal.throwIfAborted()
  const home = join(dirname(archivePath), 'pack-environment')
  await mkdir(home, { mode: 0o700 })
  const userconfig = join(home, 'empty.npmrc')
  const globalconfig = join(home, 'empty-global.npmrc')
  await Promise.all([writeFile(userconfig, '', { flag: 'wx', mode: 0o600 }), writeFile(globalconfig, '', { flag: 'wx', mode: 0o600 })])
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CACHE_HOME: home, XDG_CONFIG_HOME: home, XDG_STATE_HOME: home, PNPM_HOME: home,
    NPM_CONFIG_USERCONFIG: userconfig, NPM_CONFIG_GLOBALCONFIG: globalconfig }
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/iu.test(key)) env[key] = value
  }
  await runDesktopPackagePnpm(runtime, { cwd: directory, signal, env, args: [
    'pm', `--config.userconfig=${userconfig}`, `--config.globalconfig=${globalconfig}`,
    'pack', '--out', archivePath,
    '--config.ignore-scripts=true', '--config.ignore-pnpmfile=true', '--config.offline=true', '--pm-on-fail=ignore', '--ignore-workspace',
  ] })
}
