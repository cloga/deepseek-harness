/** Bounded bootstrap observation of the official package manager's real Loader inventory. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-plugin-manager'
import type { ProfilePackageHealth } from '@deepseek-ai/dsh-app-boot'

/**
 * Observe bundles and their enabled Loader rows after profile boot has settled.
 * This is not a Core readiness or source/receipt gate: a caller must not require disabled
 * or optional package health for startup, including failed best-effort Copilot acquisition.
 * Enabled bundles without concrete Loader rows, or with unverified configuration-only
 * overrides, are conservatively unhealthy until a separate owner checks their effects.
 * @param ctx - Booted Host context; this does not load, enable, or modify packages.
 * @returns Bounded leaf records, or undefined when the profile has no manager.
 */
export async function readDesktopPackageHealth(ctx: Context): Promise<readonly ProfilePackageHealth[] | undefined> {
  const manager = ctx.get('pluginManager')
  if (manager === undefined) return undefined
  const [bundles, plugins] = await Promise.all([manager.listBundles(), manager.listPlugins()])
  if (bundles.length > 4096 || plugins.length > 16384) throw new Error('desktop package health: inventory exceeds its bound')
  const rows = new Map(plugins.map(row => [row.entryId, row]))
  return bundles.map(bundle => ({
    name: bundle.name,
    ...(bundle.version === undefined ? {} : { version: bundle.version }),
    enabled: bundle.enabled,
    healthy: bundle.error === undefined && (!bundle.enabled || (bundle.rows.length > 0 && bundle.overrides.length === 0
      && bundle.rows.every((row) => {
        const current = row.entryId === undefined ? undefined : rows.get(row.entryId)
        return current !== undefined && current.moduleName === row.moduleName
          && (!current.enabled || current.fiberPhase === 'active')
      }))),
  }))
}
