import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { desktopSmokeEnvironment } from '../scripts/smoke-environment.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import { packagedGraphCheckArguments } from './fixtures/packaged-graph-check.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// Artifact-plane subprocesses: build apps/desktop first; no source loader enters the children.
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
    packagedGraphCheckArguments(profile, runtimeRoot, [plugin]),
    { cwd: profile, env, encoding: 'utf8', timeout: 30_000 })
  return { profile, runtimeRoot, peer, runnerModules, environment, run }
}

function exited(result: ReturnType<typeof spawnSync>, status: number): void {
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  expect(result.status, result.stderr?.toString()).toBe(status)
}

it('validates unlinked runtime peers without writing links or profile state', () => {
  const { profile, runtimeRoot, environment, run } = fixture()
  const clean = run(environment)
  exited(clean, 0)
  expect(JSON.parse(clean.stdout)).toMatchObject({
    valid: true, nodePath: null, nodeOptionsPresent: false, nodeVersion: process.versions.node,
    runtimeRoot, resolutionMode: 'runtime', electronVersion: null,
  })
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
