/** CLI package operations reject Desktop aliases before any package-manager write. */
import {
  existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPluginCommand } from '@deepseek-ai/dsh-plugin-manager/operations'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runPlugin } from '../src/plugin.ts'
import { INSTALL_ANCHOR } from '../src/profile-boot.ts'

// Only the package-manager operation is replaced; all ownership filesystem reads are real.
vi.mock('@deepseek-ai/dsh-plugin-manager/operations', () => ({ runPluginCommand: vi.fn() }))

const operation = vi.mocked(runPluginCommand)
const args = ['add', './local-plugin', '--save-dev'] as const
let root: string
let home: string
let links: string[]

function directory(path: string): string {
  mkdirSync(path, { recursive: true })
  return path
}

function link(target: string, path: string): string {
  symlinkSync(target, path, process.platform === 'win32' ? 'junction' : 'dir')
  links.push(path)
  return path
}

function profile(name: string): string {
  return join(home, 'profiles', name)
}

/** Exercise the actual CLI function, not only its path helper. */
async function rejects(name: string, selectedHome = home, message = 'managed exclusively by the Electron application'): Promise<void> {
  await expect(runPlugin(name, args, selectedHome)).rejects.toThrow(message)
  expect(operation).not.toHaveBeenCalled()
}

async function forwards(name: string, dir: string, selectedHome = home): Promise<void> {
  await expect(runPlugin(name, args, selectedHome)).resolves.toBe(0)
  const anyFunction: unknown = expect.any(Function)
  expect(operation).toHaveBeenCalledExactlyOnceWith({
    profile: name, dir, installAnchor: INSTALL_ANCHOR, cwd: process.cwd(),
  }, args, {
    execution: 'cli', outputBytes: 16384, lockWaitMs: 120000, onOutput: anyFunction,
  })
  expect(operation.mock.calls[0]![1]).toBe(args)
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-cli-ownership-'))
  home = join(root, 'home')
  links = []
  operation.mockReset()
  operation.mockResolvedValue({ exitCode: 0, output: '', truncated: false, logPath: 'unused' })
})

afterEach(() => {
  // Unlink owned junctions explicitly before recursively removing real fixture directories.
  for (const path of links.reverse()) {
    if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) unlinkSync(path)
  }
  rmSync(root, { recursive: true, force: true })
})

describe('runPlugin profile ownership', () => {
  it.each(['desktop', 'Desktop', 'DESKTOP'])('rejects reserved name %s without creating home', async (name) => {
    await rejects(name)
    expect(readdirSync(root)).toEqual([])
  })

  it('rejects a real directory alias to Desktop without changing its contents', async () => {
    const desktop = directory(profile('desktop'))
    const manifest = join(desktop, 'package.json')
    writeFileSync(manifest, '{"private":true}\n')
    const before = readFileSync(manifest)
    const alias = link(desktop, profile('web-alias'))
    expect(realpathSync(alias)).toBe(realpathSync(desktop))

    await rejects('web-alias')

    expect(readFileSync(manifest)).toEqual(before)
    expect(readdirSync(desktop)).toEqual(['package.json'])
    expect(existsSync(join(desktop, 'package.json.lock'))).toBe(false)
    expect(existsSync(join(desktop, '.plugin-manager'))).toBe(false)
  })

  it('rejects an alias into Desktop installed packages without changing the package', async () => {
    const installed = directory(join(profile('desktop'), 'node_modules', 'somepkg'))
    const manifest = join(installed, 'package.json')
    writeFileSync(manifest, '{"name":"somepkg","version":"1.0.0"}\n')
    const before = readFileSync(manifest)
    link(installed, profile('web-alias'))

    await rejects('web-alias')

    expect(readFileSync(manifest)).toEqual(before)
    expect(readdirSync(installed)).toEqual(['package.json'])
    expect(existsSync(join(installed, 'package.json.lock'))).toBe(false)
    expect(existsSync(join(installed, '.plugin-manager'))).toBe(false)
  })

  it('refuses an alias to a missing Desktop descendant without creating it', async () => {
    const desktop = directory(profile('desktop'))
    const missing = join(desktop, 'missing', 'package')
    link(missing, profile('web-alias'))

    await rejects('web-alias', home, 'cannot resolve profile ownership')

    expect(readdirSync(desktop)).toEqual([])
    expect(existsSync(missing)).toBe(false)
  })

  it('allows a linked sibling whose name merely starts with desktop', async () => {
    directory(profile('desktop'))
    const unrelated = directory(profile('desktop-other'))
    link(unrelated, profile('web-alias'))

    await forwards('web-alias', realpathSync(unrelated))
    expect(readdirSync(unrelated)).toEqual([])
  })

  it('does not treat a Desktop ancestor as the Desktop directory tree', async () => {
    directory(profile('desktop'))
    link(home, profile('web-alias'))

    await forwards('web-alias', realpathSync(home))
    expect(readdirSync(home)).toEqual(['profiles'])
  })

  it('rejects chained aliases through a linked home', async () => {
    const desktop = directory(profile('desktop'))
    const first = link(desktop, profile('first-alias'))
    link(first, profile('web-alias'))
    const linkedHome = link(home, join(root, 'linked-home'))

    await rejects('web-alias', linkedHome)
    expect(readdirSync(desktop)).toEqual([])
  })

  it('rejects aliases when the profiles parent is linked', async () => {
    directory(home)
    const profiles = directory(join(root, 'external-profiles'))
    const desktop = directory(join(profiles, 'desktop'))
    link(profiles, join(home, 'profiles'))
    link(desktop, profile('web-alias'))

    await rejects('web-alias')
    expect(readdirSync(desktop)).toEqual([])
  })

  it('rejects the physical Desktop target when Desktop itself is linked', async () => {
    directory(join(home, 'profiles'))
    const physical = directory(join(root, 'desktop-data'))
    link(physical, profile('desktop'))
    link(physical, profile('web-alias'))

    await rejects('web-alias')
    expect(readdirSync(physical)).toEqual([])
  })

  it.runIf(process.platform === 'win32')('rejects differently cased Windows target spellings', async () => {
    const desktop = directory(profile('desktop'))
    link(desktop.toUpperCase(), profile('web-alias'))
    await rejects('web-alias')
    expect(readdirSync(desktop)).toEqual([])
  })

  it('forwards an unrelated existing profile with exact invocation context and unchanged args', async () => {
    directory(profile('desktop'))
    const web = directory(profile('web'))
    await forwards('web', realpathSync(web))
    expect(readdirSync(web)).toEqual([])
  })

  it('allows an unrelated profile link and pins its canonical target', async () => {
    directory(profile('desktop'))
    const physical = directory(join(root, 'custom-data'))
    link(physical, profile('web-alias'))
    const linkedHome = link(home, join(root, 'linked-home'))

    await forwards('web-alias', realpathSync(physical), linkedHome)
    expect(readdirSync(physical)).toEqual([])
  })

  it.each(['missing-home', 'missing-profiles', 'missing-profile'])('allows %s without preflight mkdir', async (state) => {
    if (state !== 'missing-home') directory(home)
    if (state === 'missing-profile') directory(profile('desktop'))
    const expected = join(realpathSync(root), 'home', 'profiles', 'web')

    await forwards('web', expected)

    expect(existsSync(profile('web'))).toBe(false)
    if (state === 'missing-home') expect(existsSync(home)).toBe(false)
    if (state === 'missing-profiles') expect(existsSync(join(home, 'profiles'))).toBe(false)
  })

  it('canonicalizes a missing ordinary profile beneath a linked home', async () => {
    directory(home)
    const linkedHome = link(home, join(root, 'linked-home'))
    await forwards('web', join(realpathSync(home), 'profiles', 'web'), linkedHome)
    expect(readdirSync(home)).toEqual([])
  })

  it.each(['target', 'desktop', 'profiles', 'home'])('refuses a dangling %s link without creating its referent', async (location) => {
    const missing = join(root, 'missing-referent')
    if (location === 'home') {
      link(missing, home)
    } else if (location === 'profiles') {
      directory(home)
      link(missing, join(home, 'profiles'))
    } else {
      directory(join(home, 'profiles'))
      link(missing, profile(location === 'target' ? 'web-alias' : 'desktop'))
    }

    await rejects('web-alias', home, 'cannot resolve profile ownership')
    expect(existsSync(missing)).toBe(false)
  })

  it.each(['web-alias', 'desktop'])('refuses a cyclic %s link without invoking operations', async (name) => {
    directory(join(home, 'profiles'))
    link(profile(name), profile(name))
    await rejects('web-alias', home, 'cannot resolve profile ownership')
    expect(readdirSync(join(home, 'profiles'))).toEqual([name])
  })

  it('refuses a regular-file ancestor rather than treating it as a missing home', async () => {
    writeFileSync(home, 'not a directory')
    await rejects('web', home, 'cannot resolve profile ownership')
    expect(readFileSync(home, 'utf8')).toBe('not a directory')
  })
})
