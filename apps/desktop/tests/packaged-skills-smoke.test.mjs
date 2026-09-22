/** Pure environment/cleanup regressions; never launch Electron, an ASAR, or the Harness. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, win32 } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import {
  packagedSkillsChildSource,
  packagedSkillsEnvironment,
  withPackagedSkillsCleanup,
} from './fixtures/packaged-skills-smoke.mjs'

const stateNames = ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'ALLUSERSPROFILE',
  'PUBLIC', 'DSH_HOME', 'DSH_AGENTS_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME',
  'XDG_DATA_HOME', 'XDG_RUNTIME_DIR', 'TEMP', 'TMP', 'TMPDIR']

for (const [platform, paths, home, executable, systemRoot] of [
  ['win32', win32, 'C:\\private\\owned-smoke', 'C:\\packaged\\Desktop.exe', 'C:\\Windows'],
  ['linux', posix, '/private/owned-smoke', '/packaged/electron', '/system'],
]) {
  test(`${platform}: explicit allowlist excludes credentials, arbitrary markers and original state roots`, () => {
    const inherited = {
      SystemRoot: systemRoot, windir: systemRoot,
      PATH: 'ORIGINAL_PROFILE/private-bin', Path: 'ORIGINAL_PROFILE/other-bin',
      SYNTHETIC_SENSITIVE_MARKER: 'synthetic-sensitive-value', OPENAI_API_KEY: 'synthetic-token',
      GITHUB_TOKEN: 'synthetic-token', NODE_OPTIONS: '--import=untrusted', NODE_PATH: 'untrusted-modules',
      ELECTRON_RUN_AS_NODE: '0', ELECTRON_NO_ASAR: '1',
      HTTPS_PROXY: 'https://synthetic-proxy.invalid', ALL_PROXY: 'synthetic-proxy',
      DEEPSEEK_BASE_URL: 'https://synthetic-provider.invalid', DSH_BUNDLED_SKILL_DIR: 'ORIGINAL_PROFILE/skills',
      DSH_DESKTOP_PROFILE_DIR: 'ORIGINAL_PROFILE/profile', npm_config_userconfig: 'ORIGINAL_PROFILE/npmrc',
      HOMEDRIVE: 'Z:', HOMEPATH: '\\ORIGINAL_PROFILE', home: 'ORIGINAL_PROFILE/lowercase',
      XDG_CONFIG_DIRS: 'ORIGINAL_PROFILE/config', XDG_DATA_DIRS: 'ORIGINAL_PROFILE/data',
    }
    for (const name of stateNames) inherited[name] = `ORIGINAL_PROFILE/${name}`
    const original = { ...inherited }
    const environment = packagedSkillsEnvironment(home, executable, inherited, platform)
    assert.deepEqual(inherited, original, 'The parent environment must not be changed')
    const expectedKeys = [...stateNames, 'PATH', 'SYSTEMROOT', 'WINDIR', 'ELECTRON_RUN_AS_NODE',
      ...(platform === 'win32' ? ['HOMEDRIVE', 'HOMEPATH'] : [])].sort()
    assert.deepEqual(Object.keys(environment).sort(), expectedKeys)
    assert.equal(environment.SYSTEMROOT, systemRoot)
    assert.equal(environment.WINDIR, systemRoot)
    assert.equal(environment.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(environment.PATH, platform === 'win32' ? 'C:\\packaged;C:\\Windows\\System32' : '/packaged:/usr/bin:/bin')
    for (const value of Object.values(environment)) {
      assert.doesNotMatch(value, /ORIGINAL_PROFILE|synthetic-|untrusted/u)
    }
    for (const name of stateNames) {
      const relative = paths.relative(home, environment[name])
      assert(paths.isAbsolute(environment[name]), `${name} must be absolute`)
      assert(relative === '' || (!paths.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${paths.sep}`)),
        `${name} must be inside the private root`)
    }
    if (platform === 'win32') assert.equal(environment.HOMEDRIVE + environment.HOMEPATH, home)
  })
}

test('environment requires absolute owned-home and executable paths', () => {
  assert.throws(() => packagedSkillsEnvironment('relative', '/app/electron', {}, 'linux'), /home must be absolute/u)
  assert.throws(() => packagedSkillsEnvironment('/private', 'relative', {}, 'linux'), /executable must be absolute/u)
})

// Extract and execute the generated child's exact helper, not a second test-only implementation.
const helperPrefix = `const withPackagedSkillsCleanup = ${withPackagedSkillsCleanup.toString()};\n`
assert(packagedSkillsChildSource.startsWith(helperPrefix))
const embeddedCleanup = runInNewContext(packagedSkillsChildSource.slice(0, helperPrefix.length) + 'withPackagedSkillsCleanup')

for (const [label, cleanupControl] of [['parent', withPackagedSkillsCleanup], ['embedded child', embeddedCleanup]]) {
  test(`${label}: primary plus cleanup failure keeps exact primary identity and reports cleanup`, async () => {
    const primary = Object.freeze(new Error('primary verification failed'))
    const secondary = new Error('owned cleanup failed')
    const reports = []
    let cleaned = 0
    await assert.rejects(cleanupControl(async () => { throw primary }, async () => {
      cleaned++
      throw secondary
    }, error => reports.push(error)), error => error === primary)
    assert.equal(cleaned, 1)
    assert.deepEqual(reports, [secondary])
    assert.equal(primary.message, 'primary verification failed')
  })

  test(`${label}: cleanup-only failure is fatal`, async () => {
    const secondary = new Error('cleanup alone failed')
    const reports = []
    await assert.rejects(cleanupControl(() => 'success', () => { throw secondary }, error => reports.push(error)),
      error => error === secondary)
    assert.deepEqual(reports, [])
  })

  test(`${label}: success awaits cleanup once before returning the original value`, async () => {
    const order = []
    const value = {}
    assert.equal(await cleanupControl(() => { order.push('operation'); return value }, async () => {
      await Promise.resolve()
      order.push('cleanup')
    }, () => assert.fail('No cleanup error expected')), value)
    assert.deepEqual(order, ['operation', 'cleanup'])
  })

  test(`${label}: primary-only failure survives successful cleanup`, async () => {
    const primary = new Error('primary alone failed')
    let cleaned = false
    await assert.rejects(cleanupControl(() => { throw primary }, () => { cleaned = true },
      () => assert.fail('No cleanup error expected')), error => error === primary)
    assert.equal(cleaned, true)
  })

  test(`${label}: undefined thrown value and a broken diagnostic sink do not hide primary failure`, async () => {
    let caught = false
    try {
      await cleanupControl(() => { throw undefined }, () => { throw new Error('cleanup') },
        () => { throw new Error('diagnostic sink') })
    } catch (error) {
      caught = true
      assert.equal(error, undefined)
    }
    assert.equal(caught, true)
  })
}

test('parent cleanup removes only its newly owned fixture after operation failure', async () => {
  const root = mkdtempSync(join(tmpdir(), 'packaged-skills-pure-'))
  const primary = new Error('fixture primary')
  try {
    await assert.rejects(withPackagedSkillsCleanup(() => {
      writeFileSync(join(root, 'owned.txt'), 'private fixture', { flag: 'wx', mode: 0o600 })
      throw primary
    }, () => rmSync(root, { recursive: true, force: true }),
    () => assert.fail('Fixture cleanup must succeed')), error => error === primary)
    assert.equal(existsSync(root), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('generated Electron child parses under Node without executing its ASAR code', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '--check'], {
    input: packagedSkillsChildSource, encoding: 'utf8', timeout: 10_000, windowsHide: true,
    env: packagedSkillsEnvironment(join(tmpdir(), 'packaged-skills-syntax-only'), process.execPath),
  })
  if (result.error !== undefined) throw result.error
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr)
})
