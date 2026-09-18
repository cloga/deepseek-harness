import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const checks = vi.hoisted(() => ({ runtime: vi.fn(async () => {}), signature: vi.fn() }))
vi.mock('../scripts/packaged-runtime.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/packaged-runtime.mjs')>(),
  verifyPackagedDesktopRuntime: checks.runtime,
}))
vi.mock('../scripts/verify-macos-signature.mjs', () => ({ verifyMacOSSignatureAfterSign: checks.signature }))
vi.mock('../lib/types/runtime-tree.js', () => ({ verifyDesktopRuntime: vi.fn(async () => ({})), writeDesktopRuntime: vi.fn() }))
vi.mock('../scripts/macos-app-update-config.mjs', async importOriginal => ({
  ...await importOriginal<typeof import('../scripts/macos-app-update-config.mjs')>(),
  writeMacOSAppUpdateConfig: vi.fn(async () => {}), verifyMacOSAppUpdateConfig: vi.fn(async () => {}),
}))

const version = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const macEnvironment = {
  DSH_DESKTOP_APP_ID: 'com.example.desktop',
  DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
  DSH_DESKTOP_TARGET_PLATFORM: 'darwin',
  DSH_DESKTOP_TARGET_ARCH: 'arm64',
  DSH_DESKTOP_MACOS_SIGNING_IDENTITY: 'Example Company (TEAMID1234)',
  DSH_DESKTOP_MACOS_TEAM_ID: 'TEAMID1234',
  APPLE_API_KEY: '/private/credentials/AuthKey_TEST123456.p8',
  APPLE_API_KEY_ID: 'TEST123456',
  APPLE_API_ISSUER: '11111111-2222-3333-4444-555555555555',
  DOWNLOAD_TEST_ORIGIN: 'https://desktop-updates.example.com',
}

beforeEach(() => {
  vi.stubEnv('DSH_DESKTOP_APP_ID', 'com.example.desktop')
  vi.stubEnv('DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN', 'https://policy.example.com')
  vi.stubEnv('DSH_DESKTOP_TARGET_PLATFORM', 'win32')
  vi.stubEnv('DSH_DESKTOP_UNSIGNED', '1')
  checks.runtime.mockReset().mockResolvedValue(undefined)
  checks.signature.mockReset()
})
afterEach(() => { vi.unstubAllEnvs() })

describe('packaged runtime hooks', () => {
  it.each(['win32', 'darwin'] as const)('verifies ASAR resources after packing %s', async (platform) => {
    const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
    const config = createElectronBuilderConfig(platform === 'darwin' ? macEnvironment : {
      DSH_DESKTOP_APP_ID: 'io.github.cloga.deepseek-harness.desktop',
      DSH_DESKTOP_MANDATORY_UPDATE_TEST_ORIGIN: 'https://policy.example.com',
      DSH_DESKTOP_TARGET_PLATFORM: 'win32', DSH_DESKTOP_TARGET_ARCH: 'x64', DSH_DESKTOP_UNSIGNED: '1',
    }, platform, platform === 'darwin' ? 'arm64' : 'x64')
    const appOutDir = join('output', platform)
    const productFilename = platform === 'win32' ? 'cloga-deepseek-harness' : 'DeepSeek Harness'
    const bundle = join(appOutDir, `${productFilename}.app`, 'Contents')
    const resources = platform === 'win32' ? join(appOutDir, 'resources') : join(bundle, 'Resources')
    const context = { appOutDir, electronPlatformName: platform,
      packager: { appInfo: { productFilename, updaterCacheDirName: 'fixture' }, config: { publish: config.publish }, getResourcesDir: () => resources } }
    await config.afterPack(context)
    expect(checks.runtime).toHaveBeenCalledWith(
      platform === 'win32' ? join(appOutDir, `${productFilename}.exe`) : join(bundle, 'MacOS', productFilename),
      join(resources, 'app.asar', 'dsh'), version,
      { platform, arch: platform === 'darwin' ? 'arm64' : 'x64' },
    )
    checks.runtime.mockRejectedValueOnce(new Error('desktop runtime: integrity verification failed'))
    await expect(config.afterPack(context)).rejects.toThrow('integrity verification failed')
  })

  it('verifies final ASAR bytes before the macOS signature check and propagates failure', async () => {
    const { createElectronBuilderConfig } = await import('../electron-builder.config.mjs')
    const config = createElectronBuilderConfig(macEnvironment, 'darwin', 'arm64')
    const context = { appOutDir: 'output', electronPlatformName: 'darwin',
      packager: { appInfo: { productFilename: 'DeepSeek Harness', updaterCacheDirName: 'fixture' }, config: { publish: config.publish } } }
    const contents = join('output', 'DeepSeek Harness.app', 'Contents')
    await config.afterSign(context)
    expect(checks.runtime).toHaveBeenCalledWith(join(contents, 'MacOS', 'DeepSeek Harness'),
      join(contents, 'Resources', 'app.asar', 'dsh'), version, { platform: 'darwin', arch: 'arm64' })
    expect(checks.signature).toHaveBeenCalledOnce()
    checks.signature.mockClear()
    checks.runtime.mockRejectedValueOnce(new Error('desktop runtime: integrity verification failed'))
    await expect(config.afterSign(context)).rejects.toThrow('integrity verification failed')
    expect(checks.signature).not.toHaveBeenCalled()
  })
})
