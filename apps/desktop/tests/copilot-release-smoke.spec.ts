import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PackagedCopilotProfileInspection } from './fixtures/copilot-release-smoke.ts'

const effects = vi.hoisted(() => ({
  parseArgs: vi.fn(() => { throw new Error('Import must not parse CLI arguments') }),
  launch: vi.fn(), runtimeRoot: vi.fn(), runtimeBytes: vi.fn(), verifyRuntime: vi.fn(),
  exec: vi.fn(), menu: vi.fn(), settings: vi.fn(), usage: vi.fn(), capability: vi.fn(),
  environment: vi.fn(), graph: vi.fn(), inventory: vi.fn(),
  fault: undefined as ((operation: string, path: unknown) => void) | undefined,
  removed: [] as string[], allocated: [] as string[], descriptors: new Map<number, string>(),
}))
vi.mock('node:util', async original => ({ ...await original<typeof import('node:util')>(), parseArgs: effects.parseArgs }))
vi.mock('node:child_process', () => ({ execFileSync: effects.exec }))
vi.mock('node:fs', async original => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    mkdtempSync: (...args: Parameters<typeof fs.mkdtempSync>) => {
      effects.fault?.('allocate', args[0])
      const path = fs.mkdtempSync(...args)
      effects.allocated.push(String(path))
      return path
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => { effects.fault?.('write', args[0]); return fs.writeFileSync(...args) },
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      effects.fault?.('open', args[0])
      const descriptor = fs.openSync(...args)
      effects.descriptors.set(descriptor, String(args[0]))
      return descriptor
    },
    closeSync: (descriptor: number) => {
      const path = effects.descriptors.get(descriptor)
      fs.closeSync(descriptor)
      effects.descriptors.delete(descriptor)
      effects.fault?.('closed', path)
    },
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => { effects.fault?.('inspect', args[0]); return fs.lstatSync(...args) },
    renameSync: (...args: Parameters<typeof fs.renameSync>) => {
      const existing = fs.existsSync(args[1]) ? fs.lstatSync(args[1]) : undefined
      effects.fault?.(existing?.size === 0 ? 'publish' : 'finalize', args[1])
      return fs.renameSync(...args)
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => { effects.fault?.('unlink', args[0]); return fs.unlinkSync(...args) },
  }
})
vi.mock('playwright', () => ({ _electron: { launch: effects.launch } }))
vi.mock('../scripts/packaged-runtime.mjs', () => ({
  packagedDesktopRuntimeEnvironment: (env: unknown) => env,
  packagedDesktopRuntimeRoot: effects.runtimeRoot,
  readPackagedDesktopRuntimeDescriptor: effects.runtimeBytes,
  verifyPackagedDesktopRuntime: effects.verifyRuntime,
}))
vi.mock('../scripts/fork-release.ts', () => ({ parseDesktopForkReleasePlan: (value: unknown) => value }))
vi.mock('../src/plugin-provisioning.ts', () => ({ readDesktopPluginProvisioningPlan: (path: string) => JSON.parse(readFileSync(path, 'utf8')) }))
vi.mock('../src/plugin-receipts.ts', () => ({ assertDesktopProvisioningInventory: effects.inventory }))
vi.mock('../scripts/smoke-environment.ts', () => ({ desktopSmokeEnvironment: effects.environment }))
vi.mock('./fixtures/desktop-version-menu-smoke.ts', () => ({ inspectDesktopVersionMenu: effects.menu }))
vi.mock('./fixtures/copilot-settings-smoke.ts', () => ({ inspectPackagedCopilotSettings: effects.settings }))
vi.mock('./fixtures/copilot-usage-smoke.ts', () => ({ inspectCopilotUsageCapability: effects.capability, inspectSignedOutCopilotUsage: effects.usage }))
vi.mock('./fixtures/packaged-graph-check.ts', () => ({ inspectPackagedGraphResolution: () => ({}), packagedGraphCheckArguments: effects.graph }))
vi.mock('../src/owned-directory.ts', async original => {
  const actual = await original<typeof import('../src/owned-directory.ts')>()
  return { removeOwnedDirectory(path: string) {
    effects.removed.push(path)
    effects.fault?.('remove', path)
    actual.removeOwnedDirectory(path)
  } }
})

const directories: string[] = []
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
const receipt = (output: string, name: string): Record<string, unknown> => JSON.parse(readFileSync(join(output, name), 'utf8'))
beforeEach(() => {
  vi.clearAllMocks()
  effects.fault = undefined
  effects.removed = []
  effects.allocated = []
  effects.descriptors.clear()
  vi.stubEnv('GITHUB_RUN_ID', '123')
  vi.stubEnv('GITHUB_RUN_ATTEMPT', '2')
  vi.stubEnv('GITHUB_SHA', 'a'.repeat(40))
})
afterEach(async () => {
  effects.fault = undefined
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  const { removeOwnedDirectory } = await vi.importActual<typeof import('../src/owned-directory.ts')>('../src/owned-directory.ts')
  for (const path of [...effects.allocated, ...directories.splice(0)]) if (existsSync(path)) removeOwnedDirectory(path)
})

/** Synthetic business boundaries drive the actual production owner; no duplicate lifecycle or real subprocess runs. */
function ownerFixture() {
  const root = mkdtempSync(join(tmpdir(), 'copilot-owner-'))
  directories.push(root)
  const application = join(root, 'not-executed.exe')
  writeFileSync(application, 'inert unit fixture bytes')
  const output = join(root, 'evidence')
  const resources = join(root, 'resources')
  const reviewed = JSON.parse(readFileSync(resolve('apps/desktop/release/cloga-windows-x64.json'), 'utf8'))
  mkdirSync(join(resources, 'desktop-provisioning'), { recursive: true })
  mkdirSync(join(resources, 'managed-update'))
  writeFileSync(join(resources, 'desktop-provisioning', 'plan.json'), JSON.stringify(reviewed.desktopProvisioning))
  writeFileSync(join(resources, 'managed-update', 'capability.json'), '{}')
  const runtimeRoot = join(resources, 'app.asar', 'dsh')
  const runtimeBytes = Buffer.from(JSON.stringify({ release: { version: reviewed.upstreamVersion } }))
  effects.runtimeRoot.mockReturnValue(runtimeRoot)
  effects.runtimeBytes.mockReturnValue(runtimeBytes)
  effects.verifyRuntime.mockResolvedValue(undefined)
  effects.menu.mockResolvedValue({ nativePopupOpened: false, nativeModalOpened: false })
  effects.settings.mockResolvedValue({ modelRolesViewLoaded: true })
  effects.capability.mockReturnValue({ id: 'account-quota-composer-usage' })
  effects.usage.mockResolvedValue({ usageSurfaceAbsent: true })
  effects.inventory.mockReturnValue(undefined)
  let profile = ''
  let home = ''
  let launches = 0
  const close = vi.fn(async () => {})
  type UnitLocator = {
    waitFor(): Promise<void>
    click(): Promise<void>
    isEnabled(): Promise<boolean>
    count(): Promise<number>
    innerText(): Promise<string>
    screenshot(): Promise<void>
    locator(selector: string): UnitLocator
    getByRole(role: string, options?: unknown): UnitLocator
  }
  const locator: UnitLocator = {
    waitFor: vi.fn(async () => {}), click: vi.fn(async () => {}), isEnabled: vi.fn(async () => true),
    count: vi.fn(async () => 0), innerText: vi.fn(async () => ''), screenshot: vi.fn(async () => {}),
    locator: (_selector: string) => locator, getByRole: (_role: string, _options?: unknown) => locator,
  }
  const page = {
    ...locator, setDefaultTimeout: vi.fn(), waitForFunction: vi.fn(async () => {}),
    url: () => 'dsh-app://app/', isClosed: () => false,
  }
  effects.environment.mockImplementation((value: string) => {
    home = value; profile = join(home, 'profiles', 'desktop')
    return {}
  })
  effects.launch.mockImplementation(async () => {
    launches++
    mkdirSync(profile, { recursive: true })
    for (const file of ['desktop-plugin-receipts.json', 'desktop-plugin-provisioning-state.json', 'package.json']) {
      writeFileSync(join(profile, file), '{}')
    }
    return {
      process: () => ({ stderr: { on: vi.fn() } }),
      evaluate: vi.fn(async () => {
        const count = evaluateCount++
        return count % 2 === 0 ? join(home, 'electron-user-data') : { node: 'unit-node', electron: 'unit-electron' }
      }), firstWindow: async () => page, close,
    }
  })
  let evaluateCount = 0
  effects.graph.mockReturnValue([])
  effects.exec.mockImplementation((file: string, args: string[], options: { stdio?: (string | number | undefined)[] }) => {
    if (file === 'git') return args[1] === 'HEAD' ? 'a'.repeat(40) : 'b'.repeat(40)
    if (file !== application) return JSON.stringify({ sha256: hash('inert unit fixture bytes') })
    const descriptor = options.stdio?.[1]
    expect(typeof descriptor).toBe('number')
    writeFileSync(descriptor as number, JSON.stringify({
      valid: true, runtimeSha256: hash(runtimeBytes), nodePath: null, nodeOptionsPresent: false,
      nodeVersion: 'unit-node', electronVersion: 'unit-electron', runAsNode: '1', electronNoAsarPresent: false,
      resolutionMode: 'runtime', runtimeRoot, executable: application, cwd: profile,
    }))
  })
  // Only acceptance-owned allocations belong to each lifecycle assertion.
  effects.allocated = []
  return { options: { application, output }, close, page, get launches() { return launches } }
}

it('imports acceptance without parsing CLI arguments or starting runtime work', async () => {
  const fixture = await import('./fixtures/copilot-release-smoke.ts')
  expect(typeof fixture.runPackagedCopilotAcceptance).toBe('function')
  expect(effects.parseArgs).not.toHaveBeenCalled()
  expect(effects.launch).not.toHaveBeenCalled()
  expect(effects.verifyRuntime).not.toHaveBeenCalled()
})

it('prepares isolated home and ancestor SDK without precreating the shell-owned profile', async () => {
  const { preparePackagedCopilotHome } = await import('./fixtures/copilot-release-smoke.ts')
  const root = mkdtempSync(join(tmpdir(), 'copilot-acceptance-home-'))
  directories.push(root)
  const home = join(root, 'home')
  const legacySdk = join(root, 'legacy-sdk')
  mkdirSync(home); mkdirSync(legacySdk)
  preparePackagedCopilotHome(home, legacySdk)
  const profile = join(home, 'profiles', 'desktop')
  expect(existsSync(profile)).toBe(false)
  expect(existsSync(join(profile, '.env'))).toBe(false)
  expect(readFileSync(join(home, '.env'), 'utf8')).toBe('')
  expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toContain('welcomeNoticeVersion: "2026-08-13.1"')
  expect(realpathSync.native(join(home, 'profiles', 'node_modules', '@modelcontextprotocol', 'sdk'))).toBe(realpathSync.native(legacySdk))
  expect(JSON.parse(readFileSync(join(legacySdk, 'package.json'), 'utf8'))).toMatchObject({ name: '@modelcontextprotocol/sdk', version: '1.0.0' })
  expect(existsSync(join(legacySdk, 'loaded'))).toBe(false)
  mkdirSync(profile)
  expect(() => { preparePackagedCopilotHome(home, legacySdk) }).toThrow('shell must exclusively create')
})

it.each([
  ['dsh-app://app/', true], ['dsh-app://app/index.html', false], ['dsh-app://shell/loading.html', false], ['https://app/', false],
])('recognizes the exact official application URL %s', async (href, ready) => {
  const { packagedCopilotStartupReady } = await import('./fixtures/copilot-release-smoke.ts')
  vi.stubGlobal('location', { href }); vi.stubGlobal('document', { querySelector: () => null })
  expect(packagedCopilotStartupReady()).toBe(ready)
})
it.each([
  [{ hidden: false, textContent: 'Host failed' }, true], [{ hidden: true, textContent: 'Host failed' }, false], [{ hidden: false, textContent: '  ' }, false],
])('preserves visible startup error detection: %j', async (error, ready) => {
  const { packagedCopilotStartupReady } = await import('./fixtures/copilot-release-smoke.ts')
  vi.stubGlobal('location', { href: 'dsh-app://shell/loading.html' }); vi.stubGlobal('document', { querySelector: () => error })
  expect(packagedCopilotStartupReady()).toBe(ready)
})

describe('actual acceptance owner lifecycle with mocked business boundaries', () => {
  it('publishes ordinary acceptance only after both rounds, observer and every owned cleanup', async () => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    const observer = vi.fn(async (paths: PackagedCopilotProfileInspection) => {
      expect(Object.isFrozen(paths)).toBe(true)
      expect(fixture.launches).toBe(2)
      expect(receipt(fixture.options.output, 'functional-results.json')).toMatchObject({
        functionalAssertionsCompleted: true, normalAcceptanceCompleted: false, cleanupVerified: false,
      })
      expect(existsSync(join(fixture.options.output, 'acceptance.json'))).toBe(false)
    })
    effects.fault = (operation, path) => {
      if (operation === 'publish' && basename(String(path)) === 'acceptance.json') {
        expect(effects.allocated.every(directory => !existsSync(directory))).toBe(true)
        expect(fixture.close).toHaveBeenCalledTimes(2)
      }
    }
    await runPackagedCopilotAcceptance({ ...fixture.options, inspectProfile: observer })
    expect(observer).toHaveBeenCalledTimes(1)
    expect(receipt(fixture.options.output, 'acceptance.json')).toMatchObject({ normalAcceptanceCompleted: true, cleanupVerified: true })
    expect(existsSync(join(fixture.options.output, 'failure.json'))).toBe(false)
    const metadataCall = effects.exec.mock.calls.find(([file]) => String(file).endsWith('powershell.exe'))
    expect(metadataCall?.[2]).toMatchObject({ timeout: 120_000 })
  })

  it.each(['sync', 'async', 'undefined'] as const)('preserves the %s observer failure through real catch and cleanup', async mode => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    const primary = mode === 'undefined' ? undefined : new Error('unexpected observer')
    const observer = mode === 'async' ? async () => { throw primary } : () => { throw primary }
    await expect(runPackagedCopilotAcceptance({ ...fixture.options, inspectProfile: observer })).rejects.toBe(primary)
    expect(effects.allocated.every(path => !existsSync(path))).toBe(true)
    expect(receipt(fixture.options.output, 'failure.json')).toMatchObject({
      schemaVersion: 2, error: String(primary), cleanupCompleted: true, cleanupVerified: true, cleanupErrors: [], diagnosticErrors: [],
    })
    expect(existsSync(join(fixture.options.output, 'acceptance.json'))).toBe(false)
  })

  it('runs combined qualification through this actual owner once and commits only the distinct suite', async () => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    const { runPackagedCopilotObserverCanary } = await import('./fixtures/copilot-observer-smoke.ts')
    await runPackagedCopilotObserverCanary(fixture.options, runPackagedCopilotAcceptance)
    expect(fixture.launches).toBe(2)
    expect(effects.allocated).toHaveLength(2)
    expect(receipt(fixture.options.output, 'packaged-suite.json')).toMatchObject({
      functionalAssertionsCompleted: true, errorPropagationVerified: true, cleanupVerified: true, normalAcceptanceCompleted: false,
    })
    expect(existsSync(join(fixture.options.output, 'acceptance.json'))).toBe(false)
  })

  it.each(['first-allocation', 'second-allocation', 'prepare'] as const)('cleans every acquired directory after %s failure', async stage => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    const primary = new Error(stage)
    effects.fault = (operation, path) => {
      if (operation === 'allocate' && ((stage === 'first-allocation' && effects.allocated.length === 0) || (stage === 'second-allocation' && effects.allocated.length === 1))) throw primary
      if (stage === 'prepare' && operation === 'write' && basename(String(path)) === 'index.js') throw primary
    }
    await expect(runPackagedCopilotAcceptance(fixture.options)).rejects.toBe(primary)
    expect(effects.allocated.every(path => !existsSync(path))).toBe(true)
    expect(effects.launch).not.toHaveBeenCalled()
    expect(existsSync(join(fixture.options.output, 'acceptance.json'))).toBe(false)
    expect(receipt(fixture.options.output, 'failure.json')).toMatchObject({ error: String(primary), cleanupCompleted: true })
  })

  it.each(['home', 'ancestor', 'close'] as const)('cleanup-only %s failure cannot publish ordinary acceptance', async stage => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    const primary = new Error('cleanup failed')
    if (stage === 'close') fixture.close.mockRejectedValue(primary)
    else effects.fault = (operation, path) => {
      if (operation === 'remove' && String(path).includes(stage === 'home' ? 'packaged-copilot-' : 'legacy-mcp-sdk-')) throw primary
    }
    await expect(runPackagedCopilotAcceptance(fixture.options)).rejects.toBe(primary)
    expect(existsSync(join(fixture.options.output, 'acceptance.json'))).toBe(false)
    expect(receipt(fixture.options.output, 'failure.json').cleanupErrors).not.toEqual([])
  })

  it.each(['initial-diagnostic', 'final-diagnostic', 'cleanup'] as const)('combined owner rejects %s damage without suite success', async stage => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    const { runPackagedCopilotObserverCanary } = await import('./fixtures/copilot-observer-smoke.ts')
    let injected = false
    effects.fault = (operation, path) => {
      if (!injected && ((stage === 'initial-diagnostic' && operation === 'publish' && basename(String(path)) === 'failure.json')
        || (stage === 'final-diagnostic' && operation === 'finalize') || (stage === 'cleanup' && operation === 'remove'))) {
        injected = true; throw new Error(stage)
      }
    }
    await expect(runPackagedCopilotObserverCanary(fixture.options, runPackagedCopilotAcceptance)).rejects.toThrow()
    expect(injected).toBe(true)
    expect(existsSync(join(fixture.options.output, 'packaged-suite.json'))).toBe(false)
    expect(existsSync(join(fixture.options.output, 'acceptance.json'))).toBe(false)
  })

  it('retains graph inspection failure while closing both output descriptors after a close error', async () => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    const primary = new Error('graph inspection failed')
    effects.graph.mockImplementation(() => { throw primary })
    const closed: string[] = []
    effects.fault = (operation, path) => {
      if (operation === 'closed' && String(path).includes('packaged-graph')) {
        closed.push(String(path))
        if (String(path).endsWith('.json')) throw new Error('graph output close failed')
      }
    }
    await expect(runPackagedCopilotAcceptance(fixture.options)).rejects.toBe(primary)
    expect(closed.map(path => basename(path))).toEqual(['initial-packaged-graph.json', 'initial-packaged-graph.stderr.txt'])
    expect(effects.descriptors.size).toBe(0)
    expect(receipt(fixture.options.output, 'failure.json')).toMatchObject({ error: String(primary), cleanupVerified: false })
    expect(existsSync(join(fixture.options.output, 'functional-results.json'))).toBe(false)
  })

  it('retains the exact primary object when diagnostic writing and cleanup both fail', async () => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    const primary = new Error('primary observer')
    effects.fault = (operation, path) => {
      if (operation === 'publish' && basename(String(path)) === 'failure.json') throw new Error('diagnostic failed')
      if (operation === 'remove') throw new Error('cleanup failed')
    }
    await expect(runPackagedCopilotAcceptance({ ...fixture.options, inspectProfile() { throw primary } })).rejects.toBe(primary)
    expect(existsSync(join(fixture.options.output, 'acceptance.json'))).toBe(false)
  })

  it.each(['functional-results.json', 'acceptance.json'] as const)('failed atomic %s publication never reports acceptance', async file => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    effects.fault = (operation, path) => { if (operation === 'publish' && basename(String(path)) === file) throw new Error('atomic publication failed') }
    await expect(runPackagedCopilotAcceptance(fixture.options)).rejects.toThrow('atomic publication failed')
    expect(existsSync(join(fixture.options.output, 'acceptance.json'))).toBe(false)
    expect(effects.allocated.every(path => !existsSync(path))).toBe(true)
    expect(readdirSync(fixture.options.output).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it.each(['ordinary', 'suite'] as const)('leaves no valid %s commit marker when rename and reservation cleanup both fail', async mode => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    const { runPackagedCopilotObserverCanary } = await import('./fixtures/copilot-observer-smoke.ts')
    const file = mode === 'ordinary' ? 'acceptance.json' : 'packaged-suite.json'
    let injected = false
    effects.fault = (operation, path) => {
      if (basename(String(path)) === file && (operation === 'publish' || operation === 'unlink')) {
        injected = true
        expect(readFileSync(join(fixture.options.output, file))).toHaveLength(0)
        throw new Error('commit and reservation cleanup failed')
      }
    }
    const run = mode === 'ordinary' ? runPackagedCopilotAcceptance(fixture.options)
      : runPackagedCopilotObserverCanary(fixture.options, runPackagedCopilotAcceptance)
    await expect(run).rejects.toThrow('publication and cleanup failed')
    expect(injected).toBe(true)
    expect(readFileSync(join(fixture.options.output, file))).toHaveLength(0)
    expect(() => receipt(fixture.options.output, file)).toThrow()
  })

  it('does not replace foreign acceptance bytes introduced before exclusive publication', async () => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    effects.fault = (operation, path) => {
      if (operation === 'open' && basename(String(path)) === 'acceptance.json') writeFileSync(String(path), 'foreign evidence', { flag: 'wx' })
    }
    await expect(runPackagedCopilotAcceptance(fixture.options)).rejects.toThrow()
    expect(readFileSync(join(fixture.options.output, 'acceptance.json'), 'utf8')).toBe('foreign evidence')
    expect(receipt(fixture.options.output, 'failure.json')).toMatchObject({ cleanupCompleted: true })
  })

  it.each(['contents', 'inode'] as const)('preserves a reservation whose %s changed before publication', async damage => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    const fs = await vi.importActual<typeof import('node:fs')>('node:fs')
    let changed = false
    effects.fault = (operation, path) => {
      if (!changed && operation === 'inspect' && basename(String(path)) === 'acceptance.json') {
        changed = true
        if (damage === 'contents') fs.writeFileSync(String(path), 'foreign evidence')
        else {
          const replacement = join(fixture.options.output, 'foreign-inode')
          fs.writeFileSync(replacement, 'foreign evidence')
          fs.renameSync(replacement, String(path))
        }
      }
    }
    await expect(runPackagedCopilotAcceptance(fixture.options)).rejects.toThrow('reservation changed')
    expect(changed).toBe(true)
    expect(readFileSync(join(fixture.options.output, 'acceptance.json'), 'utf8')).toBe('foreign evidence')
  })

  it('performs no fallible filesystem cleanup after ordinary acceptance commit', async () => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    let committed = false
    effects.fault = (operation, path) => {
      if (committed) throw new Error('Unexpected filesystem operation after commit')
      if (operation === 'publish' && basename(String(path)) === 'acceptance.json') committed = true
    }
    await runPackagedCopilotAcceptance(fixture.options)
    expect(committed).toBe(true)
  })

  it('withholds functional evidence and observer when final restart equality fails', async () => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    effects.usage.mockResolvedValueOnce({ usageSurfaceAbsent: true }).mockResolvedValueOnce({ usageSurfaceAbsent: false })
    const observer = vi.fn()
    await expect(runPackagedCopilotAcceptance({ ...fixture.options, inspectProfile: observer })).rejects.toThrow('Restart must preserve')
    expect(observer).not.toHaveBeenCalled()
    expect(existsSync(join(fixture.options.output, 'functional-results.json'))).toBe(false)
  })

  it.each(['functional-results.json', 'failure.json', 'acceptance.json', 'observer-cleanup.json', 'packaged-suite.json'])('refuses stale %s before acquiring resources', async file => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    mkdirSync(fixture.options.output)
    writeFileSync(join(fixture.options.output, file), 'stale')
    await expect(runPackagedCopilotAcceptance(fixture.options)).rejects.toThrow('requires fresh')
    expect(effects.allocated).toEqual([])
    expect(readFileSync(join(fixture.options.output, file), 'utf8')).toBe('stale')
  })
})
