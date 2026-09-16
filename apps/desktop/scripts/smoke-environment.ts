/** Environment shared by smoke-owned Host and browser processes, without ambient credentials. */
import { join, parse } from 'node:path'

const OS_ENVIRONMENT_NAMES = new Set([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'LANG', 'LC_ALL',
  'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'PROGRAMDATA', 'PUBLIC',
  'ALLUSERSPROFILE', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME', 'OS',
])

/**
 * Keep only OS execution settings and redirect every application/user state location into the fixture.
 * @param home - Private directory owned by one smoke run.
 * @param inherited - OS environment to admit by name; defaults to this process.
 * @returns Child-only environment; no repository or user dotenv layer is copied.
 */
export function desktopSmokeEnvironment(home: string, inherited: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const environment: Record<string, string> = {}
  for (const name of Object.keys(inherited)) {
    if (OS_ENVIRONMENT_NAMES.has(name.toUpperCase())) {
      const value = inherited[name]
      if (value !== undefined) environment[name] = value
    }
  }
  return {
    ...environment,
    DSH_HOME: home,
    DSH_AGENTS_HOME: join(home, 'agents'),
    HOME: home,
    USERPROFILE: home,
    ...(process.platform === 'win32' ? {
      HOMEDRIVE: parse(home).root.slice(0, -1),
      HOMEPATH: home.slice(parse(home).root.length - 1),
    } : {}),
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_CACHE_HOME: join(home, 'cache'),
    XDG_STATE_HOME: join(home, 'state'),
    TEMP: home,
    TMP: home,
    TMPDIR: home,
  }
}
