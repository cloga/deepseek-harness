/** Verify unexpected observer propagation and owned cleanup after one full packaged run. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from 'node:fs'
import { join, resolve } from 'node:path'
import type { PackagedCopilotAcceptanceOptions } from './copilot-release-smoke.ts'

/** Identity shared by internal functional, failure and suite evidence. */
export interface PackagedProofIdentity {
  readonly evidenceId: string
  readonly sourceCommit: string
  readonly sourceTree: string
  readonly runId: string | null
  readonly runAttempt: string | null
  readonly planSha256: string
  readonly runtimeSha256: string
  readonly executableSha256: string
  readonly provisioningSha256: string
  readonly capabilitySha256: string
}

/**
 * Publish complete bytes atomically, refusing existing evidence except owned diagnostic finalization.
 * @param output - Existing evidence directory.
 * @param file - Fixture-owned filename.
 * @param value - Owned JSON evidence, never runtime objects.
 * @param replace - Only the owner's already-created failure receipt may be replaced.
 */
export function writePackagedProof(output: string, file: string, value: unknown, replace = false): void {
  assert(['positive-usage.json', 'native-composer-geometry.json', 'functional-results.json', 'acceptance.json',
    'failure.json', 'observer-cleanup.json', 'packaged-suite.json'].includes(file),
  'Unknown packaged proof filename')
  assert(!replace || file === 'failure.json', 'Only owned failure diagnostics can be finalized')
  const target = join(output, file)
  const temporary = join(output, `.${file}.${randomUUID()}.tmp`)
  let descriptor: number | undefined
  let staged: Stats | undefined
  let reserved: Stats | undefined
  const sameFile = (current: Stats, expected: Stats): boolean => current.isFile() && !current.isSymbolicLink()
    && current.dev === expected.dev && current.ino === expected.ino
  // A fresh private evidence directory has one writer. These observations reject accidental replacement;
  // portable rename cannot compare-and-swap against a malicious concurrent same-user filesystem writer.
  const previous = replace ? lstatSync(target) : undefined
  if (previous !== undefined) assert(previous.isFile() && !previous.isSymbolicLink(), 'Owned diagnostic must remain a regular file')
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    staged = fstatSync(descriptor)
    writeFileSync(descriptor, JSON.stringify(value, undefined, 2) + '\n')
    fsyncSync(descriptor)
    closeSync(descriptor)
    descriptor = undefined
    if (!replace) {
      descriptor = openSync(target, 'wx', 0o600)
      reserved = fstatSync(descriptor)
      closeSync(descriptor)
      descriptor = undefined
    }
    const expected = previous ?? reserved
    assert(expected !== undefined)
    const current = lstatSync(target)
    assert(sameFile(current, expected) && (replace || current.size === 0), 'Receipt reservation changed before publication')
    // Final filesystem operation: failure before this point leaves no newly committed valid receipt.
    renameSync(temporary, target)
  } catch (error) {
    const secondary: unknown[] = []
    if (descriptor !== undefined) {
      try { closeSync(descriptor) } catch (closeError) { secondary.push(closeError) }
    }
    if (reserved !== undefined) {
      try {
        if (existsSync(target)) {
          const current = lstatSync(target)
          if (sameFile(current, reserved) && current.size === 0) unlinkSync(target)
        }
      } catch (removeError) { secondary.push(removeError) }
    }
    if (staged !== undefined) {
      try { if (existsSync(temporary) && sameFile(lstatSync(temporary), staged)) unlinkSync(temporary) }
      catch (removeError) { secondary.push(removeError) }
    }
    if (secondary.length > 0) throw new AggregateError([error, ...secondary], 'Packaged receipt publication and cleanup failed')
    throw error
  }
}

function readProof(output: string, file: string): { value: Record<string, unknown>; sha256: string } {
  const path = join(output, file)
  const stat = lstatSync(path)
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 2 * 1024 * 1024,
    'Packaged proof must be a bounded regular file')
  const bytes = readFileSync(path)
  assert.equal(bytes.length, stat.size, 'Packaged proof changed while reading')
  const value: unknown = JSON.parse(bytes.toString('utf8'))
  assert(typeof value === 'object' && value !== null && !Array.isArray(value), 'Packaged proof must be an object')
  return { value: value as Record<string, unknown>, sha256: createHash('sha256').update(bytes).digest('hex') }
}

function identityOf(value: Record<string, unknown>): PackagedProofIdentity {
  const fields = ['evidenceId', 'sourceCommit', 'sourceTree', 'runId', 'runAttempt', 'planSha256',
    'runtimeSha256', 'executableSha256', 'provisioningSha256', 'capabilitySha256'] as const
  assert(typeof value.evidenceId === 'string' && /^[a-f0-9-]{36}$/u.test(value.evidenceId))
  for (const field of ['sourceCommit', 'sourceTree'] as const) {
    assert(typeof value[field] === 'string' && /^[a-f0-9]{40}$/u.test(value[field]))
  }
  for (const field of fields.slice(5)) assert(typeof value[field] === 'string' && /^[a-f0-9]{64}$/u.test(value[field]))
  for (const field of ['runId', 'runAttempt'] as const) assert(value[field] === null || (typeof value[field] === 'string' && /^\d+$/u.test(value[field])))
  // All identity leaves were validated above; no unselected receipt fields cross this projection.
  return Object.fromEntries(fields.map(field => [field, value[field]])) as unknown as PackagedProofIdentity
}

/**
 * Exercise an ordinary failing observer through the actual owner, then commit separately scoped suite evidence.
 * @param options - Packaged application and fresh evidence destination.
 * @param runAcceptance - Fixed to the actual owner by the CLI; isolated wrapper tests may supply a controlled runner.
 * @returns Resolves only after full functional evidence, exact error propagation and observed owned removal.
 */
export async function runPackagedCopilotObserverCanary(
  options: Pick<PackagedCopilotAcceptanceOptions, 'application' | 'output' | 'expectedCoreSource'>,
  runAcceptance: (options: PackagedCopilotAcceptanceOptions) => Promise<unknown>,
): Promise<void> {
  const application = resolve(options.application)
  const output = resolve(options.output)
  mkdirSync(output, { recursive: true })
  for (const file of ['positive-usage.json', 'functional-results.json', 'acceptance.json', 'failure.json', 'observer-cleanup.json', 'packaged-suite.json']) {
    assert(!existsSync(join(output, file)), `Combined acceptance requires fresh ${file} evidence`)
  }
  const marker = new Error(`packaged observer cleanup canary ${randomUUID()}`)
  const captures: Array<{ home: string; profile: string; legacySdk: string }> = []
  let propagated = false
  try { await runAcceptance({
    application,
    output,
    ...(options.expectedCoreSource === undefined ? {} : { expectedCoreSource: options.expectedCoreSource }),
    inspectProfile(paths) {
      assert.equal(captures.length, 0, 'Observer must run once')
      assert(Object.isFrozen(paths), 'Observer paths must be immutable')
      assert.deepEqual(Object.keys(paths).sort(), ['application', 'home', 'output', 'profile', 'runtimeRoot'])
      assert.equal(paths.application, application)
      assert.equal(paths.output, output)
      assert(existsSync(paths.profile), 'Real provisioned profile must exist during inspection')
      assert(!existsSync(join(output, 'acceptance.json')), 'Ordinary acceptance must be withheld before cleanup')
      captures.push({
        home: paths.home,
        profile: paths.profile,
        legacySdk: realpathSync(join(paths.home, 'profiles', 'node_modules', '@modelcontextprotocol', 'sdk')),
      })
      throw marker
    },
  }) } catch (error) {
    if (error !== marker) throw error
    propagated = true
  }
  assert(propagated, 'Real acceptance must reject the exact unexpected observer marker')
  assert.equal(captures.length, 1, 'Real acceptance must reach the observer exactly once')
  const captured = captures[0]!
  assert(!existsSync(captured.home), 'Acceptance must remove its owned home')
  assert(!existsSync(captured.profile), 'Acceptance must remove its owned profile')
  assert(!existsSync(captured.legacySdk), 'Acceptance must remove its owned ancestor canary')
  assert(!existsSync(join(output, 'acceptance.json')), 'Unexpected observer failure must withhold ordinary acceptance')
  const functional = readProof(output, 'functional-results.json')
  const failure = readProof(output, 'failure.json')
  assert.equal(functional.value.schemaVersion, 3)
  assert.equal(functional.value.scope, 'packaged-functional-observations')
  assert.equal(functional.value.functionalAssertionsCompleted, true)
  assert.equal(functional.value.normalAcceptanceCompleted, false)
  assert.equal(functional.value.cleanupVerified, false)
  const identity = identityOf(functional.value)
  assert.deepEqual(identityOf(failure.value), identity, 'Failure and functional evidence must identify the same run')
  assert.equal(failure.value.schemaVersion, 2)
  assert.equal(failure.value.scope, 'packaged-acceptance-failure')
  assert.equal(failure.value.error, String(marker), 'Failure receipt must retain the exact observer marker')
  assert.equal(failure.value.cleanupCompleted, true)
  assert.equal(failure.value.cleanupVerified, true)
  assert.deepEqual(failure.value.cleanupErrors, [])
  assert.deepEqual(failure.value.diagnosticErrors, [])
  writePackagedProof(output, 'observer-cleanup.json', {
    schemaVersion: 3, scope: 'unexpected-observer-failure-cleanup', ...identity,
    observerInvokedOnce: true, errorPropagationVerified: true, ordinaryAcceptanceWithheld: true,
    cleanupVerified: true, ownedHomeRemoved: true, ownedProfileRemoved: true, ownedLegacySdkRemoved: true,
    normalAcceptanceCompleted: false, functionalSha256: functional.sha256, failureSha256: failure.sha256,
  })
  const observer = readProof(output, 'observer-cleanup.json')
  writePackagedProof(output, 'packaged-suite.json', {
    schemaVersion: 1, scope: 'packaged-functional-with-unexpected-observer-failure', ...identity,
    functionalAssertionsCompleted: true, errorPropagationVerified: true, cleanupVerified: true,
    normalAcceptanceCompleted: false,
    receipts: {
      functional: { file: 'functional-results.json', sha256: functional.sha256 },
      failure: { file: 'failure.json', sha256: failure.sha256 },
      observer: { file: 'observer-cleanup.json', sha256: observer.sha256 },
    },
  })
}
