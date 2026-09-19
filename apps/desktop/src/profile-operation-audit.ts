/** Bounded private receipts for serialized Desktop profile transactions, outside the profile. */

import { randomUUID } from 'node:crypto'
import {
  chmodSync, closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync,
  readdirSync, realpathSync, unlinkSync, writeSync,
} from 'node:fs'
import { join } from 'node:path'

/** Caller-validated package names and inventory digest; no package sources or configuration. */
export interface DesktopProfileInventoryEvidence {
  readonly sha256: string
  readonly names: readonly string[]
}

/** One transaction phase observation, containing only non-secret inventory evidence. */
export interface DesktopProfileOperationRecord {
  readonly transaction: string
  readonly operation: 'plugin-add' | 'plugin-install' | 'plugin-remove' | 'plugin-update' | 'plugin-toggle'
    | 'plugins-reconcile' | 'runtime-reconcile' | 'plugins-disable-all' | 'reset' | 'recovery'
  readonly target?: string
  readonly phase: 'preparation' | 'activation' | 'rollback' | 'recovery' | 'reset'
  readonly outcome: 'started' | 'committed' | 'failed' | 'recovered'
  readonly before: DesktopProfileInventoryEvidence | null
  readonly after: DesktopProfileInventoryEvidence | null
}

const MAX_GROUPS = 64
const MAX_RECORD_BYTES = 128 * 1024
const OWNED_NAME = /^([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(pending|json)$/u

function privateDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('desktop profile audit: expected an owned directory, not a link')
  }
  if (process.platform !== 'win32') {
    if (stat.uid !== process.getuid?.()) throw new Error('desktop profile audit: directory has another owner')
    if ((stat.mode & 0o7777) !== 0o700) chmodSync(path, 0o700)
  }
}

function inventory(value: DesktopProfileInventoryEvidence | null): DesktopProfileInventoryEvidence | null {
  return value === null ? null : { sha256: value.sha256, names: value.names.map(name => name) }
}

interface RecordGroup {
  readonly paths: string[]
  readonly device: number
  readonly inode: number
  readonly links: number
  readonly modified: number
}

function makeRoom(directory: string): void {
  const groups = new Map<string, RecordGroup>()
  for (const name of readdirSync(directory).sort()) {
    const match = OWNED_NAME.exec(name)
    if (match === null) continue
    const path = join(directory, name)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECORD_BYTES) {
      throw new Error('desktop profile audit: unsafe retained record')
    }
    if (process.platform !== 'win32' && (stat.uid !== process.getuid?.() || (stat.mode & 0o7777) !== 0o600)) {
      throw new Error('desktop profile audit: retained record is not private')
    }
    const stem = name.slice(0, name.lastIndexOf('.'))
    const group = groups.get(stem)
    if (group === undefined) {
      groups.set(stem, { paths: [path], device: stat.dev, inode: stat.ino, links: stat.nlink, modified: stat.mtimeMs })
    } else {
      if (stat.dev !== group.device || stat.ino !== group.inode || stat.nlink !== group.links) {
        throw new Error('desktop profile audit: retained receipt does not share its pending inode')
      }
      group.paths.push(path)
    }
  }
  const ordered = Array.from(groups.values()).sort((a, b) => a.modified - b.modified)
  // Validate every owned entry before deleting any; unknown filenames are never touched.
  for (const group of ordered) {
    if (group.links !== group.paths.length) throw new Error('desktop profile audit: retained record has unrelated hardlinks')
  }
  for (const group of ordered.slice(0, Math.max(0, ordered.length - MAX_GROUPS + 1))) {
    // Sorted names remove .json first: a failed second unlink leaves a counted pending-only group.
    for (const path of group.paths) unlinkSync(path)
  }
}

/**
 * Publish a private, exclusive receipt after prepublication retention cleanup and file synchronization.
 * Retains at most 64 UUID groups (including failed pending-only writes), each at most 128 KiB.
 * The pending hardlink remains as evidence; directory durability after power loss is not promised.
 * Callers serialize access and supply an existing Desktop-owned root outside the active profile.
 * POSIX directories are restricted to 0700; Windows privacy also requires the owner's private ACL.
 * @param desktopRoot - Existing, unlinked Desktop directory, never the active profile directory.
 * @param record - Validated names, hashes and transaction metadata; extra fields are not serialized.
 * @returns The published absolute receipt path; any cleanup, write, sync, close or link failure throws.
 */
export function recordDesktopProfileOperation(desktopRoot: string, record: DesktopProfileOperationRecord): string {
  const bytes = Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    recordedAt: new Date().toISOString(),
    transaction: record.transaction,
    operation: record.operation,
    target: record.target,
    phase: record.phase,
    outcome: record.outcome,
    before: inventory(record.before),
    after: inventory(record.after),
  })}\n`)
  if (bytes.byteLength > MAX_RECORD_BYTES) throw new Error('desktop profile audit: record exceeds 128 KiB')

  privateDirectory(desktopRoot)
  const directory = join(realpathSync.native(desktopRoot), 'profile-operations')
  const existing = lstatSync(directory, { throwIfNoEntry: false })
  if (existing === undefined) mkdirSync(directory, { mode: 0o700 })
  privateDirectory(directory)
  makeRoom(directory)

  const stem = randomUUID()
  const pending = join(directory, `${stem}.pending`)
  const receipt = join(directory, `${stem}.json`)
  const descriptor = openSync(pending, 'wx', 0o600)
  try {
    let offset = 0
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null)
      if (written === 0) throw new Error('desktop profile audit: evidence write made no progress')
      offset += written
    }
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  // No fallible work follows successful exclusive publication, including pending cleanup.
  linkSync(pending, receipt)
  return receipt
}
