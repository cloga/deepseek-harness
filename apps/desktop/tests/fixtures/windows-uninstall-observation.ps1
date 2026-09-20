# Failure-only process observations. Loading this file performs no OS observations.
# The 2s budget controls admission, not wall time: local process/file reads are not cancellable.
# No window APIs are used. Narrow wrappers let pure tests replace every process/file observation.
function New-UninstallObservationClock { [Diagnostics.Stopwatch]::StartNew() }
function Get-UninstallObservationRemaining($Budget) {
    $elapsed = $Budget.Clock.ElapsedMilliseconds
    if (($elapsed -isnot [long] -and $elapsed -isnot [int]) -or $elapsed -lt 0 -or $elapsed -ge 2000) {
        $Budget.Expired = $true
        throw 'Soft observation budget exhausted or unavailable'
    }
    return [int](2000 - $elapsed)
}
function Open-UninstallObservationProcess([int]$ProcessId, $Budget) {
    [void](Get-UninstallObservationRemaining $Budget)
    $process = [Diagnostics.Process]::GetProcessById($ProcessId)
    try {
        [void](Get-UninstallObservationRemaining $Budget)
        if ($process.Handle -eq [IntPtr]::Zero) { throw 'Process handle unavailable' }
        [void](Get-UninstallObservationRemaining $Budget)
        return $process
    } catch { $process.Dispose(); throw }
}
function Read-UninstallObservationProcess([int]$ProcessId, [int]$Seconds) {
    if ($Seconds -lt 1 -or $Seconds -gt 2) { throw 'Invalid observation timeout' }
    $entries = @(Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ProcessId) -OperationTimeoutSec $Seconds -ErrorAction Stop)
    if ($entries.Count -ne 1) { throw 'Process identity unavailable' }
    return $entries[0]
}
function Read-UninstallWorkerSample([int]$ProcessId, $Budget) {
    $remaining = Get-UninstallObservationRemaining $Budget
    # CIM accepts whole seconds. Never round up or start below its one-second minimum.
    # Reserve at most one second per call, with at most two seconds admitted across all workers.
    $seconds = [int][Math]::Min(1, [Math]::Min($Budget.QuerySeconds, [Math]::Floor($remaining / 1000)))
    if ($seconds -lt 1) { $Budget.Expired = $true; throw 'No query allowance remains' }
    $Budget.QuerySeconds -= $seconds
    $entry = Read-UninstallObservationProcess $ProcessId $seconds
    [void](Get-UninstallObservationRemaining $Budget)
    return $entry
}
function Assert-UninstallObservationPath([string]$Root, [string]$Path, $Budget) {
    $temporary = [IO.Path]::GetFullPath((Join-Path $Root 'process-temp')).TrimEnd('\')
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -ine $Path -or $full.StartsWith('\\') -or
        -not $full.StartsWith($temporary + '\', [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetExtension($full) -ine '.exe') { throw 'Worker path is not an ordinary owned executable' }
    # Recheck every ancestor, including the run root and its parents, before and after process reads.
    $cursor = $full
    while ($cursor) {
        [void](Get-UninstallObservationRemaining $Budget)
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -isnot [bool] -or
            ($cursor -ieq $full -and $item.PSIsContainer) -or ($cursor -ine $full -and -not $item.PSIsContainer)) {
            throw 'Worker path has a filesystem alias or wrong kind'
        }
        $parent = Split-Path $cursor -Parent
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    [void](Get-UninstallObservationRemaining $Budget)
}
# CIM CreationDate carries microseconds; Process.StartTime can carry another 100ns digit.
function Get-UninstallCreationIdentity($Value) {
    if ($Value -isnot [datetime]) { throw 'Creation time unavailable' }
    $ticks = $Value.ToUniversalTime().Ticks
    return ($ticks - ($ticks % 10))
}
function Assert-UninstallWorkerIdentity($Entry, $Process, [int]$LauncherId, [long]$LauncherStart, $LauncherEnd, [string]$Root, [string]$Executable, [long]$Created, $Budget) {
    [void](Get-UninstallObservationRemaining $Budget)
    if ($Entry.ProcessId -ne $Process.Id -or $Entry.ParentProcessId -ne $LauncherId -or
        (Get-UninstallCreationIdentity $Entry.CreationDate) -ne $Created -or
        $Created -lt $LauncherStart -or ($null -ne $LauncherEnd -and $Created -gt $LauncherEnd) -or
        $Entry.ExecutablePath -isnot [string] -or $Entry.ExecutablePath -ine $Executable) { throw 'Worker identity changed' }
    [void](Get-UninstallObservationRemaining $Budget)
    if ((Get-UninstallCreationIdentity $Process.StartTime) -ne $Created) { throw 'Worker incarnation changed' }
    [void](Get-UninstallObservationRemaining $Budget)
    $module = $Process.MainModule.FileName
    if ($module -isnot [string] -or $module -ine $Executable) { throw 'Worker module identity unavailable' }
    [void](Get-UninstallObservationRemaining $Budget)
    $exited = $Process.HasExited
    if ($exited -isnot [bool]) { throw 'Worker exit state unavailable' }
    $exitCode = $null
    if ($exited) {
        [void](Get-UninstallObservationRemaining $Budget)
        $exitCode = $Process.ExitCode
        if ($exitCode -isnot [int]) { throw 'Worker exit code unavailable' }
    }
    Assert-UninstallObservationPath $Root $Executable $Budget
    return [pscustomobject]@{ Exited = $exited; ExitCode = $exitCode }
}
function Get-UninstallWorkerObservation($Launcher, [object[]]$Snapshot, [string]$Root, [string]$Uninstaller) {
    $result = [ordered]@{ state = 'unknown'; category = 'launcher-identity-unavailable'; softAdmissionBudgetMs = 2000; admittedQuerySeconds = 0; candidateCount = 0; truncated = $false; workers = @() }
    $budget = @{ Clock = (New-UninstallObservationClock); QuerySeconds = 2; Expired = $false }
    try {
        [void](Get-UninstallObservationRemaining $budget)
        if ($null -eq $Launcher -or $Launcher.Id -isnot [int] -or $Launcher.Id -le 0 -or
            $Launcher.StartInfo.FileName -isnot [string] -or
            [IO.Path]::GetFullPath($Launcher.StartInfo.FileName) -ine [IO.Path]::GetFullPath($Uninstaller)) { return $result }
        $launcherId = $Launcher.Id
        [void](Get-UninstallObservationRemaining $budget)
        if ($Launcher.Handle -isnot [IntPtr] -or $Launcher.Handle -eq [IntPtr]::Zero) { return $result }
        [void](Get-UninstallObservationRemaining $budget)
        $launcherStart = Get-UninstallCreationIdentity $Launcher.StartTime
        [void](Get-UninstallObservationRemaining $budget)
        $launcherExited = $Launcher.HasExited
        if ($launcherExited -isnot [bool]) { return $result }
        [void](Get-UninstallObservationRemaining $budget)
        $launcherEnd = if ($launcherExited) { Get-UninstallCreationIdentity $Launcher.ExitTime } else { $null }
        if ($null -ne $launcherEnd -and $launcherEnd -lt $launcherStart) { return $result }
    } catch {
        if ($budget.Expired) { $result.category = 'soft-observation-budget' }
        return $result
    }
    $temporary = [IO.Path]::GetFullPath((Join-Path $Root 'process-temp')).TrimEnd('\') + '\'
    # Candidate discovery is not admission: parent or temporary-path matches must pass every check below.
    $candidates = @($Snapshot | Where-Object {
        $_.ParentProcessId -eq $launcherId -or ($_.ExecutablePath -is [string] -and $_.ExecutablePath.StartsWith($temporary, [StringComparison]::OrdinalIgnoreCase))
    })
    $result.candidateCount = $candidates.Count
    $result.truncated = $candidates.Count -gt 4
    $result.state = 'observed'
    $result.category = 'complete'
    foreach ($candidate in @($candidates | Select-Object -First 4)) {
        $worker = [ordered]@{ pid = $null; creationTimeUtc = $null; state = 'unknown'; category = 'identity-unavailable'; ownershipVerified = $null; elapsedMilliseconds = $null; exited = $null; exitCode = $null }
        $process = $null
        try {
            [void](Get-UninstallObservationRemaining $budget)
            if ($budget.QuerySeconds -lt 2) { $budget.Expired = $true; throw 'Insufficient query allowance for two identity observations' }
            if (($candidate.ProcessId -isnot [int] -and $candidate.ProcessId -isnot [uint32]) -or
                $candidate.ProcessId -le 0 -or $candidate.ProcessId -gt [int]::MaxValue) { continue }
            $worker.pid = [int]$candidate.ProcessId
            $worker.category = 'parent-or-creation-mismatch'
            $created = Get-UninstallCreationIdentity $candidate.CreationDate
            if ($candidate.ParentProcessId -ne $launcherId -or $created -lt $launcherStart -or
                ($null -ne $launcherEnd -and $created -gt $launcherEnd)) { continue }
            $worker.category = 'executable-ancestry-unavailable'
            if ($candidate.ExecutablePath -isnot [string]) { continue }
            $executable = $candidate.ExecutablePath
            Assert-UninstallObservationPath $Root $executable $budget
            $worker.category = 'process-identity-unavailable'
            [void](Get-UninstallObservationRemaining $budget)
            $process = Open-UninstallObservationProcess $worker.pid $budget
            [void](Get-UninstallObservationRemaining $budget)
            if ($null -eq $process -or $process.Id -ne $worker.pid -or $process.Handle -isnot [IntPtr] -or $process.Handle -eq [IntPtr]::Zero) { continue }
            $current = Read-UninstallWorkerSample $worker.pid $budget
            [void](Assert-UninstallWorkerIdentity $current $process $launcherId $launcherStart $launcherEnd $Root $executable $created $budget)
            # Hold the same process handle through the second independent incarnation/ancestry observation.
            $worker.category = 'post-observation-identity-unavailable'
            $current = Read-UninstallWorkerSample $worker.pid $budget
            $state = Assert-UninstallWorkerIdentity $current $process $launcherId $launcherStart $launcherEnd $Root $executable $created $budget
            $remaining = Get-UninstallObservationRemaining $budget
            $worker.creationTimeUtc = $candidate.CreationDate.ToUniversalTime().ToString('o')
            $worker.ownershipVerified = $true
            $worker.elapsedMilliseconds = 2000 - $remaining
            $worker.exited = $state.Exited
            $worker.exitCode = $state.ExitCode
            $worker.state = 'observed'
            $worker.category = 'identity-bound'
        } catch {
            # No raw exception or uncertain identity/state leaves enter retained evidence.
            if ($budget.Expired) { $worker.category = 'soft-observation-budget' }
        } finally {
            if ($null -ne $process) {
                try { $process.Dispose() }
                catch { $worker.state = 'unknown'; $worker.category = 'process-handle-dispose-failed' }
            }
            if ($worker.state -ne 'observed') {
                $worker.creationTimeUtc = $null; $worker.ownershipVerified = $null
                $worker.elapsedMilliseconds = $null; $worker.exited = $null; $worker.exitCode = $null
            }
            $result.workers += $worker
        }
    }
    $result.admittedQuerySeconds = 2 - $budget.QuerySeconds
    return $result
}
