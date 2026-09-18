/** Built-plane ASAR inventory and skill smoke for an explicitly supplied packaged Windows application. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { copyFiles, FileMatcher, getFileMatchers } from 'app-builder-lib/out/fileMatcher.js'
import { writeDesktopRuntime } from '../../lib/types/runtime-tree.js'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../lib/types/host-protocol.js'
import { normalizeDesktopRuntimePackageMetadata } from '../../scripts/runtime-package-metadata.mjs'
import { verifyPackagedSkills } from './packaged-skills-smoke.mjs'
import {
  packagedDesktopRuntimeRoot,
  readPackagedDesktopRuntimeDescriptor,
  verifyPackagedDesktopRuntime,
} from '../../scripts/packaged-runtime.mjs'

const executable = process.argv[2]
assert(executable, 'Pass a packaged Windows Electron executable; this smoke never downloads Electron')
verifyPackagedSkills(executable)
// Exercise the pinned builder's real transform and ASAR pipeline, not only the archive writer.
const packagerRequire = createRequire(import.meta.resolve('app-builder-lib/package.json'))
const { createTransformer } = packagerRequire('app-builder-lib/out/fileTransformer.js')
const { computeFileSets, transformFiles } = packagerRequire('app-builder-lib/out/util/appFileCopier.js')
const { NodeModuleCopyHelper } = packagerRequire('app-builder-lib/out/util/NodeModuleCopyHelper.js')
const { AsarPackager } = packagerRequire('app-builder-lib/out/asar/asarUtil.js')
const { readAsar } = packagerRequire('app-builder-lib/out/asar/asar.js')
const root = mkdtempSync(join(tmpdir(), 'desktop-packaged-runtime-'))
try {
  for (const name of Object.keys(process.env)) if (/^DSH_DESKTOP_/iu.test(name)) delete process.env[name]
  process.env.DSH_DESKTOP_APP_ID = 'com.example.runtime-smoke'
  process.env.DSH_DESKTOP_TARGET_PLATFORM = 'win32'
  process.env.DSH_DESKTOP_TARGET_ARCH = 'x64'
  process.env.DSH_DESKTOP_UNSIGNED = '1'
  const { createElectronBuilderConfig } = await import('../../electron-builder.config.mjs')
  const config = createElectronBuilderConfig(process.env, 'win32', 'x64')
  const version = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version
  const source = join(root, 'prepared-dsh')
  const shell = join(root, 'shell')
  const names = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host']
  const write = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes) }
  const preservedMetadata = name => ({ name, version, type: 'module', exports: { '.': './index.js' },
    dsh: { bundle: { patch: 'cordis.patch.yml' } }, dependencies: { fixture: '1.0.0' } })
  const originalMetadata = name => `${JSON.stringify({ ...preservedMetadata(name), scripts: { test: 'not executed' },
    keywords: ['fixture'], bugs: 'https://example.invalid/issues', gitHead: 'fixture', build: {}, dist: {}, _id: 'fixture', babel: {} }, undefined, 2)}\n`
  for (const name of [...names, 'native']) {
    write(join(source, 'node_modules', name, 'package.json'), originalMetadata(name))
    write(join(source, 'node_modules', name, 'index.js'), 'export const value = 1\n')
  }
  const native = 'node_modules/native/addon.node'
  const packed = 'node_modules/@deepseek-ai/dsh/index.js'
  const packedManifest = 'node_modules/@deepseek-ai/dsh/package.json'
  const unpackedManifest = 'node_modules/native/package.json'
  write(join(source, native), 'native fixture bytes')
  if (process.platform !== 'win32') {
    chmodSync(join(source, native), 0o755)
    chmodSync(join(source, packed), 0o755)
  }
  const canaries = new Map([
    ['node_modules/.pnpm/notice', 'retained hidden metadata'],
    ['node_modules/native/unknown.asset', 'retained unknown asset'],
    ['node_modules/@deepseek-ai/dsh/README.md', 'retained README\n'],
    ['node_modules/@deepseek-ai/dsh/types.d.ts', 'export interface Retained {}\n'],
    ['node_modules/@deepseek-ai/dsh/.hidden', 'retained hidden asset\n'],
    ['node_modules/@deepseek-ai/dsh/test/data.txt', 'retained test asset\n'],
  ])
  for (const [path, bytes] of canaries) write(join(source, path), bytes)
  write(join(source, 'package.json'), '{"type":"module"}\n')
  write(join(shell, 'package.json'), '{"name":"fixture-shell","version":"1.0.0"}\n')
  const release = { schemaVersion: 1, version, nodeVersion: '24.17.0', pnpmVersion: '11.7.0', hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION }
  const stage = join(root, 'app')
  const mappings = config.files.filter(entry => typeof entry === 'object').map(entry => ({
    ...entry, from: entry.to === 'dsh' ? source : join(source, 'node_modules'),
  }))
  assert.equal(mappings.length, 2, 'The descriptor and complete node_modules need their separate mappings')
  const copyStage = async () => {
    rmSync(stage, { recursive: true, force: true })
    await copyFiles(getFileMatchers({ files: mappings }, 'files', stage, {
      defaultSrc: root, globalOutDir: join(root, 'output'), macroExpander: value => value, customBuildOptions: {},
    }), undefined, false)
  }
  const resources = join(root, 'resources')
  mkdirSync(resources)
  const archive = join(resources, 'app.asar')
  const runtime = packagedDesktopRuntimeRoot(resources)
  const target = { platform: process.platform, arch: process.arch }
  const builderInfo = { appInfo: { type: 'module' }, config, getWorkspaceRoot: async () => root }
  const packager = { info: builderInfo }
  const archiveStage = async () => {
    // Remove stale sidecars so a deletion canary measures the newly packed inventory.
    rmSync(`${archive}.unpacked`, { recursive: true, force: true })
    const destination = join(root, 'archive-input')
    const transformer = createTransformer(shell, config, undefined, null)
    const fileSets = await computeFileSets([new FileMatcher(stage, destination, value => value, ['**/*'])], transformer, packager, false)
    // Raw custom mappings have no moduleRootPath. A real node-module copier contribution
    // supplies it so smartUnpack must carry the native package's manifest, not just its .node.
    const nativeSource = join(stage, 'dsh', 'node_modules', 'native')
    const nativeDestination = join(destination, 'dsh', 'node_modules', 'native')
    const copier = new NodeModuleCopyHelper(new FileMatcher(nativeSource, nativeDestination, value => value, ['**/*']), builderInfo)
    const files = await copier.collectNodeModules({ name: 'native', dir: nativeSource }, [], join('dsh', 'node_modules', 'native'))
    fileSets.push({ src: nativeSource, destination: nativeDestination, files, metadata: copier.metadata })
    for (const fileSet of fileSets) await transformFiles(transformer, fileSet)
    const unpack = new FileMatcher(stage, destination, value => value, config.asarUnpack).createFilter()
    await new AsarPackager(packager, { defaultDestination: destination, resourcePath: resources,
      options: {}, unpackPattern: unpack }).pack(fileSets)
  }
  const verify = () => verifyPackagedDesktopRuntime(resolve(executable), runtime, version, target)

  // Negative control: sealing raw npm manifests misses the builder's later metadata rewrite.
  writeDesktopRuntime(source, release, names)
  await copyStage()
  await archiveStage()
  await assert.rejects(verify(), /integrity verification failed/)
  rmSync(join(source, 'desktop-runtime.json'))
  const changed = await normalizeDesktopRuntimePackageMetadata(source, shell)
  assert.deepEqual([...changed].sort(), [...names, 'native'].map(name => `node_modules/${name}/package.json`).sort())
  for (const name of [...names, 'native']) {
    assert.equal(readFileSync(join(source, 'node_modules', name, 'package.json'), 'utf8'), JSON.stringify(preservedMetadata(name), undefined, 2))
  }
  assert.deepEqual(await normalizeDesktopRuntimePackageMetadata(source, shell), [], 'A second normalization must be byte-preserving')
  writeDesktopRuntime(source, release, names)
  const expected = readFileSync(join(source, 'desktop-runtime.json'))
  await copyStage()
  await archiveStage()
  assert.deepEqual(readPackagedDesktopRuntimeDescriptor(resolve(executable), runtime), expected)
  const packedArchive = await readAsar(archive)
  assert.notEqual(packedArchive.getFile(join('dsh', packedManifest)).unpacked, true)
  assert.equal(packedArchive.getFile(join('dsh', unpackedManifest)).unpacked, true)
  for (const path of [packedManifest, unpackedManifest]) {
    assert.deepEqual(await packedArchive.readFile(join('dsh', path)), readFileSync(join(source, path)))
  }
  for (const [path, bytes] of canaries) assert.equal((await packedArchive.readFile(join('dsh', path))).toString(), bytes)
  await verify()
  await assert.rejects(verifyPackagedDesktopRuntime(resolve(executable), runtime, '9.9.9', target), /does not match Electron/)
  await assert.rejects(verifyPackagedDesktopRuntime(resolve(executable), runtime, version, { ...target, arch: 'invalid' }), /incompatible platform/)
  const orphan = join(`${archive}.unpacked`, 'dsh', 'unrecorded.txt')
  writeFileSync(orphan, 'must not be hidden by virtual ASAR enumeration')
  await assert.rejects(verify(), /unpacked file inventory verification failed/)
  rmSync(orphan)
  const unpacked = join(`${archive}.unpacked`, 'dsh', native)
  if (process.platform !== 'win32') {
    chmodSync(unpacked, 0o644)
    await assert.rejects(verify(), /integrity verification failed/)
    chmodSync(unpacked, 0o755)
    chmodSync(join(stage, 'dsh', packed), 0o644)
    await archiveStage()
    await assert.rejects(verify(), /integrity verification failed/)
    chmodSync(join(stage, 'dsh', packed), 0o755)
    await archiveStage()
    await verify()
  }
  writeFileSync(unpacked, 'tampered native bytes')
  await assert.rejects(verify(), /integrity verification failed/)
  rmSync(unpacked)
  await assert.rejects(verify(), /unpacked file inventory verification failed/)
  await archiveStage()
  writeFileSync(join(stage, 'dsh', packed), 'export const value = 2\n')
  await archiveStage()
  await assert.rejects(verify(), /integrity verification failed/)
  rmSync(join(stage, 'dsh', packed))
  await archiveStage()
  await assert.rejects(verify(), /integrity verification failed/)
  writeFileSync(join(stage, 'dsh', packed), 'export const value = 1\n')
  if (process.platform !== 'win32') chmodSync(join(stage, 'dsh', packed), 0o755)
  await archiveStage()
  await verify()
  writeFileSync(join(stage, 'dsh', 'unrecorded.txt'), 'must not be ignored')
  await archiveStage()
  await assert.rejects(verify(), /integrity verification failed/)
  process.stdout.write('ASAR runtime: real builder transformation rejected pre-normalization seal; normalized packed/smart-unpacked metadata + exact descriptor verified; tampering, missing/extra files, version and target canaries rejected\n')
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
