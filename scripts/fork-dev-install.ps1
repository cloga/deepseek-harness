param(
  [string]$Prefix = "$HOME\.dsh\fork-cli",
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

if (-not $SkipBuild) {
  & pnpm run clean
  if ($LASTEXITCODE -ne 0) { throw "pnpm run clean failed with exit code $LASTEXITCODE" }
  & pnpm run build:official
  if ($LASTEXITCODE -ne 0) { throw "pnpm run build:official failed with exit code $LASTEXITCODE" }
}

$commit = (& git rev-parse HEAD).Trim()
$version = (& node -p "require('./apps/cli/package.json').version").Trim()
$prefixPath = [System.IO.Path]::GetFullPath($Prefix)
New-Item -ItemType Directory -Force -Path $prefixPath | Out-Null
$shim = Join-Path $prefixPath 'dsh.cmd'
$bin = Join-Path $root 'apps\cli\lib\bin.js'
$shimContent = "@ECHO off`r`nnode `"$bin`" %*`r`n"
Set-Content -Encoding ASCII -NoNewline -Path $shim -Value $shimContent

$receipt = [ordered]@{
  schemaVersion = 1
  mode = 'checkout'
  repositoryPath = $root
  repositoryUrl = (& git config --get remote.origin.url).Trim()
  commitSha = $commit
  packageVersion = $version
  cliPath = $shim
  builtAt = (Get-Date).ToUniversalTime().ToString('o')
}
$receipt | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $prefixPath 'dsh-checkout-install.json')

Write-Output "DSH checkout install ready"
Write-Output "version=$version"
Write-Output "commit=$commit"
Write-Output "cliPath=$shim"
Write-Output "Set DSH_CLI_PATH to this cliPath before starting Desktop."
