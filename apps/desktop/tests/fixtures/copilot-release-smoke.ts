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
import { validateDesktopPluginGraph } from '../../src/profile-packages.ts'
import { readDesktopPluginProvisioningPlan } from '../../src/plugin-provisioning.ts'
import { verifyDesktopRuntime } from '../../src/runtime-tree.ts'
import { removeOwnedDirectory } from '../../src/owned-directory.ts'
import { inspectPackagedGraphResolution } from './packaged-graph-check.ts'

const { values } = parseArgs({
  options: { application: { type: 'string' }, output: { type: 'string' } },
  allowPositionals: false,
})
assert(values.application && values.output, 'Packaged application and evidence directory are required')
const application = resolve(values.application)
const output = resolve(values.output)
const resources = join(dirname(application), 'resources')
const runtimeRoot = join(resources, 'dsh')
const reviewed = parseDesktopForkReleasePlan(JSON.parse(readFileSync(
  resolve('apps/desktop/release/cloga-windows-x64.json'), 'utf8',
)))
const plan = readDesktopPluginProvisioningPlan(join(resources, 'desktop-provisioning', 'plan.json'))
assert.deepEqual(plan, reviewed.desktopProvisioning)
const copilot = plan.plugins.find(entry => entry.source.packageName === 'dsh-github-copilot')
assert(copilot?.required, 'This acceptance requires a release-owned Copilot package')
const runtime = await verifyDesktopRuntime(runtimeRoot, reviewed.upstreamVersion)
const runtimeSha256 = createHash('sha256').update(readFileSync(join(runtimeRoot, 'desktop-runtime.json'))).digest('hex')
mkdirSync(output, { recursive: true })
copyFileSync(join(runtimeRoot, 'desktop-runtime.json'), join(output, 'desktop-runtime.json'))
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
    assertDesktopProvisioningInventory(profile, plan)
    const plugins = plan.plugins.map(entry => entry.source.packageName)
    let runnerError: string | undefined
    try {
      validateDesktopPluginGraph(profile, runtimeRoot, runtime, plugins)
    } catch (error) {
      runnerError = safeDiagnostic(String(error))
    }
    writeFileSync(join(output, `${phase}-runner-resolution.json`), JSON.stringify({
      authoritative: false, ...inspectPackagedGraphResolution(profile), runnerError,
    }, undefined, 2) + '\n')
    const graphOutput = join(output, `${phase}-packaged-graph.json`)
    const graphError = join(output, `${phase}-packaged-graph.stderr.txt`)
    const stdout = openSync(graphOutput, 'w')
    const bundledNode = join(resources, 'runtime', 'node', 'node.exe')
    let stderrFile: number | undefined
    try {
      stderrFile = openSync(graphError, 'w')
      execFileSync(bundledNode, [
        resolve('apps/desktop/tests/fixtures/packaged-graph-check.ts'), profile, runtimeRoot, ...plugins,
      ], { cwd: profile, env: environment, stdio: ['ignore', stdout, stderrFile], timeout: 120_000 })
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
      && 'nodeVersion' in graphResult && graphResult.nodeVersion === runtime.release.nodeVersion
      && 'executable' in graphResult && typeof graphResult.executable === 'string'
      && resolve(graphResult.executable).toLowerCase() === bundledNode.toLowerCase()
      && 'cwd' in graphResult && typeof graphResult.cwd === 'string'
      && resolve(graphResult.cwd).toLowerCase() === profile.toLowerCase(),
    'Packaged Node must verify the same graph without source-runner module paths')
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
  writeFileSync(join(output, 'acceptance.json'), JSON.stringify({
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    desktopVersion: reviewed.version,
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
    realOAuth: false,
    realModelRound: false,
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
