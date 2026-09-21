import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeOwnedDirectory } from '../src/owned-directory.ts'
import { runPackagedCopilotObserverCanary, writePackagedProof, type PackagedProofIdentity } from './fixtures/copilot-observer-smoke.ts'
import type { PackagedCopilotAcceptanceOptions } from './fixtures/copilot-release-smoke.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) removeOwnedDirectory(directory) })
const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an owned evidence object')
  return value as Record<string, unknown>
}
type Damage = 'skip-observer' | 'repeat-observer' | 'mutable-paths' | 'retain-home' | 'retain-ancestor'
  | 'missing-functional' | 'missing-failure' | 'acceptance-present' | 'wrong-error' | 'return-after-error'
  | 'wrong-marker-text' | 'diagnostic-errors' | 'cleanup-errors' | 'cleanup-unfinalized' | 'cleanup-unverified'
  | 'foreign-identity' | 'foreign-functional-scope' | 'functional-not-complete' | 'functional-success'
  | 'functional-cleanup' | 'wrong-failure-schema' | 'invalid-identity' | 'linked-functional' | 'oversized-functional'
  | 'legacy-functional-schema'

/** Controlled runner tests only wrapper validation; real lifecycle tests live in copilot-release-smoke.spec.ts. */
function isolatedRunner(damage?: Damage) {
  const root = mkdtempSync(join(tmpdir(), 'copilot-observer-canary-'))
  directories.push(root)
  const application = join(root, 'not-executed.exe')
  const output = join(root, 'evidence')
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'desktop')
  const legacySdk = join(root, 'legacy-sdk')
  const identity: PackagedProofIdentity = {
    evidenceId: randomUUID(), sourceCommit: 'a'.repeat(40), sourceTree: 'b'.repeat(40), runId: null, runAttempt: null,
    planSha256: 'c'.repeat(64), runtimeSha256: 'd'.repeat(64), executableSha256: 'e'.repeat(64),
    provisioningSha256: 'f'.repeat(64), capabilitySha256: '0'.repeat(64),
  }
  const run = vi.fn(async (actual: PackagedCopilotAcceptanceOptions) => {
    mkdirSync(profile, { recursive: true }); mkdirSync(legacySdk)
    const ancestorSdk = join(home, 'profiles', 'node_modules', '@modelcontextprotocol', 'sdk')
    mkdirSync(dirname(ancestorSdk), { recursive: true })
    symlinkSync(legacySdk, ancestorSdk, process.platform === 'win32' ? 'junction' : 'dir')
    const paths = { application, output, home, profile, runtimeRoot: join(root, 'runtime') }
    if (damage === 'skip-observer') return
    let marker: unknown
    try { await actual.inspectProfile?.(damage === 'mutable-paths' ? paths : Object.freeze(paths)) }
    catch (error) { marker = error }
    if (damage === 'repeat-observer') await actual.inspectProfile?.(Object.freeze(paths))
    const functional = {
      ...identity, schemaVersion: damage === 'legacy-functional-schema' ? 1 : 2,
      scope: damage === 'foreign-functional-scope' ? 'other' : 'packaged-functional-observations',
      functionalAssertionsCompleted: damage !== 'functional-not-complete',
      normalAcceptanceCompleted: damage === 'functional-success', cleanupVerified: damage === 'functional-cleanup',
    }
    if (damage === 'invalid-identity') functional.sourceCommit = 'not-a-commit'
    if (damage !== 'missing-functional') writeFileSync(join(output, 'functional-results.json'), JSON.stringify(functional))
    if (damage === 'linked-functional') {
      removeOwnedDirectory(join(output, 'functional-results.json'))
      // A directory junction is available without the Windows file-symlink privilege.
      symlinkSync(legacySdk, join(output, 'functional-results.json'), process.platform === 'win32' ? 'junction' : 'dir')
    }
    if (damage === 'oversized-functional') writeFileSync(join(output, 'functional-results.json'), ' '.repeat(2 * 1024 * 1024 + 1))
    if (damage !== 'missing-failure') writeFileSync(join(output, 'failure.json'), JSON.stringify({
      ...identity, evidenceId: damage === 'foreign-identity' ? randomUUID() : identity.evidenceId,
      schemaVersion: damage === 'wrong-failure-schema' ? 1 : 2, scope: 'packaged-acceptance-failure',
      error: damage === 'wrong-marker-text' ? 'another marker' : String(marker),
      cleanupCompleted: damage !== 'cleanup-unfinalized', cleanupVerified: damage !== 'cleanup-unverified',
      cleanupErrors: damage === 'cleanup-errors' ? ['cleanup failed'] : [],
      diagnosticErrors: damage === 'diagnostic-errors' ? ['write failed earlier'] : [],
    }))
    if (damage === 'acceptance-present') writeFileSync(join(output, 'acceptance.json'), '{}')
    if (damage !== 'retain-home') removeOwnedDirectory(home)
    if (damage !== 'retain-ancestor') removeOwnedDirectory(legacySdk)
    if (damage === 'return-after-error') return
    if (damage === 'wrong-error') throw new Error(String(marker))
    throw marker
  })
  return { run, options: { application, output }, home, profile, legacySdk, identity }
}

describe('separately scoped observer suite evidence', () => {
  it('binds original bytes after one rejection and cleanup; never synthesizes ordinary acceptance', async () => {
    const fixture = isolatedRunner()
    await runPackagedCopilotObserverCanary(fixture.options, fixture.run)
    expect(fixture.run).toHaveBeenCalledTimes(1)
    expect(fixture.run.mock.calls[0]?.[0]).not.toHaveProperty('expectedObserverFailure')
    for (const path of [fixture.home, fixture.profile, fixture.legacySdk]) expect(existsSync(path)).toBe(false)
    const read = (file: string): Record<string, unknown> => {
      const value: unknown = JSON.parse(readFileSync(join(fixture.options.output, file), 'utf8'))
      return record(value)
    }
    const observer = read('observer-cleanup.json')
    expect(observer).toMatchObject({
      ...fixture.identity, schemaVersion: 3, scope: 'unexpected-observer-failure-cleanup',
      observerInvokedOnce: true, errorPropagationVerified: true, ordinaryAcceptanceWithheld: true,
      cleanupVerified: true, ownedHomeRemoved: true, ownedProfileRemoved: true, ownedLegacySdkRemoved: true,
      normalAcceptanceCompleted: false,
    })
    const suite = read('packaged-suite.json')
    expect(suite).toMatchObject({
      ...fixture.identity, schemaVersion: 1, scope: 'packaged-functional-with-unexpected-observer-failure',
      functionalAssertionsCompleted: true, errorPropagationVerified: true, cleanupVerified: true, normalAcceptanceCompleted: false,
    })
    const receipts = record(suite.receipts)
    expect(Object.keys(receipts).sort()).toEqual(['failure', 'functional', 'observer'])
    for (const [name, file] of [
      ['functional', 'functional-results.json'], ['failure', 'failure.json'], ['observer', 'observer-cleanup.json'],
    ] as const) {
      expect(receipts[name]).toEqual({ file, sha256: digest(readFileSync(join(fixture.options.output, file))) })
    }
    expect(observer.functionalSha256).toBe(record(receipts.functional).sha256)
    expect(observer.failureSha256).toBe(record(receipts.failure).sha256)
    expect(existsSync(join(fixture.options.output, 'acceptance.json'))).toBe(false)
    expect(readdirSync(fixture.options.output).some(name => name.endsWith('.tmp'))).toBe(false)
  })

  it.each([
    'skip-observer', 'repeat-observer', 'mutable-paths', 'retain-home', 'retain-ancestor',
    'missing-functional', 'missing-failure', 'acceptance-present', 'wrong-error', 'return-after-error',
    'wrong-marker-text', 'diagnostic-errors', 'cleanup-errors', 'cleanup-unfinalized', 'cleanup-unverified',
    'foreign-identity', 'foreign-functional-scope', 'functional-not-complete', 'functional-success',
    'functional-cleanup', 'wrong-failure-schema', 'invalid-identity', 'linked-functional', 'oversized-functional', 'legacy-functional-schema',
  ] as const)('rejects %s without committing suite evidence', async (damage) => {
    const fixture = isolatedRunner(damage)
    await expect(runPackagedCopilotObserverCanary(fixture.options, fixture.run)).rejects.toThrow()
    expect(fixture.run).toHaveBeenCalledTimes(1)
    expect(existsSync(join(fixture.options.output, 'packaged-suite.json'))).toBe(false)
    expect(existsSync(join(fixture.options.output, 'observer-cleanup.json'))).toBe(false)
  })

  it('does not retry a full acceptance failure or publish success', async () => {
    const fixture = isolatedRunner()
    const primary = new Error('initial acceptance failed')
    const run = vi.fn(async () => { throw primary })
    await expect(runPackagedCopilotObserverCanary(fixture.options, run)).rejects.toBe(primary)
    expect(run).toHaveBeenCalledTimes(1)
    expect(existsSync(join(fixture.options.output, 'packaged-suite.json'))).toBe(false)
  })

  it.each(['positive-usage.json', 'functional-results.json', 'acceptance.json', 'failure.json', 'observer-cleanup.json', 'packaged-suite.json'])('rejects stale %s before invoking acceptance', async (file) => {
    const fixture = isolatedRunner()
    mkdirSync(fixture.options.output)
    writeFileSync(join(fixture.options.output, file), '{}')
    await expect(runPackagedCopilotObserverCanary(fixture.options, fixture.run)).rejects.toThrow('requires fresh')
    expect(fixture.run).not.toHaveBeenCalled()
    expect(readFileSync(join(fixture.options.output, file), 'utf8')).toBe('{}')
  })

  it('atomically refuses existing receipt bytes without deleting or replacing them', () => {
    const fixture = isolatedRunner()
    mkdirSync(fixture.options.output)
    writeFileSync(join(fixture.options.output, 'packaged-suite.json'), 'foreign bytes')
    expect(() => { writePackagedProof(fixture.options.output, 'packaged-suite.json', {}) }).toThrow()
    expect(readFileSync(join(fixture.options.output, 'packaged-suite.json'), 'utf8')).toBe('foreign bytes')
    expect(readdirSync(fixture.options.output)).toEqual(['packaged-suite.json'])
    expect(() => { writePackagedProof(fixture.options.output, 'packaged-suite.json', {}, true) }).toThrow('Only owned failure')
  })
})
