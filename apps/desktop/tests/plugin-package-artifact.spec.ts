import { createHash } from 'node:crypto'
import { closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { c, Header, t } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { acquireDesktopSourcePackage } from '../src/plugin-package-artifact.ts'
import type { DesktopPluginInstallSpec } from '../src/plugin-install-spec.ts'

const roots: string[] = []
const commit = '0123456789abcdef0123456789abcdef01234567'
const manifest = {
  name: '@example/real-plugin-name',
  version: '1.2.3-beta.1',
  main: './lib/index.js',
  exports: { '.': { types: './lib/index.d.ts', import: './lib/index.js', default: './lib/index.js' }, './client': './lib/client.js' },
  dsh: { bundle: { patch: './cordis.patch.yml' } },
  scripts: { prepare: 'node malicious.js', prepack: 'node malicious.js', postpack: 'node malicious.js', build: 'node malicious.js' },
}
const files = {
  'cordis.patch.yml': '[]\n',
  'lib/index.js': 'throw new Error("module must not be imported during acquisition")\n',
  'lib/client.js': 'throw new Error("client must not be imported")\n',
  'lib/helper.js': 'export const helper = 1\n',
  'assets/schema.json': '{"complete":true}\n',
  'malicious.js': 'throw new Error("scripts must not run")\n',
}

function fixture(): { root: string; staging: string } {
  const root = mkdtempSync(join(tmpdir(), 'desktop-source-package-'))
  roots.push(root)
  return { root, staging: join(root, 'staging') }
}

function directory(root: string, overrides: Record<string, unknown> = {}): string {
  const source = join(root, 'source')
  mkdirSync(source)
  writeFileSync(join(source, 'package.json'), JSON.stringify({ ...manifest, ...overrides }))
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(source, path)), { recursive: true })
    writeFileSync(join(source, path), body)
  }
  return source
}

async function pack(source: string, archive: string): Promise<void> {
  await c({ file: archive, cwd: source, prefix: 'package', gzip: true, portable: true, noMtime: true }, ['package.json', ...Object.keys(files)])
}

interface Entry {
  path: string
  body?: string
  size?: number
  type?: 'File' | 'Directory' | 'SymbolicLink' | 'Link' | 'FIFO'
  linkpath?: string
}

function archive(entries: readonly Entry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '')
    const header = new Header({ path: entry.path, size: entry.size ?? body.byteLength, type: entry.type ?? 'File', mode: 0o644, ...(entry.linkpath === undefined ? {} : { linkpath: entry.linkpath }) })
    const block = Buffer.alloc(512)
    header.encode(block)
    blocks.push(block, body, Buffer.alloc((512 - body.byteLength % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

function packageArchive(overrides: Record<string, unknown> = {}, extras: Entry[] = [], root = 'package'): Buffer {
  return archive([
    { path: `${root}/package.json`, body: JSON.stringify({ ...manifest, ...overrides }) },
    ...Object.entries(files).map(([path, body]) => ({ path: `${root}/${path}`, body })),
    ...extras,
  ])
}

function localTar(root: string, bytes: Buffer): Exclude<DesktopPluginInstallSpec, { kind: 'registry' }> {
  const path = join(root, 'input.tgz')
  writeFileSync(path, bytes)
  return { kind: 'tarball', spec: path, path }
}

function response(bytes: Buffer): Response {
  return new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.byteLength) } })
}

function github(ref?: string): Exclude<DesktopPluginInstallSpec, { kind: 'registry' }> {
  return { kind: 'github', spec: 'example/unrelated-repo#stable', owner: 'example', repo: 'unrelated-repo', ...(ref === undefined ? {} : { ref }) }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('acquireDesktopSourcePackage', () => {
  it('snapshots a complete directory via pack without importing modules or executing scripts', async () => {
    const { root, staging } = fixture()
    const source = directory(root)
    mkdirSync(join(source, '.git'))
    writeFileSync(join(source, '.git', 'secret'), 'not a package resource')
    const packer = vi.fn(pack)
    const result = await acquireDesktopSourcePackage({ kind: 'directory', spec: `link:${source}`, path: source }, staging, packer)
    expect(packer).toHaveBeenCalledOnce()
    expect(result).toMatchObject({ packageName: manifest.name, version: manifest.version })
    expect(result.resolved).toMatch(/^file:/u)
    expect(result.path.startsWith(staging)).toBe(true)
    const paths: string[] = []
    await t({ file: result.path, onReadEntry: (entry) => { paths.push(entry.path) } })
    expect(paths).toContain('package/assets/schema.json')
    expect(paths).toContain('package/lib/helper.js')
    expect(paths.some(path => path.includes('.git'))).toBe(false)
    expect(readFileSync(join(source, 'lib/index.js'), 'utf8')).toContain('must not be imported')
  })

  it.each(['..', '../outside'])('rejects escaping publishConfig.directory %s before packing', async (path) => {
    const { root, staging } = fixture()
    const source = directory(root, { publishConfig: { directory: path } })
    const packer = vi.fn(pack)
    await expect(
      acquireDesktopSourcePackage({ kind: 'directory', spec: source, path: source }, staging, packer),
    ).rejects.toThrow('publishConfig.directory')
    expect(packer).not.toHaveBeenCalled()
  })

  it('rejects a packing-directory junction escaping the selected source', async () => {
    const { root, staging } = fixture()
    const source = directory(root, { publishConfig: { directory: 'dist' } })
    const external = join(root, 'outside')
    mkdirSync(external)
    symlinkSync(external, join(source, 'dist'), 'junction')
    const packer = vi.fn(pack)
    await expect(
      acquireDesktopSourcePackage({ kind: 'directory', spec: source, path: source }, staging, packer),
    ).rejects.toThrow('publishConfig.directory')
    expect(packer).not.toHaveBeenCalled()
  })

  it('permits an in-package packing directory without executing inert tarball publishing metadata', async () => {
    const { root, staging } = fixture()
    const source = directory(root, { publishConfig: { directory: '.' } })
    await expect(
      acquireDesktopSourcePackage({ kind: 'directory', spec: source, path: source }, staging, pack),
    ).resolves.toMatchObject({ packageName: manifest.name })
    const tar = localTar(root, packageArchive({ publishConfig: { directory: '../build' } }))
    const packer = vi.fn(pack)
    await expect(acquireDesktopSourcePackage(tar, staging, packer)).resolves.toMatchObject({ packageName: manifest.name })
    expect(packer).not.toHaveBeenCalled()
  })

  it('returns hashes over immutable local tarball bytes rather than its mutable source', async () => {
    const { root, staging } = fixture()
    const bytes = packageArchive()
    const input = localTar(root, bytes)
    const packer = vi.fn(pack)
    const result = await acquireDesktopSourcePackage(input, staging, packer)
    writeFileSync(join(root, 'input.tgz'), 'changed after acquisition')
    expect(packer).not.toHaveBeenCalled()
    expect(readFileSync(result.path)).toEqual(bytes)
    expect(result.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(result.integrity).toBe(`sha512-${createHash('sha512').update(bytes).digest('base64')}`)
    expect(result.commit).toBeUndefined()
  })

  it.each(['stable', undefined, commit, commit.toUpperCase()])('resolves GitHub ref %s to a full commit and accepts codeload without inferring package name from repo', async (ref) => {
    const { staging } = fixture()
    const repository = packageArchive({}, [], 'example-unrelated-repo-0123456')
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sha: commit }))
      .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: `https://codeload.github.com/example/unrelated-repo/legacy.tar.gz/${commit}` } }))
      .mockResolvedValueOnce(response(repository))
    const result = await acquireDesktopSourcePackage(github(ref), staging, pack, fetcher)
    expect(fetcher.mock.calls[0]?.[0]).toBe(`https://api.github.com/repos/example/unrelated-repo/commits/${ref ?? 'HEAD'}`)
    expect(fetcher.mock.calls[1]?.[0]).toBe(`https://api.github.com/repos/example/unrelated-repo/tarball/${commit}`)
    for (const call of fetcher.mock.calls) expect(call[1]).toMatchObject({ credentials: 'omit', redirect: 'manual' })
    expect(result).toMatchObject({ packageName: manifest.name, version: manifest.version, commit, resolved: `https://github.com/example/unrelated-repo/archive/${commit}.tar.gz` })
  })

  it('rejects a different resolved commit when the caller supplied a full SHA', async () => {
    const { staging } = fixture()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ sha: commit }))
    await expect(acquireDesktopSourcePackage(github('f'.repeat(40)), staging, pack, fetcher)).rejects.toThrow('different commit')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(readdirSync(staging)).toEqual([])
  })

  it('rejects abbreviated commit identities before fetching a repository', async () => {
    const { staging } = fixture()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ sha: commit.slice(0, 7) }))
    await expect(acquireDesktopSourcePackage(github('stable'), staging, pack, fetcher)).rejects.toThrow('full 40-hex')
    expect(fetcher).toHaveBeenCalledOnce()
    expect(readdirSync(staging)).toEqual([])
  })

  it('stages an HTTPS tarball without packing it', async () => {
    const { staging } = fixture()
    const packer = vi.fn(pack)
    const bytes = packageArchive()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(bytes))
    const url = 'https://packages.example/plugin.tgz'
    const result = await acquireDesktopSourcePackage({ kind: 'remoteTarball', spec: url, url }, staging, packer, fetcher)
    expect(packer).not.toHaveBeenCalled()
    expect(result.resolved).toBe(url)
    expect(readFileSync(result.path)).toEqual(bytes)
  })

  it.each(['http://packages.example/a.tgz', 'https://user:secret@packages.example/a.tgz', 'https://packages.example:444/a.tgz'])('rejects unsafe remote URL %s', async (url) => {
    const { staging } = fixture()
    const fetcher = vi.fn<typeof fetch>()
    await expect(acquireDesktopSourcePackage({ kind: 'remoteTarball', spec: url, url }, staging, pack, fetcher)).rejects.toThrow('HTTPS')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['http://codeload.github.com/a', 'https://user:secret@codeload.github.com/a', 'https://evil.example/a'])('rejects unsafe GitHub redirect %s and cancels its stream', async (url) => {
    const { staging } = fixture()
    const cancel = vi.fn()
    const body = new ReadableStream<Uint8Array>({ cancel })
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sha: commit }))
      .mockResolvedValueOnce(new Response(body, { status: 302, headers: { location: url } }))
    await expect(acquireDesktopSourcePackage(github(), staging, pack, fetcher)).rejects.toThrow(/HTTPS|allowlisted|unsafe redirect/u)
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(cancel).toHaveBeenCalledOnce()
    expect(readdirSync(staging)).toEqual([])
  })

  it.each([
    '../outside', 'package/../outside', '/absolute', 'C:/outside', 'package/C:/drive',
    'package\\outside', 'package//duplicate', 'package/./dot', 'package/aux.txt',
  ])('rejects unsafe archive path %s before extraction', async (path) => {
    const { root, staging } = fixture()
    await expect(acquireDesktopSourcePackage(localTar(root, packageArchive({}, [{ path, body: 'bad' }])), staging, pack)).rejects.toThrow(/unsafe archive path/u)
    expect(existsSync(join(root, 'outside'))).toBe(false)
    expect(readdirSync(staging)).toEqual([])
  })

  it.each(['SymbolicLink', 'Link', 'FIFO'] as const)('rejects %s archive entries', async (type) => {
    const { root, staging } = fixture()
    const bytes = packageArchive({}, [{ path: 'package/link', type, ...(type === 'FIFO' ? {} : { linkpath: 'lib/index.js' }) }])
    await expect(acquireDesktopSourcePackage(localTar(root, bytes), staging, pack)).rejects.toThrow(/links and special entries/u)
  })

  it.each(['package/lib/index.js', 'package/LIB/other.js', 'Package/another.js'])('rejects duplicate or case-collision archive path %s', async (path) => {
    const { root, staging } = fixture()
    await expect(acquireDesktopSourcePackage(localTar(root, packageArchive({}, [{ path, body: 'collision' }])), staging, pack)).rejects.toThrow(/duplicate|case-collision/u)
  })

  it('requires package root for npm tarballs', async () => {
    const { root, staging } = fixture()
    await expect(acquireDesktopSourcePackage(localTar(root, packageArchive({}, [], 'repository')), staging, pack)).rejects.toThrow('named package')
  })

  it('rejects multiple GitHub top-level roots', async () => {
    const { staging } = fixture()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sha: commit }))
      .mockResolvedValueOnce(response(packageArchive({}, [{ path: 'another/file', body: 'bad' }], 'repository')))
    await expect(acquireDesktopSourcePackage(github(), staging, pack, fetcher)).rejects.toThrow('one top-level root')
  })

  it.each([
    { name: '../outside' }, { version: '^1.2.3' }, { version: 'v1.2.3' },
    { dsh: { bundle: { patch: '../outside.yml' } } }, { main: '../outside.js' },
    { exports: { '.': '/outside.js' } }, { exports: { './client': './missing-client.js' } },
  ])('rejects invalid package manifest %j', async (override) => {
    const { root, staging } = fixture()
    await expect(acquireDesktopSourcePackage(localTar(root, packageArchive(override)), staging, pack))
      .rejects.toThrow(/package name|exact semver|unsafe archive path|in-package|missing prebuilt/u)
  })

  it.each(['preinstall', 'install', 'postinstall'])('rejects source-root %s before packing, including allowlisted native names', async (hook) => {
    const { root, staging } = fixture()
    const source = directory(root, { name: hook === 'install' ? 'koffi' : manifest.name, scripts: { [hook]: 'node malicious.js' } })
    const packer = vi.fn(pack)
    await expect(acquireDesktopSourcePackage({ kind: 'directory', spec: source, path: source }, staging, packer)).rejects.toThrow(`${hook} lifecycle scripts`)
    expect(packer).not.toHaveBeenCalled()
    expect(readdirSync(staging)).toEqual([])
  })

  it.each(['preinstall', 'install', 'postinstall'])('rejects %s from a supplied tarball before returning an installable artifact', async (hook) => {
    const { root, staging } = fixture()
    const packer = vi.fn(pack)
    await expect(acquireDesktopSourcePackage(localTar(root, packageArchive({ scripts: { [hook]: '' } })), staging, packer)).rejects.toThrow('provide prebuilt output without install hooks')
    expect(packer).not.toHaveBeenCalled()
  })

  it('rejects a GitHub install hook before invoking the packer', async () => {
    const { staging } = fixture()
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ sha: commit }))
      .mockResolvedValueOnce(response(packageArchive({ name: 'koffi', scripts: { install: 'node malicious.js' } }, [], 'repository')))
    const packer = vi.fn(pack)
    await expect(acquireDesktopSourcePackage(github(), staging, packer, fetcher)).rejects.toThrow('compile-on-install source packages')
    expect(packer).not.toHaveBeenCalled()
  })

  it.each([
    { scripts: { postinstall: 'node malicious.js' } },
    { dependencies: { koffi: 'file:./unreviewed-native' } },
  ])('revalidates packed scripts and dependencies: %j', async (override) => {
    const { root, staging } = fixture()
    const source = directory(root)
    const packer = vi.fn(async (_source: string, path: string): Promise<void> => { writeFileSync(path, packageArchive(override)) })
    await expect(acquireDesktopSourcePackage({ kind: 'directory', spec: source, path: source }, staging, packer)).rejects.toThrow(/install hooks|registry version/u)
    expect(packer).toHaveBeenCalledOnce()
  })

  it.each(['dependencies', 'optionalDependencies'])('accepts registry versions, tags and ranges in %s without resolving or authorizing builds', async (field) => {
    const { root, staging } = fixture()
    const source = directory(root, { [field]: { koffi: '^2.0.0', 'node-pty': '1.0.0', 'fs-ext': 'latest', '@example/library': '>=1.0 <2 || ^3' } })
    const packer = vi.fn(pack)
    await expect(acquireDesktopSourcePackage({ kind: 'directory', spec: source, path: source }, staging, packer)).resolves.toMatchObject({ packageName: manifest.name })
    expect(packer).toHaveBeenCalledOnce()
  })

  const nonRegistrySelectors = [
    'file:./native', 'link:../native', './native', '/native', 'C:\\native',
    'github:owner/repo', 'owner/repo#main', 'git+https://github.com/owner/repo.git', 'git@github.com:owner/repo',
    'https://example.com/native.tgz', 'http://example.com/native.tgz', 'workspace:*', 'npm:other@1.0.0',
    'catalog:', 'patch:native@1.0.0', '', '  ', 'not a version', '^1\n', 42, null,
  ]
  it.each(['dependencies', 'optionalDependencies'].flatMap(field => nonRegistrySelectors.map(selector => ({ field, selector }))))('rejects non-registry $field selector $selector before packing', async ({ field, selector }) => {
    const { root, staging } = fixture()
    const source = directory(root, { [field]: { koffi: selector } })
    const packer = vi.fn(pack)
    await expect(acquireDesktopSourcePackage({ kind: 'directory', spec: source, path: source }, staging, packer)).rejects.toThrow('registry version, dist tag, or semver range')
    expect(packer).not.toHaveBeenCalled()
  })

  it.each(['latest', 'workspace:^1', 'npm:other@1', null])('requires semver peers instead of %j', async (selector) => {
    const { root, staging } = fixture()
    await expect(acquireDesktopSourcePackage(localTar(root, packageArchive({ peerDependencies: { '@deepseek-ai/cordis': selector } })), staging, pack)).rejects.toThrow('a semver range')
  })

  it('accepts semver peer requirements and inert development metadata', async () => {
    const { root, staging } = fixture()
    const bytes = packageArchive({ peerDependencies: { '@deepseek-ai/cordis': '^4.0.0 || ^5.0.0' }, devDependencies: { compiler: 'workspace:*' } })
    await expect(acquireDesktopSourcePackage(localTar(root, bytes), staging, pack)).resolves.toMatchObject({ packageName: manifest.name })
  })

  it.each([
    { dependencies: [] }, { optionalDependencies: null }, { peerDependencies: 'invalid' },
    { dependencies: { '../koffi': '^1' } }, { optionalDependencies: { '@bad/key/name': 'latest' } },
    { scripts: [] }, { scripts: null }, { scripts: { build: 42 } },
  ])('rejects malformed lifecycle or dependency metadata %j', async (override) => {
    const { root, staging } = fixture()
    await expect(acquireDesktopSourcePackage(localTar(root, packageArchive(override)), staging, pack))
      .rejects.toThrow(/map|package name|string commands/u)
  })

  it('rejects root binding.gyp before pnpm can infer a native install hook', async () => {
    const { root, staging } = fixture()
    const source = directory(root, { name: 'koffi', scripts: undefined })
    writeFileSync(join(source, 'binding.gyp'), '{"targets":[]}\n')
    const packer = vi.fn(pack)
    await expect(acquireDesktopSourcePackage({ kind: 'directory', spec: source, path: source }, staging, packer)).rejects.toThrow('without implicit native install builds')
    expect(packer).not.toHaveBeenCalled()
  })

  it('rejects implicit build metadata supplied by a tarball', async () => {
    const { root, staging } = fixture()
    const bytes = packageArchive({ name: 'koffi', scripts: undefined }, [{ path: 'package/binding.gyp', body: '{}' }])
    await expect(acquireDesktopSourcePackage(localTar(root, bytes), staging, pack)).rejects.toThrow('root binding.gyp')
  })

  it.each(['bundledDependencies', 'bundleDependencies'].flatMap(field => [true, ['koffi'], { koffi: true }].map(value => ({ field, value }))))('rejects source-owned bundled native dependencies: $field = $value', async ({ field, value }) => {
    const { root, staging } = fixture()
    const source = directory(root, { [field]: value })
    const packer = vi.fn(pack)
    await expect(acquireDesktopSourcePackage({ kind: 'directory', spec: source, path: source }, staging, packer)).rejects.toThrow('publish dependencies to a registry')
    expect(packer).not.toHaveBeenCalled()
  })

  it('allows explicitly disabled or empty bundled-dependency declarations', async () => {
    const { root, staging } = fixture()
    const bytes = packageArchive({ bundleDependencies: false, bundledDependencies: [] })
    await expect(acquireDesktopSourcePackage(localTar(root, bytes), staging, pack))
      .resolves.toMatchObject({ packageName: manifest.name })
  })

  it.each([undefined, {}, { '.': './lib/index.js' }, { './client': null }, { './client': { browser: './lib/client.js' } }, { './client': { default: { import: './lib/client.js' } } }])('requires web-declared output in the forms supported by client-modules: %j', async (exports) => {
    const { root, staging } = fixture()
    const dsh = { ...manifest.dsh, client: { platform: 'web' } }
    const source = directory(root, { dsh, exports })
    const packer = vi.fn(pack)
    await expect(acquireDesktopSourcePackage({ kind: 'directory', spec: source, path: source }, staging, packer)).rejects.toThrow('exports["./client"] must be a string or an object with a string default')
    expect(packer).not.toHaveBeenCalled()
  })

  it.each([
    './lib/client.js',
    { types: './absent.d.ts', default: './lib/client.js' },
    { browser: './absent-browser.js', import: './absent-import.js', default: './lib/client.js' },
  ])('accepts the exact string/default client target used by the runtime: %j', async (client) => {
    const { root, staging } = fixture()
    const bytes = packageArchive({ dsh: { ...manifest.dsh, client: { platform: 'web' } }, exports: { '.': './lib/index.js', './client': client } })
    await expect(acquireDesktopSourcePackage(localTar(root, bytes), staging, pack)).resolves.toMatchObject({ packageName: manifest.name })
  })

  it('checks the declared client default file, not an existing browser alternative', async () => {
    const { root, staging } = fixture()
    const bytes = packageArchive({ dsh: { ...manifest.dsh, client: { platform: 'web' } }, exports: { './client': { browser: './lib/client.js', default: './missing-default.js' } } })
    await expect(acquireDesktopSourcePackage(localTar(root, bytes), staging, pack)).rejects.toThrow('missing prebuilt output ./missing-default.js')
  })

  it('does not require web output for a non-web client platform', async () => {
    const { root, staging } = fixture()
    const bytes = packageArchive({ dsh: { ...manifest.dsh, client: { platform: 'other' } }, exports: { '.': './lib/index.js' } })
    await expect(acquireDesktopSourcePackage(localTar(root, bytes), staging, pack)).resolves.toMatchObject({ packageName: manifest.name })
  })

  it.each([{ node: null, default: './lib/index.js' }, { node: { import: null }, default: './lib/index.js' }])('rejects Host exports blocked by the selected null condition: %j', async (entry) => {
    const { root, staging } = fixture()
    await expect(acquireDesktopSourcePackage(localTar(root, packageArchive({ exports: { '.': entry } })), staging, pack)).rejects.toThrow('no supported import/default target')
  })

  it('preserves Node array fallback semantics for null alternatives', async () => {
    const { root, staging } = fixture()
    const bytes = packageArchive({ exports: { '.': [null, { node: null }, './lib/index.js'] } })
    await expect(acquireDesktopSourcePackage(localTar(root, bytes), staging, pack)).resolves.toMatchObject({ packageName: manifest.name })
  })

  it('reports missing build output before packing a source directory', async () => {
    const { root, staging } = fixture()
    const source = directory(root, { main: './lib/missing.js' })
    const packer = vi.fn(pack)
    await expect(acquireDesktopSourcePackage({ kind: 'directory', spec: source, path: source }, staging, packer)).rejects.toThrow('build the plugin before installing; Desktop does not run builds')
    expect(packer).not.toHaveBeenCalled()
  })

  it('supports nested standard node/import and browser/default exports and bundle-only packages', async () => {
    const { root, staging } = fixture()
    const bytes = packageArchive({ exports: { '.': { types: './absent.d.ts', node: { import: './lib/index.js' }, default: './lib/index.js' }, './client': { browser: './lib/client.js', default: './lib/client.js' } } })
    await expect(acquireDesktopSourcePackage(localTar(root, bytes), staging, pack)).resolves.toMatchObject({ packageName: manifest.name })
    const bundleOnly = packageArchive({ main: undefined, exports: undefined })
    await expect(acquireDesktopSourcePackage(localTar(root, bundleOnly), staging, pack))
      .resolves.toMatchObject({ packageName: manifest.name })
  })

  it('revalidates produced archives for changed name and missing outputs', async () => {
    const { root, staging } = fixture()
    const source = directory(root)
    const input = { kind: 'directory', spec: source, path: source } as const
    const changedName = async (_source: string, path: string): Promise<void> => { writeFileSync(path, packageArchive({ name: 'different-name' })) }
    await expect(acquireDesktopSourcePackage(input, staging, changedName)).rejects.toThrow('name or version changed')
    const missingOutput = async (_source: string, path: string): Promise<void> => { writeFileSync(path, packageArchive({ main: './lib/missing.js' })) }
    await expect(acquireDesktopSourcePackage(input, staging, missingOutput)).rejects.toThrow('missing prebuilt output')
  })

  it('rejects required files escaping through a directory junction', async () => {
    const { root, staging } = fixture()
    const source = directory(root, { main: './outside/file.js' })
    const outside = join(root, 'external')
    mkdirSync(outside)
    writeFileSync(join(outside, 'file.js'), 'external')
    symlinkSync(outside, join(source, 'outside'), 'junction')
    const packer = vi.fn(pack)
    await expect(acquireDesktopSourcePackage({ kind: 'directory', spec: source, path: source }, staging, packer)).rejects.toThrow('symlink escapes')
    expect(packer).not.toHaveBeenCalled()
  })

  it('rejects staging inside the input directory to prevent recursive packing', async () => {
    const { root } = fixture()
    const source = directory(root)
    const packer = vi.fn(pack)
    await expect(acquireDesktopSourcePackage({ kind: 'directory', spec: source, path: source }, join(source, 'staging'), packer)).rejects.toThrow('must not be inside')
    expect(packer).not.toHaveBeenCalled()
  })

  it('rejects forged oversized archive metadata without decompressing the claimed payload', async () => {
    const { root, staging } = fixture()
    const bytes = archive([{ path: 'package/huge', size: 256 * 1024 * 1024 + 1 }])
    await expect(acquireDesktopSourcePackage(localTar(root, bytes), staging, pack)).rejects.toThrow('extracted archive exceeds size limit')
    expect(readdirSync(staging)).toEqual([])
  })

  it('limits finite archive entry counts', async () => {
    const { root, staging } = fixture()
    const bytes = packageArchive({}, Array.from({ length: 10_001 }, (_, i) => ({ path: `package/empty-${i}` })))
    await expect(acquireDesktopSourcePackage(localTar(root, bytes), staging, pack)).rejects.toThrow('entry limit')
  })

  it('rejects oversized declared downloads and cancels the unread body', async () => {
    const { staging } = fixture()
    const cancel = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), { headers: { 'content-length': String(64 * 1024 * 1024 + 1) } }))
    const url = 'https://packages.example/a.tgz'
    await expect(acquireDesktopSourcePackage({ kind: 'remoteTarball', spec: url, url }, staging, pack, fetcher)).rejects.toThrow('Content-Length exceeds')
    expect(cancel).toHaveBeenCalledOnce()
    expect(readdirSync(staging)).toEqual([])
  })

  it('cancels chunked downloads that exceed the compressed byte limit', async () => {
    const { staging } = fixture()
    const cancel = vi.fn()
    const chunk = new Uint8Array(1024 * 1024)
    const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(chunk) }, cancel })
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(stream))
    const url = 'https://packages.example/a.tgz'
    await expect(acquireDesktopSourcePackage({ kind: 'remoteTarball', spec: url, url }, staging, pack, fetcher)).rejects.toThrow('download exceeds size limit')
    expect(cancel).toHaveBeenCalledOnce()
    expect(readdirSync(staging)).toEqual([])
  })

  it('rejects oversized local archives before copying', async () => {
    const { root, staging } = fixture()
    const path = join(root, 'large.tgz')
    const fd = openSync(path, 'wx')
    try {
      ftruncateSync(fd, 64 * 1024 * 1024 + 1)
    } finally {
      closeSync(fd)
    }
    await expect(acquireDesktopSourcePackage({ kind: 'tarball', spec: path, path }, staging, pack)).rejects.toThrow('compressed archive exceeds size limit')
    expect(readdirSync(staging)).toEqual([])
  })

  it('rejects oversized package manifests before reading their contents', async () => {
    const { root, staging } = fixture()
    const bytes = archive([{ path: 'package/package.json', size: 1024 * 1024 + 1 }])
    await expect(acquireDesktopSourcePackage(localTar(root, bytes), staging, pack)).rejects.toThrow('package.json exceeds size limit')
  })

  it('rejects archives lacking their top-level package manifest', async () => {
    const { root, staging } = fixture()
    const bytes = archive([{ path: 'package/lib/index.js', body: 'export default {}' }])
    await expect(acquireDesktopSourcePackage(localTar(root, bytes), staging, pack)).rejects.toThrow('exactly one root package.json')
  })

  it('rejects truncated archive payloads', async () => {
    const { root, staging } = fixture()
    const bytes = packageArchive()
    await expect(acquireDesktopSourcePackage(localTar(root, bytes.subarray(0, bytes.length - 12)), staging, pack)).rejects.toThrow()
    expect(readdirSync(staging)).toEqual([])
  })

  it.each([404, 500])('cancels HTTP %s bodies and reports status without interpreting the response', async (status) => {
    const { staging } = fixture()
    const cancel = vi.fn()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), { status }))
    const url = 'https://packages.example/a.tgz'
    await expect(acquireDesktopSourcePackage({ kind: 'remoteTarball', spec: url, url }, staging, pack, fetcher)).rejects.toThrow(`HTTP ${status}`)
    expect(cancel).toHaveBeenCalledOnce()
    expect(readdirSync(staging)).toEqual([])
  })

  it('rejects dishonest Content-Length and cleans the staged download', async () => {
    const { staging } = fixture()
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('short', { headers: { 'content-length': '123' } }))
    const url = 'https://packages.example/a.tgz'
    await expect(acquireDesktopSourcePackage({ kind: 'remoteTarball', spec: url, url }, staging, pack, fetcher)).rejects.toThrow('does not match Content-Length')
    expect(readdirSync(staging)).toEqual([])
  })

  it('bounds redirect chains without following a seventh response', async () => {
    const { staging } = fixture()
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(null, { status: 302, headers: { location: '/next.tgz' } }))
    const url = 'https://packages.example/a.tgz'
    await expect(acquireDesktopSourcePackage({ kind: 'remoteTarball', spec: url, url }, staging, pack, fetcher)).rejects.toThrow('too many download redirects')
    expect(fetcher).toHaveBeenCalledTimes(6)
  })

  it('cleans failed pack artifacts while preserving the source directory', async () => {
    const { root, staging } = fixture()
    const source = directory(root)
    const packer = async (_source: string, path: string): Promise<void> => { writeFileSync(path, 'partial'); throw new Error('pack failed') }
    await expect(acquireDesktopSourcePackage({ kind: 'directory', spec: source, path: source }, staging, packer)).rejects.toThrow('pack failed')
    expect(readdirSync(staging)).toEqual([])
    expect(existsSync(join(source, 'package.json'))).toBe(true)
  })
})
