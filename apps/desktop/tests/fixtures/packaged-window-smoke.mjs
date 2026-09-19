/** Real Windows startup-info/stdio/Job canary; not an interactive visibility or focus observer. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { packagedDesktopRuntimeEnvironment, packagedDesktopRuntimeRoot } from '../../scripts/packaged-runtime.mjs'

const powershell = String.raw`
param([string]$Mode)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class StartupProbe {
  [StructLayout(LayoutKind.Sequential)] public struct StartupInfo {
    public uint cb;
    public IntPtr reserved, desktop, title;
    public uint x, y, width, height, columns, rows, fill, flags;
    public ushort show, reservedBytes;
    public IntPtr reservedData, input, output, error;
  }
  [StructLayout(LayoutKind.Sequential)] public struct BasicInfo {
    public IntPtr reserved1, peb, reserved2a, reserved2b, pid, parent;
  }
  [DllImport("kernel32.dll")] public static extern void GetStartupInfoW(out StartupInfo info);
  [DllImport("kernel32.dll")] public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] public static extern uint GetFileType(IntPtr handle);
  [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("kernel32.dll", SetLastError = true)]
  public static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
  [DllImport("ntdll.dll")] public static extern int NtQueryInformationProcess(
    IntPtr process, int infoClass, out BasicInfo info, int length, out int returned);
}
'@
$startup = [StartupProbe+StartupInfo]::new()
[StartupProbe]::GetStartupInfoW([ref]$startup)
$basic = [StartupProbe+BasicInfo]::new()
$returned = 0
$status = [StartupProbe]::NtQueryInformationProcess([StartupProbe]::GetCurrentProcess(), 0,
  [ref]$basic, [Runtime.InteropServices.Marshal]::SizeOf($basic), [ref]$returned)
if ($status -ne 0) { throw "NtQueryInformationProcess failed: $status" }
$member = $false
if (![StartupProbe]::IsProcessInJob([StartupProbe]::GetCurrentProcess(), [IntPtr]::Zero, [ref]$member)) {
  throw 'IsProcessInJob failed'
}
$console = [StartupProbe]::GetConsoleWindow()
$consoleState = if ($console -eq [IntPtr]::Zero) { 'absent' }
  elseif ([StartupProbe]::IsWindowVisible($console)) { 'visible' } else { 'hidden-or-message-only' }
[Console]::Out.WriteLine((@{kind='ready'; pid=$PID; runnerPid=$basic.parent.ToInt64();
  flags=$startup.flags; show=$startup.show; inJob=$member; consoleState=$consoleState;
  stdio=@([StartupProbe]::GetFileType($startup.input), [StartupProbe]::GetFileType($startup.output),
    [StartupProbe]::GetFileType($startup.error))} | ConvertTo-Json -Compress))
[Console]::Out.Flush()
$command = [Console]::ReadLine()
if ($Mode -eq 'normal') {
  if ($command -ne 'exit') { throw 'Unexpected normal stdin command' }
  [Console]::Out.WriteLine('stdout-ok')
  [Console]::Error.WriteLine('stderr-ok')
  exit 23
}
if ($Mode -ne 'cancel' -or $command -ne 'child') { throw 'Unexpected cancellation stdin command' }
$start = [Diagnostics.ProcessStartInfo]::new((Join-Path $PSHOME 'pwsh.exe'))
$start.UseShellExecute = $false
$start.WindowStyle = [Diagnostics.ProcessWindowStyle]::Hidden
$start.RedirectStandardInput = $true
$start.RedirectStandardOutput = $true
$start.RedirectStandardError = $true
foreach ($arg in @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', (Join-Path $PSScriptRoot 'descendant.ps1'))) {
  $start.ArgumentList.Add($arg)
}
$descendant = [Diagnostics.Process]::Start($start)
$readyPid = $descendant.StandardOutput.ReadLine()
if ([int]$readyPid -ne $descendant.Id) { throw 'Descendant readiness did not identify the owned child' }
[Console]::Out.WriteLine((@{kind='descendant'; pid=$descendant.Id} | ConvertTo-Json -Compress))
[Console]::Out.Flush()
$null = [Console]::ReadLine()
throw 'Cancellation target unexpectedly resumed'
`

const childSource = String.raw`
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { readFileSync, realpathSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'
assert.equal(process.platform, 'win32')
assert.equal(process.arch, 'x64')
assert(process.versions.electron, 'Use the supplied packaged Electron Host runtime')
const runtime = process.argv[2]
const home = process.env.DSH_HOME
assert(home)
const packages = join(runtime, 'node_modules', '@deepseek-ai')
const load = name => import(pathToFileURL(join(packages, name, 'lib', 'index.js')).href)
const [{ Context }, { default: LocalSubprocess }] = await Promise.all([load('cordis'), load('dsh-subprocess-local')])
const koffi = createRequire(pathToFileURL(join(packages, 'dsh-win32-process', 'package.json')))('koffi')
const kernel = koffi.load('kernel32.dll')
const openProcess = kernel.func('void * __stdcall OpenProcess(uint32 access, int inherit, uint32 pid)')
const wait = kernel.func('uint32 __stdcall WaitForSingleObject(void *handle, uint32 milliseconds)')
const close = kernel.func('int __stdcall CloseHandle(void *handle)')
const imageName = kernel.func('int __stdcall QueryFullProcessImageNameW(void *process, uint32 flags, void *name, void *size)')
const freeConsole = kernel.func('int __stdcall FreeConsole()')
const consoleWindow = kernel.func('void * __stdcall GetConsoleWindow()')
const stdHandle = kernel.func('void * __stdcall GetStdHandle(uint32 selector)')
const fileType = kernel.func('uint32 __stdcall GetFileType(void *handle)')
const selectors = [0xfffffff6, 0xfffffff5, 0xfffffff4]
const hostStdio = selectors.map(selector => stdHandle(selector))
for (const handle of hostStdio) assert.equal(fileType(handle), 3, 'Private Host stdio must already be redirected pipes')
// Detach only this private probe, never its parent's/user's console, to model the GUI Host.
assert.equal(freeConsole(), 1, 'Private Host console detachment failed')
const detachedWindow = consoleWindow()
assert(detachedWindow === null || detachedWindow === 0n, 'Private Host must have no ambient console HWND')
for (const [index, selector] of selectors.entries()) {
  assert.equal(stdHandle(selector), hostStdio[index], 'Detaching the private Host must preserve its stdio handle')
  assert.equal(fileType(hostStdio[index]), 3, 'Redirected Host pipe was invalidated by detachment')
}
assert.equal(readFileSync(0, 'utf8'), 'host-stdin-probe\n')
writeSync(1, 'host-stdio-ready\n')
writeSync(2, 'host-stderr-ready\n')
const ctx = new Context()
const deadline = Date.now() + 90_000
async function bounded(promise, label, cleanup = false) {
  const timeout = cleanup ? 30_000 : Math.max(1, Math.min(30_000, deadline - Date.now()))
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(label + ' exceeded its deadline')), timeout)
    })])
  } finally { clearTimeout(timer) }
}
function retain(pid) {
  assert(Number.isSafeInteger(pid) && pid > 0)
  const handle = openProcess(0x100000 | 0x1000, 0, pid)
  assert(handle !== null && handle !== 0n, 'OpenProcess must retain the owned process')
  return handle
}
const receipts = []
try {
  await ctx.plugin(LocalSubprocess)
  const pwsh = await ctx.subprocess.resolveExecutable('pwsh')
  for (const mode of ['normal', 'cancel']) {
    const controller = new AbortController()
    const processHandle = ctx.subprocess.spawn({
      argv: [pwsh, '-NoLogo', '-NoProfile', '-NonInteractive', '-File', join(home, 'probe.ps1'), mode],
      cwd: home, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: 16_384 } },
      graceMs: 2_000, signal: controller.signal,
    })
    // Attach rejection handling before waiting for a child's startup report.
    const outcome = processHandle.done.then(value => ({ value }), error => ({ error }))
    const reader = createInterface({ input: processHandle.stdout, crlfDelay: Infinity })
    const lines = reader[Symbol.asyncIterator]()
    const nativeHandles = []
    try {
      const first = await bounded(lines.next(), mode + ' readiness')
      assert.equal(first.done, false, 'pwsh exited before readiness: ' + processHandle.collected.stderr.readFrom(0).text)
      const ready = JSON.parse(first.value)
      assert.equal(ready.kind, 'ready')
      nativeHandles.push(retain(ready.pid))
      nativeHandles.push(retain(ready.runnerPid))
      // The target is blocked on owned stdin: the liveness sensor must first see it alive.
      for (const handle of nativeHandles) assert.equal(wait(handle, 0), 258)
      assert.notEqual(ready.runnerPid, process.pid, 'Fallback/direct spawning is not this canary')
      const path = Buffer.alloc(65_536)
      const length = Buffer.alloc(4)
      length.writeUInt32LE(path.length / 2)
      assert.equal(imageName(nativeHandles[1], 0, path, length), 1)
      assert.equal(realpathSync(path.toString('utf16le', 0, length.readUInt32LE() * 2)).toLowerCase(), realpathSync(process.execPath).toLowerCase())
      assert.equal(ready.inJob, true)
      assert.equal(ready.flags & 0x100, 0x100, 'STARTF_USESTDHANDLES must survive')
      assert.equal(ready.flags & 1, 1, 'Actual pwsh STARTUPINFO must include STARTF_USESHOWWINDOW')
      assert.equal(ready.show, 0, 'Actual pwsh STARTUPINFO must request SW_HIDE')
      assert(['absent', 'hidden-or-message-only'].includes(ready.consoleState), 'The target reports a visible console HWND')
      // Absent/message-only HWNDs do not observe Windows Terminal, other console hosts, or focus history.
      assert.deepEqual(ready.stdio, [3, 3, 3], 'All actual standard handles must be pipes')
      processHandle.stdin.write(mode === 'normal' ? 'exit\n' : 'child\n')
      const next = await bounded(lines.next(), mode + ' response')
      assert.equal(next.done, false)
      if (mode === 'normal') assert.equal(next.value, 'stdout-ok')
      else {
        const descendant = JSON.parse(next.value)
        assert.equal(descendant.kind, 'descendant')
        nativeHandles.push(retain(descendant.pid))
        assert.equal(wait(nativeHandles[2], 0), 258)
        controller.abort(new Error('owned canary cancellation'))
      }
      const result = await bounded(outcome, mode + ' exit')
      if (result.error) throw result.error
      assert.equal(result.value.signal, null)
      if (mode === 'normal') {
        assert.equal(controller.signal.aborted, false)
        assert.equal(result.value.exitCode, 23)
        assert.equal(processHandle.collected.stderr.readFrom(0).text.trim(), 'stderr-ok')
      } else {
        assert.equal(controller.signal.aborted, true)
        assert.notEqual(result.value.exitCode, 0)
      }
      assert.equal(await bounded(processHandle.waitForExit(), mode + ' managed-range exit'), true)
      for (const handle of nativeHandles) assert.equal(wait(handle, 0), 0, 'Owned target, runner, and descendant must have exited')
      assert.equal((await bounded(lines.next(), mode + ' stdout close')).done, true)
      receipts.push({ mode, flags: ready.flags, show: ready.show, consoleState: ready.consoleState, exitCode: result.value.exitCode, cleanup: true })
    } finally {
      try {
        processHandle.terminate()
        await bounded(Promise.all([outcome, processHandle.waitForExit()]), mode + ' final cleanup', true)
        for (const handle of nativeHandles) assert.equal(wait(handle, 0), 0, 'Cleanup must join owned processes even after assertion failure')
      } finally {
        reader.close()
        const closed = nativeHandles.map(handle => close(handle))
        assert(closed.every(result => result !== 0), 'CloseHandle failed for an owned process')
      }
    }
  }
} finally { await bounded(ctx.fiber.dispose(), 'Host context disposal', true) }
process.stdout.write(JSON.stringify({ hostConsoleDetached: true, receipts, interactiveVisibilityAndFocus: 'inconclusive', restrictedToken: 'not-exercised' }) + '\n')
`

/**
 * Verify the packaged Host -> Windows Job runner -> pwsh path without inspecting unrelated windows.
 * @param {string} executable - Existing Windows x64 packaged Electron executable; no download occurs.
 * @returns {void} Returns after real startup flags, stdio, exit and owned-process cleanup pass.
 */
export function verifyPackagedWindowsStartup(executable) {
  assert.equal(process.platform, 'win32', 'This canary requires Windows')
  const application = resolve(executable)
  const runtime = packagedDesktopRuntimeRoot(join(dirname(application), 'resources'))
  const home = mkdtempSync(join(tmpdir(), 'desktop-packaged-window-'))
  try {
    const profile = join(home, 'profiles', 'desktop')
    mkdirSync(profile, { recursive: true })
    for (const [name, content] of [
      ['check.mjs', childSource], ['probe.ps1', powershell],
      ['descendant.ps1', '[Console]::Out.WriteLine($PID); [Console]::Out.Flush(); $null = [Console]::ReadLine()\n'],
    ]) writeFileSync(join(home, name), content, { flag: 'wx', mode: 0o600 })
    const policy = pathToFileURL(join(runtime, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'register-module-resolution-policy.mjs')).href
    const result = spawnSync(application, ['--import', policy, join(home, 'check.mjs'), runtime, profile], {
      cwd: home, env: { ...packagedDesktopRuntimeEnvironment(), DSH_HOME: home },
      input: 'host-stdin-probe\n', encoding: 'utf8', windowsHide: true, timeout: 180_000, maxBuffer: 1024 * 1024,
    })
    assert.equal(result.error, undefined, `Packaged startup canary failed: ${result.error?.message}`)
    assert.equal(result.signal, null, `Packaged startup canary was terminated: ${result.signal}`)
    assert.equal(result.status, 0, `Packaged startup canary exited ${result.status}: ${result.stderr}`)
    const output = result.stdout.trimEnd().split(/\r?\n/u)
    assert.equal(output.length, 2, 'Expected private Host stdio readiness and one final receipt')
    assert.equal(output[0], 'host-stdio-ready')
    assert.equal(result.stderr.split(/\r?\n/u).filter(line => line === 'host-stderr-ready').length, 1, 'Private Host stderr must survive detachment')
    const receipt = JSON.parse(output[1])
    assert.equal(receipt.hostConsoleDetached, true)
    assert.deepEqual(receipt.receipts.map(entry => entry.mode), ['normal', 'cancel'])
    assert(receipt.receipts.every(entry => entry.cleanup && (entry.flags & 1) === 1 && entry.show === 0))
    assert.equal(receipt.interactiveVisibilityAndFocus, 'inconclusive')
    assert.equal(receipt.restrictedToken, 'not-exercised')
    process.stdout.write('Windows startup: ' + JSON.stringify(receipt) + '\n')
    process.stdout.write('Startup-info, stdio and Job cleanup passed; HWND observations cannot establish no transient console, Windows Terminal visibility, or focus stealing. Interactive and restricted-token acceptance remain untested.\n')
  } finally {
    rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  }
}

if (process.argv[1] !== undefined && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  assert(process.argv[2], 'Pass an existing packaged Windows Electron executable')
  verifyPackagedWindowsStartup(process.argv[2])
}
