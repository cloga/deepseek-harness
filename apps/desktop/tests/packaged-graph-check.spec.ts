import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createProfileResolutionGeneration, loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { desktopSmokeEnvironment } from '../scripts/smoke-environment.ts'
import { createPluginProfile } from '../src/project-manager.ts'
import { readDesktopRuntime, writeDesktopRuntime } from '../src/runtime-tree.ts'
import { packagedGraphCheckArguments } from './fixtures/packaged-graph-check.ts'
import { resolvePackagedAppBoot } from './fixtures/packaged-graph-inventory.mjs'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

// Source tests use the official read-only generation through the declared ESM source launcher.
// The separate argv test keeps packaged acceptance on actual runtime JavaScript without executing it here.
const sourceLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href
// The child cwd is the isolated profile, not the checkout that owns workspace source aliases.
const sourceTsconfig = fileURLToPath(new URL('../../../tsconfig.json', import.meta.url))
const sourceGraphCheck = `
import { loadProfileDirectory, createProfileResolutionGeneration } from ${JSON.stringify(new URL('../../../packages/boot/app-boot/src/profile.ts', import.meta.url).href)}
import { assertPackagedGraphInventory } from ${JSON.stringify(new URL('./fixtures/packaged-graph-inventory.mjs', import.meta.url).href)}
import { readDesktopRuntime } from ${JSON.stringify(new URL('../src/runtime-tree.ts', import.meta.url).href)}
const [profile, runtimeRoot, ...plugins] = process.argv.slice(1)
try {
  await assertPackagedGraphInventory({ profile, runtimeRoot, runtime: readDesktopRuntime(runtimeRoot), plugins,
    loadProfileDirectory, createProfileResolutionGeneration })
  console.log(JSON.stringify({ valid: true }))
} catch (error) {
  console.log(JSON.stringify({ valid: false, error: String(error) }))
  process.exitCode = 1
}
`

function fixture() {
  const created = mkdtempSync(join(tmpdir(), 'desktop-graph-plane-'))
  roots.push(created)
  // Match the official plain-Node bundle resolver's spelling, including Windows short-name aliases.
  const root = realpathSync.native(created)
  const home = join(root, 'home')
  mkdirSync(home)
  const profile = join(home, 'profiles', 'desktop')
  const runtimeRoot = join(root, 'runtime')
  const runtime = runtimeFixture(runtimeRoot)
  // The packaged Host depends on the CLI, not vice versa; both remain descriptor-owned.
  const modules = join(runtimeRoot, 'node_modules')
  writePackage(modules, '@deepseek-ai/dsh', {
    dependencies: Object.fromEntries(runtime.sharedPackages
      .filter(entry => entry.name !== '@deepseek-ai/dsh' && entry.name !== '@deepseek-ai/dsh-desktop-host')
      .map(entry => [entry.name, entry.version])),
  })
  writePackage(modules, '@deepseek-ai/dsh-desktop-host', {
    dependencies: { '@deepseek-ai/dsh': runtime.release.version },
  })
  writeDesktopRuntime(runtimeRoot, runtime.release, runtime.sharedPackages.map(entry => entry.name))
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
    { cwd: profile, env: { ...env, TSX_TSCONFIG_PATH: sourceTsconfig }, encoding: 'utf8', timeout: 30_000 })
  return { profile, runtimeRoot, peer, runnerModules, environment, run }
}

function exited(result: ReturnType<typeof spawnSync>, status: number): void {
  expect(result.error).toBeUndefined()
  expect(result.signal).toBeNull()
  const output = [result.stderr?.toString(), result.stdout?.toString()].filter(Boolean).join('\n')
  expect(result.status, output.slice(-16_384)).toBe(status)
}

it('emits packaged generation inspection and carrier evidence without source-loader hooks', () => {
  const { profile, runtimeRoot } = fixture()
  const args = packagedGraphCheckArguments(profile, runtimeRoot, ['plugin'])
  expect(args.slice(0, 2)).toEqual(['--input-type=module', '--eval'])
  expect(args.slice(3)).toEqual([profile, runtimeRoot, 'plugin'])
  const script = args[2]!
  expect(script).toContain(new URL('./fixtures/packaged-graph-inventory.mjs', import.meta.url).href)
  expect(script).toContain(new URL('../lib/types/runtime-tree.js', import.meta.url).href)
  expect(script).toContain('const bootEntry = resolvePackagedAppBoot(runtimeRoot)')
  expect(script.indexOf('resolvePackagedAppBoot(runtimeRoot)')).toBeLessThan(script.indexOf('await import(pathToFileURL(bootEntry).href)'))
  expect(script).toContain('createProfileResolutionGeneration: boot.createProfileResolutionGeneration')
  expect(script).toContain('await assertPackagedGraphInventory(')
  expect(script).not.toContain('validateDesktopPluginGraph')
  for (const observation of ['runtimeSha256', 'process.execPath', 'process.versions.node', 'process.versions.electron',
    'process.env.ELECTRON_RUN_AS_NODE', 'process.env.NODE_PATH', 'process.env.NODE_OPTIONS', 'process.env.ELECTRON_NO_ASAR']) {
    expect(script).toContain(observation)
  }
  expect(script).not.toContain('/src/')
  expect(script).not.toContain('tsx')
  expect(script).not.toContain('TSX_TSCONFIG_PATH')
  expect(args).not.toContain('--import')
  expect(() => packagedGraphCheckArguments('relative-profile', runtimeRoot, ['plugin'])).toThrow('must be absolute')
  expect(() => packagedGraphCheckArguments(profile, runtimeRoot, [])).toThrow('Active plugin names are required')
})

it('refuses a missing or escaped packaged app-boot before importing package code', () => {
  const { runtimeRoot, runnerModules } = fixture()
  const marker = join(runnerModules, 'loaded')
  const foreign = writePackage(runnerModules, '@deepseek-ai/dsh-app-boot', {},
    `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded')\n`)
  expect(() => resolvePackagedAppBoot(runtimeRoot)).toThrow()
  symlinkSync(foreign, join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => resolvePackagedAppBoot(runtimeRoot)).toThrow('Packaged app-boot escapes the runtime')
  unlinkSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-app-boot'))
  const owned = writePackage(join(runtimeRoot, 'node_modules'), '@deepseek-ai/dsh-app-boot')
  expect(resolvePackagedAppBoot(runtimeRoot)).toBe(realpathSync(join(owned, 'index.js')))
  expect(existsSync(marker)).toBe(false)
})

it('uses the runtime fallback before foreign NODE_PATH copies of a shared peer', () => {
  const { runnerModules, environment, run } = fixture()
  writePackage(runnerModules, '@deepseek-ai/cordis', { version: '2.0.0' })
  exited(run({ ...environment, NODE_PATH: runnerModules }), 0)
})

it('does not accept an ancestor-supplied link merely because it points back into the profile', () => {
  const { profile, peer, environment, run } = fixture()
  const bundle = writePackage(join(profile, 'node_modules'), 'required-plugin', {
    peerDependencies: { [peer]: '^1.0.0' }, dsh: { bundle: { patch: './bundle.yml' } },
  })
  writeFileSync(join(bundle, 'bundle.yml'), '[]\n')
  const manifestPath = join(profile, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
  manifest.dsh.profile.bundles.push('required-plugin')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  const hidden = writePackage(join(profile, 'not-a-search-position'), peer)
  const ancestorModules = join(dirname(profile), 'node_modules')
  mkdirSync(ancestorModules, { recursive: true })
  symlinkSync(hidden, join(ancestorModules, peer), process.platform === 'win32' ? 'junction' : 'dir')
  const result = run(environment, 'required-plugin')
  exited(result, 1)
  expect(result.stdout).toContain(`required-plugin resolves ${peer} outside its owned packages`)
})

it('rejects a same-version peer with the wrong manifest identity', () => {
  const { profile, peer, environment, run } = fixture()
  writePackage(join(profile, 'node_modules'), peer, { name: 'wrong-peer' })
  const result = run(environment)
  exited(result, 1)
  expect(result.stdout).toContain(`plugin resolves ${peer} to a different package identity`)
})

it('rejects a package manifest redirected outside its owned package directory', () => {
  const { profile, runnerModules, environment, run } = fixture()
  const external = join(runnerModules, 'plugin-manifest.json')
  writeFileSync(external, JSON.stringify({ name: 'plugin', version: '1.0.0' }))
  const manifest = join(profile, 'node_modules', 'plugin', 'package.json')
  unlinkSync(manifest)
  symlinkSync(external, manifest, 'file')
  const result = run(environment)
  exited(result, 1)
  expect(result.stdout).toContain('Package manifest must be a regular file')
})

it('validates the descriptor-owned Host without adding it to the CLI generation', async () => {
  const { profile, runtimeRoot, environment, run } = fixture()
  const installAnchor = join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const generation = await createProfileResolutionGeneration({
    installAnchor,
    profile: loadProfileDirectory('graph fixture', profile, installAnchor),
    home: dirname(dirname(profile)),
  })
  expect(readDesktopRuntime(runtimeRoot).sharedPackages.some(entry => entry.name === '@deepseek-ai/dsh-desktop-host')).toBe(true)
  expect(generation.entries.some(entry => entry.name === '@deepseek-ai/dsh-desktop-host')).toBe(false)
  expect(generation.entries.some(entry => entry.name === '@deepseek-ai/cordis' && entry.scope === 'installation')).toBe(true)
  const result = run(environment)
  exited(result, 0)
  expect(JSON.parse(result.stdout)).toEqual({ valid: true })
})

it('rejects a missing descriptor-only Host package', () => {
  const { runtimeRoot, environment, run } = fixture()
  rmSync(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-desktop-host'), { recursive: true })
  const result = run(environment)
  exited(result, 1)
  expect(result.stdout).toContain('ENOENT')
  expect(result.stdout).toContain('dsh-desktop-host')
})

it.each(['name', 'version'] as const)('rejects a descriptor-only Host with the wrong %s', (field) => {
  const { runtimeRoot, environment, run } = fixture()
  writePackage(join(runtimeRoot, 'node_modules'), '@deepseek-ai/dsh-desktop-host', {
    [field]: field === 'name' ? 'wrong-host' : '2.0.0',
  })
  const result = run(environment)
  exited(result, 1)
  expect(result.stdout).toContain(field === 'name'
    ? 'runtime shared package @deepseek-ai/dsh-desktop-host differs from its descriptor identity'
    : 'runtime shared package @deepseek-ai/dsh-desktop-host differs from its descriptor')
})

it('rejects a descriptor-only Host provider that escapes the sealed runtime', () => {
  const { runtimeRoot, runnerModules, environment, run } = fixture()
  const host = '@deepseek-ai/dsh-desktop-host'
  const provider = join(runtimeRoot, 'node_modules', host)
  rmSync(provider, { recursive: true })
  const outside = writePackage(runnerModules, host)
  symlinkSync(outside, provider, process.platform === 'win32' ? 'junction' : 'dir')
  const result = run(environment)
  exited(result, 1)
  expect(result.stdout).toContain(`shared provider ${host} escapes its runtime`)
})

it.each(['dependencies', 'peerDependencies'] as const)('does not supply a descriptor-only Host to plugin %s', (field) => {
  const { profile, runtimeRoot, environment, run } = fixture()
  const host = '@deepseek-ai/dsh-desktop-host'
  writePackage(join(profile, 'node_modules'), 'plugin', { [field]: { [host]: '^1.0.0' } })
  const absent = run(environment)
  exited(absent, 1)
  expect(absent.stdout).toContain(`plugin resolves ${host} outside its owned packages`)
  const link = join(profile, 'node_modules', host)
  mkdirSync(dirname(link), { recursive: true })
  symlinkSync(join(runtimeRoot, 'node_modules', host), link, process.platform === 'win32' ? 'junction' : 'dir')
  const unselected = run(environment)
  exited(unselected, 1)
  expect(unselected.stdout).toContain(`unselected runtime package ${host}`)
})

it('requires the exact shared provider path declared by the descriptor', () => {
  const { runtimeRoot, environment, run } = fixture()
  writePackage(join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh', 'node_modules'), '@deepseek-ai/cordis')
  const result = run(environment)
  exited(result, 1)
  expect(result.stdout).toContain('runtime shared package @deepseek-ai/cordis differs from its descriptor provider')
})

it.each(['dependencies', 'optionalDependencies', 'peerDependencies'])('rejects a malformed %s map', (field) => {
  const { profile, environment, run } = fixture()
  writePackage(join(profile, 'node_modules'), 'plugin', { [field]: [] })
  const result = run(environment)
  exited(result, 1)
  expect(result.stdout).toContain(`plugin has an invalid ${field} map`)
})

it('recognizes explicit npm alias identity and checks its semver requirement', () => {
  const { profile, peer, environment, run } = fixture()
  writePackage(join(profile, 'node_modules'), 'plugin', { dependencies: { [peer]: 'npm:actual-package@^1.0.0' } })
  writePackage(join(profile, 'node_modules'), peer, { name: 'actual-package' })
  exited(run(environment), 0)
  writePackage(join(profile, 'node_modules'), peer, { name: 'actual-package', version: '2.0.0' })
  const result = run(environment)
  exited(result, 1)
  expect(result.stdout).toContain(`plugin requires ${peer}@^1.0.0, found 2.0.0`)
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

it('rejects an incompatible profile-owned optional peer instead of treating it as absent', () => {
  const { profile, peer, environment, run } = fixture()
  writePackage(join(profile, 'node_modules'), peer, { version: '2.0.0' })
  const result = run(environment)
  exited(result, 1)
  expect(result.stdout).toContain(`plugin requires ${peer}@^1.0.0, found 2.0.0`)
})

it.each(['@deepseek-ai/cordis', '@deepseek-ai/dsh-desktop-host'])('rejects a private duplicate of %s even at the same version', (name) => {
  const { profile, environment, run } = fixture()
  writePackage(join(profile, 'node_modules'), 'plugin', { peerDependencies: { [name]: '^1.0.0' } })
  writePackage(join(profile, 'node_modules'), name)
  const result = run(environment)
  exited(result, 1)
  expect(result.stdout).toContain(`private duplicate of runtime shared package ${name}`)
})

it('rejects an active package link that leaves the profile', () => {
  const { profile, runnerModules, environment, run } = fixture()
  const outside = writePackage(runnerModules, 'escaped-plugin')
  symlinkSync(outside, join(profile, 'node_modules', 'escaped-plugin'), process.platform === 'win32' ? 'junction' : 'dir')
  const result = run(environment, 'escaped-plugin')
  exited(result, 1)
  expect(result.stdout).toContain('active plugin escaped-plugin is outside its owned packages')
})

it('uses an owned bundle fallback but never skips an escaping nearer peer link', () => {
  const { profile, peer, runnerModules, environment, run } = fixture()
  const bundle = writePackage(join(profile, 'node_modules'), 'fallback-bundle', {
    dependencies: { [peer]: '^1.0.0' }, dsh: { bundle: { patch: './bundle.yml' } },
  })
  writeFileSync(join(bundle, 'bundle.yml'), '[]\n')
  writePackage(join(bundle, 'node_modules'), peer)
  const manifestPath = join(profile, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dsh: { profile: { bundles: string[] } } }
  manifest.dsh.profile.bundles.push('fallback-bundle')
  writeFileSync(manifestPath, JSON.stringify(manifest))
  writePackage(join(profile, 'node_modules'), 'required-plugin', { peerDependencies: { [peer]: '^1.0.0' } })
  const fallback = run(environment, 'required-plugin')
  exited(fallback, 0)
  symlinkSync(join(runnerModules, peer), join(profile, 'node_modules', peer), process.platform === 'win32' ? 'junction' : 'dir')
  const escaped = run(environment, 'required-plugin')
  exited(escaped, 1)
  expect(escaped.stdout).toContain(`required-plugin resolves ${peer} outside its owned packages`)
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
