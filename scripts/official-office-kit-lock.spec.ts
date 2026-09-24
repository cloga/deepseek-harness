/** Pin the independent Office kit and both Windows native engines without registry workarounds. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as yaml from 'js-yaml'
import { expect, it } from 'vitest'

interface LockPackage { resolution: { integrity: string } }
interface LockEntry { specifier: string; version: string }
interface OfficeLock {
  importers: Record<string, { dependencies: Record<string, LockEntry> }>
  packages: Record<string, LockPackage>
  snapshots: Record<string, { optionalDependencies?: Record<string, string> }>
}

it('pins the official kit 0.0.1 and exactly declared Windows engine archives', () => {
  const lock = yaml.load(readFileSync(resolve(import.meta.dirname, '..', 'pnpm-lock.yaml'), 'utf8')) as OfficeLock
  const kit = '@deepseek-ai/libreoffice-kit@0.0.1'
  const winX64 = '@deepseek-ai/libreoffice-kit-win32-x64@0.0.1'
  const winArm64 = '@deepseek-ai/libreoffice-kit-win32-arm64@0.0.1'
  expect(lock.importers['packages/document/office-to-pdf']?.dependencies['@deepseek-ai/libreoffice-kit'])
    .toEqual({ specifier: '0.0.1', version: '0.0.1' })
  expect(lock.packages[kit]?.resolution.integrity)
    .toBe('sha512-e4JZqohz5TEVfI3sfUK/dHRLjqlQep96CmqNM93Rm7LY9PuECiJakIX2BdHi5OkmbK9Mo47SiW44HNTTiwW1yw==')
  expect(lock.packages[winX64]?.resolution.integrity)
    .toBe('sha512-+DPPT5V6rfwWfMf7scfgzxwNBQiuePdY4dmVvWb4QAINgquOXUAyWVNZaThWNCO8baRn1l4fb3L5sdbLWib3zQ==')
  expect(lock.packages[winArm64]?.resolution.integrity)
    .toBe('sha512-9G7YxXHEFaVn5iFM6IaHusWuXAd3cEprwTYSA1OsYMUREliHzdcmJEqcEyePDpX1y39KNKWQgowYeSpFbfrbgg==')
  expect(lock.snapshots[kit]?.optionalDependencies).toMatchObject({
    '@deepseek-ai/libreoffice-kit-win32-x64': '0.0.1',
    '@deepseek-ai/libreoffice-kit-win32-arm64': '0.0.1',
  })
  expect(lock.snapshots[winX64]).toMatchObject({ optional: true })
  expect(lock.snapshots[winArm64]).toMatchObject({ optional: true })
})
