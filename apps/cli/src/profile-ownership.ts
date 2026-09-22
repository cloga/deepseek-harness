/** Read-only ownership checks before CLI profile package operations. */
import { lstatSync, realpathSync, statSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, sep } from 'node:path'
import { resolveProfileDir } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Canonicalize existing directories and missing suffixes, but never unresolved links. */
function canonicalDirectory(path: string): string {
  let canonical: string
  try {
    canonical = realpathSync(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // A dangling link is an existing entry, not an ordinary missing directory.
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) throw error
    const parent = dirname(path)
    if (parent === path) throw error
    return join(canonicalDirectory(parent), basename(path))
  }
  if (!statSync(canonical).isDirectory()) throw new Error(`not a directory: ${path}`)
  return canonical
}

/**
 * Resolve a CLI-owned profile without creating directories or following an unresolved link.
 * Desktop's name and canonical directory tree are reserved for Electron. The returned directory
 * pins the checked spelling; this is not a lock against concurrent filesystem replacement.
 * @param profile Profile name.
 * @param home Explicit Harness home; otherwise use the public home resolver.
 * @returns Canonical profile directory, including any genuinely missing suffix.
 * @throws When the target belongs to Desktop or ownership cannot be resolved.
 */
export function resolveCliPluginDirectory(profile: string, home?: string): string {
  const reservedMessage = 'dsh: profile "desktop" is managed exclusively by the Electron application'
  if (profile.toLowerCase() === 'desktop') throw new Error(reservedMessage)
  const resolvedHome = resolveDshHome(home)
  const target = resolveProfileDir(profile, resolvedHome)
  const desktop = resolveProfileDir('desktop', resolvedHome)
  let dir: string
  let desktopDir: string
  try {
    dir = canonicalDirectory(target)
    desktopDir = canonicalDirectory(desktop)
  } catch (error) {
    throw new Error(`dsh: cannot resolve profile ownership for ${JSON.stringify(profile)}; check profile and home directories for dangling or cyclic links`, { cause: error })
  }
  const fromDesktop = relative(desktopDir, dir)
  if (fromDesktop === '' || (fromDesktop !== '..' && !fromDesktop.startsWith(`..${sep}`) && !isAbsolute(fromDesktop))) {
    throw new Error(reservedMessage)
  }
  return dir
}
