/** User removal choices survive plan changes without modifying active profile data before activation. */
import { randomUUID } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import {
  clearDesktopPluginRemoval, DESKTOP_PLUGIN_USER_INTENTS_FILE, markDesktopPluginRemoved, readDesktopPluginUserIntents,
} from '../src/plugin-user-intents.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-user-intents-'))
  roots.push(root)
  const active = join(root, 'desktop')
  const candidate = join(root, `.desktop.package-stage-${randomUUID()}`, 'profile')
  mkdirSync(active); mkdirSync(candidate, { recursive: true })
  return { root, active, candidate }
}

it('reads absence without creating evidence or permitting an active-profile write', () => {
  const f = fixture()
  expect(readDesktopPluginUserIntents(f.active)).toEqual({ schemaVersion: 1, removed: {} })
  expect(existsSync(join(f.active, DESKTOP_PLUGIN_USER_INTENTS_FILE))).toBe(false)
  expect(() => markDesktopPluginRemoved(f.active, 'addon')).toThrow('non-candidate')
  expect(() => clearDesktopPluginRemoval(f.active, 'addon')).toThrow('non-candidate')
})

it('stages removal and reinstall intent without changing original bytes', () => {
  const f = fixture()
  const before = JSON.stringify({ schemaVersion: 1, removed: { kept: { observedPlanSha256: 'a'.repeat(64) } } })
  writeFileSync(join(f.active, DESKTOP_PLUGIN_USER_INTENTS_FILE), before)
  cpSync(f.active, f.candidate, { recursive: true })
  expect(markDesktopPluginRemoved(f.candidate, '@example/addon', 'b'.repeat(64))).toBe(true)
  expect(clearDesktopPluginRemoval(f.candidate, 'kept')).toBe(true)
  expect(clearDesktopPluginRemoval(f.candidate, 'kept')).toBe(false)
  expect(readFileSync(join(f.active, DESKTOP_PLUGIN_USER_INTENTS_FILE), 'utf8')).toBe(before)
  expect(readDesktopPluginUserIntents(f.candidate)).toEqual({ schemaVersion: 1,
    removed: { '@example/addon': { observedPlanSha256: 'b'.repeat(64) } } })
})

it('does not expire or transfer a removal choice when the packaged plan changes', () => {
  const f = fixture()
  markDesktopPluginRemoved(f.candidate, 'addon', 'a'.repeat(64))
  const before = readFileSync(join(f.candidate, DESKTOP_PLUGIN_USER_INTENTS_FILE), 'utf8')
  expect(markDesktopPluginRemoved(f.candidate, 'addon', 'b'.repeat(64))).toBe(false)
  expect(readFileSync(join(f.candidate, DESKTOP_PLUGIN_USER_INTENTS_FILE), 'utf8')).toBe(before)
  expect(readDesktopPluginUserIntents(f.candidate).removed.addon).toEqual({ observedPlanSha256: 'a'.repeat(64) })
})

it.each([
  '{"schemaVersion":1,"removed":{},"owner":"release"}',
  '{"schemaVersion":1,"removed":{"addon":{"url":"https://example.invalid"}}}',
  '{"schemaVersion":1,"removed":{"addon":{"verified":true}}}',
  '{"schemaVersion":1,"removed":{"__proto__":{}}}',
  '{"schemaVersion":1,"removed":{"addon":{"observedPlanSha256":"old-plan"}}}',
  '{"schemaVersion":2,"removed":{}}',
])('refuses unknown or overpowered intent evidence without replacing it (%s)', text => {
  const f = fixture()
  const path = join(f.candidate, DESKTOP_PLUGIN_USER_INTENTS_FILE)
  writeFileSync(path, text)
  expect(() => markDesktopPluginRemoved(f.candidate, 'other')).toThrow()
  expect(readFileSync(path, 'utf8')).toBe(text)
})

it('bounds evidence size and package count without accepting path-like names', () => {
  const f = fixture()
  expect(() => markDesktopPluginRemoved(f.candidate, '../outside')).toThrow('invalid evidence')
  const path = join(f.candidate, DESKTOP_PLUGIN_USER_INTENTS_FILE)
  writeFileSync(path, JSON.stringify({ schemaVersion: 1,
    removed: Object.fromEntries(Array.from({ length: 1025 }, (_, index) => [`package-${index}`, {}])) }))
  expect(() => readDesktopPluginUserIntents(f.candidate)).toThrow('invalid evidence')
  writeFileSync(path, ' '.repeat(1024 * 1024 + 1))
  expect(() => readDesktopPluginUserIntents(f.candidate)).toThrow('invalid evidence')
})

it('refuses redirected candidate ancestors and unsafe intent files', () => {
  const f = fixture()
  const real = join(f.root, 'real-stage')
  mkdirSync(join(real, 'profile'), { recursive: true })
  const alias = join(f.root, `.desktop.package-stage-${randomUUID()}`)
  symlinkSync(real, alias, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => markDesktopPluginRemoved(join(alias, 'profile'), 'addon')).toThrow('non-candidate')
  const intent = join(f.candidate, DESKTOP_PLUGIN_USER_INTENTS_FILE)
  mkdirSync(intent)
  expect(() => readDesktopPluginUserIntents(f.candidate)).toThrow('invalid evidence')
  expect(existsSync(join(real, 'profile', DESKTOP_PLUGIN_USER_INTENTS_FILE))).toBe(false)
})
