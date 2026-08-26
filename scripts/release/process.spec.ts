/** Cross-platform command resolution for release subprocesses. */

import { describe, expect, it } from 'vitest'
import { commandInvocation } from './process.ts'

describe('release process commands', () => {
  it('uses Windows package-manager command shims', () => {
    expect(commandInvocation('npm', ['install'], 'win32', 'cmd.exe')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'npm.cmd', 'install'],
    })
    expect(commandInvocation('pnpm', ['pack'], 'win32', 'cmd.exe')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'pnpm.cmd', 'pack'],
    })
  })

  it('leaves native executables and POSIX commands unchanged', () => {
    expect(commandInvocation('git', ['status'], 'win32', 'cmd.exe')).toEqual({
      command: 'git',
      args: ['status'],
    })
    expect(commandInvocation('pnpm', ['pack'], 'linux')).toEqual({
      command: 'pnpm',
      args: ['pack'],
    })
  })

  it('runs an absolute Windows command shim through ComSpec', () => {
    expect(commandInvocation('C:\\local dsh\\dsh.cmd', ['--version'], 'win32', 'cmd.exe')).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', 'call', 'C:\\local dsh\\dsh.cmd', '--version'],
    })
  })
})
