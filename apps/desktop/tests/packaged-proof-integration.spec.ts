/** Actual packaged receipt producers feed the real verifier; native/UI and installed evidence remain inert unit boundaries. */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopForkReleaseCapability, parseDesktopForkReleasePlan } from '../scripts/fork-release.ts'
import { verifyForkQualification } from '../scripts/verify-fork-qualification.ts'
import { managedUpdateJsonSha256, DESKTOP_MANAGED_UPDATE_WORKFLOW } from '../src/managed-update-protocol.ts'
import { buildDesktopProvisioningState } from '../src/plugin-provisioning.ts'
import { DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, parseDesktopPluginProvisionReceipt } from '../src/plugin-source.ts'
import { removeOwnedDirectory } from '../src/owned-directory.ts'
import { runPackagedCopilotAcceptance } from './fixtures/copilot-release-smoke.ts'
import { runPackagedCopilotObserverCanary } from './fixtures/copilot-observer-smoke.ts'
import type { PositiveCopilotUsageEvidence } from './fixtures/copilot-usage-positive-smoke.ts'

const boundary = vi.hoisted(() => ({
  pin: '', temporaryBase: '', launch: vi.fn(), exec: vi.fn(), runtimeRoot: vi.fn(), runtimeBytes: vi.fn(), environment: vi.fn(),
  menu: vi.fn(), settings: vi.fn(), usage: vi.fn(), capability: vi.fn(), allocated: [] as string[],
  reviewedPlugin: undefined as unknown, installedClientSha256: '',
}))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return { ...fs,
    openSync: (...args: Parameters<typeof fs.openSync>) => {
      // Only the independently pinned baseline is replaced with inert unit bytes; verifier logic is real.
      if (boundary.pin && String(args[0]).replaceAll('\\', '/').endsWith('/tests/fixtures/windows-upgrade-baseline.json')) args[0] = boundary.pin
      return fs.openSync(...args)
    },
    mkdtempSync: (...args: Parameters<typeof fs.mkdtempSync>) => {
      const path = fs.mkdtempSync(...args)
      boundary.allocated.push(path)
      return path
    },
  }
})
vi.mock('../scripts/copilot-usage-client-policy.ts', () => ({
  // Admit only this explicitly inert Client's real digest, retaining the original reviewed plan tuple.
  assertReviewedCopilotUsageClient(source: unknown, installedClientSha256: string): void {
    expect(source).toEqual(boundary.reviewedPlugin)
    expect(installedClientSha256).toBe(boundary.installedClientSha256)
  },
}))
vi.mock('node:os', async (original) => {
  const os = await original<typeof import('node:os')>()
  return { ...os, tmpdir: () => boundary.temporaryBase || os.tmpdir() }
})
vi.mock('node:child_process', () => ({ execFileSync: boundary.exec }))
vi.mock('playwright', () => ({ _electron: { launch: boundary.launch } }))
vi.mock('../scripts/packaged-runtime.mjs', () => ({
  packagedDesktopRuntimeEnvironment: (environment: unknown) => environment,
  packagedDesktopRuntimeRoot: boundary.runtimeRoot, readPackagedDesktopRuntimeDescriptor: boundary.runtimeBytes,
  verifyPackagedDesktopRuntime: vi.fn(async () => {}),
}))
vi.mock('../scripts/smoke-environment.ts', () => ({ desktopSmokeEnvironment: boundary.environment }))
vi.mock('../src/plugin-receipts.ts', () => ({ assertDesktopProvisioningInventory: vi.fn() }))
vi.mock('./fixtures/desktop-version-menu-smoke.ts', () => ({ inspectDesktopVersionMenu: boundary.menu }))
vi.mock('./fixtures/copilot-settings-smoke.ts', () => ({ inspectPackagedCopilotSettings: boundary.settings }))
vi.mock('./fixtures/copilot-usage-smoke.ts', () => ({ inspectCopilotUsageCapability: boundary.capability, inspectSignedOutCopilotUsage: boundary.usage }))

const source = 'a'.repeat(40)
const tree = 'b'.repeat(40)
const previousSource = 'c'.repeat(40)
const token = '11111111-2222-4333-8444-555555555555'
const hash = (bytes: string | Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const rawHash = (path: string): string => hash(readFileSync(path))
const save = (path: string, value: unknown): void => { writeFileSync(path, JSON.stringify(value, undefined, 2) + '\n') }
function readRecord(path: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected emitted receipt object')
  return value as Record<string, unknown>
}
const flags = (names: readonly string[], value: boolean): Record<string, boolean> => Object.fromEntries(names.map(name => [name, value]))
const settings = {
  modelRolesViewLoaded: true, currentWorkspaceReadOnly: true, searchProviderCatalogLoaded: true,
  providerOnlySearchRouting: true, fallbackProviderLabel: true, registeredSearchProviders: ['github-copilot-hosted'], realSearch: false,
}
const capabilityEvidence = {
  id: 'account-quota-composer-usage', required: true, evidenceScope: 'synthetic-quota-and-public-remote-ui-contracts-not-live-account-access',
  signedOutNetworkRegressionDeclared: true, lifecycleRegressionDeclared: true,
}
const signedOut = { usageTriggerCount: 0, accountUsageTextCount: 0, usageSurfaceAbsent: true, hostQuotaRequestInstrumentation: 'not-available-in-packaged-smoke' }

function positiveCase(provider: string): PositiveCopilotUsageEvidence {
  return {
    scope: 'packaged-renderer-released-client-synthetic-session-and-quota', provider, usageText: '7 used · 13 left',
    quotaReads: 4, selectorErrors: 0, forbiddenRemoteCalls: 0, hostTransport: 'not-provided-to-isolated-fixture',
    sessionSubscribed: true, removedSessionHidesUsage: true, otherProviderHidesUsage: true, clientDisposalRemovesUsage: true,
    applicationMountPreserved: true, syntheticSiblingPreserved: true, inheritedSessionScopeVerified: true,
    explicitUndefinedSessionScopeAbsent: true, removedSessionRestoresUsage: true, closedSessionHidesUsage: true,
    closedSessionRestoresUsage: true, restoredProviderShowsUsage: true, subscriptionsReleased: true, syntheticContextDisposed: true,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  boundary.pin = ''; boundary.temporaryBase = ''; boundary.allocated = []
  vi.stubEnv('GITHUB_RUN_ID', '123'); vi.stubEnv('GITHUB_RUN_ATTEMPT', '2'); vi.stubEnv('GITHUB_SHA', source)
})
afterEach(() => {
  boundary.pin = ''; boundary.temporaryBase = ''
  vi.unstubAllEnvs()
  for (const path of boundary.allocated.reverse()) if (existsSync(path)) removeOwnedDirectory(path)
})

/** Assemble only preconditions and non-packaged evidence; production functions alone emit the packaged proof graph. */
function integrationFixture(alteredClientBytes?: string) {
  // Resolve the newly owned root before deriving identities; Windows tmpdir may use an 8.3 parent spelling.
  const directory = realpathSync.native(mkdtempSync(join(tmpdir(), 'packaged-proof-integration-')))
  const application = join(directory, 'unpacked', 'cloga-deepseek-harness.exe')
  const resources = join(directory, 'unpacked', 'resources')
  const releaseAssets = join(directory, 'assets')
  const ordinaryEvidence = join(directory, 'ordinary')
  const packagedEvidence = join(directory, 'packaged')
  const baselineDirectory = join(directory, 'baseline')
  const upgradeRoot = join(directory, 'upgrade')
  const evidence = join(upgradeRoot, 'evidence')
  for (const path of [join(resources, 'desktop-provisioning'), join(resources, 'managed-update'), releaseAssets, ordinaryEvidence, packagedEvidence, baselineDirectory, evidence]) mkdirSync(path, { recursive: true })
  // Synthetic prerequisite only: this integration never invokes the helper or claims its real bootstrap was exercised.
  save(join(ordinaryEvidence, 'helper-acceptance.json'), {
    helperSha256: hash('synthetic helper'), isolatedBootstrap: 'passed', validSyntheticHandoffAcknowledged: true,
    cancellationCompleted: true, nodePath: null, nodeOptions: null,
    manifestTransport: 'synthetic fetch only; receipt and installer requests forbidden', liveHandoff: false, installerStarted: false,
  })
  writeFileSync(application, 'INERT UNIT BYTES: NOT AN EXECUTABLE')
  const executableSha256 = rawHash(application)
  // Both producer and consumer bind the very same original reviewed plan bytes, not a reserialized copy.
  const planPath = resolve('apps/desktop/release/cloga-windows-x64.json')
  const plan = parseDesktopForkReleasePlan(JSON.parse(readFileSync(planPath, 'utf8')))
  const capability = createDesktopForkReleaseCapability(plan)
  const capabilityPath = join(resources, 'managed-update', 'capability.json')
  const provisioningPath = join(resources, 'desktop-provisioning', 'plan.json')
  save(capabilityPath, capability)
  save(provisioningPath, plan.desktopProvisioning)
  writeFileSync(join(releaseAssets, 'desktop-provisioning.json'), readFileSync(provisioningPath))
  const runtimeRoot = join(resources, 'app.asar', 'dsh')
  const runtimeBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, release: { version: plan.upstreamVersion, nodeVersion: '24.18.1' }, platform: 'win32', arch: 'x64' }) + '\n')
  const runtimeSha256 = hash(runtimeBytes)
  const metadata = {
    file: basename(application), sha256: executableSha256, productVersion: `${plan.version.split('-')[0]}.0`,
    companyName: 'GitHub, Inc.', productName: plan.identity.productName, fileDescription: plan.identity.productName, signature: 'NotSigned',
  }
  const plugin = plan.desktopProvisioning.plugins[0]!.source
  const inertClientPath = join(directory, 'inert-original-client.js')
  writeFileSync(inertClientPath, '// INERT actual-owner Client identity bytes; never imported or executed.\n')
  boundary.reviewedPlugin = plugin
  boundary.installedClientSha256 = rawHash(inertClientPath)
  const installedClientBytes = alteredClientBytes ?? readFileSync(inertClientPath)
  const pluginReceipt = parseDesktopPluginProvisionReceipt({
    schemaVersion: 1, capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, source: plugin, releaseId: 123,
    assetId: plugin.assetId, packageName: plugin.packageName, version: plugin.version, artifactSha256: plugin.sha256,
    states: { staged: true, health: 'passed', activated: true, rolledBack: false, verified: true },
  })
  const provisionedState = buildDesktopProvisioningState(plan.desktopProvisioning, pluginReceipt)
  let home = ''
  let profile = ''
  let rounds = 0
  let evaluations = 0
  boundary.runtimeRoot.mockReturnValue(runtimeRoot)
  boundary.runtimeBytes.mockReturnValue(runtimeBytes)
  boundary.environment.mockImplementation((path: string) => { home = path; profile = join(path, 'profiles', 'desktop'); return {} })
  boundary.menu.mockResolvedValue({
    applicationMenuLabel: 'Application', aboutMenuLabel: `About Desktop ${plan.version}…`, desktopVersion: plan.version,
    windowId: 1, popupCount: 1, aboutDispatchCount: 1, nativePopupOpened: false, nativeModalOpened: false,
  })
  boundary.settings.mockResolvedValue(settings)
  boundary.capability.mockReturnValue(capabilityEvidence)
  boundary.usage.mockResolvedValue(signedOut)
  type Locator = {
    waitFor(): Promise<void>
    click(): Promise<void>
    isEnabled(): Promise<boolean>
    count(): Promise<number>
    innerText(): Promise<string>
    screenshot(): Promise<void>
    locator(selector: string): Locator
    getByRole(role: string, options?: unknown): Locator
  }
  const locator: Locator = {
    waitFor: async () => {}, click: async () => {}, isEnabled: async () => true, count: async () => 0,
    innerText: async () => '', screenshot: async () => {}, locator: () => locator, getByRole: () => locator,
  }
  const positiveRoutes: string[] = []
  let captureDisposed = false
  let captureRestored = false
  const page = {
    ...locator, setDefaultTimeout() {}, waitForFunction: async () => {}, url: () => 'dsh-app://app/', isClosed: () => false,
    addInitScript: async (script: string) => {
      captureDisposed = false; captureRestored = false
      expect(script.endsWith('\ncaptureUsageModulesInBrowser()')).toBe(true)
      return { dispose: async () => { captureDisposed = true } }
    },
    reload: async () => {},
    evaluate: async (script: string): Promise<unknown> => {
      if (script.endsWith('\nrestoreUsageModulesInBrowser()')) {
        expect(captureDisposed).toBe(true)
        captureRestored = true
        return undefined
      }
      const match = /\nrunPositiveUsageInBrowser\("(github-copilot(?:-preview)?)"\)$/u.exec(script)
      const provider = match?.[1]
      if (provider === undefined) throw new Error('Unexpected isolated Page evaluation')
      positiveRoutes.push(provider)
      return positiveCase(provider)
    },
  }
  boundary.launch.mockImplementation(async () => {
    rounds++
    mkdirSync(profile, { recursive: true })
    const clientDirectory = join(profile, 'node_modules', plugin.packageName, 'lib')
    mkdirSync(clientDirectory, { recursive: true })
    writeFileSync(join(clientDirectory, 'client.js'), installedClientBytes)
    save(join(profile, 'desktop-plugin-receipts.json'), { schemaVersion: 1, receipts: { [plugin.packageName]: pluginReceipt }, owners: { [plugin.packageName]: 'release' } })
    save(join(profile, 'desktop-plugin-provisioning-state.json'), provisionedState)
    save(join(profile, 'package.json'), { dependencies: { [plugin.packageName]: `file:.desktop-plugin-artifacts/${plugin.sha256}.tgz` }, dsh: { profile: { bundles: [plugin.packageName] } } })
    return {
      process: () => ({ stderr: { on() {} } }), firstWindow: async () => page, close: async () => {},
      evaluate: async () => evaluations++ % 2 === 0 ? join(home, 'electron-user-data') : { node: '24.18.1', electron: '44.0.0' },
    }
  })
  boundary.exec.mockImplementation((file: string, args: string[], options?: { stdio?: (string | number | undefined)[] }) => {
    if (file === 'git') {
      expect(args).toEqual(['rev-parse', expect.stringMatching(/^HEAD(?:\^\{tree\})?$/u)])
      return args[1] === 'HEAD' ? source : tree
    }
    if (file.endsWith('powershell.exe')) return JSON.stringify(metadata)
    expect(file).toBe(application)
    // The actual graph-argument producer supplies the profile/runtime; no Electron child is executed.
    expect(args.slice(0, 2)).toEqual(['--input-type=module', '--eval'])
    expect(args[3]).toBe(profile); expect(args[4]).toBe(runtimeRoot)
    const descriptor = options?.stdio?.[1]
    expect(typeof descriptor).toBe('number')
    writeFileSync(descriptor as number, JSON.stringify({
      valid: true, runtimeSha256, executable: application, nodeVersion: '24.18.1', electronVersion: '44.0.0',
      runAsNode: '1', nodePath: null, nodeOptionsPresent: false, electronNoAsarPresent: false,
      cwd: profile, profile, runtimeRoot, resolutionMode: 'runtime',
    }))
  })

  function release(destination: string, commit: string, version: string, upstreamVersion: string, sequence: number) {
    const file = `cloga-deepseek-harness-${version}-win-x64.exe`
    const bytes = Buffer.from('SYNTHETIC INERT INSTALLER INPUT; NEVER EXECUTED\n')
    writeFileSync(join(destination, file), bytes)
    const installer = { file, bytes: bytes.length, sha256: hash(bytes), sha512: createHash('sha512').update(bytes).digest('base64'), signature: 'NotSigned' }
    const build = { workflow: DESKTOP_MANAGED_UPDATE_WORKFLOW, nodeVersion: 'v24.13.0', pnpmVersion: '11.7.0', packageRegistry: 'https://packagefeedproxy.microsoft.io/npm/', lockfileSha256: hash('synthetic lock'), planSha256: rawHash(planPath) }
    const network = { manifestOrigin: 'https://github.com', apiOrigin: 'https://api.github.com', allowedRedirectHosts: ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'] }
    const installation = { interaction: 'required', installerArguments: [], uac: 'installer-controlled', completion: 'post-restart-installed-evidence' }
    const payload = {
      schemaVersion: 1, action: 'desktop-fork-release', status: 'complete', createdUtc: '2026-01-01T00:00:00.000Z',
      source: { repository: 'cloga/deepseek-harness', tag: `dsh-desktop-v${version}`, version, commit, tree }, buildInputs: build,
      identity: { ...plan.identity, upstreamVersion, sequence },
      artifacts: { installer, executableSha256, runtimeSha256, helperSha256: hash('synthetic helper'), capabilitySha256: rawHash(capabilityPath),
        provisioning: { file: 'desktop-provisioning.json', sha256: rawHash(provisioningPath), planSha256: capability.provisioning.planSha256 } },
      validation: {
        helperStandalone: true, nativeUpdaterEnabled: false, appUpdateYmlPresent: false, managedCapabilityMatches: true,
        provisioningPlanMatches: true, installerStarted: false, installedDesktopTouched: false,
      },
      network, installation,
    }
    const buildReceipt = { ...payload, receiptSha256: managedUpdateJsonSha256(payload) }
    save(join(destination, 'build-receipt.json'), buildReceipt)
    const manifestPayload = {
      schemaVersion: 3, owner: 'cloga/deepseek-harness', mode: 'interactive-windows-installer', channel: 'cloga-windows-x64', version, upstreamVersion, sequence,
      source: { repository: 'cloga/deepseek-harness', commit, tree, tag: `dsh-desktop-v${version}` }, build, identity: plan.identity, installer,
      buildReceipt: { file: 'build-receipt.json', sha256: rawHash(join(destination, 'build-receipt.json')), receiptSha256: buildReceipt.receiptSha256 },
      installedEvidence: { executableSha256, runtimeSha256 },
      pluginCompatibility: { capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, automaticProvisioning: false },
      network, installation,
    }
    const manifest = { ...manifestPayload, manifestSha256: managedUpdateJsonSha256(manifestPayload) }
    save(join(destination, 'release.json'), manifest)
    return { manifest, installer: join(destination, file), manifestPath: join(destination, 'release.json'), manifestFileSha256: rawHash(join(destination, 'release.json')) }
  }
  const previous = release(baselineDirectory, previousSource, '0.1.6-alpha.1.cloga.2', '0.1.6-alpha.1', 12)
  const candidate = release(releaseAssets, source, plan.version, plan.upstreamVersion, plan.sequence)
  boundary.pin = join(directory, 'synthetic-baseline-pin.json')
  save(boundary.pin, { schemaVersion: 1, repository: 'cloga/deepseek-harness', releaseId: 1, tag: previous.manifest.source.tag, version: previous.manifest.version, upstreamVersion: previous.manifest.upstreamVersion, sequence: 12,
    manifest: { file: 'release.json', assetId: 2, bytes: readFileSync(previous.manifestPath).length, sha256: previous.manifestFileSha256 }, installer: { ...previous.manifest.installer, assetId: 3 }, applicationUrl: 'dsh-app://app/index.html' })
  save(join(baselineDirectory, 'acquisition.json'), { schemaVersion: 1, releaseId: 1, immutable: true, tag: previous.manifest.source.tag, sourceCommit: previousSource,
    manifestSha256: previous.manifestFileSha256, installerSha256: previous.manifest.installer.sha256, receiptSha256: rawHash(join(baselineDirectory, 'build-receipt.json')), installerExecuted: false })
  save(join(upgradeRoot, 'owner.json'), { token, runId: '123', runAttempt: '2' })
  save(join(upgradeRoot, 'validated.json'), { ownerToken: token, previous, candidate })
  const retainedEnvSha256 = hash(`# Disposable installer-upgrade retained home: ${token}\n`)
  save(join(upgradeRoot, 'retained.json'), { envSha256: retainedEnvSha256 })
  save(join(evidence, 'installer-upgrade.json'), {
    schemaVersion: 1, sourceCommit: source,
    ...flags(['succeeded', 'installerUpgradeVerified', 'runningApplicationRefusalVerified', 'sameCustomPathVerified', 'actualInstalledHostAndClientVerified', 'candidateRestartVerified', 'retainedHomeFileVerified', 'separateSameVersionPackagedPluginAcceptanceVerified'], true),
    ...flags(['pluginUserChoicesVerified', 'draftAttachmentRefusalVerified', 'promotionFailureRollbackVerified', 'managedHandoffVerified', 'postSuccessDowngradeVerified'], false),
    installationRoot: join(upgradeRoot, 'Installed App', plan.identity.packageName), baselineProcessBinding: flags(['pathAvailable', 'providerNormalized', 'directParentMatches', 'basenameMatches', 'hashMatches'], true),
    cleanupErrors: [], secondaryErrors: [], failure: null,
  })
  for (const round of ['baseline', 'candidate', 'candidate-restart']) {
    const expected = round === 'baseline' ? previous : candidate
    save(join(evidence, `${round}.json`), { sourceCommit: expected.manifest.source.commit, version: expected.manifest.version, executableSha256, runtimeSha256,
      actualInstalledApplication: true, actualHostSettingsViews: round === 'baseline' ? { modelRolesViewLoaded: true, searchProviderCatalogLoaded: true, registeredSearchProviders: ['github-copilot-hosted'], realSearch: false } : settings,
      sameRetainedHome: true, retainedEnvSha256, isolatedUserData: true, pluginUserChoicesVerified: false,
      draftAttachmentRefusalVerified: false, realOAuth: false, realModelRound: false, managedHandoffVerified: false,
    })
  }
  save(join(evidence, 'profile-cleanup.json'), { ownedHomeRemoved: true, ownedElectronDataRemoved: true, isolatedPackageAcceptanceDataRemoved: true })
  save(join(evidence, 'package-acceptance.json'), {
    schemaVersion: 1, sourceCommit: source, scope: 'candidate-installed-desktop-same-version-isolated-home',
    ...flags(['succeeded', 'preparedGraphVerified', 'declinePreservedGraphVerified', 'discardPreservedGraphVerified', 'liveDraftAttachmentVetoVerified', 'attachmentOnlyVetoVerified', 'draftOnlyVetoVerified', 'consentGraphPromotionVerified', 'newHostGenerationVerified', 'installedDisabledAfterConsentVerified', 'enabledFixtureRunningAfterSeparateRestartVerified', 'copilotDisabledChoiceAcrossRestartVerified', 'copilotRemovalChoiceAcrossRestartVerified', 'zeroModelRequestsVerified', 'cleanupVerified'], true),
    ...flags(['newlyInstalledTargetHealthyAtFirstConsent', 'verifiedGithubReleaseReceiptForFixture', 'choicesAcrossInstallerUpgradeVerified', 'draftPersistedAcrossQuitVerified', 'promotionFailureRollbackVerified', 'managedHandoffVerified'], false),
    checkpoints: ['synthetic-checkpoint'], shellIncarnations: [{ launchId: token, pid: 12, launcherPid: 13, launchReturned: true, bound: true, exited: true, launcherExited: true }], pageErrors: [], cleanupErrors: [], secondaryErrors: [],
  })
  return {
    ownerOptions: { application, output: packagedEvidence }, get rounds() { return rounds },
    positiveRoutes, get captureDisposed() { return captureDisposed }, get captureRestored() { return captureRestored }, options: {
      planPath, releaseAssets, ordinaryEvidence, packagedEvidence, upgradeRoot, baselineDirectory, expectedSource: source, runId: '123', runAttempt: '2',
    },
  }
}

function packagedHashes(directory: string): Record<string, string> {
  return Object.fromEntries(readdirSync(directory).map(file => [file, rawHash(join(directory, file))]))
}

describe('actual owner/wrapper receipt producer to real qualification consumer', () => {
  it('canonicalizes an owned allocation under an aliased temp base without admitting aliased evidence', async () => {
    const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'packaged-proof-alias-')))
    const target = join(root, 'physical-temp')
    const alias = join(root, 'temp-alias')
    mkdirSync(target)
    symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
    boundary.temporaryBase = alias
    const fixture = integrationFixture()
    const allocated = boundary.allocated.at(-1)
    if (allocated === undefined) throw new Error('Expected the fixture-owned allocation')
    expect(allocated.startsWith(alias)).toBe(true)
    expect(fixture.options.baselineDirectory).toBe(join(realpathSync.native(allocated), 'baseline'))
    expect(fixture.options.baselineDirectory.startsWith(target)).toBe(true)
    await runPackagedCopilotAcceptance({ ...fixture.ownerOptions, output: fixture.options.ordinaryEvidence })
    await runPackagedCopilotObserverCanary(fixture.ownerOptions, runPackagedCopilotAcceptance)
    expect(verifyForkQualification(fixture.options).unexpectedObserverFailureCleanupVerified).toBe(true)
    expect(() => verifyForkQualification({ ...fixture.options, baselineDirectory: join(allocated, 'baseline') }))
      .toThrow(/link|Evidence path differs/u)
  })

  it('verifies original emitted receipts and before-cleanup diagnostics without rewriting any packaged evidence', async () => {
    const fixture = integrationFixture()
    await runPackagedCopilotAcceptance({ ...fixture.ownerOptions, output: fixture.options.ordinaryEvidence })
    expect(fixture.captureDisposed).toBe(true)
    expect(fixture.captureRestored).toBe(true)
    expect(fixture.positiveRoutes).toEqual(['github-copilot', 'github-copilot-preview'])
    await runPackagedCopilotObserverCanary(fixture.ownerOptions, runPackagedCopilotAcceptance)
    expect(fixture.rounds).toBe(4)
    expect(fixture.positiveRoutes).toEqual(['github-copilot', 'github-copilot-preview', 'github-copilot', 'github-copilot-preview'])
    expect(fixture.captureDisposed).toBe(true)
    expect(fixture.captureRestored).toBe(true)
    expect(existsSync(join(fixture.options.packagedEvidence, 'acceptance.json'))).toBe(false)
    const original = packagedHashes(fixture.options.packagedEvidence)
    const originalOrdinary = packagedHashes(fixture.options.ordinaryEvidence)
    expect(original).not.toHaveProperty('helper-acceptance.json')
    const summary = verifyForkQualification(fixture.options)
    expect(summary.inputs['ordinary.acceptance']).toBe(originalOrdinary['acceptance.json'])
    expect(summary.inputs['ordinary.helper']).toBe(originalOrdinary['helper-acceptance.json'])
    expect(summary.inputs['ordinary.positiveUsage']).toBe(originalOrdinary['positive-usage.json'])
    expect(summary.inputs['packaged.positiveUsage']).toBe(original['positive-usage.json'])
    expect(packagedHashes(fixture.options.ordinaryEvidence)).toEqual(originalOrdinary)
    for (const [root, file] of [[fixture.options.ordinaryEvidence, 'acceptance.json'], [fixture.options.packagedEvidence, 'functional-results.json']]) {
      const functional = readRecord(join(root!, file!))
      const positive = readRecord(join(root!, 'positive-usage.json'))
      expect(functional.schemaVersion).toBe(2)
      expect(functional.positiveCopilotUsage).toEqual(positive.cases)
      expect(positive.installedClientSha256).toBe(boundary.installedClientSha256)
    }
    expect(summary).toMatchObject({
      packagedFunctionalVerified: true, unexpectedObserverFailureCleanupVerified: true,
      normalPackagedAcceptanceCompleted: true, canaryNormalAcceptanceCompleted: false,
    })
    for (const [name, file] of [
      ['functional', 'functional-results.json'], ['failure', 'failure.json'], ['observer', 'observer-cleanup.json'],
      ['suite', 'packaged-suite.json'], ['positiveUsage', 'positive-usage.json'],
    ] as const) {
      expect(summary.inputs[`packaged.${name}`]).toBe(original[file])
    }
    expect(packagedHashes(fixture.options.packagedEvidence)).toEqual(original)
  })

  it.each(['ordinary', 'packaged'])('rejects absent or mismatched original %s positive evidence after real producers succeed', async (label) => {
    const fixture = integrationFixture()
    await runPackagedCopilotAcceptance({ ...fixture.ownerOptions, output: fixture.options.ordinaryEvidence })
    await runPackagedCopilotObserverCanary(fixture.ownerOptions, runPackagedCopilotAcceptance)
    expect(verifyForkQualification(fixture.options).unexpectedObserverFailureCleanupVerified).toBe(true)
    const root = label === 'ordinary' ? fixture.options.ordinaryEvidence : fixture.options.packagedEvidence
    const path = join(root, 'positive-usage.json')
    const original = readFileSync(path)
    const positive = JSON.parse(original.toString('utf8')) as Record<string, unknown>
    save(path, { ...positive, installedClientSha256: 'e'.repeat(64) })
    expect(() => verifyForkQualification(fixture.options)).toThrow()
    save(path, { ...positive, cases: [] })
    expect(() => verifyForkQualification(fixture.options)).toThrow()
    writeFileSync(path, original)
    unlinkSync(path)
    expect(() => verifyForkQualification(fixture.options)).toThrow()
  })

  it('rejects contradictory original positive evidence after a successful actual owner run', async () => {
    const fixture = integrationFixture()
    await runPackagedCopilotAcceptance({ ...fixture.ownerOptions, output: fixture.options.ordinaryEvidence })
    await runPackagedCopilotObserverCanary(fixture.ownerOptions, runPackagedCopilotAcceptance)
    expect(verifyForkQualification(fixture.options).packagedFunctionalVerified).toBe(true)
    const path = join(fixture.options.packagedEvidence, 'positive-usage.json')
    const positive = readRecord(path)
    positive.hostTransport = 'unexpected-live-transport'
    save(path, positive)
    expect(() => verifyForkQualification(fixture.options)).toThrow()
  })

  it('rejects altered inert installed Client bytes through the real owner hash and shared policy boundary', async () => {
    const fixture = integrationFixture('// ALTERED INERT Client bytes; never executed.\n')
    await expect(runPackagedCopilotObserverCanary(fixture.ownerOptions, runPackagedCopilotAcceptance)).rejects.toThrow()
    for (const file of ['positive-usage.json', 'functional-results.json', 'packaged-suite.json', 'acceptance.json']) {
      expect(existsSync(join(fixture.options.packagedEvidence, file))).toBe(false)
    }
    expect(() => verifyForkQualification(fixture.options)).toThrow()
  })

  it.each(['functional-results.json', 'failure.json', 'observer-cleanup.json'])('rejects a changed real-producer %s without accepting a reconstructed expected receipt', async (file) => {
    const fixture = integrationFixture()
    await runPackagedCopilotAcceptance({ ...fixture.ownerOptions, output: fixture.options.ordinaryEvidence })
    await runPackagedCopilotObserverCanary(fixture.ownerOptions, runPackagedCopilotAcceptance)
    expect(verifyForkQualification(fixture.options).unexpectedObserverFailureCleanupVerified).toBe(true)
    const path = join(fixture.options.packagedEvidence, file)
    writeFileSync(path, readFileSync(path, 'utf8') + ' ')
    expect(() => verifyForkQualification(fixture.options)).toThrow()
  })
})
