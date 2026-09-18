import { createHash, randomUUID } from 'node:crypto'
import fs, { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { execFile, execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createServer } from 'node:https'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { c, x } from 'tar'
import { load } from 'js-yaml'
import { packDesktopSourceDirectory, runDesktopPackagePnpm } from '../src/profile-package-pnpm.ts'
import { parseDesktopPluginInstallSpec } from '../src/plugin-install-spec.ts'
import { DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY, parseDesktopPluginProvisionReceipt } from '../src/plugin-source.ts'
import { desktopPackageReceiptPosition, desktopReceiptFileTransitions, prepareDesktopPackageReceipt } from '../src/profile-package-receipt.ts'
import { createDesktopProfilePackageActivation } from '../src/profile-package-activation.ts'
import { DESKTOP_PLUGIN_USER_INTENTS_FILE, readDesktopPluginUserIntents } from '../src/plugin-user-intents.ts'
import { DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE, parseDesktopPluginProvisioningPlan, parseDesktopPluginProvisioningState, desktopPluginProvisioningPlanSha256 } from '../src/plugin-provisioning.ts'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { initProfile, PROFILE_ROOT_CONFIG, PROFILE_ROOT_FILENAME, withProfilePackageLease, writeProfileRootConfig } from '@deepseek-ai/dsh-app-boot'
import { inventoryDesktopRuntime } from '../src/runtime-tree.ts'
import { createDesktopProfilePackageTransactions, type DesktopProfilePackageStagingOptions, type DesktopStagingPnpmRequest } from '../src/profile-package-staging.ts'

// Generated NONPRODUCTION loopback fixture material. The leaf key is INTENTIONALLY PUBLIC.
// NEVER use these certificates/keys in production or add this CA to an OS/global trust store.
const LOOPBACK_TEST_TLS = {"ca":"-----BEGIN CERTIFICATE-----\nMIIESTCCArGgAwIBAgIJAP7cYZ5gH1dOMA0GCSqGSIb3DQEBCwUAMEIxQDA+BgNV\nBAMTN0RTSCBOT05QUk9EVUNUSU9OIExPT1BCQUNLIFRFU1QgQ0EgLSBORVZFUiBH\nTE9CQUwgVFJVU1QwHhcNMjYwOTE3MDUxMjEwWhcNNDYwOTE3MDUxMjEwWjBCMUAw\nPgYDVQQDEzdEU0ggTk9OUFJPRFVDVElPTiBMT09QQkFDSyBURVNUIENBIC0gTkVW\nRVIgR0xPQkFMIFRSVVNUMIIBojANBgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA\nz+vtWbYPnVqxh361I2gKx/PiZyc4gl6qirPCJQA4+CeCPzLUSO/G+jFTfen0PV51\nJpEOaHMDjHOVeGJ39La+ycGxgA9O1zcnfxXYV4aTbYRmNw5uHQH5JYDYTte2sAS2\nIUS3JqV7bQVb3v7fbCcmLjQooMTOWYDc0ElFzenp/Na5vKp5MdB6oeeM+ose1ODE\ndTcIgK+JOtLFQt+IoR+NMX+tbdEYOXiVX8wcqjHeU4L2qYhMM04c+PsLmw4R+mzo\nzmhPBHl5TsDb/V6tTTg3vJ525UT5HLVfVkHG45PklccaUze8ADNnn+WpJdz39ZTv\nvpILO+AUg3hOYwnNSMNVgdiGU1mQvwEGHbqsxROqVOlEmII3SUO03kzV55FmOod+\neRZQNlrh3/l2tLhE7kXq75k+8VgNmcO5aKkQIWk90HICCR+Df08zdKWNFkbJiuO6\nun0LR3NeWK+K+AQUDHgnBv62YoY/k/vuM+E9OVNARk13ueuWQECKDT211tNuSppp\nAgMBAAGjQjBAMA8GA1UdEwEB/wQFMAMBAf8wDgYDVR0PAQH/BAQDAgEGMB0GA1Ud\nDgQWBBSS79yejlxJRcNtPFGA9OurtyNe1TANBgkqhkiG9w0BAQsFAAOCAYEAt8ub\ngHmcrwl0ezxylzg6OUb/dk99Bsj1T46HDAgzwORCLWCEVebMSaLSoorEYYLRyyZh\nemSd1a84v/AIB/uNrZcK0yKFB2j/YRI69jyJXv6FXqLrkrtZ0iAMWXZEwQufFQLG\npDDq0//UW1n8KZyMQXtYON9+0XrB4b/RCgGHMbipapO0uVpztfmcWIJd88HZRplK\n2nl/Hv2Ky0t8gqOQ0gKYtZbXtFjgh0+St7DbfjOjaY8oBjTss4QZlLf4pttorEZo\njtQRHVfr2oI3/jWxaD1J2ohLq/p6PzimvQ5OdFTae1PuZUN0pzl5rq/uAF3x6Izx\nA06AlKy1o1FkzxciLwtGVHsW28+JHOUq6UKDXTncsmHNVR0iIvXTG4UYSQovNhvi\nmyiIyw/ab98kELFXzF57K39v9dIIqH2vREBx1wobVELz3bJeTTt+rwdU6d5AKLVF\ndKMnzV/fw0KrOGWAyfIlCP7DMTZijNRzPcw8/h+KR1FCG/fbBz+CntMKCsal\n-----END CERTIFICATE-----\n","certificate":"-----BEGIN CERTIFICATE-----\nMIID3zCCAkegAwIBAgIQIcCeskfUl6WtUNYHwbJ16TANBgkqhkiG9w0BAQsFADBC\nMUAwPgYDVQQDEzdEU0ggTk9OUFJPRFVDVElPTiBMT09QQkFDSyBURVNUIENBIC0g\nTkVWRVIgR0xPQkFMIFRSVVNUMB4XDTI2MDkxNzA1MTIxMFoXDTM2MDkxNzA1MTIx\nMFowPzE9MDsGA1UEAxM0RFNIIE5PTlBST0RVQ1RJT04gTE9PUEJBQ0sgRklYVFVS\nRSAtIFBVQkxJQyBURVNUIEtFWTCCASIwDQYJKoZIhvcNAQEBBQADggEPADCCAQoC\nggEBAMWQnLTwMa55I+aQKKZOkZA8WKx9nPj9sHeKIbEcnHr0bHtM3X0vwxig84kI\n4F6GeRxznX6i/fXCqZVdTVrxG+uMJQJ+A3dBgny09V19SKQnWozZSp6LQtfCjUp5\np7tjvdFKGojjxBrJxFgV9lepOzI+zIl9Sizsf1G5mZFuZqwcajknEARualFGL90n\nxKESwyDb0fuqsalB5URsfUj01UCV9IZdVktmWFOePSsUsV94kFQ+X8wlN6nMf130\n1QHig+/xQSvd2qE9zEHDbDD2Bgm2loLyBfqavjLq5Jo4z+Wq6YBTGlvN6aG8IbF7\nEkyb0bSkde5Z8ybcbtX5MyDVSpUCAwEAAaNUMFIwDAYDVR0TAQH/BAIwADAOBgNV\nHQ8BAf8EBAMCBaAwFgYDVR0lAQH/BAwwCgYIKwYBBQUHAwEwGgYDVR0RBBMwEYcE\nfwAAAYIJbG9jYWxob3N0MA0GCSqGSIb3DQEBCwUAA4IBgQDKOUgPv+I1SzNUMCGs\nk9ljm9PVMa4f4XG30l1+0sW0Yu6Nd/Qa4MDduB7NiJxaOhPNRGib7HSwjUZcCLwU\nd5U7oqO4TnXYXm8ryBi/MrHzydjucyW+Umh8ldeVMV4nnrJUoLcFrAOhwIH3Moqm\niE5sn0h0cRItr1DielCpuG2Ju7qFdS+D1x93Xf4CQKN+2mf3TuCtzgBIvLWlmc8B\nJJRNBvmd7DGH15YFJlmk8B5M7rVY6CX7WHXM1KOlxH+dlxrgapha56kgP44vdMZ8\n6rZBE6pHvfsKxuApERWXd9w2MTnS61IBJ3V6x0xKvMQS2ITCu2cytuDFjZy9B3Ck\nP02U4+9xAl3RRD5HlQodtiYkY96oOflj4A/GWRIwqvivRqRuEVm+msn96hty7vKg\n9QmAmxhS4E69K3BiQTYPez4vGcId62mP9NisnHewiNfwRAG9vxsI1/aZYHfISDuF\nDQoV8P5/Rf8wapC+IVJ1xaGOBNGlG8YRHEI9jN1YPjplfYY=\n-----END CERTIFICATE-----\n","intentionallyPublicLeafKey":"-----BEGIN PRIVATE KEY-----\nMIIEvwIBADANBgkqhkiG9w0BAQEFAASCBKkwggSlAgEAAoIBAQDFkJy08DGueSPm\nkCimTpGQPFisfZz4/bB3iiGxHJx69Gx7TN19L8MYoPOJCOBehnkcc51+ov31wqmV\nXU1a8RvrjCUCfgN3QYJ8tPVdfUikJ1qM2Uqei0LXwo1Keae7Y73RShqI48QaycRY\nFfZXqTsyPsyJfUos7H9RuZmRbmasHGo5JxAEbmpRRi/dJ8ShEsMg29H7qrGpQeVE\nbH1I9NVAlfSGXVZLZlhTnj0rFLFfeJBUPl/MJTepzH9d9NUB4oPv8UEr3dqhPcxB\nw2ww9gYJtpaC8gX6mr4y6uSaOM/lqumAUxpbzemhvCGxexJMm9G0pHXuWfMm3G7V\n+TMg1UqVAgMBAAECggEBAI0Q7AP6Oc81ql+38X6GPUO7Aynu60WShw1j8RiwsD7P\nBiKoSMJZdzm/uwTO9L4p0JJzLzK8GRABNetz2ocj/+aZg9eauMjPWufGoihmC5dC\njlJh2PkJwOmkfhR+dzjDSEcHXZj+4QirpumqjOIc8Sq4Un2dm3gmSebF2pRQOzmK\nMcaB7bI/ebX+UU7tJVgPKwexzlw8TP6XI6te3aeVSN1ipWgzRNTYynwkeDz+qMsQ\nsicHMTubcK1r3jP5CmEgkHwgzrIO/5l643BJD25hw/vG0a07v7eJxfd0jue9Bt5q\nuYINZED+BJ4eU8gsmdSmN+AcyytNCUckugvoH1CNVaUCgYEAy7Wd6X4DrQ64u1KA\n45ybT7RidNrcnwhgPfYegVuG//kyjOjOA7TX+VjrqQ9D3U6nCMZL43A967wKsMb0\nyJqBoZ9zoXqm9hn7I4T+GsM74j+hrHmqAGL3uhnFpPzUXilJpgcUbH7g2apyMQ3G\nHP6ECBU0h2wtZw8TDCJu+unx79sCgYEA+Ec3vu0P68IS305Na80/kq2spqjAwukS\nWh4OTMVDgnMCNV+pNxHr+7msZmupJTJ+RStei+b7DLR4fyEVg3BwLTtAgaXnGtar\ngqvoTff/SX2CgtkjGb6lO/2lpKVBC7SXiHRax8JQsNz0DQ/1WRVOngOn/8BkDKtJ\nblbmD1sSsk8CgYEAiVNBxOniaIOIHR+dK9OjD7Q2uzffioYG+z4zili9RUokvcEj\nQHRlM/6xvyI/Sa2ABPZIqmY8F/KH8mvtEF64DNCFDtK0Qyt4lZVOB5SdhgQHZVIP\nPHt7LMW662JVd7S1pWsYZZuS0KmKmW8DowAg2aIR60kNwm/zEzcTQar8IgkCgYEA\nuGgFQr1HVv/GDrBVFt3S+zoeA4dR7TM6G085pdHay7hqioQr5ihck5KcN1J9xpAT\nc4K77cO48f3Vhe9n0EGiQCZDSkiUN738k8jleYvaxJYBavimdofAqKdD8d+ASZZv\n+r0ZdEeisUrbxhv1Sp5lzz29+VrHtRVALEFFDWDCqUcCgYAKpq9eBKYaAo7ju03s\nB0lVMD/H5tFIsPNIWei3aI85h4+nvlftHhwC8awGu0mt7RE8XXMbGki7ZZc8QZ+j\nlDdBc0dGEmmYOi3xflSWN0hI1J7ufH+nwhlABX+e7g9K3y+7gVL4ltjBO22m1qUx\nFBE65jxiF71uxA3tRWPnQ27AMQ==\n-----END PRIVATE KEY-----\n","metadata":{"schemaVersion":1,"purpose":"NONPRODUCTION loopback fixture ONLY; leaf key intentionally public; no OS/global trust","generatedAt":"2026-09-18T05:12:10.5619336+00:00","caSubject":"CN=DSH NONPRODUCTION LOOPBACK TEST CA - NEVER GLOBAL TRUST","caNotBefore":"2026-09-17T05:12:10.0000000Z","caNotAfter":"2046-09-17T05:12:10.0000000Z","leafSubject":"CN=DSH NONPRODUCTION LOOPBACK FIXTURE - PUBLIC TEST KEY","leafNotBefore":"2026-09-17T05:12:10.0000000Z","leafNotAfter":"2036-09-17T05:12:10.0000000Z","san":["IP:127.0.0.1","DNS:localhost"],"eku":"1.3.6.1.5.5.7.3.1 serverAuth","caCertificateSha256":"c2fa67e707a8159e69144c8b9ef2db3699119cff71d48d463b621ee07657a9ef","serverCertificateSha256":"2f5e9d202d1006967606ef3c61d399f5db09b9380920c4f314afed15b6dee4ce","intentionallyPublicLeafKeySha256":"25382e2595c1bb271f1cec85ec653e5d5151ac7feb734785da23c7f9a0553a84","generatorSha256":"7f603aa3a43e334bc56b0281dac577e6bd0fd57cc221b82ddcf7a01a0f27c905"}} as const

const roots: string[] = []
const pluginName = '@example/staged-plugin'
const version = '0.1.6-alpha.2'
function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value)}\n`)
}
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function object(value: unknown, ...path: readonly string[]): Record<string, unknown> {
  let current = value
  for (const key of path) current = object(current)[key]
  if (!isObject(current)) throw new Error('fixture requires an object')
  return current
}
function jsonObject(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text)
  return object(value)
}
function stringValue(value: unknown): string {
  if (typeof value !== 'string') throw new Error('fixture requires a string')
  return value
}
function isArray(value: unknown): value is unknown[] { return Array.isArray(value) }
function stringArray(value: unknown): string[] {
  if (!isArray(value) || !value.every(item => typeof item === 'string')) throw new Error('fixture requires a string array')
  return value
}
function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>((accept) => { resolve = accept })
  return { promise, resolve }
}
async function graph(request: DesktopStagingPnpmRequest): Promise<{ exitCode: number }> {
  const manifest = jsonObject(readFileSync(join(request.cwd, 'package.json'), 'utf8'))
  const dependencies: Record<string, unknown> = {}
  const packages: Record<string, unknown> = {}
  const snapshots: Record<string, unknown> = {}
  for (const [name, selector] of Object.entries(object(manifest, 'dependencies'))) {
    const spec = stringValue(selector)
    const target = join(request.cwd, 'node_modules', name)
    mkdirSync(target, { recursive: true })
    if (spec.startsWith('file:')) {
      const artifact = join(request.cwd, spec.slice(5))
      await x({ file: artifact, cwd: target, strip: 1 })
      packages[`${name}@${spec}`] = { resolution: { integrity: `sha512-${createHash('sha512').update(readFileSync(artifact)).digest('base64')}`, tarball: spec } }
    } else {
      if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(spec)) throw new Error('unit graph requires an explicitly resolved registry version')
      write(join(target, 'package.json'), { name, version: spec, dsh: { bundle: { patch: './cordis.patch.yml' } } })
      writeFileSync(join(target, 'cordis.patch.yml'), '[]\n')
      packages[`${name}@${spec}`] = { resolution: { integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` } }
    }
    dependencies[name] = { specifier: spec, version: spec }
    snapshots[`${name}@${spec}`] = {}
  }
  write(join(request.cwd, 'pnpm-lock.yaml'), { lockfileVersion: '9.0', importers: { '.': { dependencies } }, packages, snapshots })
  return { exitCode: 0 }
}
async function registryGraph(request: DesktopStagingPnpmRequest, version = '1.2.3'): Promise<{ exitCode: number }> {
  const position = request.args.indexOf('add')
  if (position !== -1) {
    const parsed = parseDesktopPluginInstallSpec(request.args[position + 1]!, request.cwd)
    if (parsed.kind !== 'registry') throw new Error('unit registry runner received a nonregistry source')
    const path = join(request.cwd, 'package.json')
    const manifest = jsonObject(readFileSync(path, 'utf8'))
    object(manifest, 'dependencies')[parsed.name] = version
    write(path, manifest)
  }
  return graph(request)
}
function fixture(overrides: Partial<DesktopProfilePackageStagingOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'desktop-package-staging-'))
  roots.push(root)
  const profile = join(root, 'profiles', 'desktop')
  const runtimeDir = join(root, 'runtime')
  mkdirSync(profile, { recursive: true })
  write(join(profile, 'package.json'), { private: true, dependencies: {}, dsh: { profile: { bundles: [] } }, userField: { untouched: true } })
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'allowBuilds:\n  approved-native: true\n')
  write(join(profile, 'desktop-plugin-receipts.json'), { schemaVersion: 1, receipts: {}, owners: {} })
  // This graph is active state and deliberately uncopyable; staging must rebuild instead.
  mkdirSync(join(profile, 'node_modules'))
  writeFileSync(join(profile, 'node_modules', 'active-sentinel'), 'active graph unchanged')
  const names = ['@deepseek-ai/dsh', '@deepseek-ai/dsh-desktop-host', '@deepseek-ai/cordis']
  const sharedPackages = names.map(name => ({ name, version, path: `node_modules/${name}` }))
  for (const shared of sharedPackages) write(join(runtimeDir, shared.path, 'package.json'), { name: shared.name, version })
  writeFileSync(join(runtimeDir, 'runtime.js'), 'export const runtime = true\n')
  write(join(runtimeDir, 'desktop-runtime.json'), {
    schemaVersion: 1, release: { version, nodeVersion: process.versions.node, pnpmVersion: '11.7.0' },
    platform: process.platform, arch: process.arch, sharedPackages, files: inventoryDesktopRuntime(runtimeDir),
  })
  const source = join(root, 'source')
  write(join(source, 'package.json'), { name: pluginName, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, main: './index.js' })
  writeFileSync(join(source, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(source, 'index.js'), 'throw new Error("staging must not import package code")\n')
  const pnpmRunner = vi.fn(graph)
  const packDirectory = vi.fn(async (directory: string, archivePath: string, signal: AbortSignal) => {
    signal.throwIfAborted()
    await c({ file: archivePath, cwd: directory, prefix: 'package', gzip: true, portable: true, noMtime: true }, ['package.json', 'cordis.patch.yml', 'index.js'])
  })
  const fetcher = vi.fn<typeof fetch>(async () => { throw new Error('fixture forbids network') })
  const options: DesktopProfilePackageStagingOptions = {
    profile, runtimeDir, installAnchor: join(runtimeDir, 'node_modules', '@deepseek-ai/dsh', 'package.json'),
    dependencyRegistry: 'https://registry.example.invalid/', configPaths: [], pnpmRunner, packDirectory, fetcher, ...overrides,
  }
  const backend = createDesktopProfilePackageTransactions(options)
  const mutation = { kind: 'install', source: { schemaVersion: 1, type: 'packageSpec', spec: source } } as const
  const transaction = (id: string) => join(dirname(profile), `.${basename(profile)}.package-stage-${id}`)
  const active = () => ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'desktop-plugin-receipts.json', 'node_modules/active-sentinel']
    .map(path => [path, readFileSync(join(profile, path), 'utf8')])
  return { root, profile, runtimeDir, source, options, backend, mutation, transaction, active, pnpmRunner, packDirectory, fetcher }
}
function receipt(name: string, bytes: Buffer) {
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const source = { schemaVersion: 1 as const, type: 'githubRelease' as const, owner: 'example', repo: 'plugin', tag: 'v1.0.0', asset: 'plugin.tgz',
    assetId: 11, packageName: name, version: '1.0.0', size: bytes.byteLength, sha256,
    integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}`, targetCommit: 'a'.repeat(40), dependencyRegistry: 'https://registry.example.invalid/' }
  return parseDesktopPluginProvisionReceipt({ schemaVersion: 1, capability: DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
    source, releaseId: 10, assetId: 11, packageName: name, version: '1.0.0', artifactSha256: sha256,
    states: { staged: true, health: 'passed', activated: true, rolledBack: false, verified: true } })
}
async function seedReceipt(f: ReturnType<typeof fixture>, name: string, fields: Record<string, unknown> = {}) {
  const source = join(f.root, `seed-${randomUUID()}`)
  write(join(source, 'package.json'), { ...fields, name, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, main: './index.js' })
  writeFileSync(join(source, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(source, 'index.js'), `export const name = ${JSON.stringify(name)}\n`)
  const archive = join(f.root, `${randomUUID()}.tgz`)
  await f.packDirectory(source, archive, new AbortController().signal)
  const evidence = receipt(name, readFileSync(archive))
  const specifier = `file:.desktop-plugin-artifacts/${evidence.artifactSha256}.tgz`
  mkdirSync(join(f.profile, '.desktop-plugin-artifacts'), { recursive: true })
  copyFileSync(archive, join(f.profile, specifier.slice(5)))
  const manifest = jsonObject(readFileSync(join(f.profile, 'package.json'), 'utf8'))
  object(manifest, 'dependencies')[name] = specifier; stringArray(object(manifest, 'dsh', 'profile').bundles).push(name)
  write(join(f.profile, 'package.json'), manifest)
  const store = jsonObject(readFileSync(join(f.profile, 'desktop-plugin-receipts.json'), 'utf8'))
  object(store, 'receipts')[name] = evidence; object(store, 'owners')[name] = 'release'
  write(join(f.profile, 'desktop-plugin-receipts.json'), store)
  await graph({ cwd: f.profile, args: [], env: {}, signal: new AbortController().signal })
  return { evidence, specifier }
}
async function provisioningFixture() {
  const f = fixture()
  const archive = join(f.root, 'planned.tgz')
  await f.packDirectory(f.source, archive, new AbortController().signal)
  const bytes = readFileSync(archive)
  const evidence = receipt(pluginName, bytes)
  const checksum = Buffer.from(`${evidence.source.sha256}  plugin.tgz\n`)
  const source = { ...evidence.source, checksumManifest: { format: 'sha256sums' as const, asset: 'SHA256SUMS', assetId: 12,
    url: 'https://github.com/example/plugin/releases/download/v1.0.0/SHA256SUMS', size: checksum.length,
    sha256: createHash('sha256').update(checksum).digest('hex') } }
  const plan = parseDesktopPluginProvisioningPlan({ schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source }] })
  const planFile = join(f.root, 'packaged-plan.json')
  write(planFile, plan)
  const fetcher = vi.fn<typeof fetch>(async input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
    if (url.endsWith('/releases/tags/v1.0.0')) return Response.json({ id: 10, draft: false, immutable: true, tag_name: 'v1.0.0', target_commitish: source.targetCommit,
      assets: [{ id: 11, name: 'plugin.tgz', state: 'uploaded', size: bytes.length, digest: `sha256:${source.sha256}` },
        { id: 12, name: 'SHA256SUMS', state: 'uploaded', size: checksum.length, digest: `sha256:${source.checksumManifest.sha256}`, browser_download_url: source.checksumManifest.url }] })
    if (url.endsWith('/git/ref/tags/v1.0.0')) return Response.json({ object: { type: 'commit', sha: source.targetCommit } })
    const body = url.endsWith('/releases/assets/11') ? bytes : url.endsWith('/releases/assets/12') ? checksum : undefined
    if (body !== undefined) return new Response(new Uint8Array(body), { headers: { 'content-length': String(body.length) } })
    throw new Error(`unexpected provisioning URL: ${url}`)
  })
  const options = { ...f.options, fetcher, provisioningPlan: plan, provisioningPlanFile: planFile, provisioningProfileCreated: true }
  return { ...f, options, backend: createDesktopProfilePackageTransactions(options), plan, planFile, plannedSource: source, fetcher,
    evidence: parseDesktopPluginProvisionReceipt({ ...evidence, source }), archive }
}
async function seedExactPlanned(f: Awaited<ReturnType<typeof provisioningFixture>>, packageOwner: 'user' | 'release' = 'user'): Promise<void> {
  const specifier = `file:.desktop-plugin-artifacts/${f.plannedSource.sha256}.tgz`
  mkdirSync(join(f.profile, '.desktop-plugin-artifacts'), { recursive: true })
  copyFileSync(f.archive, join(f.profile, specifier.slice(5)))
  write(join(f.profile, 'package.json'), { private: true, dependencies: { [pluginName]: specifier }, dsh: { profile: { bundles: [pluginName] } } })
  // Noncanonical formatting is intentional: a no-op qualification must preserve these user-owned bytes.
  writeFileSync(join(f.profile, 'desktop-plugin-receipts.json'), `${JSON.stringify({ schemaVersion: 1, receipts: { [pluginName]: f.evidence }, owners: { [pluginName]: packageOwner } }, undefined, 4)}\n`)
  writeProfileRootConfig(f.profile)
  await graph({ cwd: f.profile, args: [], env: {}, signal: new AbortController().signal })
}
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }) })

describe('Desktop stage-only package transactions', () => {
  it('requires trusted fresh-profile authorization and preserves an already prepared creation across restart', async () => {
    const f = await provisioningFixture()
    const existing = createDesktopProfilePackageTransactions({ ...f.options, provisioningProfileCreated: false })
    expect(await existing.assessProvisioning()).toMatchObject({ status: 'preserved-user-choice', reason: 'ambiguous-legacy' })
    await expect(existing.stageProvisioning(randomUUID(), new AbortController().signal)).rejects.toThrow('ambiguous-legacy')
    expect(await f.backend.assessProvisioning()).toMatchObject({ status: 'provisionable', reason: 'fresh-profile' })
    const id = randomUUID()
    const prepared = await f.backend.stageProvisioning(id, new AbortController().signal)
    expect(await existing.stageProvisioning(id, new AbortController().signal)).toEqual(prepared)
    expect((await existing.readPreparedForActivation(id))!.provisioning?.ownerDecision).toBe('create-release-owned')
    expect(f.fetcher).toHaveBeenCalled()
  })

  it('qualifies exact installed user bytes without reinstallation or receipt ownership transfer', async () => {
    const f = await provisioningFixture()
    await seedExactPlanned(f)
    const before = inventoryDesktopRuntime(f.profile)
    const receiptBytes = readFileSync(join(f.profile, 'desktop-plugin-receipts.json'))
    const assessment = await f.backend.assessProvisioning()
    expect(assessment).toMatchObject({ status: 'exact-satisfied', packageOwner: 'user', qualification: 'pending' })
    if (assessment.status !== 'exact-satisfied') throw new Error('fixture should have exact installed payload')
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
    await expect(f.backend.stageProvisioning(randomUUID(), new AbortController().signal)).rejects.toThrow('qualify the exact installed graph')
    // This unit exercises the post-health API's data binding; it does not assert actual product Host health.
    const state = await f.backend.commitSatisfiedProvisioning(assessment.assessmentFingerprint)
    expect(state.planSha256).toBe(desktopPluginProvisioningPlanSha256(f.plan))
    expect(readFileSync(join(f.profile, 'desktop-plugin-receipts.json')).equals(receiptBytes)).toBe(true)
    expect(object(jsonObject(receiptBytes.toString('utf8')), 'owners')[pluginName]).toBe('user')
    expect(inventoryDesktopRuntime(f.profile).filter(entry => entry.path !== DESKTOP_PLUGIN_PROVISIONING_STATE_FILE)).toEqual(before)
    await expect(f.backend.commitSatisfiedProvisioning(assessment.assessmentFingerprint)).rejects.toThrow('stale')
    expect(f.pnpmRunner).not.toHaveBeenCalled()
    expect(f.fetcher).not.toHaveBeenCalled()
  })

  it.each(['metadata', 'graph', 'selection', 'owner', 'resource', 'payload'] as const)('refuses a stale post-health qualification binding after %s changes', async change => {
    const f = await provisioningFixture()
    await seedExactPlanned(f)
    const assessment = await f.backend.assessProvisioning()
    if (assessment.status !== 'exact-satisfied') throw new Error('fixture should have exact installed payload')
    if (change === 'metadata') write(join(f.profile, 'user-note.json'), { changed: true })
    if (change === 'graph') writeFileSync(join(f.profile, 'node_modules', 'active-sentinel'), 'changed graph bytes')
    if (change === 'selection') {
      const manifest = jsonObject(readFileSync(join(f.profile, 'package.json'), 'utf8'))
      object(manifest, 'dsh', 'profile').bundles = []; write(join(f.profile, 'package.json'), manifest)
    }
    if (change === 'owner') {
      const store = jsonObject(readFileSync(join(f.profile, 'desktop-plugin-receipts.json'), 'utf8'))
      object(store, 'owners')[pluginName] = 'release'; write(join(f.profile, 'desktop-plugin-receipts.json'), store)
    }
    if (change === 'resource') writeFileSync(f.planFile, `${readFileSync(f.planFile, 'utf8')} `)
    if (change === 'payload') writeFileSync(join(f.profile, 'node_modules', pluginName, 'index.js'), 'export const unrecorded = true\n')
    const receiptBytes = readFileSync(join(f.profile, 'desktop-plugin-receipts.json'))
    await expect(f.backend.commitSatisfiedProvisioning(assessment.assessmentFingerprint)).rejects.toThrow('stale')
    expect(existsSync(join(f.profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE))).toBe(false)
    expect(readFileSync(join(f.profile, 'desktop-plugin-receipts.json')).equals(receiptBytes)).toBe(true)
  })

  it('cleans a failed evidence-only atomic write without changing receipt, owner or graph bytes', async () => {
    const f = await provisioningFixture()
    await seedExactPlanned(f)
    const assessment = await f.backend.assessProvisioning()
    if (assessment.status !== 'exact-satisfied') throw new Error('fixture should have exact installed payload')
    const before = inventoryDesktopRuntime(f.profile)
    const rename = fs.renameSync
    const fault = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (String(to) === join(f.profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE)) throw new Error('qualification rename denied')
      rename(from, to)
    })
    syncBuiltinESMExports()
    try { await expect(f.backend.commitSatisfiedProvisioning(assessment.assessmentFingerprint)).rejects.toThrow('qualification rename denied') }
    finally { fault.mockRestore(); syncBuiltinESMExports() }
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
    expect(readdirSync(f.profile).some(name => name.startsWith('.provisioning-state-'))).toBe(false)
  })

  it.each(['installed-override', 'disabled', 'ambiguous-legacy', 'invalid-evidence'] as const)('assesses %s without automatically reinstalling or changing user state', async reason => {
    const f = await provisioningFixture()
    await seedExactPlanned(f)
    if (reason === 'installed-override') {
      const manifest = jsonObject(readFileSync(join(f.profile, 'package.json'), 'utf8'))
      object(manifest, 'dependencies')[pluginName] = '2.0.0'; write(join(f.profile, 'package.json'), manifest)
    }
    if (reason === 'disabled') {
      const manifest = jsonObject(readFileSync(join(f.profile, 'package.json'), 'utf8'))
      object(manifest, 'dsh', 'profile').bundles = []; write(join(f.profile, 'package.json'), manifest)
    }
    if (reason === 'ambiguous-legacy') {
      const store = jsonObject(readFileSync(join(f.profile, 'desktop-plugin-receipts.json'), 'utf8'))
      delete store.owners; write(join(f.profile, 'desktop-plugin-receipts.json'), store)
    }
    if (reason === 'invalid-evidence') writeFileSync(join(f.profile, DESKTOP_PLUGIN_USER_INTENTS_FILE), '{invalid evidence')
    const before = inventoryDesktopRuntime(f.profile)
    expect(await f.backend.assessProvisioning()).toMatchObject(reason === 'invalid-evidence' ? { status: 'invalid-evidence' } : { status: 'preserved-user-choice', reason })
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
    expect(f.pnpmRunner).not.toHaveBeenCalled()
    expect(f.fetcher).not.toHaveBeenCalled()
  })

  it('does not infer exact installed code from only a receipt and cached archive', async () => {
    const f = await provisioningFixture()
    await seedExactPlanned(f)
    writeFileSync(join(f.profile, 'node_modules', pluginName, 'index.js'), 'changed while receipt and archive remain intact\n')
    expect(await f.backend.assessProvisioning()).toMatchObject({ status: 'invalid-evidence' })
    const store = jsonObject(readFileSync(join(f.profile, 'desktop-plugin-receipts.json'), 'utf8'))
    object(store, 'owners')[pluginName] = 'release'; write(join(f.profile, 'desktop-plugin-receipts.json'), store)
    expect(await f.backend.assessProvisioning()).toMatchObject({ status: 'provisionable', reason: 'release-owned-repair' })
  })

  it('retains manual removal across plan updates and clears only its target in a successful reinstall candidate', async () => {
    const f = await provisioningFixture()
    await seedExactPlanned(f)
    write(join(f.profile, DESKTOP_PLUGIN_USER_INTENTS_FILE), { schemaVersion: 1, removed: { 'other-user-choice': {} } })
    const before = inventoryDesktopRuntime(f.profile)
    const removedId = randomUUID()
    await f.backend.stage(removedId, { kind: 'remove', name: pluginName }, new AbortController().signal)
    const removed = (await f.backend.readPreparedForActivation(removedId))!
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
    expect(readDesktopPluginUserIntents(removed.candidateDir).removed[pluginName]?.observedPlanSha256)
      .toBe(desktopPluginProvisioningPlanSha256(f.plan))
    renameSync(f.profile, removed.rollbackDir); renameSync(removed.candidateDir, f.profile)
    const markerBytes = readFileSync(join(f.profile, DESKTOP_PLUGIN_USER_INTENTS_FILE))
    const nextSource = { ...f.plannedSource, tag: 'v1.0.1', assetId: 21, checksumManifest: { ...f.plannedSource.checksumManifest, assetId: 22,
      url: f.plannedSource.checksumManifest.url.replace('/v1.0.0/', '/v1.0.1/') } }
    const plan = parseDesktopPluginProvisioningPlan({ schemaVersion: 1, mode: 'exact', plugins: [{ required: true, source: nextSource }] })
    write(f.planFile, plan)
    const updated = createDesktopProfilePackageTransactions({ ...f.options, provisioningPlan: plan, provisioningProfileCreated: false })
    expect(await updated.assessProvisioning()).toMatchObject({ status: 'preserved-user-choice', reason: 'removed' })
    await expect(updated.stageProvisioning(randomUUID(), new AbortController().signal)).rejects.toThrow('removed')
    expect(readFileSync(join(f.profile, DESKTOP_PLUGIN_USER_INTENTS_FILE)).equals(markerBytes)).toBe(true)
    const installedId = randomUUID()
    await updated.stage(installedId, { kind: 'install', source: f.plannedSource }, new AbortController().signal)
    const installed = (await updated.readPreparedForActivation(installedId))!
    expect(readDesktopPluginUserIntents(installed.candidateDir).removed).toEqual({ 'other-user-choice': {} })
    expect(readFileSync(join(f.profile, DESKTOP_PLUGIN_USER_INTENTS_FILE)).equals(markerBytes)).toBe(true)
  })

  it('stages only the resource-bound singleton privately without promoting an identical manual intent', async () => {
    const f = await provisioningFixture()
    const user = await seedReceipt(f, '@example/user-owned')
    const store = jsonObject(readFileSync(join(f.profile, 'desktop-plugin-receipts.json'), 'utf8'))
    object(store, 'owners')['@example/user-owned'] = 'user'
    write(join(f.profile, 'desktop-plugin-receipts.json'), store)
    const manifest = jsonObject(readFileSync(join(f.profile, 'package.json'), 'utf8'))
    object(manifest, 'dsh', 'profile').bundles = [] // The unrelated user's disabled state must remain disabled.
    write(join(f.profile, 'package.json'), manifest)
    const before = inventoryDesktopRuntime(f.profile)
    const id = randomUUID()
    const prepared = await f.backend.stageProvisioning(id, new AbortController().signal)
    expect(prepared).toMatchObject({ transactionId: id, state: 'prepared', health: 'pending' })
    expect(Object.keys(prepared).sort()).toEqual(['baseFingerprint', 'health', 'packageName', 'state', 'transactionId'])
    const input = (await f.backend.readPreparedForActivation(id))!
    expect(input.intentFingerprint).toMatch(/^[a-f0-9]{64}$/u)
    expect(input.provisioning).toEqual({ schemaVersion: 1, planSha256: desktopPluginProvisioningPlanSha256(f.plan),
      planResourceSha256: createHash('sha256').update(readFileSync(f.planFile)).digest('hex'), source: f.plannedSource,
      ownerDecision: 'create-release-owned', previousSelected: false })
    expect(input.owner.provisioningPlanResource?.file).toBe(f.planFile)
    const candidate = join(f.transaction(id), 'profile')
    expect(object(jsonObject(readFileSync(join(candidate, 'package.json'), 'utf8')), 'dsh', 'profile').bundles).toEqual([pluginName])
    expect(jsonObject(readFileSync(join(candidate, 'desktop-plugin-receipts.json'), 'utf8'))).toEqual({ schemaVersion: 1, receipts: { '@example/user-owned': user.evidence }, owners: { '@example/user-owned': 'user' } })
    expect(await f.backend.stageProvisioning(id, new AbortController().signal)).toEqual(prepared)
    await expect(f.backend.stage(id, { kind: 'install', source: f.plannedSource }, new AbortController().signal)).rejects.toThrow('different mutation or purpose')
    const manualId = randomUUID()
    await f.backend.stage(manualId, { kind: 'install', source: f.plannedSource }, new AbortController().signal)
    expect((await f.backend.readPreparedForActivation(manualId))!.provisioning).toBeUndefined()
    await expect(f.backend.stageProvisioning(manualId, new AbortController().signal)).rejects.toThrow('different mutation or purpose')
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
  })

  it.each([[false, false], [true, false], [false, true], [true, true]] as const)('validates exact private two-file evidence progress receipt=%s state=%s', async (receiptWritten, stateWritten) => {
    const f = await provisioningFixture()
    const specifier = `file:.desktop-plugin-artifacts/${f.plannedSource.sha256}.tgz`
    mkdirSync(join(f.profile, '.desktop-plugin-artifacts'))
    copyFileSync(f.archive, join(f.profile, specifier.slice(5)))
    write(join(f.profile, 'package.json'), { dependencies: { [pluginName]: specifier }, dsh: { profile: { bundles: [pluginName] } } })
    write(join(f.profile, 'desktop-plugin-receipts.json'), { schemaVersion: 1, receipts: { [pluginName]: f.evidence }, owners: { [pluginName]: 'release' } })
    const prior = parseDesktopPluginProvisioningState({ schemaVersion: 1, capability: DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
      planSha256: desktopPluginProvisioningPlanSha256(f.plan), composition: 'active', plugins: [{ name: pluginName, version: '1.0.0', required: true,
        status: 'active', source: f.plannedSource, receipt: f.evidence }], removed: [], rolledBack: false, verified: true })
    write(join(f.profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE), prior)
    const oldState = readFileSync(join(f.profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE), 'utf8')
    const id = randomUUID()
    await f.backend.stageProvisioning(id, new AbortController().signal)
    const input = (await f.backend.readPreparedForActivation(id))!
    expect(input.provisioning?.ownerDecision).toBe('replace-release-owned')
    expect(existsSync(join(input.candidateDir, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE))).toBe(false)
    expect(readFileSync(join(f.profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE), 'utf8')).toBe(oldState)
    renameSync(f.profile, input.rollbackDir); renameSync(input.candidateDir, f.profile)
    // This checks proof/tree validation only; no live Host health or receipt-commit authorization is asserted.
    const proof = prepareDesktopPackageReceipt(input)!
    const files = desktopReceiptFileTransitions(proof)
    expect(files.map(file => file.file)).toEqual(['desktop-plugin-receipts.json', DESKTOP_PLUGIN_PROVISIONING_STATE_FILE])
    expect(files[1]!.before).toBeNull()
    if (receiptWritten) writeFileSync(join(f.profile, files[0]!.file), files[0]!.after)
    if (stateWritten) writeFileSync(join(f.profile, files[1]!.file), files[1]!.after)
    expect(desktopPackageReceiptPosition(input, proof)).toBe(receiptWritten === stateWritten ? (receiptWritten ? 'after' : 'before') : 'mixed')
    expect(await f.backend.verifyActivationTree(id, 'active', proof)).toMatchObject({ candidateFingerprint: input.candidateFingerprint })
    expect(object(jsonObject(proof.after), 'owners')[pluginName]).toBe('release')
    writeFileSync(join(f.profile, 'unrelated-user-data.json'), '{}\n')
    await expect(f.backend.verifyActivationTree(id, 'active', proof)).rejects.toThrow('active tree changed')
    rmSync(join(f.profile, 'unrelated-user-data.json'))
    writeFileSync(join(f.profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE), '{}\n')
    await expect(f.backend.verifyActivationTree(id, 'active', proof)).rejects.toThrow('receipt')
    expect(readFileSync(join(input.rollbackDir, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE), 'utf8')).toBe(oldState)
  })

  it('refuses malformed provisioning evidence rather than deleting it during staging', async () => {
    const f = await provisioningFixture()
    writeFileSync(join(f.profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE), '{broken evidence')
    await expect(f.backend.stageProvisioning(randomUUID(), new AbortController().signal)).rejects.toThrow('explicit recovery')
    expect(readFileSync(join(f.profile, DESKTOP_PLUGIN_PROVISIONING_STATE_FILE), 'utf8')).toBe('{broken evidence')
    expect(f.fetcher).not.toHaveBeenCalled()
  })

  it.each(['user-owned', 'disabled', 'extra-release'] as const)('does not restage exact user ownership, disabled state or extra managed inventory: %s', async conflict => {
    const f = await provisioningFixture()
    if (conflict === 'extra-release') await seedReceipt(f, '@example/stale-release')
    else if (conflict === 'user-owned') await seedExactPlanned(f)
    else {
      const specifier = `file:.desktop-plugin-artifacts/${f.plannedSource.sha256}.tgz`
      mkdirSync(join(f.profile, '.desktop-plugin-artifacts'))
      copyFileSync(f.archive, join(f.profile, specifier.slice(5)))
      write(join(f.profile, 'package.json'), { dependencies: { [pluginName]: specifier }, dsh: { profile: { bundles: [] } } })
      write(join(f.profile, 'desktop-plugin-receipts.json'), { schemaVersion: 1, receipts: { [pluginName]: f.evidence }, owners: { [pluginName]: 'release' } })
    }
    const before = inventoryDesktopRuntime(f.profile)
    await expect(f.backend.stageProvisioning(randomUUID(), new AbortController().signal))
      .rejects.toThrow(/qualify the exact installed graph|disabled|broader reconciliation/u)
    expect(f.fetcher).not.toHaveBeenCalled()
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
  })

  it('binds raw plan bytes as well as canonical plan identity across staging and recovery', async () => {
    const f = await provisioningFixture()
    const id = randomUUID()
    await f.backend.stageProvisioning(id, new AbortController().signal)
    writeFileSync(f.planFile, `${readFileSync(f.planFile, 'utf8')} `)
    await expect(f.backend.stageProvisioning(randomUUID(), new AbortController().signal)).rejects.toThrow('resource changed')
    await expect(f.backend.readPreparedForActivation(id)).rejects.toThrow('resource changed')
    await expect(f.backend.readPreparedForRecovery(id)).rejects.toThrow('resource changed')
  })

  it('rejects absent, optional, multi-entry and unpaired private provisioning plans', async () => {
    const ordinary = fixture()
    await expect(ordinary.backend.stageProvisioning(randomUUID(), new AbortController().signal)).rejects.toThrow('no packaged provisioning plan')
    const f = await provisioningFixture()
    const { provisioningPlanFile, ...unpaired } = f.options
    expect(provisioningPlanFile).toBe(f.planFile)
    expect(() => createDesktopProfilePackageTransactions(unpaired)).toThrow('both fixed plan')
    for (const plugins of [[], [{ required: false, source: f.plannedSource }], [{ required: true, source: f.plannedSource }, { required: true, source: { ...f.plannedSource, packageName: 'another-planned-plugin' } }]]) {
      const plan = parseDesktopPluginProvisioningPlan({ schemaVersion: 1, mode: 'exact', plugins })
      write(f.planFile, plan)
      expect(() => createDesktopProfilePackageTransactions({ ...f.options, provisioningPlan: plan })).toThrow('only one required')
    }
  })

  it('seals the official root for a freshly initialized profile before its ordinary launcher write', async () => {
    const f = fixture()
    const fresh = join(f.root, 'profiles', 'fresh')
    initProfile(fresh, [])
    writeFileSync(join(fresh, 'desktop.cordis.yml'), '# preserved legacy metadata\n[]\n')
    const before = inventoryDesktopRuntime(fresh)
    expect(existsSync(join(fresh, PROFILE_ROOT_FILENAME))).toBe(false)
    const backend = createDesktopProfilePackageTransactions({ ...f.options, profile: fresh })
    const id = randomUUID()
    await backend.stage(id, f.mutation, new AbortController().signal)
    expect(inventoryDesktopRuntime(fresh)).toEqual(before)
    const input = (await backend.readPreparedForActivation(id))!
    expect(readFileSync(join(input.candidateDir, PROFILE_ROOT_FILENAME), 'utf8')).toBe(PROFILE_ROOT_CONFIG)
    expect(readFileSync(join(input.candidateDir, 'desktop.cordis.yml'), 'utf8')).toBe('# preserved legacy metadata\n[]\n')
    renameSync(fresh, input.rollbackDir); renameSync(input.candidateDir, fresh)
    writeProfileRootConfig(fresh)
    expect(await backend.verifyActivationTree(id, 'active')).toMatchObject({ candidateFingerprint: input.candidateFingerprint })
  })

  it('refuses a nonempty unknown profile root without rewriting the user patch or active root', async () => {
    const f = fixture()
    const root = '- id: user-root\n  name: user-module\n'
    writeFileSync(join(f.profile, PROFILE_ROOT_FILENAME), root)
    const patch = readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')
    await expect(f.backend.stage(randomUUID(), f.mutation, new AbortController().signal)).rejects.toThrow('non-empty root requires explicit migration')
    expect(readFileSync(join(f.profile, PROFILE_ROOT_FILENAME), 'utf8')).toBe(root)
    expect(readFileSync(join(f.profile, 'cordis.patch.yml'), 'utf8')).toBe(patch)
    expect(f.pnpmRunner).not.toHaveBeenCalled()
  })

  it('prepares a fresh graph and content-addressed snapshot without changing active files or claiming health', async () => {
    const f = fixture()
    const before = f.active()
    const id = randomUUID()
    const result = await f.backend.stage(id, f.mutation, new AbortController().signal)
    const expectedFingerprint: unknown = expect.stringMatching(/^[a-f0-9]{64}$/u)
    expect(result).toEqual({ transactionId: id, state: 'prepared', packageName: pluginName,
      baseFingerprint: expectedFingerprint, health: 'pending' })
    expect(f.active()).toEqual(before)
    const candidate = join(f.transaction(id), 'profile')
    expect(existsSync(join(candidate, 'node_modules', 'active-sentinel'))).toBe(false)
    const manifest = jsonObject(readFileSync(join(candidate, 'package.json'), 'utf8'))
    expect(manifest.userField).toEqual({ untouched: true })
    expect(object(manifest, 'dependencies')[pluginName]).toMatch(/^file:\.desktop-plugin-artifacts\/[a-f0-9]{64}\.tgz$/u)
    expect(object(manifest, 'dsh', 'profile').bundles).toEqual([pluginName])
    expect(f.pnpmRunner).toHaveBeenCalledOnce()
    const invocation = f.pnpmRunner.mock.calls[0]![0]
    expect(invocation.args).toContain('--ignore-scripts')
    expect(invocation.args).toContain('--ignore-pnpmfile')
    expect(invocation.env.npm_config_ignore_scripts).toBe('true')
    expect(invocation.env.NODE_OPTIONS).toBeUndefined()
    expect(readFileSync(join(candidate, 'pnpm-workspace.yaml'), 'utf8')).toContain('approved-native: true')
    const receipt = jsonObject(readFileSync(join(f.transaction(id), 'PREPARED.json'), 'utf8'))
    expect(receipt.mutation).toEqual(f.mutation)
    expect(object(receipt, 'owner').profile).toBe(f.profile)
    const baseFiles = receipt.baseFiles
    if (!isArray(baseFiles)) throw new Error('prepared fixture requires an inventory array')
    expect(baseFiles.map(entry => object(entry).path)).toContain('desktop-plugin-receipts.json')
    expect(object(receipt, 'result').health).toBe('pending')
    expect(receipt).not.toHaveProperty('activated')
    expect(f.fetcher).not.toHaveBeenCalled()
  })

  it('recovers a durable request and explicitly discards it only through a later standalone cancel', async () => {
    const f = fixture()
    const id = randomUUID()
    const result = await f.backend.stage(id, f.mutation, new AbortController().signal)
    const recovered = createDesktopProfilePackageTransactions(f.options)
    expect(await recovered.stage(id, f.mutation, new AbortController().signal)).toEqual(result)
    expect(await recovered.status(id)).toEqual(result)
    expect(await recovered.listPending()).toEqual([result])
    expect(f.pnpmRunner).toHaveBeenCalledOnce()
    await expect(recovered.stage(id, { ...f.mutation, enabled: false }, new AbortController().signal)).rejects.toThrow('different mutation')
    const before = f.active()
    await recovered.cancel(id)
    await recovered.cancel(id)
    expect(await recovered.status(id)).toBeUndefined()
    expect(await recovered.listPending()).toEqual([])
    expect(existsSync(join(f.transaction(id), 'profile'))).toBe(false)
    expect(existsSync(join(f.transaction(id), 'PREPARED.json'))).toBe(true)
    expect(jsonObject(readFileSync(join(f.transaction(id), 'DISCARDED.json'), 'utf8')).state).toBe('discarded')
    await expect(recovered.stage(id, f.mutation, new AbortController().signal)).rejects.toThrow('explicitly discarded')
    expect(f.active()).toEqual(before)
  })

  it('retains a seal won before an in-flight abort and requires a separate discard request', async () => {
    const f = fixture()
    const id = randomUUID()
    const observed = deferred<undefined>()
    let cancellation: Promise<unknown> | undefined
    const rename = fs.renameSync
    const interception = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      rename(from, to)
      if (String(to) === join(f.transaction(id), 'PREPARED.json')) queueMicrotask(() => {
        cancellation = f.backend.cancel(id).catch((error: unknown) => error)
        observed.resolve(undefined)
      })
    })
    syncBuiltinESMExports()
    let result
    try { result = await f.backend.stage(id, f.mutation, new AbortController().signal); await observed.promise }
    finally { interception.mockRestore(); syncBuiltinESMExports() }
    expect(await cancellation).toBeInstanceOf(Error)
    expect(await f.backend.status(id)).toEqual(result)
    expect(existsSync(join(f.transaction(id), 'DISCARDED.json'))).toBe(false)
  })

  it('reports discard cleanup failure and resumes it without silently restaging the UUID', async () => {
    const f = fixture()
    const id = randomUUID()
    await f.backend.stage(id, f.mutation, new AbortController().signal)
    const remove = fs.rmSync
    const fault = vi.spyOn(fs, 'rmSync').mockImplementation((path, options) => {
      if (String(path) === join(f.transaction(id), 'profile', 'package.json')) throw Object.assign(new Error('discard cleanup denied'), { code: 'EPERM' })
      remove(path, options)
    })
    syncBuiltinESMExports()
    try { await expect(f.backend.cancel(id)).rejects.toThrow('discard cleanup denied') }
    finally { fault.mockRestore(); syncBuiltinESMExports() }
    await expect(f.backend.status(id)).rejects.toThrow('cleanup is incomplete')
    await expect(f.backend.stage(id, f.mutation, new AbortController().signal)).rejects.toThrow('cleanup is incomplete')
    const recovered = createDesktopProfilePackageTransactions(f.options)
    await recovered.cancel(id)
    expect(await recovered.status(id)).toBeUndefined()
    expect(existsSync(join(f.transaction(id), 'profile'))).toBe(false)
  })

  it.each(['committed', 'rolled-back'] as const)('hides %s activation history before looking for a candidate and refuses discard', async phase => {
    const f = fixture()
    const id = randomUUID()
    await f.backend.stage(id, f.mutation, new AbortController().signal)
    const activation = createDesktopProfilePackageActivation({ profile: f.profile, backend: f.backend,
      confirm: async () => true, acquireAdmission: async () => async () => {}, qualify: async () => {},
      stopHost: async () => {}, startHost: async () => {},
      verifyHost: async (_input, role) => { if (phase === 'rolled-back' && role === 'candidate') throw new Error('fixture health failure') },
      commitReceipt: async () => {},
    })
    expect((await activation.activate(id)).status).toBe(phase)
    expect(await f.backend.status(id)).toBeUndefined()
    expect(await f.backend.listPending()).toEqual([])
    await expect(f.backend.cancel(id)).rejects.toThrow('activation-owned')
    expect(existsSync(join(f.transaction(id), 'PREPARED.json'))).toBe(true)
    expect(existsSync(join(f.transaction(id), 'ACTIVATION.json'))).toBe(true)
  })

  it('refuses discard while activation holds the lease instead of waiting or deleting recovery evidence', async () => {
    const f = fixture()
    const id = randomUUID()
    await f.backend.stage(id, f.mutation, new AbortController().signal)
    const entered = deferred<undefined>()
    const release = deferred<undefined>()
    const activation = createDesktopProfilePackageActivation({ profile: f.profile, backend: f.backend,
      confirm: async () => true, acquireAdmission: async () => async () => {}, qualify: async () => {},
      stopHost: async () => { entered.resolve(undefined); await release.promise },
      startHost: async () => {}, verifyHost: async () => {}, commitReceipt: async () => {},
    })
    const operation = activation.activate(id)
    await entered.promise
    try {
      await expect(f.backend.cancel(id)).rejects.toThrow('activation-owned')
      await expect(f.backend.status(id)).rejects.toThrow('activation is in progress')
      expect(await f.backend.listPending()).toEqual([])
    } finally { release.resolve(undefined) }
    await operation
  })

  it('returns durable PREPARED even when a recovered caller signal is already aborted', async () => {
    const f = fixture()
    const id = randomUUID()
    const result = await f.backend.stage(id, f.mutation, new AbortController().signal)
    const abort = new AbortController()
    abort.abort(new Error('disconnected caller'))
    expect(await f.backend.stage(id, f.mutation, abort.signal)).toEqual(result)
  })

  it('provides a shell-private validated activation read and refuses a stale base', async () => {
    const f = fixture()
    const id = randomUUID()
    const result = await f.backend.stage(id, f.mutation, new AbortController().signal)
    const input = await withProfilePackageLease(f.profile, () => f.backend.readPreparedForActivation(id))
    expect(input).toMatchObject({ transactionDir: f.transaction(id), candidateDir: join(f.transaction(id), 'profile'), prepared: result, mutation: f.mutation })
    expect(input?.verifiedRelease).toBeUndefined()
    writeFileSync(join(f.profile, 'cordis.patch.yml'), '[] # changed after prepare\n')
    await expect(withProfilePackageLease(f.profile, () => f.backend.readPreparedForActivation(id))).rejects.toThrow('base no longer matches')
    // Recovery/listing still describes a prepared transaction, without granting activation permission.
    expect(await f.backend.status(id)).toEqual(result)
  })

  it('constructs recovery with a missing active directory only when the exact owned rollback verifies', async () => {
    const f = fixture()
    const id = randomUUID()
    await f.backend.stage(id, f.mutation, new AbortController().signal)
    const input = await withProfilePackageLease(f.profile, () => f.backend.readPreparedForActivation(id))
    expect(input).toBeDefined()
    // Model a rename gap using only disposable fixture directories, not a running application.
    renameSync(f.profile, input!.rollbackDir)
    expect(() => createDesktopProfilePackageTransactions(f.options)).toThrow('explicit owned recovery')
    const recovery = createDesktopProfilePackageTransactions({ ...f.options, recoveryTransactionId: id })
    expect(await recovery.readPreparedForRecovery(id)).toMatchObject({
      rollbackDir: input!.rollbackDir, baseGraphFingerprint: input!.baseGraphFingerprint,
    })
    await expect(recovery.verifyActivationTree(id, 'rollback')).resolves.toMatchObject({ prepared: input!.prepared })
    await expect(recovery.verifyActivationTree(id, 'candidate')).resolves.toMatchObject({ prepared: input!.prepared })
    writeFileSync(join(input!.rollbackDir, 'node_modules', 'active-sentinel'), 'changed old graph')
    await expect(recovery.verifyActivationTree(id, 'rollback')).rejects.toThrow('rollback tree changed')
    expect(() => createDesktopProfilePackageTransactions({ ...f.options, recoveryTransactionId: id })).toThrow('rollback tree changed')
    expect(existsSync(f.profile)).toBe(false)
  })

  it('verifies a candidate moved into the active fixture location without accepting receipt modifications', async () => {
    const f = fixture()
    const id = randomUUID()
    await f.backend.stage(id, f.mutation, new AbortController().signal)
    const input = await f.backend.readPreparedForActivation(id)
    renameSync(f.profile, input!.rollbackDir)
    renameSync(input!.candidateDir, f.profile)
    expect(await f.backend.verifyActivationTree(id, 'active')).toMatchObject({ prepared: input!.prepared })
    write(join(f.profile, 'desktop-plugin-receipts.json'), { changed: true })
    await expect(f.backend.verifyActivationTree(id, 'active')).rejects.toThrow('active tree changed')
    expect(await f.backend.readPreparedForRecovery(id)).toMatchObject({ prepared: input!.prepared })
  })

  it('accepts only the exact health-receipt transition while retaining the sealed graph digest', async () => {
    const f = fixture()
    const archive = join(f.root, 'verified.tgz')
    await f.packDirectory(f.source, archive, new AbortController().signal)
    const bytes = readFileSync(archive)
    const evidence = receipt(pluginName, bytes)
    const fetcher: typeof fetch = async input => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      if (url.endsWith('/releases/tags/v1.0.0')) return Response.json({ id: 10, draft: false, immutable: true, tag_name: 'v1.0.0', target_commitish: evidence.source.targetCommit,
        assets: [{ id: 11, name: 'plugin.tgz', state: 'uploaded', size: bytes.length, digest: `sha256:${evidence.source.sha256}` }] })
      if (url.endsWith('/git/ref/tags/v1.0.0')) return Response.json({ object: { type: 'commit', sha: evidence.source.targetCommit } })
      if (url.endsWith('/releases/assets/11')) return new Response(new Uint8Array(bytes), { headers: { 'content-length': String(bytes.length) } })
      throw new Error(`unexpected acquisition URL: ${url}`)
    }
    const backend = createDesktopProfilePackageTransactions({ ...f.options, fetcher })
    const id = randomUUID()
    await backend.stage(id, { kind: 'install', source: evidence.source }, new AbortController().signal)
    expect(f.pnpmRunner.mock.calls[0]![0].args).toContain('--registry=https://registry.example.invalid/')
    const input = (await backend.readPreparedForActivation(id))!
    renameSync(f.profile, input.rollbackDir); renameSync(input.candidateDir, f.profile)
    // Test only the proof validator, not runtime health or the shell's receipt-commit authorization.
    const proof = prepareDesktopPackageReceipt(input)!
    expect(await backend.verifyActivationTree(id, 'active', proof)).toMatchObject({ prepared: input.prepared })
    writeFileSync(join(f.profile, proof.file), proof.after)
    expect(await backend.verifyActivationTree(id, 'active', proof)).toMatchObject({ prepared: input.prepared })
    await expect(backend.verifyActivationTree(id, 'rollback', proof)).rejects.toThrow('only to the active tree')
    writeFileSync(join(f.profile, proof.file), `${proof.after} `)
    await expect(backend.verifyActivationTree(id, 'active', proof)).rejects.toThrow('receipt')
    writeFileSync(join(f.profile, proof.file), proof.after)
    writeFileSync(join(f.profile, 'unrecorded.txt'), 'not covered by the receipt proof')
    await expect(backend.verifyActivationTree(id, 'active', proof)).rejects.toThrow('active tree changed')
  })

  it('retains disabled state on owned replacement and stages owned removal without changing active state', async () => {
    const f = fixture()
    const initial = randomUUID()
    await f.backend.stage(initial, { ...f.mutation, enabled: false }, new AbortController().signal)
    const candidate = join(f.transaction(initial), 'profile')
    // Seed a prior owned installation in the disposable test profile; never run activation code.
    for (const name of ['package.json', 'desktop-plugin-package-locks.json', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) copyFileSync(join(candidate, name), join(f.profile, name))
    mkdirSync(join(f.profile, '.desktop-plugin-artifacts'))
    for (const name of readdirSync(join(candidate, '.desktop-plugin-artifacts'))) copyFileSync(join(candidate, '.desktop-plugin-artifacts', name), join(f.profile, '.desktop-plugin-artifacts', name))
    const before = f.active()
    const replacementId = randomUUID()
    await f.backend.stage(replacementId, f.mutation, new AbortController().signal)
    const replaced = jsonObject(readFileSync(join(f.transaction(replacementId), 'profile', 'package.json'), 'utf8'))
    expect(object(replaced, 'dsh', 'profile').bundles).toEqual([])
    const removeId = randomUUID()
    await f.backend.stage(removeId, { kind: 'remove', name: pluginName }, new AbortController().signal)
    const removed = jsonObject(readFileSync(join(f.transaction(removeId), 'profile', 'package.json'), 'utf8'))
    expect(removed.dependencies).toEqual({})
    expect(object(removed, 'dsh', 'profile').bundles).toEqual([])
    expect(f.active()).toEqual(before)
  })

  it.each(['npmRegistry', 'packageSpec'] as const)('stages a registry bundle through %s with exact distinct resolution evidence', async type => {
    const f = fixture()
    const runner = vi.fn((request: DesktopStagingPnpmRequest) => registryGraph(request))
    const backend = createDesktopProfilePackageTransactions({ ...f.options, pnpmRunner: runner })
    const before = inventoryDesktopRuntime(f.profile)
    const id = randomUUID()
    await backend.stage(id, { kind: 'install', source: { schemaVersion: 1, type, spec: '@example/registry-bundle@^1.0.0' } }, new AbortController().signal)
    const input = (await backend.readPreparedForActivation(id))!
    expect(input.registryTarget).toEqual({ schemaVersion: 1, requestedSpec: '@example/registry-bundle@^1.0.0', registry: f.options.dependencyRegistry,
      packageName: '@example/registry-bundle', version: '1.2.3', integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`, packageKey: '@example/registry-bundle@1.2.3' })
    expect(input.verifiedRelease).toBeUndefined()
    expect(input.provisioning).toBeUndefined()
    expect(jsonObject(readFileSync(join(input.candidateDir, 'desktop-plugin-package-locks.json'), 'utf8')).packages).toEqual({})
    expect(jsonObject(readFileSync(join(input.candidateDir, 'desktop-plugin-receipts.json'), 'utf8')).receipts).toEqual({})
    expect(object(jsonObject(readFileSync(join(input.candidateDir, 'package.json'), 'utf8')), 'dependencies')['@example/registry-bundle']).toBe('1.2.3')
    expect(runner.mock.calls[0]![0].args).toContain('--save-exact')
    expect(f.fetcher).not.toHaveBeenCalled()
    expect(f.packDirectory).not.toHaveBeenCalled()
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
    const prepared = jsonObject(readFileSync(join(input.transactionDir, 'PREPARED.json'), 'utf8'))
    object(prepared, 'registryTarget').integrity = `sha512-${Buffer.alloc(64, 2).toString('base64')}`
    write(join(input.transactionDir, 'PREPARED.json'), prepared)
    await expect(backend.status(id)).rejects.toThrow('registry resolution changed')
  })

  it.each(['extra-manifest', 'wrong-version', 'unsafe-tarball', 'plain-dependency'] as const)('rejects a registry install violating bundle/manifest/resolution rules: %s', async change => {
    const f = fixture()
    const name = 'registry-bundle'
    const backend = createDesktopProfilePackageTransactions({ ...f.options, pnpmRunner: async request => {
      const result = await registryGraph(request, change === 'wrong-version' ? '2.0.0' : '1.2.3')
      if (change === 'extra-manifest') {
        const path = join(request.cwd, 'package.json'); const value = jsonObject(readFileSync(path, 'utf8')); value.userField = { overwritten: true }; write(path, value)
      }
      if (change === 'unsafe-tarball') {
        const path = join(request.cwd, 'pnpm-lock.yaml'); const value = jsonObject(readFileSync(path, 'utf8')); object(value, 'packages', `${name}@1.2.3`, 'resolution').tarball = 'http://untrusted.invalid/package.tgz'; write(path, value)
      }
      if (change === 'plain-dependency') write(join(request.cwd, 'node_modules', name, 'package.json'), { name, version: '1.2.3' })
      return result
    } })
    const before = inventoryDesktopRuntime(f.profile)
    await expect(backend.stage(randomUUID(), { kind: 'install', source: { schemaVersion: 1, type: 'npmRegistry', spec: `${name}@1.2.3` } }, new AbortController().signal)).rejects.toThrow()
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
  })

  it('removes a damaged direct registry dependency without requiring Release or source-lock ownership', async () => {
    const f = fixture()
    const name = 'plain-registry-root'
    write(join(f.profile, 'package.json'), { dependencies: { [name]: '^1.0.0' }, dsh: { profile: { bundles: [] } } })
    write(join(f.profile, 'pnpm-lock.yaml'), { lockfileVersion: '9.0', importers: { '.': { dependencies: { [name]: { specifier: '^1.0.0', version: '1.0.0' } } } },
      packages: { [`${name}@1.0.0`]: { resolution: { integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` } } }, snapshots: { [`${name}@1.0.0`]: {} } })
    symlinkSync(join(f.root, 'missing-package'), join(f.profile, 'node_modules', name), 'junction')
    const id = randomUUID()
    await f.backend.stage(id, { kind: 'remove', name }, new AbortController().signal)
    const input = (await f.backend.readPreparedForActivation(id))!
    expect(jsonObject(readFileSync(join(input.candidateDir, 'package.json'), 'utf8')).dependencies).toEqual({})
    expect(readDesktopPluginUserIntents(input.candidateDir).removed[name]).toEqual({})
    expect(fs.lstatSync(join(f.profile, 'node_modules', name)).isSymbolicLink()).toBe(true)
    expect(input.registryTarget).toBeUndefined()
    expect(input.verifiedRelease).toBeUndefined()
  })

  it('rejects malformed identities, disguised registry transports and unsupported build requests with active state unchanged', async () => {
    const f = fixture()
    const before = f.active()
    await expect(f.backend.stage('../escape', f.mutation, new AbortController().signal)).rejects.toThrow('transaction id')
    await expect(f.backend.status('../escape')).rejects.toThrow('transaction id')
    await expect(f.backend.cancel('../escape')).rejects.toThrow('transaction id')
    await expect(f.backend.stage(randomUUID(), { kind: 'install', source: { schemaVersion: 1, type: 'npmRegistry', spec: `file:${f.source}` } }, new AbortController().signal)).rejects.toThrow('npmRegistry requires a registry')
    await expect(f.backend.stage(randomUUID(), { ...f.mutation, approvedBuilds: ['native'] }, new AbortController().signal)).rejects.toThrow('build approval')
    expect(f.pnpmRunner).not.toHaveBeenCalled()
    expect(f.active()).toEqual(before)
  })

  it('uses one explicit normalized registry for local installs and removals and binds it to the owner', async () => {
    const f = fixture({ dependencyRegistry: 'https://configured.invalid/npm' })
    const installed = randomUUID()
    await f.backend.stage(installed, f.mutation, new AbortController().signal)
    const input = (await f.backend.readPreparedForActivation(installed))!
    expect(input.owner.dependencyRegistry).toBe('https://configured.invalid/npm/')
    const candidate = input.candidateDir
    for (const name of ['package.json', 'pnpm-lock.yaml', 'desktop-plugin-package-locks.json']) copyFileSync(join(candidate, name), join(f.profile, name))
    cpSync(join(candidate, '.desktop-plugin-artifacts'), join(f.profile, '.desktop-plugin-artifacts'), { recursive: true })
    await f.backend.stage(randomUUID(), { kind: 'remove', name: pluginName }, new AbortController().signal)
    for (const [request] of f.pnpmRunner.mock.calls) expect(request.args).toContain('--registry=https://configured.invalid/npm/')
  })

  it('refuses a verified source or packaged plan that conflicts with the explicit registry policy before acquisition', async () => {
    const f = fixture()
    const source = { ...receipt(pluginName, Buffer.from('not downloaded')).source, dependencyRegistry: 'https://other.invalid/' }
    await expect(f.backend.stage(randomUUID(), { kind: 'install', source }, new AbortController().signal)).rejects.toThrow('registry conflicts')
    expect(f.fetcher).not.toHaveBeenCalled()
    const planned = await provisioningFixture()
    expect(() => createDesktopProfilePackageTransactions({ ...planned.options, dependencyRegistry: 'https://other.invalid/' })).toThrow('registry conflicts')
    expect(planned.fetcher).not.toHaveBeenCalled()
  })

  it.each(['', 'http://registry.invalid/', 'https://user:secret@registry.invalid/', 'https://registry.invalid/?token=secret', 'https://registry.invalid/#fragment', 'https://registry.invalid/\n'])('refuses unsafe or absent explicit registry policy %j', registry => {
    expect(() => fixture({ dependencyRegistry: registry })).toThrow()
  })

  it('preserves an untracked user-owned file-source collision instead of replacing or removing it', async () => {
    const f = fixture()
    write(join(f.profile, 'package.json'), { private: true, dependencies: { [pluginName]: 'file:./untracked-user-source.tgz' }, dsh: { profile: { bundles: [pluginName] } } })
    const before = f.active()
    await expect(f.backend.stage(randomUUID(), f.mutation, new AbortController().signal)).rejects.toThrow('user-owned')
    await expect(f.backend.stage(randomUUID(), { kind: 'remove', name: pluginName }, new AbortController().signal)).rejects.toThrow('owned source or direct registry')
    expect(f.pnpmRunner).not.toHaveBeenCalled()
    expect(f.active()).toEqual(before)
  })

  it('cleans an exclusively created transaction after owner-record flush failure without poisoning pending listing', async () => {
    const f = fixture()
    const goodId = randomUUID()
    await f.backend.stage(goodId, f.mutation, new AbortController().signal)
    const id = randomUUID()
    const sync = fs.fsyncSync
    let injected = false
    const fault = vi.spyOn(fs, 'fsyncSync').mockImplementation(fd => {
      if (existsSync(join(f.transaction(id), 'owner.json.tmp'))) { injected = true; throw new Error('owner flush failure') }
      sync(fd)
    })
    syncBuiltinESMExports()
    try {
      await expect(f.backend.stage(id, f.mutation, new AbortController().signal)).rejects.toThrow('owner flush failure')
    } finally { fault.mockRestore(); syncBuiltinESMExports() }
    expect(injected).toBe(true)
    expect(existsSync(f.transaction(id))).toBe(false)
    expect((await f.backend.listPending()).map(entry => entry.transactionId)).toEqual([goodId])
  })

  it('rejects a newly built absolute internal junction before sealing PREPARED', async () => {
    const f = fixture()
    const backend = createDesktopProfilePackageTransactions({ ...f.options, pnpmRunner: async request => {
      const result = await graph(request)
      symlinkSync(join(request.cwd, 'node_modules', pluginName), join(request.cwd, 'node_modules', 'absolute-alias'), 'junction')
      return result
    } })
    const id = randomUUID()
    await expect(backend.stage(id, f.mutation, new AbortController().signal)).rejects.toThrow('nonrelocatable absolute package link')
    expect(existsSync(f.transaction(id))).toBe(false)
  })

  it('can remove a target whose old installed junction is dangling without following it', async () => {
    const f = fixture()
    await seedReceipt(f, '@example/retained')
    await seedReceipt(f, pluginName)
    const installed = join(f.profile, 'node_modules', pluginName)
    rmSync(installed, { recursive: true })
    symlinkSync(join(f.root, 'already-missing-target'), installed, 'junction')
    const before = fs.readlinkSync(installed)
    const id = randomUUID()
    await f.backend.stage(id, { kind: 'remove', name: pluginName }, new AbortController().signal)
    expect(fs.readlinkSync(installed)).toBe(before)
    expect(existsSync(join(f.transaction(id), 'profile', 'node_modules', pluginName))).toBe(false)
    expect(await f.backend.readPreparedForActivation(id)).toBeDefined()
  })

  it.each(['unchanged', 'transitive', 'optional', 'peer', 'foreign-link'] as const)('binds retained transitive, optional, peer and runtime-link closure: %s', async change => {
    const f = fixture()
    const name = '@example/retained'
    const { specifier } = await seedReceipt(f, name, { dependencies: { middle: '^1.0.0' }, optionalDependencies: { 'optional-leaf': '~2.0.0' }, peerDependencies: { '@deepseek-ai/cordis': version } })
    const original = jsonObject(readFileSync(join(f.profile, 'pnpm-lock.yaml'), 'utf8'))
    const peer = `(@deepseek-ai/cordis@${version})`
    const key = `${name}@${specifier}${peer}`
    const middle = `middle@1.0.0${peer}`
    const originalDependencies = object(original, 'importers', '.', 'dependencies')
    const originalSnapshots = object(original, 'snapshots')
    const originalPackages = object(original, 'packages')
    const retainedEntry = object(originalDependencies, name)
    retainedEntry.version = `${stringValue(retainedEntry.version)}${peer}`
    Reflect.deleteProperty(originalSnapshots, `${name}@${specifier}`)
    const runtimeLink = `link:${join(f.runtimeDir, 'node_modules', '@deepseek-ai/cordis').replaceAll('\\', '/')}`
    originalSnapshots[key] = { dependencies: { middle: `1.0.0${peer}`, '@deepseek-ai/cordis': runtimeLink }, optionalDependencies: { 'optional-leaf': '2.0.0' } }
    originalSnapshots[middle] = { dependencies: { leaf: '3.0.0' }, transitivePeerDependencies: ['@deepseek-ai/cordis'] }
    for (const entry of ['middle@1.0.0', 'leaf@3.0.0', 'optional-leaf@2.0.0', 'plain-user@3.1.0']) {
      originalPackages[entry] = { resolution: { integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}` } }
      if (entry !== 'middle@1.0.0') originalSnapshots[entry] = {}
    }
    const manifest = jsonObject(readFileSync(join(f.profile, 'package.json'), 'utf8'))
    object(manifest, 'dependencies')['plain-user'] = '^3.0.0'
    originalDependencies['plain-user'] = { specifier: '^3.0.0', version: '3.1.0' }
    write(join(f.profile, 'package.json'), manifest)
    write(join(f.profile, 'pnpm-lock.yaml'), original)
    const backend = createDesktopProfilePackageTransactions({ ...f.options, pnpmRunner: async request => {
      const manifestPath = join(request.cwd, 'package.json')
      const text = readFileSync(manifestPath, 'utf8')
      const document = jsonObject(text)
      delete object(document, 'dependencies')['plain-user']
      write(manifestPath, document)
      await graph(request)
      writeFileSync(manifestPath, text)
      write(join(request.cwd, 'node_modules', 'plain-user', 'package.json'), { name: 'plain-user', version: '3.1.0' })
      const generated = jsonObject(readFileSync(join(request.cwd, 'pnpm-lock.yaml'), 'utf8'))
      const generatedDependencies = object(generated, 'importers', '.', 'dependencies')
      generatedDependencies[name] = originalDependencies[name]
      generatedDependencies['plain-user'] = originalDependencies['plain-user']
      const generatedPackages = { ...object(generated, 'packages'), ...originalPackages }
      const generatedSnapshots = { ...object(generated, 'snapshots'), ...originalSnapshots }
      generated.packages = generatedPackages
      generated.snapshots = generatedSnapshots
      if (request.args.includes('add')) {
        if (change === 'transitive') generatedPackages['leaf@3.0.0'] = { resolution: { integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}` } }
        if (change === 'optional') generatedSnapshots[key] = { ...object(generatedSnapshots, key), optionalDependencies: {} }
        if (change === 'peer') generatedSnapshots[middle] = { ...object(generatedSnapshots, middle), transitivePeerDependencies: ['other-peer'] }
        if (change === 'foreign-link') generatedSnapshots[key] = { ...object(generatedSnapshots, key), dependencies: { ...object(generatedSnapshots, key, 'dependencies'), '@deepseek-ai/cordis': `link:${f.root.replaceAll('\\', '/')}` } }
      }
      write(join(request.cwd, 'pnpm-lock.yaml'), generated)
      return { exitCode: 0 }
    } })
    const before = inventoryDesktopRuntime(f.profile)
    const operation = backend.stage(randomUUID(), f.mutation, new AbortController().signal)
    if (change === 'unchanged') expect(await operation).toMatchObject({ state: 'prepared', health: 'pending' })
    else await expect(operation).rejects.toThrow(/retained resolutions|descriptor target/u)
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
  })

  it('preserves real Desktop workspace policy, retained verified roots and receipt owners', async () => {
    const f = fixture()
    const retained = '@example/retained'
    const { evidence, specifier } = await seedReceipt(f, retained)
    const workspace = "# user policy stays byte-identical\npackages: ['.']\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  approved-native: true\n"
    writeFileSync(join(f.profile, 'pnpm-workspace.yaml'), workspace)
    const originalLock = jsonObject(readFileSync(join(f.profile, 'pnpm-lock.yaml'), 'utf8'))
    // Repair only the historically emitted importer separator spelling.
    object(originalLock, 'importers', '.', 'dependencies', retained).specifier = specifier.replaceAll('/', '\\')
    write(join(f.profile, 'pnpm-lock.yaml'), originalLock)
    const before = inventoryDesktopRuntime(f.profile)
    const id = randomUUID()
    await f.backend.stage(id, f.mutation, new AbortController().signal)
    const candidate = join(f.transaction(id), 'profile')
    const finalLock = object(load(readFileSync(join(candidate, 'pnpm-lock.yaml'), 'utf8')))
    expect(object(finalLock, 'importers', '.', 'dependencies')[retained]).toEqual({ specifier, version: specifier })
    expect(object(finalLock, 'packages')[`${retained}@${specifier}`]).toEqual(object(originalLock, 'packages')[`${retained}@${specifier}`])
    expect(object(finalLock, 'snapshots')[`${retained}@${specifier}`]).toEqual(object(originalLock, 'snapshots')[`${retained}@${specifier}`])
    expect(jsonObject(readFileSync(join(candidate, 'desktop-plugin-receipts.json'), 'utf8'))).toEqual({ schemaVersion: 1, receipts: { [retained]: evidence }, owners: { [retained]: 'release' } })
    expect(readFileSync(join(candidate, 'pnpm-workspace.yaml'), 'utf8')).toBe(workspace)
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
    expect(f.pnpmRunner.mock.calls.map(([request]) => request.args.includes('--frozen-lockfile'))).toEqual([true, false])
  })

  it.each(['missing', 'corrupt'] as const)('removes a %s target artifact before verifying only the retained graph', async damage => {
    const f = fixture()
    const kept = await seedReceipt(f, '@example/retained')
    const target = await seedReceipt(f, pluginName)
    const path = join(f.profile, target.specifier.slice(5))
    if (damage === 'missing') rmSync(path)
    else writeFileSync(path, 'broken artifact')
    const before = inventoryDesktopRuntime(f.profile)
    const id = randomUUID()
    await f.backend.stage(id, { kind: 'remove', name: pluginName }, new AbortController().signal)
    const candidate = join(f.transaction(id), 'profile')
    const store = jsonObject(readFileSync(join(candidate, 'desktop-plugin-receipts.json'), 'utf8'))
    expect(store).toEqual({ schemaVersion: 1, receipts: { '@example/retained': kept.evidence }, owners: { '@example/retained': 'release' } })
    expect(jsonObject(readFileSync(join(candidate, 'package.json'), 'utf8')).dependencies).toEqual({ '@example/retained': kept.specifier })
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
  })

  it('clears only the replaced target receipt before candidate graph preparation', async () => {
    const f = fixture()
    const kept = await seedReceipt(f, '@example/retained')
    await seedReceipt(f, pluginName)
    const before = inventoryDesktopRuntime(f.profile)
    const runner = vi.fn(async (request: DesktopStagingPnpmRequest) => {
      const store = jsonObject(readFileSync(join(request.cwd, 'desktop-plugin-receipts.json'), 'utf8'))
      expect(object(store, 'receipts')[pluginName]).toBeUndefined(); expect(object(store, 'owners')[pluginName]).toBeUndefined()
      expect(object(store, 'receipts')['@example/retained']).toEqual(kept.evidence)
      return graph(request)
    })
    const backend = createDesktopProfilePackageTransactions({ ...f.options, pnpmRunner: runner })
    await backend.stage(randomUUID(), f.mutation, new AbortController().signal)
    expect(runner).toHaveBeenCalledTimes(2)
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
  })

  it('refuses an incremental mutation that changes a retained locked integrity', async () => {
    const f = fixture()
    const retained = await seedReceipt(f, '@example/retained')
    const backend = createDesktopProfilePackageTransactions({ ...f.options, pnpmRunner: async request => {
      const output = await graph(request)
      if (request.args.includes('add')) {
        const lock = jsonObject(readFileSync(join(request.cwd, 'pnpm-lock.yaml'), 'utf8'))
        object(lock, 'packages', `@example/retained@${retained.specifier}`, 'resolution').integrity = `sha512-${Buffer.alloc(64).toString('base64')}`
        write(join(request.cwd, 'pnpm-lock.yaml'), lock)
      }
      return output
    } })
    const before = inventoryDesktopRuntime(f.profile)
    await expect(backend.stage(randomUUID(), f.mutation, new AbortController().signal)).rejects.toThrow('changed retained resolutions')
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
  })

  it('rebuilds and mutates an offline real pnpm graph without changing retained identities or active bytes', { timeout: 180000 }, async () => {
    const f = fixture()
    const pnpm = process.env.DSH_TEST_DESKTOP_PNPM ?? join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs')
    expect(jsonObject(readFileSync(join(dirname(dirname(pnpm)), 'package.json'), 'utf8')).version).toBe('11.7.0')
    const runtime = { node: process.execPath, nodeBin: dirname(process.execPath), pnpm }
    const calls: DesktopStagingPnpmRequest[] = []
    const runner = async (request: DesktopStagingPnpmRequest) => {
      expect(request.cwd.startsWith(f.root)).toBe(true)
      calls.push(request)
      // Test-only transport confinement. Production uses its explicit configured registry.
      return runDesktopPackagePnpm(runtime, { ...request, args: [...request.args, '--offline'] })
    }
    const backend = createDesktopProfilePackageTransactions({ ...f.options, operationTimeoutMs: 60000, pnpmRunner: runner,
      packDirectory: (directory, archive, signal) => packDesktopSourceDirectory(runtime, directory, archive, signal) })
    const workspace = "# production profile policy\npackages: ['.']\nnodeLinker: hoisted\nautoInstallPeers: false\nallowBuilds:\n  approved-native: true\n"
    writeFileSync(join(f.profile, 'pnpm-workspace.yaml'), workspace)
    const retained = '@example/retained'
    write(join(f.source, 'package.json'), { name: retained, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, main: './index.js', files: ['index.js', 'cordis.patch.yml'] })
    const first = randomUUID()
    await backend.stage(first, f.mutation, new AbortController().signal)
    const seed = async (candidate: string): Promise<void> => {
      for (const name of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'desktop-plugin-package-locks.json', 'desktop-plugin-receipts.json']) {
        copyFileSync(join(candidate, name), join(f.profile, name))
      }
      mkdirSync(join(f.profile, '.desktop-plugin-artifacts'), { recursive: true })
      for (const name of readdirSync(join(candidate, '.desktop-plugin-artifacts'))) copyFileSync(join(candidate, '.desktop-plugin-artifacts', name), join(f.profile, '.desktop-plugin-artifacts', name))
      const invocation = calls[0]!
      await runner({ cwd: f.profile, signal: AbortSignal.timeout(60000), env: invocation.env, args: [
        'pm', `--config.userconfig=${invocation.env.npm_config_userconfig}`, `--config.globalconfig=${invocation.env.npm_config_globalconfig}`,
        'install', '--frozen-lockfile', '--ignore-scripts', '--ignore-pnpmfile', '--pm-on-fail=ignore', '--config.auto-install-peers=false',
        `--store-dir=${join(f.root, 'seed-store')}`,
      ] })
    }
    await seed(join(f.transaction(first), 'profile'))
    // Simulate the deployed verified-Release inventory, not a source-lock-only installation.
    const manifest = jsonObject(readFileSync(join(f.profile, 'package.json'), 'utf8'))
    const retainedSpec = stringValue(object(manifest, 'dependencies')[retained])
    const evidence = receipt(retained, readFileSync(join(f.profile, retainedSpec.slice(5))))
    write(join(f.profile, 'desktop-plugin-receipts.json'), { schemaVersion: 1, receipts: { [retained]: evidence }, owners: { [retained]: 'release' } })
    write(join(f.profile, 'desktop-plugin-package-locks.json'), { schemaVersion: 1, packages: {} })
    const before = inventoryDesktopRuntime(f.profile)
    const beforeLock = load(readFileSync(join(f.profile, 'pnpm-lock.yaml'), 'utf8')) as { packages: Record<string, unknown>; snapshots: Record<string, unknown> }
    write(join(f.source, 'package.json'), { name: pluginName, version: '1.0.0', dsh: { bundle: { patch: './cordis.patch.yml' } }, main: './index.js', files: ['index.js', 'cordis.patch.yml'] })
    const added = randomUUID()
    expect(await backend.stage(added, f.mutation, new AbortController().signal)).toMatchObject({ state: 'prepared', health: 'pending' })
    const candidate = join(f.transaction(added), 'profile')
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
    expect(readFileSync(join(candidate, 'pnpm-workspace.yaml'), 'utf8')).toBe(workspace)
    expect(readFileSync(join(candidate, 'node_modules', retained, 'index.js'), 'utf8')).toBe(readFileSync(join(f.profile, 'node_modules', retained, 'index.js'), 'utf8'))
    const afterLock = load(readFileSync(join(candidate, 'pnpm-lock.yaml'), 'utf8')) as typeof beforeLock
    for (const [key, value] of Object.entries(beforeLock.packages)) expect(afterLock.packages[key]).toEqual(value)
    for (const [key, value] of Object.entries(beforeLock.snapshots)) expect(afterLock.snapshots[key]).toEqual(value)
    await seed(candidate)
    const activeManifest = jsonObject(readFileSync(join(f.profile, 'package.json'), 'utf8'))
    rmSync(join(f.profile, stringValue(object(activeManifest, 'dependencies')[pluginName]).slice(5)))
    const beforeRemove = inventoryDesktopRuntime(f.profile)
    const removed = randomUUID()
    expect(await backend.stage(removed, { kind: 'remove', name: pluginName }, new AbortController().signal)).toMatchObject({ state: 'prepared' })
    expect(inventoryDesktopRuntime(f.profile)).toEqual(beforeRemove)
    expect(readFileSync(join(f.transaction(removed), 'profile', 'node_modules', retained, 'index.js'), 'utf8')).toBe(readFileSync(join(candidate, 'node_modules', retained, 'index.js'), 'utf8'))
    expect(jsonObject(readFileSync(join(f.transaction(removed), 'profile', 'desktop-plugin-receipts.json'), 'utf8')).owners).toEqual({ [retained]: 'release' })
  })

  it('stages actual TLS registry exact/range/moving-tag updates and damaged removal without scripts or retained drift', { timeout: 180000 }, async () => {
    const f = fixture()
    const pnpm = process.env.DSH_TEST_DESKTOP_PNPM ?? join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs')
    expect(jsonObject(readFileSync(join(dirname(dirname(pnpm)), 'package.json'), 'utf8')).version).toBe('11.7.0')
    const runtime = { node: process.execPath, nodeBin: dirname(process.execPath), pnpm }
    const marker = join(f.root, 'registry-script-ran')
    const caFile = join(f.root, 'NONPRODUCTION-registry-ca.pem')
    writeFileSync(caFile, LOOPBACK_TEST_TLS.ca, { mode: 0o600 })
    const cache = join(f.root, 'registry-cache')
    const packages = new Map<string, { manifest: Record<string, unknown>; bytes: Buffer; integrity: string }>()
    for (const [name, release, bundle] of [['retained-bundle', '1.0.0', true], ['registry-bundle', '1.0.0', true], ['registry-bundle', '1.1.0', true], ['plain-dependency', '1.0.0', false]] as const) {
      const directory = join(f.root, `${name}-${release}`)
      const manifest = { name, version: release, type: 'module', main: './index.js', files: ['index.js', 'hook.cjs', 'cordis.patch.yml'],
        ...(bundle ? { dsh: { bundle: { patch: './cordis.patch.yml' } } } : {}),
        scripts: { pm: 'node hook.cjs', preinstall: 'node hook.cjs', install: 'node hook.cjs', postinstall: 'node hook.cjs', prepare: 'node hook.cjs', prepack: 'node hook.cjs', postpack: 'node hook.cjs' } }
      write(join(directory, 'package.json'), manifest)
      writeFileSync(join(directory, 'index.js'), `export const version = ${JSON.stringify(release)};\n`)
      writeFileSync(join(directory, 'hook.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed')`)
      writeFileSync(join(directory, 'cordis.patch.yml'), '[]\n')
      const output = join(f.root, `packed-${name}-${release}`)
      mkdirSync(output)
      const archive = join(output, 'package.tgz')
      await packDesktopSourceDirectory(runtime, directory, archive, AbortSignal.timeout(60000))
      const bytes = readFileSync(archive)
      packages.set(`${name}@${release}`, { manifest, bytes, integrity: `sha512-${createHash('sha512').update(bytes).digest('base64')}` })
    }
    expect(existsSync(marker)).toBe(false)
    let registry = ''
    let stableTag = '1.0.0'
    const requests: string[] = []
    const server = createServer({ cert: LOOPBACK_TEST_TLS.certificate, key: LOOPBACK_TEST_TLS.intentionallyPublicLeafKey, minVersion: 'TLSv1.2' }, (request, response) => {
      requests.push(request.url ?? '')
      const name = ['retained-bundle', 'registry-bundle', 'plain-dependency'].find(value => request.url === `/${value}`)
      if (request.method !== 'GET') { response.writeHead(405); response.end(); return }
      if (name !== undefined) {
        const versions = Object.fromEntries([...packages.values()].filter(value => value.manifest.name === name)
          .map(value => [String(value.manifest.version), {
          ...value.manifest, dist: { integrity: value.integrity, tarball: `${registry}/${name}/-/${name}-${value.manifest.version}.tgz` },
        }]))
        response.setHeader('content-type', 'application/json')
        response.end(JSON.stringify({ name, 'dist-tags': { latest: name === 'registry-bundle' ? '1.1.0' : '1.0.0', stable: name === 'registry-bundle' ? stableTag : '1.0.0' }, versions,
          time: { created: '2020-01-01T00:00:00.000Z', modified: '2020-01-01T00:00:00.000Z', '1.0.0': '2020-01-01T00:00:00.000Z', '1.1.0': '2020-01-02T00:00:00.000Z' } }))
        return
      }
      const archive = [...packages.values()].find(value => request.url === `/${value.manifest.name}/-/${value.manifest.name}-${value.manifest.version}.tgz`)
      if (archive === undefined) { response.writeHead(404); response.end(); return }
      response.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': archive.bytes.length }); response.end(archive.bytes)
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('registry fixture has no port')
    registry = `https://127.0.0.1:${address.port}`
    try {
      writeFileSync(join(f.profile, 'pnpm-workspace.yaml'), "packages: ['.']\nnodeLinker: hoisted\nautoInstallPeers: false\n")
      const calls: DesktopStagingPnpmRequest[] = []
      const backend = createDesktopProfilePackageTransactions({ ...f.options, dependencyRegistry: `${registry}/`, operationTimeoutMs: 60000,
        pnpmRunner: async request => {
          calls.push(request)
          const result = await runDesktopPackagePnpm(runtime, { ...request, env: { ...request.env, NODE_EXTRA_CA_CERTS: caFile },
            args: request.args.some(argument => argument.startsWith('--cache-dir=')) ? request.args : [...request.args, `--cache-dir=${cache}`] })
          const add = request.args.indexOf('add')
          if (add !== -1 && request.args[add + 1]?.startsWith('registry-bundle@')) {
            const written = jsonObject(readFileSync(join(request.cwd, 'package.json'), 'utf8'))
            console.info('registry selector evidence', JSON.stringify({ requested: request.args[add + 1], saved: object(written, 'dependencies')['registry-bundle'] }))
          }
          return result
        } })
      const adopt = async (id: string) => {
        const input = (await backend.readPreparedForActivation(id))!
        renameSync(f.profile, input.rollbackDir); renameSync(input.candidateDir, f.profile)
        await backend.verifyActivationTree(id, 'active')
      }
      const first = randomUUID()
      const original = inventoryDesktopRuntime(f.profile)
      await backend.stage(first, { kind: 'install', source: { schemaVersion: 1, type: 'npmRegistry', spec: 'retained-bundle@1.0.0' } }, new AbortController().signal)
      expect(inventoryDesktopRuntime(f.profile)).toEqual(original)
      expect((await backend.readPreparedForActivation(first))!.registryTarget).toMatchObject({ packageName: 'retained-bundle', version: '1.0.0' })
      await adopt(first)
      const before = inventoryDesktopRuntime(f.profile)
      const beforeLock = load(readFileSync(join(f.profile, 'pnpm-lock.yaml'), 'utf8')) as { packages: Record<string, unknown>; snapshots: Record<string, unknown> }
      const ranged = randomUUID()
      await backend.stage(ranged, { kind: 'install', source: { schemaVersion: 1, type: 'packageSpec', spec: 'registry-bundle@^1.0.0' }, enabled: false }, new AbortController().signal)
      const rangedInput = (await backend.readPreparedForActivation(ranged))!
      expect(rangedInput.registryTarget).toMatchObject({ requestedSpec: 'registry-bundle@^1.0.0', version: '1.1.0', packageKey: 'registry-bundle@1.1.0', registry: `${registry}/`, integrity: packages.get('registry-bundle@1.1.0')!.integrity })
      expect(object(jsonObject(readFileSync(join(rangedInput.candidateDir, 'package.json'), 'utf8')), 'dependencies')['registry-bundle']).toBe('1.1.0')
      expect(rangedInput.verifiedRelease).toBeUndefined()
      expect(object(jsonObject(readFileSync(join(rangedInput.candidateDir, 'package.json'), 'utf8')), 'dsh', 'profile').bundles).toEqual(['retained-bundle'])
      const afterLock = load(readFileSync(join(rangedInput.candidateDir, 'pnpm-lock.yaml'), 'utf8')) as typeof beforeLock
      expect(afterLock.packages['retained-bundle@1.0.0']).toEqual(beforeLock.packages['retained-bundle@1.0.0'])
      expect(afterLock.snapshots['retained-bundle@1.0.0']).toEqual(beforeLock.snapshots['retained-bundle@1.0.0'])
      expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
      await adopt(ranged)
      const tagId = randomUUID()
      const tagRequest = { kind: 'install', source: { schemaVersion: 1, type: 'npmRegistry', spec: 'registry-bundle@stable' } } as const
      await backend.stage(tagId, tagRequest, new AbortController().signal)
      expect((await backend.readPreparedForActivation(tagId))!.registryTarget?.version).toBe('1.0.0')
      const callCount = calls.length
      stableTag = '1.1.0'
      await backend.stage(tagId, tagRequest, new AbortController().signal)
      expect(calls).toHaveLength(callCount)
      expect((await backend.readPreparedForActivation(tagId))!.registryTarget?.version).toBe('1.0.0')
      const moved = randomUUID()
      const metadataGets = requests.filter(path => path === '/registry-bundle').length
      await backend.stage(moved, tagRequest, new AbortController().signal)
      expect(requests.filter(path => path === '/registry-bundle').length).toBeGreaterThan(metadataGets)
      const movedInput = (await backend.readPreparedForActivation(moved))!
      expect(movedInput.registryTarget?.version).toBe('1.1.0')
      expect(object(jsonObject(readFileSync(join(movedInput.candidateDir, 'package.json'), 'utf8')), 'dsh', 'profile').bundles).toEqual(['retained-bundle'])
      const stableActive = inventoryDesktopRuntime(f.profile)
      await expect(backend.stage(randomUUID(), { kind: 'install', source: { schemaVersion: 1, type: 'npmRegistry', spec: 'plain-dependency@1.0.0' } }, new AbortController().signal)).rejects.toThrow('bundle')
      expect(inventoryDesktopRuntime(f.profile)).toEqual(stableActive)
      rmSync(join(f.profile, 'node_modules', 'registry-bundle'), { recursive: true })
      const damaged = inventoryDesktopRuntime(f.profile)
      const removal = randomUUID()
      await backend.stage(removal, { kind: 'remove', name: 'registry-bundle' }, new AbortController().signal)
      const removed = (await backend.readPreparedForActivation(removal))!
      expect(jsonObject(readFileSync(join(removed.candidateDir, 'package.json'), 'utf8')).dependencies).toEqual({ 'retained-bundle': '1.0.0' })
      expect(readDesktopPluginUserIntents(removed.candidateDir).removed['registry-bundle']).toEqual({})
      expect(inventoryDesktopRuntime(f.profile)).toEqual(damaged)
      expect(existsSync(marker)).toBe(false)
      expect(requests).toContain('/registry-bundle')
      for (const call of calls) { expect(call.args[0]).toBe('pm'); expect(call.args).toContain('--ignore-scripts'); expect(call.args).toContain(`--registry=${registry}/`) }
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
        server.closeAllConnections()
      })
    }
  })

  it.each(['ready', 'missing-cache', 'tampered-cache'] as const)('reconstructs a real offline transitive graph and checks relocation: %s', { timeout: 180000 }, async mode => {
    const step = async <T>(phase: string, operation: () => Promise<T>): Promise<T> => {
      try { return await operation() } catch (error) {
        throw new Error(`offline transitive fixture [${phase}]: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
      }
    }
    const f = fixture()
    const pnpm = process.env.DSH_TEST_DESKTOP_PNPM ?? join(import.meta.dirname, '../node_modules/pnpm/bin/pnpm.mjs')
    expect(jsonObject(readFileSync(join(dirname(dirname(pnpm)), 'package.json'), 'utf8')).version).toBe('11.7.0')
    const runtime = { node: process.execPath, nodeBin: dirname(process.execPath), pnpm }
    const home = join(f.root, 'graph-environment')
    mkdirSync(home)
    const caFile = join(home, 'NONPRODUCTION-loopback-ca.pem')
    writeFileSync(caFile, LOOPBACK_TEST_TLS.ca, { flag: 'wx', mode: 0o600 })
    expect(createHash('sha256').update(LOOPBACK_TEST_TLS.ca).digest('hex')).toBe(LOOPBACK_TEST_TLS.metadata.caCertificateSha256)
    expect(createHash('sha256').update(LOOPBACK_TEST_TLS.certificate).digest('hex')).toBe(LOOPBACK_TEST_TLS.metadata.serverCertificateSha256)
    expect(createHash('sha256').update(LOOPBACK_TEST_TLS.intentionallyPublicLeafKey).digest('hex')).toBe(LOOPBACK_TEST_TLS.metadata.intentionallyPublicLeafKeySha256)
    writeFileSync(join(home, 'user.npmrc'), ''); writeFileSync(join(home, 'global.npmrc'), '')
    const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home, PNPM_HOME: home,
      XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, XDG_STATE_HOME: home, CI: 'true', NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false',
      NODE_EXTRA_CA_CERTS: caFile,
      NPM_CONFIG_USERCONFIG: join(home, 'user.npmrc'), NPM_CONFIG_GLOBALCONFIG: join(home, 'global.npmrc') }
    for (const [key, value] of Object.entries(process.env)) {
      if (/^(PATH|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|TEMP|TMP)$/iu.test(key)) env[key] = value
    }
    const workspace = "packages: ['.']\nnodeLinker: hoisted\nautoInstallPeers: false\n"
    writeFileSync(join(f.profile, 'pnpm-workspace.yaml'), workspace)
    const names = ['offline-root', 'offline-leaf', 'offline-optional']
    const artifacts: Record<string, string> = {}
    const receipts: Record<string, ReturnType<typeof receipt>> = {}
    const manifests: Record<string, Record<string, unknown>> = {}
    const archives: Record<string, Buffer> = {}
    for (const name of names) {
      const source = join(f.root, `${name}-source`)
      write(join(source, 'package.json'), { name, version: '1.0.0', type: 'module', main: './index.js', files: ['index.js', 'cordis.patch.yml'],
        dsh: { bundle: { patch: './cordis.patch.yml' } },
        ...(name === 'offline-root' ? { dependencies: { 'offline-leaf': '^1.0.0' }, optionalDependencies: { 'offline-optional': '~1.0.0' } } : {}),
      })
      writeFileSync(join(source, 'index.js'), name === 'offline-root' ? 'export { value } from "offline-leaf"; export const root = true;\n' : 'export const value = 41;\n')
      writeFileSync(join(source, 'cordis.patch.yml'), '[]\n')
      const acquisition = join(f.root, `${name}-pack`)
      mkdirSync(acquisition)
      const archive = join(acquisition, 'package.tgz')
      await step(`pack ${name}`, () => packDesktopSourceDirectory(runtime, source, archive, AbortSignal.timeout(60000)))
      const bytes = readFileSync(archive)
      archives[name] = bytes
      manifests[name] = jsonObject(readFileSync(join(source, 'package.json'), 'utf8'))
      const evidence = receipt(name, bytes)
      receipts[name] = evidence
      const specifier = `file:.desktop-plugin-artifacts/${evidence.artifactSha256}.tgz`
      artifacts[name] = specifier
      mkdirSync(join(f.profile, '.desktop-plugin-artifacts'), { recursive: true })
      copyFileSync(archive, join(f.profile, specifier.slice(5)))
    }
    write(join(f.profile, 'package.json'), { private: true, dependencies: { 'offline-root': artifacts['offline-root'] }, dsh: { profile: { bundles: ['offline-root'] } } })
    write(join(f.profile, 'desktop-plugin-receipts.json'), { schemaVersion: 1, receipts: { 'offline-root': receipts['offline-root'] }, owners: { 'offline-root': 'release' } })
    const publicationTime = '2020-01-01T00:00:00.000Z'
    const tarPath = (name: string) => `/${name}/-/${name}-1.0.0.tgz`
    const metadata = (name: string, registry: string) => ({ name, 'dist-tags': { latest: '1.0.0' },
      time: { created: publicationTime, modified: publicationTime, '1.0.0': publicationTime },
      versions: { '1.0.0': { ...manifests[name], dist: { integrity: receipts[name]!.source.integrity, tarball: `${registry}${tarPath(name)}` } } } })
    let loopback = ''
    let allowArchiveRequests = true
    const requested: string[] = []
    const postSeedArchiveRequests: string[] = []
    const postSeedMetadataRequests: string[] = []
    const server = createServer({ cert: LOOPBACK_TEST_TLS.certificate, key: LOOPBACK_TEST_TLS.intentionallyPublicLeafKey, minVersion: 'TLSv1.2' }, (request, response) => {
      if (request.url === '/tls-check') { response.writeHead(200); response.end('fixture TLS verified'); return }
      requested.push(request.url ?? '')
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.writeHead(405); response.end(); return }
      const name = names.find(value => request.url === `/${value}` || request.url === tarPath(value))
      if (name === undefined) { response.writeHead(404); response.end(); return }
      const tarball = request.url === tarPath(name)
      if (!allowArchiveRequests) {
        if (tarball) {
          postSeedArchiveRequests.push(request.url ?? '')
          response.writeHead(410); response.end('fixture archive transport is disabled after seed'); return
        }
        postSeedMetadataRequests.push(request.url ?? '')
      }
      const body = tarball ? archives[name]! : Buffer.from(JSON.stringify(metadata(name, loopback)))
      response.writeHead(200, { 'content-type': tarball ? 'application/octet-stream' : 'application/json', 'content-length': body.length })
      response.end(request.method === 'HEAD' ? undefined : body)
    })
    await new Promise<void>(resolve => { server.listen(0, '127.0.0.1', resolve) })
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture registry has no loopback port')
    loopback = `https://127.0.0.1:${address.port}`
    try {
    const probeTls = async (trusted: boolean) => {
      const probeEnv = { ...env }
      if (!trusted) delete probeEnv.NODE_EXTRA_CA_CERTS
      const script = `try { const response = await fetch(${JSON.stringify(`${loopback}/tls-check`)}, { signal: AbortSignal.timeout(10000) }); await response.text(); console.log(response.status); } catch (error) { console.error(error.cause?.code ?? error.name); process.exitCode = 7; }`
      return new Promise<{ code: number | string | null; stdout: string; stderr: string }>(resolve => {
        execFile(process.execPath, ['--input-type=module', '-e', script], { env: probeEnv, encoding: 'utf8', timeout: 15000 },
          (error, stdout, stderr) => { resolve({ code: error === null ? 0 : error.code ?? 'unknown-process-failure', stdout, stderr }) })
      })
    }
    const withoutCa = await probeTls(false)
    expect(withoutCa.code).toBe(7)
    expect(withoutCa.stderr).toMatch(/UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY/u)
    const withCa = await probeTls(true)
    expect(withCa).toMatchObject({ code: 0, stdout: '200\n' })
    const registry = loopback
    for (const name of names) receipts[name] = parseDesktopPluginProvisionReceipt({ ...receipts[name], source: { ...receipts[name]!.source, dependencyRegistry: `${registry}/` } })
    write(join(f.profile, 'desktop-plugin-receipts.json'), { schemaVersion: 1, receipts: { 'offline-root': receipts['offline-root'] }, owners: { 'offline-root': 'release' } })
    const seedStore = join(f.root, 'seed-store')
    const seedCache = join(f.root, 'seed-cache')
    const common = ['--prod', '--ignore-scripts', '--ignore-pnpmfile', '--pm-on-fail=ignore', '--config.auto-install-peers=false', '--config.verify-store-integrity=true']
    const prefix = ['pm', `--config.userconfig=${join(home, 'user.npmrc')}`, `--config.globalconfig=${join(home, 'global.npmrc')}`]
    await step('actual HTTPS loopback registry seed', () => runDesktopPackagePnpm(runtime, { cwd: f.profile, env, signal: AbortSignal.timeout(60000), args: [
      ...prefix, 'install', '--no-frozen-lockfile', ...common, `--registry=${registry}/`, `--store-dir=${seedStore}`, `--cache-dir=${seedCache}`,
    ] }))
    allowArchiveRequests = false
    expect(requested).toContain('/offline-leaf')
    expect(requested).toContain(tarPath('offline-leaf'))
    // Actual pnpm generated these registry IDs, lockfile and SQLite/CAFS bytes under this same HTTPS origin.
    // No verdict cache is forged, no TLS policy is disabled, and no URI/source projection is used.
    // --offline constrains package bytes; pnpm11 policy metadata GETs remain permitted only to this owned loopback server.
    const prepareCache = (cache: string): void => {
      for (const flavor of ['metadata', 'metadata-full', 'metadata-full-filtered']) for (const name of ['offline-leaf', 'offline-optional']) {
        const file = join(cache, 'v11', flavor, new URL(registry).host.replace(':', '+'), `${name}.jsonl`)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, `${JSON.stringify({ modified: publicationTime })}\n${JSON.stringify(metadata(name, registry))}`)
      }
    }
    const populated = new Set<string>([seedStore])
    const storageFacts = (directory: string) => {
      let files = 0
      let bytes = 0
      const indexes: Array<{ path: string; bytes: number; keys?: string[]; error?: string }> = []
      const visit = (path: string): void => {
        if (!existsSync(path)) return
        for (const entry of readdirSync(path, { withFileTypes: true })) {
          const child = join(path, entry.name)
          if (entry.isSymbolicLink()) continue
          if (entry.isDirectory()) visit(child)
          else if (entry.isFile()) {
            const size = fs.statSync(child).size
            files++; bytes += size
            if (entry.name === 'index.db') {
              const index: typeof indexes[number] = { path: child.slice(directory.length), bytes: size }
              let database: DatabaseSync | undefined
              try {
                database = new DatabaseSync(child, { readOnly: true })
                index.keys = database.prepare('SELECT key FROM package_index ORDER BY key LIMIT 12').all().map(row => String(row.key))
              } catch (error) { index.error = (error instanceof Error ? error.message : String(error)).slice(0, 256) }
              finally { database?.close() }
              indexes.push(index)
            }
          }
        }
      }
      visit(directory)
      return { files, bytes, indexes }
    }
    const runOffline = async (request: DesktopStagingPnpmRequest, phase: string, damage = false) => {
      const store = request.args.find(argument => argument.startsWith('--store-dir='))?.slice('--store-dir='.length)
      if (store === undefined || !store.startsWith(f.root)) throw new Error('fixture store escapes owned temporary directory')
      if (!populated.has(store)) {
        // Copy the entire quiescent private store, including SQLite sidecars and CAFS; never copy a live database or only its index.
        if (damage && mode === 'missing-cache') mkdirSync(store, { recursive: true })
        else cpSync(seedStore, store, { recursive: true })
        populated.add(store)
        if (damage && mode === 'tampered-cache') {
          let changed = false
          const visit = (directory: string): void => {
            for (const entry of readdirSync(directory, { withFileTypes: true })) {
              const path = join(directory, entry.name)
              if (entry.isSymbolicLink()) continue
              if (entry.isDirectory()) visit(path)
              else if (entry.isFile() && readFileSync(path).equals(Buffer.from('export const value = 41;\n'))) {
                writeFileSync(path, 'tampered cached fixture bytes\n'); changed = true
              }
            }
          }
          visit(store)
          expect(changed).toBe(true)
        }
      }
      const cache = join(String(request.env.HOME), 'offline-registry-cache')
      if (!cache.startsWith(f.root)) throw new Error('fixture metadata cache escapes its owned directory')
      prepareCache(cache)
      const args = [...request.args, '--offline', '--config.verify-store-integrity=true', `--cache-dir=${cache}`]
      const modulesFile = join(request.cwd, 'node_modules', '.modules.yaml')
      const modules = existsSync(modulesFile) ? load(readFileSync(modulesFile, 'utf8')) as Record<string, unknown> : undefined
      const facts = { policyMetadataServerListening: server.listening, archiveTransportEnabled: allowArchiveRequests,
        seedStore: storageFacts(seedStore), store: storageFacts(store), cache: storageFacts(cache),
        cwd: request.cwd, args, included: modules?.included, registries: modules?.registries, modulesStoreDir: modules?.storeDir }
      return step(phase, async () => {
        try {
          return await runDesktopPackagePnpm(runtime, { ...request, env: { ...request.env, CI: 'true', NO_UPDATE_NOTIFIER: '1', npm_config_update_notifier: 'false', NODE_EXTRA_CA_CERTS: caFile }, args })
        } catch (error) {
          throw new Error(`${error instanceof Error ? error.message : String(error)}\nOwned fixture facts: ${JSON.stringify(facts)}`, { cause: error })
        }
      })
    }
    const frozenArgs = [...prefix, 'install', '--frozen-lockfile', ...common, `--registry=${registry}/`]
    await runOffline({ cwd: f.profile, env, signal: AbortSignal.timeout(60000), args: [...frozenArgs, `--store-dir=${seedStore}`] }, 'initial offline frozen reconstruction')
    const initial = load(readFileSync(join(f.profile, 'pnpm-lock.yaml'), 'utf8')) as { packages: Record<string, unknown>; snapshots: Record<string, unknown> }
    const before = inventoryDesktopRuntime(f.profile)
    write(join(f.source, 'package.json'), { name: pluginName, version: '1.0.0', type: 'module', main: './index.js', files: ['index.js', 'cordis.patch.yml'], dsh: { bundle: { patch: './cordis.patch.yml' } } })
    writeFileSync(join(f.source, 'index.js'), 'export const fresh = 42;\n')
    const calls: DesktopStagingPnpmRequest[] = []
    const backend = createDesktopProfilePackageTransactions({ ...f.options, dependencyRegistry: `${registry}/`, operationTimeoutMs: 60000,
      pnpmRunner: request => {
        calls.push(request)
        return runOffline(request, request.args.includes('add') ? 'staged incremental add' : 'staged frozen reconstruction', true)
      },
      packDirectory: (directory, archive, signal) => step('new source pack', () => packDesktopSourceDirectory(runtime, directory, archive, signal)) })
    const id = randomUUID()
    const staged = backend.stage(id, f.mutation, new AbortController().signal)
    if (mode !== 'ready') {
      await expect(staged).rejects.toThrow(/staged frozen reconstruction[\s\S]*(?:offline|integrity|store)/iu)
      expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
      expect(await backend.status(id)).toBeUndefined()
      return
    }
    expect(await staged).toMatchObject({ state: 'prepared', health: 'pending' })
    expect(inventoryDesktopRuntime(f.profile)).toEqual(before)
    const input = (await backend.readPreparedForActivation(id))!
    const candidateLock = load(readFileSync(join(input.candidateDir, 'pnpm-lock.yaml'), 'utf8')) as typeof initial
    for (const [key, value] of Object.entries(initial.packages)) expect(candidateLock.packages[key]).toEqual(value)
    for (const [key, value] of Object.entries(initial.snapshots)) expect(candidateLock.snapshots[key]).toEqual(value)
    // Move only the disposable test profile. Neither the staging engine nor this test touches any running application.
    renameSync(f.profile, input.rollbackDir); renameSync(input.candidateDir, f.profile)
    expect(await backend.verifyActivationTree(id, 'active')).toMatchObject({ prepared: input.prepared })
    const rootUrl = pathToFileURL(join(f.profile, 'node_modules', 'offline-root', 'index.js')).href
    const freshUrl = pathToFileURL(join(f.profile, 'node_modules', pluginName, 'index.js')).href
    const output = execFileSync(process.execPath, ['--input-type=module', '-e',
      `const a = await import(${JSON.stringify(rootUrl)}); const b = await import(${JSON.stringify(freshUrl)}); console.log(JSON.stringify([a.value, b.fresh]));`],
    { env, encoding: 'utf8', timeout: 30000 })
    const observed: unknown = JSON.parse(output.trim())
    expect(observed).toEqual([41, 42])
    const stageStore = calls[0]!.args.find(argument => argument.startsWith('--store-dir='))!
    await runOffline({ cwd: f.profile, env, signal: AbortSignal.timeout(60000), args: [...frozenArgs, stageStore] }, 'final-location frozen install')
    expect(load(readFileSync(join(f.profile, 'pnpm-lock.yaml'), 'utf8'))).toEqual(candidateLock)
    expect(postSeedMetadataRequests.length).toBeGreaterThan(0)
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => { if (error) reject(error); else resolve() })
        server.closeAllConnections()
      })
      expect(postSeedArchiveRequests).toEqual([])
    }
  })

  it('refuses to re-resolve unrelated retained dependency ranges', async () => {
    const f = fixture()
    write(join(f.profile, 'package.json'), { dependencies: { unrelated: '^1.0.0' }, dsh: { profile: { bundles: [] } } })
    writeFileSync(join(f.profile, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# retained exact graph\n')
    const before = f.active()
    await expect(f.backend.stage(randomUUID(), f.mutation, new AbortController().signal)).rejects.toThrow('single-profile pnpm v9 lock')
    expect(f.pnpmRunner).not.toHaveBeenCalled()
    expect(readFileSync(join(f.profile, 'pnpm-lock.yaml'), 'utf8')).toContain('retained exact graph')
    expect(f.active()).toEqual(before)
  })

  it('keeps nested node_modules metadata rather than confusing it with the active root graph', async () => {
    const f = fixture()
    const nested = 'custom-data/node_modules/user.json'
    write(join(f.profile, nested), { preserve: true })
    const id = randomUUID()
    await f.backend.stage(id, f.mutation, new AbortController().signal)
    expect(readFileSync(join(f.transaction(id), 'profile', nested), 'utf8')).toBe(readFileSync(join(f.profile, nested), 'utf8'))
  })

  it('binds known-absent external patches and refuses activation when one appears', async () => {
    const f = fixture()
    const globalPatch = join(f.root, 'global.patch.yml')
    const backend = createDesktopProfilePackageTransactions({ ...f.options, configPaths: [globalPatch] })
    const id = randomUUID()
    await backend.stage(id, f.mutation, new AbortController().signal)
    writeFileSync(globalPatch, '[]\n')
    await expect(withProfilePackageLease(f.profile, () => backend.readPreparedForActivation(id))).rejects.toThrow('base no longer matches')
  })

  it('checks runtime file bytes even when the descriptor and package metadata are unchanged', async () => {
    const f = fixture()
    const id = randomUUID()
    await f.backend.stage(id, f.mutation, new AbortController().signal)
    writeFileSync(join(f.runtimeDir, 'runtime.js'), 'export const changed = true\n')
    await expect(f.backend.status(id)).rejects.toThrow('runtime file inventory changed')
  })

  it('does not hide runner failure behind a cancellation acknowledgement', async () => {
    const entered = deferred<undefined>()
    const release = deferred<undefined>()
    const failure = new Error('runner failed to quiesce cleanly')
    const f = fixture({ pnpmRunner: async () => { entered.resolve(undefined); await release.promise; throw failure } })
    const id = randomUUID()
    const stage = f.backend.stage(id, f.mutation, new AbortController().signal).catch((error: unknown) => error)
    await entered.promise
    const cancel = f.backend.cancel(id)
    const observed = cancel.catch((error: unknown) => error)
    release.resolve(undefined)
    expect(await stage).toBe(failure)
    expect(await observed).toBe(failure)
  })

  it('keeps active metadata when pnpm fails or times out with exit zero', async () => {
    for (const output of [{ exitCode: 1 }, { exitCode: 0, timedOut: true }]) {
      const f = fixture({ pnpmRunner: async () => output })
      const before = f.active()
      const id = randomUUID()
      await expect(f.backend.stage(id, f.mutation, new AbortController().signal)).rejects.toThrow('pnpm graph preparation')
      expect(existsSync(f.transaction(id))).toBe(false)
      expect(f.active()).toEqual(before)
    }
  })

  it('does not acknowledge cancellation until the injected pnpm runner has quiesced', async () => {
    const entered = deferred<AbortSignal>()
    const release = deferred<undefined>()
    const f = fixture({ pnpmRunner: async request => { entered.resolve(request.signal); await release.promise; return { exitCode: 0 } } })
    const id = randomUUID()
    const stage = f.backend.stage(id, f.mutation, new AbortController().signal)
    const observed = stage.catch((error: unknown) => error)
    const signal = await entered.promise
    let acknowledged = false
    const cancellation = f.backend.cancel(id).then(() => { acknowledged = true })
    await Promise.resolve()
    expect(signal.aborted).toBe(true)
    expect(acknowledged).toBe(false)
    expect(existsSync(f.transaction(id))).toBe(true)
    release.resolve(undefined)
    expect(await observed).toBeInstanceOf(Error)
    await cancellation
    expect(existsSync(f.transaction(id))).toBe(false)
    expect(await f.backend.status(id)).toBeUndefined()
  })

  it('cancels acquisition and does not enter pnpm after the packer stops', async () => {
    const entered = deferred<AbortSignal>()
    const release = deferred<undefined>()
    const f = fixture({ packDirectory: async (_directory, _archive, signal) => {
      entered.resolve(signal); await release.promise; signal.throwIfAborted()
    } })
    const abort = new AbortController()
    const id = randomUUID()
    const stage = f.backend.stage(id, f.mutation, abort.signal).catch((error: unknown) => error)
    await entered.promise
    abort.abort(new Error('acquisition cancelled'))
    release.resolve(undefined)
    expect(await stage).toBeInstanceOf(Error)
    expect(f.pnpmRunner).not.toHaveBeenCalled()
    expect(existsSync(f.transaction(id))).toBe(false)
  })

  it('observes cancellation while waiting for the shared profile lease before writing staging files', async () => {
    const f = fixture()
    const entered = deferred<undefined>()
    const release = deferred<undefined>()
    const lease = withProfilePackageLease(f.profile, async () => { entered.resolve(undefined); await release.promise })
    await entered.promise
    const abort = new AbortController()
    const id = randomUUID()
    const stage = f.backend.stage(id, f.mutation, abort.signal).catch((error: unknown) => error)
    abort.abort(new Error('lease wait cancelled'))
    expect(existsSync(f.transaction(id))).toBe(false)
    release.resolve(undefined)
    await lease
    expect(await stage).toBeInstanceOf(Error)
    expect(f.packDirectory).not.toHaveBeenCalled()
  })

  it('refuses PREPARED if live approvals changed before commit', async () => {
    const f = fixture()
    const runner = f.options.pnpmRunner
    const backend = createDesktopProfilePackageTransactions({ ...f.options, pnpmRunner: async request => {
      const output = await runner(request)
      writeFileSync(join(f.profile, 'pnpm-workspace.yaml'), 'allowBuilds: {}\n')
      return output
    } })
    const id = randomUUID()
    await expect(backend.stage(id, f.mutation, new AbortController().signal)).rejects.toThrow('active profile changed')
    expect(existsSync(f.transaction(id))).toBe(false)
  })

  it('rejects a tampered candidate and a foreign runtime descriptor on recovery', async () => {
    const f = fixture()
    const id = randomUUID()
    await f.backend.stage(id, f.mutation, new AbortController().signal)
    writeFileSync(join(f.transaction(id), 'profile', 'cordis.patch.yml'), '[changed]\n')
    await expect(f.backend.status(id)).rejects.toThrow('prepared files changed')
    writeFileSync(join(f.runtimeDir, 'desktop-runtime.json'), '{}\n')
    await expect(f.backend.status(id)).rejects.toThrow('identity changed')
  })

  it('refuses symlink profiles, local input links and foreign transaction directories', async () => {
    const f = fixture()
    const alias = join(f.root, 'profile-alias')
    symlinkSync(f.profile, alias, 'junction')
    expect(() => createDesktopProfilePackageTransactions({ ...f.options, profile: alias })).toThrow('symlink')
    const inputAlias = join(f.root, 'source-alias')
    symlinkSync(f.source, inputAlias, 'junction')
    await expect(f.backend.stage(randomUUID(), { ...f.mutation, source: { ...f.mutation.source, spec: inputAlias } }, new AbortController().signal)).rejects.toThrow('symlink')
    const id = randomUUID()
    mkdirSync(f.transaction(id))
    write(join(f.transaction(id), 'owner.json'), { foreign: true })
    await expect(f.backend.status(id)).rejects.toThrow('foreign transaction owner')
    expect(readdirSync(f.transaction(id))).toEqual(['owner.json'])
  })
})
