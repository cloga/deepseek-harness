import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { c } from 'tar'
import { expect, it } from 'vitest'
import { DesktopProjectManager, type DesktopProjectHooks } from '../src/project-manager.ts'
import { readDesktopPackageLocks } from '../src/plugin-package-lock.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'
import { observeFixturePnpm } from './pnpm-fixture-observer.ts'

// Offline, zero-dependency scenarios budget packing and several fresh pnpm processes, not network retries.
it.each(['directory', 'link', 'tarball', 'github', 'remoteTarball'] as const)('installs and removes a %s snapshot through real pnpm without source preparation', async (kind) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-source-pnpm-')))
  const observer = observeFixturePnpm(root, join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs'), 'memory-like-plugin', true)
  const originalFetch = globalThis.fetch
  try {
    const sentinel = join(root, 'source-hook-executed')
    const source = writePackage(root, 'repository-not-package-name', {
      name: 'memory-like-plugin', private: true, packageManager: 'pnpm@0.0.0',
      dsh: { bundle: { patch: 'bundle.yml' } },
      scripts: { pack: 'node hook.cjs', build: 'node hook.cjs', prepack: 'node hook.cjs', prepare: 'node hook.cjs', postpack: 'node hook.cjs' },
    })
    writeFileSync(join(source, 'hook.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed')\n`)
    writeFileSync(join(source, 'bundle.yml'), '[]\n')
    writeFileSync(join(source, '.pnpmfile.cjs'), 'throw new Error("source pnpm hook executed")\n')
    writeFileSync(join(source, '.npmrc'), 'ignore-scripts=false\npm-on-fail=download\n')
    writeFileSync(join(source, 'pnpm-workspace.yaml'), 'packages:\n  - .\nconfigDependencies:\n  should-never-be-fetched: 0.0.0\n')
    const beforeManifest = readFileSync(join(source, 'package.json'), 'utf8')
    const archive = join(root, 'input.tgz')
    await c({ cwd: source, file: archive, gzip: true, prefix: 'package/' }, [
      'package.json', 'index.js', 'bundle.yml', 'hook.cjs', '.pnpmfile.cjs', '.npmrc', 'pnpm-workspace.yaml',
    ])
    const commit = 'b'.repeat(40)
    globalThis.fetch = async (input) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname === '/repos/example/repository-not-package-name/commits/main') return Response.json({ sha: commit })
      if (url.pathname === `/repos/example/repository-not-package-name/tarball/${commit}` || url.href === 'https://downloads.example/plugin.tgz') return new Response(readFileSync(archive))
      throw new Error(`unexpected source fetch ${url.href}`)
    }
    const dsh = join(root, 'dsh')
    runtimeFixture(dsh)
    const manager = new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), {
      node: process.execPath, pnpm: observer.entry, dsh,
    })
    await manager.applyRelease()
    let healthChecks = 0
    const hooks: DesktopProjectHooks = {
      beforeChange: async () => {}, afterChange: async () => {},
      healthCheck: async (staged) => {
        healthChecks++
        expect(readFileSync(join(staged, 'node_modules/memory-like-plugin/index.js'), 'utf8')).toContain('identity')
      },
    }
    const specs = {
      directory: source, link: `link:${source}`, tarball: archive,
      github: 'github:example/repository-not-package-name#main', remoteTarball: 'https://downloads.example/plugin.tgz',
    }
    const spec = specs[kind]
    await manager.mutate({ type: 'plugin-add', spec }, hooks)
    expect(healthChecks).toBe(1)
    expect(manager.listPlugins()).toMatchObject([{
      name: 'memory-like-plugin', version: '1.0.0', enabled: true,
      source: { schemaVersion: 1, type: 'packageSpec', spec },
    }])
    expect(manager.listPlugins()[0]?.resolution?.sha256).toMatch(/^[a-f0-9]{64}$/u)
    const lock = readDesktopPackageLocks(manager.paths.profile)['memory-like-plugin']!
    expect(lock.commit).toBe(kind === 'github' ? commit : undefined)
    expect(existsSync(join(manager.paths.profile, '.desktop-plugin-artifacts', `${lock.sha256}.tgz`))).toBe(true)
    expect(existsSync(sentinel)).toBe(false)
    expect(readFileSync(join(source, 'package.json'), 'utf8')).toBe(beforeManifest)
    expect(existsSync(join(source, 'desktop-packages-pending'))).toBe(false)
    const installedManifest = JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>
      dsh: { profile: { bundles: string[] } }
    }
    expect(installedManifest.dependencies['memory-like-plugin']).toBe(`file:.desktop-plugin-artifacts/${lock.sha256}.tgz`)
    expect(installedManifest.dsh.profile.bundles.filter(name => name === 'memory-like-plugin')).toHaveLength(1)
    rmSync(source, { recursive: true, force: true })
    rmSync(archive)
    globalThis.fetch = async () => { throw new Error('source unavailable after initial installation') }
    await manager.mutate({ type: 'plugin-toggle', name: 'memory-like-plugin', enabled: false }, hooks)
    await manager.mutate({ type: 'plugin-toggle', name: 'memory-like-plugin', enabled: true }, hooks)
    expect(readDesktopPackageLocks(manager.paths.profile)['memory-like-plugin']).toEqual(lock)
    await expect(manager.applyRelease()).resolves.toBe(false)
    await expect(manager.mutate({ type: 'plugin-update', name: 'memory-like-plugin', version: '2.0.0' }, hooks)).rejects.toThrow('source-installed')
    expect(readDesktopPackageLocks(manager.paths.profile)['memory-like-plugin']).toEqual(lock)
    await manager.mutate({ type: 'plugin-remove', name: 'memory-like-plugin' }, {
      beforeChange: async () => {}, afterChange: async () => {}, healthCheck: async () => {},
    })
    expect(manager.listPlugins()).toEqual([])
    expect(readDesktopPackageLocks(manager.paths.profile)).toEqual({})
  } catch (error) {
    observer.reportFailure()
    throw error
  } finally {
    globalThis.fetch = originalFetch
    rmSync(root, { recursive: true, force: true })
  }
}, 90_000)

it.each(['preinstall', 'install', 'postinstall'] as const)('does not grant a source named koffi permission to run %s', async (hook) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-source-build-grant-')))
  try {
    const sentinel = join(root, 'unreviewed-source-build')
    const source = writePackage(root, 'unrelated-repository-name', {
      name: 'koffi', dsh: { bundle: { patch: 'bundle.yml' } }, scripts: { [hook]: 'node hook.cjs' },
    })
    writeFileSync(join(source, 'bundle.yml'), '[]\n')
    writeFileSync(join(source, 'hook.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed')\n`)
    const dsh = join(root, 'dsh')
    runtimeFixture(dsh)
    const pnpm = join(root, 'offline-pnpm.mjs')
    const realPnpm = pathToFileURL(join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs')).href
    writeFileSync(pnpm, `process.argv.push('--config.offline=true'); await import(${JSON.stringify(realPnpm)})\n`)
    const manager = new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), {
      node: process.execPath, pnpm, dsh,
    })
    await manager.applyRelease()
    await expect(manager.mutate({ type: 'plugin-add', spec: source }, {
      beforeChange: async () => { throw new Error('rejected source must not reach Host stop') },
      healthCheck: async () => { throw new Error('rejected source must not activate') },
      afterChange: async () => { throw new Error('rejected source must not restart Host') },
    })).rejects.toThrow(`${hook} lifecycle scripts`)
    expect(existsSync(sentinel)).toBe(false)
    expect(manager.listPlugins()).toEqual([])
  } finally { rmSync(root, { recursive: true, force: true }) }
})
