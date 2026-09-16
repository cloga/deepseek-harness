import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { desktopSmokeEnvironment } from '../scripts/smoke-environment.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import { linkDesktopHostPackages } from '../src/profile-packages.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('rejects a runner-injected optional peer but permits absence and a profile-owned copy', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-graph-plane-'))
  roots.push(root)
  const home = join(root, 'home')
  mkdirSync(home)
  const profile = join(home, 'profiles', 'desktop')
  const runtimeRoot = join(root, 'runtime')
  const runtime = runtimeFixture(runtimeRoot)
  createPluginProfile(profile)
  linkDesktopHostPackages(profile, runtimeRoot, runtime)
  const peer = `optional-peer-${randomUUID()}`
  writePackage(join(profile, 'node_modules'), 'plugin', {
    peerDependencies: { [peer]: '^1.0.0' },
    peerDependenciesMeta: { [peer]: { optional: true } },
  })
  const runnerModules = join(root, 'runner-modules')
  writePackage(runnerModules, peer)
  const environment = desktopSmokeEnvironment(home)
  const run = (env: NodeJS.ProcessEnv) => spawnSync(process.execPath, [
    resolve(import.meta.dirname, 'fixtures', 'packaged-graph-check.ts'), profile, runtimeRoot, 'plugin',
  ], { cwd: profile, env, encoding: 'utf8', timeout: 30_000 })

  const polluted = run({ ...environment, NODE_PATH: runnerModules })
  expect(polluted.error).toBeUndefined()
  expect(polluted.signal).toBeNull()
  expect(polluted.status).toBe(1)
  expect(polluted.stdout).toContain(`plugin resolves ${peer} outside its owned packages`)

  const clean = run(environment)
  expect(clean.error).toBeUndefined()
  expect(clean.signal).toBeNull()
  expect(clean.status, clean.stderr).toBe(0)
  expect(JSON.parse(clean.stdout)).toMatchObject({
    valid: true, nodePath: null, nodeOptionsPresent: false, nodeVersion: process.versions.node,
  })

  writePackage(join(profile, 'node_modules'), peer)
  const privatePeer = run({ ...environment, NODE_PATH: runnerModules })
  expect(privatePeer.error).toBeUndefined()
  expect(privatePeer.signal).toBeNull()
  expect(privatePeer.status, privatePeer.stderr).toBe(0)
  expect(JSON.parse(privatePeer.stdout)).toMatchObject({ valid: true })
})
