/** Generic CLI plugin operations must never mutate Electron-owned profile paths. */
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { resolveCliPluginDirectory } from '../src/profile-ownership.ts'
import { runPlugin } from '../src/plugin.ts'

vi.mock('node:child_process', async original => ({
  ...await original<typeof import('node:child_process')>(),
  spawnSync: vi.fn(() => { throw new Error('ownership test must not launch pnpm') }),
}))

let root: string
let home: string
let links: string[]
const profile = (name: string): string => join(home, 'profiles', name)
const directory = (path: string): string => { mkdirSync(path, { recursive: true }); return path }
function link(target: string, path: string): void {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  links.push(path)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-cli-profile-owner-'))
  home = join(root, 'home')
  links = []
  vi.stubEnv('DSH_HOME', home)
  vi.mocked(spawnSync).mockClear()
})
afterEach(() => {
  vi.unstubAllEnvs()
  for (const path of links.reverse()) if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(path)
  rmSync(root, { recursive: true, force: true })
})

it.each(['desktop', 'Desktop', 'DESKTOP'])('refuses generic plugin commands for reserved %s before creating home', (name) => {
  expect(() => runPlugin(name, ['add', './plugin'])).toThrow('managed exclusively by the Electron application')
  expect(readdirSync(root)).toEqual([])
  expect(spawnSync).not.toHaveBeenCalled()
})

it('rejects a physical alias to Desktop without touching its manifest or invoking pnpm', () => {
  const desktop = directory(profile('desktop'))
  const manifest = join(desktop, 'package.json')
  writeFileSync(manifest, '{"private":true}\n')
  const before = readFileSync(manifest)
  link(desktop, profile('alias'))
  expect(() => runPlugin('alias', ['add', './plugin'])).toThrow('managed exclusively by the Electron application')
  expect(readFileSync(manifest)).toEqual(before)
  expect(existsSync(join(desktop, '.plugin-manager'))).toBe(false)
  expect(spawnSync).not.toHaveBeenCalled()
})

it('refuses a dangling junction into Desktop and creates no missing target', () => {
  const desktop = directory(profile('desktop'))
  const missing = join(desktop, 'missing', 'plugin')
  link(missing, profile('alias'))
  expect(() => runPlugin('alias', ['add', './plugin'])).toThrow('cannot resolve profile ownership')
  expect(readdirSync(desktop)).toEqual([])
  expect(existsSync(missing)).toBe(false)
  expect(spawnSync).not.toHaveBeenCalled()
})

it('allows a separate sibling whose name only starts with desktop', () => {
  directory(profile('desktop'))
  const sibling = directory(profile('desktop-other'))
  link(sibling, profile('alias'))
  expect(resolveCliPluginDirectory('alias')).toBe(realpathSync(sibling))
  expect(spawnSync).not.toHaveBeenCalled()
})

it('allows an ancestor without treating it as a Desktop descendant', () => {
  directory(profile('desktop'))
  link(home, profile('alias'))
  expect(resolveCliPluginDirectory('alias')).toBe(realpathSync(home))
  expect(spawnSync).not.toHaveBeenCalled()
})

it('rejects chained Desktop aliases through a linked Harness home', () => {
  const desktop = directory(profile('desktop'))
  link(desktop, profile('first'))
  link(profile('first'), profile('alias'))
  const linkedHome = join(root, 'linked-home')
  link(home, linkedHome)
  expect(() => resolveCliPluginDirectory('alias', linkedHome)).toThrow('managed exclusively by the Electron application')
  expect(readdirSync(desktop)).toEqual([])
  expect(spawnSync).not.toHaveBeenCalled()
})
