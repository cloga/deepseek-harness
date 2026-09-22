/** Offline execution of the release publisher's fail-closed mutation sequence. */
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { publishForkRelease } from '../scripts/publish-fork-release.mjs'

const repository = 'cloga/deepseek-harness'
const sourceSha = 'a'.repeat(40)
const version = '0.1.6-alpha.2.cloga.1'
const tag = `dsh-desktop-v${version}`
const reviewedPlanBytes = await readFile(new URL('../release/cloga-windows-x64.json', import.meta.url))
const reviewedPlan = JSON.parse(reviewedPlanBytes.toString('utf8')) as {
  version: string
  upstreamVersion: string
  sequence: number
  channel: string
}
const api = `https://api.github.com/repos/${repository}`
const tagUrl = `${api}/git/ref/tags/${tag}`
const tagReleaseUrl = `${api}/releases/tags/${tag}`
const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))) })

interface Asset { id: number; name: string; size: number; digest: string; state: string }
interface Release {
  id: number
  tag_name: string
  target_commitish: string
  draft: boolean
  prerelease: boolean
  immutable: boolean
  upload_url: string
}
interface Call { url: string; method: string }
interface State {
  calls: Call[]
  ref: { ref: string; object: { type: string; sha: string } } | null
  release: Release | null
  assets: Asset[]
  assetReads: number
}
type Intercept = (call: Call, state: State) => Response | undefined
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const digest = (bytes: string | Buffer, algorithm = 'sha256') => createHash(algorithm).update(bytes).digest(algorithm === 'sha512' ? 'base64' : 'hex')

async function fixture(intercept?: Intercept) {
  const directory = await mkdtemp(join(tmpdir(), 'fork-publisher-'))
  roots.push(directory)
  const installer = `cloga-deepseek-harness-${version}-win-x64.exe`
  const installerBytes = Buffer.from('offline installer bytes')
  const installerRecord = { file: installer, bytes: installerBytes.length, sha256: digest(installerBytes) }
  const source = { repository, commit: sourceSha, tag, version }
  const planSha256 = digest(reviewedPlanBytes)
  const receipt = JSON.stringify({ source, artifacts: { installer: installerRecord },
    buildInputs: { planSha256 }, identity: { upstreamVersion: reviewedPlan.upstreamVersion, sequence: reviewedPlan.sequence } })
  const manifest = JSON.stringify({ source, version, upstreamVersion: reviewedPlan.upstreamVersion,
    channel: reviewedPlan.channel, sequence: reviewedPlan.sequence, build: { planSha256 }, installer: installerRecord,
    buildReceipt: { file: 'build-receipt.json', sha256: digest(receipt) } })
  const files: Record<string, string | Buffer> = { [installer]: installerBytes, 'desktop-provisioning.json': '{}', 'build-receipt.json': receipt, 'release.json': manifest }
  const payload = Object.entries(files)
  files.SHA256SUMS = `${payload.map(([name, bytes]) => `${digest(bytes)}  ${name}`).join('\n')}\n`
  files.SHA512SUMS = `${payload.map(([name, bytes]) => `${digest(bytes, 'sha512')}  ${name}`).join('\n')}\n`
  await Promise.all(Object.entries(files).map(([name, bytes]) => writeFile(join(directory, name), bytes)))
  const state: State = { calls: [], ref: null, release: null, assets: [], assetReads: 0 }
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    const jsonBody = () => {
      if (typeof init?.body !== 'string') throw new Error('Expected a JSON string request')
      return JSON.parse(init.body) as Record<string, unknown>
    }
    const method = init?.method ?? 'GET'
    const call = { url, method }
    state.calls.push(call)
    expect(init?.redirect).toBe('error')
    const headers = new Headers(init?.headers)
    expect(headers.get('authorization')).toBe('Bearer workflow-only-token')
    const override = intercept?.(call, state)
    if (override) return override
    if (url === tagReleaseUrl && method === 'GET') return state.release ? json(state.release) : json({}, 404)
    if (url === tagUrl && method === 'GET') return state.ref ? json(state.ref) : json({}, 404)
    if (url === `${api}/releases?per_page=100&page=1` && method === 'GET') return json([])
    if (url === `${api}/git/commits/${sourceSha}` && method === 'GET') return json({ sha: sourceSha })
    if (url === `${api}/git/refs` && method === 'POST') {
      expect(state.ref).toBeNull()
      expect(jsonBody()).toEqual({ ref: `refs/tags/${tag}`, sha: sourceSha })
      state.ref = { ref: `refs/tags/${tag}`, object: { type: 'commit', sha: sourceSha } }
      return json(state.ref, 201)
    }
    if (url === `${api}/releases` && method === 'POST') {
      expect(state.release).toBeNull()
      const body = jsonBody() as Omit<Release, 'id' | 'immutable' | 'upload_url'>
      state.release = { ...body, id: 42, immutable: false, upload_url: 'https://untrusted.invalid/steal-token' }
      return json(state.release, 201)
    }
    if (url === `${api}/releases/42` && method === 'GET') return json(state.release)
    if (url === `${api}/releases/42/assets?per_page=100` && method === 'GET') {
      state.assetReads += 1
      return json(state.assets)
    }
    if (url.startsWith(`https://uploads.github.com/repos/${repository}/releases/42/assets?name=`) && method === 'POST') {
      const chunks: Uint8Array[] = []
      for await (const chunk of init?.body as unknown as AsyncIterable<Uint8Array>) chunks.push(chunk)
      const bytes = Buffer.concat(chunks)
      expect(Number(headers.get('content-length'))).toBe(bytes.length)
      const asset = { id: state.assets.length + 1, name: new URL(url).searchParams.get('name')!, size: bytes.length, digest: `sha256:${digest(bytes)}`, state: 'uploaded' }
      state.assets.push(asset)
      return json(asset, 201)
    }
    if (url === `${api}/releases/42` && method === 'PATCH') {
      expect(jsonBody()).toEqual({ draft: false })
      expect(state.release?.draft).toBe(true)
      state.release!.draft = false
      state.release!.immutable = true
      return json(state.release)
    }
    throw new Error(`Unexpected offline request ${method} ${url}`)
  }
  const options = { repository, sourceSha, tag, version, assetsDirectory: directory, token: 'workflow-only-token', fetchImpl }
  return { state, options, directory, files }
}
function publicWrites(state: State) { return state.calls.filter(call => call.method === 'PATCH') }
function writes(state: State) { return state.calls.filter(call => call.method !== 'GET') }

describe('fail-closed fork publication', () => {
  it('executes the CLI without outputs or networking when reviewed inputs are invalid', async () => {
    const { directory } = await fixture()
    const output = join(directory, 'github-output')
    const child = spawnSync(process.execPath, [
      '--import', `data:text/javascript,${encodeURIComponent('globalThis.fetch = async () => { throw new Error("offline test forbids networking") }')}`,
      fileURLToPath(new URL('../scripts/publish-fork-release.mjs', import.meta.url)), directory,
    ], { stdio: 'ignore', windowsHide: true, timeout: 10_000, env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, GITHUB_REPOSITORY: repository,
      SOURCE_SHA: 'invalid', RELEASE_TAG: tag, RELEASE_VERSION: version, GH_TOKEN: 'offline-test', GITHUB_OUTPUT: output,
    } })
    expect(child.error).toBeUndefined()
    expect(child.status).toBe(1)
    await expect(readFile(output)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('finds an unpublished matching draft on a later authenticated listing page', async () => {
    const { state, options } = await fixture((call) => {
      if (call.url === `${api}/releases?per_page=100&page=1`) return json(Array.from({ length: 100 }, (_, id) => ({ id, tag_name: `other-${id}` })))
      if (call.url === `${api}/releases?per_page=100&page=2`) return json([{ id: 999, tag_name: tag, draft: true }])
      return undefined
    })
    await expect(publishForkRelease(options)).rejects.toThrow('already exists')
    expect(writes(state)).toEqual([])
  })

  it('does not interpret a failed draft listing as absence', async () => {
    const { state, options } = await fixture(call => call.url.includes('/releases?') ? json({}, 403) : undefined)
    await expect(publishForkRelease(options)).rejects.toThrow('HTTP 403')
    expect(writes(state)).toEqual([])
  })

  it.each(['tag', 'draft', 'upload'])('never retries an uncertain %s creation', async (stage) => {
    const { state, options } = await fixture((call) => {
      if (call.method === 'POST' && ((stage === 'tag' && call.url.endsWith('/git/refs'))
        || (stage === 'draft' && call.url === `${api}/releases`)
        || (stage === 'upload' && call.url.startsWith('https://uploads.github.com/')))) throw new Error('response lost')
      return undefined
    })
    await expect(publishForkRelease(options)).rejects.toThrow('response lost')
    expect(publicWrites(state)).toEqual([])
    const last = state.calls.at(-1)!
    expect(state.calls.filter(call => call.method === last.method && call.url === last.url)).toHaveLength(1)
  })

  it('rejects a different draft ID during pre-publication verification', async () => {
    const { state, options } = await fixture((call, current) => call.url === `${api}/releases/42` && call.method === 'GET'
      ? json({ ...current.release, id: 999 }) : undefined)
    await expect(publishForkRelease(options)).rejects.toThrow('owned draft')
    expect(publicWrites(state)).toEqual([])
  })
  it('publishes the exact alpha2 sequence-32 source plan through one owned and fully verified draft', async () => {
    expect(reviewedPlan).toMatchObject({ version, upstreamVersion: '0.1.6-alpha.2', sequence: 32, channel: 'cloga-windows-x64' })
    const { state, options, files } = await fixture()
    expect(await publishForkRelease(options)).toEqual({
      release_url: `https://github.com/${repository}/releases/tag/${tag}`,
      manifest_url: `https://github.com/${repository}/releases/download/${tag}/release.json`,
    })
    expect(state.assets.map(asset => asset.name).sort()).toEqual(Object.keys(files).sort())
    expect(publicWrites(state)).toHaveLength(1)
    expect(writes(state)).toHaveLength(9)
    expect(state.assetReads).toBe(3)
    expect(state.calls.some(call => call.url.includes('untrusted.invalid'))).toBe(false)
  })

  it.each([401, 403, 429, 500, 503])('does not interpret HTTP %s as absence', async (status) => {
    const { state, options } = await fixture(call => call.url === tagReleaseUrl ? json({}, status) : undefined)
    await expect(publishForkRelease(options)).rejects.toThrow(`HTTP ${status}`)
    expect(writes(state)).toEqual([])
  })

  it.each([tagReleaseUrl, tagUrl])('stops on a network error inspecting %s', async (url) => {
    const { state, options } = await fixture((call) => { if (call.url === url) throw new Error('offline network failure'); return undefined })
    await expect(publishForkRelease(options)).rejects.toThrow('offline network failure')
    expect(writes(state)).toEqual([])
  })

  it.each(['release', 'tag'])('never adopts an existing %s', async (kind) => {
    const { state, options } = await fixture(call => call.url === (kind === 'release' ? tagReleaseUrl : tagUrl) ? json({ id: 991, draft: true }) : undefined)
    await expect(publishForkRelease(options)).rejects.toThrow('already exists')
    expect(writes(state)).toEqual([])
  })

  it.each(['repository', 'sourceSha', 'tag', 'version'])('rejects invalid reviewed %s before networking', async (key) => {
    const { state, options } = await fixture()
    await expect(publishForkRelease({ ...options, [key]: 'wrong' })).rejects.toThrow()
    expect(state.calls).toEqual([])
  })

  it.each(['0.1.6-alpha.1.cloga.7', '0.1.6-alpha.2.cloga.2'])('rejects a matching tag for unplanned version %s before networking', async (unplanned) => {
    const { state, options } = await fixture()
    await expect(publishForkRelease({ ...options, version: unplanned, tag: `dsh-desktop-v${unplanned}` }))
      .rejects.toThrow('Version differs from the reviewed source plan')
    expect(state.calls).toEqual([])
  })

  it.each(['upstreamVersion', 'channel', 'sequence', 'planSha256'] as const)(
    'rejects a manifest %s from another plan before networking', async (field) => {
      const { state, options, directory } = await fixture()
      const path = join(directory, 'release.json')
      const manifest = JSON.parse(await readFile(path, 'utf8')) as {
        upstreamVersion: string
        channel: string
        sequence: number
        build: { planSha256: string }
      }
      if (field === 'planSha256') manifest.build.planSha256 = digest(Buffer.concat([reviewedPlanBytes, Buffer.from('\n')]))
      else if (field === 'sequence') manifest.sequence = 17
      else manifest[field] = field === 'upstreamVersion' ? '0.1.6-alpha.1' : 'other-channel'
      await writeFile(path, JSON.stringify(manifest))
      await expect(publishForkRelease(options)).rejects.toThrow(/reviewed plan/u)
      expect(state.calls).toEqual([])
    },
  )

  it.each(['upstreamVersion', 'sequence', 'planSha256'] as const)(
    'rejects a receipt %s from another plan before networking', async (field) => {
      const { state, options, directory } = await fixture()
      const path = join(directory, 'build-receipt.json')
      const receipt = JSON.parse(await readFile(path, 'utf8')) as {
        identity: { upstreamVersion: string; sequence: number }
        buildInputs: { planSha256: string }
      }
      if (field === 'planSha256') receipt.buildInputs.planSha256 = digest(Buffer.concat([reviewedPlanBytes, Buffer.from('\n')]))
      else if (field === 'sequence') receipt.identity.sequence = 17
      else receipt.identity.upstreamVersion = '0.1.6-alpha.1'
      await writeFile(path, JSON.stringify(receipt))
      await expect(publishForkRelease(options)).rejects.toThrow(/reviewed plan/u)
      expect(state.calls).toEqual([])
    },
  )

  it.each(['version', 'commit', 'tag'])('rejects a local manifest %s mismatch before mutation', async (key) => {
    const { state, options, directory } = await fixture()
    const path = join(directory, 'release.json')
    const manifest = JSON.parse(await readFile(path, 'utf8')) as { version: string; source: Record<string, string> }
    if (key === 'version') manifest.version = 'wrong'
    else manifest.source[key] = 'wrong'
    await writeFile(path, JSON.stringify(manifest))
    await expect(publishForkRelease(options)).rejects.toThrow()
    expect(state.calls).toEqual([])
  })

  it.each(['293 Core/Web tarballs', 'tarball substituted for installer', 'tarball added beside installer'])(
    'rejects %s even with matching checksums and a Desktop tag, before networking', async (kind) => {
      const { state, options, directory, files } = await fixture()
      const installer = `cloga-deepseek-harness-${version}-win-x64.exe`
      if (kind === '293 Core/Web tarballs') {
        for (const name of Object.keys(files)) await rm(join(directory, name))
        for (const name of Object.keys(files)) Reflect.deleteProperty(files, name)
        for (let index = 0; index < 293; index += 1) files[`core-web-${index}.tgz`] = `package ${index}`
      } else {
        if (kind === 'tarball substituted for installer') {
          await rm(join(directory, installer))
          Reflect.deleteProperty(files, installer)
        }
        files['core-web.tgz'] = 'raw package bytes'
      }
      const payload = Object.entries(files).filter(([name]) => name !== 'SHA256SUMS' && name !== 'SHA512SUMS')
      for (const [name, algorithm] of [['SHA256SUMS', 'sha256'], ['SHA512SUMS', 'sha512']] as const) {
        files[name] = `${payload.map(([file, bytes]) => `${digest(bytes, algorithm)}  ${file}`).join('\n')}\n`
      }
      await Promise.all(Object.entries(files).map(([name, bytes]) => writeFile(join(directory, name), bytes)))
      await expect(publishForkRelease(options)).rejects.toThrow('Unexpected local asset set')
      expect(state.calls).toEqual([])
    },
  )

  it('rejects changed local payload bytes before any remote call', async () => {
    const { state, options, directory } = await fixture()
    await writeFile(join(directory, 'desktop-provisioning.json'), 'changed')
    await expect(publishForkRelease(options)).rejects.toThrow('SHA256SUMS')
    expect(state.calls).toEqual([])
  })

  it.each(['tag race', 'draft creation', 'upload'])('stops after %s failure without publishing or cleanup', async (stage) => {
    const { state, options } = await fixture((call) => {
      if (stage === 'tag race' && call.method === 'POST' && call.url === `${api}/git/refs`) return json({}, 422)
      if (stage === 'draft creation' && call.method === 'POST' && call.url === `${api}/releases`) return json({}, 500)
      if (stage === 'upload' && call.url.startsWith('https://uploads.github.com/')) return json({}, 502)
      return undefined
    })
    await expect(publishForkRelease(options)).rejects.toThrow('HTTP')
    expect(publicWrites(state)).toEqual([])
    expect(state.calls.filter(call => call.method === 'DELETE')).toEqual([])
    expect(state.calls.filter(call => call.url.startsWith('https://uploads.github.com/'))).toHaveLength(stage === 'upload' ? 1 : 0)
  })

  it.each(['id', 'target', 'tag', 'not draft'])('rejects an unowned or mismatched new draft: %s', async (fault) => {
    const { state, options } = await fixture((call) => {
      if (call.method !== 'POST' || call.url !== `${api}/releases`) return undefined
      return json({ id: fault === 'id' ? null : 42, tag_name: fault === 'tag' ? 'wrong' : tag,
        target_commitish: fault === 'target' ? 'b'.repeat(40) : sourceSha, draft: fault !== 'not draft', prerelease: true }, 201)
    })
    await expect(publishForkRelease(options)).rejects.toThrow()
    expect(publicWrites(state)).toEqual([])
    expect(state.calls.some(call => call.url.startsWith('https://uploads.github.com/'))).toBe(false)
  })

  it.each(['missing', 'extra', 'duplicate', 'digest', 'size', 'state'])('refuses a draft with %s assets', async (fault) => {
    const { state, options } = await fixture((call, current) => {
      if (!call.url.endsWith('/assets?per_page=100') || current.assetReads !== 1) return undefined
      const assets = current.assets.map(asset => ({ ...asset }))
      if (fault === 'missing') assets.pop()
      if (fault === 'extra') assets.push({ ...assets[0]!, id: 99, name: 'extra' })
      if (fault === 'duplicate') assets[1] = { ...assets[0]! }
      if (fault === 'digest') assets[0]!.digest = `sha256:${'0'.repeat(64)}`
      if (fault === 'size') assets[0]!.size += 1
      if (fault === 'state') assets[0]!.state = 'starter'
      return json(assets)
    })
    await expect(publishForkRelease(options)).rejects.toThrow()
    expect(publicWrites(state)).toEqual([])
  })

  it('checks the tag again before making the owned draft public', async () => {
    const { state, options } = await fixture((call, current) => call.url === tagUrl && current.ref
      ? json({ ...current.ref, object: { type: 'commit', sha: 'b'.repeat(40) } }) : undefined)
    await expect(publishForkRelease(options)).rejects.toThrow('Tag source differs')
    expect(publicWrites(state)).toEqual([])
  })

  it.each(['network', 'HTTP'])('does not retry an uncertain publication %s response', async (fault) => {
    const { state, options } = await fixture((call) => {
      if (call.method !== 'PATCH') return undefined
      if (fault === 'network') throw new Error('publication response lost')
      return json({}, 503)
    })
    await expect(publishForkRelease(options)).rejects.toThrow()
    expect(publicWrites(state)).toHaveLength(1)
    expect(state.calls.at(-1)?.method).toBe('PATCH')
  })

  it.each(['immutable', 'assets', 'tag', 'id'])('fails closed when final public verification differs: %s', async (fault) => {
    const { state, options } = await fixture((call, current) => {
      if (current.release?.draft !== false || call.method !== 'GET') return undefined
      if (fault === 'immutable' && call.url === `${api}/releases/42`) return json({ ...current.release, immutable: false })
      if (fault === 'id' && call.url === tagReleaseUrl) return json({ ...current.release, id: 99 })
      if (fault === 'assets' && call.url.endsWith('/assets?per_page=100')) return json([])
      if (fault === 'tag' && call.url === tagUrl) return json({ ...current.ref, object: { type: 'commit', sha: 'b'.repeat(40) } })
      return undefined
    })
    await expect(publishForkRelease(options)).rejects.toThrow()
    expect(publicWrites(state)).toHaveLength(1)
  })
})
