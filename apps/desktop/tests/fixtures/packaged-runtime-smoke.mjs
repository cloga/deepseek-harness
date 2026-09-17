/** Built-plane ASAR inventory smoke; requires an explicitly supplied existing Electron executable. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { copyFiles, getFileMatchers } from 'app-builder-lib/out/fileMatcher.js'
import { writeDesktopRuntime } from '../../lib/types/runtime-tree.js'
import { DESKTOP_HOST_PROTOCOL_VERSION } from '../../lib/types/host-protocol.js'
import {
  packagedDesktopRuntimeRoot,
  readPackagedDesktopRuntimeDescriptor,
  verifyPackagedDesktopRuntime,
} from '../../scripts/packaged-runtime.mjs'

const executable = process.argv[2]
assert(executable, 'Pass an existing Electron executable; this smoke never downloads Electron')
// Use the pinned packager's own ASAR writer, not another archive implementation.
const packagerRequire = createRequire(import.meta.resolve('app-builder-lib/package.json'))
const { createPackageWithOptions } = await import(pathToFileURL(packagerRequire.resolve('@electron/asar')).href)
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
  const names = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host']
  const write = (path, bytes) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, bytes) }
  for (const name of names) {
    write(join(source, 'node_modules', name, 'package.json'), JSON.stringify({ name, version }))
    write(join(source, 'node_modules', name, 'index.js'), 'export const value = 1\n')
  }
  const native = 'node_modules/native/addon.node'
  const packed = 'node_modules/@deepseek-ai/dsh/index.js'
  write(join(source, native), 'native fixture bytes')
  if (process.platform !== 'win32') {
    chmodSync(join(source, native), 0o755)
    chmodSync(join(source, packed), 0o755)
  }
  write(join(source, 'node_modules/.pnpm/notice'), 'retained hidden metadata')
  write(join(source, 'node_modules/native/unknown.asset'), 'retained unknown asset')
  write(join(source, 'package.json'), '{"type":"module"}\n')
  writeDesktopRuntime(source, { schemaVersion: 1, version, nodeVersion: '24.17.0', pnpmVersion: '11.7.0', hostProtocolVersion: DESKTOP_HOST_PROTOCOL_VERSION }, names)
  const expected = readFileSync(join(source, 'desktop-runtime.json'))
  const stage = join(root, 'app')
  const mappings = config.files.filter(entry => typeof entry === 'object').map(entry => ({
    ...entry, from: entry.to === 'dsh' ? source : join(source, 'node_modules'),
  }))
  assert.equal(mappings.length, 2, 'The descriptor and complete node_modules need their separate mappings')
  await copyFiles(getFileMatchers({ files: mappings }, 'files', stage, {
    defaultSrc: root, globalOutDir: join(root, 'output'), macroExpander: value => value, customBuildOptions: {},
  }), undefined, false)
  const resources = join(root, 'resources')
  mkdirSync(resources)
  const archive = join(resources, 'app.asar')
  const runtime = packagedDesktopRuntimeRoot(resources)
  const target = { platform: process.platform, arch: process.arch }
  const archiveStage = async () => { await createPackageWithOptions(stage, archive, { unpack: '**/*.node' }) }
  const verify = () => verifyPackagedDesktopRuntime(resolve(executable), runtime, version, target)
  await archiveStage()
  assert.deepEqual(readPackagedDesktopRuntimeDescriptor(resolve(executable), runtime), expected)
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
  process.stdout.write('ASAR runtime: exact descriptor + complete inventory verified; packed/unpacked tampering, missing files, extra files, version and target canaries rejected\n')
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
}
