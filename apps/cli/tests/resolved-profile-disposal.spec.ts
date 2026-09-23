import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { boot, watchUserPatches, type Profile } from '@deepseek-ai/dsh-app-boot'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { createLaunchEnvironmentSnapshot } from '@deepseek-ai/dsh-launch-environment'
import { afterEach, expect, it, vi } from 'vitest'
import { runProfile } from '../src/profile-boot.ts'

vi.mock('@deepseek-ai/dsh-app-boot', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@deepseek-ai/dsh-app-boot')>()
  return { ...actual, boot: vi.fn(), watchUserPatches: vi.fn(), installFailLoud: vi.fn() }
})
vi.mock('@deepseek-ai/dsh-http-proxy', () => ({ installProxyFromEnvironment: vi.fn() }))
vi.mock('../src/process-shutdown.ts', () => ({ createProcessShutdown: vi.fn((dispose: () => Promise<void>) => ({
  shutdown: () => dispose(), interrupt: () => {},
})) }))

const roots: string[] = []
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  vi.resetAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('releases the launch proxy exactly once even when a successfully booted tree fails disposal', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-resolved-disposal-'))
  roots.push(home)
  const runtime = join(home, 'runtime')
  mkdirSync(runtime)
  writeFileSync(join(runtime, 'package.json'), '{"name":"test-runtime","version":"1.0.0"}')
  writeFileSync(join(home, 'package.json'), '{"name":"desktop-profile","version":"1.0.0"}')
  vi.stubEnv('DSH_HOME', home)
  vi.spyOn(process, 'on').mockReturnValue(process)
  const ctx = new Context()
  ctx.provide('loader', { create: vi.fn() })
  const failure = new Error('tree disposal failed')
  const disposed = vi.spyOn(ctx.fiber, 'dispose').mockRejectedValueOnce(failure)
  const releaseProxy = vi.fn().mockResolvedValue(undefined)
  vi.mocked(installProxyFromEnvironment).mockResolvedValue(releaseProxy)
  vi.mocked(boot).mockImplementation(async (_name, _root, _patches, prepare) => {
    await prepare?.(ctx)
    return ctx
  })
  const profile: Profile = { name: 'desktop', dir: home, patchPath: join(home, 'cordis.patch.yml'),
    layers: [], patches: [], patchReload: 'startup' }
  try {
    const { shutdown } = await runProfile({ environment: createLaunchEnvironmentSnapshot([]), profile: 'desktop',
      resolvedProfile: { profile, installAnchor: join(runtime, 'package.json') }, patchFiles: [], args: [] })
    await expect(shutdown.shutdown(0)).rejects.toBe(failure)
    await expect(shutdown.shutdown(0)).rejects.toBe(failure)
    expect(disposed).toHaveBeenCalledOnce()
    expect(releaseProxy).toHaveBeenCalledOnce()
  } finally { await ctx.fiber.dispose() }
})

it('unwinds a live named-profile tree and proxy when ordinary HMR setup fails', async () => {
  const home = mkdtempSync(join(tmpdir(), 'dsh-live-watch-disposal-'))
  roots.push(home)
  const dir = join(home, 'profiles', 'custom')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'custom',
    dsh: { profile: { bundles: [], patchReload: 'live' } } }))
  writeFileSync(join(dir, 'cordis.patch.yml'), '[]\n')
  vi.stubEnv('DSH_HOME', home)
  vi.spyOn(process, 'on').mockReturnValue(process)
  const ctx = new Context()
  ctx.provide('loader', { create: vi.fn() })
  ctx.provide('hmr', {})
  const disposed = vi.spyOn(ctx.fiber, 'dispose')
  const releaseProxy = vi.fn().mockResolvedValue(undefined)
  vi.mocked(installProxyFromEnvironment).mockResolvedValue(releaseProxy)
  vi.mocked(boot).mockImplementation(async (_name, _root, _patches, prepare) => {
    await prepare?.(ctx)
    return ctx
  })
  const failure = new Error('ordinary patch watcher failed')
  vi.mocked(watchUserPatches).mockRejectedValueOnce(failure)
  try {
    await expect(runProfile({ environment: createLaunchEnvironmentSnapshot([]), profile: 'custom',
      patchFiles: [], args: [] })).rejects.toBe(failure)
    expect(watchUserPatches).toHaveBeenCalledOnce()
    expect(disposed).toHaveBeenCalledOnce()
    expect(releaseProxy).toHaveBeenCalledOnce()
  } finally { await ctx.fiber.dispose() }
})
