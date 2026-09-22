/** Qualification reads actual profile layers but never executes candidate package code. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { assertDesktopPackageHealth, qualifyDesktopPackageProfile } from '../src/profile-package-qualification.ts'
import type { DesktopPreparedPackageActivation } from '../src/profile-package-staging.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-package-qualification-'))
  roots.push(root)
  const runtimeDir = join(root, 'runtime')
  runtimeFixture(runtimeDir)
  const candidate = join(root, 'candidate')
  const addon = writePackage(join(candidate, 'node_modules'), 'addon', { dsh: { bundle: { patch: './bundle.yml' } } },
    'throw new Error("qualification must not execute package code")\n')
  writeFileSync(join(addon, 'bundle.yml'), '- insert:\n    - id: addon\n      name: addon\n')
  writeFileSync(join(candidate, 'package.json'), JSON.stringify({ private: true, dependencies: { addon: '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'addon'] } } }))
  writeFileSync(join(candidate, 'cordis.patch.yml'), '[]\n')
  const home = join(root, 'home')
  mkdirSync(home)
  const globalPatch = join(home, 'cordis.patch.yml')
  const input: DesktopPreparedPackageActivation = {
    transactionDir: root, candidateDir: candidate, rollbackDir: join(root, 'rollback'),
    baseGraphFingerprint: 'a'.repeat(64), candidateFingerprint: 'b'.repeat(64), intentFingerprint: 'e'.repeat(64),
    owner: { profile: candidate, runtimeDir, installAnchor: join(runtimeDir, 'node_modules/@deepseek-ai/dsh/package.json'),
      runtimeFingerprint: 'c'.repeat(64), dependencyRegistry: 'https://registry.example.test/', configPaths: [globalPatch] },
    mutation: { kind: 'install', source: { schemaVersion: 1, type: 'packageSpec', spec: 'fixture.tgz' } },
    prepared: { transactionId: '11111111-1111-4111-8111-111111111111', state: 'prepared', packageName: 'addon', baseFingerprint: 'd'.repeat(64), health: 'pending' },
  }
  return { input, candidate, globalPatch }
}

it('qualifies selected layers without importing their executable entry points', () => {
  const f = fixture()
  expect(qualifyDesktopPackageProfile(f.input, f.candidate)).toEqual([
    { name: '@deepseek-ai/dsh-base', version: '1.0.0' }, { name: 'addon', version: '1.0.0' },
  ])
})

it('refuses nested Include configuration that is not represented by the sealed graph', () => {
  const f = fixture()
  writeFileSync(f.globalPatch, '- insert:\n    - id: outside\n      name: cordis:include\n      config:\n        url: ./untracked.yml\n')
  expect(() => qualifyDesktopPackageProfile(f.input, f.candidate)).toThrow('nested Include')
})

it('requires real matching enabled and healthy bundle observations with no extra selections', () => {
  const expected = [{ name: 'addon', version: '1.0.0' }]
  const good = { ...expected[0]!, enabled: true, healthy: true }
  expect(() => { assertDesktopPackageHealth(expected, [good]) }).not.toThrow()
  expect(() => { assertDesktopPackageHealth(expected, undefined) }).toThrow('did not report')
  expect(() => { assertDesktopPackageHealth(expected, [{ ...good, healthy: false }]) }).toThrow('does not match')
  expect(() => { assertDesktopPackageHealth(expected, [{ ...good, enabled: false }]) }).toThrow('does not match')
  expect(() => { assertDesktopPackageHealth(expected, [{ ...good, version: '2.0.0' }]) }).toThrow('does not match')
  expect(() => { assertDesktopPackageHealth(expected, [good, good]) }).toThrow('duplicate')
  expect(() => { assertDesktopPackageHealth(expected, [good, { ...good, name: 'unexpected' }]) }).toThrow('unexpected bundles')
})
