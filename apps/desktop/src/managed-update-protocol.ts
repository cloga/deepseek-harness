/** Validated metadata exchanged by the Electron shell and the detached Windows updater. */

import { createHash } from 'node:crypto'
import { isAbsolute, win32 } from 'node:path'
import {
  parseDesktopPluginSource,
  type DesktopGithubReleasePluginSource,
} from './plugin-source.ts'

const SOURCE_REPOSITORY = 'cloga/deepseek-harness'
const LEGACY_REPOSITORY = 'cloga/dsh-windows-ops'
// oxlint-disable-next-line @stylistic/max-len -- Keep the complete SemVer grammar as one auditable literal.
const SEMVER = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:0|[1-9]\d*|(?:\d*[A-Za-z-][0-9A-Za-z-]*))(?:\.(?:0|[1-9]\d*|(?:\d*[A-Za-z-][0-9A-Za-z-]*)))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u
const SHA256 = /^[a-f0-9]{64}$/u
const SHA512_BASE64 = /^[A-Za-z0-9+/]{86}==$/u
const COMMIT = /^[a-f0-9]{40}$/u
const FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u
const TOKEN = /^[a-f0-9]{64}$/u

function legacyAcknowledgementField(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'boolean') return String(value).toLowerCase()
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  throw new Error('desktop managed update: legacy acknowledgement field must be scalar')
}

/** Immutable local selection of one source-owned release manifest. */
export interface DesktopManagedUpdateCapability {
  readonly schemaVersion: 1
  readonly mode: 'windows-ops-managed'
  readonly manifestUrl: string
  readonly manifestSha256: string
  readonly minimumSequence: number
  readonly expectedSource: {
    readonly version: string
    readonly commit: string
  }
  readonly migration?: {
    readonly owner: typeof LEGACY_REPOSITORY
    readonly manifestUrl: string
    readonly manifestSha256: string
    readonly maximumSequence: 1
    readonly expectedSource: {
      readonly version: string
      readonly commit: string
    }
  }
}

/** Source identity and installation evidence published with one Desktop release. */
export interface DesktopManagedUpdateManifest {
  readonly schemaVersion: 2
  readonly owner: typeof SOURCE_REPOSITORY
  readonly mode: 'interactive-windows-installer'
  readonly version: string
  readonly sequence: number
  readonly source: {
    readonly repository: typeof SOURCE_REPOSITORY
    readonly commit: string
    readonly tag: string
  }
  readonly installer: {
    readonly file: string
    readonly bytes: number
    readonly sha256: string
    readonly sha512: string
    readonly signature: 'NotSigned'
  }
  readonly buildReceipt: {
    readonly file: string
    readonly sha256: string
    readonly receiptSha256: string
  }
  readonly installedEvidence: {
    readonly executableSha256: string
    readonly runtimeSha256: string
  }
  readonly pluginProvisioning: {
    readonly capability: 'verified-github-release'
    readonly source: DesktopGithubReleasePluginSource
    readonly receiptSha256: string
  }
  readonly manifestSha256: string
}

/** Legacy Windows Ops manifest accepted only by an explicit one-time migration capability. */
export interface DesktopLegacyManagedUpdateManifest {
  readonly schemaVersion: 1
  readonly owner: typeof LEGACY_REPOSITORY
  readonly mode: 'unsigned-manual'
  readonly channelVersion: string
  readonly upstreamVersion: string
  readonly sequence: 1
  readonly feedBaseUrl: string
  readonly installer: {
    readonly file: string
    readonly size: number
    readonly sha256: string
    readonly sha512: string
    readonly signature: 'NotSigned'
  }
  readonly buildReceipt: {
    readonly file: string
    readonly sha256: string
    readonly receiptSha256: string
  }
  readonly installedEvidence: {
    readonly executableSha256: string
    readonly seedSha256: string
  }
  readonly manifestSha256: string
}

/** Manifest accepted for the current source-owned stream or its single legacy migration. */
export type DesktopAcceptedManagedUpdateManifest =
  | DesktopManagedUpdateManifest
  | DesktopLegacyManagedUpdateManifest

/** One-time request claimed by the detached helper before Desktop exits. */
export interface DesktopManagedUpdateHandoff {
  readonly schemaVersion: 1
  readonly token: string
  readonly capability: DesktopManagedUpdateCapability
  readonly selectedManifest: 'source' | 'migration'
  readonly stageRoot: string
  readonly waitPids: readonly number[]
  readonly waitTimeoutMs: number
  readonly installedSequence: number
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`desktop managed update: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort()
  const expected = [...keys].sort()
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new Error(`desktop managed update: ${label} has unsupported fields`)
  }
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value === '') {
    throw new Error(`desktop managed update: ${label} must be a non-empty string`)
  }
  return value
}

function integer(value: unknown, label: string, maximum = 2_147_483_647): number {
  if (!Number.isSafeInteger(value) || typeof value !== 'number' || value < 0 || value > maximum) {
    throw new Error(`desktop managed update: ${label} must be an allowed integer`)
  }
  return value
}

function hash(value: unknown, label: string): string {
  const result = string(value, label)
  if (!SHA256.test(result)) throw new Error(`desktop managed update: ${label} must be lowercase SHA-256`)
  return result
}

function assetFile(value: unknown, label: string): string {
  const result = string(value, label)
  if (!FILE.test(result) || win32.basename(result) !== result) {
    throw new Error(`desktop managed update: ${label} must be a plain filename`)
  }
  return result
}

function githubReleaseManifestUrl(value: unknown, repository: string, label: string): string {
  const text = string(value, label)
  let url: URL
  try {
    url = new URL(text)
  } catch {
    throw new Error(`desktop managed update: ${label} must be an absolute URL`)
  }
  const prefix = `/${repository}/releases/download/`
  if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '' || !url.pathname.startsWith(prefix)
    || !url.pathname.endsWith('/release.json') || url.pathname.slice(prefix.length, -'/release.json'.length) === '') {
    throw new Error(`desktop managed update: ${label} must be an immutable ${repository} release manifest`)
  }
  return url.href
}

function canonical(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('desktop managed update: canonical JSON rejects non-finite numbers')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  const object = record(value, 'canonical JSON value')
  return `{${Object.keys(object).sort().map(key => `${JSON.stringify(key)}:${canonical(object[key])}`).join(',')}}`
}

/** Compute the lowercase SHA-256 of recursively key-sorted JSON. */
export function managedUpdateJsonSha256(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex')
}

/** Compute the acknowledgement hash used by the one supported Windows Ops migration manifest. */
export function legacyManagedUpdateManifestSha256(value: unknown): string {
  const item = record(value, 'legacy manifest hash input')
  const installer = record(item.installer, 'legacy manifest.installer')
  const buildReceipt = record(item.buildReceipt, 'legacy manifest.buildReceipt')
  const evidence = record(item.installedEvidence, 'legacy manifest.installedEvidence')
  const security = record(item.security, 'legacy manifest.security')
  const fields = [
    item.schemaVersion, item.owner, item.mode, item.channel, item.channelVersion, item.upstreamVersion, item.sequence,
    item.createdUtc, item.feedBaseUrl, item.feedFile,
    installer.file, installer.size, installer.sha256, installer.sha512, installer.signature,
    buildReceipt.file, buildReceipt.sha256, buildReceipt.receiptSha256,
    evidence.executableSha256, evidence.seedSha256,
    security.nativeUpdaterEnabled, security.appUpdateYmlPresent, security.signatureRequiredForNativeUpdater,
    security.applyMode, security.publication,
  ].map(legacyAcknowledgementField)
  const payload = fields.map(field => `${Buffer.byteLength(field, 'utf8')}:${field}`).join('\n')
  return createHash('sha256').update(payload).digest('hex')
}

function verifySelfHash(value: Record<string, unknown>, expected: string): void {
  const payload = { ...value }
  delete payload.manifestSha256
  if (managedUpdateJsonSha256(payload) !== expected) {
    throw new Error('desktop managed update: manifest self-hash does not match')
  }
}

/** Parse the local capability without accepting user-selected repositories or mutable release aliases. */
export function parseDesktopManagedUpdateCapability(value: unknown): DesktopManagedUpdateCapability {
  const item = record(value, 'capability')
  exactKeys(item, ['schemaVersion', 'mode', 'manifestUrl', 'manifestSha256', 'minimumSequence', 'expectedSource',
    ...(item.migration === undefined ? [] : ['migration'])], 'capability')
  if (item.schemaVersion !== 1 || item.mode !== 'windows-ops-managed') {
    throw new Error('desktop managed update: unsupported capability identity')
  }
  const expectedSourceValue = record(item.expectedSource, 'capability.expectedSource')
  exactKeys(expectedSourceValue, ['version', 'commit'], 'capability.expectedSource')
  const expectedVersion = string(expectedSourceValue.version, 'capability.expectedSource.version')
  if (!SEMVER.test(expectedVersion) || typeof expectedSourceValue.commit !== 'string'
    || !COMMIT.test(expectedSourceValue.commit)) {
    throw new Error('desktop managed update: capability expected source is invalid')
  }
  const migrationValue = item.migration
  let migration: DesktopManagedUpdateCapability['migration']
  if (migrationValue !== undefined) {
    const legacy = record(migrationValue, 'capability.migration')
    exactKeys(legacy, ['owner', 'manifestUrl', 'manifestSha256', 'maximumSequence', 'expectedSource'], 'capability.migration')
    if (legacy.owner !== LEGACY_REPOSITORY || legacy.maximumSequence !== 1) {
      throw new Error('desktop managed update: unsupported migration capability')
    }
    const legacySource = record(legacy.expectedSource, 'capability.migration.expectedSource')
    exactKeys(legacySource, ['version', 'commit'], 'capability.migration.expectedSource')
    const legacyVersion = string(legacySource.version, 'capability.migration.expectedSource.version')
    if (!SEMVER.test(legacyVersion) || typeof legacySource.commit !== 'string' || !COMMIT.test(legacySource.commit)) {
      throw new Error('desktop managed update: capability migration source is invalid')
    }
    migration = {
      owner: LEGACY_REPOSITORY,
      manifestUrl: githubReleaseManifestUrl(legacy.manifestUrl, LEGACY_REPOSITORY, 'capability.migration.manifestUrl'),
      manifestSha256: hash(legacy.manifestSha256, 'capability.migration.manifestSha256'),
      maximumSequence: 1,
      expectedSource: { version: legacyVersion, commit: legacySource.commit },
    }
  }
  const manifestUrl = githubReleaseManifestUrl(item.manifestUrl, SOURCE_REPOSITORY, 'capability.manifestUrl')
  if (new URL(manifestUrl).pathname
    !== `/${SOURCE_REPOSITORY}/releases/download/dsh-v${expectedVersion}/release.json`) {
    throw new Error('desktop managed update: source manifest URL does not match the expected version')
  }
  return {
    schemaVersion: 1,
    mode: 'windows-ops-managed',
    manifestUrl,
    manifestSha256: hash(item.manifestSha256, 'capability.manifestSha256'),
    minimumSequence: integer(item.minimumSequence, 'capability.minimumSequence'),
    expectedSource: { version: expectedVersion, commit: expectedSourceValue.commit },
    ...(migration === undefined ? {} : { migration }),
  }
}

function parseSourceManifest(item: Record<string, unknown>): DesktopManagedUpdateManifest {
  exactKeys(item, ['schemaVersion', 'owner', 'mode', 'version', 'sequence', 'source', 'installer', 'buildReceipt',
    'installedEvidence', 'pluginProvisioning', 'manifestSha256'], 'manifest')
  if (item.schemaVersion !== 2 || item.owner !== SOURCE_REPOSITORY || item.mode !== 'interactive-windows-installer') {
    throw new Error('desktop managed update: unsupported source manifest identity')
  }
  const version = string(item.version, 'manifest.version')
  if (!SEMVER.test(version)) throw new Error('desktop managed update: manifest.version must be semantic')
  const source = record(item.source, 'manifest.source')
  exactKeys(source, ['repository', 'commit', 'tag'], 'manifest.source')
  if (source.repository !== SOURCE_REPOSITORY || typeof source.commit !== 'string' || !COMMIT.test(source.commit)) {
    throw new Error('desktop managed update: manifest source identity is invalid')
  }
  const installer = record(item.installer, 'manifest.installer')
  exactKeys(installer, ['file', 'bytes', 'sha256', 'sha512', 'signature'], 'manifest.installer')
  if (typeof installer.sha512 !== 'string' || !SHA512_BASE64.test(installer.sha512)
    || installer.signature !== 'NotSigned') {
    throw new Error('desktop managed update: installer evidence is invalid')
  }
  const evidence = record(item.installedEvidence, 'manifest.installedEvidence')
  exactKeys(evidence, ['executableSha256', 'runtimeSha256'], 'manifest.installedEvidence')
  const buildReceipt = record(item.buildReceipt, 'manifest.buildReceipt')
  exactKeys(buildReceipt, ['file', 'sha256', 'receiptSha256'], 'manifest.buildReceipt')
  const provisioning = record(item.pluginProvisioning, 'manifest.pluginProvisioning')
  exactKeys(provisioning, ['capability', 'source', 'receiptSha256'], 'manifest.pluginProvisioning')
  if (provisioning.capability !== 'verified-github-release') {
    throw new Error('desktop managed update: unsupported plugin provisioning capability')
  }
  const pluginSource = parseDesktopPluginSource(provisioning.source)
  if (pluginSource.type !== 'githubRelease') {
    throw new Error('desktop managed update: plugin provisioning requires a verified GitHub release')
  }
  const manifestSha256 = hash(item.manifestSha256, 'manifest.manifestSha256')
  verifySelfHash(item, manifestSha256)
  const sequence = integer(item.sequence, 'manifest.sequence')
  const bytes = integer(installer.bytes, 'manifest.installer.bytes', Number.MAX_SAFE_INTEGER)
  if (sequence < 1 || bytes < 1) throw new Error('desktop managed update: manifest sequence and installer bytes must be positive')
  return {
    schemaVersion: 2,
    owner: SOURCE_REPOSITORY,
    mode: 'interactive-windows-installer',
    version,
    sequence,
    source: {
      repository: SOURCE_REPOSITORY,
      commit: source.commit,
      tag: string(source.tag, 'manifest.source.tag'),
    },
    installer: {
      file: assetFile(installer.file, 'manifest.installer.file'),
      bytes,
      sha256: hash(installer.sha256, 'manifest.installer.sha256'),
      sha512: installer.sha512,
      signature: installer.signature,
    },
    buildReceipt: {
      file: assetFile(buildReceipt.file, 'manifest.buildReceipt.file'),
      sha256: hash(buildReceipt.sha256, 'manifest.buildReceipt.sha256'),
      receiptSha256: hash(buildReceipt.receiptSha256, 'manifest.buildReceipt.receiptSha256'),
    },
    installedEvidence: {
      executableSha256: hash(evidence.executableSha256, 'manifest.installedEvidence.executableSha256'),
      runtimeSha256: hash(evidence.runtimeSha256, 'manifest.installedEvidence.runtimeSha256'),
    },
    pluginProvisioning: {
      capability: 'verified-github-release',
      source: pluginSource,
      receiptSha256: hash(provisioning.receiptSha256, 'manifest.pluginProvisioning.receiptSha256'),
    },
    manifestSha256,
  }
}

function parseLegacyManifest(item: Record<string, unknown>): DesktopLegacyManagedUpdateManifest {
  const required = ['schemaVersion', 'owner', 'mode', 'channel', 'channelVersion', 'upstreamVersion', 'sequence', 'createdUtc',
    'feedBaseUrl', 'feedFile', 'installer', 'buildReceipt', 'installedEvidence', 'security', 'manifestSha256']
  exactKeys(item, required, 'legacy manifest')
  if (item.schemaVersion !== 1 || item.owner !== LEGACY_REPOSITORY || item.mode !== 'unsigned-manual' || item.sequence !== 1) {
    throw new Error('desktop managed update: unsupported legacy manifest identity')
  }
  const installer = record(item.installer, 'legacy manifest.installer')
  exactKeys(installer, ['file', 'size', 'sha256', 'sha512', 'signature'], 'legacy manifest.installer')
  const buildReceipt = record(item.buildReceipt, 'legacy manifest.buildReceipt')
  exactKeys(buildReceipt, ['file', 'sha256', 'receiptSha256'], 'legacy manifest.buildReceipt')
  const evidence = record(item.installedEvidence, 'legacy manifest.installedEvidence')
  exactKeys(evidence, ['executableSha256', 'seedSha256'], 'legacy manifest.installedEvidence')
  const security = record(item.security, 'legacy manifest.security')
  exactKeys(security, ['nativeUpdaterEnabled', 'appUpdateYmlPresent', 'signatureRequiredForNativeUpdater', 'applyMode', 'publication'], 'legacy manifest.security')
  if (installer.signature !== 'NotSigned' || typeof installer.sha512 !== 'string' || !SHA512_BASE64.test(installer.sha512)) {
    throw new Error('desktop managed update: legacy installer evidence is invalid')
  }
  const manifestSha256 = hash(item.manifestSha256, 'legacy manifest.manifestSha256')
  if (legacyManagedUpdateManifestSha256(item) !== manifestSha256) {
    throw new Error('desktop managed update: legacy manifest self-hash does not match')
  }
  const size = integer(installer.size, 'legacy manifest.installer.size', Number.MAX_SAFE_INTEGER)
  if (size < 1) throw new Error('desktop managed update: legacy installer size must be positive')
  return {
    schemaVersion: 1,
    owner: LEGACY_REPOSITORY,
    mode: 'unsigned-manual',
    channelVersion: string(item.channelVersion, 'legacy manifest.channelVersion'),
    upstreamVersion: string(item.upstreamVersion, 'legacy manifest.upstreamVersion'),
    sequence: 1,
    feedBaseUrl: string(item.feedBaseUrl, 'legacy manifest.feedBaseUrl'),
    installer: {
      file: assetFile(installer.file, 'legacy manifest.installer.file'),
      size,
      sha256: hash(installer.sha256, 'legacy manifest.installer.sha256'),
      sha512: installer.sha512,
      signature: 'NotSigned',
    },
    buildReceipt: {
      file: assetFile(buildReceipt.file, 'legacy manifest.buildReceipt.file'),
      sha256: hash(buildReceipt.sha256, 'legacy manifest.buildReceipt.sha256'),
      receiptSha256: hash(buildReceipt.receiptSha256, 'legacy manifest.buildReceipt.receiptSha256'),
    },
    installedEvidence: {
      executableSha256: hash(evidence.executableSha256, 'legacy manifest.installedEvidence.executableSha256'),
      seedSha256: hash(evidence.seedSha256, 'legacy manifest.installedEvidence.seedSha256'),
    },
    manifestSha256,
  }
}

/** Parse exactly the capability-selected source manifest or the unconsumed legacy migration. */
export function parseDesktopManagedUpdateManifest(
  value: unknown,
  capability: DesktopManagedUpdateCapability,
  installedSequence: number,
  allowInstalledSequence = false,
): DesktopAcceptedManagedUpdateManifest {
  const item = record(value, 'manifest')
  const owner = item.owner
  const parsed = owner === SOURCE_REPOSITORY ? parseSourceManifest(item) : parseLegacyManifest(item)
  const selectedHash = parsed.owner === SOURCE_REPOSITORY
    ? capability.manifestSha256
    : capability.migration?.manifestSha256
  if (selectedHash === undefined || parsed.manifestSha256 !== selectedHash) {
    throw new Error('desktop managed update: manifest is not selected by the local capability')
  }
  if (parsed.owner === SOURCE_REPOSITORY) {
    const releaseTag = decodeURIComponent(
      new URL(capability.manifestUrl).pathname.slice(
        `/${SOURCE_REPOSITORY}/releases/download/`.length,
        -'/release.json'.length,
      ),
    )
    if (parsed.version !== capability.expectedSource.version
      || parsed.source.commit !== capability.expectedSource.commit
      || parsed.source.tag !== `dsh-v${parsed.version}`
      || parsed.source.tag !== releaseTag) {
      throw new Error('desktop managed update: manifest source does not match the local capability')
    }
  } else {
    if (capability.migration === undefined || parsed.upstreamVersion !== capability.migration.expectedSource.version
      || parsed.feedBaseUrl !== new URL('.', capability.migration.manifestUrl).href) {
      throw new Error('desktop managed update: legacy manifest source does not match the migration capability')
    }
  }
  if (parsed.sequence < installedSequence
    || (!allowInstalledSequence && parsed.sequence === installedSequence)
    || parsed.sequence < capability.minimumSequence) {
    throw new Error('desktop managed update: manifest sequence does not advance the installed release')
  }
  const migrationMaximumSequence = capability.migration?.maximumSequence ?? 0
  if (parsed.owner === LEGACY_REPOSITORY
    && (installedSequence !== 0 || parsed.sequence > migrationMaximumSequence)) {
    throw new Error('desktop managed update: legacy migration has already been consumed')
  }
  return parsed
}

/** Resolve an asset beside the immutable manifest without accepting manifest-provided origins or paths. */
export function managedUpdateAssetUrl(manifestUrl: string, file: string): string {
  const url = new URL(manifestUrl)
  url.pathname = `${url.pathname.slice(0, url.pathname.lastIndexOf('/') + 1)}${assetFile(file, 'asset file')}`
  return url.href
}

/** Restrict manual HTTP redirects to GitHub's release download service. */
export function assertManagedUpdateRedirect(from: string, to: string): void {
  const source = new URL(from)
  const target = new URL(to, source)
  if (target.protocol !== 'https:' || target.username !== '' || target.password !== '') {
    throw new Error('desktop managed update: redirect must remain credential-free HTTPS')
  }
  if (source.hostname === 'github.com') {
    if (!['github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(target.hostname)) {
      throw new Error('desktop managed update: GitHub release redirected to an unsupported host')
    }
    return
  }
  if (target.hostname !== source.hostname) {
    throw new Error('desktop managed update: asset redirect changed host')
  }
}

/** Parse helper input written only by the Electron main process. */
export function parseDesktopManagedUpdateHandoff(value: unknown): DesktopManagedUpdateHandoff {
  const item = record(value, 'handoff')
  exactKeys(item, ['schemaVersion', 'token', 'capability', 'selectedManifest', 'stageRoot', 'waitPids',
    'waitTimeoutMs', 'installedSequence'], 'handoff')
  if (item.schemaVersion !== 1 || typeof item.token !== 'string' || !TOKEN.test(item.token)) {
    throw new Error('desktop managed update: invalid handoff identity')
  }
  const stageRoot = string(item.stageRoot, 'handoff.stageRoot')
  if (!isAbsolute(stageRoot)) {
    throw new Error('desktop managed update: handoff.stageRoot must be absolute')
  }
  if (!Array.isArray(item.waitPids) || item.waitPids.length < 1 || item.waitPids.length > 8
    || item.waitPids.some(pid => !Number.isSafeInteger(pid) || typeof pid !== 'number' || pid < 1)) {
    throw new Error('desktop managed update: handoff.waitPids must contain targeted process ids')
  }
  const capability = parseDesktopManagedUpdateCapability(item.capability)
  if (item.selectedManifest !== 'source' && item.selectedManifest !== 'migration') {
    throw new Error('desktop managed update: handoff.selectedManifest is invalid')
  }
  if (item.selectedManifest === 'migration' && capability.migration === undefined) {
    throw new Error('desktop managed update: handoff selected an unavailable migration')
  }
  return {
    schemaVersion: 1,
    token: item.token,
    capability,
    selectedManifest: item.selectedManifest,
    stageRoot,
    waitPids: [...new Set(item.waitPids as number[])],
    waitTimeoutMs: integer(item.waitTimeoutMs, 'handoff.waitTimeoutMs', 120_000),
    installedSequence: integer(item.installedSequence, 'handoff.installedSequence'),
  }
}
