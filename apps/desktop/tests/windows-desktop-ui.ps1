<# Disposable-runner native UI driver. No business IPC, dialog replacement, global keys or name-based termination. #>
[CmdletBinding()]
param(
    [Parameter(Mandatory)][ValidateSet('Bind','Observe','ReviewPackages','ChooseWorkspace','Exit','VerifyExited','StopOwned')][string]$Action,
    [Parameter(Mandatory)][string]$RunRoot,
    [Parameter(Mandatory)][string]$OwnerToken,
    [Parameter(Mandatory)][ValidatePattern('^[a-f0-9-]{36}$')][string]$RequestId,
    [Parameter(Mandatory)][int]$ShellPid,
    [Parameter(Mandatory)][int]$FixturePid
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT' -or $env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_OS -ne 'Windows' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'Native Desktop acceptance requires a disposable GitHub-hosted Windows runner'
}
if ($env:GITHUB_RUN_ID -notmatch '^\d+$' -or $env:GITHUB_RUN_ATTEMPT -notmatch '^\d+$' -or $env:GITHUB_SHA -notmatch '^[a-f0-9]{40}$') { throw 'Missing workflow identity' }
$root = [IO.Path]::GetFullPath($RunRoot).TrimEnd('\')
$temp = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')
if (-not $root.StartsWith($temp + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Run root escapes RUNNER_TEMP' }
for ($cursor = $root; $cursor; $cursor = Split-Path $cursor -Parent) {
    if (-not (Test-Path -LiteralPath $cursor) -or ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe run-root ancestry' }
    if ((Split-Path $cursor -Parent) -eq $cursor) { break }
}
$owner = Get-Content -LiteralPath (Join-Path $root 'owner.json') -Raw | ConvertFrom-Json
$validated = Get-Content -LiteralPath (Join-Path $root 'validated.json') -Raw | ConvertFrom-Json
if ($owner.token -cne $OwnerToken -or $validated.ownerToken -cne $OwnerToken -or $owner.runId -cne $env:GITHUB_RUN_ID -or $owner.runAttempt -cne $env:GITHUB_RUN_ATTEMPT -or $validated.candidate.manifest.source.commit -cne $env:GITHUB_SHA) { throw 'Foreign runner owner' }
$application = Join-Path $root 'Installed App\cloga-deepseek-harness-desktop\cloga-deepseek-harness.exe'
. (Join-Path $PSScriptRoot 'fixtures/windows-installer-registration.ps1')
Assert-InstallerOwnedPath $root $application
$profile = Join-Path $root 'package-home\profiles\desktop'
$workspace = Join-Path $root 'package-workspace'
$evidence = Join-Path $root 'evidence'
foreach ($path in @($evidence, (Split-Path $application -Parent))) {
    if (-not (Test-Path -LiteralPath $path -PathType Container) -or ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe native fixture path' }
}
$resultPath = Join-Path $evidence "package-native-$RequestId.json"
if (Test-Path -LiteralPath $resultPath) { throw 'Native request identity was reused' }
$bindingPath = Join-Path $root "package-shell-$ShellPid.json"
$familyPath = Join-Path $root "package-family-$ShellPid.json"
function Identity($Process, [switch]$AllowExited) {
    $handle = Get-Process -Id $Process.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $handle) {
        if ($AllowExited) { return $null }
        throw 'Required process exited before identity observation'
    }
    try {
        [void]$handle.Handle
        $fresh = Read-Process ([int]$Process.ProcessId)
        if ($handle.HasExited -or $null -eq $fresh -or $fresh.CreationDate -ne $Process.CreationDate -or $fresh.ParentProcessId -ne $Process.ParentProcessId -or $fresh.ExecutablePath -ine $Process.ExecutablePath -or $handle.Path -ine $Process.ExecutablePath) {
            if ($AllowExited) { return $null }
            throw 'Process changed during identity observation'
        }
        [ordered]@{ pid = [int]$Process.ProcessId; parentPid = [int]$Process.ParentProcessId; created = $handle.StartTime.ToUniversalTime().ToString('o'); executable = [string]$Process.ExecutablePath }
    } catch {
        $fresh = Read-Process ([int]$Process.ProcessId)
        if ($AllowExited -and ($null -eq $fresh -or $fresh.CreationDate -ne $Process.CreationDate -or $fresh.ParentProcessId -ne $Process.ParentProcessId)) { return $null }
        throw
    } finally { $handle.Dispose() }
}
function Same-Identity($Actual, $Expected) {
    if ($null -eq $Actual -or [int]$Actual.ProcessId -ne [int]$Expected.pid -or [int]$Actual.ParentProcessId -ne [int]$Expected.parentPid -or [string]$Actual.ExecutablePath -ine $Expected.executable) { return $false }
    $handle = Get-Process -Id $Actual.ProcessId -ErrorAction SilentlyContinue
    if ($null -eq $handle) { return $false }
    try { [void]$handle.Handle; return $handle.StartTime.ToUniversalTime().ToString('o') -ceq $Expected.created -and $handle.Path -ieq $Expected.executable }
    finally { $handle.Dispose() }
}
function Read-Process([int]$ProcessId) { Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" }
$fixture = Read-Process $FixturePid
$helper = Read-Process $PID
if ($null -eq $fixture -or $null -eq $helper -or $helper.ParentProcessId -ne $FixturePid -or $ShellPid -le 0 -or $ShellPid -eq $FixturePid) { throw 'Missing fixture parent' }
$shell = Read-Process $ShellPid
if ($Action -eq 'Bind') {
    if ($null -eq $shell -or $shell.ParentProcessId -ne $FixturePid -or $shell.ExecutablePath -ine $application -or $shell.CreationDate -lt $fixture.CreationDate -or $shell.SessionId -ne $fixture.SessionId) { throw 'Shell is not the fixture-owned installed executable' }
    if ((Get-FileHash -LiteralPath $application -Algorithm SHA256).Hash.ToLowerInvariant() -cne $validated.candidate.manifest.installedEvidence.executableSha256) { throw 'Installed executable changed' }
    if (Test-Path -LiteralPath $bindingPath) { throw 'Shell PID binding already exists; retain its previous incarnation evidence' }
    $binding = [ordered]@{ ownerToken = $OwnerToken; fixture = (Identity $fixture); shell = (Identity $shell) }
    $binding | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $bindingPath -Encoding UTF8
    @{ ownerToken = $OwnerToken; completeObservation = $false; processes = @($binding.shell) } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $familyPath -Encoding UTF8
} else {
    $binding = Get-Content -LiteralPath $bindingPath -Raw | ConvertFrom-Json
    if ($binding.ownerToken -cne $OwnerToken -or -not (Same-Identity $fixture $binding.fixture)) { throw 'Native request has another fixture owner' }
    if ($Action -notin @('StopOwned','VerifyExited') -and -not (Same-Identity $shell $binding.shell)) { throw 'Shell process incarnation changed or exited' }
}

# A family observation records creation times. Cleanup reopens handles and verifies those times before termination.
function Observe-Family {
    $all = @(Get-CimInstance Win32_Process)
    $rootProcess = $all | Where-Object { $_.ProcessId -eq $ShellPid }
    if (-not (Same-Identity $rootProcess $binding.shell)) { throw 'Cannot observe a replaced shell' }
    $family = @($rootProcess)
    for ($round = 0; $round -lt 16; $round++) {
        $next = @($all | Where-Object {
            $child = $_
            -not ($family.ProcessId -contains $child.ProcessId) -and @($family | Where-Object { $_.ProcessId -eq $child.ParentProcessId -and $_.CreationDate -le $child.CreationDate }).Count -eq 1
        })
        if ($next.Count -eq 0) { break }
        $family += $next
        if ($family.Count -gt 256 -or $round -eq 15) { throw 'Process family exceeds its bound' }
    }
    $known = @()
    if (Test-Path -LiteralPath $familyPath) {
        $previous = Get-Content -LiteralPath $familyPath -Raw | ConvertFrom-Json
        if ($previous.ownerToken -cne $OwnerToken) { throw 'Foreign process-family ledger' }
        $known = @($previous.processes)
    }
    foreach ($item in $family) {
        $identity = Identity $item -AllowExited
        if ($null -eq $identity) { continue }
        if (@($known | Where-Object { $_.pid -eq $identity.pid -and $_.created -ceq $identity.created }).Count -eq 0) { $known += $identity }
    }
    @{ ownerToken = $OwnerToken; completeObservation = $true; processes = $known } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $familyPath -Encoding UTF8
    return $family
}
$nativeReady = $false
function Initialize-Native {
    Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes, System.Drawing
    Add-Type -ReferencedAssemblies System.Drawing -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
public static class DesktopAcceptanceWindows {
    public delegate bool Callback(IntPtr window, IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumWindows(Callback callback, IntPtr data);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int count);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr dc, uint flags);
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    public static IntPtr[] Owned(int pid) {
        var result = new List<IntPtr>();
        EnumWindows(delegate(IntPtr w, IntPtr unused) { uint owner; GetWindowThreadProcessId(w, out owner); if (owner == pid && IsWindowVisible(w)) result.Add(w); return true; }, IntPtr.Zero);
        return result.ToArray();
    }
    public static string Kind(IntPtr window) { var text = new StringBuilder(128); GetClassName(window, text, text.Capacity); return text.ToString(); }
    public static void Capture(IntPtr window, string path) {
        Rect rect; if (!GetWindowRect(window, out rect)) throw new InvalidOperationException("Cannot read owned window bounds");
        int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
        if (width < 1 || height < 1 || width > 8192 || height > 8192) throw new InvalidOperationException("Invalid owned window bounds");
        using (var bitmap = new Bitmap(width, height)) {
            using (var graphics = Graphics.FromImage(bitmap)) { var dc = graphics.GetHdc(); try { PrintWindow(window, dc, 2); } finally { graphics.ReleaseHdc(dc); } }
            bitmap.Save(path, ImageFormat.Png);
        }
    }
}
'@
    $script:nativeReady = $true
}
function Owned-Nodes([switch]$FolderDialog) {
    $current = Read-Process $ShellPid
    if (-not (Same-Identity $current $binding.shell)) { throw 'Native window owner changed' }
    $nodes = @()
    foreach ($handle in [DesktopAcceptanceWindows]::Owned($ShellPid)) {
        if ($FolderDialog -and [DesktopAcceptanceWindows]::Kind($handle) -ne '#32770') { continue }
        try {
            $element = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
            $descendants = $element.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
            if ($descendants.Count -gt 4000) { throw 'Owned accessibility tree exceeds its bound' }
            foreach ($node in $descendants) {
                if ($node.Current.ProcessId -eq $ShellPid) { $nodes += $node }
            }
        } catch [System.Windows.Automation.ElementNotAvailableException] { # A replaced popup is retried within the action deadline.
        }
    }
    return $nodes
}
function Invoke-Control($Node) {
    if ($Node.Current.ProcessId -ne $ShellPid -or -not $Node.Current.IsEnabled -or $Node.Current.IsOffscreen) { throw 'Native control is not enabled and owned' }
    $pattern = $Node.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $pattern.Invoke()
}
function Wait-Control([string]$Name, [switch]$FolderDialog) {
    $timer = [Diagnostics.Stopwatch]::StartNew()
    do {
        $matches = @(Owned-Nodes -FolderDialog:$FolderDialog | Where-Object { $_.Current.Name.Replace('&','') -ceq $Name -and -not $_.Current.IsOffscreen })
        if ($matches.Count -gt 1) { throw "Ambiguous owned native control: $Name" }
        if ($matches.Count -eq 1) { return $matches[0] }
        Start-Sleep -Milliseconds 100
    } while ($timer.Elapsed.TotalSeconds -lt 25)
    throw "Owned native control deadline: $Name"
}
try {
    if ($Action -eq 'VerifyExited') {
        $known = Get-Content -LiteralPath $familyPath -Raw | ConvertFrom-Json
        if ($known.ownerToken -cne $OwnerToken -or $known.completeObservation -ne $true) { throw 'Exit verification requires a complete owned-family observation, not a partial Bind seed' }
        $reusedPids = @()
        foreach ($identity in @($known.processes)) {
            $actual = Read-Process ([int]$identity.pid)
            if (Same-Identity $actual $identity) { throw 'A recorded process incarnation remains live; exit is not verified' }
            if ($null -ne $actual) { $reusedPids += $identity.pid }
        }
        $installRoot = (Split-Path $application -Parent) + '\'
        foreach ($candidate in @(Get-CimInstance Win32_Process)) {
            if ($candidate.ExecutablePath -and $candidate.ExecutablePath.StartsWith($installRoot, [StringComparison]::OrdinalIgnoreCase)) { throw 'An unaccounted installed-product process remains after shell exit' }
            $possibleParents = @($known.processes | Where-Object { $_.pid -eq $candidate.ParentProcessId -and $candidate.CreationDate.ToUniversalTime() -ge [datetime]$_.created })
            if ($possibleParents.Count -ne 0) { throw 'An unaccounted descendant of a recorded PID remains; retain state for investigation' }
        }
        $result = @{ ownedFamilyExited = $true; postExitProcessScanPassed = $true; skippedReusedPids = $reusedPids }
    } elseif ($Action -eq 'StopOwned') {
        if (Same-Identity $shell $binding.shell) { [void](Observe-Family) }
        $known = Get-Content -LiteralPath $familyPath -Raw | ConvertFrom-Json
        if ($known.ownerToken -cne $OwnerToken) { throw 'Foreign cleanup family' }
        $handles = @()
        $reusedPids = @()
        try {
            foreach ($identity in @($known.processes)) {
                $actual = Read-Process ([int]$identity.pid)
                if ($null -eq $actual) { continue }
                if (-not (Same-Identity $actual $identity)) { $reusedPids += $identity.pid; continue } # The owned incarnation exited; never stop its replacement.
                $handle = Get-Process -Id $identity.pid
                [void]$handle.Handle
                if ($handle.StartTime.ToUniversalTime().ToString('o') -cne $identity.created) { $handle.Dispose(); throw 'Cleanup handle incarnation differs' }
                $handles += $handle
            }
            [array]::Reverse($handles)
            foreach ($handle in $handles) { if (-not $handle.HasExited) { $handle.Kill() } }
            foreach ($handle in $handles) { if (-not $handle.WaitForExit(10000)) { throw 'Owned cleanup process did not exit' } }
        } finally { foreach ($handle in $handles) { $handle.Dispose() } }
        $result = @{ stoppedOwnedFamily = $true; skippedReusedPids = $reusedPids }
    } else {
        $family = @(Observe-Family)
        $hosts = @($family | Where-Object { $_.ParentProcessId -eq $ShellPid -and $_.ExecutablePath -ieq $application -and $_.CommandLine -and $_.CommandLine.Contains('dsh-desktop-host') -and $_.CommandLine.Contains('index.js') -and $_.CommandLine.Contains($profile) })
        if ($hosts.Count -gt 1) { throw 'Ambiguous Desktop Host generation' }
        $result = @{ shell = $binding.shell; hosts = @($hosts | ForEach-Object { Identity $_ -AllowExited } | Where-Object { $null -ne $_ }) }
        if ($Action -in @('ReviewPackages','ChooseWorkspace','Exit')) {
            Initialize-Native
            if ($Action -eq 'ChooseWorkspace') {
                if (-not (Test-Path -LiteralPath $workspace -PathType Container) -or ((Get-Item -LiteralPath $workspace).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe fixture workspace' }
                $timer = [Diagnostics.Stopwatch]::StartNew()
                do {
                    $edits = @(Owned-Nodes -FolderDialog | Where-Object { $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Edit -and $_.Current.AutomationId -in @('1148','1152') -and -not $_.Current.IsOffscreen })
                    if ($edits.Count -eq 1) { break }
                    if ($edits.Count -gt 1) { throw 'Ambiguous native folder edit' }
                    Start-Sleep -Milliseconds 100
                } while ($timer.Elapsed.TotalSeconds -lt 25)
                if ($edits.Count -ne 1) { throw 'Native folder path edit not found' }
                $value = $edits[0].GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
                $value.SetValue($workspace)
                if ($value.Current.Value -ine $workspace) { throw 'Native folder edit did not accept owned path' }
                Invoke-Control (Wait-Control 'Select Folder' -FolderDialog)
            } else {
                $label = if ($Action -eq 'ReviewPackages') { 'Review staged package changes' } else { 'Exit' }
                $control = Wait-Control $label
                $result.selectedControl = @{ name = $control.Current.Name; processId = $control.Current.ProcessId; type = $control.Current.ControlType.ProgrammaticName }
                Invoke-Control $control
            }
            $result.nativeActionInvoked = $Action
        }
    }
    @{ schemaVersion = 1; ownerToken = $OwnerToken; requestId = $RequestId; action = $Action; succeeded = $true; result = $result } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding UTF8
} catch {
    $primaryFailure = $_
    $diagnostic = $primaryFailure.Exception.Message
    $secondaryErrors = [Collections.Generic.List[string]]::new()
    $tree = @()
    if ($nativeReady) {
        try {
            $tree = @(Owned-Nodes | Select-Object -First 150 | ForEach-Object { @{ name = $_.Current.Name; automationId = $_.Current.AutomationId; type = $_.Current.ControlType.ProgrammaticName } })
            $number = 0
            foreach ($window in [DesktopAcceptanceWindows]::Owned($ShellPid)) {
                [DesktopAcceptanceWindows]::Capture($window, (Join-Path $evidence "package-native-$RequestId-$number.png"))
                $number++
            }
        } catch { $secondaryErrors.Add('Native evidence capture failed: ' + $_.Exception.Message) }
    }
    try {
        @{ schemaVersion = 1; ownerToken = $OwnerToken; requestId = $RequestId; action = $Action; succeeded = $false; error = $diagnostic; accessibility = $tree; secondaryErrors = @($secondaryErrors) } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $resultPath -Encoding UTF8
    } catch {
        $secondaryErrors.Add('Native failure evidence write failed: ' + $_.Exception.Message)
        try { [Console]::Error.WriteLine(('Secondary native failures: ' + ($secondaryErrors -join '; '))) }
        catch { $secondaryErrors.Add('Secondary native diagnostic output failed: ' + $_.Exception.Message) }
    }
    throw $primaryFailure
}
