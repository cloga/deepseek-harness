/** Launcher checks for bounded configuration inputs and real post-boot bundle inventory. */
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches, loadProfileDirectory, type ProfilePackageHealth } from '@deepseek-ai/dsh-app-boot'
import type { DesktopPreparedPackageActivation } from './profile-package-staging.ts'

function inside(root: string, path: string): boolean {
  const remainder = relative(root, path)
  return remainder === '' || (!isAbsolute(remainder) && remainder !== '..' && !remainder.startsWith(`..${sep}`))
}

/**
 * Read the exact selected bundle versions and refuse untracked Loader code/configuration paths.
 * Backend byte/integrity and freshness verification must run under the same lease before this check.
 * @param input - Backend-owned activation identity and complete external patch input roster.
 * @param root - Candidate, active, or restored profile directory selected by the shell, never a remote caller.
 * @returns Expected ordered bundle inventory; this never loads package code.
 */
export function qualifyDesktopPackageProfile(
  input: DesktopPreparedPackageActivation, root: string,
): readonly { name: string; version: string }[] {
  const profileRoot = realpathSync(root)
  const runtimeRoot = realpathSync(input.owner.runtimeDir)
  const allowed = (path: string): boolean => {
    if (!inside(profileRoot, path) && !inside(runtimeRoot, path)) return false
    const canonical = realpathSync(path)
    return inside(profileRoot, canonical) || inside(runtimeRoot, canonical)
  }
  const profile = loadProfileDirectory('desktop package activation', profileRoot, input.owner.installAnchor)
  const layers = profile.layers.map((layer) => {
    if (!allowed(layer.packageDir) || !allowed(layer.patchPath)) throw new Error('desktop package activation: bundle configuration escapes the sealed graph')
    return layer.patches
  })
  layers.push(profile.patches)
  for (const file of input.owner.configPaths) {
    if (existsSync(file)) layers.push(loadOverlayPatches('desktop package activation', file))
  }
  const visit = (entries: ReturnType<typeof composeEntries>): void => {
    for (const entry of entries) {
      if (typeof entry.name !== 'string') throw new Error('desktop package activation: dynamic module names are not qualified')
      if (entry.name === 'cordis:include' || entry.name === '@deepseek-ai/cordis-plugin-include'
        || entry.name.startsWith('@deepseek-ai/cordis-plugin-include/')) {
        throw new Error('desktop package activation: nested Include dependencies are not qualified for profile replacement')
      }
      if (entry.name.startsWith('file:') && !allowed(fileURLToPath(entry.name))) {
        throw new Error('desktop package activation: module path escapes the sealed graph')
      }
      if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/u.test(entry.name) && !entry.name.startsWith('file:') && entry.name !== 'cordis:group') {
        throw new Error('desktop package activation: untracked module protocol is not qualified')
      }
      if (isAbsolute(entry.name) || entry.name.startsWith('./') || entry.name.startsWith('../')) {
        throw new Error('desktop package activation: module path was not anchored by the profile parser')
      }
      if (entry.group && Array.isArray(entry.config)) visit(entry.config as ReturnType<typeof composeEntries>)
    }
  }
  visit(composeEntries(layers))
  return profile.layers.map((layer) => {
    const manifest = JSON.parse(readFileSync(join(layer.packageDir, 'package.json'), 'utf8')) as { name?: unknown; version?: unknown }
    if (manifest.name !== layer.packageName || typeof manifest.version !== 'string') {
      throw new Error('desktop package activation: selected bundle identity is invalid')
    }
    return { name: layer.packageName, version: manifest.version }
  })
}

/**
 * Check actual settled Loader health without calling the blocked browser API transport.
 * @param expected - Selected bundles from the freshly validated profile.
 * @param observed - Leaf inventory received in this Host generation's readiness message.
 * @param requireHealthy - Newly activated targets; unrelated pre-existing optional failures do not become required startup entries.
 */
export function assertDesktopPackageHealth(
  expected: readonly { name: string; version: string }[], observed: readonly ProfilePackageHealth[] | undefined,
  requireHealthy: readonly string[] = expected.map(item => item.name),
): void {
  if (observed === undefined) throw new Error('desktop package activation: Host did not report bundle health')
  const byName = new Map(observed.map(item => [item.name, item]))
  if (byName.size !== observed.length) throw new Error('desktop package activation: Host reported duplicate bundle identities')
  for (const target of expected) {
    const actual = byName.get(target.name)
    if (actual === undefined || !actual.enabled
      || (requireHealthy.includes(target.name) && !actual.healthy) || actual.version !== target.version) {
      throw new Error(`desktop package activation: Host bundle health does not match ${target.name}@${target.version}`)
    }
  }
  const names = new Set(expected.map(item => item.name))
  if (observed.some(item => item.enabled && !names.has(item.name))) throw new Error('desktop package activation: Host selected unexpected bundles')
}
