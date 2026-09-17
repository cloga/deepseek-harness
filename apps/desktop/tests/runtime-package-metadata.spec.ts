import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  DESKTOP_PACKAGE_METADATA_OPTIONS,
  normalizeDesktopRuntimePackageMetadata,
} from '../scripts/runtime-package-metadata.mjs'

const roots: string[] = []
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-package-metadata-'))
  roots.push(root)
  const runtime = join(root, 'prepared-dsh')
  const shell = join(root, 'shell')
  mkdirSync(runtime)
  mkdirSync(shell)
  const write = (path: string, content: string | Buffer): void => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return { root, runtime, shell, write }
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

describe('pre-seal Desktop package metadata normalization', () => {
  it('uses the same explicit script and keyword policy as the packager', () => {
    expect(DESKTOP_PACKAGE_METADATA_OPTIONS).toEqual({ removePackageScripts: true, removePackageKeywords: true })
  })

  it('normalizes copied nested package metadata once while retaining runtime fields and all other bytes', async () => {
    const f = fixture()
    const name = '@scope/example'
    const preserved = {
      name, version: '1.0.0', type: 'module', main: './index.js',
      exports: { '.': './index.js' }, imports: { '#internal': './internal.js' },
      dsh: { bundle: { patch: 'cordis.patch.yml' } },
      dependencies: { semver: '^7.8.5' }, peerDependencies: { '@deepseek-ai/cordis': '^4.0.0' },
      optionalDependencies: { 'optional-native': '1.0.0' }, config: { native: true },
      engines: { node: '>=22' }, bin: { example: './index.js' }, license: 'MIT',
    }
    const removed = {
      scripts: { install: 'never executed by normalization' }, keywords: ['fixture'],
      _id: 'registry metadata', _integrity: 'receipt metadata', bugs: { url: 'https://example.invalid/issues' },
      gitHead: 'source-revision', dist: { integrity: 'registry metadata' }, build: { native: true },
      jspm: {}, ava: {}, xo: {}, nyc: {}, eslintConfig: {}, contributors: [], bundleDependencies: [], tags: [], babel: {},
    }
    const manifest = join(f.runtime, 'node_modules', name, 'package.json')
    f.write(manifest, `${JSON.stringify({ ...preserved, ...removed }, undefined, 2)}\n`)
    const runtimeManifest = '{ "name": "runtime-root", "scripts": { "keep": "root is not the shell" } }\n'
    const shellManifest = '{ "name": "shell", "scripts": { "keep": "not in runtime" } }\n'
    f.write(join(f.runtime, 'package.json'), runtimeManifest)
    f.write(join(f.shell, 'package.json'), shellManifest)
    const untouched = new Map([
      ['node_modules/@scope/example/README.md', 'retained README\n'],
      ['node_modules/@scope/example/types.d.ts', 'export interface Preserved {}\n'],
      ['node_modules/@scope/example/.hidden', 'hidden bytes\n'],
      ['node_modules/@scope/example/test/fixture.js', 'test asset\n'],
      ['node_modules/@scope/example/addon.node', 'dummy native payload\n'],
      ['assets/package.json', '{ "scripts": { "keep": "non-module metadata" } }\n'],
    ])
    for (const [path, content] of untouched) f.write(join(f.runtime, path), content)
    expect(await normalizeDesktopRuntimePackageMetadata(f.runtime, f.shell)).toEqual(['node_modules/@scope/example/package.json'])
    const normalized = readFileSync(manifest, 'utf8')
    expect(normalized).toBe(JSON.stringify(preserved, undefined, 2))
    expect(normalized.endsWith('\n')).toBe(false)
    expect(await normalizeDesktopRuntimePackageMetadata(f.runtime, f.shell)).toEqual([])
    expect(readFileSync(manifest, 'utf8')).toBe(normalized)
    expect(readFileSync(join(f.runtime, 'package.json'), 'utf8')).toBe(runtimeManifest)
    expect(readFileSync(join(f.shell, 'package.json'), 'utf8')).toBe(shellManifest)
    for (const [path, content] of untouched) expect(readFileSync(join(f.runtime, path), 'utf8')).toBe(content)
    expect(existsSync(join(f.runtime, 'desktop-runtime.json'))).toBe(false)
  })

  it('handles transitive node_modules and retains babel configuration when its dependency needs it', async () => {
    const f = fixture()
    const path = join(f.runtime, 'node_modules', 'outer', 'node_modules', 'inner', 'package.json')
    const kept = { name: 'inner', version: '1.0.0', dependencies: { 'babel-core': '6.26.3' }, babel: { presets: ['fixture'] } }
    f.write(path, JSON.stringify({ ...kept, scripts: { test: 'unused' }, bugs: 'removed' }))
    expect(await normalizeDesktopRuntimePackageMetadata(f.runtime, f.shell)).toEqual(['node_modules/outer/node_modules/inner/package.json'])
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(kept)
    expect(await normalizeDesktopRuntimePackageMetadata(f.runtime, f.shell)).toEqual([])
  })

  it('preserves formatting and trailing newlines when the transformer makes no change', async () => {
    const f = fixture()
    const path = join(f.runtime, 'node_modules', 'plain', 'package.json')
    const original = '{ "name": "plain", "version": "1.0.0", "dsh": {} }\n'
    f.write(path, original)
    expect(await normalizeDesktopRuntimePackageMetadata(f.runtime, f.shell)).toEqual([])
    expect(readFileSync(path, 'utf8')).toBe(original)
  })

  it('refuses an already sealed runtime instead of updating either manifest or descriptor', async () => {
    const f = fixture()
    const path = join(f.runtime, 'node_modules', 'plain', 'package.json')
    const original = '{"name":"plain","scripts":{"test":"unused"}}\n'
    f.write(path, original)
    f.write(join(f.runtime, 'desktop-runtime.json'), 'sealed descriptor bytes\n')
    await expect(normalizeDesktopRuntimePackageMetadata(f.runtime, f.shell)).rejects.toThrow(/seal|descriptor|desktop-runtime/iu)
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(readFileSync(join(f.runtime, 'desktop-runtime.json'), 'utf8')).toBe('sealed descriptor bytes\n')
  })

  it.each(['root', 'package-directory', 'package-manifest'] as const)('rejects a linked %s without writing its target', async (kind) => {
    const f = fixture()
    const target = join(f.root, 'external')
    mkdirSync(target)
    const original = '{"name":"external","scripts":{"test":"unused"}}\n'
    f.write(join(target, 'package.json'), original)
    const path = kind === 'root' ? join(f.root, 'linked-runtime')
      : kind === 'package-directory' ? join(f.runtime, 'node_modules', 'external')
        : join(f.runtime, 'node_modules', 'external', 'package.json')
    mkdirSync(dirname(path), { recursive: true })
    // Junctions require no Windows symlink privileges and are rejected before traversing their target.
    symlinkSync(process.platform === 'win32' || kind !== 'package-manifest' ? target : join(target, 'package.json'), path,
      process.platform === 'win32' ? 'junction' : kind === 'package-manifest' ? 'file' : 'dir')
    await expect(normalizeDesktopRuntimePackageMetadata(kind === 'root' ? path : f.runtime, f.shell)).rejects.toThrow(/link|regular|directory/iu)
    expect(readFileSync(join(target, 'package.json'), 'utf8')).toBe(original)
  })
})
