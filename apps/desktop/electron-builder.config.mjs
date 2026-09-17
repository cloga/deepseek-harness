import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  resolveDesktopAppId,
  resolveDesktopForkReleaseEnvironment,
  resolveMacOSNotarizationEnvironment,
  resolveMacOSSigningEnvironment,
} from './scripts/desktop-release-environment.mjs'
import { notarizeMacOSDiskImageArtifact } from './scripts/notarize-macos-disk-images.mjs'
import { verifyMacOSSignatureAfterSign } from './scripts/verify-macos-signature.mjs'
import {
  createWindowsTokenSigner,
  installWindowsNsisBootstrapSigner,
} from './scripts/windows-sign.mjs'
import { resolveDesktopAutoUpdateConfig } from './scripts/desktop-auto-update-environment.mjs'
import { desktopTargetBuildPaths, resolveDesktopBuildTarget } from './scripts/desktop-build-paths.mjs'
import { packagedDesktopRuntimeRoot, verifyPackagedDesktopRuntime } from './scripts/packaged-runtime.mjs'
import { DESKTOP_PACKAGE_METADATA_OPTIONS } from './scripts/runtime-package-metadata.mjs'

/**
 * Create electron-builder configuration from one release environment.
 * @param {NodeJS.ProcessEnv} env - Packaging environment.
 * @param {NodeJS.Platform} hostPlatform - Build-host platform used when no explicit target is present.
 * @param {string} hostArch - Build-host architecture used when no explicit target is present.
 * @returns {object} electron-builder configuration.
 */
export function createElectronBuilderConfig(
  env = process.env,
  hostPlatform = process.platform,
  hostArch = process.arch,
) {
  const forkRelease = resolveDesktopForkReleaseEnvironment(env)
  const appId = forkRelease?.appId ?? resolveDesktopAppId(env)
  const targetPlatform = env.DSH_DESKTOP_TARGET_PLATFORM
  const resolvedPlatform = targetPlatform ?? hostPlatform
  const resolvedArch = env.DSH_DESKTOP_TARGET_ARCH ?? hostArch
  if (env.DSH_DESKTOP_UNSIGNED !== undefined && !['0', '1'].includes(env.DSH_DESKTOP_UNSIGNED)) {
    throw new Error('desktop package: DSH_DESKTOP_UNSIGNED must be 0 or 1')
  }
  const unsigned = env.DSH_DESKTOP_UNSIGNED === '1'
  if (unsigned && resolvedPlatform !== 'win32') throw new Error('desktop package: unsigned builds require Windows')
  if (forkRelease !== undefined && (!unsigned || resolvedPlatform !== 'win32' || resolvedArch !== 'x64')) {
    throw new Error('desktop package: managed fork releases require unsigned Windows x64 packaging')
  }
  const packagesMacOS = targetPlatform === 'darwin' || (targetPlatform === undefined && hostPlatform === 'darwin')
  const packagesWindows = targetPlatform === 'win32'
  const macOSSigning = packagesMacOS ? resolveMacOSSigningEnvironment(env) : undefined
  if (packagesMacOS) resolveMacOSNotarizationEnvironment(env)
  const windowsSigner = packagesWindows && !unsigned
    ? createWindowsTokenSigner({
        certificateFile: env.DSH_DESKTOP_WINDOWS_CER_FILE,
        signTool: env.DSH_DESKTOP_WINDOWS_SIGNTOOL,
        tokenPin: env.DSH_DESKTOP_WINDOWS_TOKEN_PIN,
        keyContainer: env.DSH_DESKTOP_WINDOWS_KEY_CONTAINER,
      })
    : undefined
  if (windowsSigner !== undefined) {
    installWindowsNsisBootstrapSigner({ sign: windowsSigner })
  }
  const update = unsigned || forkRelease !== undefined
    ? undefined
    : resolveDesktopAutoUpdateConfig(env, resolvedPlatform, resolvedArch)
  const buildPaths = desktopTargetBuildPaths(resolveDesktopBuildTarget(env, hostPlatform, hostArch))
  const runtimeVersion = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version
  const iconPath = fileURLToPath(new URL('./assets/whale.png', import.meta.url))
  const icon = readFileSync(iconPath)
  if (icon.length < 24 || icon.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a'
    || icon.readUInt32BE(16) !== 256 || icon.readUInt32BE(20) !== 256) {
    throw new Error('desktop package: whale icon must be a 256x256 PNG')
  }
  return {
    ...DESKTOP_PACKAGE_METADATA_OPTIONS,
    appId,
    productName: forkRelease?.productName ?? 'DeepSeek Harness',
    executableName: forkRelease?.executableName,
    artifactName: forkRelease === undefined
      ? 'deepseek-harness-${version}-${os}-${arch}.${ext}'
      : 'cloga-deepseek-harness-${version}-${os}-${arch}.${ext}',
    extraMetadata: forkRelease === undefined
      ? undefined
      : { name: forkRelease.packageName, version: forkRelease.version },
    directories: { output: unsigned ? join(buildPaths.root, 'unsigned-artifacts') : buildPaths.artifacts },
    asar: true,
    files: [
      'lib/*.js',
      'lib/*.cjs',
      'renderer/**/*',
      'assets/whale.png',
      'package.json',
      { from: buildPaths.dsh, to: 'dsh', filter: ['**/*'] },
      // electron-builder excludes a source directory's root node_modules.
      { from: join(buildPaths.dsh, 'node_modules'), to: 'dsh/node_modules', filter: ['**/*'] },
    ],
    asarUnpack: [
      '**/*.{node,dylib,dll,so,exe}',
      '**/*.so.*',
      '**/spawn-helper',
      '**/@vscode/ripgrep/bin/rg',
    ],
    extraResources: [
      { from: buildPaths.runtime, to: 'runtime' },
      { from: 'lib/managed-update-helper.js', to: 'managed-update/helper.mjs' },
      ...(forkRelease === undefined
        ? []
        : [
            { from: forkRelease.capabilityPath, to: 'managed-update/capability.json' },
            { from: forkRelease.provisioningPath, to: 'desktop-provisioning/plan.json' },
          ]),
    ],
    mac: {
      category: 'public.app-category.developer-tools',
      identity: macOSSigning?.signingIdentity,
      forceCodeSigning: true,
      hardenedRuntime: true,
      // ASAR-unpacked native runtime files are pre-signed; PAK resources are sealed by their enclosing bundle.
      signIgnore: ['/Contents/Resources/app\\.asar\\.unpacked/dsh(?:/|$)', '\\.pak$'],
      notarize: true,
      target: ['dmg', 'zip'],
    },
    dmg: {
      sign: true,
      writeUpdateInfo: false,
    },
    afterPack: async context => {
      const name = context.packager.appInfo.productFilename
      const executable = resolvedPlatform === 'darwin'
        ? join(context.appOutDir, `${name}.app`, 'Contents', 'MacOS', name)
        : join(context.appOutDir, `${name}${resolvedPlatform === 'win32' ? '.exe' : ''}`)
      await verifyPackagedDesktopRuntime(executable,
        packagedDesktopRuntimeRoot(context.packager.getResourcesDir(context.appOutDir)),
        runtimeVersion, { platform: resolvedPlatform, arch: resolvedArch })
    },
    afterSign: async context => {
      if (context.electronPlatformName !== 'darwin') return
      const name = context.packager.appInfo.productFilename
      const contents = join(context.appOutDir, `${name}.app`, 'Contents')
      await verifyPackagedDesktopRuntime(join(contents, 'MacOS', name),
        packagedDesktopRuntimeRoot(join(contents, 'Resources')),
        runtimeVersion, { platform: 'darwin', arch: resolvedArch })
      verifyMacOSSignatureAfterSign(context, macOSSigning ?? resolveMacOSSigningEnvironment(env))
    },
    artifactBuildCompleted: artifact => {
      if (!artifact.file.endsWith('.dmg')) return
      return notarizeMacOSDiskImageArtifact(
        artifact,
        env,
        macOSSigning ?? resolveMacOSSigningEnvironment(env),
      )
    },
    win: {
      icon: iconPath,
      forceCodeSigning: !unsigned,
      signtoolOptions: {
        sign: windowsSigner,
        signingHashAlgorithms: ['sha256'],
      },
      target: ['nsis'],
    },
    linux: {
      category: 'Development',
      target: ['AppImage'],
    },
    nsis: {
      include: fileURLToPath(new URL('./scripts/installer.nsh', import.meta.url)),
      oneClick: false,
      allowToChangeInstallationDirectory: true,
      allowElevation: true,
      runAfterFinish: true,
      differentialPackage: true,
    },
    publish: update === undefined ? null : [{ provider: 'generic', url: update.publicUrl }],
  }
}

export default createElectronBuilderConfig()
