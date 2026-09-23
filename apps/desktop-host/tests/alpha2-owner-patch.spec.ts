/** The Desktop-only last layer overrides hostile or stale Web flags before any row can print a launch token. */
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { composeEntries, loadOverlayPatches } from '@deepseek-ai/dsh-app-boot'
import type { PatchOptions } from '@deepseek-ai/cordis-plugin-include'
import { expect, it } from 'vitest'
import { alpha2OwnerCompositionGuard } from '../src/alpha2-owner-composition.ts'

const root = fileURLToPath(new URL('../../../', import.meta.url))
const web = join(root, 'packages', 'bundle', 'web-app', 'cordis.patch.yml')
const owner = join(root, 'apps', 'desktop-host', 'config', 'alpha2-desktop.cordis.patch.yml')

it('closes URL logging, browser launch, LAN trust and all-interface bind above user and home patches', () => {
  const hostile: PatchOptions[] = [
    { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', disabled: true, config: { host: '0.0.0.0', port: 8080 } },
    { id: 'web-runtime', name: '@deepseek-ai/dsh-web-app', disabled: true,
      config: { openBrowser: true, printUrl: true, surfaceContext: true, trustedHosts: ['lan.example'] } },
  ]
  const sources = [
    loadOverlayPatches('alpha2 owner test', web), hostile,
    loadOverlayPatches('alpha2 owner test', owner),
  ]
  expect(() => alpha2OwnerCompositionGuard.beforeCompose(sources.flat())).not.toThrow()
  const rows = composeEntries(sources)
  expect(() => alpha2OwnerCompositionGuard.afterCompose(rows)).not.toThrow()
  const carrier = rows.find(row => row.id === 'webserver')
  const runtime = rows.find(row => row.id === 'web-runtime')
  expect(carrier).toMatchObject({
    name: '@deepseek-ai/dsh-host-webserver', disabled: false, inject: ['webStartup'],
    config: { host: '127.0.0.1', port: 0, compression: 'gzip', compressionLevel: 1, compressionThresholdBytes: 1024 },
  })
  expect(runtime).toMatchObject({
    name: '@deepseek-ai/dsh-web-app', disabled: false, inject: ['webStartup'],
    config: { openBrowser: false, printUrl: false, surfaceContext: false, trustedHosts: [] },
  })
  expect(Object.keys(carrier?.config ?? {}).sort()).toEqual([
    'compression', 'compressionLevel', 'compressionThresholdBytes', 'host', 'port',
  ])
  expect(Object.keys(runtime?.config ?? {}).sort()).toEqual([
    'openBrowser', 'printUrl', 'surfaceContext', 'trustedHosts',
  ])
})

it.each([
  { kind: 'replaced Web runtime insert', patches: [{ insert: [
    { id: 'web-runtime', name: 'private-sentinel-module', config: { printUrl: true } },
  ] }] },
  { kind: 'same-name duplicate Webserver insert', patches: [{ insert: [
    { id: 'webserver', name: '@deepseek-ai/dsh-host-webserver', config: { host: '0.0.0.0', port: 8080 } },
  ] }] },
  { kind: 'name-qualified override', patches: [
    { id: 'web-runtime', name: 'private-sentinel-module', config: { printUrl: true } },
  ] },
  { kind: 'nested duplicate protected id', patches: [{ insert: [
    { id: 'nested', name: 'cordis:group', group: true, config: [
      { id: 'web-runtime', name: 'private-sentinel-module', config: { printUrl: true } },
    ] },
  ] }] },
] satisfies Array<{ kind: string; patches: PatchOptions[] }>)(
  'refuses a $kind before Include can log a user-owned name or mount the Web runtime', ({ patches }) => {
    const raw = [
      ...loadOverlayPatches('alpha2 owner test', web), ...patches,
      ...loadOverlayPatches('alpha2 owner test', owner),
    ]
    try { alpha2OwnerCompositionGuard.beforeCompose(raw) }
    catch (error) {
      expect(String(error)).toContain('protected Web carrier composition was replaced')
      expect(String(error)).not.toContain('private-sentinel-module')
      return
    }
    throw new Error('Unsafe protected Web id was not refused before composing')
  },
)
