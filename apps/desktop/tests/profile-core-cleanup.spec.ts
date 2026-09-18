import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync,
  rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { cleanProfileCorePackages } from '../src/profile-core-cleanup.ts'

const roots: string[] = []
const links: string[] = []
const core = '@deepseek-ai/dsh-web-app'
const extra = '@deepseek-ai/optional-plugin'

function fixture(locked = true): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-core-cleanup-'))
  roots.push(root)
  mkdirSync(join(root, 'node_modules', core), { recursive: true })
  mkdirSync(join(root, 'node_modules', extra), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    dependencies: { [core]: 'file:./desktop-packages/web.tgz', [extra]: '1.0.0' },
    optionalDependencies: { [core]: '1.0.0' },
    pnpm: { overrides: { [core]: '1.0.0', third: '2.0.0' } },
    dsh: { profile: { bundles: [core, extra] } },
  }))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), `nodeLinker: hoisted\noverrides:\n  '${core}': file:./desktop-packages/web.tgz\n  third: 2.0.0\n`)
  if (locked) writeFileSync(join(root, 'pnpm-lock.yaml'), 'old resolutions\n')
  writeFileSync(join(root, 'cordis.patch.yml'), '[]\n')
  return root
}

function link(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  links.push(path)
}

/** Capture fixture names, file bytes and link targets without traversing links. */
function snapshot(root: string): Record<string, string> {
  const entries: Record<string, string> = {}
  function visit(path: string, relative: string): void {
    const entry = lstatSync(path)
    if (entry.isSymbolicLink()) entries[relative] = `link:${readlinkSync(path)}`
    else if (entry.isDirectory()) {
      entries[relative] = 'directory'
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${relative}/${name}`)
    } else entries[relative] = `file:${readFileSync(path).toString('base64')}`
  }
  visit(root, '.')
  return entries
}

function recordPackages(root: string, names: readonly string[]): void {
  writeFileSync(join(root, 'desktop-packages.json'), JSON.stringify({ schemaVersion: 1, packages: [...names].sort().map((name, index) => ({
    name, version: '0.1.2', file: `${index}.tgz`, bytes: 1, integrity: 'sha512-YQ==',
  })) }))
}

function refusesUnchanged(root: string, names: readonly string[] = [core]): void {
  const before = snapshot(root)
  expect(() => { cleanProfileCorePackages(root, names, true) }).toThrow('lock-preserving migration is required')
  expect(snapshot(root)).toEqual(before)
}

afterEach(() => {
  for (const path of links.splice(0).reverse()) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(path)
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

it('removes core packages without a frozen lock while preserving optional plugins and configuration', () => {
  const root = fixture(false)
  cleanProfileCorePackages(root, [core], true)
  expect(existsSync(join(root, 'node_modules', core))).toBe(false)
  expect(existsSync(join(root, 'node_modules', extra))).toBe(true)
  expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toEqual({
    dependencies: { [extra]: '1.0.0' }, optionalDependencies: {},
    pnpm: { overrides: { third: '2.0.0' } }, dsh: { profile: { bundles: [core, extra] } },
  })
  expect(load(readFileSync(join(root, 'pnpm-workspace.yaml'), 'utf8'))).toEqual({ nodeLinker: 'hoisted', overrides: { third: '2.0.0' } })
  expect(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
  expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(false)
  writeFileSync(join(root, 'pnpm-lock.yaml'), 'new plugin resolutions\n')
  cleanProfileCorePackages(root, [core], true)
  expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe('new plugin resolutions\n')
})

it('does not clean development profiles', () => {
  const root = fixture()
  const before = readFileSync(join(root, 'package.json'), 'utf8')
  cleanProfileCorePackages(root, [core], false)
  expect(existsSync(join(root, 'node_modules', core))).toBe(true)
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
  expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(true)
})

it('unlinks development fallbacks without deleting their target, including dangling links', () => {
  const root = fixture(false)
  const target = join(root, 'development-package')
  mkdirSync(target)
  writeFileSync(join(target, 'sentinel'), 'keep')
  const owned = join(root, '.dsh-module-fallback', 'node_modules', core)
  mkdirSync(join(owned, '..'), { recursive: true })
  link(target, owned)
  rmSync(join(root, 'node_modules', core), { recursive: true })
  link(owned, join(root, 'node_modules', core))
  cleanProfileCorePackages(root, [core], true)
  expect(readFileSync(join(target, 'sentinel'), 'utf8')).toBe('keep')
  expect(existsSync(owned)).toBe(false)
  link(target, join(root, 'node_modules', core))
  rmSync(target, { recursive: true })
  cleanProfileCorePackages(root, [core], true)
  expect(() => lstatSync(join(root, 'node_modules', core))).toThrow()
})

it('uses the old package inventory to remove retired core names', () => {
  const root = fixture(false)
  recordPackages(root, ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host', core])
  cleanProfileCorePackages(root, [], true)
  expect(existsSync(join(root, 'node_modules', core))).toBe(false)
  expect(existsSync(join(root, 'node_modules', extra))).toBe(true)
})

it('rejects invalid metadata before deleting packages or declarations', () => {
  const root = fixture()
  writeFileSync(join(root, 'desktop-packages.json'), '{"schemaVersion":1,"packages":[{"name":"../../outside"}]}')
  const before = readFileSync(join(root, 'package.json'), 'utf8')
  expect(() => { cleanProfileCorePackages(root, [core], true) }).toThrow('invalid package record')
  expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(before)
  expect(existsSync(join(root, 'node_modules', core))).toBe(true)
})

it('refuses redirected package parents without deleting their contents', () => {
  const root = fixture()
  const target = join(root, 'external-scope')
  mkdirSync(join(target, 'dsh-web-app'), { recursive: true })
  rmSync(join(root, 'node_modules', '@deepseek-ai'), { recursive: true })
  link(target, join(root, 'node_modules', '@deepseek-ai'))
  expect(() => { cleanProfileCorePackages(root, [core], true) }).toThrow('not a real directory')
  expect(existsSync(join(target, 'dsh-web-app'))).toBe(true)
})

it('refuses locked external roots before changing any active profile resource', () => {
  const root = fixture()
  writeFileSync(join(root, 'node_modules', core, 'index.js'), 'core bytes\n')
  writeFileSync(join(root, 'node_modules', extra, 'index.js'), 'plugin bytes\n')
  mkdirSync(join(root, 'desktop-packages'))
  writeFileSync(join(root, 'desktop-packages', 'web.tgz'), Buffer.from([0, 1, 2, 255]))
  writeFileSync(join(root, 'pnpm-lock.yaml'), `lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      '${extra}':\n        specifier: 1.0.0\n        version: 1.0.0\n`)
  refusesUnchanged(root)
})

it.each(['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'])(
  'treats retained %s as external roots rather than guessing from their package scope', (field) => {
    const root = fixture()
    writeFileSync(join(root, 'package.json'), JSON.stringify({
      dependencies: { [core]: '1.0.0' },
      [field]: { ...(field === 'dependencies' ? { [core]: '1.0.0' } : {}), [extra]: '1.0.0' },
    }))
    refusesUnchanged(root)
  },
)

it.each(['manifest', 'workspace', 'package', 'fallback'])('refuses when only %s core residue remains', (residue) => {
  const root = fixture()
  rmSync(join(root, 'node_modules', core), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: {
    [extra]: '1.0.0', ...(residue === 'manifest' ? { [core]: '1.0.0' } : {}),
  } }))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), residue === 'workspace'
    ? `overrides:\n  '${core}': 1.0.0\n` : 'nodeLinker: hoisted\n')
  if (residue === 'package') mkdirSync(join(root, 'node_modules', core))
  if (residue === 'fallback') {
    const path = join(root, '.dsh-module-fallback', 'node_modules', core)
    mkdirSync(join(path, '..'), { recursive: true })
    link(join(root, 'missing-core-target'), path)
  }
  refusesUnchanged(root)
})

it('leaves a locked runtime-mode external profile without core residue byte-identical', () => {
  const root = fixture()
  rmSync(join(root, 'node_modules', core), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    dependencies: { [extra]: '1.0.0' }, dsh: { profile: { bundles: [core, extra] } },
  }))
  writeFileSync(join(root, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\n')
  const before = snapshot(root)
  cleanProfileCorePackages(root, [core], true)
  expect(snapshot(root)).toEqual(before)
})

it('cleans a locked core-only profile without retaining unrelated dependency roots', () => {
  const root = fixture()
  rmSync(join(root, 'node_modules', extra), { recursive: true })
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [core]: '1.0.0' } }))
  cleanProfileCorePackages(root, [core], true)
  expect(existsSync(join(root, 'node_modules', core))).toBe(false)
  expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(false)
  expect(JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))).toEqual({ dependencies: {} })
  expect(readFileSync(join(root, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
})

it('recognizes retired managed dependency roots only through the recorded package inventory', () => {
  const root = fixture()
  recordPackages(root, ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host', core, extra])
  cleanProfileCorePackages(root, [], true)
  expect(existsSync(join(root, 'node_modules', core))).toBe(false)
  expect(existsSync(join(root, 'node_modules', extra))).toBe(false)
  expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(false)
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { dependencies: unknown }
  expect(manifest.dependencies).toEqual({})
})

it('refuses retired core cleanup that would invalidate a retained external root lock', () => {
  const root = fixture()
  recordPackages(root, ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host', core])
  refusesUnchanged(root, [])
})

it('refuses ambiguous retained roots when a locked profile has no manifest', () => {
  const root = fixture()
  unlinkSync(join(root, 'package.json'))
  refusesUnchanged(root)
})

it('rejects malformed dependency metadata before changing the active profile', () => {
  const root = fixture()
  writeFileSync(join(root, 'package.json'), JSON.stringify({ dependencies: { [core]: '1.0.0' }, optionalDependencies: null }))
  const before = snapshot(root)
  expect(() => { cleanProfileCorePackages(root, [core], true) }).toThrow('expected an object')
  expect(snapshot(root)).toEqual(before)
})
