/** Track real project-fixture operations until cleanup can safely restore mocks and remove owned roots. */
import type { ChildProcess } from 'node:child_process'
import type { TestAPI } from 'vitest'

interface Phase {
  readonly name: string
  readonly started: number
  durationMs?: number
  outcome: 'pending' | 'fulfilled' | 'rejected'
}

/**
 * Track the complete original test callback, including continuations after awaited manager operations.
 * @param api - Vitest registration API; each/skipIf retain their normal case generation and skip behavior.
 * @param work - Fixture owner that must settle before mutable test state is restored.
 * @returns The same typed registration API with observed callbacks.
 */
export function trackProjectFixtureTests(api: TestAPI, work: ProjectFixtureWork): TestAPI {
  return new Proxy(api, {
    apply(target, receiver: unknown, args: unknown[]): unknown {
      const callbackIndex = args.findIndex(value => typeof value === 'function')
      if (callbackIndex < 0) return Reflect.apply(target, receiver, args)
      // Vitest overloads supply either TestContext or each-row arguments; their runtime tuple is forwarded unchanged.
      const callback = args[callbackIndex] as (...values: unknown[]) => unknown
      const forwarded = [...args]
      forwarded[callbackIndex] = (...values: unknown[]) => work.track('test body', async () => callback(...values))
      return Reflect.apply(target, receiver, forwarded)
    },
    get(target, key, receiver: unknown): unknown {
      const value: unknown = Reflect.get(target, key, receiver)
      if (key !== 'each' && key !== 'skipIf') return value
      if (typeof value !== 'function') throw new Error('project fixture: unsupported test registration factory')
      return (...args: unknown[]) => {
        const register: unknown = Reflect.apply(value, target, args)
        if (typeof register !== 'function') throw new Error('project fixture: test factory did not return a registration function')
        return trackProjectFixtureTests(register as TestAPI, work)
      }
    },
  })
}

/** Per-file ownership of fixture promises and the real pnpm children they launch. */
export class ProjectFixtureWork {
  private readonly pending = new Set<Promise<void>>()
  private readonly children = new Set<ChildProcess>()
  private phases: Phase[] = []
  private closing = false
  private broken: Error | undefined

  /** Start a case only after its predecessor reached quiescence. */
  begin(): void {
    if (this.broken !== undefined) throw this.broken
    if (this.pending.size > 0 || this.children.size > 0) throw new Error('project fixture: previous work is still active')
    this.phases = []
    this.closing = false
  }

  /** Reject new work once cleanup begins. */
  assertOpen(): void {
    if (this.broken !== undefined) throw this.broken
    if (this.closing) throw new Error('project fixture: cleanup has stopped new work')
  }

  /**
   * Observe an operation without changing its value or rejection.
   * @param name - Fixed method or phase label, never request data.
   * @param operation - Actual fixture operation.
   * @returns The original result promise.
   */
  track<T>(name: string, operation: () => Promise<T>): Promise<T> {
    this.assertOpen()
    const result = operation()
    this.observe(name, result)
    return result
  }

  /**
   * Own a child until its close event, not merely an exit request.
   * @param child - Actual child created by the fixture's spawn wrapper.
   * @param name - Fixed pnpm operation label.
   */
  child(child: ChildProcess, name: string): void {
    this.children.add(child)
    this.observe(name, new Promise<void>((resolve) => {
      child.once('close', () => { this.children.delete(child); resolve() })
    }))
    // Own the close event before stopping a child that arrived after cleanup's first sweep.
    if ((this.closing || this.broken !== undefined) && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }

  private observe(name: string, result: Promise<unknown>): void {
    const phase: Phase = { name, started: performance.now(), outcome: 'pending' }
    this.phases.push(phase)
    const finish = (outcome: Phase['outcome']): void => {
      phase.outcome = outcome
      phase.durationMs = Math.round(performance.now() - phase.started)
    }
    const settled = result.then(() => { finish('fulfilled') }, () => { finish('rejected') })
    this.pending.add(settled)
    void settled.then(() => { this.pending.delete(settled) })
  }

  /**
   * Return bounded method/child timings without arguments, paths, environment or error bodies.
   * @returns Pending counts and the most recent fixed-label phases.
   */
  snapshot(): object {
    return {
      pending: this.pending.size,
      children: this.children.size,
      phases: this.phases.slice(-24).map(phase => ({
        name: phase.name,
        outcome: phase.outcome,
        durationMs: phase.durationMs ?? Math.round(performance.now() - phase.started),
      })),
    }
  }

  /**
   * Stop new work, terminate remaining owned children, and await all observed operations before caller cleanup.
   * @param timeoutMs - Cleanup deadline; expiry fails closed and prevents another case from starting.
   */
  async close(timeoutMs = 25_000): Promise<void> {
    if (this.broken !== undefined) throw this.broken
    this.closing = true
    for (const child of this.children) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        (async () => { while (this.pending.size > 0) await Promise.all([...this.pending]) })(),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.broken = new Error(`project fixture: cleanup did not reach quiescence: ${JSON.stringify(this.snapshot())}`)
            reject(this.broken)
          }, timeoutMs)
        }),
      ])
    } finally { clearTimeout(timer) }
  }
}
