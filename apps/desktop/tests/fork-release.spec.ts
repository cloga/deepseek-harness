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
    steps: Array<{
      name?: string
      id?: string
      uses?: string
      if?: string
      run?: string
      env?: Record<string, string>
      with?: Record<string, unknown>
    }>
  }>
}

const metadataTokenEnv = 'DSH_DESKTOP_RELEASE_GITHUB_TOKEN'

function readReleaseWorkflow(): ReleaseWorkflow {
  return load(readFileSync(resolve(repositoryRoot, '.github', 'workflows', 'desktop-fork-release.yml'), 'utf8')) as ReleaseWorkflow
}

function assertMetadataAuthScope(workflow: ReleaseWorkflow): void {
  expect(workflow.env ?? {}).not.toHaveProperty(metadataTokenEnv)
  const authenticatedSteps: string[] = []
  const baselineAcquisitions: string[] = []
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    expect(job.env ?? {}).not.toHaveProperty(metadataTokenEnv)
    for (const step of job.steps) {
      const metadataStep = (jobName === 'build' && step.name === 'Prepare reviewed managed capability')
        || (jobName === 'remote-check' && step.name === 'Run the shipped source discovery against GitHub')
      const baselineStep = jobName === 'build' && step.name === 'Acquire the verified installer-upgrade baseline'
      if (metadataStep) {
        expect(job.permissions ?? workflow.permissions).toEqual({ contents: 'read' })
        expect(step.env).toEqual({ [metadataTokenEnv]: '${{ github.token }}' })
        authenticatedSteps.push(jobName)
      } else if (baselineStep) {
        expect(job.permissions ?? workflow.permissions).toEqual({ contents: 'read' })
        expect(step.env).toEqual({ GH_TOKEN: '${{ github.token }}' })
        expect(step.run).not.toMatch(/Start-Process|electron\.launch|ELECTRON_RUN_AS_NODE/u)
        baselineAcquisitions.push(jobName)
      } else {
        expect(step.env ?? {}).not.toHaveProperty(metadataTokenEnv)
      }
      // Neither packaging nor any Electron/helper/Copilot/installer acceptance process inherits a CI credential.
      if (!metadataStep && !baselineStep && (jobName === 'build' || jobName === 'remote-check')) {
        expect(Object.keys({ ...workflow.env, ...job.env, ...step.env }).filter(key => /token|secret|password/iu.test(key))).toEqual([])
      }
      expect(step.run ?? '').not.toMatch(/DSH_DESKTOP_RELEASE_GITHUB_TOKEN|github\.token|GITHUB_ENV/u)
    }
  }
  expect(authenticatedSteps).toEqual(['build', 'remote-check'])
  expect(baselineAcquisitions).toEqual(['build'])
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
      version: '0.1.6-alpha.2.cloga.1',
      sequence: 13,
      upstreamVersion: '0.1.6-alpha.2',
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
          tag: 'v0.4.0-alpha.25',
          asset: 'dsh-github-copilot-0.4.0-alpha.25.tgz',
          assetId: 571311733,
          packageName: 'dsh-github-copilot',
          version: '0.4.0-alpha.25',
          size: 671451,
          sha256: 'c11d4b3955ae7a8cd85fbf078e2892c74b192949838cf0cbab4796bf55a7e66f',
          integrity: 'sha512-xDcD9Kxg7Z7hQqLt8opOwmS4mVFppheYmFRpRMIWgKO0r3YkmXHGNx76Ta4C79M8waLTpx5HlmNPEq10m80oLQ==',
          targetCommit: '5458fda2854d5956e0c8d68a0f0b0a6e55833c8b',
          dependencyRegistry: 'https://packagefeedproxy.microsoft.io/npm/',
          checksumManifest: {
            format: 'sha256sums',
            asset: 'SHA256SUMS',
            assetId: 571311764,
            url: 'https://github.com/cloga/dsh-github-copilot/releases/download/v0.4.0-alpha.25/SHA256SUMS',
            size: 104,
            sha256: 'c21c8205deaa15385512b3f3a6c6d3faf8353daf69ab198950ef958c344cb7e4',
            integrity: 'sha512-am2kbX4Qco7C6dP540xO46cfuEE2X5mqC+3vuVQatHGZAYl7I8LTaHJsPz48bEyU1wPlqc6Qb3lMDUqf4BpxiA==',
          },
        },
      }],
    })
    expect(createDesktopForkReleaseCapability(plan)).toMatchObject({
      schemaVersion: 3,
      mode: 'github-release-managed',
      owner: 'cloga/deepseek-harness',
      tagPrefix: 'dsh-desktop-v',
      currentSequence: 13,
      minimumSequence: 2,
      provisioning: {
        capability: { id: 'desktopNativePluginProvisioning' },
      },
    })
  })

  it('binds the reviewed upstream version to the Core and Desktop source manifests', () => {
    const plan = parseDesktopForkReleasePlan(planValue())
    for (const path of ['package.json', 'apps/desktop/package.json']) {
      const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, path), 'utf8')) as { version: string }
      expect(manifest.version).toBe(plan.upstreamVersion)
    }
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

  it('limits release-script auth to metadata steps and isolates baseline acquisition', () => {
    assertMetadataAuthScope(readReleaseWorkflow())
    const script = readFileSync(resolve(repositoryRoot, 'apps/desktop/scripts/fork-release.ts'), 'utf8')
    expect(script.match(/discoverDesktopReleaseForBuild\(capability, process\.env\.DSH_DESKTOP_RELEASE_GITHUB_TOKEN\)/gu)).toHaveLength(2)
    expect(script).not.toMatch(/process\.env\.(?:GH_TOKEN|GITHUB_TOKEN)/u)
  })

  it.each(['workflow', 'job', 'package', 'account', 'observer', 'helper', 'upgrade', 'baseline'])('rejects metadata token propagation to %s scope', (scope) => {
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
        upgrade: 'Verify real installed Desktop upgrade',
        baseline: 'Acquire the verified installer-upgrade baseline',
      }
      const step = build.steps.find(candidate => candidate.name === names[scope])!
      step.env = { ...step.env, ...env }
    }
    expect(() => { assertMetadataAuthScope(workflow) }).toThrow()
  })

  it.each(['Build unsigned interactive NSIS installer', 'Verify real installed Desktop upgrade', 'Verify copied helper bootstrap and acknowledgement'])(
    'does not forward the baseline acquisition token to %s', (name) => {
      const workflow = readReleaseWorkflow()
      const step = workflow.jobs.build!.steps.find(candidate => candidate.name === name)!
      step.env = { ...step.env, GH_TOKEN: '${{ github.token }}' }
      expect(() => { assertMetadataAuthScope(workflow) }).toThrow()
    },
  )

  it('requires actual installer qualification after finalization and before release asset sealing', () => {
    const workflow = readReleaseWorkflow()
    const steps = workflow.jobs.build!.steps
    const finalize = steps.findIndex(step => step.name === 'Finalize release manifest and receipts')
    const acquire = steps.findIndex(step => step.name === 'Acquire the verified installer-upgrade baseline')
    const guards = steps.findIndex(step => step.name === 'Verify installer-upgrade guard tests')
    const upgrade = steps.findIndex(step => step.name === 'Verify real installed Desktop upgrade')
    const seal = steps.findIndex(step => step.name === 'Verify release asset checksums')
    expect(finalize).toBeGreaterThanOrEqual(0)
    expect(acquire).toBeGreaterThan(finalize)
    expect(guards).toBeGreaterThan(acquire)
    expect(upgrade).toBeGreaterThan(guards)
    expect(seal).toBeGreaterThan(upgrade)
    expect(steps[acquire]?.run).toContain('$release.immutable -isnot [bool]')
    expect(steps[acquire]?.run).toContain('$assets[0].digest -cne "sha256:$($expected.sha256)"')
    expect(steps[guards]?.run).toContain(
      'node --test apps/desktop/tests/windows-installed-upgrade.test.mjs apps/desktop/tests/windows-packaged-package-acceptance.test.mjs',
    )
    expect(steps[upgrade]?.id).toBe('installed_upgrade')
    expect(steps[upgrade]?.run).toContain('./apps/desktop/tests/windows-installer-upgrade.ps1')
    expect(steps[upgrade]?.run).toContain('-ExpectedSourceCommit $env:GITHUB_SHA')
    expect(steps[upgrade]?.run).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }')
    for (const index of [acquire, guards, upgrade]) {
      expect(steps[index]).not.toHaveProperty('continue-on-error')
      expect(steps[index]).not.toHaveProperty('if')
    }
    const evidence = steps.find(step => step.with?.name === 'desktop-installer-upgrade-${{ steps.plan.outputs.version }}')
    expect(evidence?.uses).toBe('actions/upload-artifact@v4')
    expect(evidence?.if).toContain("steps.installed_upgrade.outcome == 'failure'")
    expect(evidence?.with?.path).toContain('/evidence/*')
    expect(evidence?.with?.path).toContain('/acquisition.json')
    expect(evidence?.with?.path).not.toMatch(/home|userData|release-assets/u)
  })

  it('formats the source commit in release notes without an interpolated Markdown here-string', () => {
    const publish = readReleaseWorkflow().jobs.release!.steps.find(step => step.name === 'Publish reviewed release')
    expect(publish?.run).toContain("('- Source commit: `{0}`' -f $env:SOURCE_SHA)")
    expect(publish?.run).toContain("'- Native `electron-updater`: disabled; no `app-update.yml`'")
    expect(publish?.run).not.toContain('@"')
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
