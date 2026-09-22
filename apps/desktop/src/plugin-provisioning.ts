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

/** Native exact-state provisioning capability consumed by release automation. */
export const DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY = {
  id: 'desktopNativePluginProvisioning',
  schemaVersion: 1,
  planSchemaVersion: 1,
  stateSchemaVersion: 1,
  pluginCapability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
} as const

/** One required or optional plugin in the release-owned exact inventory. */
export interface DesktopPluginProvisioningEntry {
  readonly required: boolean
  readonly source: DesktopGithubReleasePluginSource & {
    readonly checksumManifest: NonNullable<DesktopGithubReleasePluginSource['checksumManifest']>
  }
}

/** Release-owned desired state for externally provisioned Desktop plugins. */
export interface DesktopPluginProvisioningPlan {
  readonly schemaVersion: 1
  readonly mode: 'exact'
  readonly plugins: readonly DesktopPluginProvisioningEntry[]
}

/** One plugin's committed result in the active reserved profile. */
export interface DesktopPluginProvisioningResult {
  readonly name: string
  readonly version: string
  readonly required: boolean
  readonly status: 'active' | 'optional-failed'
  readonly source: DesktopPluginProvisioningEntry['source']
  readonly receipt?: DesktopPluginProvisionReceipt
  readonly message?: string
  readonly phase?: 'download' | 'validation' | 'install' | 'graph' | 'health'
}

/** Durable evidence for the active release-owned plugin inventory. */
export interface DesktopPluginProvisioningState {
  readonly schemaVersion: 1
  readonly capability: typeof DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY
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

/** Parse one packaged exact-state provisioning plan. */
export function parseDesktopPluginProvisioningPlan(value: unknown): DesktopPluginProvisioningPlan {
  if (!record(value) || Object.keys(value).sort().join(',') !== 'mode,plugins,schemaVersion'
    || value.schemaVersion !== 1 || value.mode !== 'exact' || !Array.isArray(value.plugins)) {
    throw new Error('desktop plugin provisioning: invalid plan')
  }
  const names = new Set<string>()
  let dependencyRegistry: string | undefined
  const plugins = value.plugins.map((entry: unknown): DesktopPluginProvisioningEntry => {
    if (!record(entry) || Object.keys(entry).sort().join(',') !== 'required,source'
      || typeof entry.required !== 'boolean') {
      throw new Error('desktop plugin provisioning: invalid plugin entry')
    }
    const source = parseDesktopPluginSource(entry.source)
    if (source.type !== 'githubRelease' || source.checksumManifest === undefined) {
      throw new Error('desktop plugin provisioning: plugins require a checksum-attested GitHub Release source')
    }
    if (names.has(source.packageName)) throw new Error('desktop plugin provisioning: duplicate package')
    names.add(source.packageName)
    const registry = source.dependencyRegistry ?? 'https://registry.npmjs.org/'
    dependencyRegistry ??= registry
    if (dependencyRegistry !== registry) {
      throw new Error('desktop plugin provisioning: every plugin must use the same dependency registry')
    }
    return { required: entry.required, source: source as DesktopPluginProvisioningEntry['source'] }
  })
  return { schemaVersion: 1, mode: 'exact', plugins }
}

/** Parse durable active-profile provisioning evidence. */
export function parseDesktopPluginProvisioningState(value: unknown): DesktopPluginProvisioningState {
  if (!record(value) || value.schemaVersion !== 1
    || JSON.stringify(value.capability) !== JSON.stringify(DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY)
    || typeof value.planSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.planSha256)
    || value.composition !== 'active' || !Array.isArray(value.plugins) || !Array.isArray(value.removed)
    || value.rolledBack !== false || value.verified !== true) {
    throw new Error('desktop plugin provisioning: invalid state')
  }
  const plugins = value.plugins.map((item: unknown): DesktopPluginProvisioningResult => {
    if (!record(item)
      || !['name', 'version', 'required', 'status', 'source'].every(key => key in item)
      || Object.keys(item).some(key => !['name', 'version', 'required', 'status', 'source', 'receipt', 'message', 'phase'].includes(key))
      || typeof item.name !== 'string' || typeof item.version !== 'string'
      || typeof item.required !== 'boolean' || (item.status !== 'active' && item.status !== 'optional-failed')
      || (item.message !== undefined && typeof item.message !== 'string')) {
      throw new Error('desktop plugin provisioning: invalid state plugin')
    }
    const source = parseDesktopPluginSource(item.source)
    if (source.type !== 'githubRelease' || source.checksumManifest === undefined
      || source.packageName !== item.name || source.version !== item.version) {
      throw new Error('desktop plugin provisioning: invalid state source')
    }
    const receipt = item.receipt === undefined ? undefined : parseDesktopPluginProvisionReceipt(item.receipt)
    const phase = item.phase
    if (phase !== undefined && phase !== 'download' && phase !== 'validation'
      && phase !== 'install' && phase !== 'graph' && phase !== 'health') {
      throw new Error('desktop plugin provisioning: invalid failure phase')
    }
    if ((receipt !== undefined && JSON.stringify(receipt.source) !== JSON.stringify(source))
      || (item.status === 'active' && (receipt === undefined || item.message !== undefined || phase !== undefined))
      || (item.status === 'optional-failed' && (item.required || receipt !== undefined
        || item.message === undefined || item.message === '' || phase === undefined))) {
      throw new Error('desktop plugin provisioning: invalid state result')
    }
    return {
      name: item.name,
      version: item.version,
      required: item.required,
      status: item.status,
      source: source as DesktopPluginProvisioningEntry['source'],
      ...(receipt === undefined ? {} : { receipt }),
      ...(item.message === undefined ? {} : { message: item.message }),
      ...(phase === undefined ? {} : { phase }),
    }
  })
  const removed = value.removed
  if (new Set(plugins.map(plugin => plugin.name)).size !== plugins.length
    || removed.some(item => typeof item !== 'string' || !/^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u.test(item))
    || new Set(removed).size !== removed.length) {
    throw new Error('desktop plugin provisioning: invalid removed package')
  }
  return {
    schemaVersion: 1,
    capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
    planSha256: value.planSha256,
    composition: 'active',
    plugins,
    removed: removed as string[],
    rolledBack: false,
    verified: true,
  }
}

/**
 * Build existing-schema evidence for the required singleton baseline after actual Host health verification.
 * This pure builder neither verifies runtime health nor changes receipt ownership or files.
 * @param inputPlan - The fixed packaged plan, not a caller-selected ownership policy.
 * @param inputReceipt - Already verified active receipt; user ownership may remain unchanged in its separate store.
 * @returns Canonical schema-1 baseline state for exactly the matching required package.
 */
export function buildDesktopProvisioningState(
  inputPlan: DesktopPluginProvisioningPlan,
  inputReceipt: DesktopPluginProvisionReceipt,
): DesktopPluginProvisioningState {
  const plan = parseDesktopPluginProvisioningPlan(inputPlan)
  const receipt = parseDesktopPluginProvisionReceipt(inputReceipt)
  const entry = plan.plugins[0]
  if (plan.plugins.length !== 1 || entry === undefined || !entry.required
    || receipt.packageName !== entry.source.packageName || receipt.version !== entry.source.version
    || receipt.artifactSha256 !== entry.source.sha256 || JSON.stringify(receipt.source) !== JSON.stringify(entry.source)) {
    throw new Error('desktop plugin provisioning: qualified singleton receipt does not match the packaged plan')
  }
  return parseDesktopPluginProvisioningState({
    schemaVersion: 1, capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
    planSha256: desktopPluginProvisioningPlanSha256(plan), composition: 'active',
    plugins: [{ name: receipt.packageName, version: receipt.version, required: true, status: 'active', source: entry.source, receipt }],
    removed: [], rolledBack: false, verified: true,
  })
}

/** Read and validate a packaged provisioning plan. */
export function readDesktopPluginProvisioningPlan(path: string): DesktopPluginProvisioningPlan {
  return parseDesktopPluginProvisioningPlan(JSON.parse(readFileSync(path, 'utf8')) as unknown)
}

/** Compute the canonical identity used by release manifests and active profile evidence. */
export function desktopPluginProvisioningPlanSha256(plan: DesktopPluginProvisioningPlan): string {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex')
}
