# Failure-only control of the exact retained baseline monitor. No process lookup or success request.
function New-BaselineAbortClock { [Diagnostics.Stopwatch]::StartNew() }
function Request-OwnedBaselineAbort($Monitor, $Binding, $OwnedProcesses, $Errors) {
    $budget = [pscustomobject]@{ Process = $Monitor; Clock = (New-BaselineAbortClock); Requested = $false; Required = $true
        MonitorId = $null; MonitorCreated = $null; Terminal = $null }
    $temporary = $null; $stream = $null; $published = $null; $memory = $null; $created = $false; $stage = 'monitor-binding'
    try {
        if ($null -eq $Monitor -or $null -eq $Binding -or
            -not [object]::ReferenceEquals($Monitor, $Binding.Process) -or
            @($OwnedProcesses | Where-Object { [object]::ReferenceEquals($_, $Monitor) }).Count -ne 1 -or
            $Monitor.Id -ne $Binding.Id -or $Monitor.StartTime -isnot [datetime] -or
            $Monitor.StartTime.ToUniversalTime().Ticks -ne $Binding.Created -or
            $Monitor.HasExited -isnot [bool]) { throw 'Baseline monitor ownership is unavailable' }
        $budget.MonitorId = $Binding.Id; $budget.MonitorCreated = $Binding.Created
        if ($Monitor.HasExited) { $budget.Required = $false; return $budget }
        $stage = 'owner-binding'
        Assert-UninstallOwner
        $stage = 'control-path'
        $request = Join-Path $root 'baseline-abort-request.json'
        $ack = Join-Path $root 'baseline-abort-ack.json'
        # The strict installed-path reader requires an existing leaf. The owner marker
        # already checks every existing ancestor; these new leaves must stay direct children.
        foreach ($destination in @($request, $ack)) {
            if ([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($destination)) -ine [IO.Path]::GetFullPath($root).TrimEnd('\')) {
                throw 'Abort control escaped the owned root'
            }
        }
        if ((Test-Path -LiteralPath $request) -or (Test-Path -LiteralPath $ack)) { throw 'Abort control must be new' }
        if ($budget.Clock.ElapsedMilliseconds -ge 10000) { throw 'Baseline cleanup budget expired before abort request' }
        $temporary = Join-Path $root ('.baseline-abort-' + [guid]::NewGuid().ToString() + '.tmp')
        $bytes = [Text.Encoding]::UTF8.GetBytes(([ordered]@{ schemaVersion = 1; ownerToken = $token
            runId = $env:GITHUB_RUN_ID; runAttempt = $env:GITHUB_RUN_ATTEMPT
            sourceCommit = $ExpectedSourceCommit; phase = 'baseline-refusal' } | ConvertTo-Json -Compress))
        $stage = 'staging-write'
        $stream = [IO.File]::Open($temporary, 'CreateNew', 'Write', 'None')
        $created = $true
        $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true); $stream.Dispose(); $stream = $null
        Assert-UninstallOwner
        if ($budget.Clock.ElapsedMilliseconds -ge 10000) { throw 'Baseline cleanup budget expired while writing abort request' }
        $stage = 'atomic-publish'
        [IO.File]::Move($temporary, $request)
        $created = $false
        $stage = 'published-control-verification'
        Assert-InstallerOwnedPath $root $request
        $published = [IO.File]::Open($request, 'Open', 'Read', 'Read')
        Assert-InstallerOwnedPath $root $request
        if ($published.Length -ne $bytes.Length) { throw 'Published control size changed' }
        $memory = [IO.MemoryStream]::new()
        $published.CopyTo($memory)
        if ([Convert]::ToBase64String($memory.ToArray()) -cne [Convert]::ToBase64String($bytes)) { throw 'Published control bytes changed' }
        Assert-UninstallOwner
        if ($budget.Clock.ElapsedMilliseconds -ge 10000) { throw 'Baseline cleanup budget expired while verifying control' }
        $budget.Requested = $true
    } catch { $Errors.Add('Baseline abort request unavailable: ' + $stage) }
    finally {
        foreach ($reader in @($memory, $published)) { if ($null -ne $reader) { try { $reader.Dispose() } catch { $Errors.Add('Baseline abort verification close failed') } } }
        if ($null -ne $stream) { try { $stream.Dispose() } catch { $Errors.Add('Baseline abort staging close failed') } }
        if ($created) { try { [IO.File]::Delete($temporary) } catch { $Errors.Add('Baseline abort staging removal failed') } }
    }
    return $budget
}
function Confirm-OwnedBaselineAbort($Budget, $Errors) {
    if ($null -eq $Budget -or -not $Budget.Required) { return $true }
    try {
        if (-not $Budget.Requested -or $Budget.Clock.ElapsedMilliseconds -ge 10000 -or
            $Budget.Process.Id -ne $Budget.MonitorId -or $Budget.Process.StartTime -isnot [datetime] -or
            $Budget.Process.StartTime.ToUniversalTime().Ticks -ne $Budget.MonitorCreated -or
            $Budget.Process.HasExited -isnot [bool] -or -not $Budget.Process.HasExited -or $Budget.Process.ExitCode -ne 1) {
            throw 'Baseline abort exit was not acknowledged within cleanup budget'
        }
        Assert-UninstallOwner
        $ackPath = Join-Path $root 'baseline-abort-ack.json'
        Assert-InstallerOwnedPath $root $ackPath
        $info = Get-Item -LiteralPath $ackPath -Force -ErrorAction Stop
        if ($info.PSIsContainer -or $info.Length -gt 2048) { throw 'Invalid baseline abort acknowledgement' }
        $ack = Get-Content -LiteralPath $ackPath -Raw | ConvertFrom-Json
        if ($ack.schemaVersion -ne 1 -or $ack.ownerToken -cne $token -or
            $ack.runId -cne $env:GITHUB_RUN_ID -or $ack.runAttempt -cne $env:GITHUB_RUN_ATTEMPT -or
            $ack.sourceCommit -cne $ExpectedSourceCommit -or $ack.phase -cne 'baseline-refusal' -or
            $ack.appCloseResolved -isnot [bool] -or -not $ack.appCloseResolved -or
            $ack.failed -isnot [bool] -or -not $ack.failed -or $Budget.Clock.ElapsedMilliseconds -ge 10000) {
            throw 'Unbound baseline abort acknowledgement'
        }
        # Cache only the timely, exact-incarnation terminal result after validating the owned ACK.
        # Later unrelated cleanup cannot retroactively expire that completed observation.
        $Budget.Terminal = [pscustomobject]@{ Process = $Budget.Process; Id = $Budget.MonitorId
            Created = $Budget.MonitorCreated; Acknowledged = $true }
        return $true
    } catch { $Errors.Add('Baseline abort close acknowledgement unavailable'); return $false }
}
