/** Launcher-owned, data-only package preparation. This module never activates a profile or certifies runtime health. */
import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, closeSync, fsyncSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { load, dump, JSON_SCHEMA } from 'js-yaml'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'
import { t, type ReadEntry } from 'tar'
import { valid, validRange, satisfies, subset } from 'semver'
import {
  loadOverlayPatches, parseProfilePreparedChange, parseProfileTransactionId,
  prepareProfileRootConfig, readProfileManifest, withProfilePackageLease,
  type ProfilePackageMutation, type ProfilePackageTransactions, type ProfilePreparedPackageChange,
} from '@deepseek-ai/dsh-app-boot'
import { acquireDesktopPluginArtifact, parseDesktopPluginSource, type DesktopVerifiedPluginArtifact } from './plugin-source.ts'
import { acquireDesktopSourcePackage } from './plugin-package-artifact.ts'
import { parseDesktopPluginInstallSpec } from './plugin-install-spec.ts'
import { DESKTOP_PLUGIN_RECEIPTS_FILE, readDesktopPluginReceipts } from './plugin-receipts.ts'
import { readDesktopPluginUserIntents, markDesktopPluginRemoved, clearDesktopPluginRemoval } from './plugin-user-intents.ts'
import { normalizeDesktopArtifactSpecifiers, type DesktopArtifactSpecifier } from './plugin-lock-normalization.ts'
import { desktopPackageReceiptPosition, desktopReceiptFileTransitions, desktopReceiptHash, validateDesktopReceiptTransition, type DesktopReceiptTransition } from './profile-package-receipt.ts'
import { desktopPackageArtifactSpecifier, readDesktopPackageLocks, verifyDesktopPackageArtifact, writeDesktopPackageLocks, type DesktopPackageInstallLock } from './plugin-package-lock.ts'
import { DESKTOP_RUNTIME_FILE, inventoryDesktopRuntime, readDesktopRuntime, runtimePath, type DesktopRuntimeDescriptor } from './runtime-tree.ts'
import { readDesktopPackageActivationPhase } from './profile-package-activation.ts'
import { DESKTOP_PLUGIN_PROVISIONING_STATE_FILE, buildDesktopProvisioningState, desktopPluginProvisioningPlanSha256, parseDesktopPluginProvisioningPlan, parseDesktopPluginProvisioningState, type DesktopPluginProvisioningPlan, type DesktopPluginProvisioningEntry, type DesktopPluginProvisioningState } from './plugin-provisioning.ts'

/** A runner must disable inherited environment and resolve only after the child has exited, including on abort. */
export interface DesktopStagingPnpmRequest {
  readonly cwd: string
  readonly args: readonly string[]
  readonly env: Readonly<NodeJS.ProcessEnv>
  readonly signal: AbortSignal
}

/** Only the launcher supplies executable selection; no executable or callback arrives through Host IPC. */
export interface DesktopProfilePackageStagingOptions {
  readonly profile: string
  readonly runtimeDir: string
  readonly installAnchor: string
  /** Explicit launcher-resolved profile registry policy; this backend supplies no default. */
  readonly dependencyRegistry: string
  /** Complete launcher-resolved external configuration inputs, including known-absent global patches. No ambient discovery. */
  readonly configPaths: readonly string[]
  /** Fixed packaged singleton plan and its resource file are supplied together by the shell, never Host IPC. */
  readonly provisioningPlan?: DesktopPluginProvisioningPlan
  readonly provisioningPlanFile?: string
  /** True only when the trusted initializer actually created this profile; never inferred from empty dependencies. */
  readonly provisioningProfileCreated?: boolean
  /** Missing active directory is accepted only when this owned transaction's rollback tree verifies completely. */
  readonly recoveryTransactionId?: string
  readonly pnpmRunner: (request: DesktopStagingPnpmRequest) => Promise<{ exitCode: number; timedOut?: boolean }>
  /** Pack with lifecycle and pnpm hooks disabled; resolve only after all work has stopped on cancellation. */
  readonly packDirectory: (directory: string, archivePath: string, signal: AbortSignal) => Promise<void>
  readonly fetcher: typeof fetch
  readonly operationTimeoutMs?: number
  readonly leaseWaitMs?: number
}

/** Fixed resource identity bound into every transaction created by a plan-configured shell. */
export interface DesktopProvisioningPlanResource {
  readonly file: string
  readonly sha256: string
  readonly planSha256: string
}

/** Shell-only authority for the required singleton plan; never a user-supplied ownership flag. */
export interface DesktopPreparedProvisioningContext {
  readonly schemaVersion: 1
  readonly planSha256: string
  readonly planResourceSha256: string
  readonly source: DesktopPluginProvisioningEntry['source']
  readonly ownerDecision: 'create-release-owned' | 'replace-release-owned'
  readonly previousSelected: boolean
}

/** Registry resolution evidence, not a content-addressed local source lock or verified Release receipt. */
export interface DesktopPreparedRegistryTarget {
  readonly schemaVersion: 1
  readonly requestedSpec: string
  readonly registry: string
  readonly packageName: string
  readonly version: string
  readonly integrity: string
  /** Full peer-qualified key in pnpm snapshots; package metadata uses the name@version prefix. */
  readonly packageKey: string
  readonly tarball?: string
}

/** Shell-private data revalidated under the caller's common profile lease; never exposed through Host IPC. */
export interface DesktopPreparedPackageActivation {
  readonly transactionDir: string
  readonly candidateDir: string
  readonly rollbackDir: string
  readonly baseGraphFingerprint: string
  readonly owner: {
    readonly profile: string
    readonly runtimeDir: string
    readonly installAnchor: string
    readonly runtimeFingerprint: string
    readonly dependencyRegistry: string
    readonly configPaths: readonly string[]
    readonly provisioningPlanResource?: DesktopProvisioningPlanResource
  }
  /** Present on every real backend result; optional only for legacy shell test fixtures. */
  readonly intentFingerprint?: string
  readonly provisioning?: DesktopPreparedProvisioningContext
  readonly mutation: ProfilePackageMutation
  readonly prepared: ProfilePreparedPackageChange
  readonly candidateFingerprint: string
  readonly verifiedRelease?: Omit<DesktopVerifiedPluginArtifact, 'path'>
  readonly registryTarget?: DesktopPreparedRegistryTarget
}

/** Read-only package-choice assessment. Exact bytes and selection do not substitute for current Host health. */
export type DesktopProvisioningAssessment = {
  readonly packageName: string
  readonly planSha256: string
  readonly planResourceSha256: string
} & (
  | {
    readonly status: 'exact-satisfied'
    readonly packageOwner: 'user' | 'release'
    readonly qualification: 'pending'
    readonly owner: DesktopPreparedPackageActivation['owner']
    readonly baseFingerprint: string
    readonly baseGraphFingerprint: string
    readonly assessmentFingerprint: string
  }
  | { readonly status: 'provisionable'; readonly reason: 'fresh-profile' | 'release-owned-update' | 'release-owned-repair' }
  | { readonly status: 'preserved-user-choice'; readonly reason: 'removed' | 'installed-override' | 'disabled' | 'ambiguous-legacy' }
  | { readonly status: 'invalid-evidence'; readonly diagnostic: string }
)

/** The additional reader is shell-private, not part of the remotely callable protocol. */
export interface DesktopProfilePackageTransactions extends ProfilePackageTransactions {
  /** Read under the common lease without mutating the profile.
   * @returns Evidence classification, with health still pending for exact matches.
   */
  assessProvisioning(): Promise<DesktopProvisioningAssessment>
  /**
   * Commit only baseline evidence after the shell verifies current target health/admission; no receipt ownership changes.
   * The caller must not hold the lease recursively. A stale metadata/graph/resource fingerprint always refuses the write.
   * @param expectedAssessmentFingerprint - Exact prior assessment binding, including metadata and full graph, not a health claim.
   * @returns Existing-schema qualified state after the fixed atomic write.
   * A changed state requires fresh assessment and health before retry.
   */
  commitSatisfiedProvisioning(expectedAssessmentFingerprint: string): Promise<DesktopPluginProvisioningState>
  /**
   * Stage only the constructor-bound required singleton plan, under the same lease and engine as manual requests.
   * @param requestId - Durable lowercase UUID, disjoint from any existing manual intent.
   * @param signal - Explicit cancellation/deadline source; no activation occurs.
   * @returns PREPARED with pending health, never an active provisioning receipt.
   */
  stageProvisioning(requestId: string, signal: AbortSignal): Promise<ProfilePreparedPackageChange>
  /**
   * Validate prepared bytes and the still-current base without modifying either tree.
   * The caller must already hold withProfilePackageLease and retain it through any activation.
   * @param transactionId - Prepared lowercase UUID belonging to this profile/runtime.
   * @returns Validated activation inputs, or undefined when no PREPARED record exists.
   */
  readPreparedForActivation(transactionId: string): Promise<DesktopPreparedPackageActivation | undefined>
  /**
   * Read owned evidence under the caller's lease without assuming that candidate or active is still in place.
   * This is not tree verification: call verifyActivationTree before acting on any path.
   * @param transactionId - Owned lowercase UUID.
   * @returns Parsed evidence bound to the current runtime and external configuration.
   */
  readPreparedForRecovery(transactionId: string): Promise<DesktopPreparedPackageActivation | undefined>
  /**
   * Verify one fixed tree location under the caller's lease, without repairing or renaming anything.
   * @param transactionId - Owned lowercase UUID.
   * @param role - Candidate is transaction/profile, active is owner.profile, rollback is transaction/rollback.
   * @param receiptTransition - Optional journal-bound exact receipt transition, accepted only for the active tree.
   * @returns Owned evidence after an exact tree digest match; unproved receipt changes fail closed.
   */
  verifyActivationTree(transactionId: string, role: 'candidate' | 'active' | 'rollback', receiptTransition?: DesktopReceiptTransition): Promise<DesktopPreparedPackageActivation>
}

interface Identity {
  profile: string
  runtimeDir: string
  installAnchor: string
  runtimeFingerprint: string
  dependencyRegistry: string
  configPaths: readonly string[]
  provisioningPlanResource?: DesktopProvisioningPlanResource
}
interface ConfigInput { path: string; sha256: string | null }
interface InventoryEntry { path: string; kind: 'file' | 'directory' | 'link'; sha256?: string; target?: string }
interface PreparedRecord {
  schemaVersion: 1
  owner: Identity
  requestFingerprint: string
  result: ProfilePreparedPackageChange
  baseFiles: InventoryEntry[]
  baseInputs: ConfigInput[]
  baseGraphFingerprint: string
  candidateFingerprint: string
  mutation: ProfilePackageMutation
  provisioning?: DesktopPreparedProvisioningContext
  verifiedRelease?: Omit<DesktopVerifiedPluginArtifact, 'path'>
  registryTarget?: DesktopPreparedRegistryTarget
}
interface Running { abort: AbortController; requestKey: string; done: Promise<ProfilePreparedPackageChange> }
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const RECORD = 'PREPARED.json'
const OWNER = 'owner.json'
const DISCARD = 'DISCARDED.json'
const MAX_FILES = 100_000
const MAX_BYTES = 512 * 1024 * 1024

function fail(message: string): never { throw new Error(`desktop package staging: ${message}`) }
function array(value: unknown): value is unknown[] { return Array.isArray(value) }
function strings(value: unknown): value is string[] {
  return array(value) && value.every(item => typeof item === 'string')
}
function requireRuntimeSchema(value: unknown): void {
  if (value !== 1) fail('incompatible runtime')
}
function synchronousResult<T>(operation: () => T): Promise<T> {
  return new Promise((resolve) => { resolve(operation()) })
}
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !array(value) }
function hash(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex') }
function registryUrl(input: string): string {
  if (typeof input !== 'string' || /[\\\u0000-\u0020\u007f]/u.test(input)) fail('an explicit safe HTTPS dependency registry is required')
  const url = new URL(input)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') fail('dependency registry must be HTTPS without credentials, query or fragment')
  return url.href.endsWith('/') ? url.href : `${url.href}/`
}
function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}
function canonical(path: string, directory: boolean): string {
  if (!isAbsolute(path) || /[\u0000-\u001f\u007f]/u.test(path)) fail('locations must be absolute local paths')
  // Reject links in every ancestor, not merely the final path segment.
  for (let current = resolve(path); ; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) fail('symlink locations are unsupported')
    if (dirname(current) === current) break
  }
  const stat = lstatSync(path)
  if (directory ? !stat.isDirectory() : !stat.isFile()) fail('location has the wrong filesystem type')
  return realpathSync(path)
}
function removeOwnedTree(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return
  if (stat.isSymbolicLink()) { unlinkSync(path); return }
  if (stat.isDirectory()) for (const name of readdirSync(path)) removeOwnedTree(join(path, name))
  rmSync(path, { recursive: stat.isDirectory(), force: true })
}
function json(path: string): unknown {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) fail('invalid metadata file')
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}
function readProvisioningEvidence(profile: string): ReturnType<typeof parseDesktopPluginProvisioningState> | undefined {
  const path = join(profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE)
  if (!existsSync(path)) return undefined
  try { return parseDesktopPluginProvisioningState(json(path)) } catch (error) {
    throw new Error('desktop package staging: invalid provisioning evidence requires explicit recovery', { cause: error })
  }
}
function durableJson(path: string, value: unknown, temporary = `${path}.tmp`): void {
  const fd = openSync(temporary, 'wx', 0o600)
  let renamed = false
  try {
    try { writeFileSync(fd, `${JSON.stringify(value, undefined, 2)}\n`); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
    renamed = true
    // Windows cannot open directory handles with node:fs; file data is flushed before the rename there.
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
  } catch (error) {
    if (!renamed) {
      try { unlinkSync(temporary) } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'durable record write and cleanup failed')
      }
    }
    throw error
  }
}
function inventory(root: string, modules: boolean, runtime?: string, verifyLinks = true, relocatable = true): InventoryEntry[] {
  const files: InventoryEntry[] = []
  let bytes = 0
  const walk = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (!modules && directory === root && name === 'node_modules') continue
      const path = join(directory, name)
      const key = relative(root, path).split(sep).join('/')
      const stat = lstatSync(path)
      if (++bytes > MAX_BYTES || files.length >= MAX_FILES) fail('profile snapshot exceeds its bound')
      if (stat.isSymbolicLink()) {
        if (!modules || runtime === undefined) fail(`linked profile metadata is unsupported: ${key}`)
        if (verifyLinks) {
          const target = realpathSync(path)
          if (!inside(root, target) && !inside(runtime, target)) fail(`package graph escapes staging/runtime: ${key}`)
          if (relocatable && isAbsolute(readlinkSync(path)) && inside(root, target)) fail(`nonrelocatable absolute package link: ${key}`)
        }
        files.push({ path: key, kind: 'link', target: readlinkSync(path) })
      } else if (stat.isDirectory()) {
        files.push({ path: key, kind: 'directory' }); walk(path)
      } else if (stat.isFile()) {
        bytes += stat.size
        if (bytes > MAX_BYTES) fail('profile snapshot exceeds its byte bound')
        files.push({ path: key, kind: 'file', sha256: hash(readFileSync(path)) })
      } else fail(`special profile entry is unsupported: ${key}`)
    }
  }
  walk(root)
  return files
}
async function verifyInstalledSource(profile: string, source: DesktopPluginProvisioningEntry['source'], signal: AbortSignal): Promise<void> {
  const archive = canonical(join(profile, '.desktop-plugin-artifacts', `${source.sha256}.tgz`), false)
  if (lstatSync(archive).size !== source.size || source.size > 64 * 1024 * 1024) fail('planned artifact size differs or exceeds its bound')
  const bytes = readFileSync(archive)
  if (bytes.length !== source.size || hash(bytes) !== source.sha256
    || (source.integrity !== undefined && `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== source.integrity)) fail('planned artifact bytes do not match their recorded identity')
  const installed = realpathSync(join(profile, 'node_modules', source.packageName))
  if (!inside(profile, installed)) fail('installed planned package is outside the profile')
  canonical(installed, true)
  const manifest = json(join(installed, 'package.json'))
  if (!record(manifest) || manifest.name !== source.packageName || manifest.version !== source.version) fail('installed planned package identity differs')
  const expected = new Set<string>()
  const payloads: Array<{ name: string; size: number; bytes: number; digest: ReturnType<typeof createHash> }> = []
  let failure: Error | undefined
  let count = 0
  const parser = t({ strict: true, onReadEntry(entry: ReadEntry) {
    if (failure !== undefined) return
    try {
      const original = entry.header.path ?? entry.path
      const name = original.endsWith('/') ? original.slice(0, -1) : original
      if (++count > MAX_FILES || /[\\\u0000-\u001f\u007f]/u.test(name) || name.split('/').some(part => part === '' || part === '.' || part === '..' || part.includes(':'))
        || (!name.startsWith('package/') && name !== 'package') || (entry.type !== 'File' && entry.type !== 'Directory')) fail('unsafe planned package archive')
      if (entry.type === 'Directory') return
      const relativeName = name.slice('package/'.length)
      if (relativeName === '' || expected.has(relativeName)) fail('duplicate or invalid planned package file')
      expected.add(relativeName)
      const payload = { name: relativeName, size: entry.size, bytes: 0, digest: createHash('sha256') }
      payloads.push(payload)
      entry.on('data', (chunk: Buffer) => {
        if (failure !== undefined) return
        try {
          payload.bytes += chunk.length
          if (payload.bytes > payload.size) fail('planned archive entry exceeds its declared size')
          payload.digest.update(chunk)
        } catch (error) { failure = error instanceof Error ? error : new Error('invalid planned archive bytes'); parser.abort(failure) }
      })
    } catch (error) { failure = error instanceof Error ? error : new Error('invalid planned archive'); parser.abort(failure) }
  } })
  let expanded = 0
  const bound = new Transform({ transform(chunk: Buffer, _encoding, callback) {
    expanded += chunk.length
    callback(expanded > MAX_BYTES ? new Error('planned archive exceeds its expanded byte bound') : null, chunk)
  } })
  await pipeline(createReadStream(archive), createGunzip(), bound, parser, { signal })
  if (failure !== undefined) throw failure
  if (!expected.has('package.json')) fail('planned archive has no package manifest')
  for (const payload of payloads) {
    signal.throwIfAborted()
    const target = canonical(runtimePath(installed, payload.name), false)
    if (payload.bytes !== payload.size || !inside(installed, target) || lstatSync(target).size !== payload.size
      || hash(readFileSync(target)) !== payload.digest.digest('hex')) fail('installed planned package bytes differ from the verified artifact')
  }
  for (const file of inventory(installed, false)) if (file.kind === 'file' && !expected.has(file.path)) fail('installed planned package contains unrecorded payload files')
}
function checkSharedPackages(root: string, files: readonly InventoryEntry[], runtime: DesktopRuntimeDescriptor): void {
  for (const entry of files) {
    if (entry.kind !== 'file' || !entry.path.startsWith('node_modules/') || !entry.path.endsWith('/package.json')) continue
    const manifest = json(join(root, entry.path))
    if (!record(manifest)) fail('invalid graph manifest')
    if (runtime.sharedPackages.some(shared => shared.name === manifest.name)) fail('graph contains a private duplicate of a runtime shared package')
    if (record(manifest.peerDependencies)) for (const [name, range] of Object.entries(manifest.peerDependencies)) {
      const shared = runtime.sharedPackages.find(item => item.name === name)
      if (shared !== undefined && (typeof range !== 'string' || !satisfies(shared.version, range))) fail('runtime shared peer does not satisfy the installed package')
    }
  }
}
function fingerprint(files: InventoryEntry[]): string { return hash(JSON.stringify(files)) }
function snapshot(source: string, target: string, files: InventoryEntry[]): void {
  mkdirSync(target, { mode: 0o700 })
  for (const entry of files) {
    const path = join(target, entry.path)
    if (entry.kind === 'directory') mkdirSync(path, { mode: 0o700 })
    else {
      copyFileSync(join(source, entry.path), path)
      if (hash(readFileSync(path)) !== entry.sha256) fail('profile changed while copying metadata')
    }
  }
}
function parseMutation(input: unknown): ProfilePackageMutation {
  if (!record(input)) fail('invalid mutation')
  if (input.kind === 'remove') {
    if (Object.keys(input).some(key => key !== 'kind' && key !== 'name') || typeof input.name !== 'string' || !NAME.test(input.name)) fail('invalid remove mutation')
    return { kind: 'remove', name: input.name }
  }
  if (input.kind !== 'install' || Object.keys(input).some(key => !['kind', 'source', 'enabled', 'approvedBuilds'].includes(key))
    || (input.enabled !== undefined && typeof input.enabled !== 'boolean')
    || (input.approvedBuilds !== undefined && (!array(input.approvedBuilds) || input.approvedBuilds.length !== 0))) {
    fail('unsupported mutation or build approval; this backend does not execute builds')
  }
  return { kind: 'install', source: parseDesktopPluginSource(input.source),
    ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
    ...(input.approvedBuilds === undefined ? {} : { approvedBuilds: [] }) }
}
type RegistryRequest = Extract<ReturnType<typeof parseDesktopPluginInstallSpec>, { kind: 'registry' }>
function registryRequestOf(mutation: ProfilePackageMutation, profile: string): RegistryRequest | undefined {
  if (mutation.kind !== 'install' || mutation.source.type === 'githubRelease') return undefined
  const parsed = parseDesktopPluginInstallSpec(mutation.source.spec, profile)
  if (mutation.source.type === 'npmRegistry' && parsed.kind !== 'registry') fail('npmRegistry requires a registry package spec')
  return parsed.kind === 'registry' ? parsed : undefined
}
function isDirectRegistrySelector(name: string, selector: unknown, profile: string): boolean {
  if (typeof selector !== 'string') return false
  try {
    const parsed = parseDesktopPluginInstallSpec(`${name}@${selector}`, profile)
    return parsed.kind === 'registry' && parsed.name === name
  } catch (_error) {
    // A non-registry selector grants no direct-registry mutation authority.
    return false
  }
}
function registryIntegrity(input: unknown): string {
  if (typeof input !== 'string') fail('registry resolution has no integrity')
  const match = /^(sha1|sha256|sha384|sha512)-([A-Za-z0-9+/]+={0,2})$/u.exec(input)
  if (match === null) fail('registry resolution has unsupported integrity')
  const algorithm = match[1]
  const encoded = match[2]
  if (algorithm === undefined || encoded === undefined) fail('registry resolution has unsupported integrity')
  const bytes = Buffer.from(encoded, 'base64')
  const size = { sha1: 20, sha256: 32, sha384: 48, sha512: 64 }[algorithm as 'sha1' | 'sha256' | 'sha384' | 'sha512']
  if (bytes.length !== size || bytes.toString('base64') !== encoded) fail('registry integrity is not a canonical digest')
  return input
}
function registryTarball(input: unknown): string | undefined {
  if (input === undefined) return undefined
  if (typeof input !== 'string' || /[\\\u0000-\u0020\u007f]/u.test(input)) fail('unsafe registry tarball URL')
  const url = new URL(input)
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') fail('registry tarball must be credential-free HTTPS')
  return input
}
function stable(value: unknown, depth = 0): string {
  if (depth > 64) fail('metadata is cyclic or too deeply nested')
  if (array(value)) return `[${value.map(item => stable(item, depth + 1)).join(',')}]`
  if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable(value[key], depth + 1)}`).join(',')}}`
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null'
  return JSON.stringify(value)
}
interface PackageLock {
  document: Record<string, unknown>
  importer: Record<string, unknown>
  dependencies: Record<string, unknown>
  packages: Record<string, unknown>
  snapshots: Record<string, unknown>
}
function readPackageLock(profile: string): PackageLock | undefined {
  const path = join(profile, 'pnpm-lock.yaml')
  if (!existsSync(path)) return undefined
  canonical(path, false)
  if (lstatSync(path).size > 16 * 1024 * 1024) fail('pnpm lock exceeds its byte bound')
  const value: unknown = load(readFileSync(path, 'utf8'), { schema: JSON_SCHEMA })
  if (!record(value) || !['9.0', 9].includes(value.lockfileVersion as string | number) || !record(value.importers)
    || Object.keys(value.importers).join(',') !== '.' || !record(value.importers['.'])) fail('only a single-profile pnpm v9 lock is supported')
  const importer = value.importers['.']
  if (Object.keys(importer).some(key => !['dependencies', 'devDependencies', 'optionalDependencies'].includes(key))
    || (importer.dependencies !== undefined && !record(importer.dependencies))
    || (importer.devDependencies !== undefined && (!record(importer.devDependencies) || Object.keys(importer.devDependencies).length !== 0))
    || (importer.optionalDependencies !== undefined
      && (!record(importer.optionalDependencies) || Object.keys(importer.optionalDependencies).length !== 0))
    || (value.packages !== undefined && !record(value.packages)) || (value.snapshots !== undefined && !record(value.snapshots))) fail('unsupported pnpm lock importer')
  return { document: value, importer, dependencies: importer.dependencies ?? {},
    packages: value.packages ?? {}, snapshots: value.snapshots ?? {} }
}
function deriveRegistryTarget(
  profile: string, input: RegistryRequest, registry: string, requireExact = true,
): DesktopPreparedRegistryTarget {
  const manifest = json(join(profile, 'package.json'))
  const lock = readPackageLock(profile)
  const installedDir = realpathSync(join(profile, 'node_modules', input.name))
  if (!inside(profile, installedDir)) fail('registry target resolves outside the candidate')
  const installed = json(join(installedDir, 'package.json'))
  if (!record(manifest) || !record(manifest.dependencies) || !record(installed) || installed.name !== input.name
    || typeof installed.version !== 'string' || valid(installed.version) !== installed.version
    || lock === undefined) fail('registry target is not one exact installed version')
  const saved = manifest.dependencies[input.name]
  if (typeof saved !== 'string') fail('registry target is not one exact installed version')
  const selector = input.spec === input.name ? 'latest' : input.spec.slice(input.name.length + 1)
  if (validRange(selector) !== null && !satisfies(installed.version, selector)) fail('registry target version does not satisfy the requested selector')
  if (requireExact && saved !== installed.version) fail('registry target is not exact-pinned in the manifest')
  if (!requireExact && saved !== installed.version
    && !(validRange(selector) !== null && validRange(saved) !== null && satisfies(installed.version, saved) && subset(saved, selector))
    && !(validRange(selector) === null && saved === selector)) fail('pnpm saved a selector incompatible with the registry request')
  const entry = lock.dependencies[input.name]
  if (!record(entry) || entry.specifier !== saved || typeof entry.version !== 'string'
    || entry.version.split('(')[0] !== installed.version) fail('registry importer does not bind the exact target')
  const packageKey = `${input.name}@${entry.version}`
  const metadata = lock.packages[`${input.name}@${installed.version}`]
  if (!record(lock.snapshots[packageKey]) || !record(metadata) || !record(metadata.resolution)
    || Object.keys(metadata.resolution).some(key => !['integrity', 'tarball'].includes(key))) fail('registry target has no registry-shaped locked resolution')
  const integrity = registryIntegrity(metadata.resolution.integrity)
  const tarball = registryTarball(metadata.resolution.tarball)
  if (readDesktopPackageLocks(profile)[input.name] !== undefined || readDesktopPluginReceipts(profile).receipts[input.name] !== undefined) fail('registry target carries stale source or Release evidence')
  return { schemaVersion: 1, requestedSpec: input.spec, registry, packageName: input.name, version: installed.version,
    integrity, packageKey, ...(tarball === undefined ? {} : { tarball }) }
}
function savePackageLock(profile: string, lock: PackageLock): void {
  writeFileSync(join(profile, 'pnpm-lock.yaml'), dump({ ...lock.document, importers: { '.': { ...lock.importer, dependencies: lock.dependencies } } },
    { schema: JSON_SCHEMA, lineWidth: -1, noCompatMode: true }), { mode: 0o600 })
}
function runtimeLinkIdentity(name: string, reference: string, runtime: DesktopRuntimeDescriptor, runtimeDir: string): string | undefined {
  if (!reference.startsWith('link:')) return undefined
  const shared = runtime.sharedPackages.find(entry => entry.name === name)
  const target = reference.slice(5)
  if (shared === undefined || !isAbsolute(target) || /(?:^|[\\/])[^\\/]+\.asar(?:[\\/]|$)/iu.test(target)
    || canonical(target, true) !== canonical(runtimePath(runtimeDir, shared.path), true)) fail('locked runtime link requires an exact physical descriptor target; relative/ASAR/foreign links require migration')
  return stable({ name, path: runtimePath(runtimeDir, shared.path), version: shared.version })
}
/** Bind every retained root and reachable locked package, including peer suffixes, optional edges and resolution integrity. */
function retainedGraph(
  lock: PackageLock, names: readonly string[], artifacts: readonly DesktopArtifactSpecifier[],
  runtime: DesktopRuntimeDescriptor, runtimeDir: string,
): string {
  const roots: Record<string, unknown> = {}
  const snapshots: Record<string, unknown> = {}
  const packages: Record<string, unknown> = {}
  const allowedArtifacts = new Set(artifacts.map(artifact => artifact.specifier))
  const runtimeLinks: Record<string, string> = {}
  const visit = (name: string, reference: unknown): void => {
    if (typeof reference !== 'string') fail('invalid locked dependency reference')
    const runtimeIdentity = runtimeLinkIdentity(name, reference, runtime, runtimeDir)
    if (runtimeIdentity !== undefined) { runtimeLinks[`${name}@${reference}`] = runtimeIdentity; return }
    const key = Object.hasOwn(lock.snapshots, `${name}@${reference}`) ? `${name}@${reference}` : reference
    if (!Object.hasOwn(lock.snapshots, key)) fail(`unresolved retained lock reference: ${name}`)
    if (Object.hasOwn(snapshots, key)) return
    if (Object.keys(snapshots).length >= MAX_FILES) fail('locked graph exceeds its entry bound')
    const snapshot = lock.snapshots[key]
    const packageKey = key.split('(')[0] ?? key
    const metadata = lock.packages[packageKey]
    if (!record(snapshot) || !record(metadata) || !record(metadata.resolution)) fail('locked package metadata is missing')
    const resolution = metadata.resolution
    if (Object.keys(resolution).some(field => !['integrity', 'tarball'].includes(field)) || typeof resolution.integrity !== 'string'
      || !/^sha(?:1|256|384|512)-[A-Za-z0-9+/=]+$/u.test(resolution.integrity)) fail('unsupported locked package transport or integrity')
    if (resolution.tarball !== undefined) {
      if (typeof resolution.tarball !== 'string') fail('invalid locked tarball')
      if (resolution.tarball.startsWith('file:')) {
        if (!allowedArtifacts.has(resolution.tarball.replaceAll('\\', '/'))) fail('locked file dependency has no retained artifact owner')
      } else {
        const url = new URL(resolution.tarball)
        if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '') fail('unsafe locked registry tarball')
      }
    }
    snapshots[key] = snapshot; packages[packageKey] = metadata
    for (const field of ['dependencies', 'optionalDependencies']) {
      const edges = snapshot[field]
      if (edges === undefined) continue
      if (!record(edges)) fail('invalid locked dependency edges')
      for (const [dependency, version] of Object.entries(edges)) visit(dependency, version)
    }
  }
  for (const name of names) {
    const entry = lock.dependencies[name]
    if (!record(entry) || typeof entry.specifier !== 'string') fail(`missing locked root: ${name}`)
    roots[name] = entry; visit(name, entry.version)
  }
  return stable({ roots, snapshots, packages, runtimeLinks })
}
function environment(home: string): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/iu.test(key)) result[key] = value
  }
  return { ...result, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home,
    npm_config_userconfig: join(home, 'empty.npmrc'), npm_config_globalconfig: join(home, 'empty-global.npmrc'),
    npm_config_ignore_scripts: 'true', npm_config_ignore_pnpmfile: 'true', CI: 'true' }
}

/**
 * Construct a stage-only backend scoped to one real profile and packaged runtime.
 * Retained packages reconstruct from an existing frozen lock; their reachable versions, peer edges and integrity must remain unchanged.
 * Bundle installs use owned snapshots or exact pnpm registry resolutions;
 * unsupported transports/configuration and build approvals fail closed.
 * Direct registry roots may be updated or removed explicitly; unrelated unowned source/selection collisions remain protected.
 * Private provisioning supports one required resource-bound release entry;
 * user ownership, disabled targets and stale extra release inventory require explicit resolution.
 * Records survive process disconnect; power-loss durability of the candidate tree is not certified.
 * The launcher must enumerate global patches and all external overlay/include inputs in configPaths; unknown inputs require refusal.
 * @param options - Launcher-owned filesystem locations and bounded, cancellation-aware IO implementations.
 * @returns Protocol v1 backend; PREPARED survives disconnect/in-flight abort,
 * while a later explicit cancel discards an unactivated candidate with a durable tombstone.
 */
export function createDesktopProfilePackageTransactions(options: DesktopProfilePackageStagingOptions): DesktopProfilePackageTransactions {
  const missingProfile = lstatSync(options.profile, { throwIfNoEntry: false }) === undefined
  if (missingProfile && options.recoveryTransactionId === undefined) fail('active profile is missing; explicit owned recovery is required')
  if (!isAbsolute(options.profile)) fail('profile must be an absolute path')
  const profile = missingProfile
    ? join(canonical(dirname(options.profile), true), basename(options.profile)) : canonical(options.profile, true)
  const runtimeDir = canonical(options.runtimeDir, true)
  const installAnchor = canonical(options.installAnchor, false)
  const dependencyRegistry = registryUrl(options.dependencyRegistry)
  const checkSourceRegistry = (mutation: ProfilePackageMutation): void => {
    if (mutation.kind === 'install' && mutation.source.type === 'githubRelease' && mutation.source.dependencyRegistry !== undefined
      && registryUrl(mutation.source.dependencyRegistry) !== dependencyRegistry) fail('source registry conflicts with the explicit profile registry policy')
  }
  if (!inside(runtimeDir, installAnchor) || inside(profile, runtimeDir) || inside(runtimeDir, profile)) fail('foreign runtime/install anchor or overlapping profile')
  canonical(join(runtimeDir, DESKTOP_RUNTIME_FILE), false)
  const runtime: DesktopRuntimeDescriptor = readDesktopRuntime(runtimeDir)
  requireRuntimeSchema(runtime.schemaVersion)
  if (runtime.platform !== process.platform || runtime.arch !== process.arch) fail('incompatible runtime')
  const runtimeFingerprint = (): string => {
    canonical(runtimeDir, true); canonical(installAnchor, false); canonical(join(runtimeDir, DESKTOP_RUNTIME_FILE), false)
    const fileIdentity = (files: DesktopRuntimeDescriptor['files']): string => JSON.stringify(files.map(file =>
      [file.path, file.bytes, file.sha256, process.platform === 'win32' ? false : file.executable]))
    if (fileIdentity(inventoryDesktopRuntime(runtimeDir)) !== fileIdentity(runtime.files)) fail('runtime file inventory changed')
    return hash(JSON.stringify([hash(readFileSync(join(runtimeDir, DESKTOP_RUNTIME_FILE))), hash(readFileSync(installAnchor)),
      runtime.sharedPackages.map((shared) => {
        const path = canonical(runtimePath(runtimeDir, shared.path), true)
        if (!inside(runtimeDir, path)) fail('shared package escapes runtime')
        const manifest = json(join(path, 'package.json'))
        if (!record(manifest) || manifest.name !== shared.name || manifest.version !== shared.version) fail('runtime shared package identity changed')
        return [shared.name, hash(readFileSync(join(path, 'package.json'))) ]
      })]))
  }
  if (!strings(options.configPaths)) fail('launcher must enumerate all external configuration inputs')
  const configPaths = options.configPaths.map((path) => {
    if (!isAbsolute(path)) fail('external configuration paths must be absolute')
    return join(canonical(dirname(path), true), basename(path))
  }).sort()
  if (new Set(configPaths).size !== configPaths.length) fail('duplicate external configuration input')
  const configInputs = (): ConfigInput[] => configPaths.map((path) => {
    canonical(dirname(path), true)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat === undefined) return { path, sha256: null }
    canonical(path, false)
    if (stat.size > 8 * 1024 * 1024) fail('external configuration exceeds its bound')
    return { path, sha256: hash(readFileSync(path)) }
  })
  if ((options.provisioningPlan === undefined) !== (options.provisioningPlanFile === undefined)) fail('provisioning requires both fixed plan data and its resource file')
  let planResource: DesktopProvisioningPlanResource | undefined
  let fixedSource: DesktopPluginProvisioningEntry['source'] | undefined
  if (options.provisioningPlan !== undefined && options.provisioningPlanFile !== undefined) {
    const file = canonical(options.provisioningPlanFile, false)
    if (configPaths.includes(file)) fail('the JSON provisioning resource is not a YAML configuration input')
    const supplied = parseDesktopPluginProvisioningPlan(options.provisioningPlan)
    const disk = parseDesktopPluginProvisioningPlan(json(file))
    if (stable(supplied) !== stable(disk) || disk.plugins.length !== 1 || disk.plugins[0]?.required !== true) fail('only one required packaged provisioning entry is supported')
    fixedSource = disk.plugins[0].source
    checkSourceRegistry({ kind: 'install', source: fixedSource })
    planResource = { file, sha256: hash(readFileSync(file)), planSha256: desktopPluginProvisioningPlanSha256(disk) }
  }
  const owner: Identity = { profile, runtimeDir, installAnchor, runtimeFingerprint: runtimeFingerprint(), dependencyRegistry, configPaths,
    ...(planResource === undefined ? {} : { provisioningPlanResource: planResource }) }
  const checkPlanResource = (): void => {
    if (planResource === undefined) return
    canonical(planResource.file, false)
    if (hash(readFileSync(planResource.file)) !== planResource.sha256
      || desktopPluginProvisioningPlanSha256(parseDesktopPluginProvisioningPlan(json(planResource.file))) !== planResource.planSha256) fail('packaged provisioning resource changed')
  }
  const intentHash = (mutation: ProfilePackageMutation, provisioning?: DesktopPreparedProvisioningContext): string =>
    hash(JSON.stringify(provisioning === undefined ? mutation : { mutation, provisioning }))
  const requestKey = (mutation: ProfilePackageMutation, provisioning = false): string => hash(JSON.stringify(provisioning
    ? { mutation, planSha256: planResource?.planSha256, planResourceSha256: planResource?.sha256 } : mutation))
  const parseProvisioning = (value: unknown, mutation: ProfilePackageMutation): DesktopPreparedProvisioningContext | undefined => {
    if (value === undefined) return undefined
    if (fixedSource === undefined || planResource === undefined || !record(value)
      || Object.keys(value).sort().join(',') !== 'ownerDecision,planResourceSha256,planSha256,previousSelected,schemaVersion,source'
      || value.schemaVersion !== 1 || value.planSha256 !== planResource.planSha256 || value.planResourceSha256 !== planResource.sha256
      || (value.ownerDecision !== 'create-release-owned' && value.ownerDecision !== 'replace-release-owned')
      || typeof value.previousSelected !== 'boolean'
      || value.previousSelected !== (value.ownerDecision === 'replace-release-owned')
      || mutation.kind !== 'install' || mutation.enabled !== undefined || mutation.approvedBuilds !== undefined
      || stable(parseDesktopPluginSource(value.source)) !== stable(fixedSource) || stable(mutation.source) !== stable(fixedSource)) fail('invalid or foreign private provisioning intent')
    return { schemaVersion: 1, planSha256: planResource.planSha256, planResourceSha256: planResource.sha256,
      source: parseDesktopPluginSource(value.source) as DesktopPluginProvisioningEntry['source'],
      ownerDecision: value.ownerDecision, previousSelected: value.previousSelected }
  }
  const chooseProvisioning = (base = profile, persistedCreation = false): DesktopPreparedProvisioningContext => {
    checkPlanResource()
    if (fixedSource === undefined || planResource === undefined) fail('no packaged provisioning plan is configured')
    const name = fixedSource.packageName
    if (Object.hasOwn(readDesktopPluginUserIntents(base).removed, name)) fail('packaged provisioning preserves explicit user removal')
    readProvisioningEvidence(base)
    const store = readDesktopPluginReceipts(base)
    const manifest = json(join(base, 'package.json'))
    if (!record(manifest) || !record(manifest.dsh) || !record(manifest.dsh.profile) || !array(manifest.dsh.profile.bundles)
      || (manifest.dependencies !== undefined && !record(manifest.dependencies))) fail('invalid provisioning base profile')
    if (Object.entries(store.owners).some(([entry, ownership]) => ownership === 'release' && entry !== name)) fail('additional release-owned inventory requires broader reconciliation')
    const selector = manifest.dependencies?.[name]
    const receipt = store.receipts[name]
    const selected = manifest.dsh.profile.bundles.includes(name)
    let ownerDecision: DesktopPreparedProvisioningContext['ownerDecision']
    if (selector === undefined && receipt === undefined && !selected && readDesktopPackageLocks(base)[name] === undefined) {
      if (options.provisioningProfileCreated !== true && !persistedCreation) fail('packaged provisioning requires trusted fresh-profile authorization')
      ownerDecision = 'create-release-owned'
    }
    else {
      if (receipt === undefined || store.owners[name] !== 'release' || selector !== `file:.desktop-plugin-artifacts/${receipt.artifactSha256}.tgz`) fail('packaged provisioning conflicts with user-owned or retargeted state')
      if (!selected) fail('required packaged target is disabled; explicit user resolution is required')
      ownerDecision = 'replace-release-owned'
    }
    return { schemaVersion: 1, planSha256: planResource.planSha256, planResourceSha256: planResource.sha256,
      source: fixedSource, ownerDecision, previousSelected: selected }
  }
  configInputs()
  const prefix = `.${basename(profile)}.package-stage-`
  const directory = (id: string): string => join(dirname(profile), `${prefix}${parseProfileTransactionId(id)}`)
  const running = new Map<string, Running>()
  const timeout = options.operationTimeoutMs ?? 120_000
  const wait = options.leaseWaitMs ?? 120_000
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || !Number.isSafeInteger(wait) || wait < 0) fail('invalid operation limits')
  const checkIdentity = (recovery = false): void => {
    checkPlanResource()
    if (recovery && lstatSync(profile, { throwIfNoEntry: false }) === undefined) {
      if (join(canonical(dirname(profile), true), basename(profile)) !== owner.profile) fail('profile parent identity changed')
    } else if (canonical(profile, true) !== owner.profile) fail('profile identity changed')
    if (runtimeFingerprint() !== owner.runtimeFingerprint) fail('profile/runtime identity changed')
  }
  const readDiscard = (id: string, value: Pick<PreparedRecord, 'owner' | 'requestFingerprint' | 'candidateFingerprint'>): 'discarding' | 'discarded' | undefined => {
    const path = join(directory(id), DISCARD)
    if (!existsSync(path)) return undefined
    const marker = json(path)
    if (!record(marker) || Object.keys(marker).sort().join(',') !== 'candidateFingerprint,ownerFingerprint,requestFingerprint,schemaVersion,state,transactionId'
      || marker.schemaVersion !== 1 || marker.transactionId !== id || marker.ownerFingerprint !== hash(JSON.stringify(value.owner))
      || marker.requestFingerprint !== value.requestFingerprint || marker.candidateFingerprint !== value.candidateFingerprint
      || (marker.state !== 'discarding' && marker.state !== 'discarded')) fail('invalid or foreign discard marker')
    return marker.state
  }
  const readPrepared = (id: string, recovery = false, allowDiscard = false): PreparedRecord | undefined => {
    checkIdentity(recovery)
    const root = directory(id)
    if (!existsSync(root)) return undefined
    canonical(root, true)
    const identity = json(join(root, OWNER))
    if (JSON.stringify(identity) !== JSON.stringify(owner)) fail('foreign transaction owner')
    if (!existsSync(join(root, RECORD))) return undefined
    const value = json(join(root, RECORD))
    if (!record(value) || value.schemaVersion !== 1 || JSON.stringify(value.owner) !== JSON.stringify(owner)
      || Object.keys(value).filter(key => key !== 'verifiedRelease' && key !== 'provisioning' && key !== 'registryTarget').sort().join(',') !== 'baseFiles,baseGraphFingerprint,baseInputs,candidateFingerprint,mutation,owner,requestFingerprint,result,schemaVersion'
      || typeof value.requestFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.requestFingerprint)
      || typeof value.candidateFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.candidateFingerprint)
      || typeof value.baseGraphFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(value.baseGraphFingerprint)
      || !array(value.baseFiles) || !array(value.baseInputs)) fail('invalid prepared record')
    const result = parseProfilePreparedChange(value.result)
    if (result.transactionId !== id || result.health !== 'pending'
      || hash(JSON.stringify({ owner, files: value.baseFiles, inputs: value.baseInputs })) !== result.baseFingerprint) fail('prepared identity mismatch')
    const mutation = parseMutation(value.mutation)
    checkSourceRegistry(mutation)
    const provisioning = parseProvisioning(value.provisioning, mutation)
    if (intentHash(mutation, provisioning) !== value.requestFingerprint) fail('prepared request mismatch')
    let verifiedRelease: Omit<DesktopVerifiedPluginArtifact, 'path'> | undefined
    if (mutation.kind === 'install' && mutation.source.type === 'githubRelease') {
      const verified = value.verifiedRelease
      if (!record(verified) || Object.keys(verified).sort().join(',') !== 'assetId,packageName,releaseId,source,version'
        || !Number.isSafeInteger(verified.releaseId) || (verified.releaseId as number) <= 0
        || verified.assetId !== mutation.source.assetId || verified.packageName !== mutation.source.packageName
        || verified.version !== mutation.source.version || result.packageName !== mutation.source.packageName
        || JSON.stringify(parseDesktopPluginSource(verified.source)) !== JSON.stringify(mutation.source)) fail('invalid prepared Release evidence')
      verifiedRelease = { source: mutation.source, releaseId: verified.releaseId as number, assetId: mutation.source.assetId,
        packageName: mutation.source.packageName, version: mutation.source.version }
    } else if (value.verifiedRelease !== undefined) fail('unexpected Release evidence')
    const registryRequest = registryRequestOf(mutation, profile)
    let registryTarget: DesktopPreparedRegistryTarget | undefined
    if (registryRequest !== undefined) {
      const target = value.registryTarget
      if (!record(target) || Object.keys(target).filter(key => key !== 'tarball').sort().join(',') !== 'integrity,packageKey,packageName,registry,requestedSpec,schemaVersion,version'
        || target.schemaVersion !== 1 || target.requestedSpec !== registryRequest.spec || target.registry !== dependencyRegistry
        || target.packageName !== registryRequest.name || target.packageName !== result.packageName
        || typeof target.version !== 'string' || valid(target.version) !== target.version
        || typeof target.packageKey !== 'string' || target.packageKey.length > 4096 || /[\u0000-\u001f\u007f]/u.test(target.packageKey)
        || (target.packageKey !== `${target.packageName}@${target.version}` && (!target.packageKey.startsWith(`${target.packageName}@${target.version}(`) || !target.packageKey.endsWith(')')))
        || provisioning !== undefined || verifiedRelease !== undefined) fail('invalid registry prepared evidence')
      const tarball = registryTarball(target.tarball)
      registryTarget = { schemaVersion: 1, requestedSpec: registryRequest.spec, registry: dependencyRegistry,
        packageName: registryRequest.name, version: target.version, packageKey: target.packageKey,
        integrity: registryIntegrity(target.integrity), ...(tarball === undefined ? {} : { tarball }) }
    } else if (value.registryTarget !== undefined) fail('unexpected registry evidence')
    const discarded = readDiscard(id, {
      owner, requestFingerprint: value.requestFingerprint, candidateFingerprint: value.candidateFingerprint,
    })
    if (discarded !== undefined && !allowDiscard) fail(discarded === 'discarded' ? 'transaction was explicitly discarded' : 'discard cleanup is incomplete')
    if (!recovery) {
      const candidate = join(root, 'profile')
      canonical(candidate, true)
      if (fingerprint(inventory(candidate, true, runtimeDir)) !== value.candidateFingerprint) fail('prepared files changed')
      if (registryRequest !== undefined && stable(deriveRegistryTarget(candidate, registryRequest, dependencyRegistry)) !== stable(registryTarget)) fail('prepared registry resolution changed')
    }
    return { schemaVersion: 1, owner, requestFingerprint: value.requestFingerprint, result,
      baseFiles: value.baseFiles as InventoryEntry[], baseInputs: value.baseInputs as ConfigInput[],
      baseGraphFingerprint: value.baseGraphFingerprint,
      candidateFingerprint: value.candidateFingerprint, mutation,
      ...(provisioning === undefined ? {} : { provisioning }),
      ...(registryTarget === undefined ? {} : { registryTarget }),
      ...(verifiedRelease === undefined ? {} : { verifiedRelease }) }
  }
  const activationInput = (id: string, value: PreparedRecord): DesktopPreparedPackageActivation => ({
    transactionDir: directory(id), candidateDir: join(directory(id), 'profile'), rollbackDir: join(directory(id), 'rollback'),
    baseGraphFingerprint: value.baseGraphFingerprint, owner: { ...owner, configPaths: [...owner.configPaths],
      ...(owner.provisioningPlanResource === undefined ? {} : { provisioningPlanResource: { ...owner.provisioningPlanResource } }) },
    intentFingerprint: value.requestFingerprint,
    ...(value.provisioning === undefined ? {} : { provisioning: value.provisioning }),
    mutation: value.mutation, prepared: value.result, candidateFingerprint: value.candidateFingerprint,
    ...(value.verifiedRelease === undefined ? {} : { verifiedRelease: value.verifiedRelease }),
    ...(value.registryTarget === undefined ? {} : { registryTarget: value.registryTarget }),
  })
  const pending = (id: string, listing = false): ProfilePreparedPackageChange | undefined => {
    const value = readPrepared(id, true, true)
    if (value === undefined) return undefined
    const discarded = readDiscard(id, value)
    const phase = readDesktopPackageActivationPhase(activationInput(id, value))
    if (discarded !== undefined && phase !== undefined) fail('transaction has conflicting activation and discard journals')
    if (discarded === 'discarded' || phase === 'committed' || phase === 'rolled-back') return undefined
    if (discarded === 'discarding') fail('discard cleanup is incomplete; retry explicit discard')
    if (phase !== undefined) {
      if (listing) return undefined
      fail('activation is in progress or requires recovery')
    }
    return readPrepared(id)?.result
  }
  const checkExternalInputs = (value: PreparedRecord): void => {
    if (JSON.stringify(configInputs()) !== JSON.stringify(value.baseInputs)) fail('external configuration changed since preparation')
  }
  const verifyTree = (id: string, role: 'candidate' | 'active' | 'rollback', receiptTransition?: DesktopReceiptTransition): DesktopPreparedPackageActivation => {
    const value = readPrepared(id, true)
    if (value === undefined) fail('transaction is not prepared')
    checkExternalInputs(value)
    const input = activationInput(id, value)
    const path = role === 'candidate' ? input.candidateDir : role === 'active' ? owner.profile : input.rollbackDir
    canonical(path, true)
    // A renamed rollback can have temporarily dangling absolute links. Hash their exact recorded bytes, never follow them.
    let files = inventory(path, true, runtimeDir, role !== 'rollback')
    if (receiptTransition !== undefined) {
      if (role !== 'active') fail('receipt transitions apply only to the active tree')
      const proof = validateDesktopReceiptTransition(input, receiptTransition)
      const selection = readProfileManifest('dsh', path).dsh?.profile?.bundles
      if (selection?.includes(input.prepared.packageName) !== true) fail('a disabled package cannot earn an active receipt')
      desktopPackageReceiptPosition(input, proof)
      for (const transition of desktopReceiptFileTransitions(proof)) {
        const before = transition.before
        if (before === null) files = files.filter(entry => entry.path !== transition.file)
        else files = files.map(entry => entry.path === transition.file ? { ...entry, sha256: desktopReceiptHash(before) } : entry)
      }
    }
    const actual = fingerprint(files)
    if (actual !== (role === 'rollback' ? value.baseGraphFingerprint : value.candidateFingerprint)) fail(`activation ${role} tree changed`)
    if (role !== 'rollback' && value.registryTarget !== undefined) {
      const request = registryRequestOf(value.mutation, profile)
      if (request === undefined || stable(deriveRegistryTarget(path, request, dependencyRegistry)) !== stable(value.registryTarget)) fail('activation registry resolution changed')
    }
    if (role === 'rollback' && value.provisioning !== undefined && stable(chooseProvisioning(path, value.provisioning.ownerDecision === 'create-release-owned')) !== stable(value.provisioning)) fail('original provisioning ownership no longer matches')
    return input
  }
  if (missingProfile) verifyTree(parseProfileTransactionId(options.recoveryTransactionId), 'rollback')
  const assessLocked = async (): Promise<DesktopProvisioningAssessment> => {
    if (fixedSource === undefined || planResource === undefined) fail('no packaged provisioning plan is configured')
    const base = { packageName: fixedSource.packageName, planSha256: planResource.planSha256, planResourceSha256: planResource.sha256 }
    try {
      checkIdentity()
      const intents = readDesktopPluginUserIntents(profile)
      readProvisioningEvidence(profile)
      const receipts = readDesktopPluginReceipts(profile)
      const locks = readDesktopPackageLocks(profile)
      const manifest = json(join(profile, 'package.json'))
      if (!record(manifest) || !record(manifest.dsh) || !record(manifest.dsh.profile) || !array(manifest.dsh.profile.bundles)
        || manifest.dsh.profile.bundles.some(name => typeof name !== 'string' || !NAME.test(name))
        || (manifest.dependencies !== undefined && !record(manifest.dependencies))) fail('invalid provisioning base profile')
      if (Object.hasOwn(intents.removed, base.packageName)) return { ...base, status: 'preserved-user-choice', reason: 'removed' }
      const selector = manifest.dependencies?.[base.packageName]
      const receipt = receipts.receipts[base.packageName]
      const selected = manifest.dsh.profile.bundles.includes(base.packageName)
      if (selector !== undefined && !selected) return { ...base, status: 'preserved-user-choice', reason: 'disabled' }
      if (selector === undefined && receipt === undefined && locks[base.packageName] === undefined && !selected) {
        if (Object.entries(receipts.owners).some(([name, ownership]) => ownership === 'release' && name !== base.packageName)) fail('additional release-owned inventory requires broader reconciliation')
        return options.provisioningProfileCreated === true ? { ...base, status: 'provisionable', reason: 'fresh-profile' }
          : { ...base, status: 'preserved-user-choice', reason: 'ambiguous-legacy' }
      }
      if (receipt === undefined || selector !== `file:.desktop-plugin-artifacts/${receipt.artifactSha256}.tgz` || !selected) {
        return { ...base, status: 'preserved-user-choice', reason: 'installed-override' }
      }
      const packageOwner = receipts.owners[base.packageName]
      if (packageOwner !== 'user' && packageOwner !== 'release') fail('planned package has no validated owner')
      const rawReceipts = json(join(profile, DESKTOP_PLUGIN_RECEIPTS_FILE))
      if (packageOwner === 'user' && record(rawReceipts) && !Object.hasOwn(rawReceipts, 'owners')) return { ...base, status: 'preserved-user-choice', reason: 'ambiguous-legacy' }
      if (Object.entries(receipts.owners).some(([name, ownership]) => ownership === 'release' && name !== base.packageName)) fail('additional release-owned inventory requires broader reconciliation')
      if (stable(receipt.source) !== stable(fixedSource)) {
        return packageOwner === 'release' ? { ...base, status: 'provisionable', reason: 'release-owned-update' }
          : { ...base, status: 'preserved-user-choice', reason: 'installed-override' }
      }
      const baseFingerprint = hash(JSON.stringify({ owner, files: inventory(profile, false), inputs: configInputs() }))
      const baseGraphFingerprint = fingerprint(inventory(profile, true, runtimeDir, false))
      try { await verifyInstalledSource(profile, fixedSource, AbortSignal.timeout(timeout)) } catch (error) {
        if (packageOwner === 'release') return { ...base, status: 'provisionable', reason: 'release-owned-repair' }
        throw error
      }
      const graph = inventory(profile, true, runtimeDir, true, false)
      checkSharedPackages(profile, graph, runtime)
      if (fingerprint(graph) !== baseGraphFingerprint) fail('installed graph changed during payload comparison')
      checkIdentity()
      if (baseFingerprint !== hash(JSON.stringify({ owner, files: inventory(profile, false), inputs: configInputs() }))
        || baseGraphFingerprint !== fingerprint(inventory(profile, true, runtimeDir, true, false))) fail('profile changed during exact assessment')
      const exact = { ...base, status: 'exact-satisfied' as const, packageOwner, qualification: 'pending' as const,
        owner: { ...owner, configPaths: [...owner.configPaths],
          ...(owner.provisioningPlanResource === undefined ? {} : { provisioningPlanResource: { ...owner.provisioningPlanResource } }) },
        baseFingerprint, baseGraphFingerprint }
      return { ...exact, assessmentFingerprint: hash(stable(exact)) }
    } catch (error) {
      return { ...base, status: 'invalid-evidence', diagnostic: (error instanceof Error ? error.message : String(error)).slice(0, 2048) }
    }
  }
  const prepare = async (
    id: string, mutation: ProfilePackageMutation, key: string, signal: AbortSignal, provisioningRequested = false,
  ): Promise<ProfilePreparedPackageChange> => {
    // The common lease checks cancellation before/after its bounded wait. Never abandon its pending callback.
    return withProfilePackageLease(profile, async () => {
      const previous = readPrepared(id, true)
      if (previous !== undefined) {
        if (readDesktopPackageActivationPhase(activationInput(id, previous)) !== undefined) fail('activation already owns this transaction')
        if (requestKey(previous.mutation, previous.provisioning !== undefined) !== key) fail('transaction id already binds a different mutation or purpose')
        const checked = readPrepared(id)
        if (checked === undefined) fail('prepared record disappeared during validation')
        return checked.result
      }
      signal.throwIfAborted()
      const registryRequest = registryRequestOf(mutation, profile)
      const knownName = mutation.kind === 'remove' ? mutation.name : mutation.source.type === 'githubRelease' ? mutation.source.packageName : registryRequest?.name
      if (knownName !== undefined && runtime.sharedPackages.some(shared => shared.name === knownName)) fail('cannot mutate a runtime-owned package')
      if (provisioningRequested) {
        const assessment = await assessLocked()
        if (assessment.status !== 'provisionable') fail(`private provisioning is not provisionable: ${assessment.status}; ${assessment.status === 'invalid-evidence' ? assessment.diagnostic : assessment.status === 'preserved-user-choice' ? assessment.reason : 'qualify the exact installed graph without restaging'}`)
      }
      const provisioning = provisioningRequested ? chooseProvisioning() : undefined
      const requestFingerprint = intentHash(mutation, provisioning)
      const root = directory(id)
      if (existsSync(root)) fail('incomplete transaction requires explicit recovery; refusing to overwrite it')
      mkdirSync(root, { mode: 0o700 })
      let committed = false
      try {
        durableJson(join(root, OWNER), owner)
        const baseFiles = inventory(profile, false)
        const baseGraphFingerprint = fingerprint(inventory(profile, true, runtimeDir, false))
        const baseInputs = configInputs()
        const baseFingerprint = hash(JSON.stringify({ owner, files: baseFiles, inputs: baseInputs }))
        const candidate = join(root, 'profile')
        snapshot(profile, candidate, baseFiles)
        if (provisioning !== undefined && stable(chooseProvisioning(candidate)) !== stable(provisioning)) fail('provisioning ownership changed while snapshotting')
        prepareProfileRootConfig(candidate)
        readDesktopPluginUserIntents(candidate)
        // User-controlled executable package-manager configuration is never consulted.
        for (const name of ['.npmrc', '.pnpmfile.cjs', 'pnpmfile.cjs']) if (existsSync(join(candidate, name))) fail(`unsupported package-manager configuration: ${name}`)
        const manifestPath = join(candidate, 'package.json')
        const manifest = json(manifestPath)
        if (!record(manifest)) fail('profile manifest must be an object')
        for (const field of ['scripts', 'pnpm', 'workspaces', 'devDependencies', 'optionalDependencies']) {
          if (manifest[field] !== undefined) fail(`unsupported profile manifest field: ${field}`)
        }
        if (manifest.dependencies !== undefined && !record(manifest.dependencies)) fail('invalid profile dependencies')
        const dependencies = { ...manifest.dependencies }
        const originalDependencies = { ...dependencies }
        const locks = Object.assign(Object.create(null) as Record<string, DesktopPackageInstallLock>, readDesktopPackageLocks(candidate))
        const priorProvisioning = readProvisioningEvidence(candidate)
        const receiptStore = readDesktopPluginReceipts(candidate)
        const ownedTarget = (name: string): boolean => {
          const selector = originalDependencies[name]
          const sourceLock = locks[name]
          const receipt = receiptStore.receipts[name]
          return (sourceLock !== undefined && selector === desktopPackageArtifactSpecifier(sourceLock))
            || (receipt !== undefined && selector === `file:.desktop-plugin-artifacts/${receipt.artifactSha256}.tgz`)
        }
        for (const [name, selector] of Object.entries(dependencies)) {
          if (!NAME.test(name) || typeof selector !== 'string') fail('invalid profile dependency')
        }
        const dsh = manifest.dsh
        if (!record(dsh) || !record(dsh.profile) || !strings(dsh.profile.bundles)
          || dsh.profile.bundles.some(name => !NAME.test(name))) fail('invalid profile bundle selection')
        let bundles = [...dsh.profile.bundles]
        if (new Set(bundles).size !== bundles.length) fail('duplicate bundle selection')
        const home = join(root, 'environment')
        mkdirSync(home, { mode: 0o700 })
        writeFileSync(join(home, 'empty.npmrc'), '')
        writeFileSync(join(home, 'empty-global.npmrc'), '')
        const acquisition = join(root, 'acquisition')
        mkdirSync(acquisition, { mode: 0o700 })
        const fetcher: typeof fetch = (input, init) => options.fetcher(input, { ...init,
          signal: AbortSignal.any([signal, ...(init?.signal === undefined || init.signal === null ? [] : [init.signal])]) })
        const pack = async (source: string, archive: string): Promise<void> => {
          signal.throwIfAborted(); await options.packDirectory(source, archive, signal); signal.throwIfAborted()
        }
        let packageName: string
        let registryTarget: DesktopPreparedRegistryTarget | undefined
        let verifiedRelease: Omit<DesktopVerifiedPluginArtifact, 'path'> | undefined
        if (mutation.kind === 'remove') {
          packageName = mutation.name
          if (!ownedTarget(packageName) && !isDirectRegistrySelector(packageName, originalDependencies[packageName], profile)) fail('removal requires an owned source or direct registry dependency')
          Reflect.deleteProperty(dependencies, packageName); Reflect.deleteProperty(locks, packageName)
          bundles = bundles.filter(name => name !== packageName)
        } else if (registryRequest !== undefined) {
          packageName = registryRequest.name
          if ((Object.hasOwn(originalDependencies, packageName) && !ownedTarget(packageName)
            && !isDirectRegistrySelector(packageName, originalDependencies[packageName], profile))
            || (!Object.hasOwn(originalDependencies, packageName) && bundles.includes(packageName))) fail('registry package collides with user-owned nonregistry selection')
          dependencies[packageName] = registryRequest.spec === packageName ? 'latest' : registryRequest.spec.slice(packageName.length + 1)
          Reflect.deleteProperty(locks, packageName)
        } else {
          const source = mutation.source
          let artifact
          if (source.type === 'githubRelease') {
            const verified = await acquireDesktopPluginArtifact(source, acquisition, fetcher, () => { signal.throwIfAborted() })
            verifiedRelease = { source: verified.source, releaseId: verified.releaseId, assetId: verified.assetId,
              packageName: verified.packageName, version: verified.version }
            signal.throwIfAborted()
            // Apply the stricter data-only archive/dependency checks to Release packages too.
            artifact = await acquireDesktopSourcePackage({ kind: 'tarball', spec: verified.path, path: verified.path }, acquisition, pack, fetcher)
          } else {
            const input = parseDesktopPluginInstallSpec(source.spec, profile)
            if (input.kind === 'registry') fail('registry request changed during staging')
            if (input.kind === 'directory' || input.kind === 'tarball') {
              canonical(input.path, input.kind === 'directory')
              if (input.kind === 'directory') inventory(input.path, false)
              if (inside(profile, input.path) || inside(runtimeDir, input.path) || inside(input.path, root)) fail('local input overlaps managed profile/runtime/staging')
            }
            artifact = await acquireDesktopSourcePackage(input, acquisition, pack, fetcher)
          }
          signal.throwIfAborted()
          packageName = artifact.packageName
          if (runtime.sharedPackages.some(shared => shared.name === packageName)) fail('cannot replace a runtime-owned package')
          if ((Object.hasOwn(dependencies, packageName) || bundles.includes(packageName)) && !ownedTarget(packageName)) fail('package collides with user-owned selection')
          const lock: DesktopPackageInstallLock = { packageName, version: artifact.version,
            spec: source.type === 'githubRelease' ? `github-release:${source.owner}/${source.repo}@${source.tag}/${source.asset}` : source.spec,
            resolved: source.type === 'githubRelease' ? `https://github.com/${source.owner}/${source.repo}/releases/download/${encodeURIComponent(source.tag)}/${encodeURIComponent(source.asset)}` : artifact.resolved,
            sha256: artifact.sha256, integrity: artifact.integrity,
            ...(artifact.commit === undefined ? {} : { commit: artifact.commit }) }
          const artifacts = join(candidate, '.desktop-plugin-artifacts')
          mkdirSync(artifacts, { recursive: true, mode: 0o700 })
          const destination = join(artifacts, `${artifact.sha256}.tgz`)
          if (existsSync(destination)) {
            if (hash(readFileSync(destination)) !== artifact.sha256) {
              if (originalDependencies[packageName] !== `file:.desktop-plugin-artifacts/${artifact.sha256}.tgz`) fail('content-addressed artifact collision')
              copyFileSync(artifact.path, destination)
            }
          } else copyFileSync(artifact.path, destination)
          locks[packageName] = lock; dependencies[packageName] = desktopPackageArtifactSpecifier(lock)
        }
        if (mutation.kind === 'install') {
          if (mutation.enabled === false) bundles = bundles.filter(name => name !== packageName)
          else if ((mutation.enabled === true || !Object.hasOwn(originalDependencies, packageName)) && !bundles.includes(packageName)) {
            bundles.push(packageName)
          }
        }
        signal.throwIfAborted()
        if (runtime.sharedPackages.some(shared => shared.name === packageName)) fail('cannot mutate a runtime-owned package')
        // A removed/replaced target is not a retained artifact: its missing/corrupt old bytes must not prevent repair.
        const retained = Object.fromEntries(Object.entries(originalDependencies).filter(([name]) => name !== packageName))
        // Ownership was inferred above from the intact old evidence. Never expose stale target health in the candidate.
        if (priorProvisioning !== undefined
          && (provisioning !== undefined || priorProvisioning.plugins.some(entry => entry.name === packageName))) {
          unlinkSync(join(candidate, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE))
        }
        Reflect.deleteProperty(receiptStore.receipts, packageName); Reflect.deleteProperty(receiptStore.owners, packageName)
        if (existsSync(join(candidate, DESKTOP_PLUGIN_RECEIPTS_FILE))) writeFileSync(join(candidate, DESKTOP_PLUGIN_RECEIPTS_FILE), `${JSON.stringify(receiptStore, undefined, 2)}\n`, { mode: 0o600 })
        const artifacts: DesktopArtifactSpecifier[] = []
        for (const [name, selector] of Object.entries(retained)) {
          const lock = locks[name]
          const receipt = receiptStore.receipts[name]
          if (lock !== undefined) {
            if (selector !== desktopPackageArtifactSpecifier(lock)) fail('source lock does not own retained dependency')
            verifyDesktopPackageArtifact(candidate, lock)
            if (receipt !== undefined && (receipt.artifactSha256 !== lock.sha256 || receipt.version !== lock.version)) fail('conflicting retained source identities')
            artifacts.push({ name, specifier: selector, sha256: lock.sha256 })
          } else if (receipt !== undefined) {
            const specifier = `file:.desktop-plugin-artifacts/${receipt.artifactSha256}.tgz`
            if (selector !== specifier) fail('receipt does not own retained dependency')
            const path = canonical(join(candidate, specifier.slice(5)), false)
            const bytes = readFileSync(path)
            if (bytes.byteLength !== receipt.source.size || hash(bytes) !== receipt.artifactSha256
              || (receipt.source.integrity !== undefined && `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== receipt.source.integrity)) fail('retained receipt artifact integrity mismatch')
            artifacts.push({ name, specifier, sha256: receipt.artifactSha256 })
          } else if (typeof selector !== 'string' || (runtimeLinkIdentity(name, selector, runtime, runtimeDir) === undefined && !isDirectRegistrySelector(name, selector, profile))) fail(`unsupported unowned file/transport dependency: ${name}`)
        }
        if (Object.keys(locks).some(name => !Object.hasOwn(dependencies, name))) fail('orphaned source lock')
        writeDesktopPackageLocks(candidate, locks)
        manifest.dsh = { ...dsh, profile: { ...dsh.profile, bundles } }
        const saveManifest = (selection: Record<string, unknown>): void => {
          manifest.dependencies = selection
          writeFileSync(manifestPath, `${JSON.stringify(manifest, undefined, 2)}\n`, { mode: 0o600 })
        }
        saveManifest(retained)
        normalizeDesktopArtifactSpecifiers(candidate, artifacts)
        const originalLock = readPackageLock(candidate)
        if (Object.keys(retained).length !== 0 && originalLock === undefined) fail('retained dependencies require an existing frozen lock')
        if (originalLock !== undefined) {
          Reflect.deleteProperty(originalLock.dependencies, packageName)
          if (Object.keys(originalLock.dependencies).sort().join('\0') !== Object.keys(retained).sort().join('\0')) fail('profile manifest and lock roots disagree')
          for (const [name, selector] of Object.entries(retained)) {
            const entry = originalLock.dependencies[name]
            if (!record(entry) || entry.specifier !== selector) fail('retained manifest selector does not match the frozen lock')
          }
          savePackageLock(candidate, originalLock)
        }
        const baseline = originalLock === undefined
          ? undefined : retainedGraph(originalLock, Object.keys(retained), artifacts, runtime, runtimeDir)
        const policyPath = join(candidate, 'pnpm-workspace.yaml')
        const policyBytes = existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : undefined
        const policy: unknown = policyBytes === undefined ? {} : load(policyBytes, { schema: JSON_SCHEMA })
        const overrides = Object.fromEntries(runtime.sharedPackages.map(shared => [shared.name, `link:${runtimePath(runtimeDir, shared.path).split(sep).join('/')}`]))
        if (!record(policy) || Object.keys(policy).some(key => !['packages', 'nodeLinker', 'allowBuilds', 'overrides', 'autoInstallPeers', 'strictPeerDependencies', 'strictDepBuilds'].includes(key))
          || (policy.packages !== undefined && stable(policy.packages) !== '["."]')
          || (policy.nodeLinker !== undefined && policy.nodeLinker !== 'hoisted' && policy.nodeLinker !== 'isolated')
          || (policy.overrides !== undefined
            && (!record(policy.overrides) || Object.entries(policy.overrides).some(([name, value]) => value !== overrides[name])))
          || (policy.autoInstallPeers !== undefined && policy.autoInstallPeers !== false)
          || (policy.strictPeerDependencies !== undefined && typeof policy.strictPeerDependencies !== 'boolean')
          || (policy.strictDepBuilds !== undefined && typeof policy.strictDepBuilds !== 'boolean')) fail('unsupported pnpm workspace settings')
        if (policy.allowBuilds !== undefined && (!record(policy.allowBuilds) || Object.entries(policy.allowBuilds).some(([name, value]) => name === '' || /[\u0000-\u001f\u007f]/u.test(name) || (value !== true && value !== false && value !== 'set this to true or false')))) fail('invalid build approval policy')
        const nodeLinker = policy.nodeLinker ?? 'isolated'
        const runPnpm = async (args: readonly string[]): Promise<void> => {
          signal.throwIfAborted()
          const output = await options.pnpmRunner({ cwd: candidate, signal, env: environment(home), args: [
            'pm', `--config.userconfig=${join(home, 'empty.npmrc')}`, `--config.globalconfig=${join(home, 'empty-global.npmrc')}`, ...args,
            '--prod', '--ignore-scripts', '--ignore-pnpmfile', '--pm-on-fail=ignore', '--config.auto-install-peers=false',
            `--registry=${dependencyRegistry}`,
            `--config.node-linker=${nodeLinker}`, `--store-dir=${join(root, 'store')}`,
          ] })
          signal.throwIfAborted()
          if (output.exitCode !== 0 || output.timedOut === true) fail('pnpm graph preparation failed or timed out')
          const currentPolicy = existsSync(policyPath) ? readFileSync(policyPath, 'utf8') : undefined
          if (currentPolicy !== policyBytes) fail('pnpm changed the preserved workspace/build policy')
        }
        if (originalLock !== undefined) {
          await runPnpm(['install', '--frozen-lockfile'])
          const rebuilt = readPackageLock(candidate)
          if (rebuilt === undefined || retainedGraph(rebuilt, Object.keys(retained), artifacts, runtime, runtimeDir) !== baseline) fail('frozen reconstruction changed retained resolutions')
        }
        saveManifest(dependencies)
        const expectedManifest = stable(manifest)
        if (mutation.kind === 'install') {
          const registryCacheArgs: string[] = []
          if (registryRequest !== undefined) {
            const cache = join(root, 'registry-resolution-cache')
            mkdirSync(cache, { mode: 0o700 })
            if (!inside(root, canonical(cache, true))) fail('registry resolution cache escaped its transaction')
            registryCacheArgs.push(`--cache-dir=${cache}`)
          }
          const targetSelector = dependencies[packageName]
          if (typeof targetSelector !== 'string') fail('invalid dependency selector')
          await runPnpm(['add', registryRequest?.spec ?? `./${targetSelector.slice(5)}`, '--save-exact', ...registryCacheArgs, ...(policyBytes === undefined ? [] : ['--workspace-root'])])
          const written = json(manifestPath)
          if (!record(written) || !record(written.dependencies)) fail('pnpm wrote an invalid manifest')
          const specifier = written.dependencies[packageName]
          if (registryRequest !== undefined) {
            const resolved = deriveRegistryTarget(candidate, registryRequest, dependencyRegistry, false)
            written.dependencies[packageName] = dependencies[packageName]
            if (stable(written) !== expectedManifest) fail('pnpm changed more than the expected registry dependency')
            const resolvedLock = readPackageLock(candidate)
            if (resolvedLock === undefined || (baseline !== undefined && retainedGraph(resolvedLock, Object.keys(retained), artifacts, runtime, runtimeDir) !== baseline)) fail('registry resolution changed retained dependencies before exact pinning')
            dependencies[packageName] = resolved.version
            saveManifest(dependencies)
            if (specifier !== resolved.version) {
              // pnpm11 prioritizes the previous/requested range or tag over --save-exact's default.
              // Only the private manifest target is pinned here; pnpm itself must rewrite its importer.
              await runPnpm(['add', `${packageName}@${resolved.version}`, '--save-exact', ...registryCacheArgs, ...(policyBytes === undefined ? [] : ['--workspace-root'])])
              if (stable(json(manifestPath)) !== stable(manifest)) fail('pnpm changed the manifest during exact registry pinning')
            }
            registryTarget = deriveRegistryTarget(candidate, registryRequest, dependencyRegistry)
            if (stable(registryTarget) !== stable(resolved)) fail('registry identity changed between resolution and exact pinning')
          } else {
            if (typeof specifier === 'string') written.dependencies[packageName] = specifier.replaceAll('\\', '/')
            if (stable(written) !== expectedManifest) fail('pnpm changed checked profile selection')
            saveManifest(dependencies)
            const targetLock = locks[packageName]
            if (targetLock === undefined) fail('new source has no snapshot lock')
            artifacts.push({ name: packageName, specifier: desktopPackageArtifactSpecifier(targetLock), sha256: targetLock.sha256 })
            normalizeDesktopArtifactSpecifiers(candidate, artifacts)
          }
        } else if (originalLock === undefined) await runPnpm(['install', '--lockfile-only'])
        const finalLock = readPackageLock(candidate)
        if (finalLock === undefined || (baseline !== undefined && retainedGraph(finalLock, Object.keys(retained), artifacts, runtime, runtimeDir) !== baseline)) fail('package mutation changed retained resolutions or integrity')
        retainedGraph(finalLock, Object.keys(dependencies), artifacts, runtime, runtimeDir)
        const graphFiles = inventory(candidate, true, runtimeDir)
        checkSharedPackages(candidate, graphFiles, runtime)
        // Validate actual resolution directly; never use resolveBundleDir's installation fallback for new packages.
        for (const [name, selector] of Object.entries(dependencies)) {
          const path = realpathSync(join(candidate, 'node_modules', name))
          const shared = runtime.sharedPackages.find(item => item.name === name)
          if (shared === undefined ? !inside(candidate, path) : path !== realpathSync(runtimePath(runtimeDir, shared.path))) fail('dependency resolves outside its assigned owner')
          const installed = json(join(path, 'package.json'))
          const expectedVersion = locks[name]?.version ?? receiptStore.receipts[name]?.version
          if (!record(installed) || installed.name !== name || (expectedVersion !== undefined && installed.version !== expectedVersion)) fail('resolved package identity mismatch')
          if (typeof selector !== 'string') fail('invalid dependency selector')
        }
        for (const name of bundles) {
          const local = Object.hasOwn(dependencies, name)
          const shared = runtime.sharedPackages.find(item => item.name === name)
          let path: string
          if (local) path = realpathSync(join(candidate, 'node_modules', name))
          else {
            if (shared === undefined) fail('bundle has no explicit local/runtime owner')
            path = runtimePath(runtimeDir, shared.path)
          }
          const metadata = readProfileManifest('dsh', path)
          const patch = metadata.dsh?.bundle?.patch
          if (typeof patch !== 'string') fail('selected package is not an official profile bundle')
          const patchPath = resolve(path, patch)
          if (!inside(path, patchPath) || !inside(path, canonical(patchPath, false))) fail('bundle patch escapes its package')
          loadOverlayPatches('dsh', patchPath)
        }
        // Validate disabled installed bundles as well: their package source is not allowed to evade YAML validation.
        if (mutation.kind === 'install' && !bundles.includes(packageName)) {
          const path = realpathSync(join(candidate, 'node_modules', packageName))
          const patch = readProfileManifest('dsh', path).dsh?.bundle?.patch
          if (typeof patch !== 'string' || !inside(path, resolve(path, patch))) fail('installed package has no confined bundle patch')
          const patchPath = canonical(resolve(path, patch), false)
          if (!inside(path, patchPath)) fail('bundle patch escapes package')
          loadOverlayPatches('dsh', patchPath)
        }
        if (mutation.kind === 'remove') markDesktopPluginRemoved(candidate, packageName, planResource?.planSha256)
        else clearDesktopPluginRemoval(candidate, packageName)
        // The base inventory binds the original approval bytes; candidate records the explicit shared graph policy.
        removeOwnedTree(acquisition)
        checkIdentity()
        if (hash(JSON.stringify({ owner, files: inventory(profile, false), inputs: configInputs() })) !== baseFingerprint) fail('active profile changed during staging')
        if (fingerprint(inventory(profile, true, runtimeDir, false)) !== baseGraphFingerprint) fail('active package graph changed during staging')
        const candidateFingerprint = fingerprint(inventory(candidate, true, runtimeDir))
        const result: ProfilePreparedPackageChange = { transactionId: id, state: 'prepared', packageName, baseFingerprint, health: 'pending' }
        const prepared: PreparedRecord = { schemaVersion: 1, owner, requestFingerprint, result, baseFiles, baseInputs,
          baseGraphFingerprint, candidateFingerprint, mutation,
          ...(provisioning === undefined ? {} : { provisioning }),
          ...(registryTarget === undefined ? {} : { registryTarget }),
          ...(verifiedRelease === undefined ? {} : { verifiedRelease }) }
        signal.throwIfAborted()
        try { durableJson(join(root, RECORD), prepared) } catch (error) {
          // Rename may have succeeded before a directory flush failed. Never erase or report cancellation of that record.
          if (!existsSync(join(root, RECORD))) throw error
          committed = true
          const recovered = readPrepared(id)
          if (recovered === undefined) throw error
          return recovered.result
        }
        committed = true
        return result
      } catch (primary) {
        if (!committed) {
          try { removeOwnedTree(root) } catch (cleanup) {
            throw new AggregateError([primary, cleanup], 'desktop package staging: preparation failed and cleanup is incomplete', { cause: primary })
          }
        }
        throw primary
      }
    }, wait, signal)
  }
  const stageRequest = async (
    requestId: string, request: ProfilePackageMutation, externalSignal: AbortSignal, provisioningRequested: boolean,
  ): Promise<ProfilePreparedPackageChange> => {
    const id = parseProfileTransactionId(requestId)
    const mutation = parseMutation(request)
    checkSourceRegistry(mutation)
    const key = requestKey(mutation, provisioningRequested)
    const prepared = readPrepared(id, true)
    if (prepared !== undefined) {
      if (readDesktopPackageActivationPhase(activationInput(id, prepared)) !== undefined) fail('activation already owns this transaction')
      if (requestKey(prepared.mutation, prepared.provisioning !== undefined) !== key) fail('transaction id already binds a different mutation or purpose')
      const checked = readPrepared(id)
      if (checked === undefined) fail('prepared record disappeared during validation')
      return checked.result
    }
    const existing = running.get(id)
    if (existing !== undefined) {
      if (existing.requestKey !== key) fail('request id reused for a different mutation or purpose')
      return existing.done
    }
    const abort = new AbortController()
    const signal = AbortSignal.any([abort.signal, externalSignal, AbortSignal.timeout(timeout)])
    const done = prepare(id, mutation, key, signal, provisioningRequested)
    const control: Running = { abort, requestKey: key, done }
    running.set(id, control)
    try { return await done } finally { if (running.get(id) === control) running.delete(id) }
  }
  return {
    protocolVersion: 1,
    async assessProvisioning() { return withProfilePackageLease(profile, assessLocked, wait) },
    async commitSatisfiedProvisioning(expectedAssessmentFingerprint) {
      if (!/^[a-f0-9]{64}$/u.test(expectedAssessmentFingerprint)) fail('invalid exact-assessment fingerprint')
      return withProfilePackageLease(profile, async () => {
        const assessment = await assessLocked()
        if (assessment.status !== 'exact-satisfied' || assessment.assessmentFingerprint !== expectedAssessmentFingerprint) fail('exact assessment is stale or no longer satisfied; re-assess and verify current Host health')
        if (fixedSource === undefined || planResource === undefined) fail('no packaged provisioning plan is configured')
        const receiptPath = join(profile, DESKTOP_PLUGIN_RECEIPTS_FILE)
        const receiptBytes = readFileSync(receiptPath)
        const receipt = readDesktopPluginReceipts(profile).receipts[fixedSource.packageName]
        if (receipt === undefined) fail('qualified receipt disappeared')
        const state = buildDesktopProvisioningState({ schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: fixedSource }] }, receipt)
        const path = join(profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE)
        const expectedBytes = `${JSON.stringify(state, undefined, 2)}\n`
        if (existsSync(path) && readFileSync(path, 'utf8') === expectedBytes) return state
        durableJson(path, state, join(profile, `.provisioning-state-${randomUUID()}.tmp`))
        if (!readFileSync(receiptPath).equals(receiptBytes)) fail('receipt bytes changed during baseline commit')
        const observed = readProvisioningEvidence(profile)
        if (observed === undefined || stable(observed) !== stable(state)) fail('qualified state write did not settle')
        return observed
      }, wait)
    },
    stage(requestId, request, signal) { return stageRequest(requestId, request, signal, false) },
    async stageProvisioning(requestId, signal) {
      if (fixedSource === undefined || planResource === undefined) fail('no packaged provisioning plan is configured')
      checkPlanResource()
      return stageRequest(requestId, { kind: 'install', source: fixedSource }, signal, true)
    },
    readPreparedForActivation(transactionId) { return synchronousResult(() => {
      const id = parseProfileTransactionId(transactionId)
      const value = readPrepared(id)
      if (value === undefined) return undefined
      if (hash(JSON.stringify({ owner, files: inventory(profile, false), inputs: configInputs() })) !== value.result.baseFingerprint) fail('prepared base no longer matches the active profile')
      if (fingerprint(inventory(profile, true, runtimeDir, false)) !== value.baseGraphFingerprint) fail('prepared original graph no longer matches the active profile')
      if (value.provisioning !== undefined && stable(chooseProvisioning(profile, value.provisioning.ownerDecision === 'create-release-owned')) !== stable(value.provisioning)) fail('original provisioning ownership no longer matches')
      return activationInput(id, value)
    }) },
    readPreparedForRecovery(transactionId) { return synchronousResult(() => {
      const id = parseProfileTransactionId(transactionId)
      const value = readPrepared(id, true)
      if (value === undefined) return undefined
      checkExternalInputs(value)
      return activationInput(id, value)
    }) },
    verifyActivationTree(transactionId, role, receiptTransition) {
      return synchronousResult(() => verifyTree(parseProfileTransactionId(transactionId), role, receiptTransition))
    },
    status(id) { return synchronousResult(() => pending(parseProfileTransactionId(id))) },
    listPending() { return synchronousResult(() => {
      const results: ProfilePreparedPackageChange[] = []
      for (const name of readdirSync(dirname(profile)).sort()) {
        if (!name.startsWith(prefix)) continue
        const id = name.slice(prefix.length)
        // A foreign sibling is not an owned transaction and must never be opened or deleted.
        if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(id)) continue
        const prepared = pending(id, true)
        if (prepared !== undefined) results.push(prepared)
      }
      return results
    }) },
    async cancel(transactionId) {
      const id = parseProfileTransactionId(transactionId)
      const control = running.get(id)
      if (control !== undefined) {
        control.abort.abort(new Error('desktop package staging: cancelled'))
        try { await control.done } catch (error) {
          if (error !== control.abort.signal.reason) throw error
          return
        }
        fail('operation already prepared; retained for a separate explicit discard')
      }
      const observed = readPrepared(id, true, true)
      if (observed !== undefined && readDesktopPackageActivationPhase(activationInput(id, observed)) !== undefined) fail('activation-owned transactions cannot be discarded')
      await withProfilePackageLease(profile, () => synchronousResult(() => {
        const value = readPrepared(id, true, true)
        if (value === undefined) return
        if (readDesktopPackageActivationPhase(activationInput(id, value)) !== undefined) fail('activation-owned transactions cannot be discarded')
        const state = readDiscard(id, value)
        if (state === 'discarded') return
        if (state === undefined) readPrepared(id)
        const path = join(directory(id), DISCARD)
        const marker = { schemaVersion: 1, transactionId: id, ownerFingerprint: hash(JSON.stringify(value.owner)),
          requestFingerprint: value.requestFingerprint, candidateFingerprint: value.candidateFingerprint }
        if (state === undefined) durableJson(path, { ...marker, state: 'discarding' }, `${path}.${randomUUID()}.tmp`)
        for (const name of ['profile', 'store', 'environment', 'acquisition', 'registry-resolution-cache']) removeOwnedTree(join(directory(id), name))
        durableJson(path, { ...marker, state: 'discarded' }, `${path}.${randomUUID()}.tmp`)
      }), wait)
    },
  }
}
