/** Bounded, link-free private copy of active profile metadata for a Shell-owned candidate. */
import { createHash } from 'node:crypto'
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync,
} from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { removeOwnedDirectory } from './owned-directory.ts'

const MAX_FILES = 100_000
const MAX_BYTES = 512 * 1024 * 1024
const MAX_DEPTH = 64
const TRANSACTION = /^\.desktop-transaction-[a-f0-9]{32}$/u

type Entry = { readonly path: string; readonly kind: 'directory' }
  | { readonly path: string; readonly kind: 'file'; readonly size: number; readonly sha256: string }

function inside(root: string, path: string): boolean {
  const rel = relative(root, path)
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)
}

function ownedDirectory(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('desktop packages: profile metadata must have real owned directories')
  }
  return realpathSync.native(path)
}

/** Snapshot only profile metadata; NOT a full activation fingerprint of home patches, package graph or runtime. */
export function profileMetadataFingerprint(profile: string, signal?: AbortSignal): { sha256: string; entries: readonly Entry[] } {
  const root = ownedDirectory(resolve(profile))
  const entries: Entry[] = []
  let total = 0
  const walk = (directory: string, depth: number): void => {
    if (depth > MAX_DEPTH) throw new Error('desktop packages: profile metadata depth exceeds its bound')
    for (const name of readdirSync(directory).sort()) {
      signal?.throwIfAborted()
      if (directory === root && name === 'node_modules') continue
      if (name === '.' || name === '..' || /[\\/:\u0000-\u001f\u007f]/u.test(name)) {
        throw new Error('desktop packages: unsupported profile metadata name')
      }
      const path = join(directory, name)
      const key = relative(root, path).split(sep).join('/')
      const stat = lstatSync(path)
      if (entries.length >= MAX_FILES) throw new Error('desktop packages: profile metadata entry limit exceeded')
      if (stat.isSymbolicLink()) throw new Error('desktop packages: linked profile metadata requires explicit migration')
      if (stat.isDirectory()) {
        entries.push({ path: key, kind: 'directory' })
        walk(path, depth + 1)
      } else if (stat.isFile()) {
        total += stat.size
        if (total > MAX_BYTES) throw new Error('desktop packages: profile metadata byte limit exceeded')
        entries.push({ path: key, kind: 'file', size: stat.size,
          sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })
      } else throw new Error('desktop packages: unsupported profile metadata entry')
    }
  }
  walk(root, 0)
  return { sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), entries }
}

/**
 * Copy only the captured files into a fresh `.desktop-transaction-<UUID hex>/staging` sibling.
 * No file of the active profile is changed or linked to a candidate; `node_modules`
 * is deliberately omitted and must later be materialized/verified privately.
 */
export function snapshotDesktopProfileMetadata(active: string, transaction: string, signal?: AbortSignal): {
  readonly staging: string
  readonly baseMetadataSha256: string
} {
  const source = ownedDirectory(resolve(active))
  const owner = ownedDirectory(resolve(transaction))
  if (dirname(owner) !== dirname(source) || !TRANSACTION.test(basename(owner)) || existsSync(join(owner, 'staging'))) {
    throw new Error('desktop packages: staging must be a fresh owned profile sibling')
  }
  const staging = join(owner, 'staging')
  const baseline = profileMetadataFingerprint(source, signal)
  let created = false
  try {
    mkdirSync(staging, { mode: 0o700 })
    created = true
    for (const entry of baseline.entries) {
      signal?.throwIfAborted()
      const target = join(staging, ...entry.path.split('/'))
      if (!inside(staging, target)) throw new Error('desktop packages: staging path escapes owned candidate')
      if (entry.kind === 'directory') { mkdirSync(target, { mode: 0o700 }); continue }
      const original = join(source, ...entry.path.split('/'))
      const current = lstatSync(original)
      if (!current.isFile() || current.isSymbolicLink() || current.size !== entry.size
        || !inside(source, realpathSync.native(original))) {
        throw new Error('desktop packages: active metadata target changed before private copy')
      }
      copyFileSync(original, target)
      const written = lstatSync(target)
      if (!written.isFile() || written.isSymbolicLink() || written.size !== entry.size
        || createHash('sha256').update(readFileSync(target)).digest('hex') !== entry.sha256) {
        throw new Error('desktop packages: copied metadata differs from active source')
      }
    }
    if (profileMetadataFingerprint(source, signal).sha256 !== baseline.sha256
      || profileMetadataFingerprint(staging, signal).sha256 !== baseline.sha256) {
      throw new Error('desktop packages: active profile changed during private copy')
    }
    return { staging, baseMetadataSha256: baseline.sha256 }
  } catch (error) {
    if (created) {
      try { removeOwnedDirectory(staging) }
      catch (cleanupError) { throw new AggregateError([error, cleanupError], 'desktop packages: candidate copy and cleanup failed') }
    }
    throw error
  }
}
