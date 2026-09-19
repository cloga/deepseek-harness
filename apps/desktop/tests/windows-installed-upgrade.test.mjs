/** Unit coverage of runner-only acceptance guards; never starts an application or installer. */
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
    for (const member of ['Initialize', 'Find', 'FindText', 'FindButton', 'Progress', 'Save', 'SaveWithShadow', 'SendMessage']) {
      assert.ok(observed.members.includes(member), `Actual helper is missing ${member}`)
    }
    t.diagnostic(`Compilation only: PowerShell ${observed.edition} ${observed.version}`)
  })
}

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
  const install = source.split('function Start-Installer')[1].split('function Finish-Installer')[0]
  assert.ok(install.includes("$arguments = '/THEME=light'"))
  assert.ok(install.includes("$arguments += ' /D=' + $installPath"))
  assert.doesNotMatch(install, /\/S|--updated|RunAs|ExecutionPolicy/)
  assert.ok(source.includes("throw 'Installer unexpectedly launched the product'"))
  assert.ok(source.includes('draftAttachmentRefusalVerified = $false'))
  assert.ok(source.includes('pluginUserChoicesVerified = $false'))
  assert.ok(source.includes('managedHandoffVerified = $false'))
})

test('cleanup admission precedes Finish and rechecks actual registration before uninstalling', () => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\$installed\b/)
  assert.ok(source.indexOf('$installationAttempted = $true') < source.indexOf('Finish-Installer (Start-Installer $validated.previous'))
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
