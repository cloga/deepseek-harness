/** Canonical Desktop package-root guard before any application-owned profile row mounts. */
import { lstatSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

function inside(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))
}

/** Refuse aliases in the claimed root or any ancestor, not just escaped child packages. */
function ownedRoot(path: string): string {
  let current = resolve(path)
  for (;;) {
    const stat = lstatSync(current)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('redirected owner')
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return realpathSync(path)
}

/**
 * Reject bundles escaping both the installed runtime and user-owned profile.
 * This is a pre-boot ownership boundary, NOT package-byte, receipt, or native source attestation.
 */
export function assertAlpha2ProfileOwnership(
  runtimeDir: string,
  projectDir: string,
  layers: readonly { readonly packageDir: string }[],
): void {
  let runtimeRoot: string
  let profileRoot: string
  try {
    runtimeRoot = ownedRoot(runtimeDir)
    profileRoot = ownedRoot(projectDir)
  } catch {
    throw new Error('desktop alpha2: owned package roots are unavailable or redirected')
  }
  for (const layer of layers) {
    let actual: string
    try { actual = realpathSync(layer.packageDir) }
    catch { throw new Error('desktop alpha2: profile bundle is unavailable') }
    if (!inside(runtimeRoot, actual) && !inside(profileRoot, actual)) {
      throw new Error('desktop alpha2: profile bundle resolved outside its owned roots')
    }
  }
}
