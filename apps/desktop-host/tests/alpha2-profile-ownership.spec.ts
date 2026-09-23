/** Canonical profile/runtime ownership before the dormant alpha2 Host loads any bundle row. */
import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertAlpha2ProfileOwnership } from '../src/alpha2-profile-ownership.ts'

const homes: string[] = []
afterEach(() => { for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true }) })

function roots() {
  const home = mkdtempSync(join(tmpdir(), 'dsh-alpha2-owned-'))
  homes.push(home)
  const runtime = join(home, 'runtime')
  const project = join(home, 'project')
  const outside = join(home, 'project-copy')
  for (const path of [runtime, project, outside]) mkdirSync(path)
  return { runtime, project, outside }
}

it('accepts installed runtime and user-owned profile packages, including an internal pnpm junction', () => {
  const { runtime, project } = roots()
  const bundled = join(runtime, 'node_modules', 'core')
  const stored = join(project, 'node_modules', '.pnpm', 'bundle', 'node_modules', 'bundle')
  mkdirSync(bundled, { recursive: true })
  mkdirSync(stored, { recursive: true })
  const linked = join(project, 'node_modules', 'bundle')
  symlinkSync(stored, linked, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => assertAlpha2ProfileOwnership(runtime, project, [
    { packageDir: bundled }, { packageDir: linked },
  ])).not.toThrow()
})

it('refuses both sibling-prefix escapes and a junction leaving the owned roots', () => {
  const { runtime, project, outside } = roots()
  expect(() => assertAlpha2ProfileOwnership(runtime, project, [{ packageDir: outside }]))
    .toThrow('profile bundle resolved outside its owned roots')
  const linked = join(project, 'escaped')
  symlinkSync(outside, linked, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => assertAlpha2ProfileOwnership(runtime, project, [{ packageDir: linked }]))
    .toThrow('profile bundle resolved outside its owned roots')
})

it('refuses redirected project or runtime roots and an alias in a root ancestor', () => {
  const { runtime, project } = roots()
  const home = join(project, '..')
  const packageDir = join(project, 'node_modules', 'installed')
  mkdirSync(packageDir, { recursive: true })
  const projectAlias = join(home, 'project-alias')
  const runtimeAlias = join(home, 'runtime-alias')
  const ancestorAlias = join(home, 'ancestor-alias')
  const aliases: Array<readonly [string, string]> = [
    [project, projectAlias], [runtime, runtimeAlias], [home, ancestorAlias],
  ]
  for (const [target, link] of aliases) {
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const invalidRoots: Array<readonly [string, string]> = [
    [runtime, projectAlias], [runtimeAlias, project], [runtime, join(ancestorAlias, 'project')],
  ]
  for (const [runtimeRoot, profileRoot] of invalidRoots) {
    expect(() => assertAlpha2ProfileOwnership(runtimeRoot, profileRoot, [{ packageDir }]))
      .toThrow('owned package roots are unavailable or redirected')
  }
})

it('fails closed on missing roots or missing bundle bytes without echoing a path', () => {
  const { runtime, project } = roots()
  expect(() => assertAlpha2ProfileOwnership(join(project, 'missing-root'), project, []))
    .toThrow('owned package roots are unavailable')
  const missing = join(project, 'private-sentinel-missing')
  try { assertAlpha2ProfileOwnership(runtime, project, [{ packageDir: missing }]) }
  catch (error) {
    expect(String(error)).toContain('profile bundle is unavailable')
    expect(String(error)).not.toContain('private-sentinel')
    return
  }
  throw new Error('Missing bundle was not refused')
})
