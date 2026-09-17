import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { desktopSmokeEnvironment } from '../scripts/smoke-environment.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import { packagedGraphCheckArguments } from './fixtures/packaged-graph-check.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// Source tests exercise the production validator through the declared ESM source launcher.
// The separate argv test keeps the packaged acceptance on built JavaScript without executing it here.
const sourceLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
const sourceGraphCheck = `
import { validateDesktopPluginGraph } from ${JSON.stringify(new URL('../src/profile-packages.ts', import.meta.url).href)}
import { readDesktopRuntime } from ${JSON.stringify(new URL('../src/runtime-tree.ts', import.meta.url).href)}
const [profile, runtimeRoot, ...plugins] = process.argv.slice(1)
try {
  validateDesktopPluginGraph(profile, runtimeRoot, readDesktopRuntime(runtimeRoot), plugins, 'runtime')
  console.log(JSON.stringify({ valid: true }))
} catch (error) {
  console.log(JSON.stringify({ valid: false, error: String(error) }))
  process.exitCode = 1
}
`

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-graph-plane-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  const profile = join(home, 'profiles', 'desktop')
  const runtimeRoot = join(root, 'runtime')
  runtimeFixture(runtimeRoot)
  createPluginProfile(profile)
  const peer = `optional-peer-${randomUUID()}`
  writePackage(join(profile, 'node_modules'), 'plugin', {
    peerDependencies: { '@deepseek-ai/cordis': '^1.0.0', [peer]: '^1.0.0' },
    peerDependenciesMeta: { [peer]: { optional: true } },
  })
  const runnerModules = join(root, 'runner-modules')
  writePackage(runnerModules, peer)
  const environment = desktopSmokeEnvironment(home)
  const run = (env: NodeJS.ProcessEnv, plugin = 'plugin') => spawnSync(process.execPath,
    ['--import', sourceLoader, '--input-type=module', '--eval', sourceGraphCheck, profile, runtimeRoot, plugin],
    { cwd: profile, env, encoding: 'utf8', timeout: 30_000 })
  return { profile, runtimeRoot, peer, runnerModules, environment, run }
}

function exited(result: ReturnType<typeof spawnSync>, status: number): void {
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr?.toString()).toBe(status)
}

it('emits the built runtime-mode validator and carrier evidence without source-loader hooks', () => {
  const { profile, runtimeRoot } = fixture()
  const args = packagedGraphCheckArguments(profile, runtimeRoot, ['plugin'])
  expect(args.slice(0, 2)).toEqual(['--input-type=module', '--eval'])
  expect(args.slice(3)).toEqual([profile, runtimeRoot, 'plugin'])
  const script = args[2]!
  expect(script).toContain(new URL('../lib/types/profile-packages.js', import.meta.url).href)
  expect(script).toContain(new URL('../lib/types/runtime-tree.js', import.meta.url).href)
  expect(script).toContain("validateDesktopPluginGraph(profile, runtimeRoot, readDesktopRuntime(runtimeRoot), plugins, 'runtime')")
  for (const observation of ['runtimeSha256', 'process.execPath', 'process.versions.node', 'process.versions.electron',
    'process.env.ELECTRON_RUN_AS_NODE', 'process.env.NODE_PATH', 'process.env.NODE_OPTIONS', 'process.env.ELECTRON_NO_ASAR']) {
    expect(script).toContain(observation)
  }
  expect(script).not.toContain('/src/')
  expect(script).not.toContain('tsx')
  expect(args).not.toContain('--import')
  expect(() => packagedGraphCheckArguments('relative-profile', runtimeRoot, ['plugin'])).toThrow('must be absolute')
  expect(() => packagedGraphCheckArguments(profile, runtimeRoot, [])).toThrow('Active plugin names are required')
})

it('validates unlinked runtime peers without writing links or profile state', () => {
  const { profile, environment, run } = fixture()
  const clean = run(environment)
  exited(clean, 0)
  expect(JSON.parse(clean.stdout)).toEqual({ valid: true })
  expect(existsSync(join(profile, 'node_modules', '@deepseek-ai', 'cordis'))).toBe(false)
  expect(existsSync(join(profile, 'desktop-runtime-state.json'))).toBe(false)
})

it('treats an external optional peer as absent but accepts a profile-owned peer', () => {
  const { profile, peer, runnerModules, environment, run } = fixture()
  const polluted = run({ ...environment, NODE_PATH: runnerModules })
  exited(polluted, 0)
  expect(JSON.parse(polluted.stdout)).toMatchObject({ valid: true })
  writePackage(join(profile, 'node_modules'), peer)
  const privatePeer = run({ ...environment, NODE_PATH: runnerModules })
  exited(privatePeer, 0)
  expect(JSON.parse(privatePeer.stdout)).toMatchObject({ valid: true })
})

it('rejects a required peer outside the profile rather than accepting runner pollution', () => {
  const { profile, peer, runnerModules, environment, run } = fixture()
  writePackage(join(profile, 'node_modules'), 'required-plugin', { peerDependencies: { [peer]: '^1.0.0' } })
  const required = run({ ...environment, NODE_PATH: runnerModules }, 'required-plugin')
  exited(required, 1)
  expect(required.stdout).toContain(`required-plugin resolves ${peer} outside its owned packages`)
})

it('rejects an incompatible runtime peer and a missing active plugin', () => {
  const { profile, environment, run } = fixture()
  writePackage(join(profile, 'node_modules'), 'incompatible-plugin', {
    peerDependencies: { '@deepseek-ai/cordis': '^2.0.0' },
  })
  const incompatible = run(environment, 'incompatible-plugin')
  exited(incompatible, 1)
  expect(incompatible.stdout).toContain('incompatible-plugin requires @deepseek-ai/cordis@^2.0.0, found 1.0.0')
  const missing = run(environment, 'missing-plugin')
  exited(missing, 1)
  expect(missing.stdout).toContain('missing local plugin missing-plugin')
})
