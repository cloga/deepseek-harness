/** Read-only refusal of retained alpha1 activation evidence; never an automatic recovery or migration. */
import { lstatSync, opendirSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { DesktopPaths } from './paths.ts'

/** Fixed launcher-owned locations, resolved from the same Harness home; never journal-supplied paths. */
export type DesktopProfileSafetyPaths = Pick<DesktopPaths, 'profile' | 'legacyStateRoot'>

/** Stable fatal admission result, including an unsafe or incomplete legacy inspection. */
export class DesktopLegacyActivationRefusal extends Error {
  constructor(reason: string, options?: ErrorOptions) {
    super(`desktop legacy activation: ${reason}; retain all profile and recovery bytes for manual inspection before retrying`, options)
    this.name = 'DesktopLegacyActivationRefusal'
  }
}

/** Identify only this boundary's refusal, never a message-matching network or runtime error. */
export function isDesktopLegacyActivationRefusal(error: unknown): error is DesktopLegacyActivationRefusal {
  return error instanceof DesktopLegacyActivationRefusal
}

function refuse(reason: string): never {
  throw new DesktopLegacyActivationRefusal(reason)
}

/** Walk from the filesystem root so an intermediate link is rejected before inspecting its children. */
function ordinaryDirectory(path: string): boolean {
  const chain: string[] = []
  for (let current = path; ; current = dirname(current)) {
    chain.push(current)
    if (dirname(current) === current) break
  }
  for (const current of chain.reverse()) {
    const entry = lstatSync(current, { throwIfNoEntry: false })
    if (entry === undefined) return false
    if (!entry.isDirectory() || entry.isSymbolicLink()) refuse('path must be a real directory, not a symlink or unexpected type')
    if (relative(current, realpathSync(current)) !== '') refuse('directory identity is not canonical')
  }
  return true
}

/**
 * Refuse old journals and orphan rollbacks without reading their contents or changing any filesystem entry.
 * Valid old staging-only directories are retained, not reclaimed. Ambiguous names/types and excessive scans fail closed.
 * @param paths - Explicit Desktop profile and legacy state root from the owning launcher.
 */
export function assertNoLegacyDesktopActivation(paths: DesktopProfileSafetyPaths): void {
  try { inspectLegacyDesktopActivation(paths) } catch (error) {
    if (isDesktopLegacyActivationRefusal(error)) throw error
    // Only failures inside this read-only inspection become fatal legacy refusals.
    throw new DesktopLegacyActivationRefusal('legacy evidence could not be safely inspected', { cause: error })
  }
}

function inspectLegacyDesktopActivation(paths: DesktopProfileSafetyPaths): void {
  if (!isAbsolute(paths.profile) || !isAbsolute(paths.legacyStateRoot)) refuse('launcher paths must be absolute')
  const profile = resolve(paths.profile)
  const legacyRoot = resolve(paths.legacyStateRoot)
  // Check both complete ancestor chains, even when the active profile is absent.
  ordinaryDirectory(profile)
  if (ordinaryDirectory(legacyRoot)
    && lstatSync(join(legacyRoot, 'profile-activation.json'), { throwIfNoEntry: false }) !== undefined) {
    refuse('a retained alpha1 profile-activation.json requires explicit recovery')
  }
  const parent = dirname(profile)
  if (!ordinaryDirectory(parent)) return
  const directory = opendirSync(parent)
  let entries = 0
  let transactions = 0
  let failed = false
  let failure: unknown
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (++entries > 1024) refuse('profile parent exceeds the bounded inspection limit')
      if (!/^\.desktop-transaction-/iu.test(entry.name)) continue
      if (++transactions > 100) refuse('too many retained alpha1 transactions')
      if (!/^\.desktop-transaction-[A-Za-z0-9]+$/u.test(entry.name)) refuse('ambiguous alpha1 transaction name')
      const transaction = join(parent, entry.name)
      if (!ordinaryDirectory(transaction)) refuse('alpha1 transaction disappeared during inspection')
      if (lstatSync(join(transaction, 'rollback'), { throwIfNoEntry: false }) !== undefined) {
        refuse('an orphan alpha1 rollback requires explicit recovery')
      }
    }
  } catch (error) {
    failed = true
    failure = error
  } finally {
    try { directory.closeSync() } catch (error) {
      if (!failed) { failed = true; failure = error }
    }
  }
  if (failed) throw failure
}
