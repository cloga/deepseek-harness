/** Read-only GitHub evidence for the single approved Core/Web artifact release. */
import { assertDispatch, checkoutCommit, type GitHub, type Selection } from './github-artifacts.ts'

const REPOSITORY = 'cloga/deepseek-harness'
const BASE = 'review/issue-72-official-base'
const SHA = /^[a-f0-9]{40}$/u
interface Commit { sha: string; tree: { sha: string }; parents: Array<{ sha: string }> }
interface Ref { ref: string; object: { type: string; sha: string } }
interface Tag { object: { type: string; sha: string } }
interface Pull {
  number: number
  merged: boolean
  merged_at: string
  merge_commit_sha: string
  draft: boolean
  user: { login: string }
  head: { sha: string; repo: { full_name: string } }
  base: { ref: string; repo: { full_name: string } }
}
interface Run {
  id: number
  run_attempt: number
  event: string
  status: string
  conclusion: string
  head_sha: string
  path: string
  repository: { full_name: string }
  head_repository: { full_name: string }
  pull_requests: Array<{ number: number; head: { sha: string }; base: { ref: string } }>
}
interface Step { name: string; status: string; conclusion: string; started_at: string; completed_at: string }
interface Job { id: number; run_id: number; name: string; status: string; conclusion: string; steps: Step[] }
interface Review { id: number; user: { login: string }; state: string; commit_id: string; author_association: string }
interface Check { name: string; head_sha: string; status: string; conclusion: string; app: { id: number; slug: string } }
interface Status { context: string; state: string; sha: string }
interface Rule {
  type: string
  parameters?: { required_approving_review_count?: number; required_status_checks?: Array<{ context: string; integration_id?: number }> }
}
interface Artifact { id: number; name: string; expired: boolean; workflow_run: { id: number; head_sha: string } }
interface TagRuleset {
  id: number
  target: string
  enforcement: string
  source_type: string
  source: string
  current_user_can_bypass?: string
  conditions?: { ref_name?: { include?: string[]; exclude?: string[] } }
  rules?: Array<{ type: string; parameters?: { update_allows_fetch_and_merge?: boolean } }>
}
interface ClassicProtection {
  requiresApprovingReviews: boolean
  requiredApprovingReviewCount: number | null
  requiresStatusChecks: boolean
  requiredStatusCheckContexts: string[] | null
  requiredStatusChecks: Array<{ context: string; app?: { databaseId: number } | null }> | null
}
interface BranchFacts {
  errors?: unknown[]
  data?: { repository: {
    ref?: { branchProtectionRule: ClassicProtection | null }
    pullRequest?: { reviewDecision: string | null }
  } }
}

function requireValue<T>(value: T | null | undefined, context: string): T {
  if (value === null || value === undefined) throw new Error(`${context} unavailable; publication refused`)
  return value
}
function classicRequirements(protection: ClassicProtection | null): {
  approvals: number
  checks: Array<{ context: string; integration_id?: number }>
} {
  if (protection === null) return { approvals: 0, checks: [] }
  if (typeof protection.requiresApprovingReviews !== 'boolean' || typeof protection.requiresStatusChecks !== 'boolean') {
    throw new Error('Classic protection facts unavailable')
  }
  const approvals = protection.requiresApprovingReviews ? requireValue(protection.requiredApprovingReviewCount, 'Review count') : 0
  if (!Number.isSafeInteger(approvals) || approvals < 0) throw new Error('Classic review requirement unavailable')
  if (!protection.requiresStatusChecks) return { approvals, checks: [] }
  const contexts = requireValue(protection.requiredStatusCheckContexts, 'Classic check contexts')
  const checks = requireValue(protection.requiredStatusChecks, 'Classic check/app bindings')
  if (!Array.isArray(contexts) || !Array.isArray(checks)
    || JSON.stringify([...contexts].sort()) !== JSON.stringify(checks.map(check => check.context).sort())) {
    throw new Error('Classic protection check/app bindings unavailable')
  }
  return { approvals, checks: checks.map((check) => {
    if (check.app === null) return { context: check.context }
    const app = requireValue(check.app, 'Classic check app')
    if (!Number.isSafeInteger(app.databaseId) || app.databaseId <= 0) throw new Error('Classic check app unavailable')
    return { context: check.context, integration_id: app.databaseId }
  }) }
}

async function commit(api: GitHub, sha: string): Promise<Commit> {
  if (!SHA.test(sha)) throw new Error('Invalid commit evidence')
  const result = requireValue(await api.json<Commit>(`/git/commits/${sha}`), 'Commit')
  if (result.sha !== sha || !SHA.test(result.tree.sha)) throw new Error('Commit/tree evidence differs')
  return result
}

/** Resolve lightweight or annotated tags without creating, moving or trusting target_commitish.
 * @param api - Read-only GitHub API operations.
 * @param selection - Exact approved tag and merged-commit selectors.
 * @param tree - Full source tree from the read-only preparation.
 * @param expectedIdentity - Original ref object type/SHA, when checking for concurrent tag changes.
 * @returns The exact ref object identity, not just its peeled commit.
 */
export async function verifyTag(api: GitHub, selection: Selection, tree: string, expectedIdentity?: string): Promise<string> {
  const tag = `dsh-v${selection.version}`
  const ref = requireValue(await api.json<Ref>(`/git/ref/tags/${encodeURIComponent(tag)}`), 'Existing tag')
  if (ref.ref !== `refs/tags/${tag}` || !SHA.test(ref.object.sha)) throw new Error('Tag ref differs')
  const identity = `${ref.object.type}:${ref.object.sha}`
  if (expectedIdentity !== undefined && identity !== expectedIdentity) throw new Error('Tag object identity changed')
  let object = ref.object
  const seen = new Set<string>()
  while (object.type === 'tag') {
    if (!SHA.test(object.sha) || seen.has(object.sha) || seen.size >= 8) throw new Error('Tag chain rejected')
    seen.add(object.sha)
    object = requireValue(await api.json<Tag>(`/git/tags/${object.sha}`), 'Annotated tag').object
  }
  if (object.type !== 'commit' || object.sha !== selection.mergedCommit || object.sha !== selection.source
    || (await commit(api, object.sha)).tree.sha !== tree) throw new Error('Tag commit or full tree differs')
  return identity
}

/** Require active exact-tag creation/update/deletion prohibitions that the publishing principal cannot bypass.
 * @param api - Read-only ruleset API.
 * @param selection - Exact protected tag selector.
 */
export async function verifyTagProtection(api: GitHub, selection: Selection): Promise<void> {
  const summaries = await api.list<TagRuleset>('/rulesets?includes_parents=true')
  for (const summary of summaries) {
    if (summary.target !== 'tag' || summary.enforcement !== 'active' || !Number.isSafeInteger(summary.id) || summary.id <= 0) continue
    const rule = requireValue(await api.json<TagRuleset>(`/rulesets/${summary.id}?includes_parents=true`), 'Tag ruleset')
    const refs = rule.conditions?.ref_name
    if (rule.id !== summary.id || rule.target !== 'tag' || rule.enforcement !== 'active'
      || rule.source_type !== 'Repository' || rule.source !== REPOSITORY
      || rule.current_user_can_bypass !== 'never'
      || !rule.conditions || Object.keys(rule.conditions).join(',') !== 'ref_name'
      || !refs || Object.keys(refs).sort().join(',') !== 'exclude,include'
      || !Array.isArray(refs.include) || refs.include.length !== 1 || refs.include[0] !== selection.ref
      || !Array.isArray(refs.exclude) || refs.exclude.length !== 0 || !Array.isArray(rule.rules)) continue
    const rules = rule.rules
    const required = ['creation', 'update', 'deletion']
    if (required.every(type => rules.some(item => item.type === type
      && (item.parameters === undefined || (type === 'update'
        && Object.keys(item.parameters).join(',') === 'update_allows_fetch_and_merge'
        && item.parameters.update_allows_fetch_and_merge === false))))) return
  }
  throw new Error('Exact-tag creation/update/deletion protection and non-bypass facts unavailable; publication requires separately authorized protection and readable facts')
}

async function successfulRun(api: GitHub, id: string, path: string, selection: Selection): Promise<Run> {
  const run = requireValue(await api.json<Run>(`/actions/runs/${id}`), 'Selected workflow run')
  if (String(run.id) !== id || !Number.isSafeInteger(run.run_attempt) || run.run_attempt < 1
    || run.path !== path || run.event !== 'pull_request' || run.status !== 'completed' || run.conclusion !== 'success'
    || run.repository.full_name !== REPOSITORY || run.head_repository.full_name !== REPOSITORY
    || run.head_sha !== selection.reviewedHead
    || !run.pull_requests.some(pr => pr.number === 75 && pr.head.sha === selection.reviewedHead && pr.base.ref === BASE)) {
    throw new Error('Selected PR workflow is not successful evidence for the reviewed final head')
  }
  return run
}
async function jobs(api: GitHub, run: Run): Promise<Job[]> {
  const result = await api.list<Job>(`/actions/runs/${run.id}/attempts/${run.run_attempt}/jobs`, 'jobs')
  if (result.length === 0 || new Set(result.map(job => job.id)).size !== result.length
    || result.some(job => job.run_id !== run.id || job.status !== 'completed')) throw new Error('Workflow job evidence is missing or incomplete')
  return result
}

/** Verify real PR approval, rules, CI checkout trees, policy and fresh same-run release jobs.
 * @param api - GitHub transport; all operations here are GETs.
 * @param selection - Operator selectors, not assertions of success.
 * @param tree - Full Git tree from the tagged source checkout.
 * @param artifactId - Immutable artifact ID passed directly from this run's pack job.
 * @returns Original tag ref object identity for subsequent mutation checks.
 */
export async function verifyEvidence(api: GitHub, selection: Selection, tree: string, artifactId: string): Promise<string> {
  assertDispatch(selection)
  const repo = requireValue(await api.json<{ full_name: string; private: unknown; visibility: string }>('/repository'), 'Repository visibility')
  if (repo.full_name !== REPOSITORY || repo.private !== false || repo.visibility !== 'public') throw new Error('Public repository evidence unavailable')
  const tagIdentity = await verifyTag(api, selection, tree)
  await verifyTagProtection(api, selection)
  if ((await commit(api, selection.reviewedHead)).tree.sha !== tree) throw new Error('Reviewed final head full tree differs from release source')
  const pr = requireValue(await api.json<Pull>('/pulls/75'), 'PR 75')
  if (pr.number !== 75 || !pr.merged || !pr.merged_at || pr.draft || pr.merge_commit_sha !== selection.mergedCommit
    || pr.head.sha !== selection.reviewedHead || pr.head.repo.full_name !== REPOSITORY
    || pr.base.repo.full_name !== REPOSITORY || pr.base.ref !== BASE) throw new Error('Merged PR or approved final head differs')

  // GraphQL reads classic protection without the REST administration permission.
  // REST branch rules supplies enforced rulesets, which classic protection omits.
  const branch = requireValue(await api.json<BranchFacts>('/graphql', 'POST', { query:
    'query { repository(owner: "cloga", name: "deepseek-harness") { ref(qualifiedName: "refs/heads/review/issue-72-official-base") { branchProtectionRule { requiresApprovingReviews requiredApprovingReviewCount requiresStatusChecks requiredStatusCheckContexts requiredStatusChecks { context app { databaseId } } } } pullRequest(number: 75) { reviewDecision } } }',
  }), 'Branch requirements')
  if (branch.errors?.length || !branch.data?.repository.ref || !branch.data.repository.pullRequest) throw new Error('Required branch/review facts unavailable')
  const classic = classicRequirements(branch.data.repository.ref.branchProtectionRule)
  const rules = await api.list<Rule>(`/rules/branches/${encodeURIComponent(BASE)}`)
  const reviewRules = rules.filter(rule => rule.type === 'pull_request')
  const checkRules = rules.filter(rule => rule.type === 'required_status_checks')
  if (reviewRules.some(rule => !Number.isSafeInteger(rule.parameters?.required_approving_review_count))
    || checkRules.some(rule => !Array.isArray(rule.parameters?.required_status_checks))) throw new Error('Enforced review/check rules unavailable')
  const required = [...classic.checks, ...checkRules.flatMap(rule =>
    requireValue(rule.parameters?.required_status_checks, 'Ruleset checks'))]
  const approvalCount = Math.max(classic.approvals,
    ...reviewRules.map(rule => requireValue(rule.parameters?.required_approving_review_count, 'Ruleset review count')))
  if (approvalCount < 0 || (approvalCount > 0 && branch.data.repository.pullRequest.reviewDecision !== 'APPROVED')) throw new Error('GitHub required-review decision is not approved')
  const reviews = await api.list<Review>('/pulls/75/reviews')
  const latest = new Map<string, Review>()
  for (const review of [...reviews].sort((left, right) => left.id - right.id)) {
    if (['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED'].includes(review.state)) latest.set(review.user.login, review)
  }
  if (['CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(branch.data.repository.pullRequest.reviewDecision ?? '')
    || [...latest.values()].filter(review => review.state === 'APPROVED' && review.commit_id === selection.reviewedHead
      && review.user.login !== pr.user.login && ['OWNER', 'MEMBER', 'COLLABORATOR'].includes(review.author_association)).length < approvalCount) throw new Error('Required final-head approval is missing or changes were requested')

  const ci = await successfulRun(api, selection.ciRun, '.github/workflows/ci.yml', selection)
  const ciJobs = await jobs(api, ci)
  // These named lanes anchor the known ci.yml. Extra jobs also have to succeed;
  // checkout evidence is required for every job that executes a checkout.
  const anchors = ['all checks passed', 'node 24 / static', 'node 24 / coverage', 'node 24 / benchmarks',
    'node 24 / snapshots and artifacts', 'node 22.19', 'node 24.9', 'node 26', 'python 3.10 / keyless SDK',
    'windows node 24 / build', 'windows node 24 / native tests']
  if (anchors.some(name => ciJobs.filter(job => job.name === name && job.conclusion === 'success').length !== 1)
    || !ciJobs.some(job => job.name.startsWith('python runtime / release-shaped matrix /') && job.conclusion === 'success')) throw new Error('Full PR CI inventory unavailable')
  const tested = new Set<string>()
  for (const job of ciJobs) {
    // The successful workflow and aggregate own required jobs. Optional key-gated
    // jobs may be skipped; their absence supplies no tested-source evidence.
    if (job.conclusion !== 'success') continue
    const checkouts = job.steps.filter(step => step.name === 'Run actions/checkout@v6')
    if (checkouts.length === 0) {
      if (job.name !== 'all checks passed') throw new Error('Known checkout step unavailable; cannot infer tested source')
      continue
    }
    const checkout = requireValue(checkouts[0], 'Checkout step')
    if (checkouts.length !== 1 || checkout.status !== 'completed' || checkout.conclusion !== 'success') throw new Error('Ambiguous checkout evidence')
    const testedSha = checkoutCommit((await api.bytes(`/actions/jobs/${job.id}/logs`)).toString('utf8'), checkout)
    const testedCommit = await commit(api, testedSha)
    if (testedCommit.tree.sha !== tree || (testedSha !== selection.reviewedHead && !testedCommit.parents.some(parent => parent.sha === selection.reviewedHead))) throw new Error('Actual tested checkout full tree or PR parent differs')
    tested.add(testedSha)
  }
  if (tested.size === 0) throw new Error('No actual tested checkout evidence')

  const policy = await successfulRun(api, selection.policyRun, '.github/workflows/issue-policy.yml', selection)
  if (!(await jobs(api, policy)).some(job => job.name === 'Issue policy' && job.conclusion === 'success')) throw new Error('Issue policy did not succeed')
  // Required checks may be attached to the PR head or synthetic checkout.
  // Optional skipped e2e and the running manual publisher are not required CI.
  const checks: Check[] = []
  const statuses: Status[] = []
  for (const sha of new Set([selection.reviewedHead, ...tested])) {
    const currentChecks = await api.list<Check>(`/commits/${sha}/check-runs?filter=latest`, 'check_runs')
    const currentStatus = requireValue(await api.json<{ statuses: Status[]; total_count: number }>(`/commits/${sha}/status?per_page=100`), 'Commit status')
    if (currentStatus.total_count > 100 || !Array.isArray(currentStatus.statuses)
      || currentChecks.some(check => check.head_sha !== sha)) throw new Error('Commit checks/statuses unavailable or incomplete')
    checks.push(...currentChecks)
    statuses.push(...currentStatus.statuses)
  }
  for (const rule of required) {
    if (typeof rule.context !== 'string' || !rule.context) throw new Error('Required check context unavailable')
    const namedChecks = checks.filter(check => check.name === rule.context)
    const matching = namedChecks.filter(check => rule.integration_id == null || check.app.id === rule.integration_id)
    const matchingStatuses = statuses.filter(status => status.context === rule.context)
    // filter=latest and the combined-status endpoint supply current results.
    // Do not let a head success mask a tested-merge failure, or a check mask a
    // same-named failed legacy status. Missing app-bound checks cannot be filled
    // by another app or a legacy status whose API cannot establish that binding.
    if (namedChecks.some(check => check.status !== 'completed' || check.conclusion !== 'success')
      || matchingStatuses.some(status => status.state !== 'success')
      || (matching.length === 0 && (rule.integration_id != null || matchingStatuses.length === 0))) throw new Error('Required check evidence missing, contradictory or unsuccessful')
  }

  const current = requireValue(await api.json<Run>(`/actions/runs/${selection.run}`), 'Current release run')
  if (String(current.id) !== selection.run || current.run_attempt !== 1 || current.event !== 'workflow_dispatch'
    || current.path !== '.github/workflows/release.yml' || current.head_sha !== selection.source
    || current.repository.full_name !== REPOSITORY || current.head_repository.full_name !== REPOSITORY) throw new Error('Current artifact source/run differs')
  // A new dispatch must not silently resume a possibly-written earlier run.
  // Recovery after an attempted writer is deliberately an operator procedure.
  const previousRuns = await api.list<Run>(`/actions/workflows/release.yml/runs?event=workflow_dispatch&head_sha=${selection.source}`, 'workflow_runs')
  for (const previous of previousRuns) {
    if (String(previous.id) === selection.run || previous.head_sha !== selection.source) continue
    const previousJobs = await api.list<Job>(`/actions/runs/${previous.id}/jobs?filter=all`, 'jobs')
    if (previousJobs.some(job => job.name === 'Publish Core/Web GitHub artifacts' && job.conclusion !== 'skipped'
      && job.status !== 'queued' && job.status !== 'waiting')) throw new Error('Previous publication attempt requires operator reconciliation; automatic recovery is forbidden')
  }
  const currentJobs = await api.list<Job>(`/actions/runs/${selection.run}/attempts/1/jobs`, 'jobs')
  for (const name of ['Dependency layout', 'Pack npm tarballs']) {
    const matches = currentJobs.filter(job => job.name === name)
    const job = requireValue(matches[0], 'Fresh release job')
    if (matches.length !== 1 || job.run_id !== current.id || job.status !== 'completed' || job.conclusion !== 'success') throw new Error('Fresh dependency and pack checks must both succeed')
  }
  const artifacts = (await api.list<Artifact>(`/actions/runs/${selection.run}/artifacts`, 'artifacts')).filter(item => item.name === 'dsh-npm-tarballs')
  const artifact = requireValue(artifacts[0], 'Same-run artifact')
  if (artifacts.length !== 1 || artifact.expired || !/^[1-9][0-9]*$/u.test(artifactId) || String(artifact.id) !== artifactId
    || artifact.workflow_run.id !== current.id || artifact.workflow_run.head_sha !== selection.source) throw new Error('Same-run source-bound artifact unavailable')
  return tagIdentity
}
