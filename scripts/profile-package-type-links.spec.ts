import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { FOUNDATION_TYPE_NAMES, LINK_MAP, SERVICE_PAGE, TYPE_LINK_EXEMPTIONS } from './gen-cordis-catalog.ts'

it('assigns the launcher staging service to the boot subsystem', () => {
  expect(SERVICE_PAGE.profilePackageTransactions).toBe('boot.md')
})

it.each(['ProfilePackageMutation', 'ProfilePreparedPackageChange', 'ProfileVerifiedReleaseSource'])(
  'links %s to authored boot documentation instead of exempting it', (name) => {
    expect(LINK_MAP[name]).toBe('boot.md')
    expect(FOUNDATION_TYPE_NAMES.has(name)).toBe(false)
    expect(Object.hasOwn(TYPE_LINK_EXEMPTIONS, name)).toBe(false)
    for (const page of ['boot.md', 'boot.zh.md']) {
      const source = readFileSync(new URL(`../docs/subsystems/${page}`, import.meta.url), 'utf8')
      const authored = source.split('<!-- BEGIN GENERATED cordis-surface')[0]
      expect(authored).toContain(`\`${name}\``)
    }
  },
)
