/** Read-only CI qualification of retained packaged and installed evidence; never release metadata. */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep, win32 } from 'node:path'
import { parseArgs } from 'node:util'
import { createDesktopForkReleaseCapability, parseDesktopForkReleasePlan } from './fork-release.ts'
import { managedUpdateJsonSha256, parseDesktopManagedUpdateCapability, parseDesktopManagedUpdateManifest } from '../src/managed-update-protocol.ts'
import { desktopPluginProvisioningPlanSha256, parseDesktopPluginProvisioningPlan, parseDesktopPluginProvisioningState } from '../src/plugin-provisioning.ts'
import { parseDesktopPluginProvisionReceipt } from '../src/plugin-source.ts'
import { verifyUpgradeRelease } from '../tests/fixtures/windows-installed-upgrade-contract.mjs'

const repository = resolve(import.meta.dirname, '../../..')
const pinPath = join(repository, 'apps/desktop/tests/fixtures/windows-upgrade-baseline.json')
const identityKeys = ['evidenceId', 'sourceCommit', 'sourceTree', 'runId', 'runAttempt', 'planSha256', 'runtimeSha256', 'executableSha256', 'provisioningSha256', 'capabilitySha256']
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const packagedTrue = ['isolatedHome', 'onboardingNoticeDismissed', 'actualGraphVerified', 'ancestorSdkJunction', 'accountEntryVisible', 'manageCompatibilityDisclosureAbsent', 'modelRolesViewLoaded', 'currentWorkspaceReadOnly', 'searchProviderCatalogLoaded', 'providerOnlySearchRouting', 'fallbackProviderLabel']
const packagedFalse = ['ancestorSdkLoaded', 'liveAccountQuota', 'realOAuth', 'verificationNavigationExercised', 'manualVerificationAddressObserved', 'realModelRound', 'realSearch', 'installerUpgradeVerified']
const settingsTrue = ['modelRolesViewLoaded', 'currentWorkspaceReadOnly', 'searchProviderCatalogLoaded', 'providerOnlySearchRouting', 'fallbackProviderLabel']
const upgradeTrue = ['succeeded', 'installerUpgradeVerified', 'runningApplicationRefusalVerified', 'sameCustomPathVerified', 'actualInstalledHostAndClientVerified', 'candidateRestartVerified', 'retainedHomeFileVerified', 'separateSameVersionPackagedPluginAcceptanceVerified']
const upgradeFalse = ['pluginUserChoicesVerified', 'draftAttachmentRefusalVerified', 'promotionFailureRollbackVerified', 'managedHandoffVerified', 'postSuccessDowngradeVerified']
const packageTrue = ['succeeded', 'preparedGraphVerified', 'declinePreservedGraphVerified', 'discardPreservedGraphVerified', 'liveDraftAttachmentVetoVerified', 'attachmentOnlyVetoVerified', 'draftOnlyVetoVerified', 'consentGraphPromotionVerified', 'newHostGenerationVerified', 'installedDisabledAfterConsentVerified', 'enabledFixtureRunningAfterSeparateRestartVerified', 'copilotDisabledChoiceAcrossRestartVerified', 'copilotRemovalChoiceAcrossRestartVerified', 'zeroModelRequestsVerified', 'cleanupVerified']
const packageFalse = ['newlyInstalledTargetHealthyAtFirstConsent', 'verifiedGithubReleaseReceiptForFixture', 'choicesAcrossInstallerUpgradeVerified', 'draftPersistedAcrossQuitVerified', 'promotionFailureRollbackVerified', 'managedHandoffVerified']
type RecordValue = Record<string, unknown>

function object(value: unknown): RecordValue {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value), 'Expected evidence object')
  return value as RecordValue
}
function text(value: unknown): string { assert.equal(typeof value, 'string'); return value as string }
function array(value: unknown): unknown[] { assert(Array.isArray(value), 'Expected evidence array'); return value }
function keys(value: RecordValue, required: readonly string[], optional: readonly string[] = []): void {
  for (const key of required) assert(Object.hasOwn(value, key), `Missing evidence field: ${key}`)
  for (const key of Object.keys(value)) assert(required.includes(key) || optional.includes(key), `Unknown evidence field: ${key}`)
}
function flags(value: RecordValue, yes: readonly string[], no: readonly string[] = []): void {
  for (const key of yes) assert.equal(value[key], true, `Required observation: ${key}`)
  for (const key of no) assert.equal(value[key], false, `Unqualified scope: ${key}`)
}
function hash(bytes: Uint8Array | string): string { return createHash('sha256').update(bytes).digest('hex') }
function samePath(left: string, right: string): void {
  const normalize = (path: string) => process.platform === 'win32' ? resolve(path).toLowerCase() : resolve(path)
  assert.equal(normalize(left), normalize(right), 'Evidence path differs')
}

// Check every ancestor, including the supplied root. An existing junction must not make an escape canonical.
function physical(path: string): string {
  const absolute = resolve(path)
  assert(!absolute.startsWith('\\\\'), 'Network evidence is not permitted')
  let cursor = absolute
  while (true) {
    const stat = lstatSync(cursor, { throwIfNoEntry: false })
    if (stat !== undefined) {
      assert(!stat.isSymbolicLink(), 'Evidence must not traverse a link')
      samePath(realpathSync.native(cursor), cursor)
    }
    const parent = dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  return absolute
}
function bounded(path: string, maximum = 8 * 1024 * 1024): string {
  const result = physical(path)
  const stat = lstatSync(result)
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maximum, 'Evidence must be a bounded regular file')
  return result
}
function read(path: string): { value: RecordValue; sha256: string; bytes: number } {
  const safe = bounded(path)
  const descriptor = openSync(safe, 'r')
  try {
    const before = fstatSync(descriptor)
    assert(before.isFile() && before.size > 0 && before.size <= 8 * 1024 * 1024)
    const bytes = readFileSync(descriptor)
    const after = fstatSync(descriptor)
    assert.equal(bytes.length, before.size, 'Evidence changed during read')
    assert.equal(after.mtimeMs, before.mtimeMs, 'Evidence changed during read')
    assert.equal(after.size, before.size, 'Evidence changed during read')
    return { value: object(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/u, ''))), sha256: hash(bytes), bytes: bytes.length }
  } finally { closeSync(descriptor) }
}
function absent(path: string): void { physical(path); assert.equal(lstatSync(path, { throwIfNoEntry: false }), undefined, `Unexpected evidence: ${path}`) }
function settings(value: unknown, baseline = false): void {
  const record = object(value)
  const required = baseline ? ['modelRolesViewLoaded', 'searchProviderCatalogLoaded'] : settingsTrue
  keys(record, [...required, 'registeredSearchProviders', 'realSearch'])
  flags(record, required, ['realSearch'])
  const providers = array(record.registeredSearchProviders)
  assert(providers.every(item => typeof item === 'string' && item.length > 0))
  assert.equal(new Set(providers).size, providers.length)
  assert(providers.includes('github-copilot-hosted'))
}

/** Paths and exact workflow identity supplied by the caller; all inputs remain read-only. */
export interface ForkQualificationOptions {
  readonly planPath: string
  readonly releaseAssets: string
  readonly ordinaryEvidence: string
  readonly packagedEvidence: string
  readonly upgradeRoot: string
  readonly baselineDirectory: string
  readonly expectedSource: string
  readonly runId: string
  readonly runAttempt: string
}

/**
 * Validate the original evidence graph without launching, extracting, preparing or finalizing any application.
 * Older installed phases inherit owner/run binding through validated.json, not nonexistent per-record run hashes.
 * @param options - Reviewed plan, finalized assets and the same fresh installed-upgrade root.
 * @returns An owned CI-only summary with raw input hashes and deliberately limited acceptance claims.
 */
export function verifyForkQualification(options: ForkQualificationOptions) {
  assert.match(options.expectedSource, /^[a-f0-9]{40}$/u)
  assert.match(options.runId, /^[1-9]\d*$/u)
  assert.match(options.runAttempt, /^[1-9]\d*$/u)
  const inputs: Record<string, string> = {}
  const input = (root: string, file: string, label: string) => {
    assert.match(file, /^[A-Za-z0-9][A-Za-z0-9._-]*$/u, 'Evidence filename must not contain a path')
    const result = read(join(root, file))
    inputs[label] = result.sha256
    return result
  }
  const reviewed = read(options.planPath)
  inputs.plan = reviewed.sha256
  const plan = parseDesktopForkReleasePlan(reviewed.value)
  const capability = createDesktopForkReleaseCapability(plan)
  const pin = read(pinPath)
  inputs.baselinePin = pin.sha256
  const pinned = pin.value
  assert.equal(pinned.schemaVersion, 1)
  assert.equal(pinned.repository, 'cloga/deepseek-harness')
  const pinnedManifest = object(pinned.manifest)
  const pinnedInstaller = object(pinned.installer)
  assert.equal(pinnedManifest.file, 'release.json')

  const release = (directory: string, commit: string, version: string, upstreamVersion: string, manifestHash?: string) => {
    const manifest = input(directory, 'release.json', `${directory === options.releaseAssets ? 'candidate' : 'baseline'}.manifest`)
    const value = manifest.value
    assert.equal(object(value.buildReceipt).file, 'build-receipt.json')
    const receipt = input(directory, 'build-receipt.json', `${directory === options.releaseAssets ? 'candidate' : 'baseline'}.receipt`)
    assert.equal(object(value.installer).file, `cloga-deepseek-harness-${version}-win-x64.exe`)
    bounded(join(directory, text(object(value.installer).file)), 512 * 1024 * 1024)
    // The maintained verifier distinguishes raw manifest/receipt hashes from canonical self-hashes.
    const verified = verifyUpgradeRelease(directory, {
      commit, version, upstreamVersion, ...(manifestHash === undefined ? {} : { manifestSha256: manifestHash }),
    }, managedUpdateJsonSha256)
    inputs[`${directory === options.releaseAssets ? 'candidate' : 'baseline'}.installer`] = text(object(value.installer).sha256)
    return { verified, manifest, receipt }
  }
  const baselineManifest = input(options.baselineDirectory, 'release.json', 'baseline.manifest')
  assert.equal(baselineManifest.sha256, pinnedManifest.sha256, 'Baseline independent pin differs')
  assert.equal(baselineManifest.bytes, pinnedManifest.bytes)
  const previous = release(
    options.baselineDirectory, text(object(baselineManifest.value.source).commit),
    text(pinned.version), text(pinned.upstreamVersion), text(pinnedManifest.sha256),
  )
  assert.equal(previous.manifest.value.sequence, pinned.sequence)
  assert.equal(object(previous.manifest.value.source).tag, pinned.tag)
  for (const field of ['file', 'bytes', 'sha256', 'sha512']) assert.equal(object(previous.manifest.value.installer)[field], pinnedInstaller[field])
  const candidate = release(options.releaseAssets, options.expectedSource, plan.version, plan.upstreamVersion)
  const manifest = parseDesktopManagedUpdateManifest(candidate.manifest.value, capability, 0, true)
  assert(manifest.schemaVersion === 3, 'Expected finalized source manifest')
  assert.equal(manifest.sequence, plan.sequence)
  assert(Number(pinned.sequence) < plan.sequence)
  assert.equal(manifest.build.planSha256, reviewed.sha256)
  const receipt = candidate.receipt.value
  assert.equal(receipt.schemaVersion, 1)
  assert.deepEqual(object(receipt.source), { ...manifest.source, version: plan.version })
  assert.deepEqual(object(receipt.identity), { ...plan.identity, upstreamVersion: plan.upstreamVersion, sequence: plan.sequence })
  flags(object(receipt.validation), ['helperStandalone', 'managedCapabilityMatches', 'provisioningPlanMatches'], ['nativeUpdaterEnabled', 'appUpdateYmlPresent', 'installerStarted', 'installedDesktopTouched'])
  assert.deepEqual(receipt.buildInputs, manifest.build)
  assert.deepEqual(receipt.installation, manifest.installation)
  assert.deepEqual(receipt.network, manifest.network)
  const artifacts = object(receipt.artifacts)
  const helper = input(options.ordinaryEvidence, 'helper-acceptance.json', 'ordinary.helper').value
  keys(helper, ['helperSha256', 'isolatedBootstrap', 'validSyntheticHandoffAcknowledged', 'cancellationCompleted', 'nodePath', 'nodeOptions', 'manifestTransport', 'liveHandoff', 'installerStarted'])
  assert.match(text(helper.helperSha256), /^[a-f0-9]{64}$/u)
  assert.equal(helper.helperSha256, artifacts.helperSha256)
  assert.equal(helper.isolatedBootstrap, 'passed')
  flags(helper, ['validSyntheticHandoffAcknowledged', 'cancellationCompleted'], ['liveHandoff', 'installerStarted'])
  assert.equal(helper.nodePath, null)
  assert.equal(helper.nodeOptions, null)
  assert.equal(helper.manifestTransport, 'synthetic fetch only; receipt and installer requests forbidden')
  const provisioning = input(options.packagedEvidence, 'provisioning-plan.json', 'packaged.provisioning')
  const publicProvisioning = input(options.releaseAssets, 'desktop-provisioning.json', 'candidate.provisioning')
  assert.equal(provisioning.sha256, publicProvisioning.sha256)
  assert.deepEqual(parseDesktopPluginProvisioningPlan(provisioning.value), plan.desktopProvisioning)
  const normalizedProvisioning = desktopPluginProvisioningPlanSha256(plan.desktopProvisioning)
  assert.deepEqual(artifacts.provisioning, { file: 'desktop-provisioning.json', sha256: provisioning.sha256, planSha256: normalizedProvisioning })
  const rawCapability = input(options.packagedEvidence, 'capability.json', 'packaged.capability')
  assert.deepEqual(parseDesktopManagedUpdateCapability(rawCapability.value), capability)
  assert.equal(rawCapability.sha256, artifacts.capabilitySha256)
  const runtime = input(options.packagedEvidence, 'desktop-runtime.json', 'packaged.runtime')
  assert.equal(runtime.sha256, manifest.installedEvidence.runtimeSha256)
  assert.equal(runtime.value.schemaVersion, 1)
  assert.equal(runtime.value.platform, 'win32')
  assert.equal(runtime.value.arch, 'x64')
  assert.equal(object(runtime.value.release).version, plan.upstreamVersion)
  const executable = input(options.packagedEvidence, 'executable.json', 'packaged.executable')
  keys(executable.value, ['file', 'sha256', 'productVersion', 'companyName', 'productName', 'fileDescription', 'signature'])
  assert.equal(executable.value.file, `${plan.identity.executableName}.exe`)
  assert.equal(executable.value.sha256, manifest.installedEvidence.executableSha256)
  assert.equal(executable.value.productName, plan.identity.productName)
  assert.equal(executable.value.fileDescription, plan.identity.productName)
  assert.equal(executable.value.signature, 'NotSigned')
  assert.equal(executable.value.productVersion, `${plan.version.split('-')[0]}.0`)

  absent(join(options.packagedEvidence, 'acceptance.json'))
  const functional = input(options.packagedEvidence, 'functional-results.json', 'packaged.functional')
  const failure = input(options.packagedEvidence, 'failure.json', 'packaged.failure')
  const observer = input(options.packagedEvidence, 'observer-cleanup.json', 'packaged.observer')
  const suite = input(options.packagedEvidence, 'packaged-suite.json', 'packaged.suite')
  const identity = { evidenceId: text(functional.value.evidenceId), sourceCommit: options.expectedSource, sourceTree: manifest.source.tree,
    runId: options.runId, runAttempt: options.runAttempt, planSha256: reviewed.sha256, runtimeSha256: runtime.sha256,
    executableSha256: executable.value.sha256, provisioningSha256: provisioning.sha256, capabilitySha256: rawCapability.sha256 }
  assert.match(identity.evidenceId, uuid)
  for (const record of [functional.value, failure.value, observer.value, suite.value]) {
    for (const field of identityKeys) assert.deepEqual(record[field], object(identity)[field], `Packaged identity differs: ${field}`)
  }
  assert.notEqual(physical(options.ordinaryEvidence), physical(options.packagedEvidence), 'Independent evidence directories are required')
  const ordinary = input(options.ordinaryEvidence, 'acceptance.json', 'ordinary.acceptance').value
  keys(ordinary, ['schemaVersion', 'scope', ...identityKeys, 'functionalAssertionsCompleted', 'normalAcceptanceCompleted', 'cleanupVerified',
    ...packagedTrue, ...packagedFalse, 'desktopVersion', 'runtimeVersion', 'versionMenus', 'plugin', 'transport', 'restartReceiptSha256', 'copilotUsageCapability', 'signedOutCopilotUsage', 'positiveCopilotUsage', 'positiveUsageHostTransport', 'hostQuotaNoNetworkEvidence', 'timeline'])
  assert.equal(ordinary.schemaVersion, 1)
  assert.equal(ordinary.scope, 'packaged-acceptance')
  assert.match(text(ordinary.evidenceId), uuid)
  for (const field of identityKeys.filter(field => field !== 'evidenceId')) {
    assert.deepEqual(ordinary[field], object(identity)[field], `Ordinary identity differs: ${field}`)
  }
  flags(ordinary, [...packagedTrue, 'functionalAssertionsCompleted', 'normalAcceptanceCompleted', 'cleanupVerified'], packagedFalse)
  for (const field of ['desktopVersion', 'runtimeVersion', 'plugin', 'transport', 'copilotUsageCapability', 'signedOutCopilotUsage', 'positiveCopilotUsage', 'positiveUsageHostTransport', 'hostQuotaNoNetworkEvidence']) {
    assert.deepEqual(ordinary[field], functional.value[field], `Ordinary business evidence differs: ${field}`)
  }
  const f = functional.value
  keys(f, ['schemaVersion', 'scope', ...identityKeys, 'functionalAssertionsCompleted', 'normalAcceptanceCompleted', 'cleanupVerified',
    ...packagedTrue, ...packagedFalse, 'desktopVersion', 'runtimeVersion', 'versionMenus', 'plugin', 'transport', 'restartReceiptSha256', 'copilotUsageCapability', 'signedOutCopilotUsage', 'positiveCopilotUsage', 'positiveUsageHostTransport', 'hostQuotaNoNetworkEvidence', 'timeline'])
  assert.equal(f.schemaVersion, 1)
  assert.equal(f.scope, 'packaged-functional-observations')
  flags(f, [...packagedTrue, 'functionalAssertionsCompleted'], [...packagedFalse, 'normalAcceptanceCompleted', 'cleanupVerified'])
  assert.equal(f.desktopVersion, plan.version)
  assert.equal(f.runtimeVersion, plan.upstreamVersion)
  const copilot = plan.desktopProvisioning.plugins.find(entry => entry.source.packageName === 'dsh-github-copilot')
  assert(copilot?.required, 'Reviewed plan must require Copilot')
  assert.deepEqual(f.plugin, copilot.source)
  assert.equal(f.transport, 'official Web-backed Desktop Host with packaged Electron dsh-app origin bridge')
  assert.equal(f.hostQuotaNoNetworkEvidence, 'immutable-plugin-ci-regression-only')
  const usageCapability = { id: 'account-quota-composer-usage', required: true, evidenceScope: 'synthetic-quota-and-public-remote-ui-contracts-not-live-account-access', signedOutNetworkRegressionDeclared: true, lifecycleRegressionDeclared: true }
  const signedOut = { usageTriggerCount: 0, accountUsageTextCount: 0, usageSurfaceAbsent: true, hostQuotaRequestInstrumentation: 'not-available-in-packaged-smoke' }
  assert.deepEqual(f.copilotUsageCapability, usageCapability)
  assert.deepEqual(f.signedOutCopilotUsage, [signedOut, signedOut])
  let installedClientSha256: string | undefined
  for (const [root, record, label] of [[options.ordinaryEvidence, ordinary, 'ordinary'], [options.packagedEvidence, f, 'packaged']] as const) {
    const positive = input(root, 'positive-usage.json', `${label}.positiveUsage`).value
    keys(positive, ['runtimeSha256', 'installedClientSha256', 'pluginSource', 'cases', 'originalSignedOutApplicationRestored', 'hostTransport'])
    assert.equal(positive.runtimeSha256, runtime.sha256)
    assert.deepEqual(positive.pluginSource, copilot.source)
    assert.match(text(positive.installedClientSha256), /^[a-f0-9]{64}$/u)
    // This is the observed installed client.js digest, not an independently verified archive-member digest.
    if (installedClientSha256 !== undefined) assert.equal(positive.installedClientSha256, installedClientSha256)
    installedClientSha256 = text(positive.installedClientSha256)
    flags(positive, ['originalSignedOutApplicationRestored'])
    assert.equal(positive.hostTransport, 'not-provided-to-isolated-fixture')
    assert.equal(record.positiveUsageHostTransport, positive.hostTransport)
    assert.deepEqual(positive.cases, record.positiveCopilotUsage)
    const cases = array(positive.cases)
    assert.equal(cases.length, 2)
    for (const [index, provider] of ['github-copilot', 'github-copilot-preview'].entries()) {
      const usage = object(cases[index])
      keys(usage, ['scope', 'provider', 'usageText', 'quotaReads', 'sessionSubscribed', 'removedSessionHidesUsage', 'otherProviderHidesUsage',
        'clientDisposalRemovesUsage', 'selectorErrors', 'forbiddenRemoteCalls', 'hostTransport', 'applicationMountPreserved', 'syntheticSiblingPreserved'])
      assert.equal(usage.scope, 'packaged-renderer-released-client-synthetic-session-and-quota')
      assert.equal(usage.provider, provider)
      assert.equal(usage.hostTransport, positive.hostTransport)
      assert.match(text(usage.usageText), /7 used/u)
      assert.equal(usage.quotaReads, 2)
      assert.equal(usage.selectorErrors, 0)
      assert.equal(usage.forbiddenRemoteCalls, 0)
      flags(usage, ['sessionSubscribed', 'removedSessionHidesUsage', 'otherProviderHidesUsage', 'clientDisposalRemovesUsage',
        'applicationMountPreserved', 'syntheticSiblingPreserved'])
    }
  }
  const menus = array(f.versionMenus)
  assert.equal(menus.length, 2)
  const phases = ['initial', 'restart']
  const events = ['launch', 'version-menu', 'application', 'account', 'usage-readonly', 'settings-readonly', 'packaged-graph']
  const expectedTimeline = ['package-identity', ...phases.flatMap(phase =>
    [...events, ...(phase === 'restart' ? ['positive-usage'] : []), 'closed'].map(event => `${phase}:${event}`))]
  // Canary runs last; its terminal timestamp also bounds the retained failure event below.
  let milliseconds = -1
  for (const record of [ordinary, f]) {
    milliseconds = -1
    const timeline = array(record.timeline).map((value) => {
      const event = object(value)
      keys(event, ['event', 'milliseconds'])
      assert(typeof event.milliseconds === 'number' && Number.isFinite(event.milliseconds) && event.milliseconds >= milliseconds)
      milliseconds = event.milliseconds
      return text(event.event)
    })
    assert.deepEqual(timeline.filter(event => !phases.some(phase => event === `${phase}:provider-deferred`)), expectedTimeline)
  }
  let previousGraph: RecordValue | undefined
  for (const [index, phase] of phases.entries()) {
    const menu = input(options.packagedEvidence, `${phase}-version-menu.json`, `packaged.${phase}.menu`).value
    assert.deepEqual(menu, menus[index])
    keys(menu, ['applicationMenuLabel', 'aboutMenuLabel', 'desktopVersion', 'windowId', 'popupCount', 'aboutDispatchCount', 'nativePopupOpened', 'nativeModalOpened'])
    assert(['Application', '应用'].includes(text(menu.applicationMenuLabel)))
    assert.equal(menu.aboutMenuLabel, `${menu.applicationMenuLabel === '应用' ? '关于' : 'About'} Desktop ${plan.version}…`)
    assert.equal(menu.desktopVersion, plan.version)
    assert(Number.isSafeInteger(menu.windowId) && Number(menu.windowId) > 0)
    assert.equal(menu.popupCount, 1)
    assert.equal(menu.aboutDispatchCount, 1)
    flags(menu, [], ['nativePopupOpened', 'nativeModalOpened'])
    const usage = input(options.packagedEvidence, `${phase}-usage-readonly.json`, `packaged.${phase}.usage`).value
    assert.deepEqual(usage, { capability: usageCapability, signedOut })
    settings(input(options.packagedEvidence, `${phase}-settings-readonly.json`, `packaged.${phase}.settings`).value)
    const graph = input(options.packagedEvidence, `${phase}-packaged-graph.json`, `packaged.${phase}.graph`).value
    keys(graph, ['valid', 'runtimeSha256', 'executable', 'nodeVersion', 'electronVersion', 'runAsNode', 'nodePath', 'nodeOptionsPresent', 'electronNoAsarPresent', 'cwd', 'profile', 'runtimeRoot', 'resolutionMode'])
    flags(graph, ['valid'], ['nodeOptionsPresent', 'electronNoAsarPresent'])
    assert.equal(graph.runtimeSha256, runtime.sha256)
    assert.equal(graph.nodePath, null)
    assert.equal(graph.runAsNode, '1')
    assert.equal(graph.resolutionMode, 'runtime')
    assert.equal(graph.nodeVersion, object(runtime.value.release).nodeVersion)
    assert.match(text(graph.electronVersion), /^\d+\.\d+\.\d+$/u)
    assert.equal(graph.cwd, graph.profile)
    assert.equal(win32.basename(text(graph.executable)), `${plan.identity.executableName}.exe`)
    assert.equal(win32.normalize(text(graph.runtimeRoot)), win32.join(win32.dirname(text(graph.executable)), 'resources', 'app.asar', 'dsh'))
    assert.equal(win32.basename(text(graph.profile)), 'desktop')
    if (previousGraph !== undefined) assert.deepEqual(graph, previousGraph)
    previousGraph = graph
    const store = input(options.packagedEvidence, `${phase}-desktop-plugin-receipts.json`, `packaged.${phase}.receipts`)
    assert.equal(store.sha256, f.restartReceiptSha256)
    keys(store.value, ['schemaVersion', 'receipts', 'owners'])
    assert.equal(store.value.schemaVersion, 1)
    const receipts = object(store.value.receipts)
    const owners = object(store.value.owners)
    const state = parseDesktopPluginProvisioningState(input(options.packagedEvidence, `${phase}-desktop-plugin-provisioning-state.json`, `packaged.${phase}.provisioning`).value)
    assert.equal(state.planSha256, normalizedProvisioning)
    assert.deepEqual(state.removed, [])
    assert.equal(state.plugins.length, plan.desktopProvisioning.plugins.length)
    const names = plan.desktopProvisioning.plugins.map(entry => entry.source.packageName)
    keys(receipts, names)
    keys(owners, names)
    const profile = input(options.packagedEvidence, `${phase}-package.json`, `packaged.${phase}.profile`).value
    const bundles = array(object(object(profile.dsh).profile).bundles)
    for (const entry of plan.desktopProvisioning.plugins) {
      const name = entry.source.packageName
      const pluginReceipt = parseDesktopPluginProvisionReceipt(receipts[name])
      assert.deepEqual(pluginReceipt.source, entry.source)
      assert.equal(owners[name], 'release')
      const result = state.plugins.find(item => item.name === name)
      assert(result)
      assert.equal(result.status, 'active')
      assert.equal(result.required, entry.required)
      assert.deepEqual(result.source, entry.source)
      assert.deepEqual(result.receipt, pluginReceipt)
      assert.equal(object(profile.dependencies)[name], `file:.desktop-plugin-artifacts/${entry.source.sha256}.tgz`)
      assert(bundles.includes(name))
    }
  }
  keys(failure.value, ['schemaVersion', 'scope', ...identityKeys, 'error', 'cleanupCompleted', 'cleanupVerified', 'cleanupErrors', 'diagnosticErrors'],
    ['visibleText', 'captureError', 'stderrTail', 'stderrTruncated', 'timeline', 'profileFilesPresentBeforeCleanup', 'realOAuth', 'realModelRound', 'realSearch', 'verificationNavigationExercised', 'manualVerificationAddressObserved'])
  for (const field of ['realOAuth', 'realModelRound', 'realSearch', 'verificationNavigationExercised', 'manualVerificationAddressObserved']) {
    if (Object.hasOwn(failure.value, field)) assert.equal(failure.value[field], false)
  }
  for (const field of ['visibleText', 'stderrTail']) if (Object.hasOwn(failure.value, field)) text(failure.value[field])
  if (Object.hasOwn(failure.value, 'stderrTruncated')) assert.equal(typeof failure.value.stderrTruncated, 'boolean')
  if (Object.hasOwn(failure.value, 'timeline')) {
    const failedTimeline = array(failure.value.timeline)
    assert.deepEqual(failedTimeline.slice(0, -1), f.timeline)
    const last = object(failedTimeline.at(-1))
    keys(last, ['event', 'milliseconds'])
    assert.equal(last.event, 'failure')
    assert(typeof last.milliseconds === 'number' && Number.isFinite(last.milliseconds) && last.milliseconds >= milliseconds)
  }
  if (Object.hasOwn(failure.value, 'profileFilesPresentBeforeCleanup')) {
    const beforeCleanup = object(failure.value.profileFilesPresentBeforeCleanup)
    keys(beforeCleanup, ['package.json', 'desktop-plugin-receipts.json', 'desktop-plugin-provisioning-state.json'])
    for (const present of Object.values(beforeCleanup)) assert.equal(typeof present, 'boolean')
  }
  assert.equal(failure.value.schemaVersion, 2)
  assert.equal(failure.value.scope, 'packaged-acceptance-failure')
  assert.match(text(failure.value.error),
    /^Error: packaged observer cleanup canary [a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u)
  flags(failure.value, ['cleanupCompleted', 'cleanupVerified'])
  assert.deepEqual(failure.value.cleanupErrors, [])
  assert.deepEqual(failure.value.diagnosticErrors, [])
  assert.equal(failure.value.captureError, undefined)
  keys(observer.value, ['schemaVersion', 'scope', ...identityKeys, 'observerInvokedOnce', 'errorPropagationVerified', 'ordinaryAcceptanceWithheld', 'cleanupVerified', 'ownedHomeRemoved', 'ownedProfileRemoved', 'ownedLegacySdkRemoved', 'normalAcceptanceCompleted', 'functionalSha256', 'failureSha256'])
  assert.equal(observer.value.schemaVersion, 3)
  assert.equal(observer.value.scope, 'unexpected-observer-failure-cleanup')
  flags(observer.value, ['observerInvokedOnce', 'errorPropagationVerified', 'ordinaryAcceptanceWithheld', 'cleanupVerified', 'ownedHomeRemoved', 'ownedProfileRemoved', 'ownedLegacySdkRemoved'], ['normalAcceptanceCompleted'])
  assert.equal(observer.value.functionalSha256, functional.sha256)
  assert.equal(observer.value.failureSha256, failure.sha256)
  keys(suite.value, ['schemaVersion', 'scope', ...identityKeys, 'functionalAssertionsCompleted', 'errorPropagationVerified', 'cleanupVerified', 'normalAcceptanceCompleted', 'receipts'])
  assert.equal(suite.value.schemaVersion, 1)
  assert.equal(suite.value.scope, 'packaged-functional-with-unexpected-observer-failure')
  flags(suite.value, ['functionalAssertionsCompleted', 'errorPropagationVerified', 'cleanupVerified'], ['normalAcceptanceCompleted'])
  assert.deepEqual(suite.value.receipts, { functional: { file: 'functional-results.json', sha256: functional.sha256 }, failure: { file: 'failure.json', sha256: failure.sha256 }, observer: { file: 'observer-cleanup.json', sha256: observer.sha256 } })

  const owner = input(options.upgradeRoot, 'owner.json', 'upgrade.owner').value
  keys(owner, ['token', 'runId', 'runAttempt'])
  assert.match(text(owner.token), uuid)
  assert.equal(owner.runId, options.runId)
  assert.equal(owner.runAttempt, options.runAttempt)
  const validated = input(options.upgradeRoot, 'validated.json', 'upgrade.validated').value
  keys(validated, ['ownerToken', 'previous', 'candidate'])
  assert.equal(validated.ownerToken, owner.token)
  for (const [key, actual] of [['previous', previous], ['candidate', candidate]] as const) {
    const bound = object(validated[key])
    keys(bound, ['manifest', 'installer', 'manifestPath', 'manifestFileSha256'])
    assert.deepEqual(bound.manifest, actual.manifest.value)
    assert.equal(bound.manifestFileSha256, actual.manifest.sha256)
    samePath(text(bound.manifestPath), actual.verified.manifestPath)
    samePath(text(bound.installer), actual.verified.installer)
  }
  const acquisition = input(options.baselineDirectory, 'acquisition.json', 'baseline.acquisition').value
  assert.deepEqual(acquisition, {
    schemaVersion: 1, releaseId: pinned.releaseId, immutable: true, tag: pinned.tag,
    sourceCommit: object(previous.manifest.value.source).commit,
    manifestSha256: previous.manifest.sha256, installerSha256: pinnedInstaller.sha256,
    receiptSha256: previous.receipt.sha256, installerExecuted: false,
  })
  const evidence = join(options.upgradeRoot, 'evidence')
  const upgrade = input(evidence, 'installer-upgrade.json', 'upgrade.result').value
  keys(upgrade, ['schemaVersion', 'sourceCommit', ...upgradeTrue, ...upgradeFalse, 'installationRoot', 'baselineProcessBinding', 'cleanupErrors', 'secondaryErrors', 'failure'])
  assert.equal(upgrade.schemaVersion, 1)
  assert.equal(upgrade.sourceCommit, options.expectedSource)
  flags(upgrade, upgradeTrue, upgradeFalse)
  assert.deepEqual(upgrade.cleanupErrors, [])
  assert.deepEqual(upgrade.secondaryErrors, [])
  assert.equal(upgrade.failure, null)
  samePath(text(upgrade.installationRoot), join(options.upgradeRoot, 'Installed App', plan.identity.packageName))
  const binding = object(upgrade.baselineProcessBinding)
  const bindingFlags = ['pathAvailable', 'providerNormalized', 'directParentMatches', 'basenameMatches', 'hashMatches']
  keys(binding, bindingFlags)
  flags(binding, bindingFlags)
  const retained = input(options.upgradeRoot, 'retained.json', 'upgrade.retained').value
  keys(retained, ['envSha256'])
  assert.equal(retained.envSha256, hash(`# Disposable installer-upgrade retained home: ${text(owner.token)}\n`))
  for (const round of ['baseline', 'candidate', 'candidate-restart']) {
    absent(join(evidence, `${round}-failure.json`))
    const result = input(evidence, `${round}.json`, `upgrade.${round}`).value
    const expected = round === 'baseline' ? previous.manifest.value : candidate.manifest.value
    const yes = ['actualInstalledApplication', 'sameRetainedHome', 'isolatedUserData']
    const no = ['pluginUserChoicesVerified', 'draftAttachmentRefusalVerified', 'realOAuth', 'realModelRound', 'managedHandoffVerified']
    keys(result, ['sourceCommit', 'version', 'executableSha256', 'runtimeSha256', ...yes, ...no, 'actualHostSettingsViews', 'retainedEnvSha256'])
    assert.equal(result.sourceCommit, object(expected.source).commit)
    assert.equal(result.version, expected.version)
    for (const field of ['executableSha256', 'runtimeSha256']) assert.equal(result[field], object(expected.installedEvidence)[field])
    assert.equal(result.retainedEnvSha256, retained.envSha256)
    flags(result, yes, no)
    settings(result.actualHostSettingsViews, round === 'baseline')
  }
  const cleanup = input(evidence, 'profile-cleanup.json', 'upgrade.cleanup').value
  const cleanupFlags = ['ownedHomeRemoved', 'ownedElectronDataRemoved', 'isolatedPackageAcceptanceDataRemoved']
  keys(cleanup, cleanupFlags)
  flags(cleanup, cleanupFlags)
  for (const directory of ['home', 'electron-user-data', 'package-home', 'package-electron-user-data', 'package-workspace', 'package-fixture-data']) absent(join(options.upgradeRoot, directory))
  const packages = input(evidence, 'package-acceptance.json', 'upgrade.packages').value
  keys(packages, ['schemaVersion', 'sourceCommit', 'scope', ...packageTrue, ...packageFalse, 'checkpoints', 'shellIncarnations', 'pageErrors', 'cleanupErrors', 'secondaryErrors'])
  assert.equal(packages.schemaVersion, 1)
  assert.equal(packages.sourceCommit, options.expectedSource)
  assert.equal(packages.scope, 'candidate-installed-desktop-same-version-isolated-home')
  flags(packages, packageTrue, packageFalse)
  for (const field of ['pageErrors', 'cleanupErrors', 'secondaryErrors']) assert.deepEqual(packages[field], [])
  const shells = array(packages.shellIncarnations)
  assert(shells.length > 0, 'Package acceptance must observe process cleanup')
  for (const value of shells) {
    const shell = object(value)
    flags(shell, ['launchReturned', 'bound', 'exited', 'launcherExited'])
    for (const field of ['pid', 'launcherPid']) assert(Number.isSafeInteger(shell[field]) && Number(shell[field]) > 0)
    assert.match(text(shell.launchId), uuid)
  }
  assert(array(packages.checkpoints).length > 0)
  return { schemaVersion: 1 as const, scope: 'ci-only-fork-qualification' as const, sourceCommit: options.expectedSource, sourceTree: manifest.source.tree,
    runId: options.runId, runAttempt: options.runAttempt, version: plan.version, sequence: plan.sequence, inputs,
    packagedFunctionalVerified: true, unexpectedObserverFailureCleanupVerified: true, actualInstalledUpgradeVerified: true,
    sameVersionPackageAcceptanceVerified: true, normalPackagedAcceptanceCompleted: true, canaryNormalAcceptanceCompleted: false,
    limits: { helperTransport: 'synthetic fetch only; receipt and installer requests forbidden', liveHandoff: false,
      menuObservation: 'intercepted-model-and-dispatch-not-native-popup-or-modal', realOAuth: false, realModelRound: false, realSearch: false, liveAccountQuota: false,
      choicesAcrossInstallerUpgradeVerified: false, promotionFailureRollbackVerified: false,
      managedHandoffVerified: false, postSuccessDowngradeVerified: false } }
}

/**
 * Check workflow-owned packaged paths and observe removal, without opening the executable or ASAR interior.
 * @param checkout - Actual checkout root selected by the CLI, or an inert temporary root in path tests.
 * @param graph - Original packaged graph observations already verified by the qualification API.
 * @returns Nothing; rejects noncanonical paths or any surviving packaged home/profile.
 */
export function assertPackagedQualificationPaths(checkout: string, graph: RecordValue): void {
  samePath(text(graph.executable), join(checkout, 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/cloga-deepseek-harness.exe'))
  const profile = relative(join(checkout, '.desktop-smoke'), text(graph.profile)).split(sep)
  assert.equal(profile.length, 3)
  assert.match(profile[0]!, /^packaged-copilot-[A-Za-z0-9]+$/u)
  assert.deepEqual(profile.slice(1), ['profiles', 'desktop'])
  const home = join(checkout, '.desktop-smoke', profile[0]!)
  absent(join(home, 'profiles', 'desktop'))
  absent(home)
}

/**
 * Run only at the canonical workflow paths, binding checkout HEAD/tree to GitHub's exact run identity.
 * @returns Nothing; writes a fresh qualification.json outside the six public assets after complete verification.
 */
export function runForkQualificationCli(): void {
  const names = ['plan', 'release-assets', 'ordinary-evidence', 'packaged-evidence', 'upgrade-root', 'baseline-directory', 'expected-source', 'run-id', 'run-attempt', 'output']
  const { values } = parseArgs({ options: Object.fromEntries(names.map(name => [name, { type: 'string' as const }])), allowPositionals: false })
  for (const name of names) assert(typeof values[name] === 'string' && values[name] !== '', `Required --${name}`)
  assert.equal(process.env.GITHUB_ACTIONS, 'true')
  assert.equal(process.env.RUNNER_ENVIRONMENT, 'github-hosted')
  assert.equal(process.env.RUNNER_OS, 'Windows')
  assert.equal(process.platform, 'win32')
  samePath(text(process.env.GITHUB_WORKSPACE), repository)
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  const tree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repository, encoding: 'utf8' }).trim()
  assert.match(source, /^[a-f0-9]{40}$/u)
  assert.match(tree, /^[a-f0-9]{40}$/u)
  assert.equal(source, process.env.GITHUB_SHA, 'Checkout HEAD differs from GITHUB_SHA')
  assert.equal(values['expected-source'], source, 'Expected source differs from checkout HEAD')
  const runId = text(process.env.GITHUB_RUN_ID)
  const runAttempt = text(process.env.GITHUB_RUN_ATTEMPT)
  assert.match(runId, /^[1-9]\d*$/u)
  assert.match(runAttempt, /^[1-9]\d*$/u)
  const temporary = physical(text(process.env.RUNNER_TEMP))
  const releaseAssets = join(repository, 'dist/desktop-fork-release')
  const outputDirectory = physical(join(repository, 'dist/desktop-fork-qualification'))
  const output = physical(text(values.output))
  const suffix = relative(physical(releaseAssets), output)
  assert(suffix.startsWith(`..${sep}`) || isAbsolute(suffix), 'Qualification output must be outside release assets')
  const options = { planPath: join(repository, 'apps/desktop/release/cloga-windows-x64.json'), releaseAssets,
    ordinaryEvidence: join(repository, 'dist/desktop-copilot-acceptance'),
    packagedEvidence: join(repository, 'dist/desktop-copilot-observer-canary'), upgradeRoot: join(temporary, `cloga-installer-upgrade-${runId}-${runAttempt}`),
    baselineDirectory: join(temporary, `desktop-upgrade-baseline-${runId}-${runAttempt}`), expectedSource: source, runId, runAttempt }
  for (const [argument, canonical] of [['plan', options.planPath], ['release-assets', releaseAssets], ['ordinary-evidence', options.ordinaryEvidence], ['packaged-evidence', options.packagedEvidence],
    ['upgrade-root', options.upgradeRoot], ['baseline-directory', options.baselineDirectory], ['output', join(outputDirectory, 'qualification.json')]]) samePath(text(values[argument!]), canonical!)
  assert.equal(values['run-id'], runId)
  assert.equal(values['run-attempt'], runAttempt)
  absent(output)
  const summary = verifyForkQualification(options)
  assert.equal(summary.sourceTree, tree, 'Checkout tree differs from release evidence')
  const graph = read(join(options.packagedEvidence, 'initial-packaged-graph.json')).value
  assertPackagedQualificationPaths(repository, graph)
  mkdirSync(outputDirectory, { recursive: true })
  physical(outputDirectory)
  writeFileSync(output, `${JSON.stringify(summary, undefined, 2)}\n`, { flag: 'wx' })
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === import.meta.filename) runForkQualificationCli()
