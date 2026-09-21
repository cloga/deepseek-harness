/** Credential-free acceptance of the actual packaged Desktop and its release-owned Copilot account. */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  closeSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright'
import { desktopSmokeEnvironment } from '../../scripts/smoke-environment.ts'
import { parseDesktopForkReleasePlan } from '../../scripts/fork-release.ts'
import { assertDesktopProvisioningInventory } from '../../src/plugin-receipts.ts'
import { readDesktopPluginProvisioningPlan } from '../../src/plugin-provisioning.ts'
import type { DesktopRuntimeDescriptor } from '../../src/runtime-tree.ts'
import { removeOwnedDirectory } from '../../src/owned-directory.ts'
import {
  packagedDesktopRuntimeEnvironment,
  packagedDesktopRuntimeRoot,
  readPackagedDesktopRuntimeDescriptor,
  verifyPackagedDesktopRuntime,
} from '../../scripts/packaged-runtime.mjs'
import { inspectPackagedGraphResolution, packagedGraphCheckArguments } from './packaged-graph-check.ts'
import { inspectPackagedCopilotSettings } from './copilot-settings-smoke.ts'
import { runPackagedCopilotObserverCanary, writePackagedProof, type PackagedProofIdentity } from './copilot-observer-smoke.ts'
import {
  inspectCopilotUsageCapability,
  inspectSignedOutCopilotUsage,
  type CopilotUsageCapabilityEvidence,
  type SignedOutCopilotUsageEvidence,
} from './copilot-usage-smoke.ts'
import { inspectDesktopVersionMenu, type DesktopVersionMenuEvidence } from './desktop-version-menu-smoke.ts'

/** Paths available only during the awaited, read-only post-acceptance inspection. */
export interface PackagedCopilotProfileInspection {
  readonly application: string
  readonly runtimeRoot: string
  readonly home: string
  readonly profile: string
  readonly output: string
}

/** Actual packaged application, evidence destination, and an optional read-only profile observer. */
export interface PackagedCopilotAcceptanceOptions {
  readonly application: string
  readonly output: string
  /** Runs once after both Desktop processes close and restart receipts match, before owned cleanup. */
  readonly inspectProfile?: (paths: PackagedCopilotProfileInspection) => void | Promise<void>
}

/**
 * Prepare private home settings and the ancestor SDK canary without claiming Desktop profile ownership.
 * @param home - Newly allocated fixture home.
 * @param legacySdk - Separately allocated fixture package directory.
 */
export function preparePackagedCopilotHome(home: string, legacySdk: string): void {
  const profile = join(home, 'profiles', 'desktop')
  assert(!existsSync(profile), 'The shell must exclusively create the fresh Desktop profile')
  writeFileSync(join(legacySdk, 'package.json'), JSON.stringify({
    name: '@modelcontextprotocol/sdk', version: '1.0.0', type: 'module', exports: './index.js',
  }))
  writeFileSync(join(legacySdk, 'index.js'), [
    'import { writeFileSync } from "node:fs"',
    `writeFileSync(${JSON.stringify(join(legacySdk, 'loaded'))}, '')`,
    'export const legacy = true',
    '',
  ].join('\n'))
  const ancestorSdk = join(home, 'profiles', 'node_modules', '@modelcontextprotocol', 'sdk')
  mkdirSync(dirname(ancestorSdk), { recursive: true })
  symlinkSync(legacySdk, ancestorSdk, process.platform === 'win32' ? 'junction' : 'dir')
  assert(!realpathSync.native(ancestorSdk).startsWith(resolve(profile)),
    'Legacy SDK fixture must resolve outside the Desktop profile')
  // The product permits an absent profile .env; the isolated home and scrubbed environment own startup values.
  writeFileSync(join(home, '.env'), '')
  writeFileSync(join(home, 'settings.yaml'), 'ui-onboarding:\n  welcomeNoticeVersion: "2026-08-13.1"\n')
  assert(!existsSync(profile), 'Fixture preparation must leave Desktop initialization to the shell')
}

/** Browser-serialized readiness predicate for the official application URL or a visible startup failure. */
export function packagedCopilotStartupReady(): boolean {
  const error = document.querySelector<HTMLElement>('#error')
  return location.href === 'dsh-app://app/'
    || Boolean(error !== null && !error.hidden && error.textContent?.trim())
}

/**
 * Exercise actual packaged Copilot UI and restart acceptance with an isolated, temporary profile.
 * @param options - Application and evidence paths; the optional observer must finish all read-only work before returning.
 * @returns Resolves after acceptance, any observer, and owned cleanup; no installed application qualification is implied.
 */
export async function runPackagedCopilotAcceptance(options: PackagedCopilotAcceptanceOptions): Promise<void> {
  const application = resolve(options.application)
  const output = resolve(options.output)
  mkdirSync(output, { recursive: true })
  for (const file of ['functional-results.json', 'acceptance.json', 'failure.json', 'observer-cleanup.json', 'packaged-suite.json']) {
    assert(!existsSync(join(output, file)), `Packaged acceptance requires fresh ${file} evidence`)
  }
  const ownedDirectories: string[] = []
  let diagnosticProfile: string | undefined
  let identity: Partial<PackagedProofIdentity> = {
    evidenceId: randomUUID(), runId: process.env.GITHUB_RUN_ID ?? null, runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? null,
  }
  let functional: Record<string, unknown> | undefined
  const inventories: string[] = []
  const versionMenus: DesktopVersionMenuEvidence[] = []
  const usageCapabilities: CopilotUsageCapabilityEvidence[] = []
  const signedOutUsage: SignedOutCopilotUsageEvidence[] = []
  const started = performance.now()
  const timeline: { event: string; milliseconds: number }[] = []
  const record = (event: string): void => { timeline.push({ event, milliseconds: performance.now() - started }) }
  const safeDiagnostic = (text: string): string => text
    .replace(/(https?:\/\/[^?\s"'<>]+)\?[^\s"'<>]*/gu, '$1?[redacted]')
    .replace(/(authorization:\s*(?:bearer|token)\s+)\S+/giu, '$1[redacted]')
  const describeError = (error: unknown): string => {
    try { return safeDiagnostic(String(error)).slice(0, 8192) }
    catch { return 'Unprintable acceptance failure' }
  }
  let stderr = ''
  let stderrTruncated = false
  let page: Page | undefined
  let app: ElectronApplication | undefined
  let failure: unknown
  let failed = false
  let failureReceiptWritten = false
  const cleanupErrors: string[] = []
  const diagnosticErrors: string[] = []
  let diagnostics: Record<string, unknown> = {}
  const retain = (error: unknown): void => {
    if (!failed) { failure = error; failed = true }
  }
  const writeFailure = (cleanupCompleted: boolean): void => {
    try {
      writePackagedProof(output, 'failure.json', {
        ...diagnostics, ...identity, schemaVersion: 2, scope: 'packaged-acceptance-failure',
        error: describeError(failure), cleanupCompleted,
        cleanupVerified: cleanupCompleted && cleanupErrors.length === 0,
        cleanupErrors, diagnosticErrors,
      }, failureReceiptWritten)
      failureReceiptWritten = true
    } catch (error) {
      diagnosticErrors.push(describeError(error))
      retain(error)
    }
  }
  try {
    const resources = join(dirname(application), 'resources')
    const runtimeRoot = packagedDesktopRuntimeRoot(resources)
    const planBytes = readFileSync(resolve('apps/desktop/release/cloga-windows-x64.json'))
    const reviewed = parseDesktopForkReleasePlan(JSON.parse(planBytes.toString('utf8')))
    const plan = readDesktopPluginProvisioningPlan(join(resources, 'desktop-provisioning', 'plan.json'))
    assert.deepEqual(plan, reviewed.desktopProvisioning)
    const copilot = plan.plugins.find(entry => entry.source.packageName === 'dsh-github-copilot')
    assert(copilot?.required, 'This acceptance requires a release-owned Copilot package')
    await verifyPackagedDesktopRuntime(application, runtimeRoot, reviewed.upstreamVersion, { platform: 'win32', arch: 'x64' })
    const runtimeBytes = readPackagedDesktopRuntimeDescriptor(application, runtimeRoot)
    // The production verifier validates this immutable descriptor through Electron's ASAR filesystem.
    const runtime = JSON.parse(runtimeBytes.toString('utf8')) as DesktopRuntimeDescriptor
    const digest = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')
    const runtimeSha256 = digest(runtimeBytes)
    const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { encoding: 'utf8' }).trim()
    assert(/^[a-f0-9]{40}$/u.test(sourceCommit) && /^[a-f0-9]{40}$/u.test(sourceTree))
    if (process.env.GITHUB_SHA !== undefined) assert.equal(sourceCommit, process.env.GITHUB_SHA)
    identity = {
      ...identity, sourceCommit, sourceTree, planSha256: digest(planBytes), runtimeSha256,
      executableSha256: digest(readFileSync(application)),
      provisioningSha256: digest(readFileSync(join(resources, 'desktop-provisioning', 'plan.json'))),
      capabilitySha256: digest(readFileSync(join(resources, 'managed-update', 'capability.json'))),
    }
    writeFileSync(join(output, 'desktop-runtime.json'), runtimeBytes)
    copyFileSync(join(resources, 'desktop-provisioning', 'plan.json'), join(output, 'provisioning-plan.json'))
    copyFileSync(join(resources, 'managed-update', 'capability.json'), join(output, 'capability.json'))
    const scratch = resolve('.desktop-smoke')
    mkdirSync(scratch, { recursive: true })
    const home = mkdtempSync(join(scratch, 'packaged-copilot-'))
    ownedDirectories.push(home)
    const profile = join(home, 'profiles', 'desktop')
    diagnosticProfile = profile
    const legacySdk = mkdtempSync(join(scratch, 'legacy-mcp-sdk-'))
    ownedDirectories.push(legacySdk)
    const legacySdkLoaded = join(legacySdk, 'loaded')
    preparePackagedCopilotHome(home, legacySdk)
    const environment = desktopSmokeEnvironment(home)
    const userData = join(home, 'electron-user-data')
    const metadata = execFileSync(
      join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-Command', [
        '$ErrorActionPreference = "Stop"',
        'Import-Module (Join-Path $env:SystemRoot "System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Security\\Microsoft.PowerShell.Security.psd1")',
        '$file = Get-Item -LiteralPath $env:DSH_DESKTOP_SMOKE_EXECUTABLE',
        '[ordered]@{',
        '  file = $file.Name',
        '  sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()',
        '  productVersion = $file.VersionInfo.ProductVersion',
        '  companyName = $file.VersionInfo.CompanyName',
        '  productName = $file.VersionInfo.ProductName',
        '  fileDescription = $file.VersionInfo.FileDescription',
        '  signature = (Get-AuthenticodeSignature -LiteralPath $file.FullName).Status.ToString()',
        '} | ConvertTo-Json',
      ].join('\n')],
      { encoding: 'utf8', windowsHide: true, timeout: 120_000, env: { ...environment, DSH_DESKTOP_SMOKE_EXECUTABLE: application } },
    )
    writeFileSync(join(output, 'executable.json'), metadata.trim() + '\n')
    record('package-identity')
    for (const phase of ['initial', 'restart'] as const) {
      record(`${phase}:launch`)
      app = await electron.launch({
        executablePath: application,
        args: [`--user-data-dir=${userData}`],
        env: environment,
        timeout: 120_000,
      })
      app.process().stderr?.on('data', (chunk: Buffer | string) => {
        const combined = stderr + chunk.toString()
        stderrTruncated ||= combined.length > 65_536
        stderr = combined.slice(-65_536)
      })
      assert.equal(resolve(await app.evaluate(({ app }) => app.getPath('userData'))), userData)
      page = await app.firstWindow()
      const versionMenu = await inspectDesktopVersionMenu(app, page, reviewed.version)
      versionMenus.push(versionMenu)
      writeFileSync(join(output, `${phase}-version-menu.json`), JSON.stringify(versionMenu, undefined, 2) + '\n')
      record(`${phase}:version-menu`)
      page.setDefaultTimeout(120_000)
      await page.waitForFunction(packagedCopilotStartupReady, undefined, { timeout: 300_000 })
      if (page.url() !== 'dsh-app://app/') {
        throw new Error(`Packaged Desktop startup failed: ${safeDiagnostic(await page.locator('#error').innerText())}`)
      }
      record(`${phase}:application`)
      const configureLater = page.getByRole('button', { name: 'Configure later', exact: true })
      let providerPromptVisible = false
      try {
        await configureLater.waitFor({ state: 'visible', timeout: phase === 'initial' ? 30_000 : 5_000 })
        providerPromptVisible = true
      } catch (error: unknown) {
        if (!(error instanceof Error) || error.name !== 'TimeoutError') throw error
      }
      if (providerPromptVisible) {
        await configureLater.click()
        record(`${phase}:provider-deferred`)
      }
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.getByRole('button', { name: 'Models', exact: true }).click()
      const account = settings.locator('[data-dsh-github-copilot-compact-account]')
      await account.waitFor({ state: 'visible' })
      const signIn = account.getByRole('button', { name: 'Sign in with GitHub', exact: true })
      await signIn.waitFor({ state: 'visible' })
      record(`${phase}:account`)
      assert(await signIn.isEnabled(), 'The account must expose a writable device-authorization entry')
      assert.equal(await account.locator('[data-dsh-github-copilot-account-error]').count(), 0)
      const usageCapability = inspectCopilotUsageCapability(profile)
      const usageEvidence = await inspectSignedOutCopilotUsage(page)
      usageCapabilities.push(usageCapability)
      signedOutUsage.push(usageEvidence)
      writeFileSync(join(output, `${phase}-usage-readonly.json`), JSON.stringify({
        capability: usageCapability, signedOut: usageEvidence,
      }, undefined, 2) + '\n')
      record(`${phase}:usage-readonly`)
      await page.screenshot({ path: join(output, `${phase}-models.png`) })
      await account.getByRole('button', { name: 'Manage', exact: true }).click()
      const management = account.getByRole('region', { name: 'GitHub Copilot account management', exact: true })
      await management.waitFor({ state: 'visible' })
      const managementText = await management.innerText()
      assert(!managementText.includes('Compatibility and existing configurations'),
        'Manage must not restore the removed compatibility disclosure')
      assert.equal(await account.locator('[data-dsh-github-copilot-compatibility]').count(), 0,
        'Manage must not restore the removed compatibility disclosure component')
      assert.equal(await account.locator('[data-dsh-github-copilot-auth-notice]').count(), 0,
        'Read-only acceptance must not initiate device authorization')
      assert.equal(await account.locator('[data-dsh-github-copilot-verification-url]').count(), 0,
        'Read-only acceptance must not create or open a verification URL')
      await page.screenshot({ path: join(output, `${phase}-account.png`) })
      const settingsEvidence = await inspectPackagedCopilotSettings(settings)
      writeFileSync(join(output, `${phase}-settings-readonly.json`), JSON.stringify(settingsEvidence, undefined, 2) + '\n')
      await settings.locator('[data-dsh-dual-model-card]').screenshot({ path: join(output, `${phase}-model-roles.png`) })
      await settings.locator('[data-dsh-web-search-routing]').screenshot({ path: join(output, `${phase}-search-catalog.png`) })
      record(`${phase}:settings-readonly`)
      assertDesktopProvisioningInventory(profile, plan)
      const plugins = plan.plugins.map(entry => entry.source.packageName)
      writeFileSync(join(output, `${phase}-runner-resolution.json`), JSON.stringify({
        authoritative: false, observation: 'physical lookup only; runtime generation is not installed in this runner',
        ...inspectPackagedGraphResolution(profile),
      }, undefined, 2) + '\n')
      const carrier = await app.evaluate(() => ({ node: process.versions.node, electron: process.versions.electron }))
      const graphOutput = join(output, `${phase}-packaged-graph.json`)
      const graphError = join(output, `${phase}-packaged-graph.stderr.txt`)
      const stdout = openSync(graphOutput, 'w')
      let stderrFile: number | undefined
      try {
        stderrFile = openSync(graphError, 'w')
        execFileSync(application, packagedGraphCheckArguments(profile, runtimeRoot, plugins), {
          cwd: profile, env: packagedDesktopRuntimeEnvironment(environment),
          stdio: ['ignore', stdout, stderrFile], timeout: 120_000, windowsHide: true,
        })
      } catch (error) {
        retain(error)
        throw error
      } finally {
        for (const descriptor of [stdout, stderrFile]) {
          if (descriptor === undefined) continue
          try { closeSync(descriptor) } catch (error) {
            cleanupErrors.push(describeError(error)); retain(error)
          }
        }
      }
      if (failed) throw failure
      const graphResult: unknown = JSON.parse(readFileSync(graphOutput, 'utf8'))
      assert(typeof graphResult === 'object' && graphResult !== null
      && 'valid' in graphResult && graphResult.valid === true
      && 'runtimeSha256' in graphResult && graphResult.runtimeSha256 === runtimeSha256
      && 'nodePath' in graphResult && graphResult.nodePath === null
      && 'nodeOptionsPresent' in graphResult && graphResult.nodeOptionsPresent === false
      && 'nodeVersion' in graphResult && graphResult.nodeVersion === carrier.node
      && 'electronVersion' in graphResult && graphResult.electronVersion === carrier.electron
      && 'runAsNode' in graphResult && graphResult.runAsNode === '1'
      && 'electronNoAsarPresent' in graphResult && graphResult.electronNoAsarPresent === false
      && 'resolutionMode' in graphResult && graphResult.resolutionMode === 'runtime'
      && 'runtimeRoot' in graphResult && graphResult.runtimeRoot === runtimeRoot
      && 'executable' in graphResult && typeof graphResult.executable === 'string'
      && resolve(graphResult.executable).toLowerCase() === application.toLowerCase()
      && 'cwd' in graphResult && typeof graphResult.cwd === 'string'
      && resolve(graphResult.cwd).toLowerCase() === profile.toLowerCase(),
      'Packaged Electron Node mode must validate the ASAR runtime graph without source-runner overrides')
      assert(!existsSync(legacySdkLoaded), 'Packaged Host must not load the ancestor MCP SDK')
      record(`${phase}:packaged-graph`)
      const receipts = readFileSync(join(profile, 'desktop-plugin-receipts.json'))
      inventories.push(createHash('sha256').update(receipts).digest('hex'))
      for (const file of ['desktop-plugin-receipts.json', 'desktop-plugin-provisioning-state.json', 'package.json']) {
        copyFileSync(join(profile, file), join(output, `${phase}-${file}`))
      }
      await app.close()
      app = undefined
      page = undefined
      record(`${phase}:closed`)
    }
    assert.equal(inventories[0], inventories[1], 'Restart must reuse the verified plugin receipts')
    assert.deepEqual(usageCapabilities[0], usageCapabilities[1], 'Restart must preserve the required usage capability')
    assert.deepEqual(signedOutUsage[0], signedOutUsage[1], 'Restart must preserve the absent signed-out usage surface')
    functional = {
      ...identity, schemaVersion: 1, scope: 'packaged-functional-observations',
      functionalAssertionsCompleted: true, normalAcceptanceCompleted: false, cleanupVerified: false,
      desktopVersion: reviewed.version,
      versionMenus,
      runtimeVersion: runtime.release.version,
      plugin: copilot.source,
      transport: 'official Web-backed Desktop Host with packaged Electron dsh-app origin bridge',
      isolatedHome: true,
      onboardingNoticeDismissed: true,
      restartReceiptSha256: inventories[0],
      actualGraphVerified: true,
      ancestorSdkJunction: true,
      ancestorSdkLoaded: false,
      accountEntryVisible: true,
      manageCompatibilityDisclosureAbsent: true,
      modelRolesViewLoaded: true,
      currentWorkspaceReadOnly: true,
      searchProviderCatalogLoaded: true,
      providerOnlySearchRouting: true,
      fallbackProviderLabel: true,
      copilotUsageCapability: usageCapabilities[0],
      signedOutCopilotUsage: signedOutUsage,
      hostQuotaNoNetworkEvidence: 'immutable-plugin-ci-regression-only',
      liveAccountQuota: false,
      realOAuth: false,
      verificationNavigationExercised: false,
      manualVerificationAddressObserved: false,
      realModelRound: false,
      realSearch: false,
      installerUpgradeVerified: false,
      timeline,
    }
    writePackagedProof(output, 'functional-results.json', functional)
    await options.inspectProfile?.(Object.freeze({ application, runtimeRoot, home, profile, output }))
  } catch (error) {
    retain(error)
    record('failure')
    try {
      let visibleText: string | undefined
      let captureError: string | undefined
      if (page !== undefined && !page.isClosed()) {
        const rawText = await page.locator('body').innerText({ timeout: 5000 })
        visibleText = safeDiagnostic(rawText).slice(0, 8192)
        if (rawText === visibleText) await page.screenshot({ path: join(output, 'failure.png'), timeout: 5000 })
        else captureError = 'Screenshot omitted because visible diagnostics required redaction or truncation'
      }
      diagnostics = {
        visibleText, captureError, stderrTail: safeDiagnostic(stderr), stderrTruncated, timeline,
        profileFilesPresentBeforeCleanup: Object.fromEntries([
          'package.json', 'desktop-plugin-receipts.json', 'desktop-plugin-provisioning-state.json',
        ].map(file => [file, diagnosticProfile !== undefined && existsSync(join(diagnosticProfile, file))])),
        realOAuth: false, realModelRound: false, realSearch: false,
        verificationNavigationExercised: false, manualVerificationAddressObserved: false,
      }
    } catch (diagnosticError) {
      diagnosticErrors.push(describeError(diagnosticError))
    }
    writeFailure(false)
  } finally {
    try { await app?.close() } catch (error) {
      cleanupErrors.push(describeError(error)); retain(error)
    }
    for (const path of ownedDirectories) {
      try {
        removeOwnedDirectory(path)
        assert(!existsSync(path), 'Owned acceptance directory remains after cleanup')
      } catch (error) {
        cleanupErrors.push(describeError(error)); retain(error)
      }
    }
  }
  if (failed) {
    writeFailure(true)
    throw failure
  }
  assert(functional !== undefined, 'Functional observations must precede ordinary acceptance')
  try {
    writePackagedProof(output, 'acceptance.json', {
      ...functional, scope: 'packaged-acceptance', normalAcceptanceCompleted: true, cleanupVerified: true,
    })
  } catch (error) {
    retain(error)
    writeFailure(true)
    throw failure
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      application: { type: 'string' }, output: { type: 'string' }, 'observer-cleanup-canary': { type: 'boolean' },
    },
    allowPositionals: false,
  })
  assert(values.application && values.output, 'Packaged application and evidence directory are required')
  const options = { application: values.application, output: values.output }
  if (values['observer-cleanup-canary']) await runPackagedCopilotObserverCanary(options, runPackagedCopilotAcceptance)
  else await runPackagedCopilotAcceptance(options)
}
