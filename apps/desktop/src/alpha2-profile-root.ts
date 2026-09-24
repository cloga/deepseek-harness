/** Prepare the official Desktop profile root ONLY inside one launcher-owned private candidate. */
import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { prepareProfileRootConfig } from '@deepseek-ai/dsh-app-boot'

const LEGACY_ROOT = '# Electron desktop composition root; package transactions own this file.\n[]\n'
const TRANSACTION = /^\.desktop-transaction-[a-zA-Z0-9_-]{6,64}$/u
const MAX_ROOT_BYTES = 64 * 1024

function realDirectory(path: string): string {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined || !stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('desktop alpha2: profile candidate must be a real directory')
  }
  return realpathSync.native(path)
}

/**
 * Seal the exact upstream `cordis.yml` in a private sibling stage, never in the
 * active profile. The old framed Host's `desktop.cordis.yml` can only be an
 * empty root; all user choices remain in the copied package manifest, receipts,
 * and `cordis.patch.yml` instead of being replaced or silently reinterpreted.
 *
 * @param activeProfile - Fixed active profile location (may not yet exist on fresh install).
 * @param transaction - Shell-owned `.desktop-transaction-*` sibling; `staging` already contains the copied profile.
 * @returns Canonical private candidate path the Shell may later health-check under its transaction lease.
 */
export function prepareAlpha2ProfileRoot(activeProfile: string, transaction: string): string {
  const active = resolve(activeProfile)
  const parent = realDirectory(dirname(active))
  const activeStat = lstatSync(active, { throwIfNoEntry: false })
  if (activeStat !== undefined && (!activeStat.isDirectory() || activeStat.isSymbolicLink())) {
    throw new Error('desktop alpha2: active profile is not a real directory')
  }
  const activeRoot = activeStat === undefined ? join(parent, basename(active)) : realpathSync.native(active)
  const sibling = realDirectory(resolve(transaction))
  if (dirname(sibling) !== parent || !TRANSACTION.test(basename(sibling)) || sibling === activeRoot) {
    throw new Error('desktop alpha2: staging owner is not a private profile sibling')
  }
  const staging = realDirectory(join(sibling, 'staging'))
  const legacy = join(staging, 'desktop.cordis.yml')
  const old = lstatSync(legacy, { throwIfNoEntry: false })
  if (old !== undefined) {
    if (!old.isFile() || old.isSymbolicLink() || old.size > MAX_ROOT_BYTES) {
      throw new Error('desktop alpha2: legacy profile root is not an owned file')
    }
    const contents = readFileSync(legacy, 'utf8')
    if (contents !== LEGACY_ROOT) {
      const meaningful = contents.replace(/^\uFEFF/u, '').split(/\r?\n/u).map(line => line.trim())
        .filter(line => line !== '' && !line.startsWith('#')).join('\n')
      if (meaningful !== '[]') throw new Error('desktop alpha2: non-empty legacy root needs explicit migration')
    }
  }
  // Official helper refuses a non-empty or linked canonical root; this is the
  // ONLY write, and the Shell must never pass its active profile as `staging`.
  prepareProfileRootConfig(staging)
  return staging
}
