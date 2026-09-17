/** Electron-builder fields asserted by the Desktop release tests. */
export interface DesktopElectronBuilderConfig {
  readonly appId: string
  readonly removePackageScripts: true
  readonly removePackageKeywords: true
  readonly win: {
    readonly icon: string
  }
  readonly directories: {
    readonly output: string
  }
  readonly files: readonly [
    string,
    string,
    string,
    'assets/whale.png',
    string,
    { readonly from: string, readonly to: 'dsh', readonly filter: readonly ['**/*'] },
    { readonly from: string, readonly to: 'dsh/node_modules', readonly filter: readonly ['**/*'] },
  ]
  readonly asarUnpack: readonly string[]
  readonly extraResources:
    | readonly [
      { readonly from: string, readonly to: 'runtime' },
      { readonly from: string, readonly to: 'managed-update/helper.mjs' },
    ]
    | readonly [
      { readonly from: string, readonly to: 'runtime' },
      { readonly from: string, readonly to: 'managed-update/helper.mjs' },
      { readonly from: string, readonly to: 'managed-update/capability.json' },
      { readonly from: string, readonly to: 'desktop-provisioning/plan.json' },
    ]
  readonly mac: {
    readonly identity: string | undefined
    readonly forceCodeSigning: boolean
    readonly notarize: boolean
    readonly signIgnore: readonly string[]
  }
  readonly dmg: {
    readonly sign: boolean
    readonly writeUpdateInfo: boolean
  }
  readonly nsis: {
    readonly include: string
  }
  readonly afterPack: (context: {
    readonly appOutDir: string
    readonly packager: {
      readonly appInfo: { readonly productFilename: string }
      getResourcesDir(appOutDir: string): string
    }
  }) => Promise<void>
  readonly afterSign: (context: {
    readonly appOutDir: string
    readonly electronPlatformName: string
    readonly packager: { readonly appInfo: { readonly productFilename: string } }
  }) => Promise<void>
  readonly artifactBuildCompleted: (artifact: { readonly file: string }) => Promise<void> | undefined
  readonly publish: readonly [{ readonly provider: 'generic', readonly url: string }] | null
}

/**
 * Create electron-builder configuration from one release environment.
 * @param env - Packaging environment.
 * @param hostPlatform - Build-host platform used when no explicit target is present.
 * @param hostArch - Build-host architecture used when no explicit target is present.
 * @returns electron-builder configuration.
 */
export function createElectronBuilderConfig(
  env?: NodeJS.ProcessEnv,
  hostPlatform?: NodeJS.Platform,
  hostArch?: string,
): DesktopElectronBuilderConfig

declare const electronBuilderConfig: DesktopElectronBuilderConfig

export default electronBuilderConfig
