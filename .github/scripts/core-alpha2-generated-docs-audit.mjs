/** TEMPORARY source/output audit; no rejected file bytes enter its upload directory. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

const mode = process.argv[2]
assert.ok(mode === 'before' || mode === 'after', 'Expected before or after audit mode')
const root = realpathSync(resolve(process.env.GITHUB_WORKSPACE ?? '.'))
const evidence = process.env.DOCS_EVIDENCE
assert.ok(evidence && isAbsolute(evidence), 'An owned evidence directory is required')
const head = process.env.EXPECTED_HEAD_SHA
assert.match(head ?? '', /^[a-f0-9]{40}$/u)
const git = args => execFileSync('git', args, { cwd: root, maxBuffer: 64 * 1024 * 1024 })
const sha = bytes => createHash('sha256').update(bytes).digest('hex')
const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
const upload = join(evidence, 'upload')
const privateBefore = join(evidence, 'private-before')
const fixed = new Set([
  'packages/extensions/tool-cordis/src/api-catalog.ts',
  'docs/capability-seams.md', 'apps/cli/composition.md', 'docs/event-producer-consumer.md',
  'docs/agent-lifecycle.md', 'docs/tool-execution-pipeline.md', 'docs/graph-atlas.md',
])
const subsystemPage = path => /^docs\/subsystems\/[a-z0-9-]+(?:\.zh)?\.md$/u.test(path)
const subsystemPair = path => /^docs\/subsystems\/[a-z0-9-]+\.i18n\.yaml$/u.test(path)
function allowed(path) {
  return fixed.has(path) || subsystemPage(path)
    || /^docs\/cordis-api\/(?:inherited|context|events|fiber|registry|service)\.md$/u.test(path)
}
function safe(path) {
  assert.ok(!isAbsolute(path) && !path.includes('\\') && !path.split('/').includes('..') && !/[\0\r\n]/u.test(path), 'Unsafe tracked path')
  return join(root, path)
}
function ownedRegular(path) {
  const absolute = safe(path)
  const stat = lstatSync(absolute)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('OUTPUT_NOT_REGULAR')
  const canonical = realpathSync(absolute)
  const suffix = relative(root, canonical)
  const same = process.platform === 'win32' ? canonical.toLowerCase() === absolute.toLowerCase() : canonical === absolute
  if (!same || suffix === '..' || isAbsolute(suffix) || suffix.startsWith(`..${sep}`)) throw new Error('OUTPUT_NOT_OWNED')
  return absolute
}
function working(path) {
  const absolute = safe(path)
  const stat = lstatSync(absolute)
  assert.ok(stat.isFile() || stat.isSymbolicLink(), 'Tracked input is not a file or link')
  const bytes = stat.isSymbolicLink() ? Buffer.from(readlinkSync(absolute)) : readFileSync(absolute)
  return { kind: stat.isSymbolicLink() ? 'link' : 'file', bytes: bytes.length, sha256: sha(bytes) }
}
function stripRegions(text) {
  const result = []
  let region = false
  let count = 0
  for (const line of text.split('\n')) {
    if (/^<!-- BEGIN GENERATED cordis-surface .*-->$/u.test(line)) {
      if (region) throw new Error('REGION_INVALID')
      region = true
      count++
      result.push(line)
    } else if (/^<!-- END GENERATED cordis-surface .*-->$/u.test(line)) {
      if (!region) throw new Error('REGION_INVALID')
      region = false
      result.push(line)
    } else if (!region) result.push(line)
  }
  if (region || count !== 1) throw new Error('REGION_INVALID')
  return result.join('\n')
}
assert.equal(git(['rev-parse', 'HEAD']).toString().trim(), head, 'Checkout head changed')
mkdirSync(upload, { recursive: true })
if (mode === 'before') {
  assert.equal(git(['status', '--porcelain']).length, 0, 'Generation requires a clean checkout')
  const tree = git(['ls-tree', '-r', '-z', head]).toString('utf8').split('\0').filter(Boolean)
  const inputs = tree.map(line => {
    const match = /^(\d+) blob ([a-f0-9]{40})\t(.+)$/u.exec(line)
    assert.ok(match, 'Only tracked blob inputs are accepted')
    const path = match[3]
    const source = allowed(path) || subsystemPair(path) ? ownedRegular(path) : undefined
    const current = working(path)
    if (source !== undefined) {
      // Before snapshots stay private and are never included in the upload list.
      if (subsystemPage(path) || subsystemPair(path)) {
        const destination = join(privateBefore, path)
        mkdirSync(dirname(destination), { recursive: true })
        copyFileSync(source, destination)
      }
    }
    return { path, gitMode: match[1], gitBlob: match[2], ...current }
  })
  writeJson(join(upload, 'inputs.json'), {
    schemaVersion: 1, headSha: head, tree: git(['rev-parse', 'HEAD^{tree}']).toString().trim(),
    nodeVersion: process.version,
    pnpmVersion: execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' }).trim(),
    lockSha256: sha(readFileSync(join(root, 'pnpm-lock.yaml'))), inputs,
    commands: ['pnpm install --frozen-lockfile', 'pnpm run gen-cordis-catalog', 'pnpm run gen-doc-graphs', 'pnpm run verify-cordis-catalog', 'pnpm run verify-doc-graphs'],
  })
  console.log(`Bound ${inputs.length} tracked inputs to ${head}`)
} else {
  const before = readJson(join(upload, 'inputs.json'))
  assert.equal(before.headSha, head)
  const changed = git(['diff', '--no-ext-diff', '--no-renames', '--name-only', '-z']).toString('utf8').split('\0').filter(Boolean)
  const staged = git(['diff', '--cached', '--name-only', '-z']).toString('utf8').split('\0').filter(Boolean)
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).toString('utf8').split('\0').filter(Boolean)
  const tracked = new Set(before.inputs.map(input => input.path))
  const problems = new Set()
  if (staged.length) problems.add('INDEX_CHANGED')
  if (untracked.length) problems.add('UNTRACKED_OUTPUT')
  const changedSet = new Set(changed)
  const candidates = changed.filter(path => allowed(path) && tracked.has(path))
  const deferredPairs = changed.filter(path => subsystemPair(path) && tracked.has(path))
  const acceptedNames = new Set(candidates)
  for (const path of changed) {
    if (!acceptedNames.has(path) && !deferredPairs.includes(path)) problems.add('NON_OUTPUT_CHANGED')
  }
  for (const input of before.inputs) {
    try {
      const now = working(input.path)
      if (!changedSet.has(input.path) && (now.kind !== input.kind || now.sha256 !== input.sha256)) problems.add('UNREPORTED_INPUT_DRIFT')
    } catch { problems.add('TRACKED_INPUT_MISSING') }
  }
  // Sidecars are deliberately NOT copied or diffed. Their normal pairing must be rerun after artifact review.
  for (const path of deferredPairs) {
    const english = path.replace(/\.i18n\.yaml$/u, '.md')
    const chinese = path.replace(/\.i18n\.yaml$/u, '.zh.md')
    if (!tracked.has(english) || !tracked.has(chinese) || (!acceptedNames.has(english) && !acceptedNames.has(chinese))) {
      problems.add('UNRELATED_PAIRING_CHANGE')
    }
    try {
      const current = readFileSync(ownedRegular(path), 'utf8')
      const previous = readFileSync(join(privateBefore, path), 'utf8')
      const names = [basename(english), basename(chinese)]
      const parts = previous.split('\n')
      const records = parts.flatMap(line => {
        if (line === '' || line.startsWith('#')) return []
        const match = /^([^:#]+\.md): ([a-f0-9]{40})$/u.exec(line)
        if (match === null) throw new Error('PAIRING_INVALID')
        return [match[1]]
      })
      if (records.length !== 2 || new Set(records).size !== 2 || names.some(name => !records.includes(name))) {
        throw new Error('PAIRING_INVALID')
      }
      const hashes = new Map([english, chinese].map(page => {
        const bytes = readFileSync(ownedRegular(page))
        return [basename(page), createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')]
      }))
      const expected = parts.map(line => {
        const match = /^([^:#]+\.md): [a-f0-9]{40}$/u.exec(line)
        return match === null ? line : `${match[1]}: ${hashes.get(match[1])}`
      }).join('\n')
      if (current !== expected) throw new Error('PAIRING_INVALID')
    } catch { problems.add('PAIRING_NOT_EXACT_OR_OWNED') }
  }
  const pending = []
  for (const path of candidates) {
    try {
      const bytes = readFileSync(ownedRegular(path))
      if (subsystemPage(path)) {
        const previous = readFileSync(join(privateBefore, path), 'utf8')
        if (stripRegions(bytes.toString('utf8')) !== stripRegions(previous)) throw new Error('PROSE_CHANGED')
      }
      pending.push({ path, bytes })
    } catch { problems.add('OUTPUT_REGION_OR_OWNERSHIP_REJECTED') }
  }
  const outcome = process.env.GENERATION_OUTCOME ?? 'unknown'
  const checks = process.env.CHECKS_OUTCOME ?? 'unknown'
  if (outcome !== 'success' || checks !== 'success') problems.add('GENERATION_OR_CHECK_FAILED')
  const lockSha256 = sha(readFileSync(join(root, 'pnpm-lock.yaml')))
  if (lockSha256 !== before.lockSha256) problems.add('LOCK_CHANGED')
  const outputs = []
  let diff = Buffer.alloc(0)
  // Whole-audit fail closed: never retain partial raw payloads if any guard failed.
  if (problems.size === 0) {
    const paths = pending.map(item => item.path).sort()
    if (paths.length > 0) diff = git(['diff', '--no-ext-diff', '--no-renames', '--binary', '--', ...paths])
    for (const { path, bytes } of pending) {
      const destination = join(upload, 'generated', path)
      mkdirSync(dirname(destination), { recursive: true })
      writeFileSync(destination, bytes)
      outputs.push({ path, bytes: bytes.length, sha256: sha(bytes) })
    }
  }
  writeFileSync(join(upload, 'generated.diff'), diff)
  writeJson(join(upload, 'outputs.json'), {
    schemaVersion: 1, headSha: head, generationOutcome: outcome, checksOutcome: checks,
    lockSha256, changedPathCount: changed.length, untrackedPathCount: untracked.length, stagedPathCount: staged.length,
    deferredPairingPaths: problems.size === 0 ? deferredPairs : [],
    outputs, diffSha256: sha(diff), problems: [...problems].sort(),
    qualification: 'Validated official generated bytes only; sidecars deferred to normal pairing; not complete CI or runtime qualification',
  })
  if (problems.size) { console.error('Generated output audit rejected; raw outputs and diff withheld'); process.exitCode = 1 }
  else console.log(`Audited ${outputs.length} generated outputs; pairing sidecars withheld`)
}
