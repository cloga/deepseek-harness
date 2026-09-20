/** Controlled GitHub-only artifact publication. Plain Node; no package manager or lifecycle execution. */
import { createHash } from 'node:crypto'
import { appendFileSync, lstatSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { setTimeout } from 'node:timers/promises'
import { verifyEvidence, verifyTag, verifyTagProtection } from './github-artifacts-evidence.ts'

const REPOSITORY = 'cloga/deepseek-harness'
const VERSION = '0.1.6-alpha.4'
const SHA = /^[a-f0-9]{40}$/u
const ID = /^[1-9][0-9]*$/u
const BASENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u
const MANIFEST = 'release-manifest.json'
const SUMS = 'SHA256SUMS'

/** Operator selectors are checked against GitHub facts, never treated as evidence. */
export interface Selection {
  repository: string
  event: string
  publish: string
  ref: string
  source: string
  version: string
  reviewedHead: string
  mergedCommit: string
  ciRun: string
  policyRun: string
  run: string
  attempt: string
}
interface Asset { name: string; size: number; sha256: string }
interface Manifest { schema: number; selection: Selection; tree: string; tarballs: string[]; assets: Asset[] }
interface RemoteAsset { id: number; name: string; size: number; digest: string; state: string }
interface Release { id: number; tag_name: string; draft: boolean; prerelease: boolean; immutable?: boolean }

/** Reject invalid or unapproved dispatch inputs before any build or API operation.
 * @param selection - Exact Actions context and manually supplied selectors.
 */
export function assertDispatch(selection: Selection): void {
  if (selection.repository !== REPOSITORY || selection.event !== 'workflow_dispatch' || selection.publish !== 'true'
    || selection.version !== VERSION || selection.ref !== `refs/tags/dsh-v${selection.version}`
    || !SHA.test(selection.source) || !SHA.test(selection.reviewedHead)
    || selection.mergedCommit !== selection.source || selection.attempt !== '1'
    || ![selection.ciRun, selection.policyRun, selection.run].every(value => ID.test(value))
    || new Set([selection.ciRun, selection.policyRun, selection.run]).size !== 3) {
    throw new Error('Release dispatch selectors rejected; use the approved existing tag and a new first-attempt run')
  }
}

/** Read workflow selectors without reading any credential.
 * @param env - Actions environment, or an isolated test environment.
 * @returns Validated selector values.
 */
export function selectionFromEnvironment(env: NodeJS.ProcessEnv): Selection {
  const selection = {
    repository: env.GITHUB_REPOSITORY ?? '', event: env.GITHUB_EVENT_NAME ?? '', publish: env.RELEASE_PUBLISH ?? '',
    ref: env.GITHUB_REF ?? '', source: env.GITHUB_SHA ?? '', version: env.RELEASE_VERSION ?? '',
    reviewedHead: env.RELEASE_REVIEWED_HEAD ?? '', mergedCommit: env.RELEASE_MERGED_COMMIT ?? '',
    ciRun: env.RELEASE_CI_RUN ?? '', policyRun: env.RELEASE_POLICY_RUN ?? '',
    run: env.GITHUB_RUN_ID ?? '', attempt: env.GITHUB_RUN_ATTEMPT ?? '',
  }
  assertDispatch(selection)
  return selection
}

function digest(bytes: Uint8Array): string { return createHash('sha256').update(bytes).digest('hex') }
function safeNames(names: string[]): void {
  if (names.length === 0 || names.some(name => !BASENAME.test(name) || name.includes('..'))
    || new Set(names.map(name => name.toLowerCase())).size !== names.length) throw new Error('Unsafe or duplicate artifact basenames')
}
function files(directory: string, expected: string[]): void {
  safeNames(expected)
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error('Artifact directory must be real')
  const actual = readdirSync(directory).sort()
  if (JSON.stringify(actual) !== JSON.stringify([...expected].sort())) throw new Error('Missing or unexpected artifact files')
  for (const name of actual) {
    const stat = lstatSync(join(directory, name))
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Artifact links and non-files are forbidden')
  }
}
function asset(directory: string, name: string): Asset {
  const bytes = readFileSync(join(directory, name))
  return { name, size: bytes.length, sha256: digest(bytes) }
}
function checksums(assets: Asset[]): string {
  return [...assets].sort((left, right) => left.name.localeCompare(right.name, 'en')).map(item => `${item.sha256}  ${item.name}\n`).join('')
}

/** Seal a strictly validated family only after the workflow's packed-install check succeeds.
 * @param directory - Flat original pack output; no previous seal may exist.
 * @param selection - Same-run source selectors.
 * @param tree - Full Git tree verified against the checkout.
 * @param tarballs - Exact official family's canonical publish order.
 */
export function sealDirectory(directory: string, selection: Selection, tree: string, tarballs: string[]): void {
  assertDispatch(selection)
  if (!SHA.test(tree) || tarballs.some(name => !name.endsWith('.tgz'))) throw new Error('Invalid artifact tree or tarball set')
  files(directory, [...tarballs, 'publish-order.txt'])
  if (readFileSync(join(directory, 'publish-order.txt'), 'utf8') !== `${tarballs.join('\n')}\n`) throw new Error('Publish order differs from the official family')
  const assets = [...tarballs, 'publish-order.txt'].map(name => asset(directory, name))
  const manifest: Manifest = { schema: 1, selection, tree, tarballs, assets }
  writeFileSync(join(directory, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' })
  writeFileSync(join(directory, SUMS), checksums([...assets, asset(directory, MANIFEST)]), { flag: 'wx' })
}

/** Revalidate downloaded original files against the source-bound same-run seal.
 * @param directory - Downloaded artifact directory.
 * @param selection - Current workflow selectors.
 * @returns Validated metadata, with no executable paths or URLs from the artifact.
 */
export function verifyDirectory(directory: string, selection: Selection): Manifest {
  assertDispatch(selection)
  const manifest = JSON.parse(readFileSync(join(directory, MANIFEST), 'utf8')) as Manifest
  if (manifest.schema !== 1 || !SHA.test(manifest.tree)
    || JSON.stringify(manifest.selection) !== JSON.stringify(selection)
    || !Array.isArray(manifest.tarballs) || !Array.isArray(manifest.assets)
    || manifest.tarballs.some(name => typeof name !== 'string' || !name.endsWith('.tgz'))) throw new Error('Artifact source/run metadata rejected')
  files(directory, [...manifest.tarballs, 'publish-order.txt', MANIFEST, SUMS])
  const actual = [...manifest.tarballs, 'publish-order.txt'].map(name => asset(directory, name))
  if (JSON.stringify(actual) !== JSON.stringify(manifest.assets)
    || readFileSync(join(directory, 'publish-order.txt'), 'utf8') !== `${manifest.tarballs.join('\n')}\n`
    || readFileSync(join(directory, SUMS), 'utf8') !== checksums([...actual, asset(directory, MANIFEST)])) throw new Error('Artifact bytes or publish order changed')
  return manifest
}

/** Recover the final checkout SHA only from the successful checkout step's bounded log interval.
 * @param logs - Job log fetched from GitHub's job-log endpoint.
 * @param step - GitHub's checkout step timestamps.
 * @returns The unambiguous git log result; absence or ambiguity fails closed.
 */
export function checkoutCommit(logs: string, step: { started_at: string; completed_at: string }): string {
  const start = Date.parse(step.started_at)
  const end = Date.parse(step.completed_at)
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error('Checkout timing evidence unavailable')
  const lines = logs.split(/\r?\n/u).flatMap((line) => {
    const match = /^(\S+) (.*)$/u.exec(line)
    if (!match || match[1] === undefined || match[2] === undefined) return []
    const time = Date.parse(match[1])
    // Job-step API timestamps have second precision; logs have fractions.
    return time >= start && time < end + 1000 ? [match[2]] : []
  })
  const starts = lines.flatMap((line, index) => line === '##[group]Run actions/checkout@v6' ? [index] : [])
  const first = starts[0]
  if (starts.length !== 1 || first === undefined) throw new Error('Known checkout log group unavailable')
  const nextStep = lines.findIndex((line, index) => index > first && /^##\[group\](?:Run |Post )/u.test(line))
  const checkout = lines.slice(first, nextStep === -1 ? undefined : nextStep)
  if (!checkout.includes(`Syncing repository: ${REPOSITORY}`)) throw new Error('Checkout repository evidence differs')
  const results: string[] = []
  for (const [index, line] of checkout.entries()) {
    const next = checkout[index + 1]
    if (/^\[command\](?:.*(?:\/|\\))?git(?:\.exe)?["']? log -1 --format=%H$/u.test(line)
      && next !== undefined && SHA.test(next)) results.push(next)
  }
  const result = results[0]
  if (results.length !== 1 || result === undefined) throw new Error('Actual tested checkout SHA unavailable or ambiguous; Actions head_sha is not a substitute')
  return result
}

/** GitHub HTTP with bounded reads, explicit redirects, serial rate-limited writes, and no retries. */
export class GitHub {
  private readonly token: string
  private readonly fetcher: typeof fetch
  private readonly wait: (ms: number) => Promise<unknown>
  constructor(token: string, fetcher: typeof fetch = fetch, wait: (ms: number) => Promise<unknown> = setTimeout) {
    if (!token) throw new Error('Workflow token unavailable')
    this.token = token
    this.fetcher = fetcher
    this.wait = wait
  }

  private async response(path: string, method: string, body?: string | Buffer, binary = false): Promise<Response> {
    if (!path.startsWith('/') || path.startsWith('//') || /[\r\n#]/u.test(path)) throw new Error('Invalid GitHub API path')
    const upload = path.startsWith('/upload/')
    const url = path === '/graphql' ? 'https://api.github.com/graphql' : upload
      ? `https://uploads.github.com/repos/${REPOSITORY}${path.slice('/upload'.length)}`
      : `https://api.github.com/repos/${REPOSITORY}${path === '/repository' ? '' : path}`
    if (method !== 'GET') await this.wait(1000)
    let response: Response
    try {
      response = await this.fetcher(url, { method, redirect: 'manual', signal: AbortSignal.timeout(60_000),
        headers: { authorization: `Bearer ${this.token}`, accept: binary ? 'application/octet-stream' : 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28', ...(body === undefined ? {} : { 'content-type': upload ? 'application/octet-stream' : 'application/json' }) },
        ...(body === undefined ? {} : { body: typeof body === 'string' ? body : new Uint8Array(body) }) })
    } catch {
      throw new Error(method === 'GET' ? 'GitHub read failed' : 'GitHub write outcome uncertain; reconcile the journal and remote release before recovery')
    }
    return response
  }

  /** Read JSON or perform one mutation; never retry a POST/PATCH.
   * @param path - Repository-relative API path.
   * @param method - GET, POST, or PATCH.
   * @param body - Owned JSON or original upload bytes.
   * @returns Decoded API fields, or null for an explicit read-side 404.
   */
  async json<T>(path: string, method = 'GET', body?: object | Buffer): Promise<T | null> {
    if (!['GET', 'POST', 'PATCH'].includes(method)) throw new Error('Unsupported API method')
    const response = await this.response(path, method, Buffer.isBuffer(body) ? body : body === undefined ? undefined : JSON.stringify(body))
    if (method === 'GET' && response.status === 404) return null
    const expected = method === 'POST' && path !== '/graphql' ? 201 : 200
    if (response.status !== expected) throw new Error(`GitHub ${method} failed (HTTP ${response.status}); no retry, reconcile any write`)
    try { return JSON.parse(Buffer.from(await boundedBytes(response, 32 * 1024 * 1024)).toString('utf8')) as T }
    catch { throw new Error(`GitHub ${method} response unreadable; reconcile any write`) }
  }

  /** Read logs or remote asset bytes, dropping all authentication before allowlisted redirects.
   * @param path - Repository-relative download endpoint.
   * @returns Bounded bytes fetched with no automatic redirects or retries.
   */
  async bytes(path: string): Promise<Buffer> {
    let response = await this.response(path, 'GET', undefined, true)
    for (let hop = 0; response.status === 302 && hop < 3; hop++) {
      const location = new URL(response.headers.get('location') ?? '')
      if (location.protocol !== 'https:' || location.username || location.password || location.port
        || !(location.hostname === 'release-assets.githubusercontent.com' || location.hostname === 'objects.githubusercontent.com'
          || location.hostname.endsWith('.blob.core.windows.net') || location.hostname.endsWith('.actions.githubusercontent.com'))) throw new Error('GitHub download redirect rejected')
      try { response = await this.fetcher(location.href, { redirect: 'manual', signal: AbortSignal.timeout(60_000) }) }
      catch { throw new Error('GitHub download failed') }
    }
    if (response.status !== 200) throw new Error(`GitHub download failed (HTTP ${response.status})`)
    return Buffer.from(await boundedBytes(response, 512 * 1024 * 1024))
  }

  /** Verify public release visibility with no credentials; only 404 receives bounded read retries.
   * @param tag - Already-validated release tag.
   * @param name - Safe original asset basename.
   * @returns Public download bytes from official GitHub hosts.
   */
  async publicBytes(tag: string, name: string): Promise<Buffer> {
    safeNames([name])
    if (tag !== `dsh-v${VERSION}`) throw new Error('Public tag rejected')
    const source = `https://github.com/${REPOSITORY}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(name)}`
    for (let attempt = 0; attempt < 3; attempt++) {
      let url = source
      let response: Response | undefined
      for (let hop = 0; hop < 4; hop++) {
        try { response = await this.fetcher(url, { redirect: 'manual', signal: AbortSignal.timeout(60_000) }) }
        catch { throw new Error('Unauthenticated public release read failed; publication verification incomplete') }
        if (![301, 302, 303, 307, 308].includes(response.status)) break
        const next = new URL(response.headers.get('location') ?? '', url)
        if (next.protocol !== 'https:' || next.username || next.password || next.port
          || !['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(next.hostname)) throw new Error('Public download redirect rejected')
        url = next.href
      }
      if (response?.status === 404 && attempt < 2) { await this.wait(1000); continue }
      if (response?.status !== 200) throw new Error('Unauthenticated public release visibility unavailable; publication verification incomplete')
      return Buffer.from(await boundedBytes(response, 512 * 1024 * 1024))
    }
    throw new Error('Public release visibility unavailable')
  }

  /** Read every page; never accept a truncated evidence or asset inventory.
   * @param path - Repository-relative collection endpoint, without pagination.
   * @param field - Collection key when the response wraps its array.
   * @returns Every returned row; excessive inventories fail closed.
   */
  async list<T>(path: string, field?: string): Promise<T[]> {
    const result: T[] = []
    for (let page = 1; page <= 100; page++) {
      const value = await this.json<T[] | Record<string, T[]>>(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`)
      const rows = field === undefined ? value : (value as Record<string, T[]> | null)?.[field]
      if (!Array.isArray(rows)) throw new Error('GitHub evidence inventory unavailable')
      result.push(...rows)
      if (rows.length < 100) return result
    }
    throw new Error('GitHub evidence inventory exceeds bounded pagination')
  }
}

async function boundedBytes(response: Response, limit: number): Promise<Uint8Array> {
  if (!response.body) throw new Error('GitHub body missing')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      length += chunk.value.length
      if (length > limit) throw new Error('GitHub body exceeds limit')
      chunks.push(chunk.value)
    }
    return Buffer.concat(chunks)
  } finally { await reader.cancel(); reader.releaseLock() }
}

/** Fail if any existing release (including a draft) owns the tag.
 * @param api - Authenticated GitHub transport.
 * @param tag - Exact already-existing tag.
 */
export async function assertNoRelease(api: GitHub, tag: string): Promise<void> {
  if (await api.json(`/releases/tags/${encodeURIComponent(tag)}`) !== null
    || (await api.list<Release>('/releases')).some(release => release.tag_name === tag)) throw new Error('Existing release or draft; automatic resume is forbidden')
}

/** Publish original, sealed same-run bytes after authoritative evidence succeeds.
 * @param api - GitHub transport, fake in tests.
 * @param selection - Operator selectors to verify.
 * @param directory - Downloaded same-run artifact.
 * @param record - Persist a small, credential-free journal before each write.
 * @param artifactId - Exact immutable artifact ID emitted by this run's pack job.
 * @returns The finalized release ID; uncertainty leaves the draft and journal untouched.
 */
export async function publishArtifacts(
  api: GitHub, selection: Selection, directory: string, record: (entry: object) => void, artifactId: string,
): Promise<number> {
  const manifest = verifyDirectory(directory, selection)
  const tagIdentity = await verifyEvidence(api, selection, manifest.tree, artifactId)
  const names = [...manifest.tarballs, 'publish-order.txt', MANIFEST, SUMS]
  const local = names.map(name => asset(directory, name))
  const tag = `dsh-v${selection.version}`
  // A workflow lock cannot exclude a human writer; GitHub conflicts are terminal.
  await verifyTagProtection(api, selection)
  await verifyTag(api, selection, manifest.tree, tagIdentity)
  await assertNoRelease(api, tag)
  record({ operation: 'create-draft', tag, tagIdentity, source: selection.source, run: selection.run })
  const release = await api.json<Release>('/releases', 'POST', {
    tag_name: tag, target_commitish: selection.source, name: `Core/Web ${selection.version}`, draft: true, prerelease: true, make_latest: 'false',
    body: 'Core/Web dsh-family original npm tarballs. Not an npm publication, Desktop release, or offline installer. Vendored framework, native companions and registry dependencies remain external. See release-manifest.json and SHA256SUMS for source/run and bytes.',
  })
  if (!release || !Number.isSafeInteger(release.id) || release.id <= 0 || !release.draft || !release.prerelease || release.tag_name !== tag) throw new Error('Draft creation response rejected; reconcile before recovery')
  record({ operation: 'draft-created', release: release.id, tagIdentity })
  await verifyTagProtection(api, selection)
  await verifyTag(api, selection, manifest.tree, tagIdentity)
  for (const item of local) {
    const bytes = readFileSync(join(directory, item.name))
    if (bytes.length !== item.size || digest(bytes) !== item.sha256) throw new Error('Local bytes changed before upload')
    record({ operation: 'upload', release: release.id, name: item.name, sha256: item.sha256, size: item.size })
    const uploaded = await api.json<RemoteAsset>(`/upload/releases/${release.id}/assets?name=${encodeURIComponent(item.name)}`, 'POST', bytes)
    if (!uploaded || uploaded.name !== item.name || uploaded.size !== item.size || uploaded.digest !== `sha256:${item.sha256}` || uploaded.state !== 'uploaded') throw new Error('Uploaded asset response differs; draft retained')
  }
  await verifyRemoteAssets(api, release.id, directory, local, true)
  await verifyTagProtection(api, selection)
  await verifyTag(api, selection, manifest.tree, tagIdentity)
  const draft = await api.json<Release>(`/releases/${release.id}`)
  if (!draft?.draft || !draft.prerelease || draft.tag_name !== tag) throw new Error('Draft changed before finalization')
  record({ operation: 'finalize', release: release.id })
  const finalized = await api.json<Release>(`/releases/${release.id}`, 'PATCH', { draft: false, prerelease: true, make_latest: 'false' })
  if (!finalized || finalized.draft || !finalized.prerelease || finalized.tag_name !== tag) throw new Error('Finalization uncertain; reconcile before recovery')
  const readback = await api.json<Release>(`/releases/${release.id}`)
  if (!readback || readback.draft || !readback.prerelease || readback.tag_name !== tag) throw new Error('Final release readback differs')
  // Public downloads below verify final bytes without spending another REST
  // request per asset from the workflow token's repository quota.
  await verifyRemoteAssets(api, release.id, directory, local, false)
  await verifyTagProtection(api, selection)
  await verifyTag(api, selection, manifest.tree, tagIdentity)
  for (const item of local) {
    const bytes = await api.publicBytes(tag, item.name)
    if (bytes.length !== item.size || digest(bytes) !== item.sha256 || !bytes.equals(readFileSync(join(directory, item.name)))) throw new Error('Public asset bytes differ; publication verification incomplete')
  }
  record({ operation: 'verified', release: release.id, publicBytes: true,
    immutable: typeof readback.immutable === 'boolean' ? readback.immutable : null })
  return release.id
}

async function verifyRemoteAssets(
  api: GitHub, release: number, directory: string, expected: Asset[], verifyBytes: boolean,
): Promise<void> {
  const assets = await api.list<RemoteAsset>(`/releases/${release}/assets`)
  if (assets.length !== expected.length || new Set(assets.map(item => item.name)).size !== assets.length) throw new Error('Remote asset inventory differs; draft retained if not finalized')
  for (const item of expected) {
    const remote = assets.find(value => value.name === item.name)
    if (!remote || !Number.isSafeInteger(remote.id) || remote.id <= 0 || remote.size !== item.size
      || remote.digest !== `sha256:${item.sha256}` || remote.state !== 'uploaded') throw new Error('Remote asset metadata differs')
    if (verifyBytes) {
      const bytes = await api.bytes(`/releases/assets/${remote.id}`)
      if (!bytes.equals(readFileSync(join(directory, item.name))) || digest(bytes) !== item.sha256) throw new Error('Remote asset bytes differ')
    }
  }
}

async function main(): Promise<void> {
  const selection = selectionFromEnvironment(process.env)
  if (process.argv[2] === 'guard') return
  const directory = process.argv[3]
  const journalPath = process.argv[4]
  if (process.argv[2] !== 'publish' || process.argv.length !== 5 || directory === undefined || journalPath === undefined) {
    throw new Error('Usage: github-artifacts.ts guard | publish <directory> <journal>')
  }
  const journal = resolve(journalPath)
  writeFileSync(journal, '', { flag: 'wx', mode: 0o600 })
  await publishArtifacts(new GitHub(process.env.GITHUB_TOKEN ?? ''), selection, resolve(directory),
    (entry) => { appendFileSync(journal, `${JSON.stringify(entry)}\n`); console.log(JSON.stringify(entry)) }, process.env.RELEASE_ARTIFACT_ID ?? '')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main() }
  catch { console.error('GitHub artifact publication refused or incomplete. Exact-tag protection and non-bypass facts must be readable; missing facts cannot be overridden. Retain the write journal and inspect the exact tag/release/run before recovery; no automatic retry.'); process.exitCode = 1 }
}
