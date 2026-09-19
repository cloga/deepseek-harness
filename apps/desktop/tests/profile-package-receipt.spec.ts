/** Existing receipt schema, exact write proof, and idempotent post-readiness commit over private files. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import type { DesktopPreparedPackageActivation } from '../src/profile-package-staging.ts'
import { DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, type DesktopGithubReleasePluginSource } from '../src/plugin-source.ts'
import {
  desktopPluginProvisioningPlanSha256, parseDesktopPluginProvisioningPlan, parseDesktopPluginProvisioningState,
} from '../src/plugin-provisioning.ts'
import { readDesktopPluginReceipts, type DesktopPluginReceiptStore } from '../src/plugin-receipts.ts'
import { commitDesktopPackageReceipt, desktopPackageReceiptPosition, desktopReceiptFileTransitions, desktopReceiptHash, prepareDesktopPackageReceipt, validateDesktopReceiptTransition } from '../src/profile-package-receipt.ts'

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
const source: DesktopGithubReleasePluginSource = {
  schemaVersion: 1, type: 'githubRelease', owner: 'example', repo: 'addon', tag: 'v1.0.0', asset: 'addon.tgz', assetId: 2,
  packageName: 'addon', version: '1.0.0', size: 1, sha256: 'a'.repeat(64), targetCommit: 'b'.repeat(40),
}
function fixture(enabled = true) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-receipt-proof-'))
  roots.push(root)
  const profile = join(root, 'profile')
  const transactionDir = join(root, 'transaction')
  mkdirSync(profile); mkdirSync(transactionDir)
  writeFileSync(join(profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: enabled ? ['addon'] : [] } } }))
  const input: DesktopPreparedPackageActivation = {
    transactionDir, candidateDir: join(transactionDir, 'profile'), rollbackDir: join(transactionDir, 'rollback'),
    baseGraphFingerprint: '1'.repeat(64), candidateFingerprint: '2'.repeat(64), intentFingerprint: '5'.repeat(64),
    owner: { profile, runtimeDir: join(root, 'runtime'), installAnchor: join(root, 'runtime', 'package.json'), runtimeFingerprint: '3'.repeat(64), dependencyRegistry: 'https://registry.example.test/', configPaths: [] },
    mutation: { kind: 'install', source, enabled },
    prepared: { transactionId: '11111111-1111-4111-8111-111111111111', state: 'prepared', packageName: 'addon', baseFingerprint: '4'.repeat(64), health: 'pending' },
    verifiedRelease: { source, releaseId: 1, assetId: 2, packageName: 'addon', version: '1.0.0' },
  }
  return { input, receipt: join(profile, 'desktop-plugin-receipts.json') }
}

function provisioningFixture() {
  const f = fixture()
  const planned = { ...source, checksumManifest: { format: 'sha256sums' as const, asset: 'SHA256SUMS', assetId: 3,
    url: 'https://github.com/example/addon/releases/download/v1.0.0/SHA256SUMS', size: 1, sha256: 'c'.repeat(64) } }
  const plan = parseDesktopPluginProvisioningPlan({ schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: planned }] })
  const file = join(f.input.transactionDir, 'packaged-plan.json')
  const bytes = JSON.stringify(plan)
  writeFileSync(file, bytes)
  const sha256 = desktopReceiptHash(bytes)
  const planSha256 = desktopPluginProvisioningPlanSha256(plan)
  const input: DesktopPreparedPackageActivation = { ...f.input,
    owner: { ...f.input.owner, provisioningPlanResource: { file, sha256, planSha256 } },
    mutation: { kind: 'install', source: planned, enabled: true },
    verifiedRelease: { source: planned, releaseId: 1, assetId: 2, packageName: 'addon', version: '1.0.0' },
    provisioning: { schemaVersion: 1, planSha256, planResourceSha256: sha256, source: planned,
      ownerDecision: 'create-release-owned', previousSelected: false },
  }
  return { ...f, input, planFile: file }
}

it.each(['neither', 'receipt', 'state', 'both'] as const)('completes only the missing fixed evidence writes after %s was persisted', async (persisted) => {
  const f = provisioningFixture()
  const proof = prepareDesktopPackageReceipt(f.input)!
  const transitions = desktopReceiptFileTransitions(proof)
  expect(transitions).toHaveLength(2)
  for (const [index, file] of transitions.entries()) {
    if (persisted === 'both' || (persisted === 'receipt' && index === 0) || (persisted === 'state' && index === 1)) {
      writeFileSync(join(f.input.owner.profile, file.file), file.after)
    }
  }
  expect(desktopPackageReceiptPosition(f.input, proof)).toBe(persisted === 'neither' ? 'before' : persisted === 'both' ? 'after' : 'mixed')
  await commitDesktopPackageReceipt(f.input, proof)
  await commitDesktopPackageReceipt(f.input, proof)
  expect(desktopPackageReceiptPosition(f.input, proof)).toBe('after')
  const receipts = readDesktopPluginReceipts(f.input.owner.profile)
  const state = parseDesktopPluginProvisioningState(
    JSON.parse(readFileSync(join(f.input.owner.profile, 'desktop-plugin-provisioning-state.json'), 'utf8')),
  )
  expect(receipts.owners.addon).toBe('release')
  expect(state).toMatchObject({ schemaVersion: 1, composition: 'active', planSha256: f.input.provisioning!.planSha256 })
  expect(state.plugins[0]!.receipt).toEqual(receipts.receipts.addon)
})

it('rejects manual escalation, modified plan bytes, and arbitrary second evidence files', async () => {
  const manual = fixture()
  const manualProof = prepareDesktopPackageReceipt(manual.input)!
  expect(() => validateDesktopReceiptTransition(manual.input, { ...manualProof,
    provisioningState: { file: 'desktop-plugin-provisioning-state.json', before: null, after: '{}' } })).toThrow('invalid or unqualified')
  const f = provisioningFixture()
  const proof = prepareDesktopPackageReceipt(f.input)!
  expect(() => validateDesktopReceiptTransition(f.input, { ...proof,
    provisioningState: { ...proof.provisioningState, file: 'package.json' } })).toThrow('invalid or unqualified')
  writeFileSync(f.planFile, '{}')
  await expect(commitDesktopPackageReceipt(f.input, proof)).rejects.toThrow('invalid or unqualified')
})

it('validates both evidence positions before changing either file', async () => {
  const f = provisioningFixture()
  const proof = prepareDesktopPackageReceipt(f.input)!
  const state = join(f.input.owner.profile, 'desktop-plugin-provisioning-state.json')
  writeFileSync(state, '{unexpected partial state')
  await expect(commitDesktopPackageReceipt(f.input, proof)).rejects.toThrow('invalid or unqualified')
  expect(existsSync(f.receipt)).toBe(false)
  expect(readFileSync(state, 'utf8')).toBe('{unexpected partial state')
})

it('does not produce an active receipt for a disabled verified bundle', () => {
  expect(prepareDesktopPackageReceipt(fixture(false).input)).toBeUndefined()
})

it('refuses even a valid proof if the target is no longer enabled', () => {
  const f = fixture()
  const proof = prepareDesktopPackageReceipt(f.input)!
  writeFileSync(join(f.input.owner.profile, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
  expect(() => validateDesktopReceiptTransition(f.input, proof)).toThrow('invalid or unqualified')
})

it('writes the exact existing-schema receipt only when explicitly committed and is idempotent', async () => {
  const f = fixture()
  const proof = prepareDesktopPackageReceipt(f.input)!
  expect(proof.before).toBeNull()
  expect(desktopPackageReceiptPosition(f.input, proof)).toBe('before')
  await commitDesktopPackageReceipt(f.input, proof)
  expect(desktopPackageReceiptPosition(f.input, proof)).toBe('after')
  expect(JSON.parse(readFileSync(f.receipt, 'utf8'))).toMatchObject({ schemaVersion: 1, owners: { addon: 'user' },
    receipts: { addon: { source, states: { staged: true, health: 'passed', activated: true, rolledBack: false, verified: true } } } })
  await commitDesktopPackageReceipt(f.input, proof)
  expect(readFileSync(f.receipt, 'utf8')).toBe(proof.after)
})

it('preserves unrelated receipt ownership and rejects a proof that changes it', () => {
  const f = fixture()
  const otherSource = { ...source, packageName: 'other' }
  const other = { schemaVersion: 1, capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, source: otherSource,
    releaseId: 1, assetId: 2, packageName: 'other', version: '1.0.0', artifactSha256: source.sha256,
    states: { staged: true, health: 'passed', activated: true, rolledBack: false, verified: true } }
  writeFileSync(f.receipt, JSON.stringify({ schemaVersion: 1, receipts: { other }, owners: { other: 'release' } }))
  const proof = prepareDesktopPackageReceipt(f.input)!
  const after = JSON.parse(proof.after) as DesktopPluginReceiptStore
  expect(after.owners).toEqual({ other: 'release', addon: 'user' })
  after.owners.other = 'user'
  expect(() => validateDesktopReceiptTransition(f.input, { ...proof, after: JSON.stringify(after) })).toThrow('invalid or unqualified')
})

it('rejects altered source, path, transaction identity, and a partial unexpected write', async () => {
  const f = fixture()
  const proof = prepareDesktopPackageReceipt(f.input)!
  for (const change of [{ file: 'package.json' }, { transactionId: '22222222-2222-4222-8222-222222222222' },
    { after: proof.after.replace(source.sha256, 'c'.repeat(64)) }]) {
    expect(() => validateDesktopReceiptTransition(f.input, { ...proof, ...change })).toThrow('invalid or unqualified')
  }
  writeFileSync(f.receipt, '{partially-written')
  await expect(commitDesktopPackageReceipt(f.input, proof)).rejects.toThrow('invalid or unqualified')
  expect(readFileSync(f.receipt, 'utf8')).toBe('{partially-written')
})
