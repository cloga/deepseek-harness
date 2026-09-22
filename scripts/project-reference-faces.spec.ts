import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import ts from 'typescript'
import { afterEach, describe, expect, it } from 'vitest'
import { collectProjectReferenceFaceViolations } from './project-reference-faces.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function workspaceFixture(options: {
  readonly host: readonly string[]
  readonly client: readonly string[]
}): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-project-reference-faces-'))
  roots.push(root)
  const shared = join(root, 'packages/core/shared')
  const split = join(root, 'packages/api/split')
  mkdirSync(shared, { recursive: true })
  mkdirSync(split, { recursive: true })
  writeJson(join(root, 'tsconfig.base.json'), {})
  writeJson(join(root, 'tsconfig.base.client.json'), { extends: './tsconfig.base.json' })
  writeJson(join(shared, 'package.json'), { name: '@deepseek-ai/dsh-shared' })
  writeJson(join(shared, 'tsconfig.json'), {
    extends: '../../../tsconfig.base.json',
    references: [],
  })
  writeJson(join(split, 'package.json'), { name: '@deepseek-ai/dsh-split' })
  writeJson(join(split, 'tsconfig.json'), {
    files: [],
    references: [{ path: './tsconfig.host.json' }, { path: './tsconfig.client.json' }],
  })
  writeJson(join(split, 'tsconfig.host.json'), { references: [{ path: '../../core/shared' }] })
  writeJson(join(split, 'tsconfig.client.json'), { references: [{ path: '../../core/shared' }] })
  writeJson(join(root, 'tsconfig.host.json'), {
    references: options.host.map(path => ({ path })),
  })
  writeJson(join(root, 'tsconfig.client.json'), {
    references: options.client.map(path => ({ path })),
  })
  return root
}

const rendererUsageTest = 'packages/client/ui-renderer/tests/desktop-copilot-usage-positive.client.spec.ts'
const nativeStatsTest = 'packages/client/ui-chat/tests/chat-stats.client.spec.tsx'
const nativeBrowserFixture = 'apps/desktop/tests/fixtures/native-composer-dock-browser.ts'
const sharedUsageFixtures = [
  'apps/desktop/tests/fixtures/copilot-usage-positive-browser.ts',
  'apps/desktop/tests/fixtures/copilot-usage-positive-smoke.ts',
] as const

function clientUsageRoots(omitted?: string): string[] {
  const repository = resolve(import.meta.dirname, '..')
  const configPath = join(repository, 'tsconfig.client.json')
  const read = ts.readConfigFile(configPath, path => ts.sys.readFile(path))
  if (read.error !== undefined) throw new Error(ts.flattenDiagnosticMessageText(read.error.messageText, '\n'))
  const value: unknown = read.config
  assert(typeof value === 'object' && value !== null && !Array.isArray(value))
  const config = value as Record<string, unknown>
  assert(Array.isArray(config.include))
  const include = config.include.map((entry: unknown) => { assert(typeof entry === 'string'); return entry })
  if (omitted !== undefined) assert(include.includes(omitted), 'Negative control must remove an actual explicit include')
  const parsed = ts.parseJsonConfigFileContent(
    { ...config, include: include.filter(entry => entry !== omitted) }, ts.sys, repository, undefined, configPath,
  )
  assert.deepEqual(parsed.errors, [])
  assert.equal(parsed.options.composite, true, 'The real Client aggregate must retain composite checking')
  assert.equal(parsed.options.strict, true, 'The real Client aggregate must retain strict checking')
  return parsed.fileNames.map(file => relative(repository, file).split(sep).join('/'))
}

function assertClientUsageRoots(files: readonly string[]): void {
  for (const file of [rendererUsageTest, ...sharedUsageFixtures]) {
    assert(files.includes(file), `Client aggregate must list ${file}`)
  }
}

describe('Project Reference compiler faces', () => {
  it('lists the real native statistics test and its dependency-free browser measurement leaf', () => {
    const files = clientUsageRoots()
    expect(files).toContain(nativeStatsTest)
    expect(files).toContain(nativeBrowserFixture)
    expect(files).not.toContain('apps/desktop/tests/fixtures/native-composer-geometry.ts')
    expect(files).not.toContain('apps/desktop/tests/fixtures/native-composer-errors.ts')
  })

  it('detects omission of the native browser leaf without losing the real component or positive fixtures', () => {
    const files = clientUsageRoots(nativeBrowserFixture)
    expect(files).toContain(nativeStatsTest)
    expect(files).not.toContain(nativeBrowserFixture)
    assertClientUsageRoots(files)
    expect(() => { assert(files.includes(nativeBrowserFixture), 'Missing native browser root') }).toThrow('Missing native browser root')
  })

  it('lists the real renderer test and both shared Desktop leaves in the actual composite Client aggregate', () => {
    assertClientUsageRoots(clientUsageRoots())
  })

  it.each(sharedUsageFixtures)('detects the missing composite Client root when %s is removed', (omitted) => {
    const files = clientUsageRoots(omitted)
    expect(files).toContain(rendererUsageTest)
    expect(files).not.toContain(omitted)
    for (const retained of sharedUsageFixtures.filter(file => file !== omitted)) expect(files).toContain(retained)
    expect(() => { assertClientUsageRoots(files) }).toThrow(`Client aggregate must list ${omitted}`)
  })

  it('allows neutral projects in either graph and matching split leaves', () => {
    const root = workspaceFixture({
      host: ['./packages/core/shared', './packages/api/split/tsconfig.host.json'],
      client: ['./packages/core/shared', './packages/api/split/tsconfig.client.json'],
    })

    expect(collectProjectReferenceFaceViolations(root)).toEqual([])
  })

  it('rejects the opposite leaf and the solution root of a split project', () => {
    const root = workspaceFixture({
      host: [
        './packages/api/split/tsconfig.host.json',
        './packages/api/split/tsconfig.client.json',
      ],
      client: ['./packages/api/split'],
    })

    expect(collectProjectReferenceFaceViolations(root)).toEqual([
      'tsconfig.client.json: Project Reference "./packages/api/split" enters split project packages/api/split from a Client config; reference "packages/api/split/tsconfig.client.json" instead',
      'tsconfig.host.json: Project Reference "./packages/api/split/tsconfig.client.json" enters split project packages/api/split from a Host config; reference "packages/api/split/tsconfig.host.json" instead',
    ])
  })

  it('uses the referencing project face throughout the reachable graph', () => {
    const root = workspaceFixture({
      host: ['./packages/core/host-consumer'],
      client: ['./packages/core/client-consumer'],
    })
    const hostConsumer = join(root, 'packages/core/host-consumer')
    mkdirSync(hostConsumer, { recursive: true })
    writeJson(join(hostConsumer, 'package.json'), { name: '@deepseek-ai/dsh-host-consumer' })
    writeJson(join(hostConsumer, 'tsconfig.json'), {
      extends: '../../../tsconfig.base.json',
      references: [{ path: '../../api/split/tsconfig.client.json' }],
    })
    const clientConsumer = join(root, 'packages/core/client-consumer')
    mkdirSync(clientConsumer, { recursive: true })
    writeJson(join(clientConsumer, 'package.json'), { name: '@deepseek-ai/dsh-client-consumer' })
    writeJson(join(clientConsumer, 'tsconfig.json'), {
      extends: '../../../tsconfig.base.client.json',
      references: [{ path: '../../api/split/tsconfig.host.json' }],
    })

    expect(collectProjectReferenceFaceViolations(root)).toEqual([
      'packages/core/client-consumer/tsconfig.json: Project Reference "../../api/split/tsconfig.host.json" enters split project packages/api/split from a Client config; reference "packages/api/split/tsconfig.client.json" instead',
      'packages/core/host-consumer/tsconfig.json: Project Reference "../../api/split/tsconfig.client.json" enters split project packages/api/split from a Host config; reference "packages/api/split/tsconfig.host.json" instead',
    ])
  })
})
