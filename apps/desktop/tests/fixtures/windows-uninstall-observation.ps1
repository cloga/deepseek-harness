# Failure-only observations of the already retained direct copied-worker handle.
# No PID discovery, process adoption, CIM or window APIs. Local reads are not cancellable;
# the two-second budget is a soft admission limit, never a replacement for execution/removal gates.
function New-UninstallObservationClock { [Diagnostics.Stopwatch]::StartNew() }
function Get-UninstallObservationRemaining($Budget) {
    $elapsed = $Budget.Clock.ElapsedMilliseconds
    if (($elapsed -isnot [long] -and $elapsed -isnot [int]) -or $elapsed -lt 0 -or $elapsed -ge 2000) {
        $Budget.Expired = $true
        throw 'Soft observation budget exhausted or unavailable'
    }
    return [int](2000 - $elapsed)
}
function Assert-UninstallObservationPath([string]$Root, [string]$Path, $Budget) {
    $temporary = [IO.Path]::GetFullPath((Join-Path $Root 'process-temp')).TrimEnd('\')
    $full = [IO.Path]::GetFullPath($Path)
    if ($full -ine $Path -or $full.StartsWith('\\') -or
        -not $full.StartsWith($temporary + '\', [StringComparison]::OrdinalIgnoreCase) -or
        [IO.Path]::GetExtension($full) -ine '.exe') { throw 'Copy path is not an ordinary owned executable' }
    $cursor = $full
    while ($cursor) {
        [void](Get-UninstallObservationRemaining $Budget)
        $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.PSIsContainer -isnot [bool] -or
            ($cursor -ieq $full -and $item.PSIsContainer) -or ($cursor -ine $full -and -not $item.PSIsContainer)) {
            throw 'Copy path has a filesystem alias or wrong kind'
        }
        $parent = Split-Path $cursor -Parent
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    [void](Get-UninstallObservationRemaining $Budget)
}
function Assert-UninstallCopyObservation($Copy, [string]$Root, [string]$Target, $Budget) {
    [void](Get-UninstallObservationRemaining $Budget)
    if ($null -eq $Copy -or $Copy.Path -isnot [string] -or $Copy.Target -cne $Target -or
        $Copy.InsideOwnedTemporaryRoot -isnot [bool] -or -not $Copy.InsideOwnedTemporaryRoot -or
        $Copy.OutsideInstallation -isnot [bool] -or -not $Copy.OutsideInstallation -or
        $Copy.Path.StartsWith($Target + '\', [StringComparison]::OrdinalIgnoreCase) -or
        $Copy.Sha256 -isnot [string] -or $Copy.Sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $Copy.Sha256 -cne $Copy.SourceBeforeSha256 -or $Copy.Sha256 -cne $Copy.SourceAfterSha256) {
        throw 'Copy descriptor is not the verified execution source'
    }
    Assert-UninstallObservationPath $Root $Copy.Path $Budget
    [void](Get-UninstallObservationRemaining $Budget)
    if ($null -eq $Copy.Guard -or $Copy.Guard.CanRead -isnot [bool] -or -not $Copy.Guard.CanRead -or
        $Copy.Guard.Name -isnot [string] -or $Copy.Guard.Name -ine $Copy.Path) { throw 'Copy read guard is unavailable' }
    if ((Get-UninstallStreamSha256 $Copy.Guard) -cne $Copy.Sha256) { throw 'Copy bytes changed' }
    [void](Get-UninstallObservationRemaining $Budget)
}
function Read-OwnedUninstallProcessState($Process, [string]$Path, [string]$Target, [int]$Identity, [long]$Created, [IntPtr]$Handle, $Budget) {
    [void](Get-UninstallObservationRemaining $Budget)
    if ($Process.Id -ne $Identity -or $Process.Handle -ne $Handle -or $Process.StartTime -isnot [datetime] -or
        $Process.StartTime.ToUniversalTime().Ticks -ne $Created -or $Process.StartInfo.FileName -isnot [string] -or
        $Process.StartInfo.FileName -ine $Path -or $Process.StartInfo.Arguments -cne ('/currentuser /S _?=' + $Target)) {
        throw 'Retained execution identity changed'
    }
    [void](Get-UninstallObservationRemaining $Budget)
    $exited = $Process.HasExited
    if ($exited -isnot [bool]) { throw 'Execution state unavailable' }
    $exitCode = $null
    if ($exited) {
        [void](Get-UninstallObservationRemaining $Budget)
        $exitCode = $Process.ExitCode
        if ($exitCode -isnot [int]) { throw 'Execution exit code unavailable' }
    } else {
        [void](Get-UninstallObservationRemaining $Budget)
        $module = $Process.MainModule.FileName
        if ($module -isnot [string] -or $module -ine $Path) { throw 'Running image differs from the guarded copy' }
    }
    [void](Get-UninstallObservationRemaining $Budget)
    return [pscustomobject]@{ Exited = $exited; ExitCode = $exitCode }
}
function Get-OwnedUninstallerObservation($Process, $Copy, [string]$Root, [string]$Target) {
    $result = [ordered]@{ state = 'unknown'; category = 'copy-or-process-unavailable'; softAdmissionBudgetMs = 2000
        pid = $null; creationTimeUtc = $null; ownershipVerified = $null; elapsedMilliseconds = $null; exited = $null; exitCode = $null }
    $budget = @{ Clock = (New-UninstallObservationClock); Expired = $false }
    try {
        Assert-UninstallCopyObservation $Copy $Root $Target $budget
        [void](Get-UninstallObservationRemaining $budget)
        if ($null -eq $Process -or $Process.Id -isnot [int] -or $Process.Id -le 0 -or
            $Process.Handle -isnot [IntPtr] -or $Process.Handle -eq [IntPtr]::Zero -or $Process.StartTime -isnot [datetime]) { return $result }
        $identity = $Process.Id; $handle = $Process.Handle; $started = $Process.StartTime
        $created = $started.ToUniversalTime().Ticks
        [void](Read-OwnedUninstallProcessState $Process $Copy.Path $Target $identity $created $handle $budget)
        Assert-UninstallCopyObservation $Copy $Root $Target $budget
        $state = Read-OwnedUninstallProcessState $Process $Copy.Path $Target $identity $created $handle $budget
        Assert-UninstallObservationPath $Root $Copy.Path $budget
        $remaining = Get-UninstallObservationRemaining $budget
        $result.pid = $identity; $result.creationTimeUtc = $started.ToUniversalTime().ToString('o')
        $result.ownershipVerified = $true; $result.elapsedMilliseconds = 2000 - $remaining
        $result.exited = $state.Exited; $result.exitCode = $state.ExitCode
        $result.state = 'observed'; $result.category = 'retained-copy-identity-bound'
    } catch {
        # The caller owns both handles; never dispose, wait, kill or adopt a process here.
        $result.category = if ($budget.Expired) { 'soft-observation-budget' } else { 'identity-or-copy-unavailable' }
    }
    return $result
}
