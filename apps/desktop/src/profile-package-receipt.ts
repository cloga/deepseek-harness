/** Exact existing-schema receipt and provisioning transitions after final-location Host health verification. */
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, parseDesktopPluginProvisionReceipt } from './plugin-source.ts'
import { DESKTOP_PLUGIN_RECEIPTS_FILE, type DesktopPluginReceiptStore } from './plugin-receipts.ts'
import {
  DESKTOP_PLUGIN_PROVISIONING_STATE_FILE, buildDesktopProvisioningState,
  desktopPluginProvisioningPlanSha256, parseDesktopPluginProvisioningPlan,
} from './plugin-provisioning.ts'
import type { DesktopPreparedPackageActivation } from './profile-package-staging.ts'

/** Only the two established evidence files may be changed by a journal-bound commit. */
export interface DesktopReceiptFileTransition {
  readonly file: 'desktop-plugin-receipts.json' | 'desktop-plugin-provisioning-state.json'
  readonly before: string | null
  readonly after: string
}

/** Manual installs earn a receipt only; private provisioning additionally earns the exact baseline state. */
export interface DesktopReceiptTransition {
  readonly schemaVersion: 1
  readonly transactionId: string
  readonly file: 'desktop-plugin-receipts.json'
  readonly before: string | null
  readonly after: string
  readonly provisioningState?: {
    readonly file: 'desktop-plugin-provisioning-state.json'
    readonly before: null
    readonly after: string
  }
}
const MAX_BYTES = 8 * 1024 * 1024
function fail(): never { throw new Error('desktop package receipt: invalid or unqualified receipt transition') }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }

/** @param text - Exact UTF-8 evidence bytes. @returns SHA-256 for inventory substitution. */
export function desktopReceiptHash(text: string): string { return createHash('sha256').update(text).digest('hex') }

function readOptional(path: string): string | null {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined) return null
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail()
  const bytes = readFileSync(path)
  const text = bytes.toString('utf8')
  if (!Buffer.from(text).equals(bytes)) fail()
  return text
}

function store(text: string | null): DesktopPluginReceiptStore {
  if (text === null) return {
    schemaVersion: 1,
    receipts: Object.create(null) as DesktopPluginReceiptStore['receipts'],
    owners: Object.create(null) as DesktopPluginReceiptStore['owners'],
  }
  if (Buffer.byteLength(text) > MAX_BYTES) fail()
  const value: unknown = JSON.parse(text)
  if (!record(value) || value.schemaVersion !== 1 || !record(value.receipts) || !record(value.owners)
    || Object.keys(value).sort().join(',') !== 'owners,receipts,schemaVersion'
    || Object.keys(value.receipts).length !== Object.keys(value.owners).length) fail()
  const receipts = Object.create(null) as DesktopPluginReceiptStore['receipts']
  const owners = Object.create(null) as DesktopPluginReceiptStore['owners']
  for (const [name, raw] of Object.entries(value.receipts)) {
    const receipt = parseDesktopPluginProvisionReceipt(raw)
    const owner = value.owners[name]
    if (receipt.packageName !== name || (owner !== 'user' && owner !== 'release')) fail()
    receipts[name] = receipt; owners[name] = owner
  }
  return { schemaVersion: 1, receipts, owners }
}

function provisioningOwner(input: DesktopPreparedPackageActivation): 'user' | 'release' {
  if (typeof input.intentFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(input.intentFingerprint)) fail()
  const context = input.provisioning
  if (context === undefined) return 'user'
  const resource = input.owner.provisioningPlanResource
  const schemaVersion: unknown = context.schemaVersion
  if (schemaVersion !== 1 || resource === undefined || context.planSha256 !== resource.planSha256
    || context.planResourceSha256 !== resource.sha256 || JSON.stringify(context.source) !== JSON.stringify(input.verifiedRelease?.source)
    || !['create-release-owned', 'replace-release-owned'].includes(context.ownerDecision)
    || (context.ownerDecision === 'replace-release-owned' && !context.previousSelected)) fail()
  const bytes = readOptional(resource.file)
  if (bytes === null || desktopReceiptHash(bytes) !== resource.sha256) fail()
  const actualPlan = parseDesktopPluginProvisioningPlan(JSON.parse(bytes) as unknown)
  const expectedPlan = parseDesktopPluginProvisioningPlan({ schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: context.source }] })
  if (desktopPluginProvisioningPlanSha256(actualPlan) !== resource.planSha256
    || desktopPluginProvisioningPlanSha256(expectedPlan) !== resource.planSha256) fail()
  return 'release'
}

function expectedAfter(input: DesktopPreparedPackageActivation, before: string | null): string {
  const verified = input.verifiedRelease
  if (verified === undefined || input.mutation.kind !== 'install' || input.mutation.source.type !== 'githubRelease'
    || JSON.stringify(verified.source) !== JSON.stringify(input.mutation.source)
    || !('packageName' in input.prepared) || verified.packageName !== input.prepared.packageName) fail()
  const owner = provisioningOwner(input)
  const previous = store(before)
  if (Object.hasOwn(previous.receipts, verified.packageName) || Object.hasOwn(previous.owners, verified.packageName)) fail()
  const receipt = parseDesktopPluginProvisionReceipt({
    schemaVersion: 1, capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
    source: verified.source, releaseId: verified.releaseId, assetId: verified.assetId,
    packageName: verified.packageName, version: verified.version, artifactSha256: verified.source.sha256,
    states: { staged: true, health: 'passed', activated: true, rolledBack: false, verified: true },
  })
  return `${JSON.stringify({ schemaVersion: 1,
    receipts: { ...previous.receipts, [verified.packageName]: receipt },
    owners: { ...previous.owners, [verified.packageName]: owner },
  }, undefined, 2)}\n`
}

function expectedProvisioningState(input: DesktopPreparedPackageActivation, after: string): string {
  if (provisioningOwner(input) !== 'release' || input.provisioning === undefined || !('packageName' in input.prepared)) fail()
  const receipt = store(after).receipts[input.prepared.packageName]
  if (receipt === undefined) fail()
  const state = buildDesktopProvisioningState({ schemaVersion: 1, mode: 'exact',
    plugins: [{ required: true, source: input.provisioning.source }],
  }, receipt)
  return `${JSON.stringify(state, undefined, 2)}\n`
}

function targetEnabled(input: DesktopPreparedPackageActivation): boolean {
  if (!('packageName' in input.prepared)) fail()
  const manifest = readOptional(join(input.owner.profile, 'package.json'))
  if (manifest === null) fail()
  const value: unknown = JSON.parse(manifest)
  const profile = record(value) && record(value.dsh) && record(value.dsh.profile) ? value.dsh.profile : undefined
  if (!Array.isArray(profile?.bundles)) fail()
  return profile.bundles.includes(input.prepared.packageName)
}

/** @param input - Backend-validated private identity. @param value - Journal-owned proof. @returns Exact validated transition. */
export function validateDesktopReceiptTransition(input: DesktopPreparedPackageActivation, value: unknown): DesktopReceiptTransition {
  if (!record(value) || Object.keys(value).filter(key => key !== 'provisioningState').sort().join(',') !== 'after,before,file,schemaVersion,transactionId'
    || value.schemaVersion !== 1 || value.transactionId !== input.prepared.transactionId || value.file !== DESKTOP_PLUGIN_RECEIPTS_FILE
    || (value.before !== null && typeof value.before !== 'string') || typeof value.after !== 'string'
    || Buffer.byteLength(value.after) > MAX_BYTES || expectedAfter(input, value.before) !== value.after || !targetEnabled(input)) fail()
  let provisioningState: DesktopReceiptTransition['provisioningState']
  if (input.provisioning === undefined) {
    if (Object.hasOwn(value, 'provisioningState')) fail()
  } else {
    const next = value.provisioningState
    if (!record(next) || Object.keys(next).sort().join(',') !== 'after,before,file'
      || next.file !== DESKTOP_PLUGIN_PROVISIONING_STATE_FILE || next.before !== null || typeof next.after !== 'string'
      || Buffer.byteLength(next.after) > MAX_BYTES || next.after !== expectedProvisioningState(input, value.after)) fail()
    provisioningState = { file: DESKTOP_PLUGIN_PROVISIONING_STATE_FILE, before: null, after: next.after }
  }
  return { schemaVersion: 1, transactionId: input.prepared.transactionId, file: DESKTOP_PLUGIN_RECEIPTS_FILE,
    before: value.before, after: value.after, ...(provisioningState === undefined ? {} : { provisioningState }) }
}

/** @param proof - Validated journal proof. @returns The exact one or two fixed evidence-file transitions. */
export function desktopReceiptFileTransitions(proof: DesktopReceiptTransition): readonly DesktopReceiptFileTransition[] {
  return [
    { file: proof.file, before: proof.before, after: proof.after },
    ...(proof.provisioningState === undefined ? [] : [proof.provisioningState]),
  ]
}

/**
 * Prepare evidence only after the caller verifies actual final-location Host health under the common lease.
 * @param input - Validated identity whose candidate now occupies owner.profile.
 * @returns Proof, or undefined for disabled/nonverified manual packages and removals.
 */
export function prepareDesktopPackageReceipt(input: DesktopPreparedPackageActivation): DesktopReceiptTransition | undefined {
  if (input.mutation.kind === 'selection') {
    // Keep the discriminator check for direct untyped callers as well as validated staging inputs.
    const preparedKind: unknown = 'kind' in input.prepared ? input.prepared.kind : undefined
    if (input.verifiedRelease !== undefined || input.provisioning !== undefined || input.registryTarget !== undefined
      || preparedKind !== 'selection') fail()
    return undefined
  }
  if (input.verifiedRelease === undefined || !targetEnabled(input)) {
    if (input.provisioning !== undefined) fail()
    return undefined
  }
  const before = readOptional(join(input.owner.profile, DESKTOP_PLUGIN_RECEIPTS_FILE))
  const after = expectedAfter(input, before)
  if (input.provisioning !== undefined && readOptional(join(input.owner.profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE)) !== null) fail()
  return validateDesktopReceiptTransition(input, { schemaVersion: 1, transactionId: input.prepared.transactionId,
    file: DESKTOP_PLUGIN_RECEIPTS_FILE, before, after,
    ...(input.provisioning === undefined ? {} : { provisioningState: {
      file: DESKTOP_PLUGIN_PROVISIONING_STATE_FILE, before: null, after: expectedProvisioningState(input, after),
    } }),
  })
}

/** @param input - Validated transaction. @param value - Bound proof. @returns Exact before, after, or valid mixed two-write progress. */
export function desktopPackageReceiptPosition(input: DesktopPreparedPackageActivation, value: DesktopReceiptTransition): 'before' | 'after' | 'mixed' {
  const proof = validateDesktopReceiptTransition(input, value)
  const positions = desktopReceiptFileTransitions(proof).map((file) => {
    const current = readOptional(join(input.owner.profile, file.file))
    if (current === file.after) return 'after'
    if (current === file.before) return 'before'
    fail()
  })
  return positions.every(item => item === 'after') ? 'after' : positions.every(item => item === 'before') ? 'before' : 'mixed'
}

/**
 * Apply only journaled bytes after renewed Host verification; resume valid partial writes idempotently.
 * @param input - Validated active transaction.
 * @param value - Proof durably recorded before writing; absent means no receipt is earned.
 */
// oxlint-disable-next-line typescript/require-await -- Preserve synchronous writes and Promise-based failure delivery.
export async function commitDesktopPackageReceipt(
  input: DesktopPreparedPackageActivation, value?: DesktopReceiptTransition,
): Promise<void> {
  if (value === undefined || desktopPackageReceiptPosition(input, value) === 'after') return
  const proof = validateDesktopReceiptTransition(input, value)
  for (const file of desktopReceiptFileTransitions(proof)) {
    if (readOptional(join(input.owner.profile, file.file)) === file.after) continue
    const path = join(input.owner.profile, file.file)
    const temporary = join(input.transactionDir, `receipt-${randomUUID()}.tmp`)
    const fd = openSync(temporary, 'wx', 0o600)
    try { writeFileSync(fd, file.after); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, path)
    if (process.platform !== 'win32') {
      const directory = openSync(dirname(path), 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
  }
  if (desktopPackageReceiptPosition(input, proof) !== 'after') fail()
}
