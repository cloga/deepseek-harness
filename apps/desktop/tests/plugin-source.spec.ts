import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  acquireDesktopPluginArtifact,
  DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
  parseDesktopPluginSource,
  type DesktopGithubReleasePluginSource,
} from '../src/plugin-source.ts'

const roots: string[] = []
const targetCommit = '08bfccc3b5930b93ef2fe31d9cf9e509f34a8704'

interface TarEntry {
  readonly path: string
  readonly body?: string
  readonly type?: '0' | '1' | '2' | '5'
  readonly link?: string
}

function octal(value: number, width: number): Buffer {
  return Buffer.from(value.toString(8).padStart(width - 1, '0') + '\0')
}

function tar(entries: readonly TarEntry[]): Buffer {
  const blocks: Buffer[] = []
  for (const entry of entries) {
    const body = Buffer.from(entry.body ?? '')
    const header = Buffer.alloc(512)
    header.write(entry.path, 0, 100, 'utf8')
    octal(0o644, 8).copy(header, 100)
    octal(0, 8).copy(header, 108)
    octal(0, 8).copy(header, 116)
    octal(body.byteLength, 12).copy(header, 124)
    octal(0, 12).copy(header, 136)
    header.fill(0x20, 148, 156)
    header.write(entry.type ?? '0', 156, 1, 'ascii')
    if (entry.link !== undefined) header.write(entry.link, 157, 100, 'utf8')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    octal([...header].reduce((sum, byte) => sum + byte, 0), 8).copy(header, 148)
    blocks.push(header, body, Buffer.alloc((512 - body.byteLength % 512) % 512))
  }
  blocks.push(Buffer.alloc(1024))
  return gzipSync(Buffer.concat(blocks))
}

function packageArchive(
  manifest: Record<string, unknown> = {},
  entries: readonly TarEntry[] = [],
): Buffer {
  return tar([
    {
      path: 'package/package.json',
      body: JSON.stringify({
        name: 'dsh-github-copilot',
        version: '0.4.0-alpha.18',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        ...manifest,
      }),
    },
    { path: 'package/cordis.patch.yml', body: '[]\n' },
    ...entries,
  ])
}

function sourceFor(archive: Buffer): DesktopGithubReleasePluginSource {
  return {
    schemaVersion: 1,
    type: 'githubRelease',
    owner: 'cloga',
    repo: 'dsh-github-copilot',
    tag: 'v0.4.0-alpha.18',
    asset: 'dsh-github-copilot-0.4.0-alpha.18.tgz',
    packageName: 'dsh-github-copilot',
    version: '0.4.0-alpha.18',
    size: archive.byteLength,
    sha256: createHash('sha256').update(archive).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
    targetCommit,
    dependencyRegistry: 'https://packagefeedproxy.microsoft.io/npm/',
  }
}

interface GithubFixtureOptions {
  readonly archive?: Buffer
  readonly release?: Record<string, unknown>
  readonly asset?: Record<string, unknown>
  readonly tagObject?: Record<string, unknown>
  readonly redirect?: string
}

function githubFixture(source: DesktopGithubReleasePluginSource, options: GithubFixtureOptions = {}): typeof fetch {
  const archive = options.archive ?? packageArchive()
  const release = {
    id: 388508318,
    tag_name: source.tag,
    target_commitish: source.targetCommit,
    draft: false,
    immutable: true,
    assets: [{
      id: 563672719,
      name: source.asset,
      size: source.size,
      state: 'uploaded',
      digest: `sha256:${source.sha256}`,
      ...options.asset,
    }],
    ...options.release,
  }
  return (async (input: string | URL | Request) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname.endsWith(`/releases/tags/${encodeURIComponent(source.tag)}`)) {
      return Response.json(release)
    }
    if (url.pathname.endsWith(`/git/ref/tags/${encodeURIComponent(source.tag)}`)) {
      return Response.json({ object: options.tagObject ?? { type: 'commit', sha: source.targetCommit } })
    }
    if (url.pathname.endsWith('/releases/assets/563672719')) {
      return new Response(null, {
        status: 302,
        headers: { location: options.redirect ?? 'https://release-assets.githubusercontent.com/asset.tgz' },
      })
    }
    if (url.hostname === 'release-assets.githubusercontent.com') return new Response(archive)
    throw new Error(`unexpected request ${url.href}`)
  }) as typeof fetch
}

function root(): string {
  const path = mkdtempSync(join(tmpdir(), 'desktop-plugin-source-'))
  roots.push(path)
  return path
}

afterEach(() => {
  for (const path of roots.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('desktop verified plugin source', () => {
  it('publishes a versioned native capability', () => {
    expect(DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY).toEqual({
      id: 'desktopNativeVerifiedRelease',
      schemaVersion: 1,
      sourceSchemaVersion: 1,
      receiptSchemaVersion: 1,
    })
  })

  it('accepts the locked immutable GitHub Release and verifies its package archive', async () => {
    const archive = packageArchive()
    const source = sourceFor(archive)
    const result = await acquireDesktopPluginArtifact(source, root(), githubFixture(source, { archive }))
    expect(result).toMatchObject({
      source,
      releaseId: 388508318,
      assetId: 563672719,
      packageName: source.packageName,
      version: source.version,
    })
    expect(readFileSync(result.path)).toEqual(archive)
  })

  it.each([
    ['draft release', { release: { draft: true } }, /release is draft/u],
    ['mutable release', { release: { immutable: false } }, /release is mutable/u],
    ['wrong tag', { release: { tag_name: 'v0.4.0-alpha.19' } }, /tag or target commit/u],
    ['wrong target', { release: { target_commitish: '1111111111111111111111111111111111111111' } }, /tag or target commit/u],
    ['wrong tag commit', { tagObject: { type: 'commit', sha: '1111111111111111111111111111111111111111' } }, /tag commit/u],
    ['missing asset', { release: { assets: [] } }, /asset is missing/u],
    ['wrong asset size', { asset: { size: 1 } }, /asset metadata/u],
    ['wrong asset digest', { asset: { digest: `sha256:${'1'.repeat(64)}` } }, /asset digest/u],
    ['redirect host', { redirect: 'https://example.test/asset.tgz' }, /redirect host/u],
  ] as const)('rejects %s', async (_name, options, error) => {
    const archive = packageArchive()
    const source = sourceFor(archive)
    await expect(acquireDesktopPluginArtifact(source, root(), githubFixture(source, options))).rejects.toThrow(error)
  })

  it('rejects downloaded size, SHA-256, and SRI mismatches independently', async () => {
    const archive = packageArchive()
    const source = sourceFor(archive)
    const changed = Buffer.concat([archive, Buffer.from('changed')])
    await expect(acquireDesktopPluginArtifact(
      { ...source, size: changed.byteLength },
      root(),
      githubFixture({ ...source, size: changed.byteLength }, { archive: changed }),
    )).rejects.toThrow(/SHA-256/u)
    await expect(acquireDesktopPluginArtifact(
      { ...source, sha256: createHash('sha256').update(changed).digest('hex') },
      root(),
      githubFixture({ ...source, sha256: createHash('sha256').update(changed).digest('hex') }, { archive: changed }),
    )).rejects.toThrow(/locked size/u)
    const sameSize = Buffer.from(archive)
    sameSize[sameSize.byteLength - 1] ^= 1
    const sameSizeSource = {
      ...source,
      sha256: createHash('sha256').update(sameSize).digest('hex'),
    }
    await expect(acquireDesktopPluginArtifact(
      sameSizeSource,
      root(),
      githubFixture(sameSizeSource, { archive: sameSize }),
    )).rejects.toThrow(/SRI/u)
  })

  it.each([
    ['path traversal', packageArchive({}, [{ path: 'package/../escape', body: 'x' }]), /unsafe archive path/u],
    ['absolute path', packageArchive({}, [{ path: '/escape', body: 'x' }]), /unsafe archive path/u],
    ['unexpected root', packageArchive({}, [{ path: 'other/file', body: 'x' }]), /unexpected archive root/u],
    ['escaping symlink', packageArchive({}, [{ path: 'package/link', type: '2', link: '../../escape' }]), /link escapes/u],
    ['escaping hardlink', packageArchive({}, [{ path: 'package/link', type: '1', link: 'escape' }]), /link escapes/u],
    ['wrong name', packageArchive({ name: 'other' }), /package name/u],
    ['wrong version', packageArchive({ version: '0.4.0-alpha.19' }), /package version/u],
    ['lifecycle script', packageArchive({ scripts: { prepare: 'node build.js' } }), /lifecycle script prepare/u],
  ] as const)('rejects %s', async (_name, archive, error) => {
    const source = sourceFor(archive)
    await expect(acquireDesktopPluginArtifact(source, root(), githubFixture(source, { archive }))).rejects.toThrow(error)
  })

  it('rejects free-form URLs, mutable selectors, credentials, and unsupported provisioning markers', () => {
    const archive = packageArchive()
    const source = sourceFor(archive)
    for (const value of [
      { ...source, schemaVersion: 2 },
      { ...source, tag: 'latest' },
      { ...source, dependencyRegistry: 'https://token@example.test/npm/' },
      { ...source, type: 'url', url: 'https://example.test/plugin.tgz' },
      { ...source, externalProvisioned: true },
    ]) {
      expect(() => parseDesktopPluginSource(value)).toThrow()
    }
  })
})
