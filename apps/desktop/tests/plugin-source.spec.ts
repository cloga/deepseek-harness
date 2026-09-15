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
  const asset = 'dsh-github-copilot-0.4.0-alpha.18.tgz'
  const checksumAsset = 'SHA256SUMS'
  const artifactSha256 = createHash('sha256').update(archive).digest('hex')
  const checksum = Buffer.from(`${artifactSha256}  ${asset}\n`)
  return {
    schemaVersion: 1,
    type: 'githubRelease',
    owner: 'cloga',
    repo: 'dsh-github-copilot',
    tag: 'v0.4.0-alpha.18',
    asset,
    assetId: 563672719,
    packageName: 'dsh-github-copilot',
    version: '0.4.0-alpha.18',
    size: archive.byteLength,
    sha256: artifactSha256,
    targetCommit,
    dependencyRegistry: 'https://packagefeedproxy.microsoft.io/npm/',
    checksumManifest: {
      format: 'sha256sums',
      asset: checksumAsset,
      assetId: 563672720,
      url: `https://github.com/cloga/dsh-github-copilot/releases/download/v0.4.0-alpha.18/${checksumAsset}`,
      size: checksum.byteLength,
      sha256: createHash('sha256').update(checksum).digest('hex'),
    },
  }
}

function checksumManifest(source: DesktopGithubReleasePluginSource): Buffer {
  return Buffer.from(`${source.sha256}  ${source.asset}\n`)
}

interface GithubFixtureOptions {
  readonly archive?: Buffer
  readonly release?: Record<string, unknown>
  readonly asset?: Record<string, unknown>
  readonly checksumAsset?: Record<string, unknown>
  readonly checksumBody?: string
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
      browser_download_url: `https://github.com/${source.owner}/${source.repo}/releases/download/${source.tag}/${source.asset}`,
      size: source.size,
      state: 'uploaded',
      digest: `sha256:${source.sha256}`,
      ...options.asset,
    }, ...(source.checksumManifest === undefined ? [] : [{
      id: 563672720,
      name: source.checksumManifest.asset,
      browser_download_url: source.checksumManifest.url,
      size: source.checksumManifest.size,
      state: 'uploaded',
      digest: `sha256:${source.checksumManifest.sha256}`,
      ...options.checksumAsset,
    }])],
    ...options.release,
  }
  const fetchFixture: typeof fetch = async (input) => {
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
    if (url.pathname.endsWith('/releases/assets/563672720')) {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://release-assets.githubusercontent.com/checksums.json' },
      })
    }
    if (url.hostname === 'release-assets.githubusercontent.com' && url.pathname.endsWith('checksums.json')) {
      return new Response(options.checksumBody ?? checksumManifest(source).toString('utf8'))
    }
    if (url.hostname === 'release-assets.githubusercontent.com') return new Response(Uint8Array.from(archive))
    throw new Error(`unexpected request ${url.href}`)
  }
  return fetchFixture
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
    ['wrong asset id', { asset: { id: 563672718 } }, /asset metadata/u],
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
    const lastByte = sameSize.at(-1)
    if (lastByte === undefined) throw new Error('test archive must not be empty')
    sameSize[sameSize.byteLength - 1] = lastByte ^ 1
    const sameSizeSource = {
      ...source,
      sha256: createHash('sha256').update(sameSize).digest('hex'),
      integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
    }
    await expect(acquireDesktopPluginArtifact(
      sameSizeSource,
      root(),
      githubFixture(sameSizeSource, { archive: sameSize }),
    )).rejects.toThrow(/SRI/u)
  })

  it.each([
    ['missing package entry', `${'1'.repeat(64)}  other.tgz\n`, /exactly one package asset entry/u],
    ['wrong filename', `${'1'.repeat(64)}  renamed.tgz\n`, /exactly one package asset entry/u],
    ['wrong hash', `${'1'.repeat(64)}  dsh-github-copilot-0.4.0-alpha.18.tgz\n`, /package hash/u],
    ['duplicate entry', `${'1'.repeat(64)}  dsh-github-copilot-0.4.0-alpha.18.tgz\n${'2'.repeat(64)}  dsh-github-copilot-0.4.0-alpha.18.tgz\n`, /exactly one/u],
    ['malformed entry', 'not-a-hash  dsh-github-copilot-0.4.0-alpha.18.tgz\n', /malformed SHA256SUMS/u],
  ] as const)('rejects a SHA256SUMS manifest with a %s', async (_name, checksumBody, error) => {
    const archive = packageArchive()
    const source = sourceFor(archive)
    const body = Buffer.from(checksumBody)
    const locked = {
      ...source,
      checksumManifest: {
        ...source.checksumManifest!,
        size: body.byteLength,
        sha256: createHash('sha256').update(body).digest('hex'),
      },
    }
    await expect(acquireDesktopPluginArtifact(
      locked,
      root(),
      githubFixture(locked, { archive, checksumBody }),
    )).rejects.toThrow(error)
  })

  it.each([
    ['checksum asset id', { id: 563672721 }, /asset metadata/u],
    ['checksum asset URL', { browser_download_url: 'https://github.com/cloga/dsh-github-copilot/releases/download/v0.4.0-alpha.18/OTHER' }, /asset metadata/u],
    ['checksum asset size', { size: 1 }, /asset metadata/u],
    ['checksum asset digest', { digest: `sha256:${'1'.repeat(64)}` }, /asset digest/u],
  ] as const)('rejects %s drift', async (_name, checksumAsset, error) => {
    const archive = packageArchive()
    const source = sourceFor(archive)
    await expect(acquireDesktopPluginArtifact(
      source,
      root(),
      githubFixture(source, { archive, checksumAsset }),
    )).rejects.toThrow(error)
  })

  it('enforces optional artifact and checksum SRI when supplied', async () => {
    const archive = packageArchive()
    const source = sourceFor(archive)
    const checksum = checksumManifest(source)
    const locked = {
      ...source,
      integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}`,
      checksumManifest: {
        ...source.checksumManifest!,
        integrity: `sha512-${createHash('sha512').update(checksum).digest('base64')}`,
      },
    }
    await expect(acquireDesktopPluginArtifact(
      { ...locked, integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` },
      root(),
      githubFixture(locked, { archive }),
    )).rejects.toThrow(/SRI/u)
    await expect(acquireDesktopPluginArtifact(
      {
        ...locked,
        checksumManifest: {
          ...locked.checksumManifest,
          integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
        },
      },
      root(),
      githubFixture(locked, { archive }),
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
      { ...source, integrity: 'sha512-AAAA' },
      { ...source, assetId: 0 },
      { ...source, checksumManifest: { ...source.checksumManifest!, format: 'json' } },
      { ...source, checksumManifest: { ...source.checksumManifest!, assetId: 0 } },
      { ...source, checksumManifest: { ...source.checksumManifest!, url: 'https://example.test/SHA256SUMS' } },
      { ...source, dependencyRegistry: 'https://token@example.test/npm/' },
      { ...source, type: 'url', url: 'https://example.test/plugin.tgz' },
      { ...source, externalProvisioned: true },
    ]) {
      expect(() => parseDesktopPluginSource(value)).toThrow()
    }
  })
})
