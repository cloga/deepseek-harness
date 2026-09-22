import { join } from 'node:path'
import type { ExecFileOptions, ExecFileSyncOptions } from 'node:child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'

type Callback = (error: Error | null, stdout?: string, stderr?: string) => void
const child = vi.hoisted(() => ({
  sync: vi.fn<(executable: string, args: string[], options: ExecFileSyncOptions) => Buffer>(),
  async: vi.fn<(executable: string, args: string[], options: ExecFileOptions, callback: Callback) => void>(),
}))
vi.mock('node:child_process', () => ({ execFileSync: child.sync, execFile: child.async }))
vi.mock('app-builder-lib/out/asar/asar.js', () => ({ readAsar: async () => ({ header: { files: { dsh: { files: {} } } } }) }))
import {
  packagedDesktopRuntimeEnvironment,
  packagedDesktopRuntimeRoot,
  readPackagedDesktopRuntimeDescriptor,
  verifyPackagedDesktopRuntime,
} from '../scripts/packaged-runtime.mjs'

afterEach(() => { vi.resetAllMocks(); vi.unstubAllEnvs() })

describe('ASAR runtime inspection carrier', () => {
  it('removes loader, package manager and ASAR overrides without changing the parent environment', () => {
    const environment = { PATH: 'tools', HOME: 'home', NODE_OPTIONS: '--import unsafe', node_path: 'other-modules',
      ELECTRON_NO_ASAR: '1', ELECTRON_RUN_AS_NODE: '0', npm_config_registry: 'unsafe',
      PNPM_HOME: 'unsafe', COREPACK_HOME: 'unsafe', DSH_DESKTOP_DSH_DIR: 'wrong-runtime',
      GITHUB_TOKEN: 'fake-token', fake_api_key: 'fake-key', Fake_Secret: 'fake-secret', PASSWORD: 'fake-password',
      SystemRoot: 'system-root', HTTPS_PROXY: 'https://proxy.example.com/', NO_PROXY: 'localhost' }
    expect(packagedDesktopRuntimeEnvironment(environment)).toEqual({ PATH: 'tools', HOME: 'home', ELECTRON_RUN_AS_NODE: '1',
      SystemRoot: 'system-root', HTTPS_PROXY: 'https://proxy.example.com/', NO_PROXY: 'localhost' })
    expect(environment.ELECTRON_NO_ASAR).toBe('1')
    expect(packagedDesktopRuntimeRoot('resources')).toBe(join('resources', 'app.asar', 'dsh'))
  })

  it('returns exact descriptor bytes and rejects child failure rather than rewriting metadata', () => {
    const bytes = Buffer.from('{ "files": [] }\n')
    child.sync.mockReturnValueOnce(bytes)
    const runtime = packagedDesktopRuntimeRoot('resources with spaces')
    expect(readPackagedDesktopRuntimeDescriptor('packaged Electron.exe', runtime)).toBe(bytes)
    const [executable, args, options] = child.sync.mock.calls[0]!
    expect(executable).toBe('packaged Electron.exe')
    expect(args.slice(0, 3)).toEqual(['--input-type=module', '--eval', expect.any(String)])
    expect(args[2]).toContain(JSON.stringify(join(runtime, 'desktop-runtime.json')))
    expect(args[2]).toContain('process.versions.electron')
    expect(options).toMatchObject({ timeout: 120_000, maxBuffer: 64 * 1024 * 1024,
      windowsHide: true, env: { ELECTRON_RUN_AS_NODE: '1' } })
    child.sync.mockImplementationOnce(() => { throw new Error('descriptor missing') })
    expect(() => readPackagedDesktopRuntimeDescriptor('packaged Electron.exe', runtime)).toThrow('descriptor missing')
  })

  it('uses the caller-owned descriptor environment without ambient home or credentials', () => {
    vi.stubEnv('DSH_HOME', 'production-home')
    vi.stubEnv('AMBIENT_ONLY', 'must-not-inherit')
    const environment = { DSH_HOME: 'fixture-home', HOME: 'fixture-home', APPDATA: 'fixture-appdata',
      LOCALAPPDATA: 'fixture-localappdata', USERPROFILE: 'fixture-userprofile', PRIVATE_TOKEN: 'do-not-forward' }
    child.sync.mockReturnValueOnce(Buffer.from('{}'))
    readPackagedDesktopRuntimeDescriptor('Electron', 'runtime', environment)
    const options = child.sync.mock.calls[0]![2]
    expect(options.cwd).toBe('fixture-home')
    expect(options.env).toEqual({ DSH_HOME: 'fixture-home', HOME: 'fixture-home', APPDATA: 'fixture-appdata',
      LOCALAPPDATA: 'fixture-localappdata', USERPROFILE: 'fixture-userprofile', ELECTRON_RUN_AS_NODE: '1' })
    expect(process.env.DSH_HOME).toBe('production-home')
  })

  it('awaits the real inventory verifier and propagates nonzero exits and timeouts', async () => {
    let finish!: Callback
    let started!: () => void
    const childStarted = new Promise<void>((resolve) => { started = resolve })
    child.async.mockImplementation((_executable, _args, _options, callback) => { finish = callback; started() })
    const runtime = packagedDesktopRuntimeRoot('resources')
    let complete = false
    const verification = verifyPackagedDesktopRuntime('Electron', runtime, '0.1.6-alpha.1', { platform: 'win32', arch: 'x64' })
      .then(() => { complete = true })
    await childStarted
    const [, args, options] = child.async.mock.calls[0]!
    expect(args[2]).toContain('lib/types/runtime-tree.js')
    expect(args[2]).toContain('await verifyDesktopRuntime(')
    expect(args[2]).toContain('dsh-asar-verification-')
    expect(args[2]).toContain('"0.1.6-alpha.1", {"platform":"win32","arch":"x64"})')
    expect(options).toMatchObject({ timeout: 120_000, maxBuffer: 1024 * 1024, windowsHide: true })
    expect(complete).toBe(false)
    finish(null, '', '')
    await verification
    expect(complete).toBe(true)
    for (const message of ['integrity verification failed', 'ETIMEDOUT']) {
      const nextStarted = new Promise<void>((resolve) => { started = resolve })
      const failure = verifyPackagedDesktopRuntime('Electron', runtime, '0.1.6-alpha.1', { platform: 'win32', arch: 'x64' })
      const rejected = expect(failure).rejects.toThrow(message)
      await nextStarted
      finish(new Error(message))
      await rejected
    }
  })
})
