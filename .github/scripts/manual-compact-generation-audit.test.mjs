/** Temporary audit tests: rejected sentinel content must reach neither logs nor artifacts. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { OUTPUT_PATHS, REQUIRED_INPUTS, TEST_TITLE, TEST_GROUP } from './manual-compact-generation-audit.mjs'
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
function report(title = TEST_TITLE, ancestor = [TEST_GROUP]) {
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
  put(root, OUTPUT_PATHS[1], 'Reviewed generated prompt.\n')
  put(root, OUTPUT_PATHS[2], encode({ initial: [{ name: 'read', parameters: { type: 'object' } }], changes: [] }))
  put(root, OUTPUT_PATHS[3], '- text: Compacted prior history.\n')
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
  const lines = result.stderr.trimEnd().split(/\r?\n/u)
  assert.equal(lines.length, 2)
  assert.match(lines[0], /^MANUAL_COMPACT_DIAGNOSTICS=/u)
  assert.match(lines[1], /^MANUAL_COMPACT_AUDIT_REJECTED:[A-Z_]+$/u)
  assert.equal((result.stdout + result.stderr).includes(SENTINEL), false)
  assert.equal(artifactBytes(f.evidence).includes(SENTINEL), false)
  assert.equal(artifactBytes(f.evidence), '')
  return { result, diagnostics: JSON.parse(lines[0].slice('MANUAL_COMPACT_DIAGNOSTICS='.length)) }
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

for (const path of ['unrelated.txt', 'pnpm-lock.yaml', 'apps/web/tests/manual-compact-model-selection.overlay.yml', '.github/scripts/manual-compact-generation-audit.mjs']) {
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
test('diagnoses failed refresh separately from missing output aftermath without revealing assertions', t => {
  const f = fixture(t)
  f.env.REFRESH_OUTCOME = 'failure'
  for (const phase of ['REPLAY', 'CORPUS', 'SEMANTIC']) f.env[`${phase}_OUTCOME`] = 'skipped'
  for (const path of OUTPUT_PATHS.slice(1)) unlinkSync(join(f.root, path))
  const failed = report()
  Object.assign(failed, { success: false, numPassedTests: 0, numFailedTests: 1, numFailedTestSuites: 1 })
  failed.testResults[0].status = 'failed'
  const assertion = failed.testResults[0].assertionResults[0]
  assertion.status = 'failed'
  assertion.failureMessages = [`Error: web e2e scaffold: locator.click: Timeout 30000ms exceeded ENOENT\nexpected: ${SENTINEL}\nreceived: ${SENTINEL}\n at hiddenFunction (${f.root.replaceAll('\\', '/')}/apps/web/tests/manual-compact-model-selection.e2e.ts:371:13)\n ❯ apps/web/tests/scaffold.ts:1294:24\n at /unapproved/${SENTINEL}/private.ts:4:2`]
  put(f.evidence, 'private-refresh.json', encode(failed))
  const { result, diagnostics } = rejectsWithoutLeak(f)
  assert.match(result.stderr, /MANUAL_COMPACT_AUDIT_REJECTED:FAILED_STEP/u)
  assert.equal(result.stderr.includes('UNTRACKED_DRIFT'), false)
  assert.equal(result.stderr.includes('hiddenFunction'), false)
  assert.equal(result.stderr.includes('expected:'), false)
  assert.equal(result.stderr.includes('received:'), false)
  assert.equal(result.stderr.includes('/unapproved/'), false)
  assert.equal(result.stderr.includes(f.root), false)
  assert.deepEqual(diagnostics.phases[0].counts, { total: 1, passed: 0, failed: 1, failedSuites: 1 })
  assert.deepEqual(diagnostics.phases[0].categories, ['MISSING_FILE', 'WEB_SCAFFOLD_FAILURE', 'BROWSER_TIMEOUT'])
  assert.deepEqual(diagnostics.phases[0].positions, [
    { source: 'apps/web/tests/manual-compact-model-selection.e2e.ts', line: 371, column: 13 },
    { source: 'apps/web/tests/scaffold.ts', line: 1294, column: 24 },
  ])
  assert.equal(diagnostics.targets[0].state, 'file')
  assert.equal(diagnostics.targets[0].bytes > 0, true)
  assert.equal(diagnostics.targets.slice(1).every(target => target.state === 'absent' && target.bytes === null), true)
})
test('classifies non-report startup stderr without exposing module or unfamiliar path text', t => {
  const f = fixture(t); f.env.REFRESH_OUTCOME = 'failure'
  put(f.evidence, 'private-refresh.json', SENTINEL)
  put(f.evidence, 'private-refresh.stderr', `Error [ERR_MODULE_NOT_FOUND]: Cannot find package '${SENTINEL}'\n at /foreign/${SENTINEL}.js:4:2\n at file://${f.root.replaceAll('\\', '/')}/apps/cli/lib/bin.js:22:4\n`)
  const { diagnostics } = rejectsWithoutLeak(f)
  assert.equal(diagnostics.phases[0].report, 'invalid-json')
  assert.deepEqual(diagnostics.phases[0].categories, ['MODULE_NOT_FOUND'])
  assert.deepEqual(diagnostics.phases[0].positions, [{ source: 'apps/cli/lib/bin.js', line: 22, column: 4 }])
})
test('does not project unknown counter values or paths that only resemble allowlisted source paths', t => {
  const f = fixture(t); f.env.REFRESH_OUTCOME = 'failure'
  const failed = report()
  failed.numPassedTests = SENTINEL
  failed.numFailedTests = -1
  failed.testResults[0].message = `at /foreign/${SENTINEL}/apps/web/tests/manual-compact-model-selection.e2e.ts:99:7`
  put(f.evidence, 'private-refresh.json', encode(failed))
  const { diagnostics } = rejectsWithoutLeak(f)
  assert.equal(diagnostics.phases[0].counts.passed, null)
  assert.equal(diagnostics.phases[0].counts.failed, null)
  assert.deepEqual(diagnostics.phases[0].positions, [])
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
  put(f.root, OUTPUT_PATHS[2], encode({ initial: [{ name: 'read', parameters: {} }], changes: [], private: SENTINEL }))
  rejectsWithoutLeak(f)
})
test('rejects a leftover ACP stdout artifact outside the Web allowlist', t => {
  const f = fixture(t)
  put(f.root, 'snapshots/acp/manual-compact-model-selection/stdout.expected.jsonl', SENTINEL)
  rejectsWithoutLeak(f)
})
test('rejects invalid checkpoint Markdown without uploading its payload', t => {
  const f = fixture(t); put(f.root, OUTPUT_PATHS[3], `\0${SENTINEL}`); rejectsWithoutLeak(f)
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
