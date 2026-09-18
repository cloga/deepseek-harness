/** Read-only verified-plugin receipt ownership and installed provisioning acceptance. */
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { parseDesktopPluginProvisionReceipt, type DesktopPluginProvisionReceipt } from './plugin-source.ts'
import {
  DESKTOP_PLUGIN_PROVISIONING_STATE_FILE, desktopPluginProvisioningPlanSha256,
  parseDesktopPluginProvisioningState, type DesktopPluginProvisioningPlan, type DesktopPluginProvisioningState,
} from './plugin-provisioning.ts'

export const DESKTOP_PLUGIN_RECEIPTS_FILE = 'desktop-plugin-receipts.json'

/** Owners are separate from verified source identity; unknown legacy records remain user-owned. */
export interface DesktopPluginReceiptStore {
  readonly schemaVersion: 1
  readonly receipts: Record<string, DesktopPluginProvisionReceipt>
  readonly owners: Record<string, 'user' | 'release'>
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readJson(path: string): unknown {
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 8 * 1024 * 1024) throw new Error('desktop plugin receipts: unsafe metadata file')
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

/** @param profile - Active or private candidate profile. @returns Validated receipts and conservative ownership. */
export function readDesktopPluginReceipts(profile: string): DesktopPluginReceiptStore {
  const path = join(profile, DESKTOP_PLUGIN_RECEIPTS_FILE)
  const receipts: Record<string, DesktopPluginProvisionReceipt> = Object.create(null)
  const owners: Record<string, 'user' | 'release'> = Object.create(null)
  if (!existsSync(path)) return { schemaVersion: 1, receipts, owners }
  const input = readJson(path)
  if (!record(input) || input.schemaVersion !== 1 || !record(input.receipts)
    || Object.keys(input).some(key => !['schemaVersion', 'receipts', 'owners'].includes(key))) throw new Error('desktop plugin receipts: invalid store')
  for (const [name, value] of Object.entries(input.receipts)) {
    const receipt = parseDesktopPluginProvisionReceipt(value)
    if (receipt.packageName !== name) throw new Error('desktop plugin receipts: package identity mismatch')
    receipts[name] = receipt
    owners[name] = 'user'
  }
  if (input.owners !== undefined) {
    if (!record(input.owners) || Object.keys(input.owners).length !== Object.keys(receipts).length) throw new Error('desktop plugin receipts: invalid owners')
    for (const [name, value] of Object.entries(input.owners)) {
      if (!Object.hasOwn(receipts, name) || (value !== 'user' && value !== 'release')) throw new Error('desktop plugin receipts: invalid owner')
      owners[name] = value
    }
  } else if (existsSync(join(profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE))) {
    const prior = parseDesktopPluginProvisioningState(readJson(join(profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE)))
    const plan: DesktopPluginProvisioningPlan = {
      schemaVersion: 1, mode: 'exact', plugins: prior.plugins.map(entry => ({ required: entry.required, source: entry.source })),
    }
    const manifest = readJson(join(profile, 'package.json'))
    if (!record(manifest) || !record(manifest.dependencies)) throw new Error('desktop plugin receipts: invalid profile manifest')
    if (desktopPluginProvisioningPlanSha256(plan) === prior.planSha256) {
      for (const entry of prior.plugins) {
        const receipt = receipts[entry.name]
        if (entry.status === 'active' && receipt !== undefined && JSON.stringify(receipt) === JSON.stringify(entry.receipt)
          && manifest.dependencies[entry.name] === `file:.desktop-plugin-artifacts/${receipt.artifactSha256}.tgz`) owners[entry.name] = 'release'
      }
    }
  }
  return { schemaVersion: 1, receipts, owners }
}

/**
 * Verify the actual installed plan only after the owning shell observes final-location Host readiness.
 * @param profile - Active profile whose Host reached readiness; this function never starts it.
 * @param plan - Packaged exact plugin plan.
 * @returns Matching active provisioning evidence, preserving unrelated user-owned packages.
 */
export function assertDesktopProvisioningInventory(profile: string, plan: DesktopPluginProvisioningPlan): DesktopPluginProvisioningState {
  const state = parseDesktopPluginProvisioningState(readJson(join(profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE)))
  const manifest = readJson(join(profile, 'package.json'))
  const { receipts, owners } = readDesktopPluginReceipts(profile)
  const desired = new Map(plan.plugins.map(entry => [entry.source.packageName, entry]))
  const dsh = record(manifest) && record(manifest.dsh) ? manifest.dsh : undefined
  const selection = record(dsh?.profile) ? dsh.profile.bundles : undefined
  if (!record(manifest) || !record(manifest.dependencies) || !Array.isArray(selection)
    || state.planSha256 !== desktopPluginProvisioningPlanSha256(plan) || state.plugins.length !== plan.plugins.length
    || Object.keys(receipts).some(name => owners[name] === 'release' && !desired.has(name))) {
    throw new Error('desktop plugin provisioning: active inventory does not match the release plan')
  }
  for (const result of state.plugins) {
    const entry = desired.get(result.name)
    if (entry === undefined || entry.required !== result.required || JSON.stringify(entry.source) !== JSON.stringify(result.source)) {
      throw new Error('desktop plugin provisioning: active inventory does not match the release plan')
    }
    if (result.status === 'optional-failed') {
      if (entry.required || receipts[result.name] !== undefined || Object.hasOwn(manifest.dependencies, result.name) || selection.includes(result.name)) {
        throw new Error('desktop plugin provisioning: optional failure has active evidence')
      }
      continue
    }
    const receipt = receipts[result.name]
    const plugin = readJson(join(profile, 'node_modules', result.name, 'package.json'))
    const pluginDsh = record(plugin) && record(plugin.dsh) ? plugin.dsh : undefined
    const bundle = record(pluginDsh?.bundle) ? pluginDsh.bundle : undefined
    if (typeof bundle?.patch !== 'string' || bundle.patch === '') throw new Error('desktop plugin provisioning: installed bundle declaration is invalid')
    const packageDir = resolve(profile, 'node_modules', result.name)
    const patch = resolve(packageDir, bundle.patch)
    const rel = relative(packageDir, patch)
    if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`) || !lstatSync(patch).isFile()) {
      throw new Error('desktop plugin provisioning: installed bundle patch is invalid')
    }
    const artifact = join(profile, '.desktop-plugin-artifacts', `${entry.source.sha256}.tgz`)
    const stat = lstatSync(artifact)
    if (receipt === undefined || JSON.stringify(receipt) !== JSON.stringify(result.receipt)
      || receipt.artifactSha256 !== entry.source.sha256 || !record(plugin) || plugin.name !== result.name || plugin.version !== entry.source.version
      || manifest.dependencies[result.name] !== `file:.desktop-plugin-artifacts/${entry.source.sha256}.tgz` || !selection.includes(result.name)
      || !stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.source.size
      || createHash('sha256').update(readFileSync(artifact)).digest('hex') !== entry.source.sha256) {
      throw new Error('desktop plugin provisioning: active inventory does not match the release plan')
    }
  }
  return state
}
