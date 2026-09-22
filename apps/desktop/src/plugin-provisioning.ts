/** Exact external plugin inventory carried by a Desktop release. */

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
  parseDesktopPluginProvisionReceipt,
  parseDesktopPluginSource,
  type DesktopGithubReleasePluginSource,
  type DesktopPluginProvisionReceipt,
} from './plugin-source.ts'

/** Packaged plan filename under the Desktop provisioning resource directory. */
export const DESKTOP_PLUGIN_PROVISIONING_PLAN_FILE = 'plan.json'
/** Durable reconciliation state written inside the reserved Desktop profile. */
export const DESKTOP_PLUGIN_PROVISIONING_STATE_FILE = 'desktop-plugin-provisioning-state.json'

/** Historical provisioning capability accepted only when reading schema-1 retained evidence. */
export const LEGACY_DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY = {
  id: 'desktopNativePluginProvisioning', schemaVersion: 1, planSchemaVersion: 1, stateSchemaVersion: 1,
  pluginCapability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
} as const

/** Native exact-state provisioning capability consumed by release automation. */
export const DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY = {
  id: 'desktopNativePluginProvisioning', schemaVersion: 2, planSchemaVersion: 2, stateSchemaVersion: 2,
  pluginCapability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
} as const

/** A release entry either pins its source or permits a separately verified user source. */
export type DesktopPluginSourcePolicy = 'strict-pin' | 'compatible-user-override'
export type DesktopAttestedPluginSource = DesktopGithubReleasePluginSource & {
  readonly checksumManifest: NonNullable<DesktopGithubReleasePluginSource['checksumManifest']>
}

/** One schema-1 plugin whose source is always a strict pin. */
export interface DesktopPluginProvisioningEntryV1 {
  readonly required: boolean
  readonly source: DesktopAttestedPluginSource
}

/** One schema-2 plugin with an explicit source policy. */
export interface DesktopPluginProvisioningEntryV2 extends DesktopPluginProvisioningEntryV1 {
  readonly sourcePolicy: DesktopPluginSourcePolicy
}

/** One plugin entry from either readable plan schema. */
export type DesktopPluginProvisioningEntry = DesktopPluginProvisioningEntryV1 | DesktopPluginProvisioningEntryV2

/** Release-owned desired state for externally provisioned Desktop plugins. */
export type DesktopPluginProvisioningPlan = {
  readonly schemaVersion: 1
  readonly mode: 'exact'
  readonly plugins: readonly DesktopPluginProvisioningEntryV1[]
} | {
  readonly schemaVersion: 2
  readonly mode: 'exact'
  readonly plugins: readonly DesktopPluginProvisioningEntryV2[]
}

/** One plugin's committed result in the active reserved profile. */
export type DesktopPluginProvisioningResult = {
  readonly name: string
  readonly required: boolean
  readonly status: 'active'
  readonly requestedSource: DesktopAttestedPluginSource
  readonly sourcePolicy: DesktopPluginSourcePolicy
  readonly effective: 'plan' | 'user-override'
  readonly effectiveSource: DesktopAttestedPluginSource
  readonly receipt: DesktopPluginProvisionReceipt
} | {
  readonly name: string
  readonly required: false
  readonly status: 'optional-failed'
  readonly requestedSource: DesktopAttestedPluginSource
  readonly sourcePolicy: DesktopPluginSourcePolicy
  readonly message: string
  readonly phase: 'download' | 'validation' | 'install' | 'graph' | 'health'
}

/** Durable evidence for the active release-owned plugin inventory, normalized across readable versions. */
export interface DesktopPluginProvisioningState {
  readonly schemaVersion: 1 | 2
  readonly capability: typeof DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY | typeof LEGACY_DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY
  readonly planSchemaVersion: 1 | 2
  readonly planSha256: string
  readonly composition: 'active'
  readonly plugins: readonly DesktopPluginProvisioningResult[]
  readonly removed: readonly string[]
  readonly rolledBack: false
  readonly verified: true
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Narrow a verified GitHub source to the checksum-attested source required by provisioning state.
 * @param source - Parsed immutable GitHub release source.
 * @returns Whether the source carries a parsed checksum manifest.
 */
export function isDesktopAttestedPluginSource(
  source: DesktopGithubReleasePluginSource,
): source is DesktopAttestedPluginSource {
  return source.checksumManifest !== undefined
}

/**
 * Match immutable releases from one reviewed repository and dependency registry without comparing versions.
 * @param requested - Source selected by the packaged plan.
 * @param effective - Verified user source proposed for the same planned name.
 * @returns Whether both sources belong to the same allowed family.
 */
export function sameDesktopPluginSourceFamily(
  requested: DesktopGithubReleasePluginSource,
  effective: DesktopGithubReleasePluginSource,
): boolean {
  return requested.owner === effective.owner && requested.repo === effective.repo
    && requested.packageName === effective.packageName
    && (requested.dependencyRegistry ?? 'https://registry.npmjs.org/')
      === (effective.dependencyRegistry ?? 'https://registry.npmjs.org/')
    && requested.checksumManifest?.format === 'sha256sums'
    && effective.checksumManifest?.format === 'sha256sums'
}

function attestedSource(value: unknown, message: string): DesktopAttestedPluginSource {
  const source = parseDesktopPluginSource(value)
  if (source.type !== 'githubRelease' || !isDesktopAttestedPluginSource(source)) throw new Error(message)
  return source
}

/** Parse one packaged exact-state provisioning plan and normalize schema-1 entries to strict pins. */
export function parseDesktopPluginProvisioningPlan(value: unknown): DesktopPluginProvisioningPlan {
  if (!record(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || value.mode !== 'exact' || !Array.isArray(value.plugins)
    || Object.keys(value).sort().join(',') !== 'mode,plugins,schemaVersion') throw new Error('desktop plugin provisioning: invalid plan')
  const schemaVersion = value.schemaVersion
  const names = new Set<string>()
  let dependencyRegistry: string | undefined
  const plugins = value.plugins.map((entry: unknown): DesktopPluginProvisioningEntry => {
    const keys = schemaVersion === 1 ? 'required,source' : 'required,source,sourcePolicy'
    if (!record(entry) || Object.keys(entry).sort().join(',') !== keys || typeof entry.required !== 'boolean'
      || schemaVersion === 2 && entry.sourcePolicy !== 'strict-pin' && entry.sourcePolicy !== 'compatible-user-override') {
      throw new Error('desktop plugin provisioning: invalid plugin entry')
    }
    const source = attestedSource(entry.source, 'desktop plugin provisioning: plugins require a checksum-attested GitHub Release source')
    if (names.has(source.packageName)) throw new Error('desktop plugin provisioning: duplicate package')
    names.add(source.packageName)
    const registry = source.dependencyRegistry ?? 'https://registry.npmjs.org/'
    dependencyRegistry ??= registry
    if (dependencyRegistry !== registry) throw new Error('desktop plugin provisioning: every plugin must use the same dependency registry')
    return schemaVersion === 2
      ? { required: entry.required, source, sourcePolicy: entry.sourcePolicy as DesktopPluginSourcePolicy }
      : { required: entry.required, source }
  })
  return schemaVersion === 1
    ? { schemaVersion: 1, mode: 'exact', plugins }
    : { schemaVersion: 2, mode: 'exact', plugins }
}

function failurePhase(value: unknown): Extract<DesktopPluginProvisioningResult, { status: 'optional-failed' }>['phase'] {
  if (value !== 'download' && value !== 'validation' && value !== 'install' && value !== 'graph' && value !== 'health') {
    throw new Error('desktop plugin provisioning: invalid failure phase')
  }
  return value
}

function legacyResult(item: Record<string, unknown>): DesktopPluginProvisioningResult {
  if (!['name', 'version', 'required', 'status', 'source'].every(key => key in item)
    || Object.keys(item).some(key => !['name', 'version', 'required', 'status', 'source', 'receipt', 'message', 'phase'].includes(key))
    || typeof item.name !== 'string' || typeof item.version !== 'string' || typeof item.required !== 'boolean'
    || (item.status !== 'active' && item.status !== 'optional-failed')) throw new Error('desktop plugin provisioning: invalid state plugin')
  const requestedSource = attestedSource(item.source, 'desktop plugin provisioning: invalid state source')
  if (requestedSource.packageName !== item.name || requestedSource.version !== item.version) throw new Error('desktop plugin provisioning: invalid state source')
  if (item.status === 'optional-failed') {
    if (item.required || typeof item.message !== 'string' || item.message === '' || item.receipt !== undefined) throw new Error('desktop plugin provisioning: invalid state result')
    return { name: item.name, required: false, status: 'optional-failed', requestedSource, sourcePolicy: 'strict-pin', message: item.message, phase: failurePhase(item.phase) }
  }
  const receipt = parseDesktopPluginProvisionReceipt(item.receipt)
  if (JSON.stringify(receipt.source) !== JSON.stringify(requestedSource) || item.message !== undefined || item.phase !== undefined) throw new Error('desktop plugin provisioning: invalid state result')
  return { name: item.name, required: item.required, status: 'active', requestedSource, sourcePolicy: 'strict-pin', effective: 'plan', effectiveSource: requestedSource, receipt }
}

function currentResult(item: Record<string, unknown>, planSchemaVersion: 1 | 2): DesktopPluginProvisioningResult {
  if (typeof item.name !== 'string' || typeof item.required !== 'boolean'
    || (item.sourcePolicy !== 'strict-pin' && item.sourcePolicy !== 'compatible-user-override')
    || (item.status !== 'active' && item.status !== 'optional-failed')) throw new Error('desktop plugin provisioning: invalid state plugin')
  const requestedSource = attestedSource(item.requestedSource, 'desktop plugin provisioning: invalid requested state source')
  if (requestedSource.packageName !== item.name) throw new Error('desktop plugin provisioning: invalid requested state source')
  if (planSchemaVersion === 1 && item.sourcePolicy !== 'strict-pin') throw new Error('desktop plugin provisioning: invalid state policy')
  if (item.status === 'optional-failed') {
    if (item.required || typeof item.message !== 'string' || item.message === ''
      || Object.keys(item).sort().join(',') !== 'message,name,phase,requestedSource,required,sourcePolicy,status') throw new Error('desktop plugin provisioning: invalid state result')
    return { name: item.name, required: false, status: 'optional-failed', requestedSource, sourcePolicy: item.sourcePolicy, message: item.message, phase: failurePhase(item.phase) }
  }
  if ((item.effective !== 'plan' && item.effective !== 'user-override')
    || Object.keys(item).sort().join(',') !== 'effective,effectiveSource,name,receipt,requestedSource,required,sourcePolicy,status') throw new Error('desktop plugin provisioning: invalid state result')
  const effectiveSource = attestedSource(item.effectiveSource, 'desktop plugin provisioning: invalid effective state source')
  const receipt = parseDesktopPluginProvisionReceipt(item.receipt)
  if (effectiveSource.packageName !== item.name || JSON.stringify(receipt.source) !== JSON.stringify(effectiveSource)
    || (item.effective === 'plan') !== (JSON.stringify(requestedSource) === JSON.stringify(effectiveSource))
    || planSchemaVersion === 1 && (item.sourcePolicy !== 'strict-pin' || item.effective !== 'plan')
    || item.effective === 'user-override' && (item.sourcePolicy !== 'compatible-user-override'
      || !sameDesktopPluginSourceFamily(requestedSource, effectiveSource))) throw new Error('desktop plugin provisioning: invalid state result')
  return { name: item.name, required: item.required, status: 'active', requestedSource, sourcePolicy: item.sourcePolicy, effective: item.effective, effectiveSource, receipt }
}

/** Parse durable active-profile provisioning evidence and normalize schema-1 rows without rewriting them. */
export function parseDesktopPluginProvisioningState(value: unknown): DesktopPluginProvisioningState {
  if (!record(value) || (value.schemaVersion !== 1 && value.schemaVersion !== 2)
    || value.schemaVersion === 2 && Object.keys(value).sort().join(',') !== 'capability,composition,planSchemaVersion,planSha256,plugins,removed,rolledBack,schemaVersion,verified'
    || typeof value.planSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.planSha256)
    || value.composition !== 'active' || !Array.isArray(value.plugins) || !Array.isArray(value.removed)
    || value.rolledBack !== false || value.verified !== true) throw new Error('desktop plugin provisioning: invalid state')
  const capability = value.schemaVersion === 1
    ? LEGACY_DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY
    : DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY
  const planSchemaVersion = value.schemaVersion === 1 ? 1 : value.planSchemaVersion
  if (JSON.stringify(value.capability) !== JSON.stringify(capability)
    || (planSchemaVersion !== 1 && planSchemaVersion !== 2)) throw new Error('desktop plugin provisioning: invalid state')
  const plugins = value.plugins.map((item: unknown) => {
    if (!record(item)) throw new Error('desktop plugin provisioning: invalid state plugin')
    return value.schemaVersion === 1 ? legacyResult(item) : currentResult(item, planSchemaVersion)
  })
  const removed = value.removed
  if (new Set(plugins.map(plugin => plugin.name)).size !== plugins.length
    || removed.some(item => typeof item !== 'string' || !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(item))
    || new Set(removed).size !== removed.length) throw new Error('desktop plugin provisioning: invalid removed package')
  return { schemaVersion: value.schemaVersion, capability, planSchemaVersion, planSha256: value.planSha256, composition: 'active', plugins, removed: removed as string[], rolledBack: false, verified: true }
}

/** Read and validate a packaged provisioning plan. */
export function readDesktopPluginProvisioningPlan(path: string): DesktopPluginProvisioningPlan {
  return parseDesktopPluginProvisioningPlan(JSON.parse(readFileSync(path, 'utf8')) as unknown)
}

/**
 * Compute the canonical on-disk plan identity after exact schema validation.
 * @param input - Untrusted or already parsed durable plan value.
 * @returns SHA-256 of the canonical schema-specific JSON.
 */
export function desktopPluginProvisioningPlanSha256(input: unknown): string {
  const plan = parseDesktopPluginProvisioningPlan(input)
  const value = plan.schemaVersion === 1
    ? { schemaVersion: 1, mode: 'exact', plugins: plan.plugins.map(({ required, source }) => ({ required, source })) }
    : plan
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
