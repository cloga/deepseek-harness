import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { smokeDesktopRuntime } from '../scripts/smoke-runtime.ts'
import { smokeDesktopRuntimeBrowser } from '../scripts/smoke-runtime-browser.ts'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../src/host-protocol.ts'
import { DESKTOP_RUNTIME_FILE, renderDesktopRuntimeDescriptor, type DesktopRuntimeDescriptor } from '../src/runtime-tree.ts'

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
vi.mock('../src/host-process.ts', () => ({
  DesktopHostProcess: class {
    constructor(_node: string, _root: string, _profile: string, _inspect: unknown, environment: NodeJS.ProcessEnv) {
      owned.environments.push(environment)
      owned.homes.push(environment.DSH_HOME!)
    }
    start = async () => ({ url: 'http://127.0.0.1:19387/?token=fixture' })
    stop = owned.stop
  },
}))
vi.mock('../scripts/smoke-runtime-browser.ts', () => ({ smokeDesktopRuntimeBrowser: vi.fn() }))

const runtime: DesktopRuntimeDescriptor = {
  schemaVersion: 1,
  platform: process.platform,
  arch: process.arch,
  files: [],
  release: { schemaVersion: 1, version: '1.0.0', hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION, nodeVersion: '24.13.0', pnpmVersion: '11.7.0' },
  sharedPackages: [
    '@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host', '@deepseek-ai/cordis',
    '@deepseek-ai/schemastery', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-credentials',
  ].map(name => ({ name, version: '1.0.0', path: `node_modules/${name}` })),
}
let runtimeRoot: string

beforeEach(() => {
  runtimeRoot = mkdtempSync(join(tmpdir(), 'desktop-smoke-descriptor-'))
  writeFileSync(join(runtimeRoot, DESKTOP_RUNTIME_FILE), renderDesktopRuntimeDescriptor(runtime))
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input)
    expect(url.origin).toBe('http://127.0.0.1:19387')
    if (url.searchParams.has('token')) {
      expect(init?.redirect).toBe('manual')
      return new Response(null, { status: 302, headers: { 'set-cookie': 'session=fixture; HttpOnly; Path=/' } })
    }
    expect(new Headers(init?.headers).get('cookie')).toBe('session=fixture')
    return new Response(url.pathname === '/'
      ? '<html><script>"/plugins/??desktop-runtime-smoke-plugin/client.js&amp;rev=fixture"</script></html>'
      : 'settings.models.provider-card; Authorize neutral fixture',
    { status: url.href.includes('&amp;') ? 404 : 200 })
  }))
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.resetAllMocks()
  owned.environments.length = 0
  owned.homes.length = 0
  rmSync(runtimeRoot, { recursive: true, force: true })
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
    await smokeDesktopRuntime(runtimeRoot, process.execPath, runtime)
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
    await expect(smokeDesktopRuntime(runtimeRoot, process.execPath, runtime))
      .rejects.toThrow('did not commit exactly one neutral Host authorization')
    expect(owned.stop).toHaveBeenCalledOnce()
    expect(owned.homes.every(home => !existsSync(home))).toBe(true)
  })

  it('propagates browser failure and disposes its isolated Host/profile', async () => {
    vi.mocked(smokeDesktopRuntimeBrowser).mockRejectedValue(new Error('neutral provider is not visible'))
    await expect(smokeDesktopRuntime(runtimeRoot, process.execPath, runtime))
      .rejects.toThrow('neutral provider is not visible')
    expect(owned.stop).toHaveBeenCalledOnce()
    expect(owned.homes.every(home => !existsSync(home))).toBe(true)
  })

  it('records raw descriptor bytes without certifying workspace-linked artifact integrity', async () => {
    const bytes = `${renderDesktopRuntimeDescriptor(runtime)}\n`
    writeFileSync(join(runtimeRoot, DESKTOP_RUNTIME_FILE), bytes)
    vi.mocked(smokeDesktopRuntimeBrowser).mockImplementation(async (_host, home, receipt, _channel, captures) => {
      if (captures === undefined) throw new Error('fixture requires an evidence directory')
      mkdirSync(captures, { recursive: true })
      writeFileSync(join(home, 'neutral-auth-result.json'), JSON.stringify({ sharedCordis: true, status: 'authorized', receipt, attempts: 1 }))
    })
    const output = join(runtimeRoot, 'evidence')
    await smokeDesktopRuntime(runtimeRoot, process.execPath, runtime, undefined, output, 'workspace-linked')
    const evidence = JSON.parse(readFileSync(join(output, 'neutral-fixture-evidence.json'), 'utf8'))
    expect(evidence).toMatchObject({ runtimeKind: 'workspace-linked', artifactIntegrityVerified: false,
      runtimeDescriptorSha256: createHash('sha256').update(bytes).digest('hex') })
    expect(evidence).not.toHaveProperty('runtimeId')
    expect(evidence.runtimeDescriptorSha256).not.toBe(createHash('sha256').update(JSON.stringify(runtime)).digest('hex'))
    expect(owned.stop).toHaveBeenCalledOnce()
    expect(owned.homes.every(home => !existsSync(home))).toBe(true)
  })

  it('rejects a descriptor different from the verified input before constructing a Host', async () => {
    writeFileSync(join(runtimeRoot, DESKTOP_RUNTIME_FILE), renderDesktopRuntimeDescriptor({ ...runtime, arch: 'different-target' }))
    await expect(smokeDesktopRuntime(runtimeRoot, process.execPath, runtime)).rejects.toThrow('does not match the verified input')
    expect(owned.homes).toEqual([])
    expect(owned.stop).not.toHaveBeenCalled()
    expect(smokeDesktopRuntimeBrowser).not.toHaveBeenCalled()
  })

  it('does not let matching fixture bytes bypass shared runtime identity validation', async () => {
    const invalid = { ...runtime, sharedPackages: runtime.sharedPackages.filter(entry => entry.name !== '@deepseek-ai/dsh') }
    writeFileSync(join(runtimeRoot, DESKTOP_RUNTIME_FILE), renderDesktopRuntimeDescriptor(invalid))
    await expect(smokeDesktopRuntime(runtimeRoot, process.execPath, invalid)).rejects.toThrow('missing or mismatched @deepseek-ai/dsh')
    expect(owned.homes).toEqual([])
    expect(smokeDesktopRuntimeBrowser).not.toHaveBeenCalled()
  })

  it('rejects descriptor byte drift before publishing evidence and still disposes the Host', async () => {
    vi.mocked(smokeDesktopRuntimeBrowser).mockImplementation(async (_host, home, receipt, _channel, captures) => {
      if (captures === undefined) throw new Error('fixture requires an evidence directory')
      mkdirSync(captures, { recursive: true })
      writeFileSync(join(home, 'neutral-auth-result.json'), JSON.stringify({ sharedCordis: true, status: 'authorized', receipt, attempts: 1 }))
      writeFileSync(join(runtimeRoot, DESKTOP_RUNTIME_FILE), `${renderDesktopRuntimeDescriptor(runtime)}\n`)
    })
    const output = join(runtimeRoot, 'evidence')
    await expect(smokeDesktopRuntime(runtimeRoot, process.execPath, runtime, undefined, output)).rejects.toThrow('descriptor changed during acceptance')
    expect(existsSync(output)).toBe(false)
    expect(owned.stop).toHaveBeenCalledOnce()
    expect(owned.homes.every(home => !existsSync(home))).toBe(true)
  })
})
