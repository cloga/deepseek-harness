/** Native shell copies user metadata into a private candidate without opening linked paths. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { profileMetadataFingerprint, snapshotDesktopProfileMetadata } from '../src/profile-package-snapshot.ts'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-stage-snapshot-'))
  roots.push(root)
  const active = join(root, 'desktop')
  const transaction = join(root, `.desktop-transaction-${'a'.repeat(32)}`)
  mkdirSync(active)
  mkdirSync(transaction)
  return { root, active, transaction, staging: join(transaction, 'staging') }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('copies manual choices, patch and receipt bytes without touching active or materializing node_modules', () => {
  const { active, transaction, staging } = fixture()
  const manifest = '{"dependencies":{"@cloga/my-plugin":"1.2.3"}}\n'
  const selection = '- id: @cloga/my-plugin\n  disabled: true\n'
  const receipt = '{"sha256":"source-bound-receipt"}\n'
  writeFileSync(join(active, 'package.json'), manifest)
  writeFileSync(join(active, 'cordis.patch.yml'), selection)
  writeFileSync(join(active, 'desktop-plugin-receipts.json'), receipt)
  mkdirSync(join(active, 'owned'))
  writeFileSync(join(active, 'owned', 'note.txt'), 'private user choice\n')
  mkdirSync(join(active, 'node_modules', 'plugin'), { recursive: true })
  writeFileSync(join(active, 'node_modules', 'plugin', 'not-a-metadata-copy'), 'runtime\n')
  const before = profileMetadataFingerprint(active)
  const candidate = snapshotDesktopProfileMetadata(active, transaction)
  expect(candidate).toEqual({ staging: realpathSync.native(staging), baseMetadataSha256: before.sha256 })
  expect(profileMetadataFingerprint(staging).sha256).toBe(before.sha256)
  expect(readFileSync(join(staging, 'package.json'), 'utf8')).toBe(manifest)
  expect(readFileSync(join(staging, 'cordis.patch.yml'), 'utf8')).toBe(selection)
  expect(readFileSync(join(staging, 'desktop-plugin-receipts.json'), 'utf8')).toBe(receipt)
  expect(readFileSync(join(active, 'desktop-plugin-receipts.json'), 'utf8')).toBe(receipt)
  expect(readFileSync(join(staging, 'owned', 'note.txt'), 'utf8')).toBe('private user choice\n')
  expect(existsSync(join(staging, 'node_modules'))).toBe(false)
})

it('changes the fingerprint for same-sized user patch bytes and refuses stale candidates', () => {
  const { active, transaction, staging } = fixture()
  writeFileSync(join(active, 'package.json'), '{"name":"p"}\n')
  writeFileSync(join(active, 'cordis.patch.yml'), 'user choice A\n')
  const base = snapshotDesktopProfileMetadata(active, transaction)
  writeFileSync(join(active, 'cordis.patch.yml'), 'user choice B\n')
  expect(profileMetadataFingerprint(active).sha256).not.toBe(base.baseMetadataSha256)
  expect(profileMetadataFingerprint(staging).sha256).toBe(base.baseMetadataSha256)
})

it('produces the same content fingerprint for independent private transaction ids without sharing candidate paths', () => {
  const { root, active, transaction } = fixture()
  writeFileSync(join(active, 'package.json'), '{"name":"manual"}\n')
  const other = join(root, `.desktop-transaction-${'b'.repeat(32)}`)
  mkdirSync(other)
  const first = snapshotDesktopProfileMetadata(active, transaction)
  const second = snapshotDesktopProfileMetadata(active, other)
  expect(first.staging).not.toBe(second.staging)
  expect(first.baseMetadataSha256).toBe(second.baseMetadataSha256)
  expect(readFileSync(join(active, 'package.json'), 'utf8')).toBe('{"name":"manual"}\n')
})

it('does not create a candidate if cancellation was already requested before reading metadata', () => {
  const { active, transaction, staging } = fixture()
  writeFileSync(join(active, 'package.json'), '{"name":"manual"}\n')
  const controller = new AbortController()
  controller.abort()
  expect(() => snapshotDesktopProfileMetadata(active, transaction, controller.signal)).toThrow()
  expect(existsSync(staging)).toBe(false)
  expect(readFileSync(join(active, 'package.json'), 'utf8')).toBe('{"name":"manual"}\n')
})

it('refuses linked metadata before copying it, while leaving the outside target intact', () => {
  const { root, active, transaction, staging } = fixture()
  const outside = join(root, 'outside')
  mkdirSync(outside)
  writeFileSync(join(outside, 'private.txt'), 'do not read outside the profile\n')
  symlinkSync(outside, join(active, 'linked-metadata'), 'junction')
  expect(() => snapshotDesktopProfileMetadata(active, transaction)).toThrow('linked profile metadata')
  expect(existsSync(staging)).toBe(false)
  expect(readFileSync(join(outside, 'private.txt'), 'utf8')).toBe('do not read outside the profile\n')
})

it('refuses a foreign transaction or a pre-existing candidate without overwriting its bytes', () => {
  const first = fixture()
  const second = fixture()
  writeFileSync(join(first.active, 'package.json'), '{"name":"p"}\n')
  expect(() => snapshotDesktopProfileMetadata(first.active, second.transaction)).toThrow('owned profile sibling')
  expect(existsSync(second.staging)).toBe(false)
  mkdirSync(first.staging)
  writeFileSync(join(first.staging, 'private.txt'), 'not ours\n')
  expect(() => snapshotDesktopProfileMetadata(first.active, first.transaction)).toThrow('fresh owned profile sibling')
  expect(readFileSync(join(first.staging, 'private.txt'), 'utf8')).toBe('not ours\n')
})
