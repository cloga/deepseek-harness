/** Filesystem ownership for the Electron-managed desktop installation. */

import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'

/** Stable desktop installation paths under the shared Harness home. */
export interface DesktopPaths {
  /** Retained alpha1 journal location, resolved from the same explicit home as profile. */
  readonly legacyStateRoot: string
  readonly profile: string
  readonly lock: string
}

/**
 * Resolve every Electron-owned path without changing the shared data roots.
 * @param dshHome - Harness home shared with npm-installed dsh.
 * @returns immutable desktop path set.
 */
export function resolveDesktopPaths(dshHome: string = resolveDshHome()): DesktopPaths {
  return {
    legacyStateRoot: join(dshHome, 'desktop'),
    profile: join(dshHome, 'profiles', 'desktop'),
    lock: join(dshHome, 'profiles', 'desktop', 'lock'),
  }
}
