import { createHash } from 'node:crypto'
import {
  closeSync, existsSync, ftruncateSync, mkdirSync, mkdtempSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { dump, JSON_SCHEMA, load } from 'js-yaml'
import { afterEach, describe, expect, it } from 'vitest'
import { normalizeDesktopArtifactSpecifiers, type DesktopArtifactSpecifier } from '../src/plugin-lock-normalization.ts'

const roots: string[] = []
const packageJson = '{"name":"desktop-profile","private":true}\n'

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-lock-normalization-'))
  roots.push(root)
  mkdirSync(join(root, '.desktop-plugin-artifacts'))
  writeFileSync(join(root, 'package.json'), packageJson)
  return root
}

function artifact(profile: string, name = 'example-plugin'): DesktopArtifactSpecifier {
  const bytes = Buffer.from(`immutable bytes for ${name}`)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  writeFileSync(join(profile, '.desktop-plugin-artifacts', `${sha256}.tgz`), bytes)
  return { name, sha256, specifier: `file:.desktop-plugin-artifacts/${sha256}.tgz` }
}

function windows(specifier: string): string {
  return specifier.replaceAll('/', '\\')
}

function lock(artifact: DesktopArtifactSpecifier, importer = '.', specifier = windows(artifact.specifier)): Record<string, unknown> {
  return {
    lockfileVersion: '9.0',
    settings: { autoInstallPeers: false, excludeLinksFromLockfile: false },
    importers: {
      [importer]: {
        dependencies: {
          [artifact.name]: { specifier, version: `${artifact.specifier}(peer-library@2.0.0)` },
          unrelated: { specifier: '^2.0.0', version: '2.1.0' },
        },
        optionalDependencies: { optional: { specifier: '^1', version: '1.0.0' } },
      },
    },
    packages: {
      [artifact.specifier]: { resolution: { integrity: 'sha512-fixture==', tarball: artifact.specifier }, version: '1.0.0' },
      'unrelated@2.1.0': { resolution: { integrity: 'sha512-unrelated==' } },
    },
    snapshots: { [`${artifact.specifier}(peer-library@2.0.0)`]: { dependencies: { native: '1.0.0' } } },
    time: '2026-09-17T01:02:03.000Z',
  }
}

function writeLock(profile: string, data: unknown): string {
  const source = `# preserve these bytes on a no-op\n${dump(data, { schema: JSON_SCHEMA, lineWidth: -1 })}`
  writeFileSync(join(profile, 'pnpm-lock.yaml'), source)
  return source
}

function readLock(profile: string): unknown {
  return load(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8'), { schema: JSON_SCHEMA })
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('normalizeDesktopArtifactSpecifiers', () => {
  it.each(['.', 'C:\\private\\staging', '../../relocated-profile'])('repairs only the owned importer specifier under %s', (importer) => {
    const root = fixture()
    const owned = artifact(root)
    writeLock(root, lock(owned, importer))
    expect(normalizeDesktopArtifactSpecifiers(root, [owned])).toBe(true)
    expect(readLock(root)).toEqual(lock(owned, importer, owned.specifier))
    expect(readFileSync(join(root, 'package.json'), 'utf8')).toBe(packageJson)
    expect(readdirSync(root).some(name => name.startsWith('.desktop-lock-normalization-'))).toBe(false)
    const normalized = readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')
    expect(normalizeDesktopArtifactSpecifiers(root, [owned])).toBe(false)
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(normalized)
  })

  it('leaves canonical lockfile bytes and comments identical', () => {
    const root = fixture()
    const owned = artifact(root)
    const original = writeLock(root, lock(owned, '.', owned.specifier))
    expect(normalizeDesktopArtifactSpecifiers(root, [owned])).toBe(false)
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(original)
  })

  it('does not create a missing lockfile or metadata files', () => {
    const root = fixture()
    const owned = artifact(root)
    const before = readdirSync(root)
    expect(normalizeDesktopArtifactSpecifiers(root, [owned])).toBe(false)
    expect(readdirSync(root)).toEqual(before)
    expect(existsSync(join(root, 'pnpm-lock.yaml'))).toBe(false)
  })

  it('leaves the lockfile unchanged when no candidates were authorized', () => {
    const root = fixture()
    const owned = artifact(root)
    const original = writeLock(root, lock(owned))
    expect(normalizeDesktopArtifactSpecifiers(root, [])).toBe(false)
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(original)
  })

  it.each([
    'file:./.desktop-plugin-artifacts/{hash}.tgz',
    'file:../.desktop-plugin-artifacts/{hash}.tgz',
    'file:.desktop-plugin-artifacts/../.desktop-plugin-artifacts/{hash}.tgz',
    'file:.desktop-plugin-artifacts//{hash}.tgz',
    'link:.desktop-plugin-artifacts/{hash}.tgz',
    'https://example.org/{hash}.tgz',
    'file:.desktop-plugin-artifacts/other.tgz',
    'npm:other@1.0.0',
  ])('does not repair unrelated importer mismatch %s', (input) => {
    const root = fixture()
    const owned = artifact(root)
    const original = writeLock(root, lock(owned, '.', input.replaceAll('{hash}', owned.sha256)))
    expect(normalizeDesktopArtifactSpecifiers(root, [owned])).toBe(false)
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(original)
  })

  it.each([
    null, [], {},
    { lockfileVersion: '10.0', importers: { '.': { dependencies: {} } } },
    { lockfileVersion: '6.0', importers: { '.': { dependencies: {} } } },
    { lockfileVersion: '9.0', importers: [] },
    { lockfileVersion: '9.0', importers: {} },
    { lockfileVersion: '9.0', importers: { '.': { dependencies: {} }, other: { dependencies: {} } } },
    { lockfileVersion: '9.0', importers: { '.': [] } },
    { lockfileVersion: '9.0', importers: { '.': { dependencies: [] } } },
  ])('refuses unknown or multi-project lock structures without rewriting: %j', (data) => {
    const root = fixture()
    const owned = artifact(root)
    const original = writeLock(root, data)
    expect(normalizeDesktopArtifactSpecifiers(root, [owned])).toBe(false)
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(original)
  })

  it.each([null, [], 'not-an-entry', { specifier: 12, version: '1.0.0' }])('leaves an unknown dependency entry unchanged: %j', (entry) => {
    const root = fixture()
    const owned = artifact(root)
    const original = writeLock(root, { lockfileVersion: '9.0', importers: { '.': { dependencies: { [owned.name]: entry } } } })
    expect(normalizeDesktopArtifactSpecifiers(root, [owned])).toBe(false)
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(original)
  })

  it('does not mutate aliased entries in resolutions or unrelated dependencies', () => {
    const root = fixture()
    const owned = artifact(root)
    const shared = { specifier: windows(owned.specifier), version: owned.specifier, integrity: 'sha512-preserved==' }
    const original = {
      lockfileVersion: '9.0',
      importers: { '.': { dependencies: { [owned.name]: shared, unrelated: shared } } },
      packages: { resolutionAlias: shared },
    }
    writeLock(root, original)
    expect(normalizeDesktopArtifactSpecifiers(root, [owned])).toBe(true)
    expect(readLock(root)).toEqual({
      ...original,
      importers: { '.': { dependencies: { [owned.name]: { ...shared, specifier: owned.specifier }, unrelated: shared } } },
    })
  })

  it('handles prototype-named package entries as own properties', () => {
    const root = fixture()
    const owned = artifact(root, 'constructor')
    writeLock(root, lock(owned))
    expect(normalizeDesktopArtifactSpecifiers(root, [owned])).toBe(true)
    expect(readLock(root)).toEqual(lock(owned, '.', owned.specifier))
  })

  it.each(['corrupt', 'missing', 'directory'] as const)('rejects a %s artifact without changing lock bytes', (damage) => {
    const root = fixture()
    const owned = artifact(root)
    const original = writeLock(root, lock(owned))
    const path = join(root, '.desktop-plugin-artifacts', `${owned.sha256}.tgz`)
    if (damage === 'corrupt') writeFileSync(path, 'corrupted')
    else {
      rmSync(path)
      if (damage === 'directory') mkdirSync(path)
    }
    expect(() => normalizeDesktopArtifactSpecifiers(root, [owned])).toThrow()
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(original)
  })

  it('rejects an artifact directory junction even when its bytes match', () => {
    const root = fixture()
    const owned = artifact(root)
    const original = writeLock(root, lock(owned))
    const directory = join(root, '.desktop-plugin-artifacts')
    const target = join(root, 'external-artifacts')
    renameSync(directory, target)
    symlinkSync(target, directory, 'junction')
    expect(() => normalizeDesktopArtifactSpecifiers(root, [owned])).toThrow('unlinked directory')
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(original)
  })

  it('rejects a linked artifact file without following it', () => {
    const root = fixture()
    const owned = artifact(root)
    const original = writeLock(root, lock(owned))
    const path = join(root, '.desktop-plugin-artifacts', `${owned.sha256}.tgz`)
    const target = join(root, 'external.tgz')
    renameSync(path, target)
    symlinkSync(target, path, 'file')
    expect(() => normalizeDesktopArtifactSpecifiers(root, [owned])).toThrow('unlinked regular file')
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(original)
  })

  it('rejects linked lockfiles without replacing their target', () => {
    const root = fixture()
    const owned = artifact(root)
    const original = writeLock(root, lock(owned))
    const target = join(root, 'external-lock.yaml')
    renameSync(join(root, 'pnpm-lock.yaml'), target)
    symlinkSync(target, join(root, 'pnpm-lock.yaml'), 'file')
    expect(() => normalizeDesktopArtifactSpecifiers(root, [owned])).toThrow('unlinked regular file')
    expect(readFileSync(target, 'utf8')).toBe(original)
  })

  it('validates every artifact before applying any repairs', () => {
    const root = fixture()
    const first = artifact(root, 'first')
    const second = artifact(root, 'second')
    const original = writeLock(root, {
      lockfileVersion: '9.0', importers: { '.': { dependencies: {
        first: { specifier: windows(first.specifier), version: first.specifier },
        second: { specifier: windows(second.specifier), version: second.specifier },
      } } },
    })
    writeFileSync(join(root, '.desktop-plugin-artifacts', `${second.sha256}.tgz`), 'corrupt second')
    expect(() => normalizeDesktopArtifactSpecifiers(root, [first, second])).toThrow('snapshot SHA-256 mismatch for second')
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(original)
    expect(readdirSync(root).some(name => name.startsWith('.desktop-lock-normalization-'))).toBe(false)
  })

  it.each([
    { name: '../escape' }, { name: '' }, { sha256: 'a'.repeat(64) }, { sha256: 'A'.repeat(64) },
    { specifier: 'file:../escape.tgz' }, { specifier: 'file:./.desktop-plugin-artifacts/{hash}.tgz' },
    { specifier: 'file:.desktop-plugin-artifacts\\{hash}.tgz' }, { specifier: 'link:.desktop-plugin-artifacts/{hash}.tgz' },
    { specifier: 'file:.desktop-plugin-artifacts/{hash}.tgz?x=1' },
  ])('rejects invalid canonical metadata %j before touching lock bytes', (patch) => {
    const root = fixture()
    const owned = artifact(root)
    const original = writeLock(root, lock(owned))
    const candidate = { ...owned, ...patch, specifier: patch.specifier?.replaceAll('{hash}', owned.sha256) ?? owned.specifier }
    expect(() => normalizeDesktopArtifactSpecifiers(root, [candidate])).toThrow('artifact metadata requires')
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(original)
  })

  it('rejects duplicate ownership input rather than choosing one candidate', () => {
    const root = fixture()
    const owned = artifact(root)
    const original = writeLock(root, lock(owned))
    expect(() => normalizeDesktopArtifactSpecifiers(root, [owned, owned])).toThrow('duplicate artifact metadata')
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(original)
  })

  it.each(['lockfileVersion: [', 'lockfileVersion: !!js/function function() {}', 'importers: {}\nimporters: {}\n'])('rejects malformed or executable YAML: %j', (yaml) => {
    const root = fixture()
    const owned = artifact(root)
    writeFileSync(join(root, 'pnpm-lock.yaml'), yaml)
    expect(() => normalizeDesktopArtifactSpecifiers(root, [owned])).toThrow('malformed pnpm-lock.yaml')
    expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(yaml)
  })

  it('rejects invalid UTF-8 without rewriting an otherwise eligible artifact lock', () => {
    const root = fixture()
    const owned = artifact(root)
    const eligible = writeLock(root, lock(owned))
    const original = Buffer.concat([Buffer.from(eligible + 'unrelated: "'), Buffer.from([0xc3, 0x28]), Buffer.from('"\n')])
    writeFileSync(join(root, 'pnpm-lock.yaml'), original)
    expect(() => normalizeDesktopArtifactSpecifiers(root, [owned])).toThrow('must contain valid UTF-8')
    expect(readFileSync(join(root, 'pnpm-lock.yaml'))).toEqual(original)
    expect(readdirSync(root).some(name => name.startsWith('.desktop-lock-normalization-'))).toBe(false)
  })

  it.each(['lock', 'artifact'] as const)('bounds %s file reads before allocation', (kind) => {
    const root = fixture()
    const owned = artifact(root)
    const original = writeLock(root, lock(owned))
    const path = kind === 'lock' ? join(root, 'pnpm-lock.yaml') : join(root, '.desktop-plugin-artifacts', `${owned.sha256}.tgz`)
    const descriptor = openSync(path, 'r+')
    try {
      ftruncateSync(descriptor, (kind === 'lock' ? 16 : 64) * 1024 * 1024 + 1)
    } finally {
      closeSync(descriptor)
    }
    expect(() => normalizeDesktopArtifactSpecifiers(root, [owned])).toThrow('byte limit')
    if (kind === 'artifact') expect(readFileSync(join(root, 'pnpm-lock.yaml'), 'utf8')).toBe(original)
  })
})
