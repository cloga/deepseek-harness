/** Verified package sources and attestation for Desktop-managed plugins. */

import { createHash } from 'node:crypto'
import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
} from 'node:fs'
import { join, posix } from 'node:path'
import { valid } from 'semver'
import { t, x, type ReadEntry } from 'tar'
import {
  readDesktopGithubReleaseJson,
  requestDesktopGithubRelease,
  resolveDesktopGithubTagCommit,
} from './github-release.ts'

/** Structured plugin source schema accepted by Desktop. */
export const DESKTOP_PLUGIN_SOURCE_SCHEMA_VERSION = 1 as const

/** Attestation schema written after a verified package transaction. */
export const DESKTOP_PLUGIN_RECEIPT_SCHEMA_VERSION = 1 as const

/** Native verified-release capability consumed by Desktop release automation. */
export const DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY = {
  id: 'desktopNativeVerifiedRelease',
  schemaVersion: 1,
  sourceSchemaVersion: DESKTOP_PLUGIN_SOURCE_SCHEMA_VERSION,
  receiptSchemaVersion: DESKTOP_PLUGIN_RECEIPT_SCHEMA_VERSION,
} as const

/** Existing npm registry source represented without accepting alternate npm spec transports. */
export interface DesktopNpmRegistryPluginSource {
  readonly schemaVersion: typeof DESKTOP_PLUGIN_SOURCE_SCHEMA_VERSION
  readonly type: 'npmRegistry'
  readonly spec: string
}

/** General package input; source snapshots are not verified Release attestations. */
export interface DesktopPackageSpecPluginSource {
  readonly schemaVersion: typeof DESKTOP_PLUGIN_SOURCE_SCHEMA_VERSION
  readonly type: 'packageSpec'
  readonly spec: string
}

/** Immutable GitHub Release asset and dependency-registry lock. */
export interface DesktopGithubReleasePluginSource {
  readonly schemaVersion: typeof DESKTOP_PLUGIN_SOURCE_SCHEMA_VERSION
  readonly type: 'githubRelease'
  readonly owner: string
  readonly repo: string
  readonly tag: string
  readonly asset: string
  readonly assetId: number
  readonly packageName: string
  readonly version: string
  readonly size: number
  readonly sha256: string
  readonly integrity?: string
  readonly targetCommit: string
  readonly dependencyRegistry?: string
  readonly checksumManifest?: {
    readonly format: 'sha256sums'
    readonly asset: string
    readonly assetId: number
    readonly url: string
    readonly size: number
    readonly sha256: string
    readonly integrity?: string
  }
}

/** Supported Desktop plugin package sources. */
export type DesktopPluginSource = DesktopNpmRegistryPluginSource | DesktopGithubReleasePluginSource | DesktopPackageSpecPluginSource

/** GitHub facts and local artifact identity established before package installation. */
export interface DesktopVerifiedPluginArtifact {
  readonly source: DesktopGithubReleasePluginSource
  readonly path: string
  readonly releaseId: number
  readonly assetId: number
  readonly packageName: string
  readonly version: string
}

/** Durable result of one native verified-release transaction. */
export interface DesktopPluginProvisionReceipt {
  readonly schemaVersion: typeof DESKTOP_PLUGIN_RECEIPT_SCHEMA_VERSION
  readonly capability: typeof DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY
  readonly source: DesktopGithubReleasePluginSource
  readonly releaseId: number
  readonly assetId: number
  readonly packageName: string
  readonly version: string
  readonly artifactSha256: string
  readonly states: {
    readonly staged: true
    readonly health: 'passed'
    readonly activated: true
    readonly rolledBack: false
    readonly verified: true
  }
}

const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/u
const REPO_PATTERN = /^[A-Za-z0-9._-]+$/u
const RELEASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/u
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u
const SHA256_PATTERN = /^[a-f0-9]{64}$/u
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u
const MAX_RELEASE_ASSET_BYTES = 64 * 1024 * 1024
const API_HOST = 'api.github.com'
const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare'] as const

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function assertKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const accepted = new Set(allowed)
  const unexpected = Object.keys(value).find(key => !accepted.has(key))
  if (unexpected !== undefined) throw new Error(`desktop plugin source: unexpected field ${unexpected}`)
}

function assertString(value: unknown, field: string, pattern?: RegExp): asserts value is string {
  if (typeof value !== 'string' || value === '' || (pattern !== undefined && !pattern.test(value))) {
    throw new Error(`desktop plugin source: invalid ${field}`)
  }
}

function assertSafeRegistry(value: string): void {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') {
    throw new Error('desktop plugin source: dependency registry must be an HTTPS origin without credentials')
  }
}

function assertPositiveInteger(value: unknown, field: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw new Error(`desktop plugin source: invalid ${field}`)
  }
}

function parseIntegrity(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined
  assertString(value, field)
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(value)) {
    throw new Error(`desktop plugin source: ${field} must be SHA-512 SRI`)
  }
  const encoded = value.slice('sha512-'.length)
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.byteLength !== 64 || bytes.toString('base64') !== encoded) {
    throw new Error(`desktop plugin source: ${field} must encode one SHA-512 digest`)
  }
  return value
}

function expectedReleaseAssetUrl(source: Pick<DesktopGithubReleasePluginSource, 'owner' | 'repo' | 'tag'>, asset: string): string {
  return `https://github.com/${source.owner}/${source.repo}/releases/download/${encodeURIComponent(source.tag)}/${encodeURIComponent(asset)}`
}

/**
 * Validate a structured package source at the internal API boundary.
 * @param value - Untrusted manifest or IPC value.
 * @returns Exact supported source union.
 */
export function parseDesktopPluginSource(value: unknown): DesktopPluginSource {
  if (!isRecord(value) || value.schemaVersion !== DESKTOP_PLUGIN_SOURCE_SCHEMA_VERSION) {
    throw new Error('desktop plugin source: unsupported schema version')
  }

  if (value.type === 'npmRegistry') {
    assertKeys(value, ['schemaVersion', 'type', 'spec'])
    assertString(value.spec, 'npm registry spec')
    return { schemaVersion: 1, type: 'npmRegistry', spec: value.spec }
  }
  if (value.type === 'packageSpec') {
    assertKeys(value, ['schemaVersion', 'type', 'spec'])
    assertString(value.spec, 'package source spec')
    return { schemaVersion: 1, type: 'packageSpec', spec: value.spec }
  }
  if (value.type !== 'githubRelease') throw new Error('desktop plugin source: unsupported source type')
  assertKeys(value, [
    'schemaVersion', 'type', 'owner', 'repo', 'tag', 'asset', 'packageName', 'version',
    'assetId', 'size', 'sha256', 'integrity', 'targetCommit', 'dependencyRegistry', 'checksumManifest',
  ])
  assertString(value.owner, 'GitHub owner', OWNER_PATTERN)
  assertString(value.repo, 'GitHub repository', REPO_PATTERN)
  assertString(value.tag, 'GitHub release tag', RELEASE_NAME_PATTERN)
  if (value.tag.toLowerCase() === 'latest') throw new Error('desktop plugin source: mutable latest release is not supported')
  assertString(value.asset, 'GitHub release asset', RELEASE_NAME_PATTERN)
  assertPositiveInteger(value.assetId, 'GitHub release asset id')
  assertString(value.packageName, 'package name', PACKAGE_NAME_PATTERN)
  assertString(value.version, 'package version')
  if (valid(value.version) !== value.version) throw new Error('desktop plugin source: package version must be exact semver')
  if (!Number.isSafeInteger(value.size) || (value.size as number) <= 0 || (value.size as number) > MAX_RELEASE_ASSET_BYTES) {
    throw new Error('desktop plugin source: invalid release asset size')
  }
  assertString(value.sha256, 'SHA-256', SHA256_PATTERN)
  const integrity = parseIntegrity(value.integrity, 'integrity')
  assertString(value.targetCommit, 'target commit', COMMIT_PATTERN)
  if (value.dependencyRegistry !== undefined) {
    assertString(value.dependencyRegistry, 'dependency registry')
    assertSafeRegistry(value.dependencyRegistry)
  }
  let checksumManifest: DesktopGithubReleasePluginSource['checksumManifest']
  if (value.checksumManifest !== undefined) {
    if (!isRecord(value.checksumManifest)) throw new Error('desktop plugin source: invalid checksum manifest')
    assertKeys(value.checksumManifest, ['format', 'asset', 'assetId', 'url', 'size', 'sha256', 'integrity'])
    if (value.checksumManifest.format !== 'sha256sums') {
      throw new Error('desktop plugin source: unsupported checksum manifest format')
    }
    assertString(value.checksumManifest.asset, 'checksum manifest asset', RELEASE_NAME_PATTERN)
    assertPositiveInteger(value.checksumManifest.assetId, 'checksum manifest asset id')
    assertString(value.checksumManifest.url, 'checksum manifest URL')
    if (value.checksumManifest.url !== expectedReleaseAssetUrl({
      owner: value.owner,
      repo: value.repo,
      tag: value.tag,
    }, value.checksumManifest.asset)) {
      throw new Error('desktop plugin source: checksum manifest URL is not canonical')
    }
    if (!Number.isSafeInteger(value.checksumManifest.size) || (value.checksumManifest.size as number) <= 0
      || (value.checksumManifest.size as number) > MAX_RELEASE_ASSET_BYTES) {
      throw new Error('desktop plugin source: invalid checksum manifest size')
    }
    assertString(value.checksumManifest.sha256, 'checksum manifest SHA-256', SHA256_PATTERN)
    const checksumIntegrity = parseIntegrity(value.checksumManifest.integrity, 'checksum manifest integrity')
    checksumManifest = {
      format: 'sha256sums',
      asset: value.checksumManifest.asset,
      assetId: value.checksumManifest.assetId,
      url: value.checksumManifest.url,
      size: value.checksumManifest.size as number,
      sha256: value.checksumManifest.sha256,
      ...(checksumIntegrity === undefined ? {} : { integrity: checksumIntegrity }),
    }
  }

  return {
    schemaVersion: 1,
    type: 'githubRelease',
    owner: value.owner,
    repo: value.repo,
    tag: value.tag,
    asset: value.asset,
    assetId: value.assetId,
    packageName: value.packageName,
    version: value.version,
    size: value.size as number,
    sha256: value.sha256,
    ...(integrity === undefined ? {} : { integrity }),
    targetCommit: value.targetCommit,
    ...(value.dependencyRegistry === undefined ? {} : { dependencyRegistry: value.dependencyRegistry }),
    ...(checksumManifest === undefined ? {} : { checksumManifest }),
  }
}

/**
 * Validate one durable verified-release transaction receipt.
 * @param value - Untrusted receipt file or provisioning-state value.
 * @returns Validated transaction receipt.
 */
export function parseDesktopPluginProvisionReceipt(value: unknown): DesktopPluginProvisionReceipt {
  if (!isRecord(value) || value.schemaVersion !== DESKTOP_PLUGIN_RECEIPT_SCHEMA_VERSION
    || JSON.stringify(value.capability) !== JSON.stringify(DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY)) {
    throw new Error('desktop plugin source: invalid provision receipt')
  }
  const source = parseDesktopPluginSource(value.source)
  if (source.type !== 'githubRelease'
    || value.packageName !== source.packageName
    || value.version !== source.version
    || value.artifactSha256 !== source.sha256
    || typeof value.releaseId !== 'number' || !Number.isSafeInteger(value.releaseId) || value.releaseId <= 0
    || value.assetId !== source.assetId
    || !isRecord(value.states)
    || value.states.staged !== true
    || value.states.health !== 'passed'
    || value.states.activated !== true
    || value.states.rolledBack !== false
    || value.states.verified !== true) {
    throw new Error('desktop plugin source: invalid provision receipt')
  }
  return {
    schemaVersion: DESKTOP_PLUGIN_RECEIPT_SCHEMA_VERSION,
    capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
    source,
    releaseId: value.releaseId,
    assetId: value.assetId,
    packageName: source.packageName,
    version: source.version,
    artifactSha256: source.sha256,
    states: {
      staged: true,
      health: 'passed',
      activated: true,
      rolledBack: false,
      verified: true,
    },
  }
}

async function githubJson(url: URL, fetcher: typeof fetch): Promise<Record<string, unknown>> {
  return readDesktopGithubReleaseJson(url, fetcher, 'desktop plugin source')
}

async function resolveTagCommit(source: DesktopGithubReleasePluginSource, fetcher: typeof fetch): Promise<string> {
  return resolveDesktopGithubTagCommit(
    source.owner,
    source.repo,
    source.tag,
    fetcher,
    'desktop plugin source',
  )
}

function assertArchivePath(path: string): void {
  if (path.includes('\\') || path.startsWith('/') || posix.isAbsolute(path)) {
    throw new Error(`desktop plugin source: unsafe archive path ${JSON.stringify(path)}`)
  }
  const normalized = posix.normalize(path)
  if (normalized === '..' || normalized.startsWith('../') || normalized !== path.replace(/\/$/u, '')) {
    throw new Error(`desktop plugin source: unsafe archive path ${JSON.stringify(path)}`)
  }
  if (normalized !== 'package' && !normalized.startsWith('package/')) {
    throw new Error(`desktop plugin source: unexpected archive root ${JSON.stringify(path)}`)
  }
}

function assertArchiveLink(entry: ReadEntry): void {
  if (entry.type !== 'SymbolicLink' && entry.type !== 'Link') return
  const link = entry.linkpath
  assertString(link, 'archive link target')
  if (link.includes('\\') || posix.isAbsolute(link)) {
    throw new Error(`desktop plugin source: unsafe archive link ${JSON.stringify(link)}`)
  }
  const target = entry.type === 'Link'
    ? posix.normalize(link)
    : posix.normalize(posix.join(posix.dirname(entry.path), link))
  if (target !== 'package' && !target.startsWith('package/')) {
    throw new Error(`desktop plugin source: archive link escapes package root ${JSON.stringify(link)}`)
  }
}

async function inspectPackageArchive(
  artifact: string,
  directory: string,
  source: DesktopGithubReleasePluginSource,
): Promise<void> {
  let manifestEntries = 0
  let archiveError: Error | undefined
  await t({
    file: artifact,
    onReadEntry(entry) {
      if (archiveError !== undefined) return
      try {
        assertArchivePath(entry.path)
        assertArchiveLink(entry)
        if (entry.path === 'package/package.json') manifestEntries++
      } catch (error) {
        archiveError = error instanceof Error ? error : new Error('desktop plugin source: archive validation failed')
      }
    },
  })
  if (archiveError !== undefined) throw archiveError
  if (manifestEntries !== 1) throw new Error('desktop plugin source: archive must contain one package/package.json')
  const manifestRoot = mkdtempSync(join(directory, 'manifest-'))
  try {
    await x({
      file: artifact,
      cwd: manifestRoot,
      strip: 1,
      filter: path => path === 'package/package.json',
    })
    const value: unknown = JSON.parse(readFileSync(join(manifestRoot, 'package.json'), 'utf8'))
    if (!isRecord(value) || value.name !== source.packageName) {
      throw new Error('desktop plugin source: archive package name does not match the lock')
    }
    if (value.version !== source.version) {
      throw new Error('desktop plugin source: archive package version does not match the lock')
    }
    if (isRecord(value.scripts)) {
      for (const script of LIFECYCLE_SCRIPTS) {
        if (typeof value.scripts[script] === 'string') {
          throw new Error(`desktop plugin source: archive declares forbidden lifecycle script ${script}`)
        }
      }
    }
  } finally {
    rmSync(manifestRoot, { recursive: true, force: true })
  }
}

async function downloadArtifact(
  url: URL,
  destination: string,
  lock: { readonly size: number; readonly sha256: string; readonly integrity?: string },
  fetcher: typeof fetch,
  phase: (value: 'download' | 'validation') => void,
): Promise<void> {
  phase('download')
  const response = await requestDesktopGithubRelease(
    url,
    'application/octet-stream',
    true,
    fetcher,
    'desktop plugin source',
  )
  if (response.body === null) throw new Error('desktop plugin source: release asset response has no body')
  const descriptor = openSync(destination, 'wx', 0o600)
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  let size = 0
  try {
    const reader = response.body.getReader()
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) break
        size += chunk.value.byteLength
        if (size > lock.size || size > MAX_RELEASE_ASSET_BYTES) {
          phase('validation')
          throw new Error('desktop plugin source: release asset exceeds its locked size')
        }
        sha256.update(chunk.value)
        sha512.update(chunk.value)
        writeSync(descriptor, chunk.value)
      }
    } finally {
      reader.releaseLock()
    }
  } finally {
    closeSync(descriptor)
  }
  phase('validation')
  if (size !== lock.size) throw new Error('desktop plugin source: release asset size does not match the lock')
  if (sha256.digest('hex') !== lock.sha256) {
    throw new Error('desktop plugin source: release asset SHA-256 does not match the lock')
  }
  const actualIntegrity = `sha512-${sha512.digest('base64')}`
  if (lock.integrity !== undefined && actualIntegrity !== lock.integrity) {
    throw new Error('desktop plugin source: release asset SRI does not match the lock')
  }
}

function releaseAsset(
  release: Record<string, unknown>,
  name: string,
  lock: { readonly assetId: number; readonly size: number; readonly sha256: string; readonly url?: string },
): Record<string, unknown> {
  if (!Array.isArray(release.assets)) throw new Error('desktop plugin source: GitHub release has no asset list')
  const assets = release.assets.filter((asset): asset is Record<string, unknown> => isRecord(asset) && asset.name === name)
  if (assets.length !== 1) throw new Error('desktop plugin source: GitHub release asset is missing or duplicated')
  const asset = assets[0]
  if (asset?.state !== 'uploaded' || asset.size !== lock.size || asset.id !== lock.assetId
    || (lock.url !== undefined && asset.browser_download_url !== lock.url)) {
    throw new Error('desktop plugin source: GitHub release asset metadata does not match the lock')
  }
  if (asset.digest !== undefined && asset.digest !== null && asset.digest !== `sha256:${lock.sha256}`) {
    throw new Error('desktop plugin source: GitHub release asset digest does not match the lock')
  }
  return asset
}

function verifyChecksumManifest(path: string, source: DesktopGithubReleasePluginSource): void {
  const lines = readFileSync(path, 'utf8').split(/\r?\n/u).filter(line => line !== '')
  const entries = lines.map((line) => {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9][A-Za-z0-9._+-]*)$/u.exec(line)
    if (match === null) throw new Error('desktop plugin source: malformed SHA256SUMS entry')
    return { sha256: match[1], asset: match[2] }
  })
  const matches = entries.filter(entry => entry.asset === source.asset)
  if (matches.length !== 1) {
    throw new Error('desktop plugin source: SHA256SUMS must contain exactly one package asset entry')
  }
  if (matches[0]?.sha256 !== source.sha256) {
    throw new Error('desktop plugin source: SHA256SUMS package hash does not match the lock')
  }
}

/**
 * Download and verify one immutable GitHub Release package.
 * @param input - Structured source lock.
 * @param directory - Private transaction directory that owns the resulting artifact.
 * @param fetcher - Fetch implementation, injectable for deterministic tests.
 * @param phase - Reports acquisition phases for durable optional-failure diagnostics.
 * @returns Verified artifact and GitHub object identities.
 */
export async function acquireDesktopPluginArtifact(
  input: unknown,
  directory: string,
  fetcher: typeof fetch = fetch,
  phase: (value: 'download' | 'validation') => void = () => {},
): Promise<DesktopVerifiedPluginArtifact> {
  phase('validation')
  const parsed = parseDesktopPluginSource(input)
  if (parsed.type !== 'githubRelease') throw new Error('desktop plugin source: GitHub Release source required')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const source = parsed
  const base = `https://${API_HOST}/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}`
  phase('download')
  const release = await githubJson(new URL(`${base}/releases/tags/${encodeURIComponent(source.tag)}`), fetcher)
  phase('validation')
  if (release.draft !== false) throw new Error('desktop plugin source: GitHub release is draft')
  if (release.immutable !== true) throw new Error('desktop plugin source: GitHub release is mutable or lacks immutable metadata')
  if (release.tag_name !== source.tag || release.target_commitish !== source.targetCommit) {
    throw new Error('desktop plugin source: GitHub release tag or target commit does not match the lock')
  }
  if (!Number.isSafeInteger(release.id) || (release.id as number) <= 0) {
    throw new Error('desktop plugin source: GitHub release has no valid id')
  }
  phase('download')
  const tagCommit = await resolveTagCommit(source, fetcher)
  phase('validation')
  if (tagCommit !== source.targetCommit) throw new Error('desktop plugin source: GitHub tag commit does not match the lock')
  const asset = releaseAsset(release, source.asset, source)
  const releaseId = release.id as number
  const assetId = asset.id as number
  const artifact = join(directory, source.asset)
  try {
    await downloadArtifact(new URL(`${base}/releases/assets/${String(source.assetId)}`), artifact, source, fetcher, phase)
    if (source.checksumManifest !== undefined) {
      releaseAsset(release, source.checksumManifest.asset, source.checksumManifest)
      const checksumPath = join(directory, source.checksumManifest.asset)
      await downloadArtifact(
        new URL(`${base}/releases/assets/${String(source.checksumManifest.assetId)}`),
        checksumPath,
        source.checksumManifest,
        fetcher,
        phase,
      )
      verifyChecksumManifest(checksumPath, source)
    }
    await inspectPackageArchive(artifact, directory, source)
  } catch (error) {
    rmSync(artifact, { force: true })
    throw error
  }
  return {
    source,
    path: artifact,
    releaseId,
    assetId,
    packageName: source.packageName,
    version: source.version,
  }
}
