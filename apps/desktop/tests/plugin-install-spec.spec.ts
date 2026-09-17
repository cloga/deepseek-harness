import { describe, expect, it } from 'vitest'
import { parseDesktopPluginInstallSpec, type DesktopPluginInstallSpec } from '../src/plugin-install-spec.ts'

const cwd = '/work/plugins'
const sha = 'c337dc1af7b5c8a5578e03150bf5c4d6133f66f9'

interface Accepted {
  readonly input: string
  readonly cwd?: string
  readonly expected: DesktopPluginInstallSpec
}

const accepted: Accepted[] = [
  ...['memory', 'memory@1.2.3', 'memory@1.2.3-beta.1+build.2', 'memory@latest', 'memory@next-2', 'memory@^1.2.3', 'memory@~1.2', 'memory@>=1.2.0 <2', 'memory@1.0.0 - 2.0.0', 'memory@^1 || ^2', 'memory@*', 'memory@1.x', 'memory@>= 1.2.3', 'memory.tgz'].map(input => ({
    input,
    expected: { kind: 'registry' as const, spec: input, name: input.split('@')[0]! },
  })),
  { input: '@scope/memory', expected: { kind: 'registry', spec: '@scope/memory', name: '@scope/memory' } },
  { input: '@scope/memory@>=1 <3', expected: { kind: 'registry', spec: '@scope/memory@>=1 <3', name: '@scope/memory' } },
  { input: '  memory@^1 || ^2  ', expected: { kind: 'registry', spec: 'memory@^1 || ^2', name: 'memory' } },
  ...['github:csyangwen/dsh-memory-evolve', 'csyangwen/dsh-memory-evolve', 'https://github.com/csyangwen/dsh-memory-evolve', 'https://github.com/csyangwen/dsh-memory-evolve.git', 'git+https://github.com/csyangwen/dsh-memory-evolve.git'].flatMap(input => [
    { input, expected: { kind: 'github' as const, spec: input, owner: 'csyangwen', repo: 'dsh-memory-evolve' } },
    ...['main', 'v1.2.3', 'feature/branch-one', 'releases/v1.0+build', sha].map(ref => ({
      input: `${input}#${ref}`,
      expected: { kind: 'github' as const, spec: `${input}#${ref}`, owner: 'csyangwen', repo: 'dsh-memory-evolve', ref },
    })),
  ]),
  { input: 'github:Some-Owner/Some_Repo.git#topic', expected: { kind: 'github', spec: 'github:Some-Owner/Some_Repo.git#topic', owner: 'Some-Owner', repo: 'Some_Repo', ref: 'topic' } },
  { input: './memory', expected: { kind: 'directory', spec: './memory', path: '/work/plugins/memory' } },
  { input: '../memory', expected: { kind: 'directory', spec: '../memory', path: '/work/memory' } },
  { input: '/opt/a/../memory', expected: { kind: 'directory', spec: '/opt/a/../memory', path: '/opt/memory' } },
  { input: 'file:memory', expected: { kind: 'directory', spec: 'file:memory', path: '/work/plugins/memory' } },
  { input: 'file:../memory', expected: { kind: 'directory', spec: 'file:../memory', path: '/work/memory' } },
  { input: 'file:/opt/memory', expected: { kind: 'directory', spec: 'file:/opt/memory', path: '/opt/memory' } },
  { input: 'link:./memory', expected: { kind: 'directory', spec: 'link:./memory', path: '/work/plugins/memory' } },
  { input: 'link:./folder.tgz', expected: { kind: 'directory', spec: 'link:./folder.tgz', path: '/work/plugins/folder.tgz' } },
  ...['./memory.tgz', './memory.tar.gz', './memory.TGZ', 'file:memory.tgz'].map(input => ({
    input,
    expected: { kind: 'tarball' as const, spec: input, path: `/work/plugins/${input.replace(/^(?:\.\/|file:)/u, '')}` },
  })),
  { input: './记忆 plugins/$HOME; echo & (x) [y] #z.tgz', expected: { kind: 'tarball', spec: './记忆 plugins/$HOME; echo & (x) [y] #z.tgz', path: '/work/plugins/记忆 plugins/$HOME; echo & (x) [y] #z.tgz' } },
  { input: 'C:\\plugins\\..\\记忆 plugin', expected: { kind: 'directory', spec: 'C:\\plugins\\..\\记忆 plugin', path: 'C:\\记忆 plugin' } },
  { input: 'C:/plugins/pkg.tgz', expected: { kind: 'tarball', spec: 'C:/plugins/pkg.tgz', path: 'C:\\plugins\\pkg.tgz' } },
  { input: 'file:D:\\plugins\\pkg.tar.gz', expected: { kind: 'tarball', spec: 'file:D:\\plugins\\pkg.tar.gz', path: 'D:\\plugins\\pkg.tar.gz' } },
  { input: '\\\\server\\share\\plugins\\..\\memory', expected: { kind: 'directory', spec: '\\\\server\\share\\plugins\\..\\memory', path: '\\\\server\\share\\memory' } },
  { input: '..\\memory', cwd: 'C:\\work\\plugins', expected: { kind: 'directory', spec: '..\\memory', path: 'C:\\work\\memory' } },
  { input: './memory', cwd: 'C:\\work\\plugins', expected: { kind: 'directory', spec: './memory', path: 'C:\\work\\plugins\\memory' } },
  { input: 'file:memory', cwd: 'D:/work/plugins', expected: { kind: 'directory', spec: 'file:memory', path: 'D:\\work\\plugins\\memory' } },
  { input: '/opt/memory', cwd: 'C:\\work', expected: { kind: 'directory', spec: '/opt/memory', path: '/opt/memory' } },
  ...['https://example.org/plugins/memory.tgz', 'https://example.org/plugins/memory.tar.gz', 'https://example.org/记忆%20plugin.tgz', 'https://github.com/owner/repo/releases/download/v1/plugin.tgz'].map(input => ({
    input,
    expected: { kind: 'remoteTarball' as const, spec: input, url: input },
  })),
]

const rejected = [
  '', '   ', '\nmemory', 'memory\r', 'memory\t@1', 'memory\0', 'memory\u007f', 'memory\u0085',
  '--ignore-scripts=false', '-g', 'memory other', 'memory;whoami', 'memory&&whoami', '$(whoami)', '`whoami`', 'memory@latest;whoami',
  'Memory', '@scope', '@scope/', '@scope/Memory', '@scope/pkg/extra', '.hidden', '_hidden', 'a'.repeat(215),
  'memory@', 'memory@ ', 'memory@banana range', 'memory@1.2.3@next', 'memory@npm:other', 'memory@file:../foo',
  'npm:memory', 'workspace:memory', 'patch:memory', 'http://example.org/plugin.tgz', 'ssh://github.com/owner/repo', 'git://github.com/owner/repo',
  'git@github.com:owner/repo', 'git+ssh://github.com/owner/repo', 'https://gitlab.com/owner/repo.git', 'git+https://gitlab.com/owner/repo.git',
  'github:', 'github:owner', 'github:/repo', 'github:owner/', 'github:owner/repo/extra', 'github:owner/repo#', 'owner/repo#',
  'github:-owner/repo', 'github:owner-/repo', 'github:bad--owner/repo', 'github:bad_owner/repo', 'github:owner/.', 'github:owner/..',
  'github:owner/-repo', 'github:owner/repo?x=1', 'github:user:password@owner/repo',
  ...['../main', 'a/../b', 'a..b', 'a//b', '/main', 'main/', '.main', 'main.', 'a/.hidden/b', 'a/ref.lock', '-main', 'HEAD~1', 'HEAD^', 'HEAD^{commit}', 'main@{1}', 'main:dir', 'semver:^1.0', 'main?x', 'main*', 'main[0]', 'main\\next', 'main next', 'main#other', 'main;whoami', '%2e%2e/main'].map(ref => `github:owner/repo#${ref}`),
  'https://github.com/owner/../repo', 'https://github.com/owner/%2e%2e', 'https://github.com/owner/repo/tree/main',
  'https://github.com/owner/repo?ref=main', 'https://github.com/owner/repo?', 'https://github.com/owner/repo#',
  'https://user:password@github.com/owner/repo', 'https://github.com:8443/owner/repo',
  'https://example.org/plugin.zip', 'https://example.org/plugin.tgz?token=x', 'https://example.org/plugin.tgz?',
  'https://example.org/plugin.tgz#sha', 'https://example.org/plugin.tgz#', 'https://user:pass@example.org/plugin.tgz',
  'https://@example.org/plugin.tgz', 'https://:@example.org/plugin.tgz',
  'https://example.org:8443/plugin.tgz', 'https://example.org/a b.tgz', 'https://example.org\\plugin.tgz',
  'https:example.org/plugin.tgz', 'https:///example.org/plugin.tgz', 'https://', 'https://[bad]/plugin.tgz',
  'git+https://example.org/plugin.tgz', 'file:', 'link:', 'file://server/share', 'file:///opt/plugin', 'file:https://example.org/plugin.tgz',
  'link:github:owner/repo', 'file:C:relative', 'C:relative', 'file:C:', '\\\\?\\C:\\plugin', '\\\\.\\pipe\\plugin', '\\\\server',
]

describe('parseDesktopPluginInstallSpec', () => {
  it.each(accepted)('parses $input without acquiring or executing a package', ({ input, cwd: directory, expected }) => {
    expect(parseDesktopPluginInstallSpec(input, directory ?? cwd)).toEqual(expected)
  })

  it.each(rejected)('rejects unsupported or malformed input %j', (input) => {
    expect(() => parseDesktopPluginInstallSpec(input, cwd)).toThrow(/desktop plugin install:/u)
  })

  it('retains requested provenance independently of normalized Windows paths', () => {
    expect(parseDesktopPluginInstallSpec('  file:C:/plugins/../memory  ', '/unused')).toEqual({
      kind: 'directory', spec: 'file:C:/plugins/../memory', path: 'C:\\memory',
    })
  })

  it.each(['relative', '', 'C:relative'])('requires an absolute cwd for relative local input: %j', (directory) => {
    expect(() => parseDesktopPluginInstallSpec('./memory', directory)).toThrow(/absolute working directory/u)
  })

  it('does not consult the working directory for registry inputs', () => {
    expect(parseDesktopPluginInstallSpec('memory', '')).toEqual({ kind: 'registry', spec: 'memory', name: 'memory' })
  })

  it('rejects a control character in the local working directory', () => {
    expect(() => parseDesktopPluginInstallSpec('./memory', '/work/\n')).toThrow(/control characters/u)
  })

  it('does not resolve a Windows relative path against a POSIX working directory', () => {
    expect(() => parseDesktopPluginInstallSpec('.\\memory', cwd)).toThrow(/Windows working directory/u)
  })

  it('rejects a drive-ambiguous Windows root-relative path', () => {
    expect(() => parseDesktopPluginInstallSpec('file:\\memory', 'C:\\work')).toThrow(/explicit drive/u)
  })
})
