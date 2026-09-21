<# Actual production-identity NSIS upgrade; never run on a workstation or self-hosted runner. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$BaselineDirectory,
    [Parameter(Mandatory)][string]$CandidateDirectory,
    [Parameter(Mandatory)][string]$ExpectedSourceCommit,
    [Parameter(Mandatory)][string]$RunRoot
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Real installer qualification requires a disposable GitHub-hosted Windows runner'
}
if ($env:GITHUB_RUN_ID -notmatch '^\d+$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^\d+$' -or $ExpectedSourceCommit -notmatch '^[a-f0-9]{40}$' -or $ExpectedSourceCommit -ne $env:GITHUB_SHA) {
    throw 'Qualification requires the exact workflow commit and run identity'
}
$repo = (Resolve-Path (Join-Path $PSScriptRoot '../../..')).Path
$nodeCommands = @(Get-Command node -CommandType Application -ErrorAction Stop)
if ($nodeCommands.Count -lt 1) { throw 'No Node application is available for the owned fixture' }
$node = $nodeCommands[0].Source
if (-not [IO.File]::Exists($node)) { throw 'Selected Node application does not exist' }
$fixture = Join-Path $PSScriptRoot 'fixtures/windows-installed-upgrade-smoke.mjs'
$temp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
$root = [IO.Path]::GetFullPath($RunRoot).TrimEnd('\')
if (-not $root.StartsWith($temp + '\', [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $root)) { throw 'RunRoot must be a new strict child of RUNNER_TEMP' }
$cursor = Split-Path $root -Parent
while ($cursor) {
    if ((Test-Path -LiteralPath $cursor) -and ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'RunRoot ancestry contains a reparse point' }
    $parent = Split-Path $cursor -Parent
    if ($parent -eq $cursor) { break }
    $cursor = $parent
}
$product = 'DeepSeek Harness (cloga)'
$baselineAppFilename = 'cloga-deepseek-harness-desktop'
$installPath = Join-Path $root ('Installed App\' + $baselineAppFilename)
if ($installPath.Length -gt 180 -or $installPath -match '["\r\n\t]') { throw 'Unsupported NSIS custom path' }
$application = Join-Path $installPath 'cloga-deepseek-harness.exe'
$uninstaller = Join-Path $installPath 'Uninstall cloga-deepseek-harness.exe'
$baseline = [IO.Path]::GetFullPath($BaselineDirectory).TrimEnd('\')
$candidate = [IO.Path]::GetFullPath($CandidateDirectory).TrimEnd('\')
$token = [guid]::NewGuid().ToString()
$processes = [Collections.Generic.List[Diagnostics.Process]]::new()
$cleanupErrors = [Collections.Generic.List[string]]::new()
$secondaryErrors = [Collections.Generic.List[string]]::new()
$failure = $null
$success = $false
$packageAcceptanceSuccess = $false
$packageAcceptanceAttempted = $false
$registration = $null
$baselineProcessBinding = $null
$monitor = $null
$installationAttempted = $false
$uninstallerCopy = $null
$registrationIdentities = @()
$installerProcesses = [Collections.Generic.List[Diagnostics.Process]]::new()
. (Join-Path $PSScriptRoot 'fixtures/windows-installer-registration.ps1')
. (Join-Path $PSScriptRoot 'fixtures/windows-uninstall-observation.ps1')
function Product-Registrations { Get-InstallerRegistrationEntries }
function Product-Processes {
    @(Get-CimInstance Win32_Process | Where-Object {
        $_.Name -eq 'cloga-deepseek-harness.exe' -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($installPath + '\', [StringComparison]::OrdinalIgnoreCase))
    })
}
if (@(Product-Registrations).Count -ne 0 -or @(Product-Processes).Count -ne 0) { throw 'Runner already has the production product identity; refusing to modify it' }
New-Item -ItemType Directory -Path $root, (Join-Path $root 'evidence'), (Join-Path $root 'process-temp') | Out-Null
@{ runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT; token = $token } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'owner.json') -Encoding utf8NoBOM
. (Join-Path $PSScriptRoot 'windows-installer-ui.ps1')
[InstallerCapture]::Initialize()
[InstallerCapture]::ProductName = $product
$localizedCopy = @{ ENGLISH = @{}; SIMPCHINESE = @{} }
Get-Content (Join-Path $PSScriptRoot '../installer/strings.nsh') -Encoding UTF8 | ForEach-Object {
    if ($_ -match '^LangString (INSTALLER_\w+) \$\{LANG_(ENGLISH|SIMPCHINESE)\} "(.*)"$') { $localizedCopy[$Matches[2]][$Matches[1]] = $Matches[3] }
}
function Quote-Argument([string]$Value) {
    if ($Value.Contains('"') -or $Value.EndsWith('\') -or $Value.Contains("`n") -or $Value.Contains("`r")) { throw 'Unsupported process argument' }
    '"' + $Value + '"'
}
function Start-Owned([string]$File, [string]$Arguments, [switch]$Fixture) {
    $info = [Diagnostics.ProcessStartInfo]::new($File, $Arguments)
    $info.WorkingDirectory = $repo
    $info.UseShellExecute = $false
    $info.Environment.Clear()
    foreach ($name in @('PATH','PATHEXT','SYSTEMROOT','SYSTEMDRIVE','WINDIR','COMSPEC','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMW6432','PROGRAMDATA','ALLUSERSPROFILE','PUBLIC','USERNAME','USERDOMAIN','COMPUTERNAME','OS','USERPROFILE','HOMEDRIVE','HOMEPATH','APPDATA','LOCALAPPDATA')) {
        $value = [Environment]::GetEnvironmentVariable($name)
        if ($null -ne $value) { $info.Environment[$name] = $value }
    }
    foreach ($name in @('TEMP','TMP','TMPDIR')) { $info.Environment[$name] = Join-Path $root 'process-temp' }
    $info.Environment['DSH_TELEMETRY_DISABLED'] = '1'
    if ($Fixture) {
        foreach ($name in @('GITHUB_ACTIONS','RUNNER_OS','RUNNER_ENVIRONMENT','RUNNER_TEMP','GITHUB_RUN_ID','GITHUB_RUN_ATTEMPT','GITHUB_SHA')) { $info.Environment[$name] = [Environment]::GetEnvironmentVariable($name) }
    }
    $process = [Diagnostics.Process]::Start($info)
    $processes.Add($process)
    return $process
}
function Wait-Exit([Diagnostics.Process]$Process, [int]$Seconds, [int]$Expected = 0) {
    if (-not $Process.WaitForExit($Seconds * 1000)) { throw 'Owned qualification process exceeded its deadline' }
    if ($Process.ExitCode -ne $Expected) { throw "Owned qualification process returned $($Process.ExitCode), expected $Expected" }
}
# Process handles remain retained until the final pass, including handles added by uninstall/profile cleanup.
function Stop-OwnedProcesses {
    param($OwnedProcesses, $Errors)
    $stopped = $true
    foreach ($process in $OwnedProcesses) {
        try {
            if (-not $process.HasExited) {
                try { $process.Kill($true) }
                catch { $Errors.Add('Could not request owned process termination: ' + $_.Exception.Message); $stopped = $false }
            }
            if (-not $process.WaitForExit(10000)) { $Errors.Add('Owned qualification process did not exit after termination'); $stopped = $false }
        } catch { $Errors.Add('Could not verify owned process exit: ' + $_.Exception.Message); $stopped = $false }
    }
    return $stopped
}
function Start-Fixture([string]$Phase) {
    $args = @('--import','tsx/esm',$fixture,'--phase',$Phase,'--run-root',$root)
    if ($Phase -eq 'validate') { $args += @('--baseline-directory',$baseline,'--candidate-directory',$candidate,'--expected-source',$ExpectedSourceCommit) }
    Start-Owned $node (($args | ForEach-Object { Quote-Argument $_ }) -join ' ') -Fixture
}
function Wait-Control([Diagnostics.Process]$Process, [string]$Text, [int]$Seconds = 120, [switch]$Dialog) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($Process.HasExited) { throw "Installer exited before expected control ($($Process.ExitCode))" }
        $control = if ($Dialog) { [InstallerCapture]::FindDialogText($Process.Id, $Text) } else { [InstallerCapture]::FindText($Process.Id, $Text) }
        if ($control -ne [IntPtr]::Zero) { return $control }
        Start-Sleep -Milliseconds 50
    } while ($timer.Elapsed.TotalSeconds -lt $Seconds)
    throw "Installer control deadline: $Text"
}
function Wait-StockWindow([Diagnostics.Process]$Process, [int]$Seconds = 120) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($Process.HasExited) { throw "Stock installer exited before its directory page ($($Process.ExitCode))" }
        $window = [InstallerCapture]::FindStockWindow($Process.Id)
        if ($window -ne [IntPtr]::Zero) { return $window }
        Start-Sleep -Milliseconds 50
    } while ($timer.Elapsed.TotalSeconds -lt $Seconds)
    throw 'Owned stock installer window did not appear'
}
function Wait-StockControl([Diagnostics.Process]$Process, [IntPtr]$Window, [int]$Id, [int]$Seconds = 120) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($Process.HasExited) { throw "Stock installer exited before control $Id ($($Process.ExitCode))" }
        $control = [InstallerCapture]::FindControlById($Window, $Id)
        if ($control -ne [IntPtr]::Zero -and [InstallerCapture]::IsWindowEnabled($control)) { return $control }
        Start-Sleep -Milliseconds 50
    } while ($timer.Elapsed.TotalSeconds -lt $Seconds)
    throw "Owned stock installer control $Id did not appear"
}
function Start-LegacyInstaller($Release) {
    $path = [string]$Release.installer
    $stream = [IO.File]::Open($path, 'Open', 'Read', 'Read')
    try {
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Release.manifest.installer.sha256) { throw 'Baseline installer bytes changed after validation' }
        if ((Get-AuthenticodeSignature -LiteralPath $path).Status -ne 'NotSigned') { throw 'Unexpected baseline installer signature state' }
        $process = Start-Owned $path ('/currentuser /D=' + $installPath)
    } finally { $stream.Dispose() }
    $installerProcesses.Add($process)
    $window = Wait-StockWindow $process
    $directory = Wait-StockControl $process $window 1019
    if ([IO.Path]::GetFullPath([InstallerCapture]::Text($directory)).TrimEnd('\') -cne $installPath) { throw 'Baseline installer custom path changed before installation' }
    [void](Wait-StockControl $process $window 1)
    [void][InstallerCapture]::SaveStock($process.Id, $window, 1019, (Join-Path $root ('evidence/baseline-directory-' + $process.Id + '.png')))
    [InstallerCapture]::Click((Wait-StockControl $process $window 1))
    return $process
}
function Finish-LegacyInstaller([Diagnostics.Process]$Process) {
    $window = Wait-StockWindow $Process 600
    [void](Wait-StockControl $Process $window 1203 600)
    $checkbox = [InstallerCapture]::StockRun($Process.Id, $window)
    if ([InstallerCapture]::SendMessage($checkbox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 1) { throw 'Baseline launch checkbox default changed' }
    [InstallerCapture]::Click($checkbox)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ([InstallerCapture]::SendMessage($checkbox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 0) {
        if ($timer.Elapsed.TotalSeconds -gt 5) { throw 'Could not disable baseline automatic launch' }
        Start-Sleep -Milliseconds 25
    }
    [void](Wait-StockControl $Process $window 1)
    [void][InstallerCapture]::SaveStock($Process.Id, $window, 1203, (Join-Path $root ('evidence/baseline-finish-' + $Process.Id + '.png')))
    [InstallerCapture]::Click((Wait-StockControl $Process $window 1))
    Wait-Exit $Process 30
}
function Start-Installer($Release) {
    $path = [string]$Release.installer
    $stream = [IO.File]::Open($path, 'Open', 'Read', 'Read')
    try {
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -ne $Release.manifest.installer.sha256) { throw 'Installer bytes changed after validation' }
        if ((Get-AuthenticodeSignature -LiteralPath $path).Status -ne 'NotSigned') { throw 'Unexpected installer signature state' }
        $arguments = '/THEME=light'
        $process = Start-Owned $path $arguments
    } finally { $stream.Dispose() }
    $installerProcesses.Add($process)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        if ($process.HasExited) { throw "Installer exited before welcome ($($process.ExitCode))" }
        $languages = @($localizedCopy.Keys | Where-Object { [InstallerCapture]::FindButton($process.Id, $localizedCopy[$_].INSTALLER_INSTALL) -ne [IntPtr]::Zero })
        if ($languages.Count -eq 1) { break }
        Start-Sleep -Milliseconds 50
    } while ($timer.Elapsed.TotalSeconds -lt 120)
    if ($languages.Count -ne 1) { throw 'Cannot identify actual installer language' }
    $script:copy = $localizedCopy[$languages[0]]
    [InstallerCapture]::Click((Wait-Control $process $copy.INSTALLER_CHOOSE_PATH))
    [void](Wait-Control $process $installPath)
    $window = [InstallerCapture]::Find($process.Id)
    [void][InstallerCapture]::Save($window, (Join-Path $root ('evidence/setup-' + $process.Id + '.png')))
    [InstallerCapture]::Click((Wait-Control $process $copy.INSTALLER_INSTALL))
    return $process
}
function Finish-Installer([Diagnostics.Process]$Process) {
    [void](Wait-Control $Process $copy.INSTALLER_FINISH -Seconds 600)
    $checkbox = Wait-Control $Process $copy.INSTALLER_LAUNCH
    if ([InstallerCapture]::SendMessage($checkbox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 1) { throw 'Launch checkbox default changed' }
    [InstallerCapture]::Click($checkbox)
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while ([InstallerCapture]::SendMessage($checkbox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 0) {
        if ($timer.Elapsed.TotalSeconds -gt 5) { throw 'Could not disable installer automatic launch' }
        Start-Sleep -Milliseconds 25
    }
    $window = [InstallerCapture]::Find($Process.Id)
    if ([InstallerCapture]::GetProp($window, 'HarnessInstaller.CompletedPercent').ToInt32() -ne 100 -or [InstallerCapture]::GetProp($window, 'HarnessInstaller.Stage').ToInt32() -ne 4) { throw 'Installer did not report completed production stages' }
    [void][InstallerCapture]::Save($window, (Join-Path $root ('evidence/finish-' + $Process.Id + '.png')))
    [InstallerCapture]::Click((Wait-Control $Process $copy.INSTALLER_FINISH))
    Wait-Exit $Process 30
    for ($sample = 0; $sample -lt 20; $sample++) {
        if (@(Product-Processes).Count -ne 0) { throw 'Installer unexpectedly launched the product' }
        Start-Sleep -Milliseconds 100
    }
}
function Wait-NoProductProcesses {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (@(Product-Processes).Count -ne 0) {
        if ($timer.Elapsed.TotalSeconds -gt 30) { throw 'Owned application or Host processes did not close' }
        Start-Sleep -Milliseconds 100
    }
}
function Assert-BaselineProcessBinding($Process, [string]$ExpectedSha256) {
    $script:baselineProcessBinding = [ordered]@{
        pathAvailable = $false; providerNormalized = $false
        directParentMatches = $null; basenameMatches = $null; hashMatches = $null
    }
    if ($ExpectedSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Baseline process requires a verified SHA-256 identity' }
    $exited = $Process.HasExited
    if ($exited -isnot [bool] -or $exited) { throw 'Baseline process is exited or its liveness is unavailable' }
    $observedPath = $Process.Path
    $baselineProcessBinding.pathAvailable = $observedPath -is [string] -and -not [string]::IsNullOrWhiteSpace($observedPath)
    if (-not $baselineProcessBinding.pathAvailable) { throw 'Baseline process executable path is unavailable' }
    try { $file = Get-Item -LiteralPath $observedPath -Force }
    catch { throw 'Baseline process executable metadata is unavailable' }
    $path = [IO.Path]::GetFullPath($file.FullName)
    $baselineProcessBinding.providerNormalized = $true
    $baselineProcessBinding.directParentMatches = [IO.Path]::GetDirectoryName($path) -ieq [IO.Path]::GetFullPath($installPath)
    $baselineProcessBinding.basenameMatches = $file.Name -ieq 'cloga-deepseek-harness.exe'
    if ($file -isnot [IO.FileInfo] -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Baseline process executable is not a regular physical file' }
    try { Assert-InstallerOwnedPath $installPath $path }
    catch { throw 'Baseline process executable is outside the exact installation or traverses an alias' }
    if (-not $baselineProcessBinding.directParentMatches -or -not $baselineProcessBinding.basenameMatches) {
        throw 'Baseline process is not the exact installation executable'
    }
    try { $digest = (Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() }
    catch { throw 'Baseline process executable could not be verified' }
    $baselineProcessBinding.hashMatches = $digest -ceq $ExpectedSha256
    if (-not $baselineProcessBinding.hashMatches) { throw 'Baseline process executable differs from the verified release' }
    $exited = $Process.HasExited
    if ($exited -isnot [bool] -or $exited) { throw 'Baseline process exited or became unobservable during executable verification' }
}
function Read-Registration([object[]]$Identities = $registrationIdentities) {
    $entry = Resolve-InstallerRegistration @(Product-Registrations) $Identities $installPath
    foreach ($path in @($installPath, $application, $uninstaller)) {
        Assert-InstallerOwnedPath $root $path
    }
    if ((Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry.ExecutableSha256) {
        throw 'Registered executable differs from its verified release'
    }
    return $entry
}
function Close-UninstallStream($Stream, $Errors) {
    if ($null -eq $Stream) { return }
    try { $Stream.Dispose() }
    catch { $Errors.Add('Owned uninstall stream disposal failed') }
}
function Get-UninstallStreamSha256([IO.Stream]$Stream) {
    $Stream.Position = 0
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($algorithm.ComputeHash($Stream)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
}
function Assert-UninstallOwner {
    $marker = Join-Path $root 'owner.json'
    Assert-InstallerOwnedPath $root $marker
    $item = Get-Item -LiteralPath $marker -Force
    if ($item.PSIsContainer -or $item.Length -gt 4096) { throw 'Invalid uninstall owner marker' }
    $owner = Get-Content -LiteralPath $marker -Raw | ConvertFrom-Json
    if ($owner.token -cne $token -or $owner.runId -cne $env:GITHUB_RUN_ID -or $owner.runAttempt -cne $env:GITHUB_RUN_ATTEMPT) {
        throw 'Uninstall ownership changed'
    }
}
# app-builder-lib 26.15.3 installUtil.nsh copies outside INSTDIR and uses final _?= to wait without self-relocation.
function New-OwnedUninstallerCopy([string]$CopyDirectory, $ExpectedRegistration, $Errors) {
    $source = $null; $writer = $null; $guard = $null; $retained = $false
    try {
        Assert-UninstallOwner
        $temporaryRoot = Join-Path $root 'process-temp'
        if ([IO.Path]::GetFullPath($installPath) -cne $installPath -or $installPath.Length -gt 180 -or $installPath -match '["\r\n\t]' -or
            [IO.Path]::GetFullPath($CopyDirectory) -cne $CopyDirectory -or [IO.Path]::GetDirectoryName($CopyDirectory) -cne $temporaryRoot -or
            $CopyDirectory.StartsWith($installPath + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid owned uninstall copy location or target' }
        Assert-InstallerOwnedPath $root $temporaryRoot
        Assert-InstallerOwnedPath $root $uninstaller
        if ((Get-Item -LiteralPath $uninstaller -Force).PSIsContainer) { throw 'Uninstall source is not a regular file' }
        $source = [IO.File]::Open($uninstaller, 'Open', 'Read', 'Read')
        Assert-InstallerOwnedPath $root $uninstaller
        $before = Get-UninstallStreamSha256 $source
        New-Item -ItemType Directory -Path $CopyDirectory -ErrorAction Stop | Out-Null
        Assert-InstallerOwnedPath $root $CopyDirectory
        $copyPath = Join-Path $CopyDirectory 'owned-uninstaller.exe'
        $writer = [IO.File]::Open($copyPath, 'CreateNew', 'Write', 'None')
        $source.Position = 0
        $source.CopyTo($writer)
        $writer.Flush($true)
        $writer.Dispose(); $writer = $null
        Assert-InstallerOwnedPath $root $copyPath
        $guard = [IO.File]::Open($copyPath, 'Open', 'Read', 'Read')
        Assert-InstallerOwnedPath $root $copyPath
        $after = Get-UninstallStreamSha256 $source
        $copied = Get-UninstallStreamSha256 $guard
        if ($before -cne $after -or $before -cne $copied) { throw 'Owned uninstall copy hash mismatch' }
        $current = Read-Registration
        foreach ($field in @('Id', 'Key', 'OwnerKey', 'Version', 'Source', 'ExecutableSha256', 'InstallLocation')) {
            if ($current.$field -cne $ExpectedRegistration.$field) { throw 'Uninstall registration changed during copy' }
        }
        Wait-NoProductProcesses
        Assert-UninstallOwner
        Assert-InstallerOwnedPath $root $installPath
        Assert-InstallerOwnedPath $root $copyPath
        # The installed source must be removable by stock uninstall; only the external copy stays read-locked.
        $source.Dispose(); $source = $null
        $retained = $true
        return [pscustomobject]@{ Path = $copyPath; Guard = $guard; Sha256 = $copied
            SourceBeforeSha256 = $before; SourceAfterSha256 = $after
            InsideOwnedTemporaryRoot = $true; OutsideInstallation = $true; Target = $installPath }
    } finally {
        Close-UninstallStream $writer $Errors
        Close-UninstallStream $source $Errors
        if (-not $retained) { Close-UninstallStream $guard $Errors }
    }
}
function Write-InstallerFailureDiagnostics($OwnedInstallers, $Errors) {
    foreach ($process in $OwnedInstallers) {
        try {
            if (-not $process.HasExited) {
                [InstallerCapture]::DiagnosticText($process.Id) | Set-Content -LiteralPath (Join-Path $root ('evidence/installer-failure-ui-' + $process.Id + '.txt')) -Encoding utf8NoBOM
            }
        } catch { $Errors.Add('Owned installer UI observation failed: ' + $_.Exception.Message) }
    }
    try {
        ConvertTo-Json -InputObject @(Product-Registrations) -Depth 4 | Set-Content -LiteralPath (Join-Path $root 'evidence/installer-failure-registration.json') -Encoding utf8NoBOM
    } catch { $Errors.Add('Installer registration observation failed: ' + $_.Exception.Message) }
}
# Observe the retained copied execution handle, owned paths and fixed product keys; never adopt an observed PID.
function Write-UninstallFailureDiagnostics($UninstallerProcess, $Errors, $Copy = $null) {
    $observation = [ordered]@{
        schemaVersion = 1; sourceCommit = $ExpectedSourceCommit; arguments = '/currentuser /S _?=<owned-install-root>'
        executionMode = 'owned-copy-no-relocation'; copyVerified = ($null -ne $Copy)
        copySha256 = $(if ($null -ne $Copy) { $Copy.Sha256 } else { $null })
        copyHashesAgree = [bool]($null -ne $Copy -and $Copy.Sha256 -ceq $Copy.SourceBeforeSha256 -and $Copy.Sha256 -ceq $Copy.SourceAfterSha256)
        copyInsideOwnedTemporaryRoot = [bool]($null -ne $Copy -and $Copy.InsideOwnedTemporaryRoot)
        copyOutsideInstallation = [bool]($null -ne $Copy -and $Copy.OutsideInstallation)
        targetMatches = [bool]($null -ne $Copy -and $Copy.Target -ceq $installPath)
        launcherStarted = ($null -ne $UninstallerProcess); launcherPid = $null; launcherExited = $null; launcherExitCode = $null
        executablePresent = $null; uninstallerPresent = $null
        registrationCount = $null; registrations = @(); registrationsTruncated = $false
        productProcessCount = $null; ownedTemporaryProcessCount = $null; processes = @(); processesTruncated = $false
        ownedWorker = $null; observationErrors = @()
    }
    $observationErrors = [Collections.Generic.List[string]]::new()
    try {
        if ($null -ne $UninstallerProcess) {
            $observation.launcherPid = $UninstallerProcess.Id
            $observation.launcherExited = $UninstallerProcess.HasExited
            # PowerShell can return null for a failed property getter without entering catch.
            if ($observation.launcherExited -isnot [bool]) { throw 'Launcher exit state unavailable' }
            if ($observation.launcherExited) {
                $observation.launcherExitCode = $UninstallerProcess.ExitCode
                if ($observation.launcherExitCode -isnot [int]) { throw 'Launcher exit code unavailable' }
            }
        }
    } catch { $observationErrors.Add('launcher-state-unavailable') }
    try {
        $observation.executablePresent = Test-Path -LiteralPath $application -PathType Leaf
        $observation.uninstallerPresent = Test-Path -LiteralPath $uninstaller -PathType Leaf
    } catch { $observationErrors.Add('installed-file-state-unavailable') }
    try {
        $entries = @(Product-Registrations)
        $observation.registrationCount = $entries.Count
        $observation.registrationsTruncated = $entries.Count -gt 4
        $observation.registrations = @($entries | Select-Object -First 4 | ForEach-Object {
            [ordered]@{
                hive = $_.Hive; view = $_.View
                ownerPresent = $_.OwnerPresent; uninstallPresent = $_.UninstallPresent
                installLocationMatches = ($_.InstallLocation -ceq $installPath)
            }
        })
    } catch { $observationErrors.Add('registration-state-unavailable') }
    try {
        $temporaryRoot = (Join-Path $root 'process-temp') + '\'
        $processSnapshot = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5)
        $observed = @($processSnapshot | Where-Object {
            $_.Name -eq 'cloga-deepseek-harness.exe' -or ($_.ExecutablePath -and (
                $_.ExecutablePath.StartsWith($installPath + '\', [StringComparison]::OrdinalIgnoreCase) -or
                $_.ExecutablePath.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)))
        })
        $temporary = @($observed | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase) })
        $observation.ownedTemporaryProcessCount = $temporary.Count
        $observation.productProcessCount = @($observed | Where-Object {
            $_.Name -eq 'cloga-deepseek-harness.exe' -or ($_.ExecutablePath -and $_.ExecutablePath.StartsWith($installPath + '\', [StringComparison]::OrdinalIgnoreCase))
        }).Count
        $observation.processesTruncated = $observed.Count -gt 16
        $observation.processes = @($observed | Select-Object -First 16 | ForEach-Object {
            [ordered]@{
                pid = $_.ProcessId; parentPid = $_.ParentProcessId
                inInstallation = [bool]($_.ExecutablePath -and $_.ExecutablePath.StartsWith($installPath + '\', [StringComparison]::OrdinalIgnoreCase))
                inOwnedTemporaryRoot = [bool]($_.ExecutablePath -and $_.ExecutablePath.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase))
            }
        })
    } catch { $observationErrors.Add('process-state-unavailable') }
    try {
        $observation.ownedWorker = Get-OwnedUninstallerObservation $UninstallerProcess $Copy $root $installPath
    } catch { $observationErrors.Add('worker-observation-unavailable') }
    $observation.observationErrors = @($observationErrors)
    foreach ($issue in $observationErrors) { $Errors.Add('Post-uninstall observation failed: ' + $issue) }
    try {
        $observation | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $root 'evidence/installer-uninstall-failure.json') -Encoding utf8NoBOM
    } catch { $Errors.Add('Post-uninstall diagnostic write failed') }
}
function Write-BaselineProcessIdentityDiagnostic($Ready, $Live, $Errors) {
    $record = [ordered]@{ schemaVersion = 1; sourceCommit = $ExpectedSourceCommit
        pathAvailable = $null; literalPathMatch = $null; pidMatchesRequested = $null; launcherMatchesMain = $null
        exited = $null; category = 'process-unavailable'; observationErrors = @() }
    $issues = [Collections.Generic.List[string]]::new()
    if ($Ready.launcherPid -is [int] -or $Ready.launcherPid -is [long]) { $record.launcherMatchesMain = $Ready.launcherPid -eq $Ready.pid }
    if ($null -ne $Live) {
        $record.category = 'observed-after-failure'
        try {
            $observedPid = $Live.Id
            if ($observedPid -isnot [int] -and $observedPid -isnot [long]) { throw 'PID unavailable' }
            $record.pidMatchesRequested = $observedPid -eq $Ready.pid
        } catch { $issues.Add('pid-unreadable') }
        try {
            $path = $Live.Path
            $record.pathAvailable = $path -is [string] -and -not [string]::IsNullOrWhiteSpace($path)
            if ($record.pathAvailable) {
                $record.literalPathMatch = $path -eq $application
                if (-not $record.literalPathMatch) { $record.category = 'literal-path-difference' }
            } else { $record.category = 'path-unavailable' }
        } catch { $issues.Add('path-unreadable'); $record.category = 'path-unavailable' }
        try {
            $record.exited = $Live.HasExited
            if ($record.exited -isnot [bool]) { $record.exited = $null; throw 'Exit state unavailable' }
        } catch { $issues.Add('exit-unreadable') }
    }
    $record.observationErrors = @($issues)
    try { $record | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $root 'evidence/baseline-process-identity.json') -Encoding utf8NoBOM }
    catch { $Errors.Add('Baseline process identity diagnostic write failed') }
}
function Installation-Inventory {
    $items = @(Get-ChildItem -LiteralPath $installPath -Recurse -Force)
    if (@($items | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint }).Count -ne 0) { throw 'Installed payload contains an unexpected filesystem alias' }
    @($items | Where-Object { -not $_.PSIsContainer } | Sort-Object FullName | ForEach-Object {
        [ordered]@{ path = [IO.Path]::GetRelativePath($installPath, $_.FullName); sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant() }
    }) | ConvertTo-Json -Depth 4 -Compress
}
function Assert-NoTransactionDirectories {
    # installer-directories.nsh stages "$INSTDIR.new-$0" and "$INSTDIR.old-$0" beside the exact target.
    $parent = Split-Path $installPath -Parent
    $leaf = Split-Path $installPath -Leaf
    if (-not (Test-Path -LiteralPath $parent)) { return }
    $directory = Get-Item -LiteralPath $parent -Force
    if (-not $directory.PSIsContainer -or ($directory.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Installation parent is not an owned directory' }
    if (@(Get-ChildItem -LiteralPath $parent -Directory -Force | Where-Object {
        $_.Name.StartsWith($leaf + '.new-', [StringComparison]::OrdinalIgnoreCase) -or $_.Name.StartsWith($leaf + '.old-', [StringComparison]::OrdinalIgnoreCase)
    }).Count -ne 0) { throw 'Installer left a transaction directory requiring investigation' }
}
try {
    Wait-Exit (Start-Fixture validate) 120
    $validated = Get-Content -LiteralPath (Join-Path $root 'validated.json') -Raw | ConvertFrom-Json
    if ($validated.ownerToken -ne $token) { throw 'Validation does not belong to this run' }
    $baselinePin = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'fixtures/windows-upgrade-baseline.json') -Raw | ConvertFrom-Json
    $baselineSource = Get-PinnedInstallerBaselineSource (Join-Path $baseline 'release.json') $baselinePin.manifest.sha256 $baselinePin.tag
    $baselineIdentity = New-InstallerRegistrationIdentity $validated.previous $baselineSource
    $candidateIdentity = New-InstallerRegistrationIdentity $validated.candidate $ExpectedSourceCommit
    $registrationIdentities = @($baselineIdentity, $candidateIdentity)
    $installationAttempted = $true
    Finish-LegacyInstaller (Start-LegacyInstaller $validated.previous)
    $registration = Read-Registration @($baselineIdentity)
    if ((Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash.ToLowerInvariant() -ne $validated.previous.manifest.installedEvidence.executableSha256) { throw 'Installed baseline executable differs from verified release' }
    $before = Installation-Inventory
    $before | Set-Content -LiteralPath (Join-Path $root 'evidence/baseline-inventory.json') -Encoding utf8NoBOM
    $monitor = Start-Fixture baseline
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (-not (Test-Path -LiteralPath (Join-Path $root 'baseline-ready.json'))) {
        if ($monitor.HasExited -or $timer.Elapsed.TotalSeconds -gt 600) { throw 'Baseline Host/client acceptance did not become ready' }
        Start-Sleep -Milliseconds 100
    }
    $ready = Get-Content -LiteralPath (Join-Path $root 'baseline-ready.json') -Raw | ConvertFrom-Json
    if ($ready.ownerToken -ne $token -or $ready.application -ne $application) { throw 'Unexpected baseline readiness owner' }
    $live = $null
    try {
        $live = Get-Process -Id $ready.pid -ErrorAction Stop
        Assert-BaselineProcessBinding $live $baselineIdentity.ExecutableSha256
    } catch {
        $identityFailure = $_
        try { Write-BaselineProcessIdentityDiagnostic $ready $live $secondaryErrors }
        catch { $secondaryErrors.Add('Baseline process identity diagnostic unavailable') }
        throw $identityFailure
    }
    $refused = Start-Installer $validated.candidate
    $prompt = Wait-Control $refused $copy.INSTALLER_RUNNING -Seconds 600 -Dialog
    $okay = [InstallerCapture]::GetDlgItem([InstallerCapture]::TopLevel($prompt), 1)
    if ($okay -eq [IntPtr]::Zero) { throw 'Running-application prompt has no native OK action' }
    [InstallerCapture]::Click($okay)
    Wait-Exit $refused 30 2
    if ($live.HasExited -or (Installation-Inventory) -ne $before -or (Read-Registration @($baselineIdentity)).Key -ne $registration.Key) { throw 'Running-application refusal changed the installation or stopped the baseline' }
    Assert-NoTransactionDirectories
    @{ ownerToken = $token } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'baseline-finish-request.json') -Encoding utf8NoBOM
    Wait-Exit $monitor 120
    $monitor = $null
    Wait-NoProductProcesses
    Finish-Installer (Start-Installer $validated.candidate)
    if ((Read-Registration @($candidateIdentity)).Key -ne $registration.Key) { throw 'Upgrade changed the production registration identity' }
    Assert-NoTransactionDirectories
    Wait-Exit (Start-Fixture candidate) 900
    Wait-NoProductProcesses
    # This fresh-home, same-version package case does not qualify choices across the installer upgrade.
    $packageAcceptanceAttempted = $true
    Wait-Exit (Start-Fixture package) 1800
    Wait-NoProductProcesses
    $packageAcceptance = Get-Content -LiteralPath (Join-Path $root 'evidence/package-acceptance.json') -Raw | ConvertFrom-Json
    if ($packageAcceptance.sourceCommit -cne $ExpectedSourceCommit -or $packageAcceptance.scope -cne 'candidate-installed-desktop-same-version-isolated-home') { throw 'Package acceptance identifies another source or scope' }
    foreach ($field in @('succeeded','preparedGraphVerified','declinePreservedGraphVerified','discardPreservedGraphVerified','liveDraftAttachmentVetoVerified','attachmentOnlyVetoVerified','draftOnlyVetoVerified','consentGraphPromotionVerified','newHostGenerationVerified','installedDisabledAfterConsentVerified','enabledFixtureRunningAfterSeparateRestartVerified','copilotDisabledChoiceAcrossRestartVerified','copilotRemovalChoiceAcrossRestartVerified','zeroModelRequestsVerified','cleanupVerified')) {
        if ($packageAcceptance.$field -isnot [bool] -or $packageAcceptance.$field -ne $true) { throw "Package acceptance did not verify $field" }
    }
    $packageAcceptanceSuccess = $true
    $success = $true
} catch {
    $failure = $_
    Write-InstallerFailureDiagnostics $installerProcesses $secondaryErrors
} finally {
    $initialReaped = Stop-OwnedProcesses $processes $cleanupErrors
    if ($installationAttempted) {
        $uninstallAttempted = $false
        $ownedUninstaller = $null
        try {
            if (-not $initialReaped) { throw 'Owned process exit is unconfirmed; retain installation and profiles for VM teardown' }
            if ($packageAcceptanceAttempted) {
                $packageEvidence = Join-Path $root 'evidence/package-acceptance.json'
                if (-not (Test-Path -LiteralPath $packageEvidence -PathType Leaf)) { throw 'Package fixture has no exit evidence; retain installation and profiles for VM teardown' }
                $packageCleanup = Get-Content -LiteralPath $packageEvidence -Raw | ConvertFrom-Json
                if ($packageCleanup.cleanupVerified -isnot [bool] -or $packageCleanup.cleanupVerified -ne $true) { throw 'Package process cleanup is unconfirmed; retain installation and profiles for VM teardown' }
            }
            $hasRegistration = @(Product-Registrations).Count -ne 0
            $hasPayload = (Test-Path -LiteralPath $installPath -PathType Container) -and @(Get-ChildItem -LiteralPath $installPath -Force).Count -ne 0
            if ($hasRegistration -or $hasPayload) {
                # Finish-page assertions may fail after a complete install. Re-establish ownership from actual state.
                $uninstallRegistration = Read-Registration
                if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) { throw 'Owned registration has no usable uninstaller; leave VM teardown to remove the partial installation' }
                Wait-NoProductProcesses
                $uninstallAttempted = $true
                $copyDirectory = Join-Path (Join-Path $root 'process-temp') ('uninstall-' + [guid]::NewGuid().ToString())
                $uninstallerCopy = New-OwnedUninstallerCopy $copyDirectory $uninstallRegistration $cleanupErrors
                # NSIS requires _?= last and unquoted, including paths with spaces. Never execute registry-supplied arguments.
                $ownedUninstaller = Start-Owned $uninstallerCopy.Path ('/currentuser /S _?=' + $uninstallerCopy.Target)
                Wait-Exit $ownedUninstaller 120
                $timer = [Diagnostics.Stopwatch]::StartNew()
                while ((Test-Path -LiteralPath $application) -or @(Product-Registrations).Count -ne 0 -or @(Product-Processes).Count -ne 0) {
                    if ($timer.Elapsed.TotalSeconds -gt 30) { throw 'Owned uninstaller did not remove executable, registration and product processes' }
                    Start-Sleep -Milliseconds 100
                }
            }
            Assert-NoTransactionDirectories
            $retainedFile = Join-Path $root 'home/.env'
            if (Test-Path -LiteralPath (Join-Path $root 'retained.json')) {
                $retained = Get-Content -LiteralPath (Join-Path $root 'retained.json') -Raw | ConvertFrom-Json
                if ((Get-FileHash -LiteralPath $retainedFile -Algorithm SHA256).Hash.ToLowerInvariant() -ne $retained.envSha256) { throw 'Uninstall modified isolated application data' }
            }
            Wait-Exit (Start-Fixture cleanup) 120
        } catch {
            $cleanupFailure = $_
            $cleanupErrors.Add('Installed product cleanup failed: ' + $cleanupFailure.Exception.Message)
            if ($null -eq $failure) { $failure = $cleanupFailure }
            if ($uninstallAttempted) {
                try { Write-UninstallFailureDiagnostics $ownedUninstaller $secondaryErrors $uninstallerCopy }
                catch { $secondaryErrors.Add('Post-uninstall diagnostic collection failed') }
            }
        }
    }
    # Cleanup itself can start processes after the first pass; kill AND acknowledge every late handle before disposal.
    [void](Stop-OwnedProcesses $processes $cleanupErrors)
    # Keep uncertain execution bytes for VM teardown; releasing a guard never establishes process exit.
    if ($null -ne $uninstallerCopy) { Close-UninstallStream $uninstallerCopy.Guard $cleanupErrors }
    foreach ($process in $processes) {
        try { $process.Dispose() }
        catch { $cleanupErrors.Add('Owned process handle disposal failed: ' + $_.Exception.Message); if ($null -eq $failure) { $failure = $_ } }
    }
    try {
        [ordered]@{
            schemaVersion = 1; sourceCommit = $ExpectedSourceCommit; succeeded = ($success -and $cleanupErrors.Count -eq 0)
            installerUpgradeVerified = $success; runningApplicationRefusalVerified = $success; sameCustomPathVerified = $success
            actualInstalledHostAndClientVerified = $success; candidateRestartVerified = $success
            retainedHomeFileVerified = $success; pluginUserChoicesVerified = $false; draftAttachmentRefusalVerified = $false
            promotionFailureRollbackVerified = $false; managedHandoffVerified = $false; postSuccessDowngradeVerified = $false
            separateSameVersionPackagedPluginAcceptanceVerified = $packageAcceptanceSuccess
            installationRoot = $installPath; baselineProcessBinding = $baselineProcessBinding
            cleanupErrors = @($cleanupErrors); secondaryErrors = @($secondaryErrors)
            failure = $(if ($null -ne $failure) { $failure.Exception.Message } else { $null })
        } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $root 'evidence/installer-upgrade.json') -Encoding utf8NoBOM
    } catch {
        $secondaryErrors.Add('Installer acceptance evidence write failed: ' + $_.Exception.Message)
        if ($null -eq $failure) { $failure = $_ }
        try { [Console]::Error.WriteLine(('Secondary qualification failures: ' + ($secondaryErrors -join '; '))) }
        catch { $secondaryErrors.Add('Secondary diagnostic output failed: ' + $_.Exception.Message) }
    }
}
if ($null -ne $failure) { throw $failure }
if ($cleanupErrors.Count -ne 0) { throw 'Installer qualification cleanup failed; inspect evidence' }
Write-Output "Actual installer upgrade passed; evidence: $(Join-Path $root 'evidence')"
