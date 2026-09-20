/** Static/unit guards and isolated synthetic Win32 captures; never starts an application or installer. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { assertUpgradeRunner, ownedUpgradePath, pinnedUpgradeSourceCommit, upgradeAssetPath, upgradeFileHash, verifyUpgradeRelease } from './fixtures/windows-installed-upgrade-contract.mjs'

const hosted = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1', RUNNER_TEMP: 'C:\\runner-temp' }
const digest = (bytes, algorithm = 'sha256', encoding = 'hex') => createHash(algorithm).update(bytes).digest(encoding)
const canonical = value => Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : value !== null && typeof value === 'object'
  ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}` : JSON.stringify(value)
const jsonHash = value => digest(canonical(value))
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'installed-upgrade-contract-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return realpathSync.native(root)
}
function releaseFixture(t) {
  const root = directory(t)
  const version = '0.1.6-alpha.2.cloga.1'
  const commit = '1'.repeat(40)
  const tree = '2'.repeat(40)
  const installer = { file: `cloga-deepseek-harness-${version}-win-x64.exe`, bytes: 10, sha256: digest('unit bytes'), sha512: digest('unit bytes', 'sha512', 'base64'), signature: 'NotSigned' }
  writeFileSync(join(root, installer.file), 'unit bytes')
  const receiptPayload = {
    action: 'desktop-fork-release', status: 'complete', source: { commit, tree, version }, identity: { sequence: 13 },
    artifacts: { installer, executableSha256: '3'.repeat(64), runtimeSha256: '4'.repeat(64) },
    buildInputs: { lockfileSha256: '5'.repeat(64), planSha256: '6'.repeat(64) },
  }
  const receipt = { ...receiptPayload, receiptSha256: jsonHash(receiptPayload) }
  const receiptBytes = JSON.stringify(receipt)
  writeFileSync(join(root, 'build-receipt.json'), receiptBytes)
  const payload = {
    schemaVersion: 3, owner: 'cloga/deepseek-harness', mode: 'interactive-windows-installer', channel: 'cloga-windows-x64',
    source: { repository: 'cloga/deepseek-harness', commit, tree, tag: `dsh-desktop-v${version}` },
    version, upstreamVersion: '0.1.6-alpha.2', sequence: 13,
    identity: { appId: 'io.github.cloga.deepseek-harness.desktop', productName: 'DeepSeek Harness (cloga)', executableName: 'cloga-deepseek-harness', packageName: 'cloga-deepseek-harness-desktop' },
    installation: { interaction: 'required', installerArguments: [] }, installer,
    buildReceipt: { file: 'build-receipt.json', sha256: digest(receiptBytes), receiptSha256: receipt.receiptSha256 },
    installedEvidence: { executableSha256: receipt.artifacts.executableSha256, runtimeSha256: receipt.artifacts.runtimeSha256 },
    build: { lockfileSha256: receipt.buildInputs.lockfileSha256, planSha256: receipt.buildInputs.planSha256 },
  }
  const writeManifest = () => writeFileSync(join(root, 'release.json'), JSON.stringify({ ...payload, manifestSha256: jsonHash(payload) }))
  writeManifest()
  return { root, payload, writeManifest, expected: { commit, version, upstreamVersion: '0.1.6-alpha.2' } }
}

test('runner guard rejects workstations, self-hosted and non-Windows execution', () => {
  assert.doesNotThrow(() => assertUpgradeRunner(hosted, 'win32'))
  for (const [key, value] of [['GITHUB_ACTIONS', 'false'], ['RUNNER_ENVIRONMENT', 'self-hosted'], ['RUNNER_OS', 'Linux'], ['GITHUB_RUN_ID', ''], ['GITHUB_RUN_ATTEMPT', ''], ['RUNNER_TEMP', '']]) {
    assert.throws(() => assertUpgradeRunner({ ...hosted, [key]: value }, 'win32'))
  }
  assert.throws(() => assertUpgradeRunner(hosted, 'linux'))
})

test('direct fixture invocation refuses a workstation before loading Playwright or starting an app', () => {
  const entry = fileURLToPath(new URL('./fixtures/windows-installed-upgrade-smoke.mjs', import.meta.url))
  const result = spawnSync(process.execPath, [entry], { encoding: 'utf8', env: { ...process.env, GITHUB_ACTIONS: 'false' }, timeout: 10_000 })
  assert.equal(result.error, undefined)
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Installer qualification (?:requires Windows|is GitHub-only)/)
})

for (const [edition, shell] of [
  ['Core', 'pwsh'],
  ['Desktop', join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
]) {
  test(`actual installer helper compiles in fresh PowerShell ${edition} without invoking native methods`, { skip: process.platform !== 'win32' }, t => {
    const helper = fileURLToPath(new URL('./windows-installer-ui.ps1', import.meta.url))
    const script = `
$ErrorActionPreference = 'Stop'
. $env:DSH_INSTALLER_UI_HELPER
$helperType = 'InstallerCapture' -as [type]
if ($null -eq $helperType) { throw 'InstallerCapture was not compiled' }
if ($null -ne $helperType.TypeInitializer) { throw 'InstallerCapture must not run a static initializer' }
$members = @($helperType.GetMethods([System.Reflection.BindingFlags]'Public,Static') | ForEach-Object { $_.Name } | Sort-Object -Unique)
. $env:DSH_INSTALLER_UI_HELPER
if (('InstallerCapture' -as [type]) -ne $helperType) { throw 'Repeated loading replaced the helper type' }
[pscustomobject]@{ edition = $PSVersionTable.PSEdition; version = $PSVersionTable.PSVersion.ToString(); members = $members } | ConvertTo-Json -Compress
`
    const names = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PSMODULEPATH', 'PROGRAMFILES'])
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toUpperCase())))
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: 10_000, env: { ...environment, DSH_INSTALLER_UI_HELPER: helper },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    const observed = JSON.parse(result.stdout.trim())
    assert.equal(observed.edition, edition)
    for (const member of ['Initialize', 'Find', 'FindText', 'FindButton', 'Progress', 'Save', 'SaveStock', 'StockRun', 'DiagnosticText', 'SaveWithShadow', 'SendMessage']) {
      assert.ok(observed.members.includes(member), `Actual helper is missing ${member}`)
    }
    t.diagnostic(`Compilation only: PowerShell ${observed.edition} ${observed.version}`)
  })

  test(`stock capture validates synthetic Win32 pages in PowerShell ${edition}`, { skip: process.platform !== 'win32' }, t => {
    const root = directory(t)
    const helper = fileURLToPath(new URL('./windows-installer-ui.ps1', import.meta.url))
    const script = `
$ErrorActionPreference = 'Stop'
. $env:DSH_INSTALLER_UI_HELPER
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StockCaptureFixture {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint exStyle, string kind, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
    [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool EnableWindow(IntPtr window, bool enabled);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr window, int index, int value);
    public static void ButtonStyle(IntPtr window, int style) { SetWindowLong(window, -16, (GetWindowLong(window, -16) & ~15) | style); }
    public static IntPtr Create(string kind, string title, IntPtr parent, int id) {
        // Off-screen, no activation: PrintWindow captures only these owned windows.
        IntPtr window = CreateWindowEx(0x08000000, kind, title, parent == IntPtr.Zero ? 0x90000000u : 0x50000000u,
            parent == IntPtr.Zero ? -30000 : 10, parent == IntPtr.Zero ? -30000 : 10,
            320, 180, parent, (IntPtr)id, IntPtr.Zero, IntPtr.Zero);
        if (window == IntPtr.Zero) throw new InvalidOperationException("Cannot create synthetic window");
        return window;
    }
}
'@
[InstallerCapture]::ProductName = 'Synthetic stock capture ' + [guid]::NewGuid().ToString()
$rejected = [Collections.Generic.List[string]]::new()
function Reject-Capture([string]$Label, [scriptblock]$Action, [string]$Expected) {
    $failure = $null
    try { & $Action } catch { $failure = $_ }
    if ($null -eq $failure -or $failure.Exception.ToString() -notmatch $Expected) { throw "Missing expected rejection for "+$Label+": "+$failure }
    if (Test-Path -LiteralPath $bad) { throw "Rejected capture wrote a screenshot: $Label" }
    $rejected.Add($Label)
}
function Complete-Fixture($PrimaryFailure, [scriptblock[]]$Cleanup) {
    $failures = [Collections.Generic.List[Exception]]::new()
    if ($null -ne $PrimaryFailure) { $failures.Add($PrimaryFailure.Exception) }
    foreach ($cleanupAction in $Cleanup) {
        try { & $cleanupAction } catch { $failures.Add($_.Exception) }
    }
    if ($failures.Count) { throw [AggregateException]::new('Synthetic capture body/cleanup failed', $failures.ToArray()) }
}
# Pure negative controls exercise the same teardown path without leaking a real window.
try { throw 'synthetic primary failure' } catch { $originalFailure = $_ }
$cleanupTrace = [Collections.Generic.List[string]]::new()
$combinedFailure = $null
try {
    Complete-Fixture $originalFailure @(
        { $cleanupTrace.Add('destroy'); throw 'synthetic destruction failure' },
        { $cleanupTrace.Add('verify'); throw 'synthetic survivor failure' }
    )
} catch { $combinedFailure = $_.Exception }
if ($combinedFailure -isnot [AggregateException]) { throw 'Combined failure was not aggregated' }
$primaryOnly = $null
try { Complete-Fixture $originalFailure @({}) } catch { $primaryOnly = $_.Exception }
$cleanupOnly = $null
try { Complete-Fixture $null @({ throw 'synthetic cleanup-only failure' }) } catch { $cleanupOnly = $_.Exception }
$cleanupFailures = @{
    messages = @($combinedFailure.InnerExceptions | ForEach-Object { $_.Message })
    trace = @($cleanupTrace)
    originalRetained = [object]::ReferenceEquals($combinedFailure.InnerExceptions[0], $originalFailure.Exception)
    primaryOnly = @($primaryOnly.InnerExceptions | ForEach-Object { $_.Message })
    cleanupOnly = @($cleanupOnly.InnerExceptions | ForEach-Object { $_.Message })
}
$bad = Join-Path $env:DSH_STOCK_CAPTURE_ROOT 'rejected.png'
$primaryFailure = $null
$window = [StockCaptureFixture]::Create('#32770', [InstallerCapture]::ProductName, [IntPtr]::Zero, 0)
try {
    # NSIS page controls are nested under an inner dialog; Next/Finish is on the root.
    $page = [StockCaptureFixture]::Create('#32770', '', $window, 1018)
    $directory = [StockCaptureFixture]::Create('Edit', 'Synthetic path', $page, 1019)
    $action = [StockCaptureFixture]::Create('Button', 'Next', $window, 1)
    if ([InstallerCapture]::GetProp($window, 'HarnessInstaller.Ready') -ne [IntPtr]::Zero) { throw 'Synthetic stock window unexpectedly has native readiness' }
    $dimensions = [InstallerCapture]::SaveStock($PID, $window, 1019, (Join-Path $env:DSH_STOCK_CAPTURE_ROOT 'directory.png'))
    Reject-Capture 'foreign-pid' { [InstallerCapture]::SaveStock(($PID + 1), $window, 1019, $bad) } 'live owned installer dialog'
    Reject-Capture 'invalid-pid' { [InstallerCapture]::SaveStock(0, $window, 1019, $bad) } 'live owned installer dialog'
    Reject-Capture 'zero-window' { [InstallerCapture]::SaveStock($PID, [IntPtr]::Zero, 1019, $bad) } 'live owned installer dialog'
    Reject-Capture 'invalid-window' { [InstallerCapture]::SaveStock($PID, [IntPtr](-1), 1019, $bad) } 'live owned installer dialog'
    Reject-Capture 'child-window' { [InstallerCapture]::SaveStock($PID, $page, 1019, $bad) } 'live owned installer dialog'
    Reject-Capture 'unsupported-page' { [InstallerCapture]::SaveStock($PID, $window, 999, $bad) } 'Unsupported stock installer page'
    Reject-Capture 'absent-finish' { [InstallerCapture]::SaveStock($PID, $window, 1203, $bad) } 'control 1203'
    [void][StockCaptureFixture]::EnableWindow($directory, $false)
    Reject-Capture 'disabled-directory' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'control 1019'
    [void][StockCaptureFixture]::EnableWindow($directory, $true)
    [void][StockCaptureFixture]::ShowWindow($directory, 0)
    Reject-Capture 'hidden-directory' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'control 1019'
    [void][StockCaptureFixture]::ShowWindow($directory, 8)
    [void][StockCaptureFixture]::EnableWindow($action, $false)
    Reject-Capture 'disabled-action' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'control 1'
    [void][StockCaptureFixture]::EnableWindow($action, $true)
    [void][StockCaptureFixture]::EnableWindow($window, $false)
    Reject-Capture 'disabled-window' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'live owned installer dialog'
    [void][StockCaptureFixture]::EnableWindow($window, $true)
    [void][StockCaptureFixture]::ShowWindow($window, 0)
    Reject-Capture 'hidden-window' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'live owned installer dialog'
    [void][StockCaptureFixture]::ShowWindow($window, 8)
    [void][InstallerCapture]::SetWindowText($window, 'Wrong product')
    Reject-Capture 'wrong-title' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'live owned installer dialog'
    [void][InstallerCapture]::SetWindowText($window, [InstallerCapture]::ProductName)
    # The custom entry still times out instead of accepting this usable stock page.
    Reject-Capture 'custom-not-ready' { [InstallerCapture]::Save($window, $bad) } 'Native page did not finish creating controls'
    if (-not [StockCaptureFixture]::DestroyWindow($directory)) { throw 'Could not destroy directory control' }
    Reject-Capture 'stale-page' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'control 1019'
    # Model pinned MUI2 Finish.nsh creation order, not a hand-assigned Run ID.
    # nsDialogs.c (v304) resets controlCount=0 and CreateControl uses 1200+id.
    $finishControls = @()
    foreach ($caption in @('bitmap', 'title', 'text', ('&Run ' + [InstallerCapture]::ProductName))) {
        $kind = if ($finishControls.Count -eq 3) { 'Button' } else { 'Static' }
        $finishControls += [StockCaptureFixture]::Create($kind, $caption, $page, (1200 + $finishControls.Count))
    }
    $checkbox = $finishControls[3]
    $finishId = [StockCaptureFixture]::GetDlgCtrlID($checkbox)
    [StockCaptureFixture]::ButtonStyle($checkbox, 3)
    [void][InstallerCapture]::SetWindowText($action, '&Finish')
    if ([InstallerCapture]::StockRun($PID, $window) -ne $checkbox) { throw 'Run control identity differs' }
    [void][InstallerCapture]::SaveStock($PID, $window, $finishId, (Join-Path $env:DSH_STOCK_CAPTURE_ROOT 'finish.png'))
    Reject-Capture 'obsolete-finish-id' { [InstallerCapture]::SaveStock($PID, $window, 1204, $bad) } 'Unsupported stock installer page'
    [StockCaptureFixture]::ButtonStyle($checkbox, 9)
    Reject-Capture 'reboot-radio' { [InstallerCapture]::StockRun($PID, $window) } 'Run auto-checkbox'
    [StockCaptureFixture]::ButtonStyle($checkbox, 3)
    [void][InstallerCapture]::SetWindowText($checkbox, 'Reboot now')
    Reject-Capture 'wrong-run-caption' { [InstallerCapture]::StockRun($PID, $window) } 'Run auto-checkbox'
    [void][InstallerCapture]::SetWindowText($checkbox, ('&Run ' + [InstallerCapture]::ProductName))
    [void][InstallerCapture]::SetWindowText($action, '&Next')
    Reject-Capture 'wrong-finish-caption' { [InstallerCapture]::SaveStock($PID, $window, $finishId, $bad) } 'finish action caption'
    [void][InstallerCapture]::SetWindowText($action, '&Finish')
    [void][InstallerCapture]::SendMessage($checkbox, 0xF1, [IntPtr]1, [IntPtr]::Zero)
    $diagnostic = [InstallerCapture]::DiagnosticText($PID)
    if (-not [InstallerCapture]::IsWindow($checkbox) -or [InstallerCapture]::SendMessage($checkbox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 1) { throw 'Observation mutated owned controls' }
    $foreignDiagnostic = [InstallerCapture]::DiagnosticText(($PID + 1))
    [void][StockCaptureFixture]::EnableWindow($checkbox, $false)
    Reject-Capture 'disabled-finish' { [InstallerCapture]::SaveStock($PID, $window, 1203, $bad) } 'control 1203'
    [void][StockCaptureFixture]::EnableWindow($checkbox, $true)
    if (-not [StockCaptureFixture]::DestroyWindow($action)) { throw 'Could not destroy action control' }
    Reject-Capture 'absent-action' { [InstallerCapture]::SaveStock($PID, $window, 1203, $bad) } 'control 1'
    $wrongAction = [StockCaptureFixture]::Create('Static', 'Not a button', $window, 1)
    Reject-Capture 'wrong-action-class' { [InstallerCapture]::SaveStock($PID, $window, 1203, $bad) } 'control 1'
    if (-not [StockCaptureFixture]::DestroyWindow($wrongAction)) { throw 'Could not destroy wrong action' }
    $action = [StockCaptureFixture]::Create('Button', 'Finish', $window, 1)
    if (-not [StockCaptureFixture]::DestroyWindow($checkbox)) { throw 'Could not destroy finish control' }
    $wrongPage = [StockCaptureFixture]::Create('Edit', 'Not a checkbox', $page, 1203)
    Reject-Capture 'wrong-page-class' { [InstallerCapture]::SaveStock($PID, $window, 1203, $bad) } 'control 1203'
    $extraControls = @()
    for ($index = 0; $index -lt 70; $index++) { $extraControls += [StockCaptureFixture]::Create('Static', 'bounded', $window, (2000 + $index)) }
    $limitedDiagnostic = [InstallerCapture]::DiagnosticText($PID)
} catch { $primaryFailure = $_ } finally {
    Complete-Fixture $primaryFailure @(
        { if (-not [StockCaptureFixture]::DestroyWindow($window)) { throw 'Could not destroy owned synthetic dialog' } },
        {
            $survivors = @((@($window, $page, $directory, $action, $checkbox, $wrongAction, $wrongPage) + @($finishControls) + @($extraControls)) |
                Where-Object { $_ -and [InstallerCapture]::IsWindow($_) })
            if ($survivors.Count) { throw ('Synthetic windows survived cleanup: ' + ($survivors -join ', ')) }
        }
    )
}
Reject-Capture 'stale-window' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'live owned installer dialog'
$primaryFailure = $null
$other = [StockCaptureFixture]::Create('Static', [InstallerCapture]::ProductName, [IntPtr]::Zero, 0)
try {
    Reject-Capture 'wrong-window-class' { [InstallerCapture]::SaveStock($PID, $other, 1019, $bad) } 'live owned installer dialog'
} catch { $primaryFailure = $_ } finally {
    Complete-Fixture $primaryFailure @(
        { if (-not [StockCaptureFixture]::DestroyWindow($other)) { throw 'Could not destroy wrong-class window' } },
        { if ([InstallerCapture]::IsWindow($other)) { throw 'Wrong-class window survived cleanup' } }
    )
}
[pscustomobject]@{ dimensions = $dimensions; finishId = $finishId; diagnostic = $diagnostic; foreignDiagnostic = $foreignDiagnostic; limitedDiagnostic = $limitedDiagnostic; rejected = @($rejected); cleanupVerified = $true; cleanupFailures = $cleanupFailures } | ConvertTo-Json -Depth 4 -Compress
`
    const names = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PSMODULEPATH', 'PROGRAMFILES'])
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toUpperCase())))
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      // The real custom readiness timeout is 10 seconds; leave room for compilation and teardown.
      encoding: 'utf8', timeout: 40_000, env: { ...environment, DSH_INSTALLER_UI_HELPER: helper, DSH_STOCK_CAPTURE_ROOT: root },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    const observed = JSON.parse(result.stdout.trim())
    assert.equal(observed.dimensions, '320x180')
    assert.equal(observed.cleanupVerified, true)
    assert.equal(observed.finishId, 1203)
    assert.match(observed.diagnostic, /CLASS=Button ID=1203 VISIBLE=True ENABLED=True STYLE=\d+ CHECK=1 TEXT=&Run Synthetic stock capture/u)
    assert.doesNotMatch(observed.foreignDiagnostic, /Synthetic stock capture/u)
    assert.match(observed.limitedDiagnostic, /LIMIT_REACHED=True/u)
    assert.equal(observed.limitedDiagnostic.match(/^HWND=/gmu).length, 64)
    assert.deepEqual(observed.cleanupFailures, {
      messages: ['synthetic primary failure', 'synthetic destruction failure', 'synthetic survivor failure'],
      trace: ['destroy', 'verify'],
      originalRetained: true,
      primaryOnly: ['synthetic primary failure'],
      cleanupOnly: ['synthetic cleanup-only failure'],
    })
    assert.deepEqual(observed.rejected, [
      'foreign-pid', 'invalid-pid', 'zero-window', 'invalid-window', 'child-window', 'unsupported-page', 'absent-finish',
      'disabled-directory', 'hidden-directory', 'disabled-action', 'disabled-window', 'hidden-window', 'wrong-title',
      'custom-not-ready', 'stale-page', 'obsolete-finish-id', 'reboot-radio', 'wrong-run-caption', 'wrong-finish-caption', 'disabled-finish', 'absent-action', 'wrong-action-class', 'wrong-page-class',
      'stale-window', 'wrong-window-class',
    ])
    for (const file of ['directory.png', 'finish.png']) {
      const png = readFileSync(join(root, file))
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      assert.equal(png.readUInt32BE(16), 320)
      assert.equal(png.readUInt32BE(20), 180)
    }
    t.diagnostic('Synthetic Win32 windows only; not actual hosted installer qualification')
  })
}

function powershellUnit(t, body, extraEnv = {}) {
  const root = directory(t)
  const script = join(root, 'fixture-unit.ps1')
  writeFileSync(script, "$ErrorActionPreference = 'Stop'\n" + body)
  const names = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PSMODULEPATH', 'PROGRAMFILES'])
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toUpperCase())))
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', timeout: 15_000, env: { ...environment, ...extraEnv } })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim())
}

test('native baseline binding hashes original acquired bytes before deriving its source', { skip: process.platform !== 'win32' }, t => {
  const root = directory(t)
  const manifest = join(root, 'release.json')
  const bytes = JSON.stringify({ source: { repository: 'cloga/deepseek-harness', tag: 'dsh-desktop-v0.1.6-alpha.1.cloga.2', commit: '2'.repeat(40) }, manifestSha256: '3'.repeat(64) })
  writeFileSync(manifest, bytes)
  const observed = powershellUnit(t, `
. $env:DSH_REGISTRATION_HELPER
$path = $env:DSH_MANIFEST
$pin = $env:DSH_MANIFEST_DIGEST
$tag = 'dsh-desktop-v0.1.6-alpha.1.cloga.2'
$source = Get-PinnedInstallerBaselineSource $path $pin $tag
$rejected = @()
function Reject-Source($Label, [scriptblock]$Action) {
    $failure = $null
    try { & $Action | Out-Null } catch { $failure = $_ }
    if ($null -eq $failure) { throw ('Accepted unbound source: ' + $Label) }
    $script:rejected += $Label
}
Reject-Source 'internal-self-hash' { Get-PinnedInstallerBaselineSource $path ('3' * 64) $tag }
Reject-Source 'wrong-tag' { Get-PinnedInstallerBaselineSource $path $pin 'other-tag' }
Reject-Source 'directory' { Get-PinnedInstallerBaselineSource $PSScriptRoot $pin $tag }
$changed = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
$changed.source.commit = '4' * 40
$changed.manifestSha256 = '5' * 64
$changed | ConvertTo-Json | Set-Content -LiteralPath $path
Reject-Source 'substituted-source-and-self-hash' { Get-PinnedInstallerBaselineSource $path $pin $tag }
[pscustomobject]@{ source = $source; rejected = $rejected } | ConvertTo-Json -Compress
`, { DSH_REGISTRATION_HELPER: fileURLToPath(new URL('./fixtures/windows-installer-registration.ps1', import.meta.url)), DSH_MANIFEST: manifest, DSH_MANIFEST_DIGEST: digest(bytes) })
  writeFileSync(manifest, bytes)
  assert.equal(observed.source, '2'.repeat(40))
  assert.equal(observed.source, pinnedUpgradeSourceCommit(root, digest(bytes)))
  assert.deepEqual(observed.rejected, ['internal-self-hash', 'wrong-tag', 'directory', 'substituted-source-and-self-hash'])
})

test('cleanup rejects parent and root junctions before hashing or invoking the uninstaller', { skip: process.platform !== 'win32' }, t => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const readRegistration = source.match(/function Read-Registration[^]*?\r?\n\}/u)?.[0]
  assert.ok(readRegistration)
  const start = source.indexOf('            $hasRegistration = ')
  const launch = "                Wait-Exit (Start-Owned $uninstaller '/S') 120"
  const end = source.indexOf(launch, start)
  assert.ok(start >= 0 && end > start)
  const admission = source.slice(start, end + launch.length) + '\n            }'
  const observed = powershellUnit(t, `
. $env:DSH_REGISTRATION_HELPER
${readRegistration}
# Only registry/process boundaries are synthetic; execute the driver's actual cleanup admission.
function Product-Registrations { [pscustomobject]@{ Id = 'synthetic-registered-install' } }
function Resolve-InstallerRegistration { [pscustomobject]@{ ExecutableSha256 = ('a' * 64) } }
function Get-FileHash { $script:hashCalls++; [pscustomobject]@{ Hash = ('a' * 64) } }
function Wait-NoProductProcesses {}
function Start-Owned($File, $Arguments) {
    if ($File -cne $uninstaller -or $Arguments -cne '/S') { throw 'Unexpected synthetic launch' }
    $script:uninstallerCalls++
    return 'not-a-process'
}
function Wait-Exit {}
$root = Join-Path $PSScriptRoot 'run-root'
$parent = Join-Path $root 'Installed App'
$installPath = Join-Path $parent 'cloga-deepseek-harness-desktop'
$application = Join-Path $installPath 'cloga-deepseek-harness.exe'
$uninstaller = Join-Path $installPath 'Uninstall cloga-deepseek-harness.exe'
New-Item -ItemType Directory -Path $installPath | Out-Null
Set-Content -LiteralPath $application -Value 'synthetic payload, never executable' -NoNewline
Set-Content -LiteralPath $uninstaller -Value 'synthetic uninstaller, never executable' -NoNewline
$cleanup = {
${admission}
}
$hashCalls = 0; $uninstallerCalls = 0
& $cleanup
if ($hashCalls -ne 1 -or $uninstallerCalls -ne 1) { throw 'Ordinary owned cleanup was not admitted' }
$rejected = @()
foreach ($case in @('parent', 'root')) {
    $alias = if ($case -eq 'parent') { $parent } else { $root }
    $relocated = Join-Path $PSScriptRoot ('relocated-' + $case)
    Move-Item -LiteralPath $alias -Destination $relocated
    try {
        New-Item -ItemType Junction -Path $alias -Target $relocated | Out-Null
        try {
            $hashCalls = 0; $uninstallerCalls = 0; $failure = $null
            try { & $cleanup } catch { $failure = $_ }
            if ($null -eq $failure -or $failure.Exception.Message -notmatch 'filesystem alias') { throw ('Cleanup accepted ' + $case + ' junction') }
            if ($hashCalls -ne 0 -or $uninstallerCalls -ne 0) { throw 'Cleanup touched bytes or launched through an alias' }
            $rejected += $case
        } finally { Remove-Item -LiteralPath $alias -Force }
    } finally { Move-Item -LiteralPath $relocated -Destination $alias }
}
if ((Get-Content -LiteralPath $uninstaller -Raw) -cne 'synthetic uninstaller, never executable') { throw 'Cleanup mutated retained evidence' }
[pscustomobject]@{ rejected = $rejected; hashCalls = $hashCalls; uninstallerCalls = $uninstallerCalls; payloadRetained = $true } | ConvertTo-Json -Compress
`, { DSH_REGISTRATION_HELPER: fileURLToPath(new URL('./fixtures/windows-installer-registration.ps1', import.meta.url)) })
  assert.deepEqual(observed, { rejected: ['parent', 'root'], hashCalls: 0, uninstallerCalls: 0, payloadRetained: true })
})

test('production registration GUID is bound to the exact appId and pinned builder namespace', () => {
  const bytes = createHash('sha1').update(Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex')).update('io.github.cloga.deepseek-harness.desktop').digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const id = bytes.toString('hex').replace(/^(........)(....)(....)(....)(............)$/u, '$1-$2-$3-$4-$5')
  assert.equal(id, 'e82f4b7a-f955-53af-bd9b-031d4e7ad569')
  const source = readFileSync(new URL('./fixtures/windows-installer-registration.ps1', import.meta.url), 'utf8')
  assert.ok(source.includes(`$id = '${id}'`))
  assert.ok(source.includes("$owner.GetValue('InstallLocation', $null,"))
  assert.doesNotMatch(source, /Get-ChildItem|Set-ItemProperty|CreateSubKey|SetValue/u)
  assert.ok(source.includes('$base.OpenSubKey($ownerPath, $false)'))
  assert.ok(source.includes('$base.OpenSubKey($uninstallPath, $false)'))
  for (const name of ['owner', 'uninstall', 'base']) assert.ok(source.includes(`$${name}.Dispose()`))
})

test('exact baseline and candidate registrations accept only identical view aliases and verified identities', { skip: process.platform !== 'win32' }, t => {
  const root = directory(t)
  const input = join(root, 'records.json')
  const id = 'e82f4b7a-f955-53af-bd9b-031d4e7ad569'
  const installPath = join(root, 'Installed App', 'cloga-deepseek-harness-desktop')
  const baselineSource = '2'.repeat(40)
  const candidateSource = '1'.repeat(40)
  const release = (version, commit) => ({ manifest: {
    version, source: { repository: 'cloga/deepseek-harness', commit },
    identity: { appId: 'io.github.cloga.deepseek-harness.desktop', productName: 'DeepSeek Harness (cloga)', executableName: 'cloga-deepseek-harness', packageName: 'cloga-deepseek-harness-desktop' },
    installedEvidence: { executableSha256: (commit === baselineSource ? 'a' : 'b').repeat(64) },
  } })
  const baseline = release('0.1.6-alpha.1.cloga.2', baselineSource)
  const candidate = release('0.1.6-alpha.2.cloga.1', candidateSource)
  const record = version => ({
    Id: id, Hive: 'CurrentUser', View: 'Registry64', OwnerKey: `Software\\${id}`, Key: `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}`,
    OwnerPresent: true, UninstallPresent: true, InstallLocation: installPath,
    DisplayName: `DeepSeek Harness (cloga) ${version}`, DisplayVersion: version,
    // Stock NSIS uses PRODUCT_FILENAME, derived from executableName rather than productName.
    UninstallString: `"${join(installPath, 'Uninstall cloga-deepseek-harness.exe')}" /currentuser`,
    QuietUninstallString: `"${join(installPath, 'Uninstall cloga-deepseek-harness.exe')}" /currentuser /S`,
  })
  const old = record(baseline.manifest.version)
  const next = record(candidate.manifest.version)
  const cases = [
    ['missing', []], ['32-only', [{ ...old, View: 'Registry32' }]], ['duplicate-view', [old, old]],
    ['foreign-machine', [old, { ...old, Hive: 'LocalMachine' }]],
    ...Object.entries({
      Id: 'other-guid', OwnerKey: 'Software\\other', Key: 'Software\\other', OwnerPresent: false, UninstallPresent: false,
      InstallLocation: installPath + '-foreign', DisplayName: 'DeepSeek Harness (cloga)', DisplayVersion: '0.1.6-alpha.1.cloga.99',
      UninstallString: old.UninstallString.replaceAll('"', ''), QuietUninstallString: old.QuietUninstallString + ' /foreign',
    }).map(([field, value]) => [`wrong-${field}`, [{ ...old, [field]: value }]]),
    ['old-uninstall-location-assumption', [{ ...old, OwnerPresent: false, InstallLocation: null }]],
    ['conflicting-alias-path', [old, { ...old, View: 'Registry32', InstallLocation: installPath + '-foreign' }]],
    ['conflicting-alias-version', [old, { ...next, View: 'Registry32' }]],
    ['missing-mode', [{ ...old, UninstallString: old.UninstallString.replace(' /currentuser', '') }]],
    ['wrong-mode', [{ ...old, UninstallString: old.UninstallString.replace('/currentuser', '/allusers') }]],
    ['foreign-uninstaller', [{ ...old, UninstallString: '"C:\\foreign.exe" /currentuser' }]],
    ['display-name-uninstaller', [{ ...old,
      UninstallString: `"${join(installPath, 'Uninstall DeepSeek Harness (cloga).exe')}" /currentuser`,
      QuietUninstallString: `"${join(installPath, 'Uninstall DeepSeek Harness (cloga).exe')}" /currentuser /S`,
    }]],
    ['package-name-uninstaller', [{ ...old,
      UninstallString: `"${join(installPath, 'Uninstall cloga-deepseek-harness-desktop.exe')}" /currentuser`,
      QuietUninstallString: `"${join(installPath, 'Uninstall cloga-deepseek-harness-desktop.exe')}" /currentuser /S`,
    }]],
    ['command-injection', [{ ...old, UninstallString: old.UninstallString + ' & echo injected' }]],
    ['trailing-uninstall-arguments', [{ ...old, UninstallString: old.UninstallString + ' /S' }]],
    ['quiet-foreign-uninstaller', [{ ...old, QuietUninstallString: '"C:\\foreign.exe" /currentuser /S' }]],
    ['quiet-missing-mode', [{ ...old, QuietUninstallString: old.QuietUninstallString.replace(' /currentuser', '') }]],
    ['quiet-wrong-mode', [{ ...old, QuietUninstallString: old.QuietUninstallString.replace('/currentuser', '/allusers') }]],
    ['quiet-missing-silent', [{ ...old, QuietUninstallString: old.UninstallString }]],
  ]
  const invalidReleases = [
    ['source', { ...candidate.manifest, source: { ...candidate.manifest.source, commit: '2'.repeat(40) } }],
    ['repository', { ...candidate.manifest, source: { ...candidate.manifest.source, repository: 'other/repository' } }],
    ['version', { ...candidate.manifest, version: 'unversioned' }],
    ['executable-hash', { ...candidate.manifest, installedEvidence: { executableSha256: 'invalid' } }],
    ...['appId', 'productName', 'packageName', 'executableName'].map(field => [field, { ...candidate.manifest, identity: { ...candidate.manifest.identity, [field]: 'foreign' } }]),
  ]
  writeFileSync(input, JSON.stringify({ installPath, baselineSource, candidateSource, baseline, candidate, old, next, cases, invalidReleases }))
  const observed = powershellUnit(t, `
. $env:DSH_REGISTRATION_HELPER
# Pure validation must not observe or mutate this machine's production registry.
function Get-InstallerRegistrationEntries { throw 'Unit test attempted registry access' }
$data = Get-Content -LiteralPath $env:DSH_REGISTRATION_INPUT -Raw | ConvertFrom-Json
$oldIdentity = New-InstallerRegistrationIdentity $data.baseline $data.baselineSource
$newIdentity = New-InstallerRegistrationIdentity $data.candidate $data.candidateSource
$identities = @($oldIdentity, $newIdentity)
$accepted = @()
foreach ($entry in @($data.old, $data.next)) {
    $accepted += Resolve-InstallerRegistration @($entry) $identities $data.installPath
    $alias = $entry.PSObject.Copy()
    $alias.View = 'Registry32'
    $accepted += Resolve-InstallerRegistration @($entry, $alias) $identities $data.installPath
}
$rejected = @()
foreach ($case in $data.cases) {
    $failure = $null
    try { [void](Resolve-InstallerRegistration @($case[1]) $identities $data.installPath) } catch { $failure = $_ }
    if ($null -eq $failure) { throw ('Accepted invalid registration: ' + $case[0]) }
    $rejected += $case[0]
}
foreach ($case in $data.invalidReleases) {
    $failure = $null
    try { [void](New-InstallerRegistrationIdentity ([pscustomobject]@{ manifest = $case[1] }) $data.candidateSource) } catch { $failure = $_ }
    if ($null -eq $failure) { throw ('Accepted substituted identity: ' + $case[0]) }
    $rejected += ('release-' + $case[0])
}
$failure = $null
try { [void](Resolve-InstallerRegistration @($data.next) @($oldIdentity) $data.installPath) } catch { $failure = $_ }
if ($null -eq $failure) { throw 'Candidate accepted during baseline-only phase' }
[pscustomobject]@{ accepted = $accepted; rejected = $rejected; phaseRejected = $true } | ConvertTo-Json -Depth 5 -Compress
`, { DSH_REGISTRATION_HELPER: fileURLToPath(new URL('./fixtures/windows-installer-registration.ps1', import.meta.url)), DSH_REGISTRATION_INPUT: input })
  assert.deepEqual(observed.accepted.map(value => [value.Version, value.Source, value.ExecutableSha256]), [
    [baseline.manifest.version, baselineSource, 'a'.repeat(64)], [baseline.manifest.version, baselineSource, 'a'.repeat(64)],
    [candidate.manifest.version, candidateSource, 'b'.repeat(64)], [candidate.manifest.version, candidateSource, 'b'.repeat(64)],
  ])
  assert.ok(observed.accepted.every(value => value.Id === id && value.InstallLocation === installPath))
  assert.deepEqual(observed.rejected, [...cases.map(([name]) => name), ...invalidReleases.map(([name]) => `release-${name}`)])
  assert.equal(observed.phaseRejected, true)
})

test('driver binds registration and stock Run admission before trusting installed state', () => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  assert.ok(source.includes("$uninstaller = Join-Path $installPath 'Uninstall cloga-deepseek-harness.exe'"))
  assert.ok(source.includes("Get-PinnedInstallerBaselineSource (Join-Path $baseline 'release.json') $baselinePin.manifest.sha256 $baselinePin.tag"))
  assert.ok(source.includes("Join-Path $PSScriptRoot 'fixtures/windows-upgrade-baseline.json'"))
  assert.ok(source.includes('New-InstallerRegistrationIdentity $validated.previous $baselineSource'))
  assert.ok(source.includes('New-InstallerRegistrationIdentity $validated.candidate $ExpectedSourceCommit'))
  assert.ok(source.indexOf('$registrationIdentities = @($baselineIdentity, $candidateIdentity)') < source.indexOf('$installationAttempted = $true'))
  assert.equal(source.match(/Read-Registration @\(\$baselineIdentity\)/gu).length, 2)
  assert.equal(source.match(/Read-Registration @\(\$candidateIdentity\)/gu).length, 1)
  assert.ok(source.includes('-cne $entry.ExecutableSha256'))
  const registration = source.split('function Read-Registration')[1].split('function Write-InstallerFailureDiagnostics')[0]
  assert.ok(registration.indexOf('Assert-InstallerOwnedPath $root $path') < registration.indexOf('Get-FileHash -LiteralPath $application'))
  const legacyFinish = source.split('function Finish-LegacyInstaller')[1].split('function Start-Installer')[0]
  assert.ok(legacyFinish.indexOf('::StockRun($Process.Id, $window)') < legacyFinish.indexOf('::Click($checkbox)'))
  assert.ok(legacyFinish.includes("throw 'Baseline launch checkbox default changed'"))
  assert.ok(legacyFinish.includes("throw 'Could not disable baseline automatic launch'"))
})

test('failure observations precede process cleanup and cannot replace the primary error', { skip: process.platform !== 'win32' }, t => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const diagnostic = source.match(/function Write-InstallerFailureDiagnostics[^]*?\r?\n\}/u)?.[0]
  assert.ok(diagnostic)
  const handler = source.slice(source.indexOf('    $failure = $_\n    Write-InstallerFailureDiagnostics'))
  assert.ok(handler.indexOf('Write-InstallerFailureDiagnostics') < handler.indexOf('Stop-OwnedProcesses $processes'))
  const observed = powershellUnit(t, `
${diagnostic}
Add-Type 'public static class InstallerCapture { public static string DiagnosticText(int pid) { throw new System.InvalidOperationException("synthetic UI read failure"); } }'
function Product-Registrations { [pscustomobject]@{ Id = 'synthetic-registration-only' } }
$root = $PSScriptRoot
New-Item -ItemType Directory -Path (Join-Path $root 'evidence') | Out-Null
$errors = [Collections.Generic.List[string]]::new()
try { throw 'primary installer failure' } catch { $failure = $_; $original = $_ }
Write-InstallerFailureDiagnostics @([pscustomobject]@{ HasExited = $false; Id = 123 }) $errors
$registration = Get-Content -LiteralPath (Join-Path $root 'evidence/installer-failure-registration.json') -Raw | ConvertFrom-Json
$root = Join-Path $root 'absent-parent'
Write-InstallerFailureDiagnostics @() $errors
[pscustomobject]@{ samePrimary = [object]::ReferenceEquals($failure, $original); messages = @($errors); registration = @($registration) } | ConvertTo-Json -Depth 4 -Compress
`)
  assert.equal(observed.samePrimary, true)
  assert.deepEqual(observed.registration, [{ Id: 'synthetic-registration-only' }])
  assert.equal(observed.messages.length, 2)
  assert.match(observed.messages[0], /Owned installer UI observation failed: .*synthetic UI read failure/u)
  assert.match(observed.messages[1], /Installer registration observation failed:/u)
})

test('transaction guard rejects real target-parent staging siblings without deleting evidence', { skip: process.platform !== 'win32' }, t => {
  const driver = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const guard = driver.match(/function Assert-NoTransactionDirectories \{[^]*?\r?\n\}/u)?.[0]
  assert.ok(guard)
  const installer = readFileSync(new URL('../scripts/installer-directories.nsh', import.meta.url), 'utf8')
  assert.ok(installer.includes('StrCpy $dshNewDirectory "$INSTDIR.new-$0"'))
  assert.ok(installer.includes('StrCpy $dshOldDirectory "$INSTDIR.old-$0"'))
  const observed = powershellUnit(t, `
${guard}
$root = $PSScriptRoot
$installPath = Join-Path $root 'Installed App/cloga-deepseek-harness-desktop'
Assert-NoTransactionDirectories
New-Item -ItemType Directory -Path $installPath | Out-Null
Assert-NoTransactionDirectories
$rejected = @()
foreach ($stage in @('new', 'old')) {
    $path = $installPath + '.' + $stage + '-{11111111-1111-4111-8111-111111111111}'
    New-Item -ItemType Directory -Path $path | Out-Null
    if ($stage -eq 'old') { (Get-Item -LiteralPath $path).Attributes = [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::Hidden }
    $sentinel = Join-Path $path 'evidence.txt'
    Set-Content -LiteralPath $sentinel -Value 'retained staged bytes' -NoNewline
    $failure = $null
    try { Assert-NoTransactionDirectories } catch { $failure = $_ }
    if ($null -eq $failure -or $failure.Exception.Message -notmatch 'transaction directory') { throw ('Guard missed exact staging sibling: ' + $stage) }
    if ((Get-Content -LiteralPath $sentinel -Raw) -cne 'retained staged bytes') { throw 'Guard mutated staged evidence' }
    $rejected += $stage
    Remove-Item -LiteralPath $path -Recurse -Force
}
Assert-NoTransactionDirectories
[pscustomobject]@{ rejected = $rejected; cleanAccepted = $true } | ConvertTo-Json -Compress
`)
  assert.deepEqual(observed, { rejected: ['new', 'old'], cleanAccepted: true })
})

test('owned paths reject roots, escapes and existing junction ancestors', t => {
  const root = directory(t)
  assert.equal(root, realpathSync.native(root))
  assert.equal(ownedUpgradePath(root, join(root, 'new', 'home')), join(root, 'new', 'home'))
  assert.throws(() => ownedUpgradePath(root, root))
  assert.throws(() => ownedUpgradePath(root, join(root, '..', 'other')))
  const target = join(root, 'target')
  mkdirSync(target)
  symlinkSync(target, join(root, 'alias'), process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => ownedUpgradePath(root, join(root, 'alias', 'home')))
})

test('manifest assets cannot escape the acquisition directory', t => {
  const root = directory(t)
  assert.equal(upgradeAssetPath(root, 'build-receipt.json'), join(root, 'build-receipt.json'))
  for (const value of ['../evil.exe', '..\\evil.exe', 'C:\\evil.exe', 'https://example/evil', '/evil', '', '.']) assert.throws(() => upgradeAssetPath(root, value))
})

test('exact finalized bytes and receipt bindings are accepted as inputs, not execution evidence', t => {
  const f = releaseFixture(t)
  const verified = verifyUpgradeRelease(f.root, f.expected, jsonHash)
  assert.equal(verified.manifest.source.commit, f.expected.commit)
  assert.equal(verified.manifestFileSha256, upgradeFileHash(join(f.root, 'release.json')))
  assert.throws(() => verifyUpgradeRelease(f.root, { ...f.expected, manifestSha256: '0'.repeat(64) }, jsonHash))
})

test('derives baseline source identity from raw pinned bytes and rejects substituted commits', t => {
  const f = releaseFixture(t)
  const rawDigest = upgradeFileHash(join(f.root, 'release.json'))
  assert.equal(pinnedUpgradeSourceCommit(f.root, rawDigest), f.expected.commit)
  assert.throws(() => pinnedUpgradeSourceCommit(f.root, '0'.repeat(64)))
  const changed = JSON.parse(readFileSync(join(f.root, 'release.json'), 'utf8'))
  changed.source.commit = 'f'.repeat(40)
  changed.manifestSha256 = jsonHash(Object.fromEntries(Object.entries(changed).filter(([key]) => key !== 'manifestSha256')))
  writeFileSync(join(f.root, 'release.json'), JSON.stringify(changed))
  assert.throws(() => pinnedUpgradeSourceCommit(f.root, rawDigest), /reviewed digest/)
})

test('different source commit, product identity or silent mode is rejected', t => {
  const f = releaseFixture(t)
  assert.throws(() => verifyUpgradeRelease(f.root, { ...f.expected, commit: 'f'.repeat(40) }, jsonHash))
  f.payload.identity.appId = 'dummy.test.product'
  f.writeManifest()
  assert.throws(() => verifyUpgradeRelease(f.root, f.expected, jsonHash))
  f.payload.identity.appId = 'io.github.cloga.deepseek-harness.desktop'
  f.payload.installation.installerArguments = ['/S']
  f.writeManifest()
  assert.throws(() => verifyUpgradeRelease(f.root, f.expected, jsonHash))
})

test('changed installer, receipt or self-hash is rejected', t => {
  const f = releaseFixture(t)
  writeFileSync(join(f.root, f.payload.installer.file), 'tampered!!')
  assert.throws(() => verifyUpgradeRelease(f.root, f.expected, jsonHash))
  writeFileSync(join(f.root, f.payload.installer.file), 'unit bytes')
  writeFileSync(join(f.root, 'build-receipt.json'), '{}')
  assert.throws(() => verifyUpgradeRelease(f.root, f.expected, jsonHash))
  writeFileSync(join(f.root, 'release.json'), JSON.stringify({ ...f.payload, manifestSha256: '0'.repeat(64) }))
  assert.throws(() => verifyUpgradeRelease(f.root, f.expected, jsonHash))
})

test('native driver requires hosted runner before mutation and never silently installs', () => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  assert.ok(source.indexOf("$env:RUNNER_ENVIRONMENT -ne 'github-hosted'") < source.indexOf('New-Item -ItemType Directory'))
  assert.ok(source.includes('$info.Environment.Clear()'))
  assert.ok(source.includes('$nodeCommands = @(Get-Command node -CommandType Application -ErrorAction Stop)'))
  assert.ok(source.includes('$node = $nodeCommands[0].Source'))
  assert.doesNotMatch(source, /\(Get-Command node[^\n]+\)\.Source/u)
  const install = source.split('function Start-Installer')[1].split('function Finish-Installer')[0]
  assert.ok(install.includes("$arguments = '/THEME=light'"))
  assert.doesNotMatch(install, /\/D=/u)
  assert.doesNotMatch(install, /\/S|--updated|RunAs|ExecutionPolicy/)
  const legacy = source.split('function Start-LegacyInstaller')[1].split('function Start-Installer')[0]
  assert.ok(legacy.includes("Start-Owned $path ('/currentuser /D=' + $installPath)"))
  assert.ok(legacy.includes('Wait-StockControl $process $window 1019'))
  assert.ok(legacy.includes('Wait-StockControl $Process $window 1203 600'))
  assert.ok(source.includes("$baselineAppFilename = 'cloga-deepseek-harness-desktop'"))
  assert.ok(source.includes('Finish-LegacyInstaller (Start-LegacyInstaller $validated.previous)'))
  assert.ok(source.includes("throw 'Installer unexpectedly launched the product'"))
  assert.ok(source.includes('draftAttachmentRefusalVerified = $false'))
  assert.ok(source.includes('pluginUserChoicesVerified = $false'))
  assert.ok(source.includes('managedHandoffVerified = $false'))
})

test('stock baseline captures are separate from strict custom-page readiness', () => {
  const driver = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const legacy = driver.split('function Start-LegacyInstaller')[1].split('function Start-Installer')[0]
  assert.match(legacy, /::SaveStock\(\$process\.Id, \$window, 1019, /u)
  assert.match(legacy, /::SaveStock\(\$Process\.Id, \$window, 1203, /u)
  assert.doesNotMatch(legacy, /::Save\(/u)
  for (const [name, process] of [['Start-LegacyInstaller', 'process'], ['Finish-LegacyInstaller', 'Process']]) {
    const section = driver.split(`function ${name}`)[1].split('\nfunction ')[0]
    const capture = section.indexOf('::SaveStock(')
    const ready = section.indexOf(`[void](Wait-StockControl $${process} $window 1)`)
    assert.ok(ready >= 0 && ready < capture, `${name} must await the capture's action-control prerequisite`)
    assert.ok(section.indexOf(`::Click((Wait-StockControl $${process} $window 1))`, capture) > capture)
  }
  const custom = driver.split('function Start-Installer')[1].split('function Wait-NoProductProcesses')[0]
  assert.equal(custom.match(/::Save\(/gu)?.length, 2)
  assert.doesNotMatch(custom, /::SaveStock\(/u)
  const helper = readFileSync(new URL('./windows-installer-ui.ps1', import.meta.url), 'utf8')
  assert.match(helper, /public static string Save\(IntPtr window, string path\) \{\s+Reveal\(window\);/u)
  const reveal = helper.split('public static void Reveal(IntPtr window) {')[1].split('public static string Save(')[0]
  assert.match(reveal, /while \(GetProp\(window, "HarnessInstaller.Ready"\) == IntPtr.Zero\)/u)
  assert.match(reveal, /ElapsedMilliseconds > 10000\) throw new TimeoutException/u)
  assert.doesNotMatch(helper, /\bSetProp\b/u)
})

test('cleanup admission precedes Finish and rechecks actual registration before uninstalling', () => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\$installed\b/)
  assert.ok(source.indexOf('$installationAttempted = $true') < source.indexOf('Finish-LegacyInstaller (Start-LegacyInstaller $validated.previous)'))
  const cleanup = source.split('    if ($installationAttempted) {')[1]
  assert.ok(cleanup)
  assert.ok(cleanup.includes('$hasRegistration = @(Product-Registrations).Count -ne 0'))
  assert.ok(cleanup.includes('Get-ChildItem -LiteralPath $installPath -Force'))
  assert.ok(cleanup.indexOf('[void](Read-Registration)') < cleanup.indexOf("Start-Owned $uninstaller '/S'"))
  assert.ok(cleanup.indexOf('Wait-NoProductProcesses') < cleanup.indexOf("Start-Owned $uninstaller '/S'"))
  assert.ok(cleanup.includes("throw 'Owned registration has no usable uninstaller; leave VM teardown to remove the partial installation'"))
  assert.ok(cleanup.includes("$cleanupErrors.Add('Installed product cleanup failed: '"))
})

test('reviewed baseline distinguishes raw manifest digest from internal self-hash', () => {
  const baseline = JSON.parse(readFileSync(new URL('./fixtures/windows-upgrade-baseline.json', import.meta.url), 'utf8'))
  assert.equal(baseline.tag, 'dsh-desktop-v0.1.6-alpha.1.cloga.2')
  assert.equal(Object.hasOwn(baseline, 'sourceCommit'), false)
  assert.equal(baseline.manifest.sha256, '724214036567ddea1d6fb79bbfd4daa6c87eada4c00022ef4b0fa9170d93ff59')
  assert.equal(baseline.installer.sha256, 'cf140d49b8df9096b52fba365066ef4eeee06eed57ca0f16c2fc319f1e5f0970')
  assert.equal(baseline.installer.bytes, 171301229)
})
