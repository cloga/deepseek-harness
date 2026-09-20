/** Independent immutable release evidence for explicit recovery after an out-of-band installation. */

import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { setTimeout } from 'node:timers/promises'
import { discoverDesktopManagedInstalledRelease, type ManagedUpdateOperations } from './managed-update-coordinator.ts'
import { readManagedUpdateMetadata, withManagedUpdateResponse } from './managed-update-network.ts'
import {
  managedUpdateAssetUrl,
  managedUpdateJsonSha256,
  parseDesktopManagedUpdateCapability,
  type DesktopManagedUpdateCapability,
  type DesktopManagedUpdateManifest,
} from './managed-update-protocol.ts'

/** Explicit recovery inputs from the running packaged application, not retained helper handoffs. */
export interface DesktopManualInstallRecovery {
  readonly version: string
  readonly capabilityPath: string
  readonly operations?: ManagedUpdateOperations
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`desktop managed update: published ${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * Bind the current capability and plan bytes to a manifest-authenticated build receipt.
 * Does not install, change history, or attest Host readiness; completion still verifies installed hashes and inventory.
 * @param capability - Parsed policy of the running application.
 * @param provisioningPlan - Packaged plugin plan path.
 * @param recovery - Explicit current-version recovery request.
 * @returns Independent release candidate or a rejected promise; offline recovery never guesses.
 */
export async function verifyDesktopManualInstallEvidence(
  capability: DesktopManagedUpdateCapability,
  provisioningPlan: string,
  recovery: DesktopManualInstallRecovery,
): Promise<DesktopManagedUpdateManifest> {
  const operations = recovery.operations ?? { fetch: globalThis.fetch }
  const selected = await discoverDesktopManagedInstalledRelease(capability, recovery.version, operations)
  const manifest = selected.manifest
  if (manifest.owner !== 'cloga/deepseek-harness') {
    throw new Error('desktop managed update: manual recovery requires a source-owned release')
  }
  const body = await withManagedUpdateResponse(
    managedUpdateAssetUrl(selected.manifestUrl, manifest.buildReceipt.file),
    'metadata',
    { fetch: (url, init) => operations.fetch(url, init), sleep: async (milliseconds) => { await setTimeout(milliseconds) } },
    async (response, transfer) => readManagedUpdateMetadata(response, 1024 * 1024, transfer),
  )
  if (sha256(body) !== manifest.buildReceipt.sha256) {
    throw new Error('desktop managed update: published build receipt hash does not match the manifest')
  }
  const receipt = record(JSON.parse(body.toString('utf8')), 'build receipt')
  const { receiptSha256, ...payload } = receipt
  if (receipt.schemaVersion !== 1 || receipt.action !== 'desktop-fork-release' || receipt.status !== 'complete'
    || receiptSha256 !== manifest.buildReceipt.receiptSha256 || managedUpdateJsonSha256(payload) !== receiptSha256) {
    throw new Error('desktop managed update: published build receipt identity is invalid')
  }
  const source = record(receipt.source, 'build receipt source')
  const identity = record(receipt.identity, 'build receipt identity')
  if (source.repository !== manifest.source.repository || source.tag !== manifest.source.tag
    || source.version !== manifest.version || source.commit !== manifest.source.commit || source.tree !== manifest.source.tree
    || identity.sequence !== manifest.sequence) {
    throw new Error('desktop managed update: published build receipt source does not match the installed release')
  }
  const artifacts = record(receipt.artifacts, 'build receipt artifacts')
  const provisioning = record(artifacts.provisioning, 'build receipt provisioning')
  const [capabilityBytes, planBytes] = await Promise.all([
    readFile(recovery.capabilityPath), readFile(provisioningPlan),
  ])
  const installedCapability = parseDesktopManagedUpdateCapability(JSON.parse(capabilityBytes.toString('utf8')))
  if (managedUpdateJsonSha256(installedCapability) !== managedUpdateJsonSha256(capability)
    || artifacts.capabilitySha256 !== sha256(capabilityBytes)
    || artifacts.executableSha256 !== manifest.installedEvidence.executableSha256
    || artifacts.runtimeSha256 !== manifest.installedEvidence.runtimeSha256
    || provisioning.sha256 !== sha256(planBytes) || provisioning.planSha256 !== capability.provisioning.planSha256) {
    throw new Error('desktop managed update: installed capability or provisioning plan does not match the published build receipt')
  }
  return manifest
}
