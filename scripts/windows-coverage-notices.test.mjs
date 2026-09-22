/** Pure Node 24 tests for the opt-in CI observer; no application or dependency bootstrap. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import {
  coverageNoticeChildEnvironment,
  coverageNoticeCommand,
  WINDOWS_COVERAGE_NOTICES_ENV,
  withWindowsCoverageNotices,
} from './windows-coverage-notices.ts'

function fixture() {
  const lines = []
  const timers = []
  let now = 0
  let samples = 0
  const runtime = {
    platform: 'win32',
    env: { GITHUB_ACTIONS: 'true', [WINDOWS_COVERAGE_NOTICES_ENV]: '1', ImageOS: 'win25', ImageVersion: '20260913.1.0' },
    nodeVersion: '24.20.0',
    now: () => now,
    sample: () => { samples++; return { freeBytes: 4 * 1048576, totalBytes: 16 * 1048576, rssBytes: 2 * 1048576 } },
    after: (delay, callback) => {
      const timer = { delay, callback, disposals: 0 }
      timers.push(timer)
      return () => { timer.disposals++ }
    },
    emit: line => { lines.push(line) },
  }
  return { runtime, lines, timers, samples: () => samples, advance: value => { now = value } }
}

function payload(line) {
  const prefix = '::notice title=Windows coverage checkpoint::'
  assert.ok(line.startsWith(prefix))
  return JSON.parse(decodeURIComponent(line.slice(prefix.length)))
}

for (const [name, mode, overrides] of [
  ['other mode', 'ci-static', {}],
  ['other platform', 'ci-coverage', { platform: 'linux' }],
  ['outside Actions', 'ci-coverage', { env: { GITHUB_ACTIONS: 'false', [WINDOWS_COVERAGE_NOTICES_ENV]: '1' } }],
  ['absent opt-in', 'ci-coverage', { env: { GITHUB_ACTIONS: 'true' } }],
  ['inexact opt-in', 'ci-coverage', { env: { GITHUB_ACTIONS: 'true', [WINDOWS_COVERAGE_NOTICES_ENV]: 'true' } }],
]) {
  test(`does no diagnostic work for ${name}`, async () => {
    const subject = fixture()
    const code = await withWindowsCoverageNotices(mode, async progress => {
      progress.started(); progress.finished(); progress.result('failed')
      return 17
    }, { ...subject.runtime, ...overrides })
    assert.equal(code, 17)
    assert.deepEqual(subject.lines, [])
    assert.deepEqual(subject.timers, [])
    assert.equal(subject.samples(), 0)
  })
}

test('emits fixed aggregate counters and seven bounded checkpoints, then becomes inert', async () => {
  const subject = fixture()
  const code = await withWindowsCoverageNotices('ci-coverage', async progress => {
    progress.started()
    for (const timer of subject.timers) {
      subject.advance(timer.delay)
      for (let attempt = 0; attempt < 20; attempt++) timer.callback()
    }
    progress.finished(); progress.result('failed'); progress.result('skipped')
    return 1
  }, subject.runtime)
  assert.equal(code, 1)
  assert.deepEqual(subject.timers.map(timer => timer.delay), [15, 30, 45, 60, 90].map(minutes => minutes * 60_000))
  const values = subject.lines.map(payload)
  assert.deepEqual(values.map(value => value.checkpoint), ['baseline', 'minute-15', 'minute-30', 'minute-45', 'minute-60', 'minute-90', 'terminal'])
  assert.equal(values[1].elapsedSeconds, 900)
  assert.equal(values[1].running, 1)
  assert.deepEqual(Object.fromEntries(['started', 'running', 'finished', 'failed', 'skipped', 'exitCode'].map(key => [key, values.at(-1)[key]])),
    { started: 1, running: 0, finished: 1, failed: 1, skipped: 1, exitCode: 1 })
  assert.ok(subject.lines.length <= 8)
  for (const timer of subject.timers) { assert.equal(timer.disposals, 1); timer.callback() }
  assert.equal(subject.lines.length, 7)
})

test('selects only fixed validated metadata and finite local memory fields', async () => {
  const subject = fixture()
  subject.runtime.env.EXTRA = 'do-not-leak'
  subject.runtime.env.GITHUB_TOKEN = 'fake-secret'
  await withWindowsCoverageNotices('ci-coverage', async () => 0, subject.runtime)
  assert.deepEqual(payload(subject.lines[0]), {
    schema: 'dsh.windows-coverage-notice', version: 1, checkpoint: 'baseline', elapsedSeconds: 0,
    node: '24.20.0', imageOS: 'win25', imageVersion: '20260913.1.0',
    freeMiB: 4, totalMiB: 16, rssMiB: 2,
    started: 0, running: 0, finished: 0, passed: 0, failed: 0, skipped: 0,
  })
  assert.doesNotMatch(subject.lines.join('\n'), /do-not-leak|fake-secret|GITHUB_TOKEN|EXTRA/u)
})

test('never echoes malformed metadata or permits annotation injection', async () => {
  const subject = fixture()
  const injection = 'bad%0A\r\n::error::injected'
  subject.runtime.env.ImageOS = injection
  subject.runtime.env.ImageVersion = injection
  subject.runtime.nodeVersion = injection
  subject.runtime.sample = () => ({ freeBytes: NaN, totalBytes: Infinity, rssBytes: -1 })
  await withWindowsCoverageNotices('ci-coverage', async () => 0, subject.runtime)
  const first = payload(subject.lines[0])
  assert.deepEqual([first.node, first.imageOS, first.imageVersion], ['unknown', 'unknown', 'unknown'])
  assert.deepEqual([first.freeMiB, first.totalMiB, first.rssMiB], [null, null, null])
  for (const line of subject.lines) assert.doesNotMatch(line, /injected|::error|[\r\n]/u)
  assert.equal(coverageNoticeCommand('value%\r\n::error::data'),
    '::notice title=Windows coverage checkpoint::value%25%0D%0A::error::data')
})

test('rejects overlong or inexact version tokens without echoing them', async () => {
  const subject = fixture()
  subject.runtime.env.ImageOS = 'windows-2025'
  subject.runtime.env.ImageVersion = '9'.repeat(40) + '.1.0'
  subject.runtime.nodeVersion = '24.20.0\n'
  await withWindowsCoverageNotices('ci-coverage', async () => 0, subject.runtime)
  const first = payload(subject.lines[0])
  assert.deepEqual([first.node, first.imageOS, first.imageVersion], ['unknown', 'unknown', 'unknown'])
})

for (const [name, failure] of [['undefined', undefined], ['null', null], ['same object', { code: 'same-object' }]]) {
  test(`preserves the exact rejection ${name} and cleans timers`, async () => {
    const subject = fixture()
    const untouched = Symbol('not rejected')
    let caught = untouched
    try { await withWindowsCoverageNotices('ci-coverage', async () => { throw failure }, subject.runtime) }
    catch (error) { caught = error }
    assert.equal(caught, failure)
    assert.equal(payload(subject.lines.at(-1)).checkpoint, 'threw')
    assert.equal(payload(subject.lines.at(-1)).exitCode, null)
    for (const timer of subject.timers) assert.equal(timer.disposals, 1)
  })
}

test('contains diagnostic failures without replacing the primary exit or thrown object', async () => {
  const subject = fixture()
  let schedules = 0, disposals = 0
  assert.equal(await withWindowsCoverageNotices('ci-coverage', async () => 23, {
    ...subject.runtime,
    after: () => {
      if (schedules++ > 0) throw new Error('timer diagnostic only')
      return () => { disposals++; throw new Error('dispose diagnostic only') }
    },
    sample: () => { throw new Error('sample diagnostic only') },
  }), 23)
  assert.equal(disposals, 1)
  const failure = { primary: true }
  let caught
  try {
    await withWindowsCoverageNotices('ci-coverage', async () => { throw failure }, {
      ...subject.runtime, emit: () => { throw new Error('emit diagnostic only') },
    })
  } catch (error) { caught = error }
  assert.equal(caught, failure)
})

test('unrefs every real timer and clears it before returning the original exit', async () => {
  const subject = fixture()
  const originalSet = globalThis.setTimeout, originalClear = globalThis.clearTimeout
  const handles = [], cleared = []
  let finish
  globalThis.setTimeout = (...args) => { const handle = originalSet(...args); handles.push(handle); return handle }
  globalThis.clearTimeout = handle => { cleared.push(handle); originalClear(handle) }
  try {
    const { after: _after, ...runtime } = subject.runtime
    const work = withWindowsCoverageNotices('ci-coverage', () => new Promise(resolveWork => { finish = resolveWork }), runtime)
    assert.equal(handles.length, 5)
    assert.ok(handles.every(handle => !handle.hasRef()))
    finish(7)
    assert.equal(await work, 7)
    for (const handle of handles) assert.ok(cleared.includes(handle))
  } finally {
    finish?.(7)
    for (const handle of handles) originalClear(handle)
    globalThis.setTimeout = originalSet; globalThis.clearTimeout = originalClear
  }
})

test('removes only the diagnostic child flag without mutating parent or business flags', () => {
  const parent = Object.freeze({ [WINDOWS_COVERAGE_NOTICES_ENV]: '1', DSH_GATE_FAIL_FAST: '1', DSH_COVERAGE_PARTITIONS: '2', KEEP: 'parent', REMOVE: 'parent' })
  const gate = Object.freeze({ [WINDOWS_COVERAGE_NOTICES_ENV]: '1', KEEP: 'gate', REMOVE: undefined })
  const child = coverageNoticeChildEnvironment(parent, gate)
  assert.deepEqual(child, { [WINDOWS_COVERAGE_NOTICES_ENV]: undefined, DSH_GATE_FAIL_FAST: '1', DSH_COVERAGE_PARTITIONS: '2', KEEP: 'gate', REMOVE: undefined })
  assert.equal(parent[WINDOWS_COVERAGE_NOTICES_ENV], '1')
  assert.equal(gate[WINDOWS_COVERAGE_NOTICES_ENV], '1')
  assert.equal(parent.KEEP, 'parent')
  assert.equal(parent.REMOVE, 'parent')
  assert.notEqual(child, parent)
})

test('does not inspect a failed result object or change an observer rejection', async () => {
  const subject = fixture()
  const failure = { status: 'failed', exitCode: 42, command: 'not-for-notices' }
  const observeError = { original: 'observer failure' }
  let observed
  let caught
  try {
    await withWindowsCoverageNotices('ci-coverage', async progress => {
      progress.started()
      let result
      try { result = await Promise.resolve(failure) } finally { progress.finished() }
      progress.result(result.status)
      observed = result
      throw observeError
    }, subject.runtime)
  } catch (error) { caught = error }
  assert.equal(observed, failure)
  assert.equal(caught, observeError)
  assert.doesNotMatch(subject.lines.join('\n'), /not-for-notices|observer failure/u)
})

test('keeps the existing coverage command, budgets and entrypoint with an executed pure-test step', () => {
  const root = resolve(import.meta.dirname, '..')
  const workflow = readFileSync(resolve(root, '.github/workflows/ci.yml'), 'utf8')
  const start = workflow.indexOf('\n  windows-coverage:')
  const end = workflow.indexOf('\n  windows-native-tests:', start)
  assert.ok(start >= 0 && end > start)
  const coverage = workflow.slice(start, end)
  for (const text of [
    'timeout-minutes: 120',
    "DSH_COVERAGE_MAX_WORKERS: ${{ github.repository != 'deepseek-ai/deepseek-harness' && '2' || '6' }}",
    "DSH_COVERAGE_PARTITIONS: ${{ github.repository != 'deepseek-ai/deepseek-harness' && '2' || '4' }}",
    "DSH_COVERAGE_TEST_TIMEOUT_MS: '90000'", "DSH_GATE_CONCURRENCY: '3'", "DSH_GATE_FAIL_FAST: '1'",
    'run: node --test scripts/windows-coverage-notices.test.mjs',
    "- name: Run Windows coverage\n        shell: pwsh\n        env:\n          DSH_WINDOWS_COVERAGE_NOTICES: '1'\n        run: pnpm run check:ci:coverage",
  ]) assert.ok(coverage.includes(text), `missing reviewed coverage setting: ${text}`)
  assert.ok(coverage.indexOf('Verify coverage notice diagnostics') < coverage.indexOf('Run Windows coverage'))
  assert.equal([...workflow.matchAll(/DSH_WINDOWS_COVERAGE_NOTICES:/gu)].length, 1)
  const source = readFileSync(resolve(root, 'scripts/run-gates.ts'), 'utf8')
  assert.ok(source.includes('env: coverageNoticeChildEnvironment(process.env, gate.env)'))
  assert.ok(source.includes('runGates(gates, maxConcurrency, execute, observe, cliGateOptions(failFast))'))
  assert.ok(source.includes('return await runGate(gate, signal)'))
  assert.ok(source.includes('printResult(result)'))
})
