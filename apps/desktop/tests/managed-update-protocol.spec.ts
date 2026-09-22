import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  assertManagedUpdateRedirect,
  legacyManagedUpdateManifestSha256,
  managedUpdateAssetUrl,
  managedUpdateJsonSha256,
  parseDesktopManagedUpdateCapability,
  parseDesktopManagedUpdateHandoff,
  parseDesktopManagedUpdateManifest,
} from '../src/managed-update-protocol.ts'
import {
  MANAGED_COMMIT,
  MANAGED_SEQUENCE,
  MANAGED_VERSION,
  managedCapability,
  managedManifest,
} from './managed-update-fixture.ts'

describe('Desktop managed update protocol', () => {
  it('accepts a fixed source-owned discovery capability and versioned manifest', () => {
    const capability = parseDesktopManagedUpdateCapability(managedCapability())
    expect(capability).toMatchObject({
      mode: 'github-release-managed',
      owner: 'cloga/deepseek-harness',
      tagPrefix: 'dsh-desktop-v',
      currentSequence: MANAGED_SEQUENCE,
      provisioning: {
        capability: {
          id: 'desktopNativePluginProvisioning',
          schemaVersion: 2,
          planSchemaVersion: 2,
          stateSchemaVersion: 2,
        },
        planSha256: 'b'.repeat(64),
      },
    })
    expect(parseDesktopManagedUpdateManifest(managedManifest(), capability, 1)).toMatchObject({
      owner: 'cloga/deepseek-harness',
      version: MANAGED_VERSION,
      sequence: MANAGED_SEQUENCE,
    })
  })

  it('rejects self-hash tampering, rollback, arbitrary discovery fields, and mutable aliases', () => {
    const manifest = managedManifest()
    const capability = managedCapability()
    expect(() => parseDesktopManagedUpdateManifest({
      ...manifest,
      installedEvidence: {
        ...manifest.installedEvidence,
        executableSha256: 'f'.repeat(64),
      },
    }, capability, 1))
      .toThrow(/self-hash/u)
    expect(() => parseDesktopManagedUpdateManifest(manifest, capability, MANAGED_SEQUENCE))
      .toThrow(/does not advance/u)
    expect(() => parseDesktopManagedUpdateCapability({
      ...capability,
      owner: 'attacker/repo',
    })).toThrow(/unsupported capability/u)
    expect(() => parseDesktopManagedUpdateHandoff({
      schemaVersion: 1,
      token: 'a'.repeat(64),
      capability,
      selection: {
        kind: 'source',
        manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/latest/download/release.json',
        manifestSha256: manifest.manifestSha256,
        assetSha256: 'b'.repeat(64),
      },
      stageRoot: resolve('.test-managed-update-stage'),
      waitPids: [12],
      waitTimeoutMs: 60_000,
      installedSequence: 1,
    })).toThrow(/immutable|versioned/u)
  })

  it('accepts the legacy owner only through the exact one-time migration capability', () => {
    const payload = {
      schemaVersion: 1,
      owner: 'cloga/dsh-windows-ops',
      mode: 'unsigned-manual',
      channel: 'rc',
      channelVersion: '0.1.5-rc.2.local.1',
      upstreamVersion: '0.1.5-rc.2',
      sequence: 1,
      createdUtc: '2026-09-14T23:21:49.8645707Z',
      feedBaseUrl: 'https://github.com/cloga/dsh-windows-ops/releases/download/dsh-local-0.1.5-rc.2.local.1/',
      feedFile: 'rc.yml',
      installer: {
        file: 'dsh-local-build-0.1.5-rc.2.local.1-win-x64.exe',
        size: 123,
        sha256: 'a'.repeat(64),
        sha512: `${'B'.repeat(86)}==`,
        signature: 'NotSigned',
      },
      buildReceipt: {
        file: 'build-receipt.json',
        sha256: 'b'.repeat(64),
        receiptSha256: 'c'.repeat(64),
      },
      installedEvidence: {
        executableSha256: 'd'.repeat(64),
        seedSha256: 'e'.repeat(64),
      },
      security: {
        nativeUpdaterEnabled: false,
        appUpdateYmlPresent: false,
        signatureRequiredForNativeUpdater: true,
        applyMode: 'manual',
        publication: 'immutable-github-release-or-approved-static-feed',
      },
    }
    const manifest = { ...payload, manifestSha256: legacyManagedUpdateManifestSha256(payload) }
    const capability = managedCapability({
      currentSequence: 2,
      migration: {
        owner: 'cloga/dsh-windows-ops',
        manifestUrl: 'https://github.com/cloga/dsh-windows-ops/releases/download/dsh-local-0.1.5-rc.2.local.1/release.json',
        manifestSha256: manifest.manifestSha256,
        assetSha256: managedUpdateJsonSha256(manifest),
        maximumSequence: 1,
        expectedSource: {
          version: '0.1.5-rc.2',
          tag: 'dsh-v0.1.5-rc.2',
        },
      },
    })
    expect(parseDesktopManagedUpdateManifest(manifest, capability, 0)).toMatchObject({
      owner: 'cloga/dsh-windows-ops',
      sequence: 1,
    })
    expect(() => parseDesktopManagedUpdateManifest(manifest, capability, 1)).toThrow(/does not advance|consumed/u)
  })

  it('derives assets beside the locked manifest and rejects non-GitHub redirect hosts', () => {
    const url = `https://github.com/cloga/deepseek-harness/releases/download/dsh-desktop-v${MANAGED_VERSION}/release.json`
    expect(managedUpdateAssetUrl(url, 'installer.exe'))
      .toBe(`https://github.com/cloga/deepseek-harness/releases/download/dsh-desktop-v${MANAGED_VERSION}/installer.exe`)
    expect(() => { managedUpdateAssetUrl(url, '../installer.exe') }).toThrow(/plain filename/u)
    expect(() => { assertManagedUpdateRedirect(url, 'https://attacker.example/installer.exe') })
      .toThrow(/unsupported host/u)
    expect(() => { assertManagedUpdateRedirect(url, 'https://release-assets.githubusercontent.com/object') })
      .not.toThrow()
  })

  it('accepts only targeted PIDs and a bounded helper timeout', () => {
    const manifest = managedManifest()
    expect(parseDesktopManagedUpdateHandoff({
      schemaVersion: 1,
      token: 'a'.repeat(64),
      capability: managedCapability(),
      selection: {
        kind: 'source',
        manifestUrl: `https://github.com/cloga/deepseek-harness/releases/download/dsh-desktop-v${MANAGED_VERSION}/release.json`,
        manifestSha256: manifest.manifestSha256,
        assetSha256: 'b'.repeat(64),
      },
      stageRoot: resolve('.test-managed-update-stage'),
      waitPids: [12, 34, 12],
      waitTimeoutMs: 60_000,
      installedSequence: 1,
    }).waitPids).toEqual([12, 34])
    expect(() => parseDesktopManagedUpdateHandoff({
      schemaVersion: 1,
      token: 'a'.repeat(64),
      capability: managedCapability(),
      selection: {
        kind: 'source',
        manifestUrl: `https://github.com/cloga/deepseek-harness/releases/download/dsh-desktop-v${MANAGED_VERSION}/release.json`,
        manifestSha256: 'b'.repeat(64),
        assetSha256: 'c'.repeat(64),
      },
      stageRoot: 'relative',
      waitPids: [],
      waitTimeoutMs: 120_001,
      installedSequence: 1,
    })).toThrow()
  })

  it('pins manifest source identity, build inputs, plugin schemas, network policy, and interactive completion', () => {
    const manifest = managedManifest()
    expect(manifest.source.tree).toMatch(/^[a-f0-9]{40}$/u)
    expect(manifest).toMatchObject({
      source: { commit: MANAGED_COMMIT },
      build: {
        workflow: '.github/workflows/desktop-fork-release.yml',
        nodeVersion: 'v24.13.0',
        pnpmVersion: '11.7.0',
        packageRegistry: 'https://registry.npmjs.org/',
      },
      pluginCompatibility: {
        capability: {
          id: 'desktopNativeVerifiedRelease',
          schemaVersion: 1,
          sourceSchemaVersion: 1,
          receiptSchemaVersion: 1,
        },
        automaticProvisioning: false,
      },
      network: {
        manifestOrigin: 'https://github.com',
        apiOrigin: 'https://api.github.com',
      },
      installation: {
        interaction: 'required',
        installerArguments: [],
        completion: 'post-restart-installed-evidence',
      },
    })
  })
})
