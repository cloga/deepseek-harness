/**
 * TEMPORARY, dependency-free audit only. Never runs a generator or writes a repo file.
 * Run `node .github/scripts/core-alpha2-snapshot-audit.mjs before|after` in a clean
 * checkout, with absolute GITHUB_WORKSPACE, absolute external SNAPSHOT_EVIDENCE,
 * and EXPECTED_HEAD_SHA (40 lowercase hex). `git` must be available on PATH.
 * Use a fresh, private evidence directory. Upload ONLY evidence/upload/**.
 * Between modes: normal frozen install + build, official headless refresh then
 * replay of plugin-manager and plugin-manager-mcp, then read-only corpus checks.
 * after requires REFRESH_OUTCOME, REPLAY_OUTCOME, CORPUS_OUTCOME all `success`
 * and private-refresh.json, private-replay.json, private-corpus.json in evidence.
 * Vitest JSON reports/logs and private-before MUST NEVER be uploaded.
 *
 * Scope: six fixed generated paths; only two tool-schemas.expected.json payloads.
 * Four leaves in each of ordinary initial, MCP initial, MCP changes[0] may change:
 * description, parameters.properties.action.enum, target.description, and
 * approvedBuilds.description. Exactly all twelve changes are required. Other four
 * generated files, all other schema structure/values and every tracked input stay
 * byte-identical. Source is read-only tools.ts's exact literal registration shape;
 * no TS dependency, import/eval, interpolation, escapes or computed syntax allowed.
 * JSON sidecars must have canonical JSON.stringify(value, null, 2) + '\n' bytes.
 * This authenticates a narrow diff, not runtime/CI completeness or runner choice.
 */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const scenarios = ['plugin-manager', 'plugin-manager-mcp']
const sourcePath = 'packages/boot/plugin-manager/src/tools.ts'
const lockPath = 'pnpm-lock.yaml'
const targets = scenarios.flatMap(s => ['session.v3.jsonl', 'system-prompt.expected.md', 'tool-schemas.expected.json'].map(f => `snapshots/session/${s}/${f}`))
const outputPaths = targets.filter(p => p.endsWith('/tool-schemas.expected.json'))
const oldActions = ['list_plugins', 'list_bundles', 'set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle']
const newActions = ['list_plugins', 'list_bundles', 'list_pending', 'cancel_pending', 'set_plugin', 'set_bundle', 'install_bundle', 'remove_bundle']
const scope = {
  sourcePath, generatedPaths: targets, acceptedPaths: outputPaths,
  entries: ['plugin-manager.initial', 'plugin-manager-mcp.initial', 'plugin-manager-mcp.changes[0]'],
  leaves: ['description', 'parameters.properties.action.enum', 'parameters.properties.target.description', 'parameters.properties.approvedBuilds.description'],
  requiredLeafChanges: 12, requiredOutcomes: ['REFRESH_OUTCOME', 'REPLAY_OUTCOME', 'CORPUS_OUTCOME'],
  qualification: 'Narrow official snapshot byte audit only; private reports and baseline never uploaded.',
}
const sha = b => createHash('sha256').update(b).digest('hex')
const blob = b => createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex')
const jsonBytes = v => Buffer.from(JSON.stringify(v, null, 2) + '\n')
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b)
const fail = code => { throw Object.assign(new Error(), { auditCode: code }) }
const check = (condition, code) => { if (!condition) fail(code) }
const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b
const inside = (a, b) => { const p = relative(a, b); return p === '' || (!isAbsolute(p) && p !== '..' && !p.startsWith(`..${sep}`)) }
let root, evidence, upload, head, baseline
let phase = 'ENVIRONMENT_REJECTED'
let publicInputs = { schemaVersion: 1, scope, inputs: [] }
let outputs = []
let fixedTargetDrift = []
let diff = Buffer.alloc(0)
const problems = new Set()
const git = args => execFileSync('git', ['-c', 'core.quotePath=true', '-c', 'color.ui=false', ...args], {
  cwd: root, maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
})
function directories(path, create = false) {
  const parent = dirname(path)
  if (parent !== path) directories(parent, create)
  if (!existsSync(path) && create) mkdirSync(path)
  const s = lstatSync(path)
  check(s.isDirectory() && !s.isSymbolicLink(), 'DIRECTORY_NOT_OWNED')
  check(samePath(realpathSync(path), resolve(path)), 'DIRECTORY_NOT_OWNED')
}
function safe(path) {
  check(typeof path === 'string' && path.length > 0 && !isAbsolute(path) && !path.includes('\\') && !/[\0\r\n]/u.test(path)
    && path.split('/').every(p => p !== '' && p !== '.' && p !== '..'), 'TRACKED_PATH_REJECTED')
  const absolute = resolve(root, path)
  check(inside(root, absolute), 'TRACKED_PATH_REJECTED')
  return absolute
}
function regularAt(absolute, owner) {
  check(inside(owner, absolute), 'FILE_NOT_OWNED')
  directories(dirname(absolute))
  const stat = lstatSync(absolute)
  check(stat.isFile() && !stat.isSymbolicLink(), 'FILE_NOT_REGULAR')
  check(samePath(realpathSync(absolute), absolute), 'FILE_NOT_OWNED')
  return absolute
}
function regular(path) { return regularAt(safe(path), root) }
function working(path) {
  const absolute = safe(path)
  directories(dirname(absolute))
  const stat = lstatSync(absolute)
  check(stat.isFile() || stat.isSymbolicLink(), 'INPUT_TYPE_REJECTED')
  // Links are hashed as link spelling, NEVER opened. Intermediate links are rejected.
  const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(regular(path))
  return { kind: stat.isSymbolicLink() ? 'link' : 'file', fsMode: stat.mode & 0o777, bytes: bytes.length, sha256: sha(bytes) }
}
function canonical(bytes) {
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { fail('SIDECAR_JSON_REJECTED') }
  check(jsonBytes(value).equals(bytes), 'SIDECAR_NOT_CANONICAL')
  return value
}
function readPrivate(name) { return readFileSync(regularAt(join(evidence, name), evidence)) }
function tree() {
  return git(['ls-tree', '-r', '-z', head]).toString('utf8').split('\0').filter(Boolean).map(line => {
    const m = /^(100644|100755|120000) blob ([a-f0-9]{40})\t([^\0]+)$/u.exec(line)
    check(m !== null, 'TREE_REJECTED')
    safe(m[3])
    return { path: m[3], gitMode: m[1], gitBlob: m[2] }
  })
}
function indexMatches(rows) {
  const expected = rows.map(r => `${r.gitMode} ${r.gitBlob} 0\t${r.path}\0`).join('')
  check(git(['ls-files', '--stage', '-z']).equals(Buffer.from(expected)), 'INDEX_CHANGED')
}
function noUntracked() {
  check(git(['ls-files', '--others', '--exclude-standard', '-z']).length === 0, 'UNTRACKED_DRIFT')
}
function literalSource() {
  const text = readFileSync(regular(sourcePath), 'utf8').replace(/\r\n/gu, '\n')
  check(text.split('ctx.tools.register(defineTool({').length === 2, 'SOURCE_SYNTAX_REJECTED')
  // Intentionally narrow grammar: exact current registration layout and literal-only fields.
  const s = "'([^'\\\\\\n\\r]*)'"
  const pattern = '^  ctx\\.tools\\.register\\(defineTool\\(\\{\\n'
    + "    name: 'plugin_manager',\\n"
    + '    description: ' + s + ',\\n'
    + '    parameters: \\{\\n'
    + "      action: \\{ type: 'string', required: true, enum: \\[([^\\n]*)\\], description: 'Management operation\\.' \\},\\n"
    + "      target: \\{ type: 'string', description: " + s + ' \\},\\n'
    + "      enabled: \\{ type: 'boolean', description: 'Required for set operations; defaults to true for installation\\.' \\},\\n"
    + "      approvedBuilds: \\{ type: 'array', items: \\{ type: 'string' \\}, description: " + s + ' \\},\\n'
    + "      offset: \\{ type: 'number', description: 'Zero-based list offset; defaults to 0\\.' \\},\\n"
    + "      limit: \\{ type: 'number', description: 'List page size, from 1 to 100; defaults to 25\\.' \\},\\n"
    + '    \\},\\n    output: \\{\\n'
  const m = new RegExp(pattern, 'mu').exec(text)
  check(m !== null, 'SOURCE_SYNTAX_REJECTED')
  check(m[2] === newActions.map(v => `'${v}'`).join(', '), 'SOURCE_ACTIONS_REJECTED')
  return { description: m[1], actions: newActions, target: m[3], approvedBuilds: m[4] }
}
function schemaEntries(value, index) {
  check(value !== null && typeof value === 'object' && !Array.isArray(value), 'SCHEMA_SHAPE_REJECTED')
  check(Array.isArray(value.initial) && Array.isArray(value.changes) && value.changes.length === index, 'GENERATION_COUNT_REJECTED')
  const generations = [value.initial, ...value.changes]
  return generations.map((entries, generation) => {
    check(Array.isArray(entries), 'SCHEMA_SHAPE_REJECTED')
    const indices = entries.flatMap((entry, i) => entry?.name === 'plugin_manager' ? [i] : [])
    check(indices.length === 1, 'MANAGER_COUNT_REJECTED')
    return { entry: entries[indices[0]], prefix: generation === 0 ? ['initial', String(indices[0])] : ['changes', '0', String(indices[0])] }
  })
}
function auditSchema(previous, current, index, literals) {
  const old = canonical(previous), now = canonical(current)
  const entries = schemaEntries(old, index)
  schemaEntries(now, index)
  const allowed = new Map()
  for (const { entry, prefix } of entries) {
    check(equal(entry?.parameters?.properties?.action?.enum, oldActions), 'BASELINE_ACTIONS_REJECTED')
    for (const [suffix, value] of [
      [['description'], literals.description],
      [['parameters', 'properties', 'action', 'enum'], literals.actions],
      [['parameters', 'properties', 'target', 'description'], literals.target],
      [['parameters', 'properties', 'approvedBuilds', 'description'], literals.approvedBuilds],
    ]) allowed.set([...prefix, ...suffix].join('/'), value)
  }
  let count = 0
  function walk(a, b, path = []) {
    const key = path.join('/')
    if (allowed.has(key)) {
      check(equal(b, allowed.get(key)) && !equal(a, b), 'APPROVED_LEAF_REJECTED')
      count++
      return
    }
    if (a !== null && typeof a === 'object') {
      check(b !== null && typeof b === 'object' && Array.isArray(a) === Array.isArray(b)
        && equal(Object.keys(a), Object.keys(b)), 'UNAPPROVED_SCHEMA_DELTA')
      for (const k of Object.keys(a)) walk(a[k], b[k], [...path, k])
    } else check(a === b, 'UNAPPROVED_SCHEMA_DELTA')
  }
  walk(old, now)
  check(count === (index + 1) * 4, 'LEAF_COUNT_REJECTED')
}
function report(name, verb) {
  let r
  try { r = JSON.parse(readPrivate(name).toString('utf8')) } catch { fail('REPORT_REJECTED') }
  check(r?.success === true && r.numFailedTests === 0 && r.numFailedTestSuites === 0
    && Number.isSafeInteger(r.numPassedTests) && r.numPassedTests >= 1 && Array.isArray(r.testResults), 'REPORT_REJECTED')
  const assertions = []
  for (const suite of r.testResults) {
    check(['passed', 'pending', 'skipped'].includes(suite.status) && Array.isArray(suite.assertionResults), 'REPORT_REJECTED')
    assertions.push(...suite.assertionResults)
  }
  check(assertions.every(a => ['passed', 'pending', 'skipped', 'todo'].includes(a.status)
    && (a.failureMessages === undefined || (Array.isArray(a.failureMessages) && a.failureMessages.length === 0))), 'REPORT_REJECTED')
  const passed = assertions.filter(a => a.status === 'passed')
  check(passed.length === r.numPassedTests && r.numTotalTests === assertions.length, 'REPORT_COUNTS_REJECTED')
  if (verb) {
    const titles = scenarios.map(s => `${verb}s ${s} through dsh --profile headless`)
    check(passed.length === 2 && new Set(passed.map(a => a.title)).size === 2
      && passed.every(a => titles.includes(a.title)
        && a.fullName === `headless recorded-session snapshots ${a.title}`
        && equal(a.ancestorTitles, ['headless recorded-session snapshots'])), 'REPORT_SCENARIOS_REJECTED')
    check(assertions.filter(a => titles.includes(a.title)).length === 2, 'REPORT_SCENARIOS_REJECTED')
  }
}
function validateDiff(bytes, pending) {
  const lines = bytes.toString('utf8').split('\n')
  check(lines.pop() === '', 'DIFF_REJECTED')
  let cursor = 0
  for (const item of pending) {
    const input = baseline.inputs.find(r => r.path === item.path)
    check(lines[cursor++] === `diff --git a/${item.path} b/${item.path}`
      && lines[cursor++] === `index ${input.gitBlob}..${blob(item.bytes)} 100644`
      && lines[cursor++] === `--- a/${item.path}` && lines[cursor++] === `+++ b/${item.path}`, 'DIFF_METADATA_REJECTED')
    // Parse/apply every hunk to the private baseline; this also binds raw diff text
    // to accepted bytes, rather than trusting Git config, filters, or later reads.
    const oldLines = readPrivate(`private-before/${item.path}`).toString('utf8').split('\n')
    oldLines.pop()
    const result = []
    let oldCursor = 0, hunks = 0
    while (cursor < lines.length && !lines[cursor].startsWith('diff --git ')) {
      const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@.*$/u.exec(lines[cursor++])
      check(hunk !== null, 'DIFF_METADATA_REJECTED')
      const start = Number(hunk[1]) - 1, oldCount = Number(hunk[2] ?? 1), newCount = Number(hunk[4] ?? 1)
      check(start >= oldCursor && start <= oldLines.length, 'DIFF_REJECTED')
      result.push(...oldLines.slice(oldCursor, start)); oldCursor = start
      check(Number(hunk[3]) - 1 === result.length, 'DIFF_REJECTED')
      let removed = 0, added = 0
      while (removed < oldCount || added < newCount) {
        const line = lines[cursor++]
        check(typeof line === 'string' && [' ', '+', '-'].includes(line[0]), 'DIFF_REJECTED')
        if (line[0] !== '+') { check(line.slice(1) === oldLines[oldCursor++], 'DIFF_REJECTED'); removed++ }
        if (line[0] !== '-') { result.push(line.slice(1)); added++ }
      }
      check(removed === oldCount && added === newCount, 'DIFF_REJECTED'); hunks++
    }
    result.push(...oldLines.slice(oldCursor))
    check(hunks > 0 && Buffer.from(result.join('\n') + '\n').equals(item.bytes), 'DIFF_REJECTED')
  }
  check(cursor === lines.length, 'DIFF_METADATA_REJECTED')
}
function publishInputBindings() {
  // Explicit projection: even private manifest extension fields can never leak.
  publicInputs = { schemaVersion: 1, headSha: head, scope,
    nodeVersion: process.version, platform: process.platform,
    inputs: baseline.inputs.map(r => ({ pathSha256: sha(Buffer.from(r.path)),
      gitMode: r.gitMode, gitBlob: r.gitBlob, kind: r.kind, fsMode: r.fsMode, bytes: r.bytes, sha256: r.sha256 })) }
}
function savePublic() {
  writeFileSync(join(upload, 'inputs.json'), jsonBytes(publicInputs))
  writeFileSync(join(upload, 'outputs.json'), jsonBytes({ schemaVersion: 1, headSha: /^[a-f0-9]{40}$/u.test(head ?? '') ? head : null,
    scope, outputs, fixedTargetDrift, diffSha256: sha(diff), problems: [...problems].sort() }))
  writeFileSync(join(upload, 'generated.diff'), diff)
}
try {
  const mode = process.argv[2]
  check(mode === 'before' || mode === 'after', 'MODE_REJECTED')
  check(typeof process.env.GITHUB_WORKSPACE === 'string' && isAbsolute(process.env.GITHUB_WORKSPACE), 'WORKSPACE_REJECTED')
  root = resolve(process.env.GITHUB_WORKSPACE)
  directories(root)
  check(typeof process.env.SNAPSHOT_EVIDENCE === 'string' && isAbsolute(process.env.SNAPSHOT_EVIDENCE), 'EVIDENCE_REJECTED')
  evidence = resolve(process.env.SNAPSHOT_EVIDENCE)
  check(!inside(root, evidence) && !inside(evidence, root), 'EVIDENCE_REJECTED')
  directories(evidence, true)
  const freshEvidence = readdirSync(evidence).length === 0
  upload = join(evidence, 'upload')
  // Remove any previous raw payload before doing ANY validation, including before failures.
  rmSync(upload, { recursive: true, force: true })
  mkdirSync(upload)
  savePublic()
  check(mode !== 'before' || freshEvidence, 'EVIDENCE_NOT_FRESH')
  head = process.env.EXPECTED_HEAD_SHA
  check(/^[a-f0-9]{40}$/u.test(head ?? ''), 'HEAD_REJECTED')
  phase = 'GIT_REJECTED'
  check(samePath(realpathSync(git(['rev-parse', '--show-toplevel']).toString('utf8').trim()), root), 'WORKSPACE_REJECTED')
  check(git(['rev-parse', 'HEAD']).toString('utf8').trim() === head, 'HEAD_CHANGED')
  const rows = tree()
  indexMatches(rows)
  noUntracked()
  const byPath = new Map(rows.map(r => [r.path, r]))
  // All six targets are validated BEFORE generic tracked reads or private copying.
  phase = 'TARGET_REJECTED'
  for (const path of targets) {
    check(byPath.get(path)?.gitMode === '100644', 'TARGET_MODE_REJECTED')
    regular(path)
  }
  check(byPath.has(sourcePath) && byPath.has(lockPath), 'INPUT_MISSING')
  regular(sourcePath); regular(lockPath)
  phase = 'INPUT_REJECTED'
  const current = rows.map(row => ({ ...row, ...working(row.path) }))
  for (const input of current) {
    check(input.kind === (input.gitMode === '120000' ? 'link' : 'file'), 'INPUT_TYPE_CHANGED')
    if (process.platform !== 'win32' && input.kind === 'file') {
      check(Boolean(input.fsMode & 0o111) === (input.gitMode === '100755'), 'INPUT_MODE_CHANGED')
    }
  }
  if (mode === 'before') {
    // A supposedly clean baseline must not hide changes via index skip/assume flags.
    check(git(['ls-files', '-v', '-z']).toString('utf8').split('\0').filter(Boolean).every(line => line.startsWith('H ')), 'BASELINE_INDEX_FLAGS_REJECTED')
    check(git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', head, '--']).length === 0, 'CHECKOUT_NOT_CLEAN')
    phase = 'SOURCE_REJECTED'
    literalSource()
    for (const [index, path] of outputPaths.entries()) {
      const bytes = readFileSync(regular(path))
      schemaEntries(canonical(bytes), index)
      check(blob(bytes) === byPath.get(path).gitBlob, 'BASELINE_BLOB_REJECTED')
    }
    phase = 'BASELINE_REJECTED'
    check(!existsSync(join(evidence, 'private-before')), 'BASELINE_ALREADY_EXISTS')
    mkdirSync(join(evidence, 'private-before'))
    baseline = { schemaVersion: 1, headSha: head, root, nodeVersion: process.version, platform: process.platform, inputs: current }
    for (const path of outputPaths) {
      const destination = join(evidence, 'private-before', path)
      directories(dirname(destination), true)
      // Original canonical bytes only; never manufacture expected sidecars.
      writeFileSync(destination, readFileSync(regular(path)), { flag: 'wx', mode: 0o600 })
    }
    writeFileSync(join(evidence, 'private-before', 'inputs.json'), jsonBytes(baseline), { flag: 'wx', mode: 0o600 })
  } else {
    phase = 'BASELINE_REJECTED'
    baseline = JSON.parse(readPrivate('private-before/inputs.json').toString('utf8'))
    check(baseline.schemaVersion === 1 && baseline.headSha === head && baseline.root === root && Array.isArray(baseline.inputs), 'BASELINE_REJECTED')
    check(equal(baseline.inputs.map(r => ({ path: r.path, gitMode: r.gitMode, gitBlob: r.gitBlob })), rows), 'BASELINE_TREE_REJECTED')
    check(baseline.nodeVersion === process.version && baseline.platform === process.platform, 'BASELINE_RUNTIME_CHANGED')
    for (const r of baseline.inputs) check(['file', 'link'].includes(r.kind)
      && Number.isSafeInteger(r.fsMode) && r.fsMode >= 0 && r.fsMode <= 0o777
      && Number.isSafeInteger(r.bytes) && r.bytes >= 0 && /^[a-f0-9]{64}$/u.test(r.sha256), 'BASELINE_REJECTED')
    publishInputBindings()
    fixedTargetDrift = targets.filter(path => !outputPaths.includes(path)).flatMap(path => {
      const before = baseline.inputs.find(r => r.path === path), now = current.find(r => r.path === path)
      return before.sha256 === now.sha256 ? [] : [{ path, beforeSha256: before.sha256, afterSha256: now.sha256 }]
    })
    for (let i = 0; i < current.length; i++) {
      const before = baseline.inputs[i], now = current[i]
      check(before.kind === now.kind && before.fsMode === now.fsMode, 'INPUT_MODE_OR_TYPE_CHANGED')
      if (!outputPaths.includes(now.path)) {
        check(before.sha256 === now.sha256 && before.bytes === now.bytes, now.path === lockPath ? 'LOCK_CHANGED' : targets.includes(now.path) ? 'FIXED_NONOUTPUT_CHANGED' : 'NONOUTPUT_CHANGED')
      }
    }
    phase = 'OUTCOME_REJECTED'
    check(['REFRESH_OUTCOME', 'REPLAY_OUTCOME', 'CORPUS_OUTCOME'].every(k => process.env[k] === 'success'), 'PIPELINE_OUTCOME_REJECTED')
    report('private-refresh.json', 'refresh'); report('private-replay.json', 'replay'); report('private-corpus.json')
    phase = 'SOURCE_REJECTED'
    const literals = literalSource()
    phase = 'SCHEMA_REJECTED'
    const pending = outputPaths.map((path, index) => {
      const previous = readPrivate(`private-before/${path}`)
      const bound = baseline.inputs.find(r => r.path === path)
      check(sha(previous) === bound.sha256 && blob(previous) === bound.gitBlob, 'BASELINE_BYTES_REJECTED')
      const bytes = readFileSync(regular(path))
      auditSchema(previous, bytes, index, literals)
      return { path, bytes }
    }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
    phase = 'DIFF_REJECTED'
    // Never call unrestricted diff for an empty list. Run only after ALL gates pass.
    const names = pending.map(p => p.path)
    diff = names.length === 0 ? Buffer.alloc(0) : git(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--no-relative', '--full-index', '--src-prefix=a/', '--dst-prefix=b/', '--unified=3', '--output-indicator-new=+', '--output-indicator-old=-', '--output-indicator-context= ', head, '--', ...names])
    validateDiff(diff, pending)
    // Recheck all bindings after Git, before publishing any raw bytes.
    indexMatches(rows); noUntracked()
    check(git(['rev-parse', 'HEAD']).toString('utf8').trim() === head, 'HEAD_CHANGED')
    for (const input of current) check(equal(working(input.path), { kind: input.kind, fsMode: input.fsMode, bytes: input.bytes, sha256: input.sha256 }), 'LATE_INPUT_DRIFT')
    for (const item of pending) {
      const destination = join(upload, 'generated', item.path)
      directories(dirname(destination), true)
      writeFileSync(destination, item.bytes)
      outputs.push({ path: item.path, bytes: item.bytes.length, sha256: sha(item.bytes) })
    }
  }
  // Arbitrary tracked names remain private; public records bind their name hashes.
  publishInputBindings()
  savePublic()
  console.log(mode === 'before' ? 'SNAPSHOT_BASELINE_BOUND' : 'SNAPSHOT_AUDIT_ACCEPTED')
} catch (error) {
  // Never emit error.message, stack, assertion object dumps, or rejected path names.
  // Only our literal reason codes or a fixed phase code are exposed.
  const code = error?.auditCode
  problems.add(typeof code === 'string' && /^[A-Z_]+$/u.test(code) ? code : phase)
  outputs = []; diff = Buffer.alloc(0)
  if (upload) {
    try {
      rmSync(upload, { recursive: true, force: true }); mkdirSync(upload)
      savePublic()
    } catch { problems.add('EVIDENCE_WRITE_FAILED') }
  }
  console.error('SNAPSHOT_AUDIT_REJECTED')
  process.exitCode = 1
}
