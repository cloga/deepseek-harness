/** Task-owned bounded accounting. Runtime producer attribution, not this helper, establishes coverage. */

/** Exact provider, model and effort used to select a fixed comparison weight. */
export interface WorkRoute {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Explicit comparison metric; never a currency estimate or the adaptive policy's mutable weight. */
export interface WorkMetric {
  readonly revision: string
  readonly routes: readonly { readonly selection: WorkRoute; readonly weightPerToken: number }[]
  readonly maxCalls: number
  readonly maxOperations: number
}

/** Producer categories that must all attest interception before task work can be complete. */
export type WorkSource = 'conversation' | 'classifier' | 'compaction' | 'title' | 'child' | 'review'
/** Closed reasons measured task work remains incomplete, without arbitrary diagnostic text. */
export type WorkGap = 'coverage-unproven' | 'pending-work' | 'missing-usage' | 'unknown-route'
  | 'invalid-usage' | 'limit-exceeded' | 'interrupted' | 'arithmetic-limit' | 'invalid-lifecycle'

/** Safe local summary; no request, output, tool arguments, or error prose. */
export interface TaskWorkSummary {
  readonly metricRevision: string
  readonly complete: boolean
  readonly relativeWork: number | null
  readonly calls: number
  readonly gaps: readonly WorkGap[]
}

/** One dispatched attempt, with one usage report and one normal or interrupted settlement. */
export interface WorkCall {
  /**
   * Supply exactly one authoritative full-call total, including cache; reasoning is already part of output.
   * @param totalTokens - Strictly normalized nonnegative integer total, or undefined when usage is missing.
   */
  usage(totalTokens: number | undefined): void
  /** Normal settlement is not a successful task label; failed paid calls still contribute work. */
  settle(): void
  /** Consumer cancellation or broken iteration cannot establish complete measurement. */
  interrupt(): void
}

/** Producer-owned operation reserved before awaits and closed after its calls settle. */
export interface WorkOperation {
  /**
   * Invoke at actual dispatch, including every retry, not at a routing proposal.
   * @param selection - Exact dispatched route, compared with the task's fixed metric.
   * @returns One attempt handle whose usage and settlement belong to this operation.
   */
  beginCall(selection: WorkRoute): WorkCall
  /** Join all owned calls before closing the operation. */
  close(): void
}

function sameRoute(left: WorkRoute, right: WorkRoute): boolean {
  return left.provider === right.provider && left.model === right.model
    && left.reasoningEffort === right.reasoningEffort
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

/**
 * One instance belongs to one task captured before asynchronous producer work begins.
 * It deliberately has no Session lookup or mutable current-task fallback.
 * Source coverage must be attested by installed producer owners; an uninstrumented
 * source always keeps the result unknown. Coverage does not mean there were calls.
 */
export class TaskWorkAccounting {
  private readonly metric: WorkMetric
  private readonly coverage = new Set<WorkSource>()
  private readonly gaps = new Set<WorkGap>()
  private operations = 0
  private pendingOperations = 0
  private calls = 0
  private pendingCalls = 0
  private total = 0
  private sealed: TaskWorkSummary | undefined

  /** @param metric - Fixed revision, exact route weights and positive operation/call limits to validate and capture. */
  constructor(metric: WorkMetric) {
    if (metric.revision.length === 0 || !positiveInteger(metric.maxCalls) || !positiveInteger(metric.maxOperations)
      || metric.routes.length === 0 || metric.routes.some((route, index) => {
      return route.selection.provider.length === 0 || route.selection.model.length === 0
        || !Number.isFinite(route.weightPerToken) || route.weightPerToken <= 0
        || metric.routes.slice(0, index).some(other => sameRoute(other.selection, route.selection))
    })) {
      throw new Error('invalid work metric')
    }
    this.metric = {
      revision: metric.revision, maxCalls: metric.maxCalls, maxOperations: metric.maxOperations,
      routes: metric.routes.map(route => ({ selection: { ...route.selection }, weightPerToken: route.weightPerToken })),
    }
  }

  /**
   * Only a trusted installed producer owner may attest complete interception for its source.
   * @param source - Producer category whose complete attempt coverage the owner attests.
   */
  cover(source: WorkSource): void {
    this.assertOpen()
    this.coverage.add(source)
  }

  /**
   * Record a known coverage break without storing arbitrary diagnostics.
   * @param gap - Closed incompleteness reason retained in the final summary.
   */
  invalidate(gap: WorkGap): void {
    this.assertOpen()
    this.gaps.add(gap)
  }

  /**
   * Reserve ownership before scheduling producer work, even before its first paid attempt.
   * @param source - Producer category responsible for this operation's attempt attribution.
   * @returns A handle to record each dispatched attempt and close the joined operation.
   */
  beginOperation(source: WorkSource): WorkOperation {
    this.assertOpen()
    if (this.operations >= this.metric.maxOperations) {
      this.gaps.add('limit-exceeded')
      throw new Error('task work operation limit exceeded')
    }
    this.operations++
    if (!this.coverage.has(source)) this.gaps.add('coverage-unproven')
    this.pendingOperations++
    let closed = false
    let ownPending = 0
    return {
      beginCall: (selection) => {
        this.assertOpen()
        if (closed) {
          this.gaps.add('invalid-lifecycle')
          throw new Error('task work operation closed')
        }
        if (this.calls >= this.metric.maxCalls) {
          this.gaps.add('limit-exceeded')
          throw new Error('task work call limit exceeded')
        }
        this.calls++
        const weight = this.metric.routes.find(route => sameRoute(route.selection, selection))?.weightPerToken
        if (weight === undefined) this.gaps.add('unknown-route')
        this.pendingCalls++
        ownPending++
        let settled = false
        let usageSeen = false
        let measured: number | undefined
        const checkCall = () => {
          this.assertOpen()
          if (settled) {
            this.gaps.add('invalid-lifecycle')
            throw new Error('task work call settled')
          }
        }
        const settle = (interrupted: boolean) => {
          checkCall()
          settled = true
          this.pendingCalls--
          ownPending--
          if (interrupted) this.gaps.add('interrupted')
          if (!usageSeen || measured === undefined) this.gaps.add('missing-usage')
          if (measured !== undefined && weight !== undefined) {
            const work = measured * weight
            const next = this.total + work
            if (!Number.isFinite(next) || (measured > 0 && (work === 0 || next === this.total))) {
              this.gaps.add('arithmetic-limit')
            } else this.total = next
          }
        }
        return {
          usage: (totalTokens) => {
            checkCall()
            if (usageSeen) {
              this.gaps.add('invalid-usage')
              return
            }
            usageSeen = true
            if (totalTokens === undefined) return
            if (!Number.isSafeInteger(totalTokens) || totalTokens < 0) {
              this.gaps.add('invalid-usage')
              return
            }
            measured = totalTokens
          },
          settle: () => { settle(false) },
          interrupt: () => { settle(true) },
        }
      },
      close: () => {
        this.assertOpen()
        if (closed) {
          this.gaps.add('invalid-lifecycle')
          throw new Error('task work operation closed')
        }
        closed = true
        this.pendingOperations--
        if (ownPending !== 0) this.gaps.add('invalid-lifecycle')
      },
    }
  }

  /**
   * Seal only after runtime admission closes; late activity must not mutate accepted evidence.
   * @returns The stable frozen summary, with null work when any completeness requirement is unmet.
   */
  seal(): TaskWorkSummary {
    if (this.sealed !== undefined) return this.sealed
    const required: readonly WorkSource[] = ['conversation', 'classifier', 'compaction', 'title', 'child', 'review']
    if (required.some(source => !this.coverage.has(source))) this.gaps.add('coverage-unproven')
    if (this.pendingCalls !== 0 || this.pendingOperations !== 0) this.gaps.add('pending-work')
    if (this.calls === 0) this.gaps.add('missing-usage')
    const complete = this.gaps.size === 0
    this.sealed = Object.freeze({
      metricRevision: this.metric.revision, complete,
      relativeWork: complete ? this.total : null, calls: this.calls,
      gaps: Object.freeze([...this.gaps].sort()),
    })
    return this.sealed
  }

  private assertOpen(): void {
    if (this.sealed !== undefined) throw new Error('task work accounting sealed')
  }
}
