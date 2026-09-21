import { deepStrictEqual } from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
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
  on: { workflow_dispatch: { inputs: Record<string, { required: boolean; type: string; default?: unknown }> } }
  permissions: Record<string, string>
  concurrency: { group: string; 'cancel-in-progress': boolean }
  env?: Record<string, string>
  jobs: Record<string, {
    'runs-on'?: string
    needs?: string | string[]
    if?: string
    environment?: string
    permissions?: Record<string, string>
    env?: Record<string, string>
    steps: Array<{
      name?: string
      id?: string
      uses?: string
      if?: string
      run?: string
      shell?: string
      'continue-on-error'?: boolean
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

function assertRehearsalConcurrency(workflow: ReleaseWorkflow): void {
  expect(workflow.concurrency).toEqual({
    group: "${{ inputs.rehearsal && format('desktop-fork-rehearsal-{0}', github.ref) || 'desktop-fork-release' }}",
    'cancel-in-progress': false,
  })
  expect(workflow.on.workflow_dispatch.inputs.rehearsal).toMatchObject({ type: 'boolean', default: false })
  expect(workflow.permissions).toEqual({ contents: 'read' })
  expect(workflow.jobs.build!['runs-on']).toBe('windows-2025')
  expect(workflow.jobs.build!.permissions).toBeUndefined()
  for (const name of ['release', 'remote-check']) {
    expect(workflow.jobs[name]!.if).toBe("${{ !inputs.rehearsal && github.ref == 'refs/heads/master' }}")
  }
}

function assertReviewedSourcePin(workflow: ReleaseWorkflow): string {
  expect(workflow.on.workflow_dispatch.inputs.expected_source_sha).toMatchObject({ required: true, type: 'string' })
  expect(workflow.on.workflow_dispatch.inputs.expected_source_sha).not.toHaveProperty('default')
  const steps = workflow.jobs.build!.steps
  const guardIndex = steps.findIndex(step => step.name === 'Require current reviewed ref and version')
  expect(guardIndex).toBeGreaterThanOrEqual(0)
  expect(steps.findIndex(step => step.name === 'Install from frozen lockfile')).toBeGreaterThan(guardIndex)
  expect(steps.findIndex(step => step.name === 'Build unsigned interactive NSIS installer')).toBeGreaterThan(guardIndex)
  const guard = steps[guardIndex]!
  expect(guard.shell).toBe('pwsh')
  expect(guard.env?.EXPECTED_SOURCE_SHA).toBe('${{ inputs.expected_source_sha }}')
  expect(workflow.env ?? {}).not.toHaveProperty('EXPECTED_SOURCE_SHA')
  for (const job of Object.values(workflow.jobs)) {
    expect(job.env ?? {}).not.toHaveProperty('EXPECTED_SOURCE_SHA')
    for (const step of job.steps) if (step !== guard) expect(step.env ?? {}).not.toHaveProperty('EXPECTED_SOURCE_SHA')
  }
  const script = guard.run ?? ''
  const formatCheck = "if ($env:EXPECTED_SOURCE_SHA -cnotmatch '\\A[0-9a-f]{40}\\z')"
  const exactCheck = 'if ($head -cne $env:EXPECTED_SOURCE_SHA)'
  const headRead = script.indexOf('$head = git rev-parse HEAD')
  const branchCheck = script.indexOf("if ($env:REHEARSAL -eq 'true')")
  expect(script).toContain(`${formatCheck} {\n  throw 'Expected source SHA must be exactly 40 lowercase hexadecimal characters'\n}`)
  expect(script).toContain(`${exactCheck} {\n  throw "Checkout does not match reviewed source: HEAD=$head expected=$($env:EXPECTED_SOURCE_SHA)"\n}`)
  expect(headRead).toBeGreaterThan(script.indexOf(formatCheck))
  expect(script.indexOf(exactCheck)).toBeGreaterThan(headRead)
  expect(branchCheck).toBeGreaterThan(script.indexOf(exactCheck))
  expect(script).toContain('if ($head -ne $selected)')
  expect(script).toContain('if ($head -ne $master)')
  expect(script).toContain('if ($env:CONFIRM_VERSION -ne $plan.version)')
  expect(script).not.toContain('${{ inputs.expected_source_sha }}')
  return script.slice(0, branchCheck)
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

function assertQualificationGate(workflow: ReleaseWorkflow): void {
  const steps = workflow.jobs.build!.steps
  const index = steps.findIndex(step => step.name === 'Verify complete release qualification')
  expect(steps.filter(step => step.name === 'Verify complete release qualification')).toHaveLength(1)
  const upgrade = steps.findIndex(step => step.name === 'Verify real installed Desktop upgrade')
  const checksums = steps.findIndex(step => step.name === 'Verify release asset checksums')
  expect(upgrade).toBeGreaterThanOrEqual(0)
  expect(index).toBeGreaterThan(upgrade)
  expect(checksums).toBeGreaterThan(index)
  const step = steps[index]!
  expect(step.id).toBe('qualification')
  expect(step.shell).toBe('pwsh')
  expect(step).not.toHaveProperty('if')
  expect(step).not.toHaveProperty('continue-on-error')
  expect(step.env).toBeUndefined()
  expect(step.run?.trim()).toBe([
    "$ErrorActionPreference = 'Stop'",
    'pnpm exec tsx apps/desktop/scripts/verify-fork-qualification.ts `',
    '  --plan $env:RELEASE_PLAN `',
    '  --release-assets $env:RELEASE_ASSETS `',
    '  --ordinary-evidence dist/desktop-copilot-acceptance `',
    '  --packaged-evidence dist/desktop-copilot-observer-canary `',
    '  --upgrade-root (Join-Path $env:RUNNER_TEMP "cloga-installer-upgrade-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT") `',
    '  --baseline-directory (Join-Path $env:RUNNER_TEMP "desktop-upgrade-baseline-$env:GITHUB_RUN_ID-$env:GITHUB_RUN_ATTEMPT") `',
    '  --expected-source $env:GITHUB_SHA `',
    '  --run-id $env:GITHUB_RUN_ID `',
    '  --run-attempt $env:GITHUB_RUN_ATTEMPT `',
    '  --output dist/desktop-fork-qualification/qualification.json',
    'if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }',
  ].join('\n'))
  const summary = steps.findIndex(item => item.name === 'Retain verified internal qualification summary')
  expect(summary).toBeGreaterThan(index)
  expect(checksums).toBeGreaterThan(summary)
  expect(steps[summary]).toMatchObject({
    uses: 'actions/upload-artifact@v4',
    with: {
      name: 'desktop-fork-qualification-${{ steps.plan.outputs.version }}-${{ github.sha }}-${{ github.run_attempt }}',
      path: 'dist/desktop-fork-qualification/qualification.json', 'if-no-files-found': 'error', 'retention-days': 7,
    },
  })
  expect(steps[summary]).not.toHaveProperty('if')
  expect(steps[summary]).not.toHaveProperty('continue-on-error')
  const diagnostic = steps.findIndex(item => item.name === 'Retain unqualified rehearsal candidate for targeted diagnosis')
  expect(diagnostic).toBeGreaterThan(steps.findIndex(item => item.name === 'Finalize release manifest and receipts'))
  expect(upgrade).toBeGreaterThan(diagnostic)
  expect(steps[diagnostic]).toMatchObject({
    if: '${{ inputs.rehearsal }}', uses: 'actions/upload-artifact@v4',
    with: {
      name: 'desktop-unqualified-candidate-${{ steps.plan.outputs.version }}-${{ github.sha }}-${{ github.run_attempt }}',
      path: '${{ env.RELEASE_ASSETS }}/*', 'if-no-files-found': 'error', 'retention-days': 7,
    },
  })
  const released = steps.findIndex(item => item.with?.name === 'desktop-fork-release-${{ steps.plan.outputs.version }}')
  expect(released).toBeGreaterThan(checksums)
  expect(workflow.jobs.release!.needs).toBe('build')
  const download = workflow.jobs.release!.steps.find(item => item.uses === 'actions/download-artifact@v4')
  expect(download?.with?.name).toBe('desktop-fork-release-${{ needs.build.outputs.version }}')
}

describe('Desktop fork release plan', () => {
  it('requires complete source-bound qualification before sealing and never publishes diagnostic artifacts', () => {
    assertQualificationGate(readReleaseWorkflow())
  })

  it.each([
    'missing', 'duplicate', 'before-upgrade', 'after-seal', 'conditional', 'continue-on-error',
    'wrong-source', 'public-summary-path', 'swallowed-exit', 'diagnostic-for-release', 'unguarded-diagnostic',
  ])('rejects a %s qualification path', (damage) => {
    const workflow = readReleaseWorkflow()
    const steps = workflow.jobs.build!.steps
    const index = steps.findIndex(step => step.name === 'Verify complete release qualification')
    const step = steps[index]!
    if (damage === 'missing') steps.splice(index, 1)
    else if (damage === 'duplicate') steps.push({ ...step })
    else if (damage === 'before-upgrade') steps.unshift(...steps.splice(index, 1))
    else if (damage === 'after-seal') steps.push(...steps.splice(index, 1))
    else if (damage === 'conditional') step.if = 'always()'
    else if (damage === 'continue-on-error') step['continue-on-error'] = true
    else if (damage === 'wrong-source') step.run = step.run!.replace('--expected-source $env:GITHUB_SHA', '--expected-source unreviewed')
    else if (damage === 'public-summary-path') step.run = step.run!.replace('dist/desktop-fork-qualification/', 'dist/desktop-fork-release/')
    else if (damage === 'swallowed-exit') step.run = step.run!.replace('exit $LASTEXITCODE', 'Write-Output $LASTEXITCODE')
    else if (damage === 'diagnostic-for-release') {
      workflow.jobs.release!.steps.find(item => item.uses === 'actions/download-artifact@v4')!.with!.name = 'desktop-unqualified-candidate'
    } else delete steps.find(item => item.name === 'Retain unqualified rehearsal candidate for targeted diagnosis')!.if
    expect(() => { assertQualificationGate(workflow) }).toThrow()
  })

  it('isolates read-only rehearsals by branch while keeping publication globally serialized', () => {
    assertRehearsalConcurrency(readReleaseWorkflow())
  })

  it.each([
    'global-rehearsal', 'split-formal', 'cancel-running', 'string-input', 'publish-default',
    'writable-rehearsal', 'self-hosted-rehearsal', 'unguarded-release', 'unguarded-remote-check',
  ])('rejects a %s concurrency or publication boundary', (damage) => {
    const workflow = readReleaseWorkflow()
    if (damage === 'global-rehearsal') workflow.concurrency.group = 'desktop-fork-release'
    else if (damage === 'split-formal') workflow.concurrency.group = 'desktop-fork-release-${{ github.ref }}'
    else if (damage === 'cancel-running') workflow.concurrency['cancel-in-progress'] = true
    else if (damage === 'string-input') workflow.on.workflow_dispatch.inputs.rehearsal!.type = 'string'
    else if (damage === 'publish-default') workflow.on.workflow_dispatch.inputs.rehearsal!.default = true
    else if (damage === 'writable-rehearsal') workflow.jobs.build!.permissions = { contents: 'write' }
    else if (damage === 'self-hosted-rehearsal') workflow.jobs.build!['runs-on'] = 'self-hosted'
    else if (damage === 'unguarded-release') delete workflow.jobs.release!.if
    else delete workflow.jobs['remote-check']!.if
    expect(() => { assertRehearsalConcurrency(workflow) }).toThrow()
  })

  it('requires a step-local exact reviewed source pin before dependencies and packaging in both modes', () => {
    assertReviewedSourcePin(readReleaseWorkflow())
  })

  it.each([
    'missing-input', 'optional-input', 'default-source', 'wrong-env', 'insensitive-format', 'insensitive-head',
    'loose-length', 'late-guard', 'missing-rejection', 'workflow-env', 'job-env',
  ])('rejects a %s source pin guard', (damage) => {
    const workflow = readReleaseWorkflow()
    const build = workflow.jobs.build!
    const index = build.steps.findIndex(step => step.name === 'Require current reviewed ref and version')
    const guard = build.steps[index]!
    if (damage === 'missing-input') delete workflow.on.workflow_dispatch.inputs.expected_source_sha
    else if (damage === 'optional-input') workflow.on.workflow_dispatch.inputs.expected_source_sha!.required = false
    else if (damage === 'default-source') workflow.on.workflow_dispatch.inputs.expected_source_sha!.default = '${{ github.sha }}'
    else if (damage === 'wrong-env') guard.env!.EXPECTED_SOURCE_SHA = '${{ inputs.confirm_version }}'
    else if (damage === 'insensitive-format') guard.run = guard.run!.replace('-cnotmatch', '-notmatch')
    else if (damage === 'insensitive-head') guard.run = guard.run!.replace('-cne', '-ne')
    else if (damage === 'loose-length') guard.run = guard.run!.replace('{40}', '{39,40}')
    else if (damage === 'late-guard') build.steps.push(...build.steps.splice(index, 1))
    else if (damage === 'missing-rejection') guard.run = guard.run!.replace('throw "Checkout', 'Write-Output "Checkout')
    else if (damage === 'workflow-env') workflow.env = { ...workflow.env, EXPECTED_SOURCE_SHA: 'unreviewed' }
    else build.env = { ...build.env, EXPECTED_SOURCE_SHA: 'unreviewed' }
    expect(() => { assertReviewedSourcePin(workflow) }).toThrow()
  })

  const reviewedSha = 'a'.repeat(40)
  it.runIf(process.platform === 'win32').each([
    { label: 'matching source', expected: reviewedSha, head: reviewedSha, accepted: true },
    { label: 'different source with unchanged plan', expected: reviewedSha, head: 'b'.repeat(40), accepted: false },
    { label: 'missing source', expected: undefined, head: reviewedSha, accepted: false },
    { label: 'empty source', expected: '', head: reviewedSha, accepted: false },
    { label: 'short source', expected: 'a'.repeat(39), head: reviewedSha, accepted: false },
    { label: 'long source', expected: 'a'.repeat(41), head: reviewedSha, accepted: false },
    { label: 'uppercase source', expected: 'A'.repeat(40), head: reviewedSha, accepted: false },
    { label: 'non-hex source', expected: 'g'.repeat(40), head: reviewedSha, accepted: false },
    { label: 'trailing newline', expected: `${reviewedSha}\n`, head: reviewedSha, accepted: false },
  ])('executes the Windows source pin guard: $label', { timeout: 15_000 }, ({ expected, head, accepted }) => {
    const guard = assertReviewedSourcePin(readReleaseWorkflow())
    const gitStub = `function git {
  if (($args -join ' ') -cne 'rev-parse HEAD') { throw 'Unexpected Git operation in source-pin fixture' }
  $global:LASTEXITCODE = 0
  $env:RELEASE_TEST_HEAD
}`
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command',
      `${gitStub}\n${guard}\nWrite-Output 'reviewed-source-accepted'`], {
      encoding: 'utf8', timeout: 10000,
      env: { ...process.env, EXPECTED_SOURCE_SHA: expected, RELEASE_TEST_HEAD: head },
    })
    expect(result.error).toBeUndefined()
    expect(result.signal).toBeNull()
    if (accepted) {
      expect(result.status).toBe(0)
      expect(result.stdout.trim()).toBe('reviewed-source-accepted')
    } else {
      expect(result.status).not.toBe(0)
      expect(result.stdout).not.toContain('reviewed-source-accepted')
      expect(result.stderr).toContain(expected === reviewedSha ? 'Checkout does not match reviewed source' : 'Expected source SHA must be')
    }
  })

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
      sequence: 26,
      upstreamVersion: '0.1.6-alpha.2',
      migration: {
        owner: 'cloga/dsh-windows-ops',
        maximumSequence: 1,
        channelVersion: '0.1.5-rc.2.local.1',
      },
    })
    deepStrictEqual(plan.desktopProvisioning, {
      schemaVersion: 1,
      mode: 'exact',
      plugins: [{
        required: true,
        source: {
          schemaVersion: 1,
          type: 'githubRelease',
          owner: 'cloga',
          repo: 'dsh-github-copilot',
          tag: 'v0.4.0-alpha.32',
          asset: 'dsh-github-copilot-0.4.0-alpha.32.tgz',
          assetId: 576880049,
          packageName: 'dsh-github-copilot',
          version: '0.4.0-alpha.32',
          size: 723822,
          sha256: '8f5b55488fd1bb9949ef8aa23b1bf2d41b3da52584b38497685ce07559290e32',
          integrity: 'sha512-lbZNmi4EQrCB018C1RE+mwb6m0nK/a7eJtpB1T4/MI+VKRllMJfrVJGmauSPsn4lV2xGGA48cEA23hK0u9T+Og==',
          targetCommit: '76d190aed688e073df930adb3c753d2a749519c9',
          dependencyRegistry: 'https://packagefeedproxy.microsoft.io/npm/',
          checksumManifest: {
            format: 'sha256sums',
            asset: 'SHA256SUMS',
            assetId: 576880065,
            url: 'https://github.com/cloga/dsh-github-copilot/releases/download/v0.4.0-alpha.32/SHA256SUMS',
            size: 104,
            sha256: 'a8e7dd1906b0478d80d5540217d80bb09837079d46b17c71143597de2726c7c2',
            integrity: 'sha512-OE5SovBXez6XTcmJcrqPfamWgN4KPxGxM7XnaGcSovFNWz5SvCB6Z8dMXN7sm9NuBJhxLUpu1NMLyNRQquAX5g==',
          },
        },
      }],
    })
    expect(createDesktopForkReleaseCapability(plan)).toMatchObject({
      schemaVersion: 3,
      mode: 'github-release-managed',
      owner: 'cloga/deepseek-harness',
      tagPrefix: 'dsh-desktop-v',
      currentSequence: 26,
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

  it.each([
    'Build unsigned interactive NSIS installer', 'Verify real installed Desktop upgrade',
    'Verify copied helper bootstrap and acknowledgement', 'Verify packaged Copilot account and restart',
    'Verify real acceptance observer failure cleanup',
  ])(
    'does not forward the baseline acquisition token to %s', (name) => {
      const workflow = readReleaseWorkflow()
      const step = workflow.jobs.build!.steps.find(candidate => candidate.name === name)!
      step.env = { ...step.env, GH_TOKEN: '${{ github.token }}' }
      expect(() => { assertMetadataAuthScope(workflow) }).toThrow()
    },
  )

  it('requires native Windows command and ACL acceptance before managed preparation and packaging', () => {
    const steps = readReleaseWorkflow().jobs.build!.steps
    const transactions = steps.findIndex(step => step.name === 'Verify Desktop project transactions')
    const native = steps.findIndex(step => step.name === 'Verify hidden Windows command paths')
    const prepare = steps.findIndex(step => step.name === 'Prepare reviewed managed capability')
    const packaging = steps.findIndex(step => step.name === 'Build unsigned interactive NSIS installer')
    expect(transactions).toBeGreaterThanOrEqual(0)
    expect(native).toBeGreaterThan(transactions)
    expect(prepare).toBeGreaterThan(native)
    expect(packaging).toBeGreaterThan(prepare)
    expect(steps.filter(step => step.name === 'Verify hidden Windows command paths')).toHaveLength(1)
    expect(steps[native]?.run?.trim()).toBe([
      'pnpm exec vitest run',
      'packages/subprocess/win32-process/tests',
      'packages/subprocess/subprocess-local/tests/windows-job.spec.ts',
      'packages/subprocess/subprocess-local/tests/native-windows.spec.ts',
      'packages/sandbox/sandbox-windows-acl/tests/runner.spec.ts',
      'packages/sandbox/sandbox-windows-acl/tests/provider-chain.spec.ts',
      'packages/sandbox/sandbox-windows-acl/tests/control.spec.ts',
      '--maxWorkers=2 --testTimeout=90000 --hookTimeout=90000',
    ].join(' '))
    expect(steps[native]).not.toHaveProperty('continue-on-error')
    expect(steps[native]).not.toHaveProperty('if')
  })

  it('runs packaged skill canary guards before building and testing the actual artifact', () => {
    const steps = readReleaseWorkflow().jobs.build!.steps
    const guards = steps.findIndex(step => step.name === 'Verify packaged skill canary guards')
    const build = steps.findIndex(step => step.name === 'Build unsigned interactive NSIS installer')
    const canary = steps.findIndex(step => step.name === 'Verify ASAR runtime inventory canaries with packaged Electron')
    expect(guards).toBeGreaterThanOrEqual(0)
    expect(build).toBeGreaterThan(guards)
    expect(canary).toBeGreaterThan(build)
    expect(steps[guards]?.shell).toBe('pwsh')
    expect(steps[guards]?.run).toContain('node --test apps/desktop/tests/packaged-skills-smoke.test.mjs')
    expect(steps[guards]?.run).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }')
    expect(steps[guards]).not.toHaveProperty('continue-on-error')
    expect(steps[guards]).not.toHaveProperty('if')
  })

  it('runs source installer guards before packaging and actual upgrade before release sealing', () => {
    const workflow = readReleaseWorkflow()
    const steps = workflow.jobs.build!.steps
    const install = steps.findIndex(step => step.name === 'Install from frozen lockfile')
    const build = steps.findIndex(step => step.name === 'Build unsigned interactive NSIS installer')
    const finalize = steps.findIndex(step => step.name === 'Finalize release manifest and receipts')
    const acquire = steps.findIndex(step => step.name === 'Acquire the verified installer-upgrade baseline')
    const guards = steps.findIndex(step => step.name === 'Verify installer-upgrade guard tests')
    const upgrade = steps.findIndex(step => step.name === 'Verify real installed Desktop upgrade')
    const seal = steps.findIndex(step => step.name === 'Verify release asset checksums')
    expect(install).toBeGreaterThanOrEqual(0)
    expect(guards).toBeGreaterThan(install)
    expect(build).toBeGreaterThan(guards)
    expect(finalize).toBeGreaterThan(build)
    expect(acquire).toBeGreaterThan(finalize)
    expect(upgrade).toBeGreaterThan(acquire)
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

  it('binds baseline API and tag commits to independently pinned manifest bytes', () => {
    const acquisition = readReleaseWorkflow().jobs.build!.steps
      .find(step => step.name === 'Acquire the verified installer-upgrade baseline')?.run
    if (acquisition === undefined) throw new Error('Baseline acquisition step is missing')
    expect(acquisition).not.toContain('$baseline.sourceCommit')
    const digestCheck = acquisition.indexOf('$manifestDigest -cne $baseline.manifest.sha256')
    const commitCheck = acquisition.indexOf('$manifest.source.commit -cne $release.target_commitish')
    expect(digestCheck).toBeGreaterThanOrEqual(0)
    expect(commitCheck).toBeGreaterThan(digestCheck)
    expect(acquisition).toContain('$manifest.source.commit -cne $tagSha')
  })

  it('invokes the plan-bound publisher from the exact build checkout only after artifact verification', () => {
    const workflow = readReleaseWorkflow()
    const release = workflow.jobs.release!
    expect(release.needs).toBe('build')
    expect(release.if).toBe("${{ !inputs.rehearsal && github.ref == 'refs/heads/master' }}")
    expect(release.environment).toBe('desktop-fork-release')
    const steps = release.steps
    const checkout = steps.findIndex(step => step.uses === 'actions/checkout@v6')
    const node = steps.findIndex(step => step.uses === 'actions/setup-node@v6')
    const download = steps.findIndex(step => step.uses === 'actions/download-artifact@v4')
    const verified = steps.findIndex(step => step.name === 'Cross-check downloaded artifact set')
    const publish = steps.findIndex(step => step.name === 'Publish reviewed release')
    expect(checkout).toBeGreaterThanOrEqual(0)
    expect(node).toBeGreaterThan(checkout)
    expect(download).toBeGreaterThan(node)
    expect(verified).toBeGreaterThan(download)
    expect(publish).toBeGreaterThan(verified)
    expect(steps[checkout]?.with).toMatchObject({ ref: '${{ needs.build.outputs.source_sha }}', 'persist-credentials': false, clean: true })
    expect(steps[node]?.with).toEqual({ 'node-version': '${{ env.NODE_VERSION }}', 'package-manager-cache': false })
    expect(steps[publish]?.env).toEqual({
      GH_TOKEN: '${{ github.token }}', RELEASE_TAG: '${{ needs.build.outputs.tag }}',
      RELEASE_VERSION: '${{ needs.build.outputs.version }}', SOURCE_SHA: '${{ needs.build.outputs.source_sha }}',
    })
    expect(steps[publish]?.run).toContain('$head = git rev-parse HEAD')
    expect(steps[publish]?.run).toContain('$LASTEXITCODE -ne 0 -or $head -cne $env:SOURCE_SHA')
    expect(steps[publish]?.run).toContain('node apps/desktop/scripts/publish-fork-release.mjs release-assets')
    expect(steps[publish]?.run).toContain('if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }')
    expect(steps[publish]?.run).not.toMatch(/gh release (?:create|edit|delete)|@"/u)
    expect(steps[publish]).not.toHaveProperty('continue-on-error')
    expect(steps[publish]).not.toHaveProperty('if')
    expect(workflow.jobs['remote-check']?.needs).toEqual(['build', 'release'])
  })

  it('keeps plan-byte binding and managed installer notes in the checked publisher', () => {
    const script = readFileSync(resolve(repositoryRoot, 'apps/desktop/scripts/publish-fork-release.mjs'), 'utf8')
    expect(script).toContain("new URL('../release/cloga-windows-x64.json', import.meta.url)")
    expect(script).toContain('manifest.build?.planSha256, planSha256')
    expect(script).toContain('receipt.buildInputs?.planSha256, planSha256')
    expect(script).toContain('Source commit: ${sourceSha}')
    expect(script).toContain('Native electron-updater is disabled.')
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
        steps?: Array<{
          id?: string
          name?: string
          run?: string
          env?: Record<string, string>
          with?: { name?: string; path?: string; 'if-no-files-found'?: string; 'retention-days'?: number }
        }>
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
    expect(acceptance).toBeGreaterThan(runtimeCanaries)
    expect(finalize).toBeGreaterThan(acceptance)
    expect(steps[acceptance]?.run?.trim()).toBe([
      'pnpm exec tsx apps/desktop/tests/fixtures/copilot-release-smoke.ts',
      '--application apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/cloga-deepseek-harness.exe',
      '--output dist/desktop-copilot-acceptance',
    ].join(' '))
    expect(steps[acceptance]).not.toHaveProperty('continue-on-error')
    expect(steps[acceptance]).not.toHaveProperty('if')
    const observerCleanup = steps.findIndex(step => step.name === 'Verify real acceptance observer failure cleanup')
    expect(observerCleanup).toBeGreaterThan(acceptance)
    expect(finalize).toBeGreaterThan(observerCleanup)
    const assertAcceptancePair = (candidates: typeof steps): void => {
      deepStrictEqual(candidates.filter(step => step.run?.includes('fixtures/copilot-release-smoke.ts')),
        [steps[acceptance], steps[observerCleanup]])
    }
    assertAcceptancePair(steps)
    expect(() => { assertAcceptancePair([...steps, steps[acceptance]!]) }).toThrow()
    expect(() => { assertAcceptancePair(steps.filter((_, index) => index !== acceptance)) }).toThrow()
    expect(() => { assertAcceptancePair(steps.filter((_, index) => index !== observerCleanup)) }).toThrow()
    expect(steps[observerCleanup]?.run).toBe([
      'pnpm exec tsx apps/desktop/tests/fixtures/copilot-release-smoke.ts --observer-cleanup-canary',
      '--application apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/cloga-deepseek-harness.exe',
      '--output dist/desktop-copilot-observer-canary',
    ].join(' '))
    expect(steps[observerCleanup]).not.toHaveProperty('continue-on-error')
    expect(steps[observerCleanup]).not.toHaveProperty('if')
    expect(steps.filter(step => step.run?.includes('--observer-cleanup-canary'))).toHaveLength(1)
    expect(steps.some(step => step.run?.includes('fixtures/copilot-observer-smoke.ts'))).toBe(false)
    const observerEvidence = steps.findIndex(step => step.with?.name === 'desktop-copilot-observer-canary-${{ steps.plan.outputs.version }}')
    expect(observerEvidence).toBeGreaterThan(observerCleanup)
    expect(finalize).toBeGreaterThan(observerEvidence)
    expect(steps[observerEvidence]).toMatchObject({
      if: "${{ !cancelled() && (steps.observer_cleanup.outcome == 'success' || steps.observer_cleanup.outcome == 'failure') }}",
      with: { path: 'dist/desktop-copilot-observer-canary/*', 'if-no-files-found': 'error', 'retention-days': 7 },
    })
    const acceptanceEvidence = steps.findIndex(step => step.with?.name === 'desktop-copilot-acceptance-${{ steps.plan.outputs.version }}')
    expect(acceptanceEvidence).toBeGreaterThan(acceptance)
    expect(finalize).toBeGreaterThan(acceptanceEvidence)
    expect(steps[acceptanceEvidence]).toMatchObject({
      if: "${{ !cancelled() && (steps.copilot_acceptance.outcome == 'success' || steps.copilot_acceptance.outcome == 'failure') }}",
      with: { path: 'dist/desktop-copilot-acceptance/*', 'if-no-files-found': 'error', 'retention-days': 7 },
    })
    expect(steps[runtimeCanaries]?.run?.trim()).toBe(
      'node apps/desktop/tests/fixtures/packaged-runtime-smoke.mjs '
      + 'apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/win-unpacked/cloga-deepseek-harness.exe',
    )
  })
})
