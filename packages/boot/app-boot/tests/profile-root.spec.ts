import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { prepareProfileRootConfig, PROFILE_ROOT_CONFIG, writeProfileRootConfig } from '../src/profile-root.ts'

const roots: string[] = []
afterEach(() => { for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true }) })
function root() { const path = mkdtempSync(join(tmpdir(), 'dsh-profile-root-')); roots.push(path); return path }

it.each([undefined, '[]\n', '# old empty derived root\r\n[]\r\n', PROFILE_ROOT_CONFIG])('prepares supported empty roots without changing the user patch (%s)', value => {
  const path = root()
  if (value !== undefined) writeFileSync(join(path, 'cordis.yml'), value)
  writeFileSync(join(path, 'cordis.patch.yml'), '- id: preserve-user\n  disabled: true\n')
  prepareProfileRootConfig(path)
  expect(readFileSync(join(path, 'cordis.yml'), 'utf8')).toBe(PROFILE_ROOT_CONFIG)
  expect(readFileSync(join(path, 'cordis.patch.yml'), 'utf8')).toBe('- id: preserve-user\n  disabled: true\n')
})

it('refuses an unrecognized nonempty candidate root without overwriting it', () => {
  const path = root()
  const unknown = '- id: user-written-root\n  name: custom-module\n'
  writeFileSync(join(path, 'cordis.yml'), unknown)
  expect(() => prepareProfileRootConfig(path)).toThrow('explicit migration')
  expect(readFileSync(join(path, 'cordis.yml'), 'utf8')).toBe(unknown)
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
