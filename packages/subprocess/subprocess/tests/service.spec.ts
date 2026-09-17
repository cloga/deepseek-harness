import { describe, expect, it } from 'vitest'
import { PassThrough } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import { scrubbedParentEnv, SubprocessRuntime } from '@deepseek-ai/dsh-subprocess'
import type {
  SubprocessHandle,
  SubprocessOutputRead,
  SubprocessSpawnSpec,
  SubprocessTerminalHandle,
  SubprocessTerminalSpawnSpec,
} from '@deepseek-ai/dsh-subprocess'

/**
 * Minimal concrete service: a hand-built handle. The seam is spawn-only —
 * defaulting, shell semantics, and deadlines belong to callers — so this stub
 * is all an implementation owes the abstract class.
 */
class StubSubprocessRuntime extends SubprocessRuntime {
  async resolveExecutable(command: string): Promise<string> {
    return `/bin/${command}`
  }

  spawn(spec: SubprocessSpawnSpec): SubprocessHandle {
    const read: SubprocessOutputRead = { text: '', nextOffset: 0, lossy: false }
    const collected = spec.stdio.stdout !== 'pipe' && spec.stdio.stdout !== 'inherit'
      ? { stdout: { readFrom: () => read } }
      : {}
    return {
      stdin: undefined,
      stdout: undefined,
      stderr: undefined,
      collected,
      done: Promise.resolve({ exitCode: 0, signal: null }),
      terminate: () => {},
      waitForExit: () => Promise.resolve(true),
    }
  }

  async spawnTerminal(spec: SubprocessTerminalSpawnSpec): Promise<SubprocessTerminalHandle> {
    return {
      pid: spec.argv.length,
      output: new PassThrough(),
      done: Promise.resolve({ exitCode: 0, signal: null }),
      write: async () => {},
      inspectForeground: async () => ({ processGroupId: 1, inputWaiting: true }),
      signalForeground: async () => 1,
      terminate: async () => {},
    }
  }
}

describe('SubprocessRuntime seam', () => {
  it('a concrete subclass registers as ctx.subprocess and serves the abstract API', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSubprocessRuntime)
    const handle = ctx.subprocess.spawn({
      argv: ['true'],
      cwd: '/stub',
      stdio: { stdin: 'ignore', stdout: { maxBytes: 1 }, stderr: 'inherit' },
      graceMs: 1,
    })
    expect(Object.hasOwn(handle, 'pid')).toBe(false)
    expect(handle.collected.stdout!.readFrom(0)).toEqual({ text: '', nextOffset: 0, lossy: false })
    handle.terminate()
    await expect(handle.waitForExit()).resolves.toBe(true)
    const outcome = await handle.done
    expect(outcome.exitCode).toBe(0)
  })

  it('loading a second implementation throws (one subprocess service per context — cordis standard)', async () => {
    const ctx = new Context()
    await ctx.plugin(StubSubprocessRuntime)
    class SecondService extends StubSubprocessRuntime {}
    await expect(ctx.plugin(SecondService)).rejects.toThrow(/service "subprocess" has been registered/)
  })

  it.each<{ label: string; entries: Record<string, string> }>([
    { label: 'zero count', entries: { GIT_CONFIG_COUNT: '0' } },
    { label: 'one pair', entries: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.quotepath', GIT_CONFIG_VALUE_0: 'false' } },
    {
      label: 'multiple pairs',
      entries: {
        GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'core.quotepath', GIT_CONFIG_VALUE_0: 'false',
        GIT_CONFIG_KEY_1: 'core.bare', GIT_CONFIG_VALUE_1: 'false',
      },
    },
    { label: 'sparse indices', entries: { GIT_CONFIG_COUNT: '5', GIT_CONFIG_KEY_4: 'core.quotepath', GIT_CONFIG_VALUE_4: 'false' } },
    { label: 'missing key', entries: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_VALUE_0: 'false' } },
    { label: 'missing value', entries: { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.quotepath' } },
    { label: 'orphan pair', entries: { GIT_CONFIG_KEY_7: 'core.quotepath', GIT_CONFIG_VALUE_7: 'false' } },
    { label: 'orphan value', entries: { GIT_CONFIG_VALUE_9: 'false' } },
    {
      label: 'mixed case',
      entries: { git_config_count: '1', Git_Config_Key_0: 'core.quotepath', Git_Config_Value_0: 'false', git_config_parameters: "'core.quotepath=false'" },
    },
    { label: 'legacy parameters', entries: { GIT_CONFIG_PARAMETERS: "'core.quotepath=false'" } },
  ])('scrubbedParentEnv removes ambient Git temporary configuration: $label', ({ entries }) => {
    const originalEnv = process.env
    const retained = {
      PATH: '/synthetic/bin', HOME: '/synthetic/home',
      GIT_CONFIG_GLOBAL: '/synthetic/global', GIT_CONFIG_SYSTEM: '/synthetic/system', GIT_CONFIG_NOSYSTEM: '1',
    }
    // Replace rather than copy ambient values: the fixture never reads real Git configuration.
    process.env = { ...retained, ...entries }
    try {
      expect(scrubbedParentEnv()).toEqual(retained)
    } finally {
      process.env = originalEnv
    }
  })

  it('scrubbedParentEnv rejects temporary Git configuration by name without reading its values', () => {
    const originalEnv = process.env
    const fixture: NodeJS.ProcessEnv = { PATH: '/synthetic/bin', UNSET: undefined }
    for (const key of ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GIT_CONFIG_PARAMETERS']) {
      Object.defineProperty(fixture, key, {
        enumerable: true,
        get: () => { throw new Error('filtered value must not be read') },
      })
    }
    process.env = fixture
    try {
      expect(scrubbedParentEnv()).toEqual({ PATH: '/synthetic/bin' })
    } finally {
      process.env = originalEnv
    }
  })

  it('scrubbedParentEnv drops credential-shaped and DSH_ names (case-insensitively) but keeps PATH', () => {
    process.env.DSH_SCRUB_PROBE = 'stale'
    process.env.dsh_scrub_probe_lower = 'stale'
    process.env.SCRUB_PROBE_TOKEN = 'secret'
    process.env.SCRUB_PROBE_PASSWORD = 'secret'
    process.env.SCRUB_PROBE_PLAIN = 'visible'
    try {
      const env = scrubbedParentEnv()
      expect(env.DSH_SCRUB_PROBE).toBeUndefined()
      expect(env.dsh_scrub_probe_lower).toBeUndefined()
      expect(env.SCRUB_PROBE_TOKEN).toBeUndefined()
      expect(env.SCRUB_PROBE_PASSWORD).toBeUndefined()
      expect(env.SCRUB_PROBE_PLAIN).toBe('visible')
      expect(env.PATH).toBeDefined()
    } finally {
      delete process.env.DSH_SCRUB_PROBE
      delete process.env.dsh_scrub_probe_lower
      delete process.env.SCRUB_PROBE_TOKEN
      delete process.env.SCRUB_PROBE_PASSWORD
      delete process.env.SCRUB_PROBE_PLAIN
    }
  })
})
