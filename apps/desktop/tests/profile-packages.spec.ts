import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it } from 'vitest'
import { createPluginProfile } from '../src/project-manager.ts'
import {
  linkDesktopHostPackages,
  readDesktopProfileState,
  recordDesktopRuntimeProfile,
  unlinkDesktopHostPackages,
  validateDesktopPluginGraph,
} from '../src/profile-packages.ts'
import { runtimeFixture, writePackage } from './runtime-fixture.ts'

const roots: string[] = []
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'desktop-profile-'))
  roots.push(root)
  const dsh = join(root, 'dsh')
  const runtime = runtimeFixture(dsh)
  const profile = join(root, 'profile')
  createPluginProfile(profile)
  linkDesktopHostPackages(profile, dsh, runtime)
  return { root, dsh, runtime, profile }
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('loads one shared ESM instance from both host and external plugin while keeping ordinary dependencies private', () => {
  const { dsh, runtime, profile } = fixture()
  writePackage(join(dsh, 'node_modules'), 'ordinary', {}, 'export default "host"')
  writePackage(join(profile, 'node_modules'), 'ordinary', {}, 'export default "plugin"')
  const plugin = writePackage(join(profile, 'node_modules'), 'plugin', {
    peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' }, dependencies: { ordinary: '1.0.0' },
  }, 'export { identity } from "@deepseek-ai/cordis"; export { default as ordinary } from "ordinary"')
  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin'])
  const entry = join(dsh, 'check.mjs')
  writeFileSync(entry, `import {identity} from '@deepseek-ai/cordis'; import ordinary from 'ordinary'; import * as plugin from ${JSON.stringify(pathToFileURL(join(plugin, 'index.js')).href)}; console.log(JSON.stringify({same:identity===plugin.identity, host:ordinary, plugin:plugin.ordinary}))`)
  const output = execFileSync(process.execPath, [entry], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '' } })
  expect(JSON.parse(output)).toEqual({ same: true, host: 'host', plugin: 'plugin' })
})
it('runtime resolution retains and ignores an existing Link generation', () => {
  const { dsh, runtime, profile } = fixture()
  const links = readDesktopProfileState(profile)?.links
  expect(links?.length).toBeGreaterThan(0)

  recordDesktopRuntimeProfile(profile, runtime)
  expect(readDesktopProfileState(profile)?.links).toEqual(links)
  expect(lstatSync(join(profile, 'node_modules/@deepseek-ai/cordis')).isSymbolicLink()).toBe(true)
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, [], 'runtime') }).not.toThrow()
})
it.each(['nested', 'alias'])('rejects a %s second copy of a host package', (placement) => {
  const { dsh, runtime, profile } = fixture()
  const plugin = writePackage(join(profile, 'node_modules'), 'plugin')
  if (placement === 'nested') writePackage(join(plugin, 'node_modules'), '@deepseek-ai/cordis')
  else writePackage(join(profile, 'node_modules'), 'alias', { name: '@deepseek-ai/cordis' })
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }).toThrow(/duplicate or aliased/u)
})
it.each(['dependencies', 'optionalDependencies'] as const)('rejects a shared peer also declared in %s', (section) => {
  const { dsh, runtime, profile } = fixture()
  writePackage(join(profile, 'node_modules'), 'plugin', {
    [section]: { '@deepseek-ai/cordis': '^1.0.0' },
    peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' },
  })
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }).toThrow(/peer dependency/u)
})
it('rejects incompatible peers only when the plugin is enabled', () => {
  const { dsh, runtime, profile } = fixture()
  writePackage(join(profile, 'node_modules'), 'plugin', { peerDependencies: { '@deepseek-ai/cordis': '^2.0.0' } })
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }).toThrow(/found 1.0.0/u)
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, []) }).not.toThrow()
})
it('does not satisfy a required Node peer through a Client external declaration', () => {
  const { dsh, runtime, profile } = fixture()
  const external = `desktop-client-external-${randomUUID()}`
  writePackage(join(profile, 'node_modules'), 'plugin', {
    peerDependencies: { [external]: '1.0.0' },
    dsh: { client: { external: [external] } },
  })
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) })
    .toThrow(`plugin requires missing ${external}@1.0.0`)
})
it('rejects an ancestor React peer even when React is a Client external', () => {
  const { root, dsh, runtime, profile } = fixture()
  writePackage(join(root, 'node_modules'), 'react', { version: '18.3.1' })
  writePackage(join(profile, 'node_modules'), 'plugin', {
    peerDependencies: { react: '^18.2.0' },
    dsh: { client: { external: ['react'] } },
  })
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) })
    .toThrow('plugin resolves react outside its owned packages')
})
it('treats an ancestor optional peer as absent without weakening required package ownership', () => {
  const root = mkdtempSync(join(tmpdir(), 'desktop-profile-ancestor-'))
  roots.push(root)
  const dsh = join(root, 'dsh')
  const runtime = runtimeFixture(dsh)
  const profile = join(root, '.dsh', 'profiles', 'desktop')
  createPluginProfile(profile)
  linkDesktopHostPackages(profile, dsh, runtime)
  writePackage(join(profile, 'node_modules'), 'dsh-github-copilot', {
    dependencies: { '@earendil-works/pi-ai': '0.85.1' },
  })
  const adapter = writePackage(join(profile, 'node_modules'), '@earendil-works/pi-ai', {
    dependencies: { '@google/genai': '1.52.0' },
  })
  writePackage(join(profile, 'node_modules'), '@google/genai', {
    peerDependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
    peerDependenciesMeta: { '@modelcontextprotocol/sdk': { optional: true } },
  })
  const legacy = writePackage(join(root, 'legacy'), '@modelcontextprotocol/sdk')
  mkdirSync(join(root, '.dsh', 'profiles', 'node_modules', '@modelcontextprotocol'), { recursive: true })
  symlinkSync(
    legacy,
    join(root, '.dsh', 'profiles', 'node_modules', '@modelcontextprotocol', 'sdk'),
    process.platform === 'win32' ? 'junction' : 'dir',
  )
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, ['dsh-github-copilot']) }).not.toThrow()
  writeFileSync(join(adapter, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-ai',
    version: '0.85.1',
    dependencies: { '@google/genai': '1.52.0', '@modelcontextprotocol/sdk': '^1.0.0' },
  }))
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, ['dsh-github-copilot']) })
    .toThrow('@earendil-works/pi-ai resolves @modelcontextprotocol/sdk outside its owned packages')
  writeFileSync(join(adapter, 'package.json'), JSON.stringify({
    name: '@earendil-works/pi-ai',
    version: '0.85.1',
    dependencies: { '@google/genai': '1.52.0' },
  }))
  writeFileSync(join(profile, 'node_modules', '@google', 'genai', 'package.json'), JSON.stringify({
    name: '@google/genai',
    version: '1.0.0',
    peerDependencies: { '@modelcontextprotocol/sdk': '^1.0.0' },
  }))
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, ['dsh-github-copilot']) })
    .toThrow('@google/genai resolves @modelcontextprotocol/sdk outside its owned packages')
})
it('keeps Client-only externals outside the Node dependency graph', () => {
  const { dsh, runtime, profile } = fixture()
  writePackage(join(profile, 'node_modules'), 'plugin', {
    peerDependencies: { '@deepseek-ai/cordis': '^1.0.0' },
    dsh: { client: { external: ['react'] } },
  })
  expect(() => { validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }).not.toThrow()
})
it('refuses to satisfy a plugin dependency from an ancestor CLI project', () => {
  const { root, dsh, runtime, profile } = fixture()
  writePackage(join(root, 'node_modules'), 'ambient')
  writePackage(join(profile, 'node_modules'), 'plugin', { dependencies: { ambient: '1.0.0' } })
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }).toThrow(/outside its owned packages/u)
})
it('removes broken owned links without following them', () => {
  const { root, profile } = fixture()
  writePackage(join(profile, 'node_modules'), 'plugin')
  rmSync(join(root, 'dsh'), { recursive: true })
  expect(() =>{  unlinkDesktopHostPackages(profile) }).not.toThrow()
})
it('refuses to replace an unowned package at a managed name', () => {
  const { profile } = fixture()
  unlinkSync(join(profile, 'node_modules/@deepseek-ai/cordis'))
  writePackage(join(profile, 'node_modules'), '@deepseek-ai/cordis')
  expect(() =>{  unlinkDesktopHostPackages(profile) }).toThrow(/unowned package/u)
})
it('rejects private package links instead of following cycles or old transaction paths', () => {
  const { dsh, runtime, profile } = fixture()
  const plugin = writePackage(join(profile, 'node_modules'), 'plugin')
  symlinkSync(plugin, join(profile, 'node_modules/alias'), process.platform === 'win32' ? 'junction' : 'dir')
  expect(() =>{  validateDesktopPluginGraph(profile, dsh, runtime, ['plugin']) }).toThrow(/linked private package/u)
})
