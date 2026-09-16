import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { desktopSmokeEnvironment } from '../scripts/smoke-environment.ts'

it('admits OS execution settings without copying credential, proxy, or live profile variables', () => {
  const home = resolve('.desktop-smoke', 'environment-fixture')
  const environment = desktopSmokeEnvironment(home, {
    PATH: 'system-execution-path',
    GH_TOKEN: 'synthetic-gh-token',
    GITHUB_TOKEN: 'synthetic-github-token',
    DEEPSEEK_API_KEY: 'synthetic-model-key',
    HTTP_PROXY: 'http://unrelated-proxy.invalid',
    NODE_OPTIONS: '--import unrelated-module',
    DSH_HOME: 'unrelated-home',
    USERPROFILE: 'unrelated-profile',
    APPDATA: 'unrelated-roaming',
    LOCALAPPDATA: 'unrelated-local',
  })
  expect(environment['PATH']).toBe('system-execution-path')
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'DEEPSEEK_API_KEY', 'HTTP_PROXY', 'NODE_OPTIONS']) {
    expect(environment).not.toHaveProperty(key)
  }
  expect(environment['DSH_HOME']).toBe(home)
  expect(environment['USERPROFILE']).toBe(home)
  expect(environment['APPDATA']).toBe(join(home, 'AppData', 'Roaming'))
  expect(environment['LOCALAPPDATA']).toBe(join(home, 'AppData', 'Local'))
  if (process.platform === 'win32') expect(environment['HOMEDRIVE']! + environment['HOMEPATH']!).toBe(home)
})
