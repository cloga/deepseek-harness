/** Credential-free acceptance of the actual packaged Desktop and its release-owned Copilot account. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
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
import { assertDesktopProvisioningInventory } from '../../src/project-manager.ts'
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
 * Exercise actual packaged Copilot UI and restart acceptance with an isolated, temporary profile.
 * @param options - Application and evidence paths; the optional observer must finish all read-only work before returning.
 * @returns Resolves after acceptance, any observer, and owned cleanup; no installed application qualification is implied.
 */
export async function runPackagedCopilotAcceptance(options: PackagedCopilotAcceptanceOptions): Promise<void> {
  const application = resolve(options.application)
  const output = resolve(options.output)
  const resources = join(dirname(application), 'resources')
  const runtimeRoot = packagedDesktopRuntimeRoot(resources)
  const reviewed = parseDesktopForkReleasePlan(JSON.parse(readFileSync(
    resolve('apps/desktop/release/cloga-windows-x64.json'), 'utf8',
  )))
  const plan = readDesktopPluginProvisioningPlan(join(resources, 'desktop-provisioning', 'plan.json'))
  assert.deepEqual(plan, reviewed.desktopProvisioning)
  const copilot = plan.plugins.find(entry => entry.source.packageName === 'dsh-github-copilot')
  assert(copilot?.required, 'This acceptance requires a release-owned Copilot package')
  await verifyPackagedDesktopRuntime(application, runtimeRoot, reviewed.upstreamVersion, { platform: 'win32', arch: 'x64' })
  const runtimeBytes = readPackagedDesktopRuntimeDescriptor(application, runtimeRoot)
  // The production verifier validates this immutable descriptor through Electron's ASAR filesystem.
  const runtime = JSON.parse(runtimeBytes.toString('utf8')) as DesktopRuntimeDescriptor
  const runtimeSha256 = createHash('sha256').update(runtimeBytes).digest('hex')
  mkdirSync(output, { recursive: true })
  writeFileSync(join(output, 'desktop-runtime.json'), runtimeBytes)
  copyFileSync(join(resources, 'desktop-provisioning', 'plan.json'), join(output, 'provisioning-plan.json'))
  copyFileSync(join(resources, 'managed-update', 'capability.json'), join(output, 'capability.json'))
  const scratch = resolve('.desktop-smoke')
  mkdirSync(scratch, { recursive: true })
  const home = mkdtempSync(join(scratch, 'packaged-copilot-'))
  const profile = join(home, 'profiles', 'desktop')
  mkdirSync(profile, { recursive: true })
  const legacySdk = mkdtempSync(join(scratch, 'legacy-mcp-sdk-'))
  const legacySdkLoaded = join(legacySdk, 'loaded')
  writeFileSync(join(legacySdk, 'package.json'), JSON.stringify({
    name: '@modelcontextprotocol/sdk',
    version: '1.0.0',
    type: 'module',
    exports: './index.js',
  }))
  writeFileSync(join(legacySdk, 'index.js'), [
    'import { writeFileSync } from "node:fs"',
    `writeFileSync(${JSON.stringify(legacySdkLoaded)}, '')`,
    'export const legacy = true',
    '',
  ].join('\n'))
  const ancestorSdk = join(home, 'profiles', 'node_modules', '@modelcontextprotocol', 'sdk')
  mkdirSync(dirname(ancestorSdk), { recursive: true })
  symlinkSync(legacySdk, ancestorSdk, process.platform === 'win32' ? 'junction' : 'dir')
  assert(!realpathSync.native(ancestorSdk).startsWith(realpathSync.native(profile)),
    'Legacy SDK fixture must resolve outside the Desktop profile')
  writeFileSync(join(home, '.env'), '')
  writeFileSync(join(profile, '.env'), '')
  writeFileSync(join(home, 'settings.yaml'), 'ui-onboarding:\n  welcomeNoticeVersion: "2026-08-13.1"\n')
  const environment = desktopSmokeEnvironment(home)
  const userData = join(home, 'electron-user-data')
  const inventories: string[] = []
  const versionMenus: DesktopVersionMenuEvidence[] = []
  const started = performance.now()
  const timeline: { event: string; milliseconds: number }[] = []
  const record = (event: string): void => { timeline.push({ event, milliseconds: performance.now() - started }) }
  const safeDiagnostic = (text: string): string => text
    .replace(/(https?:\/\/[^?\s"'<>]+)\?[^\s"'<>]*/gu, '$1?[redacted]')
    .replace(/(authorization:\s*(?:bearer|token)\s+)\S+/giu, '$1[redacted]')
  let stderr = ''
  let stderrTruncated = false
  let page: Page | undefined
  let app: ElectronApplication | undefined
  let failure: unknown
  try {
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
      { encoding: 'utf8', windowsHide: true, env: { ...environment, DSH_DESKTOP_SMOKE_EXECUTABLE: application } },
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
      const versionMenu = await app.evaluate(inspectDesktopVersionMenu, reviewed.version)
      versionMenus.push(versionMenu)
      writeFileSync(join(output, `${phase}-version-menu.json`), JSON.stringify(versionMenu, undefined, 2) + '\n')
      record(`${phase}:version-menu`)
      page.setDefaultTimeout(120_000)
      await page.waitForFunction(() => {
        const error = document.querySelector<HTMLElement>('#error')
        return location.href === 'dsh-app://app/index.html'
        || Boolean(error !== null && !error.hidden && error.textContent?.trim())
      }, undefined, { timeout: 300_000 })
      if (page.url() !== 'dsh-app://app/index.html') {
        throw new Error(`Packaged Desktop startup failed: ${safeDiagnostic(await page.locator('#error').innerText())}`)
      }
      record(`${phase}:application`)
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
      await page.screenshot({ path: join(output, `${phase}-models.png`) })
      await account.getByRole('button', { name: 'Manage', exact: true }).click()
      await account.getByRole('region', { name: 'GitHub Copilot account management', exact: true })
        .waitFor({ state: 'visible' })
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
      } finally {
        closeSync(stdout)
        if (stderrFile !== undefined) closeSync(stderrFile)
      }
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
    await options.inspectProfile?.(Object.freeze({ application, runtimeRoot, home, profile, output }))
    writeFileSync(join(output, 'acceptance.json'), JSON.stringify({
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      desktopVersion: reviewed.version,
      versionMenus,
      runtimeVersion: runtime.release.version,
      plugin: copilot.source,
      transport: 'packaged Electron dsh-app byte pipes',
      isolatedHome: true,
      onboardingNoticeDismissed: true,
      restartReceiptSha256: inventories[0],
      actualGraphVerified: true,
      ancestorSdkJunction: true,
      ancestorSdkLoaded: false,
      accountEntryVisible: true,
      modelRolesViewLoaded: true,
      searchProviderCatalogLoaded: true,
      realOAuth: false,
      realModelRound: false,
      realSearch: false,
      installerUpgradeVerified: false,
      timeline,
    }, undefined, 2) + '\n')
  } catch (error) {
    failure = error
    record('failure')
    let visibleText: string | undefined
    let captureError: string | undefined
    if (page !== undefined && !page.isClosed()) {
      try {
        const rawText = await page.locator('body').innerText({ timeout: 5000 })
        visibleText = safeDiagnostic(rawText)
        if (rawText === visibleText) {
          await page.screenshot({ path: join(output, 'failure.png'), timeout: 5000 })
        } else {
          captureError = 'Screenshot omitted because visible diagnostics required redaction'
        }
      } catch (diagnosticError) {
        captureError = safeDiagnostic(String(diagnosticError))
      }
    }
    const diagnostic = {
      error: safeDiagnostic(String(error)), visibleText, captureError,
      stderrTail: safeDiagnostic(stderr), stderrTruncated, timeline,
      profileFilesPresent: Object.fromEntries([
        'package.json', 'desktop-plugin-receipts.json', 'desktop-plugin-provisioning-state.json',
      ].map(file => [file, existsSync(join(profile, file))])),
      realOAuth: false, realModelRound: false,
    }
    writeFileSync(join(output, 'failure.json'), JSON.stringify(diagnostic, undefined, 2) + '\n')
    console.error(JSON.stringify(diagnostic))
    throw error
  } finally {
    const cleanupErrors: unknown[] = []
    try { await app?.close() } catch (error) { cleanupErrors.push(error) }
    for (const path of [home, legacySdk]) {
      try { removeOwnedDirectory(path) } catch (error) { cleanupErrors.push(error) }
    }
    if (cleanupErrors.length > 0) {
      throw new AggregateError([
        ...(failure === undefined ? [] : [failure]), ...cleanupErrors,
      ], 'Packaged Copilot acceptance cleanup failed')
    }
  }
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: { application: { type: 'string' }, output: { type: 'string' } },
    allowPositionals: false,
  })
  assert(values.application && values.output, 'Packaged application and evidence directory are required')
  await runPackagedCopilotAcceptance({ application: values.application, output: values.output })
}
