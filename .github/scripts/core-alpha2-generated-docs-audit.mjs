/** TEMPORARY read-only-source audit for official generator output; remove with its workflow. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'

const mode = process.argv[2]
assert.ok(mode === 'before' || mode === 'after', 'Expected before or after audit mode')
const root = resolve(process.env.GITHUB_WORKSPACE ?? '.')
const evidence = process.env.DOCS_EVIDENCE
assert.ok(evidence && isAbsolute(evidence), 'An owned evidence directory is required')
const head = process.env.EXPECTED_HEAD_SHA
assert.match(head ?? '', /^[a-f0-9]{40}$/u)
const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const fixed = new Set([
  'packages/extensions/tool-cordis/src/api-catalog.ts',
  'docs/capability-seams.md', 'apps/cli/composition.md', 'docs/event-producer-consumer.md',
  'docs/agent-lifecycle.md', 'docs/tool-execution-pipeline.md', 'docs/graph-atlas.md',
])
function allowed(path) {
  return fixed.has(path)
    || /^docs\/cordis-api\/(?:inherited|context|events|fiber|registry|service)\.md$/u.test(path)
    || /^docs\/subsystems\/[a-z0-9-]+(?:\.zh\.md|\.md|\.i18n\.yaml)$/u.test(path)
}
function safe(path) {
  assert.ok(!isAbsolute(path) && !path.includes('\\') && !path.split('/').includes('..') && !/[\0\r\n]/u.test(path), 'Unsafe tracked path')
  return join(root, path)
}
function working(path) {
  const absolute = safe(path)
  const stat = lstatSync(absolute)
  assert.ok(stat.isFile() || stat.isSymbolicLink(), 'Tracked input is not a file or link')
  const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute)
  return { kind: stat.isSymbolicLink() ? 'link' : 'file', bytes: bytes.length, sha256: sha(bytes) }
}
function stripRegions(text) {
  const lines = text.split('\n')
  const result = []
  let region = false
  let count = 0
  for (const line of lines) {
    if (/^<!-- BEGIN GENERATED cordis-surface .*-->$/u.test(line)) {
      assert.equal(region, false, 'Nested generated regions')
      region = true
      count++
      result.push(line)
    } else if (/^<!-- END GENERATED cordis-surface .*-->$/u.test(line)) {
      assert.equal(region, true, 'Unmatched generated region end')
      region = false
      result.push(line)
    } else if (!region) result.push(line)
  }
  assert.equal(region, false, 'Unclosed generated region')
  assert.equal(count, 1, 'Expected one existing Cordis generated region')
  return result.join('\n')
}
assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), head, 'Checkout head changed')
if (mode === 'before') {
  assert.equal(git(['status', '--porcelain']).length, 0, 'Generation requires a clean checkout')
  const tree = git(['ls-tree', '-r', '-z', head]).toString('utf8').split('\0').filter(Boolean)
  const inputs = tree.map(line => {
    const match = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/u.exec(line)
    assert.ok(match, 'Only tracked blob inputs are accepted')
    const path = match[3]
    const current = working(path)
    if (allowed(path)) {
      const destination = join(evidence, 'before', path)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(safe(path), destination)
    }
    return { path, gitMode: match[1], gitBlob: match[2], ...current }
  })
  writeJson(join(evidence, 'inputs.json'), {
    schemaVersion: 1, headSha: head, tree: git(['rev-parse', 'HEAD^{tree}']).toString().trim(),
    nodeVersion: process.version, pnpmVersion: execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' }).trim(),
    lockSha256: sha(readFileSync(join(root, 'pnpm-lock.yaml'))), inputs,
    commands: ['pnpm install --frozen-lockfile', 'pnpm run gen-cordis-catalog', 'pnpm run gen-doc-graphs', 'pnpm run verify-cordis-catalog', 'pnpm run verify-doc-graphs'],
  })
  console.log(`Bound ${inputs.length} tracked inputs to ${head}`)
} else {
  const before = readJson(join(evidence, 'inputs.json'))
  assert.equal(before.headSha, head)
  const changed = git(['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z']).toString('utf8').split('\0').filter(Boolean)
  const staged = git(['diff', '--cached', '--name-only', '-z']).toString('utf8').split('\0').filter(Boolean)
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean)
  const unexpected = [...new Set([...changed, ...untracked])].filter(path => !allowed(path))
  const problems = []
  if (staged.length) problems.push('Generator changed the index')
  if (unexpected.length) problems.push('Generator changed paths outside its declared outputs')
  const changedSet = new Set(changed)
  for (const input of before.inputs) {
    try {
      const now = working(input.path)
      if (!changedSet.has(input.path) && (now.kind !== input.kind || now.sha256 !== input.sha256)) problems.push(`Unreported input drift: ${input.path}`)
    } catch { problems.push(`Tracked input disappeared: ${input.path}`) }
  }
  const outputs = []
  for (const path of [...new Set([...changed, ...untracked])].sort()) {
    if (!allowed(path)) continue
    const absolute = safe(path)
    try {
      const stat = lstatSync(absolute)
      assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'Output must be regular')
      const bytes = readFileSync(absolute)
      if (/^docs\/subsystems\/.+\.md$/u.test(path)) {
        const previous = readFileSync(join(evidence, 'before', path), 'utf8')
        assert.equal(stripRegions(bytes.toString('utf8')), stripRegions(previous), 'Generator changed ordinary prose or markers')
      }
      const destination = join(evidence, 'generated', path)
      mkdirSync(dirname(destination), { recursive: true })
      copyFileSync(absolute, destination)
      outputs.push({ path, bytes: bytes.length, sha256: sha(bytes) })
    } catch (error) { problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  const diff = git(['diff', '--no-ext-diff', '--no-renames', '--binary'])
  writeFileSync(join(evidence, 'generated.diff'), diff)
  const outcome = process.env.GENERATION_OUTCOME ?? 'unknown'
  const checks = process.env.CHECKS_OUTCOME ?? 'unknown'
  if (outcome !== 'success' || checks !== 'success') problems.push('Generation or official freshness checks did not succeed')
  const lockSha256 = sha(readFileSync(join(root, 'pnpm-lock.yaml')))
  if (lockSha256 !== before.lockSha256) problems.push('Lockfile changed')
  writeJson(join(evidence, 'outputs.json'), {
    schemaVersion: 1, headSha: head, generationOutcome: outcome, checksOutcome: checks,
    lockSha256, changedPaths: changed, untrackedPaths: untracked, stagedPaths: staged,
    unexpectedPaths: unexpected, outputs, diffSha256: sha(diff), problems,
    qualification: 'Official generated bytes only; not build, complete CI, release or runtime qualification',
  })
  assert.deepEqual(problems, [], 'Generated output audit failed; evidence retained')
  console.log(`Audited ${outputs.length} generated outputs; all other tracked bytes unchanged`)
}
