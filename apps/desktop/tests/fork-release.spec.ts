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
  env?: Record<string, string>
  jobs: Record<string, {
    permissions?: Record<string, string>
    env?: Record<string, string>
    steps: Array<{ name?: string; shell?: string; run?: string; env?: Record<string, string> }>
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

describe('Desktop fork release plan', () => {
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
      version: '0.1.6-alpha.1.cloga.5',
      sequence: 15,
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
          tag: 'v0.4.0-alpha.27',
          asset: 'dsh-github-copilot-0.4.0-alpha.27.tgz',
          assetId: 573327174,
          packageName: 'dsh-github-copilot',
          version: '0.4.0-alpha.27',
          size: 678130,
          sha256: 'c2a1d331436e217dd76ae57635dd79ceb8839b723e036dd111019b2d14b7b186',
          integrity: 'sha512-t6k14sg/mMLGvNGoJmrdtxLk2yAkZ3lJEYSQc2gZy8LgD0sG62Z/fCFiS71M3B9CurFtSmZn0HzSujzBhUf0sw==',
          targetCommit: '8f8211b0a2d39ac8b8a39cb18f2d3287403b6594',
          dependencyRegistry: 'https://packagefeedproxy.microsoft.io/npm/',
          checksumManifest: {
            format: 'sha256sums',
            asset: 'SHA256SUMS',
            assetId: 573327192,
            url: 'https://github.com/cloga/dsh-github-copilot/releases/download/v0.4.0-alpha.27/SHA256SUMS',
            size: 104,
            sha256: '4266646d9a06e3401aa3316ac314419de17d2f5762037a55394bd29f4af16144',
            integrity: 'sha512-J8Nt5zfuxZlBzqpsAIenfvImPp3qYVQ6eBJvsDBI2UgABCB4jSPOB1WCjJYLSN8/GRDim5puskAfIXfaNibySw==',
          },
        },
      }],
    })
    expect(createDesktopForkReleaseCapability(plan)).toMatchObject({
      schemaVersion: 3,
      mode: 'github-release-managed',
      owner: 'cloga/deepseek-harness',
      tagPrefix: 'dsh-desktop-v',
      currentSequence: 15,
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
