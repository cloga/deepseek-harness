import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import { c } from 'tar'
import { expect, it } from 'vitest'
import { DesktopProjectManager, type DesktopProjectMutation } from '../src/project-manager.ts'
import type { DesktopGithubReleasePluginSource } from '../src/plugin-source.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

interface FixtureLock {
  importers: Record<string, { dependencies?: Record<string, { specifier: string; version: unknown }> }>
  packages?: Record<string, unknown>
  snapshots?: Record<string, unknown>
}

function readLock(path: string): FixtureLock {
  return load(readFileSync(path, 'utf8'), { schema: JSON_SCHEMA }) as FixtureLock
}

const hooks = { beforeChange: async () => {}, healthCheck: async () => {}, afterChange: async () => {} }

// Each offline case includes a real verified install and a separate ordinary mutation of the legacy profile.
it.each(['add', 'toggle', 'remove'] as const)('repairs an existing receipt-bound separator mismatch before ordinary %s frozen install', async (action) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-legacy-lock-pnpm-')))
  const originalFetch = globalThis.fetch
  try {
    const name = 'legacy-verified-plugin'
    const packageDir = writePackage(root, 'source', { name, dsh: { bundle: { patch: 'bundle.yml' } } })
    writeFileSync(join(packageDir, 'bundle.yml'), '[]\n')
    const archive = join(root, 'source.tgz')
    await c({ file: archive, cwd: packageDir, prefix: 'package', gzip: true }, ['package.json', 'index.js', 'bundle.yml'])
    const bytes = readFileSync(archive)
    const source: DesktopGithubReleasePluginSource = {
      schemaVersion: 1, type: 'githubRelease', owner: 'example', repo: 'legacy', tag: 'v1.0.0',
      asset: 'plugin.tgz', assetId: 1, packageName: name, version: '1.0.0', size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'), targetCommit: 'a'.repeat(40),
    }
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname.endsWith('/releases/tags/v1.0.0')) return Response.json({
        id: 2, immutable: true, draft: false, tag_name: source.tag, target_commitish: source.targetCommit,
        assets: [{ id: 1, name: source.asset, state: 'uploaded', size: bytes.byteLength, digest: `sha256:${source.sha256}` }],
      })
      if (url.pathname.endsWith('/git/ref/tags/v1.0.0')) return Response.json({ object: { type: 'commit', sha: source.targetCommit } })
      if (url.pathname.endsWith('/releases/assets/1')) return new Response(new Uint8Array(bytes))
      throw new Error(`unexpected fixture request ${url.href}`)
    }
    const dsh = join(root, 'dsh')
    runtimeFixture(dsh)
    const capture = join(root, 'before-first-frozen.yaml')
    const captureManifest = join(root, 'before-first-frozen-package.json')
    const pnpm = join(root, 'offline-pnpm.mjs')
    const realPnpm = pathToFileURL(join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs')).href
    writeFileSync(pnpm, `import {existsSync,readFileSync,writeFileSync} from 'node:fs'
import {join} from 'node:path'
if (process.argv.includes('--frozen-lockfile') && !existsSync(${JSON.stringify(capture)})) {
  writeFileSync(${JSON.stringify(capture)}, readFileSync(join(process.cwd(),'pnpm-lock.yaml')), {flag:'wx'})
  writeFileSync(${JSON.stringify(captureManifest)}, readFileSync(join(process.cwd(),'package.json')), {flag:'wx'})
}
process.argv.push('--config.offline=true')
await import(${JSON.stringify(realPnpm)})
`)
    const manager = new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), { node: process.execPath, pnpm, dsh })
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-install', source }, hooks)
    expect(existsSync(capture)).toBe(false)
    const manifestPath = join(manager.paths.profile, 'package.json')
    const originalManifest = readFileSync(manifestPath, 'utf8')
    const lockPath = join(manager.paths.profile, 'pnpm-lock.yaml')
    const expected = readLock(lockPath)
    const legacy = readLock(lockPath)
    const importer = Object.values(legacy.importers)[0]
    const entry = importer?.dependencies?.[name]
    if (entry === undefined) throw new Error('fixture has no root dependency')
    const canonical = `file:.desktop-plugin-artifacts/${source.sha256}.tgz`
    expect(entry.specifier).toBe(canonical)
    entry.specifier = canonical.replaceAll('/', '\\')
    writeFileSync(lockPath, dump(legacy, { schema: JSON_SCHEMA, lineWidth: -1, noRefs: true }))
    const seeded = readFileSync(lockPath, 'utf8')
    expect(seeded).toContain(entry.specifier)
    expect(readFileSync(manifestPath, 'utf8')).toBe(originalManifest)
    globalThis.fetch = async () => { throw new Error('legacy normalization must not request a new release') }
    const added = writePackage(root, 'addon', { name: 'new-source-plugin', dsh: { bundle: { patch: 'bundle.yml' } } })
    writeFileSync(join(added, 'bundle.yml'), '[]\n')
    const addedArchive = join(root, 'addon.tgz')
    await c({ file: addedArchive, cwd: added, prefix: 'package', gzip: true }, ['package.json', 'index.js', 'bundle.yml'])
    const mutation: DesktopProjectMutation = action === 'add'
      ? { type: 'plugin-add', spec: addedArchive }
      : action === 'toggle'
        ? { type: 'plugin-toggle', name, enabled: false }
        : { type: 'plugin-remove', name }
    await manager.mutate(mutation, hooks)
    expect(existsSync(capture)).toBe(true)
    // This is the input seen by the actual pnpm process, not the final lock it later rewrites.
    expect(readLock(capture)).toEqual(expected)
    expect(readFileSync(captureManifest, 'utf8')).toBe(originalManifest)
    if (action === 'remove') expect(manager.listPlugins()).toEqual([])
    else {
      const retained = manager.listPlugins().find(plugin => plugin.name === name)
      expect(retained?.version).toBe('1.0.0')
      expect(retained?.enabled).toBe(action !== 'toggle')
      expect(retained?.source).toEqual(source)
    }
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)
