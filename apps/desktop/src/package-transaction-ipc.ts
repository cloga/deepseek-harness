/** Fixed child-to-shell package protocol; no renderer can select paths or executables. */
import { parseProfilePendingChange, parseProfilePreparedChange, parseProfileTransactionId, type ProfilePackageTransactions, type ProfilePackageMutation } from '@deepseek-ai/dsh-app-boot'
import { parseDesktopPluginSource } from './plugin-source.ts'

/** One Host connection, independent of the longer-lived staging backend. */
export class DesktopPackageTransactionIpc {
  private readonly stages = new Map<string, { abort: AbortController; work: Promise<unknown> }>()
  private disconnected = false

  constructor(private readonly backend: ProfilePackageTransactions) {}

  /** @param value - Child message. @returns Whether it belongs to this fixed protocol. */
  accepts(value: unknown): boolean {
    return typeof value === 'object' && value !== null && 'type' in value && value.type === 'package-transaction'
  }

  /**
   * Execute one validated operation; always return a bounded JSON result for the caller.
   * @param value - Child request carrying a protocol version and UUID correlation id.
   * @returns Correlated reply, never a callback, profile path, or active receipt.
   */
  async handle(value: unknown): Promise<object> {
    const input = value as Record<string, unknown>
    let rpcId: string | undefined
    let acknowledgedCancellation = false
    try {
      rpcId = parseProfileTransactionId(input.rpcId)
      const backendProtocolVersion = (): unknown => this.backend.protocolVersion
      if (this.disconnected || input.protocolVersion !== 1 || backendProtocolVersion() !== 1) {
        throw new Error('desktop packages: staging connection unavailable or unsupported')
      }
      let result: unknown
      switch (input.operation) {
        case 'hello': {
          keys(input, ['type', 'protocolVersion', 'rpcId', 'operation'])
          result = 1
          break
        }
        case 'stage': {
          keys(input, ['type', 'protocolVersion', 'rpcId', 'operation', 'requestId', 'mutation'])
          const requestId = parseProfileTransactionId(input.requestId)
          if (this.stages.has(requestId)) throw new Error('desktop packages: request already in progress; query its status')
          if (this.stages.size >= 32) throw new Error('desktop packages: too many concurrent staging requests')
          const mutation = parseMutation(input.mutation)
          const abort = new AbortController()
          const work = this.backend.stage(requestId, mutation, abort.signal)
          this.stages.set(requestId, { abort, work })
          try {
            const prepared = parseProfilePreparedChange(await work)
            if (prepared.transactionId !== requestId) throw new Error('desktop packages: prepared identity mismatch')
            result = prepared
          } catch (error) {
            acknowledgedCancellation = abort.signal.aborted && error === abort.signal.reason
            throw error
          } finally { this.stages.delete(requestId) }
          break
        }
        case 'status': {
          keys(input, ['type', 'protocolVersion', 'rpcId', 'operation', 'transactionId'])
          const id = parseProfileTransactionId(input.transactionId)
          const record = await this.backend.status(id)
          result = record === undefined ? null : parseProfilePendingChange(record)
          if (record !== undefined && record.transactionId !== id) throw new Error('desktop packages: status identity mismatch')
          break
        }
        case 'list': {
          keys(input, ['type', 'protocolVersion', 'rpcId', 'operation'])
          const list = await this.backend.listPending()
          if (!Array.isArray(list) || list.length > 100) throw new Error('desktop packages: pending record limit exceeded')
          result = list.map(parseProfilePendingChange)
          break
        }
        case 'abort': {
          keys(input, ['type', 'protocolVersion', 'rpcId', 'operation', 'transactionId'])
          const stage = this.stages.get(parseProfileTransactionId(input.transactionId))
          stage?.abort.abort()
          if (stage !== undefined) await stage.work.catch((error: unknown) => {
            if (error !== stage.abort.signal.reason) throw error
          })
          // A durable prepare won before cancellation: leave it available for status/review.
          result = null
          break
        }
        case 'cancel': {
          keys(input, ['type', 'protocolVersion', 'rpcId', 'operation', 'transactionId'])
          const id = parseProfileTransactionId(input.transactionId)
          if (this.stages.has(id)) throw new Error('desktop packages: preparation is still running; cancel its request before explicitly discarding a prepared change')
          await this.backend.cancel(id)
          if (await this.backend.status(id) !== undefined) throw new Error('desktop packages: prepared discard was not confirmed')
          result = null
          break
        }
        default: throw new Error('desktop packages: unsupported staging operation')
      }
      return { type: 'package-transaction-result', protocolVersion: 1, rpcId, ok: true, value: result }
    } catch (error) {
      return { type: 'package-transaction-result', protocolVersion: 1, rpcId: rpcId ?? '', ok: false, errorKind: acknowledgedCancellation ? 'cancelled' : 'failed',
        error: (error instanceof Error ? error.message : 'Package operation failed').slice(0, 2048) }
    }
  }

  /** Abort unfinished stages and await their cleanup; already prepared records survive disconnect. */
  async dispose(): Promise<void> {
    this.disconnected = true
    const stages = [...this.stages.values()]
    for (const stage of stages) stage.abort.abort()
    const outcomes = await Promise.allSettled(stages.map(stage => stage.work))
    const failures = outcomes.flatMap((outcome, index): unknown[] => {
      if (outcome.status !== 'rejected') return []
      const reason: unknown = outcome.reason
      return reason !== stages[index]?.abort.signal.reason ? [reason] : []
    })
    if (failures.length > 0) throw new AggregateError(failures, 'desktop packages: owned staging cleanup failed during Host disposal')
  }
}

function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (Object.keys(value).length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) {
    throw new Error('desktop packages: unexpected staging fields')
  }
}

function parseMutation(value: unknown): ProfilePackageMutation {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('desktop packages: invalid mutation')
  const input = value as Record<string, unknown>
  if (input.kind === 'remove') {
    keys(input, ['kind', 'name'])
    if (typeof input.name !== 'string' || !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9][a-z0-9._~-]*$/u.test(input.name)) {
      throw new Error('desktop packages: invalid package name')
    }
    return { kind: 'remove', name: input.name }
  }
  if (input.kind !== 'install' || Object.keys(input).some(key => !['kind', 'source', 'enabled', 'approvedBuilds'].includes(key))) {
    throw new Error('desktop packages: invalid mutation')
  }
  const source = parseDesktopPluginSource(input.source)
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('desktop packages: invalid enablement')
  if (input.approvedBuilds !== undefined && (!Array.isArray(input.approvedBuilds) || input.approvedBuilds.length > 100
    || input.approvedBuilds.some(name => typeof name !== 'string' || name.length === 0 || name.length > 214))) {
    throw new Error('desktop packages: invalid build approvals')
  }
  return { kind: 'install', source,
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.approvedBuilds === undefined ? {} : { approvedBuilds: input.approvedBuilds as string[] }),
  }
}
