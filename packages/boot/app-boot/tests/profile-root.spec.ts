import { lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assertPreparedProfileRootConfig, prepareProfileRootConfig, PROFILE_ROOT_CONFIG, writeProfileRootConfig } from '../src/profile-root.ts'

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
function root() { const path = mkdtempSync(join(tmpdir(), 'dsh-profile-root-')); roots.push(path); return path }

it.each([undefined, '[]\n', '\uFEFF[]\n', '# old empty derived root\r\n[]\r\n', PROFILE_ROOT_CONFIG])('prepares supported empty roots without changing the user patch (%s)', (value) => {
  const path = root()
  if (value !== undefined) writeFileSync(join(path, 'cordis.yml'), value)
  writeFileSync(join(path, 'cordis.patch.yml'), '- id: preserve-user\n  disabled: true\n')
  prepareProfileRootConfig(path)
  expect(readFileSync(join(path, 'cordis.yml'), 'utf8')).toBe(PROFILE_ROOT_CONFIG)
  expect(readFileSync(join(path, 'cordis.patch.yml'), 'utf8')).toBe('- id: preserve-user\n  disabled: true\n')
})

it('requires a presealed staged root without creating it or normalizing user bytes', () => {
  const path = root()
  const rootFile = join(path, 'cordis.yml')
  const patchFile = join(path, 'cordis.patch.yml')
  writeFileSync(patchFile, '- id: preserve-user\n  disabled: true\n')
  expect(() => { assertPreparedProfileRootConfig(path) }).toThrow('already sealed canonical root')
  expect(lstatSync(rootFile, { throwIfNoEntry: false })).toBeUndefined()
  const commented = '# previously derived empty root\n[]\n'
  writeFileSync(rootFile, commented)
  expect(() => { assertPreparedProfileRootConfig(path) }).toThrow('already sealed canonical root')
  expect(readFileSync(rootFile, 'utf8')).toBe(commented)
  writeFileSync(rootFile, PROFILE_ROOT_CONFIG)
  expect(() => { assertPreparedProfileRootConfig(path) }).not.toThrow()
  expect(readFileSync(rootFile, 'utf8')).toBe(PROFILE_ROOT_CONFIG)
  expect(readFileSync(patchFile, 'utf8')).toBe('- id: preserve-user\n  disabled: true\n')
})

it('refuses an unrecognized nonempty candidate root without overwriting it', () => {
  const path = root()
  const unknown = '- id: user-written-root\n  name: custom-module\n'
  writeFileSync(join(path, 'cordis.yml'), unknown)
  expect(() => { prepareProfileRootConfig(path) }).toThrow('explicit migration')
  expect(readFileSync(join(path, 'cordis.yml'), 'utf8')).toBe(unknown)
})

it.each(['directory', 'linked-directory', 'oversized-file'] as const)('refuses an unsupported %s root without changing user data', (kind) => {
  const path = root()
  const rootFile = join(path, 'cordis.yml')
  const patch = '- id: preserve-user\n  disabled: true\n'
  writeFileSync(join(path, 'cordis.patch.yml'), patch)
  const oversized = `#${'x'.repeat(64 * 1024 - 3)}\n[]`
  let marker = join(rootFile, 'preserve')
  if (kind === 'directory') {
    mkdirSync(rootFile)
    writeFileSync(marker, 'untouched')
  } else if (kind === 'linked-directory') {
    const target = join(path, 'linked-target')
    mkdirSync(target)
    marker = join(target, 'preserve')
    writeFileSync(marker, 'untouched')
    symlinkSync(target, rootFile, process.platform === 'win32' ? 'junction' : 'dir')
  } else {
    expect(Buffer.byteLength(oversized)).toBe(64 * 1024 + 1)
    writeFileSync(rootFile, oversized)
  }
  expect(() => { prepareProfileRootConfig(path) }).toThrow('unsupported root file')
  expect(readFileSync(join(path, 'cordis.patch.yml'), 'utf8')).toBe(patch)
  if (kind === 'oversized-file') expect(readFileSync(rootFile, 'utf8')).toBe(oversized)
  else {
    expect(readFileSync(marker, 'utf8')).toBe('untouched')
    expect(lstatSync(rootFile).isSymbolicLink()).toBe(kind === 'linked-directory')
    expect(lstatSync(rootFile).isDirectory()).toBe(kind === 'directory')
  }
})

it('accepts a supported commented root at exactly the 64 KiB byte limit', () => {
  const path = root()
  const content = `#${'x'.repeat(64 * 1024 - 4)}\n[]`
  expect(Buffer.byteLength(content)).toBe(64 * 1024)
  writeFileSync(join(path, 'cordis.yml'), content)
  prepareProfileRootConfig(path)
  expect(readFileSync(join(path, 'cordis.yml'), 'utf8')).toBe(PROFILE_ROOT_CONFIG)
})

it('writes identical bytes when the official launcher boots a promoted fresh candidate', () => {
  const candidate = root()
  prepareProfileRootConfig(candidate)
  const before = readFileSync(join(candidate, 'cordis.yml'))
  const active = `${candidate}-active`
  roots.push(active)
  renameSync(candidate, active)
  writeProfileRootConfig(active)
  expect(readFileSync(join(active, 'cordis.yml'))).toEqual(before)
})
