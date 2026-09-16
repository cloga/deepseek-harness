import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createDesktopForkReleaseCapability,
  finalizeDesktopForkRelease,
  parseDesktopForkReleasePlan,
} from '../scripts/fork-release.ts'
import {
  managedUpdateJsonSha256,
  parseDesktopManagedUpdateManifest,
} from '../src/managed-update-protocol.ts'
import {
  desktopPluginProvisioningPlanSha256,
  parseDesktopPluginProvisioningPlan,
} from '../src/plugin-provisioning.ts'

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    copyFileSync: vi.fn(actual.copyFileSync),
    writeFileSync: vi.fn(actual.writeFileSync),
  }
})

const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..')
const planPath = join(repositoryRoot, 'apps', 'desktop', 'release', 'cloga-windows-x64.json')
const processDescriptors = Object.getOwnPropertyDescriptors(process)
let root: string

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, undefined, 2)}\n`)
}

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fixture() {
  const plan = parseDesktopForkReleasePlan(readJson(planPath))
  const capability = createDesktopForkReleaseCapability(plan)
  const artifacts = join(root, 'artifacts')
  const output = join(root, 'output')
  const resources = join(artifacts, 'win-unpacked', 'resources')
  const capabilityPath = join(root, 'capability.json')
  const provisioningPath = join(root, 'provisioning.json')
  const packagedCapability = join(resources, 'managed-update', 'capability.json')
  const packagedProvisioning = join(resources, 'desktop-provisioning', 'plan.json')
  writeJson(capabilityPath, capability)
  writeJson(packagedCapability, capability)
  writeJson(provisioningPath, plan.desktopProvisioning)
  writeJson(packagedProvisioning, plan.desktopProvisioning)
  writeFileSync(join(resources, 'managed-update', 'helper.mjs'), 'export const standalone = true\n')
  writeJson(join(resources, 'dsh', 'desktop-runtime.json'), { fixture: true })
  writeFileSync(join(artifacts, 'win-unpacked', `${plan.identity.executableName}.exe`), 'fixture executable')
  writeFileSync(join(artifacts, `cloga-deepseek-harness-${plan.version}-win-x64.exe`), 'fixture installer')
  return {
    plan, capability, capabilityPath, provisioningPath, packagedCapability, packagedProvisioning, artifacts, output,
    finalize: () => { finalizeDesktopForkRelease(plan, capabilityPath, provisioningPath, artifacts, output) },
  }
}

function otherProvisioning() {
  return parseDesktopPluginProvisioningPlan({
    schemaVersion: 1,
    mode: 'exact',
    plugins: [{
      required: true,
      source: {
        schemaVersion: 1,
        type: 'githubRelease',
        owner: 'example',
        repo: 'plugin',
        tag: 'v1.0.0',
        asset: 'plugin-1.0.0.tgz',
        assetId: 2,
        packageName: 'plugin',
        version: '1.0.0',
        size: 123,
        sha256: 'a'.repeat(64),
        integrity: `sha512-${Buffer.alloc(64, 1).toString('base64')}`,
        targetCommit: 'b'.repeat(40),
        checksumManifest: {
          format: 'sha256sums',
          asset: 'SHA256SUMS',
          assetId: 3,
          url: 'https://github.com/example/plugin/releases/download/v1.0.0/SHA256SUMS',
          size: 42,
          sha256: 'c'.repeat(64),
          integrity: `sha512-${Buffer.alloc(64, 2).toString('base64')}`,
        },
      },
    }],
  })
}

beforeEach(() => {
  root = mkdtempSync(join(repositoryRoot, '.fork-release-test-'))
  Object.defineProperties(process, {
    version: { ...processDescriptors.version, value: 'v24.13.0' },
    platform: { ...processDescriptors.platform, value: 'win32' },
  })
  vi.mocked(copyFileSync).mockImplementation(realFs.copyFileSync)
  vi.mocked(writeFileSync).mockImplementation(realFs.writeFileSync)
  // Only host attestations are simulated; finalization reads and writes real, private fixture files.
  vi.mocked(execFileSync).mockImplementation((file, args) => {
    if (file === 'git') {
      if (args?.[0] === 'status') return ''
      if (args?.[1] === 'HEAD') return 'a'.repeat(40)
      if (args?.[1] === 'HEAD^{tree}') return 'b'.repeat(40)
    }
    if (args?.includes('--version') || args?.includes('pnpm --version')) return '11.7.0'
    if (file.endsWith('powershell.exe')) return 'NotSigned'
    throw new Error(`Unexpected subprocess: ${file} ${args?.join(' ')}`)
  })
})

afterEach(() => {
  Object.defineProperties(process, {
    version: processDescriptors.version,
    platform: processDescriptors.platform,
  })
  vi.resetAllMocks()
  rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
})

describe('Desktop fork release finalization identities', () => {
  it.each(['import "semver";', 'export { value } from "./chunk.mjs";'])(
    'rejects packaged external dependencies before release finalization: %s', (source) => {
      const f = fixture()
      writeFileSync(join(dirname(f.packagedCapability), 'helper.mjs'), source)
      expect(f.finalize).toThrow(/nonbuiltin external/u)
      expect(existsSync(f.output)).toBe(false)
    },
  )
  it('binds the published plan and receipt hashes to the packaged bytes', () => {
    const f = fixture()
    writeFileSync(f.packagedProvisioning, JSON.stringify(f.plan.desktopProvisioning))
    f.finalize()
    const publishedProvisioning = join(f.output, 'desktop-provisioning.json')
    expect(readFileSync(publishedProvisioning)).toEqual(readFileSync(f.packagedProvisioning))
    const receiptPath = join(f.output, 'build-receipt.json')
    const receipt = readJson(receiptPath)
    const { receiptSha256, ...payload } = receipt
    expect(receiptSha256).toBe(managedUpdateJsonSha256(payload))
    expect(receipt.artifacts).toMatchObject({
      capabilitySha256: hash(f.packagedCapability),
      provisioning: {
        sha256: hash(f.packagedProvisioning),
        planSha256: desktopPluginProvisioningPlanSha256(f.plan.desktopProvisioning),
      },
    })
    expect(receipt.pluginCompatibility).toMatchObject({
      provisioning: { planSha256: desktopPluginProvisioningPlanSha256(f.plan.desktopProvisioning) },
    })
    const manifest = parseDesktopManagedUpdateManifest(
      readJson(join(f.output, 'release.json')), f.capability, 0, true,
    )
    expect(manifest.buildReceipt).toMatchObject({ sha256: hash(receiptPath), receiptSha256 })
    for (const name of ['desktop-provisioning.json', 'build-receipt.json', 'release.json']) {
      expect(readFileSync(join(f.output, 'SHA256SUMS'), 'utf8')).toContain(`${hash(join(f.output, name))}  ${name}\n`)
    }
  })

  it('rejects a supplied release plan that differs from the source plan being attested', () => {
    const f = fixture()
    const plan = { ...f.plan, sequence: f.plan.sequence + 1 }
    writeJson(f.capabilityPath, createDesktopForkReleaseCapability(plan))
    writeJson(f.packagedCapability, createDesktopForkReleaseCapability(plan))
    expect(() => {
      finalizeDesktopForkRelease(plan, f.capabilityPath, f.provisioningPath, f.artifacts, f.output)
    }).toThrow(/reviewed.*plan|plan.*reviewed/u)
    expect(existsSync(f.output)).toBe(false)
  })

  it.each(['sequence', 'provisioning hash', 'migration'] as const)(
    'rejects matching input and packaged capabilities with an unreviewed %s',
    (field) => {
      const f = fixture()
      const capability = {
        ...f.capability,
        ...(field === 'sequence' ? { currentSequence: f.plan.sequence + 1 } : {}),
        ...(field === 'provisioning hash'
          ? { provisioning: { ...f.capability.provisioning, planSha256: 'f'.repeat(64) } }
          : {}),
        ...(field === 'migration'
          ? { migration: { ...f.capability.migration, assetSha256: 'f'.repeat(64) } }
          : {}),
      }
      writeJson(f.capabilityPath, capability)
      writeJson(f.packagedCapability, capability)
      expect(f.finalize).toThrow(/capability.*reviewed/u)
      expect(existsSync(f.output)).toBe(false)
    },
  )

  it('rejects matching input and packaged provisioning that differs from the reviewed inventory', () => {
    const f = fixture()
    writeJson(f.provisioningPath, otherProvisioning())
    writeJson(f.packagedProvisioning, otherProvisioning())
    expect(f.finalize).toThrow(/provisioning.*reviewed/u)
    expect(existsSync(f.output)).toBe(false)
  })

  it('rejects a self-consistent unreviewed capability and provisioning inventory', () => {
    const f = fixture()
    const provisioning = otherProvisioning()
    const capability = {
      ...f.capability,
      provisioning: {
        ...f.capability.provisioning,
        planSha256: desktopPluginProvisioningPlanSha256(provisioning),
      },
    }
    writeJson(f.capabilityPath, capability)
    writeJson(f.packagedCapability, capability)
    writeJson(f.provisioningPath, provisioning)
    writeJson(f.packagedProvisioning, provisioning)
    expect(f.finalize).toThrow(/reviewed/u)
    expect(existsSync(f.output)).toBe(false)
  })

  it.each(['capability', 'provisioning'] as const)('rejects a changed packaged %s', (kind) => {
    const f = fixture()
    if (kind === 'capability') {
      writeJson(f.packagedCapability, { ...f.capability, currentSequence: f.plan.sequence + 1 })
    } else {
      writeJson(f.packagedProvisioning, otherProvisioning())
    }
    expect(f.finalize).toThrow(/packaged.*does not match/u)
    expect(existsSync(f.output)).toBe(false)
  })

  it.each(['installer', 'provisioning'] as const)('rejects changed published %s bytes', (kind) => {
    const f = fixture()
    vi.mocked(copyFileSync).mockImplementation((source, destination, flags) => {
      realFs.copyFileSync(source, destination, flags)
      if ((kind === 'installer' && String(destination).endsWith('.exe'))
        || (kind === 'provisioning' && basename(String(destination)) === 'desktop-provisioning.json')) {
        realFs.writeFileSync(destination, kind === 'installer' ? 'different installer' : JSON.stringify(otherProvisioning()))
      }
    })
    expect(f.finalize).toThrow(/published.*does not match/u)
    expect(existsSync(join(f.output, 'SHA256SUMS'))).toBe(false)
  })

  it.each(['capabilitySha256', 'provisioning', 'pluginCompatibility', 'source', 'buildInputs'] as const)(
    'rejects a rewritten receipt %s even with a matching receipt self-hash',
    (field) => {
      const f = fixture()
      vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
        realFs.writeFileSync(path, data, options)
        if (basename(String(path)) !== 'build-receipt.json') return
        const { receiptSha256: _receiptSha256, ...payload } = readJson(String(path))
        if (field === 'capabilitySha256' || field === 'provisioning') {
          payload.artifacts = {
            ...(payload.artifacts as Record<string, unknown>),
            [field]: field === 'capabilitySha256' ? 'f'.repeat(64) : {
              file: 'desktop-provisioning.json', sha256: 'f'.repeat(64), planSha256: 'f'.repeat(64),
            },
          }
        } else {
          payload[field] = { changed: true }
        }
        realFs.writeFileSync(path, JSON.stringify({ ...payload, receiptSha256: managedUpdateJsonSha256(payload) }))
      })
      expect(f.finalize).toThrow(/receipt.*does not match/u)
      expect(existsSync(join(f.output, 'SHA256SUMS'))).toBe(false)
    },
  )

  it.each([
    'packaged installer', 'packaged provisioning', 'packaged capability', 'packaged helper',
    'packaged executable', 'packaged runtime', 'published installer', 'published provisioning', 'published manifest',
  ] as const)('rejects a changed %s after the receipt was written', (target) => {
    const f = fixture()
    const installer = `cloga-deepseek-harness-${f.plan.version}-win-x64.exe`
    const unpacked = join(f.artifacts, 'win-unpacked')
    const paths = {
      'packaged installer': join(f.artifacts, installer),
      'packaged provisioning': f.packagedProvisioning,
      'packaged capability': f.packagedCapability,
      'packaged helper': join(unpacked, 'resources', 'managed-update', 'helper.mjs'),
      'packaged executable': join(unpacked, `${f.plan.identity.executableName}.exe`),
      'packaged runtime': join(unpacked, 'resources', 'dsh', 'desktop-runtime.json'),
      'published installer': join(f.output, installer),
      'published provisioning': join(f.output, 'desktop-provisioning.json'),
      'published manifest': join(f.output, 'release.json'),
    }
    vi.mocked(writeFileSync).mockImplementation((path, data, options) => {
      realFs.writeFileSync(path, data, options)
      if (basename(String(path)) === 'release.json') realFs.writeFileSync(paths[target], 'changed after receipt')
    })
    expect(f.finalize).toThrow(new RegExp(`${target}.*does not match`, 'u'))
    expect(existsSync(join(f.output, 'SHA256SUMS'))).toBe(false)
  })
})
