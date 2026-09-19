/** GitHub artifact publication uses fake HTTP and private files, never live credentials. */
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs'
import { validateArchiveEntries, validateArtifactFamily } from './github-artifacts-prepare.ts'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertDispatch, checkoutCommit, GitHub, publishArtifacts, sealDirectory, verifyDirectory,
  type Selection,
} from './github-artifacts.ts'

const sha = 'a'.repeat(40)
const tree = 'b'.repeat(40)
const head = 'c'.repeat(40)
const version = '0.1.6-alpha.3'
const selection: Selection = {
  repository: 'cloga/deepseek-harness', event: 'workflow_dispatch', publish: 'true',
  ref: `refs/tags/dsh-v${version}`, source: sha, version, reviewedHead: head, mergedCommit: sha,
  ciRun: '100', policyRun: '101', run: '200', attempt: '1',
}
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function directory(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-github-artifacts-'))
  roots.push(root)
  return root
}
function artifact(): string {
  const root = directory()
  writeFileSync(join(root, 'member.tgz'), 'original tarball bytes')
  writeFileSync(join(root, 'publish-order.txt'), 'member.tgz\n')
  sealDirectory(root, selection, tree, ['member.tgz'])
  return root
}

describe('dispatch and checkout evidence', () => {
  it('runs the real guard under plain Node with no dependencies or credentials', () => {
    const env = { GITHUB_REPOSITORY: selection.repository, GITHUB_EVENT_NAME: selection.event,
      GITHUB_REF: selection.ref, GITHUB_SHA: selection.source, GITHUB_RUN_ID: selection.run, GITHUB_RUN_ATTEMPT: selection.attempt,
      RELEASE_PUBLISH: selection.publish, RELEASE_VERSION: selection.version, RELEASE_REVIEWED_HEAD: selection.reviewedHead,
      RELEASE_MERGED_COMMIT: selection.mergedCommit, RELEASE_CI_RUN: selection.ciRun, RELEASE_POLICY_RUN: selection.policyRun }
    const script = fileURLToPath(new URL('./github-artifacts.ts', import.meta.url))
    const result = spawnSync(process.execPath, [script, 'guard'], { env, encoding: 'utf8', timeout: 10_000 })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    const refused = spawnSync(process.execPath, [script, 'guard'], { env: { ...env, GITHUB_REF: 'refs/heads/master' }, encoding: 'utf8', timeout: 10_000 })
    expect(refused.error).toBeUndefined()
    expect(refused.signal).toBeNull()
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('publication refused')
  })
  it('admits only the approved existing tag dispatch and first attempt', () => {
    expect(() => { assertDispatch(selection) }).not.toThrow()
  })
  it('rejects the previous dated candidate even when its tag matches its version', () => {
    const previous = '0.1.6-alpha.2.20260919.1'
    expect(() => { assertDispatch({ ...selection, version: previous, ref: `refs/tags/dsh-v${previous}` }) }).toThrow()
  })
  it.each([
    { repository: 'outsider/deepseek-harness' }, { event: 'pull_request' }, { publish: 'false' },
    { ref: 'refs/heads/master' }, { version: '0.1.6-alpha.2' }, { reviewedHead: 'short' },
    { mergedCommit: head }, { ciRun: 'latest' }, { attempt: '2' },
  ])('rejects invalid selectors %j', (change) => {
    expect(() => { assertDispatch({ ...selection, ...change }) }).toThrow()
  })
  it('uses the checkout step git result, not Actions head_sha or arbitrary printed SHA', () => {
    const step = { started_at: '2026-09-19T10:00:00Z', completed_at: '2026-09-19T10:00:02Z' }
    const logs = `2026-09-19T10:00:00.010Z ##[group]Run actions/checkout@v6\n2026-09-19T10:00:00.020Z Syncing repository: cloga/deepseek-harness\n2026-09-19T10:00:01.100Z [command]/usr/bin/git log -1 --format=%H\n2026-09-19T10:00:01.200Z ${sha}\n2026-09-19T10:00:03.000Z ${head}\n`
    expect(checkoutCommit(logs, step)).toBe(sha)
    expect(checkoutCommit(logs.replace('/usr/bin/git', '"C:\\Program Files\\Git\\bin\\git.exe"'), step)).toBe(sha)
    expect(checkoutCommit(logs.replace('/usr/bin/git', 'git'), step)).toBe(sha)
    expect(checkoutCommit(`2026-09-19T10:00:00.001Z Runner image Commit: ${head}\n${logs}`, step)).toBe(sha)
    expect(() => checkoutCommit(logs.replace('git log -1', 'echo log -1'), step)).toThrow()
    expect(() => checkoutCommit(logs + logs, step)).toThrow()
    expect(() => checkoutCommit(logs, { ...step, completed_at: step.started_at })).toThrow()
  })
})

describe('sealed same-run artifact', () => {
  it('retains exact original bytes and checksums after download', () => {
    const root = artifact()
    expect(verifyDirectory(root, selection).tree).toBe(tree)
    expect(readFileSync(join(root, 'member.tgz'), 'utf8')).toBe('original tarball bytes')
  })
  it.each(['tamper', 'missing', 'extra', 'order', 'source', 'run', 'checksum'])('rejects %s', (variant) => {
    const root = artifact()
    if (variant === 'tamper') writeFileSync(join(root, 'member.tgz'), 'changed')
    if (variant === 'missing') rmSync(join(root, 'member.tgz'))
    if (variant === 'extra') writeFileSync(join(root, 'extra.tgz'), 'extra')
    if (variant === 'order') writeFileSync(join(root, 'publish-order.txt'), '../member.tgz\n')
    if (variant === 'checksum') writeFileSync(join(root, 'SHA256SUMS'), '')
    expect(() => verifyDirectory(root, { ...selection,
      ...(variant === 'source' ? { source: head } : {}), ...(variant === 'run' ? { run: '201' } : {}),
    })).toThrow()
  })
  it('refuses unsafe basenames and preexisting seals', () => {
    expect(() => { sealDirectory(directory(), selection, tree, ['../evil.tgz']) }).toThrow()
    expect(() => { sealDirectory(artifact(), selection, tree, ['member.tgz']) }).toThrow()
  })
})

describe('bounded HTTP', () => {
  it('omits the request body property and content type when no body was supplied', async () => {
    let sent: Parameters<typeof fetch>[1]
    const api = new GitHub('synthetic-token', async (_url, options) => {
      sent = options
      return new Response('{}', { status: 200 })
    }, async () => {})
    await api.json('/releases/1')
    expect(sent).toBeDefined()
    expect(Object.hasOwn(sent ?? {}, 'body')).toBe(false)
    expect(new Headers(sent?.headers).has('content-type')).toBe(false)
  })
  it('uploads only a nonzero-offset Buffer view as owned bytes with the original hash', async () => {
    const backing = Buffer.from([91, 92, 0, 128, 255, 10, 93, 94])
    const original = backing.subarray(2, 6)
    const expected = Buffer.from(original)
    expect(original.byteOffset).toBeGreaterThan(0)
    let sent: Parameters<typeof fetch>[1]
    const api = new GitHub('synthetic-token', async (_url, options) => {
      sent = options
      return new Response('{}', { status: 201 })
    }, async () => {})
    await api.json('/upload/releases/1/assets?name=original.tgz', 'POST', original)
    const body = sent?.body
    if (!(body instanceof Uint8Array)) throw new Error('Binary upload body missing')
    expect(Buffer.from(body)).toEqual(expected)
    expect(createHash('sha256').update(body).digest('hex')).toBe(createHash('sha256').update(expected).digest('hex'))
    expect(new Headers(sent?.headers).get('content-type')).toBe('application/octet-stream')
    original.fill(42)
    expect(Buffer.from(body)).toEqual(expected)
  })
  it('does not retry uncertain writes or expose credentials and response bodies', async () => {
    let calls = 0
    const api = new GitHub('secret', async () => { calls++; throw new Error('secret response') }, async () => {})
    await expect(api.json('/releases', 'POST', {})).rejects.toThrow('uncertain')
    expect(calls).toBe(1)
  })
  it('never forwards authorization over a redirect', async () => {
    const auth: Array<string | null> = []
    const api = new GitHub('secret', async (_url, options) => {
      auth.push(new Headers(options?.headers).get('authorization'))
      return new Response(null, { status: 302, headers: { location: 'https://evil.example/secret' } })
    }, async () => {})
    await expect(api.bytes('/actions/jobs/10/logs')).rejects.toThrow()
    expect(auth).toEqual(['Bearer secret'])
  })
})

const tested = 'd'.repeat(40)
const repository = { full_name: selection.repository }
const step = { name: 'Run actions/checkout@v6', status: 'completed', conclusion: 'success', started_at: '2026-09-19T10:00:00Z', completed_at: '2026-09-19T10:00:02Z' }
const laneNames = ['all checks passed', 'node 24 / static', 'node 24 / coverage', 'node 24 / benchmarks', 'node 24 / snapshots and artifacts',
  'node 22.19', 'node 24.9', 'node 26', 'python 3.10 / keyless SDK', 'windows node 24 / build', 'windows node 24 / native tests',
  'python runtime / release-shaped matrix / build (linux)']
function run(id: number, path: string) {
  return { id, path, run_attempt: 1, event: 'pull_request', status: 'completed', conclusion: 'success', head_sha: head,
    repository, head_repository: repository, pull_requests: [{ number: 75, head: { sha: head }, base: { ref: 'review/issue-72-official-base' } }] }
}
function fixture(mode = '') {
  const ci = run(100, '.github/workflows/ci.yml')
  const policy = run(101, '.github/workflows/issue-policy.yml')
  const ciJobs = laneNames.map((name, index) => ({ id: index + 1, run_id: 100, name, status: 'completed', conclusion: 'success', steps: index === 0 ? [] : [step] }))
  const requiredChecks = [{ name: 'all checks passed', head_sha: head, status: 'completed', conclusion: 'success', app: { id: 1, slug: 'github-actions' } }]
  const pr = { number: 75, merged: true, merged_at: '2026-09-19T11:00:00Z', merge_commit_sha: sha, draft: false,
    user: { login: 'author' }, head: { sha: head, repo: repository }, base: { ref: 'review/issue-72-official-base', repo: repository } }
  const branch = { data: { repository: { ref: { branchProtectionRule: null }, pullRequest: { reviewDecision: 'APPROVED' } } } }
  const routes = new Map<string, unknown>([
    ['/repository', { full_name: selection.repository, private: false, visibility: 'public' }],
    [`/git/commits/${head}`, { sha: head, tree: { sha: tree }, parents: [] }],
    [`/git/ref/tags/dsh-v${version}`, { ref: selection.ref, object: { type: 'commit', sha } }],
    [`/git/commits/${sha}`, { sha, tree: { sha: tree }, parents: [{ sha: head }] }],
    [`/git/tags/${'e'.repeat(40)}`, { object: { type: 'commit', sha } }],
    [`/git/commits/${tested}`, { sha: tested, tree: { sha: tree }, parents: [{ sha: head }] }],
    ['/pulls/75', pr], ['/graphql', branch],
    ['/rulesets', [{ id: 1, target: 'tag', enforcement: 'active' }]],
    ['/rulesets/1', { id: 1, target: 'tag', enforcement: 'active', source_type: 'Repository', source: selection.repository,
      current_user_can_bypass: 'never', bypass_actors: [], conditions: { ref_name: { include: [selection.ref], exclude: [] } },
      rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }] }],
    ['/rules/branches/review%2Fissue-72-official-base', [
      { type: 'pull_request', parameters: { required_approving_review_count: 1 } },
      { type: 'required_status_checks', parameters: { required_status_checks: [{ context: 'all checks passed', integration_id: 1 }] } },
    ]],
    ['/pulls/75/reviews', [{ id: 1, user: { login: 'reviewer' }, state: 'APPROVED', commit_id: head, author_association: 'COLLABORATOR' }]],
    ['/actions/runs/100', ci], ['/actions/runs/101', policy],
    ['/actions/runs/100/attempts/1/jobs', { jobs: ciJobs }],
    ['/actions/runs/101/attempts/1/jobs', { jobs: [{ id: 50, run_id: 101, name: 'Issue policy', status: 'completed', conclusion: 'success', steps: [] }] }],
    [`/commits/${head}/check-runs`, { check_runs: requiredChecks }], [`/commits/${tested}/check-runs`, { check_runs: [] }],
    [`/commits/${head}/status`, { statuses: [], total_count: 0 }], [`/commits/${tested}/status`, { statuses: [], total_count: 0 }],
    ['/actions/runs/200', { ...run(200, '.github/workflows/release.yml'), event: 'workflow_dispatch', status: 'in_progress', head_sha: sha }],
    ['/actions/runs/200/attempts/1/jobs', { jobs: ['Dependency layout', 'Pack npm tarballs'].map((name, index) => ({ id: 60 + index, run_id: 200, name, status: 'completed', conclusion: 'success' })) }],
    ['/actions/runs/200/artifacts', { artifacts: [{ id: 500, name: 'dsh-npm-tarballs', expired: false, workflow_run: { id: 200, head_sha: sha } }] }],
    ['/actions/workflows/release.yml/runs', { workflow_runs: [] }],
  ])
  let release: { id: number; tag_name: string; draft: boolean; prerelease: boolean; immutable?: boolean } | null = mode === 'existing' ? { id: 700, tag_name: `dsh-v${version}`, draft: true, prerelease: true } : null
  const remote: Array<{ id: number; name: string; size: number; digest: string; state: string; bytes: Buffer }> = []
  const writes: Array<{ path: string; method: string; body: unknown }> = []
  const delays: number[] = []
  let tagReads = 0
  const publicReads: Array<{ auth: string | null; name: string }> = []
  const assetApiReads: string[] = []
  const assetInventoryReads: boolean[] = []
  const api = new GitHub('synthetic-workflow-token', async (url, options) => {
    const parsed = new URL(typeof url === 'string' ? url : url instanceof URL ? url.href : url.url)
    const path = parsed.pathname.replace(`/repos/${selection.repository}`, '') || '/repository'
    const method = options?.method ?? 'GET'
    if (parsed.hostname === 'github.com') {
      const name = decodeURIComponent(parsed.pathname.split('/').at(-1)!)
      publicReads.push({ name, auth: new Headers(options?.headers).get('authorization') })
      if (mode === 'public-unavailable' || (mode === 'public-late' && publicReads.length < 3)) return new Response(null, { status: 404 })
      if (mode === 'public-redirect') return new Response(null, { status: 302, headers: { location: 'https://evil.example/bytes' } })
      const item = remote.find(item => item.name === name)!
      return new Response(mode === 'public-tampered' ? 'tampered' : new Uint8Array(item.bytes))
    }
    const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status })
    if (method === 'POST' && path === '/graphql') return json(routes.get(path))
    if (method !== 'GET') {
      writes.push({ path, method, body: options?.body })
      if (method === 'POST' && path === '/releases') {
        if (release || mode === 'conflict') return json({ message: 'sensitive raw failure' }, 422)
        release = { id: 700, tag_name: `dsh-v${version}`, draft: true, prerelease: true }
        if (mode === 'uncertain-create') throw new Error('synthetic token must not leak')
        return json(release, 201)
      }
      if (method === 'POST' && path === '/releases/700/assets') {
        const bytes = Buffer.from(options?.body as Uint8Array)
        const name = parsed.searchParams.get('name')!
        const item = { id: remote.length + 800, name, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, state: 'uploaded', bytes }
        remote.push(item)
        if (mode === 'uncertain-upload') throw new Error('synthetic secret')
        return json(item, 201)
      }
      if (method === 'PATCH' && path === '/releases/700') {
        release!.draft = false
        if (mode === 'uncertain-finalize') throw new Error('synthetic secret')
        return json(release)
      }
      throw new Error('Unexpected fake write')
    }
    if (path.startsWith('/git/ref/')) {
      tagReads++
      if (mode === 'tag-moved' && tagReads > 1) return json({ ref: selection.ref, object: { type: 'commit', sha: head } })
      if (mode === 'tag-absent' || (mode === 'tag-deleted-after-draft' && tagReads > 2)) return new Response(null, { status: 404 })
      if (mode === 'tag-object-recreated' && tagReads <= 2) return json({ ref: selection.ref, object: { type: 'tag', sha: 'e'.repeat(40) } })
      if (mode === 'tag-object-replaced' && tagReads > 3) return json({ ref: selection.ref, object: { type: 'tag', sha: 'e'.repeat(40) } })
    }
    if (path === `/releases/tags/dsh-v${version}`) return release ? json(release) : new Response(null, { status: 404 })
    if (path === '/releases') return json(release ? [release] : [])
    if (path === '/releases/700') return json(release)
    if (path === '/releases/700/assets') {
      assetInventoryReads.push(release?.draft === true)
      const items = remote.map(({ bytes: _bytes, ...item }) => item)
      if (mode === 'extra-asset') items.push({ ...items[0]!, id: 999, name: 'extra.tgz' })
      if (mode === 'missing-asset') items.pop()
      if (mode === 'duplicate-asset') items[1] = items[0]!
      if (mode === 'bad-digest' || (mode === 'postfinal-metadata' && release?.draft === false)) items[0]!.digest = 'sha256:bad'
      return json(items)
    }
    if (path.startsWith('/releases/assets/')) {
      assetApiReads.push(path)
      const item = remote.find(item => String(item.id) === path.split('/').at(-1))!
      return new Response(mode === 'tampered-remote' ? 'tampered' : new Uint8Array(item.bytes))
    }
    if (/^\/actions\/jobs\/\d+\/logs$/u.test(path)) {
      return new Response(mode === 'missing-checkout' ? '' : `2026-09-19T10:00:00.010Z ##[group]Run actions/checkout@v6\n2026-09-19T10:00:00.020Z Syncing repository: cloga/deepseek-harness\n2026-09-19T10:00:01.100Z [command]/usr/bin/git log -1 --format=%H\n2026-09-19T10:00:01.200Z ${tested}\n`)
    }
    if (!routes.has(path)) throw new Error(`Unexpected fake read: ${path}`)
    const value = routes.get(path)
    return value === null ? new Response(null, { status: 404 }) : json(value)
  }, async (ms) => { delays.push(ms) })
  const journal: object[] = []
  return { api, routes, ci, policy, ciJobs, requiredChecks, pr, branch, writes, remote,
    delays, journal, publicReads, assetApiReads, assetInventoryReads,
    publish: (root = artifact(), chosen = selection, artifactId = '500') => publishArtifacts(api, chosen, root, entry => journal.push(entry), artifactId) }
}

describe('authoritative evidence and draft publication', () => {
  it('uploads exact originals serially, verifies remote bytes, then finalizes a non-latest prerelease', async () => {
    const f = fixture()
    expect(await f.publish()).toBe(700)
    expect(f.writes.map(write => write.method)).toEqual(['POST', 'POST', 'POST', 'POST', 'POST', 'PATCH'])
    expect(JSON.parse(String(f.writes[0]!.body))).toMatchObject({ draft: true, prerelease: true, make_latest: 'false', target_commitish: sha })
    expect(JSON.parse(String(f.writes.at(-1)!.body))).toEqual({ draft: false, prerelease: true, make_latest: 'false' })
    expect(f.remote[0]!.bytes.toString()).toBe('original tarball bytes')
    expect(f.journal.at(-1)).toEqual({ operation: 'verified', release: 700, publicBytes: true, immutable: null })
    expect(f.publicReads).toHaveLength(4)
    expect(f.assetApiReads).toHaveLength(4)
    expect(new Set(f.assetApiReads).size).toBe(4)
    expect(f.assetInventoryReads).toEqual([true, false])
    expect(f.publicReads.every(read => read.auth === null)).toBe(true)
    expect(f.delays.every(ms => ms === 1000)).toBe(true)
    await expect(f.publish()).rejects.toThrow('Existing release')
    expect(f.writes).toHaveLength(6)
  })
  it.each(['existing', 'missing-checkout', 'tag-moved', 'tag-absent'])('rejects %s before the first write', async (mode) => {
    const f = fixture(mode)
    await expect(f.publish()).rejects.toThrow()
    expect(f.writes).toHaveLength(0)
  })
  it.each(['extra-asset', 'missing-asset', 'duplicate-asset', 'bad-digest', 'tampered-remote', 'uncertain-upload', 'conflict', 'tag-deleted-after-draft', 'tag-object-recreated', 'tag-object-replaced'])('never finalizes after %s', async (mode) => {
    const f = fixture(mode)
    await expect(f.publish()).rejects.toThrow()
    expect(f.writes.some(write => write.method === 'PATCH')).toBe(false)
  })
  it.each(['public-unavailable', 'public-tampered', 'public-redirect', 'postfinal-metadata'])('reports publication incomplete after %s, without repeating writes', async (mode) => {
    const f = fixture(mode)
    await expect(f.publish()).rejects.toThrow()
    expect(f.writes.filter(write => write.method === 'PATCH')).toHaveLength(1)
    expect(f.publicReads.length).toBeLessThanOrEqual(3)
    expect(f.assetApiReads).toHaveLength(4)
    expect(f.assetInventoryReads).toEqual([true, false])
    expect(f.publicReads.every(read => read.auth === null)).toBe(true)
    expect(f.journal.at(-1)).toEqual({ operation: 'finalize', release: 700 })
  })
  it('bounds read-only public visibility retries without retrying mutations', async () => {
    const f = fixture('public-late')
    expect(await f.publish()).toBe(700)
    expect(f.publicReads).toHaveLength(6)
    expect(f.writes).toHaveLength(6)
  })
  it.each(['reviewed-tree', 'merge-check', 'legacy-status', 'classic-app', 'classic-unavailable', 'private-repository'])('rejects contradictory or unavailable approval evidence: %s', async (variant) => {
    const f = fixture()
    if (variant === 'reviewed-tree') f.routes.set(`/git/commits/${head}`, { sha: head, tree: { sha: tested }, parents: [] })
    if (variant === 'merge-check') f.routes.set(`/commits/${tested}/check-runs`, { check_runs: [{ ...f.requiredChecks[0], head_sha: tested, conclusion: 'failure' }] })
    if (variant === 'legacy-status') f.routes.set(`/commits/${head}/status`, { statuses: [{ context: 'all checks passed', state: 'failure' }], total_count: 1 })
    if (variant === 'private-repository') f.routes.set('/repository', { full_name: selection.repository, private: true, visibility: 'private' })
    if (variant === 'classic-app' || variant === 'classic-unavailable') f.routes.set('/graphql', { data: { repository: { ...f.branch.data.repository,
      ref: { branchProtectionRule: { requiresApprovingReviews: false, requiredApprovingReviewCount: 0, requiresStatusChecks: true, requiredStatusCheckContexts: ['all checks passed'],
        ...(variant === 'classic-app' ? { requiredStatusChecks: [{ context: 'all checks passed', app: { databaseId: 999 } }] } : {}) } },
    } } })
    await expect(f.publish()).rejects.toThrow()
    expect(f.writes).toHaveLength(0)
  })
  it('retains uncertain draft creation evidence and refuses a duplicate POST on another attempt', async () => {
    const f = fixture('uncertain-create')
    await expect(f.publish()).rejects.toThrow('uncertain')
    expect(f.journal).toHaveLength(1)
    await expect(f.publish()).rejects.toThrow('Existing release')
    expect(f.writes).toHaveLength(1)
  })
  it('never retries an uncertain finalization', async () => {
    const f = fixture('uncertain-finalize')
    await expect(f.publish()).rejects.toThrow('uncertain')
    expect(f.writes.filter(write => write.method === 'PATCH')).toHaveLength(1)
    expect(f.journal.at(-1)).toEqual({ operation: 'finalize', release: 700 })
  })
  it.each(['unmerged', 'head', 'merge', 'ci', 'policy', 'tree', 'parent', 'required-check', 'review', 'rules', 'artifact', 'dependencies', 'pack'])('rejects denied evidence: %s', async (variant) => {
    const f = fixture()
    if (variant === 'unmerged') f.pr.merged = false
    if (variant === 'head') f.pr.head.sha = sha
    if (variant === 'merge') f.pr.merge_commit_sha = head
    if (variant === 'ci') f.ci.conclusion = 'failure'
    if (variant === 'policy') f.policy.conclusion = 'failure'
    if (variant === 'tree') f.routes.set(`/git/commits/${tested}`, { sha: tested, tree: { sha: head }, parents: [{ sha: head }] })
    if (variant === 'parent') f.routes.set(`/git/commits/${tested}`, { sha: tested, tree: { sha: tree }, parents: [{ sha }] })
    if (variant === 'required-check') f.requiredChecks[0]!.conclusion = 'failure'
    if (variant === 'review') f.branch.data.repository.pullRequest.reviewDecision = 'CHANGES_REQUESTED'
    if (variant === 'rules') f.routes.set('/graphql', { errors: [{ message: 'unreadable' }] })
    if (variant === 'artifact') f.routes.set('/actions/runs/200/artifacts', { artifacts: [] })
    if (variant === 'dependencies' || variant === 'pack') f.routes.set('/actions/runs/200/attempts/1/jobs', { jobs: [] })
    await expect(f.publish()).rejects.toThrow()
    expect(f.writes).toHaveLength(0)
  })
  it('does not invent mandatory external reviews or block optional skipped checks', async () => {
    const f = fixture()
    f.routes.set('/rules/branches/review%2Fissue-72-official-base', [])
    f.routes.set('/pulls/75/reviews', [])
    f.branch.data.repository.pullRequest.reviewDecision = ''
    f.ciJobs.push({ id: 99, run_id: 100, name: 'optional keyed e2e', status: 'completed', conclusion: 'skipped', steps: [] })
    f.requiredChecks.push({ name: 'manual publisher', head_sha: head, status: 'in_progress', conclusion: '', app: { id: 1, slug: 'github-actions' } })
    expect(await f.publish()).toBe(700)
  })
  it.each(['missing', 'unknown-bypass', 'can-bypass', 'exempt', 'pull-request-bypass', 'exclude', 'wildcard', 'disabled', 'no-creation', 'update-loophole', 'unknown-condition'])('fails closed on tag protection: %s', async (variant) => {
    const f = fixture()
    const rule = f.routes.get('/rulesets/1') as Record<string, unknown>
    if (variant === 'missing') f.routes.set('/rulesets', [])
    if (variant === 'unknown-bypass') delete rule.current_user_can_bypass
    if (variant === 'can-bypass') rule.current_user_can_bypass = 'always'
    if (variant === 'exempt') rule.current_user_can_bypass = 'exempt'
    if (variant === 'pull-request-bypass') rule.current_user_can_bypass = 'pull_requests_only'
    if (variant === 'exclude') rule.conditions = { ref_name: { include: [selection.ref], exclude: [selection.ref] } }
    if (variant === 'wildcard') rule.conditions = { ref_name: { include: ['refs/tags/*'], exclude: [] } }
    if (variant === 'disabled') rule.enforcement = 'disabled'
    if (variant === 'no-creation') rule.rules = [{ type: 'update' }, { type: 'deletion' }]
    if (variant === 'update-loophole') rule.rules = [{ type: 'creation' }, { type: 'update', parameters: { update_allows_fetch_and_merge: true } }, { type: 'deletion' }]
    if (variant === 'unknown-condition') rule.conditions = { ref_name: { include: [selection.ref], exclude: [] }, unknown: true }
    await expect(f.publish()).rejects.toThrow('protection')
    expect(f.writes).toHaveLength(0)
  })
  it.each([undefined, [{ actor_type: 'RepositoryRole', actor_id: 5 }]])('uses publishing-principal non-bypass without requiring a global bypass list: %j', async (bypass) => {
    const f = fixture()
    const rule = f.routes.get('/rulesets/1') as Record<string, unknown>
    if (bypass === undefined) delete rule.bypass_actors
    else rule.bypass_actors = bypass
    expect(await f.publish()).toBe(700)
  })
  it('blocks a new dispatch after a previous writer attempt even if no release is visible', async () => {
    const f = fixture()
    f.routes.set('/actions/workflows/release.yml/runs', { workflow_runs: [{ ...run(199, '.github/workflows/release.yml'), head_sha: sha }] })
    f.routes.set('/actions/runs/199/jobs', { jobs: [{ name: 'Publish Core/Web GitHub artifacts', status: 'completed', conclusion: 'failure' }] })
    await expect(f.publish()).rejects.toThrow('reconciliation')
    expect(f.writes).toHaveLength(0)
  })
  it('rejects a different immutable artifact ID', async () => {
    const f = fixture()
    await expect(f.publish(artifact(), selection, '501')).rejects.toThrow('artifact')
    expect(f.writes).toHaveLength(0)
  })
})

describe('real compressed tarball family validation', () => {
  function packedFixture(variant = '') {
    const root = directory()
    const output = join(root, 'output')
    const member = join(root, 'packages', 'fixture', 'member')
    const payload = join(root, 'payload')
    for (const path of [output, member, join(payload, 'package')]) mkdirSync(path, { recursive: true })
    const name = '@deepseek-ai/dsh-fixture'
    const filename = `deepseek-ai-dsh-fixture-${version}.tgz`
    writeFileSync(join(root, 'package.json'), JSON.stringify({ private: true, version: variant === 'root-version' ? '0.0.0' : version }))
    writeFileSync(join(member, 'package.json'), JSON.stringify({ name, version: variant === 'source-version' ? '0.0.0' : version }))
    writeFileSync(join(payload, 'package', 'package.json'), JSON.stringify({ name: variant === 'packed-name' ? '@deepseek-ai/other' : name, version: variant === 'packed-version' ? '0.0.0' : version }))
    const paths = ['package/package.json']
    if (variant === 'payload') {
      mkdirSync(join(payload, 'package', 'src'))
      writeFileSync(join(payload, 'package', 'src', 'private.ts'), 'export {}')
      paths.push('package/src/private.ts')
    }
    const archive = join(output, filename)
    const result = spawnSync('tar', ['-czf', archive, '-C', payload, ...paths], { encoding: 'utf8', timeout: 10_000 })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    expect(result.status, result.stderr).toBe(0)
    writeFileSync(join(output, 'publish-order.txt'), `${filename}\n`)
    if (variant === 'missing') rmSync(archive)
    if (variant === 'extra') writeFileSync(join(output, 'extra.tgz'), 'extra')
    if (variant === 'wrong-filename') { writeFileSync(join(output, 'other.tgz'), readFileSync(archive)); rmSync(archive) }
    if (variant === 'order') writeFileSync(join(output, 'publish-order.txt'), `${filename}\n${filename}\n`)
    return { root, output, filename, archive }
  }
  it('reads the real packed package manifest and leaves original gzip bytes unchanged', () => {
    const f = packedFixture()
    const bytes = readFileSync(f.archive)
    expect(validateArtifactFamily(f.root, f.output, version)).toEqual([f.filename])
    expect(readFileSync(f.archive)).toEqual(bytes)
  })
  it.each(['root-version', 'source-version', 'packed-name', 'packed-version', 'payload', 'missing', 'extra', 'wrong-filename', 'order'])('rejects genuine packed/source inconsistency: %s', (variant) => {
    const f = packedFixture(variant)
    expect(() => validateArtifactFamily(f.root, f.output, version)).toThrow()
  })
})

describe('archive entries and filesystem links', () => {
  it('accepts a regular package manifest inventory', () => {
    expect(() => { validateArchiveEntries(['package/package.json'], '-rw-r--r-- 0/0 42 2026-09-19 package/package.json\n') }).not.toThrow()
  })
  it.each([
    ['package/package.json', 'package/../evil'], ['package/package.json', '/evil'],
    ['package/package.json', 'package/package.json'], ['package/package.json', 'package\\evil'],
  ])('rejects unsafe inventory %j', (...paths) => {
    expect(() => { validateArchiveEntries(paths, paths.map(path => `-rw-r--r-- 0/0 1 ${path}`).join('\n')) }).toThrow()
  })
  it.each(['l', 'h', 'c', 'b', 'p'])('rejects tar type %s', (type) => {
    expect(() => { validateArchiveEntries(['package/package.json'], `${type}rw-r--r-- 0/0 42 package/package.json\n`) }).toThrow()
  })
  it('rejects a linked artifact directory', () => {
    const root = artifact()
    const link = join(directory(), 'linked')
    symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => verifyDirectory(link, selection)).toThrow('real')
  })
})
