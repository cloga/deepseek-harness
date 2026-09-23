/** One canonical launcher-owned empty root; user composition belongs in profile patch layers. */
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Root config filename inside a profile directory. */
export const PROFILE_ROOT_FILENAME = 'cordis.yml'

/** Exact root document used by the official profile launcher. */
export const PROFILE_ROOT_CONFIG = `# dsh profile root — an empty entry list. The tree is composed as patches:
# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any
# --patch overlays. Edit cordis.patch.yml, not this file.
[]
`

/**
 * Refresh the derived root at ordinary boot, preserving the launcher's existing write-back repair contract.
 * @param profileDir - Initialized profile; the caller owns startup and mutation serialization.
 */
export function writeProfileRootConfig(profileDir: string): void {
  writeFileSync(join(profileDir, PROFILE_ROOT_FILENAME), PROFILE_ROOT_CONFIG)
}

/**
 * Seal the same root before private staging; do not silently replace a non-empty unknown composition.
 * Canonical bytes, absence, and an empty list with only whitespace/comments are the supported inputs.
 * @param profileDir - Private candidate directory, never a live profile.
 */
export function prepareProfileRootConfig(profileDir: string): void {
  const path = join(profileDir, PROFILE_ROOT_FILENAME)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat !== undefined) {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new Error('profile root: unsupported root file')
    const current = readFileSync(path, 'utf8')
    if (current === PROFILE_ROOT_CONFIG) return
    const value = current.replace(/^\uFEFF/u, '').split(/\r?\n/u).map(line => line.trim())
      .filter(line => line !== '' && !line.startsWith('#')).join('\n')
    if (value !== '[]') throw new Error('profile root: non-empty root requires explicit migration; user patch is unchanged')
  }
  writeProfileRootConfig(profileDir)
}

/**
 * Read-only boot check for a launcher-staged application profile. The private
 * native owner must prepare the candidate; Host startup must not repair a live
 * profile before the stage handshake or user consent.
 */
export function assertPreparedProfileRootConfig(profileDir: string): void {
  const path = join(profileDir, PROFILE_ROOT_FILENAME)
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()
      || stat.size !== Buffer.byteLength(PROFILE_ROOT_CONFIG) || readFileSync(path, 'utf8') !== PROFILE_ROOT_CONFIG) {
      throw new Error('noncanonical')
    }
  } catch {
    throw new Error('profile root: staged application requires an already sealed canonical root')
  }
}
