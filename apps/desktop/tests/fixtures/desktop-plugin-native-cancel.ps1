# Windows-only, fixture-owned process identity, menu, Apply, Cancel and close operations. Never searches by title alone.
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

function Initialize-UiAutomation {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    $providerName = [Windows.Automation.AutomationElement].Assembly.GetName()
    $providerName.Name = 'UIAutomationClientsideProviders'
    # A managed reflection frame avoids the .NET Framework default-proxy loader's
    # null ReflectedType dereference on PowerShell's dynamic invocation frames.
    $registration = [Windows.Automation.ClientSettings].GetMethod('RegisterClientSideProviderAssembly',
        [type[]]@([Reflection.AssemblyName]))
    $null = $registration.Invoke($null, [object[]]@($providerName))
}

function Read-RuntimeId($element) {
    $values = @($element.GetRuntimeId())
    if ($values.Count -eq 0 -or $values.Count -gt 64) { throw 'UIA RuntimeId is missing or exceeds bound' }
    return ($values -join '.')
}
function Read-BoundedUiTree($root, [int]$MaximumDepth = 8, [int]$MaximumVisited = 512) {
    $walker = [Windows.Automation.TreeWalker]::ControlViewWalker
    $queue = [System.Collections.Generic.Queue[object]]::new()
    $rootRuntimeId = Read-RuntimeId $root
    $queue.Enqueue([pscustomobject]@{ element = $root; depth = 0; runtimeId = $rootRuntimeId })
    $records = [System.Collections.Generic.List[object]]::new()
    $visited = 0
    while ($queue.Count -gt 0) {
        $parent = $queue.Dequeue()
        if ($parent.depth -ge $MaximumDepth) { continue }
        $child = $walker.GetFirstChild($parent.element)
        while ($null -ne $child) {
            if (++$visited -gt $MaximumVisited) { throw 'UIA traversal exceeded visited-element bound' }
            $name = [string]$child.Current.Name
            if ($name.Length -gt 256) { throw 'UIA accessible name exceeded bound' }
            $runtimeId = Read-RuntimeId $child
            $record = [pscustomobject]@{ element = $child; depth = $parent.depth + 1;
                runtimeId = $runtimeId; parentRuntimeId = $parent.runtimeId; name = $name }
            $records.Add($record)
            $queue.Enqueue($record)
            $child = $walker.GetNextSibling($child)
        }
    }
    return $records.ToArray()
}
function Test-UiDescendant($records, [string]$RuntimeId, [string]$AncestorRuntimeId) {
    $parents = @{}
    foreach ($record in $records) { $parents[$record.runtimeId] = $record.parentRuntimeId }
    $current = $RuntimeId
    for ($depth = 0; $depth -le 8; $depth++) {
        if ($current -ceq $AncestorRuntimeId) { return $true }
        if (!$parents.ContainsKey($current)) { return $false }
        $current = $parents[$current]
    }
    throw 'UIA ancestry exceeded depth bound'
}
function Read-UiPattern($element, $pattern, [string]$label) {
    $value = $element.GetCurrentPattern($pattern)
    if ($null -eq $value) { throw "$label does not expose its required UIA pattern" }
    return $value
}

function Assert-PageTitle($title) {
    if ($title -isnot [string] -or [string]::IsNullOrWhiteSpace($title) -or $title.Length -gt 1024 -or
        $title -match '[\x00-\x1f\x7f]') { throw 'Expected bounded nonempty actual CDP page title' }
}

# EnumWindows includes hidden top-level windows. Visibility is evidence, never identity.
function Initialize-WindowApi {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public sealed class OwnedWindowObservation {
    public string hwnd, title, owner, rootOwner;
    public uint pid;
    public int width, height;
    public bool visible, minimized;
}
public static class OwnedDialogWin32 {
    public delegate bool EnumWindowProc(IntPtr hwnd, IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int left, top, right, bottom; }
    [DllImport("user32.dll", SetLastError = true)] public static extern bool EnumWindows(EnumWindowProc callback, IntPtr parameter);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
    [DllImport("user32.dll", SetLastError = true)] public static extern bool PostMessage(IntPtr hwnd, uint message, IntPtr wparam, IntPtr lparam);
    public static OwnedWindowObservation[] Enumerate(uint processId) {
        var windows = new List<OwnedWindowObservation>();
        Exception failure = null;
        int count = 0;
        EnumWindowProc callback = delegate(IntPtr hwnd, IntPtr parameter) {
            try {
                if (++count > 8192) throw new InvalidOperationException("Desktop window enumeration exceeded bound");
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                if (pid != processId) return true;
                if (windows.Count >= 256) throw new InvalidOperationException("Owned window enumeration exceeded bound");
                var text = new StringBuilder(1026);
                int length = GetWindowText(hwnd, text, text.Capacity);
                if (length > 1024) throw new InvalidOperationException("Owned window title exceeded bound");
                Rect rect;
                if (!GetClientRect(hwnd, out rect)) throw new InvalidOperationException("Owned window client rectangle unavailable");
                var observation = new OwnedWindowObservation {
                    hwnd = hwnd.ToInt64().ToString(), pid = pid, title = text.ToString(),
                    owner = GetWindow(hwnd, 4).ToInt64().ToString(),
                    rootOwner = GetAncestor(hwnd, 3).ToInt64().ToString(),
                    width = rect.right - rect.left, height = rect.bottom - rect.top,
                    visible = IsWindowVisible(hwnd), minimized = IsIconic(hwnd)
                };
                uint currentPid;
                GetWindowThreadProcessId(hwnd, out currentPid);
                if (!IsWindow(hwnd) || currentPid != processId) throw new InvalidOperationException("Owned window changed during enumeration");
                windows.Add(observation);
                return true;
            } catch (Exception error) { failure = error; return false; }
        };
        bool complete = EnumWindows(callback, IntPtr.Zero);
        if (failure != null) throw failure;
        if (!complete) throw new InvalidOperationException("EnumWindows did not complete");
        return windows.ToArray();
    }
}
'@
}

function Read-OwnedWindows($process) {
    if ($process.HasExited) { throw 'Owned process exited before enumeration' }
    $windows = [OwnedDialogWin32]::Enumerate([uint32]$process.Id)
    if ($process.HasExited) { throw 'Owned process exited during enumeration' }
    return ,$windows
}
function Select-OwnedRoot($windows, [int]$ProcessId, [string]$title) {
    Assert-PageTitle $title
    $matches = @($windows | Where-Object {
        $_.pid -eq $ProcessId -and $_.title -ceq $title -and $_.hwnd -cne '0' -and
        $_.owner -ceq '0' -and $_.rootOwner -ceq $_.hwnd -and $_.width -gt 0 -and $_.height -gt 0
    })
    if ($matches.Count -gt 1) { throw 'Ambiguous owned root windows matching actual CDP page title' }
    if ($matches.Count -eq 1) { return $matches[0] }
    return $null
}
function Read-VerifiedRoot($process, [string]$title, [string]$hwnd) {
    $windows = Read-OwnedWindows $process
    $selected = Select-OwnedRoot $windows $process.Id $title
    if ($null -eq $selected -or $selected.hwnd -cne $hwnd) { throw 'Exact owned root HWND/title/owner identity changed' }
    return @{ candidates = $windows; selected = $selected }
}
function Capture-OwnedRoot($process, [string]$title) {
    Assert-PageTitle $title
    $clock = [Diagnostics.Stopwatch]::StartNew()
    do {
        $windows = Read-OwnedWindows $process
        $selected = Select-OwnedRoot $windows $process.Id $title
        if ($null -ne $selected) { break }
        Start-Sleep -Milliseconds 100
    } while ($clock.Elapsed.TotalSeconds -lt 30)
    if ($null -eq $selected -or $clock.Elapsed.TotalSeconds -ge 30) { throw 'Timed out discovering unique owned root window' }
    $initial = $windows
    $hwnd = $selected.hwnd
    $current = Read-VerifiedRoot $process $title $hwnd
    $showRequested = $false
    if (!$current.selected.visible -or $current.selected.minimized) {
        # No global focus/keys: restore/show only this identity-revalidated HWND.
        $command = if ($current.selected.minimized) { 9 } else { 4 }
        if (![OwnedDialogWin32]::ShowWindowAsync([IntPtr]([long]$hwnd), $command)) { throw 'Owned root show request was rejected' }
        $showRequested = $true
    }
    $clock.Restart()
    do {
        $current = Read-VerifiedRoot $process $title $hwnd
        if ($current.selected.visible -and !$current.selected.minimized) { break }
        Start-Sleep -Milliseconds 100
    } while ($clock.Elapsed.TotalSeconds -lt 15)
    if (!$current.selected.visible -or $current.selected.minimized -or $clock.Elapsed.TotalSeconds -ge 15) {
        throw 'Owned root did not become visible and unminimized within bound'
    }
    return @{ title = $title; initialCandidates = $initial; readyCandidates = $current.candidates;
        showRequested = $showRequested; hwnd = $hwnd }
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
        Assert-PageTitle $request.pageTitle
        Initialize-WindowApi
        $mainWindow = Capture-OwnedRoot $verifiedMain $request.pageTitle
        $mainHwnd = $mainWindow.hwnd
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
        $finalWindow = Read-VerifiedRoot $verifiedMain $mainWindow.title $mainHwnd
        if (!$finalWindow.selected.visible -or $finalWindow.selected.minimized) { throw 'Owned root visibility changed during capture' }
        $mainWindow.readyCandidates = $finalWindow.candidates
        [ordered]@{ main = $main; host = $hostIdentity; mainHwnd = $mainHwnd; mainWindow = $mainWindow;
            home = $request.home; hostEntry = $request.hostEntry; profile = $request.profile } | ConvertTo-Json -Depth 8 -Compress
        exit 0
    } finally { $verifiedMain.Dispose() }
}

$ownership = $request.ownership
Assert-PageTitle $ownership.mainWindow.title
if ($ownership.mainWindow.hwnd -cne $ownership.mainHwnd) { throw 'Captured main HWND evidence mismatch' }
Initialize-WindowApi
if ($request.action -eq 'close') {
    $main = Open-Verified $ownership.main
    try {
        $current = Read-VerifiedRoot $main $ownership.mainWindow.title $ownership.mainHwnd
        if (![OwnedDialogWin32]::PostMessage([IntPtr]([long]$ownership.mainHwnd), 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)) {
            throw 'Exact owned root WM_CLOSE request was rejected'
        }
        # Only a close request: the caller must prove root exit AND empty Job within its deadline.
        @{ closeRequested = $true; mainHwnd = $ownership.mainHwnd; mainWindow = $current.selected } | ConvertTo-Json -Depth 5 -Compress
        exit 0
    } finally { $main.Dispose() }
}

$mainProcess = Open-Verified $ownership.main
$hostProcess = $null
$diagnosticStream = $null
try {
    $hostProcess = Open-Verified $ownership.host
    $hostCim = Get-CimInstance Win32_Process -Filter "ProcessId = $($ownership.host.pid)"
    if ($null -eq $hostCim -or $hostCim.ParentProcessId -ne $ownership.main.pid) { throw 'Host no longer belongs to the owned Electron main' }
    $currentRoot = Read-VerifiedRoot $mainProcess $ownership.mainWindow.title $ownership.mainHwnd
    if (!$currentRoot.selected.visible -or $currentRoot.selected.minimized) { throw 'Owned root is no longer visible and unminimized' }
    if ($request.action -eq 'verify') {
        $currentHosts = @(Get-CimInstance Win32_Process -Filter "ParentProcessId = $($ownership.main.pid)" | Where-Object {
            $_.ExecutablePath -eq $ownership.main.executable -and $null -ne $_.CommandLine -and
            $_.CommandLine.Contains($ownership.hostEntry) -and $_.CommandLine.Contains($ownership.profile)
        })
        if ($currentHosts.Count -ne 1 -or $currentHosts[0].ProcessId -ne $ownership.host.pid) { throw 'The actual owned Host child changed' }
        @{ main = $ownership.main; host = $ownership.host; mainHwnd = $ownership.mainHwnd;
            mainWindow = $currentRoot.selected } | ConvertTo-Json -Depth 5 -Compress
        exit 0
    }
    if ($request.action -eq 'open-manager') {
        Initialize-UiAutomation
        $mainHwnd = [IntPtr]([long]$ownership.mainHwnd)
        $canonicalRoot = [Windows.Automation.AutomationElement]::FromHandle($mainHwnd)
        if ($null -eq $canonicalRoot -or [IntPtr]$canonicalRoot.Current.NativeWindowHandle -ne $mainHwnd -or
            $canonicalRoot.Current.ProcessId -ne $ownership.main.pid) { throw 'Cannot bind owned main HWND to canonical UIA root' }
        $preWindows = Read-OwnedWindows $mainProcess
        $preHandles = @($preWindows | ForEach-Object { $_.hwnd })
        $preVisibleHandles = @($preWindows | Where-Object { $_.visible } | ForEach-Object { $_.hwnd })
        $rootTree = Read-BoundedUiTree $canonicalRoot
        $applications = @($rootTree | Where-Object {
            $_.name -ceq 'Application' -and
            $_.element.Current.ControlType -eq [Windows.Automation.ControlType]::MenuItem -and
            $_.element.Current.ProcessId -eq $ownership.main.pid -and
            $_.element.Current.IsEnabled -and !$_.element.Current.IsOffscreen
        })
        if ($applications.Count -ne 1) { throw 'Expected one exact owned Application menu item' }
        $application = $applications[0]
        $applicationRuntimeId = $application.runtimeId
        $expand = Read-UiPattern $application.element ([Windows.Automation.ExpandCollapsePattern]::Pattern) 'Application menu item'
        $expand.Expand()

        function Merge-OwnedManagerRoutes($routes) {
            $items = @($routes)
            if ($items.Count -eq 0) { return @() }
            $groups = @($items | Group-Object -Property runtimeId)
            if ($groups.Count -ne 1) { throw 'Distinct Desktop Plugins… RuntimeIds are ambiguous' }
            $bindings = @($groups[0].Group)
            $popupBindings = @($bindings | Where-Object { $null -ne $_.popupHwnd })
            $popupHwnds = @($popupBindings | ForEach-Object { $_.popupHwnd } | Sort-Object -Unique)
            if ($popupHwnds.Count -gt 1) { throw 'Desktop Plugins… RuntimeId has conflicting popup bindings' }
            $selected = $bindings[0]
            if ($popupBindings.Count -gt 0) { $selected = $popupBindings[0] }
            $relations = @($bindings | ForEach-Object { $_.relation } | Sort-Object -Unique)
            $popupBinding = if ($popupHwnds.Count -eq 1) { $popupHwnds[0] } else { $null }
            return [pscustomobject]@{ element = $selected.element; runtimeId = $groups[0].Name;
                popupHwnd = $popupBinding; relations = $relations; observations = $bindings.Count }
        }

        function Find-OwnedManagerLeaf($root, $applicationId, $beforeVisibleHandles) {
            $matches = @()
            $tree = Read-BoundedUiTree $root
            foreach ($record in @($tree | Where-Object {
                $_.name -ceq 'Desktop Plugins…' -and
                $_.element.Current.ControlType -eq [Windows.Automation.ControlType]::MenuItem -and
                $_.element.Current.ProcessId -eq $ownership.main.pid -and
                $_.element.Current.IsEnabled -and !$_.element.Current.IsOffscreen
            })) {
                if (Test-UiDescendant $tree $record.runtimeId $applicationId) {
                    $matches += [pscustomobject]@{ element = $record.element; runtimeId = $record.runtimeId;
                        popupHwnd = $null; relation = 'Application descendant' }
                }
            }
            $ownedWindows = Read-OwnedWindows $mainProcess
            $popups = @($ownedWindows | Where-Object {
                $_.hwnd -cne $ownership.mainHwnd -and $_.pid -eq $ownership.main.pid -and $_.visible -and !$_.minimized -and
                $beforeVisibleHandles -cnotcontains $_.hwnd -and
                ($_.owner -ceq $ownership.mainHwnd -or $_.rootOwner -ceq $ownership.mainHwnd)
            })
            if ($popups.Count -gt 16) { throw 'Owned menu popup count exceeded bound' }
            foreach ($popup in $popups) {
                $popupHwnd = [IntPtr]([long]$popup.hwnd)
                $popupRoot = [Windows.Automation.AutomationElement]::FromHandle($popupHwnd)
                if ($null -eq $popupRoot -or $popupRoot.Current.ProcessId -ne $ownership.main.pid) {
                    throw 'Owned menu popup UIA root identity changed'
                }
                $popupTree = Read-BoundedUiTree $popupRoot
                foreach ($record in @($popupTree | Where-Object {
                    $_.name -ceq 'Desktop Plugins…' -and
                    $_.element.Current.ControlType -eq [Windows.Automation.ControlType]::MenuItem -and
                    $_.element.Current.ProcessId -eq $ownership.main.pid -and
                    $_.element.Current.IsEnabled -and !$_.element.Current.IsOffscreen
                })) {
                    $matches += [pscustomobject]@{ element = $record.element; runtimeId = $record.runtimeId;
                        popupHwnd = $popup.hwnd; relation = 'new owned popup' }
                }
            }
            return Merge-OwnedManagerRoutes $matches
        }

        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        $routes = @()
        while ($routes.Count -eq 0 -and [DateTime]::UtcNow -lt $deadline) {
            $null = Read-VerifiedRoot $mainProcess $ownership.mainWindow.title $ownership.mainHwnd
            $routes = @(Find-OwnedManagerLeaf $canonicalRoot $applicationRuntimeId $preVisibleHandles)
            if ($routes.Count -eq 0) { Start-Sleep -Milliseconds 100 }
        }
        if ($routes.Count -ne 1) { throw 'Expected one exact Desktop Plugins… menu route' }
        $route = $routes[0]
        $leafRuntimeId = $route.runtimeId

        $currentRoot = Read-VerifiedRoot $mainProcess $ownership.mainWindow.title $ownership.mainHwnd
        if (!$currentRoot.selected.visible -or $currentRoot.selected.minimized -or $mainProcess.HasExited -or $hostProcess.HasExited) {
            throw 'Owned root or Host changed before manager-menu invocation'
        }
        $canonicalRoot = [Windows.Automation.AutomationElement]::FromHandle($mainHwnd)
        $currentTree = Read-BoundedUiTree $canonicalRoot
        $currentApplication = @($currentTree | Where-Object { $_.runtimeId -ceq $applicationRuntimeId })
        if ($currentApplication.Count -ne 1 -or $currentApplication[0].name -cne 'Application' -or
            $currentApplication[0].element.Current.ControlType -ne [Windows.Automation.ControlType]::MenuItem -or
            $currentApplication[0].element.Current.ProcessId -ne $ownership.main.pid -or
            !$currentApplication[0].element.Current.IsEnabled -or $currentApplication[0].element.Current.IsOffscreen) {
            throw 'Application menu item changed before manager-menu invocation'
        }
        $null = Read-UiPattern $currentApplication[0].element ([Windows.Automation.ExpandCollapsePattern]::Pattern) 'Application menu item'
        $currentRoutes = @(Find-OwnedManagerLeaf $canonicalRoot $applicationRuntimeId $preVisibleHandles)
        $currentRoute = @($currentRoutes | Where-Object { $_.runtimeId -ceq $leafRuntimeId })
        if ($currentRoutes.Count -ne 1 -or $currentRoute.Count -ne 1) {
            throw 'Desktop Plugins… menu route changed before invocation'
        }
        $invoke = Read-UiPattern $currentRoute[0].element ([Windows.Automation.InvokePattern]::Pattern) 'Desktop Plugins menu item'
        $invoke.Invoke()
        $postHandles = @(Read-OwnedWindows $mainProcess | ForEach-Object { $_.hwnd })
        [ordered]@{ action = 'OpenManager'; route = 'owned-uia'; semanticPath = @('Application', 'Desktop Plugins…');
            rootHwnd = $ownership.mainHwnd; applicationRuntimeId = $applicationRuntimeId; leafRuntimeId = $leafRuntimeId;
            relations = $currentRoute[0].relations; observations = $currentRoute[0].observations;
            popupHwnd = $currentRoute[0].popupHwnd;
            expandPattern = 'ExpandCollapsePattern'; invokePattern = 'InvokePattern';
            preOwnedHwnds = $preHandles; preVisibleHwnds = $preVisibleHandles;
            postOwnedHwnds = $postHandles } | ConvertTo-Json -Depth 6 -Compress
        exit 0
    }
    if ($request.action -ne 'cancel' -and $request.action -ne 'apply') { throw 'Unknown fixture helper action' }
    Initialize-UiAutomation
    $mainHwnd = [IntPtr]([long]$ownership.mainHwnd)
    # Private fixture evidence only; flushed records survive helper failure or timeout.
    # No unrelated window text or controls are recorded, and evidence never selects a target.
    try {
        $diagnosticStream = [IO.File]::Open($RequestFile + '.observations.jsonl', [IO.FileMode]::CreateNew,
            [IO.FileAccess]::Write, [IO.FileShare]::Read)
    } catch { [Console]::Error.WriteLine('Native observation file unavailable') }
    $diagnosticClock = [Diagnostics.Stopwatch]::StartNew()
    $script:nextDiagnosticMs = 0
    $script:diagnosticWriteFailed = $false
    function Write-Observation($value) {
        if ($null -eq $diagnosticStream -or $script:diagnosticWriteFailed) { return }
        try {
            $bytes = [Text.Encoding]::UTF8.GetBytes(($value | ConvertTo-Json -Depth 6 -Compress) + "`n")
            if ($bytes.Length -gt 32768 -or $diagnosticStream.Position + $bytes.Length -gt 262144) { return }
            $diagnosticStream.Write($bytes, 0, $bytes.Length)
            $diagnosticStream.Flush()
        } catch {
            $script:diagnosticWriteFailed = $true
            [Console]::Error.WriteLine('Native observation write failed')
        }
    }
    function Bounded-Name([string]$value) {
        if ($value.Length -gt 128) { return $value.Substring(0, 128) }
        return $value
    }
    function Read-OwnedConfirmation([int]$ProcessId, [IntPtr]$MainHwnd) {
        # UIA's desktop root can omit owned modal windows. Discover HWNDs natively,
        # then use canonical UIA only inside the exact process/root-owner checks.
        $windows = Read-OwnedWindows $mainProcess
        $trace = $diagnosticClock.ElapsedMilliseconds -ge $script:nextDiagnosticMs
        if ($trace) {
            $script:nextDiagnosticMs = $diagnosticClock.ElapsedMilliseconds + 10000
            try {
                $nativeWindows = $windows
                $observed = @($nativeWindows | Select-Object -First 32 | ForEach-Object {
                    @{ hwnd = $_.hwnd; pid = $_.pid; owner = $_.owner; rootOwner = $_.rootOwner;
                        title = (Bounded-Name $_.title); width = $_.width; height = $_.height;
                        visible = $_.visible; minimized = $_.minimized }
                })
                Write-Observation @{ stage = 'native-windows'; elapsedMs = $diagnosticClock.ElapsedMilliseconds;
                    total = $nativeWindows.Count; windows = $observed }
            } catch { Write-Observation @{ stage = 'native-observation-unavailable' } }
        }
        [uint32]$windowPid = 0
        $matches = @()
        if ($trace) { Write-Observation @{ stage = 'native-confirmation-candidates'; total = $windows.Count } }
        $ownedCount = 0
        foreach ($candidate in $windows) {
            $candidateHwnd = [IntPtr]([long]$candidate.hwnd)
            if ($candidateHwnd -eq [IntPtr]::Zero -or $candidateHwnd -eq $MainHwnd -or
                ![OwnedDialogWin32]::IsWindow($candidateHwnd)) { continue }
            $null = [OwnedDialogWin32]::GetWindowThreadProcessId($candidateHwnd, [ref]$windowPid)
            if ($windowPid -ne $ProcessId) { continue }
            if (++$ownedCount -gt 256) { throw 'Owned confirmation window enumeration exceeded bound' }
            if ($trace -and $ownedCount -le 32) {
                try {
                    Write-Observation @{ stage = 'owned-window-candidate'; hwnd = $candidateHwnd.ToInt64().ToString();
                        rootOwner = [OwnedDialogWin32]::GetAncestor($candidateHwnd, 3).ToInt64().ToString() }
                } catch { Write-Observation @{ stage = 'window-observation-unavailable' } }
            }
            $null = [OwnedDialogWin32]::GetWindowThreadProcessId($candidateHwnd, [ref]$windowPid)
            if ($windowPid -ne $ProcessId -or [OwnedDialogWin32]::GetAncestor($candidateHwnd, 3) -ne $MainHwnd) { continue }
            # Bind UIA controls to the natively verified HWND; never trust descendants from the enumerating provider object.
            $canonical = [Windows.Automation.AutomationElement]::FromHandle($candidateHwnd)
            if ($null -eq $canonical -or [IntPtr]$canonical.Current.NativeWindowHandle -ne $candidateHwnd) {
                throw 'Cannot bind owned confirmation HWND to its canonical UIA element'
            }
            $elements = $canonical.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)
            if ($elements.Count -gt 2048) { throw 'Owned confirmation control enumeration exceeded bound' }
            $cancel = @($elements | Where-Object {
                $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.Name -ceq 'Cancel'
            })
            $apply = @($elements | Where-Object {
                $_.Current.ControlType -eq [Windows.Automation.ControlType]::Button -and $_.Current.Name -ceq 'Apply and Restart Host'
            })
            $message = @($elements | Where-Object { $_.Current.Name -ceq 'Restart the Desktop Host to apply this change?' })
            if ($trace -and $ownedCount -le 32) {
                try {
                    $null = [OwnedDialogWin32]::GetWindowThreadProcessId($candidateHwnd, [ref]$windowPid)
                    if ([OwnedDialogWin32]::IsWindow($candidateHwnd) -and $windowPid -eq $ProcessId -and
                        [OwnedDialogWin32]::GetAncestor($candidateHwnd, 3) -eq $MainHwnd) {
                        $controls = @($elements | Select-Object -First 32 | ForEach-Object {
                            @{ name = (Bounded-Name $_.Current.Name); type = $_.Current.ControlType.ProgrammaticName;
                                pid = $_.Current.ProcessId; enabled = $_.Current.IsEnabled; offscreen = $_.Current.IsOffscreen }
                        })
                        Write-Observation @{ stage = 'owned-controls'; hwnd = $candidateHwnd.ToInt64().ToString();
                            total = $elements.Count; cancelCount = $cancel.Count; applyCount = $apply.Count;
                            messageCount = $message.Count; controls = $controls }
                    }
                } catch { Write-Observation @{ stage = 'control-observation-unavailable' } }
            }
            if ($cancel.Count -eq 1 -and $apply.Count -eq 1 -and $message.Count -ge 1) {
                # Descendant traversal can race destruction or handle reuse; native identity must still match afterward.
                if (![OwnedDialogWin32]::IsWindow($candidateHwnd) -or
                    [IntPtr]$canonical.Current.NativeWindowHandle -ne $candidateHwnd) { throw 'Owned confirmation changed during control enumeration' }
                $null = [OwnedDialogWin32]::GetWindowThreadProcessId($candidateHwnd, [ref]$windowPid)
                if ($windowPid -ne $ProcessId -or [OwnedDialogWin32]::GetAncestor($candidateHwnd, 3) -ne $MainHwnd) {
                    throw 'Owned confirmation identity changed during control enumeration'
                }
                $title = [Text.StringBuilder]::new(1026)
                $length = [OwnedDialogWin32]::GetWindowText($candidateHwnd, $title, $title.Capacity)
                if ($length -gt 1024) { throw 'Owned confirmation title exceeded bound' }
                $matches += @{ dialog = $canonical; hwnd = $candidateHwnd; title = $title.ToString();
                    cancel = $cancel[0]; apply = $apply[0]; messageCount = $message.Count }
            }
        }
        if ($matches.Count -gt 1) { throw 'Ambiguous owned confirmation windows with exact controls' }
        if ($matches.Count -eq 1) { return $matches[0] }
        return $null
    }
    $deadline = [DateTime]::UtcNow.AddSeconds(45)
    $confirmation = $null
    while ($null -eq $confirmation -and [DateTime]::UtcNow -lt $deadline) {
        if ($mainProcess.HasExited -or $hostProcess.HasExited) { throw 'Owned application exited before native confirmation' }
        $confirmation = Read-OwnedConfirmation ([int]$ownership.main.pid) $mainHwnd
        if ($null -eq $confirmation) { Start-Sleep -Milliseconds 100 }
    }
    if ($null -eq $confirmation) { throw 'Verified owned native confirmation did not appear' }
    $hwnd = $confirmation.hwnd
    $controlName = if ($request.action -eq 'apply') { 'Apply' } else { 'Cancel' }
    $control = if ($request.action -eq 'apply') { $confirmation.apply } else { $confirmation.cancel }
    if (!$control.Current.IsEnabled -or $control.Current.IsOffscreen -or $control.Current.ProcessId -ne $ownership.main.pid) {
        throw "$controlName is not an enabled owned visible control"
    }
    $focused = $control.Current.HasKeyboardFocus
    $invoke = $control.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
    if ($null -eq $invoke) { throw "$controlName has no native InvokePattern" }
    # Recheck the retained process handles, exact root and structurally matched dialog before invocation.
    $currentRoot = Read-VerifiedRoot $mainProcess $ownership.mainWindow.title $ownership.mainHwnd
    if (!$currentRoot.selected.visible -or $currentRoot.selected.minimized) { throw "Owned root visibility changed before $controlName" }
    if ($mainProcess.HasExited -or $hostProcess.HasExited) { throw 'Dialog ownership expired before invocation' }
    $currentConfirmation = Read-OwnedConfirmation ([int]$ownership.main.pid) $mainHwnd
    if ($null -eq $currentConfirmation -or $currentConfirmation.hwnd -ne $hwnd) {
        throw "$controlName confirmation changed before invocation"
    }
    $currentControl = if ($request.action -eq 'apply') { $currentConfirmation.apply } else { $currentConfirmation.cancel }
    if (!$currentControl.Current.IsEnabled -or $currentControl.Current.IsOffscreen -or
        $currentControl.Current.ProcessId -ne $ownership.main.pid) { throw "$controlName identity changed before invocation" }
    $invoke = $currentControl.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
    if ($null -eq $invoke) { throw "$controlName lost native InvokePattern" }
    $invoke.Invoke()
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    while ([OwnedDialogWin32]::IsWindow($hwnd) -and [DateTime]::UtcNow -lt $deadline) { Start-Sleep -Milliseconds 100 }
    if ([OwnedDialogWin32]::IsWindow($hwnd)) { throw "Native dialog did not close after $controlName" }
    if ($request.action -eq 'cancel') {
        $afterWindow = (Read-VerifiedRoot $mainProcess $ownership.mainWindow.title $ownership.mainHwnd).selected
    } else {
        if ($mainProcess.HasExited -or ![OwnedDialogWin32]::IsWindow($mainHwnd)) { throw 'Owned main process or root ended after Apply' }
        [uint32]$afterPid = 0
        $null = [OwnedDialogWin32]::GetWindowThreadProcessId($mainHwnd, [ref]$afterPid)
        if ($afterPid -ne $ownership.main.pid -or [OwnedDialogWin32]::GetAncestor($mainHwnd, 3) -ne $mainHwnd) {
            throw 'Owned root identity changed after Apply'
        }
        $afterWindows = Read-OwnedWindows $mainProcess
        $afterMatches = @($afterWindows | Where-Object { $_.hwnd -ceq $ownership.mainHwnd })
        if ($afterMatches.Count -ne 1 -or !$afterMatches[0].visible -or $afterMatches[0].minimized) {
            throw 'Owned root is not uniquely visible after Apply'
        }
        $afterWindow = $afterMatches[0]
    }
    $cancelFocused = if ($request.action -eq 'cancel') { $focused } else { $null }
    $applyFocused = if ($request.action -eq 'apply') { $focused } else { $null }
    [ordered]@{ action = $controlName; dialogHwnd = $hwnd.ToInt64().ToString(); observedTitle = $confirmation.title;
        mainHwnd = $ownership.mainHwnd; mainWindow = $afterWindow;
        messageVerified = $true; exactButtonsVerified = $true;
        cancelHadKeyboardFocus = $cancelFocused; applyHadKeyboardFocus = $applyFocused;
        defaultFocusAsserted = $false; closed = $true } | ConvertTo-Json -Depth 5 -Compress
} finally {
    try {
        if ($null -ne $diagnosticStream) { $diagnosticStream.Dispose() }
    } catch { [Console]::Error.WriteLine('Native observation close failed') }
    try { if ($null -ne $hostProcess) { $hostProcess.Dispose() } } finally { $mainProcess.Dispose() }
}
