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
      version: '0.1.6-alpha.1.cloga.1',
      sequence: 3,
      upstreamVersion: '0.1.6-alpha.1',
      migration: {
        owner: 'cloga/dsh-windows-ops',
        maximumSequence: 1,
        channelVersion: '0.1.5-rc.2.local.1',
      },
      desktopProvisioning: {
        schemaVersion: 1,
        mode: 'exact',
        plugins: [{
          required: true,
          source: {
            schemaVersion: 1,
            type: 'githubRelease',
            owner: 'cloga',
            repo: 'dsh-github-copilot',
            tag: 'v0.4.0-alpha.19',
            asset: 'dsh-github-copilot-0.4.0-alpha.19.tgz',
            assetId: 566022628,
            packageName: 'dsh-github-copilot',
            version: '0.4.0-alpha.19',
            size: 541663,
            sha256: '7bd8f18159227968ba46a252d2ec5b0369be5004b68b5edcf8569bf459b1e15a',
            integrity: 'sha512-OC4s04kc1yDmY8uVqCaS6d9bCSPHu3WDd9H/gIc6ZJGCyp7cPochVHekUGLZh050yYhoUyGPRkXxX6kadtkAnw==',
            targetCommit: 'f44fd1b15ba93dad3bea0c498648dab3392788d5',
            dependencyRegistry: 'https://packagefeedproxy.microsoft.io/npm/',
            checksumManifest: {
              format: 'sha256sums',
              asset: 'SHA256SUMS',
              assetId: 566022655,
              url: 'https://github.com/cloga/dsh-github-copilot/releases/download/v0.4.0-alpha.19/SHA256SUMS',
              size: 104,
              sha256: 'd38f3ac469384c8d0b5154bcc58f7ace86fe8bade86a5432c981a253dc44770c',
              integrity: 'sha512-UYdYkddwitxaPNAy/OCgxehRwtbBMq5v7Y5tcUWWiZSwD4ijme8nYomTdiKoMzaHMbYHyMRz1YWfqTeNcSN/cw==',
            },
          },
        }],
      },
    })
    expect(createDesktopForkReleaseCapability(plan)).toMatchObject({
      schemaVersion: 3,
      mode: 'github-release-managed',
      owner: 'cloga/deepseek-harness',
      tagPrefix: 'dsh-desktop-v',
      currentSequence: 3,
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
