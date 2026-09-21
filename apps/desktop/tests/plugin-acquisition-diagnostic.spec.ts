import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { c } from 'tar'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { diagnosePluginAcquisition } from '../scripts/diagnose-plugin-acquisition.ts'
import { observePluginAcquisition, type AcquisitionTarget } from '../scripts/plugin-acquisition-observer.ts'
import { desktopSmokeEnvironment } from '../scripts/smoke-environment.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
const target: AcquisitionTarget = { owner: 'cloga', repo: 'dsh-github-copilot', tag: 'v0.4.0-alpha.35', assetId: 10, checksumAssetId: 11 }
const base = 'https://api.github.com/repos/cloga/dsh-github-copilot'
const metadataUrl = `${base}/releases/tags/${target.tag}`
const hash = (bytes: Buffer, algorithm = 'sha256', encoding: 'hex' | 'base64' = 'hex') =>
  createHash(algorithm).update(bytes).digest(encoding)

function root(): string {
  const directory = mkdtempSync(join(tmpdir(), 'acquisition-diagnostic-test-'))
  roots.push(directory)
  return directory
}

async function acquisitionFixture(damage?: 'bytes' | 'mutable' | 'forbidden-script') {
  const directory = root()
  mkdirSync(join(directory, 'package'))
  writeFileSync(join(directory, 'package', 'package.json'), JSON.stringify({
    name: 'dsh-github-copilot', version: '0.4.0-alpha.35',
    ...(damage === 'forbidden-script' ? { scripts: { install: 'must-not-execute' } } : {}),
  }))
  const archive = join(directory, 'fixture.tgz')
  await c({ cwd: directory, file: archive, gzip: true }, ['package'])
  const bytes = readFileSync(archive)
  const asset = 'dsh-github-copilot-0.4.0-alpha.35.tgz'
  const checksum = Buffer.from(`${hash(bytes)}  ${asset}\n`)
  const source = {
    schemaVersion: 1, type: 'githubRelease', owner: target.owner, repo: target.repo, tag: target.tag,
    asset, assetId: target.assetId, packageName: 'dsh-github-copilot', version: '0.4.0-alpha.35',
    size: bytes.length, sha256: hash(bytes), integrity: `sha512-${hash(bytes, 'sha512', 'base64')}`,
    targetCommit: 'a'.repeat(40), dependencyRegistry: 'https://packagefeedproxy.microsoft.io/npm/',
    checksumManifest: { format: 'sha256sums', asset: 'SHA256SUMS', assetId: target.checksumAssetId,
      url: `https://github.com/cloga/dsh-github-copilot/releases/download/${target.tag}/SHA256SUMS`,
      size: checksum.length, sha256: hash(checksum), integrity: `sha512-${hash(checksum, 'sha512', 'base64')}` },
  }
  const plan = join(directory, 'plan.json')
  const planBytes = Buffer.from(JSON.stringify({ desktopProvisioning: { plugins: [{ required: true, source }] } }))
  writeFileSync(plan, planBytes)
  const output = join(directory, 'safe.json'), scratch = join(directory, 'scratch')
  const options = { plan, output, scratch, planSha256: hash(planBytes), sourceCommit: 'b'.repeat(40) }
  const fetcher = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname.endsWith(`/releases/tags/${target.tag}`)) return Response.json({
      id: 12, tag_name: target.tag, target_commitish: source.targetCommit, draft: false, immutable: damage !== 'mutable',
      assets: [{ id: 10, name: asset, state: 'uploaded', size: bytes.length, digest: `sha256:${source.sha256}` },
        { id: 11, name: 'SHA256SUMS', state: 'uploaded', size: checksum.length,
          digest: `sha256:${source.checksumManifest.sha256}`, browser_download_url: source.checksumManifest.url }],
    })
    if (url.pathname.includes('/git/ref/')) return Response.json({ object: { type: 'tag', sha: 'c'.repeat(40) } })
    if (url.pathname.includes('/git/tags/')) return Response.json({ object: { type: 'commit', sha: source.targetCommit } })
    if (url.pathname.endsWith('/assets/10')) return new Response(null, {
      status: 302, headers: { location: 'https://release-assets.githubusercontent.com/archive?signature=do-not-persist' },
    })
    if (url.hostname === 'release-assets.githubusercontent.com') {
      return new Response(Uint8Array.from(damage === 'bytes' ? Buffer.from('corrupt') : bytes))
    }
    if (url.pathname.endsWith('/assets/11')) return new Response(Uint8Array.from(checksum))
    throw new Error('Unexpected offline request')
  })
  return { options, fetcher }
}

describe('bounded anonymous acquisition diagnostic', () => {
  it('forwards the original request/options/response without consuming or logging remote payloads', async () => {
    const response = new Response('PRIVATE_BODY', { status: 403, headers: {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1790019414', 'retry-after': '60',
      'x-github-request-id': 'ABCD:1234:5678:9ABC:12345678', 'set-cookie': 'SECRET_COOKIE',
      location: 'https://example.invalid/?token=SECRET_QUERY',
    } })
    const fetcher = vi.fn<typeof fetch>(async () => response)
    const observation = observePluginAcquisition(target, fetcher)
    const init = { headers: { accept: 'application/vnd.github+json' }, redirect: 'manual' as const,
      credentials: 'omit' as const, signal: new AbortController().signal }
    expect(await observation.fetch(metadataUrl, init)).toBe(response)
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(metadataUrl, init)
    expect(fetcher.mock.calls[0]![1]).toBe(init)
    expect(response.bodyUsed).toBe(false)
    expect(observation.observations).toEqual([{ route: 'release-metadata', host: 'api.github.com', status: 403,
      rateLimitRemaining: 0, rateLimitReset: 1790019414, retryAfter: 60, requestId: 'ABCD:1234:5678:9ABC:12345678' }])
    expect(JSON.stringify(observation.observations)).not.toMatch(/PRIVATE|SECRET|token=|example/u)
  })

  it('omits malformed metadata and preserves only validated HTTP dates', async () => {
    const observer = observePluginAcquisition(target, async () => new Response(null, { headers: {
      'x-ratelimit-remaining': '-1', 'x-ratelimit-reset': 'secret', 'x-github-request-id': 'secret',
      'retry-after': 'Mon, 21 Sep 2026 19:00:00 GMT',
    } }))
    await observer.fetch(metadataUrl)
    expect(observer.observations).toEqual([{ route: 'release-metadata', host: 'api.github.com', status: 200,
      retryAfter: 'Mon, 21 Sep 2026 19:00:00 GMT' }])
  })

  it('does not retain transport exceptions or signed redirect queries', async () => {
    const observer = observePluginAcquisition(target, async () => { throw new Error('Bearer SECRET https://host/?signature=PRIVATE') })
    await expect(observer.fetch('https://release-assets.githubusercontent.com/archive?signature=PRIVATE'))
      .rejects.toThrow('Diagnostic acquisition transport failed')
    expect(observer.observations).toEqual([
      { route: 'asset-redirect', host: 'release-assets.githubusercontent.com', transportFailure: true },
    ])
    expect(JSON.stringify(observer.observations)).not.toMatch(/PRIVATE|SECRET|signature/u)
  })

  it('rejects authentication, extra endpoints, and request31 before transport without retrying', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => new Response())
    const observer = observePluginAcquisition(target, fetcher)
    await expect(observer.fetch(metadataUrl, { headers: { authorization: 'Bearer private' } })).rejects.toThrow('authentication')
    await expect(observer.fetch(`${base}/rate_limit`)).rejects.toThrow('api-route')
    await expect(observer.fetch(`${metadataUrl}?token=PRIVATE`)).rejects.toThrow('api-query')
    expect(observer.rejection).toBe('api-query')
    expect(fetcher).not.toHaveBeenCalled()
    for (let index = 0; index < 30; index++) await observer.fetch(metadataUrl)
    await expect(observer.fetch(metadataUrl)).rejects.toThrow('request-limit')
    expect(fetcher).toHaveBeenCalledTimes(30)
    expect(observer.observations).toHaveLength(30)
    expect(observer.rejection).toBe('request-limit')
  })

  it('verifies one complete acquisition and removes all downloaded bytes', async () => {
    const { options, fetcher } = await acquisitionFixture()
    await expect(diagnosePluginAcquisition(options, fetcher)).resolves.toMatchObject({
      attemptCount: 1, outcome: 'verified', cleanup: 'removed', observerRejection: 'none',
      releaseId: 12, installed: false, executedPlugin: false,
    })
    expect(fetcher).toHaveBeenCalledTimes(6)
    expect(readdirSync(options.scratch)).toEqual([])
    expect(readFileSync(options.output, 'utf8')).not.toContain('do-not-persist')
  })

  it.each(['bytes', 'mutable', 'forbidden-script'] as const)('keeps product %s validation fatal with safe evidence', async (damage) => {
    const { options, fetcher } = await acquisitionFixture(damage)
    await expect(diagnosePluginAcquisition(options, fetcher)).rejects.toThrow('Anonymous acquisition diagnostic failed')
    const report: unknown = JSON.parse(readFileSync(options.output, 'utf8'))
    expect(report).toMatchObject({ outcome: 'failed', cleanup: 'removed', attemptCount: 1 })
    expect(readdirSync(options.scratch)).toEqual([])
    expect(readFileSync(options.output, 'utf8')).not.toMatch(/must-not-execute|corrupt|do-not-persist/u)
  })

  it('rejects unreviewed plan bytes before making requests', async () => {
    const { options, fetcher } = await acquisitionFixture()
    await expect(diagnosePluginAcquisition({ ...options, planSha256: '0'.repeat(64) }, fetcher)).rejects.toThrow('plan hash')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('uses the existing OS-only smoke environment instead of ambient credentials or profile state', () => {
    const environment = desktopSmokeEnvironment(root(), {
      PATH: 'os-path', GH_TOKEN: 'private', GITHUB_TOKEN: 'private', ACTIONS_RUNTIME_TOKEN: 'private',
      NODE_OPTIONS: 'private', HTTPS_PROXY: 'https://user:password@proxy', HOME: 'live-home',
    })
    expect(environment.PATH).toBe('os-path')
    expect(JSON.stringify(environment)).not.toMatch(/private|live-home|password/u)
  })
})
