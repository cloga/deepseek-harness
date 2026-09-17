import { spawnSync } from 'node:child_process'
import { accessSync, constants, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { scrubbedParentEnv } from '../src/index.ts'

function gitExecutable(): string {
  const executable = process.platform === 'win32' ? 'git.exe' : 'git'
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (entry.length === 0) continue
    const candidate = resolve(entry, executable)
    try {
      accessSync(candidate, constants.X_OK)
      return realpathSync(candidate)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'EACCES') throw error
    }
  }
  throw new Error('Git is required on PATH for the isolated configuration regression')
}

it('real Git rejects a broken ambient config group and succeeds after scrubbing a complete synthetic group', () => {
  const git = gitExecutable()
  const root = mkdtempSync(join(tmpdir(), 'dsh-git-environment-'))
  try {
    const globalConfig = join(root, 'global.gitconfig')
    const systemConfig = join(root, 'system.gitconfig')
    writeFileSync(globalConfig, '')
    writeFileSync(systemConfig, '')
    // Whitelist only executable lookup and Windows loader support from the host.
    // All configuration, repository discovery, and home paths belong to this fixture.
    const base: Record<string, string> = {
      PATH: dirname(git),
      ...(process.env.SystemRoot === undefined ? {} : { SystemRoot: process.env.SystemRoot }),
      HOME: root, USERPROFILE: root, XDG_CONFIG_HOME: root,
      GIT_CONFIG_GLOBAL: globalConfig, GIT_CONFIG_SYSTEM: systemConfig, GIT_CONFIG_NOSYSTEM: '1',
      GIT_CEILING_DIRECTORIES: dirname(root), GIT_TERMINAL_PROMPT: '0',
      LANG: 'C', LC_ALL: 'C', LANGUAGE: 'C',
    }
    const run = (env: Record<string, string>) => spawnSync(
      git, ['-c', 'core.quotepath=false', 'config', '--bool', 'core.quotepath'],
      {
        cwd: root, env, encoding: 'utf8', windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000, killSignal: 'SIGKILL', maxBuffer: 64 * 1024,
      },
    )

    // Reproduce the former name-only scrub: KEY_0 was removed, COUNT/VALUE_0 survived.
    const broken = run({ ...base, GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'true' })
    expect(broken.error).toBeUndefined()
    expect(broken.signal).toBeNull()
    expect(broken.status).toBe(128)
    expect(broken.stderr).toContain('missing config key GIT_CONFIG_KEY_0')

    const originalEnv = process.env
    let scrubbed: Record<string, string>
    process.env = {
      ...base, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.quotepath', GIT_CONFIG_VALUE_0: 'true',
    }
    try {
      scrubbed = scrubbedParentEnv()
    } finally {
      process.env = originalEnv
    }
    const clean = run(scrubbed)
    expect(clean.error).toBeUndefined()
    expect(clean.signal).toBeNull()
    expect(clean.status).toBe(0)
    expect(clean.stderr).toBe('')
    expect(clean.stdout.trim()).toBe('false')
  } finally {
    // spawnSync has reaped each Git process before either assertion or cleanup runs.
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
