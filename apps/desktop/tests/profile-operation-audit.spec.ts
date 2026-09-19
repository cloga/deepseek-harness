import { beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import {
  chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, symlinkSync, utimesSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { removeOwnedDirectory } from '../src/owned-directory.ts'
import { recordDesktopProfileOperation, type DesktopProfileOperationRecord } from '../src/profile-operation-audit.ts'

const effects = vi.hoisted(() => ({
  failure: undefined as 'open' | 'write' | 'sync' | 'close' | 'publish' | 'cleanup' | 'scan' | undefined,
  shortWrites: false,
  zeroWrite: false,
  stem: undefined as string | undefined,
  openDescriptors: new Set<number>(),
  events: [] as string[],
  failUnlinkAt: 0,
  unlinks: 0,
}))
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>()
  return { ...actual, randomUUID: () => effects.stem ?? actual.randomUUID() }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    openSync: (...args: Parameters<typeof actual.openSync>) => {
      effects.events.push('open')
      if (effects.failure === 'open') throw new Error('simulated open failure')
      const descriptor = actual.openSync(...args)
      effects.openDescriptors.add(descriptor)
      return descriptor
    },
    writeSync: (descriptor: number, bytes: NodeJS.ArrayBufferView, offset: number, length: number, position: number | null) => {
      effects.events.push('write')
      if (effects.failure === 'write') throw new Error('simulated write failure')
      if (effects.zeroWrite) return 0
      return actual.writeSync(descriptor, bytes, offset, effects.shortWrites ? Math.min(7, length) : length, position)
    },
    fsyncSync: (descriptor: number) => {
      effects.events.push('sync')
      if (effects.failure === 'sync') throw new Error('simulated sync failure')
      actual.fsyncSync(descriptor)
    },
    closeSync: (descriptor: number) => {
      effects.events.push('close')
      actual.closeSync(descriptor)
      effects.openDescriptors.delete(descriptor)
      if (effects.failure === 'close') throw new Error('simulated close failure')
    },
    linkSync: (...args: Parameters<typeof actual.linkSync>) => {
      effects.events.push('publish')
      if (effects.failure === 'publish') throw new Error('simulated publish failure')
      actual.linkSync(...args)
    },
    unlinkSync: (...args: Parameters<typeof actual.unlinkSync>) => {
      effects.events.push('cleanup')
      effects.unlinks += 1
      if (effects.failure === 'cleanup' || effects.unlinks === effects.failUnlinkAt) throw new Error('simulated cleanup failure')
      actual.unlinkSync(...args)
    },
    readdirSync: (...args: Parameters<typeof actual.readdirSync>) => {
      if (effects.failure === 'scan') throw new Error('simulated scan failure')
      return actual.readdirSync(...args)
    },
  }
})

beforeEach(() => {
  effects.failure = undefined
  effects.shortWrites = false
  effects.zeroWrite = false
  effects.stem = undefined
  effects.openDescriptors.clear()
  effects.events.length = 0
  effects.failUnlinkAt = 0
  effects.unlinks = 0
})

const record: DesktopProfileOperationRecord = {
  transaction: 'test-transaction',
  operation: 'plugin-add',
  target: '@fixture/plugin',
  phase: 'activation',
  outcome: 'committed',
  before: { sha256: 'a'.repeat(64), names: ['existing-plugin'] },
  after: { sha256: 'b'.repeat(64), names: ['existing-plugin', '@fixture/plugin'] },
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-profile-audit-'))
  onTestFinished(() => {
    effects.failure = undefined
    effects.failUnlinkAt = 0
    removeOwnedDirectory(root)
  })
  const desktopRoot = join(root, 'desktop')
  const directory = join(desktopRoot, 'profile-operations')
  mkdirSync(desktopRoot, { mode: 0o700 })
  return { root, desktopRoot, directory }
}

function seed(directory: string, index: number, partial = false): string {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stem = `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`
  const pending = join(directory, `${stem}.pending`)
  writeFileSync(pending, 'retained evidence\n', { mode: 0o600 })
  utimesSync(pending, new Date(946684800000 + index * 1000), new Date(946684800000 + index * 1000))
  if (!partial) linkSync(pending, join(directory, `${stem}.json`))
  return stem
}

it('publishes only projected leaves with its own version and timestamp, retaining the synchronized inode', () => {
  const { desktopRoot, directory } = fixture()
  const extra = {
    ...record,
    source: 'https://secret.invalid/token', rawSpec: 'token=value', config: { token: 'secret' },
    error: 'private error', prompt: 'private prompt', schemaVersion: 99, recordedAt: 'untrusted',
    before: { ...record.before!, source: 'private source', toJSON: () => ({ token: 'private' }) },
    after: { ...record.after!, rawSpec: 'private spec' },
    toJSON: () => ({ secret: 'caller serialization hook' }),
  }
  const path = recordDesktopProfileOperation(desktopRoot, extra)
  expect(dirname(path)).toBe(realpathSync.native(directory))
  expect(basename(path)).toMatch(/^[0-9a-f-]{36}\.json$/u)
  const text = readFileSync(path, 'utf8')
  const { recordedAt, ...parsed } = JSON.parse(text) as Record<string, unknown>
  expect(parsed).toEqual({ ...record, schemaVersion: 1 })
  if (typeof recordedAt !== 'string') throw new Error('Audit timestamp must be a string')
  expect(new Date(recordedAt).toISOString()).toBe(recordedAt)
  expect(text).not.toMatch(/secret|private|rawSpec|config|prompt|source|toJSON/u)
  const pending = path.replace(/\.json$/u, '.pending')
  expect(readFileSync(pending, 'utf8')).toBe(text)
  expect(lstatSync(path).ino).toBe(lstatSync(pending).ino)
  expect(lstatSync(path).nlink).toBe(2)
  expect(effects.events).toEqual(['open', 'write', 'sync', 'close', 'publish'])
  expect(effects.openDescriptors.size).toBe(0)
  expect(readdirSync(directory)).toHaveLength(2)
  if (process.platform !== 'win32') {
    expect(lstatSync(desktopRoot).mode & 0o777).toBe(0o700)
    expect(lstatSync(directory).mode & 0o777).toBe(0o700)
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
  }
})

it('preserves null evidence and omits an absent target', () => {
  const { desktopRoot } = fixture()
  const path = recordDesktopProfileOperation(desktopRoot, {
    transaction: 'recovery', operation: 'recovery', phase: 'recovery', outcome: 'recovered', before: null, after: null,
  })
  const { recordedAt, ...parsed } = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  expect(typeof recordedAt).toBe('string')
  expect(parsed).toEqual({
    schemaVersion: 1, transaction: 'recovery', operation: 'recovery',
    phase: 'recovery', outcome: 'recovered', before: null, after: null,
  })
})

it('completes short writes before syncing, closing and publishing', () => {
  const { desktopRoot } = fixture()
  effects.shortWrites = true
  const path = recordDesktopProfileOperation(desktopRoot, record)
  expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject(record)
  expect(effects.events.filter(event => event === 'write').length).toBeGreaterThan(1)
  expect(effects.events.slice(-3)).toEqual(['sync', 'close', 'publish'])
})

it.each(['open', 'write', 'sync', 'close', 'publish'] as const)('throws on %s failure without publishing a receipt', (failure) => {
  const { desktopRoot, directory } = fixture()
  effects.failure = failure
  expect(() => recordDesktopProfileOperation(desktopRoot, record)).toThrow(`simulated ${failure} failure`)
  const names = readdirSync(directory)
  expect(names).toHaveLength(failure === 'open' ? 0 : 1)
  expect(names.every(name => name.endsWith('.pending'))).toBe(true)
  expect(effects.openDescriptors.size).toBe(0)
})

it('throws on zero-progress writes and retains pending evidence', () => {
  const { desktopRoot, directory } = fixture()
  effects.zeroWrite = true
  expect(() => recordDesktopProfileOperation(desktopRoot, record)).toThrow('no progress')
  expect(readdirSync(directory)).toHaveLength(1)
  expect(readdirSync(directory)[0]).toMatch(/\.pending$/u)
  expect(effects.events).toEqual(['open', 'write', 'close'])
  expect(effects.openDescriptors.size).toBe(0)
})

it('rejects a record larger than 128 KiB before creating audit storage', () => {
  const { desktopRoot, directory } = fixture()
  expect(() => recordDesktopProfileOperation(desktopRoot, { ...record, transaction: 'x'.repeat(128 * 1024) })).toThrow('128 KiB')
  expect(existsSync(directory)).toBe(false)
  expect(effects.events).toEqual([])
})

it('applies the size bound to UTF-8 bytes rather than character count', () => {
  const { desktopRoot, directory } = fixture()
  expect(() => recordDesktopProfileOperation(desktopRoot, { ...record, transaction: '界'.repeat(45000) })).toThrow('128 KiB')
  expect(existsSync(directory)).toBe(false)
})

it('admits a record exactly at the byte limit but rejects one additional byte', () => {
  const { desktopRoot, directory } = fixture()
  const baseline = recordDesktopProfileOperation(desktopRoot, { ...record, transaction: '' })
  const remaining = 128 * 1024 - readFileSync(baseline).byteLength
  const path = recordDesktopProfileOperation(desktopRoot, { ...record, transaction: 'x'.repeat(remaining) })
  expect(readFileSync(path).byteLength).toBe(128 * 1024)
  expect(() => recordDesktopProfileOperation(desktopRoot, { ...record, transaction: 'x'.repeat(remaining + 1) })).toThrow('128 KiB')
  expect(readdirSync(directory)).toHaveLength(4)
})

it('prunes the oldest complete group before opening the new pending record', () => {
  const { desktopRoot, directory } = fixture()
  const stems = Array.from({ length: 64 }, (_, index) => seed(directory, index))
  effects.events.length = 0
  const path = recordDesktopProfileOperation(desktopRoot, record)
  expect(readdirSync(directory)).toHaveLength(128)
  expect(existsSync(join(directory, `${stems[0]}.pending`))).toBe(false)
  expect(existsSync(join(directory, `${stems[0]}.json`))).toBe(false)
  expect(existsSync(join(directory, `${stems[1]}.json`))).toBe(true)
  expect(existsSync(path)).toBe(true)
  expect(effects.events.slice(0, 3)).toEqual(['cleanup', 'cleanup', 'open'])
  expect(effects.events.at(-1)).toBe('publish')
})

it('counts pending-only groups when cleaning up retained partial writes', () => {
  const { desktopRoot, directory } = fixture()
  for (let index = 0; index < 80; index += 1) seed(directory, index, true)
  recordDesktopProfileOperation(desktopRoot, record)
  const names = readdirSync(directory)
  expect(new Set(names.map(name => name.split('.')[0])).size).toBe(64)
  expect(names).toHaveLength(65)
})

it('keeps repeated failed publications bounded without losing the newest partial record', () => {
  const { desktopRoot, directory } = fixture()
  for (let index = 0; index < 64; index += 1) seed(directory, index, true)
  effects.failure = 'publish'
  for (let index = 0; index < 4; index += 1) {
    expect(() => recordDesktopProfileOperation(desktopRoot, record)).toThrow('simulated publish failure')
    expect(readdirSync(directory)).toHaveLength(64)
  }
  expect(readdirSync(directory).every(name => name.endsWith('.pending'))).toBe(true)
})

it('surfaces cleanup failure before opening or publishing a new record', () => {
  const { desktopRoot, directory } = fixture()
  for (let index = 0; index < 64; index += 1) seed(directory, index)
  effects.events.length = 0
  effects.failure = 'cleanup'
  expect(() => recordDesktopProfileOperation(desktopRoot, record)).toThrow('simulated cleanup failure')
  expect(effects.events).toEqual(['cleanup'])
  expect(readdirSync(directory)).toHaveLength(128)
})

it('counts a pending-only group left by partial cleanup and recovers on the next attempt', () => {
  const { desktopRoot, directory } = fixture()
  const stems = Array.from({ length: 64 }, (_, index) => seed(directory, index))
  effects.events.length = 0
  effects.failUnlinkAt = 2
  expect(() => recordDesktopProfileOperation(desktopRoot, record)).toThrow('simulated cleanup failure')
  expect(existsSync(join(directory, `${stems[0]}.json`))).toBe(false)
  expect(existsSync(join(directory, `${stems[0]}.pending`))).toBe(true)
  expect(effects.events).not.toContain('open')
  effects.failUnlinkAt = 0
  recordDesktopProfileOperation(desktopRoot, record)
  expect(readdirSync(directory)).toHaveLength(128)
  expect(existsSync(join(directory, `${stems[0]}.pending`))).toBe(false)
})

it('does not delete unknown filenames, directories or links during retention cleanup', () => {
  const { root, desktopRoot, directory } = fixture()
  for (let index = 0; index < 64; index += 1) seed(directory, index)
  const unknown = ['notes.json', 'operation.pending', '00000000-0000-1000-8000-000000000000.json',
    '00000000-0000-4000-8000-000000000000.json.bak']
  for (const name of unknown) writeFileSync(join(directory, name), 'unrelated')
  const external = join(root, 'external')
  mkdirSync(external)
  writeFileSync(join(external, 'sentinel'), 'external content')
  mkdirSync(join(directory, 'unrelated-directory'))
  symlinkSync(external, join(directory, 'unrelated-link'), process.platform === 'win32' ? 'junction' : 'dir')
  recordDesktopProfileOperation(desktopRoot, record)
  for (const name of unknown) expect(readFileSync(join(directory, name), 'utf8')).toBe('unrelated')
  expect(lstatSync(join(directory, 'unrelated-directory')).isDirectory()).toBe(true)
  expect(lstatSync(join(directory, 'unrelated-link')).isSymbolicLink()).toBe(true)
  expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('external content')
})

it.each(['root', 'audit'] as const)('rejects a linked %s directory without touching its target', (which) => {
  const { root, desktopRoot, directory } = fixture()
  const external = join(root, 'external')
  mkdirSync(external)
  writeFileSync(join(external, 'sentinel'), 'untouched')
  const linked = which === 'root' ? join(root, 'linked-root') : directory
  symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => recordDesktopProfileOperation(which === 'root' ? linked : desktopRoot, record)).toThrow('not a link')
  expect(readdirSync(external)).toEqual(['sentinel'])
  expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('untouched')
})

it.each(['root', 'audit'] as const)('rejects a regular file in place of the %s directory', (which) => {
  const { root, desktopRoot, directory } = fixture()
  const path = which === 'root' ? join(root, 'file-root') : directory
  writeFileSync(path, 'untouched')
  expect(() => recordDesktopProfileOperation(which === 'root' ? path : desktopRoot, record)).toThrow('owned directory')
  expect(readFileSync(path, 'utf8')).toBe('untouched')
})

it('requires an existing Desktop root rather than recursively creating paths', () => {
  const { root } = fixture()
  expect(() => recordDesktopProfileOperation(join(root, 'missing'), record)).toThrow()
  expect(existsSync(join(root, 'missing'))).toBe(false)
})

it('refuses owned-looking linked records without reading or deleting their targets', () => {
  const { root, desktopRoot, directory } = fixture()
  mkdirSync(directory, { mode: 0o700 })
  const external = join(root, 'external')
  mkdirSync(external)
  writeFileSync(join(external, 'sentinel'), 'untouched')
  const linked = join(directory, '00000000-0000-4000-8000-000000000000.pending')
  symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => recordDesktopProfileOperation(desktopRoot, record)).toThrow('unsafe retained record')
  expect(lstatSync(linked).isSymbolicLink()).toBe(true)
  expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('untouched')
  expect(effects.events).not.toContain('open')
})

it.skipIf(process.platform === 'win32')('refuses file symlinks with owned record names', () => {
  const { root, desktopRoot, directory } = fixture()
  mkdirSync(directory, { mode: 0o700 })
  const external = join(root, 'external-file')
  writeFileSync(external, 'untouched')
  symlinkSync(external, join(directory, '00000000-0000-4000-8000-000000000000.json'), 'file')
  expect(() => recordDesktopProfileOperation(desktopRoot, record)).toThrow('unsafe retained record')
  expect(readFileSync(external, 'utf8')).toBe('untouched')
})

it('rejects unrelated hardlinks before any cleanup or publication', () => {
  const { root, desktopRoot, directory } = fixture()
  const stem = seed(directory, 0, true)
  const outside = join(root, 'unrelated-evidence')
  linkSync(join(directory, `${stem}.pending`), outside)
  effects.events.length = 0
  expect(() => recordDesktopProfileOperation(desktopRoot, record)).toThrow('unrelated hardlinks')
  expect(readFileSync(outside, 'utf8')).toBe('retained evidence\n')
  expect(effects.events).toEqual([])
})

it('rejects a final and pending pair that do not share an inode', () => {
  const { desktopRoot, directory } = fixture()
  const stem = seed(directory, 0, true)
  writeFileSync(join(directory, `${stem}.json`), 'other evidence', { mode: 0o600 })
  expect(() => recordDesktopProfileOperation(desktopRoot, record)).toThrow('does not share')
  expect(readdirSync(directory)).toHaveLength(2)
})

it('never replaces an existing pending inode on a UUID collision', () => {
  const { desktopRoot, directory } = fixture()
  effects.stem = seed(directory, 0, true)
  expect(() => recordDesktopProfileOperation(desktopRoot, record)).toThrow()
  expect(readFileSync(join(directory, `${effects.stem}.pending`), 'utf8')).toBe('retained evidence\n')
  expect(readdirSync(directory)).toHaveLength(1)
})

it('never replaces an existing final receipt on a UUID collision', () => {
  const { desktopRoot, directory } = fixture()
  mkdirSync(directory, { mode: 0o700 })
  effects.stem = '00000000-0000-4000-8000-000000000000'
  const path = join(directory, `${effects.stem}.json`)
  writeFileSync(path, 'immutable final', { mode: 0o600 })
  expect(() => recordDesktopProfileOperation(desktopRoot, record)).toThrow()
  expect(readFileSync(path, 'utf8')).toBe('immutable final')
  expect(existsSync(join(directory, `${effects.stem}.pending`))).toBe(true)
  expect(effects.openDescriptors.size).toBe(0)
})

it('surfaces directory scan failure without opening a new record', () => {
  const { desktopRoot } = fixture()
  effects.failure = 'scan'
  expect(() => recordDesktopProfileOperation(desktopRoot, record)).toThrow('simulated scan failure')
  expect(effects.events).toEqual([])
})

it.skipIf(process.platform === 'win32')('restricts existing owned directories to 0700', () => {
  const { desktopRoot, directory } = fixture()
  chmodSync(desktopRoot, 0o755)
  mkdirSync(directory, { mode: 0o755 })
  recordDesktopProfileOperation(desktopRoot, record)
  expect(lstatSync(desktopRoot).mode & 0o777).toBe(0o700)
  expect(lstatSync(directory).mode & 0o777).toBe(0o700)
})

it.skipIf(process.platform === 'win32')('refuses retained records with nonprivate permissions', () => {
  const { desktopRoot, directory } = fixture()
  const stem = seed(directory, 0, true)
  chmodSync(join(directory, `${stem}.pending`), 0o644)
  expect(() => recordDesktopProfileOperation(desktopRoot, record)).toThrow('not private')
  expect(effects.events).not.toContain('open')
})
