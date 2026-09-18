/** Minimal Context + actual ASAR skills verification, not production Host/profile health. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve, win32 } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packagedDesktopRuntimeRoot } from '../../scripts/packaged-runtime.mjs'

const expectedNames = ['cordis-plugin-development', 'editing-cordis-compositions', 'packaged-user-one', 'packaged-user-two']

/**
 * Narrow the official smoke-environment.ts OS allowlist for a standalone Electron Node child.
 * No ambient PATH, loader options, provider settings, proxies, or user state are inherited.
 * @param {string} home - Newly created private directory owned by this smoke.
 * @param {string} executable - Explicitly supplied packaged Electron executable.
 * @param {NodeJS.ProcessEnv} inherited - Environment from which only OS roots are admitted.
 * @param {string} platform - Path platform, injectable for pure cross-platform checks.
 * @returns {Record<string, string>} Child-only environment with private state roots.
 */
export function packagedSkillsEnvironment(home, executable, inherited = process.env, platform = process.platform) {
  const paths = platform === 'win32' ? win32 : posix
  assert(paths.isAbsolute(home), 'The smoke home must be absolute')
  assert(paths.isAbsolute(executable), 'The packaged executable must be absolute')
  const environment = {}
  const allowed = new Set(['SYSTEMROOT', 'WINDIR'])
  for (const [name, value] of Object.entries(inherited)) {
    if (allowed.has(name.toUpperCase()) && value !== undefined) environment[name.toUpperCase()] = value
  }
  const systemPath = platform === 'win32'
    ? (environment.SYSTEMROOT ? paths.join(environment.SYSTEMROOT, 'System32') : '')
    : '/usr/bin:/bin'
  return {
    ...environment,
    PATH: [paths.dirname(executable), systemPath].filter(Boolean).join(paths.delimiter),
    ELECTRON_RUN_AS_NODE: '1',
    HOME: home,
    USERPROFILE: home,
    ...(platform === 'win32' ? {
      HOMEDRIVE: paths.parse(home).root.slice(0, -1),
      HOMEPATH: home.slice(paths.parse(home).root.length - 1),
    } : {}),
    APPDATA: paths.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: paths.join(home, 'AppData', 'Local'),
    PROGRAMDATA: paths.join(home, 'ProgramData'),
    ALLUSERSPROFILE: paths.join(home, 'ProgramData'),
    PUBLIC: paths.join(home, 'Public'),
    DSH_HOME: home,
    DSH_AGENTS_HOME: paths.join(home, 'agents'),
    XDG_CONFIG_HOME: paths.join(home, 'config'),
    XDG_CACHE_HOME: paths.join(home, 'cache'),
    XDG_STATE_HOME: paths.join(home, 'state'),
    XDG_DATA_HOME: paths.join(home, 'data'),
    XDG_RUNTIME_DIR: paths.join(home, 'run'),
    TEMP: paths.join(home, 'temp'),
    TMP: paths.join(home, 'temp'),
    TMPDIR: paths.join(home, 'temp'),
  }
}

/**
 * Await cleanup without replacing an operation's thrown value; cleanup alone is fatal.
 * @param {() => unknown} operation - Work whose result or failure must be preserved.
 * @param {() => unknown} cleanup - Owned teardown, also awaited when work fails.
 * @param {(error: unknown) => void} reportCleanup - Record a secondary cleanup failure.
 * @returns {Promise<unknown>} Work result after cleanup, or the original thrown value.
 */
export async function withPackagedSkillsCleanup(operation, cleanup, reportCleanup) {
  let failed = false
  let primary
  let value
  try {
    value = await operation()
  } catch (error) {
    failed = true
    primary = error
  }
  try {
    await cleanup()
  } catch (error) {
    if (!failed) throw error
    try {
      reportCleanup(error)
    } catch (reportError) {
      // A broken diagnostic sink must not replace the primary operation failure.
      void reportError
    }
  }
  if (failed) throw primary
  return value
}

// The exact pure-tested implementation is embedded; no workspace runtime modules enter the child.
/** Generated Electron-only child, exported for pure syntax and cleanup regression checks. */
export const packagedSkillsChildSource = `const withPackagedSkillsCleanup = ${withPackagedSkillsCleanup.toString()};\n` + String.raw`
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { isAbsolute, join, relative, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
assert(process.versions.electron, 'The skill canary must execute under packaged Electron')
const runtime = process.argv[2]
const profile = process.argv[3]
const home = process.env.DSH_HOME
assert(home, 'The skill canary requires its private home')
const runtimeRoot = await realpath(runtime)
const packages = join(runtime, 'node_modules', '@deepseek-ai')
const owned = async path => {
  const canonical = await realpath(path)
  const child = relative(runtimeRoot, canonical)
  assert(child !== '' && !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep),
    'Skill runtime sources must belong to the supplied ASAR runtime')
  return canonical
}
const load = async name => import(pathToFileURL(await owned(join(packages, name, 'lib', 'index.js'))).href)
const [{ Context }, { default: Loader }, { entryListSchema }, { default: Skills },
  { default: LocalFileSystem }, { default: Tools }, { default: Agents }, { default: SystemPrompt }] = await Promise.all([
  load('cordis'), load('cordis-plugin-loader'), load('cordis-plugin-include'), load('dsh-skill'),
  load('dsh-fs-local'), load('dsh-tools'), load('dsh-agent'), load('dsh-system-prompt'),
])
const preset = await owned(join(packages, 'dsh-agent-presets', 'presets', 'cordis'))
const presetRequire = createRequire(pathToFileURL(join(packages, 'dsh-agent-presets', 'package.json')))
await owned(presetRequire.resolve('js-yaml'))
const yaml = presetRequire('js-yaml')
const entries = yaml.load(await readFile(await owned(join(preset, 'agent.cordis.yml')), 'utf8'), { schema: entryListSchema })
assert(Array.isArray(entries), 'Packaged Cordis preset must contain an entry list')
const ctx = new Context()
const receipt = await withPackagedSkillsCleanup(async () => {
  ctx.baseUrl = pathToFileURL(preset + sep).href
  await ctx.plugin(Loader)
  await ctx.plugin(Skills)
  await ctx.plugin(LocalFileSystem, { cwd: home })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Agents)
  for (const id of ['skill-filesystem', 'tool-skill']) {
    const row = entries.find(entry => entry.id === id)
    assert(row, 'Packaged Cordis preset must contain ' + id)
    assert.equal(row.name, '@deepseek-ai/dsh-' + id)
    await owned(presetRequire.resolve(row.name))
    await ctx.loader.create(row)
    await ctx.loader.await()
  }
  assert(ctx.tools.get('skill'), 'Packaged skill tool must register')
  const snapshot = await ctx.skills.snapshot({ cwd: home })
  assert.equal(snapshot.complete, true, 'Packaged skill discovery did not complete')
  const names = ['cordis-plugin-development', 'editing-cordis-compositions', 'packaged-user-one', 'packaged-user-two']
  assert.deepEqual(snapshot.skills.map(skill => skill.name), names)
  const loaded = []
  for (const name of names) {
    const skill = await ctx.skills.get(name, { cwd: home })
    assert(skill?.content.length > 0, name + ' must contain instructions')
    assert.equal(skill.source, name.startsWith('packaged-user-') ? 'user-dsh' : 'bundled')
    if (skill.source === 'bundled') assert.equal(skill.path, await owned(join(preset, 'skills', name, 'SKILL.md')))
    else {
      assert.equal(skill.path, await realpath(join(home, 'skills', name, 'SKILL.md')))
      assert.equal(skill.content, 'Use the private ' + name + ' fixture.')
    }
    const result = await ctx.tools.execute({ name: 'skill', callId: 'packaged-' + name,
      arguments: { name }, signal: new AbortController().signal })
    assert.equal(result.isError, false, 'Packaged skill tool must load ' + name)
    assert.equal(result.value.content, skill.content)
    loaded.push(name)
  }
  return { complete: true, loaded, profile }
}, () => ctx.fiber.dispose(), error => console.error('Packaged skill Context disposal also failed:', error))
process.stdout.write(JSON.stringify(receipt) + '\n')
`

/**
 * Verify actual ASAR YAML/skills with minimal Cordis services and four real tool calls.
 * This does not launch the production Host or qualify a production profile.
 * @param {string} executable - Packaged Windows Electron executable supplied by the release build.
 * @returns {Promise<void>} Resolves after successful child execution and private-root cleanup.
 */
export async function verifyPackagedSkills(executable) {
  const application = resolve(executable)
  const runtime = packagedDesktopRuntimeRoot(join(dirname(application), 'resources'))
  const home = mkdtempSync(join(tmpdir(), 'desktop-packaged-skills-'))
  await withPackagedSkillsCleanup(async () => {
    const profile = join(home, 'profiles', 'desktop')
    const environment = packagedSkillsEnvironment(home, application)
    for (const name of ['APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PUBLIC', 'DSH_AGENTS_HOME',
      'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'TEMP']) {
      mkdirSync(environment[name], { recursive: true, mode: 0o700 })
    }
    mkdirSync(profile, { recursive: true, mode: 0o700 })
    // Stop project-root discovery at the owned workspace, not an ancestor of the OS temp directory.
    mkdirSync(join(home, '.git'), { mode: 0o700 })
    for (const name of expectedNames.filter(name => name.startsWith('packaged-user-'))) {
      const directory = join(home, 'skills', name)
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Private packaged skill canary\n---\n\nUse the private ${name} fixture.\n`, { flag: 'wx', mode: 0o600 })
    }
    const child = join(home, 'check.mjs')
    writeFileSync(child, packagedSkillsChildSource, { flag: 'wx', mode: 0o600 })
    const policy = pathToFileURL(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'register-module-resolution-policy.mjs')).href
    const result = spawnSync(application, ['--import', policy, child, runtime, profile], {
      cwd: home, env: environment,
      encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024,
    })
    if (result.error !== undefined) throw result.error
    assert.equal(result.signal, null, `Packaged skill child was terminated: ${result.signal}`)
    assert.equal(result.status, 0, `Packaged skill child exited ${result.status}: ${result.stderr}`)
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.complete, true)
    assert.deepEqual(receipt.loaded, expectedNames)
    assert.equal(receipt.profile, profile)
  }, () => rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }),
  error => console.error('Packaged skill private-root cleanup also failed:', error))
  process.stdout.write('ASAR skills: minimal Context + actual ASAR skills verification; packaged Cordis YAML discovered both bundled and private user skills; all four skill tool calls succeeded (not production Host/profile health)\n')
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert(process.argv[2], 'Pass an existing packaged Windows Electron executable')
  await verifyPackagedSkills(process.argv[2])
}
