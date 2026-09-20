/** Build-time access to the packaged Electron ASAR runtime. */

/**
 * Resolve the runtime inside the application archive.
 * @param resourcesDir - Packaged Electron resources directory.
 * @returns ASAR-backed runtime directory.
 */
export function packagedDesktopRuntimeRoot(resourcesDir: string): string

/**
 * Select Electron Node mode without credential-shaped variables or inherited loader/ASAR overrides.
 * @param environment - Parent environment.
 * @returns Isolated inspection environment.
 */
export function packagedDesktopRuntimeEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv

/**
 * Read the original descriptor bytes through Electron's ASAR filesystem.
 * @param executable - Packaged Electron executable, never bundled upstream Node.
 * @param runtimeRoot - ASAR-backed runtime directory.
 * @param environment - Optional caller-owned inspection environment; no ambient variables are merged into it.
 * @returns Exact packaged bytes used by release receipts and installed evidence.
 */
export function readPackagedDesktopRuntimeDescriptor(executable: string, runtimeRoot: string, environment?: NodeJS.ProcessEnv): Buffer

/**
 * Verify every packed and unpacked runtime file after the Desktop build.
 * @param executable - Packaged Electron executable.
 * @param runtimeRoot - ASAR-backed runtime directory.
 * @param version - Expected upstream shell/runtime version.
 * @param target - Required runtime target.
 * @param environment - Optional caller-owned environment with an absolute TMPDIR, TEMP or TMP for materialization.
 * @returns Resolves after successful verification and child exit.
 */
export function verifyPackagedDesktopRuntime(
  executable: string, runtimeRoot: string, version: string,
  target: { platform: NodeJS.Platform; arch: string },
  environment?: NodeJS.ProcessEnv,
): Promise<void>
