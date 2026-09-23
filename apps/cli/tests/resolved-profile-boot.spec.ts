/** Application-owned profiles share the named profile launch lifecycle. */
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import {
  boot, composeEntries, createProfileResolutionGeneration, healIsolatedProfileModuleFallback,
  PluginPackages, type Profile, type ProfilePackageTransactions,
} from '@deepseek-ai/dsh-app-boot'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runProfile } from '../src/profile-boot.ts'

vi.mock('@deepseek-ai/dsh-app-boot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>()
  return {
    ...actual,
    boot: vi.fn(),
    createProfileResolutionGeneration: vi.fn(actual.createProfileResolutionGeneration),
    healIsolatedProfileModuleFallback: vi.fn(actual.healIsolatedProfileModuleFallback),
    installFailLoud: vi.fn(),
  }
})
vi.mock('@deepseek-ai/dsh-http-proxy', () => ({ installProxyFromEnvironment: vi.fn() }))

const homes: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.resetAllMocks()
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('runProfile with an application-owned profile', () => {
  it('rejects a foreign resolved profile identity before installing proxy or loading a tree', async () => {
    const profile: Profile = { name: 'foreign', dir: tmpdir(), patchPath: join(tmpdir(), 'unused.patch.yml'),
      layers: [], patches: [], patchReload: 'startup' }
    await expect(runProfile({ environment: createLaunchEnvironmentSnapshot([]), profile: 'desktop',
      resolvedProfile: { profile, installAnchor: join(tmpdir(), 'unused-runtime.json') }, patchFiles: [], args: [],
    })).rejects.toThrow('profile name differs from the requested launch identity')
    expect(installProxyFromEnvironment).not.toHaveBeenCalled()
    expect(boot).not.toHaveBeenCalled()
  })

  it.each(
    (['link', 'runtime'] as const).flatMap(resolutionMode =>
      (['composition', 'prepare', 'boot', 'cleanup', 'tree-cleanup', 'both-cleanups'] as const)
        .map(stage => ({ resolutionMode, stage }))),
  )('releases startup resources after a $stage failure in $resolutionMode mode', async ({ resolutionMode, stage }) => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-profile-startup-failure-'))
    homes.push(home)
    mkdirSync(join(home, 'runtime'))
    writeFileSync(join(home, 'runtime/package.json'), '{"name":"test-runtime","version":"1.0.0"}')
    writeFileSync(join(home, 'package.json'), '{"name":"test-bundle","version":"1.0.0"}')
    vi.stubEnv('DSH_HOME', home)
    vi.spyOn(process, 'on').mockReturnValue(process)
    const ctx = new Context()
    ctx.provide('loader', { create: vi.fn() })
    ctx.provide('hmr', {})
    const dispose = vi.spyOn(ctx.fiber, 'dispose')
    const failure = new Error('startup failed')
    const cleanupFailure = new Error('proxy cleanup failed')
    const treeCleanupFailure = new Error('tree cleanup failed')
    if (stage === 'tree-cleanup' || stage === 'both-cleanups') dispose.mockRejectedValueOnce(treeCleanupFailure)
    const disposeProxy = vi.fn().mockImplementation(() => stage === 'cleanup' || stage === 'both-cleanups'
      ? Promise.reject(cleanupFailure)
      : Promise.resolve())
    vi.mocked(installProxyFromEnvironment).mockResolvedValue(disposeProxy)
    vi.mocked(boot).mockImplementation(async (_name, _root, _patches, setup) => {
      await setup?.(ctx)
      throw failure
    })
    if (stage === 'composition') vi.mocked(createProfileResolutionGeneration).mockRejectedValueOnce(failure)
    const profile: Profile = {
      name: 'desktop', dir: home, patchPath: join(home, 'cordis.patch.yml'),
      patches: [], layers: [], patchReload: 'startup',
    }
    try {
      const application = runProfile({
        environment: createLaunchEnvironmentSnapshot([]), profile: 'desktop', patchFiles: [], args: ['--no-open'],
        resolutionMode,
        resolvedProfile: { profile, installAnchor: join(home, 'runtime/package.json') },
        ...(stage === 'prepare' ? { prepare: () => { throw failure } } : {}),
      })
      if (stage === 'both-cleanups') {
        await expect(application).rejects.toMatchObject({ errors: [failure, { errors: [treeCleanupFailure, cleanupFailure] }] })
      } else if (stage === 'tree-cleanup') {
        await expect(application).rejects.toMatchObject({ errors: [failure, treeCleanupFailure] })
      } else if (stage === 'cleanup') {
        await expect(application).rejects.toMatchObject({ errors: [failure, cleanupFailure] })
      } else {
        await expect(application).rejects.toBe(failure)
      }
      expect(disposeProxy).toHaveBeenCalledOnce()
      expect(boot).toHaveBeenCalledTimes(stage === 'composition' ? 0 : 1)
      expect(dispose).toHaveBeenCalledTimes(stage === 'composition' ? 0 : 1)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it.each(['named-live', 'named-startup', 'home', 'overlay', 'application-owned', 'application-group-config', 'inserted-other-id'] as const)(
    'refuses a %s name-qualified legacy HMR patch without touching user choices', async (source) => {
      const home = mkdtempSync(join(tmpdir(), 'dsh-legacy-hmr-patch-'))
      homes.push(home)
      const owned = source === 'application-owned' || source === 'application-group-config'
      const profileDir = owned ? home : join(home, 'profiles', 'custom')
      mkdirSync(profileDir, { recursive: true })
      const runtime = join(home, 'runtime')
      mkdirSync(runtime)
      writeFileSync(join(runtime, 'package.json'), '{"name":"test-runtime","version":"1.0.0"}')
      writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ name: owned ? 'desktop' : 'custom',
        dsh: { profile: { bundles: [], patchReload: source === 'named-startup' || owned ? 'startup' : 'live' } } }))
      const legacy = source === 'inserted-other-id'
        ? "- insert:\n    - id: custom-hmr\n      name: '@deepseek-ai/cordis-plugin-hmr'\n      disabled: false\n"
        : source === 'application-group-config'
          ? "- id: group\n  config:\n    - id: custom-hmr\n      name: '@deepseek-ai/cordis-plugin-hmr'\n      disabled: false\n"
          : "- id: hmr\n  name: '@deepseek-ai/cordis-plugin-hmr'\n  disabled: false\n"
      const profilePatch = join(profileDir, owned ? 'profile.patch.yml' : 'cordis.patch.yml')
      const homePatch = join(home, 'cordis.patch.yml')
      const overlay = join(home, 'legacy-overlay.yml')
      writeFileSync(profilePatch, source === 'named-live' || source === 'named-startup'
        || source === 'inserted-other-id' || source === 'application-group-config' ? legacy : '[]\n')
      if (homePatch !== profilePatch) writeFileSync(homePatch, source === 'home' ? legacy : '[]\n')
      writeFileSync(overlay, source === 'overlay' ? legacy : '[]\n')
      const record = source === 'home' ? homePatch : source === 'overlay' ? overlay : profilePatch
      const previous = readFileSync(record, 'utf8')
      vi.stubEnv('DSH_HOME', home)
      const releaseProxy = vi.fn().mockResolvedValue(undefined)
      vi.mocked(installProxyFromEnvironment).mockResolvedValue(releaseProxy)
      const groupOverride = source === 'application-group-config'
      const profile: Profile = { name: 'desktop', dir: profileDir, patchPath: profilePatch,
        layers: groupOverride ? [{ packageName: 'desktop', packageDir: profileDir, patchPath: join(profileDir, 'bundle.yml'),
          patches: [{ insert: [{ id: 'group', name: 'cordis:group', group: true, config: [] }] }] }] : [],
        patches: groupOverride ? [{ id: 'group', config: [
          { id: 'custom-hmr', name: '@deepseek-ai/cordis-plugin-hmr', disabled: false },
        ] }] : [{ id: 'hmr', name: '@deepseek-ai/cordis-plugin-hmr', disabled: false }],
        patchReload: 'startup' }
      await expect(runProfile({ environment: createLaunchEnvironmentSnapshot([]),
        profile: owned ? 'desktop' : 'custom', patchFiles: source === 'overlay' ? [overlay] : [], args: [],
        ...(owned ? { resolvedProfile: { profile, installAnchor: join(runtime, 'package.json') } } : {}),
      })).rejects.toThrow('legacy HMR module or name-qualified override')
      expect(readFileSync(record, 'utf8')).toBe(previous)
      expect(boot).not.toHaveBeenCalled()
      expect(releaseProxy).toHaveBeenCalledOnce()
    },
  )

  it.each(['absent', 'wrong-protocol'] as const)('refuses %s staged package authority before profile entries mount', async (kind) => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-profile-staging-refusal-'))
    homes.push(home)
    mkdirSync(join(home, 'runtime'))
    writeFileSync(join(home, 'runtime/package.json'), '{"name":"test-runtime","version":"1.0.0"}')
    writeFileSync(join(home, 'package.json'), '{"name":"test-bundle","version":"1.0.0"}')
    vi.stubEnv('DSH_HOME', home)
    vi.spyOn(process, 'on').mockReturnValue(process)
    const ctx = new Context()
    ctx.provide('loader', { create: vi.fn() })
    const dispose = vi.spyOn(ctx.fiber, 'dispose')
    const disposeProxy = vi.fn().mockResolvedValue(undefined)
    vi.mocked(installProxyFromEnvironment).mockResolvedValue(disposeProxy)
    const mounted = vi.fn()
    vi.mocked(boot).mockImplementation(async (_name, _root, _patches, setup) => {
      await setup?.(ctx)
      mounted()
      return ctx
    })
    const profile: Profile = { name: 'desktop', dir: home, patchPath: join(home, 'cordis.patch.yml'),
      layers: [], patches: [], patchReload: 'startup' }
    try {
      await expect(runProfile({
        environment: createLaunchEnvironmentSnapshot([]), profile: 'desktop', patchFiles: [], args: [],
        resolvedProfile: { profile, installAnchor: join(home, 'runtime/package.json') },
        stagedPackageTransactions: true,
        ...(kind === 'wrong-protocol' ? { prepare: (owner: Context) => {
          owner.provide('profilePackageTransactions', { protocolVersion: 2 } as unknown as ProfilePackageTransactions)
        } } : {}),
      })).rejects.toThrow('launcher package staging is required but unavailable')
      expect(mounted).not.toHaveBeenCalled()
      expect(dispose).toHaveBeenCalledOnce()
      expect(disposeProxy).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })

  it.each([
    { selection: 'default', options: {}, mode: 'runtime' },
    { selection: 'link', options: { resolutionMode: 'link' }, mode: 'link' },
    { selection: 'dual', options: { resolutionMode: 'dual' }, mode: 'dual' },
    { selection: 'runtime', options: { resolutionMode: 'runtime' }, mode: 'runtime' },
  ] as const)('uses shared layers, $selection resolution, and shutdown', async ({ selection, options, mode }) => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-resolved-profile-'))
    homes.push(home)
    mkdirSync(join(home, 'runtime'))
    writeFileSync(join(home, 'runtime/package.json'), '{"name":"test-runtime","version":"1.0.0","exports":"./index.cjs"}')
    writeFileSync(join(home, 'runtime/index.cjs'), 'module.exports = "installation"\n')
    writeFileSync(join(home, 'package.json'), '{"name":"test-bundle","version":"1.0.0","dependencies":{"test-local":"*"}}')
    const localPackageDir = join(home, 'node_modules/test-local')
    mkdirSync(localPackageDir, { recursive: true })
    const localManifest = '{"name":"test-local","version":"1.0.0","exports":"./index.cjs"}'
    writeFileSync(join(localPackageDir, 'package.json'), localManifest)
    writeFileSync(join(localPackageDir, 'index.cjs'), 'module.exports = "profile"\n')
    vi.stubEnv('DSH_HOME', home)
    vi.stubEnv('DSH_TELEMETRY_DISABLED', '1')
    vi.spyOn(process, 'on').mockReturnValue(process)
    const oldExitCode = process.exitCode
    const ctx = new Context()
    const plugin = vi.spyOn(ctx, 'plugin')
    // An application-owned startup-frozen profile must not acquire HMR implicitly.
    ctx.provide('loader', { create: vi.fn() })
    const dispose = vi.spyOn(ctx.fiber, 'dispose')
    const disposeProxy = vi.fn().mockResolvedValue(undefined)
    vi.mocked(installProxyFromEnvironment).mockResolvedValue(disposeProxy)
    vi.mocked(boot).mockImplementation(async (_name, _root, _patches, setup) => {
      await setup?.(ctx)
      return ctx
    })
    const homePatch = join(home, 'cordis.patch.yml')
    const profilePatch = join(home, 'profile.patch.yml')
    const overlay = join(home, 'desktop.patch.yml')
    writeFileSync(homePatch, '- id: target\n  config: { home: true, priority: home }\n')
    writeFileSync(profilePatch, '- id: target\n  config: { profile: true, priority: profile }\n')
    writeFileSync(overlay, '- id: target\n  config: { overlay: true, priority: overlay }\n')
    writeFileSync(join(home, 'cordis.yml'), '# previously derived empty root\n[]\n')
    const profile: Profile = {
      name: 'desktop', dir: home, patchPath: profilePatch, patchReload: 'live',
      patches: [{ id: 'target', config: { profile: true, priority: 'profile' } }],
      layers: [{
        packageName: 'test-bundle', packageDir: home, patchPath: join(home, 'bundle.yml'),
        patches: [{ insert: [
          { id: 'target', name: 'target', config: { bundle: true, priority: 'bundle' } },
          { id: 'session-telemetry-otel', name: 'telemetry' },
        ] }],
      }],
    }
    const environment = createLaunchEnvironmentSnapshot([{ source: 'process', values: { HTTPS_PROXY: 'http://localhost:8080' } }])
    const runtime = { profile, installAnchor: join(home, 'runtime/package.json') }
    const stagedService: ProfilePackageTransactions = {
      protocolVersion: 1, stage: async () => { throw new Error('not invoked by boot') },
      status: async () => undefined, listPending: async () => [], cancel: async () => {},
    }
    const prepare = vi.fn(async (owner: Context) => { owner.provide('profilePackageTransactions', stagedService) })
    try {
      const { shutdown } = await runProfile({
        environment, profile: 'desktop', resolvedProfile: runtime, ...options,
        patchFiles: [overlay], args: ['--port', '0', '--no-open'],
        ...(selection === 'default' ? { stagedPackageTransactions: true, prepare } : {}),
      })
      expect(installProxyFromEnvironment).toHaveBeenCalledWith(environment, expect.any(Function))
      if (selection === 'default') {
        expect(prepare).toHaveBeenCalledOnce()
        expect(ctx.get('profilePackageTransactions')).toBe(stagedService)
      } else expect(prepare).not.toHaveBeenCalled()
      if (mode !== 'runtime') {
        expect(healIsolatedProfileModuleFallback).toHaveBeenCalledWith({ profile, installAnchor: runtime.installAnchor })
      } else {
        expect(healIsolatedProfileModuleFallback).not.toHaveBeenCalled()
      }
      const generation = vi.mocked(createProfileResolutionGeneration).mock.settledResults
        .find(result => result.type === 'fulfilled')?.value
      expect(generation?.profileDir).toBe(home)
      expect(plugin).toHaveBeenCalledWith(PluginPackages, mode === 'link' ? {} : {
        generation,
        behavior: mode === 'dual' ? 'verify' : 'enforce',
      })
      expect(existsSync(join(home, 'profiles/node_modules'))).toBe(false)
      expect(existsSync(join(home, '.dsh-module-fallback'))).toBe(mode !== 'runtime')
      expect(existsSync(join(home, 'node_modules/test-runtime'))).toBe(mode !== 'runtime')
      expect(lstatSync(localPackageDir).isDirectory()).toBe(true)
      expect(readFileSync(join(localPackageDir, 'package.json'), 'utf8')).toBe(localManifest)
      const requireFromProfile = createRequire(join(home, 'package.json'))
      expect(requireFromProfile('test-runtime')).toBe('installation')
      expect(requireFromProfile('test-local')).toBe('profile')
      expect(readFileSync(join(home, 'cordis.yml'), 'utf8')).not.toContain('stale')
      expect(ctx.cmdlineArgs!.get()).toEqual(['--port', '0', '--no-open'])
      const ready = vi.fn()
      ctx.appReady!.onReady(ready)
      expect(ready).toHaveBeenCalledOnce()
      const patches = vi.mocked(boot).mock.calls[0]![2]!
      const rows = composeEntries([patches])
      expect(patches.slice(1, 4)).toEqual([
        { id: 'target', config: { profile: true, priority: 'profile' } },
        { id: 'target', config: { home: true, priority: 'home' } },
        { id: 'target', config: { overlay: true, priority: 'overlay' } },
      ])
      expect(rows.find(row => row.id === 'target')?.config).toEqual({ overlay: true, priority: 'overlay' })
      expect(rows.find(row => row.id === 'session-telemetry-otel')?.disabled).toBe(true)
      expect(ctx.profileContext).toMatchObject({ dir: home, patchPath: profilePatch,
        installAnchor: runtime.installAnchor, watchProfilePatches: false })
      await shutdown.shutdown(0)
      expect(dispose).toHaveBeenCalledOnce()
      expect(disposeProxy).toHaveBeenCalledOnce()
    } finally {
      await ctx.fiber.dispose()
      process.exitCode = oldExitCode
    }
  })

  it.each(['live', 'startup'] as const)('keeps the maintained ordinary named-profile %s watcher policy', async (patchReload) => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-named-profile-hmr-'))
    homes.push(home)
    const dir = join(home, 'profiles', 'custom')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'custom',
      dsh: { profile: { bundles: [], patchReload } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    vi.stubEnv('DSH_HOME', home)
    vi.spyOn(process, 'on').mockReturnValue(process)
    const previousExitCode = process.exitCode
    const ctx = new Context()
    ctx.provide('loader', { create: vi.fn() })
    ctx.provide('hmr', { runExclusive: async <T>(operation: () => Promise<T>): Promise<T> => operation() } as unknown as Context['hmr'])
    const disposeProxy = vi.fn().mockResolvedValue(undefined)
    vi.mocked(installProxyFromEnvironment).mockResolvedValue(disposeProxy)
    vi.mocked(boot).mockImplementation(async (_name, _root, _patches, setup) => {
      await setup?.(ctx)
      return ctx
    })
    try {
      const { shutdown } = await runProfile({ environment: createLaunchEnvironmentSnapshot([]),
        profile: 'custom', patchFiles: [], args: [] })
      expect(ctx.profileContext.watchProfilePatches).toBe(patchReload === 'live')
      expect(ctx.get('hmr')).toBeDefined()
      expect(healIsolatedProfileModuleFallback).not.toHaveBeenCalled()
      await shutdown.shutdown(0)
      expect(disposeProxy).toHaveBeenCalledOnce()
    } finally {
      await ctx.fiber.dispose()
      process.exitCode = previousExitCode
    }
  })

  it('refuses a legacy HMR row rather than silently dropping a named live profile watcher', async () => {
    const home = mkdtempSync(join(tmpdir(), 'dsh-legacy-hmr-'))
    homes.push(home)
    const dir = join(home, 'profiles', 'custom')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'custom',
      dsh: { profile: { bundles: [], patchReload: 'live' } } }))
    writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
    vi.stubEnv('DSH_HOME', home)
    vi.spyOn(process, 'on').mockReturnValue(process)
    const ctx = new Context()
    const create = vi.fn()
    ctx.provide('loader', { create })
    ctx.provide('hmr', {} as unknown as Context['hmr'])
    const disposeProxy = vi.fn().mockResolvedValue(undefined)
    vi.mocked(installProxyFromEnvironment).mockResolvedValue(disposeProxy)
    vi.mocked(boot).mockImplementation(async (_name, _root, _patches, setup) => {
      await setup?.(ctx)
      return ctx
    })
    try {
      await expect(runProfile({ environment: createLaunchEnvironmentSnapshot([]),
        profile: 'custom', patchFiles: [], args: [] })).rejects.toThrow('requires official serialized HMR')
      expect(create).not.toHaveBeenCalled()
      expect(disposeProxy).toHaveBeenCalledOnce()
    } finally { await ctx.fiber.dispose() }
  })
})
