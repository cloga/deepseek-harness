/** Explicit defaults shared by runtime preparation and electron-builder. */
export const DESKTOP_PACKAGE_METADATA_OPTIONS: Readonly<{
  removePackageScripts: true
  removePackageKeywords: true
}>

/**
 * Normalize an exclusively owned, unsealed production copy with the pinned packager transformer.
 * @param runtimeRoot - Prepared runtime copy, never a live profile or workspace dependency directory.
 * @param shellAppDir - Electron shell directory whose package.json is the main manifest.
 * @returns Changed package.json paths relative to the prepared runtime.
 */
export function normalizeDesktopRuntimePackageMetadata(runtimeRoot: string, shellAppDir: string): Promise<readonly string[]>
