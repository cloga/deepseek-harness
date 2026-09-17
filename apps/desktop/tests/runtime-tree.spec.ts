import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { DESKTOP_HOST_PACKAGE, DESKTOP_HOST_RUNTIME_FILES } from '../src/core-package-set.ts'
import { DESKTOP_RUNTIME_FILE, desktopRuntimeId, readDesktopRuntime, runtimePath, verifyDesktopRuntime, writeDesktopRuntime } from '../src/runtime-tree.ts'
import { runtimeFixture } from './runtime-fixture.ts'

const roots: string[] = []
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'desktop-runtime-'))
  roots.push(root)
  runtimeFixture(join(root, 'dsh'))
  return root
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('verifies a runtime after relocation without depending on build paths', async () => {
  const root = fixture()
  const before = await verifyDesktopRuntime(join(root, 'dsh'), '1.0.0')
  cpSync(join(root, 'dsh'), join(root, 'moved'), { recursive: true })
  expect(desktopRuntimeId(await verifyDesktopRuntime(join(root, 'moved'), '1.0.0'))).toBe(desktopRuntimeId(before))
})
it.each(['changed', 'same-size', 'extra', 'missing'])('checks %s runtime bytes only during build verification', async (operation) => {
  const dsh = join(fixture(), 'dsh')
  const before = readDesktopRuntime(dsh)
  if (operation === 'changed') writeFileSync(join(dsh, 'package.json'), '{}')
  if (operation === 'same-size') writeFileSync(join(dsh, 'package.json'), '{"type":"Module"}\n')
  if (operation === 'extra') writeFileSync(join(dsh, 'extra'), '')
  if (operation === 'missing') rmSync(join(dsh, 'package.json'))
  expect(readDesktopRuntime(dsh)).toEqual(before)
  await expect(verifyDesktopRuntime(dsh, '1.0.0')).rejects.toThrow(/integrity/u)
})
it('reports bounded missing, unexpected and changed inventory metadata without file contents', async () => {
  const dsh = join(fixture(), 'dsh')
  writeFileSync(join(dsh, 'removed.txt'), 'before')
  const previous = readDesktopRuntime(dsh)
  writeDesktopRuntime(dsh, previous.release, previous.sharedPackages.map(entry => entry.name))
  rmSync(join(dsh, 'removed.txt'))
  const privateBody = 'runtime-file-body-must-not-appear-in-diagnostics'
  writeFileSync(join(dsh, 'package.json'), privateBody)
  for (let index = 0; index < 12; index++) writeFileSync(join(dsh, `extra-${String(index)}`), '')
  const error: unknown = await verifyDesktopRuntime(dsh, '1.0.0').catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error('Expected runtime integrity rejection')
  const prefix = 'desktop runtime: integrity verification failed: '
  expect(error.message.startsWith(prefix)).toBe(true)
  const diagnostic = JSON.parse(error.message.slice(prefix.length)) as Record<string, unknown>
  expect(diagnostic).toMatchObject({ missing: 1, unexpected: 12, changed: 1, invalidExpected: 0, recordOrderOrShape: false })
  expect(diagnostic.samples).toHaveLength(5)
  expect(error.message).not.toContain(privateBody)
  expect(error.message).not.toContain(dsh)
  expect(error.message.length).toBeLessThan(4096)
})
it('bounds untrusted paths and omits invalid expected hash payloads from diagnostics', async () => {
  const dsh = join(fixture(), 'dsh')
  const path = join(dsh, DESKTOP_RUNTIME_FILE)
  const descriptor = JSON.parse(readFileSync(path, 'utf8')) as { files: Record<string, unknown>[] }
  const privateMetadata = 'descriptor-field-must-not-appear-in-diagnostics'
  descriptor.files.find(entry => entry.path === 'package.json')!.sha256 = { privateMetadata }
  descriptor.files.push({ path: 'long-'.repeat(1000), bytes: 0, sha256: '0'.repeat(64), executable: false })
  writeFileSync(path, JSON.stringify(descriptor))
  const error: unknown = await verifyDesktopRuntime(dsh, '1.0.0').catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(Error)
  if (!(error instanceof Error)) throw new Error('Expected runtime integrity rejection')
  expect(error.message).toContain('"missing":1')
  expect(error.message).toContain('"changed":1')
  expect(error.message).toContain('"sha256":null')
  expect(error.message).not.toContain(privateMetadata)
  expect(error.message.length).toBeLessThan(4096)
})
it('identifies record ordering differences without accepting the changed descriptor', async () => {
  const dsh = join(fixture(), 'dsh')
  const path = join(dsh, DESKTOP_RUNTIME_FILE)
  const descriptor = JSON.parse(readFileSync(path, 'utf8')) as { files: unknown[] }
  descriptor.files.reverse()
  writeFileSync(path, JSON.stringify(descriptor))
  await expect(verifyDesktopRuntime(dsh, '1.0.0')).rejects.toThrow('"recordOrderOrShape":true')
})
it('identifies duplicate expected records without accepting the changed descriptor', async () => {
  const dsh = join(fixture(), 'dsh')
  const path = join(dsh, DESKTOP_RUNTIME_FILE)
  const descriptor = JSON.parse(readFileSync(path, 'utf8')) as { files: unknown[] }
  descriptor.files.push(descriptor.files[0])
  writeFileSync(path, JSON.stringify(descriptor))
  await expect(verifyDesktopRuntime(dsh, '1.0.0')).rejects.toThrow('"invalidExpected":1')
})
it('rejects filesystem links and incompatible targets', async () => {
  const dsh = join(fixture(), 'dsh')
  await expect(verifyDesktopRuntime(dsh, '1.0.0', { platform: process.platform, arch: 'wrong' })).rejects.toThrow(/incompatible/u)
  symlinkSync(join(dsh, 'node_modules'), join(dsh, 'outside'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(readDesktopRuntime(dsh).release.version).toBe('1.0.0')
  await expect(verifyDesktopRuntime(dsh, '1.0.0')).rejects.toThrow(/unsupported filesystem/u)
})
it('reads file inventory records unchanged during startup', () => {
  const dsh = join(fixture(), 'dsh')
  const path = join(dsh, DESKTOP_RUNTIME_FILE)
  const descriptor = JSON.parse(readFileSync(path, 'utf8')) as { files: unknown[] }
  descriptor.files.unshift({ path: '../outside', bytes: -1.5, sha256: 'unchecked', executable: 'unchecked' })
  writeFileSync(path, JSON.stringify(descriptor))
  expect(readDesktopRuntime(dsh).files).toEqual(descriptor.files)
})
it.each(['missing', 'directory'])('checks a %s Host entry only during build verification', async (operation) => {
  const dsh = join(fixture(), 'dsh')
  const path = join(dsh, 'node_modules', DESKTOP_HOST_PACKAGE, DESKTOP_HOST_RUNTIME_FILES[0])
  rmSync(path)
  if (operation === 'directory') mkdirSync(path)
  expect(readDesktopRuntime(dsh).release.version).toBe('1.0.0')
  await expect(verifyDesktopRuntime(dsh, '1.0.0')).rejects.toThrow(/integrity/u)
})
it('checks the shell version only during build verification', async () => {
  const dsh = join(fixture(), 'dsh')
  expect(readDesktopRuntime(dsh).release.version).toBe('1.0.0')
  await expect(verifyDesktopRuntime(dsh, '2.0.0')).rejects.toThrow(/does not match Electron/u)
})
it.each([
  { schemaVersion: 2 },
  { platform: 'other' },
  { arch: 'other' },
  { release: { schemaVersion: 2 } },
  { release: { hostProtocolVersion: 999 } },
  { release: { nodeVersion: 'invalid' } },
  { release: { pnpmVersion: 'invalid' } },
])('checks release compatibility only during build verification: %j', async (patch) => {
  const dsh = join(fixture(), 'dsh')
  const path = join(dsh, DESKTOP_RUNTIME_FILE)
  const original = readDesktopRuntime(dsh)
  const descriptor = { ...original, ...patch, release: { ...original.release, ...patch.release } }
  writeFileSync(path, JSON.stringify(descriptor))
  expect(readDesktopRuntime(dsh)).toEqual(descriptor)
  await expect(verifyDesktopRuntime(dsh, '1.0.0')).rejects.toThrow(/invalid|incompatible/u)
})
it.each(['missing', 'invalid-json', 'mismatched'])('checks %s shared manifests only during build verification', async (operation) => {
  const dsh = join(fixture(), 'dsh')
  const before = readDesktopRuntime(dsh)
  const path = join(dsh, 'node_modules', DESKTOP_HOST_PACKAGE, 'package.json')
  if (operation === 'missing') rmSync(path)
  else writeFileSync(path, operation === 'invalid-json' ? '{' : '{}')
  expect(readDesktopRuntime(dsh)).toEqual(before)
  await expect(verifyDesktopRuntime(dsh, '1.0.0')).rejects.toThrow()
})
it('rejects a descriptor that maps a shared package outside node_modules', async () => {
  const dsh = join(fixture(), 'dsh')
  const path = join(dsh, DESKTOP_RUNTIME_FILE)
  const descriptor = JSON.parse(readFileSync(path, 'utf8')) as { sharedPackages: { path: string }[] }
  descriptor.sharedPackages[0]!.path = '../outside'
  writeFileSync(path, JSON.stringify(descriptor))
  await expect(verifyDesktopRuntime(dsh, '1.0.0')).rejects.toThrow(/shared package record/u)
})
it('verifies recorded executable permissions only on Unix', async () => {
  const dsh = join(fixture(), 'dsh')
  const path = join(dsh, DESKTOP_RUNTIME_FILE)
  const descriptor = JSON.parse(readFileSync(path, 'utf8')) as { files: { executable: boolean }[] }
  descriptor.files[0]!.executable = !descriptor.files[0]!.executable
  writeFileSync(path, JSON.stringify(descriptor))
  if (process.platform === 'win32') await expect(verifyDesktopRuntime(dsh, '1.0.0')).resolves.toMatchObject(descriptor)
  else await expect(verifyDesktopRuntime(dsh, '1.0.0')).rejects.toThrow(/integrity/u)
})
it.each(['../outside', '/absolute', 'C:/absolute', 'a\\b', 'a//b', './a'])('rejects nonportable path %s', (path) => {
  expect(() => runtimePath('/runtime', path)).toThrow(/invalid relative path/u)
})
