/** Unit-only Office diagnostics; the kit is mocked and no Harness runtime is launched. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { registerHooks, syncBuiltinESMExports } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from './fixtures/python-sdk-office.mjs'

const stateKey = Symbol.for('dsh-office-diagnostic-unit')
const kitUrl = 'data:text/javascript,' + encodeURIComponent(`
export const createConverter = options => globalThis[Symbol.for('dsh-office-diagnostic-unit')].create(options)
`)

async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-office-diagnostic-unit-'))
  const lines = []
  const calls = []
  const state = {
    create(config) {
      calls.push('create')
      assert.deepEqual(config, { timeoutMs: 120_000 })
      if (options.failure === 'create') throw options.error
      return {
        render(config) {
          calls.push('render')
          assert.deepEqual(config, { inputPath: 'unit-input', outputPath: 'unit-output' })
          if (options.failure === 'render') throw options.error
          return { backend: 'native' }
        },
        dispose() {
          calls.push('dispose')
          if (options.failure === 'dispose') throw options.error
        },
      }
    },
  }
  globalThis[stateKey] = state
  const hooks = registerHooks({
    resolve(specifier, context, nextResolve) {
      if (specifier !== '@deepseek-ai/libreoffice-kit') return nextResolve(specifier, context)
      if (options.failure === 'import') throw options.error
      return { url: kitUrl, shortCircuit: true }
    },
  })
  t.after(async () => {
    hooks.deregister()
    t.mock.restoreAll()
    syncBuiltinESMExports()
    delete globalThis[stateKey]
    await rm(root, { recursive: true, force: true })
  })
  t.mock.method(fs, 'writeSync', (fd, line) => {
    assert.equal(fd, 2)
    if (options.brokenDiagnostics) throw new Error('diagnostic sink unavailable')
    lines.push(line)
    return Buffer.byteLength(line)
  })
  syncBuiltinESMExports()
  return {
    calls,
    lines,
    config: {
      input: 'unit-input',
      output: 'unit-output',
      result: join(root, options.failure === 'result-write' ? 'absent/result.json' : 'result.json'),
      diagnostics: join(root, options.brokenDiagnostics ? 'absent/phases.jsonl' : 'phases.jsonl'),
    },
  }
}

function records(lines) {
  assert.ok(lines.length <= 10)
  assert.ok(lines.join('').length <= 2048)
  return lines.map(line => {
    assert.match(line, /^python-sdk-office: \{"phase":"(?:import|create|render|result-write|dispose)","state":"(?:start|done|fail)","elapsedMs":\d+\}\n$/)
    const record = JSON.parse(line.slice('python-sdk-office: '.length))
    assert.ok(Number.isSafeInteger(record.elapsedMs) && record.elapsedMs >= 0 && record.elapsedMs <= 2_147_483_647)
    return record
  })
}

const successfulPhases = ['import', 'create', 'render', 'result-write', 'dispose']

test('records all five phases without changing operation order or converter budget', async t => {
  const owned = await fixture(t)
  await apply(undefined, owned.config)
  const observed = records(owned.lines)
  assert.deepEqual(observed.map(({ phase, state }) => [phase, state]), successfulPhases.flatMap(phase => [[phase, 'start'], [phase, 'done']]))
  assert.deepEqual(owned.calls, ['create', 'render', 'dispose'])
  const persisted = (await readFile(owned.config.diagnostics, 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
  assert.deepEqual(persisted, observed)
  const result = JSON.parse(await readFile(owned.config.result, 'utf8'))
  assert.equal(result.backend, 'native')
  assert.equal(result.moduleUrl, kitUrl)
})

for (const failure of successfulPhases) {
  test(`records ${failure} failure without logging the exception or input`, async t => {
    const error = new Error('DO_NOT_LOG_EXCEPTION_OR_INPUT')
    const owned = await fixture(t, { failure, error })
    await assert.rejects(apply(undefined, owned.config), actual => failure === 'result-write' ? actual.code === 'ENOENT' : actual === error)
    const observed = records(owned.lines)
    assert.ok(observed.some(record => record.phase === failure && record.state === 'fail'))
    assert.ok(!owned.lines.join('').includes('DO_NOT_LOG'))
    assert.ok(!owned.lines.join('').includes('unit-input'))
    if (failure === 'render' || failure === 'result-write') {
      assert.deepEqual(observed.slice(-2).map(({ phase, state }) => [phase, state]), [['dispose', 'start'], ['dispose', 'done']])
    }
    if (failure === 'import' || failure === 'create') assert.ok(!owned.calls.includes('dispose'))
  })
}

test('unwritable stderr and stage record preserve the original conversion error', async t => {
  const error = new Error('original conversion error')
  const owned = await fixture(t, { failure: 'render', error, brokenDiagnostics: true })
  await assert.rejects(apply(undefined, owned.config), actual => actual === error)
  assert.deepEqual(owned.calls, ['create', 'render', 'dispose'])
})

test('unwritable diagnostics do not turn a successful conversion into failure', async t => {
  const owned = await fixture(t, { brokenDiagnostics: true })
  await apply(undefined, owned.config)
  assert.equal(JSON.parse(await readFile(owned.config.result, 'utf8')).backend, 'native')
})
