/** Persistent manager behavior through a real profile Include and Loader. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { expect, it, onTestFinished, vi } from 'vitest'
import {
  ProfilePackageCancelledError, boot, composeEntries, initProfile, readProfilePatches, readProfileManifest, reconcileProfilePatches,
  type ProfileContext, type ProfilePackageTransactions, type ProfilePreparedPackageChange,
} from '@deepseek-ai/dsh-app-boot'
import PluginManager, { type Config, type PluginChange, type PluginInstallLogChunk, type PluginInstallProgress, type PluginInstallRequestId } from '../src/index.ts'
import Hmr from '@deepseek-ai/dsh-hmr'
import Timer from '@deepseek-ai/cordis-plugin-timer'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { Group } from '@deepseek-ai/cordis-plugin-loader'
import * as operations from '../src/operations.ts'
import * as atomicWrite from '@deepseek-ai/dsh-atomic-write'
import { parse, parseDocument } from 'yaml'

async function fixture(reload: 'live' | 'startup' = 'live', overlay = false, prepare?: (ctx: Context) => void,
  config: Config = {}, packageManager?: ProfileContext['packageManager'], staged = false) {
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
    watchProfilePatches: reload === 'live',
    ...(staged ? { stagedPackageTransactions: true } : {}),
    ...(packageManager === undefined ? {} : { packageManager }),
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

it.each(['startup', 'live'] as const)(
  'refuses staged Desktop mutations before files, pnpm or HMR in %s mode', async (reload) => {
    const { ctx, dir, manager, profile } = await fixture(reload, false, undefined, {}, undefined, true)
    const patch = readFileSync(profile.patchPath, 'utf8')
    const manifest = readFileSync(join(dir, 'package.json'), 'utf8')
    const policyPath = join(dir, 'pnpm-workspace.yaml')
    const lockPath = join(dir, 'pnpm-lock.yaml')
    const content = (path: string): string | undefined => existsSync(path) ? readFileSync(path, 'utf8') : undefined
    const policy = content(policyPath)
    const lock = content(lockPath)
    const changed: PluginChange[] = []
    ctx.on('plugin-manager/changed', (event) => { changed.push(event) })
    const hmr = ctx.get('hmr')
    const runExclusive = hmr === undefined ? undefined : vi.spyOn(hmr, 'runExclusive')
    const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
      throw new Error('staged Desktop operation must never start pnpm')
    })
    onTestFinished(() => { pnpm.mockRestore(); runExclusive?.mockRestore() })
    const plugin = (await manager.listPlugins()).find(row => row.patchId === 'managed')
    if (plugin === undefined) throw new Error('missing addressable plugin fixture')
    const refused = { changed: false, application: 'failed', error: {
      code: 'operation-error', diagnostic: 'Desktop package mutations require launcher-owned staging',
    } }
    expect(await manager.setPluginEnabled(plugin.entryId, false)).toMatchObject({ ...refused, stage: 'enable', enabled: false })
    expect(await manager.setBundleEnabled('extra', false)).toMatchObject({ ...refused, stage: 'enable', enabled: false })
    expect(await manager.installBundle('file:./untrusted', { enabled: false, approvedBuilds: ['native'] }))
      .toMatchObject({ ...refused, stage: 'install', target: 'launcher-owned', enabled: false })
    expect(await manager.removeBundle('extra')).toMatchObject({ ...refused, stage: 'remove', target: 'extra' })
    expect(pnpm).not.toHaveBeenCalled()
    expect(hmr !== undefined).toBe(reload === 'live')
    if (runExclusive !== undefined) expect(runExclusive).not.toHaveBeenCalled()
    expect(changed).toEqual([])
    expect(readFileSync(profile.patchPath, 'utf8')).toBe(patch)
    expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(manifest)
    expect(content(policyPath)).toBe(policy)
    expect(content(lockPath)).toBe(lock)
  },
)

const stagedRequestId = '11111111-1111-4111-8111-111111111111' as PluginInstallRequestId
const stagedPrepared: ProfilePreparedPackageChange = {
  transactionId: stagedRequestId, state: 'prepared', packageName: '@cloga/addon',
  baseFingerprint: 'a'.repeat(64), health: 'pending',
}
function stagedService() {
  return {
    protocolVersion: 1 as const,
    stage: vi.fn<ProfilePackageTransactions['stage']>().mockResolvedValue(stagedPrepared),
    status: vi.fn<ProfilePackageTransactions['status']>().mockResolvedValue(stagedPrepared),
    listPending: vi.fn<ProfilePackageTransactions['listPending']>().mockResolvedValue([stagedPrepared]),
    cancel: vi.fn<ProfilePackageTransactions['cancel']>().mockResolvedValue(undefined),
  }
}

it('delegates staged install/remove and pending views to the native owner without mutating the active profile', async () => {
  const service = stagedService()
  const { ctx, dir, manager, profile } = await fixture('startup', false,
    (root) => { root.provide('profilePackageTransactions', service) }, {}, undefined, true)
  const beforeManifest = readFileSync(join(dir, 'package.json'), 'utf8')
  const beforePatch = readFileSync(profile.patchPath, 'utf8')
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    throw new Error('staged Manager used stock live pnpm')
  })
  onTestFinished(() => { pnpm.mockRestore() })
  const installed = await manager.installBundle('@cloga/addon@1.2.3', { requestId: stagedRequestId, enabled: false })
  expect(installed).toMatchObject({ stage: 'install', target: '@cloga/addon', application: 'prepared',
    changed: false, prepared: stagedPrepared })
  expect(service.stage).toHaveBeenCalledExactlyOnceWith(stagedRequestId, {
    kind: 'install', source: { schemaVersion: 1, type: 'packageSpec', spec: '@cloga/addon@1.2.3' }, enabled: false,
  }, expect.any(AbortSignal))
  expect(await manager.pendingPackageChange(stagedRequestId)).toEqual(stagedPrepared)
  expect(await manager.listPendingPackageChanges()).toEqual([stagedPrepared])
  service.cancel.mockImplementation(async () => { service.status.mockResolvedValue(undefined) })
  await manager.cancelPendingPackageChange(stagedRequestId)
  expect(await manager.pendingPackageChange(stagedRequestId)).toBeUndefined()
  service.stage.mockImplementation(async id => ({ ...stagedPrepared, transactionId: id, packageName: 'extra' }))
  expect(await manager.removeBundle('extra')).toMatchObject({ stage: 'remove', target: 'extra',
    application: 'prepared', changed: false, prepared: { packageName: 'extra', health: 'pending' } })
  expect(pnpm).not.toHaveBeenCalled()
  expect(ctx.get('hmr')).toBeUndefined()
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(beforeManifest)
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(beforePatch)
})

it('never exposes signed source or backend output in a staged Remote result or install-log event', async () => {
  const service = stagedService()
  service.stage.mockRejectedValue(new Error('pnpm output https://private.invalid/file?sig=private-sentinel'))
  const { ctx, manager } = await fixture('startup', false,
    (root) => { root.provide('profilePackageTransactions', service) }, {}, undefined, true)
  const logs: PluginInstallLogChunk[] = []
  ctx.on('plugin-manager/install-log', (chunk) => { logs.push(chunk) })
  const result = await manager.installBundle('https://private.invalid/file?sig=private-sentinel', { requestId: stagedRequestId })
  expect(result).toMatchObject({ stage: 'install', target: 'launcher-owned', application: 'failed', changed: false,
    error: { code: 'operation-error', diagnostic: 'Desktop package staging failed' } })
  expect(JSON.stringify(result)).not.toContain('private-sentinel')
  expect(logs).toEqual([])
})

it('refuses a mismatched native prepared identity and never calls staged toggles as live writes', async () => {
  const service = stagedService()
  const { manager, profile, dir } = await fixture('startup', false,
    (root) => { root.provide('profilePackageTransactions', service) }, {}, undefined, true)
  const before = readFileSync(profile.patchPath, 'utf8')
  service.stage.mockResolvedValue({ ...stagedPrepared, transactionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' })
  expect(await manager.installBundle('addon', { requestId: stagedRequestId })).toMatchObject({
    application: 'failed', changed: false, error: { code: 'operation-error', diagnostic: 'Desktop package staging failed' },
  })
  service.stage.mockImplementation(async id => ({ ...stagedPrepared, transactionId: id, packageName: 'foreign' }))
  expect(await manager.removeBundle('extra')).toMatchObject({
    application: 'failed', changed: false, error: { code: 'operation-error', diagnostic: 'Desktop package staging failed' },
  })
  const plugin = (await manager.listPlugins()).find(row => row.patchId === 'managed')!
  expect(await manager.setPluginEnabled(plugin.entryId, false)).toMatchObject({ application: 'failed', changed: false })
  expect(await manager.setBundleEnabled('extra', false)).toMatchObject({ application: 'failed', changed: false })
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(before)
  expect(readProfileManifest('test', dir).dependencies).toEqual({ extra: '1.0.0' })
})

it('acknowledges an in-flight staged cancellation only after the owner confirms cleanup', async () => {
  const service = stagedService()
  const entered = Promise.withResolvers<AbortSignal>()
  const ready = Promise.withResolvers<ProfilePreparedPackageChange>()
  service.stage.mockImplementation((_id, _request, signal) => { entered.resolve(signal); return ready.promise })
  const { manager } = await fixture('startup', false,
    (root) => { root.provide('profilePackageTransactions', service) }, {}, undefined, true)
  const installing = manager.installBundle('addon', { requestId: stagedRequestId })
  const signal = await entered.promise
  const stopping = manager.cancelInstall(stagedRequestId)
  expect(signal.aborted).toBe(true)
  let settled = false
  void stopping.then(() => { settled = true })
  await Promise.resolve()
  expect(settled).toBe(false)
  ready.reject(new ProfilePackageCancelledError())
  expect(await installing).toMatchObject({ application: 'cancelled', changed: false })
  expect(await stopping).toEqual({ status: 'cancelled' })
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

it('refuses a duplicate in-flight stock request id without replacing its cancellation owner', async () => {
  const { manager, dir } = await fixture('startup')
  const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
  const started = Promise.withResolvers<undefined>()
  const release = Promise.withResolvers<undefined>()
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async (_context, _args, options) => {
    started.resolve(undefined)
    if (options.signal?.aborted) release.resolve(undefined)
    else options.signal?.addEventListener('abort', () => { release.resolve(undefined) }, { once: true })
    await release.promise
    return { exitCode: 1, output: 'cancelled', truncated: false, logPath: join(dir, 'pnpm.log') }
  })
  onTestFinished(() => { release.resolve(undefined); pnpm.mockRestore() })
  const first = manager.installBundle('slow', { requestId })
  await started.promise
  expect(await manager.installBundle('other', { requestId })).toMatchObject({
    changed: false, application: 'failed', target: 'request-in-progress',
    error: { code: 'operation-error', diagnostic: 'An installation with this request id is already running' },
  })
  expect(pnpm).toHaveBeenCalledOnce()
  expect(await manager.cancelInstall(requestId)).toEqual({ status: 'cancelled' })
  expect(await first).toMatchObject({ application: 'cancelled', changed: false })
  expect(await manager.cancelInstall(requestId)).toEqual({ status: 'not-running' })
})

it('reports a writer-lock rejection to an already joined cancellation instead of claiming cleanup', async () => {
  const { dir, manager } = await fixture('startup', false, undefined, { lockWaitMs: 0 })
  const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
  const manifest = join(dir, 'package.json')
  const before = readFileSync(manifest, 'utf8')
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    throw new Error('writer lock rejection must not start pnpm')
  })
  onTestFinished(() => { pnpm.mockRestore() })
  await atomicWrite.withFileLock(manifest, async () => {
    const owner = readFileSync(`${manifest}.lock`, 'utf8')
    const installing = manager.installBundle('addon', { requestId })
    const cancelling = manager.cancelInstall(requestId)
    await Promise.all([
      expect(installing).rejects.toThrow('writer lock'),
      expect(cancelling).rejects.toThrow('writer lock'),
    ])
    expect(readFileSync(`${manifest}.lock`, 'utf8')).toBe(owner)
    expect(readFileSync(manifest, 'utf8')).toBe(before)
  })
  expect(pnpm).not.toHaveBeenCalled()
  expect(await manager.cancelInstall(requestId)).toEqual({ status: 'not-running' })
})

it('never acknowledges cancellation after invalid stock input fails without a diagnostic', async () => {
  const { manager, dir } = await fixture('startup')
  const requestId = 'f2340b6d-40bb-46b7-8b94-217bdf5010bd' as PluginInstallRequestId
  const before = readFileSync(join(dir, 'package.json'), 'utf8')
  const pnpm = vi.spyOn(operations, 'runProfilePnpm').mockImplementation(async () => {
    throw new Error('invalid input must not start pnpm')
  })
  onTestFinished(() => { pnpm.mockRestore() })
  const installing = manager.installBundle('', { requestId })
  const cancelling = manager.cancelInstall(requestId)
  await expect(cancelling).rejects.toThrow('Package cleanup failed; cancellation was not confirmed')
  const outcome = await installing
  expect(outcome).toMatchObject({ application: 'failed', changed: false, error: { code: 'invalid-spec' } })
  expect(outcome.error?.diagnostic).toBeUndefined()
  expect(readFileSync(join(dir, 'package.json'), 'utf8')).toBe(before)
  expect(pnpm).not.toHaveBeenCalled()
  expect(await manager.cancelInstall(requestId)).toEqual({ status: 'not-running' })
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

it('lists installation-supplied dormant bundles without inventing an optional offer', async () => {
  const { manager, profile } = await fixture()
  // The installation owns this package, but this fork has no reviewed optional-offer list.
  // Its node_modules is consulted before the profile's and before the repository's.
  const offered = '@test/installation-supplied'
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
    enabled: false, installed: false, optional: false, removable: false,
    rows: [{ rowId: 'offered-row', moduleName: pathToFileURL(join(supplied, 'plugin.mjs')).href }], overrides: [],
  })
  expect(await manager.setBundleEnabled(offered, true)).toMatchObject({ application: 'applied' })
  expect((await manager.listBundles()).find(row => row.name === offered))
    .toMatchObject({ enabled: true, optional: false, removable: false })
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
  expect(profile.watchProfilePatches).toBe(true)
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
  const startedAt = Date.now()
  const phases: string[] = []
  const mark = (phase: string): void => { phases.push(`${phase}:${Date.now() - startedAt}ms`) }
  let completed = false
  onTestFinished(() => {
    if (!completed) console.warn('manager bundled pnpm fixture phases', Object.freeze([...phases]).join(', '))
  })
  const pnpm = fileURLToPath(new URL('../../../../apps/desktop/node_modules/pnpm/bin/pnpm.mjs', import.meta.url))
  const { manager, dir } = await fixture('startup', false, undefined, { pnpmCommand: 'must-not-be-used' }, {
    command: process.execPath, args: ['--expose-internals', pnpm], env: { PATH: '', ELECTRON_RUN_AS_NODE: '1' },
  })
  mark('fixture-ready')
  const target = join(dir, 'local-bundle')
  mkdirSync(target)
  writeFileSync(join(target, 'package.json'), JSON.stringify({ name: '@test/desktop-manager', version: '1.0.0',
    dsh: { bundle: { patch: './cordis.patch.yml' } } }))
  writeFileSync(join(target, 'cordis.patch.yml'), '[]\n')
  // Fixture-only packages need no registry resolution during this local install.
  const manifest = readProfileManifest('test', dir)
  delete manifest.dependencies
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  mark('local-bundle-ready')
  const installed = await manager.installBundle(target)
  mark('install-settled')
  expect(installed.error).toBeUndefined()
  expect(installed.packageResult?.exitCode).toBe(0)
  expect(readProfileManifest('test', dir).dependencies).toHaveProperty('@test/desktop-manager')
  mark('install-observed')
  const removed = await manager.removeBundle('@test/desktop-manager')
  mark('remove-settled')
  expect(removed.error).toBeUndefined()
  expect(removed.packageResult?.exitCode).toBe(0)
  expect(readProfileManifest('test', dir).dependencies ?? {}).not.toHaveProperty('@test/desktop-manager')
  completed = true
})
