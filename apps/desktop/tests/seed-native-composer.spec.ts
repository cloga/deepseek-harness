/** Execute only the seeder control flow with inert public-API boundaries; no packaged code, provider or Host runs. */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join } from 'node:path'
import { runInNewContext } from 'node:vm'
import { afterEach, describe, expect, it } from 'vitest'
import { nativeComposerSeed } from './native-composer-fixture.ts'
import type { Session } from '@deepseek-ai/dsh-session'
import type { UserMessage, AssistantMessage } from '@deepseek-ai/dsh-llm/types'

const source = readFileSync(new URL('./fixtures/seed-native-composer.mjs', import.meta.url), 'utf8')
const loadLine = 'const load = name => import(pathToFileURL(require.resolve(name)).href)'
assert(source.includes(loadLine))
const body = source.replace(/^import .*\n/gmu, '').replace(loadLine, 'const load = loadFixtureModule')
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture(stage = '', primary?: unknown) {
  const home = mkdtempSync(join(tmpdir(), 'composer-seeder-unit-'))
  roots.push(home)
  const runtime = join(home, 'runtime')
  mkdirSync(runtime)
  const marker = join(home, 'native-composer-owner.json')
  writeFileSync(marker, JSON.stringify({ kind: 'desktop-native-composer-smoke', home, token: 'unit-private-owner' }))
  const calls: string[] = []
  const loaded: string[] = []
  const outputs: string[] = []
  const records: { type: string; seq: number; data: unknown; metadata: unknown }[] = []
  const secondary = new Error('secondary cleanup failure')
  let header: Parameters<typeof Session.create>[2]
  let persisted: unknown
  let factoryId = 0
  const persistence = { async create(value: unknown) {
    calls.push('create'); expect(value).toEqual(header)
    if (stage === 'create') throw primary
    return {
      async append(events: unknown) { calls.push('append'); persisted = events; if (stage.startsWith('append')) throw primary },
      async close() { calls.push('close'); if (stage === 'close') throw primary; if (stage === 'append-and-close') throw secondary },
    }
  } }
  const owner = { sessionIds: [] as string[], async attachSession(id: string) {
    calls.push('attach'); if (stage === 'attach') throw primary; owner.sessionIds.push(id)
  } }
  const registry = { async create(path: string) {
    calls.push('workspace'); expect(path).toBe(join(home, 'synthetic-composer-workspace')); return owner
  } }
  class Context {
    fiber = { async dispose() { calls.push('dispose'); if (stage === 'dispose') throw primary; if (stage === 'append-and-close') throw secondary } }
    async plugin(_plugin: unknown, _options?: unknown) { calls.push('plugin') }
    get(name: string) { return name === 'sessionPersistence' ? persistence : name === 'workspaceRegistry' ? registry : undefined }
  }
  const modules: Record<string, unknown> = {
    '@deepseek-ai/cordis': { Context },
    '@deepseek-ai/dsh-session': { SESSION_FORMAT_VERSION: 1, SessionId: (value: string) => value, Session: {
      create(id: string, seed: unknown, metadata: Parameters<typeof Session.create>[2]) {
        expect(id).toBe('desktop-inline-composer-synthetic'); expect(seed).toBeUndefined(); header = metadata
        return {
          append(type: string, data: unknown, extra: unknown) {
            const record = { type, data, metadata: extra, seq: records.length + 1 }; records.push(record); return record
          },
          snapshotEvents() { return records },
        }
      },
    } },
    '@deepseek-ai/dsh-llm': {
      createSystemMessage(text: string, plugin: string) { return { id: `message-${++factoryId}`, role: 'system', content: [{ type: 'text', text }], source: { kind: 'plugin', plugin } } },
      createUserMessage(value: Pick<UserMessage, 'content' | 'source'>) { return { ...value, id: `message-${++factoryId}`, role: 'user' } },
      createAssistantMessage(value: Pick<AssistantMessage, 'content'> & { source: { provider: string; model: string } }) {
        return { ...value, id: `message-${++factoryId}`, role: 'assistant', source: { kind: 'model', ...value.source } }
      },
    },
    '@deepseek-ai/dsh-session-persistence-jsonl': { default: 'unit-jsonl' },
    '@deepseek-ai/dsh-storage': { default: 'unit-storage' }, '@deepseek-ai/dsh-storage-json': {},
    '@deepseek-ai/dsh-storage-domain': {}, '@deepseek-ai/dsh-workspace': { default: 'unit-workspace' },
  }
  const run = () => runInNewContext(`(async () => { ${body} })()`, {
    assert, mkdirSync, readFileSync, isAbsolute, join, Date,
    createRequire: () => ({}),
    process: { argv: ['node', 'seed', runtime, home, 'unit-private-owner'], env: { ELECTRON_RUN_AS_NODE: '1' }, versions: { electron: 'unit' } },
    console: { log(text: string) { calls.push('output'); outputs.push(text) } },
    async loadFixtureModule(name: string) { loaded.push(name); assert(Object.hasOwn(modules, name)); return modules[name] },
  }, { timeout: 1000 }) as Promise<void>
  return { run, home, marker, calls, loaded, outputs, records, get header() { return header }, get persisted() { return persisted } }
}

describe('packaged public-API seeder control flow with inert business boundaries', () => {
  it('creates and closes exact synthetic history, attaches workspace membership, then disposes before publishing six fields', async () => {
    const f = fixture()
    await f.run()
    expect(f.header).toMatchObject({ id: 'desktop-inline-composer-synthetic', isSeeded: false, delegationDepth: 0 })
    expect(f.records.map(record => record.type)).toEqual(['turn/start', 'step/start', 'system/message', 'user/message',
      'session/title', 'request/header', 'assistant/message', 'step/end', 'turn/end'])
    expect(f.records[6]?.data).toMatchObject({ usage: { inputTokens: 10, cacheReadTokens: 90, outputTokens: 5 } })
    expect(f.calls.indexOf('append')).toBeLessThan(f.calls.indexOf('close'))
    expect(f.calls.indexOf('close')).toBeLessThan(f.calls.indexOf('attach'))
    expect(f.calls.indexOf('attach')).toBeLessThan(f.calls.indexOf('dispose'))
    expect(f.calls.at(-1)).toBe('output')
    expect(f.outputs).toHaveLength(1)
    expect(JSON.parse(f.outputs[0]!)).toEqual(nativeComposerSeed())
    expect(Array.isArray(f.persisted)).toBe(true)
    expect(f.loaded).not.toContain('@deepseek-ai/dsh-agent')
  })
  it('refuses a foreign ownership marker before loading any packaged API or creating workspace state', async () => {
    const f = fixture()
    writeFileSync(f.marker, '{}')
    await expect(f.run()).rejects.toThrow()
    expect(f.loaded).toEqual([])
    expect(f.outputs).toEqual([])
    expect(existsSync(join(f.home, 'synthetic-composer-workspace'))).toBe(false)
  })
  it.each(['create', 'append', 'append-and-close', 'close', 'attach', 'dispose', 'append-undefined'] as const)(
    'retains original %s failure, closes acquired handles and never publishes success', async (stage) => {
      const primary = stage === 'append-undefined' ? undefined : new Error(`primary ${stage}`)
      const f = fixture(stage, primary)
      await expect(f.run()).rejects.toBe(primary)
      expect(f.calls).toContain('dispose')
      if (stage.startsWith('append') || stage === 'close') expect(f.calls).toContain('close')
      if (stage === 'create') expect(f.calls).not.toContain('close')
      expect(f.outputs).toEqual([])
    },
  )
})
