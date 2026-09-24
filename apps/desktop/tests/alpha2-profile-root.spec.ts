/** The native Shell seals only an owned alpha2 candidate; active user choices are untouched. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROFILE_ROOT_CONFIG } from '@deepseek-ai/dsh-app-boot'
import { afterEach, expect, it } from 'vitest'
import { prepareAlpha2ProfileRoot } from '../src/alpha2-profile-root.ts'

const roots: string[] = []
const legacy = '# Electron desktop composition root; package transactions own this file.\n[]\n'

function candidate(activeExists = true): { root: string; active: string; transaction: string; staging: string } {
  const root = mkdtempSync(join(tmpdir(), 'dsh-alpha2-profile-root-'))
  roots.push(root)
  const active = join(root, 'desktop-profile')
  const transaction = join(root, '.desktop-transaction-abcdef')
  const staging = join(transaction, 'staging')
  if (activeExists) mkdirSync(active)
  mkdirSync(staging, { recursive: true })
  return { root, active, transaction, staging }
}

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('seals the copied candidate while preserving active legacy root and user patch/receipt bytes', () => {
  const { active, transaction, staging } = candidate()
  const choices = '- id: personal-plugin\n  disabled: true\n'
  const receipt = '{"source":"signed-private-user-choice"}\n'
  const manifest = '{"dsh":{"profile":{"bundles":["@deepseek-ai/dsh-web-app","@cloga/personal-plugin"]}},"dependencies":{"@cloga/personal-plugin":"1.2.3"}}\n'
  writeFileSync(join(active, 'desktop.cordis.yml'), legacy)
  writeFileSync(join(active, 'cordis.patch.yml'), choices)
  writeFileSync(join(active, 'package.json'), manifest)
  writeFileSync(join(staging, 'desktop.cordis.yml'), legacy)
  writeFileSync(join(staging, 'cordis.patch.yml'), choices)
  writeFileSync(join(staging, 'package.json'), manifest)
  writeFileSync(join(staging, 'desktop-plugin-receipts.json'), receipt)

  expect(prepareAlpha2ProfileRoot(active, transaction)).toBe(realpathSync.native(staging))
  expect(readFileSync(join(staging, 'cordis.yml'), 'utf8')).toBe(PROFILE_ROOT_CONFIG)
  expect(readFileSync(join(staging, 'desktop.cordis.yml'), 'utf8')).toBe(legacy)
  expect(readFileSync(join(staging, 'cordis.patch.yml'), 'utf8')).toBe(choices)
  expect(readFileSync(join(staging, 'package.json'), 'utf8')).toBe(manifest)
  expect(readFileSync(join(staging, 'desktop-plugin-receipts.json'), 'utf8')).toBe(receipt)
  expect(readFileSync(join(active, 'desktop.cordis.yml'), 'utf8')).toBe(legacy)
  expect(readFileSync(join(active, 'cordis.patch.yml'), 'utf8')).toBe(choices)
  expect(readFileSync(join(active, 'package.json'), 'utf8')).toBe(manifest)
  expect(existsSync(join(active, 'cordis.yml'))).toBe(false)
})

it('prepares an official root for a first install without creating the active profile', () => {
  const { active, transaction, staging } = candidate(false)
  expect(prepareAlpha2ProfileRoot(active, transaction)).toBe(realpathSync.native(staging))
  expect(readFileSync(join(staging, 'cordis.yml'), 'utf8')).toBe(PROFILE_ROOT_CONFIG)
  expect(existsSync(active)).toBe(false)
})

it('accepts a comment-only empty legacy root but never silently adopts non-empty user composition', () => {
  const { active, transaction, staging } = candidate()
  writeFileSync(join(staging, 'desktop.cordis.yml'), '# comment\n\n[]\n')
  expect(prepareAlpha2ProfileRoot(active, transaction)).toBe(realpathSync.native(staging))
  expect(readFileSync(join(staging, 'cordis.yml'), 'utf8')).toBe(PROFILE_ROOT_CONFIG)
  writeFileSync(join(staging, 'desktop.cordis.yml'), '- id: private-user-entry\n')
  rmSync(join(staging, 'cordis.yml'))
  expect(() => prepareAlpha2ProfileRoot(active, transaction)).toThrow('non-empty legacy root needs explicit migration')
  expect(existsSync(join(staging, 'cordis.yml'))).toBe(false)
})

it('refuses to overwrite a non-empty canonical root or target the active/sibling profile', () => {
  const { root, active, transaction, staging } = candidate()
  writeFileSync(join(staging, 'cordis.yml'), '- id: existing-private-entry\n')
  expect(() => prepareAlpha2ProfileRoot(active, transaction)).toThrow('non-empty root requires explicit migration')
  expect(readFileSync(join(staging, 'cordis.yml'), 'utf8')).toBe('- id: existing-private-entry\n')
  const unrelated = join(root, 'other-profile')
  mkdirSync(join(unrelated, 'staging'), { recursive: true })
  expect(() => prepareAlpha2ProfileRoot(active, unrelated)).toThrow('not a private profile sibling')
  expect(existsSync(join(unrelated, 'staging', 'cordis.yml'))).toBe(false)
})

it('refuses a foreign transaction parent and an active directory disguised as a transaction', () => {
  const first = candidate()
  const second = candidate()
  expect(() => prepareAlpha2ProfileRoot(first.active, second.transaction)).toThrow('not a private profile sibling')
  expect(existsSync(join(second.staging, 'cordis.yml'))).toBe(false)
  expect(() => prepareAlpha2ProfileRoot(first.active, first.active)).toThrow('not a private profile sibling')
  expect(existsSync(join(first.active, 'cordis.yml'))).toBe(false)
})
