/** Build and verify the source-owned unsigned Windows Desktop release record. */

import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { gt, valid } from 'semver'
import {
  DESKTOP_MANAGED_UPDATE_CAPABILITY_SCHEMA_VERSION,
  DESKTOP_MANAGED_UPDATE_CHANNEL,
  DESKTOP_MANAGED_UPDATE_MANIFEST_ASSET,
  DESKTOP_MANAGED_UPDATE_MANIFEST_SCHEMA_VERSION,
  DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY,
  DESKTOP_MANAGED_UPDATE_TAG_PREFIX,
  DESKTOP_MANAGED_UPDATE_WORKFLOW,
  managedUpdateJsonSha256,
  parseDesktopManagedUpdateCapability,
  parseDesktopManagedUpdateManifest,
  type DesktopManagedUpdateCapability,
} from '../src/managed-update-protocol.ts'
import {
  DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
} from '../src/plugin-source.ts'
import {
  DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
  desktopPluginProvisioningPlanSha256,
  parseDesktopPluginProvisioningPlan,
  type DesktopPluginProvisioningPlan,
} from '../src/plugin-provisioning.ts'
import { discoverDesktopManagedSourceRelease } from '../src/managed-update-coordinator.ts'
import { resolveDesktopPackageRegistry } from './desktop-release-environment.mjs'
import { assertStandaloneDesktopHelper } from './helper-standalone.ts'
import { packagedDesktopRuntimeRoot, readPackagedDesktopRuntimeDescriptor } from './packaged-runtime.mjs'

const APP_ROOT = resolve(import.meta.dirname, '..')
const REPOSITORY_ROOT = resolve(APP_ROOT, '..', '..')
const NODE_VERSION = 'v24.13.0'
const PNPM_VERSION = '11.7.0'
const IDENTITY = {
  appId: 'io.github.cloga.deepseek-harness.desktop',
  productName: 'DeepSeek Harness (cloga)',
  packageName: 'cloga-deepseek-harness-desktop',
  executableName: 'cloga-deepseek-harness',
} as const

/** Reviewed source inputs for one immutable cloga Windows release. */
export interface DesktopForkReleasePlan {
  readonly schemaVersion: 2
  readonly channel: typeof DESKTOP_MANAGED_UPDATE_CHANNEL
  readonly version: string
  readonly sequence: number
  readonly upstreamVersion: string
  readonly identity: typeof IDENTITY
  readonly desktopProvisioning: DesktopPluginProvisioningPlan
  readonly migration: NonNullable<DesktopManagedUpdateCapability['migration']> & {
    readonly channelVersion: string
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`desktop fork release: ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) {
    throw new Error(`desktop fork release: ${label} has unsupported fields`)
  }
}

function positiveInteger(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new Error(`desktop fork release: ${label} must be a positive integer`)
  }
  return value
}

function sha256(body: Uint8Array | string): string {
  return createHash('sha256').update(body).digest('hex')
}

function sha512(path: string): string {
  return createHash('sha512').update(readFileSync(path)).digest('base64')
}

function fileSha256(path: string): string {
  return sha256(readFileSync(path))
}

function assertFileSha256(path: string, expected: string, label: string): void {
  if (fileSha256(path) !== expected) {
    throw new Error(`desktop fork release: ${label} does not match the verified bytes: ${path}`)
  }
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPOSITORY_ROOT, encoding: 'utf8' }).trim()
}

function pnpmVersion(): string {
  const entry = process.env.npm_execpath
  if (entry !== undefined && entry !== '') {
    return execFileSync(process.execPath, [entry, '--version'], { encoding: 'utf8' }).trim()
  }
  return process.platform === 'win32'
    ? execFileSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', 'pnpm --version'], { encoding: 'utf8' }).trim()
    : execFileSync('pnpm', ['--version'], { encoding: 'utf8' }).trim()
}

/** Parse and validate the reviewed cloga Windows release plan. */
export function parseDesktopForkReleasePlan(value: unknown): DesktopForkReleasePlan {
  const plan = record(value, 'plan')
  if (plan.schemaVersion === 1) {
    exactKeys(plan, ['schemaVersion', 'channel', 'version', 'sequence', 'upstreamVersion', 'identity', 'migration'], 'plan')
  } else if (plan.schemaVersion === 2) {
    exactKeys(plan, [
      'schemaVersion', 'channel', 'version', 'sequence', 'upstreamVersion', 'identity', 'desktopProvisioning', 'migration',
    ], 'plan')
  } else {
    throw new Error('desktop fork release: plan identity or version is invalid')
  }
  if (plan.channel !== DESKTOP_MANAGED_UPDATE_CHANNEL
    || typeof plan.version !== 'string' || valid(plan.version) !== plan.version
    || typeof plan.upstreamVersion !== 'string' || valid(plan.upstreamVersion) !== plan.upstreamVersion) {
    throw new Error('desktop fork release: plan identity or version is invalid')
  }
  const identity = record(plan.identity, 'plan.identity')
  exactKeys(identity, ['appId', 'productName', 'packageName', 'executableName'], 'plan.identity')
  if (JSON.stringify(identity) !== JSON.stringify(IDENTITY)) {
    throw new Error('desktop fork release: plan identity must use the cloga fork identity')
  }
  const migration = record(plan.migration, 'plan.migration')
  const desktopProvisioning = parseDesktopPluginProvisioningPlan(plan.schemaVersion === 1
    ? { schemaVersion: 1, mode: 'exact', plugins: [] }
    : plan.desktopProvisioning)
  exactKeys(migration, [
    'owner', 'manifestUrl', 'manifestSha256', 'assetSha256', 'maximumSequence', 'expectedSource', 'channelVersion',
  ], 'plan.migration')
  const sequence = positiveInteger(plan.sequence, 'plan.sequence')
  if (sequence <= 1) {
    throw new Error('desktop fork release: version and sequence must advance the upstream and migration releases')
  }
  const capability = parseDesktopManagedUpdateCapability({
    schemaVersion: DESKTOP_MANAGED_UPDATE_CAPABILITY_SCHEMA_VERSION,
    mode: 'github-release-managed',
    owner: DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY,
    tagPrefix: DESKTOP_MANAGED_UPDATE_TAG_PREFIX,
    manifestAsset: DESKTOP_MANAGED_UPDATE_MANIFEST_ASSET,
    currentSequence: sequence,
    minimumSequence: 2,
    provisioning: {
      capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
      planSha256: desktopPluginProvisioningPlanSha256(desktopProvisioning),
    },
    migration: {
      owner: migration.owner,
      manifestUrl: migration.manifestUrl,
      manifestSha256: migration.manifestSha256,
      assetSha256: migration.assetSha256,
      maximumSequence: migration.maximumSequence,
      expectedSource: migration.expectedSource,
    },
  })
  if (capability.migration === undefined || typeof migration.channelVersion !== 'string'
    || valid(migration.channelVersion) !== migration.channelVersion
    || !gt(plan.version, plan.upstreamVersion) || !gt(plan.version, migration.channelVersion)
    || sequence <= capability.migration.maximumSequence) {
    throw new Error('desktop fork release: version and sequence must advance the upstream and migration releases')
  }
  return {
    schemaVersion: 2,
    channel: DESKTOP_MANAGED_UPDATE_CHANNEL,
    version: plan.version,
    sequence,
    upstreamVersion: plan.upstreamVersion,
    identity: IDENTITY,
    desktopProvisioning,
    migration: {
      ...capability.migration,
      channelVersion: migration.channelVersion,
    },
  }
}

/** Create the build-carried source discovery and one-time migration capability. */
export function createDesktopForkReleaseCapability(
  plan: DesktopForkReleasePlan,
): DesktopManagedUpdateCapability {
  return parseDesktopManagedUpdateCapability({
    schemaVersion: DESKTOP_MANAGED_UPDATE_CAPABILITY_SCHEMA_VERSION,
    mode: 'github-release-managed',
    owner: DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY,
    tagPrefix: DESKTOP_MANAGED_UPDATE_TAG_PREFIX,
    manifestAsset: DESKTOP_MANAGED_UPDATE_MANIFEST_ASSET,
    currentSequence: plan.sequence,
    minimumSequence: 2,
    provisioning: {
      capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
      planSha256: desktopPluginProvisioningPlanSha256(plan.desktopProvisioning),
    },
    migration: {
      owner: plan.migration.owner,
      manifestUrl: plan.migration.manifestUrl,
      manifestSha256: plan.migration.manifestSha256,
      assetSha256: plan.migration.assetSha256,
      maximumSequence: plan.migration.maximumSequence,
      expectedSource: plan.migration.expectedSource,
    },
  })
}

function jsonText(value: unknown): string {
  return `${JSON.stringify(value, undefined, 2)}\n`
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, jsonText(value))
}

function assertReleaseBuildEnvironment(plan: DesktopForkReleasePlan): {
  commit: string
  tree: string
  planSha256: string
  lockfileSha256: string
} {
  const reviewedPlan = readFileSync(join(APP_ROOT, 'release', 'cloga-windows-x64.json'))
  if (managedUpdateJsonSha256(parseDesktopForkReleasePlan(JSON.parse(reviewedPlan.toString('utf8'))))
    !== managedUpdateJsonSha256(plan)) {
    throw new Error('desktop fork release: supplied plan does not match the reviewed source plan')
  }
  const rootVersion = record(readJson(join(REPOSITORY_ROOT, 'package.json')), 'root package').version
  const desktopVersion = record(readJson(join(APP_ROOT, 'package.json')), 'Desktop package').version
  if (rootVersion !== plan.upstreamVersion || desktopVersion !== plan.upstreamVersion) {
    throw new Error('desktop fork release: reviewed upstream version does not match the source manifests')
  }
  if (process.version !== NODE_VERSION || pnpmVersion() !== PNPM_VERSION) {
    throw new Error(`desktop fork release: build requires Node ${NODE_VERSION} and pnpm ${PNPM_VERSION}`)
  }
  if (git('status', '--porcelain', '--untracked-files=no') !== '') {
    throw new Error('desktop fork release: tracked source must be clean')
  }
  const commit = git('rev-parse', 'HEAD')
  const tree = git('rev-parse', 'HEAD^{tree}')
  if (!/^[a-f0-9]{40}$/u.test(commit) || !/^[a-f0-9]{40}$/u.test(tree)) {
    throw new Error('desktop fork release: Git returned an invalid source identity')
  }
  return {
    commit,
    tree,
    planSha256: sha256(reviewedPlan),
    lockfileSha256: fileSha256(join(REPOSITORY_ROOT, 'pnpm-lock.yaml')),
  }
}

function assertUnsignedInstaller(path: string): void {
  if (process.platform !== 'win32') {
    throw new Error('desktop fork release: finalization requires Windows')
  }
  const escaped = path.replaceAll("'", "''")
  const status = execFileSync(
    join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
      [
        'Import-Module (Join-Path $env:SystemRoot "System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1")',
        `(Get-AuthenticodeSignature -LiteralPath '${escaped}').Status.ToString()`,
      ].join('\n')],
    { encoding: 'utf8' },
  ).trim()
  if (status !== 'NotSigned') throw new Error(`desktop fork release: installer signature status is ${status}`)
}

/**
 * Finalize installer, receipt, manifest, and checksum assets after unsigned packaging.
 * Reject inconsistent reviewed, input, packaged, or published identities before writing checksums.
 * @param plan - Reviewed release plan.
 * @param capabilityPath - Capability file copied into the packaged application.
 * @param provisioningPath - Provisioning input matching the reviewed release inventory.
 * @param artifactsRoot - electron-builder unsigned output directory.
 * @param outputRoot - Release asset output directory.
 */
export function finalizeDesktopForkRelease(
  plan: DesktopForkReleasePlan,
  capabilityPath: string,
  provisioningPath: string,
  artifactsRoot: string,
  outputRoot: string,
): void {
  const source = assertReleaseBuildEnvironment(plan)
  const capability = createDesktopForkReleaseCapability(plan)
  const packagedCapabilityPath = join(
    artifactsRoot,
    'win-unpacked',
    'resources',
    'managed-update',
    'capability.json',
  )
  const helperPath = join(artifactsRoot, 'win-unpacked', 'resources', 'managed-update', 'helper.mjs')
  const packagedProvisioningPath = join(
    artifactsRoot,
    'win-unpacked',
    'resources',
    'desktop-provisioning',
    'plan.json',
  )
  const appUpdatePath = join(artifactsRoot, 'win-unpacked', 'resources', 'app-update.yml')
  if (!existsSync(packagedCapabilityPath) || !existsSync(packagedProvisioningPath) || !existsSync(helperPath)) {
    throw new Error('desktop fork release: packaged capability, provisioning plan, or standalone helper is missing')
  }
  if (existsSync(appUpdatePath)) {
    throw new Error('desktop fork release: native app-update.yml must not accompany managed mode')
  }
  const helperBytes = readFileSync(helperPath)
  assertStandaloneDesktopHelper(helperBytes.toString('utf8'))
  const inputCapability = parseDesktopManagedUpdateCapability(readJson(capabilityPath))
  if (JSON.stringify(inputCapability) !== JSON.stringify(capability)) {
    throw new Error('desktop fork release: input capability does not match the reviewed release plan')
  }
  const packagedCapabilityBytes = readFileSync(packagedCapabilityPath)
  if (JSON.stringify(inputCapability)
    !== JSON.stringify(parseDesktopManagedUpdateCapability(JSON.parse(packagedCapabilityBytes.toString('utf8'))))) {
    throw new Error('desktop fork release: packaged capability does not match the reviewed input')
  }
  const provisioning = parseDesktopPluginProvisioningPlan(readJson(provisioningPath))
  if (JSON.stringify(provisioning) !== JSON.stringify(plan.desktopProvisioning)) {
    throw new Error('desktop fork release: input provisioning plan does not match the reviewed release plan')
  }
  const packagedProvisioningBytes = readFileSync(packagedProvisioningPath)
  if (JSON.stringify(provisioning)
    !== JSON.stringify(parseDesktopPluginProvisioningPlan(JSON.parse(packagedProvisioningBytes.toString('utf8'))))) {
    throw new Error('desktop fork release: packaged provisioning plan does not match the reviewed input')
  }
  const provisioningSha256 = desktopPluginProvisioningPlanSha256(provisioning)
  const installerName = `cloga-deepseek-harness-${plan.version}-win-x64.exe`
  const installerPath = join(artifactsRoot, installerName)
  if (!existsSync(installerPath)) {
    const candidates = readdirSync(artifactsRoot).filter(name => name.endsWith('.exe'))
    throw new Error(`desktop fork release: expected ${installerName}; found ${candidates.join(', ')}`)
  }
  assertUnsignedInstaller(installerPath)
  const executablePath = join(artifactsRoot, 'win-unpacked', `${IDENTITY.executableName}.exe`)
  if (!existsSync(executablePath)) {
    throw new Error('desktop fork release: installed executable is missing')
  }
  const runtimeRoot = packagedDesktopRuntimeRoot(join(artifactsRoot, 'win-unpacked', 'resources'))
  const runtimeBytes = readPackagedDesktopRuntimeDescriptor(executablePath, runtimeRoot)
  const installerSha256 = fileSha256(installerPath)
  const packagedProvisioningSha256 = sha256(packagedProvisioningBytes)
  rmSync(outputRoot, { recursive: true, force: true })
  mkdirSync(outputRoot, { recursive: true })
  const publishedInstaller = join(outputRoot, installerName)
  const provisioningName = 'desktop-provisioning.json'
  const publishedProvisioning = join(outputRoot, provisioningName)
  copyFileSync(installerPath, publishedInstaller)
  copyFileSync(packagedProvisioningPath, publishedProvisioning)
  assertFileSha256(publishedInstaller, installerSha256, 'published installer')
  assertFileSha256(publishedProvisioning, packagedProvisioningSha256, 'published provisioning plan')
  const receiptPayload = {
    schemaVersion: 1,
    action: 'desktop-fork-release',
    status: 'complete',
    createdUtc: new Date().toISOString(),
    source: {
      repository: DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY,
      tag: `${DESKTOP_MANAGED_UPDATE_TAG_PREFIX}${plan.version}`,
      version: plan.version,
      commit: source.commit,
      tree: source.tree,
    },
    buildInputs: {
      workflow: DESKTOP_MANAGED_UPDATE_WORKFLOW,
      nodeVersion: process.version,
      pnpmVersion: PNPM_VERSION,
      packageRegistry: resolveDesktopPackageRegistry(process.env),
      lockfileSha256: source.lockfileSha256,
      planSha256: source.planSha256,
    },
    identity: { ...IDENTITY, upstreamVersion: plan.upstreamVersion, sequence: plan.sequence },
    artifacts: {
      installer: {
        file: installerName,
        bytes: statSync(publishedInstaller).size,
        sha256: installerSha256,
        sha512: sha512(publishedInstaller),
        signature: 'NotSigned',
      },
      executableSha256: fileSha256(executablePath),
      runtimeSha256: sha256(runtimeBytes),
      helperSha256: sha256(helperBytes),
      capabilitySha256: sha256(packagedCapabilityBytes),
      provisioning: {
        file: provisioningName,
        sha256: packagedProvisioningSha256,
        planSha256: provisioningSha256,
      },
    },
    validation: {
      helperStandalone: true,
      nativeUpdaterEnabled: false,
      appUpdateYmlPresent: false,
      managedCapabilityMatches: true,
      provisioningPlanMatches: true,
      installerStarted: false,
      installedDesktopTouched: false,
    },
    network: {
      manifestOrigin: 'https://github.com',
      apiOrigin: 'https://api.github.com',
      allowedRedirectHosts: [
        'github.com',
        'objects.githubusercontent.com',
        'release-assets.githubusercontent.com',
      ],
    },
    installation: {
      interaction: 'required',
      installerArguments: [],
      uac: 'installer-controlled',
      completion: 'post-restart-installed-evidence',
    },
    pluginCompatibility: {
      capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
      automaticProvisioning: true,
      provisioning: {
        capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
        planSha256: provisioningSha256,
      },
    },
  }
  const receipt = { ...receiptPayload, receiptSha256: managedUpdateJsonSha256(receiptPayload) }
  const receiptPath = join(outputRoot, 'build-receipt.json')
  const receiptFileSha256 = sha256(jsonText(receipt))
  writeJson(receiptPath, receipt)
  const manifestPayload = {
    schemaVersion: DESKTOP_MANAGED_UPDATE_MANIFEST_SCHEMA_VERSION,
    owner: DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY,
    mode: 'interactive-windows-installer',
    channel: DESKTOP_MANAGED_UPDATE_CHANNEL,
    version: plan.version,
    upstreamVersion: plan.upstreamVersion,
    sequence: plan.sequence,
    source: {
      repository: DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY,
      commit: source.commit,
      tree: source.tree,
      tag: `${DESKTOP_MANAGED_UPDATE_TAG_PREFIX}${plan.version}`,
    },
    build: {
      workflow: DESKTOP_MANAGED_UPDATE_WORKFLOW,
      lockfileSha256: source.lockfileSha256,
      planSha256: source.planSha256,
      nodeVersion: process.version,
      pnpmVersion: PNPM_VERSION,
      packageRegistry: resolveDesktopPackageRegistry(process.env),
    },
    identity: IDENTITY,
    installer: receipt.artifacts.installer,
    buildReceipt: {
      file: basename(receiptPath),
      sha256: receiptFileSha256,
      receiptSha256: receipt.receiptSha256,
    },
    installedEvidence: {
      executableSha256: receipt.artifacts.executableSha256,
      runtimeSha256: receipt.artifacts.runtimeSha256,
    },
    pluginCompatibility: {
      capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
      automaticProvisioning: false,
    },
    network: receipt.network,
    installation: receipt.installation,
  }
  const manifest = { ...manifestPayload, manifestSha256: managedUpdateJsonSha256(manifestPayload) }
  parseDesktopManagedUpdateManifest(manifest, capability, 0, true)
  const manifestPath = join(outputRoot, DESKTOP_MANAGED_UPDATE_MANIFEST_ASSET)
  writeJson(manifestPath, manifest)
  for (const [path, expected, label] of [
    [installerPath, installerSha256, 'packaged installer'],
    [publishedInstaller, installerSha256, 'published installer'],
    [packagedProvisioningPath, packagedProvisioningSha256, 'packaged provisioning plan'],
    [publishedProvisioning, packagedProvisioningSha256, 'published provisioning plan'],
    [packagedCapabilityPath, receipt.artifacts.capabilitySha256, 'packaged capability'],
    [helperPath, receipt.artifacts.helperSha256, 'packaged helper'],
    [executablePath, receipt.artifacts.executableSha256, 'packaged executable'],
    [receiptPath, receiptFileSha256, 'build receipt'],
    [manifestPath, sha256(jsonText(manifest)), 'published manifest'],
  ] as const) {
    assertFileSha256(path, expected, label)
  }
  if (sha256(readPackagedDesktopRuntimeDescriptor(executablePath, runtimeRoot)) !== receipt.artifacts.runtimeSha256) {
    throw new Error('desktop fork release: packaged runtime descriptor does not match the recorded SHA-256')
  }
  const files = [installerName, provisioningName, basename(receiptPath), basename(manifestPath)]
  writeFileSync(join(outputRoot, 'SHA256SUMS'), `${files.map(name => `${fileSha256(join(outputRoot, name))}  ${name}`).join('\n')}\n`)
  writeFileSync(join(outputRoot, 'SHA512SUMS'), `${files.map(name => `${sha512(join(outputRoot, name))}  ${name}`).join('\n')}\n`)
}

function requiredOption(value: string | undefined, name: string): string {
  if (value === undefined || value === '') throw new Error(`desktop fork release: --${name} is required`)
  return resolve(value)
}

async function main(): Promise<void> {
  const command = process.argv[2]
  const { values } = parseArgs({
    args: process.argv.slice(3),
    options: {
      plan: { type: 'string' },
      out: { type: 'string' },
      capability: { type: 'string' },
      provisioning: { type: 'string' },
      artifacts: { type: 'string' },
      remote: { type: 'boolean', default: false },
    },
  })
  const planPath = requiredOption(values.plan, 'plan')
  const plan = parseDesktopForkReleasePlan(readJson(planPath))
  const capability = createDesktopForkReleaseCapability(plan)
  if (command === 'prepare') {
    assertReleaseBuildEnvironment(plan)
    if (values.remote) {
      const latest = await discoverDesktopManagedSourceRelease(capability, 0)
      if (latest !== undefined && latest.manifest.sequence >= plan.sequence) {
        throw new Error('desktop fork release: reviewed sequence does not advance the published channel')
      }
    }
    const output = requiredOption(values.out, 'out')
    mkdirSync(resolve(output, '..'), { recursive: true })
    writeJson(output, capability)
    writeJson(requiredOption(values.provisioning, 'provisioning'), plan.desktopProvisioning)
    return
  }
  if (command === 'finalize') {
    finalizeDesktopForkRelease(
      plan,
      requiredOption(values.capability, 'capability'),
      requiredOption(values.provisioning, 'provisioning'),
      requiredOption(values.artifacts, 'artifacts'),
      requiredOption(values.out, 'out'),
    )
    return
  }
  if (command === 'verify-remote') {
    const source = assertReleaseBuildEnvironment(plan)
    const selected = await discoverDesktopManagedSourceRelease(capability, 0)
    if (selected === undefined || selected.kind !== 'source'
      || selected.manifest.owner !== DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY
      || selected.manifest.version !== plan.version
      || selected.manifest.sequence !== plan.sequence
      || selected.manifest.source.commit !== source.commit
      || selected.manifest.source.tree !== source.tree) {
      throw new Error('desktop fork release: remote Check did not select the reviewed release')
    }
    process.stdout.write(`${JSON.stringify({
      version: selected.manifest.version,
      sequence: selected.manifest.sequence,
      manifestUrl: selected.manifestUrl,
      manifestSha256: selected.manifestSha256,
      assetSha256: selected.assetSha256,
    })}\n`)
    return
  }
  throw new Error('desktop fork release: expected prepare, finalize, or verify-remote')
}

if (process.argv[1] !== undefined && import.meta.filename === resolve(process.argv[1])) await main()
