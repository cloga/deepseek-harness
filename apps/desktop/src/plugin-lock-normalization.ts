/** Normalize only receipt-backed artifact separator differences before a staged frozen pnpm install. */

import { createHash } from 'node:crypto'
import {
  closeSync, fstatSync, lstatSync, mkdtempSync, openSync, readSync,
  renameSync, rmSync, writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import { valid } from 'semver'

/** Caller-validated manifest entry backed by a source lock or verified Release receipt. */
export interface DesktopArtifactSpecifier {
  readonly name: string
  readonly specifier: string
  readonly sha256: string
  /** Verified Release package version; requires the locked root resolution to match the receipt and bytes. */
  readonly verifiedVersion?: string
}

const MAX_LOCK_BYTES = 16 * 1024 * 1024
const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
const ARTIFACT_SPECIFIER = /^file:\.desktop-plugin-artifacts\/([a-f0-9]{64})\.tgz$/u
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u

function fail(message: string): never {
  throw new Error(`desktop plugin lock: ${message}`)
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function missing(error: unknown): boolean {
  return record(error) && error.code === 'ENOENT'
}

function requireDirectory(path: string): void {
  const stat = lstatSync(path)
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail(`expected an unlinked directory: ${path}`)
}

function consumeRegularFile(path: string, maximum: number, consume: (chunk: Buffer) => void): void {
  const before = lstatSync(path)
  if (!before.isFile() || before.isSymbolicLink()) fail(`expected an unlinked regular file: ${path}`)
  const descriptor = openSync(path, 'r')
  try {
    const opened = fstatSync(descriptor)
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) fail(`file changed while opening: ${path}`)
    if (opened.size > maximum) fail(`file exceeds ${String(maximum)} byte limit: ${path}`)
    const buffer = Buffer.alloc(64 * 1024)
    let total = 0
    for (;;) {
      const size = readSync(descriptor, buffer, 0, buffer.byteLength, null)
      if (size === 0) break
      total += size
      if (total > maximum) fail(`file exceeds ${String(maximum)} byte limit: ${path}`)
      consume(buffer.subarray(0, size))
    }
  } finally {
    closeSync(descriptor)
  }
}

function validateArtifacts(artifacts: readonly DesktopArtifactSpecifier[]): void {
  const names = new Set<string>()
  for (const artifact of artifacts) {
    if (artifact.name.length > 214 || !PACKAGE_NAME.test(artifact.name)
      || !/^[a-f0-9]{64}$/u.test(artifact.sha256)
      || ARTIFACT_SPECIFIER.exec(artifact.specifier)?.[1] !== artifact.sha256
      || (artifact.verifiedVersion !== undefined && valid(artifact.verifiedVersion) !== artifact.verifiedVersion)) {
      fail('artifact metadata requires a package name and canonical file:.desktop-plugin-artifacts/<sha256>.tgz matching its SHA-256')
    }
    if (names.has(artifact.name)) fail(`duplicate artifact metadata for ${artifact.name}`)
    names.add(artifact.name)
  }
}

function verifyArtifacts(profile: string, artifacts: readonly DesktopArtifactSpecifier[]): ReadonlyMap<string, string> {
  const integrities = new Map<string, string>()
  if (artifacts.length === 0) return integrities
  requireDirectory(join(profile, '.desktop-plugin-artifacts'))
  for (const artifact of artifacts) {
    const hash = createHash('sha256')
    const integrity = createHash('sha512')
    consumeRegularFile(join(profile, '.desktop-plugin-artifacts', `${artifact.sha256}.tgz`), MAX_ARTIFACT_BYTES,
      (chunk) => { hash.update(chunk); integrity.update(chunk) })
    if (hash.digest('hex') !== artifact.sha256) fail(`snapshot SHA-256 mismatch for ${artifact.name}`)
    integrities.set(artifact.name, `sha512-${integrity.digest('base64')}`)
  }
  return integrities
}

function matchesArtifactReference(value: unknown, specifier: string, peers: boolean): boolean {
  if (typeof value !== 'string') return false
  const normalized = value.replaceAll('\\', '/')
  return normalized === specifier || (peers && normalized.startsWith(`${specifier}(`) && normalized.endsWith(')'))
}

function verifyReleaseResolution(
  lock: Record<string, unknown>,
  entry: Record<string, unknown>,
  artifact: DesktopArtifactSpecifier,
  integrity: string | undefined,
): void {
  if (artifact.verifiedVersion === undefined) return
  const prefix = `${artifact.name}@`
  const candidates = record(lock.packages) ? Object.entries(lock.packages).filter(([key]) => (
    key.startsWith(prefix) && matchesArtifactReference(key.slice(prefix.length), artifact.specifier, true)
  )) : []
  if (!matchesArtifactReference(entry.version, artifact.specifier, true)) {
    fail('inconsistent verified-artifact lock identity: locked reference')
  }
  const locked = candidates.length === 1 ? candidates[0]?.[1] : undefined
  if (!record(locked)) fail('inconsistent verified-artifact lock identity: package key')
  if (locked.version !== artifact.verifiedVersion) fail('inconsistent verified-artifact lock identity: package version')
  const resolution = locked.resolution
  if (!record(resolution) || !matchesArtifactReference(resolution.tarball, artifact.specifier, false)) {
    fail('inconsistent verified-artifact lock identity: tarball reference')
  }
  if (integrity === undefined || resolution.integrity !== integrity) {
    fail(`verified-artifact lock integrity mismatch for ${artifact.name}`)
  }
}

/**
 * Repair only backslash separators in owned artifact importer specifiers before a frozen install.
 * @param profile Private staging profile exclusively owned by the caller; never an active profile.
 * @param artifacts Exact canonical manifest matches already tied to validated source locks or verified Release receipts.
 * @returns Whether the lockfile changed. Absent locks, unknown schemas, and multiple importers remain byte-identical.
 * Throws on invalid candidate metadata, unsafe files, missing or corrupt artifact bytes, or malformed YAML.
 * All artifacts are verified before writing; resolutions, integrity, versions, and package.json are never changed.
 * Verified Release candidates additionally require the receipt's package version, canonical tarball and byte-derived SHA-512.
 */
export function normalizeDesktopArtifactSpecifiers(profile: string, artifacts: readonly DesktopArtifactSpecifier[]): boolean {
  validateArtifacts(artifacts)
  requireDirectory(profile)
  const lockPath = join(profile, 'pnpm-lock.yaml')
  const chunks: Buffer[] = []
  try {
    consumeRegularFile(lockPath, MAX_LOCK_BYTES, (chunk) => { chunks.push(Buffer.from(chunk)) })
  } catch (error) {
    if (missing(error)) return false
    throw error
  }
  const original = Buffer.concat(chunks)
  const text = original.toString('utf8')
  if (!Buffer.from(text, 'utf8').equals(original)) fail('pnpm-lock.yaml must contain valid UTF-8; refusing normalization')
  let parsed: unknown
  try {
    parsed = load(text, { schema: JSON_SCHEMA })
  } catch (error) {
    throw new Error('desktop plugin lock: malformed pnpm-lock.yaml; refusing normalization', { cause: error })
  }
  if (!record(parsed) || (parsed.lockfileVersion !== '9.0' && parsed.lockfileVersion !== 9) || !record(parsed.importers)) return false
  const importers = Object.entries(parsed.importers)
  if (importers.length !== 1) return false
  const sole = importers[0]
  if (sole === undefined) return false
  const [key, importer] = sole
  if (!record(importer) || !record(importer.dependencies)) return false
  const integrities = verifyArtifacts(profile, artifacts)
  const dependencies = { ...importer.dependencies }
  let changed = false
  for (const artifact of artifacts) {
    if (!Object.hasOwn(dependencies, artifact.name)) continue
    const entry = dependencies[artifact.name]
    if (!record(entry) || typeof entry.specifier !== 'string' || entry.specifier === artifact.specifier
      || entry.specifier.replaceAll('\\', '/') !== artifact.specifier) continue
    verifyReleaseResolution(parsed, entry, artifact, integrities.get(artifact.name))
    // Copy the entry instead of mutating a YAML alias also referenced by a resolution or another dependency.
    dependencies[artifact.name] = { ...entry, specifier: artifact.specifier }
    changed = true
  }
  if (!changed) return false
  const normalized = { ...parsed, importers: { ...parsed.importers, [key]: { ...importer, dependencies } } }
  const serialized = dump(normalized, { schema: JSON_SCHEMA, lineWidth: -1, noCompatMode: true })
  if (Buffer.byteLength(serialized) > MAX_LOCK_BYTES) fail('normalized pnpm-lock.yaml exceeds size limit')
  const temporary = mkdtempSync(join(profile, '.desktop-lock-normalization-'))
  try {
    const path = join(temporary, 'pnpm-lock.yaml')
    writeFileSync(path, serialized, { flag: 'wx', mode: 0o600 })
    renameSync(path, lockPath)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
  return true
}
