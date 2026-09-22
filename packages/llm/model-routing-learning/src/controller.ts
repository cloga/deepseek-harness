/** ID-only local approval authority over sealed evidence; no collection, timers or model calls. */

import { brandString } from '@deepseek-ai/dsh-brand'
import { deepEqualJson, deepFreeze } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { parseRoutingPolicy } from '@deepseek-ai/dsh-model-routing'
import type { ModelRoutingPolicy } from '@deepseek-ai/dsh-model-routing/types'
import type { LearningWeightOverlay } from '@deepseek-ai/dsh-model-routing'
import {
  applyAdaptivePolicyPatch, evaluateAdaptivePolicy, fingerprintAdaptiveBasePolicy,
  parseAdaptiveEvaluationInput, parseAdaptivePolicyConfig,
} from '@deepseek-ai/dsh-model-routing/adaptive'
import type { AdaptiveEvaluationInput, AdaptiveObservation, AdaptiveObservationId } from '@deepseek-ai/dsh-model-routing/adaptive-types'
import type {
  LearningLedger, LearningLedgerData, LearningProposalId, LearningProposalRecord, LearningScopeId,
  LearningTaskRecord, LearningVersionId, LearningVersionRecord,
} from './types.ts'
import type {
  LearningControllerConfig, LearningControllerDependencies, LearningControllerErrorCode, LearningControllerEvaluation,
  LearningControllerView, LearningCurrentContext, LearningMutationStamp, LearningProposalView, LearningRecordStatus,
} from './controller-types.ts'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
const uuid = z.uuid().regex(/^[0-9a-f-]+$/)
const stampSchema = z.object({ expectedRevision: count, expectedEpoch: count }).strict()
const evaluateSchema = stampSchema.extend({ scopeId: uuid })
const applySchema = stampSchema.extend({ proposalId: uuid })
const rollbackSchema = stampSchema.extend({ versionId: uuid })
const configSchema = z.object({
  revision: token, enabled: z.boolean(), guards: z.unknown().transform(parseAdaptivePolicyConfig),
  proposalTtlMs: count.positive(), versionTtlMs: count.positive(),
}).strict()

/** Safe refusal with no raw task, configuration or underlying exception prose. */
export class LearningControllerError extends Error {
  /** @param code - Closed reason for a UI/API owner to localize. */
  constructor(readonly code: LearningControllerErrorCode) {
    super(`learning controller: ${code}`)
    this.name = 'LearningControllerError'
  }
}

function fail(code: LearningControllerErrorCode): never { throw new LearningControllerError(code) }

function parse<T>(schema: z.ZodType<T>, value: unknown, code: LearningControllerErrorCode): T {
  try { return schema.parse(value) } catch (_error: unknown) { return fail(code) }
}

function sameStamp(ledger: LearningLedger, request: LearningMutationStamp): void {
  if (ledger.epoch !== request.expectedEpoch) fail('epoch-conflict')
  if (ledger.revision !== request.expectedRevision) fail('revision-conflict')
}

function addTime(now: number, duration: number): number {
  const result = now + duration
  if (!Number.isSafeInteger(result)) fail('invalid-clock')
  return result
}

function routeEqual(
  left: { provider: string; model: string; reasoningEffort?: string },
  right: { provider: string; model: string; reasoningEffort?: string },
): boolean {
  return left.provider === right.provider && left.model === right.model && left.reasoningEffort === right.reasoningEffort
}

function observation(task: LearningTaskRecord): AdaptiveObservation {
  if (task.state !== 'sealed' || task.completedAt === null || task.candidateId === null || task.cohort === null) fail('stale-source')
  return {
    observationId: brandString<AdaptiveObservationId>(task.id), taskId: task.id,
    candidateId: task.candidateId, cohort: task.cohort, evidence: task.evidence, outcome: task.outcome,
    observedRelativeWork: task.observedRelativeWork, workComplete: task.workComplete, completedAt: task.completedAt,
  }
}

interface Snapshot {
  readonly config: LearningControllerConfig
  readonly context: LearningCurrentContext
  readonly baseFingerprint: ReturnType<typeof fingerprintAdaptiveBasePolicy>
  readonly now: number
}

interface ValidatedVersion {
  readonly record: LearningVersionRecord
  readonly proposal: LearningProposalRecord
  readonly policy: ModelRoutingPolicy
  readonly snapshot: Snapshot
}

/** Store-backed approval controller. The owner authenticates callers and supplies trusted local context snapshots. */
export class LearningController {
  constructor(private readonly dependencies: LearningControllerDependencies) {}

  /**
   * Evaluate a bounded recent window of sealed server records, committing an immutable proposal only.
   * @param value - Exactly scopeId, expectedRevision and expectedEpoch; no evidence may be supplied.
   * @returns Cropped proposal or no-proposal diagnostics; no weights are activated.
   */
  async evaluate(value: unknown): Promise<LearningControllerEvaluation> {
    const request = parse(evaluateSchema, value, 'invalid-request')
    const scopeId = brandString<LearningScopeId>(request.scopeId)
    const ledger = this.read()
    sameStamp(ledger, request)
    const snapshot = this.snapshot(ledger, scopeId)
    const tasks = this.recentTasks(ledger, snapshot)
    const input = this.input(tasks, snapshot, snapshot.now)
    const result = this.evaluateEvidence(snapshot, input)
    if (result.kind === 'no-proposal') {
      return deepFreeze({ ...result, revision: ledger.revision, epoch: ledger.epoch })
    }
    const id = this.id(() => this.dependencies.proposalId())
    const record: LearningProposalRecord = deepFreeze({
      id, scopeId, cohort: snapshot.context.cohort, basePolicyFingerprint: snapshot.baseFingerprint,
      configRevision: snapshot.config.revision, contextRevision: snapshot.context.contextRevision,
      guardConfig: snapshot.config.guards, evaluationInput: input, proposal: result.proposal,
      sourceTaskRevisions: tasks.map(task => ({ taskId: task.id, revision: task.revision })),
      createdAt: snapshot.now, expiresAt: addTime(snapshot.now, snapshot.config.proposalTtlMs),
    })
    const committed = await this.write(request, (current) => {
      if (current.proposals.some(proposal => proposal.id === id) || current.versions.some(version => version.proposalId === id)) fail('id-conflict')
      const latest = this.snapshot(current, scopeId)
      this.validateProposal(current, record, latest, true)
      return { scopes: current.scopes, tasks: current.tasks, proposals: [...current.proposals, record], versions: current.versions }
    })
    return deepFreeze({ kind: 'proposal', proposal: this.proposalView(committed, record), revision: committed.revision, epoch: committed.epoch })
  }

  /**
   * Recompute retained authoritative evidence and approve a bounded overlay by proposal identity alone.
   * @param value - Exactly proposalId, expectedRevision and expectedEpoch.
   * @returns A cropped committed view; source changes after commit can make the pointer unusable.
   */
  async apply(value: unknown): Promise<LearningControllerView> {
    const request = parse(applySchema, value, 'invalid-request')
    const id = brandString<LearningProposalId>(request.proposalId)
    const versionId = this.id(() => this.dependencies.versionId())
    await this.write(request, (ledger) => {
      const proposal = ledger.proposals.find(record => record.id === id)
      if (proposal === undefined) fail('unknown-proposal')
      if (ledger.versions.some(version => version.proposalId === id)) fail('already-approved')
      if (ledger.versions.some(version => version.id === versionId)) fail('id-conflict')
      const snapshot = this.snapshot(ledger, proposal.scopeId)
      const policy = this.validateProposal(ledger, proposal, snapshot, true)
      const scope = ledger.scopes.find(record => record.id === proposal.scopeId)
      if (scope === undefined) fail('unknown-scope')
      const version: LearningVersionRecord = deepFreeze({
        id: versionId, scopeId: scope.id, cohort: proposal.cohort, proposalId: id,
        parentVersionId: scope.activeVersionId, basePolicyFingerprint: proposal.basePolicyFingerprint,
        weights: policy.candidates.map(candidate => ({ candidateId: candidate.id, relativeCost: candidate.relativeCost })),
        createdAt: snapshot.now, validUntil: addTime(snapshot.now, snapshot.config.versionTtlMs),
      })
      return {
        scopes: ledger.scopes.map(record => record.id === scope.id ? { ...record, activeVersionId: version.id } : record),
        tasks: ledger.tasks, proposals: ledger.proposals, versions: [...ledger.versions, version],
      }
    })
    return this.view()
  }

  /**
   * Reactivate only a retained, currently valid immutable version with its original retained evidence.
   * @param value - Exactly versionId, expectedRevision and expectedEpoch.
   * @returns A cropped committed view; no version or parent lineage is rewritten.
   */
  async rollback(value: unknown): Promise<LearningControllerView> {
    const request = parse(rollbackSchema, value, 'invalid-request')
    const id = brandString<LearningVersionId>(request.versionId)
    await this.write(request, (ledger) => {
      const validated = this.validateVersion(ledger, id)
      return {
        scopes: ledger.scopes.map(scope => scope.id === validated.record.scopeId ? { ...scope, activeVersionId: id } : scope),
        tasks: ledger.tasks, proposals: ledger.proposals, versions: ledger.versions,
      }
    })
    return this.view()
  }

  /**
   * Invalidate every proposal and active pointer while preserving task and immutable version history.
   * Retained versions without proposal evidence cannot be rolled back into use.
   * @param value - Exactly expectedRevision and expectedEpoch.
   * @returns The committed cropped view; global settings enablement remains the configuration owner's responsibility.
   */
  async disable(value: unknown): Promise<LearningControllerView> {
    const request = parse(stampSchema, value, 'invalid-request')
    await this.write(request, ledger => ({
      scopes: ledger.scopes.map(scope => ({ ...scope, activeVersionId: null })),
      tasks: ledger.tasks, proposals: [], versions: ledger.versions,
    }))
    return this.view()
  }

  /**
   * Clear local learning data and advance the store epoch, invalidating queued pre-clear admissions.
   * @param value - Exactly expectedRevision and expectedEpoch.
   * @returns The empty cropped view; no Session, model, feedback or settings operation is invoked.
   */
  async clear(value: unknown): Promise<LearningControllerView> {
    const request = parse(stampSchema, value, 'invalid-request')
    try { await this.dependencies.store.clear(request.expectedRevision, request.expectedEpoch) } catch (error: unknown) {
      this.storeFailure(error)
    }
    return this.view()
  }

  /**
   * Read a cropped overlay for NEW task admission after revalidating active pointer and retained evidence.
   * The lower router must still enforce classification, eligibility and weight-only bounds.
   * @param scopeId - Server-selected scope for the new task; not a client-supplied cohort or base.
   * @returns Exactly the lower-router overlay fields, or undefined for an unusable/missing active version.
   */
  activeOverlay(scopeId: LearningScopeId): LearningWeightOverlay | undefined {
    try {
      const ledger = this.read()
      const scope = ledger.scopes.find(record => record.id === scopeId)
      if (scope?.activeVersionId === null || scope?.activeVersionId === undefined) return undefined
      const validated = this.validateVersion(ledger, scope.activeVersionId)
      if (validated.record.scopeId !== scopeId) return undefined
      const validUntil = validated.proposal.evaluationInput.observations.reduce((until, row) =>
        Math.min(until, Number.MAX_SAFE_INTEGER, row.completedAt + validated.snapshot.config.guards.observationWindowMs + 1),
      validated.record.validUntil)
      return deepFreeze({
        versionId: validated.record.id, basePolicyFingerprint: validated.record.basePolicyFingerprint,
        mode: validated.proposal.proposal.mode, complexity: validated.proposal.proposal.complexity,
        validUntil,
        weights: validated.record.weights.map(weight => ({ ...weight })),
      })
    } catch (_error: unknown) {
      // This optional provider grants nothing on stale or unavailable local authority.
      return undefined
    }
  }

  /**
   * Project current local approval and version usability without exporting private evidence.
   * @returns Bounded safe metadata without tasks, observations, policies, profile/cohort keys or raw exceptions.
   */
  view(): LearningControllerView {
    const ledger = this.read()
    let enabled = false
    try { enabled = this.configuration().enabled } catch (_error: unknown) { /* Invalid configuration remains unavailable. */ }
    const versions = ledger.versions.map((version) => {
      const status = this.status(() => { this.validateVersion(ledger, version.id) })
      return {
        id: version.id, scopeId: version.scopeId, proposalId: version.proposalId, parentVersionId: version.parentVersionId,
        createdAt: version.createdAt, validUntil: version.validUntil,
        active: status === 'ready' && ledger.scopes.some(scope => scope.activeVersionId === version.id), status,
      }
    })
    return deepFreeze({
      revision: ledger.revision, epoch: ledger.epoch, enabled,
      scopes: ledger.scopes.map(scope => ({
        id: scope.id, activeVersionId: scope.activeVersionId,
        activeStatus: scope.activeVersionId === null ? 'none' as const
          : versions.find(version => version.id === scope.activeVersionId)?.status ?? 'unknown-version' as const,
      })),
      proposals: ledger.proposals.map(proposal => this.proposalView(ledger, proposal)), versions,
    })
  }

  private id<T extends LearningProposalId | LearningVersionId>(create: () => T): T {
    try { return uuid.parse(create()) as T } catch (_error: unknown) { return fail('id-conflict') }
  }

  private configuration(): LearningControllerConfig {
    let value: LearningControllerConfig
    try { value = this.dependencies.config() } catch (_error: unknown) { return fail('invalid-config') }
    return deepFreeze(parse(configSchema, value, 'invalid-config'))
  }

  private clock(): number {
    try { return parse(count, this.dependencies.now(), 'invalid-clock') } catch (_error: unknown) { return fail('invalid-clock') }
  }

  private snapshot(ledger: LearningLedger, scopeId: LearningScopeId): Snapshot {
    const config = this.configuration()
    if (!config.enabled) fail('disabled')
    const scope = ledger.scopes.find(record => record.id === scopeId)
    if (scope === undefined) fail('unknown-scope')
    let raw: LearningCurrentContext | undefined
    try { raw = this.dependencies.context(scopeId) } catch (_error: unknown) { return fail('context-unavailable') }
    if (raw === undefined) fail('context-unavailable')
    if (raw.profileKey !== ledger.profileKey || raw.scopeId !== scopeId || raw.cohort !== scope.cohort) fail('stale-context')
    parse(token, raw.contextRevision, 'invalid-context')
    parse(token, raw.classifierRevision, 'invalid-context')
    parse(token, raw.metricRevision, 'invalid-context')
    let basePolicy: ModelRoutingPolicy
    try { basePolicy = parseRoutingPolicy(raw.basePolicy) } catch (_error: unknown) { return fail('invalid-context') }
    const ids = new Set<string>()
    const eligibleCandidates = raw.eligibleCandidates.map((entry) => {
      const candidate = basePolicy.candidates.find(candidate => candidate.id === entry.candidateId)
      if (candidate === undefined || ids.has(entry.candidateId)
        || candidate.selection.provider !== entry.resolvedSelection.provider || candidate.selection.model !== entry.resolvedSelection.model
        || (candidate.selection.reasoningEffort !== undefined
          && candidate.selection.reasoningEffort !== entry.resolvedSelection.reasoningEffort)) {
        return fail('invalid-context')
      }
      ids.add(entry.candidateId)
      return { candidateId: entry.candidateId, resolvedSelection: { ...entry.resolvedSelection } }
    }).sort((left, right) => left.candidateId < right.candidateId ? -1 : left.candidateId > right.candidateId ? 1 : 0)
    const context = deepFreeze({
      profileKey: raw.profileKey, scopeId, contextRevision: raw.contextRevision, cohort: raw.cohort,
      category: raw.category, role: raw.role, mode: raw.mode, complexity: raw.complexity,
      classifierRevision: raw.classifierRevision, metricRevision: raw.metricRevision, basePolicy, eligibleCandidates,
    })
    return { config, context, baseFingerprint: fingerprintAdaptiveBasePolicy(basePolicy), now: this.clock() }
  }

  private matches(task: LearningTaskRecord, snapshot: Snapshot): boolean {
    const context = snapshot.context
    const candidate = context.eligibleCandidates.find(entry => entry.candidateId === task.candidateId)
    return task.state === 'sealed' && task.completedAt !== null && task.scopeId === context.scopeId && task.cohort === context.cohort
      && task.category === context.category && task.role === context.role
      && task.mode === context.mode && task.complexity === context.complexity
      && task.classifierRevision === context.classifierRevision && task.metricRevision === context.metricRevision
      && task.basePolicy !== null && task.basePolicyFingerprint === snapshot.baseFingerprint
      && fingerprintAdaptiveBasePolicy(task.basePolicy) === snapshot.baseFingerprint
      && task.resolvedSelection !== null && candidate !== undefined && routeEqual(task.resolvedSelection, candidate.resolvedSelection)
  }

  private recentTasks(ledger: LearningLedger, snapshot: Snapshot): readonly LearningTaskRecord[] {
    const start = Math.max(0, snapshot.now - snapshot.config.guards.observationWindowMs)
    return ledger.tasks.filter(task => this.matches(task, snapshot)
      && task.completedAt !== null && task.completedAt >= start && task.completedAt <= snapshot.now)
      .sort((left, right) => (right.completedAt as number) - (left.completedAt as number)
        || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
      .slice(0, snapshot.config.guards.maxObservations)
  }

  private input(tasks: readonly LearningTaskRecord[], snapshot: Snapshot, evaluatedAt: number): AdaptiveEvaluationInput {
    try {
      return parseAdaptiveEvaluationInput({
        cohort: snapshot.context.cohort, mode: snapshot.context.mode, complexity: snapshot.context.complexity,
        now: evaluatedAt, eligibleCandidateIds: snapshot.context.eligibleCandidates.map(candidate => candidate.candidateId),
        observations: tasks.map(observation),
      }, snapshot.config.guards)
    } catch (_error: unknown) { return fail('invalid-evidence') }
  }

  private evaluateEvidence(snapshot: Snapshot, input: AdaptiveEvaluationInput) {
    try { return evaluateAdaptivePolicy(snapshot.context.basePolicy, snapshot.config.guards, input) } catch (_error: unknown) {
      return fail('invalid-evidence')
    }
  }

  private validateProposal(
    ledger: LearningLedger,
    record: LearningProposalRecord,
    snapshot: Snapshot,
    checkExpiry: boolean,
  ): ModelRoutingPolicy {
    if (record.configRevision !== snapshot.config.revision || !deepEqualJson(record.guardConfig, snapshot.config.guards)
      || record.expiresAt !== addTime(record.createdAt, snapshot.config.proposalTtlMs)) fail('stale-config')
    if (record.contextRevision !== snapshot.context.contextRevision || record.cohort !== snapshot.context.cohort
      || record.scopeId !== snapshot.context.scopeId) fail('stale-context')
    if (record.basePolicyFingerprint !== snapshot.baseFingerprint) fail('stale-base')
    if (record.createdAt !== record.proposal.evaluatedAt || record.evaluationInput.now !== record.createdAt) fail('invalid-evidence')
    if (snapshot.now < record.createdAt || (checkExpiry && snapshot.now >= record.expiresAt)) fail('expired')
    const sources = record.sourceTaskRevisions.map((source) => {
      const task = ledger.tasks.find(task => task.id === source.taskId)
      if (task === undefined) return fail('missing-evidence')
      if (task.revision !== source.revision || !this.matches(task, snapshot)
        || task.completedAt === null || task.completedAt < Math.max(0, snapshot.now - snapshot.config.guards.observationWindowMs)
        || task.completedAt > record.proposal.evaluatedAt) return fail('stale-source')
      return task
    })
    const currentSources = this.recentTasks(ledger, snapshot).map(task => ({ taskId: task.id, revision: task.revision }))
    if (!deepEqualJson(currentSources, record.sourceTaskRevisions)) fail('stale-source')
    const reconstructed = this.input(sources, snapshot, record.proposal.evaluatedAt)
    if (!deepEqualJson(reconstructed, record.evaluationInput)) fail('invalid-evidence')
    try {
      return applyAdaptivePolicyPatch(snapshot.context.basePolicy, snapshot.config.guards, reconstructed, record.proposal)
    } catch (_error: unknown) { return fail('invalid-evidence') }
  }

  private validateVersion(ledger: LearningLedger, id: LearningVersionId): ValidatedVersion {
    const record = ledger.versions.find(version => version.id === id)
    if (record === undefined) fail('unknown-version')
    const proposal = ledger.proposals.find(proposal => proposal.id === record.proposalId)
    if (proposal === undefined) fail('missing-evidence')
    const snapshot = this.snapshot(ledger, record.scopeId)
    if (snapshot.now < record.createdAt || snapshot.now >= record.validUntil) fail('expired')
    if (record.scopeId !== proposal.scopeId || record.cohort !== proposal.cohort
      || record.basePolicyFingerprint !== proposal.basePolicyFingerprint
      || record.createdAt < proposal.createdAt || record.createdAt >= proposal.expiresAt
      || record.validUntil !== addTime(record.createdAt, snapshot.config.versionTtlMs)) fail('invalid-version')
    const policy = this.validateProposal(ledger, proposal, snapshot, false)
    const weights = policy.candidates.map(candidate => ({ candidateId: candidate.id, relativeCost: candidate.relativeCost }))
    if (!deepEqualJson(record.weights, weights)) fail('invalid-version')
    return { record, proposal, policy, snapshot }
  }

  private proposalView(ledger: LearningLedger, record: LearningProposalRecord): LearningProposalView {
    const approved = ledger.versions.find(version => version.proposalId === record.id)
    const status = this.status(() => {
      if (approved !== undefined) this.validateVersion(ledger, approved.id)
      else this.validateProposal(ledger, record, this.snapshot(ledger, record.scopeId), true)
    })
    return deepFreeze({
      id: record.id, scopeId: record.scopeId, status: approved !== undefined && status === 'ready' ? 'approved' : status,
      createdAt: record.createdAt, expiresAt: record.expiresAt,
      baselineCandidateId: record.proposal.baselineCandidateId, winnerCandidateId: record.proposal.winnerCandidateId,
      change: { ...record.proposal.changes[0] },
      samples: { baseline: record.proposal.evidence.baseline.samples, winner: record.proposal.evidence.winner.samples },
      relativeWorkImprovement: record.proposal.evidence.relativeWorkImprovement,
    })
  }

  private status(validate: () => void): LearningRecordStatus {
    try { validate(); return 'ready' } catch (error: unknown) {
      return error instanceof LearningControllerError ? error.code : 'invalid-evidence'
    }
  }

  private read(): LearningLedger {
    try { return this.dependencies.store.read() } catch (error: unknown) { return this.storeFailure(error) }
  }

  private async write(request: LearningMutationStamp, transform: (current: LearningLedger) => LearningLedgerData): Promise<LearningLedger> {
    try {
      return await this.dependencies.store.update(request.expectedRevision, request.expectedEpoch, (ledger) => {
        sameStamp(ledger, request)
        return transform(ledger)
      })
    } catch (error: unknown) { return this.storeFailure(error) }
  }

  private storeFailure(error: unknown): never {
    if (error instanceof LearningControllerError) throw error
    if (typeof error === 'object' && error !== null && 'code' in error) {
      if (error.code === 'revision-conflict' || error.code === 'epoch-conflict') return fail(error.code)
      if (error.code === 'closed') return fail('store-unavailable')
    }
    return fail('store-rejected')
  }
}
