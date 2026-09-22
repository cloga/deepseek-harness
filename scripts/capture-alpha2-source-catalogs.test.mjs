/** Inert source-capture regressions: owned temporary files only, no generators, package install or application launch. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { assertArtifactFiles, assertStable, bindSource, changedOutputs, CHECKS, EN_GRAPHS, GENERATORS, OUTPUT_PATHS,
  isAllowedOutput, safePath, trackedLinkTarget } from './capture-alpha2-source-catalogs.mjs'

const head = 'a'.repeat(40)
const observed = { head, tree: 'b'.repeat(40), node: 'v24.13.0', pnpm: '11.7.0', platform: 'win32', arch: 'x64' }
const environment = { GITHUB_SHA: head, GITHUB_REPOSITORY: 'cloga/deepseek-harness',
  GITHUB_REF: 'refs/heads/cloga-official-first-016a2', GITHUB_ACTIONS: 'true', GITHUB_EVENT_NAME: 'push',
  RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' }
const root = fileURLToPath(new URL('..', import.meta.url))
const entry = (path, bytes = Buffer.from('original')) => ({ path, mode: '100644', kind: 'file', bytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex') })

for (const event of ['push', 'workflow_dispatch']) test(`binds exact hosted task-branch ${event} identity`, () => {
  const value = bindSource(observed, { ...environment, GITHUB_EVENT_NAME: event }, head)
  assert.equal(value.sourceCommit, head)
  assert.equal(value.sourceTree, observed.tree)
  assert.equal(value.nodeVersion, 'v24.13.0')
  assert.equal(value.pnpmVersion, '11.7.0')
  assert.equal(value.runId, '123')
})

test('refuses mismatched source, fork, branch, event, tools and host identity before capture', () => {
  for (const key of Object.keys(observed)) assert.throws(() => bindSource({ ...observed, [key]: 'wrong' }, environment, head))
  for (const key of Object.keys(environment)) assert.throws(() => bindSource(observed, { ...environment, [key]: 'wrong' }, head))
  for (const expected of ['', 'A'.repeat(40), head + '\n', 'c'.repeat(40)]) assert.throws(() => bindSource(observed, environment, expected))
  for (const id of ['0', '-1', '123\n', '1'.repeat(21)]) {
    assert.throws(() => bindSource(observed, { ...environment, GITHUB_RUN_ID: id }, head))
    assert.throws(() => bindSource(observed, { ...environment, GITHUB_RUN_ATTEMPT: id }, head))
  }
})

test('rejects unsafe portable, device, ignored-dependency and metadata paths', () => {
  for (const path of ['', '../secret', '/absolute', 'C:/secret', 'a\\b', 'a//b', './a', 'a/../b', 'a/.',
    'a/name.', 'a/name ', 'a/CON.txt', 'a/aux', '.git/config', 'a/NODE_MODULES/x', 'a/line\nb', 'a:stream']) {
    assert.throws(() => safePath(path), path)
  }
  assert.equal(safePath('docs/subsystems/boot.zh.md'), 'docs/subsystems/boot.zh.md')
})

test('binds normal tracked CLAUDE link text without reading foreign target bytes', () => {
  assert.equal(trackedLinkTarget(root, 'CLAUDE.md', 'AGENTS.md'), join(root, 'AGENTS.md'))
  assert.equal(trackedLinkTarget(root, 'packages/CLAUDE.md', 'AGENTS.md'), join(root, 'packages', 'AGENTS.md'))
  for (const text of ['../foreign', '/absolute', 'C:/secret', 'AGENTS.md\n', '', '../../secret']) {
    assert.throws(() => trackedLinkTarget(root, 'CLAUDE.md', text))
  }
  const link = { ...entry('CLAUDE.md', Buffer.from('AGENTS.md')), mode: '120000', kind: 'link' }
  assert.deepEqual(changedOutputs([link], [link]), [])
  const plainCheckout = { ...link, kind: 'file' }
  assert.deepEqual(changedOutputs([plainCheckout], [plainCheckout]), [])
  assert.throws(() => changedOutputs([link], [plainCheckout]))
  assert.throws(() => changedOutputs([link], [{ ...link, sha256: 'c'.repeat(64) }]))
})

test('admits only destinations named by the maintained generator owners', () => {
  const source = readFileSync(join(root, 'scripts/gen-cordis-catalog.ts'), 'utf8')
  const ownedPaths = new Set(['docs/cordis-api/inherited.md'])
  for (const name of ['SERVICE_PAGE', 'EVENT_SCOPE_PAGE']) {
    const block = source.match(new RegExp(`export const ${name}[^=]*= \\{([\\s\\S]*?)\\n\\}`))
    assert(block, `Missing owner map ${name}`)
    const pages = [...block[1].matchAll(/: '([^']+\.md)'/gu)].map(match => match[1])
    assert(pages.length > 20, 'Owner map unexpectedly empty or narrowed')
    for (const page of pages) for (const suffix of ['.md', '.zh.md', '.i18n.yaml']) {
      const path = 'docs/subsystems/' + page.replace(/\.md$/u, suffix)
      assert(isAllowedOutput(path), page)
      ownedPaths.add(path)
    }
  }
  const core = readFileSync(join(root, 'scripts/cordis-core-api.ts'), 'utf8')
  const corePaths = [...core.matchAll(/out: '([^']+)'/gu)].map(match => match[1])
  assert.equal(corePaths.length, 5)
  for (const path of corePaths) { assert(isAllowedOutput(path)); ownedPaths.add(path) }
  for (const path of ['packages/extensions/tool-cordis/src/api-catalog.ts',
    'packages/extensions/cordis-client-runner/src/client/api-catalog.ts',
    'packages/extensions/cordis-client-runner/src/client/slot-catalog.ts', 'THIRD_PARTY_NOTICES.md', ...EN_GRAPHS]) {
    assert(isAllowedOutput(path)); ownedPaths.add(path)
  }
  assert.deepEqual([...OUTPUT_PATHS].sort(), [...ownedPaths].sort(), 'Output allowlist differs from reviewed generator owners')
  assert.match(source, /const OUT_RUNTIME_API = 'packages\/extensions\/tool-cordis\/src\/api-catalog\.ts'/u)
  assert.match(source, /const OUT_INHERITED = 'docs\/cordis-api\/inherited\.md'/u)
  assert.match(readFileSync(join(root, 'scripts/gen-cordis-inspect-catalog.ts'), 'utf8'),
    /const CLIENT_OUT = 'packages\/extensions\/cordis-client-runner\/src\/client\/api-catalog\.ts'/u)
  assert.match(readFileSync(join(root, 'scripts/gen-client-catalog.ts'), 'utf8'),
    /const OUT = 'packages\/extensions\/cordis-client-runner\/src\/client\/slot-catalog\.ts'/u)
  const graphs = readFileSync(join(root, 'scripts/gen-doc-graphs.ts'), 'utf8')
  assert.deepEqual([...new Set([...graphs.matchAll(/rel: '([^']+\.md)'/gu)].map(match => match[1]))].sort(), [...EN_GRAPHS].sort())
  assert.match(readFileSync(join(root, 'scripts/gen-third-party-notices.ts'), 'utf8'), /const OUT = 'THIRD_PARTY_NOTICES\.md'/u)
  for (const path of ['package.json', 'pnpm-lock.yaml', 'scripts/gen-cordis-catalog.ts', 'docs/subsystems/unknown.md',
    'docs/cordis-api/context.zh.md', 'docs/graph-atlas.zh.md', 'packages/boot/app-boot/src/types.ts']) assert(!isAllowedOutput(path))
  assert(!GENERATORS.includes('gen-cordis-api'))
  assert.deepEqual(CHECKS, ['verify-cordis-catalog', 'verify-cordis-inspect-catalog', 'verify-client-catalog',
    'verify-doc-graphs', 'verify-third-party-notices'])
})

test('captures exact original and generated raw hashes without line-ending normalization', () => {
  const before = [entry('docs/subsystems/boot.md', Buffer.from('one\r\n'))]
  const after = [entry('docs/subsystems/boot.md', Buffer.from('one\n'))]
  const changes = changedOutputs(before, after)
  assert.equal(changes.length, 1)
  assert.equal(changes[0].before.bytes, 5)
  assert.equal(changes[0].after.bytes, 4)
  assert.notEqual(changes[0].before.sha256, changes[0].after.sha256)
  assert.deepEqual(changedOutputs(before, before), [])
})

test('refuses source edits, tracked additions, deletions, duplicate paths, links and mode changes', () => {
  const before = [entry('docs/subsystems/boot.md')]
  assert.throws(() => changedOutputs(before, []))
  assert.throws(() => changedOutputs(before, [...before, entry('unexpected.md')]))
  assert.throws(() => changedOutputs(before, [entry('docs/subsystems/core.md')]))
  assert.throws(() => changedOutputs([...before, ...before], [...before, ...before]))
  assert.throws(() => changedOutputs([entry('pnpm-lock.yaml')], [entry('pnpm-lock.yaml', Buffer.from('changed'))]))
  assert.throws(() => changedOutputs(before, [{ ...before[0], mode: '100755' }]))
  assert.throws(() => changedOutputs(before, [{ ...before[0], kind: 'link' }]))
})

test('does not let an allowed output change after its copy observation', () => {
  const before = [entry('docs/subsystems/boot.md')]
  const after = [entry('docs/subsystems/boot.md', Buffer.from('generated'))]
  assert.equal(changedOutputs(before, after).length, 1)
  assertStable(after, structuredClone(after))
  assert.throws(() => assertStable(after, [entry('docs/subsystems/boot.md', Buffer.from('late'))]))
  assert.throws(() => assertStable(after, []))
})

test('private artifact permits only exact indexed regular files, not a whole-tree payload', () => {
  const directory = mkdtempSync(join(tmpdir(), 'alpha2-capture-test-'))
  try {
    const files = ['index.json', 'inputs.json', 'before/docs/subsystems/boot.md', 'after/docs/subsystems/boot.md']
    for (const path of files) {
      mkdirSync(dirname(join(directory, path)), { recursive: true })
      writeFileSync(join(directory, path), 'owned fixture', { flag: 'wx' })
    }
    assertArtifactFiles(directory, files)
    writeFileSync(join(directory, 'unexpected.txt'), 'must not upload')
    assert.throws(() => assertArtifactFiles(directory, files))
  } finally { rmSync(directory, { recursive: true, force: true }) }
})

test('actual workflow source expression never substitutes GITHUB_SHA for empty or missing manual input', () => {
  const workflow = readFileSync(join(root, '.github/workflows/alpha2-source-catalogs.yml'), 'utf8')
  const expression = workflow.match(/^      EXPECTED_SOURCE: \$\{\{ (.+) \}\}$/mu)?.[1]
  // Evaluate only this reviewed expression form, extracted from the real workflow; a fallback-direction change fails here.
  const parsed = /^github\.event_name == '([^']+)' && github\.sha \|\| inputs\.expected_source$/u.exec(expression ?? '')
  assert(parsed, 'Workflow must derive pushes from github.sha and leave manual input unfilled')
  assert.equal(parsed[1], 'push')
  assert(workflow.includes("if ($env:GITHUB_EVENT_NAME -cnotin @('push', 'workflow_dispatch')) { throw 'Unsupported capture event' }"))
  assert(workflow.includes("if ($env:EXPECTED_SOURCE -cnotmatch '\\A[a-f0-9]{40}\\z') { throw 'Invalid expected source' }"))
  assert(workflow.includes("if ($env:GITHUB_SHA -cne $env:EXPECTED_SOURCE) { throw 'Dispatch source differs from workflow source' }"))
  const derive = (event, raw) => (event === parsed[1] && environment.GITHUB_SHA) || raw
  for (const raw of ['', undefined, 'c'.repeat(40), head + '\n']) {
    assert.equal(derive('workflow_dispatch', raw), raw)
    assert.throws(() => bindSource(observed, { ...environment, GITHUB_EVENT_NAME: 'workflow_dispatch' }, derive('workflow_dispatch', raw)))
  }
  assert.equal(bindSource(observed, { ...environment, GITHUB_EVENT_NAME: 'workflow_dispatch' },
    derive('workflow_dispatch', head)).sourceCommit, head)
  for (const raw of ['', undefined, 'wrong', 'c'.repeat(40)]) {
    assert.equal(derive('push', raw), head)
    assert.equal(bindSource(observed, environment, derive('push', raw)).sourceCommit, head)
  }
  assert.throws(() => bindSource(observed, { ...environment, GITHUB_EVENT_NAME: 'pull_request' }, derive('pull_request', head)))
})

test('workflow is branch-fixed, read-only, frozen-install and artifact-only with all owner tasks', () => {
  const workflow = readFileSync(join(root, '.github/workflows/alpha2-source-catalogs.yml'), 'utf8')
  assert.match(workflow, /branches: \[cloga-official-first-016a2\]/u)
  assert.match(workflow, /github\.ref == 'refs\/heads\/cloga-official-first-016a2'/u)
  assert.match(workflow, /contents: read/u)
  assert.match(workflow, /persist-credentials: false/u)
  assert.match(workflow, /runs-on: windows-2025/u)
  assert.match(workflow, /node-version: '24\.13\.0'/u)
  assert.match(workflow, /version: '11\.7\.0'/u)
  assert.match(workflow, /pnpm install --frozen-lockfile/u)
  assert.match(workflow, /path: \$\{\{ env\.CAPTURE_ROOT \}\}\/artifact/u)
  assert(!/pull_request:|workflow_run:|cancel-in-progress:|contents: write|git push|npm publish|gh release|gen-cordis-api/u.test(workflow))
  for (const task of [...GENERATORS, ...CHECKS]) assert(workflow.includes(`'${task}'`))
  for (const phase of ['begin', 'baseline', 'capture', 'verify']) assert(workflow.includes(`--phase ${phase}`))
})
