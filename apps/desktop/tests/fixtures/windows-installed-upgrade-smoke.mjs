/** Actual installed Desktop observations; execution is restricted to disposable GitHub Windows runners. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertUpgradeRunner, ownedUpgradePath, pinnedUpgradeSourceCommit, upgradeFileHash, verifyUpgradeRelease } from './windows-installed-upgrade-contract.mjs'
import { retainPrimaryFailure } from './windows-packaged-package-acceptance.mjs'

const baseline = JSON.parse(readFileSync(new URL('./windows-upgrade-baseline.json', import.meta.url), 'utf8'))
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const safeError = error => String(error).replace(/(https?:\/\/[^?\s"'<>]+)\?[^\s"'<>]*/gu, '$1?[redacted]')

async function main() {
  assertUpgradeRunner(process.env)
  const { values } = parseArgs({ options: Object.fromEntries(['phase', 'run-root', 'baseline-directory', 'candidate-directory', 'expected-source'].map(name => [name, { type: 'string' }])) })
  assert.ok(['validate', 'baseline', 'candidate', 'package', 'cleanup'].includes(values.phase))
  assert.ok(values['run-root'])
  const root = ownedUpgradePath(process.env.RUNNER_TEMP, values['run-root'])
  const owner = json(join(root, 'owner.json'))
  assert.equal(owner.runId, process.env.GITHUB_RUN_ID)
  assert.equal(owner.runAttempt, process.env.GITHUB_RUN_ATTEMPT)
  assert.match(owner.token, /^[a-f0-9-]{36}$/)
  const evidence = ownedUpgradePath(root, join(root, 'evidence'))
  mkdirSync(evidence, { recursive: true })
  if (values.phase === 'validate') {
    const { managedUpdateJsonSha256 } = await import('../../src/managed-update-protocol.ts')
    const { parseDesktopForkReleasePlan } = await import('../../scripts/fork-release.ts')
    const plan = parseDesktopForkReleasePlan(json(fileURLToPath(new URL('../../release/cloga-windows-x64.json', import.meta.url))))
    assert.equal(values['expected-source'], process.env.GITHUB_SHA, 'Candidate must be the workflow checkout')
    assert.equal(plan.upstreamVersion, '0.1.6-alpha.2')
    assert.ok(plan.sequence > baseline.sequence)
    const baselineDirectory = resolve(values['baseline-directory'])
    const baselineCommit = pinnedUpgradeSourceCommit(baselineDirectory, baseline.manifest.sha256)
    const previous = verifyUpgradeRelease(baselineDirectory, {
      manifestSha256: baseline.manifest.sha256, commit: baselineCommit,
      version: baseline.version, upstreamVersion: baseline.upstreamVersion,
    }, managedUpdateJsonSha256)
    assert.equal(previous.manifest.sequence, baseline.sequence)
    for (const name of ['file', 'bytes', 'sha256', 'sha512']) assert.equal(previous.manifest.installer[name], baseline.installer[name])
    const candidate = verifyUpgradeRelease(resolve(values['candidate-directory']), {
      commit: values['expected-source'], version: plan.version, upstreamVersion: plan.upstreamVersion,
    }, managedUpdateJsonSha256)
    assert.equal(candidate.manifest.sequence, plan.sequence)
    assert.equal(candidate.manifest.build.planSha256, upgradeFileHash(fileURLToPath(new URL('../../release/cloga-windows-x64.json', import.meta.url))))
    save(join(root, 'validated.json'), { ownerToken: owner.token, previous, candidate })
    return
  }
  const validated = json(join(root, 'validated.json'))
  assert.equal(validated.ownerToken, owner.token)
  if (values.phase === 'package') {
    const { runPackagedPackageAcceptance } = await import('./windows-packaged-package-acceptance.mjs')
    await runPackagedPackageAcceptance(root)
    return
  }
  if (values.phase === 'cleanup') {
    const { removeOwnedDirectory } = await import('../../src/owned-directory.ts')
    for (const name of ['home', 'electron-user-data', 'package-home', 'package-electron-user-data', 'package-workspace', 'package-fixture-data']) {
      const path = ownedUpgradePath(root, join(root, name))
      if (existsSync(path)) removeOwnedDirectory(path)
      assert.equal(existsSync(path), false)
    }
    save(join(evidence, 'profile-cleanup.json'), { ownedHomeRemoved: true, ownedElectronDataRemoved: true, isolatedPackageAcceptanceDataRemoved: true })
    return
  }
  const expected = values.phase === 'baseline' ? validated.previous : validated.candidate
  assert.equal(upgradeFileHash(expected.manifestPath), expected.manifestFileSha256)
  const application = ownedUpgradePath(root, join(root, 'Installed App', 'cloga-deepseek-harness.exe'))
  assert.equal(upgradeFileHash(application), expected.manifest.installedEvidence.executableSha256)
  const home = ownedUpgradePath(root, join(root, 'home'))
  const userData = ownedUpgradePath(root, join(root, 'electron-user-data'))
  const retained = join(home, '.env')
  if (values.phase === 'baseline') {
    assert.ok(!existsSync(home) && !existsSync(userData), 'Baseline must create fresh owned state')
    mkdirSync(home)
    writeFileSync(retained, `# Disposable installer-upgrade retained home: ${owner.token}\n`, { flag: 'wx' })
    writeFileSync(join(home, 'settings.yaml'), 'ui-onboarding:\n  welcomeNoticeVersion: "2026-08-13.1"\n', { flag: 'wx' })
    save(join(root, 'retained.json'), { envSha256: upgradeFileHash(retained) })
  }
  assert.equal(upgradeFileHash(retained), json(join(root, 'retained.json')).envSha256)
  const { desktopSmokeEnvironment } = await import('../../scripts/smoke-environment.ts')
  const { inspectPackagedCopilotSettings } = await import('./copilot-settings-smoke.ts')
  const { _electron } = await import('playwright')
  const env = { ...desktopSmokeEnvironment(home), DSH_TELEMETRY_DISABLED: '1' }
  const rounds = values.phase === 'baseline' ? ['baseline'] : ['candidate', 'candidate-restart']
  for (const round of rounds) {
    let app
    let page
    let roundFailure
    const errors = []
    const secondaryErrors = []
    try {
      app = await _electron.launch({ executablePath: application, args: [`--user-data-dir=${userData}`], env, timeout: 120_000 })
      const identity = await app.evaluate(({ app }) => ({ executable: process.execPath, userData: app.getPath('userData'), version: app.getVersion(), packaged: app.isPackaged }))
      assert.equal(resolve(identity.executable).toLowerCase(), application.toLowerCase())
      assert.equal(resolve(identity.userData).toLowerCase(), userData.toLowerCase())
      assert.equal(identity.version, expected.manifest.version)
      assert.equal(identity.packaged, true)
      const runtimeText = await app.evaluate(async () => {
        const { readFile } = await import('node:fs/promises')
        const { join } = await import('node:path')
        return readFile(join(process.resourcesPath, 'app.asar', 'dsh', 'desktop-runtime.json'), 'utf8')
      })
      assert.equal(hash(runtimeText), expected.manifest.installedEvidence.runtimeSha256)
      const expectedUrl = values.phase === 'baseline' ? baseline.applicationUrl : 'dsh-app://app/'
      page = await app.firstWindow()
      page.setDefaultTimeout(120_000)
      page.on('pageerror', error => errors.push(safeError(error)))
      await page.waitForFunction(url => location.href === url || Boolean(document.querySelector('#error:not([hidden])')?.textContent?.trim()), expectedUrl, { timeout: 300_000 })
      assert.equal(page.url(), expectedUrl, 'Installed application did not reach its version-owned URL')
      await page.getByRole('button', { name: 'Settings', exact: true }).click()
      const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
      await settings.getByRole('button', { name: 'Models', exact: true }).click()
      const account = settings.locator('[data-dsh-github-copilot-compact-account]')
      await account.getByRole('button', { name: 'Sign in with GitHub', exact: true }).waitFor({ state: 'visible' })
      const settingsEvidence = await inspectPackagedCopilotSettings(settings)
      await page.screenshot({ path: join(evidence, `${round}-models.png`) })
      if (round === 'baseline') {
        save(join(root, 'baseline-ready.json'), { ownerToken: owner.token, pid: app.process().pid, application })
        const deadline = Date.now() + 600_000
        while (!existsSync(join(root, 'baseline-finish-request.json'))) {
          assert.ok(Date.now() < deadline, 'Native driver did not finish its running-app refusal case')
          assert.equal(app.process().exitCode, null, 'Baseline exited during installer refusal')
          await delay(250)
        }
        assert.equal(json(join(root, 'baseline-finish-request.json')).ownerToken, owner.token)
        assert.equal(app.process().exitCode, null)
        assert.equal(page.url(), expectedUrl)
        await account.getByRole('button', { name: 'Sign in with GitHub', exact: true }).waitFor({ state: 'visible' })
        await page.screenshot({ path: join(evidence, 'baseline-after-refusal.png') })
      }
      assert.deepEqual(errors, [], 'Installed page reported JavaScript errors')
      assert.equal(upgradeFileHash(retained), json(join(root, 'retained.json')).envSha256)
      await app.close()
      app = undefined
      save(join(evidence, `${round}.json`), {
        sourceCommit: expected.manifest.source.commit, version: expected.manifest.version,
        executableSha256: upgradeFileHash(application), runtimeSha256: hash(runtimeText),
        actualInstalledApplication: true, actualHostSettingsViews: settingsEvidence,
        sameRetainedHome: true, retainedEnvSha256: upgradeFileHash(retained), isolatedUserData: true,
        pluginUserChoicesVerified: false, draftAttachmentRefusalVerified: false,
        realOAuth: false, realModelRound: false, managedHandoffVerified: false,
      })
    } catch (error) {
      roundFailure = error
    } finally {
      try { await app?.close() }
      catch (error) { roundFailure = retainPrimaryFailure(roundFailure, error, 'round-owned-close', secondaryErrors) }
      if (roundFailure !== undefined) {
        try { save(join(evidence, `${round}-failure.json`), { error: safeError(roundFailure), pageErrors: errors, secondaryErrors }) }
        catch (error) {
          roundFailure = retainPrimaryFailure(roundFailure, error, 'round-failure-evidence-write', secondaryErrors)
          console.error('Installed acceptance secondary failures:', secondaryErrors)
        }
      }
    }
    if (roundFailure !== undefined) throw roundFailure
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(safeError(error)); process.exitCode = 1 })
}
