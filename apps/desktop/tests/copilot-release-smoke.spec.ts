import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'

const effects = vi.hoisted(() => ({
  parseArgs: vi.fn(() => { throw new Error('Import must not parse CLI arguments') }),
  launch: vi.fn(() => { throw new Error('Import must not launch Electron') }),
  inspectRuntime: vi.fn(() => { throw new Error('Import must not inspect an application') }),
}))
vi.mock('node:util', async importOriginal => ({
  ...await importOriginal<typeof import('node:util')>(), parseArgs: effects.parseArgs,
}))
vi.mock('playwright', () => ({ _electron: { launch: effects.launch } }))
vi.mock('../scripts/packaged-runtime.mjs', () => ({
  packagedDesktopRuntimeEnvironment: effects.inspectRuntime,
  packagedDesktopRuntimeRoot: effects.inspectRuntime,
  readPackagedDesktopRuntimeDescriptor: effects.inspectRuntime,
  verifyPackagedDesktopRuntime: effects.inspectRuntime,
}))

const directories: string[] = []
afterEach(() => {
  vi.unstubAllGlobals()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

it('imports the reusable acceptance without parsing CLI arguments or starting runtime work', async () => {
  const fixture = await import('./fixtures/copilot-release-smoke.ts')
  expect(typeof fixture.runPackagedCopilotAcceptance).toBe('function')
  expect(effects.parseArgs).not.toHaveBeenCalled()
  expect(effects.launch).not.toHaveBeenCalled()
  expect(effects.inspectRuntime).not.toHaveBeenCalled()
})

it('prepares isolated home and ancestor SDK without precreating the shell-owned profile', async () => {
  const { preparePackagedCopilotHome } = await import('./fixtures/copilot-release-smoke.ts')
  const root = mkdtempSync(join(tmpdir(), 'copilot-acceptance-home-'))
  directories.push(root)
  const home = join(root, 'home')
  const legacySdk = join(root, 'legacy-sdk')
  mkdirSync(home)
  mkdirSync(legacySdk)
  preparePackagedCopilotHome(home, legacySdk)
  const profile = join(home, 'profiles', 'desktop')
  expect(existsSync(profile)).toBe(false)
  expect(existsSync(join(profile, '.env'))).toBe(false)
  expect(readFileSync(join(home, '.env'), 'utf8')).toBe('')
  expect(readFileSync(join(home, 'settings.yaml'), 'utf8')).toContain('welcomeNoticeVersion: "2026-08-13.1"')
  const ancestorSdk = join(home, 'profiles', 'node_modules', '@modelcontextprotocol', 'sdk')
  expect(realpathSync.native(ancestorSdk)).toBe(realpathSync.native(legacySdk))
  expect(JSON.parse(readFileSync(join(ancestorSdk, 'package.json'), 'utf8'))).toMatchObject({
    name: '@modelcontextprotocol/sdk', version: '1.0.0',
  })
  expect(existsSync(join(legacySdk, 'loaded'))).toBe(false)
  mkdirSync(profile)
  expect(() => preparePackagedCopilotHome(home, legacySdk)).toThrow('shell must exclusively create')
  expect(existsSync(profile)).toBe(true)
})

it.each([
  ['dsh-app://app/', true],
  ['dsh-app://app/index.html', false],
  ['dsh-app://shell/loading.html', false],
  ['https://app/', false],
])('recognizes the exact official application URL %s', async (href, ready) => {
  const { packagedCopilotStartupReady } = await import('./fixtures/copilot-release-smoke.ts')
  vi.stubGlobal('location', { href })
  vi.stubGlobal('document', { querySelector: () => null })
  expect(packagedCopilotStartupReady()).toBe(ready)
})

it.each([
  [{ hidden: false, textContent: 'Host failed' }, true],
  [{ hidden: true, textContent: 'Host failed' }, false],
  [{ hidden: false, textContent: '  ' }, false],
])('preserves visible startup error detection: %j', async (error, ready) => {
  const { packagedCopilotStartupReady } = await import('./fixtures/copilot-release-smoke.ts')
  vi.stubGlobal('location', { href: 'dsh-app://shell/loading.html' })
  vi.stubGlobal('document', { querySelector: () => error })
  expect(packagedCopilotStartupReady()).toBe(ready)
})
