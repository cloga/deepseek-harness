/** Temporary, dependency-free source/output audit; remove before final PR approval. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SCENARIO = 'snapshots/acp/manual-compact-model-selection'
export const OUTPUT_PATHS = ['session.v3.jsonl', 'stdout.expected.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json'].map(name => `${SCENARIO}/${name}`)
export const TEST_TITLE = 'snapshot: manual-compact-model-selection matches the expected outputs'
export const REQUIRED_INPUTS = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
  '.github/workflows/manual-compact-generation.yml',
  '.github/scripts/manual-compact-generation-audit.mjs',
  '.github/scripts/manual-compact-generation-audit.test.mjs',
  '.github/scripts/manual-compact-generation-semantic.mjs',
  'snapshots/acp/acp.snapshot.ts',
  `${SCENARIO}/input.json`, `${SCENARIO}/snapshot.yml`, `${SCENARIO}/cordis.yml`, `${SCENARIO}/cordis.snapshot.yml`,
  'packages/test-support/session-snapshot/src/harness.ts',
  'packages/test-support/session-snapshot/src/suite.ts',
  'packages/test-support/session-snapshot/src/launcher.ts',
  'packages/test-support/llm-replay/src/index.ts',
]
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const json = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const reject = code => { throw Object.assign(new Error(), { auditCode: code }) }
const requireFact = (condition, code) => { if (!condition) reject(code) }
const inside = (parent, child) => {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b

function directory(path) {
  const parent = dirname(path)
  if (parent !== path) directory(parent)
  const stat = lstatSync(path)
  requireFact(stat.isDirectory() && !stat.isSymbolicLink() && samePath(realpathSync(path), resolve(path)), 'UNSAFE_DIRECTORY')
}
function pathIn(root, path) {
  requireFact(typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !/[\\\0\r\n]/u.test(path)
    && path.split('/').every(part => part && part !== '.' && part !== '..'), 'UNSAFE_PATH')
  const absolute = resolve(root, path)
  requireFact(inside(root, absolute), 'UNSAFE_PATH')
  directory(dirname(absolute))
  return absolute
}
function regular(root, path) {
  const absolute = pathIn(root, path)
  const stat = lstatSync(absolute)
  requireFact(stat.isFile() && !stat.isSymbolicLink() && samePath(realpathSync(absolute), absolute), 'UNSAFE_FILE')
  return absolute
}
function git(root, args) {
  return execFileSync('git', ['-c', 'core.quotePath=true', '-c', 'color.ui=false', ...args], {
    cwd: root, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
  })
}
function tracked(root, head) {
  return git(root, ['ls-tree', '-r', '-z', head]).toString('utf8').split('\0').filter(Boolean).map(line => {
    const match = /^(100644|100755|120000) blob ([0-9a-f]{40})\t([^\0]+)$/u.exec(line)
    requireFact(match !== null, 'INVALID_TREE')
    pathIn(root, match[3])
    return { path: match[3], mode: match[1], blob: match[2] }
  })
}
function indexUnchanged(root, rows) {
  const expected = rows.map(row => `${row.mode} ${row.blob} 0\t${row.path}\0`).join('')
  requireFact(git(root, ['ls-files', '--stage', '-z']).equals(Buffer.from(expected)), 'INDEX_CHANGED')
}
function metadata(root, path) {
  const absolute = pathIn(root, path)
  const stat = lstatSync(absolute)
  requireFact(stat.isFile() || stat.isSymbolicLink(), 'UNSAFE_INPUT_TYPE')
  // Committed input links are hashed as link spelling, never followed.
  const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(regular(root, path))
  return { kind: stat.isSymbolicLink() ? 'link' : 'file', fsMode: stat.mode & 0o777, bytes: bytes.length, sha256: digest(bytes) }
}
function untracked(root) {
  return git(root, ['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean)
}
function outputBytes(root, path) {
  const file = regular(root, path)
  const size = lstatSync(file).size
  requireFact(size > 0 && size <= MAX_OUTPUT_BYTES, 'OUTPUT_SIZE')
  return readFileSync(file)
}
function parseLines(bytes) {
  const text = bytes.toString('utf8')
  requireFact(text.endsWith('\n') && !text.includes('\0'), 'INVALID_JSONL')
  return text.trimEnd().split('\n').map(line => {
    const value = JSON.parse(line)
    requireFact(value !== null && typeof value === 'object' && !Array.isArray(value), 'INVALID_JSONL')
    return value
  })
}
function report(evidence, name, exactScenario) {
  const value = JSON.parse(readFileSync(regular(evidence, name), 'utf8'))
  requireFact(value.success === true && value.numFailedTests === 0 && value.numFailedTestSuites === 0
    && Array.isArray(value.testResults), 'FAILED_REPORT')
  const assertions = value.testResults.flatMap(suite => {
    requireFact(['passed', 'pending', 'skipped'].includes(suite.status) && Array.isArray(suite.assertionResults), 'FAILED_REPORT')
    return suite.assertionResults
  })
  requireFact(assertions.every(item => ['passed', 'pending', 'skipped', 'todo'].includes(item.status)
    && (item.failureMessages === undefined || item.failureMessages.length === 0)), 'FAILED_REPORT')
  const passed = assertions.filter(item => item.status === 'passed')
  requireFact(passed.length > 0 && value.numPassedTests === passed.length && value.numTotalTests === assertions.length, 'REPORT_COUNTS')
  if (exactScenario) requireFact(passed.length === 1 && passed[0].title === TEST_TITLE
    && passed[0].fullName === `snapshot scenarios ${TEST_TITLE}`
    && equal(passed[0].ancestorTitles, ['snapshot scenarios']), 'WRONG_SCENARIO')
  return { passed: passed.length, total: assertions.length }
}
function purgeUpload(evidence) {
  const upload = join(evidence, 'upload')
  if (existsSync(upload)) {
    directory(upload)
    rmSync(upload, { recursive: true, force: true })
  }
}

/** Execute one audit phase; errors contain fixed codes, never rejected bytes or paths. */
export function audit(mode, env = process.env) {
  requireFact(mode === 'before' || mode === 'after', 'INVALID_MODE')
  requireFact(isAbsolute(env.GITHUB_WORKSPACE ?? '') && isAbsolute(env.SNAPSHOT_EVIDENCE ?? ''), 'INVALID_ROOT')
  const root = resolve(env.GITHUB_WORKSPACE)
  const evidence = resolve(env.SNAPSHOT_EVIDENCE)
  requireFact(!inside(root, evidence) && !inside(evidence, root), 'INVALID_EVIDENCE')
  directory(root); directory(evidence)
  purgeUpload(evidence)
  try {
    const head = env.EXPECTED_HEAD_SHA
    requireFact(/^[a-f0-9]{40}$/u.test(head ?? '') && env.SOURCE_REPOSITORY === 'cloga/deepseek-harness'
      && env.SOURCE_BRANCH === 'cloga-manual-compact-selection' && env.SOURCE_DRAFT === 'true', 'SOURCE_IDENTITY')
    requireFact(/^[a-f0-9]{40}$/u.test(env.WORKFLOW_SHA ?? '')
      && /^cloga\/deepseek-harness\/\.github\/workflows\/manual-compact-generation\.yml@refs\/pull\/[1-9][0-9]*\/merge$/u.test(env.WORKFLOW_REF ?? '')
      && /^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ID ?? '') && /^[1-9][0-9]*$/u.test(env.GITHUB_RUN_ATTEMPT ?? ''), 'RUN_IDENTITY')
    requireFact(git(root, ['rev-parse', 'HEAD']).toString('utf8').trim() === head, 'HEAD_CHANGED')
    requireFact(samePath(realpathSync(git(root, ['rev-parse', '--show-toplevel']).toString('utf8').trim()), root), 'INVALID_ROOT')
    const tree = git(root, ['rev-parse', 'HEAD^{tree}']).toString('utf8').trim()
    const rows = tracked(root, head)
    indexUnchanged(root, rows)
    const paths = new Set(rows.map(row => row.path))
    requireFact(REQUIRED_INPUTS.every(path => paths.has(path)) && paths.has(OUTPUT_PATHS[0]), 'REQUIRED_INPUT_MISSING')
    for (const path of REQUIRED_INPUTS) regular(root, path)
    const stateFile = join(evidence, 'private-state.json')
    if (mode === 'before') {
      requireFact(!existsSync(stateFile) && untracked(root).length === 0, 'DIRTY_BASELINE')
      requireFact(git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', head]).length === 0
        && git(root, ['ls-files', '-v', '-z']).toString('utf8').split('\0').filter(Boolean).every(line => line.startsWith('H ')), 'DIRTY_BASELINE')
      const outputs = OUTPUT_PATHS.map(path => {
        if (paths.has(path)) { outputBytes(root, path); return { path, existed: true } }
        requireFact(!existsSync(pathIn(root, path)), 'UNTRACKED_TARGET')
        return { path, existed: false }
      })
      const state = { schemaVersion: 1, head, tree, root, node: process.version, platform: process.platform,
        inputs: rows.map(row => ({ ...row, ...metadata(root, row.path) })), outputs }
      const bytes = json(state)
      writeFileSync(stateFile, bytes, { flag: 'wx', mode: 0o600 })
      writeFileSync(join(evidence, 'private-seed.jsonl'), outputBytes(root, OUTPUT_PATHS[0]), { flag: 'wx', mode: 0o600 })
      writeFileSync(join(evidence, 'private-audit.mjs'), readFileSync(regular(root, '.github/scripts/manual-compact-generation-audit.mjs')), { flag: 'wx', mode: 0o400 })
      return `state_sha=${digest(bytes)}`
    }
    const stateBytes = readFileSync(regular(evidence, 'private-state.json'))
    requireFact(/^[a-f0-9]{64}$/u.test(env.EXPECTED_STATE_SHA ?? '') && digest(stateBytes) === env.EXPECTED_STATE_SHA, 'BASELINE_CHANGED')
    const state = JSON.parse(stateBytes.toString('utf8'))
    requireFact(state.schemaVersion === 1 && state.head === head && state.tree === tree && state.root === root
      && state.node === process.version && state.platform === process.platform
      && equal(state.inputs.map(({ path, mode, blob }) => ({ path, mode, blob })), rows), 'BASELINE_CHANGED')
    const initialUntracked = state.outputs.filter(item => !item.existed).map(item => item.path).sort()
    requireFact(equal(untracked(root).sort(), initialUntracked), 'UNTRACKED_DRIFT')
    for (const input of state.inputs) {
      const now = metadata(root, input.path)
      requireFact(now.kind === input.kind && now.fsMode === input.fsMode, 'INPUT_TYPE_CHANGED')
      if (!OUTPUT_PATHS.includes(input.path)) requireFact(now.sha256 === input.sha256 && now.bytes === input.bytes, 'INPUT_CHANGED')
    }
    requireFact(['REFRESH_OUTCOME', 'REPLAY_OUTCOME', 'CORPUS_OUTCOME', 'SEMANTIC_OUTCOME'].every(key => env[key] === 'success'), 'FAILED_STEP')
    const checks = { refresh: report(evidence, 'private-refresh.json', true), replay: report(evidence, 'private-replay.json', true), corpus: report(evidence, 'private-corpus.json', false) }
    const seed = readFileSync(regular(evidence, 'private-seed.jsonl'))
    requireFact(digest(seed) === state.inputs.find(row => row.path === OUTPUT_PATHS[0]).sha256, 'BASELINE_CHANGED')
    const pending = OUTPUT_PATHS.map(path => ({ path, bytes: outputBytes(root, path) }))
    requireFact(pending.every(item => Buffer.from(item.bytes.toString('utf8')).equals(item.bytes)), 'INVALID_UTF8')
    const semanticBytes = readFileSync(regular(evidence, 'private-semantic.json'))
    requireFact(/^[a-f0-9]{64}$/u.test(env.EXPECTED_SEMANTIC_SHA ?? '')
      && digest(semanticBytes) === env.EXPECTED_SEMANTIC_SHA, 'SEMANTIC_RECEIPT_CHANGED')
    const semantic = JSON.parse(semanticBytes.toString('utf8'))
    requireFact(semantic.schemaVersion === 1 && semantic.sourceSha === head
      && semantic.seedSha256 === digest(seed) && semantic.sessionSha256 === digest(pending[0].bytes)
      && equal(semantic.checks, { normalRequests: 2, headers: 1, summaries: 1, summaryModel: 'deepseek-v4-pro', maxTokens: 256 }), 'SEMANTIC_RECEIPT_MISMATCH')
    // Session decoding/semantics are owned by the source-bound official-reader step.
    parseLines(pending[1].bytes)
    requireFact(!pending[2].bytes.includes(0) && pending[2].bytes.toString('utf8').trim().length > 0, 'INVALID_PROMPT')
    const schemas = JSON.parse(pending[3].bytes.toString('utf8'))
    requireFact(json(schemas).equals(pending[3].bytes) && equal(Object.keys(schemas).sort(), ['changes', 'initial'])
      && Array.isArray(schemas.initial) && schemas.initial.length > 0
      && Array.isArray(schemas.changes) && schemas.changes.length === 0
      && schemas.initial.every(item => typeof item?.name === 'string' && item.parameters !== null && typeof item.parameters === 'object')
      && new Set(schemas.initial.map(item => item.name)).size === schemas.initial.length, 'INVALID_TOOL_SCHEMAS')
    // Recheck before any payload is made available to upload-artifact.
    indexUnchanged(root, rows)
    requireFact(git(root, ['rev-parse', 'HEAD']).toString('utf8').trim() === head
      && equal(untracked(root).sort(), initialUntracked), 'LATE_DRIFT')
    for (const input of state.inputs) if (!OUTPUT_PATHS.includes(input.path)) {
      const now = metadata(root, input.path)
      requireFact(now.sha256 === input.sha256 && now.bytes === input.bytes && now.kind === input.kind && now.fsMode === input.fsMode, 'LATE_DRIFT')
    }
    for (const output of pending) requireFact(outputBytes(root, output.path).equals(output.bytes), 'LATE_DRIFT')
    const upload = join(evidence, 'upload')
    mkdirSync(upload)
    const requiredInputs = REQUIRED_INPUTS.map(path => {
      const input = state.inputs.find(row => row.path === path)
      return { path, sha256: input.sha256, bytes: input.bytes, gitBlob: input.blob }
    })
    writeFileSync(join(upload, 'inputs.json'), json({ schemaVersion: 1, sourceSha: head, sourceTree: tree,
      baselineSha256: env.EXPECTED_STATE_SHA, requiredInputs,
      trackedInputs: state.inputs.map(input => ({ pathSha256: digest(input.path), gitBlob: input.blob, gitMode: input.mode, sha256: input.sha256, bytes: input.bytes })) }))
    for (const output of pending) {
      const target = join(upload, 'generated', output.path)
      mkdirSync(dirname(target), { recursive: true })
      writeFileSync(target, output.bytes)
    }
    writeFileSync(join(upload, 'qualified.json'), json({ schemaVersion: 1, sourceSha: head, sourceTree: tree,
      workflowSha: env.WORKFLOW_SHA ?? '', workflowRef: env.WORKFLOW_REF ?? '',
      runId: env.GITHUB_RUN_ID ?? '', runAttempt: env.GITHUB_RUN_ATTEMPT ?? '', node: process.version, platform: process.platform,
      lockSha256: state.inputs.find(row => row.path === 'pnpm-lock.yaml').sha256, checks, semantics: semantic.checks,
      outputs: pending.map(item => ({ path: item.path, bytes: item.bytes.length, sha256: digest(item.bytes) })),
      acceptance: 'Source-bound candidate generation only; parent byte review and exact final-head CI are required.' }))
    return 'MANUAL_COMPACT_AUDIT_ACCEPTED'
  } catch (error) {
    purgeUpload(evidence)
    throw error
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(audit(process.argv[2])) }
  catch (error) {
    const code = /^[A-Z_]+$/u.test(error?.auditCode ?? '') ? error.auditCode : 'AUDIT_FAILED'
    console.error(`MANUAL_COMPACT_AUDIT_REJECTED:${code}`)
    process.exitCode = 1
  }
}
