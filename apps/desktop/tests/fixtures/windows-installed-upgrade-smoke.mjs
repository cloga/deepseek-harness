/** Actual installed Desktop observations; execution is restricted to disposable GitHub Windows runners. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { assertUpgradeRunner, installedUpgradeApplication, ownedUpgradePath, pinnedUpgradeSourceCommit, upgradeFileHash, verifyUpgradeRelease } from './windows-installed-upgrade-contract.mjs'
import { retainPrimaryFailure } from './windows-packaged-package-acceptance.mjs'
import { inspectInstalledDesktopIdentity, readInstalledDesktopRuntimeDescriptor } from './windows-installed-runtime.mjs'

const baseline = JSON.parse(readFileSync(new URL('./windows-upgrade-baseline.json', import.meta.url), 'utf8'))
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const safeError = error => String(error).replace(/(https?:\/\/[^?\s"'<>]+)\?[^\s"'<>]*/gu, '$1?[redacted]')

export function inspectInstalledPageDiagnostic() {
  const codec = {
    utf8Bytes(value) {
      let bytes = 0
      for (const character of value) {
        const point = character.codePointAt(0)
        bytes += point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
      }
      return bytes
    },
    redact(value) {
      return value
        .replace(/\b((?:https?|wss?|dsh-app):\/\/)[^/@\s?#]+@/giu, '$1')
        .replace(/\b((?:https?|wss?|dsh-app):\/\/[^?\s#]+)[?#][^\s]*/giu, '$1?[redacted]')
        .replace(/(["']?(?:authorization|token|password|api[-_ ]?key|client[-_ ]?secret|github[-_ ]?token)["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:bearer|basic)\s+[^\s,;&}]+|[^\s,;&}]+)/giu, '$1[redacted]')
        .replace(/\b(?:github_pat_[a-z0-9_]+|gh[pousr]_[a-z0-9]+)\b/giu, '[redacted]')
    },
    retain(value, limit) {
      const redacted = codec.redact(value)
      let text = ''
      let bytes = 0
      for (const character of redacted) {
        const point = character.codePointAt(0)
        const size = point <= 0x7f ? 1 : point <= 0x7ff ? 2 : point <= 0xffff ? 3 : 4
        if (bytes + size > limit) break
        text += character
        bytes += size
      }
      return { text, redacted: redacted !== value, truncated: bytes < codec.utf8Bytes(redacted) }
    },
  }

  const rawUrl = String(location.href)
  let sanitizedUrl
  try {
    const parsed = new URL(rawUrl)
    parsed.username = ''
    parsed.password = ''
    parsed.search = ''
    parsed.hash = ''
    sanitizedUrl = parsed.toString()
  } catch {
    sanitizedUrl = rawUrl.replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/iu, '$1[redacted]@').split(/[?#]/u, 1)[0]
  }
  const retainedUrl = codec.retain(sanitizedUrl, 2048)
  const main = document.querySelector('main')
  const error = document.querySelector('#error')
  const style = error === null ? null : getComputedStyle(error)
  const box = error === null ? null : error.getBoundingClientRect()
  const width = box !== null && Number.isFinite(box.width) ? box.width : null
  const height = box !== null && Number.isFinite(box.height) ? box.height : null
  const rectCountValue = error === null ? null : error.getClientRects().length
  const rectCount = Number.isSafeInteger(rectCountValue) && rectCountValue >= 0 ? rectCountValue : null
  const rawText = error === null ? '' : String(error.textContent ?? '')
  const retainedText = codec.retain(rawText, 8192)
  const readyState = ['loading', 'interactive', 'complete'].includes(document.readyState) ? document.readyState : 'unknown'
  const errorHidden = error === null ? null : Boolean(error.hidden)
  const display = style === null || typeof style.display !== 'string' ? null : style.display.slice(0, 64)
  const visibility = style === null || typeof style.visibility !== 'string' ? null : style.visibility.slice(0, 64)
  const ariaBusyPresent = main !== null && main.hasAttribute('aria-busy')
  const ariaBusy = ariaBusyPresent ? codec.retain(String(main.getAttribute('aria-busy')), 256) : null
  return {
    url: retainedUrl.text, urlRawBytes: codec.utf8Bytes(rawUrl), urlRedacted: sanitizedUrl !== rawUrl || retainedUrl.redacted, urlTruncated: retainedUrl.truncated,
    readyState,
    mainPresent: main !== null, mainAriaBusyPresent: ariaBusyPresent, mainAriaBusyValue: ariaBusy?.text ?? null,
    errorPresent: error !== null, errorHidden, errorDisplay: display, errorVisibility: visibility,
    errorWidth: width, errorHeight: height, errorClientRectCount: rectCount,
    errorRendered: error !== null && !errorHidden && display !== 'none' && visibility !== 'hidden' && visibility !== 'collapse' && width !== null && width > 0 && height !== null && height > 0 && rectCount !== null && rectCount > 0,
    errorText: retainedText.text, errorTextRawBytes: codec.utf8Bytes(rawText), errorTextRedacted: retainedText.redacted, errorTextTruncated: retainedText.truncated,
  }
}

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
  const application = installedUpgradeApplication(root)
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
  const inspectSettings = values.phase === 'baseline'
    ? (await import('./baseline-copilot-settings-smoke.ts')).inspectBaselinePackagedCopilotSettings
    : (await import('./copilot-settings-smoke.ts')).inspectPackagedCopilotSettings
  const { _electron } = await import('playwright')
  const env = { ...desktopSmokeEnvironment(home), DSH_TELEMETRY_DISABLED: '1' }
  const rounds = values.phase === 'baseline' ? ['baseline'] : ['candidate', 'candidate-restart']
  for (const round of rounds) {
    let app
    let page
    let roundFailure
    let failureSnapshot = null
    const errors = []
    const secondaryErrors = []
    try {
      app = await _electron.launch({ executablePath: application, args: [`--user-data-dir=${userData}`], env, timeout: 120_000 })
      const identity = await app.evaluate(inspectInstalledDesktopIdentity)
      assert.equal(resolve(identity.executable).toLowerCase(), application.toLowerCase())
      assert.equal(resolve(identity.userData).toLowerCase(), userData.toLowerCase())
      assert.equal(identity.version, expected.manifest.version)
      assert.equal(identity.packaged, true)
      const runtimeBytes = readInstalledDesktopRuntimeDescriptor(application, identity.resourcesPath, expected.manifest.installedEvidence.executableSha256)
      assert.equal(hash(runtimeBytes), expected.manifest.installedEvidence.runtimeSha256)
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
      const settingsEvidence = await inspectSettings(settings)
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
        executableSha256: upgradeFileHash(application), runtimeSha256: hash(runtimeBytes),
        actualInstalledApplication: true, actualHostSettingsViews: settingsEvidence,
        sameRetainedHome: true, retainedEnvSha256: upgradeFileHash(retained), isolatedUserData: true,
        pluginUserChoicesVerified: false, draftAttachmentRefusalVerified: false,
        realOAuth: false, realModelRound: false, managedHandoffVerified: false,
      })
    } catch (error) {
      roundFailure = error
    } finally {
      if (roundFailure !== undefined && page !== undefined) {
        try { failureSnapshot = await page.evaluate(inspectInstalledPageDiagnostic) }
        catch { roundFailure = retainPrimaryFailure(roundFailure, new Error('DOM diagnostic capture failed'), 'round-failure-dom-diagnostic', secondaryErrors) }
      }
      try { await app?.close() }
      catch (error) { roundFailure = retainPrimaryFailure(roundFailure, error, 'round-owned-close', secondaryErrors) }
      if (roundFailure !== undefined) {
        try { save(join(evidence, `${round}-failure.json`), { error: safeError(roundFailure), pageErrors: errors, secondaryErrors, snapshot: failureSnapshot }) }
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
