import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import { c } from 'tar'
import { expect, it } from 'vitest'
import { boot, readProfilePatches, withProfilePackageLease, type ProfileContext } from '@deepseek-ai/dsh-app-boot'
import PluginManager from '@deepseek-ai/dsh-plugin-manager'
import { DesktopProjectManager } from '../src/project-manager.ts'
import { DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, type DesktopGithubReleasePluginSource } from '../src/plugin-source.ts'
import { createDesktopProfilePackageTransactions } from '../src/profile-package-staging.ts'
import { packDesktopSourceDirectory, runDesktopPackagePnpm } from '../src/profile-package-pnpm.ts'
import { inventoryDesktopRuntime } from '../src/runtime-tree.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

interface FixtureManifest {
  dependencies: Record<string, string>
  dsh: { profile: { bundles: string[] } }
}
function readManifest(path: string): FixtureManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as FixtureManifest
}

interface FixtureLock {
  importers: Record<string, { dependencies?: Record<string, { specifier: string; version: unknown }> }>
  packages?: Record<string, unknown>
  snapshots?: Record<string, unknown>
}
function readLock(path: string): FixtureLock {
  return load(readFileSync(path, 'utf8'), { schema: JSON_SCHEMA }) as FixtureLock
}
function candidate(profile: string, id: string): string {
  return join(dirname(profile), `.${basename(profile)}.package-stage-${id}`, 'profile')
}

// Real acquisition/pnpm preparation supplies test input graphs, not Host health.
// The receipt below is explicitly fixture data for normalization/ownership checks.
// Official selection-only toggles do not invoke pnpm or repair its lockfile.
it.each(['add', 'toggle', 'remove'] as const)('handles receipt-bound legacy separators through the current %s owner', async (action) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-legacy-lock-pnpm-')))
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
    let acquisitionAllowed = true
    const fetcher: typeof fetch = async (input) => {
      if (!acquisitionAllowed) throw new Error('legacy normalization must not request a new release')
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
    const pnpm = process.env.DSH_TEST_DESKTOP_PNPM ?? join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs')
    const installed = JSON.parse(readFileSync(join(dirname(dirname(pnpm)), 'package.json'), 'utf8')) as { version?: unknown }
    expect(installed.version).toBe('11.7.0')
    const runtime = { node: process.execPath, nodeBin: dirname(process.execPath), pnpm }
    const capture = join(root, 'before-first-frozen.yaml')
    const captureManifest = join(root, 'before-first-frozen-package.json')
    let capturing = false
    let invocations = 0
    const backend = (profile: string) => createDesktopProfilePackageTransactions({
      profile, legacyStateRoot: join(root, '.dsh', 'desktop'), runtimeDir: dsh, installAnchor: join(dsh, 'node_modules/@deepseek-ai/dsh/package.json'),
      dependencyRegistry: 'https://registry.example.test/', configPaths: [], fetcher,
      operationTimeoutMs: 60000, leaseWaitMs: 0,
      packDirectory: (directory, output, signal) => packDesktopSourceDirectory(runtime, directory, output, signal),
      pnpmRunner: async (request) => {
        invocations++
        if (capturing && request.args.includes('--frozen-lockfile') && !existsSync(capture)) {
          writeFileSync(capture, readFileSync(join(request.cwd, 'pnpm-lock.yaml')), { flag: 'wx' })
          writeFileSync(captureManifest, readFileSync(join(request.cwd, 'package.json')), { flag: 'wx' })
        }
        return runDesktopPackagePnpm(runtime, { ...request, args: [...request.args, '--offline'] })
      },
    })
    const initializer = new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), { dsh })
    await initializer.applyRelease()
    const profile = initializer.paths.profile
    const operations = backend(profile)
    const originalBytes = inventoryDesktopRuntime(profile)
    // Adopt only fixture seed graphs through validated real swaps at the fixed profile.
    // Re-staging inside a prior candidate incorrectly compounds private stage paths.
    const adoptSeed = (id: string, unchanged: ReturnType<typeof inventoryDesktopRuntime>) => withProfilePackageLease(profile, async () => {
      expect(inventoryDesktopRuntime(profile)).toEqual(unchanged)
      const input = await operations.readPreparedForActivation(id)
      if (input === undefined) throw new Error('fixture seed is not prepared')
      expect(input.owner.profile).toBe(profile)
      expect(input.prepared).toMatchObject({ state: 'prepared', health: 'pending' })
      expect(input.candidateDir).toBe(candidate(profile, id))
      expect(dirname(input.transactionDir)).toBe(dirname(profile))
      await operations.verifyActivationTree(id, 'candidate')
      renameSync(profile, input.rollbackDir)
      renameSync(input.candidateDir, profile)
      await operations.verifyActivationTree(id, 'active')
      await operations.verifyActivationTree(id, 'rollback')
      expect(inventoryDesktopRuntime(input.rollbackDir)).toEqual(unchanged)
      return input.rollbackDir
    }, 0)
    const seed = randomUUID()
    expect(await operations.stage(seed, { kind: 'install', source }, new AbortController().signal))
      .toMatchObject({ state: 'prepared', health: 'pending' })
    const firstRollback = await adoptSeed(seed, originalBytes)
    // Fixture-only committed-receipt shape: real source bytes were acquired above,
    // but this test neither starts a Host nor claims production activation health.
    // Write it only after the sealed candidate has been adopted and verified.
    writeFileSync(join(profile, 'desktop-plugin-receipts.json'), JSON.stringify({ schemaVersion: 1,
      receipts: { [name]: { schemaVersion: 1, capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
        source, releaseId: 2, assetId: 1, packageName: name, version: '1.0.0', artifactSha256: source.sha256,
        states: { staged: true, health: 'passed', activated: true, rolledBack: false, verified: true } } }, owners: { [name]: 'user' } }))
    writeFileSync(join(profile, 'desktop-plugin-package-locks.json'), JSON.stringify({ schemaVersion: 1, packages: {} }))
    const removable = writePackage(root, 'removable-source', { name: 'removable-source-plugin', dsh: { bundle: { patch: 'bundle.yml' } } })
    writeFileSync(join(removable, 'bundle.yml'), '[]\n')
    const beforeSecondSeed = inventoryDesktopRuntime(profile)
    const secondId = randomUUID()
    expect(await operations.stage(secondId, { kind: 'install', source: { schemaVersion: 1, type: 'packageSpec', spec: removable } }, new AbortController().signal))
      .toMatchObject({ state: 'prepared', health: 'pending' })
    const secondRollback = await adoptSeed(secondId, beforeSecondSeed)
    const manifestPath = join(profile, 'package.json')
    const originalManifest = readManifest(manifestPath)
    const lockPath = join(profile, 'pnpm-lock.yaml')
    const expected = readLock(lockPath)
    const legacy = readLock(lockPath)
    const entry = legacy.importers['.']?.dependencies?.[name]
    if (entry === undefined) throw new Error('fixture has no root dependency')
    const canonical = `file:.desktop-plugin-artifacts/${source.sha256}.tgz`
    expect(entry.specifier).toBe(canonical)
    entry.specifier = canonical.replaceAll('/', '\\')
    writeFileSync(lockPath, dump(legacy, { schema: JSON_SCHEMA, lineWidth: -1, noRefs: true }))
    const seededLock = readFileSync(lockPath, 'utf8')
    const receiptBytes = readFileSync(join(profile, 'desktop-plugin-receipts.json'), 'utf8')
    const sourceLockBytes = readFileSync(join(profile, 'desktop-plugin-package-locks.json'), 'utf8')
    const before = inventoryDesktopRuntime(profile)
    acquisitionAllowed = false
    capturing = true
    if (action === 'toggle') {
      const profileContext: ProfileContext = {
        name: 'dsh', dir: profile, patchPath: join(profile, 'cordis.patch.yml'),
        installAnchor: join(dsh, 'node_modules/@deepseek-ai/dsh/package.json'),
        cwd: root, home: root, startedBundles: originalManifest.dsh.profile.bundles,
        stagedPackageTransactions: true, overlays: [], telemetryDisabledEnv: undefined,
      }
      const ctx = await boot('dsh', join(profile, 'cordis.yml'), readProfilePatches('dsh', profileContext), (ctx) => {
        ctx.provide('profileContext', profileContext)
        ctx.provide('profilePackageTransactions', operations)
        ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
      })
      try {
        // Await the ordinary public plugin startup barrier before any disposal.
        await ctx.plugin(PluginManager)
        const count = invocations
        expect(await ctx.pluginManager.setBundleEnabled(name, false)).toMatchObject({ changed: true })
        expect((await ctx.pluginManager.listBundles()).find(item => item.name === name)?.enabled).toBe(false)
        expect(await ctx.pluginManager.setBundleEnabled(name, true)).toMatchObject({ changed: true })
        expect((await ctx.pluginManager.listBundles()).find(item => item.name === name)?.enabled).toBe(true)
        expect(invocations).toBe(count)
        expect(existsSync(capture)).toBe(false)
        expect(readFileSync(lockPath, 'utf8')).toBe(seededLock)
        expect(readFileSync(join(profile, 'desktop-plugin-receipts.json'), 'utf8')).toBe(receiptBytes)
        expect(readFileSync(join(profile, 'desktop-plugin-package-locks.json'), 'utf8')).toBe(sourceLockBytes)
        expect(readManifest(manifestPath).dependencies).toEqual(originalManifest.dependencies)
      } finally { await ctx.fiber.dispose() }
    } else {
      const added = writePackage(root, 'addon', { name: 'new-source-plugin', dsh: { bundle: { patch: 'bundle.yml' } } })
      writeFileSync(join(added, 'bundle.yml'), '[]\n')
      const id = randomUUID()
      expect(await operations.stage(id, action === 'add'
        ? { kind: 'install', source: { schemaVersion: 1, type: 'packageSpec', spec: added } }
        : { kind: 'remove', name: 'removable-source-plugin' }, new AbortController().signal))
        .toMatchObject({ state: 'prepared', health: 'pending' })
      // These are the actual inputs immediately before the real frozen pnpm call,
      // not a final lockfile that pnpm may subsequently have normalized itself.
      expect(readLock(capture).importers['.']?.dependencies?.[name]).toEqual(expected.importers['.']?.dependencies?.[name])
      const capturedDependencies = readManifest(captureManifest).dependencies
      expect(capturedDependencies[name]).toBe(canonical)
      expect(Object.keys(capturedDependencies).sort()).toEqual(action === 'add' ? [name, 'removable-source-plugin'].sort() : [name])
      const staged = candidate(profile, id)
      expect(readFileSync(join(staged, 'desktop-plugin-receipts.json'), 'utf8')).toBe(receiptBytes)
      const stagedManifest = readManifest(join(staged, 'package.json'))
      expect(stagedManifest.dependencies[name]).toBe(canonical)
      expect(stagedManifest.dependencies['removable-source-plugin'] !== undefined).toBe(action !== 'remove')
      expect(stagedManifest.dependencies['new-source-plugin'] !== undefined).toBe(action === 'add')
      expect(inventoryDesktopRuntime(profile)).toEqual(before)
      expect(readFileSync(lockPath, 'utf8')).toBe(seededLock)
    }
    expect(inventoryDesktopRuntime(firstRollback)).toEqual(originalBytes)
    expect(inventoryDesktopRuntime(secondRollback)).toEqual(beforeSecondSeed)
  } finally { rmSync(root, { recursive: true, force: true }) }
}, 120000)
