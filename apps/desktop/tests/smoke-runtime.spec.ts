import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { smokeDesktopRuntimeBrowser } from '../scripts/smoke-runtime-browser.ts'
import type { DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'

const owned = vi.hoisted(() => ({
  stop: vi.fn(async () => {}),
  environments: [] as NodeJS.ProcessEnv[],
  homes: [] as string[],
}))

vi.mock('../src/project-manager.ts', () => ({
  createPluginProfile(profile: string) {
    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      dependencies: {}, dsh: { profile: { bundles: [] } },
    }))
  },
}))
vi.mock('../src/profile-packages.ts', () => ({
  linkDesktopHostPackages: vi.fn(),
  unlinkDesktopHostPackages: vi.fn(),
  validateDesktopPluginGraph: vi.fn(),
}))
vi.mock('../src/host-process.ts', () => ({
  DesktopHostProcess: class {
    constructor(_node: string, _root: string, _profile: string, _inspect: unknown, environment: NodeJS.ProcessEnv) {
      owned.environments.push(environment)
      owned.homes.push(environment.DSH_HOME!)
    }
    start = async () => ({ dshVersion: '1.0.0' })
    stop = owned.stop
    fetch = async (request: Request) => new Response(request.url.endsWith('/')
      ? '<html><script>"/plugins/??desktop-runtime-smoke-plugin/client.js&amp;rev=fixture"</script></html>'
      : 'settings.models.provider-card; device-code authentication; Authorize neutral fixture',
    { status: request.url.includes('&amp;') ? 404 : 200 })
  },
}))
vi.mock('../scripts/smoke-runtime-browser.ts', () => ({ smokeDesktopRuntimeBrowser: vi.fn() }))

const runtime: DesktopRuntimeDescriptor = {
  schemaVersion: 1,
  platform: process.platform,
  arch: process.arch,
  files: [],
  release: {
    schemaVersion: 1, version: '1.0.0', hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION,
    nodeVersion: '24.13.0', pnpmVersion: '11.7.0',
  },
  sharedPackages: [
    '@deepseek-ai/cordis', '@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-credentials',
  ].map(name => ({ name, version: '1.0.0', path: `node_modules/${name}` })),
}

afterEach(() => {
  vi.resetAllMocks()
  owned.environments.length = 0
  owned.homes.length = 0
})

describe('Desktop runtime browser acceptance orchestration', () => {
  it('requires browser execution and one Host authorization after assets are served', async () => {
    vi.mocked(smokeDesktopRuntimeBrowser).mockImplementation(async (_host, home, receipt) => {
      const plugin = join(home, 'profiles', 'desktop', 'node_modules', 'desktop-runtime-smoke-plugin')
      expect(readFileSync(join(plugin, 'index.mjs'), 'utf8')).toContain('ctx instanceof Context')
      expect(readFileSync(join(plugin, 'index.mjs'), 'utf8')).toContain('registerConfigurableProviders')
      expect(readFileSync(join(plugin, 'index.mjs'), 'utf8')).toContain('settings.register')
      writeFileSync(join(home, 'neutral-auth-result.json'), JSON.stringify({
        sharedCordis: true, status: 'authorized', receipt, attempts: 1,
      }))
    })
    await smokeDesktopRuntime('runtime', process.execPath, runtime)
    expect(smokeDesktopRuntimeBrowser).toHaveBeenCalledOnce()
    expect(owned.stop).toHaveBeenCalledOnce()
    expect(owned.homes.every(home => !existsSync(home))).toBe(true)
    const environment = owned.environments[0]!
    expect(environment.HOME).toBe(environment.DSH_HOME)
    expect(environment.USERPROFILE).toBe(environment.DSH_HOME)
    expect(Object.keys(environment).filter(name => /KEY|TOKEN|SECRET|PASSWORD/iu.test(name))).toEqual([])
  })

  it('rejects a visible client result without the matching Host write', async () => {
    vi.mocked(smokeDesktopRuntimeBrowser).mockImplementation(async (_host, home) => {
      writeFileSync(join(home, 'neutral-auth-result.json'), JSON.stringify({
        sharedCordis: true, status: 'authorized', receipt: 'another-run', attempts: 1,
      }))
    })
    await expect(smokeDesktopRuntime('runtime', process.execPath, runtime))
      .rejects.toThrow('did not commit exactly one neutral Host authorization')
    expect(owned.stop).toHaveBeenCalledOnce()
    expect(owned.homes.every(home => !existsSync(home))).toBe(true)
  })

  it('propagates browser failure and disposes its isolated Host/profile', async () => {
    vi.mocked(smokeDesktopRuntimeBrowser).mockRejectedValue(new Error('neutral provider is not visible'))
    await expect(smokeDesktopRuntime('runtime', process.execPath, runtime))
      .rejects.toThrow('neutral provider is not visible')
    expect(owned.stop).toHaveBeenCalledOnce()
    expect(owned.homes.every(home => !existsSync(home))).toBe(true)
  })
})
