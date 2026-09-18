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
 * @returns Exit outcome after all owned stdio closes.
 */
export function runDesktopPackagePnpm(runtime: DesktopPackagePnpmRuntime, request: DesktopPackagePnpmRequest): Promise<{ exitCode: number }> {
  return new Promise((resolve, reject) => {
    request.signal.throwIfAborted()
    const environment = { ...request.env }
    if (process.platform === 'win32') {
      const path = Object.entries(environment).find(([name]) => name.toUpperCase() === 'PATH')?.[1]
      for (const name of Object.keys(environment)) if (name.toUpperCase() === 'PATH') delete environment[name]
      if (path !== undefined) environment.PATH = path
    }
    // pnpm 11 recognizes its built-in-only sentinel only at argv[0]; flags must not precede `pm`.
    const args = request.args[0] === 'pm'
      ? ['pm', '--config.update-notifier=false', ...request.args.slice(1)]
      : ['--config.update-notifier=false', ...request.args]
    const child = spawn(runtime.node, ['--expose-internals', runtime.pnpm, ...args], {
      cwd: request.cwd,
      env: desktopNodeEnvironment(runtime.node, runtime.nodeBin, { ...environment, ELECTRON_RUN_AS_NODE: '1', COREPACK_ENABLE_PROJECT_SPEC: '0', CI: 'true', NO_UPDATE_NOTIFIER: '1' }),
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    })
    let diagnostics = Buffer.alloc(0)
    let truncated = false
    const append = (chunk: Buffer): void => {
      const next = Buffer.concat([diagnostics, chunk])
      if (next.byteLength > 8192) truncated = true
      diagnostics = Buffer.from(next.subarray(Math.max(0, next.byteLength - 8192)))
    }
    child.stdout?.on('data', append)
    child.stderr?.on('data', append)
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
    const abort = (): void => { child.kill('SIGTERM') }
    request.signal.addEventListener('abort', abort, { once: true })
    let failure: Error | undefined
    child.once('error', error => { failure = error })
    child.once('close', code => {
      request.signal.removeEventListener('abort', abort)
      if (request.signal.aborted) {
        const reason: unknown = request.signal.reason
        if (reason instanceof DOMException && reason.name === 'TimeoutError') {
          reject(new Error(`desktop package operation: pnpm deadline exceeded: ${failureText()}`, { cause: reason }))
        } else reject(reason)
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
export async function packDesktopSourceDirectory(runtime: DesktopPackagePnpmRuntime, directory: string, archivePath: string, signal: AbortSignal): Promise<void> {
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
