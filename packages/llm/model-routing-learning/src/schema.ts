/** Strict bounded local ledger validation; semantic evaluation and approval remain runtime operations. */

import { isAbsolute } from 'node:path'
import { Buffer } from 'node:buffer'
import { brandString } from '@deepseek-ai/dsh-brand'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import { z } from 'zod'
import { parseRoutingPolicy } from '@deepseek-ai/dsh-model-routing'
import {
  fingerprintAdaptiveBasePolicy, parseAdaptiveEvaluationInput, parseAdaptivePolicyConfig, parseAdaptivePolicyProposal,
} from '@deepseek-ai/dsh-model-routing/adaptive'
import type { AdaptiveBasePolicyFingerprint, AdaptiveCohortKey } from '@deepseek-ai/dsh-model-routing/adaptive-types'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {
  LearningLedger, LearningProposalId, LearningScopeId, LearningStoreConfig,
  LearningStoreErrorCode, LearningTaskId, LearningVersionId,
} from './types.ts'

const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const profileKey = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/)
const token = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/)
const routeToken = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,255}$/)
const uuid = z.uuid().regex(/^[0-9a-f-]+$/)
const digest = z.string().regex(/^[0-9a-f]{64}$/)
const scopeId = uuid.transform(value => brandString<LearningScopeId>(value))
const taskId = uuid.transform(value => brandString<LearningTaskId>(value))
const proposalId = uuid.transform(value => brandString<LearningProposalId>(value))
const versionId = uuid.transform(value => brandString<LearningVersionId>(value))
const cohort = digest.transform(value => brandString<AdaptiveCohortKey>(value))
const fingerprint = digest.transform(value => brandString<AdaptiveBasePolicyFingerprint>(value))
const selectionSchema = z.object({
  provider: routeToken, model: routeToken, reasoningEffort: token.optional(),
}).strict().transform(({ reasoningEffort, ...route }) => ({
  ...route, ...reasoningEffort === undefined ? {} : { reasoningEffort },
}))
const policySchema = z.unknown().transform((value) => {
  const policy = parseRoutingPolicy(value)
  for (const candidate of policy.candidates) {
    token.parse(candidate.id)
    selectionSchema.parse(candidate.selection)
  }
  token.parse(policy.conservativeCandidateId)
  return policy
})
const incompleteReason = z.enum([
  'not-sealed', 'unattributed-profile', 'unattributed-scope', 'unattributed-cohort',
  'unattributed-route', 'missing-revision', 'missing-usage', 'pending-calls',
  'unknown-auxiliary-work', 'unknown-child-work', 'unknown-review-work', 'interrupted', 'unsupported-source',
])
const limitsSchema = z.object({
  maxScopes: count.positive(), maxTasks: count.positive(), maxProposals: count.positive(),
  maxVersions: count.positive(), maxObservationsPerProposal: count.positive(), maxLedgerBytes: count.positive(),
}).strict()
const configSchema = z.object({
  profileKey,
  ownershipLockPath: z.string().min(1).refine(value => isAbsolute(value), 'ownership lock path must be absolute'),
  ownershipWaitMs: count.positive().max(2_147_483_647),
  limits: limitsSchema,
}).strict()

/** Safe typed failures containing no private record or filesystem contents. */
export class LearningStoreError extends Error {
  /** @param code - Closed failure reason safe for an owning API to map to localized copy. */
  constructor(readonly code: LearningStoreErrorCode) {
    super(`learning store: ${code}`)
    this.name = 'LearningStoreError'
  }
}

/**
 * Validate explicit deployment identity, ownership path, and storage bounds.
 * @param value - Unknown deployment configuration; no defaults are supplied.
 * @returns An owned frozen configuration.
 */
export function parseLearningStoreConfig(value: unknown): LearningStoreConfig {
  return deepFreeze(configSchema.parse(value))
}

const scopeSchema = z.object({ id: scopeId, cohort: cohort.nullable(), activeVersionId: versionId.nullable() }).strict()
const taskSchema = z.object({
  id: taskId,
  sessionId: token.transform(value => brandString<SessionId>(value)),
  scopeId: scopeId.nullable(),
  cohort: cohort.nullable(),
  category: z.enum(['code-edit', 'debugging', 'tests', 'review', 'documentation', 'research', 'other']).nullable(),
  complexity: z.enum(['routine', 'standard', 'complex']).nullable(),
  mode: z.enum(['efficiency', 'balanced', 'intelligence']).nullable(),
  role: z.enum(['main', 'child', 'review']).nullable(),
  candidateId: token.nullable(),
  resolvedSelection: selectionSchema.nullable(),
  basePolicy: policySchema.nullable(),
  basePolicyFingerprint: fingerprint.nullable(),
  classifierRevision: token.nullable(),
  metricRevision: token.nullable(),
  revision: count,
  state: z.enum(['pending', 'sealed']),
  createdAt: count,
  completedAt: count.nullable(),
  observedRelativeWork: z.number().nonnegative().nullable(),
  workComplete: z.boolean(),
  incompleteReasons: z.array(incompleteReason).max(incompleteReason.options.length),
  outcome: z.enum(['unknown', 'success', 'failure']),
  evidence: z.enum(['user-confirmed', 'validator', 'unverified']),
}).strict().superRefine((task, ctx) => {
  const invalid = () => { ctx.addIssue({ code: 'custom', message: 'inconsistent task facts' }) }
  if (task.state === 'pending' && (task.completedAt !== null || task.workComplete)) invalid()
  if (task.state === 'sealed' && (task.completedAt === null || task.completedAt < task.createdAt)) invalid()
  if (new Set(task.incompleteReasons).size !== task.incompleteReasons.length) invalid()
  if (task.workComplete) {
    if (task.observedRelativeWork === null || task.incompleteReasons.length !== 0
      || task.scopeId === null || task.cohort === null || task.category === null
      || task.complexity === null || task.mode === null || task.role === null
      || task.candidateId === null || task.resolvedSelection === null || task.basePolicy === null
      || task.classifierRevision === null || task.metricRevision === null) invalid()
  } else if (task.observedRelativeWork !== null || task.incompleteReasons.length === 0) invalid()
  if (task.basePolicy === null ? task.basePolicyFingerprint !== null
    : task.basePolicyFingerprint !== fingerprintAdaptiveBasePolicy(task.basePolicy)) invalid()
})

function requireUnique(values: readonly string[]): void {
  if (new Set(values).size !== values.length) throw new LearningStoreError('invalid-ledger')
}

/**
 * Create the authoritative per-profile record schema used on reads and every commit.
 * Parsers retain only closed domain types; they do not approve or apply stored proposals.
 * @param config - Validated explicit identity and record/byte limits.
 * @returns The strict bounded ledger schema, returning owned deeply frozen records.
 */
export function createLearningLedgerSchema(config: LearningStoreConfig): z.ZodType<LearningLedger> {
  const proposalSchema = z.object({
    id: proposalId, scopeId, cohort, basePolicyFingerprint: fingerprint,
    configRevision: token, contextRevision: token,
    guardConfig: z.unknown().transform(parseAdaptivePolicyConfig),
    evaluationInput: z.unknown(),
    proposal: z.unknown().transform(parseAdaptivePolicyProposal),
    sourceTaskRevisions: z.array(z.object({ taskId, revision: count }).strict()).max(config.limits.maxObservationsPerProposal),
    createdAt: count, expiresAt: count,
  }).strict().transform((record) => {
    const input = parseAdaptiveEvaluationInput(record.evaluationInput, {
      ...record.guardConfig,
      maxObservations: Math.min(record.guardConfig.maxObservations, config.limits.maxObservationsPerProposal),
    })
    cohort.parse(input.cohort)
    for (const id of input.eligibleCandidateIds) token.parse(id)
    for (const observation of input.observations) {
      uuid.parse(observation.observationId)
      taskId.parse(observation.taskId)
      token.parse(observation.candidateId)
      cohort.parse(observation.cohort)
    }
    token.parse(record.proposal.baselineCandidateId)
    token.parse(record.proposal.winnerCandidateId)
    for (const change of record.proposal.changes) token.parse(change.candidateId)
    for (const id of [
      ...record.proposal.evidence.baseline.observationIds, ...record.proposal.evidence.winner.observationIds,
    ]) uuid.parse(id)
    if (record.proposal.evidence.baseline.observationIds.length > config.limits.maxObservationsPerProposal
      || record.proposal.evidence.winner.observationIds.length > config.limits.maxObservationsPerProposal) {
      throw new LearningStoreError('limit-exceeded')
    }
    requireUnique(record.sourceTaskRevisions.map(source => source.taskId))
    if (record.expiresAt <= record.createdAt || record.createdAt < record.proposal.evaluatedAt
      || record.cohort !== input.cohort || record.cohort !== record.proposal.cohort
      || record.basePolicyFingerprint !== record.proposal.basePolicyFingerprint
      || input.now !== record.proposal.evaluatedAt
      || input.mode !== record.proposal.mode || input.complexity !== record.proposal.complexity
      || record.sourceTaskRevisions.length !== input.observations.length
      || input.observations.some(observation => !record.sourceTaskRevisions.some(source => source.taskId === observation.taskId))) {
      throw new LearningStoreError('invalid-ledger')
    }
    return { ...record, evaluationInput: input }
  })
  const versionSchema = z.object({
    id: versionId, scopeId, cohort, proposalId,
    parentVersionId: versionId.nullable(), basePolicyFingerprint: fingerprint,
    weights: z.array(z.object({ candidateId: token, relativeCost: z.number().positive() }).strict()).min(1),
    createdAt: count, validUntil: count,
  }).strict().superRefine((version, ctx) => {
    if (version.validUntil <= version.createdAt || version.parentVersionId === version.id
      || new Set(version.weights.map(weight => weight.candidateId)).size !== version.weights.length) {
      ctx.addIssue({ code: 'custom', message: 'inconsistent version facts' })
    }
  })
  const shape = z.object({
    schemaVersion: z.literal(1), profileKey: z.literal(config.profileKey), revision: count, epoch: count,
    scopes: z.array(scopeSchema).max(config.limits.maxScopes),
    tasks: z.array(taskSchema).max(config.limits.maxTasks),
    proposals: z.array(proposalSchema).max(config.limits.maxProposals),
    versions: z.array(versionSchema).max(config.limits.maxVersions),
  }).strict()
  return z.unknown().transform((value): LearningLedger => {
    const ledger = shape.parse(value)
    for (const records of [ledger.scopes, ledger.tasks, ledger.proposals, ledger.versions]) {
      requireUnique(records.map(record => record.id))
    }
    const scopes = new Map(ledger.scopes.map(scope => [scope.id, scope]))
    const versions = new Map(ledger.versions.map(version => [version.id, version]))
    const proposals = new Map(ledger.proposals.map(proposal => [proposal.id, proposal]))
    for (const task of ledger.tasks) {
      const scope = task.scopeId === null ? undefined : scopes.get(task.scopeId)
      if (task.scopeId !== null && (scope === undefined || (task.cohort !== null && scope.cohort !== task.cohort))) {
        throw new LearningStoreError('invalid-ledger')
      }
    }
    for (const record of [...ledger.proposals, ...ledger.versions]) {
      if (scopes.get(record.scopeId)?.cohort !== record.cohort) throw new LearningStoreError('invalid-ledger')
    }
    for (const version of ledger.versions) {
      const proposal = proposals.get(version.proposalId)
      const parent = version.parentVersionId === null ? undefined : versions.get(version.parentVersionId)
      if ((proposal !== undefined && (proposal.scopeId !== version.scopeId || proposal.cohort !== version.cohort
        || proposal.basePolicyFingerprint !== version.basePolicyFingerprint))
        || (parent !== undefined && (parent.scopeId !== version.scopeId || parent.cohort !== version.cohort))) {
        throw new LearningStoreError('invalid-ledger')
      }
    }
    for (const scope of ledger.scopes) {
      if (scope.activeVersionId === null) continue
      const version = versions.get(scope.activeVersionId)
      const proposal = version === undefined ? undefined : proposals.get(version.proposalId)
      if (version === undefined || version.scopeId !== scope.id || version.cohort !== scope.cohort
        || proposal === undefined || proposal.scopeId !== scope.id || proposal.cohort !== scope.cohort
        || proposal.basePolicyFingerprint !== version.basePolicyFingerprint) {
        throw new LearningStoreError('invalid-ledger')
      }
    }
    if (Buffer.byteLength(JSON.stringify(ledger), 'utf8') > config.limits.maxLedgerBytes) {
      throw new LearningStoreError('limit-exceeded')
    }
    return deepFreeze(ledger)
  })
}
