import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { sanitizeProfile } from '../src/profile-sanitize.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function profile(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-sanitize-profile-'))
  roots.push(root)
  const path = join(root, 'profile')
  mkdirSync(path)
  return path
}

it('backs up the patch and changes only the caller-selected bundles after owned shutdown', () => {
  const path = profile()
  const patch = join(path, 'cordis.patch.yml')
  writeFileSync(patch, '[]\n')
  writeFileSync(join(path, 'package.json'), JSON.stringify({
    name: 'preserved-profile', private: true, custom: { keep: true },
    dependencies: { 'installed-addon': '1.0.0' },
    dsh: { profile: { bundles: ['installed-addon'], reload: 'manual' } },
  }))
  const backup = sanitizeProfile('test', path, ['disabled-by-recovery'])
  expect(backup).toMatch(/cordis\.patch\.yml\.bak-\d+(?:-\d+)?$/u)
  if (backup === undefined) throw new Error('Expected owned patch backup')
  expect(readFileSync(backup, 'utf8')).toBe('[]\n')
  expect(existsSync(patch)).toBe(false)
  expect(JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))).toEqual({
    name: 'preserved-profile', private: true, custom: { keep: true },
    dependencies: { 'installed-addon': '1.0.0' },
    dsh: { profile: { bundles: ['disabled-by-recovery'], reload: 'manual' } },
  })
})

it('keeps a missing patch absent while updating an existing profile', () => {
  const path = profile()
  writeFileSync(join(path, 'package.json'), JSON.stringify({ dependencies: {}, dsh: { profile: { bundles: ['old'] } } }))
  expect(sanitizeProfile('test', path, [])).toBeUndefined()
  expect(JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).dsh.profile.bundles).toEqual([])
  expect(existsSync(join(path, 'cordis.patch.yml'))).toBe(false)
})

it('refuses a malformed manifest before moving the only patch', () => {
  const path = profile()
  const patch = join(path, 'cordis.patch.yml')
  writeFileSync(patch, '[]\n')
  writeFileSync(join(path, 'package.json'), 'not JSON')
  expect(() => sanitizeProfile('test', path, [])).toThrow()
  expect(readFileSync(patch, 'utf8')).toBe('[]\n')
})
