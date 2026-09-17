/** Transactional owner of the reserved desktop profile and its private pnpm state. */

import { valid } from 'semver'
import { createHash } from 'node:crypto'
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
  type DesktopPluginProvisioningPlan,
  type DesktopPluginProvisioningResult,
  type DesktopPluginProvisioningState,
} from './plugin-provisioning.ts'
import {
  desktopPluginLockHash, linkDesktopHostPackages, readDesktopProfileState,
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

interface DesktopPluginReceiptStore {
  readonly schemaVersion: 1
  readonly receipts: Record<string, DesktopPluginProvisionReceipt>
}

type StagedDesktopPluginProvision = Omit<DesktopPluginProvisionReceipt, 'states'>

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

function writeActivationJournal(path: string, transaction: string, phase: 'activating' | 'committed'): void {
  const temporary = `${path}.tmp`
  const descriptor = openSync(temporary, 'w', 0o600)
  try {
    writeSync(descriptor, `${JSON.stringify({ schemaVersion: 1, transaction: basename(transaction), phase })}\n`)
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  renameSync(temporary, path)
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function readPluginReceipts(projectDir: string): DesktopPluginReceiptStore {
  const path = join(projectDir, PLUGIN_RECEIPTS)
  if (!existsSync(path)) return { schemaVersion: 1, receipts: Object.create(null) as Record<string, DesktopPluginProvisionReceipt> }
  const value = readJson(path)
  if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.receipts)) {
    throw new Error('desktop project: invalid plugin receipt store')
  }
  const receipts = Object.create(null) as Record<string, DesktopPluginProvisionReceipt>
  for (const [name, receipt] of Object.entries(value.receipts)) {
    assertPackageName(name)
    const parsed = parseDesktopPluginProvisionReceipt(receipt)
    if (parsed.packageName !== name) {
      throw new Error(`desktop project: invalid plugin receipt for ${name}`)
    }
    receipts[name] = parsed
  }
  return { schemaVersion: 1, receipts }
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
  const receipts = readPluginReceipts(projectDir).receipts
  const desired = new Map(plan.plugins.map(entry => [entry.source.packageName, entry]))
  if (Object.keys(receipts).some(name => !desired.has(name))) return false
  return state.plugins.every((result) => {
    const entry = desired.get(result.name)
    if (entry === undefined || entry.required !== result.required
      || JSON.stringify(entry.source) !== JSON.stringify(result.source)) return false
    if (result.status === 'optional-failed') {
      return !entry.required && receipts[result.name] === undefined
        && !Object.hasOwn(manifest.dependencies, result.name)
        && !profilePluginNames(projectDir).includes(result.name)
    }
    const receipt = receipts[result.name]
    if (receipt === undefined || JSON.stringify(receipt) !== JSON.stringify(result.receipt)
      || receipt.artifactSha256 !== entry.source.sha256
      || manifest.dependencies[result.name] !== artifactSpecifier(receipt)
      || !existsSync(join(projectDir, 'node_modules', result.name, 'package.json'))) return false
    const plugin = inspectPlugin(projectDir, result.name)
    return plugin.version === entry.source.version && plugin.enabled
      && createHash('sha256').update(readFileSync(join(projectDir, PLUGIN_ARTIFACTS, `${receipt.artifactSha256}.tgz`)))
        .digest('hex') === entry.source.sha256
  })
}

/**
 * Validate durable results against the actual receipt-owned installed inventory.
 * @param projectDir - Active profile whose Host has reached readiness.
 * @param plan - Installed release's reviewed exact inventory.
 * @returns Matching active provisioning evidence; throws on missing or drifted inventory.
 */
export function assertDesktopProvisioningInventory(
  projectDir: string,
  plan: DesktopPluginProvisioningPlan,
): DesktopPluginProvisioningState {
  const state = parseDesktopPluginProvisioningState(readJson(join(projectDir, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE)))
  if (!matchesProvisioning(projectDir, plan, state)) {
    throw new Error('desktop plugin provisioning: active inventory does not match the release plan')
  }
  return state
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
  if (!PACKAGE_NAME_PATTERN.test(name)) throw new Error(`desktop project: invalid npm package name ${JSON.stringify(name)}`)
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
   * Reinitialize the profile, deleting configuration and third-party packages without a backup.
   * @param hooks - Stop the Host before resetting files; restart after preparation succeeds.
   * @returns Completion of reset; the held lock and shared product data are preserved.
   */
  async resetConfiguration(hooks: DesktopProjectHooks): Promise<void> {
    await this.withLock(async () => {
      await hooks.beforeChange()
      this.descriptor = this.readRuntime()
      for (const entry of readdirSync(this.paths.profile, { withFileTypes: true })) {
        const path = join(this.paths.profile, entry.name)
        if (path === this.paths.lock) continue
        if (entry.isDirectory()) removeOwnedDirectory(path)
        else unlinkSync(path)
      }
      createPluginProfile(this.paths.profile)
      this.prepareProfile(this.paths.profile)
      await hooks.afterChange()
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
    if (!existsSync(journal)) return
    const value = readJson(journal)
    if (!isRecord(value) || value.schemaVersion !== 1
      || typeof value.transaction !== 'string' || !/^\.desktop-transaction-[A-Za-z0-9]+$/u.test(value.transaction)
      || (value.phase !== 'activating' && value.phase !== 'committed')) {
      throw new Error('desktop project: invalid profile activation recovery journal')
    }
    const transaction = join(dirname(this.paths.profile), value.transaction)
    const rollback = join(transaction, 'rollback')
    for (const path of [transaction, rollback]) {
      if (existsSync(path) && (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink())) {
        throw new Error(`desktop project: recovery path is not an owned directory: ${path}`)
      }
    }
    if (value.phase === 'activating' && existsSync(rollback)) {
      if (existsSync(this.paths.profile)) {
        renameSync(this.paths.profile, join(transaction, `recovery-${Date.now()}`))
      }
      renameSync(rollback, this.paths.profile)
    }
    if (!existsSync(join(this.paths.profile, 'package.json'))) {
      throw new Error(`desktop project: profile recovery requires inspection of ${transaction}`)
    }
    unlinkSync(journal)
    if (existsSync(transaction)) removeOwnedDirectory(transaction)
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
    linkDesktopHostPackages(projectDir, this.runtime.dsh, runtime)
    validateDesktopPluginGraph(projectDir, this.runtime.dsh, runtime, profilePluginNames(projectDir))
  }

  private profileMatchesRuntime(projectDir: string): boolean {
    const target = this.currentRuntime()
    const previous = readDesktopProfileState(projectDir)
    return !existsSync(this.pendingPackages(projectDir))
      && previous?.runtimeId === desktopRuntimeId(target)
      && previous.lockHash === desktopPluginLockHash(projectDir)
      && previous.links.length === target.sharedPackages.length
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
      const target = this.readRuntime()
      this.descriptor = target
      const previous = readDesktopProfileState(this.paths.profile)
      if (this.profileMatchesRuntime(this.paths.profile)) return false
      if (previous === undefined) createPluginProfile(this.paths.profile)
      return true
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
      if (!existsSync(this.paths.profile)) throw new Error('desktop project: active profile is not installed')
      const parent = dirname(this.paths.profile)
      mkdirSync(parent, { recursive: true, mode: 0o700 })
      const transaction = mkdtempSync(join(parent, '.desktop-transaction-'))
      const staging = join(transaction, 'staging')
      const rollback = join(transaction, 'rollback')
      const failed = join(transaction, 'failed')
      try {
        copyProfileMetadata(this.paths.profile, staging)
        const removingSnapshot = mutation.type === 'plugin-remove' && readDesktopPackageLocks(staging)[mutation.name] !== undefined
        if (removingSnapshot) this.pruneSourcePackage(staging, mutation.name)
        if (mutation.type === 'plugins-reconcile') {
          for (const entry of mutation.plan.plugins) this.pruneSourcePackage(staging, entry.source.packageName)
        }
        for (const snapshot of Object.values(readDesktopPackageLocks(staging))) {
          verifyDesktopPackageArtifact(staging, snapshot)
        }
        const previous = readDesktopProfileState(staging)
        const registry = this.registryForMutation(staging, mutation)
        if (mutation.type !== 'plugins-reconcile' && (removingSnapshot || Object.keys(projectManifest(staging).dependencies).length > 0)) {
          if (!removingSnapshot) this.normalizeRetainedArtifactSpecifiers(staging)
          await this.runPnpm(staging, ['install', removingSnapshot ? '--no-frozen-lockfile' : '--frozen-lockfile', '--ignore-scripts'], registry)
        }
        let provision: StagedDesktopPluginProvision | StagedDesktopProvisioning | undefined
        if (mutation.type === 'plugins-reconcile') {
          provision = await this.stageProvisioning(staging, mutation.plan, transaction, hooks)
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
          const packagesChanged = mutation.type !== 'plugin-toggle' || existsSync(this.pendingPackages(staging))
          if (packagesChanged) unlinkDesktopHostPackages(staging)
          try {
            provision = await this.applyMutation(staging, mutation, transaction)
          } finally {
            if (packagesChanged) linkDesktopHostPackages(staging, this.runtime.dsh, this.currentRuntime())
          }
          await this.reconcileProfile(staging, previous, packagesChanged, registry)
        }
        await hooks.beforeChange()
        try {
          await hooks.healthCheck(staging)
        } catch (healthError) {
          try {
            await hooks.afterChange()
          } catch (restartError) {
            throw new AggregateError([healthError, restartError], 'desktop project: staged health check and active Host restart failed')
          }
          throw healthError
        }
        let result: DesktopProjectMutationResult
        if (provision !== undefined && !('plan' in provision)) {
          const receipt: DesktopPluginProvisionReceipt = {
            ...provision,
            states: { staged: true, health: 'passed', activated: true, rolledBack: false, verified: true },
          }
          const store = readPluginReceipts(staging)
          writePluginReceipts(staging, {
            schemaVersion: 1,
            receipts: { ...store.receipts, [receipt.packageName]: receipt },
          })
          result = receipt
        } else if (provision !== undefined) {
          const state: DesktopPluginProvisioningState = {
            schemaVersion: 1,
            capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
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
          writeActivationJournal(this.activationJournal(), transaction, 'activating')
          renameSync(this.paths.profile, rollback)
          previousMoved = true
          renameSync(staging, this.paths.profile)
          stagedActivated = true
          await hooks.afterChange()
          if (provision !== undefined && 'plan' in provision) {
            assertDesktopProvisioningInventory(this.paths.profile, provision.plan)
          }
          writeActivationJournal(this.activationJournal(), transaction, 'committed')
        } catch (activationError) {
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
        removeOwnedDirectory(rollback)
        unlinkSync(this.activationJournal())
        return result
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
    writePluginReceipts(projectDir, { schemaVersion: 1, receipts })
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
  ): Promise<void> {
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
  }

  private registryForMutation(projectDir: string, mutation: DesktopProjectMutation): string {
    if (mutation.type === 'plugin-install') {
      const source = parseDesktopPluginSource(mutation.source)
      return source.type === 'githubRelease' ? source.dependencyRegistry ?? DESKTOP_REGISTRY : DESKTOP_REGISTRY
    }
    if (mutation.type === 'plugin-remove' || mutation.type === 'plugin-update') {
      return readPluginReceipts(projectDir).receipts[mutation.name]?.source.dependencyRegistry ?? DESKTOP_REGISTRY
    }
    if (mutation.type === 'plugins-reconcile') {
      return mutation.plan.plugins[0]?.source.dependencyRegistry ?? DESKTOP_REGISTRY
    }
    return DESKTOP_REGISTRY
  }

  private async installGithubRelease(
    projectDir: string,
    source: DesktopGithubReleasePluginSource,
    transaction: string,
    phase: (value: NonNullable<DesktopPluginProvisioningResult['phase']>) => void = () => {},
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
  ): Promise<StagedDesktopProvisioning> {
    const manifest = projectManifest(projectDir)
    const owned = Object.keys(readPluginReceipts(projectDir).receipts)
    const desired = new Set(plan.plugins.map(entry => entry.source.packageName))
    const replace = new Set([...owned, ...desired])
    const removed = owned.filter(name => !desired.has(name))
    for (const name of owned) this.clearPluginReceipt(projectDir, name)
    writeJson(join(projectDir, 'package.json'), {
      ...manifest,
      dependencies: Object.fromEntries(Object.entries(manifest.dependencies).filter(([name]) => !replace.has(name))),
      dsh: { ...manifest.dsh, profile: {
        ...manifest.dsh.profile,
        bundles: manifest.dsh.profile.bundles.filter(name => !replace.has(name)),
      } },
    })
    const registry = plan.plugins[0]?.source.dependencyRegistry ?? DESKTOP_REGISTRY
    if (Object.keys(manifest.dependencies).length > 0) {
      await this.runPnpm(projectDir, ['install', '--no-frozen-lockfile', '--ignore-scripts'], registry)
    }
    const results = new Map<string, DesktopPluginProvisioningResult>()
    const activeResult = (entry: DesktopPluginProvisioningPlan['plugins'][number], receipt: StagedDesktopPluginProvision): DesktopPluginProvisioningResult => ({
      name: entry.source.packageName,
      version: entry.source.version,
      required: entry.required,
      status: 'active',
      source: entry.source,
      receipt: { ...receipt, states: { staged: true, health: 'passed', activated: true, rolledBack: false, verified: true } },
    })
    for (const entry of plan.plugins.filter(entry => entry.required)) {
      results.set(entry.source.packageName, activeResult(entry, await this.installGithubRelease(projectDir, entry.source, transaction)))
    }
    await this.reconcileProfile(projectDir, undefined, existsSync(this.pendingPackages(projectDir)), registry)
    await hooks.healthCheck(projectDir)
    for (const entry of plan.plugins.filter(entry => !entry.required)) {
      const candidate = mkdtempSync(join(transaction, 'optional-'))
      let phase: NonNullable<DesktopPluginProvisioningResult['phase']> = 'install'
      try {
        let provision: StagedDesktopPluginProvision
        try {
          copyProfileMetadata(projectDir, candidate)
          if (Object.keys(projectManifest(candidate).dependencies).length > 0) {
            await this.runPnpm(candidate, ['install', '--frozen-lockfile', '--ignore-scripts'], registry)
          }
          provision = await this.installGithubRelease(candidate, entry.source, transaction, (value) => { phase = value })
          phase = 'graph'
          this.prepareProfile(candidate)
          phase = 'install'
          await this.finishPackageOperation(candidate, registry)
          phase = 'health'
          await hooks.healthCheck(candidate)
        } catch (error) {
          results.set(entry.source.packageName, {
            name: entry.source.packageName, version: entry.source.version, source: entry.source,
            required: false, status: 'optional-failed', phase,
            message: errorOf(error, 'desktop plugin provisioning: optional entry failed').message,
          })
          continue
        }
        const superseded = join(transaction, 'optional-predecessor')
        renameSync(projectDir, superseded)
        try {
          renameSync(candidate, projectDir)
        } catch (error) {
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
      unlinkDesktopHostPackages(projectDir)
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
    mutation: Exclude<DesktopProjectMutation, { type: 'plugins-disable-all' | 'plugins-reconcile' | 'runtime-reconcile' }>,
    transaction: string,
  ): Promise<StagedDesktopPluginProvision | StagedDesktopProvisioning | undefined> {
    switch (mutation.type) {
      case 'plugin-add': {
        const parsed = parseDesktopPluginInstallSpec(mutation.spec, process.cwd())
        if (parsed.kind !== 'registry') {
          await this.installSourcePackage(projectDir, parsed, transaction)
          return
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
        return
      }
      case 'plugin-install': {
        const source = parseDesktopPluginSource(mutation.source)
        if (source.type !== 'githubRelease') {
          if (source.type === 'npmRegistry') packageNameFromSpec(source.spec)
          return this.applyMutation(projectDir, { type: 'plugin-add', spec: source.spec }, transaction)
        }
        return this.installGithubRelease(projectDir, source, transaction)
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
        return
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
        return
      case 'plugin-toggle': {
        assertPackageName(mutation.name)
        const plugins = pluginRecords(projectDir)
        if (!plugins.some(plugin => plugin.name === mutation.name)) throw new Error(`desktop project: plugin ${mutation.name} is not installed`)
        writeProfilePlugins(projectDir, plugins.map(plugin => (
          plugin.name === mutation.name ? { ...plugin, enabled: mutation.enabled } : plugin
        )))
        return
      }
      default:
        mutation satisfies never
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

/** Create the first external plugin profile without running a package manager. */
export function createPluginProfile(projectDir: string): void {
  mkdirSync(projectDir, { recursive: true, mode: 0o700 })
  writeJson(join(projectDir, 'package.json'), {
    name: PROJECT_NAME, private: true, version: '0.0.0', dependencies: {},
    dsh: { profile: { bundles: [...DESKTOP_PROFILE_BUNDLES] } },
  } satisfies DesktopProjectManifest)
  writeFileSync(join(projectDir, 'pnpm-workspace.yaml'), workspaceFile(), { mode: 0o600 })
}
