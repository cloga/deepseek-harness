import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import { afterEach, expect, it } from 'vitest'
import { repairVerifiedArtifactLockfile } from '../src/plugin-lockfile.ts'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(name = 'verified-fixture') {
  const root = mkdtempSync(join(tmpdir(), 'desktop-lock-repair-'))
  roots.push(root)
  const bytes = Buffer.from('fixture verified artifact bytes')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const canonical = `file:.desktop-plugin-artifacts/${sha256}.tgz`
  const legacy = canonical.replaceAll('/', '\\')
  const entry = { specifier: legacy, version: `${canonical}(peer@1.0.0)` }
  const resolved = {
    version: '1.0.0',
    resolution: { tarball: canonical, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` },
  }
  const importers: Record<string, { dependencies: Record<string, typeof entry> }> = {
    '.': { dependencies: { [name]: entry, unrelated: { specifier: '2.0.0', version: '2.0.0' } } },
  }
  const lock = {
    lockfileVersion: '9.0',
    settings: { autoInstallPeers: false },
    importers,
    packages: { [`${name}@${canonical}`]: resolved, 'unrelated@2.0.0': { resolution: { integrity: 'unchanged' } } },
    snapshots: { [`${name}@${entry.version}`]: { dependencies: { peer: '1.0.0' } } },
  }
  const manifest = { dependencies: { [name]: canonical, unrelated: '2.0.0' } }
  const manifestPath = join(root, 'package.json')
  const lockPath = join(root, 'pnpm-lock.yaml')
  const artifactDir = join(root, '.desktop-plugin-artifacts')
  const artifactPath = join(artifactDir, `${sha256}.tgz`)
  mkdirSync(artifactDir)
  writeFileSync(artifactPath, bytes)
  const receipts = { [name]: { packageName: name, version: '1.0.0', artifactSha256: sha256 } }
  const save = (): void => {
    writeFileSync(manifestPath, JSON.stringify(manifest))
    writeFileSync(lockPath, dump(lock, { schema: JSON_SCHEMA, lineWidth: -1 }))
  }
  save()
  return { root, name, canonical, legacy, entry, resolved, lock, manifest, manifestPath, lockPath, artifactPath, receipts, save }
}

it.each(['verified-fixture', '@scope/verified-fixture'])('repairs only the receipt-bound specifier for %s', (name) => {
  const f = fixture(name)
  const originalManifest = readFileSync(f.manifestPath, 'utf8')
  const expected = structuredClone(f.lock)
  const importer = expected.importers['.']
  if (importer === undefined || importer.dependencies[name] === undefined) throw new Error('fixture importer missing')
  importer.dependencies[name].specifier = f.canonical
  expect(repairVerifiedArtifactLockfile(f.root, f.receipts)).toBe(true)
  expect(load(readFileSync(f.lockPath, 'utf8'), { schema: JSON_SCHEMA })).toEqual(expected)
  expect(readFileSync(f.manifestPath, 'utf8')).toBe(originalManifest)
  const repaired = readFileSync(f.lockPath, 'utf8')
  expect(repairVerifiedArtifactLockfile(f.root, f.receipts)).toBe(false)
  expect(readFileSync(f.lockPath, 'utf8')).toBe(repaired)
})

it('accepts the single relocated importer emitted by pnpm', () => {
  const f = fixture()
  const importer = f.lock.importers['.']
  if (importer === undefined) throw new Error('fixture importer missing')
  delete f.lock.importers['.']
  f.lock.importers['../../profiles/desktop'] = importer
  f.entry.version = f.canonical
  f.save()
  expect(repairVerifiedArtifactLockfile(f.root, f.receipts)).toBe(true)
})

it('does not repair packages without a parsed receipt', () => {
  const f = fixture()
  const before = readFileSync(f.lockPath, 'utf8')
  expect(repairVerifiedArtifactLockfile(f.root, {})).toBe(false)
  expect(readFileSync(f.lockPath, 'utf8')).toBe(before)
})

it('does not create a missing lockfile or rewrite unrelated lock text', () => {
  const f = fixture()
  rmSync(f.lockPath)
  expect(repairVerifiedArtifactLockfile(f.root, f.receipts)).toBe(false)
  writeFileSync(f.lockPath, JSON.stringify({ unrelated: '1.0.0' }))
  expect(repairVerifiedArtifactLockfile(f.root, f.receipts)).toBe(false)
  expect(readFileSync(f.lockPath, 'utf8')).toBe(JSON.stringify({ unrelated: '1.0.0' }))
})

it('rejects a lockfile symlink without changing its live target', () => {
  const f = fixture()
  const live = join(f.root, 'live')
  mkdirSync(live)
  const target = join(live, 'active-lock.yaml')
  renameSync(f.lockPath, target)
  const before = readFileSync(target, 'utf8')
  // Windows file symlinks require privileges; a junction exercises its same non-regular-file rejection.
  symlinkSync(process.platform === 'win32' ? live : target, f.lockPath,
    process.platform === 'win32' ? 'junction' : 'file')
  expect(() => repairVerifiedArtifactLockfile(f.root, f.receipts)).toThrow('must be a regular file')
  expect(readFileSync(target, 'utf8')).toBe(before)
})

it('rejects a dangling lockfile symlink instead of treating it as a missing lock', () => {
  const f = fixture()
  rmSync(f.lockPath)
  symlinkSync(join(f.root, 'missing-lock.yaml'), f.lockPath,
    process.platform === 'win32' ? 'junction' : 'file')
  expect(() => repairVerifiedArtifactLockfile(f.root, f.receipts)).toThrow('must be a regular file')
})

it.each(['foreign-lock', 'foreign-manifest', 'no-entry'] as const)('leaves %s drift for ordinary frozen validation', (kind) => {
  const f = fixture()
  if (kind === 'foreign-lock') f.entry.specifier = 'file:.desktop-plugin-artifacts\\different.tgz'
  if (kind === 'foreign-manifest') f.manifest.dependencies[f.name] = 'file:../outside.tgz'
  if (kind === 'no-entry') f.lock.importers = {}
  f.save()
  const before = readFileSync(f.lockPath, 'utf8')
  expect(repairVerifiedArtifactLockfile(f.root, f.receipts)).toBe(false)
  expect(readFileSync(f.lockPath, 'utf8')).toBe(before)
})

it.each(['artifact', 'integrity', 'version', 'tarball', 'package-version', 'package-name', 'lock-version', 'ambiguous'] as const)(
  'refuses %s inconsistency without writing a partial repair', (kind) => {
    const f = fixture()
    if (kind === 'artifact') writeFileSync(f.artifactPath, 'changed')
    if (kind === 'integrity') f.resolved.resolution.integrity = 'sha512-unrelated'
    if (kind === 'version') f.entry.version = 'file:.desktop-plugin-artifacts/unrelated.tgz'
    if (kind === 'tarball') f.resolved.resolution.tarball = 'file:../outside.tgz'
    if (kind === 'package-version') f.resolved.version = '2.0.0'
    if (kind === 'package-name') {
      const receipt = f.receipts[f.name]
      if (receipt === undefined) throw new Error('fixture receipt missing')
      receipt.packageName = 'different'
    }
    if (kind === 'lock-version') f.lock.lockfileVersion = '10.0'
    if (kind === 'ambiguous') f.lock.importers.other = { dependencies: { [f.name]: { ...f.entry } } }
    f.save()
    const before = readFileSync(f.lockPath, 'utf8')
    expect(() => repairVerifiedArtifactLockfile(f.root, f.receipts)).toThrow()
    expect(readFileSync(f.lockPath, 'utf8')).toBe(before)
  },
)
