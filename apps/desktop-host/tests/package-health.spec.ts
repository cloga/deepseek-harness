/** Desktop package readiness is a bounded read of the Manager's settled Loader leaves. */
import { Context } from '@deepseek-ai/cordis'
import type PluginManager from '@deepseek-ai/dsh-plugin-manager'
import { afterEach, expect, it, vi } from 'vitest'
import { readDesktopPackageHealth } from '../src/package-health.ts'

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

const healthyBundle = {
  name: 'core', version: '1.0.0', enabled: true, installed: false, optional: false, removable: false,
  rows: [{ rowId: 'probe', moduleName: 'probe', entryId: 'entry:probe' }], overrides: [],
}
const activePlugin = { entryId: 'entry:probe', moduleName: 'probe', enabled: true, fiberPhase: 'active' }
function context(bundles: readonly object[], plugins: readonly object[]): Context {
  const ctx = new Context()
  contexts.push(ctx)
  ctx.provide('pluginManager', {
    listBundles: vi.fn(async () => bundles), listPlugins: vi.fn(async () => plugins),
  } as unknown as PluginManager)
  return ctx
}

it('reports absence rather than inventing Desktop package readiness without a Manager', async () => {
  const ctx = new Context()
  contexts.push(ctx)
  expect(await readDesktopPackageHealth(ctx)).toBeUndefined()
})

it('reports only scalar active/failed package health after settled profile state', async () => {
  const ctx = context([
    healthyBundle,
    { name: 'inactive', enabled: false, rows: [], overrides: [] },
    { name: 'broken', enabled: false, error: { code: 'not-bundle' }, rows: [], overrides: [] },
    { name: 'pending', enabled: true, rows: [{ rowId: 'waiting', moduleName: 'waiting', entryId: 'entry:waiting' }], overrides: [] },
  ], [activePlugin, { entryId: 'entry:waiting', moduleName: 'waiting', enabled: true, fiberPhase: 'pending' }])
  expect(await readDesktopPackageHealth(ctx)).toEqual([
    { name: 'core', version: '1.0.0', enabled: true, healthy: true },
    { name: 'inactive', enabled: false, healthy: true },
    { name: 'broken', enabled: false, healthy: false },
    { name: 'pending', enabled: true, healthy: false },
  ])
})

it('does not count an explicitly disabled nested row as an unhealthy active bundle', async () => {
  const ctx = context([healthyBundle], [{ ...activePlugin, enabled: false, fiberPhase: null }])
  expect(await readDesktopPackageHealth(ctx)).toEqual([
    { name: 'core', version: '1.0.0', enabled: true, healthy: true },
  ])
})

it('refuses same-id module replacements and unobservable override-only or empty bundles', async () => {
  const replaced = context([healthyBundle], [{ ...activePlugin, moduleName: 'different' }])
  expect(await readDesktopPackageHealth(replaced)).toEqual([
    { name: 'core', version: '1.0.0', enabled: true, healthy: false },
  ])
  const missingEvidence = context([
    { ...healthyBundle, name: 'override-only', rows: [], overrides: ['llm'] },
    { ...healthyBundle, name: 'empty', rows: [], overrides: [] },
  ], [])
  expect(await readDesktopPackageHealth(missingEvidence)).toEqual([
    { name: 'override-only', version: '1.0.0', enabled: true, healthy: false },
    { name: 'empty', version: '1.0.0', enabled: true, healthy: false },
  ])
})

it.each(['bundles', 'plugins'] as const)('refuses an oversized %s inventory before projecting it', async (kind) => {
  const bundles = kind === 'bundles' ? Array.from({ length: 4097 }, () => healthyBundle) : [healthyBundle]
  const plugins = kind === 'plugins' ? Array.from({ length: 16385 }, () => activePlugin) : [activePlugin]
  await expect(readDesktopPackageHealth(context(bundles, plugins))).rejects.toThrow('inventory exceeds its bound')
})
