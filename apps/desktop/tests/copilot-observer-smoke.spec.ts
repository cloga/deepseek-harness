import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { removeOwnedDirectory } from '../src/owned-directory.ts'
import { inspectPackagedCopilotProfile, runPackagedCopilotObserverCanary } from './fixtures/copilot-observer-smoke.ts'
import type { PackagedCopilotAcceptanceOptions, PackagedCopilotProfileInspection } from './fixtures/copilot-release-smoke.ts'

const directories: string[] = []
afterEach(() => { for (const directory of directories.splice(0)) removeOwnedDirectory(directory) })
const paths: PackagedCopilotProfileInspection = Object.freeze({
  application: 'application', runtimeRoot: 'runtime', home: 'home', profile: 'profile', output: 'output',
})
const options = { application: paths.application, output: paths.output }

describe('post-acceptance observer exception ownership', () => {
  it('keeps absent and ordinary read-only observers in normal mode', async () => {
    await expect(inspectPackagedCopilotProfile(options, paths)).resolves.toBeUndefined()
    const observer = vi.fn(async (actual: PackagedCopilotProfileInspection) => { expect(actual).toBe(paths) })
    await expect(inspectPackagedCopilotProfile({ ...options, inspectProfile: observer }, paths)).resolves.toBeUndefined()
    expect(observer).toHaveBeenCalledExactlyOnceWith(paths)
  })

  it('preserves an ordinary observer rejection by identity', async () => {
    const marker = new Error('ordinary unexpected failure')
    await expect(inspectPackagedCopilotProfile({ ...options, inspectProfile: async () => { throw marker } }, paths))
      .rejects.toBe(marker)
  })

  it.each(['sync', 'async'] as const)('awaits and contains only the exact %s canary once', async (mode) => {
    const marker = new Error('expected canary')
    const observer = vi.fn(mode === 'sync' ? () => { throw marker } : async () => { throw marker })
    await expect(inspectPackagedCopilotProfile({
      ...options, inspectProfile: observer, expectedObserverFailure: marker,
    }, paths)).resolves.toEqual({ observerInvokedOnce: true, canaryContained: true })
    expect(observer).toHaveBeenCalledExactlyOnceWith(paths)
  })

  it('rejects a missing observer rather than accepting an unused canary', async () => {
    await expect(inspectPackagedCopilotProfile({ ...options, expectedObserverFailure: new Error('canary') }, paths))
      .rejects.toThrow('requires an observer')
  })

  it('rejects a canary observer that returns without throwing', async () => {
    await expect(inspectPackagedCopilotProfile({
      ...options, inspectProfile: async () => {}, expectedObserverFailure: new Error('canary'),
    }, paths)).rejects.toThrow('must throw its exact expected canary')
  })

  it('does not contain a different error with the same canary message', async () => {
    const marker = new Error('canary')
    const wrong = new Error(marker.message)
    await expect(inspectPackagedCopilotProfile({
      ...options, inspectProfile: async () => { throw wrong }, expectedObserverFailure: marker,
    }, paths)).rejects.toBe(wrong)
  })

  it('does not contain a non-Error rejection', async () => {
    await expect(inspectPackagedCopilotProfile({
      ...options, inspectProfile: async () => { throw undefined }, expectedObserverFailure: new Error('canary'),
    }, paths)).rejects.toBeUndefined()
  })
})

type Damage = 'skip-observer' | 'repeat-observer' | 'mutable-paths' | 'retain-home' | 'retain-ancestor'
  | 'missing-acceptance' | 'missing-canary-evidence' | 'failure-receipt'

function isolatedRunner(damage?: Damage) {
  const root = mkdtempSync(join(tmpdir(), 'copilot-observer-canary-'))
  directories.push(root)
  const application = join(root, 'not-executed.exe')
  const output = join(root, 'evidence')
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'desktop')
  const legacySdk = join(root, 'legacy-sdk')
  const phases: string[] = []
  const run = vi.fn(async (actual: PackagedCopilotAcceptanceOptions) => {
    mkdirSync(profile, { recursive: true })
    mkdirSync(legacySdk)
    const ancestorSdk = join(home, 'profiles', 'node_modules', '@modelcontextprotocol', 'sdk')
    mkdirSync(dirname(ancestorSdk), { recursive: true })
    symlinkSync(legacySdk, ancestorSdk, process.platform === 'win32' ? 'junction' : 'dir')
    const observedPaths = { application, output, home, profile, runtimeRoot: join(root, 'runtime') }
    phases.push('isolated-runner-entered')
    try {
      const observerCleanupCanary = damage === 'skip-observer' ? undefined : await inspectPackagedCopilotProfile(actual,
        damage === 'mutable-paths' ? observedPaths : Object.freeze(observedPaths))
      if (damage === 'repeat-observer') await inspectPackagedCopilotProfile(actual, Object.freeze(observedPaths))
      phases.push('observer-settled')
      if (damage !== 'missing-acceptance') {
        writeFileSync(join(output, 'acceptance.json'), JSON.stringify({
          observerCleanupCanary: damage === 'missing-canary-evidence' ? undefined : observerCleanupCanary,
        }))
      }
      if (damage === 'failure-receipt') writeFileSync(join(output, 'failure.json'), '{}')
    } finally {
      expect(existsSync(join(output, 'observer-cleanup.json'))).toBe(false)
      if (damage !== 'retain-home') removeOwnedDirectory(home)
      if (damage !== 'retain-ancestor') removeOwnedDirectory(legacySdk)
      phases.push('owned-cleanup-completed')
    }
  })
  return { run, options: { application, output }, home, profile, legacySdk, phases }
}

describe('one-run combined observer cleanup evidence with an isolated runner', () => {
  it('calls acceptance once and publishes cleanup evidence only after its awaited cleanup', async () => {
    const fixture = isolatedRunner()
    await runPackagedCopilotObserverCanary(fixture.options, fixture.run)
    expect(fixture.run).toHaveBeenCalledTimes(1)
    expect(fixture.phases).toEqual(['isolated-runner-entered', 'observer-settled', 'owned-cleanup-completed'])
    for (const path of [fixture.home, fixture.profile, fixture.legacySdk]) expect(existsSync(path)).toBe(false)
    expect(JSON.parse(readFileSync(join(fixture.options.output, 'observer-cleanup.json'), 'utf8'))).toEqual({
      schemaVersion: 2, observerInvokedOnce: true, canaryContained: true, acceptanceCompleted: true, successWithCanary: true,
      ownedHomeRemoved: true, ownedProfileRemoved: true, ownedLegacySdkRemoved: true,
      realOAuth: false, realModelRound: false, realSearch: false, liveAccountQuota: false,
      verificationNavigationExercised: false, manualVerificationAddressObserved: false,
    })
    expect(existsSync(join(fixture.options.output, 'acceptance.json'))).toBe(true)
    expect(existsSync(join(fixture.options.output, 'failure.json'))).toBe(false)
  })

  it.each([
    'skip-observer', 'repeat-observer', 'mutable-paths', 'retain-home', 'retain-ancestor',
    'missing-acceptance', 'missing-canary-evidence', 'failure-receipt',
  ] as const)('rejects %s without publishing successful cleanup evidence', async (damage) => {
    const fixture = isolatedRunner(damage)
    await expect(runPackagedCopilotObserverCanary(fixture.options, fixture.run)).rejects.toThrow()
    expect(fixture.run).toHaveBeenCalledTimes(1)
    expect(existsSync(join(fixture.options.output, 'observer-cleanup.json'))).toBe(false)
  })

  it('preserves a full acceptance failure without retrying or publishing cleanup success', async () => {
    const fixture = isolatedRunner()
    const primary = new Error('initial acceptance failed')
    const run = vi.fn(async () => { throw primary })
    await expect(runPackagedCopilotObserverCanary(fixture.options, run)).rejects.toBe(primary)
    expect(run).toHaveBeenCalledTimes(1)
    expect(existsSync(join(fixture.options.output, 'observer-cleanup.json'))).toBe(false)
  })

  it.each(['acceptance.json', 'failure.json', 'observer-cleanup.json'])('rejects stale %s before invoking acceptance', async (file) => {
    const fixture = isolatedRunner()
    mkdirSync(fixture.options.output)
    writeFileSync(join(fixture.options.output, file), '{}')
    await expect(runPackagedCopilotObserverCanary(fixture.options, fixture.run)).rejects.toThrow('requires fresh')
    expect(fixture.run).not.toHaveBeenCalled()
    expect(readFileSync(join(fixture.options.output, file), 'utf8')).toBe('{}')
  })
})
