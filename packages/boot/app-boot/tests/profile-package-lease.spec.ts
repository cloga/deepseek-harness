import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { profilePackageLeaseTarget, withProfilePackageLease } from '../src/profile-package-transactions.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function profile() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-lease-'))
  roots.push(root)
  const active = join(root, 'desktop')
  mkdirSync(active)
  return { root, active }
}

it('keeps the same lease while the active directory is replaced and releases it after completion', async () => {
  const { root, active } = profile()
  const lease = profilePackageLeaseTarget(active)
  await withProfilePackageLease(active, async () => {
    expect(existsSync(`${lease}.lock`)).toBe(true)
    renameSync(active, join(root, 'rollback'))
    expect(profilePackageLeaseTarget(active)).toBe(lease)
    mkdirSync(active)
    expect(profilePackageLeaseTarget(active)).toBe(lease)
    expect(existsSync(`${lease}.lock`)).toBe(true)
  })
  expect(existsSync(`${lease}.lock`)).toBe(false)
})

it.skipIf(process.platform !== 'win32')('maps Windows casing aliases to the same sibling lock', () => {
  const { active } = profile()
  expect(profilePackageLeaseTarget(active.toUpperCase())).toBe(profilePackageLeaseTarget(active))
})

it('rejects a linked activation target rather than locking an alias', () => {
  const { root, active } = profile()
  const link = join(root, 'alias')
  symlinkSync(active, link, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => profilePackageLeaseTarget(link)).toThrow('real directory')
})

it('does not enter a mutation for an already cancelled request', async () => {
  const { active } = profile()
  const abort = new AbortController()
  abort.abort(new Error('cancelled'))
  let entered = false
  await expect(Promise.resolve().then(() => withProfilePackageLease(active, async () => { entered = true }, 1000, abort.signal)))
    .rejects.toThrow('cancelled')
  expect(entered).toBe(false)
})
