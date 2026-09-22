/** Capture reviewed alpha2 generator changes as internal bytes; never import, publish or qualify a product. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const BRANCH = 'refs/heads/cloga-official-first-016a2'
const MAX_FILES = 50_000
const MAX_FILE_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 2 * 1024 * 1024 * 1024
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const subsystemPages = `agent-team approval attachment boot browser-use client-modules commands compaction computer-use core credentials
 deliverables extensions feedback filesystem goal invariants jobs llm-streaming lsp mcp office-to-pdf permission-presets persistence plan
 ptc-runtime sandbox session session-projection session-query session-reference session-telemetry session-title settings shell skills spill ssh storage
 subagent subprocess system-prompt terminal token-meter tools typert user-questions web web-server webhook workflow workspace`.trim().split(/\s+/u)
/** Exact maintained generator tasks, without the gen-cordis-api compatibility alias. */
export const GENERATORS = Object.freeze([
  'gen-cordis-catalog', 'gen-cordis-inspect-catalog', 'gen-client-catalog', 'gen-doc-graphs', 'gen-third-party-notices',
])
/** Owning freshness checks; successful workflow execution is required before final capture. */
export const CHECKS = Object.freeze(GENERATORS.map(name => name.replace(/^gen-/u, 'verify-')))
/** Exact EN graph outputs; their paired translations remain a separate human review requirement. */
export const EN_GRAPHS = Object.freeze([
  'docs/graph-atlas.md', 'docs/capability-seams.md', 'apps/cli/composition.md', 'docs/event-producer-consumer.md',
  'docs/agent-lifecycle.md', 'docs/tool-execution-pipeline.md',
])
/** Static destination roster from the five maintained generator owners, not a directory-wide allowlist. */
export const OUTPUT_PATHS = Object.freeze([
  'packages/extensions/tool-cordis/src/api-catalog.ts',
  'packages/extensions/cordis-client-runner/src/client/api-catalog.ts',
  'packages/extensions/cordis-client-runner/src/client/slot-catalog.ts',
  ...['context', 'events', 'fiber', 'registry', 'service', 'inherited'].map(name => `docs/cordis-api/${name}.md`),
  ...subsystemPages.flatMap(name => ['md', 'zh.md', 'i18n.yaml'].map(extension => `docs/subsystems/${name}.${extension}`)),
  ...EN_GRAPHS, 'THIRD_PARTY_NOTICES.md',
])
const outputPaths = new Set(OUTPUT_PATHS)
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')

/** @param path - Git-relative path. @returns Unchanged confined portable path, or throws. */
export function safePath(path) {
  assert(typeof path === 'string' && path.length > 0 && path.length <= 512 && !/[\\:\u0000-\u001f\u007f]/u.test(path), 'Unsafe path')
  assert(!path.startsWith('/') && path.split('/').every(part => part !== '' && part !== '.' && part !== '..'
    && !/[. ]$/u.test(part) && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part)), 'Unsafe path')
  assert(!path.split('/').some(part => part.toLowerCase() === '.git' || part.toLowerCase() === 'node_modules'), 'Excluded path')
  return path
}

/** @param root - Checkout root. @param path - Tracked link path. @param text - Link text, never target bytes. @returns Confined target path. */
export function trackedLinkTarget(root, path, text) {
  safePath(path)
  assert(typeof text === 'string' && text.length > 0 && text.length <= 512
    && !isAbsolute(text) && !/[:\u0000-\u001f\u007f]/u.test(text), 'Absolute or invalid tracked link')
  const target = resolve(root, dirname(path), text)
  safePath(relative(root, target).split(sep).join('/'))
  return target
}

/** @param path - Git-relative output. @returns Whether a maintained generator owns this exact destination. */
export function isAllowedOutput(path) { return outputPaths.has(safePath(path)) }

/** @param observed - Actual checkout/tool facts. @param environment - Workflow identity. @param expected - Reviewed commit. @returns Bound leaves. */
export function bindSource(observed, environment, expected) {
  assert(typeof expected === 'string' && /^[a-f0-9]{40}$/u.test(expected) && expected.length === 40, 'Invalid expected source')
  for (const value of [observed.head, observed.tree]) assert(typeof value === 'string' && value.length === 40 && /^[a-f0-9]{40}$/u.test(value))
  assert.equal(observed.head, expected, 'Checkout source mismatch')
  assert.equal(environment.GITHUB_SHA, expected, 'Workflow source mismatch')
  assert.equal(environment.GITHUB_REPOSITORY, 'cloga/deepseek-harness')
  assert.equal(environment.GITHUB_REF, BRANCH)
  assert.equal(environment.GITHUB_ACTIONS, 'true')
  assert.equal(environment.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(environment.RUNNER_OS, 'Windows')
  assert(['push', 'workflow_dispatch'].includes(environment.GITHUB_EVENT_NAME))
  assert.equal(observed.node, 'v24.13.0')
  assert.equal(observed.pnpm, '11.7.0')
  assert.equal(observed.platform, 'win32')
  assert.equal(observed.arch, 'x64')
  for (const key of ['GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT']) {
    assert(typeof environment[key] === 'string' && environment[key].length <= 20
      && environment[key].trim() === environment[key] && /^[1-9][0-9]*$/u.test(environment[key]))
  }
  return { repository: environment.GITHUB_REPOSITORY, sourceCommit: observed.head, sourceTree: observed.tree,
    sourceRef: BRANCH, event: environment.GITHUB_EVENT_NAME, runId: environment.GITHUB_RUN_ID,
    runAttempt: environment.GITHUB_RUN_ATTEMPT, platform: observed.platform, arch: observed.arch,
    runnerImage: 'windows-2025', nodeVersion: observed.node, pnpmVersion: observed.pnpm }
}

/** @param before - Original tracked raw-byte inventory. @param after - Current inventory. @returns Only approved modified files; no additions/deletions. */
export function changedOutputs(before, after) {
  assert(Array.isArray(before) && before.length > 0 && before.length <= MAX_FILES)
  assert(Array.isArray(after) && after.length === before.length, 'Tracked paths changed')
  const changed = []
  for (let index = 0; index < before.length; index++) {
    const a = before[index], b = after[index]
    for (const item of [a, b]) {
      safePath(item.path)
      assert.deepEqual(Object.keys(item).sort(), ['bytes', 'kind', 'mode', 'path', 'sha256'])
      assert(['100644', '100755', '120000'].includes(item.mode) && ['file', 'link'].includes(item.kind), 'Invalid tracked entry')
      assert(Number.isSafeInteger(item.bytes) && item.bytes >= 0 && item.bytes <= MAX_FILE_BYTES)
      assert(typeof item.sha256 === 'string' && item.sha256.length === 64 && /^[a-f0-9]{64}$/u.test(item.sha256))
    }
    assert(index === 0 || before[index - 1].path < a.path, 'Duplicate or unsorted input')
    assert.equal(a.path, b.path, 'Tracked paths changed')
    assert.equal(a.mode, b.mode, 'Tracked mode changed')
    assert.equal(a.kind, b.kind, 'File kind changed')
    if (a.sha256 === b.sha256 && a.bytes === b.bytes) continue
    assert(isAllowedOutput(a.path) && b.kind === 'file' && b.mode !== '120000', `Unexpected source change: ${a.path}`)
    changed.push({ path: a.path, before: { bytes: a.bytes, sha256: a.sha256 }, after: { bytes: b.bytes, sha256: b.sha256 } })
  }
  return changed
}

/** @param expected - Previously sealed inventory. @param current - Fresh observation. Rejects even allowlisted late byte changes. */
export function assertStable(expected, current) { assert.deepEqual(current, expected, 'Source changed after observation') }

function git(root, args) {
  return execFileSync('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
}
function tracked(root) {
  assert.equal(git(root, ['diff', '--cached', '--name-only', '-z', 'HEAD', '--']), '', 'Index changed')
  assert.equal(git(root, ['ls-files', '--others', '--exclude-standard', '-z']), '', 'Untracked files are not capture outputs')
  const entries = git(root, ['ls-files', '--stage', '-z']).split('\0').filter(Boolean).map((entry) => {
    const match = /^(100644|100755|120000) [a-f0-9]{40} 0\t(.+)$/u.exec(entry)
    assert(match, 'Unmerged/submodule/nonordinary index entry')
    return { path: safePath(match[2]), mode: match[1] }
  }).sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
  assert(entries.length > 0 && entries.length <= MAX_FILES)
  let total = 0
  return entries.map(({ path, mode }) => {
    const absolute = join(root, path)
    for (let parent = dirname(absolute); parent !== root; parent = dirname(parent)) {
      assert(lstatSync(parent).isDirectory() && !lstatSync(parent).isSymbolicLink(), 'Redirected tracked ancestor')
    }
    const stat = lstatSync(absolute)
    assert(stat.isFile() || stat.isSymbolicLink(), 'Tracked file disappeared or changed kind')
    assert(stat.size <= MAX_FILE_BYTES, 'Tracked file too large')
    const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute), 'utf8') : readFileSync(absolute)
    if (mode === '120000') {
      // Windows may check a Git link out as a plain file containing its link text. Neither representation is dereferenced.
      const target = trackedLinkTarget(root, path, bytes.toString('utf8'))
      safePath(relative(root, realpathSync(target)).split(sep).join('/'))
    } else assert(!stat.isSymbolicLink(), 'Regular tracked file became a link')
    total += bytes.length
    assert(total <= MAX_TOTAL_BYTES, 'Tracked inventory exceeds bound')
    return { path, mode, kind: stat.isSymbolicLink() ? 'link' : 'file', bytes: bytes.length, sha256: sha256(bytes) }
  })
}
function observed(root, pnpm) {
  return { head: git(root, ['rev-parse', 'HEAD']).trim(), tree: git(root, ['rev-parse', 'HEAD^{tree}']).trim(),
    node: process.version, pnpm, platform: process.platform, arch: process.arch }
}
function exclusiveJson(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
function regularBytes(root, path) {
  const absolute = join(root, safePath(path))
  for (let parent = dirname(absolute); ; parent = dirname(parent)) {
    const entry = lstatSync(parent)
    assert(entry.isDirectory() && !entry.isSymbolicLink(), 'Redirected output ancestor')
    if (parent === root) break
  }
  const stat = lstatSync(absolute)
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= MAX_FILE_BYTES, 'Invalid generated output')
  const bytes = readFileSync(absolute)
  assert.equal(bytes.length, stat.size, 'Output size changed during read')
  return bytes
}

/** @param root - Private artifact directory. @param expected - Exact owned relative file list. Rejects links and extra payloads. */
export function assertArtifactFiles(root, expected) {
  const actual = []
  let visited = 0
  const walk = (directory, prefix) => {
    const stat = lstatSync(directory)
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Redirected artifact directory')
    for (const name of readdirSync(directory)) {
      assert(++visited <= 4096, 'Artifact entry bound exceeded')
      const path = prefix + name
      safePath(path)
      const absolute = join(directory, name), entry = lstatSync(absolute)
      assert(!entry.isSymbolicLink(), 'Artifact link forbidden')
      if (entry.isDirectory()) walk(absolute, path + '/')
      else { assert(entry.isFile() && entry.size <= MAX_OUTPUT_BYTES); actual.push(path) }
    }
  }
  walk(root, '')
  assert.deepEqual(actual.sort(), [...expected].sort(), 'Unexpected artifact payload')
}
function ownedRoot(root, output, temporary) {
  assert(isAbsolute(output) && isAbsolute(temporary), 'Absolute runner-owned output required')
  const temp = realpathSync(temporary), destination = resolve(output)
  const tail = relative(temp, destination)
  assert(tail !== '' && tail !== '..' && !tail.startsWith(`..${sep}`) && !isAbsolute(tail), 'Output must be inside runner temp')
  const workspaceTail = relative(root, destination)
  assert(workspaceTail.startsWith(`..${sep}`) || workspaceTail === '..' || isAbsolute(workspaceTail), 'Output must be outside checkout')
  // The workflow selects one direct child; no preexisting ancestor under runner temp is followed.
  assert.equal(dirname(destination), temp, 'Output must be a direct runner-temp child')
  return destination
}

function main() {
  const { values } = parseArgs({ options: { phase: { type: 'string' }, 'expected-source': { type: 'string' },
    output: { type: 'string' }, 'pnpm-version': { type: 'string' } }, allowPositionals: false })
  assert(['begin', 'baseline', 'capture', 'verify'].includes(values.phase), 'Invalid capture phase')
  const root = realpathSync(resolve(fileURLToPath(new URL('..', import.meta.url))))
  const output = ownedRoot(root, values.output, process.env.RUNNER_TEMP)
  const identity = bindSource(observed(root, values['pnpm-version']), process.env, values['expected-source'])
  const current = tracked(root)
  const statePath = join(output, 'state.json')
  if (values.phase === 'begin') {
    assert.equal(git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']), '', 'Fresh clean checkout required')
    assert(!existsSync(output), 'Capture root already exists')
    mkdirSync(output, { mode: 0o700 })
    const originals = {}
    let bytes = 0
    for (const item of current.filter(item => isAllowedOutput(item.path))) {
      assert(item.kind === 'file' && item.mode !== '120000', 'Generated outputs cannot be links')
      const content = regularBytes(root, item.path)
      bytes += content.length
      assert(bytes <= MAX_OUTPUT_BYTES, 'Original generated bytes exceed bound')
      assert.equal(sha256(content), item.sha256)
      originals[item.path] = content.toString('base64')
    }
    assert(current.some(item => item.path === 'pnpm-lock.yaml'), 'Missing frozen lock')
    assertStable(current, tracked(root))
    exclusiveJson(statePath, { schemaVersion: 1, identity, inputs: current, originals })
    return
  }
  assert(lstatSync(output).isDirectory() && !lstatSync(output).isSymbolicLink(), 'Redirected capture root')
  const stateStat = lstatSync(statePath)
  assert(stateStat.isFile() && !stateStat.isSymbolicLink() && stateStat.size <= 128 * 1024 * 1024, 'Invalid capture state')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  assert.equal(state.schemaVersion, 1)
  assert.deepEqual(identity, state.identity, 'Capture invocation changed')
  if (values.phase === 'baseline') { assertStable(state.inputs, current); return }
  const changes = changedOutputs(state.inputs, current)
  const artifact = join(output, 'artifact')
  if (values.phase === 'verify') {
    assertArtifactFiles(artifact, ['index.json', 'inputs.json', ...changes.flatMap(change => ['before/', 'after/'].map(side => side + change.path))])
    const index = JSON.parse(readFileSync(join(artifact, 'index.json'), 'utf8'))
    const inputs = readFileSync(join(artifact, 'inputs.json'))
    assert.equal(index.schemaVersion, 1)
    assert.equal(index.kind, 'alpha2-source-catalog-capture')
    assert.equal(index.inputInventory.bytes, inputs.length)
    assert.equal(index.inputInventory.sha256, sha256(inputs))
    assert.deepEqual(JSON.parse(inputs.toString('utf8')), state.inputs)
    assert.deepEqual(index.identity, identity)
    assert.deepEqual(index.changes, changes)
    assert.equal(index.afterInventorySha256, sha256(JSON.stringify(current)))
    for (const change of changes) {
      for (const side of ['before', 'after']) {
        const bytes = regularBytes(artifact, `${side}/${change.path}`)
        assert.equal(bytes.length, change[side].bytes)
        assert.equal(sha256(bytes), change[side].sha256)
      }
    }
    assertStable(current, tracked(root))
    assert.deepEqual(bindSource(observed(root, values['pnpm-version']), process.env, values['expected-source']), identity)
    return
  }
  assert(!existsSync(artifact), 'Artifact already exists')
  mkdirSync(artifact, { mode: 0o700 })
  let captured = 0
  for (const change of changes) {
    const before = Buffer.from(state.originals[change.path], 'base64')
    const after = regularBytes(root, change.path)
    for (const [side, bytes] of [['before', before], ['after', after]]) {
      captured += bytes.length
      assert(captured <= MAX_OUTPUT_BYTES, 'Captured changes exceed bound')
      assert.equal(bytes.length, change[side].bytes)
      assert.equal(sha256(bytes), change[side].sha256, 'Output changed during capture')
      const destination = join(artifact, side, change.path)
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 })
      writeFileSync(destination, bytes, { flag: 'wx', mode: 0o600 })
    }
  }
  exclusiveJson(join(artifact, 'inputs.json'), state.inputs)
  assertStable(current, tracked(root))
  assert.deepEqual(bindSource(observed(root, values['pnpm-version']), process.env, values['expected-source']), identity)
  exclusiveJson(join(artifact, 'index.json'), { schemaVersion: 1, kind: 'alpha2-source-catalog-capture',
    qualification: 'internal-generation-only-not-release-qualification', identity,
    rawLockSha256: state.inputs.find(item => item.path === 'pnpm-lock.yaml').sha256,
    inputInventory: { file: 'inputs.json', bytes: lstatSync(join(artifact, 'inputs.json')).size,
      sha256: sha256(readFileSync(join(artifact, 'inputs.json'))), scope: 'tracked-raw-byte-hashes-only-generator-input-superset' },
    afterInventorySha256: sha256(JSON.stringify(current)), generators: GENERATORS, freshnessChecks: CHECKS,
    checksEvidence: 'owning-workflow-success-precondition-not-product-acceptance', changes,
    pairedTranslationReviewRequired: changes.filter(item => EN_GRAPHS.includes(item.path)).map(item => item.path),
    autoImport: false, publication: false, applicationActivation: false })
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main()
