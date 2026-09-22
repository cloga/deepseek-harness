/** Bootstrap health projects the real manager contract without opening browser API admission. */
import { Context } from '@deepseek-ai/cordis'
import type PluginManager from '@deepseek-ai/dsh-plugin-manager'
import { expect, it } from 'vitest'
import { readDesktopPackageHealth } from '../../desktop-host/src/package-health.ts'

it('reports only owned readiness leaves and rejects inactive enabled or missing rows', async () => {
  const ctx = new Context()
  try {
    ctx.provide('pluginManager', {
      listBundles: async () => [
        { name: 'active', version: '1.0.0', enabled: true, rows: [{ entryId: 'active-row' }] },
        { name: 'failed', version: '1.0.0', enabled: true, rows: [{ entryId: 'failed-row' }] },
        { name: 'removed', enabled: true, rows: [{}] },
        { name: 'disabled', enabled: false, rows: [{}] },
        { name: 'broken', enabled: false, rows: [], error: { code: 'not-bundle' } },
        { name: 'overridden-off', enabled: true, rows: [{ entryId: 'off-row' }] },
      ],
      listPlugins: async () => [
        { entryId: 'active-row', enabled: true, fiberPhase: 'active' },
        { entryId: 'failed-row', enabled: true, fiberPhase: 'failed' },
        { entryId: 'off-row', enabled: false, fiberPhase: null },
      ],
    } as unknown as PluginManager)
    expect(await readDesktopPackageHealth(ctx)).toEqual([
      { name: 'active', version: '1.0.0', enabled: true, healthy: true },
      { name: 'failed', version: '1.0.0', enabled: true, healthy: false },
      { name: 'removed', enabled: true, healthy: false },
      { name: 'disabled', enabled: false, healthy: true },
      { name: 'broken', enabled: false, healthy: false },
      { name: 'overridden-off', enabled: true, healthy: true },
    ])
  } finally { await ctx.fiber.dispose() }
})

it('does not invent package health when the manager is absent', async () => {
  const ctx = new Context()
  try { expect(await readDesktopPackageHealth(ctx)).toBeUndefined() } finally { await ctx.fiber.dispose() }
})
