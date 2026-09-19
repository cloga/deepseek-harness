// Temporary nonpublishing capture. Path guards address accidental drift, not malicious same-UID code.
// Transport controls do not generate a catalog, run a browser, or qualify the current business source.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, linkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import assert from 'node:assert/strict'

const paths = [
  'packages/extensions/cordis-client-runner/src/client/api-catalog.ts',
  'apps/web/tests/expected/agent-preset-authoring/section.expected.md',
  'apps/web/tests/expected/agent-preset-authoring/created.expected.md',
  'apps/web/tests/expected/agent-preset-authoring/damaged.expected.md',
]
const preservedPaths = ['apps/web/tests/expected/agent-preset-authoring/copy-dialog.expected.md']
const toolingPaths = ['.github/workflows/alpha2-pr74-generation.yml', 'scripts/alpha2-pr74-generation.mjs']
const generatedFiles = paths.map(path => `generated/${path}`)
const finalFiles = ['before.json', 'qualified.json', ...generatedFiles]
const MAX_GENERATED = 1024 * 1024
const MAX_RECEIPT = 16 * 1024
const MAX_LOCK = 16 * 1024 * 1024
function gitRun(args, options) {
  try { return execFileSync('git', args, options) } catch {
    // execFileSync errors retain captured stdout; never dump source blobs on failure.
    throw new Error('bounded read-only Git query failed')
  }
}
const git = (...args) => gitRun(args, { encoding: 'utf8', maxBuffer: MAX_GENERATED }).trim()
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
function validateSourceParent(source, businessSource, line) {
  assert.match(businessSource, /^[0-9a-f]{40}$/, 'reviewed business-source pin is required')
  assert.equal(line, `${source} ${businessSource}`, 'capture source must have exactly the reviewed business parent')
}
function validateToolingChanges(changed) {
  assert.equal(changed.length, toolingPaths.length, 'unexpected tooling scope')
  assert.equal(new Set(changed).size, changed.length)
  assert(changed.every(line => toolingPaths.some(path => line === `A\t${path}`)), 'only the two reviewed tooling additions are admitted')
}
function validateChanges(changed) {
  assert.equal(new Set(changed).size, changed.length)
  assert(changed.every(path => paths.includes(path)), 'unexpected tracked source change')
}
// Check lexical ancestors before canonical resolution, including Windows junctions.
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
  const output = join(runnerTemp, 'alpha2-pr74-generation')
  assert(outputArg === output, 'output must be the fixed RUNNER_TEMP/alpha2-pr74-generation child')
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
  for (const file of files) boundedRead(root, join(root, file), file.endsWith('.json') ? MAX_RECEIPT : MAX_GENERATED)
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
function receiptInventory(value, expectedPaths) {
  assert(Array.isArray(value) && value.length === expectedPaths.length, 'invalid input inventory cardinality')
  return value.map((input, index) => {
    exactKeys(input, ['path', 'bytes', 'sha256'])
    assert(input.path === expectedPaths[index], 'unexpected input path')
    assert(Number.isSafeInteger(input.bytes) && input.bytes > 0 && input.bytes < MAX_GENERATED, 'invalid input byte count')
    assert(typeof input.sha256 === 'string' && /^[0-9a-f]{64}$/.test(input.sha256), 'invalid input hash')
    return { path: input.path, bytes: input.bytes, sha256: input.sha256 }
  })
}
function validateBefore(bytes) {
  assert(bytes.length > 0 && bytes.length < MAX_RECEIPT, 'before receipt exceeds budget')
  let value
  try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new Error('invalid before receipt JSON') }
  exactKeys(value, ['source', 'businessSource', 'tree', 'lockfileSha256', 'inputs', 'preservedInputs', 'tooling'])
  for (const key of ['source', 'businessSource', 'tree']) {
    assert(typeof value[key] === 'string' && /^[0-9a-f]{40}$/.test(value[key]), 'invalid source/tree hash')
  }
  assert(typeof value.lockfileSha256 === 'string' && /^[0-9a-f]{64}$/.test(value.lockfileSha256), 'invalid lock hash')
  const inputs = receiptInventory(value.inputs, paths)
  const preservedInputs = receiptInventory(value.preservedInputs, preservedPaths)
  const tooling = receiptInventory(value.tooling, toolingPaths)
  const clean = { source: value.source, businessSource: value.businessSource, tree: value.tree,
    lockfileSha256: value.lockfileSha256, inputs, preservedInputs, tooling }
  // Byte equality rejects duplicate keys, extra fields and noncanonical encodings.
  assert(canonical(clean).equals(bytes), 'before receipt is not canonical')
  return clean
}
function unchanged(bytes, original) {
  assert(bytes.equals(original), 'preserved input differs from its exact source blob')
}
function selfTest() {
  validateSource('a'.repeat(40), 'a'.repeat(40))
  assert.throws(() => validateSource('A'.repeat(40), 'A'.repeat(40)))
  assert.throws(() => validateSource('a'.repeat(40), 'b'.repeat(40)))
  validateSourceParent('a'.repeat(40), 'd'.repeat(40), `${'a'.repeat(40)} ${'d'.repeat(40)}`)
  assert.throws(() => validateSourceParent('a'.repeat(40), '', ''))
  assert.throws(() => validateSourceParent('a'.repeat(40), 'd'.repeat(40), `${'a'.repeat(40)} ${'d'.repeat(40)} ${'e'.repeat(40)}`))
  validateToolingChanges(toolingPaths.map(path => `A\t${path}`))
  assert.throws(() => validateToolingChanges([`M\t${toolingPaths[0]}`, `A\t${toolingPaths[1]}`]))
  assert.throws(() => validateToolingChanges([`A\t${toolingPaths[0]}`, `A\t${toolingPaths[0]}`]))
  validateChanges([])
  validateChanges(paths)
  assert.throws(() => validateChanges([paths[0], paths[0]]))
  assert.throws(() => validateChanges([preservedPaths[0]]))
  assert.throws(() => validateChanges(['packages/extensions/cordis-client-runner/src/client/slot-catalog.ts']))
  assert.throws(() => validateChanges(['../credentials']))
  const fixtureBytes = Buffer.from('transport fixture only\n')
  const baseReceipt = { source: 'a'.repeat(40), businessSource: 'd'.repeat(40), tree: 'b'.repeat(40), lockfileSha256: 'c'.repeat(64),
    inputs: paths.map(path => observed(path, fixtureBytes)),
    preservedInputs: preservedPaths.map(path => observed(path, fixtureBytes)),
    tooling: toolingPaths.map(path => observed(path, fixtureBytes)) }
  const receipt = canonical(baseReceipt)
  validateBefore(receipt)
  assert.equal(baseReceipt.inputs.length, 4)
  assert.equal(finalFiles.length, 6)
  for (const inputs of [baseReceipt.inputs.slice(0, 1), baseReceipt.inputs.slice(0, 3),
    [...baseReceipt.inputs, baseReceipt.inputs[0]], [...baseReceipt.inputs].reverse()]) {
    assert.throws(() => validateBefore(canonical({ ...baseReceipt, inputs })))
  }
  assert.throws(() => validateBefore(canonical({ ...baseReceipt, inputs: [baseReceipt.inputs[0], baseReceipt.inputs[0], ...baseReceipt.inputs.slice(2)] })))
  assert.throws(() => validateBefore(canonical({ ...baseReceipt, preservedInputs: [] })))
  assert.throws(() => validateBefore(canonical({ ...baseReceipt, tooling: baseReceipt.tooling.slice(0, 1) })))
  assert.throws(() => validateBefore(Buffer.from('{"source":"duplicate",' + receipt.toString('utf8').slice(1))))
  assert.throws(() => validateBefore(canonical({ ...baseReceipt, unexpected: 'not-for-capture' })))
  assert.throws(() => validateBefore(Buffer.alloc(MAX_RECEIPT)))
  unchanged(fixtureBytes, Buffer.from(fixtureBytes))
  assert.throws(() => unchanged(Buffer.from('changed copy dialog'), fixtureBytes))
  const base = process.env.RUNNER_TEMP || tmpdir()
  noLinks(base)
  const fixture = mkdtempSync(join(base, 'alpha2-pr74-capture-selftest-'))
  try {
    const checkout = join(fixture, 'checkout')
    const runner = join(fixture, 'runner')
    mkdirSync(checkout)
    mkdirSync(runner)
    const output = fixedOutput(checkout, runner, join(runner, 'alpha2-pr74-generation'))
    assert.throws(() => fixedOutput(checkout, runner, join(fixture, 'other')))
    assert.throws(() => fixedOutput(checkout, checkout, join(checkout, 'alpha2-pr74-generation')))
    mkdirSync(output)
    assert.throws(() => mkdirSync(output))
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
    assert.throws(() => fixedOutput(checkout, link, join(link, 'alpha2-pr74-generation')))
    assert.throws(() => inventory(output, ['before.json']))
    assert.throws(() => exclusiveWrite(output, 'linked/leak.txt', fixtureBytes, MAX_GENERATED))
    assert.throws(() => boundedRead(output, join(checkout, 'missing'), MAX_GENERATED))
    assert(lstatSync(link).isSymbolicLink(), 'self-test cleanup must unlink only its link')
    unlinkSync(link)
    assert(lstatSync(checkout).isDirectory(), 'link cleanup must preserve its target')
    assert.throws(() => exclusiveWrite(output, 'oversized.ts', Buffer.alloc(MAX_GENERATED), MAX_GENERATED))
    for (const dir of directories(generatedFiles)) {
      contained(output, dirname(join(output, dir)))
      mkdirSync(join(output, dir))
    }
    for (const file of generatedFiles) exclusiveWrite(output, file, fixtureBytes, MAX_GENERATED)
    // This is a transport fixture, not a generated catalog or Browser result.
    exclusiveWrite(output, 'qualified.json', canonical({ fullReleaseQualification: false, transportFixtureOnly: true }), MAX_RECEIPT)
    inventory(output, finalFiles)
    unlinkSync(join(output, generatedFiles[3]))
    assert.throws(() => inventory(output, finalFiles))
    exclusiveWrite(output, generatedFiles[3], fixtureBytes, MAX_GENERATED)
    inventory(output, finalFiles)
  } finally {
    // Only this freshly allocated control fixture is removed, never the real capture or checkout.
    rmSync(fixture, { recursive: true, force: true })
  }
  console.log('PR74 transport self-tests passed: four generated paths, six artifact files, input cardinality and negative controls; no Git, generator, browser or network operation executed.')
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
  const businessSource = process.env.EXPECTED_BUSINESS_SHA ?? ''
  validateSourceParent(source, businessSource, git('rev-list', '--parents', '-n', '1', 'HEAD'))
  validateToolingChanges(git('diff', '--name-status', '--no-renames', businessSource, source).split('\n').filter(Boolean))
  const tree = git('rev-parse', 'HEAD^{tree}')
  const lockBytes = boundedRead(root, join(root, 'pnpm-lock.yaml'), MAX_LOCK)
  const headLock = gitBytes(source, 'pnpm-lock.yaml', MAX_LOCK)
  unchanged(lockBytes, headLock)
  const headInputs = paths.map(path => observed(path, gitBytes(source, path, MAX_GENERATED)))
  const preservedInputs = preservedPaths.map(path => {
    const original = gitBytes(source, path, MAX_GENERATED)
    unchanged(boundedRead(root, join(root, path), MAX_GENERATED), original)
    return observed(path, original)
  })
  const tooling = toolingPaths.map(path => {
    const original = gitBytes(source, path, MAX_GENERATED)
    unchanged(boundedRead(root, join(root, path), MAX_GENERATED), original)
    return observed(path, original)
  })
  const expectedBefore = { source, businessSource, tree, lockfileSha256: hash(lockBytes), inputs: headInputs, preservedInputs, tooling }
  if (mode === 'before') {
    assert(git('status', '--porcelain', '--untracked-files=all') === '', 'capture starts from a clean checkout')
    for (const [index, path] of paths.entries()) {
      const input = observed(path, boundedRead(root, join(root, path), MAX_GENERATED))
      assert(input.bytes === headInputs[index].bytes && input.sha256 === headInputs[index].sha256, 'generation input differs from exact HEAD blob')
    }
    const receipt = canonical(expectedBefore)
    validateBefore(receipt)
    mkdirSync(output, { mode: 0o700 })
    exclusiveWrite(output, 'before.json', receipt, MAX_RECEIPT)
    inventory(output, ['before.json'])
    console.log(`Bound capture source ${source}, reviewed business parent ${businessSource}, four original generation inputs and unchanged copy-dialog bytes.`)
  } else {
    inventory(output, ['before.json'])
    const beforeBytes = boundedRead(output, join(output, 'before.json'), MAX_RECEIPT)
    const before = validateBefore(beforeBytes)
    assert(canonical(expectedBefore).equals(beforeBytes), 'before receipt differs from exact source/tree/input/tooling blobs')
    assert(git('diff', '--cached', '--name-only') === '', 'generators must not stage changes')
    const changed = git('diff', '--name-only', 'HEAD').split('\n').filter(Boolean)
    validateChanges(changed)
    assert(git('ls-files', '--others', '--exclude-standard') === '', 'no untracked source may survive qualification')
    const payloads = paths.map(path => boundedRead(root, join(root, path), MAX_GENERATED))
    const outputs = paths.map((path, index) => observed(path, payloads[index]))
    const qualified = canonical({ schemaVersion: 1,
      purpose: 'normal-client-inspect-catalog-and-creator-browser-generation', source, businessSource, tree,
      node: process.version, lockfileSha256: before.lockfileSha256,
      inputs: before.inputs, preservedInputs: before.preservedInputs, tooling: before.tooling, outputs, changed,
      prerequisitesDeclaredByWorkflow: ['frozen-install', 'gen-cordis-inspect-catalog', 'verify-cordis-inspect-catalog',
        'verify-client-catalog', 'verify-cordis-catalog', 'full-build', 'owning-client-and-harness-tests', 'full-typed-lint',
        'chromium-creator-refresh', 'chromium-creator-and-fixture-replay', 'final-catalog-freshness'],
      workflowSuccessMustBeIndependentlyChecked: true, catalogAndBrowserSemanticsRequireIndependentAcceptance: true,
      fullReleaseQualification: false, desktopInstallationExecuted: false,
    })
    for (const dir of directories(generatedFiles)) {
      contained(output, dirname(join(output, dir)))
      mkdirSync(join(output, dir), { mode: 0o700 })
    }
    for (const [index, file] of generatedFiles.entries()) exclusiveWrite(output, file, payloads[index], MAX_GENERATED)
    exclusiveWrite(output, 'qualified.json', qualified, MAX_RECEIPT)
    inventory(output, finalFiles)
    console.log('Captured exactly four measured generated outputs and two bounded receipts; no 44-byte assumption, arbitrary diff, or full-release qualification. Independent workflow and adoption audit still required.')
  }
}
