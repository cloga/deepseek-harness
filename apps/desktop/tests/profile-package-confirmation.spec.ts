import { expect, it } from 'vitest'
import { en, zh } from '../src/locale.ts'
import { desktopRegistryConfirmationDetail } from '../src/profile-package-confirmation.ts'
import type { DesktopPreparedRegistryTarget } from '../src/profile-package-staging.ts'

const target: DesktopPreparedRegistryTarget = {
  schemaVersion: 1, requestedSpec: '@example/plugin@^1.0.0', registry: 'https://registry.example.test/npm/',
  packageName: '@example/plugin', version: '1.2.3', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
  packageKey: '@example/plugin@1.2.3(@deepseek-ai/cordis@1.0.0)',
}

it('leaves non-registry confirmation details absent', () => {
  expect(desktopRegistryConfirmationDetail(undefined, en)).toBeUndefined()
})

it.each([en, zh])('displays the exact prepared resolution in the native locale', messages => {
  const before = { ...target }
  const detail = desktopRegistryConfirmationDetail(target, messages)!
  for (const value of [target.requestedSpec, `${target.packageName}@${target.version}`, target.registry, target.integrity]) {
    expect(detail).toContain(value)
  }
  expect(detail).toContain(messages === en ? 'not a verified publisher' : '不代表发布者身份已验证')
  expect(detail).toContain(messages === en ? 'without resolving the request again' : '不会重新解析请求')
  expect(target).toEqual(before)
})

it('shows a distinct artifact origin without leaking path or query tokens', () => {
  const detail = desktopRegistryConfirmationDetail({ ...target,
    tarball: 'https://artifacts.example.test/private-path/plugin.tgz?download_token=fixture-secret',
  }, en)!
  expect(detail).toContain('Artifact origin: https://artifacts.example.test')
  expect(detail).not.toContain('private-path')
  expect(detail).not.toContain('download_token')
  expect(detail).not.toContain('fixture-secret')
})

it('does not duplicate the registry origin for its own artifact URL', () => {
  const detail = desktopRegistryConfirmationDetail({ ...target,
    tarball: 'https://registry.example.test/npm/@example/plugin/-/plugin-1.2.3.tgz?token=fixture-secret',
  }, en)!
  expect(detail).not.toContain('Artifact origin:')
  expect(detail).not.toContain('fixture-secret')
})
