/** Synthetic, inert evidence only: no installer, browser, package manager or network is executed. */
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync, lstatSync, symlinkSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createDesktopForkReleaseCapability, parseDesktopForkReleasePlan } from '../scripts/fork-release.ts'
import { managedUpdateJsonSha256, DESKTOP_MANAGED_UPDATE_WORKFLOW } from '../src/managed-update-protocol.ts'
import { DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, parseDesktopPluginProvisionReceipt } from '../src/plugin-source.ts'
import { buildDesktopProvisioningState } from '../src/plugin-provisioning.ts'
import { assertPackagedQualificationPaths, verifyForkQualification, runForkQualificationCli } from '../scripts/verify-fork-qualification.ts'
import type { PositiveCopilotUsageEvidence } from './fixtures/copilot-usage-positive-smoke.ts'

const boundary = vi.hoisted(() => ({
  syntheticPin: '', source: 'a'.repeat(40), tree: 'b'.repeat(40), gitCalls: [] as string[],
  reviewedPlugin: undefined as unknown, installedClientSha256: '',
}))
vi.mock('../scripts/copilot-usage-client-policy.ts', () => ({
  // Only Client admission is synthetic; keep the actual plan tuple and real hashes of inert bytes.
  assertReviewedCopilotUsageClient(source: unknown, installedClientSha256: string): void {
    expect(source).toEqual(boundary.reviewedPlugin)
    expect(installedClientSha256).toBe(boundary.installedClientSha256)
  },
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, openSync: (...args: Parameters<typeof actual.openSync>) => {
    // Only the immutable baseline-pin read is substituted. Production has no injected pin or success override.
    if (boundary.syntheticPin && String(args[0]).replaceAll('\\', '/').endsWith('/tests/fixtures/windows-upgrade-baseline.json')) args[0] = boundary.syntheticPin
    return actual.openSync(...args)
  } }
})
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, execFileSync: (file: string, args: string[]) => {
    expect(file).toBe('git')
    const command = args.join(' ')
    expect(['rev-parse HEAD', 'rev-parse HEAD^{tree}']).toContain(command)
    boundary.gitCalls.push(command)
    return command === 'rev-parse HEAD' ? boundary.source : boundary.tree
  } }
})

// Narrow containers only; mutated leaves deliberately remain unknown, including invalid schema values.
type Json = Record<string, unknown>
function object(value: unknown): Json {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected fixture object')
  return value as Json
}
function objectAt(value: Json, ...path: string[]): Json {
  for (const key of path) value = object(value[key])
  return value
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error('Expected fixture array')
  return value
}
const root = resolve(import.meta.dirname, '../../..')
const token = '11111111-2222-4333-8444-555555555555'
const source = 'a'.repeat(40)
const tree = 'b'.repeat(40)
const previousSource = 'c'.repeat(40)
const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex')
const json = (path: string): Json => object(JSON.parse(readFileSync(path, 'utf8')) as unknown)
const save = (path: string, value: unknown): void => { writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`) }
const rawHash = (path: string) => sha(readFileSync(path))
const truths = (names: string[], value = true): Record<string, boolean> => Object.fromEntries(names.map(name => [name, value] as const))
const packagedTrue = ['isolatedHome', 'onboardingNoticeDismissed', 'actualGraphVerified', 'ancestorSdkJunction', 'accountEntryVisible', 'manageCompatibilityDisclosureAbsent', 'modelRolesViewLoaded', 'currentWorkspaceReadOnly', 'searchProviderCatalogLoaded', 'providerOnlySearchRouting', 'fallbackProviderLabel']
const packagedFalse = ['ancestorSdkLoaded', 'liveAccountQuota', 'realOAuth', 'verificationNavigationExercised', 'manualVerificationAddressObserved', 'realModelRound', 'realSearch', 'installerUpgradeVerified']
const settingsTrue = ['modelRolesViewLoaded', 'currentWorkspaceReadOnly', 'searchProviderCatalogLoaded', 'providerOnlySearchRouting', 'fallbackProviderLabel']
const upgradeTrue = ['succeeded', 'installerUpgradeVerified', 'runningApplicationRefusalVerified', 'sameCustomPathVerified', 'actualInstalledHostAndClientVerified', 'candidateRestartVerified', 'retainedHomeFileVerified', 'separateSameVersionPackagedPluginAcceptanceVerified']
const upgradeFalse = ['pluginUserChoicesVerified', 'draftAttachmentRefusalVerified', 'promotionFailureRollbackVerified', 'managedHandoffVerified', 'postSuccessDowngradeVerified']
const packageTrue = ['succeeded', 'preparedGraphVerified', 'declinePreservedGraphVerified', 'discardPreservedGraphVerified', 'liveDraftAttachmentVetoVerified', 'attachmentOnlyVetoVerified', 'draftOnlyVetoVerified', 'consentGraphPromotionVerified', 'newHostGenerationVerified', 'installedDisabledAfterConsentVerified', 'enabledFixtureRunningAfterSeparateRestartVerified', 'copilotDisabledChoiceAcrossRestartVerified', 'copilotRemovalChoiceAcrossRestartVerified', 'zeroModelRequestsVerified', 'cleanupVerified']
const packageFalse = ['newlyInstalledTargetHealthyAtFirstConsent', 'verifiedGithubReleaseReceiptForFixture', 'choicesAcrossInstallerUpgradeVerified', 'draftPersistedAcrossQuitVerified', 'promotionFailureRollbackVerified', 'managedHandoffVerified']
const settings = { ...truths(settingsTrue), registeredSearchProviders: ['github-copilot-hosted'], realSearch: false }
const usageCapability = { id: 'account-quota-composer-usage', required: true, evidenceScope: 'synthetic-quota-and-public-remote-ui-contracts-not-live-account-access', signedOutNetworkRegressionDeclared: true, lifecycleRegressionDeclared: true }
const signedOut = { usageTriggerCount: 0, accountUsageTextCount: 0, usageSurfaceAbsent: true, hostQuotaRequestInstrumentation: 'not-available-in-packaged-smoke' }

const positiveFlags = [
  'sessionSubscribed', 'removedSessionHidesUsage', 'otherProviderHidesUsage', 'clientDisposalRemovesUsage',
  'applicationMountPreserved', 'syntheticSiblingPreserved', 'inheritedSessionScopeVerified',
  'explicitUndefinedSessionScopeAbsent', 'removedSessionRestoresUsage', 'closedSessionHidesUsage',
  'closedSessionRestoresUsage', 'restoredProviderShowsUsage', 'subscriptionsReleased', 'syntheticContextDisposed',
]
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

const ownedRoots: string[] = []
function fixture(temporaryRoot = tmpdir()) {
  const allocated = mkdtempSync(join(temporaryRoot, 'dsh-synthetic-qualification-'))
  ownedRoots.push(allocated)
  // Cleanup already owns the raw allocation if expanding a Windows 8.3 ancestor fails.
  const directory = realpathSync.native(allocated)
  const releaseAssets = join(directory, 'assets')
  const packagedEvidence = join(directory, 'packaged')
  const baselineDirectory = join(directory, 'baseline')
  const upgradeRoot = join(directory, 'upgrade')
  const evidence = join(upgradeRoot, 'evidence')
  for (const path of [releaseAssets, packagedEvidence, baselineDirectory, evidence]) mkdirSync(path, { recursive: true })
  const planPath = join(directory, 'plan.json')
  const plan = parseDesktopForkReleasePlan(json(join(root, 'apps/desktop/release/cloga-windows-x64.json')))
  save(planPath, plan)
  const capability = createDesktopForkReleaseCapability(plan)
  save(join(packagedEvidence, 'capability.json'), capability)
  save(join(packagedEvidence, 'helper-acceptance.json'), { helperSha256: sha('synthetic helper'), isolatedBootstrap: 'passed', validSyntheticHandoffAcknowledged: true,
    cancellationCompleted: true, nodePath: null, nodeOptions: null, manifestTransport: 'synthetic fetch only; receipt and installer requests forbidden', liveHandoff: false, installerStarted: false })
  save(join(packagedEvidence, 'provisioning-plan.json'), plan.desktopProvisioning)
  save(join(releaseAssets, 'desktop-provisioning.json'), plan.desktopProvisioning)
  save(join(packagedEvidence, 'desktop-runtime.json'), { schemaVersion: 1, release: { version: plan.upstreamVersion, nodeVersion: '24.18.1' }, platform: 'win32', arch: 'x64' })
  const runtimeSha256 = rawHash(join(packagedEvidence, 'desktop-runtime.json'))
  const executableSha256 = sha('SYNTHETIC INERT EXECUTABLE IDENTITY; NOT A PE FILE')
  save(join(packagedEvidence, 'executable.json'), { file: 'cloga-deepseek-harness.exe', sha256: executableSha256, productVersion: `${plan.version.split('-')[0]}.0`, companyName: 'GitHub, Inc.', productName: plan.identity.productName, fileDescription: plan.identity.productName, signature: 'NotSigned' })
  function release(destination: string, commit: string, version: string, upstreamVersion: string, sequence: number) {
    const installerFile = `cloga-deepseek-harness-${version}-win-x64.exe`
    const bytes = Buffer.from('SYNTHETIC INERT HASH INPUT ONLY; THIS IS NOT AN EXECUTABLE\n')
    writeFileSync(join(destination, installerFile), bytes)
    const installer = { file: installerFile, bytes: bytes.length, sha256: sha(bytes), sha512: createHash('sha512').update(bytes).digest('base64'), signature: 'NotSigned' }
    const build = { workflow: DESKTOP_MANAGED_UPDATE_WORKFLOW, nodeVersion: 'v24.13.0', pnpmVersion: '11.7.0', packageRegistry: 'https://packagefeedproxy.microsoft.io/npm/', lockfileSha256: sha('synthetic lock'), planSha256: rawHash(planPath) }
    const network = { manifestOrigin: 'https://github.com', apiOrigin: 'https://api.github.com', allowedRedirectHosts: ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'] }
    const installation = { interaction: 'required', installerArguments: [], uac: 'installer-controlled', completion: 'post-restart-installed-evidence' }
    const receiptPayload = { schemaVersion: 1, action: 'desktop-fork-release', status: 'complete', createdUtc: '2026-01-01T00:00:00.000Z',
      source: { repository: 'cloga/deepseek-harness', tag: `dsh-desktop-v${version}`, version, commit, tree }, buildInputs: build,
      identity: { ...plan.identity, upstreamVersion, sequence }, artifacts: { installer, executableSha256, runtimeSha256, helperSha256: sha('synthetic helper'), capabilitySha256: rawHash(join(packagedEvidence, 'capability.json')),
        provisioning: { file: 'desktop-provisioning.json', sha256: rawHash(join(packagedEvidence, 'provisioning-plan.json')), planSha256: capability.provisioning.planSha256 } },
      validation: {
        helperStandalone: true, nativeUpdaterEnabled: false, appUpdateYmlPresent: false,
        managedCapabilityMatches: true, provisioningPlanMatches: true, installerStarted: false, installedDesktopTouched: false,
      }, network, installation }
    const receipt = { ...receiptPayload, receiptSha256: managedUpdateJsonSha256(receiptPayload) }
    save(join(destination, 'build-receipt.json'), receipt)
    const manifestPayload = { schemaVersion: 3, owner: 'cloga/deepseek-harness', mode: 'interactive-windows-installer', channel: 'cloga-windows-x64', version, upstreamVersion, sequence,
      source: { repository: 'cloga/deepseek-harness', commit, tree, tag: `dsh-desktop-v${version}` }, build, identity: plan.identity, installer,
      buildReceipt: { file: 'build-receipt.json', sha256: rawHash(join(destination, 'build-receipt.json')), receiptSha256: receipt.receiptSha256 }, installedEvidence: { executableSha256, runtimeSha256 },
      pluginCompatibility: { capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, automaticProvisioning: false }, network, installation }
    const manifest = { ...manifestPayload, manifestSha256: managedUpdateJsonSha256(manifestPayload) }
    save(join(destination, 'release.json'), manifest)
    return { manifest, installer: join(destination, installerFile), manifestPath: join(destination, 'release.json'), manifestFileSha256: rawHash(join(destination, 'release.json')) }
  }
  const previous = release(baselineDirectory, previousSource, '0.1.6-alpha.1.cloga.2', '0.1.6-alpha.1', 12)
  const candidate = release(releaseAssets, source, plan.version, plan.upstreamVersion, plan.sequence)
  boundary.syntheticPin = join(directory, 'synthetic-independent-baseline-pin.json')
  save(boundary.syntheticPin, { schemaVersion: 1, repository: 'cloga/deepseek-harness', releaseId: 1, tag: previous.manifest.source.tag, version: previous.manifest.version, upstreamVersion: previous.manifest.upstreamVersion, sequence: 12,
    manifest: { file: 'release.json', assetId: 2, bytes: readFileSync(previous.manifestPath).length, sha256: previous.manifestFileSha256 }, installer: { ...previous.manifest.installer, assetId: 3 }, applicationUrl: 'dsh-app://app/index.html' })
  save(join(baselineDirectory, 'acquisition.json'), { schemaVersion: 1, releaseId: 1, immutable: true, tag: previous.manifest.source.tag, sourceCommit: previousSource,
    manifestSha256: previous.manifestFileSha256, installerSha256: previous.manifest.installer.sha256, receiptSha256: rawHash(join(baselineDirectory, 'build-receipt.json')), installerExecuted: false })
  save(join(upgradeRoot, 'owner.json'), { token, runId: '123', runAttempt: '2' })
  save(join(upgradeRoot, 'validated.json'), { ownerToken: token, previous, candidate })
  const retainedEnvSha256 = sha(`# Disposable installer-upgrade retained home: ${token}\n`)
  save(join(upgradeRoot, 'retained.json'), { envSha256: retainedEnvSha256 })
  save(join(evidence, 'installer-upgrade.json'), { schemaVersion: 1, sourceCommit: source, ...truths(upgradeTrue), ...truths(upgradeFalse, false), installationRoot: join(upgradeRoot, 'Installed App', plan.identity.packageName),
    baselineProcessBinding: truths(['pathAvailable', 'providerNormalized', 'directParentMatches', 'basenameMatches', 'hashMatches']), cleanupErrors: [], secondaryErrors: [], failure: null })
  for (const round of ['baseline', 'candidate', 'candidate-restart']) {
    const expected = round === 'baseline' ? previous : candidate
    save(join(evidence, `${round}.json`), { sourceCommit: expected.manifest.source.commit, version: expected.manifest.version, executableSha256, runtimeSha256,
      actualInstalledApplication: true, actualHostSettingsViews: round === 'baseline' ? { modelRolesViewLoaded: true, searchProviderCatalogLoaded: true, registeredSearchProviders: ['github-copilot-hosted'], realSearch: false } : settings,
      sameRetainedHome: true, retainedEnvSha256, isolatedUserData: true, pluginUserChoicesVerified: false,
      draftAttachmentRefusalVerified: false, realOAuth: false, realModelRound: false, managedHandoffVerified: false })
  }
  save(join(evidence, 'profile-cleanup.json'), truths(['ownedHomeRemoved', 'ownedElectronDataRemoved', 'isolatedPackageAcceptanceDataRemoved']))
  save(join(evidence, 'package-acceptance.json'), { schemaVersion: 1, sourceCommit: source, scope: 'candidate-installed-desktop-same-version-isolated-home', ...truths(packageTrue), ...truths(packageFalse, false),
    checkpoints: ['synthetic-checkpoint'], shellIncarnations: [{ launchId: token, label: 'synthetic-shell', pid: 12, launcherPid: 13, ...truths(['launchReturned', 'bound', 'exited', 'launcherExited']) }], pageErrors: [], cleanupErrors: [], secondaryErrors: [] })
  const copilot = plan.desktopProvisioning.plugins[0]!.source
  const clientPath = join(directory, 'inert-client.js')
  writeFileSync(clientPath, '// INERT qualification Client identity bytes; never imported or executed.\n')
  boundary.reviewedPlugin = copilot
  boundary.installedClientSha256 = rawHash(clientPath)
  const positiveCases = ['github-copilot', 'github-copilot-preview'].map(positiveCase)
  save(join(packagedEvidence, 'positive-usage.json'), {
    runtimeSha256, installedClientSha256: rawHash(clientPath), pluginSource: copilot, cases: positiveCases,
    originalSignedOutApplicationRestored: true, hostTransport: 'not-provided-to-isolated-fixture',
  })
  const pluginReceipt = { schemaVersion: 1, capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, source: copilot, releaseId: 123,
    assetId: copilot.assetId, packageName: copilot.packageName, version: copilot.version, artifactSha256: copilot.sha256, states: { staged: true, health: 'passed' as const, activated: true, rolledBack: false, verified: true } }
  const menus: Json[] = []
  for (const phase of ['initial', 'restart']) {
    const menu = { applicationMenuLabel: 'Application', aboutMenuLabel: `About Desktop ${plan.version}…`, desktopVersion: plan.version, windowId: 1, popupCount: 1, aboutDispatchCount: 1, nativePopupOpened: false, nativeModalOpened: false }
    menus.push(menu)
    save(join(packagedEvidence, `${phase}-version-menu.json`), menu)
    save(join(packagedEvidence, `${phase}-usage-readonly.json`), { capability: usageCapability, signedOut })
    save(join(packagedEvidence, `${phase}-settings-readonly.json`), settings)
    save(join(packagedEvidence, `${phase}-packaged-graph.json`), { valid: true, runtimeSha256, executable: 'C:\\synthetic\\cloga-deepseek-harness.exe', nodeVersion: '24.18.1', electronVersion: '44.0.0', runAsNode: '1', nodePath: null, nodeOptionsPresent: false, electronNoAsarPresent: false,
      cwd: 'C:\\synthetic-home\\profiles\\desktop', profile: 'C:\\synthetic-home\\profiles\\desktop', runtimeRoot: 'C:\\synthetic\\resources\\app.asar\\dsh', resolutionMode: 'runtime' })
    save(join(packagedEvidence, `${phase}-desktop-plugin-receipts.json`), { schemaVersion: 1, receipts: { [copilot.packageName]: pluginReceipt }, owners: { [copilot.packageName]: 'release' } })
    save(join(packagedEvidence, `${phase}-desktop-plugin-provisioning-state.json`), buildDesktopProvisioningState(plan.desktopProvisioning, parseDesktopPluginProvisionReceipt(pluginReceipt)))
    save(join(packagedEvidence, `${phase}-package.json`), { dependencies: { [copilot.packageName]: `file:.desktop-plugin-artifacts/${copilot.sha256}.tgz` }, dsh: { profile: { bundles: [copilot.packageName] } } })
  }
  const identity = { evidenceId: token, sourceCommit: source, sourceTree: tree, runId: '123', runAttempt: '2', planSha256: rawHash(planPath), runtimeSha256, executableSha256,
    provisioningSha256: rawHash(join(packagedEvidence, 'provisioning-plan.json')), capabilitySha256: rawHash(join(packagedEvidence, 'capability.json')) }
  const timelineEvents = ['package-identity', ...['initial', 'restart'].flatMap(phase =>
    ['launch', 'version-menu', 'application', 'account', 'usage-readonly', 'settings-readonly', 'packaged-graph', 'closed']
      .map(event => `${phase}:${event}`))]
  timelineEvents.splice(timelineEvents.indexOf('restart:closed'), 0, 'restart:positive-usage')
  save(join(packagedEvidence, 'functional-results.json'), { schemaVersion: 2, scope: 'packaged-functional-observations', ...identity, functionalAssertionsCompleted: true, normalAcceptanceCompleted: false, cleanupVerified: false,
    ...truths(packagedTrue), ...truths(packagedFalse, false), desktopVersion: plan.version,
    runtimeVersion: plan.upstreamVersion, versionMenus: menus, plugin: copilot,
    transport: 'official Web-backed Desktop Host with packaged Electron dsh-app origin bridge', restartReceiptSha256: rawHash(join(packagedEvidence, 'initial-desktop-plugin-receipts.json')),
    copilotUsageCapability: usageCapability, signedOutCopilotUsage: [signedOut, signedOut], hostQuotaNoNetworkEvidence: 'immutable-plugin-ci-regression-only',
    positiveCopilotUsage: positiveCases, positiveUsageHostTransport: 'not-provided-to-isolated-fixture',
    timeline: timelineEvents.map((event, milliseconds) => ({ event, milliseconds })) })
  save(join(packagedEvidence, 'failure.json'), { schemaVersion: 2, scope: 'packaged-acceptance-failure', ...identity, error: `Error: packaged observer cleanup canary ${token}`, cleanupCompleted: true, cleanupVerified: true, cleanupErrors: [], diagnosticErrors: [] })
  save(join(packagedEvidence, 'observer-cleanup.json'), { schemaVersion: 3, scope: 'unexpected-observer-failure-cleanup', ...identity,
    ...truths(['observerInvokedOnce', 'errorPropagationVerified', 'ordinaryAcceptanceWithheld', 'cleanupVerified', 'ownedHomeRemoved', 'ownedProfileRemoved', 'ownedLegacySdkRemoved']), normalAcceptanceCompleted: false, functionalSha256: '', failureSha256: '' })
  save(join(packagedEvidence, 'packaged-suite.json'), { schemaVersion: 1, scope: 'packaged-functional-with-unexpected-observer-failure', ...identity, functionalAssertionsCompleted: true, errorPropagationVerified: true, cleanupVerified: true, normalAcceptanceCompleted: false, receipts: {} })
  const options = { planPath, releaseAssets, packagedEvidence, upgradeRoot, baselineDirectory, expectedSource: source, runId: '123', runAttempt: '2' }
  const edit = (path: string, mutate: (value: Json) => void) => { const value = json(path); mutate(value); save(path, value) }
  const seal = () => {
    edit(join(packagedEvidence, 'observer-cleanup.json'), (value) => { value.functionalSha256 = rawHash(join(packagedEvidence, 'functional-results.json')); value.failureSha256 = rawHash(join(packagedEvidence, 'failure.json')) })
    edit(join(packagedEvidence, 'packaged-suite.json'), (value) => {
      const files = [
        ['functional', 'functional-results.json'], ['failure', 'failure.json'], ['observer', 'observer-cleanup.json'],
      ] as const
      value.receipts = Object.fromEntries<{ file: string; sha256: string }>(
        files.map(([key, file]) => [key, { file, sha256: rawHash(join(packagedEvidence, file)) }]),
      )
    })
  }
  seal()
  return { directory, options, edit, seal, evidence, candidate, previous, clientPath }
}
let current: ReturnType<typeof fixture>
beforeEach(() => { current = fixture(); boundary.gitCalls = [] })
afterEach(() => {
  // Remove nested allocations first while their owned alias-parent still exists; rm does not follow child links.
  for (const directory of ownedRoots.toReversed()) rmSync(directory, { recursive: true, force: true })
  ownedRoots.length = 0
  boundary.syntheticPin = ''
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})
const verify = () => verifyForkQualification(current.options)
const packaged = (file: string) => join(current.options.packagedEvidence, file)
const installed = (file: string) => join(current.evidence, file)
const mutate = (file: string, callback: (value: Json) => void, seal = true) => { current.edit(file, callback); if (seal) current.seal() }
function mutatePositive(callback: (value: Json) => void): void {
  current.edit(packaged('positive-usage.json'), callback)
  const positive = json(packaged('positive-usage.json'))
  current.edit(packaged('functional-results.json'), (value) => { value.positiveCopilotUsage = positive.cases })
  current.seal()
}

function inventory(directory: string): Record<string, string> {
  const result: Record<string, string> = {}
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (lstatSync(path).isDirectory()) Object.assign(result, inventory(path))
    else result[path] = rawHash(path)
  }
  return result
}

describe('CI-only fork qualification from retained evidence', () => {
  it('canonicalizes newly owned allocations before constructing evidence paths through a temporary-root alias', () => {
    const parent = join(current.directory, 'allocation-parent')
    const alias = join(current.directory, 'allocation-alias')
    mkdirSync(parent)
    symlinkSync(parent, alias, process.platform === 'win32' ? 'junction' : 'dir')
    const allocated = fixture(alias)
    expect(dirname(allocated.directory)).toBe(realpathSync.native(parent))
    expect(allocated.directory).toBe(realpathSync.native(allocated.directory))
    expect(verifyForkQualification(allocated.options).packagedFunctionalVerified).toBe(true)
  })
  it('accepts the complete synthetic graph, preserves all input bytes, and retains narrow scope', () => {
    const before = inventory(current.directory)
    const summary = verify()
    expect(summary).toMatchObject({ sourceCommit: source, sourceTree: tree, runId: '123', runAttempt: '2', packagedFunctionalVerified: true, actualInstalledUpgradeVerified: true, normalPackagedAcceptanceCompleted: false,
      limits: {
        realOAuth: false, realModelRound: false, realSearch: false, liveAccountQuota: false, choicesAcrossInstallerUpgradeVerified: false,
      } })
    expect(summary.inputs['packaged.suite']).toBe(rawHash(packaged('packaged-suite.json')))
    expect(inventory(current.directory)).toEqual(before)
    expect(boundary.gitCalls).toEqual([])
  })

  it('requires functional schema2 rather than accepting a legacy functional receipt', () => {
    mutate(packaged('functional-results.json'), (value) => { value.schemaVersion = 1 }); expect(verify).toThrow()
  })
  it.each(['positiveCopilotUsage', 'positiveUsageHostTransport'])('requires functional v2 field %s', (field) => {
    mutate(packaged('functional-results.json'), (value) => { Reflect.deleteProperty(value, field) }); expect(verify).toThrow()
  })
  it('binds original positive usage bytes in the CI-only input inventory', () => {
    expect(verify().inputs['packaged.positiveUsage']).toBe(rawHash(packaged('positive-usage.json')))
  })
  it('requires the original positive receipt', () => {
    rmSync(packaged('positive-usage.json')); expect(verify).toThrow()
  })
  it.each(['runtimeSha256', 'installedClientSha256', 'pluginSource', 'cases', 'originalSignedOutApplicationRestored', 'hostTransport'])('rejects missing positive field %s', (field) => {
    mutatePositive((value) => { Reflect.deleteProperty(value, field) }); expect(verify).toThrow()
  })
  it.each(['runtimeSha256', 'installedClientSha256', 'pluginSource', 'cases', 'originalSignedOutApplicationRestored', 'hostTransport'])('rejects altered positive field %s with resealed functional evidence', (field) => {
    mutatePositive((value) => { value[field] = 'foreign' }); expect(verify).toThrow()
  })
  it('rejects a valid-looking but unreviewed Client digest', () => {
    mutatePositive((value) => { value.installedClientSha256 = '0'.repeat(64) }); expect(verify).toThrow()
  })
  it('rejects the genuine digest of tampered inert Client bytes', () => {
    writeFileSync(current.clientPath, '// ALTERED inert Client identity; never executed.\n')
    mutatePositive((value) => { value.installedClientSha256 = rawHash(current.clientPath) }); expect(verify).toThrow()
  })
  it('rejects unknown positive authority fields', () => {
    mutatePositive((value) => { value.liveQuotaVerified = true }); expect(verify).toThrow()
  })
  it.each(['missing', 'duplicate', 'reversed', 'foreign'])('rejects %s positive route cases even when functional cases agree', (damage) => {
    mutatePositive((value) => {
      const cases = array(value.cases)
      if (damage === 'missing') cases.pop()
      else if (damage === 'duplicate') cases[1] = cases[0]
      else if (damage === 'reversed') cases.reverse()
      else object(cases[0]).provider = 'unreviewed-provider'
    }); expect(verify).toThrow()
  })
  it.each([0, 1].flatMap(index => positiveFlags.map(field => ({ index, field }))))('requires positive case $index observation $field', ({ index, field }) => {
    mutatePositive((value) => { object(array(value.cases)[index])[field] = false }); expect(verify).toThrow()
  })
  it.each([0, 1].flatMap(index => [
    'scope', 'provider', 'usageText', 'quotaReads', 'selectorErrors', 'forbiddenRemoteCalls', 'hostTransport', ...positiveFlags,
  ].map(field => ({ index, field }))))('requires positive case $index key $field', ({ index, field }) => {
    mutatePositive((value) => { Reflect.deleteProperty(object(array(value.cases)[index]), field) }); expect(verify).toThrow()
  })
  it.each([0, 1].flatMap(index => ['scope', 'hostTransport', 'usageText'].map(field => ({ index, field }))))('rejects foreign positive case $index $field', ({ index, field }) => {
    mutatePositive((value) => { object(array(value.cases)[index])[field] = 'foreign' }); expect(verify).toThrow()
  })
  it.each([0, 1].flatMap(index => ['quotaReads', 'selectorErrors', 'forbiddenRemoteCalls'].map(field => ({ index, field }))))('rejects wrong positive case $index count $field', ({ index, field }) => {
    mutatePositive((value) => { object(array(value.cases)[index])[field] = field === 'quotaReads' ? 2 : 1 }); expect(verify).toThrow()
  })
  it.each([
    '7 used only', '13 left only', '17 used · 13 left', '7 used · 113 left', '0.7 used · 13 left',
    '7 used · 13 leftover', '7 used · 13 left1', `7 used · 13 left${' '.repeat(256)}`,
  ])('requires both bounded exact positive usage quantities: %s', (usageText) => {
    mutatePositive((value) => { object(array(value.cases)[0]).usageText = usageText }); expect(verify).toThrow()
  })
  it.each(['Copilot credits7 used13 left', '7\tused · 13\nleft'])('accepts reviewed UI quantity formatting: %s', (usageText) => {
    mutatePositive((value) => { object(array(value.cases)[0]).usageText = usageText })
    expect(verify().packagedFunctionalVerified).toBe(true)
  })
  it.each([0, 1])('rejects unknown positive case %s fields instead of filtering them', (index) => {
    mutatePositive((value) => { object(array(value.cases)[index]).liveQuotaVerified = true }); expect(verify).toThrow()
  })
  it('rejects positive cases that disagree with the provisional functional record', () => {
    current.edit(packaged('positive-usage.json'), (value) => { object(array(value.cases)[0]).usageText = 'contradictory' })
    expect(verify).toThrow()
  })
  it.each(['missing', 'duplicate', 'initial', 'after-close', 'unknown'])('rejects %s positive timeline event', (damage) => {
    mutate(packaged('functional-results.json'), (value) => {
      const timeline = array(value.timeline)
      const index = timeline.findIndex(item => object(item).event === 'restart:positive-usage')
      const event = timeline[index]
      if (damage === 'missing') timeline.splice(index, 1)
      else if (damage === 'duplicate') timeline.splice(index, 0, event)
      else if (damage === 'initial') object(event).event = 'initial:positive-usage'
      else if (damage === 'after-close') { timeline.splice(index, 1); timeline.push(event) }
      else object(event).event = 'restart:unknown-usage'
      timeline.forEach((item, milliseconds) => { object(item).milliseconds = milliseconds })
    }); expect(verify).toThrow()
  })

  it('binds helper bootstrap/ACK/cancel to finalized helper bytes without claiming live handoff', () => {
    const summary = verify()
    expect(summary.inputs['packaged.helper']).toBe(rawHash(packaged('helper-acceptance.json')))
    expect(summary.limits).toMatchObject({ helperTransport: 'synthetic fetch only; receipt and installer requests forbidden', liveHandoff: false, managedHandoffVerified: false })
  })
  it('requires original helper acceptance, not only helperStandalone build validation', () => {
    rmSync(packaged('helper-acceptance.json')); expect(verify).toThrow()
  })
  it.each(['helperSha256', 'isolatedBootstrap', 'validSyntheticHandoffAcknowledged', 'cancellationCompleted', 'nodePath', 'nodeOptions', 'manifestTransport', 'liveHandoff', 'installerStarted'])('rejects changed helper %s', (field) => {
    mutate(packaged('helper-acceptance.json'), (value) => { value[field] = typeof value[field] === 'boolean' ? !value[field] : 'foreign' }); expect(verify).toThrow()
  })
  it('rejects additional helper authority fields', () => {
    mutate(packaged('helper-acceptance.json'), (value) => { value.liveUpgradeVerified = true }); expect(verify).toThrow()
  })
  it('accepts optional before-cleanup diagnostics without relabeling them as surviving files', () => {
    mutate(packaged('failure.json'), value => Object.assign(value, { stderrTail: '', stderrTruncated: false, profileFilesPresentBeforeCleanup: { 'package.json': true, 'desktop-plugin-receipts.json': true, 'desktop-plugin-provisioning-state.json': true },
      realOAuth: false, realModelRound: false, realSearch: false,
      verificationNavigationExercised: false, manualVerificationAddressObserved: false }))
    expect(verify().unexpectedObserverFailureCleanupVerified).toBe(true)
  })
  it.each(['schemaVersion', 'scope'])('rejects unknown failure %s', (field) => { mutate(packaged('failure.json'), (value) => { value[field] = 'foreign' }); expect(verify).toThrow() })
  it('rejects unknown failure fields even with a resealed graph', () => { mutate(packaged('failure.json'), (value) => { value.unrecognizedSuccess = true }); expect(verify).toThrow() })
  it.each(['missing', 'reordered', 'duplicate', 'nonmonotonic'])('rejects %s functional observations', (damage) => {
    mutate(packaged('functional-results.json'), (value) => {
      const timeline = array(value.timeline)
      if (damage === 'missing') timeline.pop()
      else if (damage === 'reordered') timeline.reverse()
      else if (damage === 'duplicate') timeline.push(timeline.at(-1))
      else object(timeline[2]).milliseconds = -1
    }); expect(verify).toThrow()
  })
  it.each(['owner.json', 'validated.json', 'retained.json'])('requires root evidence %s', (file) => { rmSync(join(current.options.upgradeRoot, file)); expect(verify).toThrow() })
  it.each(['installer-upgrade.json', 'baseline.json', 'candidate.json', 'candidate-restart.json', 'profile-cleanup.json', 'package-acceptance.json'])('requires installed evidence %s', (file) => { rmSync(installed(file)); expect(verify).toThrow() })
  it.each(['functional-results.json', 'failure.json', 'observer-cleanup.json', 'packaged-suite.json'])('rejects missing %s', (file) => {
    rmSync(packaged(file)); expect(verify).toThrow()
  })
  it.each(['functional-results.json', 'failure.json', 'observer-cleanup.json'])('rejects modified original %s bytes without resealing', (file) => {
    writeFileSync(packaged(file), readFileSync(packaged(file), 'utf8') + ' '); expect(verify).toThrow()
  })
  it.each(['sourceCommit', 'sourceTree', 'runId', 'runAttempt', 'planSha256', 'runtimeSha256', 'executableSha256', 'provisioningSha256', 'capabilitySha256', 'evidenceId'].flatMap(field => ['functional-results.json', 'failure.json', 'observer-cleanup.json', 'packaged-suite.json'].map(file => ({ field, file }))))('rejects foreign $file $field even with updated graph hashes', ({ file, field }) => {
    mutate(packaged(file), (value) => { value[field] = 'foreign' }); expect(verify).toThrow()
  })
  it.each(['functional-results.json', 'failure.json', 'observer-cleanup.json', 'packaged-suite.json'])('rejects missing identity in %s', (file) => {
    mutate(packaged(file), (value) => { delete value.runAttempt }); expect(verify).toThrow()
  })
  it.each(packagedTrue)('requires functional observation %s, not only suite success', (field) => {
    mutate(packaged('functional-results.json'), (value) => { value[field] = false }); expect(verify).toThrow()
  })
  it.each(packagedFalse)('rejects expanded packaged scope %s', (field) => {
    mutate(packaged('functional-results.json'), (value) => { value[field] = true }); expect(verify).toThrow()
  })
  it.each(['cleanupErrors', 'diagnosticErrors'])('rejects exact observer marker with %s', (field) => {
    mutate(packaged('failure.json'), (value) => { value[field] = ['synthetic secondary failure'] }); expect(verify).toThrow()
  })
  it.each(['cleanupCompleted', 'cleanupVerified'])('requires finalized failure %s', (field) => {
    mutate(packaged('failure.json'), (value) => { value[field] = false }); expect(verify).toThrow()
  })
  it.each(['observerInvokedOnce', 'errorPropagationVerified', 'ordinaryAcceptanceWithheld', 'cleanupVerified', 'ownedHomeRemoved', 'ownedProfileRemoved', 'ownedLegacySdkRemoved'])('requires observer %s', (field) => {
    mutate(packaged('observer-cleanup.json'), (value) => { value[field] = false }); expect(verify).toThrow()
  })
  it.each(['functionalAssertionsCompleted', 'errorPropagationVerified', 'cleanupVerified'])('requires suite %s', (field) => {
    mutate(packaged('packaged-suite.json'), (value) => { value[field] = false }); expect(verify).toThrow()
  })
  it.each(['../functional-results.json', 'C:\\foreign.json', 'acceptance.json'])('rejects suite receipt path %s', (file) => {
    mutate(packaged('packaged-suite.json'), (value) => { objectAt(value, 'receipts', 'functional').file = file }, false); expect(verify).toThrow()
  })
  it.each(['extra', 'missing', 'wrong-hash'])('rejects %s suite receipt edge', (damage) => {
    mutate(packaged('packaged-suite.json'), (value) => {
      const receipts = object(value.receipts)
      if (damage === 'extra') receipts.extra = receipts.functional
      else if (damage === 'missing') delete receipts.failure
      else object(receipts.observer).sha256 = '0'.repeat(64)
    }, false); expect(verify).toThrow()
  })
  it('rejects ordinary acceptance alongside the combined canary', () => { save(packaged('acceptance.json'), {}); expect(verify).toThrow() })
  it.each(['functional-results.json', 'observer-cleanup.json', 'packaged-suite.json'])('rejects normal acceptance claim in %s', (file) => {
    mutate(packaged(file), (value) => { value.normalAcceptanceCompleted = true }); expect(verify).toThrow()
  })
  it('does not mistake provisional cleanup for final cleanup', () => { mutate(packaged('functional-results.json'), (value) => { value.cleanupVerified = true }); expect(verify).toThrow() })
  it('rejects unknown success scope', () => { mutate(packaged('functional-results.json'), (value) => { value.nativePopupVerified = true }); expect(verify).toThrow() })
  it('rejects a diagnostic capture error even after final cleanup', () => { mutate(packaged('failure.json'), (value) => { value.captureError = 'failed' }); expect(verify).toThrow() })
  it('rejects a different primary failure', () => { mutate(packaged('failure.json'), (value) => { value.error = 'Error: unrelated' }); expect(verify).toThrow() })
  it.each(['desktop-runtime.json', 'capability.json', 'provisioning-plan.json'])('binds raw %s bytes rather than reserialized JSON', (file) => {
    writeFileSync(packaged(file), readFileSync(packaged(file), 'utf8') + ' '); expect(verify).toThrow()
  })
  it('distinguishes normalized provisioning identity from raw resource SHA', () => {
    const plan = json(current.options.planPath)
    mutate(packaged('functional-results.json'), (value) => { value.provisioningSha256 = sha(JSON.stringify(plan.desktopProvisioning)) }); expect(verify).toThrow()
  })
  it.each(['initial', 'restart'])('crosschecks original %s observations', (phase) => {
    mutate(packaged(`${phase}-settings-readonly.json`), (value) => { value.currentWorkspaceReadOnly = false }); expect(verify).toThrow()
  })
  it.each(['initial-version-menu.json', 'restart-version-menu.json'])('rejects native popup claims in %s', (file) => {
    mutate(packaged(file), (value) => { value.nativePopupOpened = true }); expect(verify).toThrow()
  })
  it.each(['runtimeSha256', 'nodeOptionsPresent', 'resolutionMode', 'profile', 'runtimeRoot'])('crosschecks original graph %s', (field) => {
    mutate(packaged('initial-packaged-graph.json'), (value) => { value[field] = 'foreign' }); expect(verify).toThrow()
  })
  it('requires actual signed-out counts, not merely an absent surface flag', () => { mutate(packaged('initial-usage-readonly.json'), (value) => { object(value.signedOut).usageTriggerCount = 1 }); expect(verify).toThrow() })
  it('crosschecks original profile dependency', () => { mutate(packaged('restart-package.json'), (value) => { object(value.dependencies)['dsh-github-copilot'] = '*' }); expect(verify).toThrow() })
  it('crosschecks original provisioning state', () => { mutate(packaged('initial-desktop-plugin-provisioning-state.json'), (value) => { value.planSha256 = '0'.repeat(64) }); expect(verify).toThrow() })
  it('crosschecks original receipt bytes', () => { mutate(packaged('initial-desktop-plugin-receipts.json'), (value) => { object(value.owners)['dsh-github-copilot'] = 'user' }); expect(verify).toThrow() })

  it.each(upgradeTrue)('requires actual installed upgrade %s', (field) => { mutate(installed('installer-upgrade.json'), (value) => { value[field] = false }); expect(verify).toThrow() })
  it.each(upgradeFalse)('retains unqualified installed scope %s', (field) => { mutate(installed('installer-upgrade.json'), (value) => { value[field] = true }); expect(verify).toThrow() })
  it.each(['cleanupErrors', 'secondaryErrors', 'failure'])('rejects succeeded:true with installer %s', (field) => { mutate(installed('installer-upgrade.json'), (value) => { value[field] = field === 'failure' ? 'synthetic failure' : ['synthetic failure'] }); expect(verify).toThrow() })
  it.each(packageTrue)('requires same-version package %s', (field) => { mutate(installed('package-acceptance.json'), (value) => { value[field] = false }); expect(verify).toThrow() })
  it.each(packageFalse)('retains package scope limit %s', (field) => { mutate(installed('package-acceptance.json'), (value) => { value[field] = true }); expect(verify).toThrow() })
  it.each(['pageErrors', 'cleanupErrors', 'secondaryErrors'])('rejects package %s despite success', (field) => { mutate(installed('package-acceptance.json'), (value) => { value[field] = ['synthetic failure'] }); expect(verify).toThrow() })
  it.each(['sourceCommit', 'scope'])('rejects foreign package %s', (field) => { mutate(installed('package-acceptance.json'), (value) => { value[field] = 'foreign' }); expect(verify).toThrow() })
  it('rejects package error alongside success', () => { mutate(installed('package-acceptance.json'), (value) => { value.error = 'failed' }); expect(verify).toThrow() })
  it.each(['ownedHomeRemoved', 'ownedElectronDataRemoved', 'isolatedPackageAcceptanceDataRemoved'])('requires profile cleanup %s', (field) => { mutate(installed('profile-cleanup.json'), (value) => { value[field] = false }); expect(verify).toThrow() })
  it.each(['token', 'runId', 'runAttempt'])('rejects foreign root owner %s', (field) => { mutate(join(current.options.upgradeRoot, 'owner.json'), (value) => { value[field] = 'foreign' }); expect(verify).toThrow() })
  it('rejects foreign validated owner', () => { mutate(join(current.options.upgradeRoot, 'validated.json'), (value) => { value.ownerToken = 'foreign' }); expect(verify).toThrow() })
  it.each(['manifestFileSha256', 'manifestPath', 'installer'])('rejects foreign validated candidate %s', (field) => { mutate(join(current.options.upgradeRoot, 'validated.json'), (value) => { object(value.candidate)[field] = 'foreign' }); expect(verify).toThrow() })
  it('rejects source-only validated manifest replay', () => { mutate(join(current.options.upgradeRoot, 'validated.json'), (value) => { objectAt(value, 'candidate', 'manifest', 'source').commit = previousSource }); expect(verify).toThrow() })
  it.each(['baseline', 'candidate', 'candidate-restart'].flatMap(round => ['sourceCommit', 'version', 'runtimeSha256', 'executableSha256', 'retainedEnvSha256', 'sameRetainedHome', 'actualInstalledApplication', 'isolatedUserData'].map(field => ({ round, field }))))('rejects changed $round $field', ({ round, field }) => {
    mutate(installed(`${round}.json`), (value) => { value[field] = 'foreign' }); expect(verify).toThrow()
  })
  it.each(['immutable', 'manifestSha256', 'installerSha256', 'receiptSha256', 'sourceCommit', 'releaseId', 'installerExecuted'])('rejects baseline acquisition %s mismatch', (field) => { mutate(join(current.options.baselineDirectory, 'acquisition.json'), (value) => { value[field] = 'foreign' }); expect(verify).toThrow() })
  it('requires independently pinned original baseline bytes', () => { writeFileSync(current.previous.manifestPath, readFileSync(current.previous.manifestPath, 'utf8') + ' '); expect(verify).toThrow() })
  it('rejects retained-home identity not derived from this owner', () => { mutate(join(current.options.upgradeRoot, 'retained.json'), (value) => { value.envSha256 = '0'.repeat(64) }); expect(verify).toThrow() })
  it('rejects leftover home despite a successful cleanup receipt', () => { mkdirSync(join(current.options.upgradeRoot, 'home')); expect(verify).toThrow() })
  it('rejects unacknowledged package process cleanup', () => { mutate(installed('package-acceptance.json'), (value) => { object(array(value.shellIncarnations)[0]).exited = false }); expect(verify).toThrow() })
  it('rejects an empty process cleanup observation', () => { mutate(installed('package-acceptance.json'), (value) => { value.shellIncarnations = [] }); expect(verify).toThrow() })
  it('rejects retained round failure alongside success', () => { save(installed('candidate-failure.json'), { error: 'failed' }); expect(verify).toThrow() })
  it('rejects a changed reviewed plan', () => { mutate(current.options.planPath, (value) => { if (typeof value.sequence !== 'number') throw new Error('Expected fixture sequence'); value.sequence++ }); expect(verify).toThrow() })
  it('rejects a changed finalized installer', () => { writeFileSync(current.candidate.installer, 'different inert text'); expect(verify).toThrow() })
  it('rejects a changed build receipt', () => { mutate(join(current.options.releaseAssets, 'build-receipt.json'), (value) => { value.status = 'failed' }); expect(verify).toThrow() })
  it('does not treat a canonical manifest hash as its raw file hash', () => { mutate(join(current.options.upgradeRoot, 'validated.json'), (value) => { object(value.candidate).manifestFileSha256 = objectAt(value, 'candidate', 'manifest').manifestSha256 }); expect(verify).toThrow() })
  it('rejects an oversized evidence file before parsing it', () => { writeFileSync(packaged('functional-results.json'), ' '.repeat(8 * 1024 * 1024 + 1)); expect(verify).toThrow(/bounded regular/u) })
  it('rejects a directory as evidence', () => { rmSync(packaged('packaged-suite.json')); mkdirSync(packaged('packaged-suite.json')); expect(verify).toThrow(/bounded regular/u) })
  it('rejects evidence reached through an ancestor junction', () => {
    const alias = join(current.directory, 'packaged-alias')
    symlinkSync(current.options.packagedEvidence, alias, process.platform === 'win32' ? 'junction' : 'dir')
    expect(() => verifyForkQualification({ ...current.options, packagedEvidence: alias })).toThrow(/link|path differs/u)
  })
  it.each(['', '0', 'foreign', '123\n'])('rejects invalid run identity %j', (runId) => { expect(() => verifyForkQualification({ ...current.options, runId })).toThrow() })
})

describe('canonical packaged cleanup guard used by the CLI', () => {
  function paths() {
    const home = join(current.directory, '.desktop-smoke', 'packaged-copilot-Synthetic')
    const graph = { executable: join(current.directory, 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/cloga-deepseek-harness.exe'), profile: join(home, 'profiles', 'desktop') }
    return { home, graph, check: () => { assertPackagedQualificationPaths(current.directory, graph) } }
  }
  it('accepts absent owned paths without reading an executable or ASAR interior', () => {
    const { check } = paths()
    const before = inventory(current.directory)
    expect(check).not.toThrow()
    expect(inventory(current.directory)).toEqual(before)
  })
  it.each(['home', 'profile'])('rejects recreated packaged %s despite cleanup receipt assertions', (kind) => {
    const { home, graph, check } = paths()
    mkdirSync(kind === 'home' ? home : graph.profile, { recursive: true })
    expect(check).toThrow(/Unexpected evidence/u)
  })
  it('rejects a profile path escape before inspecting unowned state', () => {
    const { graph } = paths()
    graph.profile = join(current.directory, 'outside', 'profiles', 'desktop')
    expect(() => { assertPackagedQualificationPaths(current.directory, graph) }).toThrow()
  })
  it('rejects a recreated owned-home junction', () => {
    const { home, check } = paths()
    mkdirSync(join(current.directory, '.desktop-smoke'))
    symlinkSync(current.options.packagedEvidence, home, process.platform === 'win32' ? 'junction' : 'dir')
    expect(check).toThrow(/link|path differs/u)
  })
})

describe('fixed qualification CLI', () => {
  function cli(change: Record<string, string> = {}) {
    const temporary = current.directory
    for (const [name, value] of Object.entries({ GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_WORKSPACE: root, GITHUB_SHA: source, GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', RUNNER_TEMP: temporary })) vi.stubEnv(name, value)
    const args = { plan: join(root, 'apps/desktop/release/cloga-windows-x64.json'), 'release-assets': join(root, 'dist/desktop-fork-release'), 'packaged-evidence': join(root, 'dist/desktop-copilot-acceptance'),
      'upgrade-root': join(temporary, 'cloga-installer-upgrade-123-2'), 'baseline-directory': join(temporary, 'desktop-upgrade-baseline-123-2'), 'expected-source': source, 'run-id': '123', 'run-attempt': '2', output: join(root, 'dist/desktop-fork-qualification/qualification.json'), ...change }
    vi.spyOn(process, 'argv', 'get').mockReturnValue(['node', 'verify-fork-qualification.ts', ...Object.entries(args).flatMap(([name, value]) => [`--${name}`, value])])
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
  }
  it('rejects expected source different from actual checkout', () => { cli({ 'expected-source': previousSource }); expect(runForkQualificationCli).toThrow(/Expected source/u); expect(boundary.gitCalls).toEqual(['rev-parse HEAD', 'rev-parse HEAD^{tree}']) })
  it('rejects GITHUB_SHA different from HEAD', () => { cli(); vi.stubEnv('GITHUB_SHA', previousSource); expect(runForkQualificationCli).toThrow(/GITHUB_SHA/u) })
  it('rejects output within public release assets', () => { cli({ output: join(root, 'dist/desktop-fork-release/qualification.json') }); expect(runForkQualificationCli).toThrow(/outside release assets/u) })
  it.each(['plan', 'release-assets', 'packaged-evidence', 'upgrade-root', 'baseline-directory', 'output'])('rejects noncanonical --%s', (name) => { cli({ [name]: join(current.directory, 'foreign') }); expect(runForkQualificationCli).toThrow(/path differs/u) })
  it.each(['run-id', 'run-attempt'])('rejects foreign --%s', (name) => { cli({ [name]: '999' }); expect(runForkQualificationCli).toThrow() })
  it('rejects local invocation before evidence or output writes', () => { cli(); vi.stubEnv('GITHUB_ACTIONS', 'false'); expect(runForkQualificationCli).toThrow(); expect(boundary.gitCalls).toEqual([]) })
})
