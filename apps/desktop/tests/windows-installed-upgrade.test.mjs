/** Static/unit guards and isolated synthetic Win32 captures; never starts an application or installer. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import { inspectInstalledDesktopIdentity, installedDesktopProcessIds, installedLauncherExited, readInstalledDesktopRuntimeDescriptor } from './fixtures/windows-installed-runtime.mjs'
import { inspectInstalledPageDiagnostic } from './fixtures/windows-installed-upgrade-smoke.mjs'
import { assertUpgradeRunner, ownedUpgradePath, pinnedUpgradeSourceCommit, upgradeAssetPath, upgradeFileHash, verifyUpgradeRelease } from './fixtures/windows-installed-upgrade-contract.mjs'
import { retainPrimaryFailure } from './fixtures/windows-packaged-package-acceptance.mjs'

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

test('running-app refusal uses validated acknowledgment before its unchanged exit and preservation checks', () => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const refusal = source.slice(source.indexOf('    $refused = Start-Installer'), source.indexOf("    @{ ownerToken = $token } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'baseline-finish-request.json')"))
  const steps = [
    '$prompt = Wait-Control $refused $copy.INSTALLER_RUNNING -Seconds 600 -Dialog',
    '$okay = [InstallerCapture]::RequireAcknowledgment($refused.Id, $prompt, $copy.INSTALLER_RUNNING)',
    '[InstallerCapture]::Click($okay)',
    'Wait-Exit $refused 30 2',
    'if ($live.HasExited -or (Installation-Inventory) -ne $before -or (Read-Registration @($baselineIdentity)).Key -ne $registration.Key)',
    'Assert-NoTransactionDirectories',
  ]
  let previous = -1
  for (const step of steps) {
    const index = refusal.indexOf(step)
    assert.ok(index > previous, `Missing or reordered refusal step: ${step}`)
    previous = index
  }
  assert.doesNotMatch(refusal, /GetDlgItem/u)
})

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

test('installed identity callback serializes without an import loader or lexical closure', () => {
  const calls = []
  const identity = runInNewContext(`(${inspectInstalledDesktopIdentity.toString()})(electron)`, {
    process: Object.freeze({ pid: 303, ppid: 202, execPath: 'owned application', resourcesPath: 'owned resources' }),
    electron: { app: {
      getPath(name) { calls.push(name); return 'isolated user data' },
      getVersion() { return 'synthetic version' }, isPackaged: true,
    } },
  })
  assert.deepEqual(JSON.parse(JSON.stringify(identity)), {
    pid: 303, parentPid: 202, executable: 'owned application', resourcesPath: 'owned resources', userData: 'isolated user data', version: 'synthetic version', packaged: true,
  })
  assert.deepEqual(calls, ['userData'])
  assert.deepEqual(installedDesktopProcessIds({ pid: 202 }, identity, 101), { pid: 303, launcherPid: 202 })
  for (const invalid of [{ pid: 0, ppid: 202 }, { pid: 1.5, ppid: 202 }, { pid: 303, ppid: 0 }, { pid: 303, ppid: 303 }]) {
    assert.throws(() => runInNewContext(`(${inspectInstalledDesktopIdentity.toString()})({app:{}})`, { process: invalid }), /process identity is invalid/u)
  }
})

test('installed PID routing preserves distinct launch transport and Electron main authority', () => {
  assert.deepEqual(installedDesktopProcessIds({ pid: 202 }, { pid: 303, parentPid: 202 }, 101), { pid: 303, launcherPid: 202 })
  assert.deepEqual(installedDesktopProcessIds({ pid: 303 }, { pid: 303, parentPid: 101 }, 101), { pid: 303, launcherPid: 303 })
  for (const [launcher, identity, fixture] of [
    [{ pid: 202 }, { pid: 303, parentPid: 999 }, 101],
    [{ pid: 303 }, { pid: 303, parentPid: 202 }, 101],
    [{ pid: 101 }, { pid: 303, parentPid: 101 }, 101],
    [{ pid: 202 }, { pid: 101, parentPid: 202 }, 101],
    [{ pid: 0 }, { pid: 303, parentPid: 202 }, 101],
    [{ pid: 202 }, { pid: Number.MAX_SAFE_INTEGER + 1, parentPid: 202 }, 101],
  ]) assert.throws(() => installedDesktopProcessIds(launcher, identity, fixture))
  assert.equal(installedLauncherExited({ exitCode: null, signalCode: null }), false)
  assert.equal(installedLauncherExited({ exitCode: 0, signalCode: null }), true)
  assert.equal(installedLauncherExited({ exitCode: null, signalCode: 'SIGTERM' }), true)
  assert.equal(installedLauncherExited({}), false)
  const observer = readFileSync(new URL('./fixtures/windows-installed-upgrade-smoke.mjs', import.meta.url), 'utf8')
  assert.ok(observer.includes('const processIds = installedDesktopProcessIds(launcher, identity, process.pid)'))
  assert.ok(observer.includes("save(join(root, 'baseline-ready.json'), { ownerToken: owner.token, ...processIds, application })"))
  assert.doesNotMatch(observer, /pid: app\.process\(\)\.pid/u)
})

function observeInstalledPage(options = {}) {
  const main = options.main === false ? null : {
    hasAttribute(name) { return name === 'aria-busy' && options.ariaBusy !== undefined },
    getAttribute() { return options.ariaBusy },
  }
  const error = options.error === false ? null : {
    hidden: options.hidden ?? false,
    textContent: options.text ?? '',
    getBoundingClientRect() { return { width: options.width ?? 10, height: options.height ?? 5 } },
    getClientRects() { return { length: options.rects ?? 1 } },
  }
  return JSON.parse(JSON.stringify(runInNewContext(`(${inspectInstalledPageDiagnostic.toString()})()`, {
    URL,
    location: { href: options.url ?? 'dsh-app://shell/startup.html' },
    document: {
      readyState: options.readyState ?? 'complete',
      querySelector(selector) { return selector === 'main' ? main : selector === '#error' ? error : null },
    },
    getComputedStyle() { return { display: options.display ?? 'block', visibility: options.visibility ?? 'visible' } },
  })))
}

test('actual installed page diagnostic is source-safe and returns only bounded scalar observations', () => {
  const callback = inspectInstalledPageDiagnostic.toString()
  assert.doesNotMatch(callback, /__name|\bimport\s*\(|\brequire\s*\(/u)
  const observed = observeInstalledPage({ main: false, error: false, readyState: 'invented' })
  assert.deepEqual(observed, {
    url: 'dsh-app://shell/startup.html', urlRawBytes: 28, urlRedacted: false, urlTruncated: false, readyState: 'unknown',
    mainPresent: false, mainAriaBusyPresent: false, mainAriaBusyValue: null,
    errorPresent: false, errorHidden: null, errorDisplay: null, errorVisibility: null,
    errorWidth: null, errorHeight: null, errorClientRectCount: null, errorRendered: false,
    errorText: '', errorTextRawBytes: 0, errorTextRedacted: false, errorTextTruncated: false,
  })
  for (const value of Object.values(observed)) assert.ok(value === null || ['string', 'number', 'boolean'].includes(typeof value))
})

test('actual installed page diagnostic distinguishes hidden, CSS-hidden, visible and invalid boxes', () => {
  const hidden = observeInstalledPage({ hidden: true, text: '' })
  assert.equal(hidden.errorPresent, true)
  assert.equal(hidden.errorHidden, true)
  assert.equal(hidden.errorRendered, false)
  assert.equal(hidden.errorText, '')
  assert.equal(observeInstalledPage({ text: 'backend failed' }).errorRendered, true)
  assert.equal(observeInstalledPage({ display: 'none' }).errorRendered, false)
  assert.equal(observeInstalledPage({ visibility: 'hidden' }).errorRendered, false)
  const invalid = observeInstalledPage({ width: Number.POSITIVE_INFINITY, height: Number.NaN, rects: Number.POSITIVE_INFINITY })
  assert.equal(invalid.errorWidth, null)
  assert.equal(invalid.errorHeight, null)
  assert.equal(invalid.errorClientRectCount, null)
  assert.equal(invalid.errorRendered, false)
  const busy = observeInstalledPage({ ariaBusy: 'true' })
  assert.equal(busy.mainAriaBusyPresent, true)
  assert.equal(busy.mainAriaBusyValue, 'true')
})

test('actual installed page diagnostic redacts URL credentials and error secrets before byte-bounded retention', () => {
  const url = 'https://alice:secret@example.test/path?token=query-secret#password=fragment-secret'
  const text = 'Authorization: Bearer bearer-secret; "password" : "secret words"; api-key = key-secret; client secret: client-secret-value; github-token=ghp_1234567890; github_pat_abcdef_123456; fetch failed https://alice:secret@example.test/pkg?sig=signed-secret&code=oauth-secret#fragment-secret'
  const observed = observeInstalledPage({ url, text })
  assert.equal(observed.url, 'https://example.test/path')
  assert.equal(observed.urlRawBytes, Buffer.byteLength(url))
  assert.equal(observed.urlRedacted, true)
  assert.equal(observed.urlTruncated, false)
  assert.equal(observed.errorTextRawBytes, Buffer.byteLength(text))
  assert.equal(observed.errorTextRedacted, true)
  for (const secret of ['alice', 'query-secret', 'fragment-secret', 'signed-secret', 'oauth-secret', 'bearer-secret', 'secret words', 'key-secret', 'client-secret-value', 'ghp_1234567890', 'github_pat_abcdef_123456']) {
    assert.equal(observed.url.includes(secret) || observed.errorText.includes(secret), false, `Retained credential: ${secret}`)
  }
  assert.match(observed.errorText, /https:\/\/example\.test\/pkg\?\[redacted\]/u)
  assert.doesNotMatch(observed.errorText, /[?&](?:sig|code)=/u)
  assert.match(observed.errorText, /\[redacted\]/u)
})

test('actual installed page diagnostic truncates only at UTF-8 character boundaries', () => {
  const url = 'x'.repeat(2047) + '🙂'
  const text = '界'.repeat(2730) + '🙂'
  const observed = observeInstalledPage({ url, text })
  assert.equal(observed.urlRawBytes, 2051)
  assert.equal(Buffer.byteLength(observed.url), 2047)
  assert.equal(observed.urlTruncated, true)
  assert.equal(observed.errorTextRawBytes, 8194)
  assert.equal(Buffer.byteLength(observed.errorText), 8190)
  assert.equal(observed.errorText.endsWith('界'), true)
  assert.equal(observed.errorText.includes('\uFFFD'), false)
  assert.equal(observed.errorTextTruncated, true)
})

test('installed failure diagnostic is captured before close and retained without replacing the primary', () => {
  const source = readFileSync(new URL('./fixtures/windows-installed-upgrade-smoke.mjs', import.meta.url), 'utf8')
  const capture = source.indexOf('failureSnapshot = await page.evaluate(inspectInstalledPageDiagnostic)')
  const close = source.indexOf('try { await app?.close() }', capture)
  const receipt = source.indexOf('snapshot: failureSnapshot', close)
  assert.ok(capture >= 0 && close > capture && receipt > close)
  assert.match(source.slice(capture, close), /retainPrimaryFailure\(roundFailure, new Error\('DOM diagnostic capture failed'\), 'round-failure-dom-diagnostic', secondaryErrors\)/u)
  const primary = new Error('primary assertion')
  const secondary = []
  assert.equal(retainPrimaryFailure(primary, new Error('DOM diagnostic capture failed'), 'round-failure-dom-diagnostic', secondary), primary)
  assert.deepEqual(secondary, [{ stage: 'round-failure-dom-diagnostic', error: 'Error: DOM diagnostic capture failed' }])
})

test('installed descriptor reader binds fresh executable bytes and observed resources before inspection', t => {
  const root = directory(t)
  const application = join(root, 'cloga-deepseek-harness.exe')
  const resources = join(root, 'resources')
  const executable = 'synthetic bytes: never executed'
  writeFileSync(application, executable)
  mkdirSync(resources)
  const descriptor = Buffer.from('{\r\n  "files": [], "label": "运行时"\r\n}\r\n')
  const calls = []
  const read = (...args) => { calls.push(args); return descriptor }
  const result = readInstalledDesktopRuntimeDescriptor(application, resources, digest(executable), read)
  assert.equal(result, descriptor, 'Original Buffer must survive without UTF-8 conversion or JSON rewriting')
  assert.notEqual(digest(result), digest(JSON.stringify(JSON.parse(descriptor.toString('utf8')))))
  assert.deepEqual(calls, [[application, join(resources, 'app.asar', 'dsh')]])
  calls.length = 0
  assert.throws(() => readInstalledDesktopRuntimeDescriptor(application, join(root, 'foreign-resources'), digest(executable), read), /Running resources/u)
  writeFileSync(application, 'changed after app launch')
  assert.throws(() => readInstalledDesktopRuntimeDescriptor(application, resources, digest(executable), read), /executable changed/u)
  writeFileSync(application, executable)
  const failure = new Error('read-only carrier failed')
  assert.throws(() => readInstalledDesktopRuntimeDescriptor(application, resources, digest(executable), () => { throw failure }), error => error === failure)
  rmSync(resources, { recursive: true })
  const other = join(root, 'other-resources')
  mkdirSync(other)
  symlinkSync(other, resources, process.platform === 'win32' ? 'junction' : 'dir')
  assert.throws(() => readInstalledDesktopRuntimeDescriptor(application, resources, digest(executable), read), /link|alias/u)
  assert.equal(calls.length, 0, 'Invalid ownership or bytes must not start an inspection child')
})

for (const name of ['windows-installed-upgrade-smoke.mjs', 'windows-packaged-package-acceptance.mjs']) {
  test(`${name} uses one closure-free identity evaluation and an external raw descriptor read`, () => {
    const source = readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8')
    assert.equal(source.match(/app\.evaluate\(/gu)?.length, 1)
    assert.ok(source.includes('app.evaluate(inspectInstalledDesktopIdentity)'))
    assert.match(source, /readInstalledDesktopRuntimeDescriptor\(application, identity\.resourcesPath, expected(?:\.manifest)?\.installedEvidence\.executableSha256\)/u)
    assert.match(source, /assert.equal\(hash\(runtime(?:Bytes)?\), expected(?:\.manifest)?\.installedEvidence\.runtimeSha256\)/u)
    assert.doesNotMatch(source, /import\('node:(?:fs|path)/u)
    const predicate = source.match(/page\.waitForFunction\((.*), (?:expectedUrl|undefined), \{ timeout: 300_000 \}\)/u)?.[1]
    assert.ok(predicate, 'Audit the actual serialized renderer predicate, not a duplicated fixture')
    const expectedUrl = name === 'windows-installed-upgrade-smoke.mjs' ? 'dsh-app://app/index.html' : 'dsh-app://app/'
    const observe = (href, error) => runInNewContext(`(${predicate})(url)`, {
      url: expectedUrl, location: { href }, document: { querySelector: () => error === undefined ? null : { textContent: error } },
    })
    assert.equal(observe(expectedUrl), true)
    assert.equal(observe('loading', 'startup failure'), true)
    assert.equal(observe('loading'), false)
  })
}

test('installed baseline selects only its version-owned settings observer after identity verification', () => {
  const source = readFileSync(new URL('./fixtures/windows-installed-upgrade-smoke.mjs', import.meta.url), 'utf8')
  assert.ok(source.indexOf('assert.equal(upgradeFileHash(expected.manifestPath), expected.manifestFileSha256)') < source.indexOf('const inspectSettings'))
  assert.ok(source.includes("const inspectSettings = values.phase === 'baseline'\n    ? (await import('./baseline-copilot-settings-smoke.ts')).inspectBaselinePackagedCopilotSettings\n    : (await import('./copilot-settings-smoke.ts')).inspectPackagedCopilotSettings"))
  assert.ok(source.includes('await inspectSettings(settings)'))
})

function compileChildEvidence(result, elapsedMs, budgetMs) {
  const stderr = result.stderr ?? ''
  return {
    elapsedMs: Math.round(elapsedMs), budgetMs, pid: result.pid ?? null,
    errorCode: result.error?.code ?? null, errorMessage: result.error?.message?.slice(0, 512) ?? null,
    signal: result.signal, status: result.status,
    lastPhase: [...stderr.matchAll(/^\[fixture-phase:([a-z-]+)\]\r?$/gmu)].at(-1)?.[1] ?? 'no-script-marker-observed',
    stdoutTail: (result.stdout ?? '').slice(-2048), stderrTail: stderr.slice(-2048),
  }
}

function assertCompileChild(result, evidence) {
  const diagnostic = JSON.stringify(evidence)
  assert.equal(result.error, undefined, diagnostic)
  assert.equal(result.signal, null, diagnostic)
  assert.equal(result.status, 0, diagnostic)
}

test('compile child diagnostics retain timeout, signal, status and bounded phase evidence independently', () => {
  const timeout = { code: 'ETIMEDOUT', message: 'owned child exceeded its budget' }
  const result = { error: timeout, pid: 12, signal: null, status: 0, stdout: 'x'.repeat(10_000), stderr: '[fixture-phase:compile-start]\n' + 'y'.repeat(10_000) }
  const evidence = compileChildEvidence(result, 30_005, 30_000)
  assert.equal(evidence.lastPhase, 'compile-start')
  assert.equal(evidence.errorCode, 'ETIMEDOUT')
  assert.equal(evidence.status, 0)
  assert.equal(evidence.signal, null)
  assert.equal(evidence.stdoutTail.length, 2048)
  assert.equal(evidence.stderrTail.length, 2048)
  assert.throws(() => assertCompileChild(result, evidence), /ETIMEDOUT/u)
  const signalled = { signal: 'SIGTERM', status: null, stdout: '', stderr: '' }
  assert.equal(compileChildEvidence(signalled, 1, 10).lastPhase, 'no-script-marker-observed')
  assert.equal(compileChildEvidence({ stderr: 'parser echo: [fixture-phase:compile-start]' }, 1, 10).lastPhase, 'no-script-marker-observed')
  assert.throws(() => assertCompileChild(signalled, compileChildEvidence(signalled, 1, 10)), /SIGTERM/u)
  const assertionFailure = { signal: null, status: 1, stderr: '[fixture-phase:assertions-start]\nassertion failed' }
  assert.throws(() => assertCompileChild(assertionFailure, compileChildEvidence(assertionFailure, 1, 10)), /assertions-start/u)
})

for (const [edition, shell] of [
  ['Core', 'pwsh'],
  ['Desktop', join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
]) {
  test(`actual installer helper compiles in fresh PowerShell ${edition} without invoking native methods`, { skip: process.platform !== 'win32' }, t => {
    const helper = fileURLToPath(new URL('./windows-installer-ui.ps1', import.meta.url))
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::Error.WriteLine('[fixture-phase:script-start]')
[Console]::Error.WriteLine('[fixture-phase:compile-start]')
. $env:DSH_INSTALLER_UI_HELPER
[Console]::Error.WriteLine('[fixture-phase:compile-complete]')
[Console]::Error.WriteLine('[fixture-phase:assertions-start]')
$helperType = 'InstallerCapture' -as [type]
if ($null -eq $helperType) { throw 'InstallerCapture was not compiled' }
if ($null -ne $helperType.TypeInitializer) { throw 'InstallerCapture must not run a static initializer' }
$members = @($helperType.GetMethods([System.Reflection.BindingFlags]'Public,Static') | ForEach-Object { $_.Name } | Sort-Object -Unique)
. $env:DSH_INSTALLER_UI_HELPER
if (('InstallerCapture' -as [type]) -ne $helperType) { throw 'Repeated loading replaced the helper type' }
[pscustomobject]@{ edition = $PSVersionTable.PSEdition; version = $PSVersionTable.PSVersion.ToString(); members = $members } | ConvertTo-Json -Compress
[Console]::Error.WriteLine('[fixture-phase:script-complete]')
`
    const names = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PSMODULEPATH', 'PROGRAMFILES'])
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toUpperCase())))
    // Total fresh-process/Core Add-Type safeguard, not a native UI or performance deadline.
    // Hosted total guard expired at 10s without phase data; 30s remains below the existing 40s synthetic capture bound.
    const budgetMs = edition === 'Core' ? 30_000 : 10_000
    const started = performance.now()
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8', timeout: budgetMs, env: { ...environment, DSH_INSTALLER_UI_HELPER: helper },
    })
    const evidence = compileChildEvidence(result, performance.now() - started, budgetMs)
    assertCompileChild(result, evidence)
    assert.equal(evidence.lastPhase, 'script-complete', JSON.stringify(evidence))
    t.diagnostic(`Compile subprocess: ${JSON.stringify(evidence)}`)
    const observed = JSON.parse(result.stdout.trim())
    assert.equal(observed.edition, edition)
    for (const member of ['Initialize', 'Find', 'FindText', 'FindButton', 'Progress', 'Save', 'SaveStock', 'StockRun', 'RequireAcknowledgment', 'DiagnosticText', 'SaveWithShadow', 'SendMessage']) {
      assert.ok(observed.members.includes(member), `Actual helper is missing ${member}`)
    }
    t.diagnostic(`Compilation only: PowerShell ${observed.edition} ${observed.version}`)
  })

  test(`stock capture validates synthetic Win32 pages in PowerShell ${edition}`, { skip: process.platform !== 'win32' }, t => {
    const root = directory(t)
    const helper = fileURLToPath(new URL('./windows-installer-ui.ps1', import.meta.url))
    const script = `
$ErrorActionPreference = 'Stop'
. $env:DSH_INSTALLER_UI_HELPER
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StockCaptureFixture {
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr CreateWindowEx(uint exStyle, string kind, string title, uint style, int x, int y, int width, int height, IntPtr parent, IntPtr menu, IntPtr instance, IntPtr data);
    [DllImport("user32.dll")] public static extern bool DestroyWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool EnableWindow(IntPtr window, bool enabled);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr window, int command);
    [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr window);
    [DllImport("user32.dll")] static extern int GetWindowLong(IntPtr window, int index);
    [DllImport("user32.dll")] static extern int SetWindowLong(IntPtr window, int index, int value);
    public static void ButtonStyle(IntPtr window, int style) { SetWindowLong(window, -16, (GetWindowLong(window, -16) & ~15) | style); }
    public static IntPtr Create(string kind, string title, IntPtr parent, int id) {
        // Off-screen, no activation: PrintWindow captures only these owned windows.
        IntPtr window = CreateWindowEx(0x08000000, kind, title, parent == IntPtr.Zero ? 0x90000000u : 0x50000000u,
            parent == IntPtr.Zero ? -30000 : 10, parent == IntPtr.Zero ? -30000 : 10,
            320, 180, parent, (IntPtr)id, IntPtr.Zero, IntPtr.Zero);
        if (window == IntPtr.Zero) throw new InvalidOperationException("Cannot create synthetic window");
        return window;
    }
}
'@
[InstallerCapture]::ProductName = 'Synthetic stock capture ' + [guid]::NewGuid().ToString()
$rejected = [Collections.Generic.List[string]]::new()
function Reject-Capture([string]$Label, [scriptblock]$Action, [string]$Expected) {
    $failure = $null
    try { & $Action } catch { $failure = $_ }
    if ($null -eq $failure -or $failure.Exception.ToString() -notmatch $Expected) { throw "Missing expected rejection for "+$Label+": "+$failure }
    if (Test-Path -LiteralPath $bad) { throw "Rejected capture wrote a screenshot: $Label" }
    $rejected.Add($Label)
}
function Complete-Fixture($PrimaryFailure, [scriptblock[]]$Cleanup) {
    $failures = [Collections.Generic.List[Exception]]::new()
    if ($null -ne $PrimaryFailure) { $failures.Add($PrimaryFailure.Exception) }
    foreach ($cleanupAction in $Cleanup) {
        try { & $cleanupAction } catch { $failures.Add($_.Exception) }
    }
    if ($failures.Count) { throw [AggregateException]::new('Synthetic capture body/cleanup failed', $failures.ToArray()) }
}
# Pure negative controls exercise the same teardown path without leaking a real window.
try { throw 'synthetic primary failure' } catch { $originalFailure = $_ }
$cleanupTrace = [Collections.Generic.List[string]]::new()
$combinedFailure = $null
try {
    Complete-Fixture $originalFailure @(
        { $cleanupTrace.Add('destroy'); throw 'synthetic destruction failure' },
        { $cleanupTrace.Add('verify'); throw 'synthetic survivor failure' }
    )
} catch { $combinedFailure = $_.Exception }
if ($combinedFailure -isnot [AggregateException]) { throw 'Combined failure was not aggregated' }
$primaryOnly = $null
try { Complete-Fixture $originalFailure @({}) } catch { $primaryOnly = $_.Exception }
$cleanupOnly = $null
try { Complete-Fixture $null @({ throw 'synthetic cleanup-only failure' }) } catch { $cleanupOnly = $_.Exception }
$cleanupFailures = @{
    messages = @($combinedFailure.InnerExceptions | ForEach-Object { $_.Message })
    trace = @($cleanupTrace)
    originalRetained = [object]::ReferenceEquals($combinedFailure.InnerExceptions[0], $originalFailure.Exception)
    primaryOnly = @($primaryOnly.InnerExceptions | ForEach-Object { $_.Message })
    cleanupOnly = @($cleanupOnly.InnerExceptions | ForEach-Object { $_.Message })
}
$bad = Join-Path $env:DSH_STOCK_CAPTURE_ROOT 'rejected.png'
$primaryFailure = $null
$window = [StockCaptureFixture]::Create('#32770', [InstallerCapture]::ProductName, [IntPtr]::Zero, 0)
try {
    # NSIS page controls are nested under an inner dialog; Next/Finish is on the root.
    $page = [StockCaptureFixture]::Create('#32770', '', $window, 1018)
    $directory = [StockCaptureFixture]::Create('Edit', 'Synthetic path', $page, 1019)
    $action = [StockCaptureFixture]::Create('Button', 'Next', $window, 1)
    if ([InstallerCapture]::GetProp($window, 'HarnessInstaller.Ready') -ne [IntPtr]::Zero) { throw 'Synthetic stock window unexpectedly has native readiness' }
    $dimensions = [InstallerCapture]::SaveStock($PID, $window, 1019, (Join-Path $env:DSH_STOCK_CAPTURE_ROOT 'directory.png'))
    Reject-Capture 'foreign-pid' { [InstallerCapture]::SaveStock(($PID + 1), $window, 1019, $bad) } 'live owned installer dialog'
    Reject-Capture 'invalid-pid' { [InstallerCapture]::SaveStock(0, $window, 1019, $bad) } 'live owned installer dialog'
    Reject-Capture 'zero-window' { [InstallerCapture]::SaveStock($PID, [IntPtr]::Zero, 1019, $bad) } 'live owned installer dialog'
    Reject-Capture 'invalid-window' { [InstallerCapture]::SaveStock($PID, [IntPtr](-1), 1019, $bad) } 'live owned installer dialog'
    Reject-Capture 'child-window' { [InstallerCapture]::SaveStock($PID, $page, 1019, $bad) } 'live owned installer dialog'
    Reject-Capture 'unsupported-page' { [InstallerCapture]::SaveStock($PID, $window, 999, $bad) } 'Unsupported stock installer page'
    Reject-Capture 'absent-finish' { [InstallerCapture]::SaveStock($PID, $window, 1203, $bad) } 'control 1203'
    [void][StockCaptureFixture]::EnableWindow($directory, $false)
    Reject-Capture 'disabled-directory' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'control 1019'
    [void][StockCaptureFixture]::EnableWindow($directory, $true)
    [void][StockCaptureFixture]::ShowWindow($directory, 0)
    Reject-Capture 'hidden-directory' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'control 1019'
    [void][StockCaptureFixture]::ShowWindow($directory, 8)
    [void][StockCaptureFixture]::EnableWindow($action, $false)
    Reject-Capture 'disabled-action' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'control 1'
    [void][StockCaptureFixture]::EnableWindow($action, $true)
    [void][StockCaptureFixture]::EnableWindow($window, $false)
    Reject-Capture 'disabled-window' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'live owned installer dialog'
    [void][StockCaptureFixture]::EnableWindow($window, $true)
    [void][StockCaptureFixture]::ShowWindow($window, 0)
    Reject-Capture 'hidden-window' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'live owned installer dialog'
    [void][StockCaptureFixture]::ShowWindow($window, 8)
    [void][InstallerCapture]::SetWindowText($window, 'Wrong product')
    Reject-Capture 'wrong-title' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'live owned installer dialog'
    [void][InstallerCapture]::SetWindowText($window, [InstallerCapture]::ProductName)
    # The custom entry still times out instead of accepting this usable stock page.
    Reject-Capture 'custom-not-ready' { [InstallerCapture]::Save($window, $bad) } 'Native page did not finish creating controls'
    if (-not [StockCaptureFixture]::DestroyWindow($directory)) { throw 'Could not destroy directory control' }
    Reject-Capture 'stale-page' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'control 1019'
    # Model pinned MUI2 Finish.nsh creation order, not a hand-assigned Run ID.
    # nsDialogs.c (v304) resets controlCount=0 and CreateControl uses 1200+id.
    $finishControls = @()
    foreach ($caption in @('bitmap', 'title', 'text', ('&Run ' + [InstallerCapture]::ProductName))) {
        $kind = if ($finishControls.Count -eq 3) { 'Button' } else { 'Static' }
        $finishControls += [StockCaptureFixture]::Create($kind, $caption, $page, (1200 + $finishControls.Count))
    }
    $checkbox = $finishControls[3]
    $finishId = [StockCaptureFixture]::GetDlgCtrlID($checkbox)
    [StockCaptureFixture]::ButtonStyle($checkbox, 3)
    [void][InstallerCapture]::SetWindowText($action, '&Finish')
    if ([InstallerCapture]::StockRun($PID, $window) -ne $checkbox) { throw 'Run control identity differs' }
    [void][InstallerCapture]::SaveStock($PID, $window, $finishId, (Join-Path $env:DSH_STOCK_CAPTURE_ROOT 'finish.png'))
    Reject-Capture 'obsolete-finish-id' { [InstallerCapture]::SaveStock($PID, $window, 1204, $bad) } 'Unsupported stock installer page'
    [StockCaptureFixture]::ButtonStyle($checkbox, 9)
    Reject-Capture 'reboot-radio' { [InstallerCapture]::StockRun($PID, $window) } 'Run auto-checkbox'
    [StockCaptureFixture]::ButtonStyle($checkbox, 3)
    [void][InstallerCapture]::SetWindowText($checkbox, 'Reboot now')
    Reject-Capture 'wrong-run-caption' { [InstallerCapture]::StockRun($PID, $window) } 'Run auto-checkbox'
    [void][InstallerCapture]::SetWindowText($checkbox, ('&Run ' + [InstallerCapture]::ProductName))
    [void][InstallerCapture]::SetWindowText($action, '&Next')
    Reject-Capture 'wrong-finish-caption' { [InstallerCapture]::SaveStock($PID, $window, $finishId, $bad) } 'finish action caption'
    [void][InstallerCapture]::SetWindowText($action, '&Finish')
    [void][InstallerCapture]::SendMessage($checkbox, 0xF1, [IntPtr]1, [IntPtr]::Zero)
    $diagnostic = [InstallerCapture]::DiagnosticText($PID)
    if (-not [InstallerCapture]::IsWindow($checkbox) -or [InstallerCapture]::SendMessage($checkbox, 0xF0, [IntPtr]::Zero, [IntPtr]::Zero).ToInt32() -ne 1) { throw 'Observation mutated owned controls' }
    $foreignDiagnostic = [InstallerCapture]::DiagnosticText(($PID + 1))
    [void][StockCaptureFixture]::EnableWindow($checkbox, $false)
    Reject-Capture 'disabled-finish' { [InstallerCapture]::SaveStock($PID, $window, 1203, $bad) } 'control 1203'
    [void][StockCaptureFixture]::EnableWindow($checkbox, $true)
    if (-not [StockCaptureFixture]::DestroyWindow($action)) { throw 'Could not destroy action control' }
    Reject-Capture 'absent-action' { [InstallerCapture]::SaveStock($PID, $window, 1203, $bad) } 'control 1'
    $wrongAction = [StockCaptureFixture]::Create('Static', 'Not a button', $window, 1)
    Reject-Capture 'wrong-action-class' { [InstallerCapture]::SaveStock($PID, $window, 1203, $bad) } 'control 1'
    if (-not [StockCaptureFixture]::DestroyWindow($wrongAction)) { throw 'Could not destroy wrong action' }
    $action = [StockCaptureFixture]::Create('Button', 'Finish', $window, 1)
    if (-not [StockCaptureFixture]::DestroyWindow($checkbox)) { throw 'Could not destroy finish control' }
    $wrongPage = [StockCaptureFixture]::Create('Edit', 'Not a checkbox', $page, 1203)
    Reject-Capture 'wrong-page-class' { [InstallerCapture]::SaveStock($PID, $window, 1203, $bad) } 'control 1203'
    $extraControls = @()
    for ($index = 0; $index -lt 70; $index++) { $extraControls += [StockCaptureFixture]::Create('Static', 'bounded', $window, (2000 + $index)) }
    $limitedDiagnostic = [InstallerCapture]::DiagnosticText($PID)
} catch { $primaryFailure = $_ } finally {
    Complete-Fixture $primaryFailure @(
        { if (-not [StockCaptureFixture]::DestroyWindow($window)) { throw 'Could not destroy owned synthetic dialog' } },
        {
            $survivors = @((@($window, $page, $directory, $action, $checkbox, $wrongAction, $wrongPage) + @($finishControls) + @($extraControls)) |
                Where-Object { $_ -and [InstallerCapture]::IsWindow($_) })
            if ($survivors.Count) { throw ('Synthetic windows survived cleanup: ' + ($survivors -join ', ')) }
        }
    )
}
Reject-Capture 'stale-window' { [InstallerCapture]::SaveStock($PID, $window, 1019, $bad) } 'live owned installer dialog'
$primaryFailure = $null
$other = [StockCaptureFixture]::Create('Static', [InstallerCapture]::ProductName, [IntPtr]::Zero, 0)
try {
    Reject-Capture 'wrong-window-class' { [InstallerCapture]::SaveStock($PID, $other, 1019, $bad) } 'live owned installer dialog'
} catch { $primaryFailure = $_ } finally {
    Complete-Fixture $primaryFailure @(
        { if (-not [StockCaptureFixture]::DestroyWindow($other)) { throw 'Could not destroy wrong-class window' } },
        { if ([InstallerCapture]::IsWindow($other)) { throw 'Wrong-class window survived cleanup' } }
    )
}
# Exercise the actual selector on owned native controls, never an installer or application.
$ackWindows = [Collections.Generic.List[IntPtr]]::new()
$ackRoots = [Collections.Generic.List[IntPtr]]::new()
$ackRejected = [Collections.Generic.List[string]]::new()
function New-AckControl([string]$Kind, [string]$Text, [IntPtr]$Parent, [int]$Id) {
    $handle = [StockCaptureFixture]::Create($Kind, $Text, $Parent, $Id)
    $ackWindows.Add($handle)
    if ($Parent -eq [IntPtr]::Zero) { $ackRoots.Add($handle) }
    return $handle
}
function Reject-Ack([string]$Label, [scriptblock]$Action) {
    $failure = $null
    try { & $Action } catch { $failure = $_ }
    if ($null -eq $failure -or $failure.Exception.ToString() -notmatch 'Acknowledgment') { throw "Missing acknowledgment rejection: $Label" }
    $ackRejected.Add($Label)
}
$primaryFailure = $null
$ackTitle = [InstallerCapture]::ProductName + ' Setup'
$ackBody = 'Exact running-application refusal.'
try {
    $outer = New-AckControl '#32770' $ackTitle ([IntPtr]::Zero) 0
    foreach ($id in @(1, 2)) {
        $decoy = New-AckControl 'Button' 'Outer wizard action' $outer $id
        [void][StockCaptureFixture]::ShowWindow($decoy, 0)
        [void][StockCaptureFixture]::EnableWindow($decoy, $false)
    }
    [void][StockCaptureFixture]::EnableWindow($outer, $false)
    $modal = New-AckControl '#32770' $ackTitle ([IntPtr]::Zero) 0
    $body = New-AckControl 'Static' $ackBody $modal 65535
    $ack = New-AckControl 'Button' 'Localized acknowledgment, not English OK' $modal 2
    [StockCaptureFixture]::ButtonStyle($ack, 1)
    $oldIdOneMissing = [InstallerCapture]::GetDlgItem([InstallerCapture]::TopLevel($body), 1) -eq [IntPtr]::Zero
    if (-not $oldIdOneMissing) { throw 'Observed ID2 fixture no longer rejects the old ID1 lookup' }
    if ([InstallerCapture]::RequireAcknowledgment($PID, $body, $ackBody) -ne $ack) { throw 'Observed ID2 acknowledgment differs' }
    Reject-Ack 'foreign-pid' { [InstallerCapture]::RequireAcknowledgment(($PID + 1), $body, $ackBody) }
    Reject-Ack 'invalid-pid' { [InstallerCapture]::RequireAcknowledgment(0, $body, $ackBody) }
    Reject-Ack 'zero-prompt' { [InstallerCapture]::RequireAcknowledgment($PID, [IntPtr]::Zero, $ackBody) }
    Reject-Ack 'invalid-prompt' { [InstallerCapture]::RequireAcknowledgment($PID, [IntPtr](-1), $ackBody) }
    Reject-Ack 'root-as-prompt' { [InstallerCapture]::RequireAcknowledgment($PID, $modal, $ackBody) }
    Reject-Ack 'wrong-body' { [InstallerCapture]::RequireAcknowledgment($PID, $body, 'Different body') }
    Reject-Ack 'substring-body' { [InstallerCapture]::RequireAcknowledgment($PID, $body, 'running-application') }
    Reject-Ack 'empty-body' { [InstallerCapture]::RequireAcknowledgment($PID, $body, '') }
    foreach ($target in @(@('modal', $modal), @('body', $body), @('button', $ack))) {
        [void][StockCaptureFixture]::EnableWindow($target[1], $false)
        Reject-Ack ('disabled-' + $target[0]) { [InstallerCapture]::RequireAcknowledgment($PID, $body, $ackBody) }
        [void][StockCaptureFixture]::EnableWindow($target[1], $true)
        [void][StockCaptureFixture]::ShowWindow($target[1], 0)
        Reject-Ack ('hidden-' + $target[0]) { [InstallerCapture]::RequireAcknowledgment($PID, $body, $ackBody) }
        [void][StockCaptureFixture]::ShowWindow($target[1], 8)
    }
    [void][InstallerCapture]::SetWindowText($modal, 'Foreign product Setup')
    Reject-Ack 'wrong-title' { [InstallerCapture]::RequireAcknowledgment($PID, $body, $ackBody) }
    [void][InstallerCapture]::SetWindowText($modal, $ackTitle)
    foreach ($style in @(3, 9, 11)) {
        [StockCaptureFixture]::ButtonStyle($ack, $style)
        Reject-Ack ('non-push-style-' + $style) { [InstallerCapture]::RequireAcknowledgment($PID, $body, $ackBody) }
    }
    [StockCaptureFixture]::ButtonStyle($ack, 1)
    $extra = New-AckControl 'Button' 'Alternative' $modal 7
    Reject-Ack 'extra-button' { [InstallerCapture]::RequireAcknowledgment($PID, $body, $ackBody) }
    [void][StockCaptureFixture]::EnableWindow($extra, $false)
    Reject-Ack 'disabled-alternative' { [InstallerCapture]::RequireAcknowledgment($PID, $body, $ackBody) }
    [void][StockCaptureFixture]::ShowWindow($extra, 0)
    Reject-Ack 'hidden-alternative' { [InstallerCapture]::RequireAcknowledgment($PID, $body, $ackBody) }
    if (-not [StockCaptureFixture]::DestroyWindow($extra)) { throw 'Cannot destroy alternative' }
    $duplicate = New-AckControl 'Static' $ackBody $modal 100
    Reject-Ack 'duplicate-body' { [InstallerCapture]::RequireAcknowledgment($PID, $body, $ackBody) }
    if (-not [StockCaptureFixture]::DestroyWindow($duplicate)) { throw 'Cannot destroy duplicate body' }
    $otherModal = New-AckControl '#32770' $ackTitle ([IntPtr]::Zero) 0
    $otherBody = New-AckControl 'Static' $ackBody $otherModal 65535
    Reject-Ack 'duplicate-dialog' { [InstallerCapture]::RequireAcknowledgment($PID, $body, $ackBody) }
    if (-not [StockCaptureFixture]::DestroyWindow($otherModal)) { throw 'Cannot destroy duplicate dialog' }
    $page = New-AckControl '#32770' '' $modal 1018
    $nestedBody = New-AckControl 'Static' $ackBody $page 100
    Reject-Ack 'nested-body' { [InstallerCapture]::RequireAcknowledgment($PID, $nestedBody, $ackBody) }
    if (-not [StockCaptureFixture]::DestroyWindow($nestedBody)) { throw 'Cannot destroy nested body' }
    $wrongBody = New-AckControl 'Edit' 'Wrong body class' $modal 100
    Reject-Ack 'wrong-body-class' { [InstallerCapture]::RequireAcknowledgment($PID, $wrongBody, 'Wrong body class') }
    if (-not [StockCaptureFixture]::DestroyWindow($ack)) { throw 'Cannot destroy ID2 action' }
    Reject-Ack 'missing-button' { [InstallerCapture]::RequireAcknowledgment($PID, $body, $ackBody) }
    $nested = New-AckControl 'Button' 'Nested action' $page 2
    Reject-Ack 'nested-button' { [InstallerCapture]::RequireAcknowledgment($PID, $body, $ackBody) }
    if (-not [StockCaptureFixture]::DestroyWindow($nested)) { throw 'Cannot destroy nested action' }
    $wrongButton = New-AckControl 'Static' 'OK' $modal 2
    Reject-Ack 'wrong-button-class' { [InstallerCapture]::RequireAcknowledgment($PID, $body, $ackBody) }
    if (-not [StockCaptureFixture]::DestroyWindow($wrongButton)) { throw 'Cannot destroy wrong-class action' }
    $ack = New-AckControl 'Button' 'Acknowledgment with conventional ID' $modal 1
    [StockCaptureFixture]::ButtonStyle($ack, 0)
    $localizedBody = 'DeepSeek Harness 正在运行。请先关闭应用，再重新运行安装程序。'
    [void][InstallerCapture]::SetWindowText($body, $localizedBody)
    [void][InstallerCapture]::SetWindowText($modal, ([InstallerCapture]::ProductName + ' 安装'))
    if ([InstallerCapture]::RequireAcknowledgment($PID, $body, $localizedBody) -ne $ack) { throw 'Localized ID1 acknowledgment differs' }
    if (-not [StockCaptureFixture]::DestroyWindow($body)) { throw 'Cannot destroy message body' }
    Reject-Ack 'stale-body' { [InstallerCapture]::RequireAcknowledgment($PID, $body, $localizedBody) }
    $wrongRoot = New-AckControl 'Static' $ackTitle ([IntPtr]::Zero) 0
    $wrongRootBody = New-AckControl 'Static' $ackBody $wrongRoot 65535
    Reject-Ack 'wrong-root-class' { [InstallerCapture]::RequireAcknowledgment($PID, $wrongRootBody, $ackBody) }
} catch { $primaryFailure = $_ } finally {
    Complete-Fixture $primaryFailure @(
        {
            $destroyFailures = [Collections.Generic.List[string]]::new()
            foreach ($handle in $ackRoots) {
                if ([InstallerCapture]::IsWindow($handle) -and -not [StockCaptureFixture]::DestroyWindow($handle)) { $destroyFailures.Add([string]$handle) }
            }
            if ($destroyFailures.Count) { throw ('Acknowledgment roots survived destruction: ' + ($destroyFailures -join ', ')) }
        },
        {
            if (@($ackWindows | Where-Object { [InstallerCapture]::IsWindow($_) }).Count) { throw 'Acknowledgment controls survived cleanup' }
        }
    )
}
[pscustomobject]@{ dimensions = $dimensions; finishId = $finishId; diagnostic = $diagnostic; foreignDiagnostic = $foreignDiagnostic; limitedDiagnostic = $limitedDiagnostic; rejected = @($rejected); cleanupVerified = $true; cleanupFailures = $cleanupFailures; acknowledgment = @{ oldIdOneMissing = $oldIdOneMissing; acceptedIds = @(2, 1); rejected = @($ackRejected); cleanupVerified = $true } } | ConvertTo-Json -Depth 4 -Compress
`
    const names = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PSMODULEPATH', 'PROGRAMFILES'])
    const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toUpperCase())))
    const result = spawnSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
      // The real custom readiness timeout is 10 seconds; leave room for compilation and teardown.
      encoding: 'utf8', timeout: 40_000, env: { ...environment, DSH_INSTALLER_UI_HELPER: helper, DSH_STOCK_CAPTURE_ROOT: root },
    })
    assert.equal(result.error, undefined)
    assert.equal(result.signal, null)
    assert.equal(result.status, 0, result.stderr)
    const observed = JSON.parse(result.stdout.trim())
    assert.equal(observed.dimensions, '320x180')
    assert.equal(observed.cleanupVerified, true)
    assert.equal(observed.finishId, 1203)
    assert.deepEqual(observed.acknowledgment, {
      oldIdOneMissing: true, acceptedIds: [2, 1], cleanupVerified: true,
      rejected: [
        'foreign-pid', 'invalid-pid', 'zero-prompt', 'invalid-prompt', 'root-as-prompt', 'wrong-body', 'substring-body', 'empty-body',
        'disabled-modal', 'hidden-modal', 'disabled-body', 'hidden-body', 'disabled-button', 'hidden-button', 'wrong-title',
        'non-push-style-3', 'non-push-style-9', 'non-push-style-11', 'extra-button', 'disabled-alternative', 'hidden-alternative',
        'duplicate-body', 'duplicate-dialog', 'nested-body', 'wrong-body-class', 'missing-button', 'nested-button', 'wrong-button-class',
        'stale-body', 'wrong-root-class',
      ],
    })
    assert.match(observed.diagnostic, /CLASS=Button ID=1203 VISIBLE=True ENABLED=True STYLE=\d+ CHECK=1 TEXT=&Run Synthetic stock capture/u)
    assert.doesNotMatch(observed.foreignDiagnostic, /Synthetic stock capture/u)
    assert.match(observed.limitedDiagnostic, /LIMIT_REACHED=True/u)
    assert.equal(observed.limitedDiagnostic.match(/^HWND=/gmu).length, 64)
    assert.deepEqual(observed.cleanupFailures, {
      messages: ['synthetic primary failure', 'synthetic destruction failure', 'synthetic survivor failure'],
      trace: ['destroy', 'verify'],
      originalRetained: true,
      primaryOnly: ['synthetic primary failure'],
      cleanupOnly: ['synthetic cleanup-only failure'],
    })
    assert.deepEqual(observed.rejected, [
      'foreign-pid', 'invalid-pid', 'zero-window', 'invalid-window', 'child-window', 'unsupported-page', 'absent-finish',
      'disabled-directory', 'hidden-directory', 'disabled-action', 'disabled-window', 'hidden-window', 'wrong-title',
      'custom-not-ready', 'stale-page', 'obsolete-finish-id', 'reboot-radio', 'wrong-run-caption', 'wrong-finish-caption', 'disabled-finish', 'absent-action', 'wrong-action-class', 'wrong-page-class',
      'stale-window', 'wrong-window-class',
    ])
    for (const file of ['directory.png', 'finish.png']) {
      const png = readFileSync(join(root, file))
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
      assert.equal(png.readUInt32BE(16), 320)
      assert.equal(png.readUInt32BE(20), 180)
    }
    t.diagnostic('Synthetic Win32 windows only; not actual hosted installer qualification')
  })
}

function powershellUnit(t, body, extraEnv = {}) {
  const root = directory(t)
  const script = join(root, 'fixture-unit.ps1')
  writeFileSync(script, "$ErrorActionPreference = 'Stop'\n" + body)
  const names = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'PSMODULEPATH', 'PROGRAMFILES'])
  const environment = Object.fromEntries(Object.entries(process.env).filter(([name]) => names.has(name.toUpperCase())))
  const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-File', script], { encoding: 'utf8', timeout: 15_000, env: { ...environment, ...extraEnv } })
  assert.equal(result.error, undefined)
  assert.equal(result.signal, null)
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout.trim())
}

test('native baseline binding hashes original acquired bytes before deriving its source', { skip: process.platform !== 'win32' }, t => {
  const root = directory(t)
  const manifest = join(root, 'release.json')
  const bytes = JSON.stringify({ source: { repository: 'cloga/deepseek-harness', tag: 'dsh-desktop-v0.1.6-alpha.1.cloga.2', commit: '2'.repeat(40) }, manifestSha256: '3'.repeat(64) })
  writeFileSync(manifest, bytes)
  const observed = powershellUnit(t, `
. $env:DSH_REGISTRATION_HELPER
$path = $env:DSH_MANIFEST
$pin = $env:DSH_MANIFEST_DIGEST
$tag = 'dsh-desktop-v0.1.6-alpha.1.cloga.2'
$source = Get-PinnedInstallerBaselineSource $path $pin $tag
$rejected = @()
function Reject-Source($Label, [scriptblock]$Action) {
    $failure = $null
    try { & $Action | Out-Null } catch { $failure = $_ }
    if ($null -eq $failure) { throw ('Accepted unbound source: ' + $Label) }
    $script:rejected += $Label
}
Reject-Source 'internal-self-hash' { Get-PinnedInstallerBaselineSource $path ('3' * 64) $tag }
Reject-Source 'wrong-tag' { Get-PinnedInstallerBaselineSource $path $pin 'other-tag' }
Reject-Source 'directory' { Get-PinnedInstallerBaselineSource $PSScriptRoot $pin $tag }
$changed = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
$changed.source.commit = '4' * 40
$changed.manifestSha256 = '5' * 64
$changed | ConvertTo-Json | Set-Content -LiteralPath $path
Reject-Source 'substituted-source-and-self-hash' { Get-PinnedInstallerBaselineSource $path $pin $tag }
[pscustomobject]@{ source = $source; rejected = $rejected } | ConvertTo-Json -Compress
`, { DSH_REGISTRATION_HELPER: fileURLToPath(new URL('./fixtures/windows-installer-registration.ps1', import.meta.url)), DSH_MANIFEST: manifest, DSH_MANIFEST_DIGEST: digest(bytes) })
  writeFileSync(manifest, bytes)
  assert.equal(observed.source, '2'.repeat(40))
  assert.equal(observed.source, pinnedUpgradeSourceCommit(root, digest(bytes)))
  assert.deepEqual(observed.rejected, ['internal-self-hash', 'wrong-tag', 'directory', 'substituted-source-and-self-hash'])
})

test('baseline process binding verifies provider paths and physical bytes without inspecting a real process', { skip: process.platform !== 'win32' }, t => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const binding = source.match(/function Assert-BaselineProcessBinding[^]*?\r?\n\}/u)?.[0]
  const receipt = source.match(/        \[ordered\]@\{\r?\n            schemaVersion = 1; sourceCommit[^]*?Set-Content[^\r\n]*installer-upgrade\.json[^\r\n]*/u)?.[0]
  assert.ok(binding && receipt)
  const observed = powershellUnit(t, `
. $env:DSH_REGISTRATION_HELPER
${binding}
function Get-FileHash($LiteralPath, $Algorithm) {
    $script:hashCalls++
    if ($mode -eq 'hash-unavailable') { throw 'credential-sentinel-hash-error' }
    $value = Microsoft.PowerShell.Utility\\Get-FileHash -LiteralPath $LiteralPath -Algorithm $Algorithm
    if ($mode -eq 'exit-during-hash') { $script:observedProcess.HasExited = $true }
    return $value
}
$results = @()
foreach ($mode in @('exact', 'alternate-case', 'separator-dot', 'outside', 'prefix-sibling', 'nested-copy', 'wrong-basename', 'wrong-hash', 'directory', 'installation-junction', 'exited', 'unknown-liveness', 'getter-failure', 'null-path', 'empty-path', 'missing-file', 'hash-unavailable', 'exit-during-hash', 'invalid-digest')) {
    $root = Join-Path $PSScriptRoot $mode
    $installPath = Join-Path $root 'Installed App'
    $application = Join-Path $installPath 'cloga-deepseek-harness.exe'
    New-Item -ItemType Directory -Path $installPath, (Join-Path $root 'evidence') | Out-Null
    [IO.File]::WriteAllText($application, 'inert baseline bytes')
    $expected = $env:DSH_BASELINE_DIGEST
    $observedProcess = [pscustomobject]@{ HasExited = $false; Path = $application }
    if ($mode -eq 'alternate-case') { $observedProcess.Path = $application.ToUpperInvariant() }
    if ($mode -eq 'separator-dot') { $observedProcess.Path = ($installPath + '\\.\\cloga-deepseek-harness.exe').Replace('\\', '/') }
    if ($mode -in @('outside', 'prefix-sibling', 'nested-copy')) {
        $parent = if ($mode -eq 'outside') { Join-Path $root 'foreign' } elseif ($mode -eq 'prefix-sibling') { $installPath + '-foreign' } else { Join-Path $installPath 'nested' }
        New-Item -ItemType Directory -Path $parent | Out-Null
        $observedProcess.Path = Join-Path $parent 'cloga-deepseek-harness.exe'
        [IO.File]::WriteAllText($observedProcess.Path, 'inert baseline bytes')
    }
    if ($mode -eq 'wrong-basename') { $observedProcess.Path = Join-Path $installPath 'other.exe'; [IO.File]::WriteAllText($observedProcess.Path, 'inert baseline bytes') }
    if ($mode -eq 'wrong-hash') { [IO.File]::WriteAllText($application, 'different inert bytes') }
    if ($mode -eq 'directory') { Remove-Item -LiteralPath $application; New-Item -ItemType Directory -Path $application | Out-Null }
    if ($mode -eq 'installation-junction') {
        $physical = Join-Path $root 'physical'
        Move-Item -LiteralPath $installPath -Destination $physical
        New-Item -ItemType Junction -Path $installPath -Target $physical | Out-Null
    }
    if ($mode -eq 'exited') { $observedProcess.HasExited = $true }
    if ($mode -eq 'unknown-liveness') { $observedProcess.HasExited = $null }
    if ($mode -eq 'getter-failure') { $observedProcess | Add-Member ScriptProperty HasExited { throw 'credential-sentinel-getter-error' } -Force }
    if ($mode -eq 'null-path') { $observedProcess.Path = $null }
    if ($mode -eq 'empty-path') { $observedProcess.Path = '' }
    if ($mode -eq 'missing-file') { Remove-Item -LiteralPath $application }
    if ($mode -eq 'invalid-digest') { $expected = 'not-a-release-digest' }
    $hashCalls = 0; $failure = $null
    try { Assert-BaselineProcessBinding $observedProcess $expected } catch { $failure = $_ }
    $ExpectedSourceCommit = 'a' * 40; $success = $false; $packageAcceptanceSuccess = $false
    $cleanupErrors = [Collections.Generic.List[string]]::new(); $secondaryErrors = [Collections.Generic.List[string]]::new()
${receipt}
    $saved = Get-Content -LiteralPath (Join-Path $root 'evidence/installer-upgrade.json') -Raw | ConvertFrom-Json
    $results += [pscustomobject]@{ mode = $mode; accepted = ($null -eq $failure); hashCalls = $hashCalls
        facts = $saved.baselineProcessBinding; receiptSucceeded = $saved.succeeded; error = $saved.failure }
}
ConvertTo-Json -InputObject $results -Depth 5 -Compress
`, { DSH_REGISTRATION_HELPER: fileURLToPath(new URL('./fixtures/windows-installer-registration.ps1', import.meta.url)), DSH_BASELINE_DIGEST: digest('inert baseline bytes') })
  const accepted = new Set(['exact', 'alternate-case', 'separator-dot'])
  for (const item of observed) {
    assert.equal(item.accepted, accepted.has(item.mode), item.mode)
    assert.equal(item.receiptSucceeded, false)
    assert.deepEqual(Object.keys(item.facts).sort(), ['basenameMatches', 'directParentMatches', 'hashMatches', 'pathAvailable', 'providerNormalized'])
    for (const value of Object.values(item.facts)) assert.ok(value === null || typeof value === 'boolean')
    if (accepted.has(item.mode)) {
      assert.equal(item.hashCalls, 1)
      assert.ok(Object.values(item.facts).every(value => value === true))
      assert.equal(item.error, null)
    } else {
      assert.equal(typeof item.error, 'string')
      assert.equal(item.hashCalls, ['wrong-hash', 'hash-unavailable', 'exit-during-hash'].includes(item.mode) ? 1 : 0, item.mode)
    }
  }
  const byMode = Object.fromEntries(observed.map(item => [item.mode, item]))
  assert.equal(byMode['wrong-hash'].facts.hashMatches, false)
  assert.equal(byMode['exit-during-hash'].facts.hashMatches, true)
  assert.equal(byMode['null-path'].facts.pathAvailable, false)
  assert.equal(byMode['missing-file'].facts.providerNormalized, false)
  assert.equal(byMode['nested-copy'].facts.directParentMatches, false)
  assert.equal(byMode['wrong-basename'].facts.basenameMatches, false)
  assert.match(byMode['installation-junction'].error, /alias/u)
  assert.doesNotMatch(JSON.stringify(observed), /credential-sentinel|Installed App|ProcessId|ExecutablePath/u)
})

test('baseline process binding keeps readiness and later refusal ownership gates in order', () => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const ready = source.indexOf("if ($ready.ownerToken -ne $token -or $ready.application -ne $application)")
  const lookup = source.indexOf('$live = Get-Process -Id $ready.pid -ErrorAction Stop')
  const binding = source.indexOf('Assert-BaselineProcessBinding $live $baselineIdentity.ExecutableSha256')
  const start = source.indexOf('$refused = Start-Installer $validated.candidate')
  assert.ok(ready >= 0 && ready < lookup && lookup < binding && binding < start)
  assert.ok(source.includes('$baselineProcessBinding = $null'))
  assert.ok(source.includes('baselineProcessBinding = $baselineProcessBinding'))
  assert.ok(source.includes("if ($live.HasExited -or (Installation-Inventory) -ne $before -or (Read-Registration @($baselineIdentity)).Key -ne $registration.Key)"))
  assert.doesNotMatch(source, /if \(\$live\.Path -ne \$application\)/u)
})

test('cleanup rejects parent and root junctions before hashing or invoking the uninstaller', { skip: process.platform !== 'win32' }, t => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const readRegistration = source.match(/function Read-Registration[^]*?\r?\n\}/u)?.[0]
  assert.ok(readRegistration)
  const start = source.indexOf('            $hasRegistration = ')
  const launch = '                Wait-Exit $ownedUninstaller 120'
  const end = source.indexOf(launch, start)
  assert.ok(start >= 0 && end > start)
  const admission = source.slice(start, end + launch.length) + '\n            }'
  const observed = powershellUnit(t, `
. $env:DSH_REGISTRATION_HELPER
${readRegistration}
# Only registry/process boundaries are synthetic; execute the driver's actual cleanup admission.
function Product-Registrations { [pscustomobject]@{ Id = 'synthetic-registered-install' } }
function Resolve-InstallerRegistration { [pscustomobject]@{ ExecutableSha256 = ('a' * 64) } }
function Get-FileHash { $script:hashCalls++; [pscustomobject]@{ Hash = ('a' * 64) } }
function Wait-NoProductProcesses {}
function New-OwnedUninstallerCopy { [pscustomobject]@{ Path = (Join-Path $root 'process-temp/copied.exe'); Target = $installPath } }
function Start-Owned($File, $Arguments) {
    if ($File -cne $uninstallerCopy.Path -or $File -ceq $uninstaller -or $Arguments -cne ('/currentuser /S _?=' + $installPath)) { throw 'Unexpected synthetic launch' }
    $script:uninstallerCalls++
    return 'not-a-process'
}
function Wait-Exit {}
$root = Join-Path $PSScriptRoot 'run-root'
$parent = Join-Path $root 'Installed App'
$installPath = Join-Path $parent 'cloga-deepseek-harness-desktop'
$application = Join-Path $installPath 'cloga-deepseek-harness.exe'
$uninstaller = Join-Path $installPath 'Uninstall cloga-deepseek-harness.exe'
New-Item -ItemType Directory -Path $installPath | Out-Null
Set-Content -LiteralPath $application -Value 'synthetic payload, never executable' -NoNewline
Set-Content -LiteralPath $uninstaller -Value 'synthetic uninstaller, never executable' -NoNewline
$cleanup = {
${admission}
}
$hashCalls = 0; $uninstallerCalls = 0
& $cleanup
if ($hashCalls -ne 1 -or $uninstallerCalls -ne 1) { throw 'Ordinary owned cleanup was not admitted' }
$rejected = @()
foreach ($case in @('parent', 'root')) {
    $alias = if ($case -eq 'parent') { $parent } else { $root }
    $relocated = Join-Path $PSScriptRoot ('relocated-' + $case)
    Move-Item -LiteralPath $alias -Destination $relocated
    try {
        New-Item -ItemType Junction -Path $alias -Target $relocated | Out-Null
        try {
            $hashCalls = 0; $uninstallerCalls = 0; $failure = $null
            try { & $cleanup } catch { $failure = $_ }
            if ($null -eq $failure -or $failure.Exception.Message -notmatch 'filesystem alias') { throw ('Cleanup accepted ' + $case + ' junction') }
            if ($hashCalls -ne 0 -or $uninstallerCalls -ne 0) { throw 'Cleanup touched bytes or launched through an alias' }
            $rejected += $case
        } finally { Remove-Item -LiteralPath $alias -Force }
    } finally { Move-Item -LiteralPath $relocated -Destination $alias }
}
if ((Get-Content -LiteralPath $uninstaller -Raw) -cne 'synthetic uninstaller, never executable') { throw 'Cleanup mutated retained evidence' }
[pscustomobject]@{ rejected = $rejected; hashCalls = $hashCalls; uninstallerCalls = $uninstallerCalls; payloadRetained = $true } | ConvertTo-Json -Compress
`, { DSH_REGISTRATION_HELPER: fileURLToPath(new URL('./fixtures/windows-installer-registration.ps1', import.meta.url)) })
  assert.deepEqual(observed, { rejected: ['parent', 'root'], hashCalls: 0, uninstallerCalls: 0, payloadRetained: true })
})

function uninstallCopyUnit(t, body) {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const functions = source.slice(source.indexOf('function Close-UninstallStream'), source.indexOf('function Write-InstallerFailureDiagnostics'))
  assert.ok(functions.includes('function New-OwnedUninstallerCopy'))
  return powershellUnit(t, `
. $env:DSH_REGISTRATION_HELPER
${functions}
$env:GITHUB_RUN_ID = '123'; $env:GITHUB_RUN_ATTEMPT = '1'
$token = 'fixture-owned-token'
function Initialize-CopyCase($Name) {
    $script:root = Join-Path $PSScriptRoot $Name
    $script:installPath = Join-Path $root 'Installed App/cloga-deepseek-harness-desktop'
    $script:uninstaller = Join-Path $installPath 'Uninstall cloga-deepseek-harness.exe'
    $script:sourcePath = $uninstaller
    $script:temporaryRoot = Join-Path $root 'process-temp'
    Microsoft.PowerShell.Management\\New-Item -ItemType Directory -Path $installPath, $temporaryRoot | Out-Null
    [IO.File]::WriteAllText($uninstaller, 'inert uninstaller bytes')
    @{ token = $token; runId = '123'; runAttempt = '1' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'owner.json')
    $script:expectedRegistration = [pscustomobject]@{ Id = 'fixture-id'; Key = 'fixture-key'; OwnerKey = 'fixture-owner-key'
        Version = '1.0.0'; Source = ('a' * 40); ExecutableSha256 = ('b' * 64); InstallLocation = $installPath }
    $script:copyDirectory = Join-Path $temporaryRoot 'uninstall-fixture'
    $script:copyPath = Join-Path $copyDirectory 'owned-uninstaller.exe'
    $script:cleanupErrors = [Collections.Generic.List[string]]::new()
    $script:readmissions = 0; $script:quiescenceChecks = 0
}
function Read-Registration { $script:readmissions++; return $expectedRegistration.PSObject.Copy() }
function Wait-NoProductProcesses { $script:quiescenceChecks++ }
${body}
`, { DSH_REGISTRATION_HELPER: fileURLToPath(new URL('./fixtures/windows-installer-registration.ps1', import.meta.url)) })
}

test('owned uninstall copy hashes real streams, seals only the copy and releases the installed source', { skip: process.platform !== 'win32' }, t => {
  const observed = uninstallCopyUnit(t, `
Initialize-CopyCase 'stream-copy'
$copy = New-OwnedUninstallerCopy $copyDirectory $expectedRegistration $cleanupErrors
$guardDeniedWrite = $false; $guardDeniedDelete = $false
try {
    try { $probe = [IO.File]::Open($copy.Path, 'Open', 'Write', 'ReadWrite'); $probe.Dispose() } catch { $guardDeniedWrite = $true }
    try { [IO.File]::Delete($copy.Path) } catch { $guardDeniedDelete = $true }
    $sourceWritable = [IO.File]::Open($sourcePath, 'Open', 'ReadWrite', 'None')
    $sourceWritable.Dispose()
    $facts = [ordered]@{ before = $copy.SourceBeforeSha256; after = $copy.SourceAfterSha256; copied = $copy.Sha256
        bytes = [IO.File]::ReadAllText($copy.Path); sourceReleased = $true; guardDeniedWrite = $guardDeniedWrite; guardDeniedDelete = $guardDeniedDelete
        inTemporary = $copy.Path.StartsWith($temporaryRoot + '\\'); outsideInstallation = -not $copy.Path.StartsWith($installPath + '\\')
        readmissions = $readmissions; quiescenceChecks = $quiescenceChecks }
} finally { Close-UninstallStream $copy.Guard $cleanupErrors }
$writable = [IO.File]::Open($copy.Path, 'Open', 'Write', 'None'); $writable.Dispose()
$facts.copyReleased = $true; $facts.errors = @($cleanupErrors)
$facts | ConvertTo-Json -Compress
`)
  assert.deepEqual(observed, {
    before: digest('inert uninstaller bytes'), after: digest('inert uninstaller bytes'), copied: digest('inert uninstaller bytes'),
    bytes: 'inert uninstaller bytes', sourceReleased: true, guardDeniedWrite: true, guardDeniedDelete: true,
    inTemporary: true, outsideInstallation: true, readmissions: 1, quiescenceChecks: 1, copyReleased: true, errors: [],
  })
})

test('owned uninstall copy rejects aliases, collisions, hash drift and stale readmission before launch', { skip: process.platform !== 'win32' }, t => {
  const observed = uninstallCopyUnit(t, `
$originalHash = (Get-Command Get-UninstallStreamSha256).ScriptBlock
function Get-UninstallStreamSha256([IO.Stream]$Stream) {
    $script:hashCalls++
    $actual = & $originalHash $Stream
    if (($damage -eq 'source-hash-drift' -and $hashCalls -eq 2) -or ($damage -eq 'copy-hash-drift' -and $hashCalls -eq 3)) { return ('f' * 64) }
    return $actual
}
function Read-Registration {
    $script:readmissions++
    if ($damage -eq 'owner-changed') { @{ token = 'changed'; runId = '123'; runAttempt = '1' } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $root 'owner.json') }
    $value = $expectedRegistration.PSObject.Copy()
    if ($damage -eq 'registration-changed') { $value.Version = '2.0.0' }
    return $value
}
function Wait-NoProductProcesses {
    $script:quiescenceChecks++
    if ($damage -eq 'process-became-live') { throw 'Owned application became live' }
}
function New-Item($ItemType, $Path, $ErrorAction) {
    Microsoft.PowerShell.Management\\New-Item -ItemType $ItemType -Path $Path -ErrorAction Stop | Out-Null
    if ($damage -eq 'file-collision') { [IO.File]::WriteAllText((Join-Path $Path 'owned-uninstaller.exe'), 'retained collision bytes') }
    if ($damage -eq 'copy-directory-junction') {
        $real = $Path + '-real'
        Move-Item -LiteralPath $Path -Destination $real
        Microsoft.PowerShell.Management\\New-Item -ItemType Junction -Path $Path -Target $real | Out-Null
    }
}
$results = @()
foreach ($damage in @('directory-collision', 'file-collision', 'source-junction', 'temporary-junction', 'copy-directory-junction', 'outside-owned-temp', 'invalid-target', 'source-hash-drift', 'copy-hash-drift', 'registration-changed', 'owner-changed', 'process-became-live')) {
    Initialize-CopyCase $damage
    $hashCalls = 0
    if ($damage -eq 'directory-collision') {
        Microsoft.PowerShell.Management\\New-Item -ItemType Directory -Path $copyDirectory | Out-Null
        [IO.File]::WriteAllText((Join-Path $copyDirectory 'sentinel'), 'retained collision bytes')
    }
    if ($damage -eq 'source-junction') {
        $moved = Join-Path $root 'physical-install'
        Move-Item -LiteralPath $installPath -Destination $moved
        Microsoft.PowerShell.Management\\New-Item -ItemType Junction -Path $installPath -Target $moved | Out-Null
    }
    if ($damage -eq 'temporary-junction') {
        $moved = $temporaryRoot + '-real'
        Move-Item -LiteralPath $temporaryRoot -Destination $moved
        Microsoft.PowerShell.Management\\New-Item -ItemType Junction -Path $temporaryRoot -Target $moved | Out-Null
    }
    if ($damage -eq 'outside-owned-temp') { $copyDirectory = Join-Path $installPath 'in-place-forbidden' }
    if ($damage -eq 'invalid-target') { $installPath += [char]34 }
    $failure = $null
    try { $unexpected = New-OwnedUninstallerCopy $copyDirectory $expectedRegistration $cleanupErrors } catch { $failure = $_ }
    if ($null -eq $failure) { Close-UninstallStream $unexpected.Guard $cleanupErrors; throw ('Accepted unsafe case: ' + $damage) }
    # Hash fault injection wraps the real stream hashing; both mismatches must follow all three observations.
    if ($damage -in @('source-hash-drift', 'copy-hash-drift') -and $hashCalls -ne 3) { throw 'Hash comparison skipped a real stream' }
    if ($damage -eq 'directory-collision' -and [IO.File]::ReadAllText((Join-Path $copyDirectory 'sentinel')) -cne 'retained collision bytes') { throw 'Directory collision was overwritten' }
    if ($damage -eq 'file-collision' -and [IO.File]::ReadAllText($copyPath) -cne 'retained collision bytes') { throw 'File collision was overwritten' }
    $probe = [IO.File]::Open($sourcePath, 'Open', 'ReadWrite', 'None'); $probe.Dispose()
    if (Test-Path -LiteralPath $copyPath -PathType Leaf) { $probe = [IO.File]::Open($copyPath, 'Open', 'ReadWrite', 'None'); $probe.Dispose() }
    $results += [pscustomobject]@{ damage = $damage; rejected = $true; streamsReleased = $true; errors = @($cleanupErrors) }
}
ConvertTo-Json -InputObject $results -Depth 4 -Compress
`)
  assert.deepEqual(observed.map(item => item.damage), ['directory-collision', 'file-collision', 'source-junction', 'temporary-junction', 'copy-directory-junction', 'outside-owned-temp', 'invalid-target', 'source-hash-drift', 'copy-hash-drift', 'registration-changed', 'owner-changed', 'process-became-live'])
  for (const item of observed) assert.deepEqual({ rejected: item.rejected, streamsReleased: item.streamsReleased, errors: item.errors }, { rejected: true, streamsReleased: true, errors: [] })
})

test('owned copied-worker launch uses final unquoted target and waits only its tracked handle', { skip: process.platform !== 'win32' }, t => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const start = source.indexOf('                $copyDirectory = Join-Path')
  const end = source.indexOf('                $timer = ', start)
  assert.ok(start >= 0 && end > start)
  const launch = source.slice(start, end)
  const observed = uninstallCopyUnit(t, `
function Start-Owned($File, $Arguments) {
    if ($File -cne $uninstallerCopy.Path -or $File -ceq $uninstaller -or $File.StartsWith($installPath + '\\')) { throw 'Uninstaller ran in place or another file was selected' }
    if ($Arguments -cne ('/currentuser /S _?=' + $installPath) -or $Arguments.Contains([char]34)) { throw 'Unbound NSIS arguments' }
    if (-not $uninstallerCopy.Guard.CanRead) { throw 'Copied bytes lost their read guard' }
    $probe = [IO.File]::Open($sourcePath, 'Open', 'ReadWrite', 'None'); $probe.Dispose()
    $script:actual = [pscustomobject]@{ Id = 71; HasExited = ($outcome -ne 'timeout'); ExitCode = $(if ($outcome -eq 'nonzero') { 2 } else { 0 }) }
    $processes.Add($actual)
    return $actual
}
function Wait-Exit($Process, $Seconds) {
    if (-not [object]::ReferenceEquals($Process, $actual) -or $Seconds -ne 120 -or $processes.Count -ne 1 -or -not [object]::ReferenceEquals($processes[0], $actual)) { throw 'Wrong execution handle or deadline' }
    $script:waited = $true
    if (-not $Process.HasExited) { throw 'Owned qualification process exceeded its deadline' }
    if ($Process.ExitCode -ne 0) { throw 'Owned qualification process returned nonzero' }
}
$cases = @()
foreach ($outcome in @('success', 'timeout', 'nonzero')) {
    Initialize-CopyCase $outcome
    $processes = [Collections.Generic.List[object]]::new()
    $uninstallRegistration = $expectedRegistration
    $uninstallerCopy = $null; $failure = $null; $waited = $false; $postconditionsReached = $false
    try {
${launch}
        $postconditionsReached = $true
    } catch { $failure = $_ } finally { if ($null -ne $uninstallerCopy) { Close-UninstallStream $uninstallerCopy.Guard $cleanupErrors } }
    $cases += [pscustomobject]@{ outcome = $outcome; waited = $waited; postconditionsReached = $postconditionsReached; failed = ($null -ne $failure); errors = @($cleanupErrors) }
}
ConvertTo-Json -InputObject $cases -Depth 4 -Compress
`)
  assert.deepEqual(observed, [
    { outcome: 'success', waited: true, postconditionsReached: true, failed: false, errors: [] },
    { outcome: 'timeout', waited: true, postconditionsReached: false, failed: true, errors: [] },
    { outcome: 'nonzero', waited: true, postconditionsReached: false, failed: true, errors: [] },
  ])
  const finalReaper = source.lastIndexOf('[void](Stop-OwnedProcesses $processes $cleanupErrors)')
  assert.ok(finalReaper < source.indexOf('Close-UninstallStream $uninstallerCopy.Guard', finalReaper))
  assert.ok(source.includes('$processes.Add($process)'))
  assert.doesNotMatch(launch, /Start-Owned \$uninstaller\s|--updated|--delete-app-data|\/NCRC|\/D=/u)
})

test('owned uninstall stream disposal failures aggregate without replacing the active error', { skip: process.platform !== 'win32' }, t => {
  const observed = uninstallCopyUnit(t, `
$errors = [Collections.Generic.List[string]]::new()
$stream = [pscustomobject]@{}
$stream | Add-Member ScriptMethod Dispose { throw 'private disposal error' }
try { throw 'primary copy failure' } catch { $failure = $_; $original = $_ }
Close-UninstallStream $stream $errors
Close-UninstallStream $null $errors
[pscustomobject]@{ originalRetained = [object]::ReferenceEquals($failure, $original); errors = @($errors) } | ConvertTo-Json -Compress
`)
  assert.deepEqual(observed, { originalRetained: true, errors: ['Owned uninstall stream disposal failed'] })
})

test('production registration GUID is bound to the exact appId and pinned builder namespace', () => {
  const bytes = createHash('sha1').update(Buffer.from('50e065bc313411e69bab38c9862bdaf3', 'hex')).update('io.github.cloga.deepseek-harness.desktop').digest().subarray(0, 16)
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const id = bytes.toString('hex').replace(/^(........)(....)(....)(....)(............)$/u, '$1-$2-$3-$4-$5')
  assert.equal(id, 'e82f4b7a-f955-53af-bd9b-031d4e7ad569')
  const source = readFileSync(new URL('./fixtures/windows-installer-registration.ps1', import.meta.url), 'utf8')
  assert.ok(source.includes(`$id = '${id}'`))
  assert.ok(source.includes("$owner.GetValue('InstallLocation', $null,"))
  assert.doesNotMatch(source, /Get-ChildItem|Set-ItemProperty|CreateSubKey|SetValue/u)
  assert.ok(source.includes('$base.OpenSubKey($ownerPath, $false)'))
  assert.ok(source.includes('$base.OpenSubKey($uninstallPath, $false)'))
  for (const name of ['owner', 'uninstall', 'base']) assert.ok(source.includes(`$${name}.Dispose()`))
})

test('exact baseline and candidate registrations accept only identical view aliases and verified identities', { skip: process.platform !== 'win32' }, t => {
  const root = directory(t)
  const input = join(root, 'records.json')
  const id = 'e82f4b7a-f955-53af-bd9b-031d4e7ad569'
  const installPath = join(root, 'Installed App', 'cloga-deepseek-harness-desktop')
  const baselineSource = '2'.repeat(40)
  const candidateSource = '1'.repeat(40)
  const release = (version, commit) => ({ manifest: {
    version, source: { repository: 'cloga/deepseek-harness', commit },
    identity: { appId: 'io.github.cloga.deepseek-harness.desktop', productName: 'DeepSeek Harness (cloga)', executableName: 'cloga-deepseek-harness', packageName: 'cloga-deepseek-harness-desktop' },
    installedEvidence: { executableSha256: (commit === baselineSource ? 'a' : 'b').repeat(64) },
  } })
  const baseline = release('0.1.6-alpha.1.cloga.2', baselineSource)
  const candidate = release('0.1.6-alpha.2.cloga.1', candidateSource)
  const record = version => ({
    Id: id, Hive: 'CurrentUser', View: 'Registry64', OwnerKey: `Software\\${id}`, Key: `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}`,
    OwnerPresent: true, UninstallPresent: true, InstallLocation: installPath,
    DisplayName: `DeepSeek Harness (cloga) ${version}`, DisplayVersion: version,
    // Stock NSIS uses PRODUCT_FILENAME, derived from executableName rather than productName.
    UninstallString: `"${join(installPath, 'Uninstall cloga-deepseek-harness.exe')}" /currentuser`,
    QuietUninstallString: `"${join(installPath, 'Uninstall cloga-deepseek-harness.exe')}" /currentuser /S`,
  })
  const old = record(baseline.manifest.version)
  const next = record(candidate.manifest.version)
  const cases = [
    ['missing', []], ['32-only', [{ ...old, View: 'Registry32' }]], ['duplicate-view', [old, old]],
    ['foreign-machine', [old, { ...old, Hive: 'LocalMachine' }]],
    ...Object.entries({
      Id: 'other-guid', OwnerKey: 'Software\\other', Key: 'Software\\other', OwnerPresent: false, UninstallPresent: false,
      InstallLocation: installPath + '-foreign', DisplayName: 'DeepSeek Harness (cloga)', DisplayVersion: '0.1.6-alpha.1.cloga.99',
      UninstallString: old.UninstallString.replaceAll('"', ''), QuietUninstallString: old.QuietUninstallString + ' /foreign',
    }).map(([field, value]) => [`wrong-${field}`, [{ ...old, [field]: value }]]),
    ['old-uninstall-location-assumption', [{ ...old, OwnerPresent: false, InstallLocation: null }]],
    ['conflicting-alias-path', [old, { ...old, View: 'Registry32', InstallLocation: installPath + '-foreign' }]],
    ['conflicting-alias-version', [old, { ...next, View: 'Registry32' }]],
    ['missing-mode', [{ ...old, UninstallString: old.UninstallString.replace(' /currentuser', '') }]],
    ['wrong-mode', [{ ...old, UninstallString: old.UninstallString.replace('/currentuser', '/allusers') }]],
    ['foreign-uninstaller', [{ ...old, UninstallString: '"C:\\foreign.exe" /currentuser' }]],
    ['display-name-uninstaller', [{ ...old,
      UninstallString: `"${join(installPath, 'Uninstall DeepSeek Harness (cloga).exe')}" /currentuser`,
      QuietUninstallString: `"${join(installPath, 'Uninstall DeepSeek Harness (cloga).exe')}" /currentuser /S`,
    }]],
    ['package-name-uninstaller', [{ ...old,
      UninstallString: `"${join(installPath, 'Uninstall cloga-deepseek-harness-desktop.exe')}" /currentuser`,
      QuietUninstallString: `"${join(installPath, 'Uninstall cloga-deepseek-harness-desktop.exe')}" /currentuser /S`,
    }]],
    ['command-injection', [{ ...old, UninstallString: old.UninstallString + ' & echo injected' }]],
    ['trailing-uninstall-arguments', [{ ...old, UninstallString: old.UninstallString + ' /S' }]],
    ['quiet-foreign-uninstaller', [{ ...old, QuietUninstallString: '"C:\\foreign.exe" /currentuser /S' }]],
    ['quiet-missing-mode', [{ ...old, QuietUninstallString: old.QuietUninstallString.replace(' /currentuser', '') }]],
    ['quiet-wrong-mode', [{ ...old, QuietUninstallString: old.QuietUninstallString.replace('/currentuser', '/allusers') }]],
    ['quiet-missing-silent', [{ ...old, QuietUninstallString: old.UninstallString }]],
  ]
  const invalidReleases = [
    ['source', { ...candidate.manifest, source: { ...candidate.manifest.source, commit: '2'.repeat(40) } }],
    ['repository', { ...candidate.manifest, source: { ...candidate.manifest.source, repository: 'other/repository' } }],
    ['version', { ...candidate.manifest, version: 'unversioned' }],
    ['executable-hash', { ...candidate.manifest, installedEvidence: { executableSha256: 'invalid' } }],
    ...['appId', 'productName', 'packageName', 'executableName'].map(field => [field, { ...candidate.manifest, identity: { ...candidate.manifest.identity, [field]: 'foreign' } }]),
  ]
  writeFileSync(input, JSON.stringify({ installPath, baselineSource, candidateSource, baseline, candidate, old, next, cases, invalidReleases }))
  const observed = powershellUnit(t, `
. $env:DSH_REGISTRATION_HELPER
# Pure validation must not observe or mutate this machine's production registry.
function Get-InstallerRegistrationEntries { throw 'Unit test attempted registry access' }
$data = Get-Content -LiteralPath $env:DSH_REGISTRATION_INPUT -Raw | ConvertFrom-Json
$oldIdentity = New-InstallerRegistrationIdentity $data.baseline $data.baselineSource
$newIdentity = New-InstallerRegistrationIdentity $data.candidate $data.candidateSource
$identities = @($oldIdentity, $newIdentity)
$accepted = @()
foreach ($entry in @($data.old, $data.next)) {
    $accepted += Resolve-InstallerRegistration @($entry) $identities $data.installPath
    $alias = $entry.PSObject.Copy()
    $alias.View = 'Registry32'
    $accepted += Resolve-InstallerRegistration @($entry, $alias) $identities $data.installPath
}
$rejected = @()
foreach ($case in $data.cases) {
    $failure = $null
    try { [void](Resolve-InstallerRegistration @($case[1]) $identities $data.installPath) } catch { $failure = $_ }
    if ($null -eq $failure) { throw ('Accepted invalid registration: ' + $case[0]) }
    $rejected += $case[0]
}
foreach ($case in $data.invalidReleases) {
    $failure = $null
    try { [void](New-InstallerRegistrationIdentity ([pscustomobject]@{ manifest = $case[1] }) $data.candidateSource) } catch { $failure = $_ }
    if ($null -eq $failure) { throw ('Accepted substituted identity: ' + $case[0]) }
    $rejected += ('release-' + $case[0])
}
$failure = $null
try { [void](Resolve-InstallerRegistration @($data.next) @($oldIdentity) $data.installPath) } catch { $failure = $_ }
if ($null -eq $failure) { throw 'Candidate accepted during baseline-only phase' }
[pscustomobject]@{ accepted = $accepted; rejected = $rejected; phaseRejected = $true } | ConvertTo-Json -Depth 5 -Compress
`, { DSH_REGISTRATION_HELPER: fileURLToPath(new URL('./fixtures/windows-installer-registration.ps1', import.meta.url)), DSH_REGISTRATION_INPUT: input })
  assert.deepEqual(observed.accepted.map(value => [value.Version, value.Source, value.ExecutableSha256]), [
    [baseline.manifest.version, baselineSource, 'a'.repeat(64)], [baseline.manifest.version, baselineSource, 'a'.repeat(64)],
    [candidate.manifest.version, candidateSource, 'b'.repeat(64)], [candidate.manifest.version, candidateSource, 'b'.repeat(64)],
  ])
  assert.ok(observed.accepted.every(value => value.Id === id && value.InstallLocation === installPath))
  assert.deepEqual(observed.rejected, [...cases.map(([name]) => name), ...invalidReleases.map(([name]) => `release-${name}`)])
  assert.equal(observed.phaseRejected, true)
})

test('driver binds registration and stock Run admission before trusting installed state', () => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  assert.ok(source.includes("$uninstaller = Join-Path $installPath 'Uninstall cloga-deepseek-harness.exe'"))
  assert.ok(source.includes("Get-PinnedInstallerBaselineSource (Join-Path $baseline 'release.json') $baselinePin.manifest.sha256 $baselinePin.tag"))
  assert.ok(source.includes("Join-Path $PSScriptRoot 'fixtures/windows-upgrade-baseline.json'"))
  assert.ok(source.includes('New-InstallerRegistrationIdentity $validated.previous $baselineSource'))
  assert.ok(source.includes('New-InstallerRegistrationIdentity $validated.candidate $ExpectedSourceCommit'))
  assert.ok(source.indexOf('$registrationIdentities = @($baselineIdentity, $candidateIdentity)') < source.indexOf('$installationAttempted = $true'))
  assert.equal(source.match(/Read-Registration @\(\$baselineIdentity\)/gu).length, 2)
  assert.equal(source.match(/Read-Registration @\(\$candidateIdentity\)/gu).length, 1)
  assert.ok(source.includes('-cne $entry.ExecutableSha256'))
  const registration = source.split('function Read-Registration')[1].split('function Write-InstallerFailureDiagnostics')[0]
  assert.ok(registration.indexOf('Assert-InstallerOwnedPath $root $path') < registration.indexOf('Get-FileHash -LiteralPath $application'))
  const legacyFinish = source.split('function Finish-LegacyInstaller')[1].split('function Start-Installer')[0]
  assert.ok(legacyFinish.indexOf('::StockRun($Process.Id, $window)') < legacyFinish.indexOf('::Click($checkbox)'))
  assert.ok(legacyFinish.includes("throw 'Baseline launch checkbox default changed'"))
  assert.ok(legacyFinish.includes("throw 'Could not disable baseline automatic launch'"))
})

test('failure observations precede process cleanup and cannot replace the primary error', { skip: process.platform !== 'win32' }, t => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const diagnostic = source.match(/function Write-InstallerFailureDiagnostics[^]*?\r?\n\}/u)?.[0]
  assert.ok(diagnostic)
  const handler = source.slice(source.indexOf('    $failure = $_\n    Write-InstallerFailureDiagnostics'))
  assert.ok(handler.indexOf('Write-InstallerFailureDiagnostics') < handler.indexOf('Stop-OwnedProcesses $processes'))
  const observed = powershellUnit(t, `
${diagnostic}
Add-Type 'public static class InstallerCapture { public static string DiagnosticText(int pid) { throw new System.InvalidOperationException("synthetic UI read failure"); } }'
function Product-Registrations { [pscustomobject]@{ Id = 'synthetic-registration-only' } }
$root = $PSScriptRoot
New-Item -ItemType Directory -Path (Join-Path $root 'evidence') | Out-Null
$errors = [Collections.Generic.List[string]]::new()
try { throw 'primary installer failure' } catch { $failure = $_; $original = $_ }
Write-InstallerFailureDiagnostics @([pscustomobject]@{ HasExited = $false; Id = 123 }) $errors
$registration = Get-Content -LiteralPath (Join-Path $root 'evidence/installer-failure-registration.json') -Raw | ConvertFrom-Json
$root = Join-Path $root 'absent-parent'
Write-InstallerFailureDiagnostics @() $errors
[pscustomobject]@{ samePrimary = [object]::ReferenceEquals($failure, $original); messages = @($errors); registration = @($registration) } | ConvertTo-Json -Depth 4 -Compress
`)
  assert.equal(observed.samePrimary, true)
  assert.deepEqual(observed.registration, [{ Id: 'synthetic-registration-only' }])
  assert.equal(observed.messages.length, 2)
  assert.match(observed.messages[0], /Owned installer UI observation failed: .*synthetic UI read failure/u)
  assert.match(observed.messages[1], /Installer registration observation failed:/u)
})

test('post-uninstall diagnostics distinguish remaining predicates and bound private observations', { skip: process.platform !== 'win32' }, t => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const diagnostic = source.match(/function Write-UninstallFailureDiagnostics[^]*?\r?\n\}/u)?.[0]
  assert.ok(diagnostic)
  const observed = powershellUnit(t, `
${diagnostic}
$root = $PSScriptRoot
$ExpectedSourceCommit = 'a' * 40
$installPath = Join-Path $root 'Installed App'
$application = Join-Path $installPath 'cloga-deepseek-harness.exe'
$uninstaller = Join-Path $installPath 'Uninstall cloga-deepseek-harness.exe'
New-Item -ItemType Directory -Path (Join-Path $root 'evidence') | Out-Null
$prior = Join-Path $root 'evidence/installer-failure-registration.json'
Set-Content -LiteralPath $prior -Value 'retained pre-cleanup evidence' -NoNewline
Add-Type 'public static class InstallerCapture { public static string DiagnosticText(int pid) { if (pid != 20) throw new System.Exception("foreign PID"); return "HWND=private-handle PID=20 VISIBLE=True TEXT=credential-sentinel\\nHWND=another-handle PID=20 VISIBLE=False TEXT=<unresponsive>\\nLIMIT_REACHED=True"; } }'
function Test-Path($LiteralPath, $PathType) {
    if ($PathType -cne 'Leaf') { throw 'Unexpected synthetic file query' }
    if ($LiteralPath -ceq $application) { return $mode -in @('executable', 'capped') }
    if ($LiteralPath -ceq $uninstaller) { return $mode -ne 'clean' }
    throw 'Unexpected synthetic path'
}
function Product-Registrations {
    if ($mode -notin @('owner', 'uninstall-key', 'capped')) { return }
    $count = if ($mode -eq 'capped') { 6 } else { 1 }
    for ($i = 0; $i -lt $count; $i++) {
        [pscustomobject]@{ Hive = 'CurrentUser'; View = 'Registry64'; OwnerPresent = ($mode -ne 'uninstall-key')
            UninstallPresent = ($mode -ne 'owner'); InstallLocation = $installPath
            UninstallString = 'credential-sentinel'; DisplayName = 'private-display-name' }
    }
}
function Get-CimInstance($ClassName, $OperationTimeoutSec) {
    if ($ClassName -cne 'Win32_Process' -or $OperationTimeoutSec -ne 5) { throw 'Unexpected synthetic process query' }
    [pscustomobject]@{ Name = 'foreign.exe'; ExecutablePath = 'C:\\foreign\\foreign.exe'; ProcessId = 999; ParentProcessId = 998; CommandLine = 'credential-sentinel' }
    if ($mode -eq 'worker') {
        [pscustomobject]@{ Name = 'relocated.exe'; ExecutablePath = (Join-Path $root 'process-temp/relocated.exe'); ProcessId = 30; ParentProcessId = 20; CommandLine = 'credential-sentinel' }
    }
    if ($mode -in @('product', 'capped')) {
        $count = if ($mode -eq 'capped') { 20 } else { 1 }
        for ($i = 0; $i -lt $count; $i++) {
            [pscustomobject]@{ Name = 'cloga-deepseek-harness.exe'; ExecutablePath = $application; ProcessId = (40 + $i); ParentProcessId = 20; CommandLine = 'credential-sentinel' }
        }
    }
}
$cases = @()
foreach ($mode in @('clean', 'executable', 'owner', 'uninstall-key', 'product', 'worker', 'capped', 'not-started')) {
    $errors = [Collections.Generic.List[string]]::new()
    $launcher = [pscustomobject]@{ Id = 20; HasExited = ($mode -ne 'worker') }
    $launcher | Add-Member ScriptProperty ExitCode { if (-not $this.HasExited) { throw 'Do not read live exit status' }; return 0 }
    if ($mode -eq 'not-started') { $launcher = $null }
    $copy = [pscustomobject]@{ Sha256 = ('b' * 64); SourceBeforeSha256 = ('b' * 64); SourceAfterSha256 = ('b' * 64)
        InsideOwnedTemporaryRoot = $true; OutsideInstallation = $true; Target = $installPath; Path = 'private-copy-path'; Guard = 'credential-sentinel' }
    if ($mode -eq 'not-started') { $copy = $null }
    Write-UninstallFailureDiagnostics $launcher $errors $copy
    $data = Get-Content -LiteralPath (Join-Path $root 'evidence/installer-uninstall-failure.json') -Raw | ConvertFrom-Json
    $cases += [pscustomobject]@{ mode = $mode; data = $data; errors = @($errors) }
}
if ((Get-Content -LiteralPath $prior -Raw) -cne 'retained pre-cleanup evidence') { throw 'Post-uninstall observation overwrote earlier evidence' }
ConvertTo-Json -InputObject $cases -Depth 8 -Compress
`)
  const cases = Object.fromEntries(observed.map(({ mode, data, errors }) => {
    assert.deepEqual(errors, [])
    assert.deepEqual(data.observationErrors, [])
    assert.equal(data.arguments, '/currentuser /S _?=<owned-install-root>')
    assert.equal(data.sourceCommit, 'a'.repeat(40))
    return [mode, data]
  }))
  assert.equal(cases.clean.executablePresent, false)
  assert.equal(cases.clean.uninstallerPresent, false)
  assert.equal(cases.clean.registrationCount, 0)
  assert.equal(cases.clean.productProcessCount, 0)
  assert.equal(cases.clean.ownedTemporaryProcessCount, 0)
  assert.deepEqual(cases.clean.processes, [])
  assert.equal(cases.executable.executablePresent, true)
  assert.equal(cases.executable.launcherExited, true)
  assert.equal(cases.executable.launcherExitCode, 0)
  assert.deepEqual(cases.owner.registrations, [{ hive: 'CurrentUser', view: 'Registry64', ownerPresent: true, uninstallPresent: false, installLocationMatches: true }])
  assert.deepEqual(cases['uninstall-key'].registrations, [{ hive: 'CurrentUser', view: 'Registry64', ownerPresent: false, uninstallPresent: true, installLocationMatches: true }])
  assert.equal(cases.product.productProcessCount, 1)
  assert.deepEqual(cases.product.processes, [{ pid: 40, parentPid: 20, inInstallation: true, inOwnedTemporaryRoot: false }])
  assert.equal(cases.worker.productProcessCount, 0)
  assert.equal(cases.worker.ownedTemporaryProcessCount, 1)
  assert.deepEqual(cases.worker.processes, [{ pid: 30, parentPid: 20, inInstallation: false, inOwnedTemporaryRoot: true }])
  assert.equal(cases.worker.launcherExited, false)
  assert.equal(cases.worker.launcherExitCode, null)
  assert.equal(cases.worker.workerWindowCount, 2)
  assert.equal(cases.worker.workerVisibleWindowCount, 1)
  assert.equal(cases.worker.workerUnresponsiveWindowCount, 1)
  assert.equal(cases.worker.workerWindowsTruncated, true)
  assert.equal(cases.worker.copyVerified, true)
  assert.equal(cases.worker.copySha256, 'b'.repeat(64))
  for (const key of ['copyHashesAgree', 'copyInsideOwnedTemporaryRoot', 'copyOutsideInstallation', 'targetMatches']) assert.equal(cases.worker[key], true)
  assert.equal(cases.capped.registrationCount, 6)
  assert.equal(cases.capped.registrations.length, 4)
  assert.equal(cases.capped.registrationsTruncated, true)
  assert.equal(cases.capped.productProcessCount, 20)
  assert.equal(cases.capped.processes.length, 16)
  assert.equal(cases.capped.processesTruncated, true)
  assert.equal(cases['not-started'].launcherStarted, false)
  assert.equal(cases['not-started'].launcherPid, null)
  assert.equal(cases['not-started'].launcherExitCode, null)
  assert.equal(cases['not-started'].copyVerified, false)
  assert.equal(cases['not-started'].copySha256, null)
  assert.doesNotMatch(JSON.stringify(observed), /credential-sentinel|private-copy-path|private-handle|another-handle|private-display-name|foreign\.exe|ExecutablePath|CommandLine|Installed App/u)
})

test('post-uninstall observation failures retain partial evidence without exposing raw errors', { skip: process.platform !== 'win32' }, t => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const diagnostic = source.match(/function Write-UninstallFailureDiagnostics[^]*?\r?\n\}/u)?.[0]
  assert.ok(diagnostic)
  const observed = powershellUnit(t, `
${diagnostic}
$root = $PSScriptRoot
$ExpectedSourceCommit = 'a' * 40
$installPath = Join-Path $root 'Installed App'
$application = Join-Path $installPath 'app.exe'; $uninstaller = Join-Path $installPath 'uninstall.exe'
New-Item -ItemType Directory -Path (Join-Path $root 'evidence') | Out-Null
function Test-Path { throw 'credential-sentinel-file' }
function Product-Registrations { throw 'credential-sentinel-registry' }
function Get-CimInstance { throw 'credential-sentinel-process' }
$launcher = [pscustomobject]@{ Id = 20 }
$launcher | Add-Member ScriptProperty HasExited { throw 'credential-sentinel-launcher' }
$errors = [Collections.Generic.List[string]]::new()
Write-UninstallFailureDiagnostics $launcher $errors
$data = Get-Content -LiteralPath (Join-Path $root 'evidence/installer-uninstall-failure.json') -Raw | ConvertFrom-Json
$root = Join-Path $root 'absent-parent'
$launcher = [pscustomobject]@{ Id = 20; HasExited = $true }
$launcher | Add-Member ScriptProperty ExitCode { throw 'credential-sentinel-exit-code' }
Write-UninstallFailureDiagnostics $launcher $errors
[pscustomobject]@{ data = $data; errors = @($errors) } | ConvertTo-Json -Depth 6 -Compress
`)
  assert.equal(observed.data.launcherPid, 20)
  assert.equal(observed.data.executablePresent, null)
  assert.equal(observed.data.registrationCount, null)
  assert.equal(observed.data.productProcessCount, null)
  assert.deepEqual(observed.data.observationErrors, ['launcher-state-unavailable', 'installed-file-state-unavailable', 'registration-state-unavailable', 'process-state-unavailable'])
  assert.equal(observed.errors.length, 9)
  assert.equal(observed.errors.at(-1), 'Post-uninstall diagnostic write failed')
  assert.doesNotMatch(JSON.stringify(observed), /credential-sentinel/u)
})

test('post-uninstall diagnostic exceptions cannot replace primary or cleanup-only failures', { skip: process.platform !== 'win32' }, t => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const start = source.indexOf('            $cleanupFailure = $_')
  const end = source.indexOf('\n        }\n    }\n    # Cleanup itself', start)
  assert.ok(start >= 0 && end > start)
  const handler = source.slice(start, end)
  const observed = powershellUnit(t, `
function Write-UninstallFailureDiagnostics { throw 'diagnostic failure' }
$cases = @()
foreach ($hasPrimary in @($true, $false)) {
    $failure = $null
    if ($hasPrimary) { try { throw 'primary failure' } catch { $failure = $_ } }
    $original = $failure
    $cleanupErrors = [Collections.Generic.List[string]]::new()
    $secondaryErrors = [Collections.Generic.List[string]]::new()
    $uninstallAttempted = $true; $ownedUninstaller = 'synthetic handle'
    try { throw 'cleanup failure' } catch {
${handler}
    }
    $cases += [pscustomobject]@{ hasPrimary = $hasPrimary; originalRetained = [object]::ReferenceEquals($failure, $original)
        failure = $failure.Exception.Message; cleanup = @($cleanupErrors); secondary = @($secondaryErrors) }
}
ConvertTo-Json -InputObject $cases -Depth 5 -Compress
`)
  assert.deepEqual(observed, [
    { hasPrimary: true, originalRetained: true, failure: 'primary failure', cleanup: ['Installed product cleanup failed: cleanup failure'], secondary: ['Post-uninstall diagnostic collection failed'] },
    { hasPrimary: false, originalRetained: false, failure: 'cleanup failure', cleanup: ['Installed product cleanup failed: cleanup failure'], secondary: ['Post-uninstall diagnostic collection failed'] },
  ])
  assert.ok(source.includes('Wait-Exit $ownedUninstaller 120'))
  assert.ok(source.includes("if ($timer.Elapsed.TotalSeconds -gt 30) { throw 'Owned uninstaller did not remove executable, registration and product processes' }"))
  assert.ok(source.includes('while ((Test-Path -LiteralPath $application) -or @(Product-Registrations).Count -ne 0 -or @(Product-Processes).Count -ne 0)'))
})

test('transaction guard rejects real target-parent staging siblings without deleting evidence', { skip: process.platform !== 'win32' }, t => {
  const driver = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const guard = driver.match(/function Assert-NoTransactionDirectories \{[^]*?\r?\n\}/u)?.[0]
  assert.ok(guard)
  const installer = readFileSync(new URL('../scripts/installer-directories.nsh', import.meta.url), 'utf8')
  assert.ok(installer.includes('StrCpy $dshNewDirectory "$INSTDIR.new-$0"'))
  assert.ok(installer.includes('StrCpy $dshOldDirectory "$INSTDIR.old-$0"'))
  const observed = powershellUnit(t, `
${guard}
$root = $PSScriptRoot
$installPath = Join-Path $root 'Installed App/cloga-deepseek-harness-desktop'
Assert-NoTransactionDirectories
New-Item -ItemType Directory -Path $installPath | Out-Null
Assert-NoTransactionDirectories
$rejected = @()
foreach ($stage in @('new', 'old')) {
    $path = $installPath + '.' + $stage + '-{11111111-1111-4111-8111-111111111111}'
    New-Item -ItemType Directory -Path $path | Out-Null
    if ($stage -eq 'old') { (Get-Item -LiteralPath $path).Attributes = [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::Hidden }
    $sentinel = Join-Path $path 'evidence.txt'
    Set-Content -LiteralPath $sentinel -Value 'retained staged bytes' -NoNewline
    $failure = $null
    try { Assert-NoTransactionDirectories } catch { $failure = $_ }
    if ($null -eq $failure -or $failure.Exception.Message -notmatch 'transaction directory') { throw ('Guard missed exact staging sibling: ' + $stage) }
    if ((Get-Content -LiteralPath $sentinel -Raw) -cne 'retained staged bytes') { throw 'Guard mutated staged evidence' }
    $rejected += $stage
    Remove-Item -LiteralPath $path -Recurse -Force
}
Assert-NoTransactionDirectories
[pscustomobject]@{ rejected = $rejected; cleanAccepted = $true } | ConvertTo-Json -Compress
`)
  assert.deepEqual(observed, { rejected: ['new', 'old'], cleanAccepted: true })
})

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
  assert.ok(source.includes('$nodeCommands = @(Get-Command node -CommandType Application -ErrorAction Stop)'))
  assert.ok(source.includes('$node = $nodeCommands[0].Source'))
  assert.doesNotMatch(source, /\(Get-Command node[^\n]+\)\.Source/u)
  const install = source.split('function Start-Installer')[1].split('function Finish-Installer')[0]
  assert.ok(install.includes("$arguments = '/THEME=light'"))
  assert.doesNotMatch(install, /\/D=/u)
  assert.doesNotMatch(install, /\/S|--updated|RunAs|ExecutionPolicy/)
  const legacy = source.split('function Start-LegacyInstaller')[1].split('function Start-Installer')[0]
  assert.ok(legacy.includes("Start-Owned $path ('/currentuser /D=' + $installPath)"))
  assert.ok(legacy.includes('Wait-StockControl $process $window 1019'))
  assert.ok(legacy.includes('Wait-StockControl $Process $window 1203 600'))
  assert.ok(source.includes("$baselineAppFilename = 'cloga-deepseek-harness-desktop'"))
  assert.ok(source.includes('Finish-LegacyInstaller (Start-LegacyInstaller $validated.previous)'))
  assert.ok(source.includes("throw 'Installer unexpectedly launched the product'"))
  assert.ok(source.includes('draftAttachmentRefusalVerified = $false'))
  assert.ok(source.includes('pluginUserChoicesVerified = $false'))
  assert.ok(source.includes('managedHandoffVerified = $false'))
})

test('stock baseline captures are separate from strict custom-page readiness', () => {
  const driver = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  const legacy = driver.split('function Start-LegacyInstaller')[1].split('function Start-Installer')[0]
  assert.match(legacy, /::SaveStock\(\$process\.Id, \$window, 1019, /u)
  assert.match(legacy, /::SaveStock\(\$Process\.Id, \$window, 1203, /u)
  assert.doesNotMatch(legacy, /::Save\(/u)
  for (const [name, process] of [['Start-LegacyInstaller', 'process'], ['Finish-LegacyInstaller', 'Process']]) {
    const section = driver.split(`function ${name}`)[1].split('\nfunction ')[0]
    const capture = section.indexOf('::SaveStock(')
    const ready = section.indexOf(`[void](Wait-StockControl $${process} $window 1)`)
    assert.ok(ready >= 0 && ready < capture, `${name} must await the capture's action-control prerequisite`)
    assert.ok(section.indexOf(`::Click((Wait-StockControl $${process} $window 1))`, capture) > capture)
  }
  const custom = driver.split('function Start-Installer')[1].split('function Wait-NoProductProcesses')[0]
  assert.equal(custom.match(/::Save\(/gu)?.length, 2)
  assert.doesNotMatch(custom, /::SaveStock\(/u)
  const helper = readFileSync(new URL('./windows-installer-ui.ps1', import.meta.url), 'utf8')
  assert.match(helper, /public static string Save\(IntPtr window, string path\) \{\s+Reveal\(window\);/u)
  const reveal = helper.split('public static void Reveal(IntPtr window) {')[1].split('public static string Save(')[0]
  assert.match(reveal, /while \(GetProp\(window, "HarnessInstaller.Ready"\) == IntPtr.Zero\)/u)
  assert.match(reveal, /ElapsedMilliseconds > 10000\) throw new TimeoutException/u)
  assert.doesNotMatch(helper, /\bSetProp\b/u)
})

test('cleanup admission precedes Finish and rechecks actual registration before uninstalling', () => {
  const source = readFileSync(new URL('./windows-installer-upgrade.ps1', import.meta.url), 'utf8')
  assert.doesNotMatch(source, /\$installed\b/)
  assert.ok(source.indexOf('$installationAttempted = $true') < source.indexOf('Finish-LegacyInstaller (Start-LegacyInstaller $validated.previous)'))
  const cleanup = source.split('    if ($installationAttempted) {')[1]
  assert.ok(cleanup)
  assert.ok(cleanup.includes('$hasRegistration = @(Product-Registrations).Count -ne 0'))
  assert.ok(cleanup.includes('Get-ChildItem -LiteralPath $installPath -Force'))
  assert.ok(cleanup.indexOf('$uninstallRegistration = Read-Registration') < cleanup.indexOf('Start-Owned $uninstallerCopy.Path'))
  assert.ok(cleanup.indexOf('Wait-NoProductProcesses') < cleanup.indexOf('Start-Owned $uninstallerCopy.Path'))
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
