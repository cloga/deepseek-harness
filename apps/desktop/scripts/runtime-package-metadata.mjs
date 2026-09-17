/** Apply the pinned packager's metadata cleanup before recording immutable runtime bytes. */
import { lstatSync, readdirSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, relative, resolve, sep } from 'node:path'

const require = createRequire(import.meta.url)

/** Explicit defaults shared by runtime preparation and electron-builder. */
export const DESKTOP_PACKAGE_METADATA_OPTIONS = Object.freeze({
  removePackageScripts: true,
  removePackageKeywords: true,
})

/**
 * Normalize an exclusively owned, unsealed production copy with the same transformer used by ASAR packaging.
 * @param {string} runtimeRoot - Prepared runtime copy, never a live profile or workspace dependency directory.
 * @param {string} shellAppDir - Electron shell directory; its package.json is the transformer's main manifest.
 * @returns {Promise<readonly string[]>} Changed package.json paths relative to the prepared runtime.
 */
export async function normalizeDesktopRuntimePackageMetadata(runtimeRoot, shellAppDir) {
  const root = resolve(runtimeRoot)
  const shell = resolve(shellAppDir)
  if (root === shell) throw new Error('desktop runtime: metadata normalization requires a separate prepared runtime')
  const stat = lstatSync(root)
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('desktop runtime: metadata normalization requires an unlinked runtime directory')
  }
  if (lstatSync(join(root, 'desktop-runtime.json'), { throwIfNoEntry: false }) !== undefined) {
    throw new Error('desktop runtime: package metadata normalization must precede runtime sealing')
  }
  // This runtime-exported internal API has no declaration export; its exact dependency version is reviewed and pinned.
  const version = require('app-builder-lib/package.json').version
  const { createTransformer } = require('app-builder-lib/out/fileTransformer.js')
  if (version !== '26.15.3' || typeof createTransformer !== 'function') {
    throw new Error('desktop runtime: package metadata normalization requires reviewed app-builder-lib 26.15.3')
  }
  const transform = createTransformer(shell, DESKTOP_PACKAGE_METADATA_OPTIONS, undefined, null)
  const candidates = []
  /** @param {string} directory - Directory inside the owned runtime copy. */
  const visit = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isSymbolicLink()) throw new Error('desktop runtime: metadata normalization rejects filesystem links')
      if (entry.isDirectory()) visit(path)
      else if (!entry.isFile()) throw new Error('desktop runtime: metadata normalization requires regular files')
      else if (entry.name === 'package.json') candidates.push(path)
    }
  }
  visit(root)
  const changed = []
  for (const path of candidates.sort()) {
    const transformed = await transform(path)
    if (transformed === null || transformed === undefined) continue
    if (typeof transformed !== 'string') throw new Error('desktop runtime: unexpected package metadata transform result')
    writeFileSync(path, transformed)
    changed.push(relative(root, path).split(sep).join('/'))
  }
  return changed
}
