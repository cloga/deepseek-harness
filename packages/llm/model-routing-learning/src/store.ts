/** Exclusive profile ownership and one durability-first CAS ledger over the domain storage capability. */

import { createHash } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import type { KvTable } from '@deepseek-ai/dsh-storage-domain'
import { deepEqualJson, deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { z } from 'zod'
import { createLearningLedgerSchema, LearningStoreError, parseLearningStoreConfig } from './schema.ts'
import type {
  LearningLedger, LearningLedgerData, LearningStore, LearningStoreConfig, LearningStoreOpenResult,
} from './types.ts'

const DATA_KEYS: ReadonlySet<string> = new Set(['scopes', 'tasks', 'proposals', 'versions'])

/**
 * Derive a storage-safe domain name without inferring or merging deployment profiles.
 * @param profileKey - Explicit deployment identity, validated by parseLearningStoreConfig.
 * @returns Stable lowercase domain name containing a SHA-256 profile suffix.
 */
export function learningDomainName(profileKey: string): string {
  return `model_routing_learning_${createHash('sha256').update(profileKey).digest('hex')}`
}

function owned(ledger: LearningLedger): LearningLedger {
  return deepFreeze(structuredClone(ledger))
}

function checkRevision(current: LearningLedger, revision: number, epoch: number): void {
  if (current.epoch !== epoch) throw new LearningStoreError('epoch-conflict')
  if (current.revision !== revision) throw new LearningStoreError('revision-conflict')
}

function assertTransitions(previous: LearningLedger, next: LearningLedger): void {
  for (const prior of previous.tasks) {
    const task = next.tasks.find(task => task.id === prior.id)
    if (task === undefined || deepEqualJson(task, prior)) continue
    if (task.revision !== prior.revision + 1 || task.createdAt !== prior.createdAt || task.sessionId !== prior.sessionId) {
      throw new LearningStoreError('invalid-ledger')
    }
  }
  for (const prior of previous.scopes) {
    const scope = next.scopes.find(scope => scope.id === prior.id)
    if (scope !== undefined && prior.cohort !== null && scope.cohort !== prior.cohort) {
      throw new LearningStoreError('invalid-ledger')
    }
  }
  for (const prior of previous.proposals) {
    const proposal = next.proposals.find(proposal => proposal.id === prior.id)
    if (proposal !== undefined && !deepEqualJson(proposal, prior)) throw new LearningStoreError('invalid-ledger')
  }
  for (const prior of previous.versions) {
    const version = next.versions.find(version => version.id === prior.id)
    if (version !== undefined && !deepEqualJson(version, prior)) throw new LearningStoreError('invalid-ledger')
  }
}

/** Private implementation; opening owns the lock, and the returned handle owns its eventual close. */
class OwnedLearningStore implements LearningStore {
  private accepting = true
  private closed = false
  private closing: Promise<void> | undefined

  constructor(
    private readonly rows: KvTable<'state', LearningLedger>,
    private readonly schema: z.ZodType<LearningLedger>,
    private readonly releaseOwnership: () => Promise<void>,
  ) {}

  read(): LearningLedger {
    if (this.closed) throw new LearningStoreError('closed')
    const current = this.rows.get('state')
    if (current === undefined) throw new LearningStoreError('invalid-ledger')
    return owned(current)
  }

  update(
    expectedRevision: number,
    expectedEpoch: number,
    transform: (current: LearningLedger) => LearningLedgerData,
  ): Promise<LearningLedger> {
    if (!this.accepting) return Promise.reject(new LearningStoreError('closed'))
    return this.rows.update('state', (current) => {
      checkRevision(current, expectedRevision, expectedEpoch)
      const data = transform(owned(current))
      const keys = Reflect.ownKeys(data)
      if (keys.length !== DATA_KEYS.size || keys.some(key => typeof key !== 'string' || !DATA_KEYS.has(key))) {
        throw new LearningStoreError('invalid-ledger')
      }
      const next = this.schema.parse({
        ...data, schemaVersion: 1, profileKey: current.profileKey,
        revision: current.revision + 1, epoch: current.epoch,
      })
      assertTransitions(current, next)
      return next
    }).then(owned)
  }

  clear(expectedRevision: number, expectedEpoch: number): Promise<LearningLedger> {
    if (!this.accepting) return Promise.reject(new LearningStoreError('closed'))
    return this.rows.update('state', (current) => {
      checkRevision(current, expectedRevision, expectedEpoch)
      return this.schema.parse({
        schemaVersion: 1, profileKey: current.profileKey,
        revision: current.revision + 1, epoch: current.epoch + 1,
        scopes: [], tasks: [], proposals: [], versions: [],
      })
    }).then(owned)
  }

  close(): Promise<void> {
    if (this.closing === undefined) {
      this.accepting = false
      this.closing = this.finishClose()
    }
    return this.closing
  }

  private async finishClose(): Promise<void> {
    try {
      await this.releaseOwnership()
    } finally {
      this.closed = true
    }
  }
}

/**
 * Open the closed local ledger only while holding its deployment-provided sole-writer lock.
 * Every process using the same profile/domain must supply the same ownership path.
 * The caller must close an available store; no consumer fiber is inferred here.
 * Acquisition failures return unavailable, never steal stale locks, and never open a domain.
 * Errors after acquisition (including malformed stored data) reject after domain/lock cleanup.
 * @param ctx - Host domain storage capability; no Session, feedback, network, or model service is used.
 * @param value - Explicit profile, absolute ownership-lock path, wait budget, and ledger limits.
 * @returns A caller-owned ready store or an explicit ownership-unavailable result.
 */
export async function openLearningStore(
  ctx: Pick<Context, 'storageDomain'>,
  value: LearningStoreConfig,
): Promise<LearningStoreOpenResult> {
  const config = parseLearningStoreConfig(value)
  const schema = createLearningLedgerSchema(config)
  const spec = defineDomain({
    name: learningDomainName(config.profileKey), version: 1,
    tables: { ledger: domainTable<'state', LearningLedger>(schema) },
  })
  try {
    await mkdir(dirname(config.ownershipLockPath), { recursive: true, mode: 0o700 })
  } catch (_error: unknown) {
    // The configured ownership location is unavailable; do not fall back to a shared unlocked store.
    return { available: false, reason: 'ownership-unavailable' }
  }
  const ready = Promise.withResolvers<LearningStoreOpenResult>()
  const release = Promise.withResolvers<undefined>()
  let acquired = false
  const ownership: Promise<void> = withFileLock(config.ownershipLockPath, async () => {
    acquired = true
    const domain = await ctx.storageDomain.open(spec)
    try {
      const rows = domain.table('ledger')
      if (rows.size > 1 || (rows.size === 1 && rows.get('state') === undefined)) {
        throw new LearningStoreError('invalid-ledger')
      }
      if (rows.get('state') === undefined) {
        await rows.put('state', schema.parse({
          schemaVersion: 1, profileKey: config.profileKey, revision: 0, epoch: 0,
          scopes: [], tasks: [], proposals: [], versions: [],
        }))
      }
      const store = new OwnedLearningStore(rows, schema, () => {
        release.resolve(undefined)
        return ownership
      })
      ready.resolve({ available: true, store })
      await release.promise
    } finally {
      await domain.close()
    }
  }, { waitMs: config.ownershipWaitMs })
  void ownership.catch((error: unknown) => {
    if (acquired) ready.reject(error)
    else ready.resolve({ available: false, reason: 'ownership-unavailable' })
  })
  return ready.promise
}
