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
  if (!Number.isSafeInteger(process.pid) || process.pid <= 0 || !Number.isSafeInteger(process.ppid) || process.ppid <= 0 || process.pid === process.ppid) {
    throw new Error('Installed Electron process identity is invalid')
  }
  return {
    pid: process.pid, parentPid: process.ppid,
    executable: process.execPath, resourcesPath: process.resourcesPath,
    userData: app.getPath('userData'), version: app.getVersion(), packaged: app.isPackaged,
  }
}

/** Distinguish Playwright's retained launch transport from the main PID reported inside Electron.
 * Windows Playwright uses shell:true; process() is the CMD launcher, not the native window owner.
 * https://github.com/microsoft/playwright/blob/v1.61.1/packages/playwright-core/src/server/electron/electron.ts
 * @param {{pid?: number}} launcher - Retained Playwright ChildProcess, never a PID found by enumeration.
 * @param {{pid: number, parentPid: number}} identity - Observed Electron main identity, after path/version checks.
 * @param {number} fixturePid - This observing fixture's process ID.
 * @returns {{pid: number, launcherPid: number}} Separate numeric identities; native binding still verifies incarnations.
 */
export function installedDesktopProcessIds(launcher, identity, fixturePid) {
  for (const pid of [launcher.pid, identity.pid, identity.parentPid, fixturePid]) {
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Installed launch requires positive process identities')
  }
  assert.notEqual(identity.pid, fixturePid, 'Electron must not be the observing fixture')
  assert.notEqual(launcher.pid, fixturePid, 'Launcher must not be the observing fixture')
  assert.equal(identity.parentPid, identity.pid === launcher.pid ? fixturePid : launcher.pid, 'Electron must belong to its retained launch transport')
  return { pid: identity.pid, launcherPid: launcher.pid }
}

/** Transport exit is separate from native Electron/Host-family exit; neither implies the other.
 * @param {{exitCode: number | null, signalCode: string | null}} launcher - Retained launch transport handle.
 * @returns {boolean} Whether its exit status or termination signal has been observed.
 */
export function installedLauncherExited(launcher) {
  return Number.isInteger(launcher.exitCode) || (typeof launcher.signalCode === 'string' && launcher.signalCode.length > 0)
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
