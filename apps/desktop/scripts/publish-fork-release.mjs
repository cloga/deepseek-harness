/** Publish one new fork release; ambiguous writes stop without retries or remote cleanup. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { appendFile, lstat, readFile, readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const repository = 'cloga/deepseek-harness'
const apiRoot = `https://api.github.com/repos/${repository}`

/** @param {string} path - Local regular file. @returns {Promise<{size:number, sha256:string, sha512:string}>} Measured bytes. */
async function measure(path) {
  const sha256 = createHash('sha256')
  const sha512 = createHash('sha512')
  let size = 0
  for await (const chunk of createReadStream(path)) {
    size += chunk.length
    sha256.update(chunk)
    sha512.update(chunk)
  }
  return { size, sha256: sha256.digest('hex'), sha512: sha512.digest('base64') }
}

/**
 * Publish only a newly owned draft after checking the exact local and remote asset sets.
 * Failed or uncertain writes leave remote state for human reconciliation, never retry or delete it.
 * @param {{repository:string, sourceSha:string, tag:string, version:string, assetsDirectory:string, token:string, fetchImpl?:typeof fetch}} options - Reviewed workflow inputs and optional offline transport.
 * @returns {Promise<{release_url:string, manifest_url:string}>} Verified immutable release URLs.
 */
export async function publishForkRelease(options) {
  const { sourceSha, tag, version, assetsDirectory, token, fetchImpl = fetch } = options
  assert.equal(options.repository, repository, 'Unexpected release repository')
  assert.match(sourceSha, /^[0-9a-f]{40}$/, 'Expected exact reviewed source SHA')
  assert.match(version, /^0\.1\.6-alpha\.1\.cloga\.[1-9]\d*$/, 'Unexpected maintained fork version')
  assert.equal(tag, `dsh-desktop-v${version}`, 'Version and tag differ')
  assert(typeof token === 'string' && token.length > 0, 'Workflow token is required')
  const installer = `cloga-deepseek-harness-${version}-win-x64.exe`
  const payloadNames = [installer, 'desktop-provisioning.json', 'build-receipt.json', 'release.json']
  const names = [...payloadNames, 'SHA256SUMS', 'SHA512SUMS'].sort()
  assert.deepEqual((await readdir(assetsDirectory)).sort(), names, 'Unexpected local asset set')
  const assets = []
  for (const name of names) {
    const path = join(assetsDirectory, name)
    assert((await lstat(path)).isFile(), 'Assets must be regular files, not links or directories')
    assets.push({ name, path, ...await measure(path) })
  }
  const manifest = JSON.parse(await readFile(join(assetsDirectory, 'release.json'), 'utf8'))
  const receipt = JSON.parse(await readFile(join(assetsDirectory, 'build-receipt.json'), 'utf8'))
  for (const document of [manifest, receipt]) {
    assert.equal(document.source?.repository, repository, 'Local source repository differs')
    assert.equal(document.source?.commit, sourceSha, 'Local source commit differs')
    assert.equal(document.source?.tag, tag, 'Local source tag differs')
  }
  assert.equal(manifest.version, version, 'Local manifest version differs')
  assert.equal(manifest.upstreamVersion, '0.1.6-alpha.1', 'Local Core version differs')
  assert.equal(receipt.source.version, version, 'Local receipt version differs')
  const installerBytes = assets.find(asset => asset.name === installer)
  for (const recorded of [manifest.installer, receipt.artifacts?.installer]) {
    assert.equal(recorded?.file, installer, 'Installer filename differs')
    assert.equal(recorded?.sha256, installerBytes.sha256, 'Installer digest differs')
    assert.equal(recorded?.bytes, installerBytes.size, 'Installer size differs')
  }
  assert.equal(manifest.buildReceipt?.file, 'build-receipt.json', 'Receipt filename differs')
  assert.equal(manifest.buildReceipt?.sha256, assets.find(asset => asset.name === 'build-receipt.json').sha256, 'Receipt digest differs')
  for (const [file, hash] of [['SHA256SUMS', 'sha256'], ['SHA512SUMS', 'sha512']]) {
    const lines = (await readFile(join(assetsDirectory, file), 'utf8')).trimEnd().split('\n')
    const expected = payloadNames.map(name => `${assets.find(asset => asset.name === name)[hash]}  ${name}`).sort()
    assert.deepEqual(lines.sort(), expected, `${file} differs from local bytes`)
  }

  /** Authenticated requests use only derived GitHub URLs, never response upload_url. */
  async function request(url, method = 'GET', body, absent = false, uploadSize) {
    const parsed = new URL(url)
    assert(parsed.protocol === 'https:' && parsed.port === '' && parsed.username === '' && parsed.password === '', 'Unexpected authenticated URL')
    assert(parsed.origin === 'https://api.github.com' || (parsed.origin === 'https://uploads.github.com' && method === 'POST' && uploadSize !== undefined), 'Unexpected authenticated host')
    const response = await fetchImpl(url, {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(uploadSize === undefined ? 90_000 : 600_000),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'dsh-desktop-fork-publisher',
        ...(body === undefined ? {} : { 'Content-Type': uploadSize === undefined ? 'application/json' : 'application/octet-stream' }),
        ...(uploadSize === undefined ? {} : { 'Content-Length': String(uploadSize) }),
      },
      ...(body === undefined ? {} : { body: uploadSize === undefined ? JSON.stringify(body) : body }),
      ...(uploadSize === undefined ? {} : { duplex: 'half' }),
    })
    if (absent && response.status === 404) return null
    assert.equal(response.status, method === 'POST' ? 201 : 200, `GitHub ${method} failed with HTTP ${response.status}`)
    return response.json()
  }
  const releaseByTag = `${apiRoot}/releases/tags/${encodeURIComponent(tag)}`
  const tagUrl = `${apiRoot}/git/ref/tags/${encodeURIComponent(tag)}`
  assert.equal(await request(releaseByTag, 'GET', undefined, true), null, 'Release already exists, including drafts')
  // Tag lookup may omit unpublished drafts; authenticated listing must also be exhausted.
  let releasesExhausted = false
  for (let page = 1; page <= 100; page += 1) {
    const releases = await request(`${apiRoot}/releases?per_page=100&page=${page}`)
    assert(Array.isArray(releases) && releases.length <= 100, 'Invalid release list')
    assert(!releases.some(release => release.tag_name === tag), 'Release already exists, including drafts')
    if (releases.length < 100) { releasesExhausted = true; break }
  }
  assert(releasesExhausted, 'Release listing limit reached; absence is unconfirmed')
  assert.equal(await request(tagUrl, 'GET', undefined, true), null, 'Tag already exists')
  const source = await request(`${apiRoot}/git/commits/${sourceSha}`)
  assert.equal(source.sha, sourceSha, 'Reviewed source commit is unavailable')
  const tagRef = `refs/tags/${tag}`
  const createdTag = await request(`${apiRoot}/git/refs`, 'POST', { ref: tagRef, sha: sourceSha })
  function assertTag(value) {
    assert.equal(value.ref, tagRef, 'Tag name differs')
    assert.equal(value.object?.type, 'commit', 'Expected a lightweight commit tag')
    assert.equal(value.object?.sha, sourceSha, 'Tag source differs')
  }
  assertTag(createdTag)
  const created = await request(`${apiRoot}/releases`, 'POST', {
    tag_name: tag, target_commitish: sourceSha, name: `Desktop fork ${version} (Windows x64)`,
    body: `Unsigned fork-owned Windows x64 Desktop release.\n\nSource commit: ${sourceSha}\n\nInteractive NSIS installer; Windows warnings and UAC remain user-controlled. Native electron-updater is disabled.`,
    draft: true, prerelease: true,
  })
  assert(Number.isSafeInteger(created.id) && created.id > 0, 'Invalid newly created draft ID')
  const releaseId = created.id
  function assertRelease(value, draft) {
    assert.equal(value.id, releaseId, 'Release ID is not the owned draft')
    assert.equal(value.tag_name, tag, 'Release tag differs')
    assert.equal(value.target_commitish, sourceSha, 'Release target differs')
    assert.equal(value.draft, draft, 'Unexpected release visibility')
    assert.equal(value.prerelease, true, 'Unexpected prerelease flag')
    if (!draft) assert.equal(value.immutable, true, 'Published release is not immutable')
  }
  assertRelease(created, true)
  const releaseUrl = `${apiRoot}/releases/${releaseId}`
  const assetUrl = `${releaseUrl}/assets?per_page=100`
  assert.deepEqual(await request(assetUrl), [], 'Newly created draft unexpectedly has assets')
  for (const asset of assets) {
    const stream = createReadStream(asset.path)
    try {
      const uploaded = await request(`https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(asset.name)}`, 'POST', stream, false, asset.size)
      assert.equal(uploaded.name, asset.name, 'Upload filename differs')
      assert.equal(uploaded.size, asset.size, 'Upload size differs')
      assert.equal(uploaded.digest, `sha256:${asset.sha256}`, 'Upload digest differs')
    } finally { stream.destroy() }
  }
  async function verify(draft) {
    assertRelease(await request(releaseUrl), draft)
    assertTag(await request(tagUrl))
    const remote = await request(assetUrl)
    assert(Array.isArray(remote), 'Invalid remote asset list')
    assert.equal(remote.length, assets.length, 'Remote asset count differs')
    assert.equal(new Set(remote.map(asset => asset.name)).size, remote.length, 'Duplicate remote asset filename')
    assert.equal(new Set(remote.map(asset => asset.id)).size, remote.length, 'Duplicate remote asset ID')
    assert.deepEqual(remote.map(asset => asset.name).sort(), names, 'Remote asset set differs')
    for (const expected of assets) {
      const actual = remote.find(asset => asset.name === expected.name)
      assert.equal(actual.state, 'uploaded', 'Remote asset is not uploaded')
      assert.equal(actual.size, expected.size, 'Remote asset size differs')
      assert.equal(actual.digest, `sha256:${expected.sha256}`, 'Remote asset digest differs')
    }
    if (!draft) assertRelease(await request(releaseByTag), false)
  }
  await verify(true)
  const published = await request(releaseUrl, 'PATCH', { draft: false })
  assertRelease(published, false)
  await verify(false)
  return {
    release_url: `https://github.com/${repository}/releases/tag/${tag}`,
    manifest_url: `https://github.com/${repository}/releases/download/${tag}/release.json`,
  }
}

/** Read only workflow-provided credentials and write outputs after full verification. */
async function main() {
  assert(process.argv.length <= 3, 'Expected only the release assets directory')
  assert(process.env.GITHUB_OUTPUT, 'GITHUB_OUTPUT is required')
  const result = await publishForkRelease({
    repository: process.env.GITHUB_REPOSITORY,
    sourceSha: process.env.SOURCE_SHA,
    tag: process.env.RELEASE_TAG,
    version: process.env.RELEASE_VERSION,
    assetsDirectory: resolve(process.argv[2] ?? 'release-assets'),
    token: process.env.GH_TOKEN,
  })
  await appendFile(process.env.GITHUB_OUTPUT, `release_url=${result.release_url}\nmanifest_url=${result.manifest_url}\n`)
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) await main()
