/** Keyless unit/guard checks only: never launches Desktop, native UI or an installer. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { installedUpgradeApplication } from './fixtures/windows-installed-upgrade-contract.mjs'
import { initialPackageAcceptance, packageCleanupVerified, packageGraphSnapshot, preparePackageAcceptanceHome, preparedTransactionId, retainPrimaryFailure, sameProcess, validatePackageFixture } from './fixtures/windows-packaged-package-acceptance.mjs'

const source = readFileSync(new URL('./fixtures/windows-packaged-package-acceptance.mjs', import.meta.url), 'utf8')
const native = readFileSync(new URL('./windows-desktop-ui.ps1', import.meta.url), 'utf8')
const id = '11111111-1111-4111-8111-111111111111'
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
function directory(t, base = tmpdir()) {
  let root = mkdtempSync(join(base, 'package-acceptance-unit-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  // Establish the physical identity of a newly owned fixture, not an untrusted application input.
  root = realpathSync.native(root)
  return root
}

test('fixture allocation resolves an aliased temporary base before ownership checks', t => {
  const parent = directory(t)
  const physical = join(parent, 'physical')
  const alias = join(parent, 'temporary-alias')
  mkdirSync(physical)
  symlinkSync(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const root = directory(t, alias)
  assert.equal(dirname(root), realpathSync.native(physical))
  assert.equal(root, realpathSync.native(root))
  assert.equal(installedUpgradeApplication(root), join(root, 'Installed App', 'cloga-deepseek-harness-desktop', 'cloga-deepseek-harness.exe'))
})

test('fresh private package home includes the empty physical Desktop required by the native picker', t => {
  const root = directory(t)
  const expectedHome = join(root, 'package-home')
  const desktop = join(expectedHome, 'Desktop')
  assert.equal(existsSync(desktop), false)
  const home = preparePackageAcceptanceHome(root)
  assert.equal(home, expectedHome)
  assert.deepEqual(readdirSync(root), ['package-home'])
  assert.deepEqual(readdirSync(home), ['Desktop'])
  assert.deepEqual(readdirSync(desktop), [])
  for (const path of [home, desktop]) {
    assert.ok(lstatSync(path).isDirectory())
    assert.equal(lstatSync(path).isSymbolicLink(), false)
    assert.equal(realpathSync.native(path), path)
  }
})

for (const collision of ['file', 'empty-home', 'home-without-Desktop', 'Desktop-file']) {
  test(`private home preparation rejects an existing ${collision} without adopting or altering it`, t => {
    const root = directory(t)
    const home = join(root, 'package-home')
    if (collision === 'file') writeFileSync(home, 'owned collision sentinel')
    else {
      mkdirSync(home)
      if (collision === 'home-without-Desktop') writeFileSync(join(home, 'retained.txt'), 'retained home sentinel')
      if (collision === 'Desktop-file') writeFileSync(join(home, 'Desktop'), 'not a Desktop directory')
    }
    const before = packageGraphSnapshot(root)
    assert.throws(() => preparePackageAcceptanceHome(root), /new isolated home/u)
    assert.deepEqual(packageGraphSnapshot(root), before)
  })
}

for (const alias of ['home', 'root']) {
  test(`private home preparation refuses a linked ${alias} without creating an external Desktop`, t => {
    const parent = directory(t)
    const root = join(parent, 'owned')
    const outside = join(parent, 'outside')
    mkdirSync(root)
    mkdirSync(outside)
    writeFileSync(join(outside, 'retained.txt'), 'outside sentinel')
    const link = alias === 'home' ? join(root, 'package-home') : join(parent, 'root-alias')
    symlinkSync(alias === 'home' ? outside : root, link, process.platform === 'win32' ? 'junction' : 'dir')
    const before = packageGraphSnapshot(parent)
    assert.throws(() => preparePackageAcceptanceHome(alias === 'home' ? root : link), /strict owned descendant|traverse a link|filesystem alias/u)
    assert.deepEqual(packageGraphSnapshot(parent), before)
    assert.equal(existsSync(join(outside, 'Desktop')), false)
    assert.equal(readFileSync(join(outside, 'retained.txt'), 'utf8'), 'outside sentinel')
  })
}

test('private Desktop remains owned by home cleanup and preparation never adopts a prior run', t => {
  const root = directory(t)
  const home = preparePackageAcceptanceHome(root)
  writeFileSync(join(home, 'Desktop', 'owned.txt'), 'owned file')
  writeFileSync(join(root, 'retained.txt'), 'root sentinel')
  const before = packageGraphSnapshot(root)
  assert.throws(() => preparePackageAcceptanceHome(root), /new isolated home/u)
  assert.deepEqual(packageGraphSnapshot(root), before)
  rmSync(home, { recursive: true })
  assert.equal(existsSync(join(home, 'Desktop')), false)
  assert.equal(readFileSync(join(root, 'retained.txt'), 'utf8'), 'root sentinel')
})

test('private picker home preparation follows ownership validation and precedes every launch', () => {
  const run = source.slice(source.indexOf('export async function runPackagedPackageAcceptance'))
  const prepare = run.indexOf('const home = preparePackageAcceptanceHome(root)')
  assert.ok(prepare >= 0)
  for (const earlier of ['assertUpgradeRunner(process.env)', 'ownedUpgradePath(process.env.RUNNER_TEMP, runRoot)',
    'assert.equal(validated.ownerToken, owner.token)', 'assert.equal(expected.source.commit, process.env.GITHUB_SHA)',
    'validated.candidate.manifestFileSha256']) {
    const index = run.indexOf(earlier)
    assert.ok(index >= 0 && index < prepare, earlier)
  }
  for (const later of ["await import('../../scripts/smoke-environment.ts')", "._electron.launch(", "await import('../../../../packages/llm/llm-pi-ai/tests/mock-server.ts')", "native('ChooseWorkspace')"]) {
    assert.ok(run.indexOf(later) > prepare, later)
  }
  assert.ok(run.includes('for (const directory of [userData, workspace, data])'))
  assert.ok(run.includes('const environment = { ...desktopSmokeEnvironment(home),'))
  assert.ok(run.includes("const profile = join(home, 'profiles', 'desktop')"))
})

test('installed observers agree on the driver-owned nested application path', t => {
  const root = directory(t)
  assert.equal(installedUpgradeApplication(root), join(root, 'Installed App', 'cloga-deepseek-harness-desktop', 'cloga-deepseek-harness.exe'))
  const driver = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  assert.ok(driver.includes("$baselineAppFilename = 'cloga-deepseek-harness-desktop'"))
  assert.ok(driver.includes("$installPath = Join-Path $root ('Installed App\\' + $baselineAppFilename)"))
  for (const name of ['windows-installed-upgrade-smoke.mjs', 'windows-packaged-package-acceptance.mjs']) {
    const consumer = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    assert.ok(consumer.includes('const application = installedUpgradeApplication(root)'), name)
    assert.equal(consumer.includes("join(root, 'Installed App', 'cloga-deepseek-harness.exe')"), false)
  }
  assert.ok(native.includes("$application = Join-Path $root 'Installed App\\cloga-deepseek-harness-desktop\\cloga-deepseek-harness.exe'"))
  const helperLoad = native.indexOf(". (Join-Path $PSScriptRoot 'fixtures/windows-installer-registration.ps1')")
  const ancestry = native.indexOf('Assert-InstallerOwnedPath $root $application')
  assert.ok(helperLoad > native.indexOf("throw 'Foreign runner owner'"))
  assert.ok(ancestry > helperLoad && ancestry < native.indexOf('$fixture = Read-Process $FixturePid'))
})

for (const location of ['container', 'application-parent']) {
  test(`installed application path rejects a linked ${location}`, t => {
    const root = directory(t)
    const target = join(root, 'elsewhere')
    mkdirSync(target)
    const container = join(root, 'Installed App')
    if (location === 'application-parent') mkdirSync(container)
    const link = location === 'container' ? container : join(container, 'cloga-deepseek-harness-desktop')
    symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => installedUpgradeApplication(root), /must not traverse a link/)
  })
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
  const qualified = { launchReturned: true, launcherPid: 40, launcherExited: true, pid: 41, bound: true, exited: true }
  assert.equal(packageCleanupVerified([], 0, []), false)
  assert.equal(packageCleanupVerified([unclaimed], 0, []), false)
  assert.equal(packageCleanupVerified([qualified, unclaimed], 0, []), false)
  assert.equal(packageCleanupVerified([{ ...qualified, bound: false }], 0, []), false)
  assert.equal(packageCleanupVerified([{ ...qualified, exited: false }], 0, []), false, 'CMD exit cannot certify Electron/Host exit')
  assert.equal(packageCleanupVerified([{ ...qualified, launcherExited: false }], 0, []), false, 'Native family exit cannot certify launch transport exit')
  assert.equal(packageCleanupVerified([{ ...qualified, launcherPid: null }], 0, []), false)
  assert.equal(packageCleanupVerified([{ ...qualified, pid: 0 }], 0, []), false)
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

function unitChildEvidence(result, elapsedMs, budgetMs) {
  const stderr = result.stderr ?? ''
  return {
    elapsedMs: Math.round(elapsedMs), budgetMs, pid: result.pid ?? null,
    errorCode: result.error?.code ?? null, errorMessage: result.error?.message?.slice(0, 512) ?? null,
    signal: result.signal, status: result.status,
    lastPhase: [...stderr.matchAll(/^\[fixture-phase:([a-z-]+)\]\r?$/gmu)].at(-1)?.[1] ?? 'no-script-marker-observed',
    stdoutTail: (result.stdout ?? '').slice(-2048), stderrTail: stderr.slice(-2048),
  }
}

function assertUnitChild(result, evidence) {
  const diagnostic = JSON.stringify(evidence)
  assert.equal(result.error, undefined, diagnostic)
  assert.equal(result.signal, null, diagnostic)
  assert.equal(result.status, 0, diagnostic)
}

test('unit child diagnostics cannot accept a timeout with zero status or hide assertion-phase failures', () => {
  const result = { error: { code: 'ETIMEDOUT', message: 'deadline' }, signal: null, status: 0, stderr: '[fixture-phase:mock-setup-complete]\n' + 'x'.repeat(10_000) }
  const evidence = unitChildEvidence(result, 30_001, 30_000)
  assert.equal(evidence.lastPhase, 'mock-setup-complete')
  assert.equal(evidence.errorCode, 'ETIMEDOUT')
  assert.equal(evidence.status, 0)
  assert.equal(evidence.stderrTail.length, 2048)
  assert.throws(() => assertUnitChild(result, evidence), /ETIMEDOUT/u)
  const failed = { signal: null, status: 1, stderr: '[fixture-phase:assertions-start]\nassertion failed' }
  assert.throws(() => assertUnitChild(failed, unitChildEvidence(failed, 1, 10)), /assertions-start/u)
  const signalled = { signal: 'SIGTERM', status: null }
  assert.throws(() => assertUnitChild(signalled, unitChildEvidence(signalled, 1, 10)), /SIGTERM/u)
  assert.equal(unitChildEvidence(signalled, 1, 10).lastPhase, 'no-script-marker-observed')
  assert.equal(unitChildEvidence({ stderr: 'parser echo: [fixture-phase:assertions-start]' }, 1, 10).lastPhase, 'no-script-marker-observed')
})

/** Run only extracted pure error/reaper code with fake process handles; never load the native driver or application. */
function powershellUnit(t, body, shell = 'pwsh', { timeout = 15_000, phases = false } = {}) {
  const root = directory(t)
  const script = join(root, 'pure-unit.ps1')
  writeFileSync(script, "$ErrorActionPreference = 'Stop'\n"
    + (phases ? "[Console]::Error.WriteLine('[fixture-phase:script-start]')\n" : '') + body
    + (phases ? "\n[Console]::Error.WriteLine('[fixture-phase:script-complete]')\n" : ''))
  const names = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PSMODULEPATH', 'PROGRAMFILES'])
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toUpperCase()))), POWERSHELL_TELEMETRY_OPTOUT: '1', POWERSHELL_UPDATECHECK: 'Off' }
  const started = performance.now()
  const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', env, timeout })
  const evidence = unitChildEvidence(result, performance.now() - started, timeout)
  assertUnitChild(result, evidence)
  if (phases) {
    assert.equal(evidence.lastPhase, 'script-complete', JSON.stringify(evidence))
    t.diagnostic(`Pure unit subprocess: ${JSON.stringify(evidence)}`)
  }
  return JSON.parse(result.stdout.trim())
}

test('package observer binds the observed Electron PID before native actions and retains transport ownership separately', () => {
  const launch = source.slice(source.indexOf('  const launch = async label => {'), source.indexOf('  const openNativeMenu'))
  assert.ok(launch.indexOf('app.evaluate(inspectInstalledDesktopIdentity)') < launch.indexOf("await native('Bind')"))
  assert.ok(launch.indexOf('assert.equal(identity.version, expected.version)') < launch.indexOf("await native('Bind')"))
  assert.ok(launch.includes('const processIds = installedDesktopProcessIds(launcher, identity, process.pid)'))
  assert.ok(launch.includes('boundPid = processIds.pid'))
  assert.doesNotMatch(source, /boundPid = app\.process\(\)\.pid/u)
  assert.ok(source.includes("'-LauncherPid', String(launcherPid)"))
  assert.ok(source.includes('const records = shells.filter(shell => shell.pid === pid)'))
  assert.ok(source.includes('launchers.set(shellRecord.launchId, launcher)'))
  assert.ok(source.includes('assert.equal(recorded.launcher.pid, shellRecord.launcherPid)'))
  assert.ok(source.includes("await native('StopOwned', shell.pid)"))
  assert.ok(source.includes("await native('VerifyExited', shell.pid)"))
  assert.ok(source.includes('const launcher = launchers.get(shell.launchId)'))
  assert.ok(source.includes('shell.launcherExited = installedLauncherExited(launcher)'))
  assert.ok(native.includes('Assert-DesktopLaunchLineage $fixture $launcher $shell $application'))
  assert.ok(native.includes("(Join-Path ([Environment]::SystemDirectory) 'cmd.exe')"))
  assert.ok(native.includes('launcher = (Identity $launcher)'))
  assert.ok(native.includes('$binding.launcher.pid -ne $LauncherPid'))
  assert.ok(native.includes('Same-Identity $launcher $binding.launcher'))
  assert.ok(native.includes('Same-Identity (Read-Process $LauncherPid) $binding.launcher'))
  assert.ok(native.includes("throw 'Owned launch transport remains live; exit is not verified'"))
})

test('native launch lineage admits only the retained CMD chain or exact direct-child launch', { skip: process.platform !== 'win32' }, t => {
  const helper = native.match(/function Assert-DesktopLaunchLineage[^]*?\r?\n\}/u)?.[0]
  assert.ok(helper)
  const observed = powershellUnit(t, `
${helper}
function Changed($Record, $Field, $Value) { $copy = $Record.PSObject.Copy(); $copy.$Field = $Value; return $copy }
$application = 'C:/owned/cloga-deepseek-harness.exe'
$command = 'C:/Windows/System32/cmd.exe'
$time = [datetime]'2026-01-01T00:00:00Z'
$fixture = [pscustomobject]@{ ProcessId = 101; ParentProcessId = 1; CreationDate = $time; SessionId = 7; ExecutablePath = 'C:/node.exe' }
$launcher = [pscustomobject]@{ ProcessId = 202; ParentProcessId = 101; CreationDate = $time.AddSeconds(1); SessionId = 7; ExecutablePath = $command }
$shell = [pscustomobject]@{ ProcessId = 303; ParentProcessId = 202; CreationDate = $time.AddSeconds(2); SessionId = 7; ExecutablePath = $application }
$direct = Changed $shell 'ParentProcessId' 101
Assert-DesktopLaunchLineage $fixture $launcher $shell $application $command
Assert-DesktopLaunchLineage $fixture $direct $direct $application $command
$cases = @(
    @{ label = 'missing-launcher'; launcher = $null; shell = $shell },
    @{ label = 'fixture-as-launcher'; launcher = $fixture; shell = $shell },
    @{ label = 'wrong-launcher-parent'; launcher = (Changed $launcher 'ParentProcessId' 999); shell = $shell },
    @{ label = 'wrong-main-parent'; launcher = $launcher; shell = (Changed $shell 'ParentProcessId' 999) },
    @{ label = 'foreign-command-interpreter'; launcher = (Changed $launcher 'ExecutablePath' 'C:/foreign/cmd.exe'); shell = $shell },
    @{ label = 'foreign-main-executable'; launcher = $launcher; shell = (Changed $shell 'ExecutablePath' ($application + '.other')) },
    @{ label = 'launcher-predates-fixture'; launcher = (Changed $launcher 'CreationDate' $time.AddSeconds(-1)); shell = $shell },
    @{ label = 'main-predates-launcher'; launcher = $launcher; shell = (Changed $shell 'CreationDate' $time) },
    @{ label = 'launcher-foreign-session'; launcher = (Changed $launcher 'SessionId' 9); shell = $shell },
    @{ label = 'main-foreign-session'; launcher = $launcher; shell = (Changed $shell 'SessionId' 9) },
    @{ label = 'direct-incarnation-mismatch'; launcher = $direct; shell = (Changed $direct 'CreationDate' $time.AddSeconds(3)) },
    @{ label = 'direct-parent-mismatch'; launcher = $direct; shell = $shell }
)
$rejected = @()
foreach ($case in $cases) {
    $failure = $null
    try { Assert-DesktopLaunchLineage $fixture $case.launcher $case.shell $application $command } catch { $failure = $_ }
    if ($null -eq $failure) { throw ('Accepted foreign lineage: ' + $case.label) }
    $rejected += $case.label
}
[pscustomobject]@{ accepted = @('cmd-chain', 'direct-child'); rejected = $rejected } | ConvertTo-Json -Compress
`)
  assert.deepEqual(observed.accepted, ['cmd-chain', 'direct-child'])
  assert.deepEqual(observed.rejected, [
    'missing-launcher', 'fixture-as-launcher', 'wrong-launcher-parent', 'wrong-main-parent', 'foreign-command-interpreter',
    'foreign-main-executable', 'launcher-predates-fixture', 'main-predates-launcher', 'launcher-foreign-session',
    'main-foreign-session', 'direct-incarnation-mismatch', 'direct-parent-mismatch',
  ])
})

test('native incarnation comparison rejects a reused launcher PID without touching any real process', { skip: process.platform !== 'win32' }, t => {
  const helper = native.match(/function Same-Identity[^]*?\r?\n\}/u)?.[0]
  assert.ok(helper)
  const observed = powershellUnit(t, `
${helper}
$started = [datetime]'2026-01-01T00:00:01Z'
$image = 'C:/Windows/System32/cmd.exe'
$disposed = 0
function Get-Process {
    $handle = [pscustomobject]@{ Handle = 1; StartTime = $script:started; Path = $script:image }
    $handle | Add-Member ScriptMethod Dispose { $script:disposed++ }
    return $handle
}
$actual = [pscustomobject]@{ ProcessId = 202; ParentProcessId = 101; ExecutablePath = $image }
$expected = [pscustomobject]@{ pid = 202; parentPid = 101; executable = $image; created = $started.ToUniversalTime().ToString('o') }
$matched = Same-Identity $actual $expected
$started = $started.AddSeconds(2)
$reused = Same-Identity $actual $expected
$started = [datetime]$expected.created
$image = 'C:/foreign/cmd.exe'
$foreign = Same-Identity $actual $expected
[pscustomobject]@{ matched = $matched; reused = $reused; foreign = $foreign; disposed = $disposed } | ConvertTo-Json -Compress
`)
  assert.deepEqual(observed, { matched: true, reused: false, foreign: false, disposed: 3 })
})

test('native exit verification requires both transport and actual main exit without adopting reused PIDs', { skip: process.platform !== 'win32' }, t => {
  const same = native.match(/function Same-Identity[^]*?\r?\n\}/u)?.[0]
  const body = native.split("if ($Action -eq 'VerifyExited') {")[1].split("    } elseif ($Action -eq 'StopOwned')")[0]
  assert.ok(same && body)
  // Match the native driver's Windows PowerShell edition: Core auto-converts ISO JSON strings to DateTime.
  // This one hosted 15s total-process guard expired before phase evidence existed. Allow 30s for
  // fresh PowerShell/mock setup; this is not an installed-process exit or UI performance deadline.
  const observed = powershellUnit(t, `
${same}
function Verify-Exit {
${body}
    return $result
}
function Read-Process($ProcessId) { return $script:processes[[int]$ProcessId] }
function Get-CimInstance { return @($script:processes.Values) }
function Get-Process($Id) {
    $value = Read-Process $Id
    if ($null -eq $value) { return $null }
    $handle = [pscustomobject]@{ Handle = 1; StartTime = $value.Started; Path = $value.ExecutablePath }
    $handle | Add-Member ScriptMethod Dispose {}
    return $handle
}
$OwnerToken = 'unit-owner'
$LauncherPid = 202
$application = Join-Path $PSScriptRoot 'app.exe'
$time = [datetime]'2026-01-01T00:00:01Z'
$command = 'C:/Windows/System32/cmd.exe'
$binding = [pscustomobject]@{ launcher = [pscustomobject]@{ pid = 202; parentPid = 101; executable = $command; created = $time.ToUniversalTime().ToString('o') } }
$familyPath = Join-Path $PSScriptRoot 'family.json'
@{ ownerToken = $OwnerToken; completeObservation = $true; processes = @(@{ pid = 303; parentPid = 202; executable = $application; created = $time.AddSeconds(1).ToUniversalTime().ToString('o') }) } | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $familyPath
[Console]::Error.WriteLine('[fixture-phase:mock-setup-complete]')
[Console]::Error.WriteLine('[fixture-phase:assertions-start]')
$rejected = @()
foreach ($case in @('transport-live', 'main-live')) {
    $processes = if ($case -eq 'transport-live') { @{ 202 = [pscustomobject]@{ ProcessId = 202; ParentProcessId = 101; ExecutablePath = $command; Started = $time } } }
        else { @{ 303 = [pscustomobject]@{ ProcessId = 303; ParentProcessId = 202; ExecutablePath = $application; Started = $time.AddSeconds(1) } } }
    $failure = $null
    try { [void](Verify-Exit) } catch { $failure = $_ }
    if ($null -eq $failure -or $failure.Exception.Message -notmatch 'remains live') { throw ('Exit incorrectly admitted: ' + $case + ': ' + $failure) }
    $rejected += $case
}
$processes = @{}
$gone = Verify-Exit
$processes = @{ 202 = [pscustomobject]@{ ProcessId = 202; ParentProcessId = 101; ExecutablePath = $command; Started = $time.AddSeconds(10); CreationDate = $time.AddSeconds(10) } }
$reused = Verify-Exit
[pscustomobject]@{ rejected = $rejected; gone = $gone.ownedFamilyExited; reused = $reused.ownedFamilyExited } | ConvertTo-Json -Compress
`, join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), { timeout: 30_000, phases: true })
  assert.deepEqual(observed, { rejected: ['transport-live', 'main-live'], gone: true, reused: true })
})

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
  assert.ok(driver.indexOf('Start-Fixture package') < driver.indexOf('Start-Owned $uninstallerCopy.Path'))
  assert.ok(driver.includes('separateSameVersionPackagedPluginAcceptanceVerified = $packageAcceptanceSuccess'))
  assert.ok(driver.includes('Package process cleanup is unconfirmed; retain installation and profiles for VM teardown'))
  assert.ok(driver.indexOf('$packageCleanup.cleanupVerified') < driver.indexOf('Start-Owned $uninstallerCopy.Path'))
  for (const field of ['pluginUserChoicesVerified', 'draftAttachmentRefusalVerified', 'managedHandoffVerified']) assert.ok(driver.includes(`${field} = $false`))
  for (const name of ['package-home', 'package-electron-user-data', 'package-workspace', 'package-fixture-data']) assert.ok(fixture.includes(`'${name}'`))
})
