/** Real installed Desktop package UI acceptance, exclusively on disposable hosted Windows runners. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, copyFileSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { assertUpgradeRunner, installedUpgradeApplication, ownedUpgradePath, upgradeFileHash } from './windows-installed-upgrade-contract.mjs'

const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
const fixtureName = '@fixture/bundle'
const fixtureFiles = ['package.json', 'index.js', 'cordis.patch.yml']
const dialogUrl = 'dsh-app://shell/update-dialog.html'
const readJson = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/u, ''))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
const save = (path, value) => writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' })
const safeError = error => String(error).replace(/(https?:\/\/[^?\s"'<>]+)\?[^\s"'<>]*/gu, '$1?[redacted]')

/** Hash files and link spellings without following package junctions. This reader never repairs a graph.
 * @param {string} root - Real profile or private candidate directory.
 * @returns {{fingerprint: string, entries: object[]}} Bounded ordered inventory and its exact digest.
 */
export function packageGraphSnapshot(root) {
  assert.ok(lstatSync(root).isDirectory() && !lstatSync(root).isSymbolicLink(), 'Graph root must be an owned real directory')
  const entries = []
  let bytes = 0
  const visit = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const key = relative(root, path).split(sep).join('/')
      const stat = lstatSync(path)
      assert.ok(entries.length < 100_000, 'Graph inventory exceeds its entry bound')
      if (stat.isSymbolicLink()) entries.push({ path: key, kind: 'link', target: readlinkSync(path) })
      else if (stat.isDirectory()) { entries.push({ path: key, kind: 'directory' }); visit(path) }
      else {
        assert.ok(stat.isFile(), 'Graph contains a special file')
        bytes += stat.size
        assert.ok(bytes <= 512 * 1024 * 1024, 'Graph inventory exceeds its byte bound')
        entries.push({ path: key, kind: 'file', sha256: hash(readFileSync(path)) })
      }
    }
  }
  visit(root)
  return { fingerprint: hash(JSON.stringify(entries)), entries }
}

/** Require one UUID in the official pending notice, not an unrelated toast.
 * @param {string} text - Actual pending notice rendered by Plugin Manager.
 * @returns {string} Exactly one lowercase transaction UUID.
 */
export function preparedTransactionId(text) {
  const ids = [...text.matchAll(/Transaction ([a-f0-9-]{36}) is staged privately\./gu)].map(match => match[1])
  assert.equal(ids.length, 1, 'Expected exactly one official prepared transaction notice')
  assert.match(ids[0], uuid)
  return ids[0]
}

/** Same numerical PID is not sufficient to identify a process incarnation.
 * @param {object | undefined} left - Earlier owned process observation.
 * @param {object | undefined} right - Later owned process observation.
 * @returns {boolean} Whether PID, parent, executable and exact start time match.
 */
export function sameProcess(left, right) {
  return left !== undefined && right !== undefined && left.pid === right.pid && left.parentPid === right.parentPid && left.created === right.created
    && typeof left.executable === 'string' && left.executable.toLowerCase() === right.executable?.toLowerCase()
}

/** Keep graph promotion and enabled target health separate, and never synthesize unexercised acceptance claims.
 * @param {string} sourceCommit - Reviewed candidate source identity.
 * @returns {object} An entirely unverified report; assertions advance individual flags.
 */
export function initialPackageAcceptance(sourceCommit) {
  return {
    schemaVersion: 1, sourceCommit, scope: 'candidate-installed-desktop-same-version-isolated-home',
    succeeded: false, preparedGraphVerified: false, declinePreservedGraphVerified: false, discardPreservedGraphVerified: false,
    liveDraftAttachmentVetoVerified: false, attachmentOnlyVetoVerified: false, draftOnlyVetoVerified: false,
    consentGraphPromotionVerified: false, newHostGenerationVerified: false, installedDisabledAfterConsentVerified: false,
    enabledFixtureRunningAfterSeparateRestartVerified: false,
    copilotDisabledChoiceAcrossRestartVerified: false, copilotRemovalChoiceAcrossRestartVerified: false,
    zeroModelRequestsVerified: false, cleanupVerified: false,
    newlyInstalledTargetHealthyAtFirstConsent: false, verifiedGithubReleaseReceiptForFixture: false,
    choicesAcrossInstallerUpgradeVerified: false, draftPersistedAcrossQuitVerified: false,
    promotionFailureRollbackVerified: false, managedHandoffVerified: false,
  }
}

/** Require qualified ownership and observed exit for every attempted launch, including rejected launches.
 * @param {object[]} launches - Records allocated before each Electron launch request.
 * @param {number} activeHelpers - Native helpers whose close event has not arrived.
 * @param {string[]} cleanupErrors - Failures encountered while reaching quiescence.
 * @returns {boolean} Whether cleanup is positively established, never vacuously true after an unclaimed launch.
 */
export function packageCleanupVerified(launches, activeHelpers, cleanupErrors) {
  return launches.length > 0 && launches.every(launch => launch.launchReturned === true && launch.bound === true && launch.exited === true)
    && activeHelpers === 0 && cleanupErrors.length === 0
}

/** Preserve the first failure while recording a later cleanup or evidence failure separately.
 * @param {unknown} primary - First failure, or undefined before any failure.
 * @param {unknown} error - Later failure.
 * @param {string} stage - Bounded fixture-owned operation label.
 * @param {object[]} secondary - Mutable fixture-owned diagnostic list.
 * @returns {unknown} The original primary, or the new error if no primary existed.
 */
export function retainPrimaryFailure(primary, error, stage, secondary) {
  secondary.push({ stage, error: safeError(error) })
  return primary === undefined ? error : primary
}

/** Only the unchanged, explicitly private inert Web fixture may be archived by this lane.
 * @param {object} manifest - Existing fixture package metadata; never a replacement official package.
 */
export function validatePackageFixture(manifest) {
  assert.equal(manifest.name, fixtureName)
  assert.equal(manifest.version, '0.0.1')
  assert.equal(manifest.private, true)
  assert.equal(manifest.type, 'module')
  assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
  for (const field of ['scripts', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.equal(manifest[field], undefined, `Acceptance fixture must not declare ${field}`)
  }
}

async function until(label, observe, predicate, milliseconds = 120_000) {
  const deadline = Date.now() + milliseconds
  let value
  do {
    value = await observe()
    if (predicate(value)) return value
    await delay(150)
  } while (Date.now() < deadline)
  throw new Error(`Acceptance deadline: ${label}`)
}

/** Execute the actual UI scenario. Imports which can start providers/browsers occur only after the runner guard.
 * @param {string} runRoot - Existing phase1-owned root containing exact candidate validation and installation.
 * @returns {Promise<object>} Separately scoped evidence after all owned process exits are checked.
 */
export async function runPackagedPackageAcceptance(runRoot) {
  assertUpgradeRunner(process.env)
  assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/u)
  const root = ownedUpgradePath(process.env.RUNNER_TEMP, runRoot)
  const owner = readJson(join(root, 'owner.json'))
  const validated = readJson(join(root, 'validated.json'))
  assert.equal(owner.runId, process.env.GITHUB_RUN_ID)
  assert.equal(owner.runAttempt, process.env.GITHUB_RUN_ATTEMPT)
  assert.match(owner.token, uuid)
  assert.equal(validated.ownerToken, owner.token)
  const expected = validated.candidate.manifest
  assert.equal(expected.source.commit, process.env.GITHUB_SHA)
  assert.equal(expected.upstreamVersion, '0.1.6-alpha.2')
  const application = installedUpgradeApplication(root)
  assert.equal(upgradeFileHash(application), expected.installedEvidence.executableSha256)
  assert.equal(upgradeFileHash(validated.candidate.manifestPath), validated.candidate.manifestFileSha256)
  const home = ownedUpgradePath(root, join(root, 'package-home'))
  const userData = ownedUpgradePath(root, join(root, 'package-electron-user-data'))
  const workspace = ownedUpgradePath(root, join(root, 'package-workspace'))
  const data = ownedUpgradePath(root, join(root, 'package-fixture-data'))
  const evidence = ownedUpgradePath(root, join(root, 'evidence'))
  for (const directory of [home, userData, workspace, data]) {
    assert.equal(existsSync(directory), false, 'Package acceptance requires new isolated state')
    mkdirSync(directory)
  }
  writeFileSync(join(home, '.env'), '# Hosted package acceptance: no credentials\n', { flag: 'wx' })
  writeFileSync(join(home, 'settings.yaml'), 'ui-onboarding:\n  welcomeNoticeVersion: "2026-08-13.1"\n', { flag: 'wx' })
  const profile = join(home, 'profiles', 'desktop')
  const report = initialPackageAcceptance(expected.source.commit)
  const checkpoints = []
  const shells = []
  const children = new Set()
  const secondaryErrors = []
  let app
  let page
  let boundPid
  let mock
  let errors = []
  let failure
  let navigationCount = 0
  const { desktopSmokeEnvironment } = await import('../../scripts/smoke-environment.ts')
  const environment = { ...desktopSmokeEnvironment(home), DSH_TELEMETRY_DISABLED: '1' }
  const nativeEnvironment = { ...environment }
  for (const key of ['GITHUB_ACTIONS', 'RUNNER_OS', 'RUNNER_ENVIRONMENT', 'RUNNER_TEMP', 'GITHUB_RUN_ID', 'GITHUB_RUN_ATTEMPT', 'GITHUB_SHA']) nativeEnvironment[key] = process.env[key]
  const native = async (action, pid = boundPid) => {
    assert.equal(children.size, 0, 'A previous native helper has not acknowledged exit')
    assert.ok(Number.isSafeInteger(pid) && pid > 0, 'Native action requires the launched shell PID')
    const requestId = randomUUID()
    const path = join(evidence, `package-native-${requestId}.json`)
    const executable = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    const diagnostic = openSync(join(evidence, `package-native-${requestId}.stderr.txt`), 'wx', 0o600)
    let child
    let nativeStartFailure
    try {
      child = spawn(executable, ['-NoProfile', '-NonInteractive', '-File', join(repository, 'apps/desktop/tests/windows-desktop-ui.ps1'),
        '-Action', action, '-RunRoot', root, '-OwnerToken', owner.token, '-RequestId', requestId,
        '-ShellPid', String(pid), '-FixturePid', String(process.pid)], { env: nativeEnvironment, windowsHide: true, stdio: ['ignore', 'ignore', diagnostic] })
      children.add(child)
    } catch (error) { nativeStartFailure = error }
    try { closeSync(diagnostic) }
    catch (error) { nativeStartFailure = retainPrimaryFailure(nativeStartFailure, error, 'native-diagnostic-close', secondaryErrors) }
    if (child === undefined) throw nativeStartFailure
    await new Promise((resolveExit, reject) => {
      let timedOut = false
      let spawnError
      let terminationDeadline
      const timer = setTimeout(() => {
        timedOut = true
        try { child.kill() }
        catch (error) { secondaryErrors.push({ stage: 'native-timeout-stop', error: safeError(error) }) }
        terminationDeadline = setTimeout(() => { reject(new Error(`Native ${action} termination is unconfirmed; no competing native action is allowed`)) }, 10_000)
      }, 60_000)
      child.once('error', error => { spawnError = error })
      child.once('close', code => {
        children.delete(child)
        clearTimeout(timer)
        clearTimeout(terminationDeadline)
        if (timedOut) reject(new Error(`Native ${action} timed out and its exit was acknowledged; inspect ${path}`))
        else if (spawnError !== undefined) reject(spawnError)
        else if (code === 0) resolveExit()
        else reject(new Error(`Native ${action} failed (${code}); inspect ${path} and its stderr file`))
      })
    }).catch(error => { throw retainPrimaryFailure(nativeStartFailure, error, 'native-helper-completion', secondaryErrors) })
    if (nativeStartFailure !== undefined) throw nativeStartFailure
    const response = readJson(path)
    assert.equal(response.ownerToken, owner.token)
    assert.equal(response.requestId, requestId)
    assert.equal(response.action, action)
    assert.equal(response.succeeded, true)
    return response.result
  }
  const checkpoint = async (name, facts) => {
    assert.deepEqual(errors, [], 'Real product page reported JavaScript errors')
    assert.equal(mock.requests.length, 0, 'An unsent-input acceptance must not request model output')
    assert.equal(mock.paths.length, 0, 'The declared local catalog must not need discovery or model requests')
    await page.screenshot({ path: join(evidence, `package-${name}.png`) })
    const record = { name, ...facts }
    checkpoints.push(record)
    save(join(evidence, `package-${name}.json`), record)
  }
  const currentHost = async () => {
    const observed = await native('Observe')
    assert.equal(observed.hosts.length, 1, 'Expected one actual Desktop Host')
    return { shell: observed.shell, host: observed.hosts[0] }
  }
  const launch = async label => {
    assert.equal(app, undefined)
    // A launcher may spawn Electron and reject before returning its handle. Such an attempt remains unqualified.
    const shellRecord = { launchId: randomUUID(), label, launchReturned: false, pid: null, bound: false, exited: false }
    shells.push(shellRecord)
    app = await (await import('playwright'))._electron.launch({ executablePath: application, args: [`--user-data-dir=${userData}`], env: environment, timeout: 120_000 })
    shellRecord.launchReturned = true
    boundPid = app.process().pid
    shellRecord.pid = boundPid
    const bindingPath = join(root, `package-shell-${boundPid}.json`)
    const bindingAlreadyExisted = existsSync(bindingPath)
    let bindFailure
    try { await native('Bind') }
    catch (error) { bindFailure = error }
    try {
      // A partial Bind can have established an exact shell handle identity before a later observation failed.
      if (!bindingAlreadyExisted && existsSync(bindingPath)) {
        const recorded = readJson(bindingPath)
        assert.equal(recorded.ownerToken, owner.token)
        assert.equal(recorded.fixture.pid, process.pid)
        assert.equal(recorded.shell.pid, boundPid)
        shellRecord.bound = true
      }
    } catch (error) { bindFailure = retainPrimaryFailure(bindFailure, error, 'bind-evidence-read', secondaryErrors) }
    if (bindFailure !== undefined) throw bindFailure
    const identity = await app.evaluate(({ app }) => ({ executable: process.execPath, userData: app.getPath('userData'), packaged: app.isPackaged, version: app.getVersion() }))
    assert.equal(resolve(identity.executable).toLowerCase(), application.toLowerCase())
    assert.equal(resolve(identity.userData).toLowerCase(), userData.toLowerCase())
    assert.equal(identity.packaged, true)
    assert.equal(identity.version, expected.version)
    const runtime = await app.evaluate(async () => {
      const { readFile } = await import('node:fs/promises')
      const { join } = await import('node:path')
      return readFile(join(process.resourcesPath, 'app.asar', 'dsh', 'desktop-runtime.json'), 'utf8')
    })
    assert.equal(hash(runtime), expected.installedEvidence.runtimeSha256)
    errors = []
    page = await app.firstWindow()
    page.setDefaultTimeout(120_000)
    page.on('pageerror', error => errors.push(safeError(error)))
    const launchedPage = page
    page.on('framenavigated', frame => { if (frame === launchedPage.mainFrame()) navigationCount++ })
    await page.waitForFunction(() => location.href === 'dsh-app://app/' || Boolean(document.querySelector('#error:not([hidden])')?.textContent?.trim()), undefined, { timeout: 300_000 })
    assert.equal(page.url(), 'dsh-app://app/', `Actual installed product startup failed in ${label}`)
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
    assert.equal(await page.locator('html').getAttribute('lang'), 'en', 'Native acceptance currently qualifies English Windows/UI copy only')
    await until('one real Host', () => native('Observe'), value => value.hosts.length === 1)
    return currentHost()
  }
  const openNativeMenu = async action => {
    const trigger = page.locator('[data-windows-menu]').getByRole('menubar', { name: 'Application menu' }).getByRole('menuitem', { name: 'Application', exact: true })
    // Native modal loops can delay the renderer click acknowledgement; arm the owned control waiter first.
    const [, clickError] = await Promise.all([native(action), trigger.click().then(() => undefined, error => error)])
    if (clickError !== undefined) {
      if (action !== 'Exit' || !/Target.*closed|page.*closed/iu.test(String(clickError))) throw clickError
      // Only the genuinely invoked native Exit followed by actual process exit can explain a closed click target.
      await until('shell exited after native menu selection', () => app.process().exitCode, value => value !== null, 60_000)
    }
  }
  const closeNormally = async () => {
    await native('Observe')
    const child = app.process()
    await openNativeMenu('Exit')
    await until('owned shell exit', () => child.exitCode, value => value !== null, 60_000)
    await native('VerifyExited')
    shells.find(shell => shell.pid === boundPid).exited = true
    app = undefined
    page = undefined
    boundPid = undefined
  }
  const openPlugins = async () => {
    await page.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
    const panel = page.locator('[data-plugin-panel]')
    await panel.getByRole('heading', { name: 'Plugins', exact: true }).waitFor()
    return panel
  }
  const card = name => page.locator(`[data-plugin-package="${name}"]`)
  const pendingNotice = () => page.locator('[data-plugin-panel]').getByRole('status').filter({ hasText: ' is staged privately.' })
  const prepared = id => {
    assert.match(id, uuid)
    const directory = ownedUpgradePath(home, join(home, 'profiles', `.desktop.package-stage-${id}`))
    const value = readJson(join(directory, 'PREPARED.json'))
    assert.equal(value.owner.profile.toLowerCase(), profile.toLowerCase())
    assert.equal(value.result.transactionId, id)
    assert.equal(value.result.state, 'prepared')
    assert.equal(value.result.health, 'pending')
    return { directory, value }
  }
  const stageFixture = async archive => {
    const panel = await openPlugins()
    await panel.getByRole('button', { name: 'Add plugin', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Add plugin', exact: true })
    await dialog.getByRole('textbox', { name: 'Package name or address', exact: true }).fill(archive)
    await dialog.getByRole('button', { name: 'Install', exact: true }).click()
    const done = page.getByRole('dialog', { name: 'Prepared, not activated', exact: true })
    await done.waitFor({ timeout: 300_000 })
    const id = preparedTransactionId(await done.getByRole('status').filter({ hasText: ' is staged privately.' }).innerText())
    await done.getByRole('button', { name: 'Done', exact: true }).click()
    await pendingNotice().filter({ hasText: id }).waitFor()
    return id
  }
  const review = async () => {
    await openNativeMenu('ReviewPackages')
    return until('real shell consent document', async () => {
      for (const window of app.windows()) if (window.url() === dialogUrl) return window
      return undefined
    }, window => window !== undefined, 30_000)
  }
  const decline = async id => {
    const window = await review()
    await window.getByText(`Transaction: ${id}`, { exact: false }).waitFor()
    await window.getByRole('button', { name: 'Update later', exact: true }).click()
    await until('consent closed', () => window.isClosed(), Boolean, 30_000)
  }
  const accept = async (id, before, expectedName) => {
    const window = await review()
    await window.getByText(`Transaction: ${id}`, { exact: false }).waitFor()
    await window.getByText(`Review ${expectedName}`, { exact: false }).waitFor()
    const previousNavigation = navigationCount
    await window.getByRole('button', { name: 'Activate and restart Host', exact: true }).click()
    const transaction = prepared(id)
    await until('health-qualified activation commit', () => {
      const path = join(transaction.directory, 'ACTIVATION.json')
      return existsSync(path) ? readJson(path) : undefined
    }, journal => journal?.phase === 'committed', 300_000)
    await until('replacement document navigation', () => navigationCount, value => value > previousNavigation)
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor()
    const after = await currentHost()
    assert.ok(sameProcess(before.shell, after.shell), 'Package activation must retain the shell incarnation')
    assert.equal(sameProcess(before.host, after.host), false, 'Package activation must replace the real Host incarnation')
    assert.equal(packageGraphSnapshot(profile).fingerprint, transaction.value.candidateFingerprint)
    assert.equal(existsSync(join(transaction.directory, 'rollback')), true, 'Activation must retain its rollback graph')
    return after
  }
  const writeDraft = async text => {
    const input = page.locator('[data-composer-input][contenteditable="true"]').first()
    await input.waitFor()
    await input.click()
    await page.keyboard.press('Control+A')
    if (text === '') await page.keyboard.press('Backspace')
    else await page.keyboard.type(text)
    await until('real draft text', () => input.innerText(), value => value.trim() === text)
    return input
  }
  const assertPreserved = async (id, snapshot, host, candidateHash) => {
    assert.equal(packageGraphSnapshot(profile).fingerprint, snapshot.fingerprint)
    assert.ok(sameProcess(host.host, (await currentHost()).host), 'Refusal/discard changed the live Host')
    const transaction = prepared(id)
    assert.equal(packageGraphSnapshot(join(transaction.directory, 'profile')).fingerprint, candidateHash)
    assert.equal(existsSync(join(transaction.directory, 'ACTIVATION.json')), false)
  }
  try {
    const { mockServer } = await import('../../../../packages/llm/llm-pi-ai/tests/mock-server.ts')
    mock = await mockServer([])
    await launch('initial')
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await settings.getByRole('button', { name: 'Models', exact: true }).click()
    await settings.locator('[data-dsh-github-copilot-compact-account]').getByRole('button', { name: 'Sign in with GitHub', exact: true }).waitFor()
    await settings.getByRole('button', { name: 'Add a custom provider', exact: true }).click()
    await settings.getByLabel('Provider ID', { exact: true }).fill('desktop-acceptance')
    await settings.getByLabel('Display name', { exact: true }).fill('Desktop acceptance (local test)')
    await settings.getByLabel('API protocol', { exact: true }).selectOption('openai-completions')
    await settings.getByLabel('Base URL', { exact: true }).fill(mock.url)
    await settings.getByRole('button', { name: 'Add model', exact: true }).click()
    await settings.getByLabel('Model ID 1', { exact: true }).fill('acceptance-local')
    await settings.getByRole('button', { name: 'Create provider', exact: true }).click()
    await settings.getByText('Desktop acceptance (local test)', { exact: true }).first().waitFor()
    await page.keyboard.press('Escape')
    await settings.waitFor({ state: 'hidden' })
    await Promise.all([native('ChooseWorkspace'), page.getByRole('textbox', { name: 'Choose workspace', exact: true }).click()])
    const modelTrigger = page.getByRole('button', { name: /^Select model, current/ })
    await modelTrigger.click()
    await page.getByRole('menuitem', { name: /^Model\b/ }).click()
    await page.getByRole('menuitemradio', { name: 'acceptance-local', exact: true }).click()
    await page.locator('[data-composer-input][contenteditable="true"]').first().waitFor()
    assert.ok(readFileSync(join(home, 'settings.yaml'), 'utf8').includes('desktop-acceptance'))
    await checkpoint('keyless-composer', { legitimateProviderConfiguration: true, realWorkspacePicker: true, provider: 'desktop-acceptance', model: 'acceptance-local', providerRequests: 0 })

    const source = join(repository, 'apps/web/tests/fixtures/plugins/fixture-bundle')
    validatePackageFixture(readJson(join(source, 'package.json')))
    const archiveSource = join(data, 'package')
    mkdirSync(archiveSource)
    const fileHashes = {}
    for (const name of fixtureFiles) {
      copyFileSync(join(source, name), join(archiveSource, name))
      fileHashes[name] = upgradeFileHash(join(source, name))
      assert.equal(upgradeFileHash(join(archiveSource, name)), fileHashes[name])
    }
    const archive = join(data, 'local-web-e2e-fixture-bundle-0.0.1.tgz')
    await (await import('tar')).c({ gzip: true, file: archive, cwd: data, portable: true }, ['package'])
    save(join(evidence, 'package-local-fixture.json'), { name: fixtureName, version: '0.0.1', private: true, localTestFixtureOnly: true,
      upstreamRelease: false, scripts: false, dependencies: false, source: 'apps/web/tests/fixtures/plugins/fixture-bundle', files: fileHashes, archiveSha256: upgradeFileHash(archive) })
    const original = packageGraphSnapshot(profile)
    const originalHost = await currentHost()
    const first = await stageFixture(archive)
    const firstPrepared = prepared(first)
    assert.equal(firstPrepared.value.mutation.enabled, false)
    assert.equal(firstPrepared.value.result.packageName, fixtureName)
    assert.equal(firstPrepared.value.baseGraphFingerprint, original.fingerprint)
    const firstCandidate = packageGraphSnapshot(join(firstPrepared.directory, 'profile'))
    assert.equal(firstCandidate.fingerprint, firstPrepared.value.candidateFingerprint)
    assert.equal(readJson(join(profile, 'package.json')).dependencies?.[fixtureName], undefined)
    assert.equal(await card(fixtureName).count(), 0)
    await assertPreserved(first, original, originalHost, firstCandidate.fingerprint)
    report.preparedGraphVerified = true
    await checkpoint('prepared-disabled', { transactionId: first, activeFingerprint: original.fingerprint, candidateFingerprint: firstCandidate.fingerprint, host: originalHost, newlyInstalledTargetEnabled: false })
    await decline(first)
    await assertPreserved(first, original, originalHost, firstCandidate.fingerprint)
    report.declinePreservedGraphVerified = true
    await checkpoint('declined', { transactionId: first, activeFingerprint: original.fingerprint, host: originalHost })
    await pendingNotice().filter({ hasText: first }).getByRole('button', { name: 'Discard prepared change', exact: true }).click()
    await until('private candidate discarded', () => existsSync(join(firstPrepared.directory, 'DISCARDED.json')) ? readJson(join(firstPrepared.directory, 'DISCARDED.json')) : undefined, value => value?.state === 'discarded')
    assert.equal(existsSync(join(firstPrepared.directory, 'profile')), false)
    assert.equal(packageGraphSnapshot(profile).fingerprint, original.fingerprint)
    assert.ok(sameProcess(originalHost.host, (await currentHost()).host))
    await pendingNotice().filter({ hasText: first }).waitFor({ state: 'hidden' })
    report.discardPreservedGraphVerified = true
    await checkpoint('discarded', { transactionId: first, activeFingerprint: original.fingerprint })

    const second = await stageFixture(archive)
    assert.notEqual(second, first)
    const secondPrepared = prepared(second)
    const candidateHash = packageGraphSnapshot(join(secondPrepared.directory, 'profile')).fingerprint
    await page.getByRole('button', { name: 'New session', exact: true }).first().click()
    const text = `Unsent package acceptance draft ${owner.token}`
    const attachmentName = 'package-acceptance-unsent.txt'
    const attachmentBytes = Buffer.from('Local unsent attachment; never sent to a model.\n')
    const input = await writeDraft(text)
    await page.locator('input[type="file"]').setInputFiles({ name: attachmentName, mimeType: 'text/plain', buffer: attachmentBytes })
    const rail = page.getByRole('group', { name: 'Pending attachments', exact: true })
    await rail.getByTitle(attachmentName, { exact: true }).waitFor()
    await until('real attachment upload receipt', () => page.getByRole('button', { name: 'Send message', exact: true }).isEnabled(), Boolean)
    const attachmentView = await rail.innerText()
    const stableNavigation = navigationCount
    const veto = async (name, expectedDraft, attachment) => {
      const window = await review()
      await window.getByText('Package activation needs attention.', { exact: false }).waitFor()
      await window.getByText('Restart is blocked by unsent or unconfirmed input.', { exact: false }).waitFor()
      assert.equal(await window.getByRole('button', { name: 'Activate and restart Host', exact: true }).count(), 0)
      await window.getByRole('button', { name: 'OK', exact: true }).click()
      await until('refusal closed', () => window.isClosed(), Boolean, 30_000)
      assert.equal((await input.innerText()).trim(), expectedDraft)
      assert.equal(await rail.getByTitle(attachmentName, { exact: true }).count(), attachment ? 1 : 0)
      if (attachment) assert.equal(await rail.innerText(), attachmentView, 'Refusal changed the live attachment card')
      assert.equal(navigationCount, stableNavigation, 'Refusal navigated the live draft document')
      await assertPreserved(second, original, originalHost, candidateHash)
      await checkpoint(name, { transactionId: second, draftPreserved: expectedDraft !== '', attachmentPreserved: attachment, attachmentName: attachment ? attachmentName : undefined, host: originalHost, activeFingerprint: original.fingerprint, mainDocumentUnchanged: true })
    }
    await veto('draft-and-attachment-refused', text, true)
    report.liveDraftAttachmentVetoVerified = true
    await writeDraft('')
    await veto('attachment-only-refused', '', true)
    report.attachmentOnlyVetoVerified = true
    await rail.getByRole('button', { name: `Remove file ${attachmentName}`, exact: true }).click()
    await writeDraft(text)
    await veto('draft-only-refused', text, false)
    report.draftOnlyVetoVerified = true
    await writeDraft('')
    const promoted = await accept(second, originalHost, fixtureName)
    const activeManifest = readJson(join(profile, 'package.json'))
    assert.ok(Object.hasOwn(activeManifest.dependencies, fixtureName))
    assert.equal(activeManifest.dsh.profile.bundles.includes(fixtureName), false)
    await openPlugins()
    const fixtureSwitch = card(fixtureName).getByRole('switch')
    await until('installed fixture disabled', () => fixtureSwitch.getAttribute('aria-checked'), value => value === 'false')
    report.consentGraphPromotionVerified = true
    report.newHostGenerationVerified = true
    report.installedDisabledAfterConsentVerified = true
    await checkpoint('graph-promoted-disabled', { transactionId: second, before: originalHost, after: promoted, candidateFingerprint: candidateHash, targetRunningClaim: false })
    await fixtureSwitch.click()
    await until('official enabled selection persisted', () => readJson(join(profile, 'package.json')).dsh.profile.bundles.includes(fixtureName), Boolean)
    await closeNormally()
    const enabledHost = await launch('enabled-fixture')
    await openPlugins()
    assert.equal(await card(fixtureName).getByRole('switch').getAttribute('aria-checked'), 'true')
    await card(fixtureName).getByRole('button', { name: /^View / }).click()
    const row = page.locator('[data-plugin-row]').filter({ hasText: 'fixture-row' })
    await row.getByText('Running', { exact: true }).waitFor()
    report.enabledFixtureRunningAfterSeparateRestartVerified = true
    await checkpoint('enabled-row-running-after-restart', { host: enabledHost, packageName: fixtureName, version: '0.0.1', row: 'fixture-row', state: 'Running', separateFromFirstConsent: true })

    await page.getByRole('button', { name: 'Back to plugins', exact: true }).click()
    const copilot = () => card('dsh-github-copilot')
    assert.equal(await copilot().getByRole('switch').getAttribute('aria-checked'), 'true')
    await copilot().getByRole('switch').click()
    await until('Copilot selection disabled', () => readJson(join(profile, 'package.json')).dsh.profile.bundles.includes('dsh-github-copilot'), value => value === false)
    const selected = readJson(join(profile, 'package.json'))
    assert.ok(Object.hasOwn(selected.dependencies, 'dsh-github-copilot'))
    await closeNormally()
    const disabledHost = await launch('disabled-copilot')
    await openPlugins()
    await until('Copilot remains disabled after startup', () => copilot().getByRole('switch').getAttribute('aria-checked'), value => value === 'false')
    assert.ok(Object.hasOwn(readJson(join(profile, 'package.json')).dependencies, 'dsh-github-copilot'))
    report.copilotDisabledChoiceAcrossRestartVerified = true
    await checkpoint('copilot-disabled-preserved', { host: disabledHost, scope: 'same-version-restart', dependencyRetained: true, selected: false })
    await copilot().getByRole('button', { name: /^View / }).click()
    await page.locator('[data-plugin-panel]').getByRole('button', { name: /^Uninstall / }).click()
    const uninstall = page.getByRole('dialog', { name: /^Uninstall / })
    await uninstall.getByRole('button', { name: 'Uninstall', exact: true }).click()
    await pendingNotice().waitFor({ timeout: 300_000 })
    const removal = preparedTransactionId(await pendingNotice().innerText())
    const removalPrepared = prepared(removal)
    assert.equal(removalPrepared.value.mutation.kind, 'remove')
    assert.equal(removalPrepared.value.result.packageName, 'dsh-github-copilot')
    assert.ok(Object.hasOwn(readJson(join(profile, 'package.json')).dependencies, 'dsh-github-copilot'))
    await accept(removal, disabledHost, 'dsh-github-copilot')
    assert.equal(readJson(join(profile, 'package.json')).dependencies?.['dsh-github-copilot'], undefined)
    assert.ok(Object.hasOwn(readJson(join(profile, 'desktop-plugin-user-intents.json')).removed, 'dsh-github-copilot'))
    await closeNormally()
    const removedHost = await launch('removed-copilot')
    const removedPanel = await openPlugins()
    // Absence is meaningful only after this generation supplies a positive, healthy retained inventory witness.
    const retainedFixture = card(fixtureName)
    await retainedFixture.waitFor({ state: 'visible' })
    await until('retained fixture enabled in loaded inventory', () => retainedFixture.getByRole('switch').getAttribute('aria-checked'), value => value === 'true')
    assert.equal(await removedPanel.getByRole('alert').count(), 0, 'Plugin inventory reported a load failure')
    assert.equal(await removedPanel.getByText('This deployment runs without a manageable profile, so plugins cannot be installed or switched here.', { exact: true }).count(), 0)
    await retainedFixture.getByRole('button', { name: /^View / }).click()
    await page.locator('[data-plugin-row]').filter({ hasText: 'fixture-row' }).getByText('Running', { exact: true }).waitFor()
    await page.getByRole('button', { name: 'Back to plugins', exact: true }).click()
    await retainedFixture.waitFor({ state: 'visible' })
    assert.equal(await removedPanel.getByRole('alert').count(), 0)
    assert.equal(await copilot().count(), 0)
    assert.equal(readJson(join(profile, 'package.json')).dependencies?.['dsh-github-copilot'], undefined)
    assert.ok(Object.hasOwn(readJson(join(profile, 'desktop-plugin-user-intents.json')).removed, 'dsh-github-copilot'))
    report.copilotRemovalChoiceAcrossRestartVerified = true
    await checkpoint('copilot-removal-preserved', { host: removedHost, scope: 'same-version-restart', dependencyRetained: false, removalIntent: true, retainedFixtureRunningInLoadedInventory: true })
    assert.equal(mock.requests.length, 0)
    assert.equal(mock.paths.length, 0)
    report.zeroModelRequestsVerified = true
    await closeNormally()
  } catch (error) {
    failure = error
    if (page !== undefined && !page.isClosed()) {
      try { await page.screenshot({ path: join(evidence, 'package-failure.png') }) }
      catch (captureError) { failure = retainPrimaryFailure(failure, captureError, 'failure-screenshot', secondaryErrors) }
    }
  } finally {
    const cleanupErrors = []
    const cleanupFailure = (stage, error) => {
      cleanupErrors.push(`${stage}: ${safeError(error)}`)
      failure = retainPrimaryFailure(failure, error, stage, secondaryErrors)
    }
    if (shells.some(shell => !shell.launchReturned || !shell.bound)) {
      cleanupFailure('unqualified-launch', new Error('A requested launch has no qualified owned-process exit; retain installation and profiles'))
    }
    // Do not race a timed-out UIA invocation or its family-ledger writer with another native action.
    for (const child of children) {
      if (child.exitCode === null) {
        try { child.kill() } catch (error) { cleanupFailure('native-helper-stop', error) }
      }
    }
    try { await until('native helper processes closed', () => children.size, value => value === 0, 10_000) }
    catch (error) { cleanupFailure('native-helper-exit', error) }
    if (children.size === 0) {
      if (app !== undefined) {
        if (app.process().exitCode === null && shells.some(shell => shell.pid === boundPid && shell.bound)) {
          try { await native('Observe') }
          catch (error) { cleanupFailure('final-pre-close-observation', error) }
        }
        try { await app.close() }
        catch (error) { cleanupFailure('graceful-owned-close', error) }
      }
      for (const shell of shells.filter(item => item.bound && !item.exited)) {
        try {
          await native('StopOwned', shell.pid)
          await native('VerifyExited', shell.pid)
          shell.exited = true
        } catch (error) { cleanupFailure('owned-family-exit', error) }
      }
    } else {
      cleanupFailure('native-helper-unconfirmed', new Error('Native helper exit is unconfirmed; retain the application and state for the outer owned-process deadline/VM teardown'))
    }
    if (mock !== undefined) {
      if (mock.requests.length !== 0 || mock.paths.length !== 0) {
        report.zeroModelRequestsVerified = false
        failure ??= new Error('The local provider observed an unexpected request')
      }
      try { await (await import('../../../../packages/llm/llm-pi-ai/tests/mock-server.ts')).closeMockServers() }
      catch (error) { cleanupFailure('loopback-provider-close', error) }
    }
    if (errors.length !== 0) failure ??= new Error('Product page errors were observed')
    report.cleanupVerified = packageCleanupVerified(shells, children.size, cleanupErrors)
    if (failure === undefined && !report.cleanupVerified) failure = new Error('Package acceptance cleanup is incomplete')
    report.succeeded = failure === undefined && report.cleanupVerified
    try {
      save(join(evidence, 'package-acceptance.json'), { ...report, checkpoints: checkpoints.map(item => item.name), shellIncarnations: shells,
        ...(failure === undefined ? {} : { error: safeError(failure) }), pageErrors: errors, cleanupErrors, secondaryErrors })
    } catch (error) {
      failure = retainPrimaryFailure(failure, error, 'package-acceptance-write', secondaryErrors)
      console.error('Package acceptance evidence failure:', safeError(failure), secondaryErrors)
    }
  }
  if (failure !== undefined) throw failure
  return report
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // Refuse workstation invocation before parse, imports, file writes, servers or browser startup.
  assertUpgradeRunner(process.env)
  const { values } = parseArgs({ options: { 'run-root': { type: 'string' } } })
  runPackagedPackageAcceptance(values['run-root']).catch(error => { console.error(safeError(error)); process.exitCode = 1 })
}
