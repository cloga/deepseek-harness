/** Contain an exact post-acceptance observer canary within one packaged run, then verify its owned cleanup. */
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PackagedCopilotAcceptanceOptions, PackagedCopilotProfileInspection } from './copilot-release-smoke.ts'

/** An expected observer exception was contained; directory removal is checked separately after the run returns. */
export interface PackagedCopilotObserverEvidence {
  readonly observerInvokedOnce: true
  readonly canaryContained: true
}

/**
 * Await the optional observer, containing only its explicitly expected exception by identity.
 * @param options - Acceptance observer and optional expected canary object.
 * @param paths - Frozen live profile paths owned by the acceptance run.
 * @returns Canary evidence only after that exact object was thrown; ordinary observer failures propagate.
 */
export async function inspectPackagedCopilotProfile(
  options: PackagedCopilotAcceptanceOptions,
  paths: PackagedCopilotProfileInspection,
): Promise<PackagedCopilotObserverEvidence | undefined> {
  if (options.expectedObserverFailure === undefined) {
    await options.inspectProfile?.(paths)
    return undefined
  }
  assert(options.inspectProfile, 'An expected observer failure requires an observer')
  let observed = false
  try {
    await options.inspectProfile(paths)
  } catch (error) {
    if (error !== options.expectedObserverFailure) throw error
    observed = true
  }
  assert(observed, 'The observer must throw its exact expected canary')
  return { observerInvokedOnce: true, canaryContained: true }
}

/**
 * Run full packaged acceptance once with a post-restart canary and verify cleanup after its awaited return.
 * @param options - Packaged application and a fresh evidence destination.
 * @param runAcceptance - The real acceptance entrypoint; unit tests supply an isolated runner, not an application.
 * @returns Resolves after successful acceptance and observed removal of the owned profile, home, and ancestor SDK.
 */
export async function runPackagedCopilotObserverCanary(
  options: Pick<PackagedCopilotAcceptanceOptions, 'application' | 'output'>,
  runAcceptance: (options: PackagedCopilotAcceptanceOptions) => Promise<void>,
): Promise<void> {
  const application = resolve(options.application)
  const output = resolve(options.output)
  mkdirSync(output, { recursive: true })
  for (const file of ['acceptance.json', 'failure.json', 'observer-cleanup.json']) {
    assert(!existsSync(join(output, file)), `Combined acceptance requires fresh ${file} evidence`)
  }
  const marker = new Error('packaged observer cleanup canary')
  const captures: Array<{ home: string; profile: string; legacySdk: string }> = []
  await runAcceptance({
    application,
    output,
    expectedObserverFailure: marker,
    inspectProfile(paths) {
      assert.equal(captures.length, 0, 'Observer must run once')
      assert(Object.isFrozen(paths), 'Observer paths must be immutable')
      assert.deepEqual(Object.keys(paths).sort(), ['application', 'home', 'output', 'profile', 'runtimeRoot'])
      assert.equal(paths.application, application)
      assert.equal(paths.output, output)
      assert(existsSync(paths.profile), 'Real provisioned profile must exist during inspection')
      captures.push({
        home: paths.home,
        profile: paths.profile,
        legacySdk: realpathSync(join(paths.home, 'profiles', 'node_modules', '@modelcontextprotocol', 'sdk')),
      })
      throw marker
    },
  })
  assert.equal(captures.length, 1, 'Real acceptance must reach the observer exactly once')
  const captured = captures[0]!
  assert(!existsSync(captured.home), 'Acceptance must remove its owned home')
  assert(!existsSync(captured.profile), 'Acceptance must remove its owned profile')
  assert(!existsSync(captured.legacySdk), 'Acceptance must remove its owned ancestor canary')
  assert(!existsSync(join(output, 'failure.json')), 'Expected canary must not be reported as an acceptance failure')
  const acceptance: unknown = JSON.parse(readFileSync(join(output, 'acceptance.json'), 'utf8'))
  assert(typeof acceptance === 'object' && acceptance !== null && 'observerCleanupCanary' in acceptance,
    'Successful acceptance must record the contained observer canary')
  assert.deepEqual(acceptance.observerCleanupCanary, { observerInvokedOnce: true, canaryContained: true })
  writeFileSync(join(output, 'observer-cleanup.json'), JSON.stringify({
    schemaVersion: 2,
    observerInvokedOnce: true,
    canaryContained: true,
    acceptanceCompleted: true,
    successWithCanary: true,
    ownedHomeRemoved: true,
    ownedProfileRemoved: true,
    ownedLegacySdkRemoved: true,
    realOAuth: false,
    realModelRound: false,
    realSearch: false,
    liveAccountQuota: false,
    verificationNavigationExercised: false,
    manualVerificationAddressObserved: false,
  }, undefined, 2) + '\n', { flag: 'wx' })
}
