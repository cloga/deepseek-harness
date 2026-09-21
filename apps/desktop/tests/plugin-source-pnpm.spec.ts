import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { c } from 'tar'
import { expect, it } from 'vitest'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { readDesktopPackageLocks } from '../src/plugin-package-lock.ts'
import { readDesktopPluginReceipts } from '../src/plugin-receipts.ts'
import { createDesktopProfilePackageTransactions } from '../src/profile-package-staging.ts'
import { packDesktopSourceDirectory, runDesktopPackagePnpm } from '../src/profile-package-pnpm.ts'
import { inventoryDesktopRuntime } from '../src/runtime-tree.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

function candidate(profile: string, id: string): string {
  return join(dirname(profile), `.${basename(profile)}.package-stage-${id}`, 'profile')
}

async function fixture(root: string, fetcher: typeof fetch) {
  const dsh = join(root, 'dsh')
  runtimeFixture(dsh)
  const pnpm = process.env.DSH_TEST_DESKTOP_PNPM ?? join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs')
  const installed = JSON.parse(readFileSync(join(dirname(dirname(pnpm)), 'package.json'), 'utf8')) as { version?: unknown }
  expect(installed.version).toBe('11.7.0')
  const runtime = { node: process.execPath, nodeBin: dirname(process.execPath), pnpm }
  const manager = new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), { dsh })
  await manager.applyRelease()
  const backend = (profile: string) => createDesktopProfilePackageTransactions({
    profile, legacyStateRoot: manager.paths.legacyStateRoot, runtimeDir: dsh, installAnchor: join(dsh, 'node_modules/@deepseek-ai/dsh/package.json'),
    dependencyRegistry: 'https://registry.example.test/', configPaths: [], fetcher,
    operationTimeoutMs: 60000, leaseWaitMs: 0,
    // Test transport is offline; production continues to use its explicit registry policy.
    pnpmRunner: request => runDesktopPackagePnpm(runtime, { ...request, args: [...request.args, '--offline'] }),
    packDirectory: (directory, archive, signal) => packDesktopSourceDirectory(runtime, directory, archive, signal),
  })
  return { profile: manager.paths.profile, backend }
}

// Preparation evidence only, not Host health or activation. Native activation has its
// own controller suite; bundle toggles belong to the official Plugin Manager.
it.each(['directory', 'link', 'tarball', 'github', 'remoteTarball'] as const)(
  'prepares a %s snapshot and separate removal through real pnpm without source hooks', async (kind) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-source-pnpm-')))
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
      let sourceAvailable = true
      const fetcher: typeof fetch = async (input) => {
        if (!sourceAvailable) throw new Error('source unavailable after preparation')
        const url = new URL(input instanceof Request ? input.url : input)
        if (url.pathname === '/repos/example/repository-not-package-name/commits/main') return Response.json({ sha: commit })
        if (url.pathname === `/repos/example/repository-not-package-name/tarball/${commit}` || url.href === 'https://downloads.example/plugin.tgz') {
          return new Response(new Uint8Array(readFileSync(archive)))
        }
        throw new Error(`unexpected source fetch ${url.href}`)
      }
      const f = await fixture(root, fetcher)
      const specs = {
        directory: source, link: `link:${source}`, tarball: archive,
        github: 'github:example/repository-not-package-name#main', remoteTarball: 'https://downloads.example/plugin.tgz',
      }
      const spec = specs[kind]
      const before = inventoryDesktopRuntime(f.profile)
      const id = randomUUID()
      const prepared = await f.backend(f.profile).stage(id, {
        kind: 'install', source: { schemaVersion: 1, type: 'packageSpec', spec },
      }, new AbortController().signal)
      expect(prepared).toMatchObject({ transactionId: id, state: 'prepared', packageName: 'memory-like-plugin', health: 'pending' })
      const staged = candidate(f.profile, id)
      const lock = readDesktopPackageLocks(staged)['memory-like-plugin']!
      expect(lock).toMatchObject({ packageName: 'memory-like-plugin', version: '1.0.0', spec })
      expect(lock.sha256).toMatch(/^[a-f0-9]{64}$/u)
      expect(lock.commit).toBe(kind === 'github' ? commit : undefined)
      expect(existsSync(join(staged, '.desktop-plugin-artifacts', `${lock.sha256}.tgz`))).toBe(true)
      expect(readFileSync(join(staged, 'node_modules/memory-like-plugin/index.js'), 'utf8')).toContain('identity')
      expect(readDesktopPluginReceipts(staged).receipts['memory-like-plugin']).toBeUndefined()
      expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
      expect(existsSync(sentinel)).toBe(false)
      expect(readFileSync(join(source, 'package.json'), 'utf8')).toBe(beforeManifest)
      const manifest = JSON.parse(readFileSync(join(staged, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>
        dsh: { profile: { bundles: string[] } }
      }
      expect(manifest.dependencies['memory-like-plugin']).toBe(`file:.desktop-plugin-artifacts/${lock.sha256}.tgz`)
      expect(manifest.dsh.profile.bundles.filter(name => name === 'memory-like-plugin')).toHaveLength(1)
      rmSync(source, { recursive: true, force: true })
      rmSync(archive)
      sourceAvailable = false
      // Bind the materialized candidate as separate test input, not a promoted live
      // profile. No Host callback or activation/health receipt is fabricated.
      const stagedBefore = inventoryDesktopRuntime(staged)
      const removal = randomUUID()
      expect(await f.backend(staged).stage(removal, { kind: 'remove', name: 'memory-like-plugin' }, new AbortController().signal))
        .toMatchObject({ state: 'prepared', health: 'pending' })
      const removed = candidate(staged, removal)
      expect(readDesktopPackageLocks(removed)).toEqual({})
      const removedManifest = JSON.parse(readFileSync(join(removed, 'package.json'), 'utf8')) as { dependencies: unknown }
      expect(removedManifest.dependencies).toEqual({})
      expect(existsSync(join(removed, 'node_modules/memory-like-plugin'))).toBe(false)
      expect(inventoryDesktopRuntime(staged)).toEqual(stagedBefore)
      expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
      expect(existsSync(sentinel)).toBe(false)
    } finally { rmSync(root, { recursive: true, force: true }) }
  }, 90000)

it.each(['preinstall', 'install', 'postinstall'] as const)('does not grant a source named koffi permission to run %s', async (hook) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-source-build-grant-')))
  try {
    const sentinel = join(root, 'unreviewed-source-build')
    const source = writePackage(root, 'unrelated-repository-name', {
      name: 'koffi', dsh: { bundle: { patch: 'bundle.yml' } }, scripts: { [hook]: 'node hook.cjs' },
    })
    writeFileSync(join(source, 'bundle.yml'), '[]\n')
    writeFileSync(join(source, 'hook.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(sentinel)}, 'executed')\n`)
    const f = await fixture(root, async () => { throw new Error('unexpected acquisition fetch') })
    const before = inventoryDesktopRuntime(f.profile)
    await expect(f.backend(f.profile).stage(randomUUID(), {
      kind: 'install', source: { schemaVersion: 1, type: 'packageSpec', spec: source },
    }, new AbortController().signal)).rejects.toThrow(`${hook} lifecycle scripts`)
    expect(existsSync(sentinel)).toBe(false)
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
    expect(readDesktopPackageLocks(f.profile)).toEqual({})
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 90000)
