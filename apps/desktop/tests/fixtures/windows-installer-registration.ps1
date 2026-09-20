# Read-only observations and pure validation; loading this fixture never opens the registry.
# app-builder-lib 26.15.3 derives APP_GUID from appId with UUIDv5 namespace 50e065bc-3134-11e6-9bab-38c9862bdaf3.
# https://github.com/electron-userland/electron-builder/blob/v26.15.3/packages/app-builder-lib/src/targets/nsis/NsisTarget.ts
# Baseline dsh-desktop-v0.1.6-alpha.1.cloga.2 and candidate retain the upstream registration macros:
# https://github.com/electron-userland/electron-builder/blob/v26.15.3/packages/app-builder-lib/templates/nsis/include/installer.nsh
# Match pinnedUpgradeSourceCommit: hash the original acquired bytes, not validated.json or a self-hash.
function Get-PinnedInstallerBaselineSource([string]$ManifestPath, [string]$ExpectedSha256, [string]$ExpectedTag) {
    if ($ExpectedSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Invalid pinned baseline manifest digest' }
    $file = Get-Item -LiteralPath $ManifestPath -Force
    if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Baseline manifest must be a regular file' }
    $bytes = [IO.File]::ReadAllBytes($ManifestPath)
    $algorithm = [Security.Cryptography.SHA256]::Create()
    try { $digest = [BitConverter]::ToString($algorithm.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
    finally { $algorithm.Dispose() }
    if ($digest -cne $ExpectedSha256) { throw 'Baseline manifest bytes differ from the reviewed digest' }
    $manifest = [Text.Encoding]::UTF8.GetString($bytes) | ConvertFrom-Json
    if ($manifest.source.repository -cne 'cloga/deepseek-harness' -or $manifest.source.tag -cne $ExpectedTag -or
        $manifest.source.commit -cnotmatch '^[a-f0-9]{40}$') { throw 'Pinned baseline source identity differs' }
    return $manifest.source.commit
}

# Recheck the root and every physical ancestor before reading installed bytes or launching cleanup.
function Assert-InstallerOwnedPath([string]$Root, [string]$Path) {
    $owner = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $target = [IO.Path]::GetFullPath($Path)
    if (-not $target.StartsWith($owner + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Installed path must be a strict owned descendant' }
    $ancestry = [Collections.Generic.Stack[string]]::new()
    $cursor = $target
    while ($cursor) {
        $ancestry.Push($cursor)
        $parent = Split-Path $cursor -Parent
        if ($parent -eq $cursor) { break }
        $cursor = $parent
    }
    foreach ($cursor in $ancestry) {
        $item = Get-Item -LiteralPath $cursor -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
            ($cursor -ine $target -and -not $item.PSIsContainer)) { throw 'Registered installation contains a filesystem alias or non-directory ancestor' }
    }
}

function New-InstallerRegistrationIdentity($Release, [string]$ExpectedSource) {
    $manifest = $Release.manifest
    if ($ExpectedSource -cnotmatch '^[a-f0-9]{40}$' -or $manifest.source.commit -cne $ExpectedSource -or
        $manifest.source.repository -cne 'cloga/deepseek-harness' -or
        $manifest.identity.appId -cne 'io.github.cloga.deepseek-harness.desktop' -or
        $manifest.identity.productName -cne 'DeepSeek Harness (cloga)' -or
        $manifest.identity.packageName -cne 'cloga-deepseek-harness-desktop' -or
        $manifest.identity.executableName -cne 'cloga-deepseek-harness' -or
        $manifest.version -cnotmatch '^\d+\.\d+\.\d+-[a-z0-9.]+\.cloga\.\d+$' -or
        $manifest.installedEvidence.executableSha256 -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Registration identity is not bound to the verified release source and product'
    }
    [pscustomobject]@{
        Id = 'e82f4b7a-f955-53af-bd9b-031d4e7ad569'; Source = $ExpectedSource
        Version = $manifest.version; DisplayName = 'DeepSeek Harness (cloga) ' + $manifest.version
        ExecutableSha256 = $manifest.installedEvidence.executableSha256
    }
}

function Get-InstallerRegistrationEntries {
    $id = 'e82f4b7a-f955-53af-bd9b-031d4e7ad569'
    $ownerPath = 'Software\' + $id
    $uninstallPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $id
    foreach ($hive in @('CurrentUser', 'LocalMachine')) {
        foreach ($view in @('Registry64', 'Registry32')) {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]$hive, [Microsoft.Win32.RegistryView]$view)
            try {
                $owner = $base.OpenSubKey($ownerPath, $false)
                try {
                    $uninstall = $base.OpenSubKey($uninstallPath, $false)
                    try {
                        if ($null -eq $owner -and $null -eq $uninstall) { continue }
                        $entry = [ordered]@{
                            Id = $id; Hive = $hive; View = $view; OwnerKey = $ownerPath; Key = $uninstallPath
                            OwnerPresent = ($null -ne $owner); UninstallPresent = ($null -ne $uninstall)
                            InstallLocation = $null; DisplayName = $null; DisplayVersion = $null
                            UninstallString = $null; QuietUninstallString = $null
                        }
                        if ($null -ne $owner) {
                            $entry.InstallLocation = $owner.GetValue('InstallLocation', $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                        }
                        if ($null -ne $uninstall) {
                            foreach ($name in @('DisplayName', 'DisplayVersion', 'UninstallString', 'QuietUninstallString')) {
                                $entry[$name] = $uninstall.GetValue($name, $null, [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
                            }
                        }
                        [pscustomobject]$entry
                    } finally { if ($null -ne $uninstall) { $uninstall.Dispose() } }
                } finally { if ($null -ne $owner) { $owner.Dispose() } }
            } finally { $base.Dispose() }
        }
    }
}

# Only the exact product keys are observed. A shared HKCU key can appear through both views;
# accept its identical alias, never an extra machine install, partial key pair, or conflicting view.
# https://learn.microsoft.com/en-us/windows/win32/winprog64/shared-registry-keys
function Resolve-InstallerRegistration([object[]]$Entries, [object[]]$Identities, [string]$InstallPath) {
    $id = 'e82f4b7a-f955-53af-bd9b-031d4e7ad569'
    $ownerPath = 'Software\' + $id
    $uninstallPath = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\' + $id
    if ($Entries.Count -lt 1 -or $Entries.Count -gt 2 -or $Identities.Count -lt 1 -or $Identities.Count -gt 2) {
        throw 'Registration requires one exact current-user installation and verified release identities'
    }
    $primary = @($Entries | Where-Object { $_.Hive -ceq 'CurrentUser' -and $_.View -ceq 'Registry64' })
    if ($primary.Count -ne 1) { throw 'Registration requires the production 64-bit registry view' }
    $seen = @{}
    foreach ($entry in $Entries) {
        if ($entry.Id -cne $id -or $entry.OwnerKey -cne $ownerPath -or $entry.Key -cne $uninstallPath -or
            $entry.Hive -cne 'CurrentUser' -or $entry.View -cnotin @('Registry64', 'Registry32') -or $seen.ContainsKey($entry.View) -or
            $entry.OwnerPresent -isnot [bool] -or -not $entry.OwnerPresent -or
            $entry.UninstallPresent -isnot [bool] -or -not $entry.UninstallPresent) {
            throw 'Foreign, duplicate, or incomplete production registration'
        }
        $seen[$entry.View] = $true
        foreach ($field in @('InstallLocation', 'DisplayName', 'DisplayVersion', 'UninstallString', 'QuietUninstallString')) {
            if ($entry.$field -isnot [string] -or $entry.$field -cne $primary[0].$field) { throw "Conflicting registration field: $field" }
        }
        if ($entry.InstallLocation -cne $InstallPath) { throw 'Registration path is not the exact owned installation' }
        $matches = @($Identities | Where-Object { $_.Id -ceq $id -and $_.Version -ceq $entry.DisplayVersion -and $_.DisplayName -ceq $entry.DisplayName })
        if ($matches.Count -ne 1) { throw 'Registration name/version is not an expected verified release' }
        $command = '"' + (Join-Path $InstallPath 'Uninstall DeepSeek Harness (cloga).exe') + '" /currentuser'
        if ($entry.UninstallString -cne $command -or $entry.QuietUninstallString -cne ($command + ' /S')) {
            throw 'Registration uninstall commands do not bind the exact owned executable and mode'
        }
    }
    [pscustomobject]@{
        Key = 'HKCU:\' + $uninstallPath; OwnerKey = 'HKCU:\' + $ownerPath; Id = $id
        InstallLocation = $InstallPath; Version = $matches[0].Version; Source = $matches[0].Source
        ExecutableSha256 = $matches[0].ExecutableSha256
    }
}
