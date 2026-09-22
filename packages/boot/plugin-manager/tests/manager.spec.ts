/** Persistent manager behavior through a real profile Include and Loader. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import {
  boot, composeEntries, initProfile, readProfilePatches, readProfileManifest, reconcileProfilePatches,
  OPTIONAL_BUNDLES, ProfilePackageCancelledError, withProfilePackageLease,
  type ProfileContext, type ProfilePackageTransactions, type ProfilePreparedBundleSelection,
  type ProfilePreparedPackageChange, type ProfileVerifiedReleaseSource,
} from '@deepseek-ai/dsh-app-boot'
import PluginManager, { type Config, type PluginChange, type PluginInstallLogChunk, type PluginInstallProgress, type PluginInstallRequestId } from '../src/index.ts'
import Hmr from '@deepseek-ai/dsh-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { Group } from '@deepseek-ai/cordis-plugin-loader'
import * as operations from '../src/operations.ts'
import * as buildApproval from '../src/build-approval.ts'
import * as atomicWrite from '@deepseek-ai/dsh-atomic-write'
import { parse, parseDocument } from 'yaml'

async function fixture(reload: 'live' | 'startup' = 'live', overlay = false, prepare?: (ctx: Context) => void, config: Config = {}, packageManager?: ProfileContext['packageManager'], stagedPackageTransactions?: boolean) {
  // pnpm resolves workspace roots through native realpath, including Windows 8.3 aliases.
  const home = await realpath(mkdtempSync(join(tmpdir(), 'plugin-manager-')))
  const dir = join(home, 'profiles', 'test')
  const anchor = join(home, 'package.json')
  writeFileSync(anchor, '{"name":"installation","dependencies":{}}\n')
  initProfile(dir, ['core', 'extra'])
  const bundle = (name: string, rows: unknown[]) => {
    const path = join(dir, 'node_modules', name)
    mkdirSync(path, { recursive: true })
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    writeFileSync(join(path, 'cordis.patch.yml'), JSON.stringify([{ insert: rows }]))
    writeFileSync(join(path, 'plugin.mjs'), 'export function apply(ctx, config) { if (config?.fail) throw new Error("test activation failed"); ctx.provide(config?.service ?? "managedProbe", true) }\n')
  }
  bundle('core', [{ id: 'manager', name: 'cordis:manager', config }])
  bundle('extra', [{ id: 'managed', name: './plugin.mjs' }])
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { extra: '1.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'cordis.yml'), '[]\n')
  const overlays: PatchOptions[] = overlay ? [{ id: 'managed', disabled: true }] : []
  const profile: ProfileContext = {
    name: 'test',
    ...(packageManager === undefined ? {} : { packageManager }),
    ...(stagedPackageTransactions === undefined ? {} : { stagedPackageTransactions }),
    startedBundles: ['core', 'extra'],
    dir, patchPath: join(dir, 'cordis.patch.yml'), installAnchor: anchor, cwd: home, home,
    overlays, telemetryDisabledEnv: undefined,
  }
  const ctx = await boot('test', join(dir, 'cordis.yml'), readProfilePatches('test', profile), (ctx) => {
    ctx.provide('appReady', { onReady: (listener: () => void) => { listener(); return () => {} } })
    prepare?.(ctx)
    ctx.provide('profileContext', profile)
    ctx.loader.builtins.manager = PluginManager
  })
  onTestFinished(async () => { await ctx.fiber.dispose(); rmSync(home, { recursive: true, force: true }) })
  let stopHmr = async () => {}
  if (reload === 'live') {
    await ctx.plugin(Timer)
    const owner = await ctx.plugin(Hmr, { root: [], ignored: [], debounce: 0 })
    stopHmr = () => owner.dispose()
    await ctx.hmr.runExclusive(async () => {})
  }
  return { ctx, dir, manager: ctx.pluginManager, bundle, profile, stopHmr, overlays }
}

it('lists bundle versions and current-profile plugin targets', async () => {
  const { manager, dir } = await fixture()
  const plugins = await manager.listPlugins()
  expect(plugins.find(row => row.entryId === 'include:managed')).toMatchObject({ patchId: 'managed', enabled: true })
  expect(plugins.find(row => row.entryId === 'include:manager')?.readOnlyReason).toBe('management-required')
  expect(await manager.listBundles()).toEqual([
    {
      name: 'core', version: '1.0.0', enabled: true, installed: false, optional: false, removable: false, readOnlyReason: 'management-required',
      rows: [{ rowId: 'manager', moduleName: 'cordis:manager', entryId: 'include:manager' }], overrides: [],
    },
    {
      name: 'extra', version: '1.0.0', enabled: true, installed: true, optional: false, removable: true,
      rows: [{ rowId: 'managed', moduleName: pathToFileURL(join(dir, 'node_modules', 'extra', 'plugin.mjs')).href, entryId: 'include:managed' }], overrides: [],
    },
  ])
})

it('describes a bundle by its manifest and patch: one-liner, rows without a live entry, and the built-in rows it changes', async () => {
  const { manager, dir, bundle } = await fixture()
  bundle('described', [{ id: 'described-row', name: './plugin.mjs' }])
  writeFileSync(join(dir, 'node_modules', 'described', 'package.json'), JSON.stringify({
    name: 'described', version: '2.0.0', description: 'Describes itself.', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  // An anonymous row is not addressable and is left out of the rows.
  writeFileSync(join(dir, 'node_modules', 'described', 'cordis.patch.yml'), JSON.stringify([
    { insert: [{ id: 'described-row', name: './plugin.mjs' }, { name: './plugin.mjs' }] }, { id: 'managed', disabled: true }, { id: 'described-row', config: {} },
  ]))
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { ...manifest.dependencies, described: '2.0.0' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  const moduleName = pathToFileURL(join(dir, 'node_modules', 'described', 'plugin.mjs')).href
  expect((await manager.listBundles()).find(row => row.name === 'described')).toEqual({
    name: 'described', version: '2.0.0', description: 'Describes itself.', enabled: false, installed: true, optional: false, removable: true,
    rows: [{ rowId: 'described-row', moduleName }], overrides: ['managed'],
  })
  await manager.setBundleEnabled('described', true)
  expect((await manager.listBundles()).find(row => row.name === 'described')?.rows).toEqual([
    { rowId: 'described-row', moduleName, entryId: 'include:described-row' },
  ])
  // Off again, the rows lose their entries.
  await manager.setBundleEnabled('described', false)
  expect((await manager.listBundles()).find(row => row.name === 'described')?.rows).toEqual([{ rowId: 'described-row', moduleName }])
})

it('turns a plugin off and on without duplicating patch overrides', async () => {
  const { manager, dir } = await fixture()
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: true, application: 'applied' })
  expect((await manager.listPlugins()).find(row => row.entryId === id)?.enabled).toBe(false)
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: false, application: 'applied' })
  expect(await manager.setPluginEnabled(id, true)).toMatchObject({ changed: true, application: 'applied' })
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8').match(/id: managed/g)).toHaveLength(1)
})

it('retains installed dependencies when toggling a bundle and appends it when re-enabled', async () => {
  const { manager, dir, bundle } = await fixture()
  bundle('third', [])
  await manager.setBundleEnabled('third', true)
  expect(await manager.setBundleEnabled('extra', false)).toMatchObject({ changed: true, application: 'applied' })
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
  expect((await manager.listPlugins()).some(row => row.patchId === 'managed')).toBe(false)
  await manager.setBundleEnabled('extra', true)
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core', 'third', 'extra'])
})

it('reports an overlay overriding a saved plugin toggle', async () => {
  const { manager } = await fixture('live', true)
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, true)).toMatchObject({ changed: true, application: 'overridden' })
})

it('saves startup-only toggles and refuses removal of currently used packages', async () => {
  const { manager } = await fixture('startup')
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ application: 'restart-required' })
  expect((await manager.listPlugins()).find(row => row.entryId === id)?.enabled).toBe(true)
  await manager.setBundleEnabled('extra', false)
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: false, application: 'failed', error: { code: 'stop-profile' } })
})

it('refuses self-disable, unknown entries and removal of installation-owned bundles', async () => {
  const { manager } = await fixture()
  const id = (await manager.listPlugins()).find(row => row.entryId === 'include:manager')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: false, application: 'failed', error: { code: 'management-required' } })
  expect(await manager.setPluginEnabled('missing' as typeof id, true)).toMatchObject({ changed: false, application: 'failed', error: { code: 'unknown-plugin' } })
  expect(await manager.removeBundle('core')).toMatchObject({ changed: false, application: 'failed', error: { code: 'not-removable' } })
  // A name no bundle directory answers to fails with the resolver's own diagnostic.
  expect(await manager.setBundleEnabled('unknown', true)).toMatchObject({ changed: false, application: 'failed', error: { code: 'operation-error' } })
})

it('installs only valid bundle declarations and honors installation without activation', async () => {
  const { manager, dir, bundle } = await fixture()
  const initial = readProfileManifest('test', dir)
  delete initial.dependencies
  writeFileSync(join(dir, 'package.json'), JSON.stringify(initial))
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, args) => {
    const name = String(args[1])
    bundle(name, [{ id: name, name: './plugin.mjs', config: { service: name } }])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('new-bundle', { enabled: false })).toMatchObject({
    changed: true, application: 'applied', stage: 'enable', target: 'new-bundle', bundle: 'new-bundle', packageResult: { exitCode: 0 },
  })
  expect((await manager.listBundles()).find(row => row.name === 'new-bundle')?.enabled).toBe(false)
  expect(await manager.setBundleEnabled('new-bundle', true)).toMatchObject({ application: 'applied' })
  expect((await manager.listPlugins()).find(row => row.patchId === 'new-bundle')?.fiberPhase).toBe('active')
  expect(await manager.installBundle('another-bundle')).toMatchObject({ application: 'applied' })
  expect((await manager.listBundles()).find(row => row.name === 'another-bundle')?.enabled).toBe(true)
})

it('reports blocked scripts after a failed installation and retries only after explicit profile build approval', async () => {
  const { manager, dir, bundle } = await fixture()
  const policy = join(dir, 'pnpm-workspace.yaml')
  const run = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    const manifest = readProfileManifest('test', dir)
    const completion = { exitCode: 0, output: '', truncated: false, logPath: join(dir, 'pnpm.log') }
    manifest.dependencies = { ...manifest.dependencies, addon: '1.0.0' }
    if (run.mock.calls.length === 1) {
      writeFileSync(policy, 'allowBuilds:\n  native: set this to true or false\n  denied: false\n')
      completion.exitCode = 1
      completion.output = 'ERR_PNPM_IGNORED_BUILDS'
    } else {
      expect(parse(readFileSync(policy, 'utf8'))).toEqual({ allowBuilds: { native: true, denied: false } })
      bundle('addon', [])
    }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return completion
  })
  onTestFinished(() => { run.mockRestore() })
  // The failed run's manifest change is put back; the policy pnpm wrote stays, so its undecided names can be offered.
  expect(await manager.installBundle('addon')).toMatchObject({ application: 'failed', pendingBuilds: ['native'] })
  expect(readProfileManifest('test', dir).dependencies).not.toHaveProperty('addon')
  expect(parse(readFileSync(policy, 'utf8'))).toMatchObject({ allowBuilds: { native: 'set this to true or false' } })
  expect(await manager.installBundle('addon', { approvedBuilds: ['denied'] })).toMatchObject({ application: 'failed', changed: false, error: { code: 'stale-approval' } })
  expect(run).toHaveBeenCalledTimes(1)
  expect(await manager.installBundle('addon', { approvedBuilds: ['native'], enabled: false })).toMatchObject({
    application: 'applied', changed: true, approvedBuilds: ['native'],
  })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).not.toContain('addon')
})

it('retains approved policy and reports it as changed when the registry fails before adding a dependency', async () => {
  const { manager, dir } = await fixture()
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'allowBuilds:\n  native: set this to true or false\n')
  const run = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue({ exitCode: 1, output: 'registry unavailable', truncated: false, logPath: '/log' })
  onTestFinished(() => { run.mockRestore() })
  expect(await manager.installBundle('addon', { approvedBuilds: ['native'] })).toMatchObject({
    changed: true, application: 'failed', pendingBuilds: [], approvedBuilds: ['native'], error: { diagnostic: 'registry unavailable' },
  })
  expect(parse(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'))).toEqual({ allowBuilds: { native: true } })
})

it('runs a real pnpm dependency script only after approval and retry', async () => {
  const { manager, dir, profile } = await fixture('startup')
  const addon = join(profile.cwd, 'addon')
  mkdirSync(addon)
  writeFileSync(join(addon, 'package.json'), JSON.stringify({ name: 'approval-fixture-addon', version: '1.0.0',
    scripts: { install: 'node build.cjs' }, dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(addon, 'build.cjs'), 'require("node:fs").writeFileSync("built.txt", "built")\n')
  writeFileSync(join(addon, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(dir, 'package.json'), '{"name":"approval-fixture","private":true}\n')
  const policy = parseDocument(readFileSync(join(dir, 'pnpm-workspace.yaml'), 'utf8'))
  policy.set('offline', true)
  policy.set('storeDir', join(profile.cwd, 'store'))
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), String(policy))
  const blocked = await manager.installBundle('file:./addon', { enabled: false })
  expect(blocked, JSON.stringify(blocked)).toMatchObject({ application: 'failed', packageResult: { kind: 'build-blocked' } })
  expect(blocked.pendingBuilds).toHaveLength(1)
  const built = join(dir, 'node_modules', 'approval-fixture-addon', 'built.txt')
  expect(existsSync(built)).toBe(false)
  expect(readProfileManifest('test', dir).dependencies?.['approval-fixture-addon']).toBeUndefined()
  const allowed = await manager.installBundle('file:./addon', { enabled: false, approvedBuilds: blocked.pendingBuilds! })
  expect(allowed, JSON.stringify(allowed)).toMatchObject({ application: 'restart-required', packageResult: { exitCode: 0 } })
  expect(readFileSync(built, 'utf8')).toBe('built')
})

it.each(['[', 'allowBuilds: false\n'])('preserves pnpm diagnostics when pending approvals cannot be read: %s', async (policy) => {
  const { manager, dir } = await fixture()
  writeFileSync(join(dir, 'pnpm-workspace.yaml'), policy)
  const run = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue({ exitCode: 1, output: 'original pnpm failure', truncated: false, logPath: '/log' })
  onTestFinished(() => { run.mockRestore() })
  expect(await manager.installBundle('addon')).toMatchObject({ application: 'failed', error: { diagnostic: 'original pnpm failure' } })
})

it('unloads before removing packages and retries inactive dependencies whose files are missing', async () => {
  const { manager, dir, ctx } = await fixture()
  const remove = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    await ctx.hmr.runExclusive(async () => {
      expect([...ctx.loader.entries()].some(row => row.id === 'include:managed')).toBe(false)
    })
    return { exitCode: 1, output: 'removal failed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { remove.mockRestore() })
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: true, application: 'failed', packageResult: { exitCode: 1 } })
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
  expect((await manager.listBundles()).find(row => row.name === 'extra')?.enabled).toBe(false)
  rmSync(join(dir, 'node_modules', 'extra'), { recursive: true })
  remove.mockImplementationOnce(async () => {
    const manifest = readProfileManifest('test', dir)
    delete manifest.dependencies?.extra
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'removed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: true, application: 'applied' })
  expect((await manager.listBundles()).some(row => row.name === 'extra')).toBe(false)
})

it('restores the manifest and lockfile after a failed package run, classifying the failure', async () => {
  const { manager, dir } = await fixture()
  const lockPath = join(dir, 'pnpm-lock.yaml')
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, partial: '1' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    writeFileSync(lockPath, 'partial lockfile\n')
    return { exitCode: 42, output: 'ERR_PNPM_META_FETCH_FAIL  GET https://registry/partial: ENOTFOUND', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  expect(await manager.installBundle('partial')).toMatchObject({
    changed: false, application: 'failed', stage: 'install', target: 'partial',
    error: { code: 'operation-error', diagnostic: expect.stringContaining('ENOTFOUND') as string },
    packageResult: { exitCode: 42, kind: 'network' },
  })
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  // A lockfile the run created is removed; one that existed is put back.
  expect(existsSync(lockPath)).toBe(false)
  writeFileSync(lockPath, 'original lockfile\n')
  expect(await manager.installBundle('partial')).toMatchObject({ changed: false, application: 'failed' })
  expect(readFileSync(lockPath, 'utf8')).toBe('original lockfile\n')
  expect((await manager.listBundles()).some(row => row.name === 'partial')).toBe(false)
  expect(install).toHaveBeenCalledTimes(2)
})

it('keeps saved changes after activation failure and allows a corrected configuration to retry', async () => {
  const { manager, dir } = await fixture()
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: managed\n  disabled: true\n  config: { fail: true }\n')
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, true)).toMatchObject({ changed: true, application: 'failed' })
  expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toContain('disabled: false')
  writeFileSync(join(dir, 'cordis.patch.yml'), '- id: managed\n  disabled: true\n  config: { fail: false }\n')
  const result = await manager.setPluginEnabled(id, true)
  expect(result, JSON.stringify(result)).toMatchObject({ application: 'applied' })
})


it('reports a selected plain dependency as a problem, omits an unselected one, and reports missing versions', async () => {
  const { manager, dir, profile } = await fixture()
  writeFileSync(profile.installAnchor, '{}')
  writeFileSync(join(dir, 'node_modules', 'extra', 'package.json'), '{"name":"extra"}')
  expect((await manager.listBundles()).find(row => row.name === 'extra')).toMatchObject({ enabled: true, error: { code: 'not-bundle' } })
  expect(await manager.setBundleEnabled('extra', false)).toMatchObject({ application: 'applied' })
  // Switched off, a dependency without a bundle patch is a library the page has no business with.
  expect((await manager.listBundles()).some(row => row.name === 'extra')).toBe(false)
  expect(await manager.setBundleEnabled('extra', true)).toMatchObject({ changed: false, application: 'failed' })
  writeFileSync(join(dir, 'node_modules', 'core', 'package.json'), '{"name":"core","dsh":{"bundle":{"patch":"./cordis.patch.yml"}}}')
  expect((await manager.listBundles())[0]?.version).toBeUndefined()
  writeFileSync(join(dir, 'package.json'), '{}')
  expect(await manager.listBundles()).toEqual([])
  expect(await manager.setBundleEnabled('unknown', false)).toMatchObject({ application: 'failed' })
  writeFileSync(profile.installAnchor, '{"dependencies":{"missing-builtin":"1"}}')
  expect(await manager.listBundles()).toEqual([])
})

it('refuses management bundle disablement and permits repeated bundle selections', async () => {
  const { manager } = await fixture()
  expect(await manager.setBundleEnabled('core', false)).toMatchObject({ application: 'failed', changed: false })
  expect(await manager.setBundleEnabled('extra', true)).toMatchObject({ application: 'applied', changed: false })
})

it.each([
  '@deepseek-ai/dsh-host-plugin-inventory',
  '@deepseek-ai/dsh-typert-registry',
  '@deepseek-ai/dsh-api-remotes',
])('protects the management dependency %s and its containing bundle', async (name) => {
  const { ctx, manager, bundle, profile, dir } = await fixture('startup')
  bundle('extra', [{ id: 'dependency', name, disabled: true }])
  await reconcileProfilePatches(ctx, readProfilePatches('test', profile), 'test')
  const entry = (await manager.listPlugins()).find(row => row.moduleName === name)!
  expect(entry).toMatchObject({ readOnlyReason: 'management-required' })
  const manifest = readFileSync(join(dir, 'package.json'), 'utf8')
  const patch = readFileSync(profile.patchPath, 'utf8')
  expect(await manager.setPluginEnabled(entry.entryId, false)).toMatchObject({
    changed: false, application: 'failed', error: { code: 'management-required' },
  })
  expect((await manager.listBundles()).find(row => row.name === 'extra')).toMatchObject({
    removable: false, readOnlyReason: 'management-required',
  })
  expect(await manager.setBundleEnabled('extra', false)).toMatchObject({
    changed: false, application: 'failed', error: { code: 'management-required' },
  })
  expect(await manager.removeBundle('extra')).toMatchObject({
    changed: false, application: 'failed', error: { code: 'not-removable' },
  })
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifest)
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(patch)
})

it('addresses children inside profile groups and marks ambiguous ids read-only', async () => {
  const { manager, bundle, profile } = await fixture('live', false, (ctx) => { ctx.loader.builtins.group = Group })
  bundle('grouped', [{ id: 'group', name: 'cordis:group', group: true,
    config: [{ id: 'child', name: './plugin.mjs', config: { service: 'child' } }] }])
  expect(await manager.setBundleEnabled('grouped', true)).toMatchObject({ application: 'applied' })
  expect((await manager.listPlugins()).find(row => row.patchId === 'child')).toBeDefined()
  const entries = composeEntries([readProfilePatches('test', profile)])
  const duplicate = entries.find(row => row.id === 'managed')!
  writeFileSync(profile.patchPath, JSON.stringify([{ insert: [duplicate] }]))
  expect((await manager.listPlugins()).find(row => row.entryId === 'include:managed')?.readOnlyReason).toBe('unaddressable')
})

it.each(['', '-g'])('rejects an invalid installation spec before calling pnpm: %j', async (spec) => {
  const { manager } = await fixture()
  expect(await manager.installBundle(spec)).toMatchObject({ changed: false, application: 'failed', error: { code: 'invalid-spec' } })
})

it('restores the manifest when the package pnpm added declares no bundle', async () => {
  const { manager, dir, bundle } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    bundle('plain', [])
    writeFileSync(join(dir, 'node_modules', 'plain', 'package.json'), '{"name":"plain"}')
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, plain: '1' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('plain')).toMatchObject({
    changed: false, application: 'failed', stage: 'install', error: { code: 'not-bundle' }, packageResult: { exitCode: 0 },
  })
  // The manifest is put back rather than cleaned through another pnpm run.
  expect(install).toHaveBeenCalledOnce()
  expect(readProfileManifest('test', dir)).toMatchObject({ dependencies: { extra: '1.0.0' }, dsh: { profile: { bundles: ['core', 'extra'] } } })
  expect((await manager.listBundles()).some(row => row.name === 'plain')).toBe(false)
})

it('never removes an existing dependency after installation validation fails', async () => {
  const { manager, dir } = await fixture()
  writeFileSync(join(dir, 'node_modules', 'extra', 'package.json'), '{"name":"extra"}')
  const install = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue({ exitCode: 0, output: '', truncated: false, logPath: '/operation.log' })
  onTestFinished(() => { install.mockRestore() })
  const result = await manager.installBundle('extra')
  expect(result).toMatchObject({ application: 'failed', stage: 'install', error: { code: 'not-bundle' } })
  expect(install).toHaveBeenCalledOnce()
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
})

it('keeps a valid installed bundle when its subsequent activation fails', async () => {
  const { manager, dir, bundle } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    bundle('broken', [{ id: 'broken', name: './plugin.mjs', config: { fail: true } }])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, broken: '1' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: '', truncated: false, logPath: '/operation.log' }
  })
  onTestFinished(() => { install.mockRestore() })
  const result = await manager.installBundle('broken')
  expect(result).toMatchObject({ application: 'failed', stage: 'enable', target: 'broken', bundle: 'broken', packageResult: { exitCode: 0 } })
  expect(install).toHaveBeenCalledOnce()
  expect((await manager.listBundles()).find(row => row.name === 'broken')).toMatchObject({ enabled: true, removable: true })
})

it('returns unchanged failures as warnings while toggling and removing another bundle', async () => {
  const { manager, dir, bundle, ctx } = await fixture()
  bundle('broken', [
    { id: 'broken', name: './plugin.mjs', config: { fail: true } },
    { id: 'missing', name: './missing.mjs' },
    { id: 'pending', name: './pending.mjs' },
  ])
  writeFileSync(join(dir, 'node_modules/broken/pending.mjs'), 'export const inject = ["unavailable"]; export function apply() {}')
  expect(await manager.setBundleEnabled('broken', true)).toMatchObject({ application: 'failed' })
  const brokenId = (await manager.listPlugins()).find(row => row.patchId === 'broken')!.entryId
  expect(await manager.setPluginEnabled(brokenId, true)).toMatchObject({ application: 'failed' })
  expect(await manager.setBundleEnabled('broken', true)).toMatchObject({ application: 'failed' })
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  const changed = await manager.setPluginEnabled(id, false)
  expect(changed).toMatchObject({ application: 'applied' })
  expect(changed.warnings).toHaveLength(3)
  expect(await manager.setPluginEnabled(id, true)).toMatchObject({ application: 'applied' })
  const remove = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    expect([...ctx.loader.entries()].some(row => row.id === 'include:managed')).toBe(false)
    const manifest = readProfileManifest('test', dir)
    delete manifest.dependencies?.extra
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: '', truncated: false, logPath: '/operation.log' }
  })
  onTestFinished(() => { remove.mockRestore() })
  const removed = await manager.removeBundle('extra')
  expect(removed.application).toBe('applied')
  expect(removed.warnings).toHaveLength(3)
  expect(remove).toHaveBeenCalledOnce()
})

it('reports repeated installs as requiring restart and ambiguous package changes as failures', async () => {
  const { manager, dir } = await fixture()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockResolvedValue({ exitCode: 0, output: '', truncated: false, logPath: join(dir, 'pnpm.log') })
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('extra')).toMatchObject({ changed: false, application: 'restart-required' })
  expect(await manager.installBundle('extra@1')).toMatchObject({ changed: false, application: 'restart-required' })
  expect(await manager.installBundle('extra-long@1')).toMatchObject({ changed: false, application: 'failed', error: { code: 'ambiguous-install' } })
  install.mockImplementationOnce(async () => {
    writeFileSync(join(dir, 'package.json'), '{}')
    return { exitCode: 0, output: '', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  expect(await manager.installBundle('unknown')).toMatchObject({ changed: false, application: 'failed', error: { code: 'ambiguous-install' } })
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
})

it('streams pnpm output, reports the installation phases, and names the installed bundle', async () => {
  const { ctx, manager, dir, bundle } = await fixture()
  const chunks: PluginInstallLogChunk[] = []
  const phases: PluginInstallProgress[] = []
  const changes: PluginChange[] = []
  ctx.on('plugin-manager/install-log', (chunk) => { chunks.push(chunk) })
  ctx.on('plugin-manager/install-state', (progress) => { phases.push(progress) })
  ctx.on('plugin-manager/changed', (change) => { changes.push(change) })
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, args, options) => {
    options.onOutput?.('Progress: resolved 1\n', 'stdout')
    options.onOutput?.('warning\n', 'stderr')
    const name = String(args[1])
    bundle(name, [{ id: name, name: './plugin.mjs', config: { service: name } }])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
  expect(await manager.installBundle('streamed', { enabled: false, requestId })).toMatchObject({ application: 'applied', changed: true, bundle: 'streamed' })
  expect(install).toHaveBeenCalledWith(expect.objectContaining({ profile: 'test' }), ['add', 'streamed'],
    expect.objectContaining({ command: 'pnpm', execution: 'service' }))
  const jobId = chunks[0]?.jobId
  expect(chunks).toEqual([
    { requestId, jobId, argv: ['pnpm', 'add', 'streamed'], cwd: dir, stream: 'stdout', text: 'Progress: resolved 1\n' },
    { requestId, jobId, argv: ['pnpm', 'add', 'streamed'], cwd: dir, stream: 'stderr', text: 'warning\n' },
    { requestId, jobId, argv: ['pnpm', 'add', 'streamed'], cwd: dir, stream: 'stdout', text: '', exitCode: 0 },
  ])
  expect(phases).toEqual([{ requestId, phase: 'installing' }, { requestId, phase: 'applying' }])
  expect(changes).toEqual([{ reason: 'install' }])
  // A run without a request id streams too, unidentified.
  await manager.removeBundle('streamed')
  expect(chunks.at(-1)).toMatchObject({ argv: ['pnpm', 'remove', 'streamed'], stream: 'stdout', exitCode: 0 })
  expect(chunks.at(-1)).not.toHaveProperty('requestId')
  expect(changes).toEqual([{ reason: 'install' }, { reason: 'remove' }])
})

it('stops a run on request, restores the files, and answers not-running or too-late otherwise', async () => {
  const { ctx, manager, dir, bundle } = await fixture()
  const phases: PluginInstallProgress[] = []
  ctx.on('plugin-manager/install-state', (progress) => { phases.push(progress) })
  const started = Promise.withResolvers<undefined>()
  const install = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, _args, options) => {
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, slow: '1' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    started.resolve(undefined)
    await new Promise<undefined>((resolve) => { options.signal?.addEventListener('abort', () => { resolve(undefined) }, { once: true }) })
    return { exitCode: 1, output: 'killed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { install.mockRestore() })
  const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  const run = manager.installBundle('slow', { requestId })
  await started.promise
  expect(await manager.cancelInstall('00000000-0000-4000-8000-000000000000' as PluginInstallRequestId)).toEqual({ status: 'not-running' })
  expect(await manager.cancelInstall(requestId)).toEqual({ status: 'cancelled' })
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  const cancelled = await run
  expect(cancelled).toMatchObject({ application: 'cancelled', changed: false, stage: 'install', packageResult: { exitCode: 1 } })
  expect(cancelled.error).toBeUndefined()
  expect(phases).toEqual([{ requestId, phase: 'installing' }, { requestId, phase: 'cancelling' }])
  expect(await manager.cancelInstall(requestId)).toEqual({ status: 'not-running' })
  // Once pnpm has exited and the bundle is being applied, the run cannot be stopped.
  install.mockImplementation(async (_context, args) => {
    const name = String(args[1])
    bundle(name, [{ id: name, name: './plugin.mjs', config: { service: name } }])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, [name]: '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  let tooLate: Promise<unknown> | undefined
  ctx.on('plugin-manager/install-state', (progress) => { if (progress.phase === 'applying') tooLate = manager.cancelInstall(progress.requestId) })
  expect(await manager.installBundle('late', { requestId })).toMatchObject({ application: 'applied', bundle: 'late' })
  expect(await tooLate).toEqual({ status: 'too-late' })
  // A request aborted before its turn under the lock never starts pnpm.
  const early = manager.installBundle('never', { requestId })
  const queued = manager.installBundle('after', { requestId: '11111111-1111-4111-8111-111111111111' as PluginInstallRequestId })
  expect(await manager.cancelInstall('11111111-1111-4111-8111-111111111111' as PluginInstallRequestId)).toEqual({ status: 'cancelled' })
  await early
  expect(await queued).toMatchObject({ application: 'cancelled', changed: false })
})

it('reads what a spec names before installing it', async () => {
  const { manager, dir, profile } = await fixture(undefined, false, undefined, { inspectTimeoutMs: 1000, pnpmCommand: 'pnpm-test' })
  const view = vi.spyOn(operations, 'viewProfilePackage')
  onTestFinished(() => { view.mockRestore() })
  const answers = (stdout: string) => view.mockResolvedValueOnce({ exitCode: 0, stdout, stderr: '', timedOut: false })
  answers(JSON.stringify({ name: 'dsh-x', version: '1.4.2', description: 'A sidebar.', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  expect(await manager.inspect('dsh-x')).toEqual({
    status: 'accepted', kind: 'registry', name: 'dsh-x', version: '1.4.2', description: 'A sidebar.', bundle: true,
  })
  expect(view).toHaveBeenCalledWith(dir, 'dsh-x', { command: 'pnpm-test', timeoutMs: 1000 })
  const signal = AbortSignal.abort()
  answers(JSON.stringify([{ name: 'dsh-lib', version: '1.0.0', dsh: { bundle: {} } }, { name: 'dsh-lib', version: '1.1.0', dsh: null }]))
  expect(await manager.inspect('dsh-lib@^1', signal)).toEqual({ status: 'refused', problem: 'not-a-bundle', reason: 'dsh-lib declares no dsh.bundle' })
  expect(view).toHaveBeenLastCalledWith(dir, 'dsh-lib@^1', { command: 'pnpm-test', timeoutMs: 1000, signal })
  // An answer that names no package keeps the name the spec gave; colour escapes around the JSON are dropped.
  answers('\x1b[36m' + JSON.stringify({ version: '0.0.1', description: '', dsh: { bundle: { patch: './p.yml' } } }) + '\x1b[39m\n')
  expect(await manager.inspect('dsh-bare')).toEqual({ status: 'accepted', kind: 'registry', name: 'dsh-bare', version: '0.0.1', bundle: true })
  const failure = (stderr: string, exitCode: number | null = 1, more: Partial<operations.PackageViewResult> = {}) =>
    view.mockResolvedValueOnce({ exitCode, stdout: '', stderr, timedOut: false, ...more })
  failure('npm error code E404\nnpm error 404 Not Found - GET https://registry/nope\n')
  expect(await manager.inspect('nope')).toMatchObject({ status: 'refused', problem: 'not-found', reason: expect.stringContaining('E404') as string })
  failure('ERR_PNPM_NO_MATCHING_VERSION  No matching version found for old@9\n')
  expect(await manager.inspect('old@9')).toMatchObject({ status: 'refused', problem: 'not-found' })
  failure('ERR_PNPM_META_FETCH_FAIL  request failed, reason: getaddrinfo ENOTFOUND registry\n')
  expect(await manager.inspect('far')).toMatchObject({ status: 'refused', problem: 'network' })
  view.mockResolvedValueOnce({ exitCode: 3, stdout: 'plain text\n', stderr: '', timedOut: false })
  expect(await manager.inspect('odd')).toEqual({ status: 'refused', problem: 'unknown', reason: 'plain text' })
  failure('', 4)
  expect(await manager.inspect('quiet')).toEqual({ status: 'refused', problem: 'unknown', reason: 'pnpm view exited with 4' })
  failure('', null, { timedOut: true })
  expect(await manager.inspect('slow')).toEqual({ status: 'refused', problem: 'unknown', reason: 'pnpm view timed out after 1000ms' })
  failure('', null, { cause: Object.assign(new Error('spawn pnpm ENOENT'), { code: 'ENOENT' }) })
  expect(await manager.inspect('gone')).toMatchObject({ status: 'refused', problem: 'unknown', reason: expect.stringContaining('ENOENT') as string })
  answers('not json')
  expect(await manager.inspect('garbled')).toMatchObject({ status: 'refused', problem: 'unknown', reason: expect.stringContaining('unreadable pnpm view output') as string })
  answers('"just a string"')
  expect(await manager.inspect('scalar')).toEqual({ status: 'refused', problem: 'unknown', reason: 'pnpm view answered no package' })
  answers('')
  expect(await manager.inspect('silent')).toEqual({ status: 'refused', problem: 'unknown', reason: 'pnpm view answered no package' })
  // What is installed, or supplied by the installation, is refused before the registry is asked.
  expect(await manager.inspect('extra')).toEqual({ status: 'refused', problem: 'already-installed', reason: 'extra is already installed' })
  expect(await manager.inspect('./relative')).toEqual({ status: 'refused', problem: 'invalid-spec', reason: 'a local path must be absolute' })
  expect(await manager.inspect('github:acme/dsh-remote')).toEqual({ status: 'accepted', kind: 'git', bundle: null })
  const tarball = join(profile.home, 'pack.tgz')
  expect(await manager.inspect(tarball)).toEqual({ status: 'refused', problem: 'not-a-package', reason: 'the tarball does not exist' })
  writeFileSync(tarball, '')
  expect(await manager.inspect(tarball)).toEqual({ status: 'accepted', kind: 'tarball', bundle: null })
  expect(await manager.inspect('https://cdn.example.com/x/y/z/dsh-x-1.0.0.tgz')).toEqual({ status: 'accepted', kind: 'tarball', bundle: null })
  // A directory answers from its own manifest.
  const local = join(profile.home, 'dev', 'dsh-local')
  mkdirSync(local, { recursive: true })
  expect(await manager.inspect(join(profile.home, 'dev', 'missing'))).toEqual({ status: 'refused', problem: 'not-a-package', reason: 'the path does not exist' })
  expect(await manager.inspect(local)).toMatchObject({ status: 'refused', problem: 'not-a-package', reason: expect.stringContaining('no readable package.json') as string })
  writeFileSync(join(local, 'package.json'), '{"version":"1.0.0"}')
  expect(await manager.inspect(local)).toEqual({ status: 'refused', problem: 'not-a-package', reason: 'the package.json names no package' })
  writeFileSync(join(local, 'package.json'), JSON.stringify({ name: 'dsh-local', version: '0.1.0', description: 'Local.' }))
  expect(await manager.inspect(local)).toEqual({ status: 'refused', problem: 'not-a-bundle', reason: 'dsh-local declares no dsh.bundle' })
  writeFileSync(join(local, 'package.json'), JSON.stringify({ name: 'dsh-local', version: '0.1.0', description: 'Local.', dsh: { bundle: { patch: './p.yml' } } }))
  expect(await manager.inspect(`file:${local}`)).toEqual({ status: 'accepted', kind: 'path', name: 'dsh-local', version: '0.1.0', description: 'Local.', bundle: true })
  writeFileSync(join(local, 'package.json'), JSON.stringify({ name: 'core', dsh: { bundle: { patch: './p.yml' } } }))
  expect(await manager.inspect(local)).toEqual({ status: 'refused', problem: 'already-installed', reason: 'core is already installed' })
  // A profile and an installation that list nothing know nothing.
  writeFileSync(join(dir, 'package.json'), '{}')
  writeFileSync(profile.installAnchor, '{}')
  expect(await manager.inspect(local)).toEqual({ status: 'accepted', kind: 'path', name: 'core', bundle: true })
  expect(view).toHaveBeenCalledTimes(13)
})

it('announces each manager operation as a change, and a patch generation applied outside it not at all', async () => {
  const { ctx, manager, profile } = await fixture('startup')
  const changes: PluginChange[] = []
  ctx.on('plugin-manager/changed', (change) => { changes.push(change) })
  await reconcileProfilePatches(ctx, readProfilePatches('test', profile), 'test')
  expect(changes).toEqual([])
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  await manager.setPluginEnabled(id, false)
  expect(changes).toEqual([{ reason: 'plugin' }])
  await manager.setBundleEnabled('extra', false)
  expect(changes).toEqual([{ reason: 'plugin' }, { reason: 'bundle' }])
})

it('handles missing patch files and retains non-Error package diagnostics', async () => {
  const { manager, dir } = await fixture()
  rmSync(join(dir, 'cordis.patch.yml'))
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: true, application: 'applied' })
  const install = vi.spyOn(operations, 'runProfilePnpm').mockRejectedValueOnce('pnpm rejected operation')
  onTestFinished(() => { install.mockRestore() })
  expect(await manager.installBundle('new')).toMatchObject({ changed: false, application: 'failed', error: { code: 'operation-error', diagnostic: 'pnpm rejected operation' } })
  rmSync(join(dir, 'cordis.patch.yml'))
  mkdirSync(join(dir, 'cordis.patch.yml'))
  await expect(manager.setPluginEnabled(id, true)).rejects.toThrow()
})

it('applies a manager change through the active HMR service', async () => {
  const { manager } = await fixture()
  const id = (await manager.listPlugins()).find(row => row.patchId === 'managed')!.entryId
  expect(await manager.setPluginEnabled(id, false)).toMatchObject({ changed: true, application: 'applied' })
  expect((await manager.listPlugins()).find(row => row.entryId === id)?.enabled).toBe(false)
})

it('refuses removal of a hot-installed bundle after HMR is disabled', async () => {
  const { ctx, manager, dir, bundle, stopHmr } = await fixture()
  bundle('later', [{ id: 'later', name: './plugin.mjs', config: { service: 'laterProbe' } }])
  const manifest = readProfileManifest('test', dir)
  manifest.dependencies = { ...manifest.dependencies, later: '1' }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  expect(await manager.setBundleEnabled('later', true)).toMatchObject({ application: 'applied' })
  await stopHmr()
  expect(ctx.get('hmr')).toBeUndefined()
  expect(await manager.setBundleEnabled('later', false)).toMatchObject({ application: 'restart-required' })
  expect(ctx.get('laterProbe')).toBe(true)
  expect(await manager.removeBundle('later')).toMatchObject({ changed: false, application: 'failed' })
})

it('offers the launcher\'s optional bundles switched off and never removable', async () => {
  const { manager, profile } = await fixture()
  // The launcher names the bundles the installation ships; the fixture supplies one of them from the
  // installation's own node_modules, which the resolver consults before the profile's and before the repository's.
  const offered = OPTIONAL_BUNDLES[0]!
  const supplied = join(profile.home, 'node_modules', offered)
  mkdirSync(supplied, { recursive: true })
  writeFileSync(join(supplied, 'package.json'), JSON.stringify({
    name: offered, version: '3.0.0', description: 'Package one-liner.', dsh: { bundle: { patch: './cordis.patch.yml' } },
  }))
  writeFileSync(join(supplied, 'cordis.patch.yml'), JSON.stringify([{ insert: [{ id: 'offered-row', name: './plugin.mjs', config: { service: 'offeredProbe' } }] }]))
  writeFileSync(join(supplied, 'plugin.mjs'), 'export function apply(ctx, config) { ctx.provide(config?.service ?? "offeredProbe", true) }\n')
  writeFileSync(profile.installAnchor, JSON.stringify({ name: 'installation', dependencies: { [offered]: '3.0.0' } }))
  expect((await manager.listBundles()).find(row => row.name === offered)).toEqual({
    name: offered, version: '3.0.0', description: 'Package one-liner.',
    enabled: false, installed: false, optional: true, removable: false,
    rows: [{ rowId: 'offered-row', moduleName: pathToFileURL(join(supplied, 'plugin.mjs')).href }], overrides: [],
  })
  expect(await manager.setBundleEnabled(offered, true)).toMatchObject({ application: 'applied' })
  expect((await manager.listBundles()).find(row => row.name === offered)).toMatchObject({ enabled: true, optional: true, removable: false })
  expect(await manager.removeBundle(offered)).toMatchObject({ changed: false, application: 'failed' })
})

it('omits installation-owned plain packages from the bundle inventory', async () => {
  const { manager, dir, profile, bundle } = await fixture()
  bundle('installation-plain', [])
  writeFileSync(join(dir, 'node_modules/installation-plain/package.json'), '{"name":"installation-plain"}')
  writeFileSync(profile.installAnchor, '{"dependencies":{"installation-plain":"1"}}')
  expect((await manager.listBundles()).some(row => row.name === 'installation-plain')).toBe(false)
})

it('does not delete a bundle retained by a higher-priority overlay', async () => {
  const { ctx, manager, overlays, dir } = await fixture()
  const entry = [...ctx.loader.entries()].find(row => row.id === 'include:managed')!
  overlays.push({ insert: [{ ...entry.options }] })
  const remove = vi.spyOn(operations, 'runProfilePnpm')
  onTestFinished(() => { remove.mockRestore() })
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: true, application: 'failed', error: { code: 'bundle-in-use' } })
  expect(await manager.removeBundle('extra')).toMatchObject({ changed: false, application: 'failed', error: { code: 'bundle-in-use' } })
  expect(remove).not.toHaveBeenCalled()
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
  expect(ctx.get('managedProbe')).toBe(true)
})

it('applies watched configuration while pnpm installation is still running', async () => {
  const { ctx, manager, dir, profile, bundle } = await fixture()
  const entered = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    entered.resolve(undefined)
    await release.promise
    bundle('new-bundle', [])
    const manifest = readProfileManifest('test', dir)
    manifest.dependencies = { ...manifest.dependencies, 'new-bundle': '1.0.0' }
    writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
    return { exitCode: 0, output: 'installed', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  const installing = manager.installBundle('new-bundle')
  onTestFinished(async () => { release.resolve(undefined); await installing; pnpm.mockRestore() })
  await entered.promise
  writeFileSync(profile.patchPath, '- id: managed\n  disabled: true\n')
  await vi.waitFor(() => { expect(ctx.get('managedProbe')).toBeUndefined() }, { timeout: 10000 })
  expect(pnpm).toHaveBeenCalledOnce()
  release.resolve(undefined)
  expect(await installing).toMatchObject({ application: 'applied', changed: true })
  expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core', 'extra', 'new-bundle'])
  expect(ctx.get('managedProbe')).toBeUndefined()
})

it('installs and removes with the bundled pnpm when PATH contains no pnpm', async () => {
  const pnpm = fileURLToPath(new URL('../../../../apps/desktop/node_modules/pnpm/bin/pnpm.mjs', import.meta.url))
  const { manager, dir } = await fixture('startup', false, undefined, { pnpmCommand: 'must-not-be-used' }, {
    command: process.execPath, args: ['--expose-internals', pnpm], env: { PATH: '', ELECTRON_RUN_AS_NODE: '1' },
  })
  const target = join(dir, 'local-bundle')
  mkdirSync(target)
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: '@test/desktop-manager', version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(target, 'cordis.patch.yml'), '[]\n')
  // Fixture-only packages need no registry resolution during this local install.
  const manifest = readProfileManifest('test', dir)
  delete manifest.dependencies
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  const installed = await manager.installBundle(target)
  expect(installed.error).toBeUndefined()
  expect(installed.packageResult?.exitCode).toBe(0)
  expect(readProfileManifest('test', dir).dependencies).toHaveProperty('@test/desktop-manager')
  const removed = await manager.removeBundle('@test/desktop-manager')
  expect(removed.error).toBeUndefined()
  expect(removed.packageResult?.exitCode).toBe(0)
  expect(readProfileManifest('test', dir).dependencies ?? {}).not.toHaveProperty('@test/desktop-manager')
})

describe('staged package transactions', () => {
  const requestId = 'be279c80-4602-4d38-bf63-b3947a818e92' as PluginInstallRequestId
  const prepared = (packageName = 'addon', transactionId: string = requestId): ProfilePreparedPackageChange => ({
    transactionId, state: 'prepared', packageName, baseFingerprint: 'a'.repeat(64), health: 'pending',
  })
  const selection = (): ProfilePreparedBundleSelection => ({
    schemaVersion: 2, kind: 'selection', transactionId: requestId, state: 'prepared',
    packageNames: ['addon', 'extra'], baseFingerprint: 'a'.repeat(64), health: 'pending',
  })
  const verifiedRelease = (): ProfileVerifiedReleaseSource => ({
    schemaVersion: 1, type: 'githubRelease', owner: 'fixture', repo: 'addon', tag: 'v2.0.0', asset: 'addon-2.0.0.tgz',
    assetId: 17, packageName: 'addon', version: '2.0.0', size: 123, sha256: 'b'.repeat(64), targetCommit: 'c'.repeat(40),
  })
  const transactions = () => ({
    protocolVersion: 1 as const,
    stage: vi.fn<ProfilePackageTransactions['stage']>().mockResolvedValue(prepared()),
    status: vi.fn<ProfilePackageTransactions['status']>().mockResolvedValue(undefined),
    listPending: vi.fn<ProfilePackageTransactions['listPending']>().mockResolvedValue([]),
    cancel: vi.fn<ProfilePackageTransactions['cancel']>().mockResolvedValue(undefined),
  } satisfies ProfilePackageTransactions)
  const stagedFixture = (service?: ProfilePackageTransactions, reload: 'live' | 'startup' = 'live') =>
    fixture(reload, false, (ctx) => {
      if (service !== undefined) ctx.provide('profilePackageTransactions', service)
    }, {}, undefined, true)

  function observeActiveProfile(ctx: Context, dir: string) {
    writeFileSync(join(dir, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n')
    writeFileSync(join(dir, 'pnpm-workspace.yaml'), 'allowBuilds:\n  native: set this to true or false\n')
    const files = ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'cordis.patch.yml', 'node_modules/extra/plugin.mjs']
    const before = files.map(file => readFileSync(join(dir, file), 'utf8'))
    const entry = [...ctx.loader.entries()].find(row => row.id === 'include:managed')!
    const fiber = entry.fiber
    const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockRejectedValue(new Error('stock pnpm must not run'))
    const approve = vi.spyOn(buildApproval, 'approveBuilds')
    const save = vi.spyOn(operations, 'saveManifest')
    const write = vi.spyOn(atomicWrite, 'writeFileAtomic')
    const hmr = ctx.get('hmr')
    const exclusive = hmr === undefined ? undefined : vi.spyOn(hmr, 'runExclusive')
    const changes: PluginChange[] = []
    ctx.on('plugin-manager/changed', (change) => { changes.push(change) })
    onTestFinished(() => {
      pnpm.mockRestore(); approve.mockRestore(); save.mockRestore(); write.mockRestore(); exclusive?.mockRestore()
    })
    return () => {
      expect(files.map(file => readFileSync(join(dir, file), 'utf8'))).toEqual(before)
      expect([...ctx.loader.entries()].find(row => row.id === 'include:managed')).toBe(entry)
      expect(entry.fiber).toBe(fiber)
      expect(ctx.get('managedProbe')).toBe(true)
      expect(pnpm).not.toHaveBeenCalled()
      expect(approve).not.toHaveBeenCalled()
      expect(save).not.toHaveBeenCalled()
      // Byte equality alone would miss a stock rollback rewriting the original files.
      expect(write).not.toHaveBeenCalled()
      if (exclusive !== undefined) expect(exclusive).not.toHaveBeenCalled()
      expect(changes).toEqual([])
    }
  }

  it('reads legacy and selection preparations without changing active package state', async () => {
    const service = transactions()
    const selected = selection()
    const previous = prepared('addon', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa')
    service.status.mockResolvedValue(selected)
    service.listPending.mockResolvedValue([previous, selected])
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    const single = await manager.pendingPackageChange(requestId)
    expect(single).toEqual(selected)
    expect(single).not.toBe(selected)
    expect(await manager.listPendingPackageChanges()).toEqual([previous, selected])
    expect((await manager.listBundles()).some(bundle => bundle.name === 'addon')).toBe(false)
    expect(service.stage).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
    unchanged()
  })

  it.each(['install', 'remove'] as const)('refuses a selection record returned by ordinary %s staging', async (operation) => {
    const service = transactions()
    const stage = vi.fn(async () => selection())
    // Model malformed launcher output without lying about the legacy stage API's static return type.
    expect(Reflect.set(service, 'stage', stage)).toBe(true)
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    const result = operation === 'install' ? await manager.installBundle('addon', { requestId }) : await manager.removeBundle('extra')
    expect(result).toMatchObject({ application: 'failed', changed: false, error: { code: 'operation-error' } })
    expect(result.prepared).toBeUndefined()
    expect(stage).toHaveBeenCalledOnce()
    unchanged()
  })

  it.each(['unsorted', 'mixed', 'wrong-id'] as const)('refuses malformed selection status and list replies: %s', async (damage) => {
    const service = transactions()
    const value = damage === 'unsorted' ? { ...selection(), packageNames: ['extra', 'addon'] }
      : damage === 'mixed' ? { ...selection(), packageName: 'fake-target' }
        : { ...selection(), transactionId: 'wrong-id' }
    expect(Reflect.set(service, 'status', vi.fn(async () => value))).toBe(true)
    expect(Reflect.set(service, 'listPending', vi.fn(async () => [value]))).toBe(true)
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    await expect(manager.pendingPackageChange(requestId)).rejects.toThrow()
    await expect(manager.listPendingPackageChanges()).rejects.toThrow()
    unchanged()
  })

  it('refuses verified Release input on a normal profile before invoking stock mutation', async () => {
    const { ctx, dir, manager } = await fixture('startup')
    const unchanged = observeActiveProfile(ctx, dir)
    expect(await manager.installBundle(verifiedRelease(), { requestId, approvedBuilds: ['native'] })).toEqual({
      stage: 'install', target: 'addon', changed: false, application: 'failed',
      error: { code: 'invalid-spec', diagnostic: 'Verified Release sources require launcher-owned package staging' },
    })
    expect(await manager.cancelInstall(requestId)).toEqual({ status: 'not-running' })
    unchanged()
  })

  it('propagates a real stock writer-lock failure to an already joined cancellation', async () => {
    const { ctx, dir, manager } = await fixture('startup', false, undefined, { lockWaitMs: 0 })
    const unchanged = observeActiveProfile(ctx, dir)
    const manifest = join(dir, 'package.json')
    await atomicWrite.withFileLock(manifest, async () => {
      const ownerBytes = readFileSync(`${manifest}.lock`, 'utf8')
      const installing = manager.installBundle('addon', { requestId })
      const cancelling = manager.cancelInstall(requestId)
      await Promise.all([
        expect(installing).rejects.toThrow('writer lock'),
        expect(cancelling).rejects.toThrow('writer lock'),
      ])
      expect(readFileSync(`${manifest}.lock`, 'utf8')).toBe(ownerBytes)
      expect(await manager.cancelInstall(requestId)).toEqual({ status: 'not-running' })
      unchanged()
    })
    expect(existsSync(`${manifest}.lock`)).toBe(false)
  })

  it('does not report cancellation when an invalid stock spec wins without a diagnostic', async () => {
    const { manager } = await fixture('startup')
    const pnpm = vi.spyOn(operations, 'runProfilePnpm')
    onTestFinished(() => { pnpm.mockRestore() })
    const installing = manager.installBundle('', { requestId })
    const cancelling = manager.cancelInstall(requestId)
    await expect(cancelling).rejects.toThrow('Package cleanup failed; cancellation was not confirmed')
    expect(await installing).toMatchObject({ application: 'failed', changed: false, error: { code: 'invalid-spec' } })
    expect((await installing).error?.diagnostic).toBeUndefined()
    expect(pnpm).not.toHaveBeenCalled()
    expect(await manager.cancelInstall(requestId)).toEqual({ status: 'not-running' })
  })

  it.each([
    { label: 'non-array reply', reply: { records: [] }, diagnostic: 'invalid pending transaction list' },
    { label: 'oversized reply', reply: Array.from({ length: 101 }, () => prepared()), diagnostic: 'invalid pending transaction list' },
    { label: 'malformed member', reply: [{ ...prepared(), baseFingerprint: 'damaged' }], diagnostic: 'invalid prepared result' },
  ])('refuses a $label at the public launcher pending-list boundary', async ({ reply, diagnostic }) => {
    const service = transactions()
    const listPending = vi.fn(async () => reply)
    // A launcher IPC adapter can return malformed data despite the same-process service's static type.
    expect(Reflect.set(service, 'listPending', listPending)).toBe(true)
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    await expect(manager.listPendingPackageChanges()).rejects.toThrow(diagnostic)
    expect(listPending).toHaveBeenCalledExactlyOnceWith()
    expect(service.stage).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
    unchanged()
  })

  it.each(['missing-bundle', 'core'])('refuses staged removal of an unknown or protected bundle: %s', async (name) => {
    const service = transactions()
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    expect(await manager.removeBundle(name)).toMatchObject({
      stage: 'remove', target: name, application: 'failed', changed: false, error: { code: 'not-removable' },
    })
    expect(service.stage).not.toHaveBeenCalled()
    unchanged()
  })

  it('fails closed without the required launcher service, never falling back to stock mutation', async () => {
    const { ctx, dir, manager } = await stagedFixture()
    const unchanged = observeActiveProfile(ctx, dir)
    expect(await manager.installBundle('addon', { approvedBuilds: ['native'] })).toMatchObject({
      changed: false, application: 'failed', stage: 'install', error: { code: 'operation-error' },
    })
    expect(await manager.removeBundle('extra')).toMatchObject({
      changed: false, application: 'failed', stage: 'remove', error: { code: 'operation-error' },
    })
    await expect(manager.pendingPackageChange(requestId)).rejects.toThrow('unavailable')
    await expect(manager.listPendingPackageChanges()).rejects.toThrow('unavailable')
    await expect(manager.cancelPendingPackageChange(requestId)).rejects.toThrow('unavailable')
    await expect(manager.setBundleEnabled('extra', false)).rejects.toThrow('Launcher package staging is required but unavailable')
    const plugin = (await manager.listPlugins()).find(row => row.patchId === 'managed')!
    await expect(manager.setPluginEnabled(plugin.entryId, false)).rejects.toThrow('Launcher package staging is required but unavailable')
    unchanged()
  })

  it.each([undefined, 2])('rejects an incompatible launcher protocol (%s) before delegation', async (protocolVersion) => {
    const service = transactions()
    // Model a mismatched launcher IPC adapter, not a valid same-version implementation.
    const incompatible = { ...service, protocolVersion } as unknown as ProfilePackageTransactions
    const { ctx, dir, manager } = await stagedFixture(incompatible)
    const unchanged = observeActiveProfile(ctx, dir)
    expect(await manager.installBundle('addon', { requestId })).toMatchObject({ application: 'failed', changed: false })
    expect(await manager.removeBundle('extra')).toMatchObject({ application: 'failed', changed: false })
    await expect(manager.pendingPackageChange(requestId)).rejects.toThrow('unavailable')
    await expect(manager.listPendingPackageChanges()).rejects.toThrow('unavailable')
    await expect(manager.cancelPendingPackageChange(requestId)).rejects.toThrow('unavailable')
    expect(service.stage).not.toHaveBeenCalled()
    expect(service.status).not.toHaveBeenCalled()
    expect(service.listPending).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
    unchanged()
  })

  it.each([
    { label: 'invalid fingerprint', result: { ...prepared(), baseFingerprint: 'not-a-fingerprint' } },
    { label: 'another transaction', result: prepared('addon', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') },
  ])('refuses $label from the launcher without reporting PREPARED or changing active files', async ({ result }) => {
    const service = transactions()
    service.stage.mockResolvedValue(result)
    service.status.mockResolvedValue(result)
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    const installed = await manager.installBundle('addon', { requestId })
    expect(installed).toMatchObject({ application: 'failed', changed: false, error: { code: 'operation-error' } })
    expect(installed.prepared).toBeUndefined()
    await expect(manager.pendingPackageChange(requestId)).rejects.toThrow()
    expect(service.cancel).not.toHaveBeenCalled()
    unchanged()
  })

  it.each([undefined, false, true])('returns PREPARED without enabling or writing the active profile (enabled: %s)', async (enabled) => {
    const service = transactions()
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    const result = await manager.installBundle('addon@2', { requestId, ...enabled === undefined ? {} : { enabled } })
    expect(service.stage).toHaveBeenCalledExactlyOnceWith(requestId, {
      kind: 'install', source: { schemaVersion: 1, type: 'packageSpec', spec: 'addon@2' },
      ...enabled === undefined ? {} : { enabled },
    }, expect.any(AbortSignal))
    expect(result).toMatchObject({ stage: 'install', target: 'addon', application: 'prepared', changed: false, prepared: prepared() })
    expect(result.packageResult).toBeUndefined()
    expect(result.bundle).toBeUndefined()
    expect((await manager.listBundles()).some(bundle => bundle.name === 'addon')).toBe(false)
    unchanged()
  })

  it('forwards verified Release identity and build approvals without granting live script permissions', async () => {
    const service = transactions()
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    const source = verifiedRelease()
    const result = await manager.installBundle(source, { requestId, enabled: false, approvedBuilds: ['native'] })
    expect(service.stage).toHaveBeenCalledExactlyOnceWith(requestId, {
      kind: 'install', source, enabled: false, approvedBuilds: ['native'],
    }, expect.any(AbortSignal))
    expect(result).toMatchObject({ application: 'prepared', changed: false, prepared: prepared() })
    expect(result.approvedBuilds).toBeUndefined()
    unchanged()
  })

  it('preserves launcher failure diagnostics without stock mutation or rollback', async () => {
    const service = transactions()
    service.stage.mockRejectedValue(new Error('staged dependency resolution failed'))
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    expect(await manager.installBundle('addon', { requestId, approvedBuilds: ['native'] })).toMatchObject({
      application: 'failed', changed: false, stage: 'install', target: 'addon',
      error: { code: 'operation-error', diagnostic: 'staged dependency resolution failed' },
    })
    expect(service.stage).toHaveBeenCalledOnce()
    expect(service.cancel).not.toHaveBeenCalled()
    expect(await manager.cancelInstall(requestId)).toEqual({ status: 'not-running' })
    unchanged()
  })

  it('cancels an in-flight launcher request and waits for settlement without restoring active files', async () => {
    const service = transactions()
    const entered = Promise.withResolvers<AbortSignal>()
    service.stage.mockImplementation(async (_id, _mutation, signal) => {
      const aborted = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      entered.resolve(signal)
      await aborted
      // The launcher transport acknowledges only after owned work and cleanup have settled.
      throw new ProfilePackageCancelledError()
    })
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    const installing = manager.installBundle('addon', { requestId, approvedBuilds: ['native'] })
    const signal = await entered.promise
    expect(signal.aborted).toBe(false)
    expect(await manager.cancelInstall(requestId)).toEqual({ status: 'cancelled' })
    expect(signal.aborted).toBe(true)
    expect(await installing).toMatchObject({ application: 'cancelled', changed: false, stage: 'install' })
    expect((await installing).error).toBeUndefined()
    expect(service.cancel).not.toHaveBeenCalled()
    expect(await manager.cancelInstall(requestId)).toEqual({ status: 'not-running' })
    unchanged()
  })

  it('rejects a duplicate in-flight UUID without replacing its cancellation owner and permits reuse after settlement', async () => {
    const service = transactions()
    const entered = Promise.withResolvers<AbortSignal>()
    service.stage.mockImplementation(async (_id, _mutation, signal) => {
      const aborted = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      entered.resolve(signal)
      await aborted
      throw new ProfilePackageCancelledError()
    })
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    const installing = manager.installBundle('addon', { requestId })
    const signal = await entered.promise
    expect(await manager.installBundle('other-bundle', { requestId })).toEqual({
      stage: 'install', target: 'other-bundle', changed: false, application: 'failed',
      error: { code: 'operation-error', diagnostic: 'An installation with this request id is already running' },
    })
    expect(signal.aborted).toBe(false)
    expect(service.stage).toHaveBeenCalledOnce()
    expect(await manager.cancelInstall(requestId)).toEqual({ status: 'cancelled' })
    expect(signal.aborted).toBe(true)
    expect(await installing).toMatchObject({ application: 'cancelled', changed: false })
    service.stage.mockResolvedValue(prepared())
    expect(await manager.installBundle('addon', { requestId })).toMatchObject({ application: 'prepared', prepared: prepared() })
    expect(service.stage).toHaveBeenCalledTimes(2)
    unchanged()
  })

  it('checks cancellation again after asynchronous validation before entering the launcher', async () => {
    const service = transactions()
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    const progress: PluginInstallProgress[] = []
    ctx.on('plugin-manager/install-state', (update) => { progress.push(update) })
    const installing = manager.installBundle('addon', { requestId })
    // Unlike notification-time cancellation, stagePackage has already entered its await when this call returns.
    const cancelling = manager.cancelInstall(requestId)
    expect(await cancelling).toEqual({ status: 'cancelled' })
    expect(await installing).toMatchObject({ application: 'cancelled', changed: false, stage: 'install' })
    expect(progress).toEqual([{ requestId, phase: 'installing' }, { requestId, phase: 'cancelling' }])
    expect(service.stage).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
    unchanged()
  })

  it('joins a cancellation requested synchronously from the installing notification', async () => {
    const service = transactions()
    const { ctx, manager } = await stagedFixture(service)
    let cancellation: ReturnType<typeof manager.cancelInstall> | undefined
    ctx.on('plugin-manager/install-state', (update) => {
      if (update.phase === 'installing') cancellation = manager.cancelInstall(update.requestId)
    })
    const result = await manager.installBundle('addon', { requestId })
    expect(result.application).toBe('cancelled')
    expect(await cancellation).toEqual({ status: 'cancelled' })
    expect(service.stage).not.toHaveBeenCalled()
  })

  it('does not acknowledge cancellation when the aborted launcher reports cleanup failure', async () => {
    const service = transactions()
    const entered = Promise.withResolvers<AbortSignal>()
    service.stage.mockImplementation(async (_id, _mutation, signal) => {
      const aborted = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      entered.resolve(signal)
      await aborted
      throw Object.assign(new Error('EPERM: candidate cleanup failed'), { code: 'EPERM' })
    })
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    const installing = manager.installBundle('addon', { requestId })
    const signal = await entered.promise
    await expect(manager.cancelInstall(requestId)).rejects.toThrow('candidate cleanup failed')
    expect(signal.aborted).toBe(true)
    expect(await installing).toMatchObject({ application: 'failed', changed: false,
      error: { diagnostic: 'EPERM: candidate cleanup failed' } })
    unchanged()
  })

  it.each(['null-prototype rejection', 'throwing error message'] as const)(
    'settles installation and joined cancellation when a public launcher diagnostic cannot be formatted: %s', async (kind) => {
      const service = transactions()
      const entered = Promise.withResolvers<AbortSignal>()
      const brokenError = new Error('unreadable launcher error')
      Object.defineProperty(brokenError, 'message', { get() { throw 'launcher diagnostic getter failed' } })
      const rejection: unknown = kind === 'null-prototype rejection' ? Object.create(null) : brokenError
      service.stage.mockImplementation(async (_id, _mutation, signal) => {
        const aborted = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
        entered.resolve(signal)
        await aborted
        throw rejection
      })
      const { ctx, dir, manager } = await stagedFixture(service)
      const unchanged = observeActiveProfile(ctx, dir)
      const installing = manager.installBundle('addon', { requestId }).catch((error: unknown) => error)
      const signal = await entered.promise
      const cancelling = manager.cancelInstall(requestId).catch((error: unknown) => error)
      const [installFailure, cancelFailure] = await Promise.all([installing, cancelling])
      expect(signal.aborted).toBe(true)
      expect(cancelFailure).toBeInstanceOf(Error)
      if (kind === 'null-prototype rejection') {
        expect(installFailure).toBeInstanceOf(TypeError)
        expect(cancelFailure).toBe(installFailure)
      } else {
        expect(installFailure).toBe('launcher diagnostic getter failed')
        expect(cancelFailure).toMatchObject({ message: 'launcher diagnostic getter failed' })
      }
      expect(await manager.cancelInstall(requestId)).toEqual({ status: 'not-running' })
      expect(service.stage).toHaveBeenCalledOnce()
      expect(service.cancel).not.toHaveBeenCalled()
      unchanged()
    },
  )

  it('saves staged-profile enablement under the shared lease and succeeds again after a competing writer releases it', async () => {
    const service = transactions()
    const { manager, dir } = await stagedFixture(service, 'startup')
    const patch = readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')
    const pnpm = vi.spyOn(operations, 'runProfilePnpm')
    onTestFinished(() => { pnpm.mockRestore() })
    expect(await manager.setBundleEnabled('extra', false)).toMatchObject({ changed: true, application: 'restart-required' })
    expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core'])
    await withProfilePackageLease(dir, async () => {
      await expect(manager.setBundleEnabled('extra', true)).rejects.toThrow('writer lock')
      expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core'])
    })
    expect(await manager.setBundleEnabled('extra', true)).toMatchObject({ changed: true, application: 'restart-required' })
    expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toEqual(['core', 'extra'])
    expect(readFileSync(join(dir, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(pnpm).not.toHaveBeenCalled()
    expect(service.stage).not.toHaveBeenCalled()
  })

  it('fails busy rather than holding a configuration write across activation and Host disposal', async () => {
    const { ctx, dir, manager } = await stagedFixture(transactions())
    const unchanged = observeActiveProfile(ctx, dir)
    await withProfilePackageLease(dir, async () => {
      await expect(manager.setBundleEnabled('extra', false)).rejects.toThrow('writer lock')
      unchanged()
      const manifest = readFileSync(join(dir, 'package.json'), 'utf8')
      await ctx.fiber.dispose()
      expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifest)
    })
  })

  it('reports too-late when durable PREPARED wins the cancellation race', async () => {
    const service = transactions()
    const committed = Promise.withResolvers<undefined>()
    service.stage.mockImplementation(async (_id, _mutation, signal) => {
      const aborted = new Promise<void>((resolve) => { signal.addEventListener('abort', () => { resolve() }, { once: true }) })
      service.status.mockResolvedValue(prepared())
      committed.resolve(undefined)
      await aborted
      // The backend committed before cancellation; delivery was still in flight.
      return prepared()
    })
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    const installing = manager.installBundle('addon', { requestId })
    await committed.promise
    expect(await manager.cancelInstall(requestId)).toEqual({ status: 'too-late' })
    expect(await installing).toMatchObject({ application: 'prepared', changed: false, prepared: prepared() })
    expect(await manager.pendingPackageChange(requestId)).toEqual(prepared())
    expect(service.cancel).not.toHaveBeenCalled()
    unchanged()
  })

  it.each(['live', 'startup'] as const)('delegates removal before disabling or unloading an active bundle (%s)', async (reload) => {
    const service = transactions()
    const { ctx, dir, manager } = await stagedFixture(service, reload)
    const unchanged = observeActiveProfile(ctx, dir)
    service.stage.mockImplementation(async (id, mutation) => {
      unchanged()
      expect(mutation).toEqual({ kind: 'remove', name: 'extra' })
      expect(readProfileManifest('test', dir).dsh?.profile?.bundles).toContain('extra')
      return prepared('extra', id)
    })
    expect(await manager.removeBundle('extra')).toMatchObject({
      stage: 'remove', target: 'extra', application: 'prepared', changed: false, prepared: { state: 'prepared', packageName: 'extra' },
    })
    expect(service.stage).toHaveBeenCalledOnce()
    service.stage.mockRejectedValueOnce(new Error('removal staging failed'))
    expect(await manager.removeBundle('extra')).toMatchObject({ application: 'failed', changed: false, error: { diagnostic: 'removal staging failed' } })
    unchanged()
  })

  it('reads and cancels the launcher-owned pending record by transaction id only', async () => {
    const service = transactions()
    service.status.mockResolvedValue(prepared())
    service.listPending.mockResolvedValue([prepared()])
    service.cancel.mockImplementation(async () => {
      service.status.mockResolvedValue(undefined)
      service.listPending.mockResolvedValue([])
    })
    const { ctx, dir, manager } = await stagedFixture(service)
    const unchanged = observeActiveProfile(ctx, dir)
    // Lookup also works without this manager instance having initiated the install.
    expect(await manager.listPendingPackageChanges()).toEqual([prepared()])
    expect(service.listPending).toHaveBeenCalledExactlyOnceWith()
    expect(await manager.pendingPackageChange(requestId)).toEqual(prepared())
    expect(service.status).toHaveBeenCalledExactlyOnceWith(requestId)
    await manager.cancelPendingPackageChange(requestId)
    expect(service.cancel).toHaveBeenCalledExactlyOnceWith(requestId)
    expect(await manager.pendingPackageChange(requestId)).toBeUndefined()
    expect(await manager.listPendingPackageChanges()).toEqual([])
    await expect(manager.cancelPendingPackageChange('../active-profile')).rejects.toThrow('invalid transaction id')
    expect(service.cancel).toHaveBeenCalledOnce()
    expect(service.stage).not.toHaveBeenCalled()
    unchanged()
  })

  it('retains stock installation and live removal when a normal profile has no staging opt-in', async () => {
    const service = transactions()
    const { ctx, dir, manager, bundle } = await fixture('live', false, (ctx) => { ctx.provide('profilePackageTransactions', service) })
    const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, args) => {
      const manifest = readProfileManifest('test', dir)
      if (args[0] === 'add') {
        bundle('addon', [{ id: 'addon', name: './plugin.mjs', config: { service: 'addonProbe' } }])
        manifest.dependencies = { ...manifest.dependencies, addon: '2.0.0' }
      } else {
        expect(args).toEqual(['remove', 'addon'])
        expect(ctx.get('addonProbe')).toBeUndefined()
        expect(manifest.dsh?.profile?.bundles).not.toContain('addon')
        delete manifest.dependencies?.addon
      }
      writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
      return { exitCode: 0, output: '', truncated: false, logPath: join(dir, 'pnpm.log') }
    })
    onTestFinished(() => { pnpm.mockRestore() })
    expect(await manager.installBundle('addon', { requestId })).toMatchObject({ application: 'applied', changed: true, bundle: 'addon' })
    expect(ctx.get('addonProbe')).toBe(true)
    expect(await manager.removeBundle('addon')).toMatchObject({ application: 'applied', changed: true })
    expect(pnpm).toHaveBeenCalledTimes(2)
    expect(service.stage).not.toHaveBeenCalled()
    await expect(manager.pendingPackageChange(requestId)).rejects.toThrow('unavailable')
    await expect(manager.cancelPendingPackageChange(requestId)).rejects.toThrow('unavailable')
    expect(service.status).not.toHaveBeenCalled()
    expect(service.cancel).not.toHaveBeenCalled()
    expect(await manager.listPendingPackageChanges()).toEqual([])
    expect(service.listPending).not.toHaveBeenCalled()
  })
})
