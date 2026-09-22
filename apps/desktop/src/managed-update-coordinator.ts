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
import { DesktopUpdatePreparationError } from './update-error.ts'
import { en, type DesktopMessages } from './locale.ts'
import { desktopUpdateNetworkDetails, withDesktopUpdateNetworkError } from './update-network-error.ts'

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
  const selections = await discoverSourceReleases(capability, operations, { kind: 'minimum', sequence: installedSequence })
  return selectSourceRelease(selections.filter(selection => selection.manifest.sequence >= installedSequence))
}

/**
 * Resolve the independently published release for the running application, never the newest update.
 * @param capability - Current packaged sequence and fixed release authority.
 * @param version - Running Electron application's version.
 * @param operations - Credential-free metadata transport.
 * @returns Exact immutable installed release; rejects missing, conflicting, or unverifiable evidence.
 */
export async function discoverDesktopManagedInstalledRelease(
  capability: DesktopManagedUpdateCapability,
  version: string,
  operations: ManagedUpdateOperations = defaultOperations,
): Promise<DesktopManagedUpdateSelection> {
  const selections = await discoverSourceReleases(capability, operations, { kind: 'exact', sequence: capability.currentSequence })
  const selected = selectSourceRelease(selections.filter(selection => selection.manifest.sequence === capability.currentSequence))
  if (selected === undefined || selected.manifest.owner !== DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY
    || selected.manifest.version !== version) {
    throw new Error('desktop managed update: installed release has no matching immutable publication')
  }
  return selected
}

type SourceReleaseScope =
  | { readonly kind: 'minimum'; readonly sequence: number }
  | { readonly kind: 'exact'; readonly sequence: number }

async function discoverSourceReleases(
  capability: DesktopManagedUpdateCapability,
  operations: ManagedUpdateOperations,
  scope: SourceReleaseScope,
): Promise<DesktopManagedUpdateSelection[]> {
  if (!Number.isSafeInteger(scope.sequence) || scope.sequence < 0) {
    throw new Error('desktop managed update: discovery sequence must be a nonnegative safe integer')
  }
  const response = await withDesktopUpdateNetworkError('release-list', () => requestDesktopGithubRelease(
    new URL(RELEASES_API),
    'application/vnd.github+json',
    false,
    (url, init) => operations.fetch(url, init),
    'desktop managed update',
  ))
  if (response.headers.get('link')?.includes('rel="next"') === true) {
    throw new Error('desktop managed update: release discovery exceeded one immutable page')
  }
  const releases: unknown = await withDesktopUpdateNetworkError('release-list', () => response.json())
  if (!Array.isArray(releases)) throw new Error('desktop managed update: GitHub releases response must be an array')
  const selections: DesktopManagedUpdateSelection[] = []
  for (const releaseValue of releases) {
    const release = record(releaseValue, 'GitHub release')
    const tag = release.tag_name
    if (typeof tag !== 'string' || !tag.startsWith(capability.tagPrefix)) continue
    if (release.draft !== false || release.immutable !== true || typeof release.target_commitish !== 'string'
      || !COMMIT.test(release.target_commitish)) {
      throw new Error('desktop managed update: channel release is not immutable or commit-pinned')
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
      + `${encodeURIComponent(tag)}/${DESKTOP_MANAGED_UPDATE_MANIFEST_ASSET}`
    const fetched = await withDesktopUpdateNetworkError('manifest-download', () => fetchManifest(manifestUrl, operations, digest))
    const manifest = parseDesktopManagedUpdateManifest(fetched.value, capability, 0, true)
    if (manifest.owner !== DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY
      || manifest.source.commit !== release.target_commitish
      || manifest.source.tag !== release.tag_name) {
      throw new Error('desktop managed update: release metadata does not match its manifest')
    }
    // Every matching record and original manifest is validated, even outside this caller's selection scope.
    // Only eligible records may become verified selections; floor zero retains full-catalog tag verification.
    const eligible = scope.kind === 'minimum' ? manifest.sequence >= scope.sequence : manifest.sequence === scope.sequence
    if (!eligible) continue
    const tagCommit = await withDesktopUpdateNetworkError('release-tag', () => resolveDesktopGithubTagCommit(
      SOURCE_OWNER,
      SOURCE_REPOSITORY,
      tag,
      (url, init) => operations.fetch(url, init),
      'desktop managed update',
    ))
    if (tagCommit !== release.target_commitish) {
      throw new Error('desktop managed update: release tag does not resolve to its target commit')
    }
    selections.push({
      kind: 'source',
      manifest,
      manifestUrl,
      manifestSha256: manifest.manifestSha256,
      assetSha256: fetched.sha256,
    })
  }
  return selections
}

function selectSourceRelease(selections: DesktopManagedUpdateSelection[]): DesktopManagedUpdateSelection | undefined {
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
  const fetched = await withDesktopUpdateNetworkError('manifest-download', () => fetchManifest(migration.manifestUrl, operations, migration.assetSha256))
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

/** Version-bound managed selection; the detached helper owns installer acquisition and verification. */
export class DesktopManagedUpdateCoordinator {
  private current: DesktopUpdateState = { phase: 'idle', mode: 'github-release-managed' }
  private selection: DesktopManagedUpdateSelection | undefined
  private prepared = false
  private handedOff = false
  private disposed = false
  private checkOperation: Promise<DesktopUpdateState> | undefined
  private downloadOperation: Promise<DesktopUpdateState> | undefined
  private installOperation: Promise<DesktopUpdateState> | undefined

  /**
   * @param capability - Build-carried immutable source and migration policy.
   * @param installedSequence - Sequence completed by the installed application.
   * @param publish - Publishes and returns the actual observable state.
   * @param launch - Main-owned admission and helper handoff; acknowledge before stopping Host, return false on deferral.
   * @param operations - Network operations replaceable by tests.
   * @param messages - Shell locale used only for classified network technical details.
   */
  constructor(
    private readonly capability: DesktopManagedUpdateCapability,
    private readonly installedSequence: () => number,
    private readonly publish: (state: DesktopUpdateState) => DesktopUpdateState,
    private readonly launch: (selection: DesktopManagedUpdateSelection) => Promise<boolean>,
    private readonly operations: ManagedUpdateOperations = defaultOperations,
    private readonly messages: DesktopMessages = en,
  ) {}

  /** Latest published state; immutable source identity remains main-process-owned. */
  get state(): DesktopUpdateState { return this.current }

  /**
   * Check immutable releases without acquiring an installer or replacing a prepared selection.
   * @param manual - Whether a failed check is published rather than returned silently.
   * @returns The joined check result, or the retained preparation state.
   */
  async check(manual = false): Promise<DesktopUpdateState> {
    this.assertLive()
    if (this.downloadOperation !== undefined || this.installOperation !== undefined || this.prepared) return this.current
    if (!manual && this.current.phase === 'error' && this.current.failedOperation === 'download') return this.current
    this.checkOperation ??= Promise.resolve().then(() => this.doCheck())
      .finally(() => { this.checkOperation = undefined })
    const result = await this.checkOperation
    return manual && result.phase === 'error' ? this.setState(result) : result
  }

  /**
   * Pin the confirmed verified selection without launching a helper or claiming downloaded installer bytes.
   * @param version - Exact version shown in the main-owned confirmation.
   * @returns Readiness for managed handoff; installer acquisition remains helper-owned.
   */
  async download(version: string): Promise<DesktopUpdateState> {
    this.assertLive()
    if (this.prepared) {
      this.assertVersion(version)
      return this.current
    }
    if (this.downloadOperation !== undefined) {
      const operation = this.downloadOperation
      await this.checkOperation
      this.assertLive()
      this.assertVersion(version)
      return operation
    }
    this.downloadOperation = Promise.resolve().then(async () => {
      await this.checkOperation
      this.assertLive()
      this.assertVersion(version)
      try {
        this.assertSequence()
        this.prepared = true
        return this.setState({ phase: 'ready', version })
      } catch (error) {
        return this.setState(this.failure(error, 'download'))
      }
    }).finally(() => { this.downloadOperation = undefined })
    return this.downloadOperation
  }

  /**
   * Launch one acknowledged helper after separate main-owned installation authorization.
   * @param version - Exact prepared version, never a renderer-selected source or URL.
   * @returns Actual published handoff, deferral, or classified preparation failure.
   */
  install(version: string): Promise<DesktopUpdateState> {
    try {
      this.assertLive()
      if (!this.prepared || this.downloadOperation !== undefined || version !== this.version()) {
        throw new Error('desktop managed update: confirmed target is not ready')
      }
    } catch (error) {
      // oxlint-disable-next-line typescript/prefer-promise-reject-errors -- Preserve validation rejection identity.
      return Promise.reject(error)
    }
    if (this.handedOff) return Promise.resolve(this.current)
    this.installOperation ??= Promise.resolve().then(async () => {
      try {
        this.assertLive()
        this.assertSequence()
        const selection = this.selection
        if (selection === undefined) throw new Error('desktop managed update: no verified update is available')
        this.setState({ phase: 'installing', version })
        if (!await this.launch(selection)) return this.setState({ phase: 'ready', version })
        this.handedOff = true
        return this.current
      } catch (error) {
        return this.setState(this.failure(error, 'install'))
      }
    }).finally(() => { this.installOperation = undefined })
    return this.installOperation
  }

  /** Prevent new operations and late publication; an already launched handoff remains main-owned. */
  dispose(): void {
    this.disposed = true
  }

  private assertLive(): void {
    if (this.disposed) throw new Error('desktop managed update: coordinator is disposed')
  }

  private version(): string | undefined {
    const manifest = this.selection?.manifest
    return manifest?.owner === DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY ? manifest.version : manifest?.channelVersion
  }

  private assertVersion(version: string): void {
    if (this.selection === undefined) throw new Error('desktop managed update: no verified update is available')
    if (version !== this.version()) throw new Error('desktop managed update: download confirmation is stale')
  }

  private assertSequence(): void {
    if (this.selection === undefined || this.selection.manifest.sequence <= this.installedSequence()) {
      throw new Error('desktop managed update: selected sequence is no longer newer than the installed application')
    }
  }

  private setState(state: DesktopUpdateState): DesktopUpdateState {
    if (!this.disposed) this.current = this.publish({ ...state, mode: 'github-release-managed' })
    return this.current
  }

  private failure(error: unknown, failedOperation: 'check' | 'download' | 'install'): DesktopUpdateState {
    const version = this.version()
    const networkDetails = desktopUpdateNetworkDetails(error, this.messages)
    return {
      phase: 'error',
      mode: 'github-release-managed',
      ...(version === undefined ? {} : { version }),
      failedOperation,
      message: error instanceof Error ? error.message : String(error),
      ...(error instanceof DesktopUpdatePreparationError ? {
        preparationFailure: error.kind,
        ...(error.technicalDetails === undefined ? {} : { technicalDetails: error.technicalDetails }),
      } : networkDetails === undefined ? {} : { technicalDetails: networkDetails }),
    }
  }

  private async doCheck(): Promise<DesktopUpdateState> {
    try {
      this.assertLive()
      const installedSequence = this.installedSequence()
      const source = await discoverDesktopManagedSourceRelease(this.capability, installedSequence, this.operations)
      const selection = source ?? await selectMigration(this.capability, installedSequence, this.operations)
      this.assertLive()
      if (selection === undefined || selection.manifest.sequence <= this.installedSequence()) {
        this.selection = undefined
        return this.setState({ phase: 'idle' })
      }
      this.selection = selection
      const version = selection.manifest.owner === DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY
        ? selection.manifest.version
        : selection.manifest.channelVersion
      return this.setState({ phase: 'available', version })
    } catch (error) {
      this.selection = undefined
      return this.failure(error, 'check')
    }
  }
}
