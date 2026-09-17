import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import {
  createDesktopForkReleaseCapability,
  parseDesktopForkReleasePlan,
} from '../scripts/fork-release.ts'

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..')
const planPath = resolve(import.meta.dirname, '..', 'release', 'cloga-windows-x64.json')

function planValue(): unknown {
  return JSON.parse(readFileSync(planPath, 'utf8'))
}

describe('Desktop fork release plan', () => {
  it('defines a monotonic source-owned release after the Windows Ops bridge', () => {
    const plan = parseDesktopForkReleasePlan(planValue())
    expect(plan).toMatchObject({
      schemaVersion: 2,
      channel: 'cloga-windows-x64',
      version: '0.1.5-rc.3.cloga.7',
      sequence: 8,
      upstreamVersion: '0.1.5-rc.2',
      migration: {
        owner: 'cloga/dsh-windows-ops',
        maximumSequence: 1,
        channelVersion: '0.1.5-rc.2.local.1',
      },
    })
    expect(plan.desktopProvisioning).toEqual({
      schemaVersion: 1,
      mode: 'exact',
      plugins: [{
        required: true,
        source: {
          schemaVersion: 1,
          type: 'githubRelease',
          owner: 'cloga',
          repo: 'dsh-github-copilot',
          tag: 'v0.4.0-alpha.22',
          asset: 'dsh-github-copilot-0.4.0-alpha.22.tgz',
          assetId: 567596250,
          packageName: 'dsh-github-copilot',
          version: '0.4.0-alpha.22',
          size: 651444,
          sha256: 'e749d982ac55752eeca4cf4819b9751144cda1c2dc06033e4b42240151e40e0e',
          integrity: 'sha512-HkGACgfUrTREbtbUgZJ6Sb02hqKseCtldW16ZBounQZahTpeKWW5bqj5TNb1MD6X7y4e5MI0Q5edYLCF71ybnQ==',
          targetCommit: '479340f965c5be7b4408e4f1e6c9dda6c421d37b',
          dependencyRegistry: 'https://packagefeedproxy.microsoft.io/npm/',
          checksumManifest: {
            format: 'sha256sums',
            asset: 'SHA256SUMS',
            assetId: 567596283,
            url: 'https://github.com/cloga/dsh-github-copilot/releases/download/v0.4.0-alpha.22/SHA256SUMS',
            size: 104,
            sha256: 'cdc2a7e8df955c9136c6c79c25adaaf929bee815308ff3ceb6c9cfb948c03546',
            integrity: 'sha512-Q6hlYjOSZU397FlT180MK8NgkEdDct20KPEpk7q1PB19Y1HkpiTweqFenptizstFrCm6u0fTl6gDEK3mEGMD/Q==',
          },
        },
      }],
    })
    expect(createDesktopForkReleaseCapability(plan)).toMatchObject({
      schemaVersion: 3,
      mode: 'github-release-managed',
      owner: 'cloga/deepseek-harness',
      tagPrefix: 'dsh-desktop-v',
      currentSequence: 8,
      minimumSequence: 2,
      provisioning: {
        capability: { id: 'desktopNativePluginProvisioning' },
      },
    })
  })

  it('normalizes the version-neutral schema 1 plan to an empty provisioning inventory', () => {
    const plan = planValue() as Record<string, unknown>
    const { desktopProvisioning: _desktopProvisioning, ...legacy } = plan
    expect(parseDesktopForkReleasePlan({ ...legacy, schemaVersion: 1 })).toMatchObject({
      schemaVersion: 2,
      desktopProvisioning: { schemaVersion: 1, mode: 'exact', plugins: [] },
    })
  })

  it('rejects unsupported fields in the schema 2 plan', () => {
    const plan = planValue() as Record<string, unknown>
    expect(() => parseDesktopForkReleasePlan({ ...plan, unexpected: true })).toThrow(/unsupported fields/u)
  })

  it('rejects a fork version or sequence that does not advance the bridge', () => {
    const plan = planValue() as Record<string, unknown>
    expect(() => parseDesktopForkReleasePlan({
      ...plan,
      version: '0.1.5-rc.2.cloga.1',
    })).toThrow(/advance/u)
    expect(() => parseDesktopForkReleasePlan({
      ...plan,
      sequence: 1,
    })).toThrow(/advance/u)
  })

  it('keeps write permission in the reviewed release job and pins build tools', () => {
    const workflow = load(readFileSync(
      resolve(repositoryRoot, '.github', 'workflows', 'desktop-fork-release.yml'),
      'utf8',
    )) as {
      permissions: Record<string, string>
      env: Record<string, string>
      jobs: Record<string, {
        permissions?: Record<string, string>
        environment?: string
        steps?: Array<{ name?: string; run?: string; env?: Record<string, string> }>
      }>
    }
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.env).toMatchObject({
      NODE_VERSION: '24.13.0',
      PNPM_VERSION: '11.7.0',
    })
    expect(workflow.jobs.build?.permissions).toBeUndefined()
    expect(workflow.jobs.release).toMatchObject({
      environment: 'desktop-fork-release',
      permissions: {
        actions: 'read',
        contents: 'write',
      },
    })
    expect(workflow.jobs['remote-check']?.permissions).toEqual({ contents: 'read' })
    const steps = workflow.jobs.build?.steps ?? []
    const install = steps.findIndex(step => step.name === 'Install from frozen lockfile')
    const browser = steps.findIndex(step => step.name === 'Prepare browser for isolated Desktop acceptance')
    const packaging = steps.findIndex(step => step.name === 'Build unsigned interactive NSIS installer')
    expect(install).toBeGreaterThanOrEqual(0)
    expect(browser).toBeGreaterThan(install)
    expect(packaging).toBeGreaterThan(browser)
    expect(steps[browser]).toMatchObject({
      run: 'node apps/desktop/node_modules/playwright/cli.js install chromium',
      env: { PLAYWRIGHT_BROWSERS_PATH: '${{ runner.temp }}/desktop-playwright' },
    })
    expect(steps[packaging]?.env?.PLAYWRIGHT_BROWSERS_PATH).toBe(steps[browser]?.env?.PLAYWRIGHT_BROWSERS_PATH)
  })
})
