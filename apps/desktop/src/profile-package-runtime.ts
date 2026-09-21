/** Fixed runtime adapter for the shell-owned private package staging backend. */
import { join } from 'node:path'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { createDesktopProfilePackageTransactions } from './profile-package-staging.ts'
import { packDesktopSourceDirectory, runDesktopPackagePnpm } from './profile-package-pnpm.ts'
import { desktopPluginProvisioningPlanSha256, readDesktopPluginProvisioningPlan, type DesktopPluginProvisioningPlan } from './plugin-provisioning.ts'
import type { DesktopManagedUpdateCapability } from './managed-update-protocol.ts'
import type { DesktopProfileSafetyPaths } from './legacy-profile-activation.ts'

/** Fixed packaged policy; the Host transport cannot supply or change this object. */
export interface DesktopPackagePolicy {
  readonly dependencyRegistry: string
  readonly provisioningPlan: DesktopPluginProvisioningPlan
  readonly provisioningPlanFile: string
}

/**
 * Bind source preparation to the reviewed packaged plan and its explicit registry.
 * @param resourcesPath - Fixed installed Electron resources directory.
 * @param capability - Validated packaged managed-release capability.
 * @returns Package policy after canonical plan-hash verification; no public registry fallback.
 */
export function loadDesktopPackagePolicy(resourcesPath: string, capability: DesktopManagedUpdateCapability): DesktopPackagePolicy {
  const provisioningPlanFile = join(resourcesPath, 'desktop-provisioning', 'plan.json')
  const provisioningPlan = readDesktopPluginProvisioningPlan(provisioningPlanFile)
  if (desktopPluginProvisioningPlanSha256(provisioningPlan) !== capability.provisioning.planSha256) {
    throw new Error('desktop package policy: packaged plan differs from its managed capability')
  }
  const sourceRegistry = provisioningPlan.plugins[0]?.source.dependencyRegistry
  if (sourceRegistry === undefined || /[\u0000-\u0020\u007f]/u.test(sourceRegistry)) throw new Error('desktop package policy: an explicit dependency registry is required')
  const registry = new URL(sourceRegistry)
  if (registry.protocol !== 'https:' || registry.username || registry.password || registry.search || registry.hash
    || provisioningPlan.plugins.some(entry => entry.source.dependencyRegistry === undefined
      || new URL(entry.source.dependencyRegistry).href !== registry.href)) {
    throw new Error('desktop package policy: one credential-free HTTPS registry must own the complete profile graph')
  }
  return { dependencyRegistry: registry.href, provisioningPlan, provisioningPlanFile }
}

/**
 * Construct staging with fixed bundled executables, never renderer commands.
 * @param paths - Desktop profile and legacy state locations from the same launcher-owned home.
 * @param resources - Verified installed application runtimes.
 * @param policy - Fixed packaged plan and explicit registry, independent of Host requests.
 * @param recoveryTransactionId - Explicit owned journal identity when a crash left the active profile absent.
 * @param provisioningProfileCreated - Trusted successful initializer result for this launch, not an empty-dependency heuristic.
 * @returns Backend whose package processes operate only on private staging directories or data-only source packing.
 */
export function createDesktopPackageBackend(paths: DesktopProfileSafetyPaths, resources: {
  readonly node: string
  readonly pnpm: string
  readonly nodeBin: string
  readonly dsh: string
}, policy: DesktopPackagePolicy, recoveryTransactionId?: string, provisioningProfileCreated = false) {
  return createDesktopProfilePackageTransactions({
    profile: paths.profile,
    legacyStateRoot: paths.legacyStateRoot,
    dependencyRegistry: policy.dependencyRegistry,
    provisioningPlan: policy.provisioningPlan,
    provisioningPlanFile: policy.provisioningPlanFile,
    provisioningProfileCreated,
    // Host mutations must not wait behind an activation lease while their own Host is draining.
    leaseWaitMs: 0,
    ...(recoveryTransactionId === undefined ? {} : { recoveryTransactionId }),
    runtimeDir: resources.dsh,
    installAnchor: join(resources.dsh, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    configPaths: [join(resolveDshHome(), 'cordis.patch.yml')],
    fetcher: fetch,
    pnpmRunner: request => runDesktopPackagePnpm(resources, request),
    packDirectory: (directory, archivePath, signal) => packDesktopSourceDirectory(resources, directory, archivePath, signal),
  })
}
