/** Local profile-ledger ownership, durability, immutable evidence and bounded admission. */

import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import Storage from '@deepseek-ai/dsh-storage'
import type { KvUnit, StorageBackend } from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { DomainChanged } from '@deepseek-ai/dsh-storage-domain'
import { JsonStorageBackend } from '@deepseek-ai/dsh-storage-json'
import { parseRoutingPolicy } from '@deepseek-ai/dsh-model-routing'
import {
  evaluateAdaptivePolicy, fingerprintAdaptiveBasePolicy, parseAdaptiveEvaluationInput, parseAdaptivePolicyConfig,
} from '@deepseek-ai/dsh-model-routing/adaptive'
import type { AdaptiveCohortKey } from '@deepseek-ai/dsh-model-routing/adaptive-types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import { createLearningLedgerSchema, parseLearningStoreConfig } from '../src/schema.ts'
import { learningDomainName, openLearningStore } from '../src/store.ts'
import type {
  LearningLedger, LearningLedgerData, LearningProposalId, LearningScopeId, LearningStore,
  LearningStoreConfig, LearningStoreLimits, LearningTaskId, LearningTaskRecord, LearningVersionId,
} from '../src/types.ts'

const directories: string[] = []
const contexts: Context[] = []
const stores: LearningStore[] = []

afterEach(async () => {
  for (const store of stores.splice(0).reverse()) await store.close()
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

function deferred() {
  let resolve!: (value: undefined) => void
  const promise = new Promise<undefined>((accept) => { resolve = accept })
  return { promise, resolve }
}

async function root(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-learning-store-'))
  directories.push(directory)
  return directory
}

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`
}

const SCOPE_ID = brandString<LearningScopeId>(uuid(1))
const COHORT = brandString<AdaptiveCohortKey>('a'.repeat(64))

function limits(patch: Partial<LearningStoreLimits> = {}): LearningStoreLimits {
  return {
    maxScopes: 4, maxTasks: 16, maxProposals: 4, maxVersions: 4,
    maxObservationsPerProposal: 8, maxLedgerBytes: 256_000, ...patch,
  }
}

function configuration(directory: string, patch: Partial<LearningStoreConfig> = {}): LearningStoreConfig {
  return parseLearningStoreConfig({
    profileKey: 'web', ownershipLockPath: join(directory, 'locks', 'web-owner'), ownershipWaitMs: 30,
    limits: limits(), ...patch,
  })
}

function empty(): LearningLedgerData {
  return { scopes: [], tasks: [], proposals: [], versions: [] }
}

function dataOf(ledger: LearningLedger): LearningLedgerData {
  return { scopes: ledger.scopes, tasks: ledger.tasks, proposals: ledger.proposals, versions: ledger.versions }
}

function scopeData(): LearningLedgerData {
  return { ...empty(), scopes: [{ id: SCOPE_ID, cohort: COHORT, activeVersionId: null }] }
}

function basePolicy() {
  return parseRoutingPolicy({
    candidates: [
      { id: 'base', selection: { provider: 'test', model: 'base' }, quality: 3, relativeCost: 1 },
      { id: 'alternative', selection: { provider: 'test', model: 'alternative' }, quality: 3, relativeCost: 1.2 },
    ],
    qualityFloors: {
      efficiency: { routine: 3, standard: 3, complex: 3 },
      balanced: { routine: 3, standard: 3, complex: 3 },
      intelligence: { routine: 3, standard: 3, complex: 3 },
    },
    conservativeCandidateId: 'alternative', minConfidence: 0.8,
  })
}

function taskRecord(index = 10, candidateId = 'base'): LearningTaskRecord {
  const base = basePolicy()
  return {
    id: brandString<LearningTaskId>(uuid(index)), sessionId: brandString<SessionId>('session-local-learning'),
    scopeId: SCOPE_ID, cohort: COHORT, category: 'tests', complexity: 'routine', mode: 'balanced', role: 'main',
    candidateId, resolvedSelection: { provider: 'test', model: candidateId },
    basePolicy: base, basePolicyFingerprint: fingerprintAdaptiveBasePolicy(base),
    classifierRevision: 'classifier-v1', metricRevision: 'token-work-v1',
    revision: 0, state: 'sealed', createdAt: 1, completedAt: 10,
    observedRelativeWork: candidateId === 'base' ? 100 : 50, workComplete: true, incompleteReasons: [],
    outcome: 'success', evidence: 'validator',
  }
}

function evidenceData(): LearningLedgerData {
  const base = basePolicy()
  const tasks = [taskRecord(10), taskRecord(11), taskRecord(12, 'alternative'), taskRecord(13, 'alternative')]
  const guardConfig = parseAdaptivePolicyConfig({
    minSamplesPerCandidate: 2, observationWindowMs: 100, maxObservations: 8,
    minRelativeImprovement: 0.1, maxFailureRate: 1, maxFailureRateRegression: 1,
    confidenceZ: 1.96, maxRelativeWeightChange: 0.5,
  })
  const evaluationInput = parseAdaptiveEvaluationInput({
    cohort: COHORT, mode: 'balanced', complexity: 'routine', now: 20,
    eligibleCandidateIds: ['base', 'alternative'],
    observations: tasks.map((task, index) => ({
      observationId: uuid(100 + index), taskId: task.id, candidateId: task.candidateId, cohort: COHORT,
      evidence: task.evidence, outcome: task.outcome, observedRelativeWork: task.observedRelativeWork,
      workComplete: task.workComplete, completedAt: task.completedAt,
    })),
  }, guardConfig)
  const evaluation = evaluateAdaptivePolicy(base, guardConfig, evaluationInput)
  if (evaluation.kind !== 'proposal') throw new Error('fixture requires a real guarded proposal')
  const proposalId = brandString<LearningProposalId>(uuid(20))
  const versionId = brandString<LearningVersionId>(uuid(30))
  return {
    scopes: [{ id: SCOPE_ID, cohort: COHORT, activeVersionId: versionId }],
    tasks,
    proposals: [{
      id: proposalId, scopeId: SCOPE_ID, cohort: COHORT, basePolicyFingerprint: fingerprintAdaptiveBasePolicy(base),
      configRevision: 'config-v1', contextRevision: 'context-v1',
      guardConfig, evaluationInput, proposal: evaluation.proposal,
      sourceTaskRevisions: tasks.map(task => ({ taskId: task.id, revision: task.revision })),
      createdAt: 20, expiresAt: 120,
    }],
    versions: [{
      id: versionId, scopeId: SCOPE_ID, cohort: COHORT, proposalId, parentVersionId: null,
      basePolicyFingerprint: fingerprintAdaptiveBasePolicy(base),
      weights: [{ candidateId: 'base', relativeCost: 1 }, { candidateId: 'alternative', relativeCost: 0.6 }],
      createdAt: 30, validUntil: 110,
    }],
  }
}

interface WriteHooks {
  beforePut?: () => Promise<void>
  openedUnit?: (unit: KvUnit) => void
}

async function host(directory: string, backend: StorageBackend = new JsonStorageBackend(join(directory, 'data')), hooks?: WriteHooks) {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(Storage)
  if (hooks !== undefined) {
    const facet = backend.kv
    if (facet === undefined) throw new Error('fixture requires key-value storage')
    const open = facet.open.bind(facet)
    vi.spyOn(facet, 'open').mockImplementation(async (descriptor) => {
      const unit = await open(descriptor)
      const put = unit.putRecord.bind(unit)
      vi.spyOn(unit, 'putRecord').mockImplementation(async (table, key, value) => {
        await hooks.beforePut?.()
        await put(table, key, value)
      })
      hooks.openedUnit?.(unit)
      return unit
    })
  }
  ctx.effect(() => {
    const unregister = ctx.storage.backend.register('test', backend)
    return async () => { unregister(); await backend.close() }
  }, 'learning-store-test: backend')
  const facility = new DomainFacility(ctx, { backend: 'test' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    return async () => { await facility.closeAll(); unmount() }
  }, 'learning-store-test: facility')
  const changes: DomainChanged[] = []
  ctx.on('domain/changed', (change) => { changes.push(change) })
  return { ctx, facility, consumer: { storageDomain: facility }, changes }
}

type Host = Awaited<ReturnType<typeof host>>

async function open(host: Host, config: LearningStoreConfig) {
  const result = await openLearningStore(host.consumer, config)
  if (result.available) stores.push(result.store)
  return result
}

async function readyStore(host: Host, config: LearningStoreConfig): Promise<LearningStore> {
  const result = await open(host, config)
  if (!result.available) throw new Error('fixture expected exclusive profile ownership')
  return result.store
}

function ledgerPath(directory: string, config: LearningStoreConfig): string {
  return join(directory, 'data', `${learningDomainName(config.profileKey)}.json`)
}

interface JsonUnitDocument {
  unit: { name: string; version: number }
  global: null
  tables: { ledger: { state: LearningLedger } }
}

async function diskLedger(directory: string, config: LearningStoreConfig): Promise<LearningLedger> {
  const value = JSON.parse(await readFile(ledgerPath(directory, config), 'utf8')) as JsonUnitDocument
  return value.tables.ledger.state
}

describe('learning store ownership and durability', () => {
  it('requires explicit profile identity, an absolute lock path, and every storage bound', async () => {
    const directory = await root()
    const source = configuration(directory)
    expect(learningDomainName('web')).toMatch(/^[a-z][a-z0-9_]*$/)
    expect(learningDomainName('web')).toBe(learningDomainName('web'))
    expect(learningDomainName('web')).not.toBe(learningDomainName('desktop'))
    for (const key of ['profileKey', 'ownershipLockPath', 'ownershipWaitMs', 'limits']) {
      const missing = Object.fromEntries(Object.entries(source).filter(([field]) => field !== key))
      expect(() => parseLearningStoreConfig(missing)).toThrow()
    }
    for (const profileKey of ['', 'two profiles', '../web', 'A'.repeat(65)]) {
      expect(() => parseLearningStoreConfig({ ...source, profileKey })).toThrow()
    }
    expect(() => parseLearningStoreConfig({ ...source, ownershipLockPath: 'relative.lock' })).toThrow()
    expect(() => parseLearningStoreConfig({ ...source, ownershipWaitMs: 0 })).toThrow()
    expect(() => parseLearningStoreConfig({ ...source, limits: { ...source.limits, maxTasks: 0 } })).toThrow()
    expect(() => parseLearningStoreConfig({ ...source, inferProfile: true })).toThrow()
  })

  it('holds ownership before opening and publishes readiness only after initial-row durability', async () => {
    const directory = await root()
    const config = configuration(directory)
    const entered = deferred()
    const release = deferred()
    const h = await host(directory, new JsonStorageBackend(join(directory, 'data')), {
      beforePut: async () => {
        entered.resolve(undefined)
        await release.promise
      },
    })
    let ready = false
    const pending = open(h, config).then((result) => { ready = true; return result })
    try {
      await entered.promise
      expect(await readFile(`${config.ownershipLockPath}.lock`, 'utf8')).toMatch(/^\d+\n$/)
      expect(ready).toBe(false)
      expect(h.changes).toEqual([])
      release.resolve(undefined)
      const result = await pending
      if (!result.available) throw new Error('expected store')
      expect(result.store.read()).toEqual({ schemaVersion: 1, profileKey: 'web', revision: 0, epoch: 0, ...empty() })
      expect(await diskLedger(directory, config)).toEqual(result.store.read())
      expect(h.changes).toHaveLength(1)
      expect(h.changes[0]).toMatchObject({ table: 'ledger', key: 'state', operation: 'put' })
    } finally {
      release.resolve(undefined)
      await pending
    }
  })

  it('returns unavailable for another owner without opening its domain or altering the held lock', async () => {
    const directory = await root()
    const config = configuration(directory)
    const first = await host(directory)
    const second = await host(directory)
    const owner = await readyStore(first, config)
    const lock = await readFile(`${config.ownershipLockPath}.lock`, 'utf8')
    const openSpy = vi.spyOn(second.facility, 'open')
    expect(await open(second, config)).toEqual({ available: false, reason: 'ownership-unavailable' })
    expect(openSpy).not.toHaveBeenCalled()
    expect(await readFile(`${config.ownershipLockPath}.lock`, 'utf8')).toBe(lock)
    await owner.close()
    await expect(readFile(`${config.ownershipLockPath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await open(second, config)).available).toBe(true)
  })

  it('does not steal an old lock whose recorded owner may no longer exist', async () => {
    const directory = await root()
    const config = configuration(directory)
    await mkdir(join(directory, 'locks'), { recursive: true })
    await writeFile(`${config.ownershipLockPath}.lock`, '999999999\n', 'utf8')
    await utimes(`${config.ownershipLockPath}.lock`, new Date(0), new Date(0))
    const h = await host(directory)
    const openSpy = vi.spyOn(h.facility, 'open')
    expect(await open(h, config)).toEqual({ available: false, reason: 'ownership-unavailable' })
    expect(openSpy).not.toHaveBeenCalled()
    expect(await readFile(`${config.ownershipLockPath}.lock`, 'utf8')).toBe('999999999\n')
  })

  it('isolates explicit profiles sharing one JSON backend root', async () => {
    const directory = await root()
    const web = configuration(directory)
    const desktop = configuration(directory, { profileKey: 'desktop', ownershipLockPath: join(directory, 'locks', 'desktop-owner') })
    const webStore = await readyStore(await host(directory), web)
    const desktopStore = await readyStore(await host(directory), desktop)
    await webStore.update(0, 0, () => scopeData())
    expect(desktopStore.read()).toEqual({ schemaVersion: 1, profileKey: 'desktop', revision: 0, epoch: 0, ...empty() })
    expect((await diskLedger(directory, web)).scopes).toHaveLength(1)
    expect((await diskLedger(directory, desktop)).scopes).toEqual([])
  })

  it('reopens the durably committed ledger through a fresh real backend and facility', async () => {
    const directory = await root()
    const config = configuration(directory)
    const first = await readyStore(await host(directory), config)
    const committed = await first.update(0, 0, () => evidenceData())
    await first.close()
    const second = await readyStore(await host(directory), config)
    expect(second.read()).toEqual(committed)
    expect(second.read()).not.toBe(committed)
    expect(Object.isFrozen(second.read().proposals[0]?.evaluationInput)).toBe(true)
  })

  it('fails closed on malformed stored state without repairing it or keeping the ownership lease', async () => {
    const directory = await root()
    const config = configuration(directory)
    const first = await readyStore(await host(directory), config)
    const committed = first.read()
    await first.close()
    const path = ledgerPath(directory, config)
    const original = JSON.parse(await readFile(path, 'utf8')) as JsonUnitDocument
    const malformed = JSON.stringify({ ...original, tables: { ledger: { state: { ...committed, schemaVersion: 2 } } } })
    await writeFile(path, malformed, 'utf8')
    const second = await host(directory)
    await expect(open(second, config)).rejects.toMatchObject({ code: 'invalid-record' })
    expect(await readFile(path, 'utf8')).toBe(malformed)
    expect(second.facility.get(learningDomainName(config.profileKey))).toBeUndefined()
    await expect(readFile(`${config.ownershipLockPath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await writeFile(path, JSON.stringify(original), 'utf8')
    expect((await readyStore(second, config)).read()).toEqual(committed)
  })

  it('rejects extra or renamed ledger rows instead of silently initializing a second authoritative row', async () => {
    const directory = await root()
    const config = configuration(directory)
    const first = await readyStore(await host(directory), config)
    await first.close()
    const path = ledgerPath(directory, config)
    const original = JSON.parse(await readFile(path, 'utf8')) as JsonUnitDocument
    await writeFile(path, JSON.stringify({ ...original, tables: { ledger: { renamed: original.tables.ledger.state } } }), 'utf8')
    await expect(open(await host(directory), config)).rejects.toMatchObject({ code: 'invalid-ledger' })
    await expect(readFile(`${config.ownershipLockPath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

describe('learning store queued transactions and lifecycle', () => {
  it('compares revisions inside the write queue so only one racing update transforms and commits', async () => {
    const directory = await root()
    const h = await host(directory)
    const store = await readyStore(h, configuration(directory))
    h.changes.length = 0
    const first = vi.fn(() => scopeData())
    const second = vi.fn(() => empty())
    const results = await Promise.allSettled([store.update(0, 0, first), store.update(0, 0, second)])
    expect(results[0]).toMatchObject({ status: 'fulfilled', value: { revision: 1, epoch: 0 } })
    expect(results[1]).toMatchObject({ status: 'rejected', reason: { code: 'revision-conflict' } })
    expect(first).toHaveBeenCalledOnce()
    expect(second).not.toHaveBeenCalled()
    expect(store.read().scopes).toHaveLength(1)
    expect(h.changes).toHaveLength(1)
  })

  it('keeps memory, medium and notifications unchanged when a durable write fails', async () => {
    const directory = await root()
    const pool = new MemoryMediaPool()
    const h = await host(directory, new MemoryStorageBackend(pool))
    const config = configuration(directory)
    const store = await readyStore(h, config)
    const before = store.read()
    const stored = pool.media.get(learningDomainName(config.profileKey))?.tables.get('ledger')?.get('state')
    h.changes.length = 0
    pool.failNextWrites = 1
    await expect(store.update(0, 0, () => evidenceData())).rejects.toThrow('injected write failure')
    expect(store.read()).toEqual(before)
    expect(pool.media.get(learningDomainName(config.profileKey))?.tables.get('ledger')?.get('state')).toBe(stored)
    expect(h.changes).toEqual([])
    expect((await store.update(0, 0, () => scopeData())).revision).toBe(1)
  })

  it('releases ownership after initialization fails before readiness', async () => {
    const directory = await root()
    const pool = new MemoryMediaPool()
    pool.failNextWrites = 1
    const h = await host(directory, new MemoryStorageBackend(pool))
    const config = configuration(directory)
    await expect(open(h, config)).rejects.toThrow('injected write failure')
    await expect(readFile(`${config.ownershipLockPath}.lock`, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(h.facility.get(learningDomainName(config.profileKey))).toBeUndefined()
    expect((await readyStore(h, config)).read().revision).toBe(0)
  })

  it('commits active pointers with their proposal and version as one durable row', async () => {
    const directory = await root()
    const h = await host(directory)
    const config = configuration(directory)
    const store = await readyStore(h, config)
    const data = evidenceData()
    h.changes.length = 0
    const observed: LearningLedger[] = []
    h.ctx.on('domain/changed', () => { observed.push(store.read()) })
    const committed = await store.update(0, 0, () => data)
    expect(h.changes).toHaveLength(1)
    expect(observed).toEqual([committed])
    expect(observed[0]?.scopes[0]?.activeVersionId).toBe(data.versions[0]?.id)
    expect(observed[0]?.proposals).toHaveLength(1)
    expect(observed[0]?.versions).toHaveLength(1)
    expect(await diskLedger(directory, config)).toEqual(committed)
  })

  it('requires task revision advancement and prevents mutation of retained immutable evidence/version ids', async () => {
    const directory = await root()
    const store = await readyStore(await host(directory), configuration(directory))
    await store.update(0, 0, () => evidenceData())
    const before = store.read()
    await expect(store.update(1, 0, current => ({
      ...dataOf(current), tasks: current.tasks.map(task => ({ ...task, outcome: 'failure' as const })),
    }))).rejects.toMatchObject({ code: 'invalid-ledger' })
    await expect(store.update(1, 0, current => ({
      ...dataOf(current), proposals: current.proposals.map(proposal => ({ ...proposal, expiresAt: proposal.expiresAt + 1 })),
    }))).rejects.toMatchObject({ code: 'invalid-ledger' })
    await expect(store.update(1, 0, current => ({
      ...dataOf(current), versions: current.versions.map(version => ({ ...version, validUntil: version.validUntil + 1 })),
    }))).rejects.toMatchObject({ code: 'invalid-ledger' })
    expect(store.read()).toEqual(before)
    const changed = await store.update(1, 0, current => ({
      ...dataOf(current), tasks: current.tasks.map(task => ({ ...task, revision: task.revision + 1, outcome: 'failure' as const })),
    }))
    expect(changed.tasks.every(task => task.revision === 1 && task.outcome === 'failure')).toBe(true)
  })

  it('requires an active proposal to remain present but permits explicit withdrawal and pruning in one transaction', async () => {
    const directory = await root()
    const store = await readyStore(await host(directory), configuration(directory))
    await store.update(0, 0, () => evidenceData())
    await expect(store.update(1, 0, current => ({ ...dataOf(current), proposals: [] })))
      .rejects.toMatchObject({ code: 'invalid-ledger' })
    await expect(store.update(1, 0, current => ({ ...dataOf(current), versions: [] })))
      .rejects.toMatchObject({ code: 'invalid-ledger' })
    const pruned = await store.update(1, 0, current => ({
      ...dataOf(current), scopes: current.scopes.map(scope => ({ ...scope, activeVersionId: null })), proposals: [],
    }))
    expect(pruned.proposals).toEqual([])
    expect(pruned.versions).toHaveLength(1)
    expect(pruned.scopes[0]?.activeVersionId).toBeNull()
  })

  it('permits unavailable inactive ancestry after pruning but rejects active cross-scope references', async () => {
    const directory = await root()
    const store = await readyStore(await host(directory), configuration(directory))
    const data = evidenceData()
    const inactive = {
      ...data,
      scopes: data.scopes.map(scope => ({ ...scope, activeVersionId: null })),
      versions: data.versions.map(version => ({
        ...version, parentVersionId: brandString<LearningVersionId>(uuid(999)),
      })),
    }
    await expect(store.update(0, 0, () => inactive)).resolves.toMatchObject({ revision: 1 })
    const otherScope = { id: brandString<LearningScopeId>(uuid(2)), cohort: COHORT, activeVersionId: data.versions[0]!.id }
    await expect(store.update(1, 0, current => ({ ...dataOf(current), scopes: [...current.scopes, otherScope] })))
      .rejects.toMatchObject({ code: 'invalid-ledger' })
  })

  it('advances clear epoch and revision, fences queued old writers, and does not touch unrelated Session/settings files', async () => {
    const directory = await root()
    const config = configuration(directory)
    const sessionFile = join(directory, 'session-marker.json')
    const settingsFile = join(directory, 'settings-marker.json')
    await writeFile(sessionFile, 'preserve Session', 'utf8')
    await writeFile(settingsFile, 'preserve settings', 'utf8')
    const store = await readyStore(await host(directory), config)
    await store.update(0, 0, () => evidenceData())
    const staleTransform = vi.fn(() => evidenceData())
    const cleared = store.clear(1, 0)
    await Promise.all([
      expect(cleared).resolves.toEqual({ schemaVersion: 1, profileKey: 'web', revision: 2, epoch: 1, ...empty() }),
      expect(store.update(1, 0, staleTransform)).rejects.toMatchObject({ code: 'epoch-conflict' }),
    ])
    expect(staleTransform).not.toHaveBeenCalled()
    expect(await readFile(sessionFile, 'utf8')).toBe('preserve Session')
    expect(await readFile(settingsFile, 'utf8')).toBe('preserve settings')
    expect((await store.update(2, 1, () => scopeData())).revision).toBe(3)
  })

  it('closes admission immediately, drains accepted writes, and keeps ownership until the drain completes', async () => {
    const directory = await root()
    const config = configuration(directory)
    const entered = deferred()
    const release = deferred()
    let hold = false
    let unitClosed = false
    const h = await host(directory, new JsonStorageBackend(join(directory, 'data')), {
      beforePut: async () => {
        if (!hold) return
        entered.resolve(undefined)
        await release.promise
      },
      openedUnit: (unit) => {
        const close = unit.close.bind(unit)
        vi.spyOn(unit, 'close').mockImplementation(async () => { unitClosed = true; await close() })
      },
    })
    const store = await readyStore(h, config)
    hold = true
    const write = store.update(0, 0, () => scopeData())
    let closing: Promise<void> | undefined
    try {
      await entered.promise
      closing = store.close()
      expect(store.close()).toBe(closing)
      await expect(store.update(0, 0, () => empty())).rejects.toMatchObject({ code: 'closed' })
      await expect(store.clear(0, 0)).rejects.toMatchObject({ code: 'closed' })
      expect(unitClosed).toBe(false)
      const contender = await host(directory)
      expect(await open(contender, config)).toEqual({ available: false, reason: 'ownership-unavailable' })
      expect(unitClosed).toBe(false)
      release.resolve(undefined)
      await expect(write).resolves.toMatchObject({ revision: 1 })
      await closing
      expect(unitClosed).toBe(true)
      expect(() => store.read()).toThrow('closed')
      expect((await readyStore(contender, config)).read().revision).toBe(1)
    } finally {
      release.resolve(undefined)
      await Promise.allSettled([write, ...closing === undefined ? [] : [closing]])
    }
  })

  it('returns owned frozen views and gives transforms no mutable alias into stored records', async () => {
    const directory = await root()
    const store = await readyStore(await host(directory), configuration(directory))
    const committed = await store.update(0, 0, () => evidenceData())
    const first = store.read()
    const second = store.read()
    expect(first).toEqual(committed)
    expect(first).not.toBe(committed)
    expect(first).not.toBe(second)
    expect(first.tasks).not.toBe(second.tasks)
    expect(Object.isFrozen(first.tasks[0]?.basePolicy?.candidates)).toBe(true)
    expect(Object.isFrozen(first.proposals[0]?.evaluationInput.observations)).toBe(true)
    expect(Reflect.set(first, 'revision', 100)).toBe(false)
    expect(Reflect.set(first.scopes, '0', null)).toBe(false)
    await store.update(1, 0, (current) => {
      expect(current).not.toBe(first)
      expect(Object.isFrozen(current)).toBe(true)
      expect(Reflect.set(current, 'epoch', 100)).toBe(false)
      return dataOf(current)
    })
    expect(store.read()).toMatchObject({ revision: 2, epoch: 0 })
  })
})

describe('learning ledger bounds and privacy', () => {
  it.each(['configRevision', 'contextRevision'] as const)(
    'requires a closed bounded %s stamp and preserves it durably without permitting replacement', async (field) => {
      const directory = await root()
      const config = configuration(directory)
      const h = await host(directory)
      const store = await readyStore(h, config)
      const data = evidenceData()
      const schema = createLearningLedgerSchema(config)
      const ledger = { schemaVersion: 1, profileKey: 'web', revision: 0, epoch: 0, ...data }
      const proposal = data.proposals[0]!
      const withoutStamp = Object.fromEntries(Object.entries(proposal).filter(([key]) => key !== field))
      expect(() => schema.parse({ ...ledger, proposals: [withoutStamp] })).toThrow()
      for (const value of [undefined, null, '', ' ', 'private prose', 'revision/path', 'x'.repeat(129), 1]) {
        expect(() => schema.parse({ ...ledger, proposals: [{ ...proposal, [field]: value }] })).toThrow()
      }
      for (const value of ['x', uuid(50), 'a'.repeat(64), 'v1.Config:revision_2-3', 'x'.repeat(128)]) {
        expect(schema.parse({ ...ledger, proposals: [{ ...proposal, [field]: value }] }).proposals[0]?.[field]).toBe(value)
      }
      expect(() => schema.parse({ ...ledger, proposals: [{ ...proposal, revisionExplanation: 'private prose' }] })).toThrow()
      const stamp = 'x'.repeat(128)
      const committed = await store.update(0, 0, () => ({
        ...data, proposals: [{ ...proposal, [field]: stamp }],
      }))
      expect(committed.versions[0]?.proposalId).toBe(committed.proposals[0]?.id)
      h.changes.length = 0
      await expect(store.update(1, 0, current => ({
        ...dataOf(current), proposals: current.proposals.map(record => ({ ...record, [field]: 'replacement' })),
      }))).rejects.toMatchObject({ code: 'invalid-ledger' })
      expect(store.read()).toEqual(committed)
      expect(h.changes).toEqual([])
      await store.close()
      const reopened = await readyStore(await host(directory), config)
      expect(reopened.read().proposals[0]?.[field]).toBe(stamp)
      expect(reopened.read()).toEqual(committed)
    },
  )

  it.each(['maxScopes', 'maxTasks', 'maxProposals', 'maxVersions', 'maxObservationsPerProposal'] as const)(
    'enforces the explicit %s record bound without a partial write', async (limit) => {
      const directory = await root()
      const config = configuration(directory, { limits: limits({ [limit]: 1 }) })
      const h = await host(directory)
      const store = await readyStore(h, config)
      const full = evidenceData()
      const data: LearningLedgerData = limit === 'maxScopes'
        ? {
          ...empty(),
          scopes: [scopeData().scopes[0]!, { id: brandString<LearningScopeId>(uuid(2)), cohort: COHORT, activeVersionId: null }],
        }
        : limit === 'maxTasks' ? { ...scopeData(), tasks: [taskRecord(10), taskRecord(11)] }
          : limit === 'maxProposals' ? {
            ...full, proposals: [...full.proposals, { ...full.proposals[0]!, id: brandString<LearningProposalId>(uuid(21)) }],
          }
            : limit === 'maxVersions' ? {
              ...full, versions: [...full.versions, { ...full.versions[0]!, id: brandString<LearningVersionId>(uuid(31)) }],
            } : full
      h.changes.length = 0
      await expect(store.update(0, 0, () => data)).rejects.toThrow()
      expect(store.read().revision).toBe(0)
      expect(h.changes).toEqual([])
    },
  )

  it('enforces exact complete-ledger UTF-8 bytes including identity and revision metadata', async () => {
    const directory = await root()
    const initial = { schemaVersion: 1, profileKey: 'web', revision: 0, epoch: 0, ...empty() }
    const schema = createLearningLedgerSchema(configuration(directory))
    const bytes = Buffer.byteLength(JSON.stringify(schema.parse(initial)), 'utf8')
    const exact = configuration(directory, { limits: limits({ maxLedgerBytes: bytes }) })
    const h = await host(directory)
    const store = await readyStore(h, exact)
    expect(store.read()).toEqual(initial)
    await expect(store.update(0, 0, () => scopeData())).rejects.toMatchObject({ code: 'limit-exceeded' })
    expect(store.read().revision).toBe(0)
    await store.close()
    await expect(open(await host(directory), configuration(directory, { limits: limits({ maxLedgerBytes: bytes - 1 }) })))
      .rejects.toMatchObject({ code: 'invalid-record' })
  })

  it('rejects unknown/prose fields, invalid identity/category data and caller-supplied concurrency stamps', async () => {
    const directory = await root()
    const store = await readyStore(await host(directory), configuration(directory))
    for (const field of ['prompt', 'code', 'error', 'profileKey', 'revision', 'epoch']) {
      const data = { ...empty(), [field]: 'not a ledger-data field' }
      await expect(store.update(0, 0, () => data)).rejects.toMatchObject({ code: 'invalid-ledger' })
    }
    const task = taskRecord()
    const schema = createLearningLedgerSchema(configuration(directory))
    const ledger = { schemaVersion: 1, profileKey: 'web', revision: 0, epoch: 0, ...scopeData() }
    for (const patch of [
      { id: 'not-server-owned' }, { sessionId: 'raw prompt text' }, { category: 'free prose' },
      { classifierRevision: 'arbitrary error text' }, { note: 'private feedback' }, { observedRelativeWork: Infinity },
    ]) expect(() => schema.parse({ ...ledger, tasks: [{ ...task, ...patch }] })).toThrow()
    expect(store.read().revision).toBe(0)
  })

  it('keeps unknown/incomplete task facts nullable without treating missing work as zero', async () => {
    const directory = await root()
    const store = await readyStore(await host(directory), configuration(directory))
    const task: LearningTaskRecord = {
      ...taskRecord(), scopeId: null, cohort: null, category: null, complexity: null, mode: null, role: null,
      candidateId: null, resolvedSelection: null, basePolicy: null, basePolicyFingerprint: null,
      classifierRevision: null, metricRevision: null, state: 'pending', completedAt: null,
      observedRelativeWork: null, workComplete: false, incompleteReasons: ['not-sealed', 'unattributed-scope'],
      outcome: 'unknown', evidence: 'unverified',
    }
    const committed = await store.update(0, 0, () => ({ ...empty(), tasks: [task] }))
    expect(committed.tasks[0]).toMatchObject({ observedRelativeWork: null, outcome: 'unknown', state: 'pending' })
    await expect(store.update(1, 0, current => ({
      ...dataOf(current), tasks: [{ ...task, revision: 1, observedRelativeWork: 0 }],
    }))).rejects.toThrow()
  })

  it('allows complete measured work with an explicitly unknown quality outcome', async () => {
    const directory = await root()
    const store = await readyStore(await host(directory), configuration(directory))
    const task: LearningTaskRecord = { ...taskRecord(), outcome: 'unknown', evidence: 'unverified' }
    const committed = await store.update(0, 0, () => ({ ...scopeData(), tasks: [task] }))
    expect(committed.tasks[0]).toMatchObject({ workComplete: true, observedRelativeWork: 100, outcome: 'unknown' })
  })

  it('emits only storage changes and never invokes network, Session, or feedback mechanisms', async () => {
    const directory = await root()
    const h = await host(directory)
    const emit = vi.spyOn(h.ctx, 'emit')
    const fetch = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected network request'))
    const store = await readyStore(h, configuration(directory))
    await store.update(0, 0, () => evidenceData())
    await store.clear(1, 0)
    await store.close()
    expect(fetch).not.toHaveBeenCalled()
    expect(emit.mock.calls.map(call => call[0])).toEqual(['domain/changed', 'domain/changed', 'domain/changed'])
  })
})
