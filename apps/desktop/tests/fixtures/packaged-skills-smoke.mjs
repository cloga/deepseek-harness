/** Credential-free skill loading against the supplied application's actual ASAR runtime. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packagedDesktopRuntimeEnvironment, packagedDesktopRuntimeRoot } from '../../scripts/packaged-runtime.mjs'

const expectedNames = ['cordis-plugin-development', 'editing-cordis-compositions', 'packaged-user-one', 'packaged-user-two']
const childSource = String.raw`
import assert from 'node:assert/strict'
import { readFile, realpath } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
assert(process.versions.electron, 'The skill canary must execute under packaged Electron')
const runtime = process.argv[2]
const profile = process.argv[3]
const home = process.env.DSH_HOME
assert(home, 'The skill canary requires its private home')
const packages = join(runtime, 'node_modules', '@deepseek-ai')
const load = name => import(pathToFileURL(join(packages, name, 'lib', 'index.js')).href)
const [{ Context }, { default: Loader }, { entryListSchema }, { default: Skills },
  { default: LocalFileSystem }, { default: Tools }, { default: Agents }, { default: SystemPrompt }] = await Promise.all([
  load('cordis'), load('cordis-plugin-loader'), load('cordis-plugin-include'), load('dsh-skill'),
  load('dsh-fs-local'), load('dsh-tools'), load('dsh-agent'), load('dsh-system-prompt'),
])
const preset = join(packages, 'dsh-agent-presets', 'presets', 'cordis')
const yaml = createRequire(pathToFileURL(join(packages, 'dsh-agent-presets', 'package.json')))('js-yaml')
const entries = yaml.load(await readFile(join(preset, 'agent.cordis.yml'), 'utf8'), { schema: entryListSchema })
assert(Array.isArray(entries), 'Packaged Cordis preset must contain an entry list')
const ctx = new Context()
ctx.baseUrl = pathToFileURL(preset + sep).href
try {
  await ctx.plugin(Loader)
  await ctx.plugin(Skills)
  await ctx.plugin(LocalFileSystem, { cwd: home })
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(Agents)
  for (const id of ['skill-filesystem', 'tool-skill']) {
    const row = entries.find(entry => entry.id === id)
    assert(row, 'Packaged Cordis preset must contain ' + id)
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
    if (skill.source === 'bundled') assert.equal(skill.path, await realpath(join(preset, 'skills', name, 'SKILL.md')))
    else assert.equal(skill.content, 'Use the private ' + name + ' fixture.')
    const result = await ctx.tools.execute({ name: 'skill', callId: 'packaged-' + name,
      arguments: { name }, signal: new AbortController().signal })
    assert.equal(result.isError, false, 'Packaged skill tool must load ' + name)
    assert.equal(result.value.content, skill.content)
    loaded.push(name)
  }
  process.stdout.write(JSON.stringify({ complete: true, loaded, profile }) + '\n')
} finally {
  await ctx.fiber.dispose()
}
`

/**
 * Execute real packaged skill discovery and tool calls without touching a user's profile.
 * @param {string} executable - Windows packaged Electron executable supplied by the release build.
 * @returns {void} Returns after the child exits and every expected skill has loaded.
 */
export function verifyPackagedSkills(executable) {
  const application = resolve(executable)
  const runtime = packagedDesktopRuntimeRoot(join(dirname(application), 'resources'))
  const home = mkdtempSync(join(tmpdir(), 'desktop-packaged-skills-'))
  try {
    const profile = join(home, 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    for (const name of expectedNames.filter(name => name.startsWith('packaged-user-'))) {
      const directory = join(home, 'skills', name)
      mkdirSync(directory, { recursive: true })
      writeFileSync(join(directory, 'SKILL.md'), `---\nname: ${name}\ndescription: Private packaged skill canary\n---\n\nUse the private ${name} fixture.\n`, { flag: 'wx', mode: 0o600 })
    }
    const child = join(home, 'check.mjs')
    writeFileSync(child, childSource, { flag: 'wx', mode: 0o600 })
    const policy = pathToFileURL(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'register-module-resolution-policy.mjs')).href
    const result = spawnSync(application, ['--import', policy, child, runtime, profile], {
      cwd: home,
      env: { ...packagedDesktopRuntimeEnvironment(), DSH_HOME: home, DSH_AGENTS_HOME: join(home, 'agents') },
      encoding: 'utf8', windowsHide: true, timeout: 120_000, maxBuffer: 1024 * 1024,
    })
    assert.equal(result.error, undefined, `Packaged skill child failed: ${result.error?.message}`)
    assert.equal(result.signal, null, `Packaged skill child was terminated: ${result.signal}`)
    assert.equal(result.status, 0, `Packaged skill child exited ${result.status}: ${result.stderr}`)
    const receipt = JSON.parse(result.stdout)
    assert.equal(receipt.complete, true)
    assert.deepEqual(receipt.loaded, expectedNames)
    assert.equal(receipt.profile, profile)
    process.stdout.write('ASAR skills: actual packaged Cordis preset discovered both bundled and private user skills; all four skill tool calls succeeded\n')
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert(process.argv[2], 'Pass an existing packaged Windows Electron executable')
  verifyPackagedSkills(process.argv[2])
}
