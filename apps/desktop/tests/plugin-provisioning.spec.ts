import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
  desktopPluginProvisioningPlanSha256,
  parseDesktopPluginProvisioningPlan,
  parseDesktopPluginProvisioningState,
} from '../src/plugin-provisioning.ts'
import { DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY } from '../src/plugin-source.ts'

const LEGACY_CAPABILITY = {
  id: 'desktopNativePluginProvisioning', schemaVersion: 1, planSchemaVersion: 1, stateSchemaVersion: 1,
  pluginCapability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
} as const

function source(name = 'neutral-auth-provider', version = '1.0.0') {
  const checksum = Buffer.from('checksums')
  return {
    schemaVersion: 1 as const, type: 'githubRelease' as const, owner: 'example', repo: name,
    tag: `v${version}`, asset: `${name}-${version}.tgz`, assetId: 2, packageName: name, version,
    size: 123, sha256: 'a'.repeat(64), integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
    targetCommit: 'b'.repeat(40), checksumManifest: {
      format: 'sha256sums' as const, asset: 'SHA256SUMS', assetId: 3,
      url: `https://github.com/example/${name}/releases/download/v${version}/SHA256SUMS`,
      size: checksum.byteLength, sha256: createHash('sha256').update(checksum).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(checksum).digest('base64')}`,
    },
  }
}

function receipt(value = source()) {
  return {
    schemaVersion: 1 as const, capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, source: value,
    releaseId: 1, assetId: 2, packageName: value.packageName, version: value.version, artifactSha256: value.sha256,
    states: { staged: true as const, health: 'passed' as const, activated: true as const, rolledBack: false as const, verified: true as const },
  }
}

describe('Desktop plugin provisioning descriptors', () => {
  it('reads legacy state strictly and normalizes its requested and effective source', () => {
    const legacy = {
      schemaVersion: 1, capability: LEGACY_CAPABILITY, planSha256: 'a'.repeat(64), composition: 'active',
      plugins: [{ name: 'neutral-auth-provider', version: '1.0.0', required: true, status: 'active', source: source(), receipt: receipt() }],
      removed: [], rolledBack: false, verified: true,
    }
    expect(parseDesktopPluginProvisioningState(legacy)).toMatchObject({
      schemaVersion: 1, planSchemaVersion: 1,
      plugins: [{ requestedSource: source(), sourcePolicy: 'strict-pin', effective: 'plan', effectiveSource: source() }],
    })
    expect(() => parseDesktopPluginProvisioningState({ ...legacy, capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY })).toThrow()
  })

  it('records schema-2 requested and effective sources honestly', () => {
    const requestedSource = source('neutral-auth-provider', '1.0.0')
    const effectiveSource = { ...source('neutral-auth-provider', '1.1.0'), sha256: 'c'.repeat(64) }
    const state = {
      schemaVersion: 2, capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY, planSchemaVersion: 2,
      planSha256: 'a'.repeat(64), composition: 'active', plugins: [{
        name: requestedSource.packageName, required: true, status: 'active', requestedSource,
        sourcePolicy: 'compatible-user-override', effective: 'user-override', effectiveSource,
        receipt: receipt(effectiveSource),
      }], removed: [], rolledBack: false, verified: true,
    }
    expect(parseDesktopPluginProvisioningState(state).plugins[0]).toMatchObject({ requestedSource, effectiveSource, effective: 'user-override' })
    expect(() => parseDesktopPluginProvisioningState({
      ...state, plugins: [{ ...state.plugins[0], effectiveSource: requestedSource }],
    })).toThrow()
    expect(() => parseDesktopPluginProvisioningState({ ...state, planSchemaVersion: 1 })).toThrow()
    expect(() => parseDesktopPluginProvisioningState({
      ...state, planSchemaVersion: 1, plugins: [{
        name: requestedSource.packageName, required: false, status: 'optional-failed', requestedSource,
        sourcePolicy: 'compatible-user-override', phase: 'health', message: 'failed',
      }],
    })).toThrow()
    for (const alien of [
      { ...effectiveSource, owner: 'other' },
      { ...effectiveSource, repo: 'other' },
      { ...effectiveSource, dependencyRegistry: 'https://registry.example/' },
    ]) {
      expect(() => parseDesktopPluginProvisioningState({
        ...state, plugins: [{ ...state.plugins[0], effectiveSource: alien, receipt: receipt(alien) }],
      })).toThrow()
    }
  })

  it('parses schema-1 strict pins and schema-2 explicit policies with stable hashes', () => {
    const legacy = parseDesktopPluginProvisioningPlan({ schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: source() }] })
    expect(JSON.parse(JSON.stringify(legacy))).toEqual({
      schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: source() }],
    })
    expect(desktopPluginProvisioningPlanSha256(legacy)).toBe(createHash('sha256').update(JSON.stringify({
      schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: source() }],
    })).digest('hex'))
    expect(() => desktopPluginProvisioningPlanSha256({
      schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: source(), sourcePolicy: 'compatible-user-override' }],
    })).toThrow()
    const current = parseDesktopPluginProvisioningPlan({
      schemaVersion: 2, mode: 'exact', plugins: [{ required: true, source: source(), sourcePolicy: 'compatible-user-override' }],
    })
    if (current.schemaVersion !== 2) throw new Error('expected schema 2')
    expect(current.plugins[0]?.sourcePolicy).toBe('compatible-user-override')
    expect(desktopPluginProvisioningPlanSha256(current)).toMatch(/^[a-f0-9]{64}$/u)
  })

  it('rejects implicit schema-2 policy, policy on schema 1, mutable, duplicate, and mixed-registry plans', () => {
    const exact = source()
    for (const plan of [
      { schemaVersion: 2, mode: 'exact', plugins: [{ required: true, source: exact }] },
      { schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: exact, sourcePolicy: 'strict-pin' }] },
      { schemaVersion: 2, mode: 'exact', plugins: [{ required: true, source: exact, sourcePolicy: 'unknown' }] },
      { schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: { ...exact, checksumManifest: undefined } }] },
      { schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: exact }, { required: false, source: exact }] },
      { schemaVersion: 1, mode: 'exact', plugins: [
        { required: true, source: { ...exact, dependencyRegistry: 'https://registry.example/' } },
        { required: true, source: source('second-provider') },
      ] },
    ]) expect(() => parseDesktopPluginProvisioningPlan(plan)).toThrow()
  })
})
