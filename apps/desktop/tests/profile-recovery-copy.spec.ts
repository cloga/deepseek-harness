import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { removeOwnedDirectory } from '../src/owned-directory.ts'
import { createDesktopProfileRecoveryCopy, recordDesktopProfileRecoveryOutcome } from '../src/profile-recovery-copy.ts'

const effects = vi.hoisted(() => ({
  afterCopy: undefined as ((source: string, target: string) => void) | undefined,
  openPaths: new Map<number, string>(),
  synced: [] as string[],
  shortWrites: false,
  zeroWrite: false,
  writes: 0,
  failure: undefined as 'payload-sync' | 'receipt-write' | 'receipt-sync' | 'receipt-close' | 'publish' | undefined,
}))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    cpSync: (...args: Parameters<typeof actual.cpSync>) => {
      actual.cpSync(...args)
      effects.afterCopy?.(String(args[0]), String(args[1]))
    },
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      const descriptor = actual.openSync(...args)
      effects.openPaths.set(descriptor, String(args[0]))
      return descriptor
    },
    closeSync: (descriptor: number) => {
      const path = effects.openPaths.get(descriptor) ?? ''
      actual.closeSync(descriptor)
      effects.openPaths.delete(descriptor)
      if (effects.failure === 'receipt-close' && path.includes('receipt.json.')) throw new Error('simulated close failure')
    },
    fsyncSync: (descriptor: number) => {
      const path = effects.openPaths.get(descriptor) ?? ''
      const receipt = path.includes('receipt.json.')
      if ((effects.failure === 'payload-sync' && !receipt) || (effects.failure === 'receipt-sync' && receipt)) {
        throw new Error('simulated sync failure')
      }
      actual.fsyncSync(descriptor)
      effects.synced.push(path)
    },
    writeSync: (descriptor: number, bytes: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
      effects.writes += 1
      if (effects.failure === 'receipt-write') throw new Error('simulated write failure')
      if (effects.zeroWrite) return 0
      return actual.writeSync(descriptor, bytes, offset, effects.shortWrites ? Math.min(length, 7) : length, position)
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      if (effects.failure === 'publish') throw new Error('simulated publication failure')
      actual.linkSync(...args)
    },
  }
})

beforeEach(() => {
  effects.afterCopy = undefined
  effects.openPaths.clear()
  effects.synced.length = 0
  effects.shortWrites = false
  effects.zeroWrite = false
  effects.writes = 0
  effects.failure = undefined
})

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-recovery-copy-'))
  onTestFinished(() => { removeOwnedDirectory(root) })
  const profile = join(root, 'profiles', 'desktop')
  const desktopRoot = join(root, 'desktop')
  mkdirSync(profile, { recursive: true })
  mkdirSync(desktopRoot)
  const manifest = '{"dependencies":{"manual-plugin":"1.0.0"}}\n'
  writeFileSync(join(profile, 'package.json'), manifest)
  writeFileSync(join(profile, 'desktop.cordis.yml'), 'plugins: []\n')
  mkdirSync(join(profile, '.desktop-plugin-artifacts'))
  writeFileSync(join(profile, '.desktop-plugin-artifacts', 'fixture.tgz'), 'private fixture artifact')
  return { root, profile, desktopRoot, manifest }
}

it('retains configuration, archives, empty directories and unrelated user files outside the profile', () => {
  const { profile, desktopRoot, manifest } = fixture()
  mkdirSync(join(profile, 'empty'))
  mkdirSync(join(profile, 'node_modules'))
  writeFileSync(join(profile, 'node_modules', 'generated.js'), 'materialized dependency')
  writeFileSync(join(profile, '.user-file'), 'user configuration')
  const copy = createDesktopProfileRecoveryCopy(profile, desktopRoot)
  const retained = join(copy.directory, 'profile')
  expect(readFileSync(join(retained, 'package.json'), 'utf8')).toBe(manifest)
  expect(readFileSync(join(retained, '.desktop-plugin-artifacts', 'fixture.tgz'), 'utf8')).toBe('private fixture artifact')
  expect(readFileSync(join(retained, '.user-file'), 'utf8')).toBe('user configuration')
  expect(lstatSync(join(retained, 'empty')).isDirectory()).toBe(true)
  expect(existsSync(join(retained, 'node_modules'))).toBe(false)
  expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(manifest)
  const receipt = JSON.parse(readFileSync(join(copy.directory, 'receipt.json'), 'utf8')) as {
    schemaVersion: number
    operation: string
    state: string
    entries: Array<{ path: string; sha256?: string }>
  }
  expect(receipt).toMatchObject({ schemaVersion: 1, operation: 'reset', state: 'copy-complete', durability: 'file-data-synced' })
  expect(effects.synced.at(-1)).toContain('receipt.json.')
  expect(effects.synced.slice(0, -1)).toEqual(expect.arrayContaining([
    join(retained, 'package.json'), join(retained, '.desktop-plugin-artifacts', 'fixture.tgz'),
  ]))
  expect(effects.openPaths.size).toBe(0)
  expect(receipt.entries.find(entry => entry.path === 'package.json')?.sha256).toMatch(/^[a-f0-9]{64}$/u)
  expect(receipt.entries.some(entry => entry.path.startsWith('node_modules'))).toBe(false)
  expect(existsSync(join(copy.directory, 'outcome.json'))).toBe(false)
})

it('refuses linked configuration before copying instead of following or recreating it', () => {
  const { root, profile, desktopRoot, manifest } = fixture()
  const external = join(root, 'external')
  mkdirSync(external)
  writeFileSync(join(external, 'sentinel'), 'not a profile-owned file')
  const linked = join(profile, 'linked')
  symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => createDesktopProfileRecoveryCopy(profile, desktopRoot)).toThrow('linked configuration requires manual recovery')
  expect(existsSync(join(desktopRoot, 'profile-recovery'))).toBe(false)
  expect(lstatSync(linked).isSymbolicLink()).toBe(true)
  expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(manifest)
  expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('not a profile-owned file')
})

it('retains incomplete evidence without a completed receipt when copying fails', () => {
  const { profile, desktopRoot, manifest } = fixture()
  effects.afterCopy = () => { throw new Error('simulated copy failure') }
  expect(() => createDesktopProfileRecoveryCopy(profile, desktopRoot)).toThrow('simulated copy failure')
  const parent = join(desktopRoot, 'profile-recovery')
  const directories = readdirSync(parent)
  expect(directories).toHaveLength(1)
  expect(existsSync(join(parent, directories[0]!, 'receipt.json'))).toBe(false)
  expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(manifest)
})

it('refuses a corrupted copy before certifying it or changing the source', () => {
  const { profile, desktopRoot, manifest } = fixture()
  effects.afterCopy = (_source, target) => { writeFileSync(join(target, 'package.json'), '{}\n') }
  expect(() => createDesktopProfileRecoveryCopy(profile, desktopRoot)).toThrow('copy verification failed')
  const parent = join(desktopRoot, 'profile-recovery')
  expect(existsSync(join(parent, readdirSync(parent)[0]!, 'receipt.json'))).toBe(false)
  expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(manifest)
})

it('detects a source change during copying without overwriting the changed source', () => {
  const { profile, desktopRoot } = fixture()
  effects.afterCopy = (source) => { writeFileSync(join(source, '.new-user-file'), 'concurrent user change') }
  expect(() => createDesktopProfileRecoveryCopy(profile, desktopRoot)).toThrow('profile changed while copying')
  const parent = join(desktopRoot, 'profile-recovery')
  expect(existsSync(join(parent, readdirSync(parent)[0]!, 'receipt.json'))).toBe(false)
  expect(readFileSync(join(profile, '.new-user-file'), 'utf8')).toBe('concurrent user change')
})

it('refuses to place the recovery directory inside the active profile', () => {
  const { profile, manifest } = fixture()
  expect(() => createDesktopProfileRecoveryCopy(profile, profile)).toThrow('outside the active profile')
  expect(existsSync(join(profile, 'profile-recovery'))).toBe(false)
  expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(manifest)
})

it('refuses a recovery parent that is itself the source profile', () => {
  const { desktopRoot } = fixture()
  const profile = join(desktopRoot, 'profile-recovery')
  mkdirSync(profile)
  writeFileSync(join(profile, 'package.json'), '{}\n')
  expect(() => createDesktopProfileRecoveryCopy(profile, desktopRoot)).toThrow('outside the active profile')
  expect(readdirSync(profile)).toEqual(['package.json'])
})

it('refuses a linked recovery parent without following it into another directory', () => {
  const { root, profile, desktopRoot, manifest } = fixture()
  const external = join(root, 'external')
  mkdirSync(external)
  symlinkSync(external, join(desktopRoot, 'profile-recovery'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => createDesktopProfileRecoveryCopy(profile, desktopRoot)).toThrow('not a link')
  expect(readdirSync(external)).toEqual([])
  expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(manifest)
})

it.each(['payload-sync', 'receipt-write', 'receipt-sync', 'receipt-close', 'publish'] as const)(
  'refuses reset and leaves no final receipt after %s failure', (failure) => {
    const { profile, desktopRoot, manifest } = fixture()
    effects.failure = failure
    expect(() => createDesktopProfileRecoveryCopy(profile, desktopRoot)).toThrow('simulated')
    const parent = join(desktopRoot, 'profile-recovery')
    const directory = join(parent, readdirSync(parent)[0]!)
    expect(existsSync(join(directory, 'receipt.json'))).toBe(false)
    expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(manifest)
    expect(effects.openPaths.size).toBe(0)
  },
)

it('writes complete evidence across short writes before publishing it', () => {
  const { profile, desktopRoot } = fixture()
  effects.shortWrites = true
  const copy = createDesktopProfileRecoveryCopy(profile, desktopRoot)
  expect(effects.writes).toBeGreaterThan(1)
  expect(JSON.parse(readFileSync(join(copy.directory, 'receipt.json'), 'utf8'))).toMatchObject({ state: 'copy-complete' })
  expect(effects.openPaths.size).toBe(0)
})

it('refuses a zero-progress evidence write without publishing a final marker', () => {
  const { profile, desktopRoot, manifest } = fixture()
  effects.zeroWrite = true
  expect(() => createDesktopProfileRecoveryCopy(profile, desktopRoot)).toThrow('no progress')
  const parent = join(desktopRoot, 'profile-recovery')
  expect(existsSync(join(parent, readdirSync(parent)[0]!, 'receipt.json'))).toBe(false)
  expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(manifest)
  expect(effects.openPaths.size).toBe(0)
})

it('does not reuse an incomplete directory as a verified recovery copy', () => {
  const { profile, desktopRoot } = fixture()
  effects.failure = 'receipt-sync'
  expect(() => createDesktopProfileRecoveryCopy(profile, desktopRoot)).toThrow('simulated')
  const parent = join(desktopRoot, 'profile-recovery')
  const partial = join(parent, readdirSync(parent)[0]!)
  effects.failure = undefined
  const complete = createDesktopProfileRecoveryCopy(profile, desktopRoot)
  expect(complete.directory).not.toBe(partial)
  expect(existsSync(join(partial, 'receipt.json'))).toBe(false)
  expect(existsSync(join(complete.directory, 'receipt.json'))).toBe(true)
  expect(readdirSync(parent)).toHaveLength(2)
})

it.each(['completed', 'failed'] as const)('records a %s reset outcome without changing the immutable receipt or copy', (outcome) => {
  const { profile, desktopRoot, manifest } = fixture()
  const copy = createDesktopProfileRecoveryCopy(profile, desktopRoot)
  const receipt = readFileSync(join(copy.directory, 'receipt.json'), 'utf8')
  recordDesktopProfileRecoveryOutcome(copy, outcome)
  expect(JSON.parse(readFileSync(join(copy.directory, 'outcome.json'), 'utf8'))).toMatchObject({
    schemaVersion: 1, operation: 'reset', outcome,
  })
  expect(readFileSync(join(copy.directory, 'receipt.json'), 'utf8')).toBe(receipt)
  expect(readFileSync(join(copy.directory, 'profile', 'package.json'), 'utf8')).toBe(manifest)
  const recorded = readFileSync(join(copy.directory, 'outcome.json'), 'utf8')
  expect(() => { recordDesktopProfileRecoveryOutcome(copy, outcome === 'completed' ? 'failed' : 'completed') }).toThrow()
  expect(readFileSync(join(copy.directory, 'outcome.json'), 'utf8')).toBe(recorded)
  expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe(manifest)
})
