import { createHash } from 'node:crypto'
import { execFile, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { dump, load } from 'js-yaml'
import { c } from 'tar'
import { expect, it } from 'vitest'
import { DesktopProjectManager, type DesktopProjectHooks } from '../src/project-manager.ts'
import type { DesktopPluginProvisioningEntry } from '../src/plugin-provisioning.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

interface FixturePnpmLock {
  readonly importers: Record<string, {
    readonly dependencies?: Record<string, { readonly specifier: string; readonly version: string }>
  }>
  readonly packages: Record<string, {
    readonly version: string
    readonly resolution: { readonly integrity: string; readonly tarball: string }
  }>
}

it.each(['activate', 'health-failure', 'activation-failure'] as const)(
  'preserves real pnpm verified file provenance through %s',
  async (outcome) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-verified-pnpm-')))
    const originalFetch = globalThis.fetch
    try {
      const name = 'verified-fixture-plugin'
      const packageDir = writePackage(root, 'package', {
        name,
        peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' },
        dsh: { bundle: { patch: 'bundle.yml' } },
      })
      writeFileSync(join(packageDir, 'bundle.yml'), '[]\n')
      const artifact = join(root, 'plugin.tgz')
      await c({ file: artifact, cwd: root, gzip: true }, ['package/package.json', 'package/index.js', 'package/bundle.yml'])
      let bytes = readFileSync(artifact)
      let sha256 = createHash('sha256').update(bytes).digest('hex')
      let checksum = Buffer.from(`${sha256}  plugin.tgz\n`)
      let source: DesktopPluginProvisioningEntry['source'] = {
        schemaVersion: 1, type: 'githubRelease', owner: 'example', repo: name,
        tag: 'v1.0.0', targetCommit: 'a'.repeat(40),
        asset: 'plugin.tgz', assetId: 1, packageName: name, version: '1.0.0',
        size: bytes.length, sha256,
        checksumManifest: {
          format: 'sha256sums', asset: 'SHA256SUMS', assetId: 2,
          url: `https://github.com/example/${name}/releases/download/v1.0.0/SHA256SUMS`,
          size: checksum.length, sha256: createHash('sha256').update(checksum).digest('hex'),
        },
      }
      globalThis.fetch = async (input) => {
        const url = new URL(input instanceof Request ? input.url : input)
        if (url.pathname.endsWith('/releases/tags/v1.0.0')) {
          return Response.json({
            id: 3, draft: false, immutable: true, tag_name: source.tag, target_commitish: source.targetCommit,
            assets: [
              { id: source.assetId, name: source.asset, state: 'uploaded', size: bytes.length, digest: `sha256:${sha256}` },
              { id: source.checksumManifest.assetId, name: 'SHA256SUMS', state: 'uploaded', size: checksum.length,
                browser_download_url: source.checksumManifest.url, digest: `sha256:${source.checksumManifest.sha256}` },
            ],
          })
        }
        if (url.pathname.endsWith('/git/ref/tags/v1.0.0')) return Response.json({ object: { type: 'commit', sha: source.targetCommit } })
        if (url.pathname.endsWith(`/releases/assets/${source.assetId}`)) return new Response(Uint8Array.from(bytes))
        if (url.pathname.endsWith(`/releases/assets/${source.checksumManifest.assetId}`)) return new Response(Uint8Array.from(checksum))
        throw new Error(`unexpected fixture request ${url.href}`)
      }
      const dsh = join(root, 'dsh')
      runtimeFixture(dsh)
      const manager = new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), {
        node: process.execPath, pnpm: join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs'), dsh,
      })
      await manager.applyRelease()
      const before = readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')
      const verifyPrivateArtifact = (): void => {
        const profile = manager.paths.profile
        const artifactPath = join(profile, '.desktop-plugin-artifacts', `${sha256}.tgz`)
        expect(createHash('sha256').update(readFileSync(artifactPath)).digest('hex')).toBe(sha256)
        const installed = realpathSync(join(profile, 'node_modules', name))
        expect(installed.startsWith(realpathSync(profile) + sep)).toBe(true)
        expect(readFileSync(join(installed, 'index.js'), 'utf8')).toBe(readFileSync(join(packageDir, 'index.js'), 'utf8'))
        const lock = load(readFileSync(join(profile, 'pnpm-lock.yaml'), 'utf8')) as FixturePnpmLock
        const entries = Object.values(lock.importers).flatMap(importer => (
          importer.dependencies?.[name] === undefined ? [] : [importer.dependencies[name]]
        ))
        expect(entries).toHaveLength(1)
        const entry = entries[0]
        if (entry === undefined) throw new Error('fixture lock has no installed dependency')
        const declared = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
          dependencies: Record<string, string>
        }
        expect(entry.specifier).toBe(declared.dependencies[name])
        // Relocation can retain a non-dot importer key; both platform path forms identify the same artifact.
        for (const specifier of new Set([entry.specifier, entry.specifier.replaceAll('/', '\\')])) {
          const resolved = resolve(profile, specifier.slice('file:'.length).replaceAll('\\', '/'))
          expect(realpathSync(resolved)).toBe(realpathSync(artifactPath))
        }
        const locked = lock.packages[`${name}@${entry.version}`]
        if (locked === undefined) throw new Error('fixture lock has no matching package resolution')
        expect(locked.version).toBe(source.version)
        expect(locked.resolution.integrity).toBe(`sha512-${createHash('sha512').update(bytes).digest('base64')}`)
        expect(locked.resolution.tarball.startsWith('file:')).toBe(true)
        expect(basename(locked.resolution.tarball.slice('file:'.length).replaceAll('\\', '/'))).toBe(`${sha256}.tgz`)
      }
      let starts = 0
      const pending = manager.reconcileProvisioning({
        schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source }],
      }, {
        beforeChange: async () => {},
        healthCheck: async () => { if (outcome === 'health-failure') throw new Error('fixture health rejected') },
        afterChange: async () => { if (++starts === 1 && outcome === 'activation-failure') throw new Error('fixture activation rejected') },
      })
      if (outcome === 'activate') {
        const state = await pending
        expect(state.plugins[0]?.receipt?.source).toEqual(source)
        expect(manager.listPlugins()).toMatchObject([{ name, version: '1.0.0', enabled: true, source }])
        const manifest = JSON.parse(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')) as {
          dependencies: Record<string, string>
        }
        expect(manifest.dependencies[name]).toBe(`file:.desktop-plugin-artifacts/${sha256}.tgz`)
        verifyPrivateArtifact()
        const lockPath = join(manager.paths.profile, 'pnpm-lock.yaml')
        const legacyLock = load(readFileSync(lockPath, 'utf8')) as {
          importers: Record<string, { dependencies?: Record<string, { specifier: string }> }>
        }
        const legacyEntry = Object.values(legacyLock.importers).flatMap(importer => (
          importer.dependencies?.[name] === undefined ? [] : [importer.dependencies[name]]
        ))[0]
        if (legacyEntry === undefined) throw new Error('fixture legacy dependency missing')
        legacyEntry.specifier = manifest.dependencies[name]?.replaceAll('/', '\\') ?? ''
        writeFileSync(lockPath, dump(legacyLock, { lineWidth: -1 }))
        const legacyBytes = readFileSync(lockPath, 'utf8')
        // Plain pnpm on this synthetic profile proves the old input fails without Desktop's staged repair.
        const control = await new Promise<{
          code: string | number | null | undefined
          killed: boolean
          signal: NodeJS.Signals | null
          output: string
        }>((settle) => {
          execFile(process.execPath, [
            join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs'),
            `--config.store-dir=${manager.paths.pnpm.store}`,
            `--config.userconfig=${join(manager.paths.pnpm.config, 'npmrc')}`,
            '--config.enable-global-virtual-store=false',
            'install', '--frozen-lockfile', '--lockfile-only', '--ignore-scripts', '--offline',
          ], {
            cwd: manager.paths.profile, timeout: 30_000, encoding: 'utf8',
            env: {
              ...Object.fromEntries(Object.entries(process.env).filter(([key]) => (
                /^(?:PATH|SYSTEMROOT|COMSPEC|TEMP|TMP|WINDIR|PATHEXT|PROCESSOR_ARCHITECTURE)$/iu.test(key)
              ))),
              HOME: manager.paths.pnpm.home, USERPROFILE: manager.paths.pnpm.home,
              APPDATA: manager.paths.pnpm.config, LOCALAPPDATA: manager.paths.pnpm.state,
              XDG_CONFIG_HOME: manager.paths.pnpm.config, XDG_CACHE_HOME: manager.paths.pnpm.cache,
              NPM_CONFIG_GLOBALCONFIG: join(manager.paths.pnpm.config, 'npmrc'),
            },
          }, (error, stdout, stderr) => {
            settle({
              code: error?.code, killed: error?.killed ?? false, signal: error?.signal ?? null,
              output: `${stdout}\n${stderr}`,
            })
          })
        })
        expect(control.killed).toBe(false)
        expect(control.signal).toBeNull()
        expect(control.code).toBe(1)
        expect(control.output).toContain('ERR_PNPM_OUTDATED_LOCKFILE')
        expect(readFileSync(lockPath, 'utf8')).toBe(legacyBytes)
        await expect(manager.mutate({ type: 'plugin-toggle', name, enabled: false }, {
          beforeChange: async () => {},
          healthCheck: async () => { throw new Error('legacy repair health rejected') },
          afterChange: async () => {},
        })).rejects.toThrow('legacy repair health rejected')
        expect(readFileSync(lockPath, 'utf8')).toBe(legacyBytes)
        const hooks: DesktopProjectHooks = {
          beforeChange: async () => {}, healthCheck: async () => {}, afterChange: async () => {},
        }
        await manager.mutate({ type: 'plugin-toggle', name, enabled: false }, hooks)
        expect(manager.listPlugins()).toMatchObject([{ name, enabled: false }])
        verifyPrivateArtifact()
        await manager.mutate({ type: 'plugin-toggle', name, enabled: true }, hooks)
        expect(manager.listPlugins()).toMatchObject([{ name, enabled: true }])
        verifyPrivateArtifact()
        const previousSha256 = sha256
        writeFileSync(join(packageDir, 'index.js'), 'export const replacement = true\n')
        await c({ file: artifact, cwd: root, gzip: true }, ['package/package.json', 'package/index.js', 'package/bundle.yml'])
        bytes = readFileSync(artifact)
        sha256 = createHash('sha256').update(bytes).digest('hex')
        checksum = Buffer.from(`${sha256}  plugin.tgz\n`)
        source = {
          ...source, owner: 'replacement-owner', assetId: 11, size: bytes.length, sha256,
          checksumManifest: {
            ...source.checksumManifest, assetId: 12, size: checksum.length,
            sha256: createHash('sha256').update(checksum).digest('hex'),
            url: source.checksumManifest.url.replace('/example/', '/replacement-owner/'),
          },
        }
        const replacement = await manager.reconcileProvisioning({
          schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source }],
        }, { beforeChange: async () => {}, healthCheck: async () => {}, afterChange: async () => {} })
        expect(sha256).not.toBe(previousSha256)
        expect(replacement.plugins[0]?.receipt?.source).toEqual(source)
        expect(manager.listPlugins()).toMatchObject([{ name, version: '1.0.0', enabled: true, source }])
        verifyPrivateArtifact()
      } else {
        await expect(pending).rejects.toThrow(outcome === 'health-failure' ? 'fixture health rejected' : 'fixture activation rejected')
        expect(readFileSync(join(manager.paths.profile, 'package.json'), 'utf8')).toBe(before)
        expect(manager.listPlugins()).toEqual([])
        expect(existsSync(join(manager.paths.profile, 'desktop-plugin-receipts.json'))).toBe(false)
      }
    } finally {
      globalThis.fetch = originalFetch
      rmSync(root, { recursive: true, force: true })
    }
  },
  60_000,
)

it('installs a real pnpm graph, then executes approved scripts with the shared host instance', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'desktop-real-pnpm-')))
  const server = createServer()
  const archives = new Map<string, Buffer>()
  try {
    for (const name of ['fixture-plugin', 'node-pty']) {
      const path = writePackage(join(root, 'packages'), name, name === 'fixture-plugin'
        ? { dependencies: { 'node-pty': '1.0.0' }, peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' }, dsh: { bundle: { patch: 'bundle.yml' } } }
        : { scripts: { install: 'node install.cjs' } }, 'export {identity} from "@deepseek-ai/cordis"')
      writeFileSync(join(path, 'bundle.yml'), '[]\n')
      writeFileSync(join(path, 'install.cjs'), 'require("node:fs").writeFileSync("built.json", JSON.stringify({node:process.execPath, host:require.resolve("@deepseek-ai/cordis")}))')
      const tarball = join(root, `${name}.tgz`)
      await c({ file: tarball, cwd: join(path, '..'), gzip: true }, [name])
      archives.set(name, readFileSync(tarball))
    }
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture registry has no TCP address')
    const origin = `http://127.0.0.1:${address.port}`
    server.on('request', (request, response) => {
      const name = request.url?.slice(1).replace(/\.tgz$/u, '') ?? ''
      const archive = archives.get(name)
      if (archive === undefined) { response.writeHead(404); response.end(); return }
      if (request.url?.endsWith('.tgz')) { response.end(archive); return }
      response.setHeader('content-type', 'application/json')
      response.end(JSON.stringify({ name, 'dist-tags': { latest: '1.0.0' }, versions: { '1.0.0': {
        name, version: '1.0.0', dist: { tarball: `${origin}/${name}.tgz`, integrity: `sha512-${createHash('sha512').update(archive).digest('base64')}` },
        ...(name === 'fixture-plugin' ? { dependencies: { 'node-pty': '1.0.0' }, peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' } } : {}),
      } }, time: { '1.0.0': '2020-01-01T00:00:00.000Z' } }))
    })
    const dsh = join(root, 'dsh')
    runtimeFixture(dsh)
    const pnpm = join(root, 'pnpm.mjs')
    const pnpmLog = join(root, 'pnpm-args.jsonl')
    const realPnpm = join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs')
    writeFileSync(pnpm, `import {appendFileSync} from 'node:fs'
process.argv = process.argv.map(arg => arg === '--config.registry=https://registry.npmjs.org/' ? ${JSON.stringify(`--config.registry=${origin}`)} : arg)
appendFileSync(${JSON.stringify(pnpmLog)}, JSON.stringify(process.argv.slice(2)) + '\\n')
await import(${JSON.stringify(pathToFileURL(realPnpm).href)})
`)
    const manager = new DesktopProjectManager(resolveDesktopPaths(join(root, '.dsh')), { node: process.execPath, pnpm, dsh })
    const hooks: DesktopProjectHooks = {
      beforeChange: async () => {},
      healthCheck: async () => {},
      afterChange: async () => {},
    }
    await manager.applyRelease()
    const manifestPath = join(manager.paths.profile, 'package.json')
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string> }
    manifest.dependencies['fixture-plugin'] = '1.0.0'
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    await new Promise<void>((resolve, reject) => {
      execFile(process.execPath, [
        pnpm,
        '--config.registry=https://registry.npmjs.org/',
        `--config.store-dir=${join(root, 'fixture-store')}`,
        'install',
        '--no-frozen-lockfile',
        '--ignore-scripts',
      ], { cwd: manager.paths.profile }, (error) => {
        if (error === null) resolve()
        else reject(new Error(error.message, { cause: error }))
      })
    })
    expect(readFileSync(join(manager.paths.profile, 'pnpm-lock.yaml'), 'utf8')).toMatch(
      /fixture-plugin:\s+specifier: 1\.0\.0\s+version: 1\.0\.0/u,
    )
    await manager.mutate({ type: 'plugin-add', spec: 'fixture-plugin@1.0.0' }, hooks)
    expect(manager.listPlugins()).toEqual([{ name: 'fixture-plugin', version: '1.0.0', enabled: true }])
    const built = JSON.parse(readFileSync(join(manager.paths.profile, 'node_modules/node-pty/built.json'), 'utf8')) as { node: string; host: string }
    expect(realpathSync(built.node)).toBe(realpathSync(process.execPath))
    expect(built.host).toBe(join(dsh, 'node_modules/@deepseek-ai/cordis/index.js'))
    const entry = join(dsh, 'identity.mjs')
    writeFileSync(entry, `import {identity} from '@deepseek-ai/cordis'; import {identity as plugin} from ${JSON.stringify(pathToFileURL(join(manager.paths.profile, 'node_modules/fixture-plugin/index.js')).href)}; console.log(identity === plugin)`)
    expect(execFileSync(process.execPath, [entry], { encoding: 'utf8' }).trim()).toBe('true')
    await manager.mutate({ type: 'plugin-remove', name: 'fixture-plugin' }, hooks)
    expect(manager.listPlugins()).toEqual([])
    const pnpmCalls = readFileSync(pnpmLog, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[])
    const initialInstall = pnpmCalls.find(args => args.includes('--no-frozen-lockfile'))
    expect(initialInstall?.slice(initialInstall.indexOf('install'))).toEqual([
      'install', '--no-frozen-lockfile', '--ignore-scripts',
    ])
    const frozenRelocation = pnpmCalls.find(args => args.includes('install') && args.includes('--frozen-lockfile'))
    expect(frozenRelocation?.slice(frozenRelocation.indexOf('install'))).toEqual([
      'install', '--frozen-lockfile', '--ignore-scripts',
    ])
  } finally {
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error !== undefined) reject(error)
        else resolve()
      })
    })
    rmSync(root, { recursive: true, force: true })
  }
}, 30_000)
