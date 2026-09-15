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

const capabilityValue = {
  schemaVersion: 1,
  mode: 'windows-ops-managed',
  manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/download/dsh-v1.2.3/release.json',
  manifestSha256: '',
  minimumSequence: 2,
  expectedSource: {
    version: '1.2.3',
    commit: 'a'.repeat(40),
  },
}

function sourceManifest() {
  const value = {
    schemaVersion: 2,
    owner: 'cloga/deepseek-harness',
    mode: 'interactive-windows-installer',
    version: '1.2.3',
    sequence: 2,
    source: {
      repository: 'cloga/deepseek-harness',
      commit: 'a'.repeat(40),
      tag: 'dsh-v1.2.3',
    },
    installer: {
      file: 'deepseek-harness-1.2.3-win-x64.exe',
      bytes: 123,
      sha256: 'b'.repeat(64),
      sha512: `${'A'.repeat(86)}==`,
      signature: 'NotSigned',
    },
    buildReceipt: {
      file: 'build-receipt.json',
      sha256: 'f'.repeat(64),
      receiptSha256: '1'.repeat(64),
    },
    installedEvidence: {
      executableSha256: 'c'.repeat(64),
      runtimeSha256: 'd'.repeat(64),
    },
    pluginProvisioning: {
      capability: 'verified-github-release',
      source: {
        schemaVersion: 1,
        type: 'githubRelease',
        owner: 'cloga',
        repo: 'dsh-github-copilot',
        tag: 'v0.4.0-alpha.18',
        asset: 'dsh-github-copilot-0.4.0-alpha.18.tgz',
        packageName: 'dsh-github-copilot',
        version: '0.4.0-alpha.18',
        size: 1,
        sha256: '2'.repeat(64),
        integrity: `sha512-${'A'.repeat(86)}==`,
        targetCommit: '3'.repeat(40),
      },
      receiptSha256: 'e'.repeat(64),
    },
  }
  return { ...value, manifestSha256: managedUpdateJsonSha256(value) }
}

describe('Desktop managed update protocol', () => {
  it('accepts a source-owned immutable manifest selected by exact hash and sequence', () => {
    const manifest = sourceManifest()
    const capability = parseDesktopManagedUpdateCapability({
      ...capabilityValue,
      manifestSha256: manifest.manifestSha256,
    })
    expect(parseDesktopManagedUpdateManifest(manifest, capability, 1)).toMatchObject({
      owner: 'cloga/deepseek-harness',
      version: '1.2.3',
      sequence: 2,
    })
  })

  it('rejects self-hash tampering, rollback, arbitrary repositories, and mutable release aliases', () => {
    const manifest = sourceManifest()
    const capability = parseDesktopManagedUpdateCapability({
      ...capabilityValue,
      manifestSha256: manifest.manifestSha256,
    })
    expect(() => parseDesktopManagedUpdateManifest({ ...manifest, version: '1.2.4' }, capability, 1))
      .toThrow(/self-hash/u)
    expect(() => parseDesktopManagedUpdateManifest(manifest, capability, 2))
      .toThrow(/does not advance/u)
    expect(() => parseDesktopManagedUpdateCapability({
      ...capabilityValue,
      manifestSha256: manifest.manifestSha256,
      manifestUrl: 'https://github.com/attacker/repo/releases/download/v1/release.json',
    })).toThrow(/immutable cloga\/deepseek-harness/u)
    expect(() => parseDesktopManagedUpdateCapability({
      ...capabilityValue,
      manifestSha256: manifest.manifestSha256,
      manifestUrl: 'https://github.com/cloga/deepseek-harness/releases/latest/download/release.json',
    })).toThrow(/immutable/u)
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
    const capability = parseDesktopManagedUpdateCapability({
      ...capabilityValue,
      minimumSequence: 1,
      manifestSha256: 'f'.repeat(64),
      migration: {
        owner: 'cloga/dsh-windows-ops',
        manifestUrl: 'https://github.com/cloga/dsh-windows-ops/releases/download/dsh-local-0.1.5-rc.2.local.1/release.json',
        manifestSha256: manifest.manifestSha256,
        maximumSequence: 1,
        expectedSource: {
          version: '0.1.5-rc.2',
          commit: 'f'.repeat(40),
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
    expect(managedUpdateAssetUrl(capabilityValue.manifestUrl, 'installer.exe'))
      .toBe('https://github.com/cloga/deepseek-harness/releases/download/dsh-v1.2.3/installer.exe')
    expect(() => { managedUpdateAssetUrl(capabilityValue.manifestUrl, '../installer.exe') }).toThrow(/plain filename/u)
    expect(() => { assertManagedUpdateRedirect(capabilityValue.manifestUrl, 'https://attacker.example/installer.exe') })
      .toThrow(/unsupported host/u)
    expect(() => { assertManagedUpdateRedirect(capabilityValue.manifestUrl, 'https://release-assets.githubusercontent.com/object') })
      .not.toThrow()
  })

  it('accepts only targeted PIDs and a bounded helper timeout', () => {
    expect(parseDesktopManagedUpdateHandoff({
      schemaVersion: 1,
      token: 'a'.repeat(64),
      capability: { ...capabilityValue, manifestSha256: 'b'.repeat(64) },
      selectedManifest: 'source',
      stageRoot: resolve('.test-managed-update-stage'),
      waitPids: [12, 34, 12],
      waitTimeoutMs: 60_000,
      installedSequence: 1,
    }).waitPids).toEqual([12, 34])
    expect(() => parseDesktopManagedUpdateHandoff({
      schemaVersion: 1,
      token: 'a'.repeat(64),
      capability: { ...capabilityValue, manifestSha256: 'b'.repeat(64) },
      selectedManifest: 'source',
      stageRoot: 'relative',
      waitPids: [],
      waitTimeoutMs: 120_001,
      installedSequence: 1,
    })).toThrow()
  })
})
