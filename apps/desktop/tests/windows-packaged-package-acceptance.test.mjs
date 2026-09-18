/** Keyless unit/guard checks only: never launches Desktop, native UI or an installer. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { initialPackageAcceptance, packageCleanupVerified, packageGraphSnapshot, preparedTransactionId, retainPrimaryFailure, sameProcess, validatePackageFixture } from './fixtures/windows-packaged-package-acceptance.mjs'

const source = readFileSync(new URL('./fixtures/windows-packaged-package-acceptance.mjs', import.meta.url), 'utf8')
const native = readFileSync(new URL('./windows-desktop-ui.ps1', import.meta.url), 'utf8')
const id = '11111111-1111-4111-8111-111111111111'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'package-acceptance-unit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test('fresh evidence cannot claim any real acceptance path passed', () => {
  const report = initialPackageAcceptance('a'.repeat(40))
  assert.equal(report.scope, 'candidate-installed-desktop-same-version-isolated-home')
  const claims = Object.entries(report).filter(([, value]) => typeof value === 'boolean')
  assert.ok(claims.length >= 20)
  assert.ok(claims.every(([, value]) => value === false))
  for (const field of ['choicesAcrossInstallerUpgradeVerified', 'draftPersistedAcrossQuitVerified', 'promotionFailureRollbackVerified', 'managedHandoffVerified', 'verifiedGithubReleaseReceiptForFixture', 'newlyInstalledTargetHealthyAtFirstConsent']) {
    assert.equal(report[field], false)
    assert.equal(source.includes(`report.${field} = true`), false)
  }
})

test('rejected or unbound launch attempts cannot vacuously qualify cleanup', () => {
  const unclaimed = { launchReturned: false, pid: null, bound: false, exited: false }
  const qualified = { launchReturned: true, pid: 41, bound: true, exited: true }
  assert.equal(packageCleanupVerified([], 0, []), false)
  assert.equal(packageCleanupVerified([unclaimed], 0, []), false)
  assert.equal(packageCleanupVerified([qualified, unclaimed], 0, []), false)
  assert.equal(packageCleanupVerified([{ ...qualified, bound: false }], 0, []), false)
  assert.equal(packageCleanupVerified([qualified], 1, []), false)
  assert.equal(packageCleanupVerified([qualified], 0, ['exit unconfirmed']), false)
  assert.equal(packageCleanupVerified([qualified], 0, []), true)
  assert.ok(source.indexOf('shells.push(shellRecord)') < source.indexOf('._electron.launch('))
  assert.ok(source.includes('packageCleanupVerified(shells, children.size, cleanupErrors)'))
})

test('close and real evidence-write failures retain the original failure object', async t => {
  const root = directory(t)
  const primary = new Error('first application failure')
  const closeFailure = new Error('subsequent close failure')
  const secondary = []
  let current = primary
  try { await Promise.reject(closeFailure) }
  catch (error) { current = retainPrimaryFailure(current, error, 'owned-close', secondary) }
  try { writeFileSync(root, 'cannot replace a directory with receipt bytes') }
  catch (error) { current = retainPrimaryFailure(current, error, 'evidence-write', secondary) }
  assert.equal(current, primary)
  assert.deepEqual(secondary.map(item => item.stage), ['owned-close', 'evidence-write'])
  assert.equal(retainPrimaryFailure(undefined, closeFailure, 'only-failure', []), closeFailure)
  assert.ok(source.includes("retainPrimaryFailure(failure, error, 'package-acceptance-write'"))
  const installed = readFileSync(new URL('./fixtures/windows-installed-upgrade-smoke.mjs', import.meta.url), 'utf8')
  assert.ok(installed.includes("retainPrimaryFailure(roundFailure, error, 'round-owned-close'"))
  assert.ok(installed.includes("retainPrimaryFailure(roundFailure, error, 'round-failure-evidence-write'"))
  assert.ok(installed.includes('if (roundFailure !== undefined) throw roundFailure'))
})

/** Run only extracted pure error/reaper code with fake process handles; never load the native driver or application. */
function powershellUnit(t, body) {
  const root = directory(t)
  const script = join(root, 'pure-unit.ps1')
  writeFileSync(script, "$ErrorActionPreference = 'Stop'\n" + body)
  const names = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PSMODULEPATH', 'PROGRAMFILES'])
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toUpperCase()))), POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off' }
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', env, timeout: 15_000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim())
}

test('Windows pure reaper covers late cleanup handles and rejects WaitForExit false', { skip: process.platform !== 'win32' }, t => {
  const driver = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const helper = driver.match(/function Stop-OwnedProcesses \{[\s\S]*?\r?\n\}/u)?.[0]
  assert.ok(helper)
  const observed = powershellUnit(t, `${helper}\n
$handles = [Collections.Generic.List[object]]::new()
$messages = [Collections.Generic.List[string]]::new()
if (-not (Stop-OwnedProcesses $handles $messages)) { throw 'Empty first pass failed' }
$late = [pscustomobject]@{ HasExited = $false; KillCalls = 0; WaitCalls = 0 }
$late | Add-Member ScriptMethod Kill { param($Tree); $this.KillCalls++ }
$late | Add-Member ScriptMethod WaitForExit { param($Milliseconds); $this.WaitCalls++; return $false }
$handles.Add($late)
$stopped = Stop-OwnedProcesses $handles $messages
@{ stopped = $stopped; kills = $late.KillCalls; waits = $late.WaitCalls; errors = @($messages) } | ConvertTo-Json -Compress
`)
  assert.equal(observed.stopped, false)
  assert.equal(observed.kills, 1)
  assert.equal(observed.waits, 1)
  assert.match(observed.errors[0], /did not exit/)
  assert.ok(driver.lastIndexOf('Stop-OwnedProcesses $processes $cleanupErrors') > driver.indexOf('Wait-Exit (Start-Fixture cleanup)'))
  assert.ok(driver.lastIndexOf('Stop-OwnedProcesses $processes $cleanupErrors') < driver.indexOf('try { $process.Dispose() }'))
})

test('Windows native failure evidence write cannot replace its primary error', { skip: process.platform !== 'win32' }, t => {
  const normalized = native.replaceAll('\r\n', '\n')
  const marker = '} catch {\n    $primaryFailure = $_'
  const start = normalized.lastIndexOf(marker)
  assert.ok(start >= 0)
  const body = normalized.slice(start + '} catch {\n'.length, normalized.lastIndexOf('\n}'))
  const observed = powershellUnit(t, `
$nativeReady = $false
$resultPath = $PSScriptRoot
$OwnerToken = 'unit-owner'
$RequestId = 'unit-request'
$Action = 'unit-only'
try {
    try { throw 'primary native action failure' } catch {
${body}
    }
} catch {
    @{ primary = $_.Exception.Message; secondary = @($secondaryErrors) } | ConvertTo-Json -Compress
}
`)
  assert.equal(observed.primary, 'primary native action failure')
  assert.equal(observed.secondary.length, 1)
  assert.match(observed.secondary[0], /Native failure evidence write failed/)
})

test('Windows outer receipt failure preserves an existing error and promotes only when none exists', { skip: process.platform !== 'win32' }, t => {
  const driver = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8').replaceAll('\r\n', '\n')
  const start = driver.lastIndexOf('    try {\n        [ordered]@{')
  assert.ok(start >= 0)
  const receipt = driver.slice(start, driver.lastIndexOf('\n}'))
  const observed = powershellUnit(t, `
$root = $PSScriptRoot
$ExpectedSourceCommit = 'unit-source'
$installPath = 'unit-only'
$success = $false
$packageAcceptanceSuccess = $false
$cleanupErrors = [Collections.Generic.List[string]]::new()
$secondaryErrors = [Collections.Generic.List[string]]::new()
try { throw 'original installer failure' } catch { $original = $_ }
$failure = $original
${receipt}
$preserved = [object]::ReferenceEquals($failure, $original)
$firstSecondary = @($secondaryErrors)
$failure = $null
$secondaryErrors.Clear()
${receipt}
@{ preserved = $preserved; firstSecondary = $firstSecondary; promoted = ($null -ne $failure); secondSecondary = @($secondaryErrors) } | ConvertTo-Json -Compress
`)
  assert.equal(observed.preserved, true)
  assert.equal(observed.promoted, true)
  assert.equal(observed.firstSecondary.length, 1)
  assert.equal(observed.secondSecondary.length, 1)
  assert.match(observed.firstSecondary[0], /Installer acceptance evidence write failed/)
})

test('removed package absence waits for a retained running inventory witness', () => {
  const removal = source.slice(source.indexOf("await launch('removed-copilot')"))
  const absence = removal.indexOf('assert.equal(await copilot().count(), 0)')
  assert.ok(absence > 0)
  for (const witness of ["retainedFixture.waitFor({ state: 'visible' })", "getByText('Running'", "removedPanel.getByRole('alert')", "name: 'Back to plugins'"]) {
    assert.ok(removal.indexOf(witness) >= 0 && removal.indexOf(witness) < absence, witness)
  }
})

test('prepared notice requires one exact transaction identity', () => {
  const notice = `@fixture/bundle: Transaction ${id} is staged privately. Active plugins are unchanged.`
  assert.equal(preparedTransactionId(notice), id)
  for (const text of ['', id, `Transaction ../${id} is staged privately.`, notice + notice, notice.replace(id, id.toUpperCase().replace('1', 'A'))]) {
    assert.throws(() => preparedTransactionId(text))
  }
})

test('graph reader hashes exact metadata, payload bytes and link spellings without following links', t => {
  const root = directory(t)
  const profile = join(root, 'profile')
  const external = join(root, 'runtime')
  mkdirSync(profile)
  mkdirSync(external)
  writeFileSync(join(profile, 'package.json'), '{"private":true}\n')
  writeFileSync(join(external, 'external.js'), 'outside\n')
  symlinkSync(external, join(profile, 'shared'), process.platform === 'win32' ? 'junction' : 'dir')
  const first = packageGraphSnapshot(profile)
  assert.equal(first.fingerprint, digest(JSON.stringify(first.entries)))
  assert.equal(first.entries.length, 2)
  assert.equal(first.entries[1].kind, 'link')
  writeFileSync(join(external, 'external.js'), 'external changes do not mutate the link spelling\n')
  assert.deepEqual(packageGraphSnapshot(profile), first)
  writeFileSync(join(profile, 'package.json'), '{"private":false}\n')
  assert.notEqual(packageGraphSnapshot(profile).fingerprint, first.fingerprint)
  assert.throws(() => packageGraphSnapshot(join(profile, 'shared')))
})

test('a process generation needs creation time and executable as well as PID', () => {
  const observed = { pid: 41, parentPid: 20, created: '2026-01-01T00:00:00.0000000Z', executable: 'C:\\owned\\desktop.exe' }
  assert.equal(sameProcess(observed, { ...observed, executable: observed.executable.toUpperCase() }), true)
  for (const change of [{ pid: 42 }, { created: '2026-01-01T00:00:01.0000000Z' }, { executable: 'C:\\other.exe' }]) {
    assert.equal(sameProcess(observed, { ...observed, ...change }), false)
  }
  assert.equal(sameProcess(undefined, observed), false)
})

test('only the unchanged private fixture package with no lifecycle or dependency fields is admitted', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../web/tests/fixtures/plugins/fixture-bundle/package.json', import.meta.url), 'utf8'))
  assert.doesNotThrow(() => validatePackageFixture(manifest))
  for (const field of ['scripts', 'dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    assert.throws(() => validatePackageFixture({ ...manifest, [field]: {} }))
  }
  assert.throws(() => validatePackageFixture({ ...manifest, private: false }))
  assert.throws(() => validatePackageFixture({ ...manifest, name: 'dsh-github-copilot' }))
  assert.throws(() => validatePackageFixture({ ...manifest, version: '0.0.2' }))
})

test('standalone fixture refuses workstation execution before filesystem setup or browser imports', () => {
  const entry = fileURLToPath(new URL('./fixtures/windows-packaged-package-acceptance.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' }, timeout: 10_000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Installer qualification (?:requires Windows|is GitHub-only)/)
  const run = source.slice(source.indexOf('export async function runPackagedPackageAcceptance'))
  assert.ok(run.indexOf('assertUpgradeRunner(process.env)') < run.indexOf('mkdirSync(directory)'))
  assert.ok(run.indexOf('assertUpgradeRunner(process.env)') < run.indexOf("import('playwright')"))
})

test('native helper checks hosted ownership before accessibility loading and uses owned controls only', () => {
  assert.ok(native.indexOf("$env:RUNNER_ENVIRONMENT -ne 'github-hosted'") < native.indexOf('Get-Content -LiteralPath'))
  assert.ok(native.indexOf("$env:RUNNER_ENVIRONMENT -ne 'github-hosted'") < native.indexOf('Add-Type'))
  for (const required of ['Same-Identity', '$handle.StartTime', '$handle.Handle', 'GetWindowThreadProcessId', '$node.Current.ProcessId -eq $ShellPid', 'InvokePattern', 'ValuePattern', "Wait-Control 'Select Folder'", 'skippedReusedPids', 'package-native-$RequestId', 'accessibility = $tree', '$fresh.CreationDate -ne $Process.CreationDate', 'Identity $item -AllowExited', 'completeObservation = $false', 'postExitProcessScanPassed = $true']) assert.ok(native.includes(required), required)
  assert.doesNotMatch(native, /SendKeys|SendInput|SetForegroundWindow|Stop-Process\s+-Name|taskkill|ExecutionPolicy|dialog\.showOpenDialog\s*=/iu)
  const actions = native.match(/ValidateSet\(([^)]+)\)/u)?.[1]
  assert.equal(actions, "'Bind','Observe','ReviewPackages','ChooseWorkspace','Exit','VerifyExited','StopOwned'")
})

test('scenario keeps real native actions, real shell consent, provider-zero-call and two-step health observations', () => {
  for (const required of ["native('ChooseWorkspace')", "openNativeMenu('ReviewPackages')", "openNativeMenu('Exit')", "name: 'Activate and restart Host'", "name: 'Update later'", "name: 'Create provider'", "mockServer([])", 'assert.equal(mock.requests.length, 0', 'firstPrepared.value.mutation.enabled, false', "getByText('Running'", 'candidateFingerprint', 'DISCARDED.json']) assert.ok(source.includes(required), required)
  assert.doesNotMatch(source, /remote\.pluginManager|ipcRenderer\.(?:send|invoke)|\.reportImpact\(|showMessageBox\s*=|showOpenDialog\s*=|MenuItem|addInitScript|\.route\(/u)
  assert.ok(source.indexOf('report.installedDisabledAfterConsentVerified = true') < source.indexOf('report.enabledFixtureRunningAfterSeparateRestartVerified = true'))
  assert.ok(source.includes("assert.equal(children.size, 0, 'A previous native helper has not acknowledged exit')"))
  assert.ok(source.includes('timed out and its exit was acknowledged'))
  const cleanup = source.slice(source.indexOf('    const cleanupErrors = []'))
  assert.ok(cleanup.indexOf("native('Observe')") < cleanup.indexOf('await app.close()'))
  assert.ok(cleanup.includes('if (children.size === 0)'))
})

test('installed driver runs the separately scoped case before uninstall and retains unverified installer flags', () => {
  const driver = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const fixture = readFileSync(new URL('./fixtures/windows-installed-upgrade-smoke.mjs', import.meta.url), 'utf8')
  assert.ok(driver.indexOf('Start-Fixture candidate') < driver.indexOf('Start-Fixture package'))
  assert.ok(driver.indexOf('Start-Fixture package') < driver.indexOf("Start-Owned $uninstaller '/S'"))
  assert.ok(driver.includes('separateSameVersionPackagedPluginAcceptanceVerified = $packageAcceptanceSuccess'))
  assert.ok(driver.includes('Package process cleanup is unconfirmed; retain installation and profiles for VM teardown'))
  assert.ok(driver.indexOf('$packageCleanup.cleanupVerified') < driver.indexOf("Start-Owned $uninstaller '/S'"))
  for (const field of ['pluginUserChoicesVerified', 'draftAttachmentRefusalVerified', 'managedHandoffVerified']) assert.ok(driver.includes(`${field} = $false`))
  for (const name of ['package-home', 'package-electron-user-data', 'package-workspace', 'package-fixture-data']) assert.ok(fixture.includes(`'${name}'`))
})
