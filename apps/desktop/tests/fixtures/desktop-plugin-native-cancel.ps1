# Windows-only, fixture-owned process identity and native Cancel operations. Never searches by title alone.
param([Parameter(Mandatory = $true)][string]$RequestFile)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$request = Get-Content -LiteralPath $RequestFile -Raw | ConvertFrom-Json

function Read-Identity([int]$ProcessId) {
    $p = [Diagnostics.Process]::GetProcessById($ProcessId)
    try {
        # Open a process handle before identity inspection; no PID-only actions are permitted.
        $null = $p.Handle
        return [ordered]@{ pid = $p.Id; created = $p.StartTime.ToUniversalTime().Ticks.ToString(); executable = $p.MainModule.FileName }
    } finally { $p.Dispose() }
}
function Open-Verified($identity) {
    $p = [Diagnostics.Process]::GetProcessById([int]$identity.pid)
    try {
        $null = $p.Handle
        if ($p.HasExited) { throw 'Owned process exited' }
        if ($p.StartTime.ToUniversalTime().Ticks.ToString() -cne $identity.created -or
            ![string]::Equals($p.MainModule.FileName, $identity.executable, [StringComparison]::OrdinalIgnoreCase)) {
            throw 'Process identity changed; refusing PID-only action'
        }
        return $p
    } catch { $p.Dispose(); throw }
}

# This helper verifies selected identities only. Complete process-tree ownership and quiescence
# belong exclusively to the fixture's retained, nonbreakaway Win32 Job, never a CIM snapshot.
function Assert-Launch($main, $process) {
    if (![string]::Equals($main.executable, $request.application, [StringComparison]::OrdinalIgnoreCase)) { throw 'Wrong Electron executable' }
    if ([long]$main.created -lt [DateTime]::Parse($request.launchedAfter).ToUniversalTime().Ticks) { throw 'Electron predates fixture launch' }
    $current = Get-CimInstance Win32_Process -Filter "ProcessId = $($main.pid)"
    if ($null -eq $current -or $current.CommandLine -cne $request.commandLine) { throw 'Owned root launch argv mismatch' }
    $port = [int]$request.port
    if ($port -lt 1 -or $port -gt 65535) { throw 'Invalid CDP port' }
    $listeners = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction Stop)
    if ($listeners.Count -ne 1 -or $listeners[0].LocalAddress -cne '127.0.0.1' -or
        $listeners[0].OwningProcess -ne $main.pid) { throw 'CDP listener is not loopback on the exact Job-created root' }
    if ($process.HasExited) { throw 'Owned root exited during CDP identity check' }
}

function Read-OnlyMainWindow($process) {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $process.Refresh()
    $hwnd = $process.MainWindowHandle
    if ($hwnd -eq [IntPtr]::Zero) { throw 'Owned main has no main HWND after app-ready' }
    $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll(
        [Windows.Automation.TreeScope]::Children,
        [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, $process.Id))
    if ($windows.Count -ne 1 -or [long]$windows[0].Current.NativeWindowHandle -ne $hwnd.ToInt64()) {
        throw 'Cannot identify exactly one owned root main window'
    }
    return $hwnd.ToInt64().ToString()
}

if ($request.action -eq 'listener' -or $request.action -eq 'capture') {
    $main = Read-Identity ([int]$request.mainPid)
    $verifiedMain = Open-Verified $main
    try {
        Assert-Launch $main $verifiedMain
        if ($request.action -eq 'listener') {
            @{ main = $main } | ConvertTo-Json -Depth 5 -Compress
            exit 0
        }
        if ($main.pid -ne $request.main.pid -or $main.created -cne $request.main.created -or
            $main.executable -cne $request.main.executable) { throw 'Root identity changed after CDP attach' }
        $mainHwnd = Read-OnlyMainWindow $verifiedMain
        $hostCandidates = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($main.pid)" | Where-Object {
            $_.ExecutablePath -eq $main.executable -and $null -ne $_.CommandLine -and
            $_.CommandLine.Contains($request.hostEntry) -and $_.CommandLine.Contains($request.profile)
        })
        if ($hostCandidates.Count -ne 1) { throw 'Cannot identify exactly one owned actual Desktop Host child' }
        $hostIdentity = Read-Identity ([int]$hostCandidates[0].ProcessId)
        $verifiedHost = Open-Verified $hostIdentity
        try {
            $currentHost = Get-CimInstance Win32_Process -Filter "ProcessId = $($hostIdentity.pid)"
            if ($null -eq $currentHost -or $currentHost.ParentProcessId -ne $main.pid -or
                $currentHost.ExecutablePath -ne $main.executable -or $null -eq $currentHost.CommandLine -or
                !$currentHost.CommandLine.Contains($request.hostEntry) -or !$currentHost.CommandLine.Contains($request.profile) -or
                [long]$hostIdentity.created -lt [long]$main.created -or $verifiedMain.HasExited -or $verifiedHost.HasExited) {
                throw 'Actual Host identity changed during capture'
            }
        } finally { $verifiedHost.Dispose() }
        [ordered]@{ main = $main; host = $hostIdentity; mainHwnd = $mainHwnd;
            home = $request.home; hostEntry = $request.hostEntry; profile = $request.profile } | ConvertTo-Json -Depth 8 -Compress
        exit 0
    } finally { $verifiedMain.Dispose() }
}

$ownership = $request.ownership
if ($request.action -eq 'close') {
    $main = Open-Verified $ownership.main
    try {
        if ((Read-OnlyMainWindow $main) -cne $ownership.mainHwnd) { throw 'Main HWND changed before normal close' }
        if (!$main.CloseMainWindow()) { throw 'Normal CloseMainWindow request was rejected' }
        # Only a close request: the caller must prove root exit AND empty Job before cleanup.
        @{ closeRequested = $true } | ConvertTo-Json -Compress
        exit 0
    } finally { $main.Dispose() }
}

$mainProcess = Open-Verified $ownership.main
$hostProcess = $null
try {
    $hostProcess = Open-Verified $ownership.host
    $hostCim = Get-CimInstance Win32_Process -Filter "ProcessId = $($ownership.host.pid)"
    if ($hostCim.ParentProcessId -ne $ownership.main.pid) { throw 'Host no longer belongs to the owned Electron main' }
    if ($request.action -eq 'verify') {
        $currentHosts = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($ownership.main.pid)" | Where-Object {
            $_.ExecutablePath -eq $ownership.main.executable -and $null -ne $_.CommandLine -and
            $_.CommandLine.Contains($ownership.hostEntry) -and $_.CommandLine.Contains($ownership.profile)
        })
        if ($currentHosts.Count -ne 1 -or $currentHosts[0].ProcessId -ne $ownership.host.pid) { throw 'The actual owned Host child changed' }
        @{ main = $ownership.main; host = $ownership.host } | ConvertTo-Json -Depth 5 -Compress
        exit 0
    }
    if ($request.action -ne 'cancel') { throw 'Unknown fixture helper action' }
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class OwnedDialogWin32 {
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
}
'@
    $mainHwnd = [IntPtr]([long]$ownership.mainHwnd)
    [uint32]$windowPid = 0
    $null = [OwnedDialogWin32]::GetWindowThreadProcessId($mainHwnd, [ref]$windowPid)
    if ($windowPid -ne $ownership.main.pid -or ![OwnedDialogWin32]::IsWindow($mainHwnd)) { throw 'Owned main HWND identity failed' }
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $dialog = $null
    $title = 'Apply Plugin Change'
    while ($null -eq $dialog -and [DateTime]::UtcNow -lt $deadline) {
        if ($mainProcess.HasExited -or $hostProcess.HasExited) { throw 'Owned application exited before native Cancel' }
        $windows = [Windows.Automation.AutomationElement]::RootElement.FindAll(
            [Windows.Automation.TreeScope]::Children,
            [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty, [int]$ownership.main.pid))
        foreach ($candidate in $windows) {
            if ($candidate.Current.Name -ceq $title) {
                if ($null -ne $dialog) { throw 'Ambiguous owned confirmation windows' }
                $dialog = $candidate
            }
        }
        if ($null -eq $dialog) { Start-Sleep -Milliseconds 100 }
    }
    if ($null -eq $dialog) { throw 'Verified owned native confirmation did not appear' }
    $hwnd = [IntPtr]$dialog.Current.NativeWindowHandle
    $null = [OwnedDialogWin32]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)
    $text = [Text.StringBuilder]::new(256)
    $null = [OwnedDialogWin32]::GetWindowText($hwnd, $text, $text.Capacity)
    if ($windowPid -ne $ownership.main.pid -or $text.ToString() -cne $title -or
        [OwnedDialogWin32]::GetAncestor($hwnd, 3) -ne $mainHwnd) { throw 'Native HWND/title/owner identity failed' }
    $elements = $dialog.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
    $cancel = @($elements | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.Name -ceq 'Cancel' })
    $apply = @($elements | Where-Object { $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.Name -ceq 'Apply and Restart Host' })
    $message = @($elements | Where-Object { $_.Current.Name -ceq 'Restart the Desktop Host to apply this change?' })
    if ($cancel.Count -ne 1 -or $apply.Count -ne 1 -or $message.Count -lt 1) { throw 'Native message and exact button identities were not verified' }
    if (!$cancel[0].Current.IsEnabled -or $cancel[0].Current.IsOffscreen -or $cancel[0].Current.ProcessId -ne $ownership.main.pid) { throw 'Cancel is not an enabled owned visible control' }
    $focused = $cancel[0].Current.HasKeyboardFocus
    $invoke = $cancel[0].GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
    if ($null -eq $invoke) { throw 'Cancel has no native InvokePattern' }
    # Recheck the retained process handles and HWND immediately before the one allowed UI action.
    if ($mainProcess.HasExited -or $hostProcess.HasExited -or ![OwnedDialogWin32]::IsWindow($hwnd)) { throw 'Dialog ownership expired before invocation' }
    $null = [OwnedDialogWin32]::GetWindowThreadProcessId($hwnd, [ref]$windowPid)
    $null = $text.Clear()
    $null = [OwnedDialogWin32]::GetWindowText($hwnd, $text, $text.Capacity)
    if ($windowPid -ne $ownership.main.pid -or $text.ToString() -cne $title -or
        $cancel[0].Current.Name -cne 'Cancel' -or $cancel[0].Current.ProcessId -ne $ownership.main.pid) { throw 'Cancel identity changed before invocation' }
    $invoke.Invoke()
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([OwnedDialogWin32]::IsWindow($hwnd) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if ([OwnedDialogWin32]::IsWindow($hwnd)) { throw 'Native dialog did not close after Cancel' }
    [ordered]@{ action = 'Cancel'; dialogHwnd = $hwnd.ToInt64().ToString(); title = $title; messageVerified = $true; cancelHadKeyboardFocus = $focused; defaultFocusAsserted = $false; closed = $true } | ConvertTo-Json -Compress
} finally {
    if ($null -ne $hostProcess) { $hostProcess.Dispose() }
    $mainProcess.Dispose()
}
