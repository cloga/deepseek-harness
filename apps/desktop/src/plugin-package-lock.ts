/** Profile-owned source snapshots, distinct from verified GitHub Release attestations. */

import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { valid } from 'semver'

/** Source resolution retained independently of the package's declared version. */
export interface DesktopPackageInstallLock {
  readonly packageName: string
  readonly version: string
  readonly spec: string
  readonly resolved: string
  readonly commit?: string
  readonly sha256: string
  readonly integrity: string
}

/** One exact installation snapshot for each source-installed package name. */
export type DesktopPackageInstallLocks = Readonly<Record<string, DesktopPackageInstallLock>>

const LOCK_FILE = 'desktop-plugin-package-locks.json'
const ARTIFACT_DIRECTORY = '.desktop-plugin-artifacts'
const NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const SHA256 = /^[a-f0-9]{64}$/u
const COMMIT = /^[a-f0-9]{40}$/u

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function validateLock(value: unknown, name: string): DesktopPackageInstallLock {
  if (!record(value) || !NAME.test(name) || value.packageName !== name
    || typeof value.version !== 'string' || valid(value.version) !== value.version
    || typeof value.spec !== 'string' || value.spec.trim() === '' || /[\u0000-\u001f\u007f]/u.test(value.spec)
    || typeof value.resolved !== 'string' || value.resolved === '' || /[\u0000-\u001f\u007f]/u.test(value.resolved)
    || typeof value.sha256 !== 'string' || !SHA256.test(value.sha256)
    || typeof value.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/u.test(value.integrity)
    || (value.commit !== undefined && (typeof value.commit !== 'string' || !COMMIT.test(value.commit)))
    || Object.keys(value).some(key => !['packageName', 'version', 'spec', 'resolved', 'commit', 'sha256', 'integrity'].includes(key))) {
    throw new Error(`desktop plugin package: invalid source lock for ${name}`)
  }
  const digest = Buffer.from(value.integrity.slice('sha512-'.length), 'base64')
  if (digest.byteLength !== 64 || `sha512-${digest.toString('base64')}` !== value.integrity) {
    throw new Error(`desktop plugin package: invalid integrity for ${name}`)
  }
  return {
    packageName: name,
    version: value.version,
    spec: value.spec,
    resolved: value.resolved,
    ...(value.commit === undefined ? {} : { commit: value.commit }),
    sha256: value.sha256,
    integrity: value.integrity,
  }
}

/**
 * Read validated snapshot metadata without executing any installed package.
 * @param profile - Desktop profile or private staging profile directory.
 * @returns Source locks keyed by the real package name.
 */
export function readDesktopPackageLocks(profile: string): DesktopPackageInstallLocks {
  const path = join(profile, LOCK_FILE)
  if (!existsSync(path)) return Object.create(null) as DesktopPackageInstallLocks
  const stat = lstatSync(path)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('desktop plugin package: source lock store must be a regular file')
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'))
  if (!record(value) || value.schemaVersion !== 1 || !record(value.packages)
    || Object.keys(value).some(key => key !== 'schemaVersion' && key !== 'packages')) {
    throw new Error('desktop plugin package: invalid source lock store')
  }
  return Object.assign(Object.create(null) as Record<string, DesktopPackageInstallLock>,
    Object.fromEntries(Object.entries(value.packages).map(([name, entry]) => [name, validateLock(entry, name)])))
}

/**
 * Write snapshot metadata only inside the caller's private transaction.
 * @param profile - Private staging profile, never a live profile.
 * @param locks - Exact snapshots remaining after this mutation.
 */
export function writeDesktopPackageLocks(profile: string, locks: DesktopPackageInstallLocks): void {
  const packages = Object.fromEntries(Object.entries(locks).map(([name, entry]) => [name, validateLock(entry, name)]))
  writeFileSync(join(profile, LOCK_FILE), `${JSON.stringify({ schemaVersion: 1, packages }, undefined, 2)}\n`, { mode: 0o600 })
}

/**
 * Derive a relocation-safe dependency specifier from one validated snapshot.
 * @param lock - Exact source snapshot identity.
 * @returns Profile-relative tarball dependency specifier.
 */
export function desktopPackageArtifactSpecifier(lock: DesktopPackageInstallLock): string {
  validateLock(lock, lock.packageName)
  return `file:${ARTIFACT_DIRECTORY}/${lock.sha256}.tgz`
}

/**
 * Verify profile-owned bytes before the package manager can reinstall a snapshot.
 * @param profile - Active or staging profile containing the artifact.
 * @param lock - Previously validated source lock.
 */
export function verifyDesktopPackageArtifact(profile: string, lock: DesktopPackageInstallLock): void {
  validateLock(lock, lock.packageName)
  const directory = join(profile, ARTIFACT_DIRECTORY)
  const path = join(directory, `${lock.sha256}.tgz`)
  if (!existsSync(directory) || lstatSync(directory).isSymbolicLink()
    || !existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) {
    throw new Error(`desktop plugin package: missing regular snapshot for ${lock.packageName}`)
  }
  const bytes = readFileSync(path)
  if (createHash('sha256').update(bytes).digest('hex') !== lock.sha256
    || `sha512-${createHash('sha512').update(bytes).digest('base64')}` !== lock.integrity) {
    throw new Error(`desktop plugin package: snapshot integrity mismatch for ${lock.packageName}`)
  }
}
