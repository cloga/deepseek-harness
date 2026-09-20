import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ExecFileOptions } from 'node:child_process'
import type { Node as AsarNode } from 'app-builder-lib/out/asar/asar.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { verifyPackagedDesktopRuntime } from '../scripts/packaged-runtime.mjs'

type Callback = (error: Error | null, stdout?: string, stderr?: string) => void
const state = vi.hoisted(() => ({
  header: {} as AsarNode,
  readFile: vi.fn<(path: string) => Promise<Buffer>>(),
  child: vi.fn<(executable: string, args: string[], options: ExecFileOptions, callback: Callback) => void>(),
}))
vi.mock('node:child_process', () => ({ execFile: state.child, execFileSync: vi.fn() }))
vi.mock('app-builder-lib/out/asar/asar.js', () => ({ readAsar: async () => ({ header: state.header, readFile: state.readFile }) }))
vi.mock('node:fs', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs')>()
  return { ...fs, chmodSync: vi.fn(fs.chmodSync), mkdtempSync: vi.fn(fs.mkdtempSync) }
})
const actualFs = await vi.importActual<typeof import('node:fs')>('node:fs')
let root: string
let runtime: string

beforeEach(() => {
  root = actualFs.mkdtempSync(join(tmpdir(), 'desktop-extraction-test-'))
  runtime = join(root, 'app.asar', 'dsh')
  state.header = { files: { dsh: { files: {
    'desktop-runtime.json': { size: 2 }, 'run.js': { executable: true }, 'addon.node': { unpacked: true },
  } } } }
  state.readFile.mockImplementation(async path => Buffer.from(`actual archive bytes: ${path}`))
  state.child.mockImplementation((_executable, _args, _options, callback) => { callback(null, '', '') })
  mkdirSync(join(root, 'app.asar.unpacked', 'dsh'), { recursive: true })
  writeFileSync(join(root, 'app.asar.unpacked', 'dsh', 'addon.node'), 'native')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  for (const result of vi.mocked(mkdtempSync).mock.results) {
    if (result.type === 'return' && typeof result.value === 'string') expect(existsSync(result.value)).toBe(false)
  }
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  vi.clearAllMocks()
})

describe('ASAR verification materialization', () => {
  it('copies original bytes with packed executable flags and physical unpacked permissions', async () => {
    const physicalMode = lstatSync(join(root, 'app.asar.unpacked', 'dsh', 'addon.node')).mode
    vi.stubGlobal('process', { ...process, platform: 'darwin' })
    state.child.mockImplementation((_executable, _args, _options, callback) => {
      const materialized = vi.mocked(mkdtempSync).mock.results[0]!.value as string
      expect(readFileSync(join(materialized, 'desktop-runtime.json'), 'utf8')).toBe(`actual archive bytes: ${join('dsh', 'desktop-runtime.json')}`)
      expect(chmodSync).toHaveBeenCalledWith(join(materialized, 'desktop-runtime.json'), 0o644)
      expect(chmodSync).toHaveBeenCalledWith(join(materialized, 'run.js'), 0o755)
      expect(chmodSync).toHaveBeenCalledWith(join(materialized, 'addon.node'), physicalMode)
      callback(null, '', '')
    })
    await verifyPackagedDesktopRuntime('Electron', runtime, '1.0.0', { platform: 'darwin', arch: 'arm64' })
  })

  it('contains verifier environment, cwd and materialization within the caller-owned home', async () => {
    vi.stubEnv('DSH_HOME', 'production-home')
    vi.stubEnv('AMBIENT_ONLY', 'must-not-inherit')
    const privateTemp = join(root, 'private-temp')
    mkdirSync(privateTemp)
    const environment = { DSH_HOME: root, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
      TEMP: privateTemp, TMP: privateTemp, PRIVATE_SECRET: 'must-not-forward' }
    state.child.mockImplementation((_executable, _args, options, callback) => {
      const materialized = vi.mocked(mkdtempSync).mock.results[0]!.value as string
      expect(materialized.startsWith(join(privateTemp, 'dsh-asar-verification-'))).toBe(true)
      expect(options.cwd).toBe(root)
      expect(options.env).toEqual({ DSH_HOME: root, HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
        TEMP: privateTemp, TMP: privateTemp, ELECTRON_RUN_AS_NODE: '1' })
      callback(null, '', '')
    })
    await verifyPackagedDesktopRuntime('Electron', runtime, '1.0.0', { platform: 'win32', arch: 'x64' }, environment)
    expect(process.env.DSH_HOME).toBe('production-home')
  })

  it.each([{}, { TEMP: 'relative-temp' }])('refuses ambiguous temporary paths for an explicit environment: %j', async (environment) => {
    await expect(verifyPackagedDesktopRuntime('Electron', runtime, '1.0.0', { platform: 'win32', arch: 'x64' }, environment))
      .rejects.toThrow('explicit inspection environment requires an absolute temporary directory')
    expect(mkdtempSync).not.toHaveBeenCalled()
    expect(state.child).not.toHaveBeenCalled()
  })

  it.each(['..', '../outside', '..\\outside', 'C:outside', ''])('rejects unsafe archive segment %j before creating files', async (name) => {
    state.header = { files: { dsh: { files: { [name]: { size: 1 } } } } }
    await expect(verifyPackagedDesktopRuntime('Electron', runtime, '1.0.0', { platform: 'win32', arch: 'x64' }))
      .rejects.toThrow('invalid ASAR path segment')
    expect(mkdtempSync).not.toHaveBeenCalled()
    expect(state.child).not.toHaveBeenCalled()
  })

  it('rejects archive links before reading their targets', async () => {
    state.header = { files: { dsh: { files: { link: { link: '../../outside' } } } } }
    await expect(verifyPackagedDesktopRuntime('Electron', runtime, '1.0.0', { platform: 'win32', arch: 'x64' }))
      .rejects.toThrow('unsupported ASAR link')
    expect(state.readFile).not.toHaveBeenCalled()
  })

  it('cleans partially extracted files when an archive read fails', async () => {
    state.readFile.mockRejectedValueOnce(new Error('archive read failed'))
    await expect(verifyPackagedDesktopRuntime('Electron', runtime, '1.0.0', { platform: 'win32', arch: 'x64' }))
      .rejects.toThrow('archive read failed')
    expect(state.child).not.toHaveBeenCalled()
  })

  it('retains extracted files until the verifier exits, then cleans up on failure', async () => {
    let finish!: Callback
    let started!: () => void
    const childStarted = new Promise<void>((resolve) => { started = resolve })
    state.child.mockImplementation((_executable, _args, _options, callback) => { finish = callback; started() })
    const verification = verifyPackagedDesktopRuntime('Electron', runtime, '1.0.0', { platform: 'win32', arch: 'x64' })
    const failed = expect(verification).rejects.toThrow('verification failed')
    await childStarted
    const materialized = vi.mocked(mkdtempSync).mock.results[0]!.value as string
    expect(existsSync(materialized)).toBe(true)
    finish(new Error('verification failed'))
    await failed
    expect(existsSync(materialized)).toBe(false)
  })
})
