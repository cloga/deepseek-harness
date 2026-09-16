import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
  desktopPluginProvisioningPlanSha256,
  parseDesktopPluginProvisioningPlan,
  parseDesktopPluginProvisioningState,
} from '../src/plugin-provisioning.ts'
import { DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY } from '../src/plugin-source.ts'

function source(name = 'neutral-auth-provider') {
  const checksum = Buffer.from('checksums')
  return {
    schemaVersion: 1 as const,
    type: 'githubRelease' as const,
    owner: 'example',
    repo: name,
    tag: 'v1.0.0',
    asset: `${name}-1.0.0.tgz`,
    assetId: 2,
    packageName: name,
    version: '1.0.0',
    size: 123,
    sha256: 'a'.repeat(64),
    integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    targetCommit: 'b'.repeat(40),
    checksumManifest: {
      format: 'sha256sums' as const,
      asset: 'SHA256SUMS',
      assetId: 3,
      url: `https://github.com/example/${name}/releases/download/v1.0.0/SHA256SUMS`,
      size: checksum.byteLength,
      sha256: createHash('sha256').update(checksum).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(checksum).digest('base64')}`,
    },
  }

}

function receipt(value = source()) {
  return {
    schemaVersion: 1 as const,
    capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
    source: value,
    releaseId: 1,
    assetId: 2,
    packageName: value.packageName,
    version: value.version,
    artifactSha256: value.sha256,
    states: {
      staged: true as const,
      health: 'passed' as const,
      activated: true as const,
      rolledBack: false as const,
      verified: true as const,
    },
  }
}

describe('Desktop plugin provisioning descriptors', () => {
  it('records an optional failure without inventing a receipt and rejects incomplete results', () => {
    const plugin = {
      name: 'neutral-auth-provider', version: '1.0.0', required: false,
      status: 'optional-failed', source: source(), phase: 'download', message: 'source unavailable',
    }
    const state = {
      schemaVersion: 1, capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
      planSha256: 'a'.repeat(64), composition: 'active', plugins: [plugin],
      removed: [], rolledBack: false, verified: true,
    }
    expect(parseDesktopPluginProvisioningState(state).plugins[0]).toEqual(plugin)
    for (const invalid of [
      { ...plugin, receipt: receipt() },
      { ...plugin, required: true },
      { ...plugin, phase: undefined },
      { ...plugin, phase: 'unknown' },
      { ...plugin, message: '' },
      { ...plugin, status: 'active' },
    ]) {
      expect(() => parseDesktopPluginProvisioningState({ ...state, plugins: [invalid] })).toThrow()
    }
    expect(() => parseDesktopPluginProvisioningState({ ...state, plugins: [plugin, plugin] })).toThrow()
  })

  it('parses an exact checksum-attested plan and stable active state', () => {
    const plan = parseDesktopPluginProvisioningPlan({
      schemaVersion: 1,
      mode: 'exact',
      plugins: [{ required: true, source: source() }],
    })
    const planSha256 = desktopPluginProvisioningPlanSha256(plan)
    expect(planSha256).toMatch(/^[a-f0-9]{64}$/u)
    expect(parseDesktopPluginProvisioningState({
      schemaVersion: 1,
      capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
      planSha256,
      composition: 'active',
      plugins: [{
        name: 'neutral-auth-provider',
        version: '1.0.0',
        required: true,
        status: 'active',
        source: source(),
        receipt: receipt(),
      }],
      removed: [],
      rolledBack: false,
      verified: true,
    })).toMatchObject({ planSha256, composition: 'active', verified: true })
  })

  it('rejects mutable, duplicate, non-attested, and mixed-registry plans', () => {
    const exact = source()
    for (const plan of [
      { schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: { ...exact, checksumManifest: undefined } }] },
      { schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: exact }, { required: false, source: exact }] },
      {
        schemaVersion: 1,
        mode: 'exact',
        plugins: [
          { required: true, source: { ...exact, dependencyRegistry: 'https://registry.example/' } },
          { required: true, source: source('second-provider') },
        ],
      },
    ]) {
      expect(() => parseDesktopPluginProvisioningPlan(plan)).toThrow()
    }
  })
})
