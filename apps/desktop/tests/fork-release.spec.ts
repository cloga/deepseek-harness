import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { assertReleaseTestCollection } from '../scripts/verify-release-test-collection.mjs'
import {
  createDesktopForkReleaseCapability,
  parseDesktopForkReleasePlan,
} from '../scripts/fork-release.ts'

const repositoryRoot = resolve(import.meta.dirname, '..', '..', '..')
const planPath = resolve(import.meta.dirname, '..', 'release', 'cloga-windows-x64.json')

function planValue(): unknown {
  return JSON.parse(readFileSync(planPath, 'utf8'))
}

type ReleaseWorkflow = {
  permissions: Record<string, string>
  env?: Record<string, string>
  jobs: Record<string, {
    permissions?: Record<string, string>
    env?: Record<string, string>
    steps: Array<{ name?: string; run?: string; env?: Record<string, string> }>
  }>
}

const metadataTokenEnv = 'DSH_DESKTOP_RELEASE_GITHUB_TOKEN'

function readReleaseWorkflow(): ReleaseWorkflow {
  return load(readFileSync(resolve(repositoryRoot, '.github', 'workflows', 'desktop-fork-release.yml'), 'utf8')) as ReleaseWorkflow
}

function assertMetadataAuthScope(workflow: ReleaseWorkflow): void {
  expect(workflow.env ?? {}).not.toHaveProperty(metadataTokenEnv)
  const authenticatedSteps: string[] = []
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    expect(job.env ?? {}).not.toHaveProperty(metadataTokenEnv)
    for (const step of job.steps) {
      const metadataStep = (jobName === 'build' && step.name === 'Prepare reviewed managed capability')
        || (jobName === 'remote-check' && step.name === 'Run the shipped source discovery against GitHub')
      if (metadataStep) {
        expect(job.permissions ?? workflow.permissions).toEqual({ contents: 'read' })
        expect(step.env?.[metadataTokenEnv]).toBe('${{ github.token }}')
        authenticatedSteps.push(jobName)
      } else {
        expect(step.env ?? {}).not.toHaveProperty(metadataTokenEnv)
      }
      // Neither packaging nor any Electron/helper/Copilot acceptance process inherits a CI credential.
      if (!metadataStep && (jobName === 'build' || jobName === 'remote-check')) {
        expect(Object.keys({ ...workflow.env, ...job.env, ...step.env }).filter(key => /token|secret|password/iu.test(key))).toEqual([])
      }
      expect(step.run ?? '').not.toMatch(/DSH_DESKTOP_RELEASE_GITHUB_TOKEN|github\.token|GITHUB_ENV/u)
    }
  }
  expect(authenticatedSteps).toEqual(['build', 'remote-check'])
}

function assertProjectFixtureSelection(workflow: ReleaseWorkflow): void {
  const ci = load(readFileSync(resolve(repositoryRoot, '.github', 'workflows', 'ci.yml'), 'utf8')) as ReleaseWorkflow
  const budget = ci.jobs['windows-coverage']!.env!.DSH_COVERAGE_TEST_TIMEOUT_MS!
  expect(budget).toBe('90000')
  const file = 'apps/desktop/tests/project-manager.spec.ts'
  const steps = workflow.jobs.build!.steps
  const collection = steps.findIndex(step => step.name === 'Verify Desktop test collection')
  const ordinary = steps.findIndex(step => step.name === 'Verify Desktop release code')
  expect(collection).toBeGreaterThanOrEqual(0)
  expect(steps[collection]?.run).toBe('node apps/desktop/scripts/verify-release-test-collection.mjs')
  expect(ordinary).toBeGreaterThan(collection)
  const transactions = steps.findIndex(step => step.name === 'Verify Desktop project transactions')
  const prepare = steps.findIndex(step => step.name === 'Prepare reviewed managed capability')
  expect(steps[ordinary]?.run?.trim()).toBe('pnpm exec vitest run apps/desktop apps/desktop-host --config=vitest.desktop-release.config.ts --maxWorkers=1')
  expect(steps[transactions]?.run?.trim()).toBe(
    `pnpm exec vitest run ${file} --maxWorkers=1 --testTimeout=${budget} --hookTimeout=${budget}`,
  )
  expect(transactions).toBeGreaterThan(ordinary)
  expect(prepare).toBeGreaterThan(transactions)
}

describe('Desktop fork release plan', () => {
  it('rejects omitted or duplicated actual collection entries', () => {
    const transaction = 'thread-safe:apps/desktop/tests/project-manager.spec.ts'
    const ordinary = 'thread-safe:apps/desktop/tests/fork-release.spec.ts'
    expect(() => { assertReleaseTestCollection([ordinary, transaction], [ordinary], [transaction]) }).not.toThrow()
    expect(() => { assertReleaseTestCollection([ordinary, transaction], [ordinary, transaction], [transaction]) }).toThrow()
    expect(() => { assertReleaseTestCollection([ordinary, transaction], [], [transaction]) }).toThrow()
    expect(() => { assertReleaseTestCollection([ordinary, transaction], [ordinary, ordinary], [transaction]) }).toThrow()
    expect(() => { assertReleaseTestCollection([ordinary, transaction, 'thread-safe:missing'], [ordinary], [transaction]) }).toThrow()
  })
  it('runs every Desktop suite once while assigning only project transactions the Windows process budget', () => {
    assertProjectFixtureSelection(readReleaseWorkflow())
  })

  it.each(['duplicate', 'omitted', 'test-budget', 'hook-budget'])('rejects a %s transaction test selection', (damage) => {
    const workflow = readReleaseWorkflow()
    const ordinary = workflow.jobs.build!.steps.find(step => step.name === 'Verify Desktop release code')!
    const transactions = workflow.jobs.build!.steps.find(step => step.name === 'Verify Desktop project transactions')!
    if (damage === 'duplicate') ordinary.run = ordinary.run!.replace(' --config=vitest.desktop-release.config.ts', '')
    else if (damage === 'omitted') transactions.run = 'pnpm exec vitest run apps/desktop/tests/locale.spec.ts'
    else if (damage === 'test-budget') transactions.run = transactions.run!.replace('--testTimeout=90000', '--testTimeout=5000')
    else transactions.run = transactions.run!.replace(' --hookTimeout=90000', '')
    expect(() => { assertProjectFixtureSelection(workflow) }).toThrow()
  })
  it('defines a monotonic source-owned release after the Windows Ops bridge', () => {
    const plan = parseDesktopForkReleasePlan(planValue())
    expect(plan).toMatchObject({
      schemaVersion: 2,
      channel: 'cloga-windows-x64',
      version: '0.1.6-alpha.1.cloga.2',
      sequence: 12,
      upstreamVersion: '0.1.6-alpha.1',
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
          tag: 'v0.4.0-alpha.24',
          asset: 'dsh-github-copilot-0.4.0-alpha.24.tgz',
          assetId: 570924251,
          packageName: 'dsh-github-copilot',
          version: '0.4.0-alpha.24',
          size: 660977,
          sha256: 'f28dd95e136e203948be8af43745c43ed32bd0bb9b84a44107c4b11ebf7e75cd',
          integrity: 'sha512-F0kqe2wy2kHgodDw69Ouz1Gm/MSWEkkNloNs2yiskYH0790rMntvRO8ytJFSr33OsGbJkyXGx/oWl5xXlPTnGg==',
          targetCommit: 'e49bf7c9307cf22dd9ea720bed8750101fc986ed',
          dependencyRegistry: 'https://packagefeedproxy.microsoft.io/npm/',
          checksumManifest: {
            format: 'sha256sums',
            asset: 'SHA256SUMS',
            assetId: 570924385,
            url: 'https://github.com/cloga/dsh-github-copilot/releases/download/v0.4.0-alpha.24/SHA256SUMS',
            size: 104,
            sha256: '2480327ffa2b6154ad8d151db97329c26b680f898a0c823f9706ec1131b6c0aa',
            integrity: 'sha512-4XktFQTeZ7ZYfI9X6Y7jrVS2+G34FExWoEnsBDHxhN5BtClc0ZedV/LOw6zHDYZQeQ7yHAo+40+EOVT5jHGKHg==',
          },
        },
      }],
    })
    expect(createDesktopForkReleaseCapability(plan)).toMatchObject({
      schemaVersion: 3,
      mode: 'github-release-managed',
      owner: 'cloga/deepseek-harness',
      tagPrefix: 'dsh-desktop-v',
      currentSequence: 12,
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

  it('opts into read-only metadata auth only in the two remote release-script steps', () => {
    assertMetadataAuthScope(readReleaseWorkflow())
    const script = readFileSync(resolve(repositoryRoot, 'apps/desktop/scripts/fork-release.ts'), 'utf8')
    expect(script.match(/discoverDesktopReleaseForBuild\(capability, process\.env\.DSH_DESKTOP_RELEASE_GITHUB_TOKEN\)/gu)).toHaveLength(2)
    expect(script).not.toMatch(/process\.env\.(?:GH_TOKEN|GITHUB_TOKEN)/u)
  })

  it.each(['workflow', 'job', 'package', 'account', 'observer', 'helper'])('rejects metadata token propagation to %s scope', (scope) => {
    const workflow = readReleaseWorkflow()
    const build = workflow.jobs.build!
    const env = { [metadataTokenEnv]: '${{ github.token }}' }
    if (scope === 'workflow') workflow.env = { ...workflow.env, ...env }
    else if (scope === 'job') build.env = env
    else {
      const names: Record<string, string> = {
        package: 'Build unsigned interactive NSIS installer',
        account: 'Verify packaged Copilot account and restart',
        observer: 'Verify real acceptance observer failure cleanup',
        helper: 'Verify copied helper bootstrap and acknowledgement',
      }
      const step = build.steps.find(candidate => candidate.name === names[scope])!
      step.env = { ...step.env, ...env }
    }
    expect(() => { assertMetadataAuthScope(workflow) }).toThrow()
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
    const runtimeCanaries = steps.findIndex(step => step.name === 'Verify ASAR runtime inventory canaries with packaged Electron')
    const finalize = steps.findIndex(step => step.name === 'Finalize release manifest and receipts')
    expect(runtimeCanaries).toBeGreaterThan(packaging)
    expect(finalize).toBeGreaterThan(runtimeCanaries)
    const acceptance = steps.findIndex(step => step.name === 'Verify packaged Copilot account and restart')
    const observerCleanup = steps.findIndex(step => step.name === 'Verify real acceptance observer failure cleanup')
    expect(observerCleanup).toBeGreaterThan(acceptance)
    expect(finalize).toBeGreaterThan(observerCleanup)
    expect(steps[observerCleanup]?.run).toContain('apps/desktop/tests/fixtures/copilot-observer-smoke.ts')
    expect(steps[runtimeCanaries]?.run?.trim()).toBe(
      'node apps/desktop/tests/fixtures/packaged-runtime-smoke.mjs '
      + 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/cloga-deepseek-harness.exe',
    )
  })
})
