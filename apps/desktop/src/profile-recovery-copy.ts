/** Verified configuration and artifact copies retained before destructive profile recovery. */

import { createHash, randomUUID } from 'node:crypto'
import {
  closeSync, cpSync, fsyncSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, realpathSync, writeSync,
} from 'node:fs'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'

interface RecoveryEntry {
  readonly path: string
  readonly kind: 'directory' | 'file'
  readonly size?: number
  readonly sha256?: string
}

/** A completed, private copy; generated node_modules directories are not retained. */
export interface DesktopProfileRecoveryCopy {
  readonly directory: string
}

function inside(parent: string, child: string): boolean {
  const path = relative(parent, child)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

function requireDirectory(path: string): void {
  const entry = lstatSync(path)
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error('desktop profile recovery: expected an owned directory, not a link')
  }
}

function entries(root: string): readonly RecoveryEntry[] {
  const result: RecoveryEntry[] = []
  const visit = (directory: string, prefix: string): void => {
    for (const name of readdirSync(directory).sort()) {
      if (name === 'node_modules') continue
      const path = join(directory, name)
      const key = prefix === '' ? name : `${prefix}/${name}`
      const entry = lstatSync(path)
      if (entry.isSymbolicLink()) {
        throw new Error('desktop profile recovery: linked configuration requires manual recovery; original profile retained')
      }
      if (entry.isDirectory()) {
        result.push({ path: key, kind: 'directory' })
        visit(path, key)
      } else if (entry.isFile()) {
        const bytes = readFileSync(path)
        result.push({ path: key, kind: 'file', size: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex') })
      } else {
        throw new Error('desktop profile recovery: unsupported configuration entry; original profile retained')
      }
    }
  }
  visit(root, '')
  return result
}

function syncPayload(root: string, inventory: readonly RecoveryEntry[]): void {
  for (const entry of inventory) {
    if (entry.kind !== 'file') continue
    const descriptor = openSync(join(root, ...entry.path.split('/')), 'r+')
    try { fsyncSync(descriptor) } finally { closeSync(descriptor) }
  }
}

function writeEvidence(path: string, value: unknown): void {
  const temporary = `${path}.${randomUUID()}.pending`
  const descriptor = openSync(temporary, 'wx', 0o600)
  try {
    const bytes = Buffer.from(`${JSON.stringify(value, undefined, 2)}\n`)
    let offset = 0
    while (offset < bytes.byteLength) {
      const written = writeSync(descriptor, bytes, offset, bytes.byteLength - offset, null)
      if (written === 0) throw new Error('desktop profile recovery: evidence write made no progress')
      offset += written
    }
    fsyncSync(descriptor)
  } finally {
    closeSync(descriptor)
  }
  // Publishing cannot replace an earlier marker. The synchronized temporary inode is retained.
  linkSync(temporary, path)
}

/**
 * Preserve regular configuration files and artifacts before reset; linked entries refuse reset.
 * File data is synchronized; directory durability after power loss is not guaranteed.
 * The caller supplies a private root; Windows copies inherit its ACLs.
 * @param profile - Existing, stopped profile protected by the manager's transaction lock.
 * @param desktopRoot - Existing private Desktop-owned directory outside the profile.
 * @returns A verified copy whose receipt is written only after copy and source checks pass.
 */
export function createDesktopProfileRecoveryCopy(profile: string, desktopRoot: string): DesktopProfileRecoveryCopy {
  requireDirectory(profile)
  requireDirectory(desktopRoot)
  const source = realpathSync.native(profile)
  const root = realpathSync.native(desktopRoot)
  if (inside(source, root)) throw new Error('desktop profile recovery: copies must be outside the active profile')
  const parent = join(root, 'profile-recovery')
  if (inside(source, parent)) throw new Error('desktop profile recovery: copies must be outside the active profile')
  const before = entries(source)
  try {
    requireDirectory(parent)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    mkdirSync(parent, { mode: 0o700 })
  }
  const directory = mkdtempSync(join(parent, 'reset-'))
  const target = join(directory, 'profile')
  cpSync(source, target, {
    recursive: true,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    filter: path => basename(path) !== 'node_modules',
  })
  if (JSON.stringify(entries(target)) !== JSON.stringify(before)) {
    throw new Error('desktop profile recovery: copy verification failed; original profile retained')
  }
  syncPayload(target, before)
  if (JSON.stringify(entries(target)) !== JSON.stringify(before)) {
    throw new Error('desktop profile recovery: copy changed while synchronizing; reset refused')
  }
  if (JSON.stringify(entries(source)) !== JSON.stringify(before)) {
    throw new Error('desktop profile recovery: profile changed while copying; reset refused')
  }
  writeEvidence(join(directory, 'receipt.json'), {
    schemaVersion: 1,
    operation: 'reset',
    createdAt: new Date().toISOString(),
    state: 'copy-complete',
    durability: 'file-data-synced',
    excludedDirectory: 'node_modules',
    entries: before,
  })
  return { directory: resolve(directory) }
}

/**
 * Record the reset result separately from the immutable copy receipt.
 * @param copy - Recovery copy returned before destructive work begins.
 * @param outcome - Whether the reset and its final Host readiness completed.
 */
export function recordDesktopProfileRecoveryOutcome(
  copy: DesktopProfileRecoveryCopy,
  outcome: 'completed' | 'failed',
): void {
  writeEvidence(join(copy.directory, 'outcome.json'), {
    schemaVersion: 1, operation: 'reset', outcome, recordedAt: new Date().toISOString(),
  })
}
