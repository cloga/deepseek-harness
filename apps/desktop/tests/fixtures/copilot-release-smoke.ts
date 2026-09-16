/** Credential-free acceptance of the actual packaged Desktop and its release-owned Copilot account. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { _electron as electron, type ElectronApplication } from 'playwright'
import { desktopSmokeEnvironment } from '../../scripts/smoke-environment.ts'
import { parseDesktopForkReleasePlan } from '../../scripts/fork-release.ts'
import { assertDesktopProvisioningInventory } from '../../src/project-manager.ts'
import { validateDesktopPluginGraph } from '../../src/profile-packages.ts'
import { readDesktopPluginProvisioningPlan } from '../../src/plugin-provisioning.ts'
import { verifyDesktopRuntime } from '../../src/runtime-tree.ts'
import { removeOwnedDirectory } from '../../src/owned-directory.ts'

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
mkdirSync(output, { recursive: true })
const scratch = resolve('.desktop-smoke')
mkdirSync(scratch, { recursive: true })
const home = mkdtempSync(join(scratch, 'packaged-copilot-'))
const profile = join(home, 'profiles', 'desktop')
mkdirSync(profile, { recursive: true })
writeFileSync(join(home, '.env'), '')
writeFileSync(join(profile, '.env'), '')
writeFileSync(join(home, 'settings.yaml'), 'ui-onboarding:\n  welcomeNoticeVersion: "2026-08-13.1"\n')
const environment = desktopSmokeEnvironment(home)
const userData = join(home, 'electron-user-data')
const inventories: string[] = []
let app: ElectronApplication | undefined
let failure: unknown
try {
  for (const phase of ['initial', 'restart'] as const) {
    app = await electron.launch({
      executablePath: application,
      args: [`--user-data-dir=${userData}`],
      env: environment,
      timeout: 120_000,
    })
    assert.equal(resolve(await app.evaluate(({ app }) => app.getPath('userData'))), userData)
    const page = await app.firstWindow()
    page.setDefaultTimeout(120_000)
    await page.waitForURL('dsh-app://app/index.html', { timeout: 300_000 })
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    const account = settings.locator('[data-dsh-github-copilot-compact-account]')
    await account.waitFor({ state: 'visible' })
    const signIn = account.getByRole('button', { name: 'Sign in with GitHub', exact: true })
    await signIn.waitFor({ state: 'visible' })
    assert(await signIn.isEnabled(), 'The account must expose a writable device-authorization entry')
    assert.equal(await account.locator('[data-dsh-github-copilot-account-error]').count(), 0)
    await page.screenshot({ path: join(output, `${phase}-models.png`) })
    await account.getByRole('button', { name: 'Manage', exact: true }).click()
    await account.getByRole('region', { name: 'GitHub Copilot account management', exact: true })
      .waitFor({ state: 'visible' })
    await page.screenshot({ path: join(output, `${phase}-account.png`) })
    assertDesktopProvisioningInventory(profile, plan)
    validateDesktopPluginGraph(profile, runtimeRoot, runtime, plan.plugins.map(entry => entry.source.packageName))
    const receipts = readFileSync(join(profile, 'desktop-plugin-receipts.json'))
    inventories.push(createHash('sha256').update(receipts).digest('hex'))
    for (const file of ['desktop-plugin-receipts.json', 'desktop-plugin-provisioning-state.json', 'package.json']) {
      copyFileSync(join(profile, file), join(output, `${phase}-${file}`))
    }
    await app.close()
    app = undefined
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
    accountEntryVisible: true,
    realOAuth: false,
    realModelRound: false,
    installerUpgradeVerified: false,
  }, undefined, 2) + '\n')
} catch (error) {
  failure = error
  throw error
} finally {
  try {
    await app?.close()
    removeOwnedDirectory(home)
  } catch (cleanupError) {
    throw new AggregateError([
      ...(failure === undefined ? [] : [failure]), cleanupError,
    ], 'Packaged Copilot acceptance cleanup failed')
  }
}
