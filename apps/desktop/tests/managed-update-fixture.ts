import { createHash } from 'node:crypto'
import {
  DESKTOP_MANAGED_UPDATE_CAPABILITY_SCHEMA_VERSION,
  DESKTOP_MANAGED_UPDATE_CHANNEL,
  DESKTOP_MANAGED_UPDATE_MANIFEST_ASSET,
  DESKTOP_MANAGED_UPDATE_MANIFEST_SCHEMA_VERSION,
  DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY,
  DESKTOP_MANAGED_UPDATE_TAG_PREFIX,
  DESKTOP_MANAGED_UPDATE_WORKFLOW,
  managedUpdateJsonSha256,
  type DesktopManagedUpdateCapability,
  type DesktopManagedUpdateManifest,
} from '../src/managed-update-protocol.ts'
import { DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY } from '../src/plugin-source.ts'
import { DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY } from '../src/plugin-provisioning.ts'

export const MANAGED_VERSION = '1.2.3'
export const MANAGED_SEQUENCE = 2
export const MANAGED_COMMIT = 'a'.repeat(40)
export const MANAGED_TREE = 'b'.repeat(40)
export const MANAGED_TAG = `${DESKTOP_MANAGED_UPDATE_TAG_PREFIX}${MANAGED_VERSION}`

export function managedCapability(
  overrides: Partial<DesktopManagedUpdateCapability> = {},
): DesktopManagedUpdateCapability {
  return {
    schemaVersion: DESKTOP_MANAGED_UPDATE_CAPABILITY_SCHEMA_VERSION,
    mode: 'github-release-managed',
    owner: DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY,
    tagPrefix: DESKTOP_MANAGED_UPDATE_TAG_PREFIX,
    manifestAsset: DESKTOP_MANAGED_UPDATE_MANIFEST_ASSET,
    currentSequence: MANAGED_SEQUENCE,
    minimumSequence: MANAGED_SEQUENCE,
    provisioning: {
      capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
      planSha256: 'b'.repeat(64),
    },
    ...overrides,
  }
}

export function managedManifest(
  overrides: Partial<Omit<DesktopManagedUpdateManifest, 'manifestSha256'>> = {},
): DesktopManagedUpdateManifest {
  const payload = {
    schemaVersion: DESKTOP_MANAGED_UPDATE_MANIFEST_SCHEMA_VERSION,
    owner: DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY,
    mode: 'interactive-windows-installer' as const,
    channel: DESKTOP_MANAGED_UPDATE_CHANNEL,
    version: MANAGED_VERSION,
    upstreamVersion: '1.2.2',
    sequence: MANAGED_SEQUENCE,
    source: {
      repository: DESKTOP_MANAGED_UPDATE_SOURCE_REPOSITORY,
      commit: MANAGED_COMMIT,
      tree: MANAGED_TREE,
      tag: MANAGED_TAG,
    },
    build: {
      workflow: DESKTOP_MANAGED_UPDATE_WORKFLOW,
      lockfileSha256: '4'.repeat(64),
      planSha256: '5'.repeat(64),
      nodeVersion: 'v24.13.0',
      pnpmVersion: '11.7.0',
      packageRegistry: 'https://registry.npmjs.org/',
    },
    identity: {
      appId: 'io.github.cloga.deepseek-harness.desktop' as const,
      productName: 'DeepSeek Harness (cloga)' as const,
      packageName: 'cloga-deepseek-harness-desktop' as const,
      executableName: 'cloga-deepseek-harness' as const,
    },
    installer: {
      file: `cloga-deepseek-harness-${MANAGED_VERSION}-win-x64.exe`,
      bytes: 123,
      sha256: '6'.repeat(64),
      sha512: `${'B'.repeat(86)}==`,
      signature: 'NotSigned' as const,
    },
    buildReceipt: {
      file: 'build-receipt.json',
      sha256: '7'.repeat(64),
      receiptSha256: '8'.repeat(64),
    },
    installedEvidence: {
      executableSha256: '9'.repeat(64),
      runtimeSha256: 'a'.repeat(64),
    },
    pluginCompatibility: {
      capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
      automaticProvisioning: false as const,
    },
    network: {
      manifestOrigin: 'https://github.com' as const,
      apiOrigin: 'https://api.github.com' as const,
      allowedRedirectHosts: [
        'github.com',
        'objects.githubusercontent.com',
        'release-assets.githubusercontent.com',
      ] as const,
    },
    installation: {
      interaction: 'required' as const,
      installerArguments: [] as const,
      uac: 'installer-controlled' as const,
      completion: 'post-restart-installed-evidence' as const,
    },
    ...overrides,
  }
  return { ...payload, manifestSha256: managedUpdateJsonSha256(payload) }
}

export function rawJsonSha256(value: unknown): string {
  return createHash('sha256').update(`${JSON.stringify(value)}\n`).digest('hex')
}
