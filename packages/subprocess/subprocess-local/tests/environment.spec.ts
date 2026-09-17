import { describe, expect, it, vi } from 'vitest'
import { childEnv } from '../src/spawn.ts'

// These tests only build environment objects; no platform-specific process is launched.
describe('childEnv', () => {
  it.each(['linux', 'win32'] as const)('keeps explicit Git configuration and credentials after ambient scrubbing on %s', (platformName) => {
    const originalEnv = process.env
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue(platformName)
    process.env = {
      PATH: '/synthetic/bin', GIT_CONFIG_GLOBAL: '/synthetic/global',
      GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_1: 'core.quotepath', GIT_CONFIG_VALUE_1: 'true',
      GIT_CONFIG_PARAMETERS: "'core.quotepath=true'", SYNTHETIC_API_TOKEN: 'ambient-placeholder',
    }
    const explicit = {
      GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.quotepath', GIT_CONFIG_VALUE_0: 'false',
      GIT_CONFIG_PARAMETERS: "'core.quotepath=false'", SYNTHETIC_API_TOKEN: 'explicit-placeholder',
      GIT_CONFIG_GLOBAL: undefined,
    }
    try {
      expect(childEnv()).toEqual({ PATH: '/synthetic/bin', GIT_CONFIG_GLOBAL: '/synthetic/global' })
      expect(childEnv(explicit)).toEqual({ PATH: '/synthetic/bin', ...explicit })
      expect(explicit.GIT_CONFIG_VALUE_0).toBe('false')
    } finally {
      process.env = originalEnv
      platform.mockRestore()
    }
  })

  it('folds Windows override names and tombstones without filtering explicit lowercase Git entries', () => {
    const originalEnv = process.env
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    process.env = { PATH: '/ambient/bin', GIT_CONFIG_GLOBAL: '/ambient/global' }
    const explicit = {
      Path: '/explicit/bin', git_config_global: undefined,
      git_config_count: '1', git_config_key_0: 'core.quotepath', git_config_value_0: 'false',
    }
    try {
      expect(childEnv(explicit)).toEqual(explicit)
    } finally {
      process.env = originalEnv
      platform.mockRestore()
    }
  })
})
