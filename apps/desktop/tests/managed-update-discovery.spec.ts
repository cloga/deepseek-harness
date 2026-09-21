import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import {
  DesktopManagedUpdateCoordinator,
  discoverDesktopManagedInstalledRelease,
  discoverDesktopManagedSourceRelease,
} from '../src/managed-update-coordinator.ts'
import { discoverDesktopReleaseForBuild } from '../scripts/desktop-release-github-fetch.ts'
import { managedUpdateJsonSha256 } from '../src/managed-update-protocol.ts'
import { managedCapability, managedManifest } from './managed-update-fixture.ts'

const api = 'https://api.github.com/repos/cloga/deepseek-harness'
const listUrl = `${api}/releases?per_page=100`
const capability = () => managedCapability({ currentSequence: 29 })
type Json = Record<string, unknown>
function object(value: unknown): Json {
  assert(value !== null && typeof value === 'object' && !Array.isArray(value))
  return value as Json
}
function array(value: unknown): unknown[] { assert(Array.isArray(value)); return value }
const hash = (body: string) => createHash('sha256').update(body).digest('hex')

function release(sequence: number, version = `1.2.${sequence}`) {
  const tag = `dsh-desktop-v${version}`
  const commit = sequence.toString(16).padStart(40, '0')
  const original = managedManifest()
  const manifest = managedManifest({
    sequence, version, source: { ...original.source, commit, tag },
    installer: { ...original.installer, file: `cloga-deepseek-harness-${version}-win-x64.exe` },
  })
  const body = JSON.stringify(manifest)
  const metadata: Json = { tag_name: tag, target_commitish: commit, draft: false, immutable: true,
    assets: [{ name: 'release.json', state: 'uploaded', digest: `sha256:${hash(body)}` }] }
  const ref: Json = { object: { type: 'commit', sha: commit } }
  return { tag, commit, body, metadata, ref }
}
type Release = ReturnType<typeof release>
function rewriteManifest(entry: Release, change: (value: Json) => void, sealSelf = true): void {
  const value = object(JSON.parse(entry.body))
  change(value)
  if (sealSelf) {
    const { manifestSha256: _old, ...payload } = value
    value.manifestSha256 = managedUpdateJsonSha256(payload)
  }
  entry.body = JSON.stringify(value)
  object(array(entry.metadata.assets)[0]).digest = `sha256:${hash(entry.body)}`
}
function catalog(entries: Release[]) {
  const requests: Array<{ url: string; authorization: string | null }> = []
  const tagObjects = new Map<string, Json>()
  const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    requests.push({ url, authorization: new Headers(init?.headers).get('authorization') })
    expect(init?.redirect).toBe('manual')
    expect(init?.credentials).toBe('omit')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
    if (url === listUrl) return new Response(JSON.stringify(entries.map(entry => entry.metadata)))
    const manifest = entries.find(entry => url === `https://github.com/cloga/deepseek-harness/releases/download/${entry.tag}/release.json`)
    if (manifest !== undefined) return new Response(manifest.body)
    const reference = entries.find(entry => url === `${api}/git/ref/tags/${entry.tag}`)
    if (reference !== undefined) return new Response(JSON.stringify(reference.ref))
    const tag = tagObjects.get(url)
    if (tag !== undefined) return new Response(JSON.stringify(tag))
    throw new Error(`Unexpected synthetic discovery request: ${url}`)
  })
  const rest = () => requests.filter(request => new URL(request.url).hostname === 'api.github.com')
  const manifests = () => requests.filter(request => request.url.includes('/releases/download/'))
  const refs = () => requests.filter(request => request.url.includes('/git/ref/tags/'))
  return { fetch, requests, tagObjects, rest, manifests, refs }
}

describe('managed discovery validates all manifests but dereferences only scoped tags', () => {
  it('validates nineteen older manifests with one REST call and no tag lookups at floor29', async () => {
    const entries = Array.from({ length: 19 }, (_, index) => release(index + 2))
    const transport = catalog(entries)
    await expect(discoverDesktopManagedSourceRelease(capability(), 29, transport)).resolves.toBeUndefined()
    expect(transport.rest().map(request => request.url)).toEqual([listUrl])
    expect(transport.refs()).toHaveLength(0)
    expect(transport.manifests().map(request => request.url)).toEqual(entries.map(entry =>
      `https://github.com/cloga/deepseek-harness/releases/download/${entry.tag}/release.json`))
    expect(transport.requests.every(request => request.authorization === null)).toBe(true)
  })

  it('bounds the recorded four-boot/two-acquisition pre-installer workload without caching or claiming traffic measurement', async () => {
    const transport = catalog(Array.from({ length: 19 }, (_, index) => release(index + 2)))
    for (let boot = 0; boot < 4; boot++) {
      await expect(discoverDesktopManagedSourceRelease(capability(), 29, transport)).resolves.toBeUndefined()
    }
    expect(transport.rest()).toHaveLength(4)
    expect(transport.manifests()).toHaveLength(4 * 19)
    // Recorded alpha33 acquisition shape: release + ref + one annotated object + archive/checksum API endpoints.
    // This static term describes d1's two fresh profiles, not an observed runner/IP request trace.
    const acquisitionRequests = 2 * (1 + 1 + 1 + 2)
    expect(transport.rest().length + acquisitionRequests).toBe(14)
    expect(4 * (1 + 19) + acquisitionRequests).toBe(90)
  })

  it('verifies equal-floor and every newer candidate, including a nonwinner, after each original manifest', async () => {
    const entries = [release(28), release(29), release(30), release(31)]
    const transport = catalog(entries)
    const selected = await discoverDesktopManagedSourceRelease(capability(), 29, transport)
    expect(selected?.manifest.sequence).toBe(31)
    expect(transport.manifests()).toHaveLength(4)
    expect(transport.refs().map(request => request.url)).toEqual(entries.slice(1).map(entry => `${api}/git/ref/tags/${entry.tag}`))
    for (const entry of entries.slice(1)) {
      const manifest = transport.requests.findIndex(request => request.url.endsWith(`/${entry.tag}/release.json`))
      const reference = transport.requests.findIndex(request => request.url === `${api}/git/ref/tags/${entry.tag}`)
      expect(reference).toBeGreaterThan(manifest)
    }
  })

  it.each([false, true])('rejects a mismatched eligible nonwinner regardless of traversal order (reversed=%s)', async (reversed) => {
    const nonwinner = release(29)
    nonwinner.ref = { object: { type: 'commit', sha: 'f'.repeat(40) } }
    const entries = [nonwinner, release(30)]
    if (reversed) entries.reverse()
    await expect(discoverDesktopManagedSourceRelease(capability(), 29, catalog(entries))).rejects.toThrow('tag does not resolve')
  })

  it('never falls back to migration after an eligible tag failure, even at floor zero', async () => {
    const entry = release(29)
    entry.ref = { object: { type: 'commit', sha: 'f'.repeat(40) } }
    const transport = catalog([entry])
    const launch = vi.fn(async () => true)
    const coordinator = new DesktopManagedUpdateCoordinator(managedCapability({ currentSequence: 29, migration: {
      owner: 'cloga/dsh-windows-ops', manifestUrl: 'https://github.com/cloga/dsh-windows-ops/releases/download/legacy/release.json',
      manifestSha256: '2'.repeat(64), assetSha256: '3'.repeat(64), maximumSequence: 1,
      expectedSource: { version: '0.1.5-rc.2', tag: 'dsh-v0.1.5-rc.2' },
    } }), () => 0, state => state, launch, transport)
    const state = await coordinator.check()
    expect(state.phase).toBe('error')
    if (state.phase !== 'error') throw new Error('Expected eligible tag failure')
    expect(state.message).toContain('tag does not resolve')
    expect(transport.requests.some(request => request.url.includes('dsh-windows-ops'))).toBe(false)
    expect(launch).not.toHaveBeenCalled()
  })

  it('does not audit an ineligible old tag, but build floor0 still rejects that exact corrupt tag', async () => {
    const old = release(28)
    old.ref = { object: { type: 'commit', sha: 'f'.repeat(40) } }
    const transport = catalog([old, release(29)])
    await expect(discoverDesktopManagedSourceRelease(capability(), 29, transport)).resolves.toMatchObject({ manifest: { sequence: 29 } })
    expect(transport.refs()).toHaveLength(1)
    await expect(discoverDesktopReleaseForBuild(capability(), 'fake-build-only-token', catalog([old, release(29)]).fetch))
      .rejects.toThrow()
  })

  it('retains authenticated build floor0 full-catalog tag verification without authenticating manifest downloads', async () => {
    const transport = catalog(Array.from({ length: 19 }, (_, index) => release(index + 2)))
    await expect(discoverDesktopReleaseForBuild(capability(), 'fake-build-only-token', transport.fetch))
      .resolves.toMatchObject({ manifest: { sequence: 20 } })
    expect(transport.rest()).toHaveLength(20)
    expect(transport.refs()).toHaveLength(19)
    expect(transport.manifests()).toHaveLength(19)
    expect(transport.rest().every(request => request.authorization === 'Bearer fake-build-only-token')).toBe(true)
    expect(transport.manifests().every(request => request.authorization === null)).toBe(true)
  })

  it('keeps exact-installed recovery distinct from minimum-floor discovery', async () => {
    const old = release(28)
    const current = release(29)
    const newer = release(30)
    old.ref = newer.ref = { object: { type: 'commit', sha: 'f'.repeat(40) } }
    const transport = catalog([old, current, newer])
    await expect(discoverDesktopManagedInstalledRelease(capability(), '1.2.29', transport))
      .resolves.toMatchObject({ manifest: { sequence: 29, version: '1.2.29' } })
    expect(transport.manifests()).toHaveLength(3)
    expect(transport.refs().map(request => request.url)).toEqual([`${api}/git/ref/tags/${current.tag}`])
  })

  it('rejects an unbound exact-installed tag rather than accepting matching manifest sequence/version alone', async () => {
    const current = release(29)
    current.ref = { object: { type: 'commit', sha: 'f'.repeat(40) } }
    const transport = catalog([release(28), current, release(30)])
    await expect(discoverDesktopManagedInstalledRelease(capability(), '1.2.29', transport)).rejects.toThrow('tag does not resolve')
    expect(transport.refs().map(request => request.url)).toEqual([`${api}/git/ref/tags/${current.tag}`])
  })

  it('rejects missing exact installation and version mismatch without falling back to another sequence', async () => {
    const missing = catalog([release(28), release(30)])
    await expect(discoverDesktopManagedInstalledRelease(capability(), '1.2.29', missing)).rejects.toThrow('no matching immutable publication')
    expect(missing.refs()).toHaveLength(0)
    const mismatch = catalog([release(29)])
    await expect(discoverDesktopManagedInstalledRelease(capability(), '1.2.30', mismatch)).rejects.toThrow('no matching immutable publication')
    expect(mismatch.refs()).toHaveLength(1)
  })

  it.each(['minimum', 'exact'] as const)('retains highest eligible sequence conflicts in %s mode', async (kind) => {
    const transport = catalog([release(29), release(29, '1.2.29-other')])
    const result = kind === 'minimum'
      ? discoverDesktopManagedSourceRelease(capability(), 29, transport)
      : discoverDesktopManagedInstalledRelease(capability(), '1.2.29', transport)
    await expect(result).rejects.toThrow('conflicting manifests')
    expect(transport.refs()).toHaveLength(2)
  })

  it.each(['immutable', 'draft', 'commit', 'missing-asset', 'duplicate-asset', 'not-uploaded', 'missing-digest', 'malformed-digest',
    'raw-digest', 'self-hash', 'source-commit', 'source-tag', 'minimum-sequence', 'unknown-field'])('rejects old ineligible %s damage before accepting a valid current release', async (damage) => {
    const old = release(28)
    const asset = object(array(old.metadata.assets)[0])
    if (damage === 'immutable') old.metadata.immutable = false
    else if (damage === 'draft') old.metadata.draft = true
    else if (damage === 'commit') old.metadata.target_commitish = 'master'
    else if (damage === 'missing-asset') old.metadata.assets = []
    else if (damage === 'duplicate-asset') old.metadata.assets = [asset, asset]
    else if (damage === 'not-uploaded') asset.state = 'new'
    else if (damage === 'missing-digest') Reflect.deleteProperty(asset, 'digest')
    else if (damage === 'malformed-digest') asset.digest = 'sha256:invalid'
    else if (damage === 'raw-digest') old.body += '\n'
    else if (damage === 'self-hash') rewriteManifest(old, (value) => { value.manifestSha256 = '0'.repeat(64) }, false)
    else if (damage === 'source-commit') rewriteManifest(old, (value) => { object(value.source).commit = 'f'.repeat(40) })
    else if (damage === 'source-tag') rewriteManifest(old, (value) => {
      value.version = '1.2.28-other'; object(value.source).tag = 'dsh-desktop-v1.2.28-other'
      object(value.installer).file = 'cloga-deepseek-harness-1.2.28-other-win-x64.exe'
    })
    else if (damage === 'minimum-sequence') rewriteManifest(old, (value) => { value.sequence = 1 })
    else rewriteManifest(old, (value) => { value.unreviewed = true })
    for (const exact of [false, true]) {
      const transport = catalog([old, release(29)])
      const result = exact ? discoverDesktopManagedInstalledRelease(capability(), '1.2.29', transport)
        : discoverDesktopManagedSourceRelease(capability(), 29, transport)
      await expect(result).rejects.toThrow()
      expect(transport.refs()).toHaveLength(0)
    }
  })

  it.each([1, 3, 4])('preserves the original annotated-tag depth boundary at %i objects', async (depth) => {
    const entry = release(29)
    const transport = catalog([entry])
    const shas = Array.from({ length: depth }, (_, index) => (index + 100).toString(16).padStart(40, '0'))
    entry.ref = { object: { type: 'tag', sha: shas[0] } }
    for (const [index, sha] of shas.entries()) {
      transport.tagObjects.set(`${api}/git/tags/${sha}`, { object: index === depth - 1
        ? { type: 'commit', sha: entry.commit } : { type: 'tag', sha: shas[index + 1] } })
    }
    const result = discoverDesktopManagedSourceRelease(capability(), 29, transport)
    if (depth === 4) await expect(result).rejects.toThrow('indirection limit')
    else await expect(result).resolves.toMatchObject({ manifest: { sequence: 29 } })
    expect(transport.requests.filter(request => request.url.includes('/git/tags/'))).toHaveLength(depth)
  })
})
