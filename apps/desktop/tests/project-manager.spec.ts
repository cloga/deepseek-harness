import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveDesktopPaths } from '../src/paths.ts'
import { DesktopProjectManager, packageNameFromSpec, type DesktopProjectHooks } from '../src/project-manager.ts'
import type { DesktopGithubReleasePluginSource } from '../src/plugin-source.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const roots: string[] = []
const releaseWorkers: Array<() => Promise<void>> = []
const targetCommit = '08bfccc3b5930b93ef2fe31d9cf9e509f34a8704'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync) }
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
function setup(): { root: string; manager: DesktopProjectManager } {
  const root = temporaryRoot()
  const dsh = join(root, 'resources', 'dsh')
  runtimeFixture(dsh)
  return { root, manager: new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), { node: process.execPath, pnpm: writeFakePnpm(root), dsh }) }
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
afterEach(async () => {
  vi.restoreAllMocks()
  vi.mocked(fs.renameSync).mockReset()
  const cleanups = releaseWorkers.splice(0)
  const directories = roots.splice(0)
  const results = await Promise.allSettled(cleanups.map(cleanup => cleanup()))
  for (const root of directories) rmSync(root, { recursive: true, force: true })
  const failures: unknown[] = results.flatMap((result): unknown[] => result.status === 'rejected' ? [result.reason] : [])
  if (failures.length > 0) throw new AggregateError(failures, 'desktop worker cleanup failed')
})

describe('desktop external plugin profile', () => {
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

  it.each(['registry', 'alternate-artifact', 'artifact-bytes', 'missing-package', 'missing-row', 'empty-extra'] as const)('repairs exact restart inventory after %s drift', async (drift) => {
    const { manager } = setup()
    await manager.applyRelease()
    const archive = verifiedPluginArchive()
    const source = verifiedSource(archive)
    const original = globalThis.fetch
    globalThis.fetch = verifiedFetch(source, archive)
    const plan = { schemaVersion: 1, mode: 'exact', plugins: drift === 'empty-extra' ? [] : [{ required: true, source }] }
    try {
      await manager.reconcileProvisioning(plan, hooks())
      if (drift === 'registry') {
        await manager.mutate({ type: 'plugin-update', name: source.packageName, version: source.version }, hooks())
      } else if (drift === 'alternate-artifact') {
        const alternateArchive = verifiedPluginArchive(source.packageName, source.version, '>=1.0.0')
        const alternate = verifiedSource(alternateArchive)
        globalThis.fetch = verifiedFetch(alternate, alternateArchive)
        await manager.mutate({ type: 'plugin-install', source: alternate }, hooks())
        globalThis.fetch = verifiedFetch(source, archive)
      } else if (drift === 'artifact-bytes') {
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
      if (drift === 'empty-extra') expect(manager.listPlugins()).toEqual([])
      else {
        expect(state.plugins).toHaveLength(1)
        expect(manager.listPlugins()[0]?.source).toEqual(source)
      }
    } finally { globalThis.fetch = original }
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
      expect(state.plugins[1]?.message).toBeTypeOf('string')
      expect(state.plugins[1]?.receipt).toBeUndefined()
      expect(manager.listPlugins().map(plugin => plugin.name)).toEqual([source.packageName, 'manual-plugin', validOptional.packageName])
    } finally { globalThis.fetch = original }
  })

  it('stages a Node upgrade without running pnpm in the active profile', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'manual-plugin@1.0.0' }, hooks())
    const dsh = join(root, 'new-runtime')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
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
      const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
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
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
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

  it.each(['old-moved', 'new-activated'] as const)('recovers an interrupted directory activation: %s', async (phase) => {
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
    await manager.applyRelease()
    expect(readFileSync(join(manager.paths.profile, 'old-profile-sentinel'), 'utf8')).toBe('recover me')
    expect(existsSync(join(manager.paths.profile, 'unverified-new-profile'))).toBe(false)
    expect(existsSync(transaction)).toBe(false)
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
      } }))).rejects.toThrow(/verified local artifacts/u)
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

  it('resets the entire profile without backups while retaining its external lock and shared data', async () => {
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
    symlinkSync(shared, join(profile, 'external-link'), process.platform === 'win32' ? 'junction' : 'dir')
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
    expect(existsSync(join(profile, 'external-link'))).toBe(false)
    expect(readFileSync(join(shared, 'sentinel'), 'utf8')).toBe('preserve')
    expect(readFileSync(task, 'utf8')).toBe('retained task')
    expect(readFileSync(homeEnvironment, 'utf8')).toBe('HOME_SETTING=retained')
    expect(readdirSync(profile).some(name => name.includes('backup'))).toBe(false)
    expect(calls(root)).toHaveLength(2)
    await expect(manager.applyRelease()).resolves.toBe(false)
    expect(existsSync(homeEnvironment)).toBe(true)
  })

  it('reports damaged application metadata as a reinstall failure', async () => {
    const { manager } = setup()
    writeFileSync(join(manager.runtime.dsh, 'desktop-runtime.json'), '{broken')
    await expect(manager.applyRelease()).rejects.toThrow()
    expect(manager.canRecoverProfile()).toBe(false)
  })

  it('accepts registry names and tags but rejects alternate sources and flags', () => {
    expect(packageNameFromSpec('@scope/plugin@1.2.3')).toBe('@scope/plugin')
    expect(packageNameFromSpec('plugin@next')).toBe('plugin')
    for (const spec of ['file:../plugin', '--registry=evil', 'https://example.test/plugin.tgz']) {
      expect(() => packageNameFromSpec(spec)).toThrow(/unsupported npm package spec/u)
    }
  })

  it('retains active plugin files after an interrupted staged runtime rebuild', async () => {
    const { root, manager } = setup()
    await manager.applyRelease()
    await manager.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())
    const dsh = join(root, 'new-node')
    runtimeFixture(dsh, '1.1.0', '24.18.0')
    const failing = join(root, 'fail-install.mjs')
    writeFileSync(failing, 'process.exitCode = 1')
    const worker = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh, pnpm: failing })
    await expect(worker.applyRelease()).rejects.toThrow('pnpm exited with 1')
    expect(existsSync(join(manager.paths.profile, 'node_modules/plugin'))).toBe(true)
    expect(manager.releaseVersion()).toBe('1.0.0')
    const retry = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
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
    const worker = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh, pnpm: failing })
    if (operation === 'plugin-add') {
      await worker.applyRelease()
      await expect(worker.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())).rejects.toThrow('pnpm exited with 1')
    } else await expect(worker.applyRelease()).rejects.toThrow('pnpm exited with 1')
    if (operation === 'plugin-add') {
      expect(() => { worker.assertProfileRuntime(worker.paths.profile) }).not.toThrow()
      expect(worker.listPlugins()).toEqual([])
      await expect(worker.applyRelease()).resolves.toBe(false)
      const retry = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
      await retry.applyRelease()
      await expect(retry.mutate({ type: 'plugin-add', spec: 'plugin@1.0.0' }, hooks())).resolves.toBeUndefined()
      return
    }
    expect(() => { worker.assertProfileRuntime(worker.paths.profile) }).toThrow('profile does not match this application runtime')
    const count = calls(root).length
    const retry = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
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
    const relaunched = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh: manager.runtime.dsh.toUpperCase() })
    await expect(relaunched.applyRelease()).resolves.toBe(false)
  })

  it.each(['changed', 'same-size', 'extra', 'missing'])('starts and reuses a profile without checking %s runtime bytes', async (operation) => {
    const { root, manager } = setup()
    if (operation === 'changed') writeFileSync(join(manager.runtime.dsh, 'package.json'), '{}')
    if (operation === 'same-size') writeFileSync(join(manager.runtime.dsh, 'package.json'), '{"type":"Module"}\n')
    if (operation === 'extra') writeFileSync(join(manager.runtime.dsh, 'extra'), '')
    if (operation === 'missing') unlinkSync(join(manager.runtime.dsh, 'package.json'))
    await expect(manager.applyRelease()).resolves.toBe(true)
    const relaunched = new DesktopProjectManager(manager.paths, manager.runtime)
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
      .toEqual({ schemaVersion: 1, receipts: {} })
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
      expect(state.plugins[0]?.receipt).toBeUndefined()
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
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh: nextRoot })
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
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
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
    const next = new DesktopProjectManager(manager.paths, { ...manager.runtime, dsh })
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
    const worker = new DesktopProjectManager(manager.paths, { ...manager.runtime, pnpm: failingPnpm })
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

  it('holds the transaction lock until the pnpm worker exits', async ({ task, signal }) => {
    const { root, manager } = setup()
    await manager.applyRelease()
    const ready = join(root, 'ready')
    const release = join(root, 'release')
    const blocker = join(root, 'blocking.mjs')
    writeFileSync(blocker, `import {existsSync, writeFileSync} from 'node:fs'; import {setTimeout as sleep} from 'node:timers/promises'; writeFileSync(${JSON.stringify(ready)}, String(process.pid)); while (!existsSync(${JSON.stringify(release)})) await sleep(10); await import(${JSON.stringify(pathToFileURL(manager.runtime.pnpm).href)})`)
    const worker = new DesktopProjectManager(manager.paths, { ...manager.runtime, pnpm: blocker })
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
