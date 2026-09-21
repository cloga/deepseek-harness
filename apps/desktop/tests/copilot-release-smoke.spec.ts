import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PackagedCopilotProfileInspection } from './fixtures/copilot-release-smoke.ts'
import type { PositiveCopilotUsageEvidence } from './fixtures/copilot-usage-positive-smoke.ts'

const effects = vi.hoisted(() => ({
  parseArgs: vi.fn(() => { throw new Error('Import must not parse CLI arguments') }),
  launch: vi.fn(), runtimeRoot: vi.fn(), runtimeBytes: vi.fn(), verifyRuntime: vi.fn(),
  exec: vi.fn(), menu: vi.fn(), settings: vi.fn(), usage: vi.fn(), capability: vi.fn(),
  environment: vi.fn(), graph: vi.fn(), inventory: vi.fn(),
  captureUsage: vi.fn<() => Promise<() => Promise<void>>>(), restoreUsage: vi.fn<() => Promise<void>>(),
  positiveUsage: vi.fn<(page: unknown, provider: string) => Promise<PositiveCopilotUsageEvidence>>(),
  clientPolicy: vi.fn<(source: unknown, clientSha256: string) => void>(),
  fault: undefined as ((operation: string, path: unknown) => void) | undefined,
  removed: [] as string[], allocated: [] as string[], descriptors: new Map<number, string>(),
}))
vi.mock('node:util', async original => ({ ...await original<typeof import('node:util')>(), parseArgs: effects.parseArgs }))
vi.mock('node:child_process', () => ({ execFileSync: effects.exec }))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    mkdtempSync: (...args: Parameters<typeof fs.mkdtempSync>) => {
      effects.fault?.('allocate', args[0])
      const path = fs.mkdtempSync(...args)
      effects.allocated.push(path)
      return path
    },
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>) => { effects.fault?.('write', args[0]); fs.writeFileSync(...args) },
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
      fs.renameSync(...args)
    },
    unlinkSync: (...args: Parameters<typeof fs.unlinkSync>) => { effects.fault?.('unlink', args[0]); fs.unlinkSync(...args) },
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
vi.mock('../src/plugin-provisioning.ts', () => ({ readDesktopPluginProvisioningPlan: (path: string) => readObject(path) }))
vi.mock('../src/plugin-receipts.ts', () => ({ assertDesktopProvisioningInventory: effects.inventory }))
vi.mock('../scripts/smoke-environment.ts', () => ({ desktopSmokeEnvironment: effects.environment }))
vi.mock('./fixtures/desktop-version-menu-smoke.ts', () => ({ inspectDesktopVersionMenu: effects.menu }))
vi.mock('./fixtures/copilot-settings-smoke.ts', () => ({ inspectPackagedCopilotSettings: effects.settings }))
vi.mock('./fixtures/copilot-usage-positive-smoke.ts', () => ({
  capturePackagedUsageModules: effects.captureUsage, inspectPositiveCopilotUsage: effects.positiveUsage,
}))
vi.mock('../scripts/copilot-usage-client-policy.ts', () => ({ assertReviewedCopilotUsageClient: effects.clientPolicy }))
vi.mock('./fixtures/copilot-usage-smoke.ts', () => ({ inspectCopilotUsageCapability: effects.capability, inspectSignedOutCopilotUsage: effects.usage }))
vi.mock('./fixtures/packaged-graph-check.ts', () => ({ inspectPackagedGraphResolution: () => ({}), packagedGraphCheckArguments: effects.graph }))
vi.mock('../src/owned-directory.ts', async (original) => {
  const actual = await original<typeof import('../src/owned-directory.ts')>()
  return { removeOwnedDirectory(path: string) {
    effects.removed.push(path)
    effects.fault?.('remove', path)
    actual.removeOwnedDirectory(path)
  } }
})

const directories: string[] = []
const inertClient = 'Inert synthetic Client bytes; never executed'
function positiveCase(provider: string): PositiveCopilotUsageEvidence {
  return {
    scope: 'packaged-renderer-released-client-synthetic-session-and-quota', provider,
    usageText: '7 used · 13 left', quotaReads: 4, selectorErrors: 0, forbiddenRemoteCalls: 0,
    hostTransport: 'not-provided-to-isolated-fixture', sessionSubscribed: true,
    removedSessionHidesUsage: true, otherProviderHidesUsage: true, clientDisposalRemovesUsage: true,
    applicationMountPreserved: true, syntheticSiblingPreserved: true, inheritedSessionScopeVerified: true,
    explicitUndefinedSessionScopeAbsent: true, removedSessionRestoresUsage: true, closedSessionHidesUsage: true,
    closedSessionRestoresUsage: true, restoredProviderShowsUsage: true, subscriptionsReleased: true, syntheticContextDisposed: true,
  }
}
const hash = (bytes: string | Buffer): string => createHash('sha256').update(bytes).digest('hex')
function readObject(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an owned JSON object')
  return value as Record<string, unknown>
}
const receipt = (output: string, name: string): Record<string, unknown> => readObject(join(output, name))
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
  const reviewed = readObject(resolve('apps/desktop/release/cloga-windows-x64.json'))
  const provisioning = reviewed.desktopProvisioning
  assert(provisioning !== null && typeof provisioning === 'object' && 'plugins' in provisioning && Array.isArray(provisioning.plugins))
  const entry: unknown = provisioning.plugins[0]
  assert(entry !== null && typeof entry === 'object' && 'source' in entry)
  const reviewedSource = entry.source
  assert(reviewedSource !== null && typeof reviewedSource === 'object' && !Array.isArray(reviewedSource))
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
  effects.restoreUsage.mockResolvedValue(undefined)
  effects.captureUsage.mockResolvedValue(effects.restoreUsage)
  effects.positiveUsage.mockImplementation(async (_page: unknown, provider: string) => positiveCase(provider))
  effects.clientPolicy.mockImplementation((source: unknown, clientSha256: string) => {
    assert.deepEqual(source, reviewedSource, 'Synthetic Client policy requires the original reviewed source tuple')
    if (clientSha256 !== hash(inertClient)) throw new Error('Synthetic Client bytes differ')
  })
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
    ...locator, screenshot: vi.fn(async (_options?: { path?: string; timeout?: number }) => {}),
    setDefaultTimeout: vi.fn(), waitForFunction: vi.fn(async () => {}),
    url: () => 'dsh-app://app/', isClosed: () => false,
  }
  effects.environment.mockImplementation((value: string) => {
    home = value; profile = join(home, 'profiles', 'desktop')
    return {}
  })
  effects.launch.mockImplementation(async () => {
    launches++
    mkdirSync(profile, { recursive: true })
    mkdirSync(join(profile, 'node_modules', 'dsh-github-copilot', 'lib'), { recursive: true })
    writeFileSync(join(profile, 'node_modules', 'dsh-github-copilot', 'lib', 'client.js'), inertClient)
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
    if (file !== application) {
      const identity = reviewed.identity as Record<string, unknown>
      return JSON.stringify({ sha256: hash('inert unit fixture bytes'), file: `${identity.executableName}.exe`,
        productVersion: `${String(reviewed.version).split('-')[0]}.0`, productName: identity.productName, fileDescription: identity.productName })
    }
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
  return {
    options: { application, output }, close, page, reviewedSource, get launches() { return launches },
    get clientPath() { return join(profile, 'node_modules', 'dsh-github-copilot', 'lib', 'client.js') },
  }
}

describe('explicit imported Core source contract', () => {
  const expectedFacts = () => {
    const planPath = resolve('apps/desktop/release/cloga-windows-x64.json')
    const plan = readObject(planPath)
    return { commit: 'a'.repeat(40), tree: 'b'.repeat(40), version: String(plan.version), upstreamVersion: String(plan.upstreamVersion),
      executableSha256: hash('inert unit fixture bytes'), runtimeSha256: hash(Buffer.from(JSON.stringify({ release: { version: plan.upstreamVersion } }))),
      planSha256: hash(readFileSync(planPath)) }
  }
  it('preserves the actual Ops run while returning independently observed Core facts', async () => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    vi.stubEnv('GITHUB_REPOSITORY', 'cloga/dsh-windows-ops'); vi.stubEnv('GITHUB_SHA', 'c'.repeat(40))
    const expectedCoreSource = expectedFacts()
    const observed = await runPackagedCopilotAcceptance({ ...fixture.options, expectedCoreSource })
    expect(observed).toEqual(expectedCoreSource); expect(observed).not.toBe(expectedCoreSource)
    expect(process.env.GITHUB_SHA).toBe('c'.repeat(40)); expect(process.env.GITHUB_REPOSITORY).toBe('cloga/dsh-windows-ops')
    expect(receipt(fixture.options.output, 'acceptance.json')).toMatchObject({ sourceCommit: 'a'.repeat(40), runId: '123', runAttempt: '2' })
  })
  it('rejects missing cross-repository facts before runtime, launch or observer work', async () => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    vi.stubEnv('GITHUB_REPOSITORY', 'cloga/dsh-windows-ops')
    const inspectProfile = vi.fn()
    await expect(runPackagedCopilotAcceptance({ ...fixture.options, inspectProfile })).rejects.toThrow('expectedCoreSource')
    expect(effects.verifyRuntime).not.toHaveBeenCalled()
    expect(effects.launch).not.toHaveBeenCalled(); expect(inspectProfile).not.toHaveBeenCalled()
  })
  it.each(['commit', 'tree', 'version', 'upstreamVersion', 'executableSha256', 'runtimeSha256', 'planSha256'] as const)('rejects mismatched %s before application or observer work', async (field) => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    vi.stubEnv('GITHUB_REPOSITORY', 'cloga/dsh-windows-ops')
    const inspectProfile = vi.fn()
    await expect(runPackagedCopilotAcceptance({ ...fixture.options, expectedCoreSource: { ...expectedFacts(), [field]: 'f'.repeat(field.includes('Sha256') ? 64 : 40) }, inspectProfile })).rejects.toThrow()
    expect(effects.launch).not.toHaveBeenCalled(); expect(inspectProfile).not.toHaveBeenCalled()
    if (field !== 'runtimeSha256') expect(effects.verifyRuntime).not.toHaveBeenCalled()
  })
  it('does not let explicit facts override the same-Core GitHub SHA', async () => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    vi.stubEnv('GITHUB_REPOSITORY', 'cloga/deepseek-harness'); vi.stubEnv('GITHUB_SHA', 'c'.repeat(40))
    await expect(runPackagedCopilotAcceptance({ ...fixture.options, expectedCoreSource: expectedFacts() })).rejects.toThrow()
    expect(effects.verifyRuntime).not.toHaveBeenCalled(); expect(effects.launch).not.toHaveBeenCalled()
  })
})

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
  it('keeps the synthetic Client policy bound to the original source tuple as well as real inert-byte hashing', () => {
    const fixture = ownerFixture()
    expect(() => { effects.clientPolicy(fixture.reviewedSource, hash(inertClient)) }).not.toThrow()
    expect(() => { effects.clientPolicy({ ...fixture.reviewedSource, version: 'unreviewed' }, hash(inertClient)) })
      .toThrow('original reviewed source tuple')
  })

  it('publishes both restart-only positive routes and genuine Client byte identity before schema-2 functional evidence', async () => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    effects.captureUsage.mockImplementation(async () => {
      expect(fixture.launches).toBe(2)
      return effects.restoreUsage
    })
    await runPackagedCopilotAcceptance({ ...fixture.options, inspectProfile() {
      expect(effects.restoreUsage).toHaveBeenCalledTimes(1)
      const positive = receipt(fixture.options.output, 'positive-usage.json')
      expect(Object.keys(positive).sort()).toEqual([
        'runtimeSha256', 'installedClientSha256', 'pluginSource', 'cases', 'originalSignedOutApplicationRestored', 'hostTransport',
      ].sort())
      expect(positive.installedClientSha256).toBe(hash(inertClient))
      expect(positive.cases).toEqual(['github-copilot', 'github-copilot-preview'].map(positiveCase))
      const functional = receipt(fixture.options.output, 'functional-results.json')
      expect(functional).toMatchObject({ schemaVersion: 2, positiveCopilotUsage: positive.cases })
      const timeline: unknown = functional.timeline
      expect(Array.isArray(timeline)).toBe(true)
      const events = (timeline as unknown[]).map((item) => {
        if (item === null || typeof item !== 'object' || !('event' in item)) throw new Error('Missing owned timeline event')
        return item.event
      })
      expect(events.indexOf('restart:positive-usage')).toBeGreaterThan(events.indexOf('restart:packaged-graph'))
      expect(events.indexOf('restart:positive-usage')).toBeLessThan(events.indexOf('restart:closed'))
    } })
    expect(effects.captureUsage).toHaveBeenCalledTimes(1)
    expect(effects.positiveUsage.mock.calls.map(call => call[1])).toEqual(['github-copilot', 'github-copilot-preview'])
    expect(receipt(fixture.options.output, 'acceptance.json')).toMatchObject({ schemaVersion: 2, cleanupVerified: true })
  })

  it.each(['capture', 'first-route', 'second-route', 'capture-restore', 'page-restore', 'screenshot', 'client-read', 'positive-write'] as const)(
    'withholds positive and functional receipts after %s failure', async (stage) => {
      const fixture = ownerFixture()
      const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
      const primary = new Error(stage)
      if (stage === 'capture') effects.captureUsage.mockRejectedValueOnce(primary)
      else if (stage === 'first-route') effects.positiveUsage.mockRejectedValueOnce(primary)
      else if (stage === 'second-route') effects.positiveUsage.mockResolvedValueOnce(positiveCase('github-copilot')).mockRejectedValueOnce(primary)
      else if (stage === 'capture-restore') effects.restoreUsage.mockRejectedValueOnce(primary)
      else if (stage === 'page-restore') {
        effects.usage.mockResolvedValueOnce({ usageSurfaceAbsent: true }).mockResolvedValueOnce({ usageSurfaceAbsent: true })
          .mockRejectedValueOnce(primary)
      } else if (stage === 'screenshot') {
        fixture.page.screenshot.mockImplementation(async (options) => {
          if (options?.path?.endsWith('positive-usage-cleanup.png')) throw primary
        })
      } else {
        effects.fault = (operation, path) => {
          if ((stage === 'client-read' && operation === 'open' && basename(String(path)) === 'client.js')
            || (stage === 'positive-write' && operation === 'publish' && basename(String(path)) === 'positive-usage.json')) throw primary
        }
      }
      const observer = vi.fn()
      await expect(runPackagedCopilotAcceptance({ ...fixture.options, inspectProfile: observer })).rejects.toBe(primary)
      expect(observer).not.toHaveBeenCalled()
      for (const file of ['positive-usage.json', 'functional-results.json', 'acceptance.json']) {
        expect(existsSync(join(fixture.options.output, file))).toBe(false)
      }
      expect(effects.allocated.every(path => !existsSync(path))).toBe(true)
    },
  )

  it('preserves the positive render exception when capture restoration also fails', async () => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    const primary = new Error('positive render failed')
    effects.positiveUsage.mockRejectedValueOnce(primary)
    effects.restoreUsage.mockRejectedValueOnce(new Error('capture restore failed'))
    await expect(runPackagedCopilotAcceptance(fixture.options)).rejects.toBe(primary)
    expect(effects.restoreUsage).toHaveBeenCalledTimes(1)
    expect(receipt(fixture.options.output, 'failure.json').cleanupErrors).not.toEqual([])
    expect(existsSync(join(fixture.options.output, 'functional-results.json'))).toBe(false)
  })

  it('rejects changed inert Client bytes through real hashing and the owned synthetic policy boundary', async () => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    effects.positiveUsage.mockImplementationOnce(async (_page: unknown, provider: string) => {
      writeFileSync(fixture.clientPath, 'changed inert Client bytes')
      return positiveCase(provider)
    })
    await expect(runPackagedCopilotAcceptance(fixture.options)).rejects.toThrow('Synthetic Client bytes differ')
    expect(effects.restoreUsage).toHaveBeenCalledTimes(1)
    expect(existsSync(join(fixture.options.output, 'positive-usage.json'))).toBe(false)
    expect(existsSync(join(fixture.options.output, 'functional-results.json'))).toBe(false)
  })

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
    expect(effects.captureUsage).toHaveBeenCalledTimes(1)
    expect(effects.positiveUsage.mock.calls.map(call => call[1])).toEqual(['github-copilot', 'github-copilot-preview'])
    const positive = receipt(fixture.options.output, 'positive-usage.json')
    const accepted = receipt(fixture.options.output, 'acceptance.json')
    expect(positive).toMatchObject({ installedClientSha256: hash(inertClient), runtimeSha256: accepted.runtimeSha256,
      pluginSource: accepted.plugin, cases: accepted.positiveCopilotUsage, originalSignedOutApplicationRestored: true,
      hostTransport: 'not-provided-to-isolated-fixture' })
    expect(receipt(fixture.options.output, 'acceptance.json')).toMatchObject({ normalAcceptanceCompleted: true, cleanupVerified: true })
    expect(existsSync(join(fixture.options.output, 'failure.json'))).toBe(false)
    const metadataCall = effects.exec.mock.calls.find(([file]) => String(file).endsWith('powershell.exe'))
    expect(metadataCall?.[2]).toMatchObject({ timeout: 120_000 })
  })

  it.each(['capture', 'canonical', 'preview', 'restored-signed-out', 'artifact-write'] as const)('withholds functional and normal acceptance after positive %s failure', async (mode) => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    const primary = new Error('positive fixture boundary failed')
    if (mode === 'capture') effects.captureUsage.mockRejectedValueOnce(primary)
    if (mode === 'canonical') effects.positiveUsage.mockRejectedValueOnce(primary)
    if (mode === 'preview') {
      const original = effects.positiveUsage.getMockImplementation()!
      effects.positiveUsage.mockImplementationOnce(original).mockRejectedValueOnce(primary)
    }
    if (mode === 'restored-signed-out') effects.usage.mockResolvedValueOnce({ usageSurfaceAbsent: true })
      .mockResolvedValueOnce({ usageSurfaceAbsent: true }).mockRejectedValueOnce(primary)
    if (mode === 'artifact-write') effects.fault = (operation, path) => {
      if (operation === 'publish' && basename(String(path)) === 'positive-usage.json') throw primary
    }
    const observer = vi.fn()
    await expect(runPackagedCopilotAcceptance({ ...fixture.options, inspectProfile: observer })).rejects.toBe(primary)
    expect(observer).not.toHaveBeenCalled()
    for (const file of ['functional-results.json', 'acceptance.json', 'packaged-suite.json']) {
      expect(existsSync(join(fixture.options.output, file))).toBe(false)
    }
    expect(receipt(fixture.options.output, 'failure.json')).toMatchObject({ cleanupCompleted: true, cleanupVerified: true })
  })

  it.each(['sync', 'async', 'undefined'] as const)('preserves the %s observer failure through real catch and cleanup', async (mode) => {
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

  it.each(['first-allocation', 'second-allocation', 'prepare'] as const)('cleans every acquired directory after %s failure', async (stage) => {
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

  it.each(['home', 'ancestor', 'close'] as const)('cleanup-only %s failure cannot publish ordinary acceptance', async (stage) => {
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

  it.each(['initial-diagnostic', 'final-diagnostic', 'cleanup'] as const)('combined owner rejects %s damage without suite success', async (stage) => {
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

  it.each(['functional-results.json', 'acceptance.json'] as const)('failed atomic %s publication never reports acceptance', async (file) => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    effects.fault = (operation, path) => { if (operation === 'publish' && basename(String(path)) === file) throw new Error('atomic publication failed') }
    await expect(runPackagedCopilotAcceptance(fixture.options)).rejects.toThrow('atomic publication failed')
    expect(existsSync(join(fixture.options.output, 'acceptance.json'))).toBe(false)
    expect(effects.allocated.every(path => !existsSync(path))).toBe(true)
    expect(readdirSync(fixture.options.output).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it.each(['ordinary', 'suite'] as const)('leaves no valid %s commit marker when rename and reservation cleanup both fail', async (mode) => {
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

  it.each(['contents', 'inode'] as const)('preserves a reservation whose %s changed before publication', async (damage) => {
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
      .mockResolvedValueOnce({ usageSurfaceAbsent: false })
    const observer = vi.fn()
    await expect(runPackagedCopilotAcceptance({ ...fixture.options, inspectProfile: observer })).rejects.toThrow('Restart must preserve')
    expect(observer).not.toHaveBeenCalled()
    expect(existsSync(join(fixture.options.output, 'functional-results.json'))).toBe(false)
  })

  it.each(['positive-usage.json', 'functional-results.json', 'failure.json', 'acceptance.json', 'observer-cleanup.json', 'packaged-suite.json'])('refuses stale %s before acquiring resources', async (file) => {
    const fixture = ownerFixture()
    const { runPackagedCopilotAcceptance } = await import('./fixtures/copilot-release-smoke.ts')
    mkdirSync(fixture.options.output)
    writeFileSync(join(fixture.options.output, file), 'stale')
    await expect(runPackagedCopilotAcceptance(fixture.options)).rejects.toThrow('requires fresh')
    expect(effects.allocated).toEqual([])
    expect(readFileSync(join(fixture.options.output, file), 'utf8')).toBe('stale')
  })
})
