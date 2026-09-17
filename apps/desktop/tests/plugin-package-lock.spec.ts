import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  desktopPackageArtifactSpecifier,
  readDesktopPackageLocks,
  verifyDesktopPackageArtifact,
  writeDesktopPackageLocks,
  type DesktopPackageInstallLock,
} from '../src/plugin-package-lock.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(): { root: string; lock: DesktopPackageInstallLock; artifact: string } {
  const root = mkdtempSync(join(tmpdir(), 'desktop-package-lock-'))
  roots.push(root)
  const bytes = Buffer.from('immutable package fixture')
  const lock: DesktopPackageInstallLock = {
    packageName: 'actual-plugin-name', version: '0.1.0', spec: 'github:example/different-repository#main',
    resolved: `https://github.com/example/different-repository#${'a'.repeat(40)}`, commit: 'a'.repeat(40),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`,
  }
  mkdirSync(join(root, '.desktop-plugin-artifacts'))
  const artifact = join(root, '.desktop-plugin-artifacts', `${lock.sha256}.tgz`)
  writeFileSync(artifact, bytes)
  return { root, lock, artifact }
}

it('round-trips immutable source identity separately from declared package version', () => {
  const { root, lock } = fixture()
  expect(readDesktopPackageLocks(root)).toEqual({})
  writeDesktopPackageLocks(root, { [lock.packageName]: lock })
  expect(readDesktopPackageLocks(root)).toEqual({ [lock.packageName]: lock })
  expect(desktopPackageArtifactSpecifier(lock)).toBe(`file:.desktop-plugin-artifacts/${lock.sha256}.tgz`)
  expect(() => { verifyDesktopPackageArtifact(root, lock) }).not.toThrow()
  const serialized = readFileSync(join(root, 'desktop-plugin-package-locks.json'), 'utf8')
  expect(serialized).not.toContain('"verified"')
  expect(serialized.endsWith('\n')).toBe(true)
})

it('does not confuse prototype property names with installed source packages', () => {
  const { root, lock } = fixture()
  expect(readDesktopPackageLocks(root).constructor).toBeUndefined()
  const named = { ...lock, packageName: 'constructor' }
  writeDesktopPackageLocks(root, { constructor: named })
  expect(readDesktopPackageLocks(root).constructor).toEqual(named)
  expect(Object.getPrototypeOf(readDesktopPackageLocks(root))).toBeNull()
})

it('round-trips a local package snapshot without inventing GitHub attestation', () => {
  const { root, lock } = fixture()
  const { commit: _commit, ...local } = lock
  const value = { ...local, spec: 'file:./plugin', resolved: 'file:/private/plugin' }
  writeDesktopPackageLocks(root, { [value.packageName]: value })
  expect(readDesktopPackageLocks(root)[value.packageName]).toEqual(value)
})

it.each([
  { packageName: '../escape' }, { version: '^0.1.0' }, { spec: '' }, { spec: 'hello\nworld' },
  { resolved: '' }, { resolved: 'hello\u0000world' }, { commit: 'main' }, { sha256: '../escape' },
  { integrity: 'sha512-not-base64' }, { states: { verified: true } },
])('rejects malformed or misleading durable source metadata %j', (patch) => {
  const { root, lock } = fixture()
  writeFileSync(join(root, 'desktop-plugin-package-locks.json'), JSON.stringify({
    schemaVersion: 1, packages: { [lock.packageName]: { ...lock, ...patch } },
  }))
  expect(() => readDesktopPackageLocks(root)).toThrow(/invalid/u)
})

it.each([
  { schemaVersion: 2, packages: {} }, { schemaVersion: 1, packages: [] },
  { schemaVersion: 1, packages: {}, verified: true }, [], null,
])('rejects invalid store envelope %j', (value) => {
  const { root } = fixture()
  writeFileSync(join(root, 'desktop-plugin-package-locks.json'), JSON.stringify(value))
  expect(() => readDesktopPackageLocks(root)).toThrow('invalid source lock store')
})

it('detects snapshot corruption before reinstall and rejects an absent artifact', () => {
  const { root, lock, artifact } = fixture()
  writeFileSync(artifact, 'tampered package')
  expect(() => { verifyDesktopPackageArtifact(root, lock) }).toThrow('snapshot integrity mismatch')
  rmSync(artifact)
  expect(() => { verifyDesktopPackageArtifact(root, lock) }).toThrow('missing regular snapshot')
})

it('does not trust a matching SHA-256 when the recorded SHA-512 differs', () => {
  const { root, lock } = fixture()
  const changed = { ...lock, integrity: `sha512-${createHash('sha512').update('other').digest('base64')}` }
  expect(() => { verifyDesktopPackageArtifact(root, changed) }).toThrow('snapshot integrity mismatch')
})

it('rejects a linked artifact directory without following it', () => {
  const { root, lock } = fixture()
  const external = mkdtempSync(join(tmpdir(), 'desktop-package-external-'))
  roots.push(external)
  const directory = join(root, '.desktop-plugin-artifacts')
  rmSync(directory, { recursive: true })
  symlinkSync(external, directory, 'junction')
  expect(() => { verifyDesktopPackageArtifact(root, lock) }).toThrow('missing regular snapshot')
})
