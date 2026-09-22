/** Transactional owner of the reserved desktop profile and its private pnpm state. */

import { valid } from 'semver'
import { createHash, randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import {
  copyFileSync,
  cpSync,
  existsSync,
  fsyncSync,
  ftruncateSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path'
import {
  DESKTOP_HOST_PACKAGE,
  desktopCorePackageOverrides,
  verifyDesktopCorePackageSet,
} from './core-package-set.ts'
import type { DesktopPaths } from './paths.ts'
import { parseDesktopPluginInstallSpec, type DesktopPluginInstallSpec } from './plugin-install-spec.ts'
import { acquireDesktopSourcePackage } from './plugin-package-artifact.ts'
import { normalizeDesktopArtifactSpecifiers } from './plugin-lock-normalization.ts'
import {
  desktopPackageArtifactSpecifier, readDesktopPackageLocks, verifyDesktopPackageArtifact,
  writeDesktopPackageLocks, type DesktopPackageInstallLock,
} from './plugin-package-lock.ts'
import { removeOwnedDirectory } from './owned-directory.ts'
import { recordDesktopProfileOperation } from './profile-operation-audit.ts'
import {
  createDesktopProfileRecoveryCopy, recordDesktopProfileRecoveryOutcome, type DesktopProfileRecoveryCopy,
} from './profile-recovery-copy.ts'
import type { DesktopRelease } from './release.ts'
import { desktopRuntimeId, readDesktopRuntime, type DesktopRuntimeDescriptor } from './runtime-tree.ts'
import {
  acquireDesktopPluginArtifact,
  DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
  parseDesktopPluginProvisionReceipt,
  parseDesktopPluginSource,
  type DesktopGithubReleasePluginSource,
  type DesktopPluginProvisionReceipt,
  type DesktopPluginSource,
} from './plugin-source.ts'
import {
  DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
  DESKTOP_PLUGIN_PROVISIONING_STATE_FILE,
  desktopPluginProvisioningPlanSha256,
  parseDesktopPluginProvisioningPlan,
  parseDesktopPluginProvisioningState,
  sameDesktopPluginSourceFamily,
  type DesktopPluginProvisioningPlan,
  type DesktopPluginProvisioningResult,
  type DesktopPluginProvisioningState,
} from './plugin-provisioning.ts'
import {
  desktopPluginLockHash, linkDesktopHostPackages, readDesktopProfileState, recordDesktopRuntimeProfile,
  unlinkDesktopHostPackages, validateDesktopPluginGraph, type DesktopProfileState,
} from './profile-packages.ts'

/** Desktop plugin record derived from the installed profile. */
export interface DesktopPluginRecord {
  readonly name: string
  readonly version: string
  readonly enabled: boolean
  readonly source?: DesktopPluginSource
  readonly resolution?: Pick<DesktopPackageInstallLock, 'resolved' | 'commit' | 'sha256' | 'integrity'>
}

/** Installed desktop project manifest slice. */
interface DesktopProjectManifest {
  readonly name: string
  readonly private: true
  readonly version: string
  readonly dependencies: Record<string, string>
  readonly dsh: {
    readonly profile: {
      readonly bundles: string[]
    }
  }
}

/** Exact executables the desktop shell bundles. */
export interface DesktopRuntimeExecutables {
  readonly node: string
  readonly pnpm: string
  readonly dsh: string
  /** How the Host obtains release-owned packages outside the writable profile. */
  readonly profileResolution?: 'link' | 'runtime'
}

/** Hooks that verify staged composition and control the active backend around profile activation. */
export interface DesktopProjectHooks {
  /** Stop the active backend and await process exit before modifying its files. */
  beforeChange(): Promise<void>
  /** Start and stop the complete staged Host composition before activation. */
  healthCheck(projectDir: string): Promise<void>
  /** Start the modified profile after package preparation succeeds. */
  afterChange(): Promise<void>
}

/** Supported dependency mutation. */
export type DesktopProjectMutation =
  | { readonly type: 'plugin-add'; readonly spec: string }
  | { readonly type: 'plugin-install'; readonly source: DesktopPluginSource }
  | { readonly type: 'plugin-remove'; readonly name: string }
  | { readonly type: 'plugin-update'; readonly name: string; readonly version: string }
  | { readonly type: 'plugin-toggle'; readonly name: string; readonly enabled: boolean }
  | { readonly type: 'plugins-reconcile'; readonly plan: DesktopPluginProvisioningPlan }
  | { readonly type: 'plugin-restore-planned'; readonly name: string; readonly plan: DesktopPluginProvisioningPlan }
  | { readonly type: 'runtime-reconcile' }
  | { readonly type: 'plugins-disable-all' }

/** Result returned by a Desktop profile mutation. */
export type DesktopProjectMutationResult =
  | DesktopPluginProvisionReceipt
  | DesktopPluginProvisioningState
  | undefined

const PROJECT_NAME = '@deepseek-ai/dsh-desktop-runtime'
const DSH_PACKAGE = '@deepseek-ai/dsh'
const CORE_BUILD_PACKAGE = '@deepseek-ai/dsh-subprocess-local'
const DESKTOP_PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const
const WORKSPACE_SETTINGS = 'nodeLinker: hoisted\nautoInstallPeers: false\nstrictDepBuilds: true\n'
const PACKAGE_NAME_PATTERN = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/u
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.+_-]*$/u
const MAX_PNPM_DIAGNOSTIC_BYTES = 64 * 1024
const DESKTOP_REGISTRY = 'https://registry.npmjs.org/'
const PLUGIN_RECEIPTS = 'desktop-plugin-receipts.json'
const PLUGIN_ARTIFACTS = '.desktop-plugin-artifacts'
const PNPM_TIMEOUT_MS = 5 * 60 * 1000

type DesktopPluginOwner = 'user' | 'release'

interface DesktopPluginReceiptStore {
  readonly schemaVersion: 1
  readonly receipts: Record<string, DesktopPluginProvisionReceipt>
  readonly owners: Record<string, DesktopPluginOwner>
}

type StagedDesktopPluginProvision = Omit<DesktopPluginProvisionReceipt, 'states'>

interface AppliedDesktopMutation {
  readonly target: string
  readonly provision?: StagedDesktopPluginProvision
}

/** User declarations captured before staging; disabled packages remain part of the inventory. */
interface DesktopUserPlugin {
  readonly dependency: string
  readonly enabled: boolean
  readonly owner: DesktopPluginOwner | undefined
  readonly receipt: DesktopPluginProvisionReceipt | undefined
  readonly snapshot: DesktopPackageInstallLock | undefined
  readonly artifactSha256: string | undefined
}

type DesktopUserInventory = ReadonlyMap<string, DesktopUserPlugin>

interface DesktopInventoryEvidence {
  readonly sha256: string
  readonly names: readonly string[]
}

interface DesktopActivationEvidence {
  readonly before: DesktopInventoryEvidence
  readonly after: DesktopInventoryEvidence
  readonly operation: DesktopProjectMutation['type']
  readonly target?: string
}

interface StagedDesktopProvisioning {
  readonly plan: DesktopPluginProvisioningPlan
  results: DesktopPluginProvisioningResult[]
  readonly removed: string[]
}

function errorOf(reason: unknown, fallback: string): Error {
  return reason instanceof Error ? reason : new Error(fallback)
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`, { mode: 0o600 })
}

function writeActivationJournal(
  path: string,
  transaction: string,
  phase: 'activating' | 'committed',
  evidence: DesktopActivationEvidence,
): void {
  const parent = lstatSync(dirname(path))
  const existing = lstatSync(path, { throwIfNoEntry: false })
  if (!parent.isDirectory() || parent.isSymbolicLink()
    || existing !== undefined && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error('desktop project: activation journal requires owned regular paths')
  }
  const temporary = `${path}.${randomUUID()}.pending`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    const bytes = Buffer.from(`${JSON.stringify({ schemaVersion: 2, transaction: basename(transaction), phase, ...evidence })}\n`)
    let offset = 0
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null)
      if (written === 0) throw new Error('desktop project: activation journal write made no progress')
      offset += written
    }
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, path)
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function legacyReceiptOwners(
  projectDir: string,
  receipts: Readonly<Record<string, DesktopPluginProvisionReceipt>>,
): Record<string, DesktopPluginOwner> {
  const owners = Object.create(null) as Record<string, DesktopPluginOwner>
  for (const name of Object.keys(receipts)) owners[name] = 'user'
  const statePath = join(projectDir, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE)
  if (!existsSync(statePath)) return owners
  const metadata = lstatSync(statePath)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('desktop project: legacy provisioning state must be a regular file')
  }
  const state = parseDesktopPluginProvisioningState(readJson(statePath))
  const previousPlan = parseDesktopPluginProvisioningPlan({
    schemaVersion: state.planSchemaVersion,
    mode: 'exact',
    plugins: state.plugins.map(result => ({
      required: result.required,
      source: result.requestedSource,
      ...(state.planSchemaVersion === 1 ? {} : { sourcePolicy: result.sourcePolicy }),
    })),
  })
  // Incomplete evidence cannot authorize deleting an otherwise unowned plugin.
  if (desktopPluginProvisioningPlanSha256(previousPlan) !== state.planSha256) return owners
  const manifest = readJson(join(projectDir, 'package.json'))
  if (!isRecord(manifest) || !isRecord(manifest.dependencies) || Array.isArray(manifest.dependencies)) {
    throw new Error('desktop project: invalid manifest for legacy plugin ownership')
  }
  for (const result of state.plugins) {
    const receipt = receipts[result.name]
    if (result.status === 'active' && result.effective === 'plan' && receipt !== undefined
      && JSON.stringify(receipt) === JSON.stringify(result.receipt)
      && manifest.dependencies[result.name] === artifactSpecifier(receipt)) {
      owners[result.name] = 'release'
    }
  }
  return owners
}

function planFromState(state: DesktopPluginProvisioningState): DesktopPluginProvisioningPlan {
  return parseDesktopPluginProvisioningPlan({
    schemaVersion: state.planSchemaVersion,
    mode: 'exact',
    plugins: state.plugins.map(result => ({
      required: result.required, source: result.requestedSource,
      ...(state.planSchemaVersion === 1 ? {} : { sourcePolicy: result.sourcePolicy }),
    })),
  })
}

function readPluginReceipts(projectDir: string): DesktopPluginReceiptStore {
  const path = join(projectDir, PLUGIN_RECEIPTS)
  const receipts = Object.create(null) as Record<string, DesktopPluginProvisionReceipt>
  if (!existsSync(path)) return {
    schemaVersion: 1, receipts, owners: Object.create(null) as Record<string, DesktopPluginOwner>,
  }
  const metadata = lstatSync(path)
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error('desktop project: plugin receipt store must be a regular file')
  }
  const value = readJson(path)
  if (!isRecord(value) || Array.isArray(value) || value.schemaVersion !== 1
    || !isRecord(value.receipts) || Array.isArray(value.receipts)
    || Object.keys(value).some(key => !['schemaVersion', 'receipts', 'owners'].includes(key))) {
    throw new Error('desktop project: invalid plugin receipt store')
  }
  for (const [name, receipt] of Object.entries(value.receipts)) {
    assertPackageName(name)
    const parsed = parseDesktopPluginProvisionReceipt(receipt)
    if (parsed.packageName !== name) {
      throw new Error(`desktop project: invalid plugin receipt for ${name}`)
    }
    receipts[name] = parsed
  }
  if (!Object.hasOwn(value, 'owners')) return { schemaVersion: 1, receipts, owners: legacyReceiptOwners(projectDir, receipts) }
  if (!isRecord(value.owners) || Array.isArray(value.owners)
    || Object.keys(value.owners).length !== Object.keys(receipts).length) {
    throw new Error('desktop project: invalid plugin receipt owners')
  }
  const owners = Object.create(null) as Record<string, DesktopPluginOwner>
  for (const [name, owner] of Object.entries(value.owners)) {
    if (!Object.hasOwn(receipts, name) || (owner !== 'user' && owner !== 'release')) {
      throw new Error('desktop project: invalid plugin receipt owners')
    }
    owners[name] = owner
  }
  return { schemaVersion: 1, receipts, owners }
}

function writePluginReceipts(projectDir: string, store: DesktopPluginReceiptStore): void {
  writeJson(join(projectDir, PLUGIN_RECEIPTS), store)
}

function copyProfileMetadata(source: string, target: string): void {
  cpSync(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    filter: path => basename(path) !== 'node_modules',
  })
}

function matchesProvisioning(
  projectDir: string,
  plan: DesktopPluginProvisioningPlan,
  state: DesktopPluginProvisioningState,
): boolean {
  if (state.planSha256 !== desktopPluginProvisioningPlanSha256(plan)
    || state.plugins.length !== plan.plugins.length) return false
  const manifest = projectManifest(projectDir)
  const store = readPluginReceipts(projectDir)
  const desired = new Map(plan.plugins.map(entry => [entry.source.packageName, entry]))
  if (Object.keys(store.receipts).some(name => store.owners[name] === 'release' && !desired.has(name))) return false
  let resolution: DesktopProvisioningResolution
  try { resolution = resolveProvisioning(readUserInventory(projectDir), plan) } catch (_error) { return false }
  return state.plugins.every((result) => {
    const decision = resolution.entries.get(result.name)
    if (decision === undefined || decision.entry.required !== result.required
      || decision.policy !== result.sourcePolicy
      || JSON.stringify(decision.entry.source) !== JSON.stringify(result.requestedSource)) return false
    if (result.status === 'optional-failed') {
      return !decision.entry.required && decision.receipt === undefined && store.receipts[result.name] === undefined
        && !Object.hasOwn(manifest.dependencies, result.name) && !profilePluginNames(projectDir).includes(result.name)
    }
    const receipt = store.receipts[result.name]
    const effectiveSource = decision.receipt?.source ?? decision.entry.source
    if (receipt === undefined || JSON.stringify(receipt) !== JSON.stringify(result.receipt)
      || JSON.stringify(effectiveSource) !== JSON.stringify(result.effectiveSource)
      || decision.effective !== result.effective || receipt.artifactSha256 !== effectiveSource.sha256
      || manifest.dependencies[result.name] !== artifactSpecifier(receipt)
      || !existsSync(join(projectDir, 'node_modules', result.name, 'package.json'))) return false
    const plugin = inspectPlugin(projectDir, result.name)
    return plugin.version === effectiveSource.version && plugin.enabled
      && createHash('sha256').update(readFileSync(join(projectDir, PLUGIN_ARTIFACTS, `${receipt.artifactSha256}.tgz`)))
        .digest('hex') === effectiveSource.sha256
  })
}

/**
 * Validate the release inventory while allowing independently user-owned plugins.
 * @param projectDir - Active profile whose Host has reached readiness.
 * @param plan - Installed release's reviewed exact inventory.
 * @returns Matching active provisioning evidence; throws on missing or drifted inventory.
 */
export function assertDesktopProvisioningInventory(
  projectDir: string,
  input: unknown,
): DesktopPluginProvisioningState {
  const plan = parseDesktopPluginProvisioningPlan(input)
  const state = parseDesktopPluginProvisioningState(readJson(join(projectDir, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE)))
  if (!matchesProvisioning(projectDir, plan, state)) {
    throw new Error('desktop plugin provisioning: active inventory does not match the release plan')
  }
  return state
}

function resolvedProvisioningState(
  projectDir: string,
  plan: DesktopPluginProvisioningPlan,
  previous: DesktopPluginProvisioningState,
): DesktopPluginProvisioningState {
  const resolution = resolveProvisioning(readUserInventory(projectDir), plan)
  const store = readPluginReceipts(projectDir)
  const enabled = new Set(profilePluginNames(projectDir))
  const plugins = plan.plugins.map((entry): DesktopPluginProvisioningResult => {
    const decision = resolution.entries.get(entry.source.packageName)
    if (decision === undefined) throw new Error('desktop plugin provisioning: missing resolved entry')
    const receipt = decision.receipt ?? store.receipts[entry.source.packageName]
    if (receipt === undefined || !enabled.has(entry.source.packageName)) {
      const failed = previous.plugins.find(result => result.name === entry.source.packageName && result.status === 'optional-failed')
      if (!entry.required && failed !== undefined) return {
        name: entry.source.packageName, required: false, status: 'optional-failed', requestedSource: entry.source,
        sourcePolicy: provisioningSourcePolicy(entry), message: failed.message, phase: failed.phase,
      }
      throw new DesktopProvisioningOverrideError(entry.source.packageName, entry.source.version,
        `desktop project: mutation would leave planned plugin ${entry.source.packageName} inactive`)
    }
    const effectiveSource = receipt.source
    if (decision.effective === 'plan' && JSON.stringify(effectiveSource) !== JSON.stringify(entry.source)) {
      throw new DesktopProvisioningOverrideError(entry.source.packageName, entry.source.version)
    }
    return {
      name: entry.source.packageName, required: entry.required, status: 'active', requestedSource: entry.source,
      sourcePolicy: provisioningSourcePolicy(entry), effective: decision.effective, effectiveSource, receipt,
    }
  })
  return {
    schemaVersion: 2, capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
    planSchemaVersion: plan.schemaVersion, planSha256: desktopPluginProvisioningPlanSha256(plan), composition: 'active', plugins,
    removed: previous.removed.map(name => name), rolledBack: false, verified: true,
  }
}

function artifactSpecifier(receipt: DesktopPluginProvisionReceipt): string {
  return `file:${PLUGIN_ARTIFACTS}/${receipt.artifactSha256}.tgz`
}

function workspaceFile(overrides: Readonly<Record<string, string>> = {}): string {
  const entries = Object.entries(overrides).sort(([left], [right]) => left.localeCompare(right))
  const overrideSection = entries.length === 0
    ? ''
    : `overrides:\n${entries.map(([name, spec]) => `  ${JSON.stringify(name)}: ${JSON.stringify(spec)}`).join('\n')}\n`
  const coreBuildSpec = overrides[CORE_BUILD_PACKAGE]
  const coreBuildKey = coreBuildSpec === undefined
    ? CORE_BUILD_PACKAGE
    : `${CORE_BUILD_PACKAGE}@${coreBuildSpec.replace('file:./', 'file:')}`
  return `packages:\n  - .\n\n${overrideSection}${WORKSPACE_SETTINGS}allowBuilds:\n  node-pty: true\n  koffi: true\n  fs-ext: true\n  ${JSON.stringify(coreBuildKey)}: true\n  '@google/genai': false\n  protobufjs: false\n  node-addon-require-builtin: false\n`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function assertPackageName(name: string): void {
  if (!PACKAGE_NAME_PATTERN.test(name)) throw new Error('desktop project: invalid npm package name')
}

function assertVersion(version: string): void {
  if (!VERSION_PATTERN.test(version)) throw new Error(`desktop project: invalid exact version ${JSON.stringify(version)}`)
}

/**
 * Validate one registry package spec and return its package name.
 * @param spec - npm registry name with an optional version or tag.
 * @returns Requested package name.
 */
export function packageNameFromSpec(spec: string): string {
  const parsed = parseDesktopPluginInstallSpec(spec, process.cwd())
  if (parsed.kind !== 'registry') throw new Error('desktop project: expected an npm registry package spec')
  return parsed.name
}

function installedDependencySpecifier(projectDir: string, name: string): string {
  const value = readJson(join(projectDir, 'package.json'))
  if (!isRecord(value) || !isRecord(value.dependencies) || typeof value.dependencies[name] !== 'string') {
    throw new Error(`desktop project: package manager did not record ${name}`)
  }
  return value.dependencies[name]
}

function projectManifest(projectDir: string): DesktopProjectManifest {
  const path = join(projectDir, 'package.json')
  const value = readJson(path)
  const dsh = isRecord(value) && isRecord(value.dsh) ? value.dsh : undefined
  const profile = isRecord(dsh?.profile) ? dsh.profile : undefined
  if (!isRecord(value) || value.name !== PROJECT_NAME || value.private !== true
    || typeof value.version !== 'string' || (value.dependencies !== undefined && !isRecord(value.dependencies))
    || !Array.isArray(profile?.bundles) || !profile.bundles.every(bundle => typeof bundle === 'string')) {
    throw new Error(`desktop project: invalid desktop profile manifest ${path}`)
  }
  const manifest = { ...value, dependencies: value.dependencies ?? {} } as unknown as DesktopProjectManifest
  const receipts = readPluginReceipts(projectDir).receipts
  const snapshots = readDesktopPackageLocks(projectDir)
  if (Object.entries(manifest.dependencies).some(([name, version]) => {
    const receipt = receipts[name]
    const snapshot = snapshots[name]
    const verifiedArtifact = receipt !== undefined && artifactSpecifier(receipt) === version
      && existsSync(join(projectDir, PLUGIN_ARTIFACTS, `${receipt.artifactSha256}.tgz`))
    const sourceArtifact = snapshot !== undefined && desktopPackageArtifactSpecifier(snapshot) === version
    return !PACKAGE_NAME_PATTERN.test(name) || typeof version !== 'string'
      || (valid(version) !== version && !verifiedArtifact && !sourceArtifact)
  })) {
    throw new Error('desktop project: plugin dependencies must use exact registry versions or locked local artifacts')
  }
  return manifest
}

function userArtifactSha256(
  projectDir: string,
  name: string,
  receipt: DesktopPluginProvisionReceipt | undefined,
  snapshot: DesktopPackageInstallLock | undefined,
): string | undefined {
  const expected = snapshot?.sha256 ?? receipt?.artifactSha256
  if (expected === undefined) return undefined
  const directory = join(projectDir, PLUGIN_ARTIFACTS)
  const path = join(directory, `${expected}.tgz`)
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()
    || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`desktop project: missing regular user plugin artifact snapshot for ${name}`)
  }
  const bytes = readFileSync(path)
  const actual = createHash('sha256').update(bytes).digest('hex')
  const integrity = snapshot?.integrity ?? receipt?.source.integrity
  if (actual !== expected || integrity !== undefined
    && `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== integrity) {
    throw new Error(`desktop project: user plugin artifact snapshot integrity mismatch for ${name}`)
  }
  return actual
}

function readUserInventory(projectDir: string, ignoredArtifact?: string): DesktopUserInventory {
  const manifest = projectManifest(projectDir)
  const store = readPluginReceipts(projectDir)
  const snapshots = readDesktopPackageLocks(projectDir)
  const enabled = new Set(profilePluginNames(projectDir))
  for (const [name, dependency] of Object.entries(manifest.dependencies)) {
    const receipt = store.receipts[name], snapshot = snapshots[name]
    if (receipt !== undefined && (snapshot !== undefined || dependency !== artifactSpecifier(receipt))
      || snapshot !== undefined && dependency !== desktopPackageArtifactSpecifier(snapshot)) {
      throw new Error(`desktop project: inconsistent user plugin metadata for ${name}; inspect the retained profile`)
    }
  }
  const orphan = [
    ...Object.keys(store.receipts).filter(name => store.owners[name] === 'user'),
    ...Object.keys(snapshots),
    ...[...enabled].filter(name => store.owners[name] !== 'release'),
  ].find(name => !Object.hasOwn(manifest.dependencies, name))
  if (orphan !== undefined) throw new Error(`desktop project: orphan user plugin metadata for ${orphan}; inspect the retained profile`)
  return new Map(Object.entries(manifest.dependencies)
    .filter(([name, dependency]) => {
      const receipt = store.receipts[name]
      return store.owners[name] !== 'release' || receipt === undefined
        || dependency !== artifactSpecifier(receipt) || snapshots[name] !== undefined
    })
    .map(([name, dependency]) => [name, {
      dependency, enabled: enabled.has(name), owner: store.owners[name],
      receipt: store.receipts[name], snapshot: snapshots[name],
      artifactSha256: name === ignoredArtifact ? undefined : userArtifactSha256(projectDir, name, store.receipts[name], snapshots[name]),
    }]))
}

function canonicalInventory(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalInventory).join(',')}]`
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().filter(key => value[key] !== undefined)
      .map(key => `${JSON.stringify(key)}:${canonicalInventory(value[key])}`).join(',')}}`
  }
  if (value === undefined || typeof value === 'function' || typeof value === 'symbol') return 'null'
  return JSON.stringify(value)
}

/** Fingerprint declared inventory and referenced bytes, not generated node_modules or Host documents. */
function profileInventoryEvidence(projectDir: string): DesktopInventoryEvidence {
  for (const name of ['package.json', 'desktop-runtime-state.json', 'desktop-packages-pending', 'pnpm-lock.yaml', 'pnpm-workspace.yaml',
    PLUGIN_RECEIPTS, 'desktop-plugin-package-locks.json', DESKTOP_PLUGIN_PROVISIONING_STATE_FILE]) {
    const entry = lstatSync(join(projectDir, name), { throwIfNoEntry: false })
    if (entry !== undefined && (!entry.isFile() || entry.isSymbolicLink())) {
      throw new Error('desktop project: inventory metadata must contain only regular unlinked files')
    }
  }
  const manifest = projectManifest(projectDir), store = readPluginReceipts(projectDir)
  const snapshots = readDesktopPackageLocks(projectDir)
  const directory = join(projectDir, PLUGIN_ARTIFACTS)
  const directoryEntry = lstatSync(directory, { throwIfNoEntry: false })
  if (directoryEntry !== undefined && (!directoryEntry.isDirectory() || directoryEntry.isSymbolicLink())) {
    throw new Error('desktop project: inventory artifacts must use an owned directory')
  }
  const hashes = new Set([
    ...Object.values(store.receipts).map(receipt => receipt.artifactSha256),
    ...Object.values(snapshots).map(snapshot => snapshot.sha256),
  ])
  const artifacts = [...hashes].sort().map((hash) => {
    const path = join(directory, `${hash}.tgz`), entry = lstatSync(path, { throwIfNoEntry: false })
    if (entry === undefined) return { hash, content: null }
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('desktop project: inventory artifact must be a regular unlinked file')
    return { hash, content: createHash('sha256').update(readFileSync(path)).digest('hex') }
  })
  const workspace = join(projectDir, 'pnpm-workspace.yaml')
  const value = {
    dependencies: manifest.dependencies, bundles: manifest.dsh.profile.bundles,
    receipts: store, snapshots, artifacts, runtime: readDesktopProfileState(projectDir) ?? null,
    lock: desktopPluginLockHash(projectDir), pending: existsSync(join(projectDir, 'desktop-packages-pending')),
    workspace: existsSync(workspace) ? createHash('sha256').update(readFileSync(workspace)).digest('hex') : null,
  }
  return { sha256: createHash('sha256').update(canonicalInventory(value)).digest('hex'), names: Object.keys(manifest.dependencies).sort() }
}

function sameInventoryEvidence(left: DesktopInventoryEvidence, right: DesktopInventoryEvidence): boolean {
  return left.sha256 === right.sha256 && canonicalInventory(left.names) === canonicalInventory(right.names)
}

function observableInventory(projectDir: string): DesktopInventoryEvidence | null {
  try { return profileInventoryEvidence(projectDir) } catch (_error) {
    // A failed or partially moved candidate has no trustworthy inventory observation.
    return null
  }
}

function parseInventoryEvidence(value: unknown): DesktopInventoryEvidence {
  if (!isRecord(value) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)
    || !Array.isArray(value.names) || !value.names.every((name: unknown) => typeof name === 'string' && PACKAGE_NAME_PATTERN.test(name))
    || new Set(value.names).size !== value.names.length || Object.keys(value).some(key => key !== 'sha256' && key !== 'names')) {
    throw new Error('desktop project: invalid profile activation inventory evidence')
  }
  return { sha256: value.sha256, names: value.names as string[] }
}

function parseActivationEvidence(value: Record<string, unknown>): DesktopActivationEvidence | undefined {
  if (value.schemaVersion === 1) {
    if (Object.keys(value).some(key => !['schemaVersion', 'transaction', 'phase'].includes(key))) {
      throw new Error('desktop project: invalid legacy activation journal fields')
    }
    return undefined
  }
  const operations = new Set<string>(['plugin-add', 'plugin-install', 'plugin-remove', 'plugin-update', 'plugin-toggle',
    'plugin-restore-planned', 'plugins-reconcile', 'runtime-reconcile', 'plugins-disable-all'])
  const needsTarget = typeof value.operation === 'string' && value.operation.startsWith('plugin-')
  if (typeof value.operation !== 'string' || !operations.has(value.operation)
    || needsTarget !== (value.target !== undefined)
    || (value.target !== undefined && (typeof value.target !== 'string' || !PACKAGE_NAME_PATTERN.test(value.target)))
    || Object.keys(value).some(key => !['schemaVersion', 'transaction', 'phase', 'before', 'after', 'operation', 'target'].includes(key))) {
    throw new Error('desktop project: invalid profile activation operation evidence')
  }
  return {
    before: parseInventoryEvidence(value.before), after: parseInventoryEvidence(value.after),
    operation: value.operation as DesktopProjectMutation['type'],
    ...(value.target === undefined ? {} : { target: value.target }),
  }
}

function provisioningSourcePolicy(entry: DesktopPluginProvisioningPlan['plugins'][number]): 'strict-pin' | 'compatible-user-override' {
  return 'sourcePolicy' in entry ? entry.sourcePolicy : 'strict-pin'
}

interface DesktopProvisioningResolutionEntry {
  readonly entry: DesktopPluginProvisioningPlan['plugins'][number]
  readonly policy: 'strict-pin' | 'compatible-user-override'
  readonly effective: 'plan' | 'user-override'
  readonly receipt?: DesktopPluginProvisionReceipt
}

interface DesktopProvisioningResolution {
  readonly entries: ReadonlyMap<string, DesktopProvisioningResolutionEntry>
}

/** A planned package cannot use the retained user source without an explicit recovery choice. */
export class DesktopProvisioningOverrideError extends Error {
  readonly code = 'restore-planned-source'

  /**
   * @param packageName - Planned package whose retained user source conflicts.
   * @param requestedVersion - Plan version available to recovery.
   * @param message - Optional diagnostic that preserves the specific refusal.
   */
  constructor(readonly packageName: string, readonly requestedVersion: string, message?: string) {
    super(message ?? `desktop project: release plan conflicts with user plugin ${packageName}; restore the planned source explicitly`)
    this.name = 'DesktopProvisioningOverrideError'
  }
}

/** A staged health failure with exactly one active override offers replacement without claiming causality. */
export class DesktopProvisioningOverrideHealthError extends DesktopProvisioningOverrideError {
  /**
   * @param packageName - Sole active override package available for optional recovery.
   * @param requestedVersion - Packaged version offered by recovery.
   * @param cause - Original staged verification failure, retained without attributing causality.
   */
  constructor(packageName: string, requestedVersion: string, cause: unknown) {
    super(packageName, requestedVersion,
      `desktop project: staged profile health failed while user override ${packageName} was active; restoring the planned source is available: ${errorOf(cause, 'Host health failed').message}`)
    this.name = 'DesktopProvisioningOverrideHealthError'
    this.cause = cause
  }
}

function assertPlannedMutationPreflight(
  plan: DesktopPluginProvisioningPlan,
  mutation: DesktopProjectMutation,
): void {
  let name: string | undefined
  if (mutation.type === 'plugin-add') {
    const parsed = parseDesktopPluginInstallSpec(mutation.spec, process.cwd())
    if (parsed.kind === 'registry') name = parsed.name
  } else if (mutation.type === 'plugin-update' || mutation.type === 'plugin-remove'
    || mutation.type === 'plugin-toggle' && !mutation.enabled) name = mutation.name
  if (name === undefined) return
  const entry = plan.plugins.find(item => item.required && item.source.packageName === name)
  if (entry !== undefined) {
    throw new DesktopProvisioningOverrideError(entry.source.packageName, entry.source.version,
      `desktop project: ${mutation.type} would leave required planned plugin ${name} invalid; restore the planned source explicitly`)
  }
}

function resolveProvisioning(
  inventory: DesktopUserInventory,
  plan: DesktopPluginProvisioningPlan,
  forceRequestedSourceFor: ReadonlySet<string> = new Set(),
): DesktopProvisioningResolution {
  const entries = new Map<string, DesktopProvisioningResolutionEntry>()
  for (const entry of plan.plugins) {
    const { source } = entry
    const policy = provisioningSourcePolicy(entry)
    const manual = inventory.get(source.packageName)
    if (manual === undefined || forceRequestedSourceFor.has(source.packageName)) {
      entries.set(source.packageName, { entry, policy, effective: 'plan' })
      continue
    }
    const verified = manual.enabled && manual.owner === 'user' && manual.receipt !== undefined && manual.snapshot === undefined
      && manual.dependency === artifactSpecifier(manual.receipt)
    const identical = verified && JSON.stringify(manual.receipt?.source) === JSON.stringify(source)
    if (identical) {
      entries.set(source.packageName, { entry, policy, effective: 'plan', receipt: manual.receipt })
      continue
    }
    if (verified && manual.receipt !== undefined && policy === 'compatible-user-override'
      && sameDesktopPluginSourceFamily(source, manual.receipt.source)) {
      entries.set(source.packageName, { entry, policy, effective: 'user-override', receipt: manual.receipt })
      continue
    }
    throw new DesktopProvisioningOverrideError(source.packageName, source.version)
  }
  return { entries }
}

function assertUserInventory(
  projectDir: string,
  baseline: DesktopUserInventory,
  mutation: DesktopProjectMutation,
  target: string | undefined,
  preparedTarget?: DesktopUserPlugin | null,
  ignoredArtifact?: string,
): void {
  const current = readUserInventory(projectDir, ignoredArtifact ?? (mutation.type === 'plugin-remove' ? mutation.name : undefined))
  const replacement = mutation.type === 'plugin-add' || mutation.type === 'plugin-install'
    || mutation.type === 'plugin-remove' || mutation.type === 'plugin-update'
    || mutation.type === 'plugin-restore-planned' ? target : undefined
  if (replacement !== undefined) {
    const removed = preparedTarget === null && (mutation.type === 'plugin-restore-planned'
      ? current.get(replacement) === undefined
      : !Object.hasOwn(projectManifest(projectDir).dependencies, replacement)
        && !profilePluginNames(projectDir).includes(replacement)
        && readPluginReceipts(projectDir).receipts[replacement] === undefined
        && readDesktopPackageLocks(projectDir)[replacement] === undefined)
    if (!removed && (preparedTarget === null || preparedTarget === undefined
      || JSON.stringify(current.get(replacement)) !== JSON.stringify(preparedTarget))) {
      throw new Error(`desktop project: requested plugin inventory changed for ${replacement}; refusing profile activation`)
    }
  }
  for (const name of new Set([...baseline.keys(), ...current.keys()])) {
    if (name === replacement) continue
    const original = baseline.get(name)
    const expected = original !== undefined && (mutation.type === 'plugins-disable-all'
      || mutation.type === 'plugin-toggle' && name === mutation.name)
      ? { ...original, enabled: mutation.type === 'plugin-toggle' && mutation.enabled }
      : original
    if (JSON.stringify(current.get(name)) !== JSON.stringify(expected)) {
      throw new Error(`desktop project: user plugin inventory changed for ${name}; refusing profile activation`)
    }
  }
}

function profilePluginNames(projectDir: string): readonly string[] {
  const bundles = projectManifest(projectDir).dsh.profile.bundles
  if (!DESKTOP_PROFILE_BUNDLES.every((bundle, index) => bundles[index] === bundle)) {
    throw new Error('desktop project: profile must begin with the built-in desktop bundle list')
  }
  const plugins = bundles.slice(DESKTOP_PROFILE_BUNDLES.length)
  if (new Set(bundles).size !== bundles.length) {
    throw new Error('desktop project: profile bundle list contains a duplicate package')
  }
  for (const plugin of plugins) assertPackageName(plugin)
  return plugins
}

function pluginRecords(projectDir: string): readonly DesktopPluginRecord[] {
  const receipts = readPluginReceipts(projectDir).receipts
  const snapshots = readDesktopPackageLocks(projectDir)
  return Object.keys(projectManifest(projectDir).dependencies).sort().map((name) => {
    const record = inspectPlugin(projectDir, name)
    const snapshot = snapshots[name]
    if (snapshot !== undefined) {
      return {
        ...record,
        source: { schemaVersion: 1, type: 'packageSpec', spec: snapshot.spec },
        resolution: {
          resolved: snapshot.resolved, sha256: snapshot.sha256, integrity: snapshot.integrity,
          ...(snapshot.commit === undefined ? {} : { commit: snapshot.commit }),
        },
      }
    }
    return receipts[name] === undefined ? record : { ...record, source: receipts[name].source }
  })
}

function writeProfilePlugins(projectDir: string, plugins: readonly DesktopPluginRecord[]): void {
  const manifest = projectManifest(projectDir)
  writeJson(join(projectDir, 'package.json'), {
    ...manifest,
    dsh: {
      ...manifest.dsh,
      profile: {
        ...manifest.dsh.profile,
        bundles: [...DESKTOP_PROFILE_BUNDLES, ...plugins.filter(plugin => plugin.enabled).map(plugin => plugin.name)],
      },
    },
  } satisfies DesktopProjectManifest)
}

function inspectInstalledPlugin(projectDir: string, requestedName: string): Pick<DesktopPluginRecord, 'name' | 'version'> {
  const manifestPath = join(projectDir, 'node_modules', ...requestedName.split('/'), 'package.json')
  if (!existsSync(manifestPath)) {
    throw new Error(`desktop project: installed package ${JSON.stringify(requestedName)} has no manifest`)
  }
  const manifest = readJson(manifestPath)
  if (!isRecord(manifest) || manifest.name !== requestedName || typeof manifest.version !== 'string') {
    throw new Error(`desktop project: installed package ${JSON.stringify(requestedName)} has inconsistent name or version`)
  }
  const dsh = manifest.dsh
  const bundle = isRecord(dsh) ? dsh.bundle : undefined
  const patch = isRecord(bundle) ? bundle.patch : undefined
  if (typeof patch !== 'string' || patch === '') {
    throw new Error(`desktop project: ${requestedName}@${manifest.version} does not declare dsh.bundle.patch`)
  }
  const packageDir = dirname(manifestPath)
  const patchPath = resolve(packageDir, patch)
  if ((patchPath !== packageDir && !patchPath.startsWith(packageDir + sep)) || !existsSync(patchPath)) {
    throw new Error(`desktop project: ${requestedName}@${manifest.version} declares an invalid bundle patch`)
  }
  return { name: requestedName, version: manifest.version }
}

function inspectPlugin(projectDir: string, requestedName: string): DesktopPluginRecord {
  return {
    ...inspectInstalledPlugin(projectDir, requestedName),
    enabled: profilePluginNames(projectDir).includes(requestedName),
  }
}

/** Stages private package graphs and retains the old profile until final Host readiness. */
export class DesktopProjectManager {
  private lockDescriptor: number | undefined
  private descriptor: DesktopRuntimeDescriptor | undefined

  /**
   * @param paths - Electron-owned package state and reserved desktop profile paths.
   * @param runtime - absolute bundled Node.js and pnpm entry paths.
   */
  constructor(
    readonly paths: DesktopPaths,
    readonly runtime: DesktopRuntimeExecutables,
  ) {}

  /** Read the active desktop plugin inventory. */
  listPlugins(): readonly DesktopPluginRecord[] {
    if (!existsSync(this.paths.profile)) return []
    const receipts = readPluginReceipts(this.paths.profile).receipts
    return pluginRecords(this.paths.profile).map((plugin) => {
      const source = receipts[plugin.name]?.source
      return source === undefined ? plugin : { ...plugin, source }
    })
  }

  /**
   * Retain a verified configuration/artifact copy before reinitializing the stopped profile.
   * @param hooks - Stop the Host before copying files; restart after preparation or a pre-reset failure.
   * @returns Completion of reset and final Host readiness; the recovery copy and shared data are retained.
   */
  async resetConfiguration(hooks: DesktopProjectHooks): Promise<void> {
    await this.withLock(async () => {
      await hooks.beforeChange()
      let recovery: DesktopProfileRecoveryCopy
      try {
        this.descriptor = this.readRuntime()
        recovery = createDesktopProfileRecoveryCopy(this.paths.profile, this.paths.root)
      } catch (copyError) {
        const failures: unknown[] = [copyError]
        try { await hooks.afterChange() } catch (restartError) { failures.push(restartError) }
        try {
          recordDesktopProfileOperation(this.paths.root, {
            transaction: `reset-${randomUUID()}`, operation: 'reset', phase: 'reset', outcome: 'failed',
            before: null, after: observableInventory(this.paths.profile),
          })
        } catch (recordError) { failures.push(recordError) }
        if (failures.length > 1) throw new AggregateError(failures, 'desktop project: reset preparation and recovery recording or prior Host restart failed')
        throw copyError
      }
      const before = observableInventory(this.paths.profile)
      let destructive = false
      let auditStarted = false
      let after: DesktopInventoryEvidence
      try {
        recordDesktopProfileOperation(this.paths.root, {
          transaction: basename(recovery.directory), operation: 'reset', phase: 'reset', outcome: 'started', before, after: null,
        })
        auditStarted = true
        destructive = true
        for (const entry of readdirSync(this.paths.profile, { withFileTypes: true })) {
          const path = join(this.paths.profile, entry.name)
          if (path === this.paths.lock) continue
          if (entry.isDirectory()) removeOwnedDirectory(path)
          else unlinkSync(path)
        }
        createPluginProfile(this.paths.profile)
        this.prepareProfile(this.paths.profile)
        await hooks.afterChange()
        after = profileInventoryEvidence(this.paths.profile)
        if (after.names.length !== 0) throw new Error('desktop project: reset profile still contains external plugins')
      } catch (resetError) {
        const failures: unknown[] = [resetError]
        try { recordDesktopProfileRecoveryOutcome(recovery, 'failed') } catch (recordError) { failures.push(recordError) }
        if (!destructive) {
          try { await hooks.afterChange() } catch (restartError) { failures.push(restartError) }
        }
        if (auditStarted) {
          try {
            recordDesktopProfileOperation(this.paths.root, {
              transaction: basename(recovery.directory), operation: 'reset', phase: 'reset', outcome: 'failed',
              before, after: observableInventory(this.paths.profile),
            })
          } catch (recordError) { failures.push(recordError) }
        }
        if (failures.length > 1) throw new AggregateError(failures, 'desktop project: reset failed and recovery recording or restart also failed')
        throw resetError
      }
      recordDesktopProfileRecoveryOutcome(recovery, 'completed')
      recordDesktopProfileOperation(this.paths.root, {
        transaction: basename(recovery.directory), operation: 'reset', phase: 'reset', outcome: 'committed',
        before, after,
      })
    })
  }

  /** Read the dsh version supplied by this application's verified resources. */
  dshVersion(): string {
    return this.currentRuntime().release.version
  }

  /** Read the release most recently applied to the active profile. */
  releaseVersion(): string {
    const state = readDesktopProfileState(this.paths.profile)
    if (state === undefined) throw new Error('desktop project: active profile has no runtime state')
    return state.version
  }

  /** Reject a profile whose dependency links were prepared for another runtime. */
  assertProfileRuntime(projectDir: string): void {
    if (existsSync(this.pendingPackages(projectDir))) throw new Error('desktop project: package preparation is incomplete; retry startup')
    if (readDesktopProfileState(projectDir)?.runtimeId !== desktopRuntimeId(this.currentRuntime())) {
      throw new Error('desktop project: profile does not match this application runtime')
    }
  }

  /** @returns Whether application resources support profile recovery. */
  canRecoverProfile(): boolean {
    return this.descriptor !== undefined && existsSync(this.runtime.node) && existsSync(this.runtime.dsh)
  }

  private pendingPackages(projectDir: string): string { return join(projectDir, 'desktop-packages-pending') }

  private activationJournal(): string { return join(this.paths.root, 'profile-activation.json') }

  private recoverActivation(): void {
    const journal = this.activationJournal()
    let value: unknown
    try {
      const entry = lstatSync(journal, { throwIfNoEntry: false })
      if (entry === undefined) return
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('desktop project: activation journal must be a regular unlinked file')
      value = readJson(journal)
      this.recoverActivationInventory(value)
    } catch (recoveryError) {
      const transaction = isRecord(value) && typeof value.transaction === 'string'
        && /^\.desktop-transaction-[A-Za-z0-9]+$/u.test(value.transaction) ? value.transaction : 'unidentified-recovery'
      try {
        recordDesktopProfileOperation(this.paths.root, {
          transaction, operation: 'recovery', phase: 'recovery', outcome: 'failed',
          before: null, after: observableInventory(this.paths.profile),
        })
      } catch (recordError) {
        throw new AggregateError([recoveryError, recordError], 'desktop project: profile recovery failed and its audit could not be recorded')
      }
      throw recoveryError
    }
  }

  private recoverActivationInventory(value: unknown): void {
    const journal = this.activationJournal()
    if (!isRecord(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
      || typeof value.transaction !== 'string' || !/^\.desktop-transaction-[A-Za-z0-9]+$/u.test(value.transaction)
      || (value.phase !== 'activating' && value.phase !== 'committed')) {
      throw new Error('desktop project: invalid profile activation recovery journal')
    }
    const evidence = parseActivationEvidence(value)
    const transaction = join(dirname(this.paths.profile), value.transaction)
    const rollback = join(transaction, 'rollback')
    const requireDirectory = (path: string): boolean => {
      const entry = lstatSync(path, { throwIfNoEntry: false })
      if (entry === undefined) return false
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error(`desktop project: recovery path is not an owned directory: ${path}`)
      return true
    }
    const transactionExists = requireDirectory(transaction)
    const candidates = [this.paths.profile, rollback, join(transaction, 'staging'), join(transaction, 'failed'),
      ...(transactionExists
        ? readdirSync(transaction).filter(name => /^recovery-[0-9]+$/iu.test(name)).map(name => join(transaction, name))
        : []),
    ]
    const observed = new Map<string, DesktopInventoryEvidence>()
    for (const candidate of candidates) {
      if (!requireDirectory(candidate)) continue
      if (!existsSync(join(candidate, 'package.json'))) {
        if (readdirSync(candidate).length === 0 && (candidate === this.paths.profile || /^recovery-/iu.test(basename(candidate)))) continue
        throw new Error(`desktop project: profile recovery requires inspection of ${transaction}; candidate metadata is incomplete`)
      }
      observed.set(candidate, profileInventoryEvidence(candidate))
    }
    const active = observed.get(this.paths.profile), previous = observed.get(rollback)
    const selected = value.phase === 'activating' && previous !== undefined ? previous : active
    if (selected === undefined) throw new Error(`desktop project: profile recovery requires inspection of ${transaction}`)
    if (evidence !== undefined) {
      const expectedActive = value.phase === 'committed' ? evidence.after : previous === undefined ? evidence.before : undefined
      if (expectedActive !== undefined && (active === undefined || !sameInventoryEvidence(active, expectedActive))
        || previous !== undefined && !sameInventoryEvidence(previous, evidence.before)) {
        throw new Error(`desktop project: profile recovery inventory mismatch; retain ${transaction} for inspection`)
      }
      for (const candidate of observed.values()) {
        if (!sameInventoryEvidence(candidate, evidence.before) && !sameInventoryEvidence(candidate, evidence.after)) {
          throw new Error(`desktop project: profile recovery contains an unrecognized inventory; retain ${transaction} for inspection`)
        }
      }
    } else {
      for (const candidate of observed.keys()) {
        const declarations = projectManifest(candidate)
        if (readDesktopProfileState(candidate) === undefined || !existsSync(join(candidate, 'pnpm-workspace.yaml'))
          || Object.keys(declarations.dependencies).length > 0 && !existsSync(join(candidate, 'pnpm-lock.yaml'))) {
          throw new Error(`desktop project: legacy recovery metadata is incomplete; retain ${transaction} for inspection`)
        }
      }
      const reference = value.phase === 'activating' && previous !== undefined ? rollback : this.paths.profile
      const protectedInventory = canonicalInventory(
        [...readUserInventory(reference)].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
      )
      for (const candidate of observed.keys()) {
        const inventory = canonicalInventory(
          [...readUserInventory(candidate)].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0),
        )
        if (inventory !== protectedInventory) {
          throw new Error(`desktop project: legacy recovery user inventories differ; retain ${transaction} for inspection`)
        }
      }
    }
    recordDesktopProfileOperation(this.paths.root, {
      transaction: value.transaction, operation: 'recovery', ...(evidence?.target === undefined ? {} : { target: evidence.target }),
      phase: 'recovery', outcome: 'started', before: active ?? null, after: selected,
    })
    if (value.phase === 'activating' && previous !== undefined) {
      if (existsSync(this.paths.profile)) renameSync(this.paths.profile, join(transaction, `recovery-${Date.now()}`))
      renameSync(rollback, this.paths.profile)
    }
    const recovered = profileInventoryEvidence(this.paths.profile)
    if (!sameInventoryEvidence(recovered, selected)) throw new Error(`desktop project: recovered inventory changed; retain ${transaction} for inspection`)
    recordDesktopProfileOperation(this.paths.root, {
      transaction: value.transaction, operation: 'recovery', ...(evidence?.target === undefined ? {} : { target: evidence.target }),
      phase: 'recovery', outcome: 'recovered', before: active ?? null, after: recovered,
    })
    // The retained operation receipt precedes cleanup; a failed audit leaves journal and copies intact.
    if (transactionExists) removeOwnedDirectory(transaction)
    unlinkSync(journal)
  }

  private assertNoOrphanRollback(): void {
    for (const name of readdirSync(dirname(this.paths.profile))) {
      if (!/^\.desktop-transaction-[a-z0-9]+$/iu.test(name)) continue
      const transaction = join(dirname(this.paths.profile), name)
      const entry = lstatSync(transaction)
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error('desktop project: unresolved recovery transaction requires inspection')
      if (lstatSync(join(transaction, 'rollback'), { throwIfNoEntry: false }) !== undefined) {
        throw new Error(`desktop project: orphan rollback prevents profile initialization; inspect ${transaction}`)
      }
    }
  }

  private currentRuntime(): DesktopRuntimeDescriptor {
    if (this.descriptor === undefined) throw new Error('desktop project: runtime metadata has not been loaded')
    return this.descriptor
  }

  private readRuntime(): DesktopRuntimeDescriptor {
    this.descriptor = undefined
    return readDesktopRuntime(this.runtime.dsh)
  }

  private prepareProfile(projectDir: string): void {
    const runtime = this.currentRuntime()
    const resolutionMode = this.runtime.profileResolution ?? 'link'
    if (resolutionMode === 'runtime') recordDesktopRuntimeProfile(projectDir, runtime)
    else linkDesktopHostPackages(projectDir, this.runtime.dsh, runtime)
    validateDesktopPluginGraph(projectDir, this.runtime.dsh, runtime, profilePluginNames(projectDir), resolutionMode)
  }

  private profileMatchesRuntime(projectDir: string): boolean {
    const target = this.currentRuntime()
    const previous = readDesktopProfileState(projectDir)
    const current = !existsSync(this.pendingPackages(projectDir))
      && previous?.runtimeId === desktopRuntimeId(target)
      && previous.lockHash === desktopPluginLockHash(projectDir)
    if (!current || this.runtime.profileResolution === 'runtime') return current
    return previous.links.length === target.sharedPackages.length
      && previous.links.every((link) => {
        const actual = join(projectDir, 'node_modules', link.name)
        const expected = join(this.runtime.dsh, 'node_modules', link.name)
        return target.sharedPackages.some(entry => entry.name === link.name)
          && existsSync(link.target) && existsSync(actual) && existsSync(expected)
          && lstatSync(actual).isSymbolicLink()
          && realpathSync.native(link.target) === realpathSync.native(expected)
          && realpathSync.native(actual) === realpathSync.native(expected)
      })
  }

  /**
   * Stage the target runtime and desired plugins together.
   * @param hooks - Staged and final-location Host readiness checks.
   * @param input - Packaged exact inventory; omission preserves manually managed inventory.
   * @returns Whether profile preparation or reconciliation was required.
   */
  async applyRelease(
    hooks: DesktopProjectHooks = { beforeChange: async () => {}, healthCheck: async () => {}, afterChange: async () => {} },
    input?: unknown,
  ): Promise<boolean> {
    const changed = await this.withLock(() => {
      try {
        const target = this.readRuntime()
        this.descriptor = target
        const previous = readDesktopProfileState(this.paths.profile)
        if (previous !== undefined) readUserInventory(this.paths.profile)
        if (this.profileMatchesRuntime(this.paths.profile)) return false
        if (previous === undefined) {
          this.assertNoOrphanRollback()
          createPluginProfile(this.paths.profile)
        }
        return true
      } catch (validationError) {
        try {
          recordDesktopProfileOperation(this.paths.root, {
            transaction: `startup-${randomUUID()}`, operation: 'runtime-reconcile', phase: 'preparation', outcome: 'failed',
            before: null, after: observableInventory(this.paths.profile),
          })
        } catch (recordError) {
          throw new AggregateError([validationError, recordError], 'desktop project: startup validation failed and its audit could not be recorded')
        }
        throw validationError
      }
    })
    if (input !== undefined) {
      await this.reconcileProvisioning(input, hooks)
    } else if (changed) {
      await this.mutate({ type: 'runtime-reconcile' }, hooks)
    }
    return changed
  }

  /**
   * Stage, validate, health-check, and atomically activate one profile mutation.
   * @param mutation - Registry, source snapshot, or verified-release package change.
   * @param hooks - Active Host lifecycle and staged composition health check.
   * @returns Verified-release attestation, or undefined for ordinary mutations.
   */
  async mutate(
    mutation: DesktopProjectMutation,
    hooks: DesktopProjectHooks,
  ): Promise<DesktopProjectMutationResult> {
    return this.withLock(async () => {
      this.currentRuntime()
      if (mutation.type === 'plugins-reconcile' || mutation.type === 'plugin-restore-planned') {
        mutation = { ...mutation, plan: parseDesktopPluginProvisioningPlan(mutation.plan) }
      }
      if ('name' in mutation) assertPackageName(mutation.name)
      if (!existsSync(this.paths.profile)) throw new Error('desktop project: active profile is not installed')
      const ignoredArtifact = mutation.type === 'plugin-remove' ? mutation.name : undefined
      const userInventory = readUserInventory(this.paths.profile, ignoredArtifact)
      const provisioningPath = join(this.paths.profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE)
      const activeProvisioning = existsSync(provisioningPath)
        ? parseDesktopPluginProvisioningState(readJson(provisioningPath)) : undefined
      const activePlan = activeProvisioning === undefined ? undefined : planFromState(activeProvisioning)
      if (activeProvisioning !== undefined && activePlan !== undefined
        && desktopPluginProvisioningPlanSha256(activePlan) !== activeProvisioning.planSha256) {
        throw new Error('desktop plugin provisioning: active state plan evidence is inconsistent')
      }
      if (activePlan !== undefined) assertPlannedMutationPreflight(activePlan, mutation)
      if (mutation.type === 'plugin-install' && activePlan !== undefined) {
        const source = parseDesktopPluginSource(mutation.source)
        const entry = source.type === 'githubRelease'
          ? activePlan.plugins.find(item => item.source.packageName === source.packageName) : undefined
        if (entry !== undefined && JSON.stringify(entry.source) !== JSON.stringify(source)
          && (provisioningSourcePolicy(entry) === 'strict-pin' || !sameDesktopPluginSourceFamily(entry.source, source))) {
          throw new DesktopProvisioningOverrideError(entry.source.packageName, entry.source.version)
        }
      }
      const beforeInventory = profileInventoryEvidence(this.paths.profile)
      if (mutation.type === 'plugins-reconcile') resolveProvisioning(userInventory, mutation.plan)
      if (mutation.type === 'plugin-restore-planned') {
        const entry = mutation.plan.plugins.find(item => item.source.packageName === mutation.name)
        if (entry === undefined) throw new Error(`desktop project: ${mutation.name} is not in the packaged provisioning plan`)
        resolveProvisioning(userInventory, mutation.plan, new Set([mutation.name]))
      }
      let targetName = 'name' in mutation ? mutation.name : undefined
      const parent = dirname(this.paths.profile)
      mkdirSync(parent, { recursive: true, mode: 0o700 })
      const transaction = mkdtempSync(join(parent, '.desktop-transaction-'))
      const staging = join(transaction, 'staging')
      const rollback = join(transaction, 'rollback')
      const failed = join(transaction, 'failed')
      const packagesChanged = mutation.type !== 'plugin-toggle'
      let auditStarted = false
      let committed = false
      // Read the runtime latch across nested catch regions; post-commit audit/cleanup calls can still throw.
      const hasCommitted = (): boolean => committed
      let phase: 'preparation' | 'activation' | 'rollback' = 'preparation'
      try {
        recordDesktopProfileOperation(this.paths.root, {
          transaction: basename(transaction), operation: mutation.type, ...(targetName === undefined ? {} : { target: targetName }),
          phase, outcome: 'started', before: beforeInventory, after: null,
        })
        auditStarted = true
        copyProfileMetadata(this.paths.profile, staging)
        // Commit legacy ownership only with the staged profile, before source replacement changes its evidence.
        if (existsSync(join(staging, PLUGIN_RECEIPTS))) writePluginReceipts(staging, readPluginReceipts(staging))
        const removingSnapshot = mutation.type === 'plugin-remove' && readDesktopPackageLocks(staging)[mutation.name] !== undefined
        if (removingSnapshot) this.pruneSourcePackage(staging, mutation.name)
        if (mutation.type === 'plugins-reconcile' || mutation.type === 'plugin-restore-planned') {
          for (const entry of mutation.plan.plugins) this.pruneSourcePackage(staging, entry.source.packageName)
        }
        for (const snapshot of Object.values(readDesktopPackageLocks(staging))) {
          verifyDesktopPackageArtifact(staging, snapshot)
        }
        const previous = readDesktopProfileState(staging)
        const registry = this.registryForMutation(staging, mutation)
        if (mutation.type !== 'plugins-reconcile' && (removingSnapshot || Object.keys(projectManifest(staging).dependencies).length > 0)) {
          await this.runPnpm(staging, ['install', removingSnapshot ? '--no-frozen-lockfile' : '--frozen-lockfile', '--ignore-scripts'], registry)
        }
        let provision: StagedDesktopPluginProvision | StagedDesktopProvisioning | undefined
        if (mutation.type === 'plugins-reconcile' || mutation.type === 'plugin-restore-planned') {
          provision = await this.stageProvisioning(
            staging, mutation.plan, transaction, hooks,
            mutation.type === 'plugin-restore-planned' ? new Set([mutation.name]) : undefined,
          )
        } else if (removingSnapshot) {
          await this.reconcileProfile(staging, previous, true, registry)
        } else if (mutation.type === 'plugins-disable-all') {
          const manifest = projectManifest(staging)
          writeJson(join(staging, 'package.json'), {
            ...manifest,
            dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile, bundles: [...DESKTOP_PROFILE_BUNDLES] } },
          })
          await this.reconcileProfile(staging, previous, existsSync(this.pendingPackages(staging)), registry)
        } else if (mutation.type === 'runtime-reconcile') {
          await this.reconcileProfile(staging, previous, existsSync(this.pendingPackages(staging)), registry)
        } else {
          const materializedPackagesChanged = packagesChanged || existsSync(this.pendingPackages(staging))
          if (materializedPackagesChanged && this.runtime.profileResolution !== 'runtime') {
            unlinkDesktopHostPackages(staging)
          }
          try {
            const applied = await this.applyMutation(staging, mutation, transaction)
            targetName = applied.target
            provision = applied.provision
          } finally {
            if (materializedPackagesChanged) {
              const runtime = this.currentRuntime()
              if (this.runtime.profileResolution === 'runtime') recordDesktopRuntimeProfile(staging, runtime)
              else linkDesktopHostPackages(staging, this.runtime.dsh, runtime)
            }
          }
          await this.reconcileProfile(staging, previous, materializedPackagesChanged, registry)
        }
        const preparedTarget = mutation.type === 'plugin-remove' || mutation.type === 'plugin-restore-planned' ? null
          : targetName === undefined || mutation.type === 'plugin-toggle' ? undefined
            : readUserInventory(staging).get(targetName)
        assertUserInventory(staging, userInventory, mutation, targetName, preparedTarget)
        if (activePlan !== undefined && activeProvisioning !== undefined
          && mutation.type !== 'plugins-reconcile' && mutation.type !== 'plugin-restore-planned'
          && mutation.type !== 'plugins-disable-all') {
          writeJson(join(staging, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE),
            resolvedProvisioningState(staging, activePlan, activeProvisioning))
        }
        const evidence: DesktopActivationEvidence = {
          before: beforeInventory, after: profileInventoryEvidence(staging), operation: mutation.type,
          ...(targetName === undefined ? {} : { target: targetName }),
        }
        await hooks.beforeChange()
        try {
          await hooks.healthCheck(staging)
          assertUserInventory(staging, userInventory, mutation, targetName, preparedTarget)
          if (!sameInventoryEvidence(profileInventoryEvidence(staging), evidence.after)) {
            throw new Error('desktop project: staged inventory changed during health verification')
          }
        } catch (healthError) {
          const healthPlan = provision !== undefined && 'plan' in provision ? provision.plan : activePlan
          const overrides = healthPlan === undefined ? []
            : [...resolveProvisioning(readUserInventory(staging), healthPlan).entries.values()]
              .filter(decision => decision.effective === 'user-override')
          const override = overrides.length === 1 ? overrides[0] : undefined
          const failure = override === undefined ? healthError : new DesktopProvisioningOverrideHealthError(
            override.entry.source.packageName, override.entry.source.version, healthError,
          )
          try {
            await hooks.afterChange()
          } catch (restartError) {
            throw new AggregateError([failure, restartError], 'desktop project: staged health check and active Host restart failed')
          }
          throw failure
        }
        let result: DesktopProjectMutationResult
        if (provision !== undefined && !('plan' in provision)) {
          const receipt: DesktopPluginProvisionReceipt = {
            ...provision,
            states: { staged: true, health: 'passed', activated: true, rolledBack: false, verified: true },
          }
          const store = readPluginReceipts(staging)
          writePluginReceipts(staging, {
            ...store,
            receipts: { ...store.receipts, [receipt.packageName]: receipt },
          })
          result = receipt
        } else if (provision !== undefined) {
          const state: DesktopPluginProvisioningState = {
            schemaVersion: 2,
            capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
            planSchemaVersion: provision.plan.schemaVersion,
            planSha256: desktopPluginProvisioningPlanSha256(provision.plan),
            composition: 'active',
            plugins: provision.results,
            removed: provision.removed.sort(),
            rolledBack: false,
            verified: true,
          }
          writeJson(join(staging, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE), state)
          result = state
        } else {
          result = undefined
        }
        let previousMoved = false
        let stagedActivated = false
        try {
          phase = 'activation'
          assertUserInventory(this.paths.profile, userInventory, { type: 'runtime-reconcile' }, undefined, undefined, ignoredArtifact)
          if (!sameInventoryEvidence(profileInventoryEvidence(this.paths.profile), evidence.before)
            || !sameInventoryEvidence(profileInventoryEvidence(staging), evidence.after)) {
            throw new Error('desktop project: activation inventories changed before replacement')
          }
          writeActivationJournal(this.activationJournal(), transaction, 'activating', evidence)
          renameSync(this.paths.profile, rollback)
          previousMoved = true
          renameSync(staging, this.paths.profile)
          stagedActivated = true
          await hooks.afterChange()
          if (provision !== undefined && 'plan' in provision) {
            assertDesktopProvisioningInventory(this.paths.profile, provision.plan)
          } else if (activePlan !== undefined && mutation.type !== 'plugins-disable-all') {
            assertDesktopProvisioningInventory(this.paths.profile, activePlan)
          }
          assertUserInventory(this.paths.profile, userInventory, mutation, targetName, preparedTarget)
          if (!sameInventoryEvidence(profileInventoryEvidence(this.paths.profile), evidence.after)) {
            throw new Error('desktop project: final inventory differs from the prepared activation')
          }
          writeActivationJournal(this.activationJournal(), transaction, 'committed', evidence)
          committed = true
        } catch (activationError) {
          phase = 'rollback'
          const failures: unknown[] = [activationError]
          if (stagedActivated) {
            try { await hooks.beforeChange() } catch (error) {
              throw new AggregateError([activationError, error], 'desktop project: activation failed and Host stop failed; rollback retained')
            }
          }
          try {
            if (stagedActivated) renameSync(this.paths.profile, failed)
            if (previousMoved) renameSync(rollback, this.paths.profile)
            if (existsSync(this.activationJournal())) unlinkSync(this.activationJournal())
          } catch (error) {
            failures.push(error)
          }
          try { await hooks.afterChange() } catch (error) { failures.push(error) }
          throw failures.length === 1
            ? activationError
            : new AggregateError(failures, 'desktop project: activation and rollback failed')
        }
        recordDesktopProfileOperation(this.paths.root, {
          transaction: basename(transaction), operation: mutation.type, ...(targetName === undefined ? {} : { target: targetName }),
          phase: 'activation', outcome: 'committed', before: evidence.before, after: evidence.after,
        })
        removeOwnedDirectory(rollback)
        unlinkSync(this.activationJournal())
        return result
      } catch (operationError) {
        // A committed journal remains recoverable if its retained audit cannot be published.
        if (auditStarted && !hasCommitted()) {
          try {
            recordDesktopProfileOperation(this.paths.root, {
              transaction: basename(transaction), operation: mutation.type, ...(targetName === undefined ? {} : { target: targetName }),
              phase, outcome: 'failed', before: beforeInventory, after: observableInventory(this.paths.profile),
            })
          } catch (recordError) {
            throw new AggregateError([operationError, recordError], 'desktop project: transaction failed and its audit could not be recorded')
          }
        }
        throw operationError
      } finally {
        if (existsSync(transaction) && !existsSync(rollback) && !existsSync(this.activationJournal())) removeOwnedDirectory(transaction)
      }
    })
  }

  /**
   * Reconcile the release-owned exact plugin inventory, or verify an already active plan.
   * @param input - Packaged provisioning plan.
   * @param hooks - Host lifecycle and staged composition health checks.
   * @returns Durable active-profile evidence.
   */
  async reconcileProvisioning(
    input: unknown,
    hooks: DesktopProjectHooks,
  ): Promise<DesktopPluginProvisioningState> {
    const plan = parseDesktopPluginProvisioningPlan(input)
    resolveProvisioning(readUserInventory(this.paths.profile), plan)
    const path = join(this.paths.profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE)
    if (existsSync(path)) {
      const state = parseDesktopPluginProvisioningState(readJson(path))
      if (this.profileMatchesRuntime(this.paths.profile) && matchesProvisioning(this.paths.profile, plan, state)) {
        return state
      }
    }
    const result = await this.mutate({ type: 'plugins-reconcile', plan }, hooks)
    if (result === undefined || !('planSha256' in result)) {
      throw new Error('desktop plugin provisioning: reconciliation returned no state')
    }
    return result
  }

  /**
   * Replace one user override with the packaged requested source through the normal transaction.
   * @param input - Packaged plan revalidated at the transaction entry.
   * @param packageName - Exact planned package retained by trusted startup recovery.
   * @param hooks - Active Host lifecycle and staged health checks.
   * @returns Durable state for the fully activated plan.
   */
  async restorePlannedSource(
    input: unknown,
    packageName: string,
    hooks: DesktopProjectHooks,
  ): Promise<DesktopPluginProvisioningState> {
    assertPackageName(packageName)
    const plan = parseDesktopPluginProvisioningPlan(input)
    const result = await this.mutate({ type: 'plugin-restore-planned', name: packageName, plan }, hooks)
    if (result === undefined || !('planSha256' in result)) throw new Error('desktop plugin provisioning: recovery returned no state')
    return result
  }

  private normalizeRetainedArtifactSpecifiers(projectDir: string): void {
    const manifest = projectManifest(projectDir)
    const receipts = readPluginReceipts(projectDir).receipts
    const snapshots = readDesktopPackageLocks(projectDir)
    const artifacts = Object.entries(manifest.dependencies).flatMap(([name, specifier]) => {
      const snapshot = snapshots[name]
      if (snapshot !== undefined && desktopPackageArtifactSpecifier(snapshot) === specifier) {
        return [{ name, specifier, sha256: snapshot.sha256 }]
      }
      const receipt = receipts[name]
      return receipt !== undefined && artifactSpecifier(receipt) === specifier
        ? [{ name, specifier, sha256: receipt.artifactSha256 }]
        : []
    })
    normalizeDesktopArtifactSpecifiers(projectDir, artifacts)
  }

  private clearPluginReceipt(projectDir: string, name: string): void {
    const store = readPluginReceipts(projectDir)
    const receipt = store.receipts[name]
    if (receipt === undefined) return
    const receipts = Object.fromEntries(Object.entries(store.receipts).filter(([entry]) => entry !== name))
    const owners = Object.fromEntries(Object.entries(store.owners).filter(([entry]) => entry !== name))
    writePluginReceipts(projectDir, { schemaVersion: 1, receipts, owners })
    this.removePackageArtifact(projectDir, receipt.artifactSha256)
  }

  private clearPackageLock(projectDir: string, name: string): void {
    const locks = readDesktopPackageLocks(projectDir)
    const lock = locks[name]
    if (lock === undefined) return
    writeDesktopPackageLocks(projectDir, Object.fromEntries(Object.entries(locks).filter(([entry]) => entry !== name)))
    this.removePackageArtifact(projectDir, lock.sha256)
  }

  private removePackageArtifact(projectDir: string, sha256: string): void {
    const directory = join(projectDir, PLUGIN_ARTIFACTS)
    if (existsSync(directory) && lstatSync(directory).isSymbolicLink()) {
      throw new Error('desktop plugin package: artifact directory must not be a link')
    }
    const artifact = join(directory, `${sha256}.tgz`)
    if (existsSync(artifact)) unlinkSync(artifact)
  }

  private pruneSourcePackage(projectDir: string, name: string): void {
    if (readDesktopPackageLocks(projectDir)[name] === undefined) return
    const manifest = projectManifest(projectDir)
    this.clearPackageLock(projectDir, name)
    writeJson(join(projectDir, 'package.json'), {
      ...manifest,
      dependencies: Object.fromEntries(Object.entries(manifest.dependencies).filter(([entry]) => entry !== name)),
      dsh: {
        ...manifest.dsh,
        profile: { ...manifest.dsh.profile, bundles: manifest.dsh.profile.bundles.filter(entry => entry !== name) },
      },
    } satisfies DesktopProjectManifest)
  }

  private async installSourcePackage(
    projectDir: string,
    input: Exclude<DesktopPluginInstallSpec, { kind: 'registry' }>,
    transaction: string,
  ): Promise<string> {
    const snapshot = await acquireDesktopSourcePackage(
      input,
      mkdtempSync(join(transaction, 'package-')),
      (directory, archive) => this.runPnpm(directory, [
        'pack', '--out', archive,
        '--config.ignore-scripts=true', '--config.ignore-pnpmfile=true',
        '--pm-on-fail=ignore', '--ignore-workspace',
      ], DESKTOP_REGISTRY, 0, false),
    )
    if (this.currentRuntime().sharedPackages.some(entry => entry.name === snapshot.packageName)) {
      throw new Error(`desktop project: cannot install host-owned package ${snapshot.packageName}`)
    }
    const manifest = projectManifest(projectDir)
    this.clearPluginReceipt(projectDir, snapshot.packageName)
    this.clearPackageLock(projectDir, snapshot.packageName)
    const artifacts = join(projectDir, PLUGIN_ARTIFACTS)
    mkdirSync(artifacts, { recursive: true, mode: 0o700 })
    copyFileSync(snapshot.path, join(artifacts, `${snapshot.sha256}.tgz`))
    const lock: DesktopPackageInstallLock = {
      packageName: snapshot.packageName, version: snapshot.version, spec: input.spec,
      resolved: snapshot.resolved, sha256: snapshot.sha256, integrity: snapshot.integrity,
      ...(snapshot.commit === undefined ? {} : { commit: snapshot.commit }),
    }
    const specifier = desktopPackageArtifactSpecifier(lock)
    await this.runPnpm(projectDir, ['add', `./${specifier.slice('file:'.length)}`, '--save-exact', '--ignore-scripts'])
    const normalizeLock = installedDependencySpecifier(projectDir, snapshot.packageName) !== specifier
    const installed = inspectInstalledPlugin(projectDir, snapshot.packageName)
    if (installed.version !== snapshot.version) throw new Error('desktop plugin package: installed version differs from the snapshot')
    writeDesktopPackageLocks(projectDir, { ...readDesktopPackageLocks(projectDir), [installed.name]: lock })
    writeJson(join(projectDir, 'package.json'), {
      ...manifest,
      dependencies: { ...manifest.dependencies, [installed.name]: specifier },
    } satisfies DesktopProjectManifest)
    // pnpm add can record Windows separators; resolve the canonical manifest spec before frozen relocation.
    if (normalizeLock) await this.runPnpm(projectDir, ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts'])
    const remaining = pluginRecords(projectDir).filter(plugin => plugin.name !== installed.name)
    writeProfilePlugins(
      projectDir,
      [...remaining, { ...installed, enabled: true }].sort((left, right) => left.name.localeCompare(right.name)),
    )
    return installed.name
  }

  private registryForMutation(projectDir: string, mutation: DesktopProjectMutation): string {
    if (mutation.type === 'plugin-install') {
      const source = parseDesktopPluginSource(mutation.source)
      return source.type === 'githubRelease' ? source.dependencyRegistry ?? DESKTOP_REGISTRY : DESKTOP_REGISTRY
    }
    if (mutation.type === 'plugin-remove' || mutation.type === 'plugin-update') {
      return readPluginReceipts(projectDir).receipts[mutation.name]?.source.dependencyRegistry ?? DESKTOP_REGISTRY
    }
    if (mutation.type === 'plugins-reconcile' || mutation.type === 'plugin-restore-planned') {
      return mutation.plan.plugins[0]?.source.dependencyRegistry ?? DESKTOP_REGISTRY
    }
    return DESKTOP_REGISTRY
  }

  private async installGithubRelease(
    projectDir: string,
    source: DesktopGithubReleasePluginSource,
    transaction: string,
    owner: DesktopPluginOwner,
    phase: (value: Extract<DesktopPluginProvisioningResult, { status: 'optional-failed' }>['phase']) => void = () => {},
  ): Promise<StagedDesktopPluginProvision> {
    if (this.currentRuntime().sharedPackages.some(entry => entry.name === source.packageName)) {
      throw new Error(`desktop project: cannot install host-owned package ${source.packageName}`)
    }
    const verified = await acquireDesktopPluginArtifact(source, mkdtempSync(join(transaction, 'download-')), fetch, phase)
    const manifest = projectManifest(projectDir)
    this.clearPackageLock(projectDir, source.packageName)
    const artifacts = join(projectDir, PLUGIN_ARTIFACTS)
    mkdirSync(artifacts, { recursive: true, mode: 0o700 })
    const artifactName = `${source.sha256}.tgz`
    copyFileSync(verified.path, join(artifacts, artifactName))
    const relativeArtifact = `./${PLUGIN_ARTIFACTS}/${artifactName}`
    phase('install')
    await this.runPnpm(
      projectDir,
      ['add', relativeArtifact, '--save-exact', '--ignore-scripts'],
      source.dependencyRegistry ?? DESKTOP_REGISTRY,
      1,
    )
    const normalizeLock = installedDependencySpecifier(projectDir, source.packageName) !== `file:${PLUGIN_ARTIFACTS}/${artifactName}`
    const installed = inspectInstalledPlugin(projectDir, source.packageName)
    if (installed.version !== source.version) {
      throw new Error('desktop project: installed verified package version does not match the source lock')
    }
    const provision: StagedDesktopPluginProvision = {
      schemaVersion: 1,
      capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
      source,
      releaseId: verified.releaseId,
      assetId: verified.assetId,
      packageName: source.packageName,
      version: source.version,
      artifactSha256: source.sha256,
    }
    writeJson(join(projectDir, 'package.json'), {
      ...manifest,
      dependencies: { ...manifest.dependencies, [source.packageName]: `file:${PLUGIN_ARTIFACTS}/${artifactName}` },
    } satisfies DesktopProjectManifest)
    const store = readPluginReceipts(projectDir)
    writePluginReceipts(projectDir, {
      schemaVersion: 1,
      owners: { ...store.owners, [source.packageName]: owner },
      receipts: {
        ...store.receipts,
        [source.packageName]: {
          ...provision,
          states: { staged: true, health: 'passed', activated: true, rolledBack: false, verified: true },
        },
      },
    })
    if (normalizeLock) await this.runPnpm(projectDir, ['install', '--lockfile-only', '--no-frozen-lockfile', '--ignore-scripts'], source.dependencyRegistry ?? DESKTOP_REGISTRY)
    const current = pluginRecords(projectDir).filter(plugin => plugin.name !== installed.name)
    writeProfilePlugins(
      projectDir,
      [...current, { ...installed, enabled: true }].sort((left, right) => left.name.localeCompare(right.name)),
    )
    return provision
  }

  private async stageProvisioning(
    projectDir: string,
    plan: DesktopPluginProvisioningPlan,
    transaction: string,
    hooks: DesktopProjectHooks,
    forceRequestedSourceFor: ReadonlySet<string> = new Set(),
  ): Promise<StagedDesktopProvisioning> {
    const manifest = projectManifest(projectDir)
    const store = readPluginReceipts(projectDir)
    const resolution = resolveProvisioning(readUserInventory(projectDir), plan, forceRequestedSourceFor)
    const owned = Object.keys(store.receipts).filter(name => store.owners[name] === 'release')
    const desired = new Set(plan.plugins.map(entry => entry.source.packageName))
    const retainedRelease = new Map<string, DesktopPluginProvisionReceipt>()
    if (forceRequestedSourceFor.size > 0) {
      for (const entry of plan.plugins) {
        const name = entry.source.packageName, receipt = store.receipts[name]
        if (!forceRequestedSourceFor.has(name) && store.owners[name] === 'release' && receipt !== undefined
          && JSON.stringify(receipt.source) === JSON.stringify(entry.source)
          && manifest.dependencies[name] === artifactSpecifier(receipt)
          && profilePluginNames(projectDir).includes(name)) {
          userArtifactSha256(projectDir, name, receipt, undefined)
          retainedRelease.set(name, receipt)
        }
      }
    }
    const preserved = new Set([
      ...[...resolution.entries].filter(([, decision]) => decision.receipt !== undefined).map(([name]) => name),
      ...retainedRelease.keys(),
    ])
    const replace = new Set([...owned, ...desired].filter(name => !preserved.has(name)))
    const removed = owned.filter(name => !desired.has(name))
    for (const name of replace) this.clearPluginReceipt(projectDir, name)
    writeJson(join(projectDir, 'package.json'), {
      ...manifest,
      dependencies: Object.fromEntries(Object.entries(manifest.dependencies).filter(([name]) => !replace.has(name))),
      dsh: { ...manifest.dsh, profile: {
        ...manifest.dsh.profile,
        bundles: manifest.dsh.profile.bundles.filter(name => !replace.has(name)),
      } },
    })
    const registry = plan.plugins[0]?.source.dependencyRegistry ?? DESKTOP_REGISTRY
    if (Object.keys(manifest.dependencies).length > 0) await this.runPnpm(projectDir, ['install', '--no-frozen-lockfile', '--ignore-scripts'], registry)
    const results = new Map<string, DesktopPluginProvisioningResult>()
    const activeResult = (
      entry: DesktopPluginProvisioningPlan['plugins'][number],
      provision: StagedDesktopPluginProvision | DesktopPluginProvisionReceipt,
      effective: 'plan' | 'user-override' = 'plan',
    ): DesktopPluginProvisioningResult => {
      const receipt: DesktopPluginProvisionReceipt = 'states' in provision ? provision : {
        ...provision, states: { staged: true, health: 'passed', activated: true, rolledBack: false, verified: true },
      }
      return {
        name: entry.source.packageName, required: entry.required, status: 'active', requestedSource: entry.source,
        sourcePolicy: provisioningSourcePolicy(entry), effective, effectiveSource: receipt.source, receipt,
      }
    }
    for (const [name, decision] of resolution.entries) {
      if (decision.receipt !== undefined) results.set(name, activeResult(decision.entry, decision.receipt, decision.effective))
      else {
        const receipt = retainedRelease.get(name)
        if (receipt !== undefined) results.set(name, activeResult(decision.entry, receipt))
      }
    }
    for (const entry of plan.plugins.filter(entry => entry.required && !preserved.has(entry.source.packageName))) {
      const receipt = await this.installGithubRelease(projectDir, entry.source, transaction, 'release')
      results.set(entry.source.packageName, activeResult(entry, receipt))
    }
    await this.reconcileProfile(projectDir, undefined, existsSync(this.pendingPackages(projectDir)), registry)
    try { await hooks.healthCheck(projectDir) } catch (error) {
      const overrides = [...resolution.entries.values()].filter(decision => decision.effective === 'user-override')
      const override = overrides.length === 1 ? overrides[0] : undefined
      if (override !== undefined) {
        throw new DesktopProvisioningOverrideHealthError(
          override.entry.source.packageName, override.entry.source.version, error,
        )
      }
      throw error
    }
    for (const entry of plan.plugins.filter(entry => !entry.required && !preserved.has(entry.source.packageName))) {
      const candidate = mkdtempSync(join(transaction, 'optional-'))
      let phase: Extract<DesktopPluginProvisioningResult, { status: 'optional-failed' }>['phase'] = 'install'
      try {
        let provision: StagedDesktopPluginProvision
        try {
          copyProfileMetadata(projectDir, candidate)
          if (Object.keys(projectManifest(candidate).dependencies).length > 0) await this.runPnpm(candidate, ['install', '--frozen-lockfile', '--ignore-scripts'], registry)
          provision = await this.installGithubRelease(candidate, entry.source, transaction, 'release', (value) => { phase = value })
          phase = 'graph'
          this.prepareProfile(candidate)
          phase = 'install'
          await this.finishPackageOperation(candidate, registry)
          phase = 'health'
          await hooks.healthCheck(candidate)
        } catch (error) {
          results.set(entry.source.packageName, {
            name: entry.source.packageName, requestedSource: entry.source, sourcePolicy: provisioningSourcePolicy(entry),
            required: false, status: 'optional-failed', phase,
            message: errorOf(error, 'desktop plugin provisioning: optional entry failed').message,
          })
          continue
        }
        const superseded = join(transaction, 'optional-predecessor')
        renameSync(projectDir, superseded)
        try { renameSync(candidate, projectDir) } catch (error) {
          renameSync(superseded, projectDir)
          throw error
        }
        removeOwnedDirectory(superseded)
        results.set(entry.source.packageName, activeResult(entry, provision))
      } finally {
        if (existsSync(candidate)) removeOwnedDirectory(candidate)
      }
    }
    return { plan, results: plan.plugins.map((entry) => {
      const result = results.get(entry.source.packageName)
      if (result === undefined) throw new Error('desktop plugin provisioning: missing staged result')
      return result
    }), removed }
  }

  private async reconcileProfile(
    projectDir: string,
    previous: DesktopProfileState | undefined,
    packagesChanged = false,
    registry = DESKTOP_REGISTRY,
  ): Promise<void> {
    const target = this.currentRuntime()
    const rebuild = !packagesChanged && (existsSync(this.pendingPackages(projectDir))
      || (previous !== undefined && pluginRecords(projectDir).length > 0
      && (previous.nodeVersion !== target.release.nodeVersion || previous.platform !== target.platform || previous.arch !== target.arch)))
    if (rebuild) {
      writeFileSync(this.pendingPackages(projectDir), '')
      if (this.runtime.profileResolution !== 'runtime') unlinkDesktopHostPackages(projectDir)
      removeOwnedDirectory(join(projectDir, 'node_modules'))
      await this.runPnpm(projectDir, ['install', '--frozen-lockfile', '--ignore-scripts'], registry)
    }
    if (rebuild || packagesChanged) await this.finishPackageOperation(projectDir, registry)
    else this.prepareProfile(projectDir)
  }

  private async finishPackageOperation(projectDir: string, registry = DESKTOP_REGISTRY): Promise<void> {
    this.prepareProfile(projectDir)
    await this.runPnpm(projectDir, ['rebuild', '--pending'], registry)
    this.prepareProfile(projectDir)
    unlinkSync(this.pendingPackages(projectDir))
  }

  private async applyMutation(
    projectDir: string,
    mutation: Exclude<DesktopProjectMutation, { type: 'plugins-disable-all' | 'plugins-reconcile' | 'plugin-restore-planned' | 'runtime-reconcile' }>,
    transaction: string,
  ): Promise<AppliedDesktopMutation> {
    switch (mutation.type) {
      case 'plugin-add': {
        const parsed = parseDesktopPluginInstallSpec(mutation.spec, process.cwd())
        if (parsed.kind !== 'registry') {
          return { target: await this.installSourcePackage(projectDir, parsed, transaction) }
        }
        const requestedName = parsed.name
        if (this.currentRuntime().sharedPackages.some(entry => entry.name === requestedName)) {
          throw new Error(`desktop project: cannot install host-owned package ${requestedName}`)
        }
        await this.runPnpm(projectDir, ['add', parsed.spec, '--save-exact', '--ignore-scripts'])
        this.clearPluginReceipt(projectDir, requestedName)
        this.clearPackageLock(projectDir, requestedName)
        const installed = { ...inspectPlugin(projectDir, requestedName), enabled: true }
        const current = pluginRecords(projectDir).filter(plugin => plugin.name !== installed.name)
        writeProfilePlugins(
          projectDir,
          [...current, installed].sort((left, right) => left.name.localeCompare(right.name)),
        )
        return { target: installed.name }
      }
      case 'plugin-install': {
        const source = parseDesktopPluginSource(mutation.source)
        if (source.type !== 'githubRelease') {
          if (source.type === 'npmRegistry') packageNameFromSpec(source.spec)
          return this.applyMutation(projectDir, { type: 'plugin-add', spec: source.spec }, transaction)
        }
        return { target: source.packageName, provision: await this.installGithubRelease(projectDir, source, transaction, 'user') }
      }
      case 'plugin-remove': {
        assertPackageName(mutation.name)
        if (!Object.hasOwn(projectManifest(projectDir).dependencies, mutation.name)) {
          throw new Error(`desktop project: plugin ${JSON.stringify(mutation.name)} is not installed`)
        }
        const remaining = pluginRecords(projectDir).filter(plugin => plugin.name !== mutation.name)
        await this.runPnpm(projectDir, ['remove', mutation.name, '--config.ignore-scripts=true'])
        this.clearPluginReceipt(projectDir, mutation.name)
        this.clearPackageLock(projectDir, mutation.name)
        writeProfilePlugins(projectDir, remaining)
        return { target: mutation.name }
      }
      case 'plugin-update':
        assertPackageName(mutation.name)
        assertVersion(mutation.version)
        if (readDesktopPackageLocks(projectDir)[mutation.name] !== undefined) {
          throw new Error('desktop plugin package: update a source-installed plugin by installing its source again, not a registry version')
        }
        if (!Object.hasOwn(projectManifest(projectDir).dependencies, mutation.name)) {
          throw new Error(`desktop project: plugin ${JSON.stringify(mutation.name)} is not installed`)
        }
        await this.runPnpm(projectDir, ['add', `${mutation.name}@${mutation.version}`, '--save-exact', '--ignore-scripts'])
        this.clearPluginReceipt(projectDir, mutation.name)
        {
          const installed = inspectPlugin(projectDir, mutation.name)
          writeProfilePlugins(
            projectDir,
            pluginRecords(projectDir).map(plugin => plugin.name === installed.name ? installed : plugin),
          )
        }
        return { target: mutation.name }
      case 'plugin-toggle': {
        assertPackageName(mutation.name)
        const plugins = pluginRecords(projectDir)
        if (!plugins.some(plugin => plugin.name === mutation.name)) throw new Error(`desktop project: plugin ${mutation.name} is not installed`)
        writeProfilePlugins(projectDir, plugins.map(plugin => (
          plugin.name === mutation.name ? { ...plugin, enabled: mutation.enabled } : plugin
        )))
        return { target: mutation.name }
      }
      default:
        return mutation satisfies never
    }
  }

  private async runPnpm(
    projectDir: string,
    args: readonly string[],
    registry = DESKTOP_REGISTRY,
    retries = 0,
    markPending = true,
  ): Promise<void> {
    let failure: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.runPnpmAttempt(projectDir, args, registry, markPending)
        return
      } catch (error) {
        failure = error
      }
    }
    throw errorOf(failure, 'desktop project: pnpm failed')
  }

  private async runPnpmAttempt(projectDir: string, args: readonly string[], registry: string, markPending: boolean): Promise<void> {
    if (resolve(projectDir) === resolve(this.paths.profile)) {
      throw new Error('desktop project: package operations require a private staging profile')
    }
    if (args.includes('--frozen-lockfile')) this.normalizeRetainedArtifactSpecifiers(projectDir)
    const registryUrl = new URL(registry)
    if (registryUrl.protocol !== 'https:' || registryUrl.username !== '' || registryUrl.password !== ''
      || registryUrl.search !== '' || registryUrl.hash !== '') {
      throw new Error('desktop project: pnpm registry must be a credential-free HTTPS URL')
    }
    const [command, ...commandArgs] = args
    if (command === undefined) throw new Error('desktop project: pnpm command is required')
    for (const path of [this.paths.root, this.paths.pnpm.store, this.paths.pnpm.cache,
      this.paths.pnpm.state, this.paths.pnpm.config, this.paths.pnpm.home]) {
      mkdirSync(path, { recursive: true, mode: 0o700 })
    }
    const npmrc = join(this.paths.pnpm.config, 'npmrc')
    if (!existsSync(npmrc)) writeFileSync(npmrc, '', { mode: 0o600 })
    const inherited = Object.fromEntries(Object.entries(process.env).filter(([name]) => (
      name !== 'NODE_OPTIONS' && name !== 'NODE_PATH' && !/^DSH_DESKTOP_/u.test(name)
      && !/^(?:npm|pnpm|corepack)_/iu.test(name) && !/(?:AUTH|KEY|SECRET|TOKEN|PASSWORD)/iu.test(name)
    )))
    if (markPending) writeFileSync(this.pendingPackages(projectDir), '')
    await new Promise<void>((settle, reject) => {
      const child = spawn(this.runtime.node, [
        this.runtime.pnpm,
        ...(markPending ? [] : ['pm']),
        `--config.registry=${registry}`,
        `--config.store-dir=${this.paths.pnpm.store}`,
        '--config.enable-global-virtual-store=false',
        `--config.userconfig=${npmrc}`,
        command,
        ...commandArgs,
      ], {
        cwd: projectDir,
        env: {
          ...inherited,
          APPDATA: this.paths.pnpm.config,
          COREPACK_HOME: this.paths.pnpm.home,
          HOME: this.paths.pnpm.home,
          LOCALAPPDATA: this.paths.pnpm.state,
          NPM_CONFIG_GLOBALCONFIG: npmrc,
          NPM_CONFIG_REGISTRY: registry,
          NPM_CONFIG_STORE_DIR: this.paths.pnpm.store,
          NPM_CONFIG_USERCONFIG: npmrc,
          PATH: `${dirname(this.runtime.node)}${delimiter}${process.env.PATH ?? ''}`,
          PNPM_HOME: this.paths.pnpm.home,
          USERPROFILE: this.paths.pnpm.home,
          XDG_CACHE_HOME: this.paths.pnpm.cache,
          XDG_CONFIG_HOME: this.paths.pnpm.config,
          XDG_STATE_HOME: this.paths.pnpm.state,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let failure: Error | undefined
      let diagnostics = ''
      let completed = false
      const timeout = setTimeout(() => {
        failure = new Error(`desktop project: pnpm exceeded ${String(PNPM_TIMEOUT_MS)}ms`)
        child.kill('SIGKILL')
      }, PNPM_TIMEOUT_MS)
      timeout.unref()
      const appendDiagnostics = (chunk: string): void => {
        diagnostics = (diagnostics + chunk).slice(-MAX_PNPM_DIAGNOSTIC_BYTES)
      }
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', appendDiagnostics)
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', appendDiagnostics)
      const complete = (settleChild: () => void): void => {
        if (completed) return
        completed = true
        clearTimeout(timeout)
        try {
          this.writeLockOwner(process.pid)
        } catch (error) {
          reject(errorOf(error, 'desktop project: failed to return the package transaction lock to Electron'))
          return
        }
        settleChild()
      }
      child.once('error', (error) => { failure = error })
      child.once('close', (code, signal) => {
        complete(() => {
          if (failure !== undefined) { reject(failure); return }
          if (code === 0) {
            settle()
            return
          }
          reject(new Error(
            `desktop project: pnpm exited with ${String(code ?? signal)}${diagnostics.trim() === '' ? '' : `: ${diagnostics.trim()}`}`,
          ))
        })
      })
      try {
        if (child.pid === undefined) throw new Error('desktop project: pnpm did not report a process id')
        this.writeLockOwner(child.pid)
      } catch (error) {
        failure = errorOf(error, 'desktop project: failed to assign the package transaction lock to pnpm')
        child.kill('SIGKILL')
      }
    })
  }

  private writeLockOwner(pid: number): void {
    const descriptor = this.lockDescriptor
    if (descriptor === undefined) throw new Error('desktop project: package transaction lost its lock')
    const content = Buffer.from(`${String(pid)}\n`)
    ftruncateSync(descriptor, 0)
    writeSync(descriptor, content, 0, content.byteLength, 0)
    fsyncSync(descriptor)
  }

  private async withLock<T>(operation: () => T | Promise<T>): Promise<T> {
    mkdirSync(this.paths.profile, { recursive: true, mode: 0o700 })
    mkdirSync(dirname(this.paths.lock), { recursive: true, mode: 0o700 })
    if (lstatSync(this.paths.profile).isSymbolicLink()) throw new Error('desktop project: profile directory must not be a link')
    let descriptor: number
    try {
      descriptor = openSync(this.paths.lock, 'wx', 0o600)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const lock = lstatSync(this.paths.lock)
        if (lock.isSymbolicLink() || !lock.isFile()) {
          throw new Error('desktop project: package transaction lock is not a regular file')
        }
        const owner = Number.parseInt(readFileSync(this.paths.lock, 'utf8').trim(), 10)
        let active = !Number.isSafeInteger(owner) || owner <= 0
        if (!active) {
          try {
            process.kill(owner, 0)
            active = true
          } catch (signalError) {
            active = (signalError as NodeJS.ErrnoException).code !== 'ESRCH'
          }
        }
        if (active) throw new Error('desktop project: another package transaction is active')
        unlinkSync(this.paths.lock)
        descriptor = openSync(this.paths.lock, 'wx', 0o600)
      } else {
        throw error
      }
    }
    try {
      this.lockDescriptor = descriptor
      this.writeLockOwner(process.pid)
      this.recoverActivation()
      return await operation()
    } finally {
      this.lockDescriptor = undefined
      closeSync(descriptor)
      unlinkSync(this.paths.lock)
    }
  }
}

/** Create build-only project metadata for materializing the signed runtime. */
export function createRuntimeProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const packageSet = verifyDesktopCorePackageSet(projectDir, release.version)
  const manifest: DesktopProjectManifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: desktopCorePackageOverrides(packageSet),
    dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(
    join(projectDir, 'pnpm-workspace.yaml'),
    workspaceFile(desktopCorePackageOverrides(packageSet)),
    { mode: 0o600 },
  )
}

/**
 * Create metadata for the unpackaged development project that links the current workspace.
 * @param projectDir - Disposable development profile directory.
 * @param release - Release identity shared by the linked CLI package and Electron shell.
 */
export function createDevelopmentProjectMetadata(projectDir: string, release: DesktopRelease): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  const manifest = {
    name: PROJECT_NAME,
    private: true,
    version: '0.0.0',
    dependencies: {
      [DSH_PACKAGE]: release.version,
      [DESKTOP_HOST_PACKAGE]: release.version,
    },
    dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
  }
  writeJson(join(projectDir, 'package.json'), manifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}

/**
 * Initialize a new profile without replacing existing package or runtime metadata.
 * @param projectDir - New profile directory; unrelated files are retained.
 */
export function createPluginProfile(projectDir: string): void {
  const metadata = [
    'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'node_modules', 'desktop.cordis.yml',
    'desktop-runtime-state.json', 'desktop-packages-pending', 'desktop-plugin-package-locks.json',
    PLUGIN_RECEIPTS, PLUGIN_ARTIFACTS, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE,
  ]
  if (metadata.some(name => lstatSync(join(projectDir, name), { throwIfNoEntry: false }) !== undefined)) {
    throw new Error('desktop project: runtime metadata is missing from an existing profile; inspect the retained files before recovery')
  }
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  writeJson(join(projectDir, 'package.json'), {
    name: PROJECT_NAME, private: true, version: '0.0.0', dependencies: {},
    dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
  } satisfies DesktopProjectManifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}
