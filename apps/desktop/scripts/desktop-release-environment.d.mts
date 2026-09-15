/** Environment variable that supplies the Electron application identifier. */
export const DESKTOP_APP_ID_ENV: 'DSH_DESKTOP_APP_ID'

/** Environment variable that supplies the managed update capability file. */
export const DESKTOP_MANAGED_UPDATE_CAPABILITY_ENV: 'DSH_DESKTOP_MANAGED_UPDATE_CAPABILITY'

/** Environment variable that supplies the fork release semantic version. */
export const DESKTOP_FORK_RELEASE_VERSION_ENV: 'DSH_DESKTOP_FORK_RELEASE_VERSION'

/** Environment variable that supplies electron-builder's macOS certificate qualifier. */
export const MACOS_SIGNING_IDENTITY_ENV: 'DSH_DESKTOP_MACOS_SIGNING_IDENTITY'

/** Environment variable that supplies the expected Apple Developer Team ID. */
export const MACOS_TEAM_ID_ENV: 'DSH_DESKTOP_MACOS_TEAM_ID'

/** Public identity expected on a macOS release. */
export interface MacOSSigningEnvironment {
  readonly signingIdentity: string
  readonly teamId: string
}

/** Apple ID credentials accepted by notarytool. */
export interface MacOSAppleIdNotarizationEnvironment {
  readonly appleId: string
  readonly appleIdPassword: string
  readonly teamId: string
}

/** App Store Connect API credentials accepted by notarytool. */
export interface MacOSApiKeyNotarizationEnvironment {
  readonly appleApiKey: string
  readonly appleApiKeyId: string
  readonly appleApiIssuer: string
}

/** Keychain profile accepted by notarytool. */
export interface MacOSKeychainNotarizationEnvironment {
  readonly keychainProfile: string
  readonly keychain?: string
}

/** One complete credential strategy accepted by notarytool. */
export type MacOSNotarizationEnvironment =
  | MacOSAppleIdNotarizationEnvironment
  | MacOSApiKeyNotarizationEnvironment
  | MacOSKeychainNotarizationEnvironment

/**
 * Resolve and validate the application identifier shared by every platform target.
 * @param env - Packaging environment.
 * @returns Reverse-DNS application identifier.
 */
export function resolveDesktopAppId(env: NodeJS.ProcessEnv): string

/** Fixed cloga identity selected for an unsigned managed Windows release. */
export interface DesktopForkReleaseEnvironment {
  readonly appId: 'io.github.cloga.deepseek-harness.desktop'
  readonly productName: 'DeepSeek Harness (cloga)'
  readonly packageName: 'cloga-deepseek-harness-desktop'
  readonly executableName: 'cloga-deepseek-harness'
  readonly version: string
  readonly capabilityPath: string
}

/**
 * Resolve the fixed unsigned cloga release identity when a managed capability is packaged.
 * @param env - Packaging environment.
 * @returns Fork release identity, or undefined for ordinary packaging.
 */
export function resolveDesktopForkReleaseEnvironment(
  env: NodeJS.ProcessEnv,
): DesktopForkReleaseEnvironment | undefined

/**
 * Resolve and validate the public identity expected on a macOS release.
 * @param env - Packaging environment.
 * @returns Expected certificate qualifier and Team ID.
 */
export function resolveMacOSSigningEnvironment(env: NodeJS.ProcessEnv): MacOSSigningEnvironment

/**
 * Resolve one complete credential set accepted by Apple's notary service.
 * @param env - Packaging environment.
 * @returns Notary credentials without the submitted artifact path.
 */
export function resolveMacOSNotarizationEnvironment(env: NodeJS.ProcessEnv): MacOSNotarizationEnvironment
