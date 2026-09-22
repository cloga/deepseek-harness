/** Bounded, opt-in Windows coverage annotations; delivery before runner loss is best effort. */
import { freemem, totalmem } from 'node:os'
import { performance } from 'node:perf_hooks'

/** Only the owning CI coverage entrypoint consumes this flag. */
export const WINDOWS_COVERAGE_NOTICES_ENV = 'DSH_WINDOWS_COVERAGE_NOTICES'

/** Aggregate counters without commands, file names, process tables, or child output. */
export interface CoverageNoticeProgress {
  started(): void
  finished(): void
  result(status: 'passed' | 'failed' | 'skipped'): void
}

/** Local observations and owned timers; injectable without starting subprocesses. */
export interface CoverageNoticeRuntime {
  platform: NodeJS.Platform
  env: NodeJS.ProcessEnv
  nodeVersion: string
  now(): number
  sample(): { freeBytes: number; totalBytes: number; rssBytes: number }
  after(delayMs: number, callback: () => void): () => void
  emit(line: string): void
}

const runtimeDefaults: CoverageNoticeRuntime = {
  platform: process.platform,
  env: process.env,
  nodeVersion: process.versions.node,
  now: () => performance.now(),
  sample: () => ({ freeBytes: freemem(), totalBytes: totalmem(), rssBytes: process.memoryUsage().rss }),
  after: (delayMs, callback) => {
    const timer = setTimeout(callback, delayMs)
    timer.unref()
    return () => { clearTimeout(timer) }
  },
  emit: (line) => { console.log(line) },
}

const silentProgress: CoverageNoticeProgress = {
  started() {},
  finished() {},
  result() {},
}

/**
 * Preserve the existing child environment while consuming the aggregate-only notice flag.
 * @param parent - Parent environment, never modified.
 * @param gate - Existing per-gate additions and removals, never modified.
 * @returns A fresh environment with only the diagnostic opt-in additionally removed.
 */
export function coverageNoticeChildEnvironment(parent: NodeJS.ProcessEnv, gate?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return { ...parent, ...gate, [WINDOWS_COVERAGE_NOTICES_ENV]: undefined }
}

/**
 * Encode workflow-command data without allowing percent, CR, or LF command injection.
 * @param message - Owned diagnostic message, not child-process output.
 * @returns One notice command with a fixed title and no trailing newline.
 */
export function coverageNoticeCommand(message: string): string {
  const data = message.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')
  return `::notice title=Windows coverage checkpoint::${data}`
}

function diagnosticAttempt(effect: () => void): void {
  try {
    effect()
  } catch (error) {
    // Diagnostics cannot replace the gate result, including when sampling or output fails.
    void error
  }
}

function token(value: string | undefined, pattern: RegExp): string {
  return value !== undefined && value.length <= 32 && pattern.exec(value)?.[0] === value ? value : 'unknown'
}

function nonnegativeInteger(value: number): number | null {
  return Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? Math.floor(value) : null
}

/**
 * Observe the existing coverage action without changing its result or rejection.
 * Windows + GitHub Actions + exact opt-in + ci-coverage are all required. Baseline,
 * 15/30/45/60/90-minute checkpoints and terminal notices total at most eight;
 * timers are unreferenced and disposed in finally. No network or child processes.
 * GitHub runner timeline notices may survive missing log blobs, but hard runner
 * loss can discard unsent notices; this is not a persistence guarantee.
 * @param mode - Existing gate-runner mode.
 * @param action - Original work, supplied only fixed aggregate counters.
 * @param overrides - Local observation dependencies for focused tests.
 * @returns The original action's numeric exit code, or its unchanged rejection.
 */
export async function withWindowsCoverageNotices(
  mode: string,
  action: (progress: CoverageNoticeProgress) => Promise<number>,
  overrides: Partial<CoverageNoticeRuntime> = {},
): Promise<number> {
  const runtime = { ...runtimeDefaults, ...overrides }
  if (mode !== 'ci-coverage' || runtime.platform !== 'win32'
    || runtime.env.GITHUB_ACTIONS !== 'true' || runtime.env[WINDOWS_COVERAGE_NOTICES_ENV] !== '1') {
    return action(silentProgress)
  }

  const counters = { started: 0, running: 0, finished: 0, passed: 0, failed: 0, skipped: 0 }
  const progress: CoverageNoticeProgress = {
    started() { counters.started++; counters.running++ },
    finished() { counters.finished++; counters.running-- },
    result(status) { counters[status]++ },
  }
  const disposeTimers: Array<() => void> = []
  const emitted = new Set<string>()
  let notices = 0
  let closed = false
  let startedAt = 0
  diagnosticAttempt(() => { startedAt = runtime.now() })
  const emit = (checkpoint: string, exitCode?: number | null) => {
    if (closed || emitted.has(checkpoint) || notices >= 8) return
    emitted.add(checkpoint)
    notices++
    diagnosticAttempt(() => {
      const memory = runtime.sample()
      const payload = {
        schema: 'dsh.windows-coverage-notice', version: 1, checkpoint,
        elapsedSeconds: nonnegativeInteger((runtime.now() - startedAt) / 1000),
        node: token(runtime.nodeVersion, /^\d+\.\d+\.\d+$/u),
        imageOS: token(runtime.env.ImageOS, /^win\d{2,4}$/u),
        imageVersion: token(runtime.env.ImageVersion, /^\d{8}\.\d{1,8}\.\d{1,8}$/u),
        freeMiB: nonnegativeInteger(memory.freeBytes / 1048576),
        totalMiB: nonnegativeInteger(memory.totalBytes / 1048576),
        rssMiB: nonnegativeInteger(memory.rssBytes / 1048576),
        ...counters,
        ...(exitCode === undefined ? {} : { exitCode }),
      }
      runtime.emit(coverageNoticeCommand(JSON.stringify(payload)))
    })
  }

  emit('baseline')
  for (const minutes of [15, 30, 45, 60, 90]) {
    diagnosticAttempt(() => {
      disposeTimers.push(runtime.after(minutes * 60_000, () => { emit(`minute-${minutes}`) }))
    })
  }
  let exitCode: number | null = null
  try {
    exitCode = await action(progress)
    return exitCode
  } finally {
    emit(exitCode === null ? 'threw' : 'terminal', exitCode)
    closed = true
    for (const dispose of disposeTimers) diagnosticAttempt(dispose)
  }
}
