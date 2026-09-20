/** Temporary audit tests: rejected sentinel content must reach neither logs nor artifacts. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { OUTPUT_PATHS, REQUIRED_INPUTS, TEST_TITLE } from './manual-compact-generation-audit.mjs'
import { verifyNormalizedSession } from './manual-compact-generation-semantic.mjs'

const AUDITOR = fileURLToPath(new URL('./manual-compact-generation-audit.mjs', import.meta.url))
const SENTINEL = 'REJECTED_PRIVATE_SENTINEL_DO_NOT_UPLOAD'
const encode = value => `${JSON.stringify(value, null, 2)}\n`
const git = (cwd, args) => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
function put(root, path, contents) { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), contents) }
function normalizedEvents() {
  const content = [{ type: 'text', text: 'reviewed checkpoint' }]
  const summary = { provider: 'deepseek-official', model: 'deepseek-v4-pro', maxTokens: 256, llmStreamCall: true,
    compactionId: 'compact-1', sourceCommandId: 'command-1', summary: content, rawOutput: content }
  const rows = [
    { type: 'request/header', data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-v4-flash' } } } },
    ...[1, 2].flatMap(n => [
      { type: 'turn/start', data: { turn: n } },
      { type: 'step/start', data: { turn: n, step: 1 } },
      { type: 'assistant/message', data: { message: { source: { provider: 'deepseek-official', model: 'deepseek-v4-flash' }, content: [{ type: 'text', text: `answer ${n}` }] } } },
    ]),
    { type: 'command/run', data: { commandId: 'command-1', name: 'compact', args: '' } },
    { type: 'compaction/start', data: { compactionId: 'compact-1', sourceCommandId: 'command-1', turn: null } },
    { type: 'compaction/summary', data: summary },
    { type: 'compaction/end', data: { compactionId: 'compact-1', sourceCommandId: 'command-1', turn: null } },
    { type: 'command/done', data: { commandId: 'command-1', kind: 'success' } },
  ].map((value, seq) => ({ ...value, seq }))
  rows.at(-1).data.sourceEventSeq = rows.find(row => row.type === 'compaction/summary').seq
  return rows
}
function transcript() {
  return [{ type: 'session', version: 3 }, ...normalizedEvents()].map(value => JSON.stringify(value)).join('\n') + '\n'
}
function report(title = TEST_TITLE, ancestor = ['snapshot scenarios']) {
  return { success: true, numFailedTests: 0, numFailedTestSuites: 0, numPassedTests: 1, numTotalTests: 1,
    testResults: [{ status: 'passed', assertionResults: [{ status: 'passed', title, ancestorTitles: ancestor,
      fullName: [...ancestor, title].join(' '), failureMessages: [] }] }] }
}
function fixture(t) {
  const temporary = mkdtempSync(join(tmpdir(), 'manual-compact-audit-'))
  const root = join(temporary, 'source'), evidence = join(temporary, 'evidence')
  mkdirSync(root); mkdirSync(evidence)
  const links = []
  t.after(() => { for (const link of links) unlinkSync(link); rmSync(temporary, { recursive: true, force: true }) })
  git(root, ['init', '-q'])
  git(root, ['config', 'user.name', 'Audit Fixture'])
  git(root, ['config', 'user.email', 'audit@example.invalid'])
  // This synthetic repository has no production hooks or credentials.
  const hooks = join(temporary, 'empty-hooks'); mkdirSync(hooks)
  git(root, ['config', 'core.hooksPath', hooks])
  for (const path of REQUIRED_INPUTS) put(root, path, '{}\n')
  put(root, '.github/scripts/manual-compact-generation-audit.mjs', readFileSync(AUDITOR))
  put(root, OUTPUT_PATHS[0], transcript())
  put(root, 'unrelated.txt', 'reviewed source\n')
  git(root, ['add', '.']); git(root, ['commit', '-qm', 'synthetic reviewed source'])
  const head = git(root, ['rev-parse', 'HEAD'])
  const env = { ...process.env, GITHUB_WORKSPACE: root, SNAPSHOT_EVIDENCE: evidence,
    EXPECTED_HEAD_SHA: head, SOURCE_REPOSITORY: 'cloga/deepseek-harness', SOURCE_BRANCH: 'cloga-manual-compact-selection', SOURCE_DRAFT: 'true',
    WORKFLOW_SHA: head, WORKFLOW_REF: 'cloga/deepseek-harness/.github/workflows/manual-compact-generation.yml@refs/pull/86/merge',
    GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', REFRESH_OUTCOME: 'success', REPLAY_OUTCOME: 'success', CORPUS_OUTCOME: 'success', SEMANTIC_OUTCOME: 'success' }
  const run = mode => spawnSync(process.execPath, [mode === 'after' ? join(evidence, 'private-audit.mjs') : join(root, '.github/scripts/manual-compact-generation-audit.mjs'), mode], { env, encoding: 'utf8' })
  const before = run('before')
  assert.equal(before.status, 0, before.stderr)
  assert.match(before.stdout, /^state_sha=[a-f0-9]{64}\r?\n$/u)
  env.EXPECTED_STATE_SHA = before.stdout.trim().split('=')[1]
  put(root, OUTPUT_PATHS[1], '{"jsonrpc":"2.0","id":1,"result":{}}\n')
  put(root, OUTPUT_PATHS[2], 'Reviewed generated prompt.\n')
  put(root, OUTPUT_PATHS[3], encode({ initial: [{ name: 'read', parameters: { type: 'object' } }], changes: [] }))
  for (const name of ['refresh', 'replay']) put(evidence, `private-${name}.json`, encode(report()))
  put(evidence, 'private-corpus.json', encode(report('corpus invariants', [])))
  const hash = bytes => createHash('sha256').update(bytes).digest('hex')
  const semantic = encode({ schemaVersion: 1, sourceSha: head,
    seedSha256: hash(transcript()), sessionSha256: hash(transcript()),
    checks: verifyNormalizedSession(normalizedEvents(), normalizedEvents()) })
  put(evidence, 'private-semantic.json', semantic)
  env.EXPECTED_SEMANTIC_SHA = hash(semantic)
  return { temporary, root, evidence, env, links, run }
}
function artifactBytes(evidence) {
  const output = []
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) visit(path)
      else if (entry.isFile()) output.push(readFileSync(path))
      else assert.fail('audit output contains a link')
    }
  }
  try { visit(join(evidence, 'upload')) } catch (error) { if (error.code !== 'ENOENT') throw error }
  return Buffer.concat(output).toString('utf8')
}
function rejectsWithoutLeak(f) {
  const result = f.run('after')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /^MANUAL_COMPACT_AUDIT_REJECTED:[A-Z_]+\r?\n$/u)
  assert.equal((result.stdout + result.stderr).includes(SENTINEL), false)
  assert.equal(artifactBytes(f.evidence).includes(SENTINEL), false)
  assert.equal(artifactBytes(f.evidence), '')
}

test('publishes only four candidate outputs and source-bound receipts', t => {
  const f = fixture(t)
  const result = f.run('after')
  assert.equal(result.status, 0, result.stderr)
  const receipt = JSON.parse(readFileSync(join(f.evidence, 'upload/qualified.json'), 'utf8'))
  assert.equal(receipt.sourceSha, f.env.EXPECTED_HEAD_SHA)
  assert.deepEqual(receipt.outputs.map(item => item.path), OUTPUT_PATHS)
  assert.equal(receipt.checks.refresh.passed, 1)
  assert.equal(receipt.checks.replay.passed, 1)
  assert.equal(receipt.lockSha256.length, 64)
  assert.equal(readdirSync(join(f.evidence, 'upload')).length, 3)
  assert.equal(artifactBytes(f.evidence).includes('private-refresh'), false)
})

for (const path of ['unrelated.txt', 'pnpm-lock.yaml', 'snapshots/acp/manual-compact-model-selection/input.json', '.github/scripts/manual-compact-generation-audit.mjs']) {
  test(`rejects changed ${path} without exposing its sentinel`, t => {
    const f = fixture(t); put(f.root, path, SENTINEL); rejectsWithoutLeak(f)
  })
}
test('rejects additional untracked output without printing its path or contents', t => {
  const f = fixture(t); put(f.root, `${SENTINEL}.txt`, SENTINEL); rejectsWithoutLeak(f)
})
test('rejects an output link without following it', t => {
  const f = fixture(t)
  const target = join(f.temporary, 'outside'); mkdirSync(target); put(target, 'secret.txt', SENTINEL)
  const path = join(f.root, OUTPUT_PATHS[2]); unlinkSync(path)
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir'); f.links.push(path)
  rejectsWithoutLeak(f)
})
test('rejects changed source head', t => {
  const f = fixture(t); f.env.EXPECTED_HEAD_SHA = '0'.repeat(40); rejectsWithoutLeak(f)
})
test('rejects staged source drift', t => {
  const f = fixture(t); put(f.root, 'unrelated.txt', SENTINEL); git(f.root, ['add', 'unrelated.txt']); rejectsWithoutLeak(f)
})
test('rejects a changed private baseline and removes any stale upload', t => {
  const f = fixture(t)
  put(f.evidence, 'private-state.json', encode({ private: SENTINEL }))
  put(f.evidence, 'upload/stale.txt', SENTINEL)
  rejectsWithoutLeak(f)
})
test('rejects a failed step without uploading captured private reports', t => {
  const f = fixture(t); f.env.REFRESH_OUTCOME = 'failure'
  put(f.evidence, 'private-refresh.json', encode({ success: false, private: SENTINEL }))
  rejectsWithoutLeak(f)
})
test('rejects a report for another scenario, including its private assertion text', t => {
  const f = fixture(t)
  const wrong = report('wrong scenario')
  wrong.testResults[0].assertionResults[0].failureMessages = [SENTINEL]
  put(f.evidence, 'private-replay.json', encode(wrong)); rejectsWithoutLeak(f)
})
test('rejects zero-test reports', t => {
  const f = fixture(t); const empty = report()
  empty.numPassedTests = 0; empty.numTotalTests = 0; empty.testResults[0].assertionResults = []
  put(f.evidence, 'private-refresh.json', encode(empty)); rejectsWithoutLeak(f)
})
test('rejects a generated summary on the stale route', t => {
  const f = fixture(t)
  put(f.root, OUTPUT_PATHS[0], transcript().replace('"model":"deepseek-v4-pro"', '"model":"deepseek-v4-flash"'))
  rejectsWithoutLeak(f)
})
test('rejects changed model prose instead of exporting arbitrary sidecar content', t => {
  const f = fixture(t); put(f.root, OUTPUT_PATHS[0], transcript().replaceAll('reviewed checkpoint', SENTINEL)); rejectsWithoutLeak(f)
})
test('rejects invalid schema extensions with a private payload', t => {
  const f = fixture(t)
  put(f.root, OUTPUT_PATHS[3], encode({ initial: [{ name: 'read', parameters: {} }], changes: [], private: SENTINEL }))
  rejectsWithoutLeak(f)
})
test('rejects a workflow reference outside the exact PR merge carrier', t => {
  const f = fixture(t); f.env.WORKFLOW_REF = 'cloga/deepseek-harness/.github/workflows/manual-compact-generation.yml@refs/heads/master'; rejectsWithoutLeak(f)
})
test('binds absent sidecars instead of permitting arbitrary newly generated files', t => {
  const f = fixture(t)
  const state = JSON.parse(readFileSync(join(f.evidence, 'private-state.json'), 'utf8'))
  assert.deepEqual(state.outputs, OUTPUT_PATHS.map((path, i) => ({ path, existed: i === 0 })))
})
for (const [name, mutate] of [
  ['old summary target', rows => { rows.find(row => row.type === 'compaction/summary').data.model = 'deepseek-v4-flash' }],
  ['old summary budget', rows => { rows.find(row => row.type === 'compaction/summary').data.maxTokens = 128 }],
  ['extra ordinary request', rows => { rows.push({ type: 'step/start', data: {} }) }],
  ['failed manual completion', rows => { rows.find(row => row.type === 'compaction/end').data.error = SENTINEL }],
  ['changed summary prose', rows => { rows.find(row => row.type === 'compaction/summary').data.summary = [{ type: 'text', text: SENTINEL }] }],
]) {
  test(`official-decoder semantic predicate rejects ${name}`, () => {
    const rows = normalizedEvents(); mutate(rows)
    assert.throws(() => verifyNormalizedSession(normalizedEvents(), rows), error => {
      assert.equal(error.message.includes(SENTINEL), false)
      return /^[A-Z_]+$/u.test(error.auditCode)
    })
  })
}
