/** Windows PowerShell behavior regression: execute source helper functions, never real GUI automation. */
import { spawn } from 'node:child_process'
import { closeSync, mkdtempSync, openSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { desktopSmokeEnvironment } from '../scripts/smoke-environment.ts'
import { removeOwnedDirectory } from '../src/owned-directory.ts'

it.skipIf(process.platform !== 'win32').each(['discovery', 'providers'] as const)('validates native %s without querying the real desktop', async (mode) => {
  const home = mkdtempSync(join(tmpdir(), 'desktop-native-discovery-'))
  const environment = desktopSmokeEnvironment(home)
  const powershell = join(environment.SystemRoot ?? environment.SYSTEMROOT ?? 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const stdoutPath = join(home, 'stdout.txt')
  const stderrPath = join(home, 'stderr.txt')
  const descriptors: number[] = []
  let spawnAttempted = false
  let completedNormally = false
  try {
    const stdout = openSync(stdoutPath, 'wx', 0o600)
    descriptors.push(stdout)
    const stderr = openSync(stderrPath, 'wx', 0o600)
    descriptors.push(stderr)
    spawnAttempted = true
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File',
      fileURLToPath(new URL('./fixtures/desktop-plugin-native-discovery-regression.ps1', import.meta.url)),
      '-SourceFile', fileURLToPath(new URL('./fixtures/desktop-plugin-native-cancel.ps1', import.meta.url)),
      ...(mode === 'providers' ? ['-InitializeProvidersOnly'] : [])],
    { cwd: home, env: environment, windowsHide: true, stdio: ['ignore', stdout, stderr] })
    let timedOut = false
    let spawnError: Error | undefined
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
      child.once('error', (error) => { spawnError = error })
      child.once('close', (code, signal) => { resolveClose({ code, signal }) })
    })
    // Bound the external helper independently of Vitest; kill is followed by awaited close.
    const timer = setTimeout(() => { timedOut = true; child.kill() }, 90_000)
    let outcome: Awaited<typeof closed>
    try { outcome = await closed } finally { clearTimeout(timer) }
    if (timedOut || spawnError !== undefined || outcome.signal !== null || outcome.code !== 0) {
      throw new Error(`PowerShell discovery regression did not complete normally; private home retained: ${home}\n${JSON.stringify({
        timedOut, exitCode: outcome.code, signal: outcome.signal, spawnError: spawnError?.message,
        stderr: readFileSync(stderrPath, 'utf8'),
      })}`)
    }
    completedNormally = true // Add-Type completes its compiler synchronously on this normal path.
    const result: unknown = JSON.parse(readFileSync(stdoutPath, 'utf8').replace(/^\uFEFF/u, ''))
    expect(result).toEqual(mode === 'providers'
      ? { providersRegistered: true, buttonProxyRegistered: true, realGuiUsed: false }
      : { passed: [
        'native-dialog-omitted-from-uia-root', 'wrong-pid', 'wrong-root-owner', 'main-hwnd',
        'missing-cancel', 'missing-apply', 'missing-message', 'wrong-case-cancel', 'not-a-button', 'duplicate-cancel',
        'canonical-handle-mismatch', 'ambiguous-dialogs', 'ambiguous-reversed-order', 'reenumeration-observes-new-ambiguity',
      ],
      realGuiUsed: false,
      nativeInvokeAvailable: false,
      })
  } finally {
    for (const descriptor of descriptors) closeSync(descriptor)
    // An abnormal helper may leave an Add-Type compiler child: root close alone is not tree quiescence.
    if (!spawnAttempted || completedNormally) removeOwnedDirectory(home)
  }
}, 120_000) // Includes the helper's 90-second deadline and awaited close; no GUI startup is involved.
