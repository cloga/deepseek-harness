/** Source-owned Windows managed update checks and detached-helper handoff. */

import { createHash } from 'node:crypto'
import {
  DESKTOP_MANAGED_UPDATE_MANIFEST_ASSET,
  DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY,
  assertManagedUpdateRedirect,
  parseDesktopManagedUpdateManifest,
  type DesktopAcceptedManagedUpdateManifest,
  type DesktopManagedUpdateCapability,
} from './managed-update-protocol.ts'
import {
  requestDesktopGithubRelease,
  resolveDesktopGithubTagCommit,
} from './github-release.ts'
import type { DesktopUpdateState } from './ipc.ts'

const REDIRECTS = new Set([301, 302, 303, 307, 308])
const MAX_MANIFEST_BYTES = 1024 * 1024
const COMMIT = /^[a-f0-9]{40}$/u
const ASSET_DIGEST = /^sha256:([a-f0-9]{64})$/u
const SOURCE_OWNER = 'cloga'
const SOURCE_REPOSITORY = 'deepseek-harness'
const RELEASES_API = `https://api.github.com/repos/${SOURCE_OWNER}/${SOURCE_REPOSITORY}/releases?per_page=100`

/** Immutable release selected by one managed check. */
export interface DesktopManagedUpdateSelection {
  readonly kind: 'source' | 'migration'
  readonly manifest: DesktopAcceptedManagedUpdateManifest
  readonly manifestUrl: string
  readonly manifestSha256: string
  readonly assetSha256: string
}

/** Network operation injected by tests and release verification. */
export interface ManagedUpdateOperations {
  fetch: typeof fetch
}

const defaultOperations: ManagedUpdateOperations = {
  fetch: (url, init) => fetch(url, init),
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`desktop managed update: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

async function fetchManifest(
  url: string,
  operations: ManagedUpdateOperations,
  expectedSha256?: string,
): Promise<{ value: unknown; sha256: string }> {
  let current = url
  for (let count = 0; count <= 5; count++) {
    const response = await operations.fetch(current, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(30_000),
    })
    if (REDIRECTS.has(response.status)) {
      const location = response.headers.get('location')
      if (location === null) throw new Error('desktop managed update: redirect omitted Location')
      const target = new URL(location, current).href
      assertManagedUpdateRedirect(current, target)
      await response.body?.cancel()
      current = target
      continue
    }
    if (!response.ok) throw new Error(`desktop managed update: manifest returned HTTP ${String(response.status)}`)
    const declared = response.headers.get('content-length')
    if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_MANIFEST_BYTES)) {
      await response.body?.cancel()
      throw new Error('desktop managed update: manifest exceeds the allowed size')
    }
    const body = Buffer.from(await response.arrayBuffer())
    if (body.byteLength > MAX_MANIFEST_BYTES) throw new Error('desktop managed update: manifest exceeds the allowed size')
    const sha256 = createHash('sha256').update(body).digest('hex')
    if (expectedSha256 !== undefined && sha256 !== expectedSha256) {
      throw new Error('desktop managed update: manifest asset digest does not match GitHub')
    }
    try {
      return { value: JSON.parse(body.toString('utf8')), sha256 }
    } catch {
      throw new Error('desktop managed update: manifest is not JSON')
    }
  }
  throw new Error('desktop managed update: redirect limit exceeded')
}

/**
 * Discover the highest immutable source-owned release at or above the supplied sequence.
 * @param capability - Build-carried owner, tag, manifest, and sequence policy.
 * @param installedSequence - Sequence already completed by the installed application.
 * @param operations - Network operations replaceable by tests.
 * @returns Highest accepted release, or undefined before the source channel has any release.
 */
export async function discoverDesktopManagedSourceRelease(
  capability: DesktopManagedUpdateCapability,
  installedSequence: number,
  operations: ManagedUpdateOperations = defaultOperations,
): Promise<DesktopManagedUpdateSelection | undefined> {
  const response = await requestDesktopGithubRelease(
    new URL(RELEASES_API),
    'application/vnd.github+json',
    false,
    (url, init) => operations.fetch(url, init),
    'desktop managed update',
  )
  if (response.headers.get('link')?.includes('rel="next"') === true) {
    throw new Error('desktop managed update: release discovery exceeded one immutable page')
  }
  const releases: unknown = await response.json()
  if (!Array.isArray(releases)) throw new Error('desktop managed update: GitHub releases response must be an array')
  const selections: DesktopManagedUpdateSelection[] = []
  for (const releaseValue of releases) {
    const release = record(releaseValue, 'GitHub release')
    if (typeof release.tag_name !== 'string' || !release.tag_name.startsWith(capability.tagPrefix)) continue
    if (release.draft !== false || release.immutable !== true || typeof release.target_commitish !== 'string'
      || !COMMIT.test(release.target_commitish)) {
      throw new Error('desktop managed update: channel release is not immutable or commit-pinned')
    }
    const tagCommit = await resolveDesktopGithubTagCommit(
      SOURCE_OWNER,
      SOURCE_REPOSITORY,
      release.tag_name,
      (url, init) => operations.fetch(url, init),
      'desktop managed update',
    )
    if (tagCommit !== release.target_commitish) {
      throw new Error('desktop managed update: release tag does not resolve to its target commit')
    }
    if (!Array.isArray(release.assets)) throw new Error('desktop managed update: channel release has no asset list')
    const manifests = release.assets.filter((asset): asset is Record<string, unknown> => (
      typeof asset === 'object' && asset !== null && !Array.isArray(asset)
      && (asset as Record<string, unknown>).name === capability.manifestAsset
    ))
    if (manifests.length !== 1) {
      throw new Error('desktop managed update: channel release manifest is missing or duplicated')
    }
    const asset = manifests[0]
    if (asset?.state !== 'uploaded' || typeof asset.digest !== 'string') {
      throw new Error('desktop managed update: channel release manifest is not uploaded with a digest')
    }
    const digest = ASSET_DIGEST.exec(asset.digest)?.[1]
    if (digest === undefined) throw new Error('desktop managed update: channel release manifest digest is invalid')
    const manifestUrl = `https://github.com/${DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY}/releases/download/`
      + `${encodeURIComponent(release.tag_name)}/${DESKTOP_MANAGED_UPDATE_MANIFEST_ASSET}`
    const fetched = await fetchManifest(manifestUrl, operations, digest)
    const manifest = parseDesktopManagedUpdateManifest(fetched.value, capability, 0, true)
    if (manifest.owner !== DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY
      || manifest.source.commit !== release.target_commitish
      || manifest.source.tag !== release.tag_name) {
      throw new Error('desktop managed update: release metadata does not match its manifest')
    }
    if (manifest.sequence >= installedSequence) {
      selections.push({
        kind: 'source',
        manifest,
        manifestUrl,
        manifestSha256: manifest.manifestSha256,
        assetSha256: fetched.sha256,
      })
    }
  }
  selections.sort((left, right) => right.manifest.sequence - left.manifest.sequence)
  const selected = selections[0]
  const conflict = selected === undefined ? undefined : selections.find(candidate => (
    candidate !== selected
    && candidate.manifest.sequence === selected.manifest.sequence
    && candidate.manifestSha256 !== selected.manifestSha256
  ))
  if (conflict !== undefined) {
    throw new Error('desktop managed update: channel publishes conflicting manifests for one sequence')
  }
  return selected
}

async function selectMigration(
  capability: DesktopManagedUpdateCapability,
  installedSequence: number,
  operations: ManagedUpdateOperations,
): Promise<DesktopManagedUpdateSelection | undefined> {
  const migration = capability.migration
  if (migration === undefined || installedSequence !== 0) return undefined
  const fetched = await fetchManifest(migration.manifestUrl, operations, migration.assetSha256)
  const manifest = parseDesktopManagedUpdateManifest(fetched.value, capability, installedSequence, true)
  if (manifest.owner !== 'cloga/dsh-windows-ops') {
    throw new Error('desktop managed update: migration manifest owner is invalid')
  }
  return {
    kind: 'migration',
    manifest,
    manifestUrl: migration.manifestUrl,
    manifestSha256: migration.manifestSha256,
    assetSha256: migration.assetSha256,
  }
}

/** Managed check/install state owner; install delegates only a validated immutable selection. */
export class DesktopManagedUpdateCoordinator {
  private selection: DesktopManagedUpdateSelection | undefined
  private checkOperation: Promise<DesktopUpdateState> | undefined
  private installOperation: Promise<DesktopUpdateState> | undefined

  constructor(
    private readonly capability: DesktopManagedUpdateCapability,
    private readonly installedSequence: () => number,
    private readonly publish: (state: DesktopUpdateState) => DesktopUpdateState,
    private readonly launch: (selection: DesktopManagedUpdateSelection) => Promise<void>,
    private readonly operations: ManagedUpdateOperations = defaultOperations,
  ) {}

  /** Check immutable source releases, using the legacy migration only before the source channel exists. */
  check(): Promise<DesktopUpdateState> {
    if (this.installOperation !== undefined) return this.installOperation
    if (this.checkOperation !== undefined) return this.checkOperation
    this.checkOperation = this.doCheck().finally(() => { this.checkOperation = undefined })
    return this.checkOperation
  }

  /** Launch one detached helper for the retained selection; repeated clicks share one operation. */
  install(): Promise<DesktopUpdateState> {
    if (this.installOperation !== undefined) return this.installOperation
    this.installOperation = (async () => {
      await this.checkOperation
      const selection = this.selection
      if (selection === undefined) throw new Error('desktop managed update: no verified update is available')
      const version = selection.manifest.owner === DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY
        ? selection.manifest.version
        : selection.manifest.channelVersion
      this.publish({
        phase: 'installing',
        version,
        mode: 'github-release-managed',
        interactiveInstaller: true,
      })
      try {
        await this.launch(selection)
        this.selection = undefined
        return this.publish({
          phase: 'installing',
          version,
          mode: 'github-release-managed',
          interactiveInstaller: true,
        })
      } catch (error) {
        return this.publish({
          phase: 'error',
          mode: 'github-release-managed',
          message: error instanceof Error ? error.message : String(error),
        })
      }
    })().finally(() => { this.installOperation = undefined })
    return this.installOperation
  }

  private async doCheck(): Promise<DesktopUpdateState> {
    this.publish({ phase: 'checking', mode: 'github-release-managed' })
    try {
      const installedSequence = this.installedSequence()
      const source = await discoverDesktopManagedSourceRelease(this.capability, installedSequence, this.operations)
      const selection = source ?? await selectMigration(this.capability, installedSequence, this.operations)
      if (selection === undefined || selection.manifest.sequence === installedSequence) {
        this.selection = undefined
        return this.publish({ phase: 'idle', mode: 'github-release-managed' })
      }
      this.selection = selection
      const version = selection.manifest.owner === DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY
        ? selection.manifest.version
        : selection.manifest.channelVersion
      return this.publish({
        phase: 'available',
        version,
        mode: 'github-release-managed',
        interactiveInstaller: true,
      })
    } catch (error) {
      this.selection = undefined
      return this.publish({
        phase: 'error',
        mode: 'github-release-managed',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
}
