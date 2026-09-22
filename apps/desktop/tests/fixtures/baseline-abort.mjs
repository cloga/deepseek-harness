/** Token-bound baseline failure control; never a successful refusal/finish request. */
import { lstatSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { ownedUpgradePath } from './windows-installed-upgrade-contract.mjs'

/**
 * Read only a regular, small control file matching this exact run and waiting phase.
 * Invalid/stale controls are not permission to close the application.
 * @param {string} root - Already validated private run root.
 * @param {{token: string, runId: string, runAttempt: string}} owner - This run's verified owner.
 * @param {string} sourceCommit - Exact current workflow source.
 * @returns {boolean} Whether the driver authorized abort during baseline refusal waiting.
 */
export function baselineAbortRequested(root, owner, sourceCommit) {
  try {
    const path = ownedUpgradePath(root, join(root, 'baseline-abort-request.json'))
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2048) return false
    const value = JSON.parse(readFileSync(path, 'utf8'))
    return value !== null && typeof value === 'object' && !Array.isArray(value)
      && value.schemaVersion === 1 && value.ownerToken === owner.token
      && value.runId === owner.runId && value.runAttempt === owner.runAttempt
      && value.sourceCommit === sourceCommit && value.phase === 'baseline-refusal'
  } catch {
    // Missing, partial, malformed or aliased controls grant no action; normal waiting remains bounded.
    return false
  }
}

/**
 * Acknowledge only after the existing owned app.close resolves. This is failure evidence, not qualification.
 * @param {string} root - Already validated private run root.
 * @param {{token: string, runId: string, runAttempt: string}} owner - This run's verified owner.
 * @param {string} sourceCommit - Exact current workflow source.
 */
export function acknowledgeBaselineAbort(root, owner, sourceCommit) {
  const path = ownedUpgradePath(root, join(root, 'baseline-abort-ack.json'))
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, ownerToken: owner.token,
    runId: owner.runId, runAttempt: owner.runAttempt, sourceCommit, phase: 'baseline-refusal',
    appCloseResolved: true, failed: true,
  }) + '\n', { flag: 'wx' })
}
