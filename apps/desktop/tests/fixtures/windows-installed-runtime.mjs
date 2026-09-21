/** Installed-observer bridge: serialized identity leaves, then the maintained ASAR inspection carrier. */
import assert from 'node:assert/strict'
import { dirname, join, resolve } from 'node:path'
import { packagedDesktopRuntimeRoot, readPackagedDesktopRuntimeDescriptor } from '../../scripts/packaged-runtime.mjs'
import { ownedUpgradePath, upgradeFileHash } from './windows-installed-upgrade-contract.mjs'

/** Closure-free callback serialized by Playwright into Electron's main process; no module loader is assumed.
 * @param {{app: {getPath(name: string): string, getVersion(): string, isPackaged: boolean}}} electron - Playwright's Electron argument.
 * @returns {object} Only owned identity leaves, including the running application's resource directory.
 */
export function inspectInstalledDesktopIdentity({ app }) {
  return {
    pid: process.pid, executable: process.execPath, resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'), version: app.getVersion(), packaged: app.isPackaged,
  }
}

/** Bind readiness authority to the observed main process, never the Playwright launcher.
 * @param {unknown} mainPid - PID read alongside the validated live executable identity.
 * @param {unknown} launcherPid - Optional launcher PID, retained only as a diagnostic leaf.
 * @returns {{pid: number, launcherPid: number | null}} Validated main PID and non-authoritative launcher observation.
 */
export function installedProcessIds(mainPid, launcherPid) {
  assert.ok(typeof mainPid === 'number' && Number.isSafeInteger(mainPid) && mainPid > 0, 'Installed main PID must be a positive safe integer')
  return { pid: mainPid, launcherPid: typeof launcherPid === 'number' && Number.isSafeInteger(launcherPid) && launcherPid > 0 ? launcherPid : null }
}

/** Read exact descriptor bytes outside CDP, whose evaluate context has no dynamic-import callback.
 * @param {string} application - Previously verified installed executable, rechecked before the inspection child starts.
 * @param {string} resourcesPath - Resource directory observed in the running Electron application.
 * @param {string} executableSha256 - Expected executable digest from the verified release manifest.
 * @param {(executable: string, runtimeRoot: string) => Buffer} readDescriptor - Maintained Electron-Node ASAR reader; injectable for keyless tests only.
 * @returns {Buffer} Original descriptor bytes, without parsing or reserialization.
 */
export function readInstalledDesktopRuntimeDescriptor(application, resourcesPath, executableSha256, readDescriptor = readPackagedDesktopRuntimeDescriptor) {
  const directory = dirname(application)
  const resources = join(directory, 'resources')
  assert.equal(resolve(resourcesPath).toLowerCase(), resolve(resources).toLowerCase(), 'Running resources must belong to the verified installed executable')
  const executable = ownedUpgradePath(directory, application)
  const ownedResources = ownedUpgradePath(directory, resources)
  assert.equal(upgradeFileHash(executable), executableSha256, 'Installed executable changed before descriptor inspection')
  return readDescriptor(executable, packagedDesktopRuntimeRoot(ownedResources))
}
