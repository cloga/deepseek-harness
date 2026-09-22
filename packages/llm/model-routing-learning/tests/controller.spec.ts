import { describe, expect, it } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { parseRoutingPolicy } from '@deepseek-ai/dsh-model-routing'
import { fingerprintAdaptiveBasePolicy, parseAdaptivePolicyConfig } from '@deepseek-ai/dsh-model-routing/adaptive'
import type { AdaptiveCohortKey } from '@deepseek-ai/dsh-model-routing/adaptive-types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { LearningController, LearningControllerError } from '../src/controller.ts'
import type { LearningControllerConfig, LearningCurrentContext } from '../src/controller-types.ts'
import { createLearningLedgerSchema, LearningStoreError } from '../src/schema.ts'
import type {
  LearningLedger, LearningLedgerData, LearningProposalId, LearningScopeId, LearningStore,
  LearningStoreConfig, LearningTaskId, LearningTaskRecord, LearningVersionId,
} from '../src/types.ts'

const uuid = (value: number): string => `00000000-0000-4000-8000-${String(value).padStart(12, '0')}`
const SCOPE = brandString<LearningScopeId>(uuid(1))
const COHORT = brandString<AdaptiveCohortKey>('a'.repeat(64))
const BASE = parseRoutingPolicy({
  candidates: [
    { id: 'a', selection: { provider: 'local', model: 'a', reasoningEffort: 'low' }, quality: 2, relativeCost: 10 },
    { id: 'b', selection: { provider: 'local', model: 'b', reasoningEffort: 'low' }, quality: 2, relativeCost: 11 },
    { id: 'safe', selection: { provider: 'local', model: 'safe', reasoningEffort: 'high' }, quality: 3, relativeCost: 20 },
  ],
  qualityFloors: {
    efficiency: { routine: 1, standard: 2, complex: 3 },
    balanced: { routine: 2, standard: 2, complex: 3 },
    intelligence: { routine: 3, standard: 3, complex: 3 },
  }, minConfidence: 0.8, conservativeCandidateId: 'safe',
})
const GUARDS = parseAdaptivePolicyConfig({
  minSamplesPerCandidate: 4, observationWindowMs: 1_000, maxObservations: 16,
  minRelativeImprovement: 0.2, maxFailureRate: 0.8, maxFailureRateRegression: 0.8,
  confidenceZ: 1, maxRelativeWeightChange: 0.2,
})
const STORE_CONFIG: LearningStoreConfig = {
  profileKey: 'private_profile', ownershipLockPath: 'C:\\unused-controller-only-lock', ownershipWaitMs: 100,
  limits: { maxScopes: 4, maxTasks: 100, maxProposals: 32, maxVersions: 32, maxObservationsPerProposal: 16, maxLedgerBytes: 2_000_000 },
}
const SCHEMA = createLearningLedgerSchema(STORE_CONFIG)

/** Queued CAS fake uses the REAL closed store schema; only storage I/O is replaced. */
class Store implements LearningStore {
  private ledger: LearningLedger
  private tail: Promise<unknown> = Promise.resolve()
  constructor(tasks: readonly LearningTaskRecord[]) {
    this.ledger = SCHEMA.parse({ schemaVersion: 1, profileKey: STORE_CONFIG.profileKey, revision: 0, epoch: 0,
      scopes: [{ id: SCOPE, cohort: COHORT, activeVersionId: null }], tasks, proposals: [], versions: [] })
  }
  read(): LearningLedger { return SCHEMA.parse(structuredClone(this.ledger)) }
  update(revision: number, epoch: number, transform: (current: LearningLedger) => LearningLedgerData): Promise<LearningLedger> {
    return this.queue(() => {
      this.check(revision, epoch)
      const next = transform(this.read())
      this.ledger = SCHEMA.parse({ ...next, schemaVersion: 1, profileKey: this.ledger.profileKey, revision: revision + 1, epoch })
      return this.read()
    })
  }
  clear(revision: number, epoch: number): Promise<LearningLedger> {
    return this.queue(() => {
      this.check(revision, epoch)
      this.ledger = SCHEMA.parse({ schemaVersion: 1, profileKey: this.ledger.profileKey, revision: revision + 1, epoch: epoch + 1,
        scopes: [], tasks: [], proposals: [], versions: [] })
      return this.read()
    })
  }
  close(): Promise<void> { return this.tail.then(() => {}) }
  /** Simulate a new server-owned collector revision or an adversarial restored row; no controller endpoint exposes this. */
  replace(transform: (ledger: LearningLedger) => LearningLedgerData): void {
    this.ledger = SCHEMA.parse({ ...this.ledger, ...transform(this.read()), revision: this.ledger.revision + 1 })
  }
  private check(revision: number, epoch: number): void {
    if (epoch !== this.ledger.epoch) throw new LearningStoreError('epoch-conflict')
    if (revision !== this.ledger.revision) throw new LearningStoreError('revision-conflict')
  }
  private queue(operation: () => LearningLedger): Promise<LearningLedger> {
    const result = this.tail.then(operation)
    this.tail = result.then(() => undefined, () => undefined)
    return result
  }
}

function task(index: number, candidateId: 'a' | 'b' = index < 4 ? 'a' : 'b'): LearningTaskRecord {
  return {
    id: brandString<LearningTaskId>(uuid(10 + index)), sessionId: brandString<SessionId>(`private-session-${index}`),
    scopeId: SCOPE, cohort: COHORT, category: 'code-edit', complexity: 'routine', mode: 'balanced', role: 'main',
    candidateId, resolvedSelection: { provider: 'local', model: candidateId, reasoningEffort: 'low' },
    basePolicy: BASE, basePolicyFingerprint: fingerprintAdaptiveBasePolicy(BASE),
    classifierRevision: 'private-classifier-revision', metricRevision: 'private-fixed-token-metric',
    revision: 0, state: 'sealed', createdAt: 800, completedAt: 900 + index,
    observedRelativeWork: candidateId === 'a' ? 100 : 10, workComplete: true, incompleteReasons: [],
    outcome: 'success', evidence: 'validator',
  }
}

function fixture(tasks = Array.from({ length: 8 }, (_, index) => task(index))) {
  const store = new Store(tasks)
  let now = 1_000
  let config: LearningControllerConfig = { revision: 'config-1', enabled: true, guards: GUARDS, proposalTtlMs: 100, versionTtlMs: 500 }
  let context: LearningCurrentContext | undefined = {
    profileKey: STORE_CONFIG.profileKey, scopeId: SCOPE, contextRevision: 'context-1', cohort: COHORT,
    category: 'code-edit', role: 'main', mode: 'balanced', complexity: 'routine', basePolicy: BASE,
    classifierRevision: 'private-classifier-revision', metricRevision: 'private-fixed-token-metric',
    eligibleCandidates: BASE.candidates.map(candidate => ({ candidateId: candidate.id, resolvedSelection: { ...candidate.selection } })),
  }
  let proposalSequence = 1_000
  let versionSequence = 2_000
  const controller = new LearningController({ store,
    config: () => config, context: () => context, now: () => now,
    proposalId: () => brandString<LearningProposalId>(uuid(++proposalSequence)),
    versionId: () => brandString<LearningVersionId>(uuid(++versionSequence)),
  })
  const stamp = () => ({ expectedRevision: store.read().revision, expectedEpoch: store.read().epoch })
  return { store, controller, stamp, now: (value: number) => { now = value },
    config: () => config, setConfig: (value: LearningControllerConfig) => { config = value },
    context: () => context as LearningCurrentContext, setContext: (value: LearningCurrentContext | undefined) => { context = value } }
}

type Fixture = ReturnType<typeof fixture>
async function propose(h: Fixture): Promise<LearningProposalId> {
  const result = await h.controller.evaluate({ scopeId: SCOPE, ...h.stamp() })
  if (result.kind !== 'proposal') throw new Error(`expected real evaluator proposal, got ${result.reasonCode}`)
  return result.proposal.id
}
async function approve(h: Fixture): Promise<LearningVersionId> {
  const proposalId = await propose(h)
  const result = await h.controller.apply({ proposalId, ...h.stamp() })
  const version = result.scopes[0]?.activeVersionId
  if (version === undefined || version === null) throw new Error('no approved version')
  return version
}

function expectCode(pending: Promise<unknown>, code: string) {
  return expect(pending).rejects.toMatchObject({ name: 'LearningControllerError', code })
}

describe('sealed-evidence proposal authority', () => {
  it('uses the production evaluator and commits immutable evidence/config/task revisions without activation', async () => {
    const h = fixture()
    const id = await propose(h)
    const ledger = h.store.read()
    const proposal = ledger.proposals.find(record => record.id === id)
    expect(proposal).toMatchObject({ configRevision: 'config-1', contextRevision: 'context-1', createdAt: 1_000, expiresAt: 1_100,
      proposal: { baselineCandidateId: 'a', winnerCandidateId: 'b', changes: [{ candidateId: 'b', before: 11, after: 8.8 }] } })
    expect(proposal?.sourceTaskRevisions).toHaveLength(8)
    expect(proposal?.evaluationInput.observations.map(row => row.observationId)).toEqual(ledger.tasks.map(row => row.id))
    expect(Object.isFrozen(proposal)).toBe(true)
    expect(ledger.scopes[0]?.activeVersionId).toBeNull()
    expect(h.controller.activeOverlay(SCOPE)).toBeUndefined()
  })

  it('does not infer verified success or complete work from a sealed task', async () => {
    const h = fixture(Array.from({ length: 8 }, (_, index) => ({ ...task(index), evidence: 'unverified' as const })))
    const result = await h.controller.evaluate({ scopeId: SCOPE, ...h.stamp() })
    expect(result).toMatchObject({ kind: 'no-proposal', reasonCode: 'no-comparable-observations' })
    expect(h.store.read().revision).toBe(0)
    const incomplete = fixture(Array.from({ length: 8 }, (_, index) => ({ ...task(index), workComplete: false,
      observedRelativeWork: null, incompleteReasons: ['unknown-child-work' as const] })))
    expect(await incomplete.controller.evaluate({ scopeId: SCOPE, ...incomplete.stamp() }))
      .toMatchObject({ kind: 'no-proposal', reasonCode: 'no-comparable-observations' })
  })

  it('uses only the bounded newest sealed matching cohort, not pending or unrelated records', async () => {
    const rows = Array.from({ length: 24 }, (_, index) => task(index, index % 2 === 0 ? 'a' : 'b'))
    const pending: LearningTaskRecord = { ...task(30), state: 'pending', createdAt: 1_000, completedAt: null,
      observedRelativeWork: null, workComplete: false, incompleteReasons: ['not-sealed'], outcome: 'unknown', evidence: 'unverified' }
    const h = fixture([...rows, pending, { ...task(31), classifierRevision: 'old-classifier' }])
    await propose(h)
    const sources = h.store.read().proposals[0]?.sourceTaskRevisions
    expect(sources).toHaveLength(16)
    expect(new Set(sources?.map(source => source.taskId))).toEqual(new Set(rows.slice(8).map(row => row.id)))
  })

  it.each(['observations', 'outcome', 'weights', 'guardConfig', 'basePolicy', 'cohort'])('rejects client-owned %s fields', async (key) => {
    const h = fixture()
    await expectCode(h.controller.evaluate({ scopeId: SCOPE, ...h.stamp(), [key]: [] }), 'invalid-request')
    await expectCode(h.controller.apply({ proposalId: uuid(1_001), ...h.stamp(), [key]: [] }), 'invalid-request')
    expect(h.store.read().revision).toBe(0)
  })

  it('rejects stale revision and epoch at the authoritative write queue', async () => {
    const h = fixture()
    const firstStamp = h.stamp()
    const id = await propose(h)
    await expectCode(h.controller.apply({ proposalId: id, ...firstStamp }), 'revision-conflict')
    await expectCode(h.controller.apply({ proposalId: id, ...h.stamp(), expectedEpoch: 9 }), 'epoch-conflict')
  })

  it('reevaluates config and context again after the proposal operation enters the queue', async () => {
    const h = fixture()
    const pending = h.controller.evaluate({ scopeId: SCOPE, ...h.stamp() })
    h.setConfig({ ...h.config(), revision: 'config-2' })
    await expectCode(pending, 'stale-config')
    expect(h.store.read().proposals).toHaveLength(0)
    const later = h.controller.evaluate({ scopeId: SCOPE, ...h.stamp() })
    h.setContext({ ...h.context(), contextRevision: 'context-2' })
    await expectCode(later, 'stale-context')
  })
})

describe('proposal-ID approval and retained version authority', () => {
  it('approves one bounded overlay of the human base without mutating a Session or the base', async () => {
    const h = fixture()
    const id = await approve(h)
    const version = h.store.read().versions[0]
    expect(version).toMatchObject({
      id, parentVersionId: null, basePolicyFingerprint: fingerprintAdaptiveBasePolicy(BASE), validUntil: 1_500,
    })
    expect(version?.weights).toEqual([{ candidateId: 'a', relativeCost: 10 }, { candidateId: 'b', relativeCost: 8.8 }, { candidateId: 'safe', relativeCost: 20 }])
    expect(BASE.candidates[1]?.relativeCost).toBe(11)
    const overlay = h.controller.activeOverlay(SCOPE)
    expect(Object.keys(overlay ?? {}).sort()).toEqual(['basePolicyFingerprint', 'complexity', 'mode', 'validUntil', 'versionId', 'weights'])
    expect(overlay).toMatchObject({ versionId: id, mode: 'balanced', complexity: 'routine', validUntil: 1_500 })
    expect(Object.isFrozen(overlay)).toBe(true)
  })

  it('does not compound approved weights and preserves immutable lineage when rolling back', async () => {
    const h = fixture()
    const firstId = await approve(h)
    const first = h.store.read().versions[0]
    h.now(1_010)
    const secondId = await approve(h)
    const second = h.store.read().versions[1]
    expect(second).toMatchObject({ parentVersionId: firstId, weights: first?.weights })
    expect(h.store.read().versions[0]).toEqual(first)
    await h.controller.rollback({ versionId: firstId, ...h.stamp() })
    expect(h.controller.activeOverlay(SCOPE)?.versionId).toBe(firstId)
    expect(h.store.read().versions[1]?.id).toBe(secondId)
    expect(h.store.read().versions[0]).toEqual(first)
  })

  it('does not apply an already approved proposal twice', async () => {
    const h = fixture()
    const id = await propose(h)
    await h.controller.apply({ proposalId: id, ...h.stamp() })
    await expectCode(h.controller.apply({ proposalId: id, ...h.stamp() }), 'already-approved')
    expect(h.store.read().versions).toHaveLength(1)
  })

  it.each(['config', 'context', 'base', 'eligibility', 'metric', 'classifier'] as const)('refuses changed authoritative %s before approval', async (changed) => {
    const h = fixture()
    const id = await propose(h)
    if (changed === 'config') h.setConfig({ ...h.config(), revision: 'config-2' })
    else if (changed === 'context') h.setContext({ ...h.context(), contextRevision: 'context-2' })
    else if (changed === 'base') h.setContext({ ...h.context(), basePolicy: parseRoutingPolicy({ ...BASE, minConfidence: 0.9 }) })
    else if (changed === 'eligibility') h.setContext({ ...h.context(), eligibleCandidates: h.context().eligibleCandidates.filter(entry => entry.candidateId !== 'b') })
    else if (changed === 'metric') h.setContext({ ...h.context(), metricRevision: 'changed-fixed-metric' })
    else h.setContext({ ...h.context(), classifierRevision: 'changed-classifier' })
    await expect(h.controller.apply({ proposalId: id, ...h.stamp() })).rejects.toBeInstanceOf(LearningControllerError)
    expect(h.store.read().versions).toHaveLength(0)
  })

  it('rejects config disable/re-enable and context ABA even when all content returns to prior values', async () => {
    const h = fixture()
    const id = await propose(h)
    const original = h.config()
    h.setConfig({ ...original, enabled: false, revision: 'config-2' })
    await expectCode(h.controller.apply({ proposalId: id, ...h.stamp() }), 'disabled')
    h.setConfig({ ...original, enabled: true, revision: 'config-3' })
    await expectCode(h.controller.apply({ proposalId: id, ...h.stamp() }), 'stale-config')
    const fresh = await propose(h)
    h.setContext({ ...h.context(), contextRevision: 'context-3' })
    await expectCode(h.controller.apply({ proposalId: fresh, ...h.stamp() }), 'stale-context')
  })

  it.each(['revision', 'new-adverse-task', 'removed-task'] as const)('requires fresh evaluation after source %s changes', async (change) => {
    const h = fixture()
    const id = await propose(h)
    h.store.replace(ledger => ({ ...ledger,
      tasks: change === 'revision' ? ledger.tasks.map((row, index) => index === 0 ? { ...row, revision: row.revision + 1 } : row)
        : change === 'removed-task' ? ledger.tasks.slice(1)
          : [...ledger.tasks, { ...task(9, 'b'), completedAt: 999, outcome: 'failure' as const, observedRelativeWork: 10_000 }],
    }))
    await expect(h.controller.apply({ proposalId: id, ...h.stamp() })).rejects.toBeInstanceOf(LearningControllerError)
  })

  it('does not invalidate sealed evidence merely because an unsealed task appears', async () => {
    const h = fixture()
    const id = await approve(h)
    h.store.replace(ledger => ({ ...ledger, tasks: [...ledger.tasks, { ...task(99), state: 'pending', completedAt: null,
      workComplete: false, observedRelativeWork: null, incompleteReasons: ['not-sealed'], outcome: 'unknown', evidence: 'unverified' }] }))
    expect(h.controller.activeOverlay(SCOPE)?.versionId).toBe(id)
  })

  it('checks the approval deadline independently of approved version lifetime and evidence freshness', async () => {
    const h = fixture()
    const id = await propose(h)
    h.now(1_100)
    await expectCode(h.controller.apply({ proposalId: id, ...h.stamp() }), 'expired')
    const approved = fixture()
    const versionId = await approve(approved)
    approved.now(1_101)
    expect(approved.controller.activeOverlay(SCOPE)?.versionId).toBe(versionId)
    await approved.controller.rollback({ versionId, ...approved.stamp() })
    approved.now(1_500)
    expect(approved.controller.activeOverlay(SCOPE)).toBeUndefined()
    await expectCode(approved.controller.rollback({ versionId, ...approved.stamp() }), 'expired')
  })

  it('recomputes evidence instead of trusting a structurally valid forged proposal', async () => {
    const h = fixture()
    const id = await propose(h)
    h.store.replace(ledger => ({ ...ledger, proposals: ledger.proposals.map(record => ({ ...record,
      proposal: { ...record.proposal, changes: [{ ...record.proposal.changes[0], after: 8.9 }] },
    })) }))
    await expectCode(h.controller.apply({ proposalId: id, ...h.stamp() }), 'invalid-evidence')
  })

  it('rejects forged version weights despite a correct base fingerprint and valid retained evidence', async () => {
    const h = fixture()
    const id = await approve(h)
    h.store.replace(ledger => ({ ...ledger, versions: ledger.versions.map(version => ({ ...version,
      weights: version.weights.map(weight => weight.candidateId === 'b' ? { ...weight, relativeCost: 8.9 } : weight),
    })) }))
    expect(h.controller.activeOverlay(SCOPE)).toBeUndefined()
    await expectCode(h.controller.rollback({ versionId: id, ...h.stamp() }), 'invalid-version')
    expect(h.controller.view().versions[0]).toMatchObject({ active: false, status: 'invalid-version' })
  })

  it('does not return active weights when new qualifying evidence changes their approved source set', async () => {
    const h = fixture()
    const id = await approve(h)
    h.store.replace(ledger => ({ ...ledger, tasks: [...ledger.tasks, { ...task(10, 'b'), completedAt: 999, outcome: 'failure' as const }] }))
    expect(h.controller.activeOverlay(SCOPE)).toBeUndefined()
    await expectCode(h.controller.rollback({ versionId: id, ...h.stamp() }), 'stale-source')
  })
})

describe('disable, clear, safe views and queued admission', () => {
  it('invalidates all proposals and active pointers without rewriting immutable version history', async () => {
    const h = fixture()
    const id = await approve(h)
    await propose(h)
    const version = h.store.read().versions[0]
    const disabled = await h.controller.disable(h.stamp())
    expect(disabled.proposals).toEqual([])
    expect(disabled.scopes[0]?.activeVersionId).toBeNull()
    expect(h.store.read().versions[0]).toEqual(version)
    expect(h.store.read().tasks).toHaveLength(8)
    expect(h.controller.activeOverlay(SCOPE)).toBeUndefined()
    await expectCode(h.controller.rollback({ versionId: id, ...h.stamp() }), 'missing-evidence')
  })

  it('fences an old evaluation behind disable via the queued ledger revision', async () => {
    const h = fixture()
    const stamp = h.stamp()
    const disabling = h.controller.disable(stamp)
    const evaluation = h.controller.evaluate({ scopeId: SCOPE, ...stamp })
    const refused = expectCode(evaluation, 'revision-conflict')
    await disabling
    await refused
    expect(h.store.read().proposals).toHaveLength(0)
  })

  it('advances the clear epoch and refuses an in-flight pre-clear evaluation', async () => {
    const h = fixture()
    const stamp = h.stamp()
    const clearing = h.controller.clear(stamp)
    const evaluation = h.controller.evaluate({ scopeId: SCOPE, ...stamp })
    const refused = expectCode(evaluation, 'epoch-conflict')
    const result = await clearing
    await refused
    expect(result).toMatchObject({ revision: 1, epoch: 1, scopes: [], proposals: [], versions: [] })
    expect(h.store.read().tasks).toEqual([])
  })

  it('returns cropped views without raw evidence, config tokens, profile/cohort keys or Session identities', async () => {
    const h = fixture()
    await approve(h)
    const view = h.controller.view()
    const text = JSON.stringify(view)
    for (const secret of ['private_profile', 'private-session', 'private-classifier', 'private-fixed-token', 'context-1', 'config-1', COHORT,
      'sourceTaskRevisions', 'evaluationInput', 'basePolicy', 'observations', 'observedRelativeWork']) {
      expect(text).not.toContain(secret)
    }
    expect(Object.isFrozen(view)).toBe(true)
    expect(view.versions[0]).toMatchObject({ active: true, status: 'ready' })
    h.setContext(undefined)
    expect(h.controller.activeOverlay(SCOPE)).toBeUndefined()
    expect(h.controller.view().versions[0]).toMatchObject({ active: false, status: 'context-unavailable' })
  })

  it('refuses invalid clocks and disabled evaluation without creating evidence or changing weights', async () => {
    const h = fixture()
    h.now(NaN)
    await expectCode(h.controller.evaluate({ scopeId: SCOPE, ...h.stamp() }), 'invalid-clock')
    h.now(1_000)
    h.setConfig({ ...h.config(), enabled: false, revision: 'disabled' })
    await expectCode(h.controller.evaluate({ scopeId: SCOPE, ...h.stamp() }), 'disabled')
    expect(h.store.read().revision).toBe(0)
  })
})
