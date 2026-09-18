/** Launcher-owned staged package operations, separate from live activation and receipts. */
import { lstatSync, mkdirSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type {} from '@deepseek-ai/cordis'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

import type { ProfilePreparedPackageChange, ProfileVerifiedReleaseSource } from './types.ts'
export type { ProfilePreparedPackageChange, ProfileVerifiedReleaseSource } from './types.ts'

/** Structured source identity; a verified source never silently degrades to a package string. */
export type ProfilePackageSource = ProfileVerifiedReleaseSource
  | { readonly schemaVersion: 1; readonly type: 'npmRegistry'; readonly spec: string }
  | { readonly schemaVersion: 1; readonly type: 'packageSpec'; readonly spec: string }

/** Explicit package mutation; omitted enablement retains existing bundle selection. */
export type ProfilePackageMutation =
  | { readonly kind: 'install'; readonly source: ProfilePackageSource; readonly enabled?: boolean; readonly approvedBuilds?: readonly string[] }
  | { readonly kind: 'remove'; readonly name: string }

/** Settled bootstrap observation supplied to a launcher before it releases API admission. */
export interface ProfilePackageHealth {
  readonly name: string
  readonly version?: string
  readonly enabled: boolean
  readonly healthy: boolean
}

/** The launcher owns the stage lease and backend lifetime; no method stops its calling Host. */
export interface ProfilePackageTransactions {
  readonly protocolVersion: 1
  /**
   * Prepare a durable graph without activating it. A Host-facing provider acknowledges cancellation
   * with ProfilePackageCancelledError only after cleanup; an aborted signal alone is not success.
   * @param requestId - Request identity, also used as the durable transaction id.
   * @param request - Package mutation to prepare under the launcher's lease.
   * @param signal - Cancellation request; cleanup must settle before cancellation is acknowledged.
   * @returns Prepared graph identity, not an active receipt or runtime health observation.
   */
  stage(requestId: string, request: ProfilePackageMutation, signal: AbortSignal): Promise<ProfilePreparedPackageChange>
  /**
   * Read a transaction's pending preparation state without inspecting active package health.
   * @param transactionId - Durable transaction identity returned by staging.
   * @returns Prepared record, or undefined when no pending stage remains.
   */
  status(transactionId: string): Promise<ProfilePreparedPackageChange | undefined>
  /**
   * List pending preparations owned by the launcher's fixed profile.
   * @returns Prepared records, without implying that any graph is active.
   */
  listPending(): Promise<readonly ProfilePreparedPackageChange[]>
  /**
   * Cancel or discard a preparation through its owner without removing an active plugin.
   * @param transactionId - Durable transaction identity to cancel.
   * @returns Settles after the owner's cancellation cleanup has completed.
   */
  cancel(transactionId: string): Promise<void>
}

/**
 * Validate a transaction identity before addressing its staged directory.
 * @param value - Caller-supplied operation identity.
 * @returns Valid lowercase UUID.
 */
export function parseProfileTransactionId(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(value)) {
    throw new Error('profile packages: invalid transaction id')
  }
  return value
}

/**
 * Validate the backend's prepared record without treating it as active package state.
 * @param value - Untrusted backend result.
 * @returns Validated scalar prepared record.
 */
export function parseProfilePreparedChange(value: unknown): ProfilePreparedPackageChange {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('profile packages: invalid prepared result')
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 5 || input.state !== 'prepared'
    || typeof input.packageName !== 'string' || !/^(?:@[a-z0-9._~-]+\/)?[a-z0-9][a-z0-9._~-]*$/u.test(input.packageName)
    || typeof input.baseFingerprint !== 'string' || !/^[a-f0-9]{64}$/u.test(input.baseFingerprint)
    || (input.health !== 'pending' && input.health !== 'passed')) throw new Error('profile packages: invalid prepared result')
  return { transactionId: parseProfileTransactionId(input.transactionId), state: 'prepared', packageName: input.packageName,
    baseFingerprint: input.baseFingerprint, health: input.health }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Optional launcher-owned backend required by profiles that forbid in-place package mutation. */
    profilePackageTransactions: ProfilePackageTransactions
  }
}

/**
 * Select one canonical sibling lock target that survives profile directory replacement.
 * @param profile - Application-owned profile directory; directory links are not activation targets.
 * @returns Target passed to withFileLock, which owns its .lock companion.
 */
export function profilePackageLeaseTarget(profile: string): string {
  const absolute = resolve(profile)
  const current = lstatSync(absolute, { throwIfNoEntry: false })
  if (current !== undefined && (!current.isDirectory() || current.isSymbolicLink())) {
    throw new Error('profile packages: activation target must be a real directory')
  }
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 })
  const canonical = current === undefined ? join(realpathSync(dirname(absolute)), basename(absolute)) : realpathSync(absolute)
  const name = process.platform === 'win32' ? basename(canonical).toLowerCase() : basename(canonical)
  return join(dirname(canonical), `.${name}.packages`)
}

/**
 * Serialize one launcher or manager write, acquiring the filesystem lease before HMR.
 * @param profile - Canonical profile activation target.
 * @param operation - Work that must not reacquire this lease, even through IPC.
 * @param waitMs - Bounded lease contention wait.
 * @param signal - Checked before waiting and before mutation; contention itself remains bounded by waitMs.
 * @returns Operation result after lease release.
 */
export function withProfilePackageLease<T>(profile: string, operation: () => Promise<T>, waitMs = 120000, signal?: AbortSignal): Promise<T> {
  signal?.throwIfAborted()
  return withFileLock(profilePackageLeaseTarget(profile), () => {
    signal?.throwIfAborted()
    return operation()
  }, { waitMs })
}
