import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, describe, expect, it as registerTest, vi } from 'vitest'
import { resolveDesktopPaths } from '../src/paths.ts'
import { assertDesktopProvisioningInventory, DesktopProjectManager, packageNameFromSpec, type DesktopProjectHooks } from '../src/project-manager.ts'
import { parseDesktopPluginSource, type DesktopGithubReleasePluginSource, type DesktopPluginProvisionReceipt } from '../src/plugin-source.ts'
import { parseDesktopPluginProvisioningPlan } from '../src/plugin-provisioning.ts'
import { readDesktopProfileState } from '../src/profile-packages.ts'
import { readDesktopPackageLocks } from '../src/plugin-package-lock.ts'
import * as recoveryCopy from '../src/profile-recovery-copy.ts'
import * as operationAudit from '../src/profile-operation-audit.ts'
import { runtimeFixture } from './runtime-fixture.ts'
import { ProjectFixtureWork, trackProjectFixtureTests } from './fixtures/project-fixture-work.ts'

const fixtureWork = new ProjectFixtureWork()
const it = trackProjectFixtureTests(registerTest, fixtureWork)
let originalFetch: typeof fetch
const roots: string[] = []
const releaseWorkers: Array<() => Promise<void>> = []
const targetCommit = '08bfccc3b5930b93ef2fe31d9cf9e509f34a8704'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
})

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return { ...actual, spawn: (...args: Parameters<typeof actual.spawn>) => {
    const cwd = args[2]?.cwd
    const owned = typeof cwd === 'string' && roots.some((root) => {
      const path = relative(root, cwd)
      return !isAbsolute(path) && path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    })
    if (!owned) return actual.spawn(...args)
    fixtureWork.assertOpen()
    const child = actual.spawn(...args)
    const verb = args[1]?.find(value => ['install', 'add', 'remove', 'rebuild'].includes(value)) ?? 'unknown'
    fixtureWork.child(child, `pnpm:${verb}`)
    return child
  } }
})

function octal(value: number, width: number): Buffer {
  return Buffer.from(value.toString(8).padStart(width - 1, '0') + '\0')
}

function verifiedPluginArchive(name = 'dsh-github-copilot', version = '0.4.0-alpha.18', peer = '^1.0.0'): Buffer {
  const entries = [
    ['package/package.json', JSON.stringify({
      name,
      version,
      peerDependencies: { '@deepseek-ai/cordis': peer },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    })],
    ['package/cordis.patch.yml', '[]\n'],
  ] as const
  const blocks: Buffer[] = []
  for (const [name, content] of entries) {
    const body = Buffer.from(content)
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    octal(0o644, 8).copy(header, 100)
    octal(0, 8).copy(header, 108)
    octal(0, 8).copy(header, 116)
    octal(body.byteLength, 12).copy(header, 124)
    octal(0, 12).copy(header, 136)
    header.fill(0x20, 148, 156)
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    octal([...header].reduce((sum, byte) => sum + byte, 0), 8).copy(header, 148)
    blocks.push(header, body, Buffer.alloc((512 - body.byteLength % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
}

function verifiedSource(archive: Buffer, name = 'dsh-github-copilot', version = '0.4.0-alpha.18'): DesktopGithubReleasePluginSource {
  const artifactSha256 = createHash('sha256').update(archive).digest('hex')
  const asset = `${name}-${version}.tgz`
  const checksum = Buffer.from(`${artifactSha256}  ${asset}\n`)
  return {
    schemaVersion: 1,
    type: 'githubRelease',
    owner: 'cloga',
    repo: name,
    tag: `v${version}`,
    asset,
    assetId: 563672719,
    packageName: name,
    version,
    size: archive.byteLength,
    sha256: artifactSha256,
    targetCommit,
    dependencyRegistry: 'https://packagefeedproxy.microsoft.io/npm/',
    checksumManifest: {
      format: 'sha256sums',
      asset: 'SHA256SUMS',
      assetId: 563672720,
      url: `https://github.com/cloga/${name}/releases/download/v${version}/SHA256SUMS`,
      size: checksum.byteLength,
      sha256: createHash('sha256').update(checksum).digest('hex'),
    },
  }
}

function checksumManifest(source: DesktopGithubReleasePluginSource): Buffer {
  return Buffer.from(`${source.sha256}  ${source.asset}\n`)
}

function verifiedFetch(source: DesktopGithubReleasePluginSource, archive: Buffer): typeof fetch {
  return async (input) => {
    const url = new URL(input instanceof Request ? input.url : input)
    if (url.pathname.endsWith(`/releases/tags/${source.tag}`)) {
      return Response.json({
        id: 388508318,
        draft: false,
        immutable: true,
        tag_name: source.tag,
        target_commitish: targetCommit,
        assets: [{
          id: 563672719,
          name: source.asset,
          browser_download_url: `https://github.com/${source.owner}/${source.repo}/releases/download/${source.tag}/${source.asset}`,
          state: 'uploaded',
          size: source.size,
          digest: `sha256:${source.sha256}`,
        }, {
          id: 563672720,
          name: source.checksumManifest?.asset,
          browser_download_url: source.checksumManifest?.url,
          state: 'uploaded',
          size: source.checksumManifest?.size,
          digest: `sha256:${source.checksumManifest?.sha256}`,
        }],
      })
    }
    if (url.pathname.endsWith(`/git/ref/tags/${source.tag}`)) {
      return Response.json({ object: { type: 'commit', sha: targetCommit } })
    }
    if (url.pathname.endsWith('/releases/assets/563672719')) return new Response(Uint8Array.from(archive))
    if (url.pathname.endsWith('/releases/assets/563672720')) {
      return new Response(checksumManifest(source).toString('utf8'))
    }
    throw new Error(`unexpected GitHub request ${url.href}`)
  }
}

function pluginFixture(name: string) {
  const archive = verifiedPluginArchive(name)
  return { archive, source: verifiedSource(archive, name) }
}

function mockVerifiedPlugins(fixtures: ReturnType<typeof pluginFixture>[]): void {
  const selected = new Map<string, ReturnType<typeof pluginFixture>>()
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input)
    const candidates = fixtures.filter(entry => url.pathname.includes(`/${entry.source.repo}/`))
    const exact = candidates.find(entry => url.pathname.includes(`/tags/${entry.source.tag}`)
      || url.pathname.includes(`/download/${entry.source.tag}/`))
    if (exact !== undefined) selected.set(exact.source.repo, exact)
    const fixture = exact ?? (candidates.length === 1 ? candidates[0] : selected.get(candidates[0]?.source.repo ?? ''))
    if (fixture === undefined) throw new Error(`unexpected fixture request ${url.href}`)
    return verifiedFetch(fixture.source, fixture.archive)(input, init)
  })
}

function receiptStore(manager: DesktopProjectManager): {
  schemaVersion: 1
  receipts: Record<string, DesktopPluginProvisionReceipt>
  owners?: Record<string, 'user' | 'release'>
} {
  return JSON.parse(readFileSync(join(manager.paths.profile, 'desktop-plugin-receipts.json'), 'utf8')) as ReturnType<typeof receiptStore>
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-desktop-test-'))
  roots.push(root)
  return root
}
function writeFakePnpm(root: string): string {
  const path = join(root, 'pnpm.mjs')
  writeFileSync(path, `
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'
const args = process.argv.slice(2)
const project = process.cwd()
const command = args.find(value => ['install', 'add', 'remove', 'rebuild'].includes(value))
function archiveManifest(path) {
  const archive = gunzipSync(readFileSync(path))
  for (let offset = 0; offset + 512 <= archive.byteLength;) {
    const header = archive.subarray(offset, offset + 512)
    const name = header.subarray(0, 100).toString('utf8').replace(/\\0.*$/u, '')
    if (name === '') break
    const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\\0.*$/u, '').trim() || '0', 8)
    const body = archive.subarray(offset + 512, offset + 512 + size)
    if (name === 'package/package.json') return JSON.parse(body.toString('utf8'))
    offset += 512 + Math.ceil(size / 512) * 512
  }
  throw new Error('fixture archive has no package manifest')
}
appendFileSync(${JSON.stringify(join(root, 'pnpm-log.jsonl'))}, JSON.stringify({
  args,
  project,
  registry: process.env.NPM_CONFIG_REGISTRY,
  credentials: {
    npmToken: process.env.NPM_TOKEN,
    corepackToken: process.env.COREPACK_NPM_TOKEN,
    userConfig: process.env.NPM_CONFIG_USERCONFIG,
    secret: process.env.DESKTOP_FIXTURE_SECRET,
  },
}) + '\\n')
if (command !== 'rebuild') {
  let addedArtifact
  const manifestPath = join(project, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (command === 'add') {
    const spec = args[args.indexOf(command) + 1]
    if (spec.startsWith('./.desktop-plugin-artifacts/')) {
      const installed = archiveManifest(join(project, spec))
      addedArtifact = installed
      const failure = ${JSON.stringify(join(root, 'fail-package'))}
      if (existsSync(failure) && readFileSync(failure, 'utf8') === installed.name) throw new Error('fixture package install failed')
      manifest.dependencies[installed.name] = 'file:' + spec.slice(2)
    } else {
      const index = spec.lastIndexOf('@')
      const name = index > 0 ? spec.slice(0, index) : spec
      manifest.dependencies[name] = index > 0 ? spec.slice(index + 1) : '1.0.0'
    }
  }
  if (command === 'remove') delete manifest.dependencies[args[args.indexOf(command) + 1]]
  writeFileSync(manifestPath, JSON.stringify(manifest))
  rmSync(join(project, 'node_modules'), { recursive: true, force: true })
  for (const [name, version] of Object.entries(manifest.dependencies)) {
    const installed = addedArtifact?.name === name ? addedArtifact : typeof version === 'string' && version.startsWith('file:.desktop-plugin-artifacts/')
      ? archiveManifest(join(project, version.slice('file:'.length)))
      : { name, version }
    const packageRoot = join(project, 'node_modules', name)
    mkdirSync(packageRoot, { recursive: true })
    writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ ...installed,
      peerDependencies: installed.peerDependencies ?? {'@deepseek-ai/cordis': '^1.0.0'}, dsh: {bundle: {patch: './bundle.yml'}}}))
    writeFileSync(join(packageRoot, 'bundle.yml'), '[]\\n')
  }
  writeFileSync(join(project, 'pnpm-lock.yaml'), JSON.stringify(manifest.dependencies))
}
`)
  return path
}
function hooks(overrides: Partial<DesktopProjectHooks> = {}): DesktopProjectHooks {
  return { beforeChange: async () => {}, healthCheck: async () => {}, afterChange: async () => {}, ...overrides }
}
function trackedProjectManager(...args: ConstructorParameters<typeof DesktopProjectManager>): DesktopProjectManager {
  const manager = new DesktopProjectManager(...args)
  const applyRelease = manager.applyRelease.bind(manager)
  const mutate = manager.mutate.bind(manager)
  const reconcileProvisioning = manager.reconcileProvisioning.bind(manager)
  const resetConfiguration = manager.resetConfiguration.bind(manager)
  manager.applyRelease = (...values) => fixtureWork.track('apply release', () => applyRelease(...values))
  manager.mutate = (...values) => fixtureWork.track(`mutate:${values[0].type}`, () => mutate(...values))
  manager.reconcileProvisioning = (...values) => fixtureWork.track('reconcile provisioning', () => reconcileProvisioning(...values))
  manager.resetConfiguration = (...values) => fixtureWork.track('reset configuration', () => resetConfiguration(...values))
  return manager
}

function setup(): { root: string; manager: DesktopProjectManager } {
  const root = temporaryRoot()
  const dsh = join(root, 'resources', 'dsh')
  runtimeFixture(dsh)
  return { root, manager: trackedProjectManager(resolveDesktopPaths(join(root, '.dsh')), { node: process.execPath, pnpm: writeFakePnpm(root), dsh }) }
}
function calls(root: string): { args: string[]; project: string; registry: string; credentials: Record<string, string | undefined> }[] {
  const path = join(root, 'pnpm-log.jsonl')
  return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line) as {
    args: string[]
    project: string
    registry: string
    credentials: Record<string, string | undefined>
  }) : []
}
beforeEach(() => {
  fixtureWork.begin()
  originalFetch = globalThis.fetch
})
// Match the release lane's hook budget; owned child quiescence retains its separate 25s bound.
afterEach(async ({ task }) => {
  const releases = releaseWorkers.splice(0).map(cleanup => fixtureWork.track('worker release', cleanup))
  const results = Promise.allSettled(releases)
  try {
    await fixtureWork.close()
  } catch (error) {
    console.error('project fixture cleanup failed', fixtureWork.snapshot())
    throw error
  }
  if (task.result?.state === 'fail') console.error('project fixture phases', fixtureWork.snapshot())
  // Original test continuations and pnpm close events settle before shared mocks or private roots disappear.
  vi.restoreAllMocks()
  vi.mocked(fs.renameSync).mockReset()
  globalThis.fetch = originalFetch
  const directories = roots.splice(0)
  for (const root of directories) rmSync(root, { recursive: true, force: true })
  const failures: unknown[] = (await results).flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'desktop worker cleanup failed')
}, 90_000)

function profileMetadata(profile: string): Record<string, string | null> {
  return Object.fromEntries([
    'package.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml', 'desktop-runtime-state.json',
    'desktop-plugin-receipts.json', 'desktop-plugin-package-locks.json', 'desktop-plugin-provisioning-state.json',
  ].map(name => [name, existsSync(join(profile, name)) ? readFileSync(join(profile, name)).toString('base64') : null]))
}

describe('desktop external plugin profile', () => {
  it.each([true, false])('refuses inventory bootstrap without runtime metadata for enabled=%s', async (enabled) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'manual-plugin@1.0.0' }, hooks())
    if (!enabled) await manager.mutate({ type: 'plugin-toggle', name: 'manual-plugin', enabled }, hooks())
    unlinkSync(join(manager.paths.profile, 'desktop-runtime-state.json'))
    const before = profileMetadata(manager.paths.profile), count = calls(root).length
    const beforeChange = vi.fn(async () => {})
    await expect(manager.applyRelease(hooks({ beforeChange }), { schemaVersion: 1, mode: 'exact', plugins: [] }))
      .rejects.toThrow('runtime metadata is missing')
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
    expect(calls(root)).toHaveLength(count)
    expect(beforeChange).not.toHaveBeenCalled()
  })

  it('rejects orphan user receipt inventory rather than adopting an empty manifest', async () => {
    const { root, manager } = setup()
    const fixture = pluginFixture('manual-verified')
    mockVerifiedPlugins([fixture])
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-install', source: fixture.source }, hooks())
    const manifestPath = join(manager.paths.profile, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
    manifest.dependencies = Object.fromEntries(
      Object.entries(manifest.dependencies).filter(([name]) => name !== fixture.source.packageName),
    )
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== fixture.source.packageName)
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const before = profileMetadata(manager.paths.profile), count = calls(root).length
    await expect(manager.applyRelease()).rejects.toThrow('orphan user plugin metadata')
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
    expect(calls(root)).toHaveLength(count)
  })

  it.each(['staged', 'final'] as const)('rejects user inventory shrink during %s health verification', async (phase) => {
    const { manager } = setup()
    const fixture = pluginFixture('release-provider')
    mockVerifiedPlugins([fixture])
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'manual-disabled@1.0.0' }, hooks())
    await manager.mutate({ type: 'plugin-toggle', name: 'manual-disabled', enabled: false }, hooks())
    const before = profileMetadata(manager.paths.profile)
    let changed = false
    const shrink = (profile: string): void => {
      if (changed) return
      changed = true
      const manifestPath = join(profile, 'package.json')
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
      delete manifest.dependencies['manual-disabled']
      writeFileSync(manifestPath, JSON.stringify(manifest))
    }
    await expect(manager.reconcileProvisioning({ schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: fixture.source }] }, hooks({
      healthCheck: async (profile) => { if (phase === 'staged') shrink(profile) },
      afterChange: async () => { if (phase === 'final') shrink(manager.paths.profile) },
    }))).rejects.toThrow('user plugin inventory changed')
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
    expect(manager.listPlugins()).toEqual([{ name: 'manual-disabled', version: '1.0.0', enabled: false }])
  })

  it.each(['package.json', 'desktop.cordis.yml', 'pnpm-workspace.yaml', 'desktop-plugin-package-locks.json'])(
    'refuses inventory bootstrap when only owned metadata %s remains', async (name) => {
      const { root, manager } = setup()
      mkdirSync(manager.paths.profile, { recursive: true })
      const file = join(manager.paths.profile, name)
      writeFileSync(file, 'retained owned metadata')
      await expect(manager.applyRelease()).rejects.toThrow('runtime metadata is missing')
      expect(readFileSync(file, 'utf8')).toBe('retained owned metadata')
      expect(calls(root)).toEqual([])
    },
  )

  it.skipIf(process.platform !== 'win32')('refuses inventory bootstrap for differently cased Package.JSON', async () => {
    const { manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    const file = join(manager.paths.profile, 'Package.JSON')
    writeFileSync(file, 'retained Windows case alias')
    await expect(manager.applyRelease()).rejects.toThrow('runtime metadata is missing')
    expect(readFileSync(file, 'utf8')).toBe('retained Windows case alias')
  })

  it('refuses inventory bootstrap from a broken owned package link', async () => {
    const { root, manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    const target = join(root, 'old-modules')
    mkdirSync(target)
    symlinkSync(target, join(manager.paths.profile, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir')
    rmSync(target, { recursive: true })
    await expect(manager.applyRelease()).rejects.toThrow('runtime metadata is missing')
    expect(fs.lstatSync(join(manager.paths.profile, 'node_modules')).isSymbolicLink()).toBe(true)
    expect(existsSync(join(manager.paths.profile, 'package.json'))).toBe(false)
  })

  it.each(['registry-add', 'registry-update', 'source-add', 'verified-install'] as const)(
    'retains the requested %s target through final health verification', async (operation) => {
      const { root, manager } = setup()
      const fixture = pluginFixture('requested-target')
      mockVerifiedPlugins([fixture])
      await manager.applyRelease()
      await manager.mutate({ type: 'plugin-add', spec: 'unrelated@1.0.0' }, hooks())
      if (operation === 'registry-update') await manager.mutate({ type: 'plugin-add', spec: 'requested-target@1.0.0' }, hooks())
      const archive = join(root, 'not-the-package-name.tgz')
      writeFileSync(archive, fixture.archive)
      const mutation = operation === 'registry-update' ? { type: 'plugin-update' as const, name: fixture.source.packageName, version: '2.0.0' }
        : operation === 'verified-install' ? { type: 'plugin-install' as const, source: fixture.source }
          : { type: 'plugin-add' as const, spec: operation === 'source-add' ? archive : 'requested-target@1.0.0' }
      const before = profileMetadata(manager.paths.profile)
      let changed = false
      await expect(manager.mutate(mutation, hooks({ afterChange: async () => {
        if (changed) return
        changed = true
        const file = join(manager.paths.profile, 'package.json')
        const manifest = JSON.parse(readFileSync(file, 'utf8')) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
        manifest.dependencies = Object.fromEntries(
          Object.entries(manifest.dependencies).filter(([name]) => name !== fixture.source.packageName),
        )
        manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== fixture.source.packageName)
        writeFileSync(file, JSON.stringify(manifest))
        const receiptPath = join(manager.paths.profile, 'desktop-plugin-receipts.json')
        if (existsSync(receiptPath)) {
          const store = receiptStore(manager)
          store.receipts = Object.fromEntries(Object.entries(store.receipts).filter(([name]) => name !== fixture.source.packageName))
          if (store.owners !== undefined) {
            store.owners = Object.fromEntries(Object.entries(store.owners).filter(([name]) => name !== fixture.source.packageName))
          }
          writeFileSync(receiptPath, JSON.stringify(store))
        }
        const lockPath = join(manager.paths.profile, 'desktop-plugin-package-locks.json')
        if (existsSync(lockPath)) writeFileSync(lockPath, JSON.stringify({ schemaVersion: 1, packages: {} }))
      } }))).rejects.toThrow('requested plugin inventory changed')
      expect(profileMetadata(manager.paths.profile)).toEqual(before)
    },
  )

  it.each((['source', 'verified'] as const).flatMap(kind =>
    (['delete', 'corrupt'] as const).flatMap(damage => (['staged', 'final'] as const).map(phase => ({ kind, damage, phase }))),
  ))('retains disabled $kind artifact bytes after $phase $damage tampering', async ({ kind, damage, phase }) => {
    const { root, manager } = setup()
    const fixture = pluginFixture('manual-artifact')
    mockVerifiedPlugins([fixture])
    await manager.applyRelease()
    const archive = join(root, 'manual.tgz')
    writeFileSync(archive, fixture.archive)
    await manager.mutate(kind === 'source' ? { type: 'plugin-add', spec: archive } : { type: 'plugin-install', source: fixture.source }, hooks())
    await manager.mutate({ type: 'plugin-toggle', name: fixture.source.packageName, enabled: false }, hooks())
    const artifact = `.desktop-plugin-artifacts/${fixture.source.sha256}.tgz`
    const before = profileMetadata(manager.paths.profile)
    let changed = false
    const damageArtifact = (profile: string): void => {
      if (changed) return
      changed = true
      if (damage === 'delete') unlinkSync(join(profile, artifact))
      else writeFileSync(join(profile, artifact), 'corrupted artifact')
    }
    await expect(manager.mutate({ type: 'plugin-add', spec: 'unrelated@1.0.0' }, hooks({
      healthCheck: async (profile) => { if (phase === 'staged') damageArtifact(profile) },
      afterChange: async () => { if (phase === 'final') damageArtifact(manager.paths.profile) },
    }))).rejects.toThrow(/artifact snapshot|locked local artifacts/u)
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
    expect(readFileSync(join(manager.paths.profile, artifact))).toEqual(fixture.archive)
  })

  it.each((['registry', 'source', 'different-verified', 'disabled-verified'] as const)
    .flatMap(origin => [true, false].map(required => ({ origin, required }))))(
    'rejects desired user $origin collision with required=$required before package work', async ({ origin, required }) => {
      const { root, manager } = setup()
      const fixture = pluginFixture('manual-collision')
      const archive = origin === 'different-verified' ? verifiedPluginArchive(fixture.source.packageName, fixture.source.version, '>=1.0.0') : fixture.archive
      mockVerifiedPlugins([{ archive, source: verifiedSource(archive, fixture.source.packageName) }])
      await manager.applyRelease()
      const input = join(root, 'collision.tgz')
      writeFileSync(input, archive)
      if (origin === 'registry' || origin === 'source') await manager.mutate({ type: 'plugin-add', spec: origin === 'registry' ? `${fixture.source.packageName}@${fixture.source.version}` : input }, hooks())
      else await manager.mutate({ type: 'plugin-install', source: verifiedSource(archive, fixture.source.packageName) }, hooks())
      if (origin === 'disabled-verified') await manager.mutate({ type: 'plugin-toggle', name: fixture.source.packageName, enabled: false }, hooks())
      const before = profileMetadata(manager.paths.profile), count = calls(root).length
      const acquisition = vi.spyOn(globalThis, 'fetch').mockImplementation(verifiedFetch(fixture.source, fixture.archive))
      acquisition.mockClear()
      await expect(manager.reconcileProvisioning({ schemaVersion: 1, mode: 'exact', plugins: [{ required, source: fixture.source }] }, hooks()))
        .rejects.toThrow('release plan conflicts with user plugin')
      expect(profileMetadata(manager.paths.profile)).toEqual(before)
      expect(calls(root)).toHaveLength(count)
      expect(acquisition).not.toHaveBeenCalled()
    },
  )

  it('does not let a stale release receipt authorize removal of a registry declaration', async () => {
    const { manager } = setup()
    const fixture = pluginFixture('release-provider')
    mockVerifiedPlugins([fixture])
    await manager.applyRelease(hooks(), { schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: fixture.source }] })
    const file = join(manager.paths.profile, 'package.json')
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies[fixture.source.packageName] = '1.0.0'
    writeFileSync(file, JSON.stringify(manifest))
    const before = profileMetadata(manager.paths.profile)
    await expect(manager.reconcileProvisioning({ schemaVersion: 1, mode: 'exact', plugins: [] }, hooks())).rejects.toThrow('inconsistent user plugin metadata')
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
  })

  it.each(['registry-mismatch', 'dual-store'] as const)('rejects user source inventory %s before fast-path reuse', async (damage) => {
    const { root, manager } = setup()
    const fixture = pluginFixture('manual-source')
    mockVerifiedPlugins([fixture])
    await manager.applyRelease()
    const input = join(root, 'source.tgz')
    writeFileSync(input, fixture.archive)
    await manager.mutate({ type: 'plugin-add', spec: input }, hooks())
    if (damage === 'registry-mismatch') {
      const file = join(manager.paths.profile, 'package.json')
      const manifest = JSON.parse(readFileSync(file, 'utf8')) as { dependencies: Record<string, string> }
      manifest.dependencies[fixture.source.packageName] = fixture.source.version
      writeFileSync(file, JSON.stringify(manifest))
    } else {
      const locks = readDesktopPackageLocks(manager.paths.profile)
      await manager.mutate({ type: 'plugin-install', source: fixture.source }, hooks())
      writeFileSync(join(manager.paths.profile, 'desktop-plugin-package-locks.json'), JSON.stringify({ schemaVersion: 1, packages: locks }))
    }
    const before = profileMetadata(manager.paths.profile), count = calls(root).length
    await expect(manager.applyRelease()).rejects.toThrow('inconsistent user plugin metadata')
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
    expect(calls(root)).toHaveLength(count)
  })

  it('changes runtime generations without deleting legacy host links', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const links = readDesktopProfileState(manager.paths.profile)?.links
    expect(links?.length).toBeGreaterThan(0)

    const dsh = join(root, 'next-runtime', 'dsh')
    runtimeFixture(dsh, '1.1.0')
    const runtimeManager = trackedProjectManager(manager.paths, {
      ...manager.runtime,
      dsh,
      profileResolution: 'runtime',
    })
    await expect(runtimeManager.applyRelease()).resolves.toBe(true)
    expect(readDesktopProfileState(manager.paths.profile)?.links).toEqual(links)
    await expect(runtimeManager.applyRelease()).resolves.toBe(false)
  })

  it('rejects an alternate verified source for a strict active plan before acquisition', async () => {
    const { root, manager } = setup()
    const planned = pluginFixture('strict-provider')
    const alternateArchive = verifiedPluginArchive('strict-provider', '2.0.0')
    const alternate = verifiedSource(alternateArchive, 'strict-provider', '2.0.0')
    mockVerifiedPlugins([planned, { archive: alternateArchive, source: alternate }])
    await manager.applyRelease(hooks(), {
      schemaVersion: 2, mode: 'exact', plugins: [{ required: true, source: planned.source, sourcePolicy: 'strict-pin' }],
    })
    const before = profileMetadata(manager.paths.profile), count = calls(root).length
    const crafted = {
      schemaVersion: 1, mode: 'exact', plugins: [{
        required: true, source: planned.source, sourcePolicy: 'compatible-user-override',
      }],
    }
    expect(() => assertDesktopProvisioningInventory(manager.paths.profile, crafted)).toThrow('invalid plugin entry')
    await expect(manager.mutate({ type: 'plugins-reconcile', plan: crafted as never }, hooks()))
      .rejects.toThrow('invalid plugin entry')
    await expect(manager.mutate({ type: 'plugin-install', source: alternate }, hooks()))
      .rejects.toThrow('restore the planned source')
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
    expect(calls(root)).toHaveLength(count)
  })

  it('rejects a different verified source family for a compatible plan before acquisition', async () => {
    const { root, manager } = setup()
    const planned = pluginFixture('family-provider')
    mockVerifiedPlugins([planned])
    const plan = { schemaVersion: 2, mode: 'exact', plugins: [{
      required: true, source: planned.source, sourcePolicy: 'compatible-user-override',
    }] }
    await manager.applyRelease(hooks(), plan)
    const checksumManifest = planned.source.checksumManifest
    if (checksumManifest === undefined) throw new Error('fixture requires checksum attestation')
    const alien = parseDesktopPluginSource({
      ...planned.source, owner: 'other-owner',
      checksumManifest: { ...checksumManifest, url: checksumManifest.url.replace('/cloga/', '/other-owner/') },
    })
    if (alien.type !== 'githubRelease') throw new Error('expected GitHub release source')
    const before = profileMetadata(manager.paths.profile), count = calls(root).length
    await expect(manager.mutate({ type: 'plugin-install', source: alien }, hooks()))
      .rejects.toThrow('restore the planned source')
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
    expect(calls(root)).toHaveLength(count)
  })

  it.each(['0.4.0-alpha.32', '0.4.0-alpha.36'])(
    'retains health-checked compatible verified user override %s without version ordering', async (overrideVersion) => {
      const { root, manager } = setup()
      const plannedArchive = verifiedPluginArchive('dsh-github-copilot', '0.4.0-alpha.33')
      const overrideArchive = verifiedPluginArchive('dsh-github-copilot', overrideVersion)
      const planned = verifiedSource(plannedArchive, 'dsh-github-copilot', '0.4.0-alpha.33')
      const override = verifiedSource(overrideArchive, 'dsh-github-copilot', overrideVersion)
      mockVerifiedPlugins([{ archive: plannedArchive, source: planned }, { archive: overrideArchive, source: override }])
      const plan = parseDesktopPluginProvisioningPlan({
        schemaVersion: 2,
        mode: 'exact',
        plugins: [{ required: true, source: planned, sourcePolicy: 'compatible-user-override' }],
      })
      await manager.applyRelease(hooks(), plan)
      await manager.mutate({ type: 'plugin-install', source: override }, hooks())
      const state = JSON.parse(readFileSync(
        join(manager.paths.profile, 'desktop-plugin-provisioning-state.json'), 'utf8',
      )) as { plugins: Array<{ requestedSource: unknown; effectiveSource: unknown; effective: string }> }
      expect(state.plugins[0]).toMatchObject({
        requestedSource: planned, effectiveSource: override, effective: 'user-override',
      })
      expect(receiptStore(manager).owners?.['dsh-github-copilot']).toBe('user')
      const beforeReuse = calls(root).length
      await manager.reconcileProvisioning(plan, hooks())
      expect(calls(root)).toHaveLength(beforeReuse)
      const dsh = join(root, 'compatible-runtime')
      runtimeFixture(dsh, '1.1.0', '24.18.0')
      const next = trackedProjectManager(manager.paths, { ...manager.runtime, dsh })
      await next.applyRelease(hooks(), plan)
      expect(next.listPlugins()[0]).toMatchObject({
        name: 'dsh-github-copilot', version: overrideVersion, source: override,
      })
      expect(receiptStore(next).owners?.['dsh-github-copilot']).toBe('user')
    }, 30_000,
  )

  it('rolls back a same-name compatible install when staged health fails', async () => {
    const { manager } = setup()
    const planned = pluginFixture('required-provider')
    const overrideArchive = verifiedPluginArchive('required-provider', '2.0.0')
    const override = verifiedSource(overrideArchive, 'required-provider', '2.0.0')
    const unrelated = pluginFixture('unrelated-user')
    mockVerifiedPlugins([planned, { archive: overrideArchive, source: override }, unrelated])
    const plan = { schemaVersion: 2, mode: 'exact', plugins: [{
      required: true, source: planned.source, sourcePolicy: 'compatible-user-override',
    }] }
    await manager.applyRelease(hooks(), plan)
    await manager.mutate({ type: 'plugin-install', source: unrelated.source }, hooks())
    const before = profileMetadata(manager.paths.profile)
    const beforeStore = receiptStore(manager)
    await expect(manager.mutate({ type: 'plugin-install', source: override }, hooks({
      healthCheck: async () => { throw new Error('unrelated staged failure') },
    }))).rejects.toThrow('health failed while user override required-provider was active')
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
    expect(receiptStore(manager)).toEqual(beforeStore)
    expect(manager.listPlugins()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: planned.source.packageName, version: planned.source.version }),
      expect.objectContaining({ name: unrelated.source.packageName, version: unrelated.source.version }),
    ]))
  }, 30_000)

  it('rejects invalid known-name mutations before package work and permits re-enabling', async () => {
    const { root, manager } = setup()
    const planned = pluginFixture('required-provider')
    const overrideArchive = verifiedPluginArchive('required-provider', '2.0.0')
    const override = verifiedSource(overrideArchive, 'required-provider', '2.0.0')
    mockVerifiedPlugins([planned, { archive: overrideArchive, source: override }])
    const plan = { schemaVersion: 2, mode: 'exact', plugins: [{
      required: true, source: planned.source, sourcePolicy: 'compatible-user-override',
    }] }
    await manager.applyRelease(hooks(), plan)
    await manager.mutate({ type: 'plugin-install', source: override }, hooks())
    const before = profileMetadata(manager.paths.profile), callCount = calls(root).length
    await expect(manager.mutate({ type: 'plugin-add', spec: `${override.packageName}@3.0.0` }, hooks()))
      .rejects.toThrow('leave active planned plugin')
    await expect(manager.mutate({
      type: 'plugin-install', source: { schemaVersion: 1, type: 'npmRegistry', spec: `${override.packageName}@3.0.0` },
    }, hooks())).rejects.toThrow('leave active planned plugin')
    await expect(manager.mutate({ type: 'plugin-update', name: override.packageName, version: '3.0.0' }, hooks()))
      .rejects.toThrow('leave active planned plugin')
    await expect(manager.mutate({ type: 'plugin-toggle', name: override.packageName, enabled: false }, hooks()))
      .rejects.toThrow('planned plugin')
    await expect(manager.mutate({ type: 'plugin-remove', name: override.packageName }, hooks()))
      .rejects.toThrow('planned plugin')
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
    expect(calls(root)).toHaveLength(callCount)
    await expect(manager.mutate({ type: 'plugin-toggle', name: override.packageName, enabled: true }, hooks())).resolves.toBeUndefined()
  }, 30_000)

  it('preflights active optional plan entries but permits normal handling for absent optional entries', async () => {
    const activeSetup = setup(), active = pluginFixture('optional-provider')
    mockVerifiedPlugins([active])
    const plan = { schemaVersion: 2, mode: 'exact', plugins: [{
      required: false, source: active.source, sourcePolicy: 'compatible-user-override',
    }] }
    await activeSetup.manager.applyRelease(hooks(), plan)
    const before = profileMetadata(activeSetup.manager.paths.profile), count = calls(activeSetup.root).length
    for (const mutation of [
      { type: 'plugin-add' as const, spec: `${active.source.packageName}@2.0.0` },
      { type: 'plugin-install' as const, source: { schemaVersion: 1 as const, type: 'npmRegistry' as const, spec: `${active.source.packageName}@2.0.0` } },
      { type: 'plugin-update' as const, name: active.source.packageName, version: '2.0.0' },
      { type: 'plugin-remove' as const, name: active.source.packageName },
      { type: 'plugin-toggle' as const, name: active.source.packageName, enabled: false },
    ]) await expect(activeSetup.manager.mutate(mutation, hooks())).rejects.toThrow('leave active planned plugin')
    expect(profileMetadata(activeSetup.manager.paths.profile)).toEqual(before)
    expect(calls(activeSetup.root)).toHaveLength(count)

    const absentSetup = setup(), absent = pluginFixture('absent-optional')
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('optional unavailable'))
    await absentSetup.manager.applyRelease(hooks(), {
      schemaVersion: 2, mode: 'exact', plugins: [{
        required: false, source: absent.source, sourcePolicy: 'compatible-user-override',
      }],
    })
    await expect(absentSetup.manager.mutate({
      type: 'plugin-toggle', name: absent.source.packageName, enabled: false,
    }, hooks())).rejects.toThrow('is not installed')
  }, 30_000)

  it('restores only the planned source after target-runtime override health failure', async () => {
    const { root, manager } = setup()
    const planned = pluginFixture('required-provider')
    const overrideArchive = verifiedPluginArchive('required-provider', '2.0.0')
    const override = verifiedSource(overrideArchive, 'required-provider', '2.0.0')
    const sibling = pluginFixture('release-sibling')
    const unrelated = pluginFixture('unrelated-user')
    const fixtures = [planned, { archive: overrideArchive, source: override }, sibling, unrelated]
    mockVerifiedPlugins(fixtures)
    const plan = parseDesktopPluginProvisioningPlan({ schemaVersion: 2, mode: 'exact', plugins: [{
      required: true, source: planned.source, sourcePolicy: 'compatible-user-override',
    }, {
      required: true, source: sibling.source, sourcePolicy: 'strict-pin',
    }] })
    await manager.applyRelease(hooks(), plan)
    await manager.mutate({ type: 'plugin-install', source: override }, hooks())
    await manager.mutate({ type: 'plugin-install', source: unrelated.source }, hooks())
    const dsh = join(root, 'rejecting-runtime')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const next = trackedProjectManager(manager.paths, { ...manager.runtime, dsh })
    const rejectOverride = hooks({ healthCheck: async (projectDir) => {
      const manifest = JSON.parse(readFileSync(join(projectDir, 'node_modules', override.packageName, 'package.json'), 'utf8')) as { version: string }
      if (manifest.version === override.version) throw new Error('override runtime rejected')
    } })
    await expect(next.applyRelease(rejectOverride, plan)).rejects.toThrow('staged profile health failed while user override')
    expect(manager.listPlugins()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: override.packageName, version: override.version }),
      expect.objectContaining({ name: unrelated.source.packageName }),
    ]))
    const beforeRecovery = profileMetadata(manager.paths.profile)
    const siblingReceipt = receiptStore(manager).receipts[sibling.source.packageName]
    const siblingArtifact = readFileSync(join(manager.paths.profile, '.desktop-plugin-artifacts', `${sibling.source.sha256}.tgz`))
    mockVerifiedPlugins(fixtures)
    vi.mocked(globalThis.fetch).mockClear()
    await expect(next.restorePlannedSource(plan, planned.source.packageName, hooks({
      healthCheck: async () => { throw new Error('planned recovery health failed') },
    }))).rejects.toThrow('planned recovery health failed')
    expect(profileMetadata(manager.paths.profile)).toEqual(beforeRecovery)
    expect(receiptStore(manager).owners).toMatchObject({ 'required-provider': 'user', 'unrelated-user': 'user' })
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([input]) => new URL(input instanceof Request ? input.url : input).pathname.includes('/release-sibling/'))).toBe(false)
    mockVerifiedPlugins(fixtures)
    vi.mocked(globalThis.fetch).mockClear()
    await next.restorePlannedSource(plan, planned.source.packageName, hooks())
    expect(next.listPlugins()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: planned.source.packageName, version: planned.source.version }),
      expect.objectContaining({ name: sibling.source.packageName, version: sibling.source.version }),
      expect.objectContaining({ name: unrelated.source.packageName, version: unrelated.source.version }),
    ]))
    expect(receiptStore(next).owners).toMatchObject({
      'required-provider': 'release', 'release-sibling': 'release', 'unrelated-user': 'user',
    })
    expect(receiptStore(next).receipts[sibling.source.packageName]).toEqual(siblingReceipt)
    expect(readFileSync(join(next.paths.profile, '.desktop-plugin-artifacts', `${sibling.source.sha256}.tgz`))).toEqual(siblingArtifact)
    expect(vi.mocked(globalThis.fetch).mock.calls.some(([input]) => new URL(input instanceof Request ? input.url : input).pathname.includes('/release-sibling/'))).toBe(false)
  }, 30_000)

  it('does not select a targeted recovery when several overrides are active during health failure', async () => {
    const { root, manager } = setup()
    const planned = ['first-provider', 'second-provider'].map(name => pluginFixture(name))
    const overrides = planned.map((item) => {
      const archive = verifiedPluginArchive(item.source.packageName, '2.0.0')
      return { archive, source: verifiedSource(archive, item.source.packageName, '2.0.0') }
    })
    mockVerifiedPlugins([...planned, ...overrides])
    const plan = { schemaVersion: 2, mode: 'exact', plugins: planned.map(item => ({
      required: true, source: item.source, sourcePolicy: 'compatible-user-override',
    })) }
    await manager.applyRelease(hooks(), plan)
    for (const override of overrides) await manager.mutate({ type: 'plugin-install', source: override.source }, hooks())
    const dsh = join(root, 'multiple-override-runtime')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const next = trackedProjectManager(manager.paths, { ...manager.runtime, dsh })
    const failure = await next.applyRelease(
      hooks({ healthCheck: async () => { throw new Error('unrelated graph failure') } }), plan,
    ).then(() => undefined, (error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain('unrelated graph failure')
    expect((failure as Error).message).not.toContain('while user override')
    expect(failure).not.toHaveProperty('code')
  }, 30_000)

  // The release lane grants 90s for serial package children, rejected activation, rollback, retry and durable audit writes.
  it.each(['legacy', 'explicit'] as const)('retains off-plan user verified plugins during a runtime-mode exact-plan upgrade: %s ownership', async (ownership) => {
    const { root, manager } = setup()
    const fixtures = ['release-provider', 'manual-verified'].map((name) => {
      const archive = verifiedPluginArchive(name)
      return { archive, source: verifiedSource(archive, name) }
    })
    const release = fixtures[0]!
    const manual = fixtures[1]!
    const plan = parseDesktopPluginProvisioningPlan({
      schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: release.source }],
    })
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const fixture = fixtures.find(entry => url.pathname.includes(`/${entry.source.repo}/`))
      if (fixture === undefined) throw new Error(`unexpected request ${url}`)
      return verifiedFetch(fixture.source, fixture.archive)(input, init)
    }
    try {
      await manager.applyRelease(hooks(), plan)
      await manager.mutate({ type: 'plugin-install', source: manual.source }, hooks())
      await manager.mutate({ type: 'plugin-toggle', name: manual.source.packageName, enabled: false }, hooks())
      await manager.mutate({ type: 'plugin-add', spec: 'manual-registry@1.0.0' }, hooks())
      const receiptPath = join(manager.paths.profile, 'desktop-plugin-receipts.json')
      const store = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
        schemaVersion: number
        receipts: Record<string, unknown>
        owners?: Record<string, 'user' | 'release'>
      }
      // Old clients lack owner metadata; an ownership-aware predecessor records the same user intent explicitly.
      const { owners: _owners, ...legacy } = store
      writeFileSync(receiptPath, JSON.stringify(ownership === 'legacy' ? legacy : {
        ...legacy, owners: { 'release-provider': 'release', 'manual-verified': 'user' },
      }))
      const artifact = join('.desktop-plugin-artifacts', `${manual.source.sha256}.tgz`)
      const retainedFiles = ['package.json', 'desktop-plugin-receipts.json', 'desktop-plugin-provisioning-state.json', artifact]
        .map(path => ({ path, bytes: readFileSync(join(manager.paths.profile, path)) }))
      const previous = readDesktopProfileState(manager.paths.profile)
      expect(previous).toBeDefined()
      const dsh = join(root, 'next-runtime', 'dsh')
      runtimeFixture(dsh, '1.1.0')
      const next = trackedProjectManager(manager.paths, { ...manager.runtime, dsh, profileResolution: 'runtime' })
      let starts = 0
      await expect(next.applyRelease(hooks({ afterChange: async () => {
        if (++starts === 1) throw new Error('retention upgrade final activation rejected')
      } }), plan)).rejects.toThrow('retention upgrade final activation rejected')
      expect(readDesktopProfileState(manager.paths.profile)).toEqual(previous)
      for (const entry of retainedFiles) expect(readFileSync(join(manager.paths.profile, entry.path))).toEqual(entry.bytes)

      const beforeUpgrade = calls(root).length
      await expect(next.applyRelease(hooks(), plan)).resolves.toBe(true)
      expect(readDesktopProfileState(manager.paths.profile)?.runtimeId).not.toBe(previous?.runtimeId)
      expect(calls(root).length).toBeGreaterThan(beforeUpgrade)
      expect(next.listPlugins()).toEqual(expect.arrayContaining([
        expect.objectContaining({ name: 'manual-verified', enabled: false, source: manual.source }),
        expect.objectContaining({ name: 'manual-registry', enabled: true }),
        expect.objectContaining({ name: 'release-provider', enabled: true, source: release.source }),
      ]))
      const updated = JSON.parse(readFileSync(receiptPath, 'utf8')) as { receipts: Record<string, unknown> }
      expect(updated.receipts[manual.source.packageName]).toEqual(store.receipts[manual.source.packageName])
      expect(readFileSync(join(manager.paths.profile, artifact))).toEqual(manual.archive)
      assertDesktopProvisioningInventory(manager.paths.profile, plan)
      const beforeReuse = calls(root).length
      await expect(next.applyRelease(hooks(), plan)).resolves.toBe(false)
      expect(calls(root)).toHaveLength(beforeReuse)
      expect(calls(root).every(call => call.project !== manager.paths.profile)).toBe(true)
    } finally { globalThis.fetch = original }
  }, 90_000)

  it('isolates two required release acquisitions sharing SHA256SUMS', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const fixtures = ['first-plugin', 'second-plugin'].map((name) => {
      const archive = verifiedPluginArchive(name)
      return { archive, source: verifiedSource(archive, name) }
    })
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      const fixture = fixtures.find(entry => url.pathname.includes(`/${entry.source.repo}/`))
      if (fixture === undefined) throw new Error(`unexpected request ${url}`)
      return verifiedFetch(fixture.source, fixture.archive)(input, init)
    }
    try {
      await manager.reconcileProvisioning({
        schemaVersion: 1, mode: 'exact',
        plugins: fixtures.map(({ source }) => ({ required: true, source })),
      }, hooks())
      expect(manager.listPlugins().map(plugin => plugin.name)).toEqual(['first-plugin', 'second-plugin'])
    } finally { globalThis.fetch = original }
  })

  describe.each(['artifact-bytes', 'missing-package', 'missing-row', 'empty-extra'] as const)('repairs exact restart inventory after %s drift', (drift) => {
    let manager: DesktopProjectManager
    const archive = verifiedPluginArchive()
    const source = verifiedSource(archive)
    const plan = { schemaVersion: 1, mode: 'exact', plugins: drift === 'empty-extra' ? [] : [{ required: true, source }] }

    beforeEach(() => fixtureWork.track('drift setup', async () => {
      manager = setup().manager
      await manager.applyRelease()
      globalThis.fetch = verifiedFetch(source, archive)
      await manager.reconcileProvisioning(plan, hooks())
    }))

    it('restores the planned inventory', async () => {
      if (drift === 'artifact-bytes') {
        writeFileSync(join(manager.paths.profile, '.desktop-plugin-artifacts', `${source.sha256}.tgz`), 'replaced archive')
      } else if (drift === 'missing-package') {
        rmSync(join(manager.paths.profile, 'node_modules', source.packageName), { recursive: true })
      } else if (drift === 'empty-extra') {
        await manager.mutate({ type: 'plugin-install', source }, hooks())
      } else {
        const path = join(manager.paths.profile, 'desktop-plugin-provisioning-state.json')
        const state = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
        writeFileSync(path, JSON.stringify({ ...state, plugins: [] }))
      }
      const state = await manager.reconcileProvisioning(plan, hooks())
      if (drift === 'empty-extra') {
        expect(state.plugins).toEqual([])
        expect(state.removed).toEqual([])
        expect(manager.listPlugins()).toMatchObject([{ name: source.packageName, enabled: true, source }])
        expect(receiptStore(manager).owners?.[source.packageName]).toBe('user')
      } else {
        expect(state.plugins).toHaveLength(1)
        expect(manager.listPlugins()[0]?.source).toEqual(source)
        expect(receiptStore(manager).owners?.[source.packageName]).toBe('release')
      }
    })
  })

  it('lets explicit reconcile repair stale plan evidence while ordinary mutations remain fail-closed', async () => {
    const { manager } = setup()
    const fixture = pluginFixture('repair-provider')
    mockVerifiedPlugins([fixture])
    const plan = { schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: fixture.source }] }
    await manager.applyRelease(hooks(), plan)
    const path = join(manager.paths.profile, 'desktop-plugin-provisioning-state.json')
    const state = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
    writeFileSync(path, JSON.stringify({ ...state, plugins: [] }))
    const before = profileMetadata(manager.paths.profile)
    await expect(manager.mutate({
      type: 'plugin-toggle', name: fixture.source.packageName, enabled: true,
    }, hooks())).rejects.toThrow('active state plan evidence is inconsistent')
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
    await expect(manager.reconcileProvisioning(plan, hooks())).resolves.toMatchObject({
      plugins: [{ name: fixture.source.packageName, status: 'active' }],
    })
  })

  it('retains user verified plugins across exact reconciliation, runtime changes, empty plans and reuse', async () => {
    const { root, manager } = setup()
    const manual = pluginFixture('manual-verified')
    const baseline = pluginFixture('release-provider')
    mockVerifiedPlugins([manual, baseline])
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'manual-registry@1.0.0' }, hooks())
    await manager.mutate({ type: 'plugin-install', source: manual.source }, hooks())
    await manager.mutate({ type: 'plugin-toggle', name: manual.source.packageName, enabled: false }, hooks())
    const manualReceipt = receiptStore(manager).receipts[manual.source.packageName]
    const plan = { schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: baseline.source }] }
    await manager.reconcileProvisioning(plan, hooks())
    expect(receiptStore(manager).owners).toEqual({ 'manual-verified': 'user', 'release-provider': 'release' })
    expect(() => assertDesktopProvisioningInventory(manager.paths.profile, parseDesktopPluginProvisioningPlan(plan))).not.toThrow()
    const count = calls(root).length
    await manager.reconcileProvisioning(plan, hooks())
    expect(calls(root)).toHaveLength(count)
    const dsh = join(root, 'updated-runtime')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const next = trackedProjectManager(manager.paths, { ...manager.runtime, dsh })
    await next.applyRelease(hooks(), plan)
    const empty = { schemaVersion: 1, mode: 'exact', plugins: [] }
    const state = await next.reconcileProvisioning(empty, hooks())
    expect(state.removed).toEqual(['release-provider'])
    expect(next.listPlugins()).toMatchObject([
      { name: 'manual-registry', version: '1.0.0', enabled: true },
      { name: 'manual-verified', version: manual.source.version, enabled: false, source: manual.source },
    ])
    expect(receiptStore(next)).toMatchObject({ receipts: { 'manual-verified': manualReceipt }, owners: { 'manual-verified': 'user' } })
    expect(readFileSync(join(next.paths.profile, '.desktop-plugin-artifacts', `${manual.source.sha256}.tgz`))).toEqual(manual.archive)
    expect(() => assertDesktopProvisioningInventory(next.paths.profile, parseDesktopPluginProvisioningPlan(empty))).not.toThrow()
    const finalCount = calls(root).length
    await next.reconcileProvisioning(empty, hooks())
    expect(calls(root)).toHaveLength(finalCount)
    expect(calls(root).every(call => call.project !== manager.paths.profile)).toBe(true)
  }, 30_000)

  it('reuses an empty plan after a user installs a verified plugin', async () => {
    const { root, manager } = setup()
    const fixture = pluginFixture('manual-verified')
    mockVerifiedPlugins([fixture])
    const plan = { schemaVersion: 1, mode: 'exact', plugins: [] }
    await manager.applyRelease(hooks(), plan)
    await manager.mutate({ type: 'plugin-install', source: fixture.source }, hooks())
    const count = calls(root).length
    await manager.reconcileProvisioning(plan, hooks())
    expect(calls(root)).toHaveLength(count)
    expect(manager.listPlugins()[0]?.source).toEqual(fixture.source)
    expect(() => assertDesktopProvisioningInventory(manager.paths.profile, parseDesktopPluginProvisioningPlan(plan))).not.toThrow()
  })

  it.each(['matching', 'absent-state', 'incomplete-state', 'optional-failed', 'different-receipt'] as const)(
    'migrates legacy receipt ownership from %s evidence only in staging', async (evidence) => {
      const { manager } = setup()
      const baseline = pluginFixture('legacy-provider')
      const manual = pluginFixture('manual-verified')
      mockVerifiedPlugins([baseline, manual])
      const plan = { schemaVersion: 2, mode: 'exact', plugins: [{
        required: false, source: baseline.source, sourcePolicy: 'compatible-user-override',
      }] }
      await manager.applyRelease(hooks(), plan)
      await manager.mutate({ type: 'plugin-install', source: manual.source }, hooks())
      const statePath = join(manager.paths.profile, 'desktop-plugin-provisioning-state.json')
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>
      if (evidence === 'absent-state') unlinkSync(statePath)
      if (evidence === 'incomplete-state') writeFileSync(statePath, JSON.stringify({ ...state, plugins: [] }))
      if (evidence === 'optional-failed') writeFileSync(statePath, JSON.stringify({
        ...state,
        plugins: [{ name: baseline.source.packageName, required: false, requestedSource: baseline.source,
          sourcePolicy: 'compatible-user-override', status: 'optional-failed', phase: 'download', message: 'old optional failure' }],
      }))
      if (evidence === 'different-receipt') {
        const archive = verifiedPluginArchive(baseline.source.packageName, baseline.source.version, '>=1.0.0')
        const replacement = { archive, source: verifiedSource(archive, baseline.source.packageName, baseline.source.version) }
        mockVerifiedPlugins([replacement, manual])
        await manager.mutate({ type: 'plugin-install', source: replacement.source }, hooks())
      }
      const storePath = join(manager.paths.profile, 'desktop-plugin-receipts.json')
      const legacy = JSON.stringify({ schemaVersion: 1, receipts: receiptStore(manager).receipts })
      writeFileSync(storePath, legacy)
      expect(manager.listPlugins()).toHaveLength(2)
      expect(readFileSync(storePath, 'utf8')).toBe(legacy)
      const result = await manager.reconcileProvisioning({ schemaVersion: 1, mode: 'exact', plugins: [] }, hooks({
        healthCheck: async (staging) => {
          expect(staging).not.toBe(manager.paths.profile)
          expect(readFileSync(storePath, 'utf8')).toBe(legacy)
        },
      }))
      expect(result.removed).toEqual(evidence === 'matching' ? [baseline.source.packageName] : [])
      expect(manager.listPlugins().map(plugin => plugin.name)).toEqual(evidence === 'matching'
        ? ['manual-verified'] : ['legacy-provider', 'manual-verified'])
      expect(Object.values(receiptStore(manager).owners ?? {})).toEqual(evidence === 'matching' ? ['user'] : ['user', 'user'])
    }, 30_000,
  )

  it.each(['identical-verified', 'changed-verified'] as const)(
    'preserves a user %s replacement when the next plan drops its name', async (replacement) => {
      const { root, manager } = setup()
      const fixture = pluginFixture('release-provider')
      mockVerifiedPlugins([fixture])
      const plan = { schemaVersion: 2, mode: 'exact', plugins: [{
        required: true, source: fixture.source, sourcePolicy: 'compatible-user-override',
      }] }
      await manager.applyRelease(hooks(), plan)
      const archive = replacement === 'identical-verified' ? fixture.archive
        : verifiedPluginArchive(fixture.source.packageName, fixture.source.version, '>=1.0.0')
      const manual = { archive, source: verifiedSource(archive, fixture.source.packageName, fixture.source.version) }
      mockVerifiedPlugins([manual])
      await manager.mutate({ type: 'plugin-install', source: manual.source }, hooks())
      expect(receiptStore(manager).owners).toEqual({ 'release-provider': 'user' })
      if (replacement === 'identical-verified') {
        const count = calls(root).length
        await manager.reconcileProvisioning(plan, hooks())
        expect(calls(root)).toHaveLength(count)
        expect(receiptStore(manager).owners).toEqual({ 'release-provider': 'user' })
      }
      const result = await manager.reconcileProvisioning({ schemaVersion: 1, mode: 'exact', plugins: [] }, hooks())
      expect(result.removed).toEqual([])
      expect(manager.listPlugins()).toHaveLength(1)
      await manager.mutate({ type: 'plugin-remove', name: fixture.source.packageName }, hooks())
      expect(manager.listPlugins()).toEqual([])
      expect(receiptStore(manager)).toEqual({ schemaVersion: 1, receipts: {}, owners: {} })
    }, 30_000,
  )

  it.each([true, false])('preserves same-source user ownership through forced rebuilds with required=%s', async (required) => {
    const { root, manager } = setup()
    const first = pluginFixture('first-provider')
    const second = pluginFixture('second-provider')
    mockVerifiedPlugins([first, second])
    const original = { schemaVersion: 1, mode: 'exact', plugins: [{ required, source: first.source }] }
    await manager.applyRelease(hooks(), original)
    expect(receiptStore(manager).owners).toEqual({ 'first-provider': 'release' })
    await manager.mutate({ type: 'plugin-install', source: first.source }, hooks())
    expect(receiptStore(manager).owners).toEqual({ 'first-provider': 'user' })
    const dsh = join(root, 'next-runtime')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const next = trackedProjectManager(manager.paths, { ...manager.runtime, dsh })
    const beforeUpgrade = calls(root).length
    await next.applyRelease(hooks(), original)
    expect(calls(root).length).toBeGreaterThan(beforeUpgrade)
    expect(next.releaseVersion()).toBe('1.1.0')
    expect(receiptStore(next).owners).toEqual({ 'first-provider': 'user' })
    const expanded = { ...original, plugins: [...original.plugins, { required: true, source: second.source }] }
    const beforeExpansion = calls(root).length
    await next.reconcileProvisioning(expanded, hooks())
    expect(calls(root).length).toBeGreaterThan(beforeExpansion)
    expect(receiptStore(next).owners).toEqual({ 'first-provider': 'user', 'second-provider': 'release' })
    const remaining = { ...original, plugins: [{ required: true, source: second.source }] }
    const dropped = await next.reconcileProvisioning(remaining, hooks())
    expect(dropped.removed).toEqual([])
    expect(next.listPlugins().map(plugin => plugin.name)).toEqual(['first-provider', 'second-provider'])
    expect(receiptStore(next).owners).toEqual({ 'first-provider': 'user', 'second-provider': 'release' })
    expect(() => assertDesktopProvisioningInventory(next.paths.profile, parseDesktopPluginProvisioningPlan(remaining))).not.toThrow()
    const empty = await next.reconcileProvisioning({ ...original, plugins: [] }, hooks())
    expect(empty.removed).toEqual(['second-provider'])
    expect(next.listPlugins()).toMatchObject([{ name: first.source.packageName, source: first.source, enabled: true }])
    expect(receiptStore(next).owners).toEqual({ 'first-provider': 'user' })
    expect(readFileSync(join(next.paths.profile, '.desktop-plugin-artifacts', `${first.source.sha256}.tgz`))).toEqual(first.archive)
  }, 30_000)

  it('preserves an identical enabled user-owned source for an optional strict plan without acquisition', async () => {
    const { root, manager } = setup()
    const target = pluginFixture('optional-target')
    const manual = pluginFixture('manual-verified')
    mockVerifiedPlugins([target, manual])
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-install', source: target.source }, hooks())
    await manager.mutate({ type: 'plugin-install', source: manual.source }, hooks())
    const plan = { schemaVersion: 1, mode: 'exact', plugins: [{ required: false, source: target.source }] }
    const artifact = readFileSync(join(manager.paths.profile, '.desktop-plugin-artifacts', `${target.source.sha256}.tgz`))
    const acquisition = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('planned source must not be reacquired'))
    let healthChecks = 0
    const state = await manager.reconcileProvisioning(plan, hooks({
      healthCheck: async () => { healthChecks++ },
    }))
    expect(acquisition).not.toHaveBeenCalled()
    expect(healthChecks).toBeGreaterThan(0)
    expect(state.plugins).toMatchObject([{
      name: target.source.packageName, status: 'active', effective: 'plan',
    }])
    expect(receiptStore(manager).owners).toEqual({ 'manual-verified': 'user', 'optional-target': 'user' })
    expect(readFileSync(join(manager.paths.profile, '.desktop-plugin-artifacts', `${target.source.sha256}.tgz`))).toEqual(artifact)
    expect(manager.listPlugins().map(plugin => plugin.name)).toEqual(['manual-verified', 'optional-target'])
    const count = calls(root).length
    await manager.reconcileProvisioning(plan, hooks())
    expect(calls(root)).toHaveLength(count)
    expect(() => assertDesktopProvisioningInventory(manager.paths.profile, parseDesktopPluginProvisioningPlan(plan))).not.toThrow()
  }, 30_000)

  it('rejects malformed legacy ownership evidence without changing the active profile', async () => {
    const { root, manager } = setup()
    const fixture = pluginFixture('manual-verified')
    mockVerifiedPlugins([fixture])
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-install', source: fixture.source }, hooks())
    const path = join(manager.paths.profile, 'desktop-plugin-receipts.json')
    const legacy = JSON.stringify({ schemaVersion: 1, receipts: receiptStore(manager).receipts })
    writeFileSync(path, legacy)
    writeFileSync(join(manager.paths.profile, 'desktop-plugin-provisioning-state.json'), '{"schemaVersion":99}')
    const count = calls(root).length
    await expect(manager.mutate({ type: 'plugin-toggle', name: fixture.source.packageName, enabled: false }, hooks())).rejects.toThrow('invalid state')
    expect(calls(root)).toHaveLength(count)
    expect(readFileSync(path, 'utf8')).toBe(legacy)
  })

  it.each(['required-health', 'final-activation'] as const)('rolls back legacy ownership migration after %s failure', async (failure) => {
    const { manager } = setup()
    const manual = pluginFixture('manual-verified')
    const baseline = pluginFixture('release-provider')
    mockVerifiedPlugins([manual, baseline])
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-install', source: manual.source }, hooks())
    const storePath = join(manager.paths.profile, 'desktop-plugin-receipts.json')
    const legacy = JSON.stringify({ schemaVersion: 1, receipts: receiptStore(manager).receipts })
    writeFileSync(storePath, legacy)
    const manifest = readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')
    const lock = readFileSync(join(manager.paths.profile, 'pnpm-lock.yaml'), 'utf8')
    let starts = 0
    await expect(manager.reconcileProvisioning({ schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: baseline.source }] }, hooks({
      healthCheck: async () => { if (failure === 'required-health') throw new Error('ownership health failure') },
      afterChange: async () => { if (++starts === 1 && failure === 'final-activation') throw new Error('ownership activation failure') },
    }))).rejects.toThrow(/ownership/u)
    expect(readFileSync(storePath, 'utf8')).toBe(legacy)
    expect(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')).toBe(manifest)
    expect(readFileSync(join(manager.paths.profile, 'pnpm-lock.yaml'), 'utf8')).toBe(lock)
    expect(readFileSync(join(manager.paths.profile, '.desktop-plugin-artifacts', `${manual.source.sha256}.tgz`))).toEqual(manual.archive)
    expect(existsSync(join(manager.paths.profile, 'desktop-plugin-provisioning-state.json'))).toBe(false)
    expect(manager.listPlugins().map(plugin => plugin.name)).toEqual(['manual-verified'])
  })

  it.each(['null', 'array', 'missing', 'extra', 'unknown-owner', 'unknown-field', 'receipt-array'] as const)(
    'rejects malformed private receipt ownership: %s', async (damage) => {
      const { root, manager } = setup()
      const fixture = pluginFixture('manual-verified')
      mockVerifiedPlugins([fixture])
      await manager.applyRelease()
      await manager.mutate({ type: 'plugin-install', source: fixture.source }, hooks())
      const store = receiptStore(manager)
      const malformed = {
        ...store,
        owners: damage === 'null' ? null : damage === 'array' ? [] : damage === 'missing' ? {}
          : damage === 'extra' ? { ...store.owners, extra: 'user' }
            : damage === 'unknown-owner' ? { 'manual-verified': 'automatic' } : store.owners,
        ...(damage === 'unknown-field' ? { unexpected: true } : {}),
        ...(damage === 'receipt-array' ? { receipts: [] } : {}),
      }
      const path = join(manager.paths.profile, 'desktop-plugin-receipts.json')
      writeFileSync(path, JSON.stringify(malformed))
      const count = calls(root).length
      const beforeChange = vi.fn(async () => {})
      await expect(manager.mutate({ type: 'plugin-toggle', name: fixture.source.packageName, enabled: false }, hooks({ beforeChange }))).rejects.toThrow(/receipt/u)
      expect(beforeChange).not.toHaveBeenCalled()
      expect(calls(root)).toHaveLength(count)
      expect(readFileSync(path, 'utf8')).toBe(JSON.stringify(malformed))
    },
  )

  it('distinguishes extra release ownership from user inventory and allows explicit reinstall after removal', async () => {
    const { root, manager } = setup()
    const fixture = pluginFixture('release-provider')
    mockVerifiedPlugins([fixture])
    const plan = { schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: fixture.source }] }
    await manager.applyRelease(hooks(), plan)
    const empty = { schemaVersion: 1, mode: 'exact', plugins: [] }
    const removed = await manager.reconcileProvisioning(empty, hooks())
    expect(removed.removed).toEqual([fixture.source.packageName])
    await manager.mutate({ type: 'plugin-install', source: fixture.source }, hooks())
    expect(() => assertDesktopProvisioningInventory(manager.paths.profile, parseDesktopPluginProvisioningPlan(empty))).not.toThrow()
    const count = calls(root).length
    await manager.reconcileProvisioning(empty, hooks())
    expect(calls(root)).toHaveLength(count)
    const store = receiptStore(manager)
    writeFileSync(join(manager.paths.profile, 'desktop-plugin-receipts.json'), JSON.stringify({
      ...store, owners: { [fixture.source.packageName]: 'release' },
    }))
    expect(() => assertDesktopProvisioningInventory(manager.paths.profile, parseDesktopPluginProvisioningPlan(empty))).toThrow('active inventory')
    const repaired = await manager.reconcileProvisioning(empty, hooks())
    expect(repaired.removed).toEqual([fixture.source.packageName])
    expect(manager.listPlugins()).toEqual([])
  })

  it.each((['download', 'validation', 'install', 'graph', 'health'] as const).flatMap(phase =>
    [false, true].map(required => ({ phase, required })),
  ))('handles $phase failure with required=$required without a successful receipt', async ({ phase, required }) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'manual-plugin@1.0.0' }, hooks())
    const archive = verifiedPluginArchive()
    const source = verifiedSource(archive)
    const optionalArchive = verifiedPluginArchive('optional-plugin', '0.4.0-alpha.18', phase === 'graph' ? '^9.0.0' : '^1.0.0')
    const optional = verifiedSource(optionalArchive, 'optional-plugin')
    const validArchive = verifiedPluginArchive('valid-optional')
    const validOptional = verifiedSource(validArchive, 'valid-optional')
    if (phase === 'install') writeFileSync(join(root, 'fail-package'), optional.packageName)
    const original = globalThis.fetch
    globalThis.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input)
      if (url.pathname.includes('/optional-plugin/')) {
        if (phase === 'download') throw new Error('optional download unavailable')
        if (phase === 'validation' && url.pathname.includes('/releases/tags/')) {
          return Response.json({ draft: false, immutable: false })
        }
        return verifiedFetch(optional, optionalArchive)(input, init)
      }
      if (url.pathname.includes('/valid-optional/')) return verifiedFetch(validOptional, validArchive)(input, init)
      return verifiedFetch(source, archive)(input, init)
    }
    try {
      const pending = manager.reconcileProvisioning({
        schemaVersion: 1, mode: 'exact',
        plugins: [{ required: true, source }, { required, source: optional }, { required: false, source: validOptional }],
      }, hooks({ healthCheck: async (projectDir) => {
        const manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
          dsh: { profile: { bundles: string[] } }
        }
        expect(manifest.dsh.profile.bundles).toContain(source.packageName)
        if (phase === 'health' && manifest.dsh.profile.bundles.includes(optional.packageName)) throw new Error('optional health failed')
      } }))
      if (required) {
        await expect(pending).rejects.toThrow()
        expect(manager.listPlugins()).toEqual([{ name: 'manual-plugin', version: '1.0.0', enabled: true }])
        expect(existsSync(join(manager.paths.profile, 'desktop-plugin-provisioning-state.json'))).toBe(false)
        return
      }
      const state = await pending
      expect(state.plugins).toMatchObject([
        { name: source.packageName, status: 'active' },
        { name: optional.packageName, status: 'optional-failed', phase },
        { name: validOptional.packageName, status: 'active' },
      ])
      const optionalFailure = state.plugins[1]
      if (optionalFailure?.status !== 'optional-failed') throw new Error('expected optional failure result')
      expect(optionalFailure.message).toBeTypeOf('string')
      expect(optionalFailure).not.toHaveProperty('receipt')
      expect(manager.listPlugins().map(plugin => plugin.name)).toEqual([source.packageName, 'manual-plugin', validOptional.packageName])
    } finally { globalThis.fetch = original }
  })

  it('stages a Node upgrade without running pnpm in the active profile', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'manual-plugin@1.0.0' }, hooks())
    const dsh = join(root, 'new-runtime')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const next = trackedProjectManager(manager.paths, { ...manager.runtime, dsh })
    await next.applyRelease()
    expect(calls(root).every(call => call.project !== manager.paths.profile)).toBe(true)
  })

  it('does not copy private node_modules into a toggle transaction', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'manual-plugin@1.0.0' }, hooks())
    writeFileSync(join(manager.paths.profile, 'node_modules', 'private-sentinel'), 'must not be copied')
    await manager.mutate({ type: 'plugin-toggle', name: 'manual-plugin', enabled: false }, hooks({
      healthCheck: async (projectDir) => {
        expect(existsSync(join(projectDir, 'node_modules', 'private-sentinel'))).toBe(false)
      },
    }))
  })

  it.each(['remove', 'replace'] as const)('reconciles an incompatible old plugin before validating a changed Host: %s', async (operation) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const archive = verifiedPluginArchive()
    const source = verifiedSource(archive)
    const original = globalThis.fetch
    globalThis.fetch = verifiedFetch(source, archive)
    try {
      await manager.reconcileProvisioning({ schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source }] }, hooks())
      const dsh = join(root, 'next-major')
      runtimeFixture(dsh, '2.0.0')
      const next = trackedProjectManager(manager.paths, { ...manager.runtime, dsh })
      const replacementArchive = verifiedPluginArchive(source.packageName, '1.0.0', '^2.0.0')
      const replacement = verifiedSource(replacementArchive, source.packageName, '1.0.0')
      globalThis.fetch = verifiedFetch(replacement, replacementArchive)
      await next.applyRelease(hooks(), {
        schemaVersion: 1, mode: 'exact', plugins: operation === 'remove' ? [] : [{ required: true, source: replacement }],
      })
      if (operation === 'remove') expect(next.listPlugins()).toEqual([])
      else expect(next.listPlugins()).toMatchObject([{ name: source.packageName, version: '1.0.0', enabled: true, source: replacement }])
      expect(next.releaseVersion()).toBe('2.0.0')
    } finally { globalThis.fetch = original }
  })

  it('restores the previous runtime when staging succeeds but final activation fails', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const dsh = join(root, 'new-runtime')
    runtimeFixture(dsh, '1.1.0')
    const next = trackedProjectManager(manager.paths, { ...manager.runtime, dsh })
    let starts = 0
    await expect(next.applyRelease(hooks({
      afterChange: async () => {
        if (++starts === 1) throw new Error('final-location Host failed')
      },
    }), { schemaVersion: 1, mode: 'exact', plugins: [] })).rejects.toThrow('final-location Host failed')
    expect(next.releaseVersion()).toBe('1.0.0')
    expect(starts).toBe(2)
  })

  it('retains the recoverable old profile when rollback rename fails', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    writeFileSync(join(manager.paths.profile, 'old-profile-sentinel'), 'recover me')
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    vi.mocked(fs.renameSync).mockImplementation((from, to) => {
      if (String(from).endsWith('rollback')) throw new Error('rollback rename denied')
      actual.renameSync(from, to)
    })
    await expect(manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks({
      afterChange: async () => { throw new Error('final Host failed') },
    }))).rejects.toThrow('activation and rollback failed')
    const parent = join(root, '.dsh', 'profiles')
    const transaction = readdirSync(parent).find(name => name.startsWith('.desktop-transaction-'))
    expect(transaction).toBeDefined()
    expect(readFileSync(join(parent, transaction!, 'rollback', 'old-profile-sentinel'), 'utf8')).toBe('recover me')
    vi.mocked(fs.renameSync).mockReset()
    await manager.applyRelease()
    expect(readFileSync(join(manager.paths.profile, 'old-profile-sentinel'), 'utf8')).toBe('recover me')
    expect(manager.listPlugins()).toEqual([])
  })

  it.each(['old-moved', 'new-activated'] as const)('retains recoverable evidence for interrupted directory activation: %s', async (phase) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    writeFileSync(join(manager.paths.profile, 'old-profile-sentinel'), 'recover me')
    const transaction = mkdtempSync(join(root, '.dsh', 'profiles', '.desktop-transaction-'))
    fs.renameSync(manager.paths.profile, join(transaction, 'rollback'))
    if (phase === 'new-activated') {
      mkdirSync(manager.paths.profile)
      writeFileSync(join(manager.paths.profile, 'unverified-new-profile'), 'not ready')
    }
    writeFileSync(join(manager.paths.root, 'profile-activation.json'), JSON.stringify({
      schemaVersion: 1, transaction: transaction.split(/[\\/]/u).at(-1), phase: 'activating',
    }))
    if (phase === 'new-activated') {
      await expect(manager.applyRelease()).rejects.toThrow('candidate metadata is incomplete')
      expect(readFileSync(join(transaction, 'rollback', 'old-profile-sentinel'), 'utf8')).toBe('recover me')
      expect(readFileSync(join(manager.paths.profile, 'unverified-new-profile'), 'utf8')).toBe('not ready')
      expect(existsSync(join(manager.paths.root, 'profile-activation.json'))).toBe(true)
    } else {
      await manager.applyRelease()
      expect(readFileSync(join(manager.paths.profile, 'old-profile-sentinel'), 'utf8')).toBe('recover me')
      expect(existsSync(transaction)).toBe(false)
    }
  })

  it.each(['activating', 'committed'] as const)('keeps both profiles when legacy %s recovery would shrink manual inventory', async (phase) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'manual-plugin@1.0.0' }, hooks())
    const transaction = mkdtempSync(join(root, '.dsh', 'profiles', '.desktop-transaction-'))
    const rollback = join(transaction, 'rollback')
    fs.cpSync(manager.paths.profile, rollback, { recursive: true, verbatimSymlinks: true })
    const smaller = phase === 'activating' ? rollback : manager.paths.profile
    const manifestPath = join(smaller, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
    delete manifest.dependencies['manual-plugin']
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== 'manual-plugin')
    writeFileSync(manifestPath, JSON.stringify(manifest))
    const activeBefore = profileMetadata(manager.paths.profile), rollbackBefore = profileMetadata(rollback)
    const journal = join(manager.paths.root, 'profile-activation.json')
    writeFileSync(journal, JSON.stringify({ schemaVersion: 1, transaction: transaction.split(/[\\/]/u).at(-1), phase }))
    await expect(manager.applyRelease()).rejects.toThrow('legacy recovery user inventories differ')
    expect(profileMetadata(manager.paths.profile)).toEqual(activeBefore)
    expect(profileMetadata(rollback)).toEqual(rollbackBefore)
    expect(existsSync(journal)).toBe(true)
  })

  it.each(['desktop-runtime-state.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml'])(
    'retains a complete rollback when committed legacy active lacks %s', async (missing) => {
      const { root, manager } = setup()
      await manager.applyRelease()
      await manager.mutate({ type: 'plugin-add', spec: 'manual-plugin@1.0.0' }, hooks())
      const transaction = mkdtempSync(join(root, '.dsh', 'profiles', '.desktop-transaction-'))
      const rollback = join(transaction, 'rollback')
      fs.cpSync(manager.paths.profile, rollback, { recursive: true, verbatimSymlinks: true })
      const rollbackBefore = profileMetadata(rollback)
      unlinkSync(join(manager.paths.profile, missing))
      const activeBefore = profileMetadata(manager.paths.profile)
      const journal = join(manager.paths.root, 'profile-activation.json')
      writeFileSync(journal, JSON.stringify({ schemaVersion: 1, transaction: transaction.split(/[\\/]/u).at(-1), phase: 'committed' }))
      await expect(manager.applyRelease()).rejects.toThrow('legacy recovery metadata is incomplete')
      expect(profileMetadata(manager.paths.profile)).toEqual(activeBefore)
      expect(profileMetadata(rollback)).toEqual(rollbackBefore)
      expect(existsSync(journal)).toBe(true)
    },
  )

  it('does not truncate an old journal temporary hardlinked to active metadata', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const manifest = join(manager.paths.profile, 'package.json')
    const original = readFileSync(manifest)
    const oldTemporary = join(manager.paths.root, 'profile-activation.json.tmp')
    fs.linkSync(manifest, oldTemporary)
    await manager.mutate({ type: 'plugin-add', spec: 'new-plugin@1.0.0' }, hooks())
    expect(readFileSync(oldTemporary)).toEqual(original)
    expect(manager.listPlugins()).toEqual([{ name: 'new-plugin', version: '1.0.0', enabled: true }])
    expect(existsSync(join(manager.paths.root, 'profile-activation.json'))).toBe(false)
  })

  it('does not initialize an empty active path over an orphan rollback', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'manual-plugin@1.0.0' }, hooks())
    const before = profileMetadata(manager.paths.profile)
    const transaction = mkdtempSync(join(root, '.dsh', 'profiles', '.desktop-transaction-'))
    fs.renameSync(manager.paths.profile, join(transaction, 'rollback'))
    const count = calls(root).length
    await expect(manager.applyRelease()).rejects.toThrow('orphan rollback prevents profile initialization')
    expect(profileMetadata(join(transaction, 'rollback'))).toEqual(before)
    expect(existsSync(join(manager.paths.profile, 'package.json'))).toBe(false)
    expect(calls(root)).toHaveLength(count)
  })

  it('reuses a healthy active profile without deleting an orphan staging directory', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const transaction = mkdtempSync(join(root, '.dsh', 'profiles', '.desktop-transaction-'))
    mkdirSync(join(transaction, 'staging'))
    writeFileSync(join(transaction, 'staging', 'sentinel'), 'inspect separately')
    await expect(manager.applyRelease()).resolves.toBe(false)
    expect(readFileSync(join(transaction, 'staging', 'sentinel'), 'utf8')).toBe('inspect separately')
  })

  it.each(['intact', 'shrunk'] as const)('checks committed versioned inventory before cleanup: %s', async (state) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'manual-plugin@1.0.0' }, hooks())
    const before = profileMetadata(manager.paths.profile)
    const actualRecord = operationAudit.recordDesktopProfileOperation
    const audit = vi.spyOn(operationAudit, 'recordDesktopProfileOperation').mockImplementation((directory, record) => {
      if (record.outcome === 'committed') throw new Error('committed audit unavailable')
      return actualRecord(directory, record)
    })
    await expect(manager.mutate({ type: 'plugin-add', spec: 'new-plugin@1.0.0' }, hooks())).rejects.toThrow('committed audit unavailable')
    expect(audit.mock.calls.map(([, record]) => record.outcome)).toEqual(['started', 'committed'])
    expect(manager.listPlugins().map(plugin => plugin.name)).toEqual(['manual-plugin', 'new-plugin'])
    audit.mockRestore()
    const journalPath = join(manager.paths.root, 'profile-activation.json')
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { schemaVersion: number; transaction: string; phase: string; before: { sha256: string; names: string[] }; after: { sha256: string; names: string[] } }
    expect(journal).toMatchObject({ schemaVersion: 2, phase: 'committed', before: { names: ['manual-plugin'] }, after: { names: ['manual-plugin', 'new-plugin'] } })
    const transaction = join(root, '.dsh', 'profiles', journal.transaction)
    expect(profileMetadata(join(transaction, 'rollback'))).toEqual(before)
    if (state === 'shrunk') {
      const path = join(manager.paths.profile, 'package.json')
      const manifest = JSON.parse(readFileSync(path, 'utf8')) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
      delete manifest.dependencies['manual-plugin']
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(name => name !== 'manual-plugin')
      writeFileSync(path, JSON.stringify(manifest))
      const damaged = profileMetadata(manager.paths.profile)
      await expect(manager.applyRelease()).rejects.toThrow('recovery inventory mismatch')
      expect(profileMetadata(manager.paths.profile)).toEqual(damaged)
      expect(profileMetadata(join(transaction, 'rollback'))).toEqual(before)
      expect(existsSync(journalPath)).toBe(true)
    } else {
      await manager.applyRelease()
      expect(manager.listPlugins().map(plugin => plugin.name)).toEqual(['manual-plugin', 'new-plugin'])
      expect(existsSync(journalPath)).toBe(false)
      expect(existsSync(transaction)).toBe(false)
    }
  })

  it.each(['plugin-remove', 'plugin-update', 'plugin-toggle'] as const)('rejects invalid %s names before recording any input', async (operation) => {
    const { manager } = setup()
    await manager.applyRelease()
    const directory = join(manager.paths.root, 'profile-operations')
    const names = readdirSync(directory).sort(), before = profileMetadata(manager.paths.profile)
    const name = 'https://example.invalid/private?token=secret'
    const mutation = operation === 'plugin-update' ? { type: operation, name, version: '1.0.0' }
      : operation === 'plugin-toggle' ? { type: operation, name, enabled: false }
        : { type: operation, name }
    await expect(manager.mutate(mutation, hooks())).rejects.toThrow('invalid npm package name')
    expect(readdirSync(directory).sort()).toEqual(names)
    const records = names.map(file => readFileSync(join(directory, file), 'utf8')).join('')
    expect(records).not.toContain('example.invalid')
    expect(records).not.toContain('token=secret')
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
  })

  it('retains private operation receipts after commit and failure without source text', async () => {
    const { manager } = setup()
    const fixture = pluginFixture('manual-verified')
    mockVerifiedPlugins([fixture])
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-install', source: fixture.source }, hooks())
    await expect(manager.mutate({ type: 'plugin-add', spec: 'other@1.0.0' }, hooks({ healthCheck: async () => { throw new Error('health failure with private source text') } })))
      .rejects.toThrow('health failure')
    const directory = join(manager.paths.root, 'profile-operations')
    const texts = readdirSync(directory).filter(name => name.endsWith('.json')).map(name => readFileSync(join(directory, name), 'utf8'))
    const records = texts.map(text => JSON.parse(text) as operationAudit.DesktopProfileOperationRecord)
    const committed = records.find(record => record.operation === 'plugin-install' && record.outcome === 'committed')
    expect(committed).toMatchObject({ target: fixture.source.packageName, after: { names: [fixture.source.packageName] } })
    const failed = records.find(record => record.operation === 'plugin-add' && record.target === 'other' && record.outcome === 'failed')
    expect(failed).toMatchObject({ before: { names: [fixture.source.packageName] }, after: { names: [fixture.source.packageName] } })
    expect(records.filter(record => record.transaction === failed?.transaction).map(record => record.outcome).sort())
      .toEqual(['failed', 'started'])
    expect(texts.join('')).not.toMatch(/github\.com|dependencyRegistry|health failure with private source text/u)
    expect(existsSync(join(manager.paths.root, 'profile-activation.json'))).toBe(false)
  })

  it('rolls back when final Host readiness leaves required receipts missing', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const archive = verifiedPluginArchive()
    const source = verifiedSource(archive)
    const original = globalThis.fetch
    globalThis.fetch = verifiedFetch(source, archive)
    let starts = 0
    try {
      await expect(manager.reconcileProvisioning({
        schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source }],
      }, hooks({ afterChange: async () => {
        if (++starts === 1) unlinkSync(join(manager.paths.profile, 'desktop-plugin-receipts.json'))
      } }))).rejects.toThrow(/locked local artifacts/u)
      expect(manager.listPlugins()).toEqual([])
      expect(starts).toBe(2)
    } finally { globalThis.fetch = original }
  })

  it.each(['../outside', '.desktop-transaction-invalid/path'])('rejects an unconfined recovery transaction: %s', async (transaction) => {
    const { manager } = setup()
    await manager.applyRelease()
    writeFileSync(join(manager.paths.root, 'profile-activation.json'), JSON.stringify({
      schemaVersion: 1, transaction, phase: 'activating',
    }))
    await expect(manager.applyRelease()).rejects.toThrow('invalid profile activation recovery journal')
    expect(manager.releaseVersion()).toBe('1.0.0')
  })

  it('reuses unchanged profiles and reconstructs damaged plugins when disabling or resetting them', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const manifest = join(manager.paths.profile, 'node_modules/plugin/package.json')
    writeFileSync(manifest, '{broken')
    await expect(manager.applyRelease()).resolves.toBe(false)
    await manager.mutate({ type: 'plugins-disable-all' }, hooks())
    await expect(manager.applyRelease()).resolves.toBe(false)
    expect(JSON.parse(readFileSync(manifest, 'utf8'))).toMatchObject({ name: 'plugin', version: '1.0.0' })
    await manager.resetConfiguration(hooks())
    expect(existsSync(manifest)).toBe(false)
    await expect(manager.applyRelease()).resolves.toBe(false)
  })

  it('disables every third-party bundle without reading a broken plugin patch declaration', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const patch = join(manager.paths.profile, 'node_modules/plugin/bundle.yml')
    unlinkSync(patch)
    await manager.mutate({ type: 'plugins-disable-all' }, hooks({ afterChange: async () => {
      expect((JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')) as {
        dsh: { profile: { bundles: string[] } }
      }).dsh.profile.bundles).not.toContain('plugin')
    } }))
    expect((JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')) as {
      dsh: { profile: { bundles: string[] } }
    }).dsh.profile.bundles).not.toContain('plugin')
    expect(existsSync(join(manager.paths.profile, 'node_modules/plugin/package.json'))).toBe(true)
    expect(calls(root)).toHaveLength(4)
    await expect(manager.applyRelease()).resolves.toBe(false)
  })

  it('retains a verified recovery copy before resetting the profile and shared data stays untouched', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const profile = manager.paths.profile
    expect(manager.paths.lock).toBe(join(root, '.dsh', 'desktop', 'profile.lock'))
    const task = join(root, '.dsh', 'task-sentinel')
    const homeEnvironment = join(root, '.dsh', '.env')
    writeFileSync(homeEnvironment, 'HOME_SETTING=retained')
    writeFileSync(task, 'retained task')
    writeFileSync(join(profile, 'desktop-runtime-state.json'), '{broken')
    writeFileSync(join(profile, 'cordis.patch.yml'), ': broken')
    writeFileSync(join(profile, '.env'), 'NODE_OPTIONS=--bad')
    mkdirSync(join(profile, '.extra'))
    writeFileSync(join(profile, '.extra', 'custom-file'), 'remove')
    const shared = join(root, 'shared-data')
    mkdirSync(shared)
    writeFileSync(join(shared, 'sentinel'), 'preserve')
    await expect(manager.applyRelease()).rejects.toThrow()
    await manager.resetConfiguration(hooks({
      beforeChange: async () => { expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toBe(': broken') },
      afterChange: async () => {
        manager.assertProfileRuntime(profile)
        expect(readFileSync(manager.paths.lock, 'utf8').trim()).toBe(String(process.pid))
        await expect(manager.applyRelease()).rejects.toThrow('another package transaction is active')
      },
    }))
    expect(manager.listPlugins()).toEqual([])
    expect(existsSync(join(profile, 'node_modules/plugin'))).toBe(false)
    expect(existsSync(join(profile, 'cordis.patch.yml'))).toBe(false)
    expect(existsSync(join(profile, '.env'))).toBe(false)
    expect(existsSync(join(profile, '.extra'))).toBe(false)
    const recoveryRoot = join(manager.paths.root, 'profile-recovery')
    const copies = readdirSync(recoveryRoot).filter(name => name.startsWith('reset-'))
    expect(copies).toHaveLength(1)
    const copy = join(recoveryRoot, copies[0]!)
    expect(JSON.parse(readFileSync(join(copy, 'receipt.json'), 'utf8'))).toMatchObject({ state: 'copy-complete', excludedDirectory: 'node_modules' })
    expect(JSON.parse(readFileSync(join(copy, 'outcome.json'), 'utf8'))).toMatchObject({ outcome: 'completed' })
    expect(readFileSync(join(copy, 'profile', 'desktop-runtime-state.json'), 'utf8')).toBe('{broken')
    expect(readFileSync(join(copy, 'profile', 'cordis.patch.yml'), 'utf8')).toBe(': broken')
    expect(readFileSync(join(copy, 'profile', '.env'), 'utf8')).toBe('NODE_OPTIONS=--bad')
    expect(readFileSync(join(copy, 'profile', '.extra', 'custom-file'), 'utf8')).toBe('remove')
    expect(existsSync(join(copy, 'profile', 'node_modules'))).toBe(false)
    expect(readFileSync(join(shared, 'sentinel'), 'utf8')).toBe('preserve')
    expect(readFileSync(task, 'utf8')).toBe('retained task')
    expect(readFileSync(homeEnvironment, 'utf8')).toBe('HOME_SETTING=retained')
    expect(readdirSync(profile).some(name => name.includes('backup'))).toBe(false)
    expect(calls(root)).toHaveLength(2)
    await expect(manager.applyRelease()).resolves.toBe(false)
    expect(existsSync(homeEnvironment)).toBe(true)
  })

  it('refuses reset for linked configuration and restarts the unchanged profile', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const external = join(root, 'linked-settings')
    mkdirSync(external)
    writeFileSync(join(external, 'sentinel'), 'unchanged')
    const link = join(manager.paths.profile, 'external-link')
    symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir')
    const before = profileMetadata(manager.paths.profile)
    const afterChange = vi.fn(async () => {})
    await expect(manager.resetConfiguration(hooks({ afterChange }))).rejects.toThrow('linked configuration requires manual recovery')
    expect(afterChange).toHaveBeenCalledOnce()
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
    expect(fs.lstatSync(link).isSymbolicLink()).toBe(true)
    expect(readFileSync(join(external, 'sentinel'), 'utf8')).toBe('unchanged')
  })

  it('does not reset after recovery copying fails and restarts the prior Host', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const before = profileMetadata(manager.paths.profile)
    const afterChange = vi.fn(async () => {})
    vi.spyOn(recoveryCopy, 'createDesktopProfileRecoveryCopy').mockImplementation(() => { throw new Error('copy unavailable') })
    await expect(manager.resetConfiguration(hooks({ afterChange }))).rejects.toThrow('copy unavailable')
    expect(afterChange).toHaveBeenCalledOnce()
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
    expect(existsSync(manager.paths.lock)).toBe(false)
  })

  it('reports reset copy failure together with a failed prior Host restart', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const before = profileMetadata(manager.paths.profile)
    vi.spyOn(recoveryCopy, 'createDesktopProfileRecoveryCopy').mockImplementation(() => { throw new Error('copy unavailable') })
    await expect(manager.resetConfiguration(hooks({ afterChange: async () => { throw new Error('restart unavailable') } })))
      .rejects.toMatchObject({ errors: [{ message: 'copy unavailable' }, { message: 'restart unavailable' }] })
    expect(profileMetadata(manager.paths.profile)).toEqual(before)
  })

  it('records a failed reset after final Host readiness fails and retains the recovery copy', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'manual-plugin@1.0.0' }, hooks())
    await expect(manager.resetConfiguration(hooks({ afterChange: async () => { throw new Error('reset Host failed') } })))
      .rejects.toThrow('reset Host failed')
    const parent = join(manager.paths.root, 'profile-recovery')
    const directory = join(parent, readdirSync(parent).find(name => name.startsWith('reset-'))!)
    expect(JSON.parse(readFileSync(join(directory, 'outcome.json'), 'utf8'))).toMatchObject({ outcome: 'failed' })
    expect(JSON.parse(readFileSync(join(directory, 'profile', 'package.json'), 'utf8'))).toMatchObject({ dependencies: { 'manual-plugin': '1.0.0' } })
    expect(existsSync(join(directory, 'receipt.json'))).toBe(true)
  })

  it('does not rewrite a completed reset outcome as failed when recording fails', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const record = vi.spyOn(recoveryCopy, 'recordDesktopProfileRecoveryOutcome').mockImplementation(() => { throw new Error('outcome unavailable') })
    const afterChange = vi.fn(async () => {})
    await expect(manager.resetConfiguration(hooks({ afterChange }))).rejects.toThrow('outcome unavailable')
    expect(afterChange).toHaveBeenCalledOnce()
    expect(record).toHaveBeenCalledOnce()
    expect(record.mock.calls[0]?.[1]).toBe('completed')
    expect(existsSync(join(record.mock.calls[0]![0].directory, 'receipt.json'))).toBe(true)
  })

  it('reports reset failure together with a failed outcome write', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const record = vi.spyOn(recoveryCopy, 'recordDesktopProfileRecoveryOutcome').mockImplementation(() => { throw new Error('outcome unavailable') })
    await expect(manager.resetConfiguration(hooks({ afterChange: async () => { throw new Error('reset Host failed') } })))
      .rejects.toMatchObject({ errors: [{ message: 'reset Host failed' }, { message: 'outcome unavailable' }] })
    expect(record).toHaveBeenCalledOnce()
    expect(record.mock.calls[0]?.[1]).toBe('failed')
    expect(existsSync(join(record.mock.calls[0]![0].directory, 'receipt.json'))).toBe(true)
  })

  it('reports damaged application metadata as a reinstall failure', async () => {
    const { manager } = setup()
    writeFileSync(join(manager.runtime.dsh, 'desktop-runtime.json'), '{broken')
    await expect(manager.applyRelease()).rejects.toThrow()
    expect(manager.canRecoverProfile()).toBe(false)
  })

  it('keeps the registry-only helper separate from general source installation', () => {
    expect(packageNameFromSpec('@scope/plugin@1.2.3')).toBe('@scope/plugin')
    expect(packageNameFromSpec('plugin@next')).toBe('plugin')
    expect(packageNameFromSpec('plugin@^1.2.0')).toBe('plugin')
    for (const spec of ['file:../plugin', 'github:example/plugin', 'https://example.test/plugin.tgz']) {
      expect(() => packageNameFromSpec(spec)).toThrow('expected an npm registry package spec')
    }
    expect(() => packageNameFromSpec('--registry=evil')).toThrow('unsupported source protocol or option')
  })

  it('retains active plugin files after an interrupted staged runtime rebuild', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const dsh = join(root, 'new-node')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const failing = join(root, 'fail-install.mjs')
    writeFileSync(failing, 'process.exitCode = 1')
    const worker = trackedProjectManager(manager.paths, { ...manager.runtime, dsh, pnpm: failing })
    await expect(worker.applyRelease()).rejects.toThrow('pnpm exited with 1')
    expect(existsSync(join(manager.paths.profile, 'node_modules/plugin'))).toBe(true)
    expect(manager.releaseVersion()).toBe('1.0.0')
    const retry = trackedProjectManager(manager.paths, { ...manager.runtime, dsh })
    await expect(retry.applyRelease()).resolves.toBe(true)
    expect(retry.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: true }])
    await expect(retry.applyRelease()).resolves.toBe(false)
  })

  it('preserves unknown files when initializing a profile', async () => {
    const { manager } = setup()
    mkdirSync(manager.paths.profile, { recursive: true })
    writeFileSync(join(manager.paths.profile, '.DS_Store'), 'metadata')
    writeFileSync(join(manager.paths.profile, 'user-file'), 'retain')
    await expect(manager.applyRelease()).resolves.toBe(true)
    expect(readFileSync(join(manager.paths.profile, '.DS_Store'), 'utf8')).toBe('metadata')
    expect(readFileSync(join(manager.paths.profile, 'user-file'), 'utf8')).toBe('retain')
  })

  it.each(['plugin-add', 'runtime-change'] as const)('retries failed rebuild after %s across manager instances', async (operation) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    let dsh = manager.runtime.dsh
    if (operation === 'runtime-change') {
      await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
      dsh = join(root, 'new-node')
      runtimeFixture(dsh, '1.1.0', '24.18.0')
    }
    const failing = join(root, 'fail-rebuild.mjs')
    writeFileSync(failing, `await import(${JSON.stringify(pathToFileURL(manager.runtime.pnpm).href)}); if (process.argv.includes('rebuild')) process.exitCode = 1`)
    const worker = trackedProjectManager(manager.paths, { ...manager.runtime, dsh, pnpm: failing })
    if (operation === 'plugin-add') {
      await worker.applyRelease()
      await expect(worker.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())).rejects.toThrow('pnpm exited with 1')
    } else await expect(worker.applyRelease()).rejects.toThrow('pnpm exited with 1')
    if (operation === 'plugin-add') {
      expect(() => { worker.assertProfileRuntime(worker.paths.profile) }).not.toThrow()
      expect(worker.listPlugins()).toEqual([])
      await expect(worker.applyRelease()).resolves.toBe(false)
      const retry = trackedProjectManager(manager.paths, { ...manager.runtime, dsh })
      await retry.applyRelease()
      await expect(retry.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())).resolves.toBeUndefined()
      return
    }
    expect(() => { worker.assertProfileRuntime(worker.paths.profile) }).toThrow('profile does not match this application runtime')
    const count = calls(root).length
    const retry = trackedProjectManager(manager.paths, { ...manager.runtime, dsh })
    await expect(retry.applyRelease()).resolves.toBe(true)
    expect(calls(root).slice(count).map(call => call.args.find(arg => !arg.startsWith('--config.')))).toEqual(['install', 'rebuild'])
    await expect(retry.applyRelease()).resolves.toBe(false)
    expect(calls(root)).toHaveLength(count + 2)
  })

  it('initializes and restarts offline without executing pnpm', async () => {
    const { root, manager } = setup()
    await expect(manager.applyRelease()).resolves.toBe(true)
    await expect(manager.applyRelease()).resolves.toBe(false)
    expect(manager.listPlugins()).toEqual([])
    expect(calls(root)).toEqual([])
    expect(existsSync(manager.paths.pnpm.store)).toBe(false)
    expect(realpathSync(join(manager.paths.profile, 'node_modules/@deepseek-ai/cordis'))).toBe(realpathSync(join(manager.runtime.dsh, 'node_modules/@deepseek-ai/cordis')))
    expect(JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8'))).toMatchObject({ dependencies: {} })
  })

  it('repairs a removed managed link without running pnpm', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    unlinkSync(join(manager.paths.profile, 'node_modules/@deepseek-ai/cordis'))
    await expect(manager.applyRelease()).resolves.toBe(true)
    expect(calls(root)).toEqual([])
  })

  it.each([false, true].flatMap(required =>
    (['missing', 'stale'] as const).map(damage => ({ required, damage })),
  ))('repairs $damage Host links with required-plan=$required before plan reuse', async ({ required, damage }) => {
    const { root, manager } = setup()
    const archive = verifiedPluginArchive()
    const source = verifiedSource(archive)
    const originalFetch = globalThis.fetch
    globalThis.fetch = verifiedFetch(source, archive)
    try {
      const plan = { schemaVersion: 1, mode: 'exact', plugins: required ? [{ required: true, source }] : [] }
      await manager.applyRelease(hooks(), plan)
      const link = join(manager.paths.profile, 'node_modules', '@deepseek-ai/cordis')
      const target = realpathSync(join(manager.runtime.dsh, 'node_modules', '@deepseek-ai/cordis'))
      unlinkSync(link)
      if (damage === 'stale') {
        const stale = join(root, 'stale-runtime')
        runtimeFixture(stale, '0.9.0')
        symlinkSync(join(stale, 'node_modules', '@deepseek-ai/cordis'), link, process.platform === 'win32' ? 'junction' : 'dir')
      }
      const callCount = calls(root).length
      await expect(manager.applyRelease(hooks({
        healthCheck: async (projectDir) => {
          expect(realpathSync(join(projectDir, 'node_modules', '@deepseek-ai/cordis'))).toBe(target)
        },
      }), plan)).resolves.toBe(true)
      expect(existsSync(link)).toBe(true)
      expect(realpathSync(link)).toBe(target)
      expect(calls(root).slice(callCount).every(call => call.project !== manager.paths.profile)).toBe(true)
      if (!required) expect(calls(root)).toHaveLength(callCount)
      expect(manager.listPlugins()).toHaveLength(required ? 1 : 0)
      await expect(manager.applyRelease(hooks(), plan)).resolves.toBe(false)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it.skipIf(process.platform !== 'win32')('reuses the profile when the launch path changes only Windows letter casing', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const relaunched = trackedProjectManager(manager.paths, { ...manager.runtime, dsh: manager.runtime.dsh.toUpperCase() })
    await expect(relaunched.applyRelease()).resolves.toBe(false)
  })

  it.each(['changed', 'same-size', 'extra', 'missing'])('starts and reuses a profile without checking %s runtime bytes', async (operation) => {
    const { root, manager } = setup()
    if (operation === 'changed') writeFileSync(join(manager.runtime.dsh, 'package.json'), '{}')
    if (operation === 'same-size') writeFileSync(join(manager.runtime.dsh, 'package.json'), '{"type":"Module"}\n')
    if (operation === 'extra') writeFileSync(join(manager.runtime.dsh, 'extra'), '')
    if (operation === 'missing') unlinkSync(join(manager.runtime.dsh, 'package.json'))
    await expect(manager.applyRelease()).resolves.toBe(true)
    const relaunched = trackedProjectManager(manager.paths, manager.runtime)
    await expect(relaunched.applyRelease()).resolves.toBe(false)
    expect(existsSync(manager.paths.profile)).toBe(true)
    expect(calls(root)).toEqual([])
  })

  it('installs only plugins and checks the graph before running lifecycle scripts', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: '@scope/plugin@2.0.0' }, hooks())
    expect(manager.listPlugins()).toEqual([{ name: '@scope/plugin', version: '2.0.0', enabled: true }])
    expect(calls(root).map(call => call.args.filter(arg => !arg.startsWith('--config.')))).toEqual([
      ['add', '@scope/plugin@2.0.0', '--save-exact', '--ignore-scripts'], ['rebuild', '--pending'],
    ])
    expect(calls(root).every(call => call.registry === 'https://registry.npmjs.org/')).toBe(true)
    expect(JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8'))).toMatchObject({ dependencies: { '@scope/plugin': '2.0.0' } })
    await expect(manager.mutate({ type: 'plugin-add', spec: '@deepseek-ai/cordis' }, hooks())).rejects.toThrow(/host-owned/u)
    await expect(manager.applyRelease()).resolves.toBe(false)
    expect(calls(root)).toHaveLength(3)
  })

  it('retains exact npm installation through the versioned source API', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    await manager.mutate({
      type: 'plugin-install',
      source: { schemaVersion: 1, type: 'npmRegistry', spec: 'plugin@1.0.0' },
    }, hooks())
    expect(manager.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: true }])
  })

  it('installs an exact verified release through the dependency proxy and records its source', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const archive = verifiedPluginArchive()
    const source = verifiedSource(archive)
    const originalFetch = globalThis.fetch
    globalThis.fetch = verifiedFetch(source, archive)
    try {
      const receipt = await manager.mutate({ type: 'plugin-install', source }, hooks())
      expect(receipt).toMatchObject({
        schemaVersion: 1,
        packageName: source.packageName,
        artifactSha256: source.sha256,
        states: { health: 'passed', activated: true, rolledBack: false, verified: true },
      })

    } finally {
      globalThis.fetch = originalFetch
    }
    expect(manager.listPlugins()).toEqual([{
      name: source.packageName,
      version: source.version,
      enabled: true,
      source,
    }])
    expect(calls(root).every(call => call.registry === source.dependencyRegistry)).toBe(true)
    expect(JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8'))).toMatchObject({
      dependencies: {
        [source.packageName]: `file:.desktop-plugin-artifacts/${source.sha256}.tgz`,
      },
    })
    const artifact = join(manager.paths.profile, '.desktop-plugin-artifacts', `${source.sha256}.tgz`)
    expect(existsSync(artifact)).toBe(true)
    await manager.mutate({ type: 'plugin-remove', name: source.packageName }, hooks())
    expect(manager.listPlugins()).toEqual([])
    expect(existsSync(artifact)).toBe(false)
    expect(JSON.parse(readFileSync(join(manager.paths.profile, 'desktop-plugin-receipts.json'), 'utf8')))
      .toEqual({ schemaVersion: 1, receipts: {}, owners: {} })
  })

  it('reconciles release-owned plugins exactly while preserving manual plugins and shared packages', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'manual-plugin@1.0.0' }, hooks())
    const archive = verifiedPluginArchive()
    const source = verifiedSource(archive)
    const originalFetch = globalThis.fetch
    globalThis.fetch = verifiedFetch(source, archive)
    try {
      const required = { schemaVersion: 1 as const, mode: 'exact' as const, plugins: [{ required: true, source }] }
      const state = await manager.reconcileProvisioning(required, hooks({
        healthCheck: async (projectDir) => {
          const manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
            dependencies: Record<string, string>
            dsh: { profile: { bundles: string[] } }
          }
          expect(manifest.dsh.profile.bundles).toContain(source.packageName)
          expect(manifest.dependencies).not.toHaveProperty('@deepseek-ai/cordis')
          expect(realpathSync(join(projectDir, 'node_modules/@deepseek-ai/cordis')))
            .toBe(realpathSync(join(manager.runtime.dsh, 'node_modules/@deepseek-ai/cordis')))
        },
      }))
      expect(state).toMatchObject({
        composition: 'active',
        plugins: [{ name: source.packageName, status: 'active', required: true }],
        removed: [],
        rolledBack: false,
        verified: true,
      })
      expect(manager.listPlugins().map(plugin => plugin.name)).toEqual(['dsh-github-copilot', 'manual-plugin'])
      const callCount = calls(root).length
      await expect(manager.reconcileProvisioning(required, hooks())).resolves.toEqual(state)
      expect(calls(root)).toHaveLength(callCount)

      const optional = { ...required, plugins: [{ required: false, source }] }
      const changed = await manager.reconcileProvisioning(optional, hooks())
      expect(changed.planSha256).not.toBe(state.planSha256)
      const removed = await manager.reconcileProvisioning(
        { schemaVersion: 1, mode: 'exact', plugins: [] },
        hooks(),
      )
      expect(removed.removed).toEqual([source.packageName])
      expect(manager.listPlugins()).toEqual([{ name: 'manual-plugin', version: '1.0.0', enabled: true }])
    } finally {
      globalThis.fetch = originalFetch
    }
  }, 30_000)

  it('keeps the active exact inventory when required provisioning health fails', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    const archive = verifiedPluginArchive()
    const source = verifiedSource(archive)
    const originalFetch = globalThis.fetch
    globalThis.fetch = verifiedFetch(source, archive)
    try {
      await expect(manager.reconcileProvisioning(
        { schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source }] },
        hooks({ healthCheck: async () => { throw new Error('required client composition failed') } }),
      )).rejects.toThrow('required client composition failed')
      expect(manager.listPlugins()).toEqual([])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('excludes an optional plugin that fails composition health without retaining a successful receipt', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const archive = verifiedPluginArchive()
    const source = verifiedSource(archive)
    const originalFetch = globalThis.fetch
    globalThis.fetch = verifiedFetch(source, archive)
    let healthChecks = 0
    try {
      const state = await manager.reconcileProvisioning(
        { schemaVersion: 1, mode: 'exact', plugins: [{ required: false, source }] },
        hooks({
          healthCheck: async (projectDir) => {
            healthChecks++
            const manifest = JSON.parse(readFileSync(join(projectDir, 'package.json'), 'utf8')) as {
              dsh: { profile: { bundles: string[] } }
            }
            if (manifest.dsh.profile.bundles.includes(source.packageName)) {
              throw new Error('optional client composition failed')
            }
            expect(manifest.dsh.profile.bundles).not.toContain(source.packageName)
          },
        }),
      )
      expect(healthChecks).toBe(3)
      expect(state.plugins).toMatchObject([{
        name: source.packageName,
        required: false,
        status: 'optional-failed',
        message: 'optional client composition failed',
      }])
      expect(manager.listPlugins()).toEqual([])
      const optionalFailure = state.plugins[0]
      if (optionalFailure?.status !== 'optional-failed') throw new Error('expected optional failure result')
      expect(optionalFailure).not.toHaveProperty('receipt')
      const callCount = calls(root).length
      await expect(manager.reconcileProvisioning(
        { schemaVersion: 1, mode: 'exact', plugins: [{ required: false, source }] },
        hooks({ healthCheck: async () => { throw new Error('should not rerun') } }),
      )).resolves.toEqual(state)
      expect(calls(root)).toHaveLength(callCount)
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('restarts the active Host when staged health fails', async () => {
    const { manager } = setup()
    await manager.applyRelease()
    let stops = 0
    let starts = 0
    await expect(manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks({
      healthCheck: async (projectDir) => {
        expect(projectDir).not.toBe(manager.paths.profile)
        expect(manager.listPlugins()).toEqual([])
        expect(existsSync(join(projectDir, 'node_modules', 'plugin', 'package.json'))).toBe(true)
        throw new Error('staged health failed')
      },
      beforeChange: async () => { stops++ },
      afterChange: async () => { starts++ },
    }))).rejects.toThrow('staged health failed')
    expect(stops).toBe(1)
    expect(starts).toBe(1)
    expect(manager.listPlugins()).toEqual([])
  })

  it('does not inherit package-manager credentials or secret environment values', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const names = ['NPM_TOKEN', 'COREPACK_NPM_TOKEN', 'npm_config_userconfig', 'DESKTOP_FIXTURE_SECRET'] as const
    const previous = new Map(names.map(name => [name, process.env[name]]))
    try {
      process.env.NPM_TOKEN = 'npm-secret'
      process.env.COREPACK_NPM_TOKEN = 'corepack-secret'
      process.env.npm_config_userconfig = 'credentialed-npmrc'
      process.env.DESKTOP_FIXTURE_SECRET = 'generic-secret'
      await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    } finally {
      for (const name of names) {
        const value = previous.get(name)
        if (value === undefined) Reflect.deleteProperty(process.env, name)
        else process.env[name] = value
      }
    }
    expect(calls(root).map(call => call.credentials)).toEqual([
      { userConfig: join(manager.paths.pnpm.config, 'npmrc') },
      { userConfig: join(manager.paths.pnpm.config, 'npmrc') },
    ])
  })

  it('retains disabled plugin versions through updates and enables them explicitly', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    await manager.mutate({ type: 'plugins-disable-all' }, hooks())
    expect(calls(root)).toHaveLength(4)
    expect(manager.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: false }])
    await manager.mutate({ type: 'plugin-update', name: 'plugin', version: '1.1.0' }, hooks())
    expect(manager.listPlugins()).toEqual([{ name: 'plugin', version: '1.1.0', enabled: false }])
    await manager.mutate({ type: 'plugin-toggle', name: 'plugin', enabled: true }, hooks())
    expect(manager.listPlugins()[0]?.enabled).toBe(true)
    await manager.mutate({ type: 'plugin-remove', name: 'plugin' }, hooks())
    expect(manager.listPlugins()).toEqual([])
  })

  it('keeps plugin files and patches through a compatible release and application relocation', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    writeFileSync(join(manager.paths.profile, 'cordis.patch.yml'), '[]\n')
    const nextRoot = join(root, 'relocated', 'dsh')
    runtimeFixture(nextRoot, '1.1.0')
    const next = trackedProjectManager(manager.paths, { ...manager.runtime, dsh: nextRoot })
    await expect(next.applyRelease()).resolves.toBe(true)
    expect(next.listPlugins()).toEqual(manager.listPlugins())
    expect(next.releaseVersion()).toBe('1.1.0')
    expect(readFileSync(join(manager.paths.profile, 'cordis.patch.yml'), 'utf8')).toBe('[]\n')
    expect(calls(root)).toHaveLength(4)
    expect(realpathSync(join(manager.paths.profile, 'node_modules/@deepseek-ai/cordis'))).toBe(realpathSync(join(nextRoot, 'node_modules/@deepseek-ai/cordis')))
    expect(readFileSync(join(manager.paths.profile, 'node_modules/plugin/bundle.yml'), 'utf8')).toBe('[]\n')
  })

  it('reinstalls the locked plugin graph when bundled Node changes', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const dsh = join(root, 'new-node')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const next = trackedProjectManager(manager.paths, { ...manager.runtime, dsh })
    await next.applyRelease()
    expect(calls(root).slice(2).map(call => call.args.filter(arg => !arg.startsWith('--config.')))).toEqual([
      ['install', '--frozen-lockfile', '--ignore-scripts'], ['rebuild', '--pending'],
    ])
    expect(next.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: true }])
  })

  it('allows incompatible plugins to be disabled in recovery without deleting them', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const dsh = join(root, 'next-major')
    runtimeFixture(dsh, '2.0.0')
    const next = trackedProjectManager(manager.paths, { ...manager.runtime, dsh })
    await expect(next.applyRelease()).rejects.toThrow(/requires @deepseek-ai\/cordis/u)
    expect(next.releaseVersion()).toBe('1.0.0')
    await next.mutate({ type: 'plugins-disable-all' }, hooks())
    expect(next.releaseVersion()).toBe('2.0.0')
    expect(next.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: false }])
  })

  it.each(['before', 'after'] as const)('keeps the active profile when the %s change hook fails', async (phase) => {
    const { manager } = setup()
    await manager.applyRelease()
    let stops = 0
    let starts = 0
    await expect(manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks({
      beforeChange: async () => {
        stops++
        if (stops === 1) {
          expect(manager.listPlugins()).toEqual([])
          if (phase === 'before') throw new Error('before failed')
        }
      },
      afterChange: async () => {
        starts++
        if (starts === 1) throw new Error('after failed')
      },
    }))).rejects.toThrow(`${phase} failed`)
    expect(manager.listPlugins()).toEqual([])
    expect(stops).toBe(phase === 'before' ? 1 : 2)
    expect(starts).toBe(phase === 'before' ? 0 : 2)
    expect(existsSync(join(manager.paths.root, 'staging'))).toBe(false)
    expect(existsSync(join(manager.paths.root, 'rollback'))).toBe(false)
    expect(existsSync(join(manager.paths.root, 'pending.json'))).toBe(false)
  })

  it('discards staged package changes and preserves active host links after pnpm fails', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const failingPnpm = join(root, 'failing.mjs')
    writeFileSync(failingPnpm, `await import(${JSON.stringify(pathToFileURL(manager.runtime.pnpm).href)}); process.exitCode = 1`)
    const worker = trackedProjectManager(manager.paths, { ...manager.runtime, pnpm: failingPnpm })
    await worker.applyRelease()
    let starts = 0
    await expect(worker.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks({
      afterChange: async () => { starts++ },
    }))).rejects.toThrow(/pnpm exited with 1/u)
    expect(worker.listPlugins()).toEqual([])
    expect(starts).toBe(0)
    expect(existsSync(manager.paths.lock)).toBe(false)
    expect(realpathSync(join(manager.paths.profile, 'node_modules/@deepseek-ai/cordis')))
      .toBe(realpathSync(join(manager.runtime.dsh, 'node_modules/@deepseek-ai/cordis')))
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    expect(manager.listPlugins()).toEqual([{ name: 'plugin', version: '1.0.0', enabled: true }])
  })

  it.each([
    ['registry', 'source'],
    ['source', 'verified'],
    ['verified', 'source'],
    ['source', 'registry'],
  ] as const)('replaces %s with %s without retaining displaced source locks or receipts', async (from, to) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const bytes = verifiedPluginArchive('plugin', '1.0.0')
    const path = join(root, 'repository-name-is-not-package-name.tgz')
    writeFileSync(path, bytes)
    const source = verifiedSource(bytes, 'plugin', '1.0.0')
    const original = globalThis.fetch
    globalThis.fetch = verifiedFetch(source, bytes)
    const install = async (origin: 'registry' | 'source' | 'verified', version = '1.0.0'): Promise<void> => {
      if (origin === 'verified') await manager.mutate({ type: 'plugin-install', source }, hooks())
      else await manager.mutate({ type: 'plugin-add', spec: origin === 'source' ? path : `plugin@${version}` }, hooks())
    }
    try {
      await install(from)
      await install(to, to === 'registry' ? '2.0.0' : '1.0.0')
      if (to === 'source') {
        expect(manager.listPlugins()[0]?.source?.type).toBe('packageSpec')
        expect(readDesktopPackageLocks(manager.paths.profile).plugin?.packageName).toBe('plugin')
      } else {
        expect(readDesktopPackageLocks(manager.paths.profile)).toEqual({})
        if (to === 'verified') expect(manager.listPlugins()[0]?.source?.type).toBe('githubRelease')
        else expect(manager.listPlugins()).toEqual([{ name: 'plugin', version: '2.0.0', enabled: true }])
      }
      const receipts = join(manager.paths.profile, 'desktop-plugin-receipts.json')
      if (to !== 'verified' && existsSync(receipts)) {
        expect(JSON.parse(readFileSync(receipts, 'utf8'))).toEqual({ schemaVersion: 1, receipts: {}, owners: {} })
      }
      expect((JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }).dsh.profile.bundles.filter(name => name === 'plugin')).toHaveLength(1)
    } finally { globalThis.fetch = original }
  })

  it('rejects automatic optional replacement of a user source snapshot before acquisition', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const bytes = verifiedPluginArchive('plugin', '1.0.0')
    const path = join(root, 'input.tgz')
    writeFileSync(path, bytes)
    await manager.mutate({ type: 'plugin-add', spec: path }, hooks())
    const lock = readDesktopPackageLocks(manager.paths.profile).plugin!
    const original = globalThis.fetch
    globalThis.fetch = async () => { throw new Error('fixture download unavailable') }
    try {
      const before = profileMetadata(manager.paths.profile), count = calls(root).length
      await expect(manager.reconcileProvisioning({
        schemaVersion: 1, mode: 'exact', plugins: [{ required: false, source: verifiedSource(bytes, 'plugin', '1.0.0') }],
      }, hooks())).rejects.toThrow('release plan conflicts with user plugin')
      expect(profileMetadata(manager.paths.profile)).toEqual(before)
      expect(calls(root)).toHaveLength(count)
      expect(readDesktopPackageLocks(manager.paths.profile)).toEqual({ plugin: lock })
      expect(readFileSync(join(manager.paths.profile, '.desktop-plugin-artifacts', `${lock.sha256}.tgz`))).toEqual(bytes)
      await manager.mutate({ type: 'plugin-add', spec: 'unrelated@1.0.0' }, hooks())
      expect(manager.listPlugins().map(plugin => plugin.name)).toEqual(['plugin', 'unrelated'])
    } finally { globalThis.fetch = original }
  })

  it.each(['missing', 'corrupt'] as const)('lists and removes a source package with a %s snapshot without rehydrating it', async (damage) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const path = join(root, 'source.tgz')
    writeFileSync(path, verifiedPluginArchive('plugin', '1.0.0'))
    await manager.mutate({ type: 'plugin-add', spec: path }, hooks())
    await manager.mutate({ type: 'plugin-add', spec: 'unrelated@1.0.0' }, hooks())
    const lock = readDesktopPackageLocks(manager.paths.profile).plugin!
    const artifact = join(manager.paths.profile, '.desktop-plugin-artifacts', `${lock.sha256}.tgz`)
    if (damage === 'missing') unlinkSync(artifact)
    else writeFileSync(artifact, 'corrupted package bytes')
    expect(manager.listPlugins().map(plugin => plugin.name)).toEqual(['plugin', 'unrelated'])
    const beforeChange = vi.fn(async () => {})
    await expect(manager.mutate({ type: 'plugin-toggle', name: 'unrelated', enabled: false }, hooks({ beforeChange }))).rejects.toThrow(/snapshot/u)
    expect(beforeChange).not.toHaveBeenCalled()
    await manager.mutate({ type: 'plugin-remove', name: 'plugin' }, hooks())
    expect(manager.listPlugins()).toEqual([{ name: 'unrelated', version: '1.0.0', enabled: true }])
    expect(readDesktopPackageLocks(manager.paths.profile)).toEqual({})
    expect(existsSync(artifact)).toBe(false)
  })

  it.each(['success', 'health-failure', 'activation-failure'] as const)('handles same-version source replacement through %s', async (outcome) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const path = join(root, 'source.tgz')
    writeFileSync(path, verifiedPluginArchive('plugin', '1.0.0'))
    await manager.mutate({ type: 'plugin-add', spec: path }, hooks())
    const old = readDesktopPackageLocks(manager.paths.profile).plugin!
    writeFileSync(path, verifiedPluginArchive('plugin', '1.0.0', '>=1.0.0'))
    let starts = 0
    const result = manager.mutate({ type: 'plugin-add', spec: path }, hooks({
      healthCheck: async () => { if (outcome === 'health-failure') throw new Error('source fixture health failed') },
      afterChange: async () => { if (++starts === 1 && outcome === 'activation-failure') throw new Error('source fixture activation failed') },
    }))
    if (outcome === 'success') {
      await result
      const next = readDesktopPackageLocks(manager.paths.profile).plugin!
      expect(next.version).toBe(old.version)
      expect(next.sha256).not.toBe(old.sha256)
      expect(existsSync(join(manager.paths.profile, '.desktop-plugin-artifacts', `${old.sha256}.tgz`))).toBe(false)
    } else {
      await expect(result).rejects.toThrow(/source fixture/u)
      expect(readDesktopPackageLocks(manager.paths.profile).plugin).toEqual(old)
      expect(existsSync(join(manager.paths.profile, '.desktop-plugin-artifacts', `${old.sha256}.tgz`))).toBe(true)
    }
    expect(manager.listPlugins()).toHaveLength(1)
    await manager.mutate({ type: 'plugin-toggle', name: 'plugin', enabled: false }, hooks())
    expect(manager.listPlugins()[0]?.enabled).toBe(false)
  })

  it('protects actual host package names concealed behind a source archive filename', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const path = join(root, 'innocent-plugin.tgz')
    writeFileSync(path, verifiedPluginArchive('@deepseek-ai/cordis', '1.0.0'))
    await expect(manager.mutate({ type: 'plugin-add', spec: path }, hooks())).rejects.toThrow('cannot install host-owned package')
    expect(manager.listPlugins()).toEqual([])
    expect(calls(root)).toEqual([])
  })

  it('holds the transaction lock until the pnpm worker exits', async ({ task, signal }) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const ready = join(root, 'ready')
    const release = join(root, 'release')
    const blocker = join(root, 'blocking.mjs')
    writeFileSync(blocker, `import {existsSync, writeFileSync} from 'node:fs'; import {setTimeout as sleep} from 'node:timers/promises'; writeFileSync(${JSON.stringify(ready)}, String(process.pid)); while (!existsSync(${JSON.stringify(release)})) await sleep(10); await import(${JSON.stringify(pathToFileURL(manager.runtime.pnpm).href)})`)
    const worker = trackedProjectManager(manager.paths, { ...manager.runtime, pnpm: blocker })
    await worker.applyRelease()
    const pending = worker.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    // Teardown observes failures even if the runner has abandoned the test body.
    const completed = pending.then(value => ({ value }), (error: unknown) => ({ error }))
    releaseWorkers.push(async () => {
      writeFileSync(release, 'continue')
      const outcome = await completed
      if ('error' in outcome) throw outcome.error
    })
    try {
      // Child startup shares the test budget; an aborted poll must not resume ownership assertions.
      await expect.poll(() => {
        signal.throwIfAborted()
        return existsSync(ready)
      }, { timeout: task.timeout }).toBe(true)
      signal.throwIfAborted()
      expect(readFileSync(manager.paths.lock, 'utf8').trim()).toBe(readFileSync(ready, 'utf8'))
      await expect(manager.applyRelease()).rejects.toThrow(/another package transaction/u)
    } finally {
      writeFileSync(release, 'continue')
      await pending
    }
    expect(existsSync(manager.paths.lock)).toBe(false)
  })
})
