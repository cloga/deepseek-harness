/** Bounded, data-only acquisition of source packages; no Git preparation or module loading. */

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { lstat, mkdir, mkdtemp, open, realpath, rm, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { pathToFileURL } from 'node:url'
import { createGunzip } from 'node:zlib'
import { valid, validRange } from 'semver'
import { t, x, type ReadEntry } from 'tar'
import type { DesktopPluginInstallSpec } from './plugin-install-spec.ts'

/** Snapshot identity, not verified Release evidence or publisher attestation. */
export interface DesktopSourcePackageArtifact {
  readonly path: string
  readonly packageName: string
  readonly version: string
  readonly sha256: string
  readonly integrity: string
  readonly resolved: string
  readonly commit?: string
}

const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024
const MAX_EXTRACTED_BYTES = 256 * 1024 * 1024
const MAX_ENTRIES = 10_000
const MAX_MANIFEST_BYTES = 1024 * 1024
const GITHUB_HOSTS = new Set(['api.github.com', 'github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u

function fail(message: string): never {
  throw new Error(`desktop plugin source: ${message}`)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function byteLimit(maximum: number, label: string): Transform {
  let size = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      size += chunk.byteLength
      callback(size > maximum ? new Error(`desktop plugin source: ${label} exceeds size limit`) : null, chunk)
    },
  })
}

function safeUrl(input: string, github: boolean): URL {
  if (/[\\\u0000-\u0020\u007f]/u.test(input)) fail('unsafe download URL')
  const url = new URL(input)
  if (url.protocol !== 'https:' || /^https:\/\/[^/]*@/iu.test(input) || url.username !== '' || url.password !== '' || url.port !== '' || url.hash !== '') {
    fail('downloads require HTTPS URLs without credentials, custom ports, or fragments')
  }
  if (github && !GITHUB_HOSTS.has(url.hostname)) fail('GitHub redirect host is not allowlisted')
  return url
}

async function request(url: string, github: boolean, fetcher: typeof fetch): Promise<Response> {
  let next = safeUrl(url, github)
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetcher(next.href, {
      redirect: 'manual',
      credentials: 'omit',
      headers: { Accept: next.hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream' },
      signal: AbortSignal.timeout(60_000),
    })
    if (response.redirected) {
      await response.body?.cancel()
      fail('transport followed an unvalidated redirect')
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location')
      await response.body?.cancel()
      if (location === null) fail('redirect has no Location header')
      if (/[\\\u0000-\u0020\u007f]/u.test(location) || /^https:\/\/[^/]*@/iu.test(location)) fail('unsafe redirect URL')
      next = safeUrl(new URL(location, next).href, github)
      continue
    }
    if (!response.ok) {
      await response.body?.cancel()
      fail(`download failed (HTTP ${response.status})`)
    }
    return response
  }
  return fail('too many download redirects')
}

async function consumeResponse(response: Response, maximum: number, consume: (chunk: Uint8Array) => void | Promise<void>): Promise<void> {
  const length = response.headers.get('content-length')
  if (length !== null && (!/^\d+$/u.test(length) || !Number.isSafeInteger(Number(length)) || Number(length) > maximum)) {
    await response.body?.cancel()
    fail('download Content-Length exceeds size limit or is invalid')
  }
  if (response.body === null) fail('download response has no body')
  const reader = response.body.getReader()
  let complete = false
  let size = 0
  try {
    for (;;) {
      const chunk = await reader.read()
      if (chunk.done) break
      size += chunk.value.byteLength
      if (size > maximum) fail('download exceeds size limit')
      await consume(chunk.value)
    }
    if (length !== null && size !== Number(length)) fail('download size does not match Content-Length')
    complete = true
  } finally {
    try {
      if (!complete) await reader.cancel()
    } finally {
      reader.releaseLock()
    }
  }
}

async function download(url: string, destination: string, github: boolean, fetcher: typeof fetch): Promise<void> {
  const file = await open(destination, 'wx', 0o600)
  try {
    const response = await request(url, github, fetcher)
    await consumeResponse(response, MAX_ARCHIVE_BYTES, async (chunk) => {
      // FileHandle.write may write fewer bytes than requested.
      let offset = 0
      while (offset < chunk.byteLength) {
        const { bytesWritten } = await file.write(chunk, offset, chunk.byteLength - offset)
        if (bytesWritten === 0) fail('download file write made no progress')
        offset += bytesWritten
      }
    })
  } finally {
    await file.close()
  }
}

async function snapshot(source: string, destination: string): Promise<void> {
  const file = await open(source, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) fail('local archive is not a regular file')
    if (metadata.size > MAX_ARCHIVE_BYTES) fail('compressed archive exceeds size limit')
    await pipeline(file.createReadStream({ autoClose: false }), byteLimit(MAX_ARCHIVE_BYTES, 'compressed archive'), createWriteStream(destination, { flags: 'wx', mode: 0o600 }))
  } finally {
    await file.close()
  }
}

function archivePath(path: string): string {
  const normalized = path.endsWith('/') ? path.slice(0, -1) : path
  if (normalized === '' || normalized.includes('\\') || normalized.startsWith('/') || /[\u0000-\u001f\u007f]/u.test(normalized)
    || normalized.split('/').some(part => part === '' || part === '.' || part === '..' || /[:*?"<>|]/u.test(part)
      || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part))) {
    fail(`unsafe archive path ${JSON.stringify(path)}`)
  }
  return normalized
}

async function extractArchive(archive: string, directory: string, npm: boolean): Promise<void> {
  const metadata = await lstat(archive)
  if (!metadata.isFile() || metadata.size > MAX_ARCHIVE_BYTES) fail('invalid or oversized compressed archive')
  const paths = new Map<string, string>()
  const entries = new Set<string>()
  const roots = new Set<string>()
  let count = 0
  let size = 0
  let manifests = 0
  let invalid: Error | undefined
  const parser = t({
    strict: true,
    onReadEntry(entry: ReadEntry) {
      if (invalid !== undefined) return
      try {
        if (++count > MAX_ENTRIES) fail('archive exceeds entry limit')
        // ReadEntry normalizes backslashes on Windows; inspect the original header as well.
        archivePath(entry.header.path ?? entry.path)
        const path = archivePath(entry.path)
        if (entry.type !== 'File' && entry.type !== 'Directory') fail(`archive links and special entries are forbidden: ${path}`)
        if (!Number.isSafeInteger(entry.size) || entry.size < 0 || (entry.type === 'Directory' && entry.size !== 0)) fail('invalid archive entry size')
        size += entry.size
        if (size > MAX_EXTRACTED_BYTES) fail('extracted archive exceeds size limit')
        if (entries.has(path.toLowerCase())) fail(`duplicate archive path: ${path}`)
        entries.add(path.toLowerCase())
        const parts = path.split('/')
        for (let i = 1; i <= parts.length; i++) {
          const prefix = parts.slice(0, i).join('/')
          const previous = paths.get(prefix.toLowerCase())
          if (previous !== undefined && previous !== prefix) fail(`case-collision archive path: ${path}`)
          paths.set(prefix.toLowerCase(), prefix)
        }
        const root = parts[0]
        if (root === undefined) fail('archive path has no root')
        roots.add(root)
        if (roots.size !== 1 || (npm && parts[0] !== 'package')) fail('archive must have exactly one top-level root' + (npm ? ' named package' : ''))
        if (parts.length === 1 && entry.type !== 'Directory') fail('archive top-level root must be a directory')
        if (parts.length === 2 && parts[1] === 'package.json' && entry.type === 'File') {
          if (entry.size > MAX_MANIFEST_BYTES) fail('package.json exceeds size limit')
          manifests++
        }
      } catch (error) {
        invalid = error instanceof Error ? error : new Error('desktop plugin source: invalid archive')
        parser.abort(invalid)
      }
    },
  })
  parser.on('ignoredEntry', () => {
    invalid = new Error('desktop plugin source: ignored archive entries are forbidden')
    parser.abort(invalid)
  })
  parser.on('meta', () => {
    if (++count > MAX_ENTRIES) {
      invalid = new Error('desktop plugin source: archive exceeds entry limit')
      parser.abort(invalid)
    }
  })
  // Bound decompressed headers/PAX data too, not only the file sizes declared in headers.
  await pipeline(createReadStream(archive), createGunzip(), byteLimit(MAX_EXTRACTED_BYTES + 16 * 1024 * 1024, 'expanded tar stream'), parser)
  if (invalid !== undefined) throw invalid
  if (manifests !== 1) fail('archive must contain exactly one root package.json')
  await mkdir(directory, { mode: 0o700 })
  await x({ file: archive, cwd: directory, strip: 1, strict: true, preservePaths: false })
}

function inside(root: string, target: string): boolean {
  const path = relative(root, target)
  return path === '' || (!isAbsolute(path) && path !== '..' && !path.startsWith(`..${sep}`))
}

async function requiredFile(root: string, input: unknown, field: string): Promise<string> {
  if (typeof input !== 'string' || input === '') fail(`${field} must name an in-package file`)
  const path = input.startsWith('./') ? input.slice(2) : input
  archivePath(path)
  const target = resolve(root, path)
  if (!inside(root, target)) fail(`${field} points outside the package`)
  let actual: string
  try {
    actual = await realpath(target)
  } catch (error) {
    if (isRecord(error) && error.code === 'ENOENT') fail(`missing prebuilt output ${input} (${field}); build the plugin before installing; Desktop does not run builds`)
    throw error
  }
  if (!inside(root, actual)) fail(`${field} symlink escapes the package`)
  if (!(await stat(actual)).isFile()) fail(`${field} must be a regular file`)
  return actual
}

function exportTarget(value: unknown, client: boolean): string | null | undefined {
  if (typeof value === 'string') return value
  if (value === null) return null
  if (Array.isArray(value)) {
    for (const option of value) {
      const target = exportTarget(option, client)
      if (typeof target === 'string') return target
    }
    return null
  }
  if (!isRecord(value)) fail('invalid package exports target')
  const conditions = new Set(client ? ['browser', 'import', 'default'] : ['node', 'import', 'default'])
  for (const [condition, target] of Object.entries(value)) {
    if (!conditions.has(condition)) continue
    const selected = exportTarget(target, client)
    if (selected !== undefined) return selected
  }
  return undefined
}

function validateSourceDependencies(manifest: Record<string, unknown>): void {
  for (const field of ['bundledDependencies', 'bundleDependencies']) {
    const bundled = manifest[field]
    if (bundled !== undefined && bundled !== false && !(Array.isArray(bundled) && bundled.length === 0)) {
      fail(`source packages must not declare bundled dependencies in ${field}; publish dependencies to a registry and declare registry versions instead`)
    }
  }
  for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    const dependencies = manifest[field]
    if (dependencies === undefined) continue
    if (!isRecord(dependencies)) fail(`${field} must be a package-name map`)
    for (const [name, selector] of Object.entries(dependencies)) {
      if (name.length > 214 || !PACKAGE_NAME.test(name)) fail(`invalid package name in ${field}: ${JSON.stringify(name)}`)
      const isPeer = field === 'peerDependencies'
      if (typeof selector !== 'string' || selector.trim() === '' || /[\u0000-\u001f\u007f-\u009f]/u.test(selector)
        || (validRange(selector) === null && (isPeer || !/^[A-Za-z][A-Za-z0-9._-]*$/u.test(selector)))) {
        fail(`${field}.${name} must use ${isPeer ? 'a semver range' : 'a registry version, dist tag, or semver range'}; source packages do not support file, link, Git, URL, workspace, or npm-alias dependencies`)
      }
    }
  }
}

function validateSourceScripts(manifest: Record<string, unknown>): void {
  if (manifest.scripts === undefined) return
  if (!isRecord(manifest.scripts)) fail('scripts must be a script-name map')
  for (const hook of ['preinstall', 'install', 'postinstall']) {
    if (Object.hasOwn(manifest.scripts, hook)) {
      fail(`source packages must not declare ${hook} lifecycle scripts; provide prebuilt output without install hooks; Desktop does not support compile-on-install source packages`)
    }
  }
  if (Object.values(manifest.scripts).some(script => typeof script !== 'string')) fail('scripts must contain string commands')
}

async function rejectImplicitSourceBuild(root: string): Promise<void> {
  try {
    await lstat(join(root, 'binding.gyp'))
  } catch (error) {
    if (!isRecord(error) || error.code !== 'ENOENT') throw error
    // No binding.gyp means pnpm cannot infer this root's default node-gyp install hook.
    return
  }
  fail('source packages must not include root binding.gyp; provide prebuilt output without implicit native install builds')
}

async function validateDeclaredClient(root: string, manifest: Record<string, unknown>): Promise<boolean> {
  const client = isRecord(manifest.dsh) ? manifest.dsh.client : undefined
  if (client === undefined) return false
  if (!isRecord(client) || typeof client.platform !== 'string') fail('dsh.client must declare a string platform')
  if (client.platform !== 'web') return false
  const entry = isRecord(manifest.exports) ? manifest.exports['./client'] : undefined
  // client-modules/src/index.ts clientExportOf reads a string or one-level default, not browser/import conditions.
  const target = typeof entry === 'string' ? entry : isRecord(entry) && typeof entry.default === 'string' ? entry.default : undefined
  if (target === undefined) fail('dsh.client declares web output but exports["./client"] must be a string or an object with a string default')
  await requiredFile(root, target, 'dsh.client exports ./client')
  return true
}

async function validatePackDirectory(root: string, manifest: Record<string, unknown>): Promise<void> {
  const config = manifest.publishConfig
  if (config === undefined) return
  if (!isRecord(config)) fail('publishConfig must be an object')
  if (config.directory === undefined) return
  if (typeof config.directory !== 'string' || config.directory === '') fail('publishConfig.directory must name an in-package directory')
  const target = resolve(root, config.directory)
  if (!inside(root, target) || !inside(root, await realpath(target)) || !(await stat(target)).isDirectory()) {
    fail('publishConfig.directory must remain inside the selected source directory')
  }
}

async function validateManifest(directory: string, packing = false): Promise<{ packageName: string; version: string }> {
  const root = await realpath(directory)
  const manifestPath = await requiredFile(root, 'package.json', 'package manifest')
  const chunks: Buffer[] = []
  let bytes = 0
  const file = await open(manifestPath, 'r')
  try {
    const metadata = await file.stat()
    if (!metadata.isFile()) fail('package.json must be a regular file')
    if (metadata.size > MAX_MANIFEST_BYTES) fail('package.json exceeds size limit')
    // No encoding is configured, so Node's stream iterator yields Buffer chunks.
    for await (const buffer of file.createReadStream({ autoClose: false }) as AsyncIterable<Buffer>) {
      bytes += buffer.byteLength
      if (bytes > MAX_MANIFEST_BYTES) fail('package.json exceeds size limit')
      chunks.push(buffer)
    }
  } finally {
    await file.close()
  }
  const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
  if (!isRecord(value) || typeof value.name !== 'string' || value.name.length > 214 || !PACKAGE_NAME.test(value.name)) fail('invalid package name')
  if (typeof value.version !== 'string' || valid(value.version) !== value.version) fail('package version must be exact semver')
  if (packing) await validatePackDirectory(root, value)
  validateSourceScripts(value)
  validateSourceDependencies(value)
  await rejectImplicitSourceBuild(root)
  const declaredClient = await validateDeclaredClient(root, value)
  const dsh = value.dsh
  const bundle = isRecord(dsh) ? dsh.bundle : undefined
  await requiredFile(root, isRecord(bundle) ? bundle.patch : undefined, 'dsh.bundle.patch')
  if (value.main !== undefined) await requiredFile(root, value.main, 'main')
  if (value.exports !== undefined && value.exports !== null) {
    const map = value.exports
    const subpaths = isRecord(map) && Object.keys(map).some(key => key.startsWith('.'))
    for (const key of ['.', './client']) {
      if (key === './client' && declaredClient) continue
      const entry = subpaths ? map[key] : key === '.' ? map : undefined
      if (entry === undefined || entry === null) continue
      const target = exportTarget(entry, key === './client')
      if (target === undefined || target === null) fail(`exports ${key} has no supported import/default target`)
      if (!target.startsWith('./')) fail(`exports ${key} must use an in-package ./ path`)
      await requiredFile(root, target, `exports ${key}`)
    }
  }
  return { packageName: value.name, version: value.version }
}

/**
 * Stage a prebuilt npm archive without executing source code or package preparation.
 * Source-root install hooks, binding.gyp, bundled dependencies, and non-registry direct dependencies are unsupported.
 * Peer dependencies require semver ranges.
 * This acquisition check does not authorize builds or validate the subsequently resolved transitive dependency graph.
 * @param input - Parsed non-registry install request.
 * @param stagingDir - Private transaction-owned directory; caller owns successful artifacts and cleanup.
 * @param packDirectory - Lifecycle/hook-disabled pack operation supplied by the transaction owner.
 * @param fetcher - Credential-free transport, injectable for offline tests.
 * @returns Validated package identity and immutable hashes; GitHub sources include a full resolved commit.
 */
export async function acquireDesktopSourcePackage(
  input: Exclude<DesktopPluginInstallSpec, { kind: 'registry' }>,
  stagingDir: string,
  packDirectory: (directory: string, archivePath: string) => Promise<void>,
  fetcher: typeof fetch = fetch,
): Promise<DesktopSourcePackageArtifact> {
  await mkdir(stagingDir, { recursive: true, mode: 0o700 })
  const work = await mkdtemp(join(stagingDir, 'source-'))
  try {
    const artifact = join(work, 'package.tgz')
    let resolved: string
    let commit: string | undefined
    let expected: { packageName: string; version: string } | undefined
    switch (input.kind) {
      case 'directory': {
        const source = await realpath(input.path)
        if (inside(source, await realpath(work))) fail('staging directory must not be inside the source directory')
        expected = await validateManifest(source, true)
        await packDirectory(source, join(work, 'packed.tgz'))
        await snapshot(join(work, 'packed.tgz'), artifact)
        resolved = pathToFileURL(source).href
        break
      }
      case 'tarball':
        await snapshot(input.path, artifact)
        resolved = pathToFileURL(resolve(input.path)).href
        break
      case 'remoteTarball':
        await download(input.url, artifact, false, fetcher)
        resolved = safeUrl(input.url, false).href
        break
      case 'github': {
        const base = `https://api.github.com/repos/${encodeURIComponent(input.owner)}/${encodeURIComponent(input.repo)}`
        const response = await request(`${base}/commits/${encodeURIComponent(input.ref ?? 'HEAD')}`, true, fetcher)
        const chunks: Buffer[] = []
        await consumeResponse(response, MAX_MANIFEST_BYTES, (chunk) => { chunks.push(Buffer.from(chunk)) })
        const data: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        if (!isRecord(data) || typeof data.sha !== 'string' || !/^[a-fA-F0-9]{40}$/u.test(data.sha)) fail('GitHub ref did not resolve to a full 40-hex commit SHA')
        commit = data.sha.toLowerCase()
        if (input.ref !== undefined && /^[a-fA-F0-9]{40}$/u.test(input.ref) && input.ref.toLowerCase() !== commit) {
          fail('GitHub resolved a different commit than the requested full SHA')
        }
        resolved = `https://github.com/${input.owner}/${input.repo}/archive/${commit}.tar.gz`
        const sourceArchive = join(work, 'github.tgz')
        await download(`${base}/tarball/${commit}`, sourceArchive, true, fetcher)
        const source = join(work, 'repository')
        await extractArchive(sourceArchive, source, false)
        expected = await validateManifest(source, true)
        await packDirectory(source, join(work, 'packed.tgz'))
        await snapshot(join(work, 'packed.tgz'), artifact)
        break
      }
      default: {
        const unhandled: never = input
        return unhandled
      }
    }
    const unpacked = join(work, 'package')
    await extractArchive(artifact, unpacked, true)
    const identity = await validateManifest(unpacked)
    if (expected !== undefined && (expected.packageName !== identity.packageName || expected.version !== identity.version)) fail('packed package name or version changed from the source manifest')
    const sha256 = createHash('sha256')
    const sha512 = createHash('sha512')
    // The archive stream has no text encoding; hash its Buffer chunks without decoding.
    for await (const chunk of createReadStream(artifact) as AsyncIterable<Buffer>) {
      sha256.update(chunk)
      sha512.update(chunk)
    }
    return { path: artifact, ...identity, sha256: sha256.digest('hex'), integrity: `sha512-${sha512.digest('base64')}`, resolved, ...(commit === undefined ? {} : { commit }) }
  } catch (error) {
    await rm(work, { recursive: true, force: true })
    throw error
  }
}
