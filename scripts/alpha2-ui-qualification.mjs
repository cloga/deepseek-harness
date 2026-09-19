// Temporary nonpublishing capture; guards accidental path drift, not malicious same-UID code.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, linkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import assert from 'node:assert/strict'

const paths = [
  'apps/web/tests/expected/plugin-config/official.expected.md',
]
const goldenFiles = paths.map(path => `goldens/${path}`)
const finalFiles = ['before.json', 'qualified.json', ...goldenFiles]
const MAX_GOLDEN = 1024 * 1024
const MAX_RECEIPT = 16 * 1024
const MAX_LOCK = 16 * 1024 * 1024
function gitRun(args, options) {
  try { return execFileSync('git', args, options) } catch {
    // execFileSync errors carry captured stdout; do not dump source blobs on failure.
    throw new Error('bounded read-only Git query failed')
  }
}
const git = (...args) => gitRun(args, { encoding: 'utf8', maxBuffer: MAX_GOLDEN }).trim()
const gitBytes = (source, path, maximum) => gitRun(['show', `${source}:${path}`], { maxBuffer: maximum })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const canonical = value => Buffer.from(JSON.stringify(value, null, 2) + '\n')
const outside = (root, path) => {
  const part = relative(root, path)
  return isAbsolute(part) || part === '..' || part.startsWith('../') || part.startsWith('..\\')
}
function validateSource(expected, actual) {
  assert.match(expected, /^[0-9a-f]{40}$/)
  assert.equal(actual, expected, 'checkout must equal the explicitly reviewed source')
}
function validateChanges(changed) {
  assert.equal(new Set(changed).size, changed.length)
  assert(changed.every(path => paths.includes(path)), 'unexpected tracked source change')
}
// Inspect lexical ancestors BEFORE resolving them, including Windows junctions.
function noLinks(path) {
  assert(isAbsolute(path))
  for (let cursor = path; ; cursor = dirname(cursor)) {
    assert(!lstatSync(cursor).isSymbolicLink(), 'linked path component refused')
    if (dirname(cursor) === cursor) break
  }
}
function contained(root, path) {
  assert(!outside(root, path), 'lexical path escaped its owner')
  noLinks(path)
  assert(!outside(realpathSync(root), realpathSync(path)), 'canonical path escaped its owner')
}
function boundedRead(root, path, maximum) {
  contained(root, path)
  const stat = lstatSync(path)
  assert(stat.isFile() && stat.nlink === 1 && stat.size > 0 && stat.size < maximum, 'expected bounded, unlinked regular file')
  const bytes = readFileSync(path)
  assert(bytes.length === stat.size && bytes.length < maximum, 'file changed during read')
  return bytes
}
function observed(path, bytes) {
  return { path, bytes: bytes.length, sha256: hash(bytes) }
}
function fixedOutput(root, runnerTemp, outputArg) {
  assert(runnerTemp && isAbsolute(runnerTemp) && resolve(runnerTemp) === runnerTemp, 'expected absolute canonical-spelling RUNNER_TEMP')
  noLinks(runnerTemp)
  assert(lstatSync(runnerTemp).isDirectory())
  const output = join(runnerTemp, 'alpha2-ui-capture')
  assert(outputArg === output, 'output must be the fixed RUNNER_TEMP/alpha2-ui-capture child')
  assert(outside(root, runnerTemp) && outside(root, output), 'evidence must be outside checkout')
  assert(outside(realpathSync(root), realpathSync(runnerTemp)), 'canonical evidence parent must be outside checkout')
  return output
}
function directories(files) {
  const dirs = new Set()
  for (const file of files) {
    const segments = file.split('/')
    for (let length = 1; length < segments.length; length++) dirs.add(segments.slice(0, length).join('/'))
  }
  return [...dirs].sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
}
function inventory(root, files) {
  contained(root, root)
  assert(lstatSync(root).isDirectory())
  const dirs = directories(files)
  const all = [...dirs, ...files]
  for (const dir of ['', ...dirs]) {
    const location = join(root, dir)
    contained(root, location)
    assert(lstatSync(location).isDirectory(), 'expected owned directory')
    const expected = all.filter(path => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '') === dir)
      .map(path => path.slice(path.lastIndexOf('/') + 1)).sort()
    const actual = readdirSync(location).sort()
    assert(actual.length === expected.length && actual.every((name, index) => name === expected[index]), 'unexpected or missing capture entry')
  }
  for (const file of files) boundedRead(root, join(root, file), file.endsWith('.json') ? MAX_RECEIPT : MAX_GOLDEN)
}
function exclusiveWrite(root, file, bytes, maximum) {
  const target = join(root, file)
  contained(root, dirname(target))
  assert(bytes.length > 0 && bytes.length < maximum, 'output exceeds capture budget')
  writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 })
  const copied = boundedRead(root, target, maximum)
  assert(copied.equals(bytes) && hash(copied) === hash(bytes), 'copied bytes differ from measured output')
}
function exactKeys(value, keys) {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'expected receipt object')
  const actual = Object.keys(value)
  assert(actual.length === keys.length && keys.every(key => Object.hasOwn(value, key)), 'unexpected receipt fields')
}
function validateBefore(bytes) {
  assert(bytes.length > 0 && bytes.length < MAX_RECEIPT, 'before receipt exceeds budget')
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('invalid before receipt JSON') }
  exactKeys(value, ['source', 'tree', 'lockfileSha256', 'inputs'])
  assert(typeof value.source === 'string' && /^[0-9a-f]{40}$/.test(value.source), 'invalid source hash')
  assert(typeof value.tree === 'string' && /^[0-9a-f]{40}$/.test(value.tree), 'invalid tree hash')
  assert(typeof value.lockfileSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.lockfileSha256), 'invalid lock hash')
  assert(Array.isArray(value.inputs) && value.inputs.length === paths.length, 'invalid input inventory')
  const inputs = value.inputs.map((input, index) => {
    exactKeys(input, ['path', 'bytes', 'sha256'])
    assert(input.path === paths[index], 'unexpected input path')
    assert(Number.isSafeInteger(input.bytes) && input.bytes > 0 && input.bytes < MAX_GOLDEN, 'invalid input byte count')
    assert(typeof input.sha256 === 'string' && /^[0-9a-f]{64}$/.test(input.sha256), 'invalid input hash')
    return { path: input.path, bytes: input.bytes, sha256: input.sha256 }
  })
  const clean = { source: value.source, tree: value.tree, lockfileSha256: value.lockfileSha256, inputs }
  // Comparing bytes rejects duplicate keys, unknown fields, and noncanonical encodings without printing their contents.
  assert(canonical(clean).equals(bytes), 'before receipt is not canonical')
  return clean
}
function selfTest() {
  validateSource('a'.repeat(40), 'a'.repeat(40))
  assert.throws(() => validateSource('A'.repeat(40), 'A'.repeat(40)))
  assert.throws(() => validateSource('a'.repeat(40), 'b'.repeat(40)))
  validateChanges([])
  validateChanges(paths)
  assert.throws(() => validateChanges([paths[0], paths[0]]))
  assert.throws(() => validateChanges(['src/main.ts']))
  assert.throws(() => validateChanges(['../credentials']))
  const base = process.env.RUNNER_TEMP || tmpdir()
  noLinks(base)
  const fixture = mkdtempSync(join(base, 'alpha2-capture-selftest-'))
  try {
    const checkout = join(fixture, 'checkout')
    const runner = join(fixture, 'runner')
    mkdirSync(checkout)
    mkdirSync(runner)
    const output = fixedOutput(checkout, runner, join(runner, 'alpha2-ui-capture'))
    assert.throws(() => fixedOutput(checkout, runner, join(fixture, 'other')))
    assert.throws(() => fixedOutput(checkout, checkout, join(checkout, 'alpha2-ui-capture')))
    mkdirSync(output)
    assert.throws(() => mkdirSync(output))
    const receipt = canonical({ source: 'a'.repeat(40), tree: 'b'.repeat(40), lockfileSha256: 'c'.repeat(64),
      inputs: paths.map(path => observed(path, Buffer.from('golden\n'))) })
    validateBefore(receipt)
    assert.throws(() => validateBefore(Buffer.from('{"source":"duplicate",' + receipt.toString('utf8').slice(1))))
    assert.throws(() => validateBefore(canonical({ ...JSON.parse(receipt), unexpected: 'not-for-capture' })))
    assert.throws(() => validateBefore(Buffer.alloc(MAX_RECEIPT)))
    exclusiveWrite(output, 'before.json', receipt, MAX_RECEIPT)
    assert.throws(() => exclusiveWrite(output, 'before.json', Buffer.from('replacement'), MAX_RECEIPT))
    assert(boundedRead(output, join(output, 'before.json'), MAX_RECEIPT).equals(receipt))
    inventory(output, ['before.json'])
    mkdirSync(join(output, 'unexpected'))
    assert.throws(() => inventory(output, ['before.json']))
    rmSync(join(output, 'unexpected'), { recursive: true })
    writeFileSync(join(output, 'unexpected.txt'), 'not-for-capture', { flag: 'wx' })
    assert.throws(() => inventory(output, ['before.json']))
    rmSync(join(output, 'unexpected.txt'))
    linkSync(join(output, 'before.json'), join(fixture, 'hardlink'))
    assert.throws(() => inventory(output, ['before.json']))
    rmSync(join(fixture, 'hardlink'))
    const link = join(output, 'linked')
    symlinkSync(checkout, link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => noLinks(link))
    assert.throws(() => fixedOutput(checkout, link, join(link, 'alpha2-ui-capture')))
    assert.throws(() => inventory(output, ['before.json']))
    assert.throws(() => exclusiveWrite(output, 'linked/leak.txt', Buffer.from('blocked'), MAX_GOLDEN))
    assert.throws(() => boundedRead(output, join(checkout, 'missing'), MAX_GOLDEN))
    assert(lstatSync(link).isSymbolicLink(), 'self-test cleanup must unlink only its link')
    unlinkSync(link)
    assert(lstatSync(checkout).isDirectory(), 'link cleanup must preserve its target')
    assert.throws(() => exclusiveWrite(output, 'oversized.md', Buffer.alloc(MAX_GOLDEN), MAX_GOLDEN))
    for (const dir of directories(goldenFiles)) {
      contained(output, dirname(join(output, dir)))
      mkdirSync(join(output, dir))
    }
    for (const file of goldenFiles) exclusiveWrite(output, file, Buffer.from('golden\n'), MAX_GOLDEN)
    exclusiveWrite(output, 'qualified.json', canonical({ fullReleaseQualification: false }), MAX_RECEIPT)
    inventory(output, finalFiles)
  } finally {
    // Only the freshly allocated test fixture is removed; never the real capture or checkout.
    rmSync(fixture, { recursive: true, force: true })
  }
  console.log('Temporary capture self-tests passed; only an owned temporary fixture was written; no Git or network operation executed.')
}

const [mode, outputArg, extra] = process.argv.slice(2)
assert(extra === undefined, 'unexpected argument')
if (mode === 'self-test') {
  assert(outputArg === undefined)
  selfTest()
} else {
  assert(mode === 'before' || mode === 'after', 'expected before, after, or self-test')
  const lexicalRoot = process.cwd()
  noLinks(lexicalRoot)
  const root = realpathSync(lexicalRoot)
  const output = fixedOutput(root, process.env.RUNNER_TEMP, outputArg)
  const source = git('rev-parse', 'HEAD')
  validateSource(process.env.EXPECTED_SOURCE_SHA ?? '', source)
  const tree = git('rev-parse', 'HEAD^{tree}')
  const lockBytes = boundedRead(root, join(root, 'pnpm-lock.yaml'), MAX_LOCK)
  const headLock = gitBytes(source, 'pnpm-lock.yaml', MAX_LOCK)
  assert(lockBytes.equals(headLock), 'lockfile bytes must equal exact HEAD blob')
  const headInputs = paths.map(path => observed(path, gitBytes(source, path, MAX_GOLDEN)))
  const expectedBefore = { source, tree, lockfileSha256: hash(lockBytes), inputs: headInputs }
  if (mode === 'before') {
    assert(git('status', '--porcelain', '--untracked-files=all') === '', 'capture starts from a clean checkout')
    for (const [index, path] of paths.entries()) {
      const input = observed(path, boundedRead(root, join(root, path), MAX_GOLDEN))
      assert(input.bytes === headInputs[index].bytes && input.sha256 === headInputs[index].sha256, 'golden input differs from exact HEAD blob')
    }
    const receipt = canonical(expectedBefore)
    validateBefore(receipt)
    mkdirSync(output, { mode: 0o700 }) // Existing paths, including dangling links, fail closed.
    exclusiveWrite(output, 'before.json', receipt, MAX_RECEIPT)
    inventory(output, ['before.json'])
    console.log(`Bound source ${source} and one original golden input.`)
  } else {
    inventory(output, ['before.json'])
    const beforeBytes = boundedRead(output, join(output, 'before.json'), MAX_RECEIPT)
    const before = validateBefore(beforeBytes)
    assert(canonical(expectedBefore).equals(beforeBytes), 'before receipt differs from exact HEAD source/tree/input blobs')
    assert(git('diff', '--cached', '--name-only') === '', 'generator must not stage changes')
    const changed = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean)
    validateChanges(changed)
    assert(git('ls-files', '--others', '--exclude-standard') === '', 'no untracked source may survive qualification')
    const payloads = paths.map(path => boundedRead(root, join(root, path), MAX_GOLDEN))
    const outputs = paths.map((path, index) => observed(path, payloads[index]))
    const qualified = canonical({ schemaVersion: 1,
      purpose: 'targeted-tests-and-browser-golden-refresh', source, tree,
      node: process.version, lockfileSha256: before.lockfileSha256,
      inputs: before.inputs, outputs, changed,
      prerequisitesDeclaredByWorkflow: ['frozen-install', 'build', 'targeted-tests', 'typed-lint', 'browser-refresh', 'browser-replay'],
      workflowSuccessMustBeIndependentlyChecked: true,
      fullReleaseQualification: false, desktopInstallationExecuted: false,
    })
    for (const dir of directories(goldenFiles)) {
      contained(output, dirname(join(output, dir)))
      mkdirSync(join(output, dir), { mode: 0o700 })
    }
    for (const [index, file] of goldenFiles.entries()) exclusiveWrite(output, file, payloads[index], MAX_GOLDEN)
    exclusiveWrite(output, 'qualified.json', qualified, MAX_RECEIPT)
    inventory(output, finalFiles)
    console.log('Captured exactly one measured golden output and two bounded receipts; independent workflow and adoption audit still required.')
  }
}
