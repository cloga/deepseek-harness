import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { assertNoLegacyDesktopActivation } from '../src/legacy-profile-activation.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { legacyActivationFixture, retainedTree } from './legacy-activation-fixture.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture(active = false) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'legacy-activation-refusal-')))
  roots.push(root)
  const paths = resolveDesktopPaths(join(root, 'home'))
  if (active) {
    mkdirSync(paths.profile, { recursive: true })
    writeFileSync(join(paths.profile, 'package.json'), '{"dependencies":{"kept-plugin":"1.0.0"}}\n')
    writeFileSync(join(paths.profile, 'cordis.patch.yml'), 'retain original patch bytes\n')
  }
  return { root, paths }
}
function unchangedRefusal(f: ReturnType<typeof fixture>, reason = 'desktop legacy activation') {
  const before = retainedTree(f.root)
  expect(() => { assertNoLegacyDesktopActivation(f.paths) }).toThrow(reason)
  expect(retainedTree(f.root)).toEqual(before)
}

describe.each([false, true])('legacy activation with active profile present=%s', (active) => {
  it.each(([1, 2] as const).flatMap(schema => (['activating', 'committed'] as const).map(phase => ({ schema, phase }))))(
    'refuses synthetic released schema$schema/$phase without parsing or replacing bytes', ({ schema, phase }) => {
      const f = fixture(active)
      mkdirSync(f.paths.legacyStateRoot, { recursive: true })
      writeFileSync(join(f.paths.legacyStateRoot, 'profile-activation.json'), legacyActivationFixture(schema, phase))
      unchangedRefusal(f, 'profile-activation.json')
    },
  )
  it.each(['invalid JSON', '{"schemaVersion":999}', '{"transaction":"../../outside","phase":"activating"}', ''])(
    'refuses any fixed journal bytes: %j', (bytes) => {
      const f = fixture(active)
      mkdirSync(f.paths.legacyStateRoot, { recursive: true })
      writeFileSync(join(f.paths.legacyStateRoot, 'profile-activation.json'), bytes)
      unchangedRefusal(f)
    },
  )
  it.each(['directory', 'file-link', 'dangling-link', 'directory-link'] as const)('refuses a %s journal without following it', (kind) => {
    const f = fixture(active)
    mkdirSync(f.paths.legacyStateRoot, { recursive: true })
    const journal = join(f.paths.legacyStateRoot, 'profile-activation.json')
    const target = join(f.root, 'unrelated-target')
    if (kind === 'directory') mkdirSync(journal)
    else if (kind === 'directory-link') {
      mkdirSync(target)
      symlinkSync(target, journal, process.platform === 'win32' ? 'junction' : 'dir')
    } else {
      if (kind === 'file-link') writeFileSync(target, 'foreign bytes')
      symlinkSync(target, journal, 'file')
    }
    unchangedRefusal(f)
  })
  it.each(['directory', 'file', 'link', 'dangling-link'] as const)('refuses orphan rollback %s with no journal', (kind) => {
    const f = fixture(active)
    const transaction = join(dirname(f.paths.profile), '.desktop-transaction-Ab12Cd')
    mkdirSync(transaction, { recursive: true })
    const rollback = join(transaction, 'rollback')
    const target = join(f.root, 'rollback-target')
    if (kind === 'directory') {
      mkdirSync(rollback)
      writeFileSync(join(rollback, 'package.json'), 'retained previous inventory')
    } else if (kind === 'file') writeFileSync(rollback, 'malformed rollback bytes')
    else {
      if (kind === 'link') writeFileSync(target, 'foreign rollback bytes')
      symlinkSync(target, rollback, 'file')
    }
    unchangedRefusal(f, 'orphan alpha1 rollback')
  })
})

it.each(['.desktop-transaction-', '.desktop-transaction-Ab_12', '.DESKTOP-TRANSACTION-Ab12', '.desktop-transaction-Ab12.json'])(
  'refuses ambiguous old namespace entry %s without guessing ownership', (name) => {
    const f = fixture()
    mkdirSync(join(dirname(f.paths.profile), name), { recursive: true })
    unchangedRefusal(f, 'ambiguous')
  },
)
it.each(['file', 'link', 'dangling-link'] as const)('refuses an old transaction with %s shape', (kind) => {
  const f = fixture()
  mkdirSync(dirname(f.paths.profile), { recursive: true })
  const transaction = join(dirname(f.paths.profile), '.desktop-transaction-Ab12')
  const target = join(f.root, 'transaction-target')
  if (kind === 'file') writeFileSync(transaction, 'not a directory')
  else {
    if (kind === 'link') mkdirSync(target)
    symlinkSync(target, transaction, process.platform === 'win32' ? 'junction' : 'dir')
  }
  unchangedRefusal(f, 'real directory')
})
it.each(['profile-parent', 'legacy-root', 'home'] as const)('refuses linked %s before following any child path', (part) => {
  const f = fixture()
  const target = join(f.root, 'target')
  mkdirSync(target)
  writeFileSync(join(target, 'sentinel'), 'retain outside bytes')
  const link = part === 'profile-parent' ? dirname(f.paths.profile) : part === 'legacy-root' ? f.paths.legacyStateRoot : dirname(f.paths.legacyStateRoot)
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  unchangedRefusal(f, 'real directory')
})
it.each(['transaction-count', 'parent-count'] as const)('fails closed at the %s bound without reclaiming entries', (kind) => {
  const f = fixture()
  const parent = dirname(f.paths.profile)
  mkdirSync(parent, { recursive: true })
  const count = kind === 'transaction-count' ? 101 : 1025
  for (let index = 0; index < count; index++) {
    if (kind === 'transaction-count') mkdirSync(join(parent, `.desktop-transaction-A${index}`))
    else writeFileSync(join(parent, `unrelated-${index}`), '')
  }
  unchangedRefusal(f, kind === 'transaction-count' ? 'too many' : 'bounded inspection limit')
})
it('admits the exact finite scan bounds without reclaiming valid staging-only directories', () => {
  const f = fixture()
  const parent = dirname(f.paths.profile)
  mkdirSync(parent, { recursive: true })
  for (let index = 0; index < 100; index++) mkdirSync(join(parent, `.desktop-transaction-A${index}`))
  for (let index = 100; index < 1024; index++) writeFileSync(join(parent, `unrelated-${index}`), '')
  const before = retainedTree(f.root)
  expect(() => { assertNoLegacyDesktopActivation(f.paths) }).not.toThrow()
  expect(retainedTree(f.root)).toEqual(before)
})
it.each([false, true])('keeps absent evidence, harmless old staging and current transactions unchanged (active=%s)', (active) => {
  const f = fixture(active)
  const before = retainedTree(f.root)
  expect(() => { assertNoLegacyDesktopActivation(f.paths) }).not.toThrow()
  expect(retainedTree(f.root)).toEqual(before)
  const parent = dirname(f.paths.profile)
  const staging = join(parent, '.desktop-transaction-Ab12', 'staging')
  mkdirSync(staging, { recursive: true })
  writeFileSync(join(staging, 'package.json'), 'do not reclaim old staging')
  const current = join(parent, '.desktop.package-stage-12345678-1234-1234-1234-123456789abc')
  mkdirSync(join(current, 'rollback'), { recursive: true })
  writeFileSync(join(current, 'ACTIVATION.json'), 'handled only by the existing current-format scanner')
  const retained = retainedTree(f.root)
  expect(() => { assertNoLegacyDesktopActivation(f.paths) }).not.toThrow()
  expect(retainedTree(f.root)).toEqual(retained)
})
it('uses the explicitly supplied home instead of the current process home', () => {
  const f = fixture()
  expect(f.paths.legacyStateRoot).toBe(join(f.root, 'home', 'desktop'))
  expect(f.paths.profile).toBe(join(f.root, 'home', 'profiles', 'desktop'))
  expect(() => { assertNoLegacyDesktopActivation({ ...f.paths, legacyStateRoot: 'relative' }) }).toThrow('absolute')
})
