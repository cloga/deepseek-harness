/** Browser acceptance against the official Web-backed, smoke-owned Desktop Host. */
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { Locator, Page } from 'playwright'
import { desktopSmokeEnvironment } from './smoke-environment.ts'
import { assertDesktopUpdateNoticeInBrowser } from './smoke-update-notice.ts'

const execFileAsync = promisify(execFile)

async function stopWindowsBrowserTree(pid: number, home: string): Promise<void> {
  const systemRoot = process.env['SystemRoot'] ?? process.env['SYSTEMROOT']
  if (systemRoot === undefined) throw new Error('desktop smoke: Windows system directory is unavailable')
  const userData = join(home, 'browser').replaceAll("'", "''")
  const command = [
    '$ErrorActionPreference = "Stop"',
    '$snapshot = @(Get-CimInstance Win32_Process)',
    `$root = $snapshot | Where-Object { $_.ProcessId -eq ${String(pid)} }`,
    'if ($null -eq $root -or $null -eq $root.CommandLine '
      + `-or $root.CommandLine.IndexOf('${userData}', [StringComparison]::OrdinalIgnoreCase) -lt 0) `
      + '{ throw "Owned browser process identity changed" }',
    '$ids = [System.Collections.Generic.HashSet[int]]::new()',
    `[void]$ids.Add(${String(pid)})`,
    'do { $added = $false; foreach ($item in $snapshot) {',
    'if ($ids.Contains([int]$item.ParentProcessId) -and $ids.Add([int]$item.ProcessId)) { $added = $true }',
    '} } while ($added)',
    '$owned = @($ids | ForEach-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })',
    'foreach ($process in $owned) { if (!$process.HasExited) { Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue } }',
    'foreach ($process in $owned) { if (!$process.WaitForExit(10000)) { throw "Owned browser process did not exit" } }',
  ].join('; ')
  await execFileAsync(join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { env: desktopSmokeEnvironment(home), windowsHide: true })
}

/**
 * Accept only a private HTTP endpoint reported by the smoke-owned Host.
 * @param readyUrl - Authentication URL; never written to evidence.
 * @returns Origin allowed by browser network containment.
 */
export function desktopSmokeOrigin(readyUrl: string): string {
  const url = new URL(readyUrl)
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.port === ''
    || url.username !== '' || url.password !== '') {
    throw new Error('desktop smoke: expected an explicit loopback Host port')
  }
  return url.origin
}

/**
 * Exercise the shipped Settings/Models page, including a Host-written authorization result.
 * @param page - Fresh browser page after its real client loader has booted.
 * @param receipt - Unique receipt expected from this isolated Host.
 * @param timeout - Bound for each observable UI transition.
 * @param evidenceDirectory - Optional run-owned directory for screenshots; publish only after the whole smoke succeeds.
 */
export async function assertNeutralProviderInBrowser(
  page: Page,
  receipt: string,
  timeout = 30_000,
  evidenceDirectory?: string,
): Promise<void> {
  page.setDefaultTimeout(timeout)
  const openCard = async (): Promise<Locator> => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
    await dialog.getByRole('button', { name: 'Models', exact: true }).click()
    await dialog.getByText('Desktop neutral provider', { exact: true }).waitFor({ state: 'visible' })
    return dialog.getByRole('region', { name: 'Neutral fixture authorization' })
  }
  const capture = async (name: string): Promise<void> => {
    if (evidenceDirectory === undefined) return
    mkdirSync(evidenceDirectory, { recursive: true })
    await page.screenshot({ path: join(evidenceDirectory, name), animations: 'disabled' })
  }
  const card = await openCard()
  await card.locator('[data-neutral-auth-status="unauthorized"]').waitFor({ state: 'visible' })
  await capture('00-neutral-provider.png')
  await card.getByRole('button', { name: 'Authorize neutral fixture', exact: true }).click()
  const authorized = `[data-neutral-auth-status="authorized"][data-neutral-auth-receipt="${receipt}"]`
  await card.locator(authorized).waitFor({ state: 'visible' })
  await card.getByText('Neutral authorization succeeded', { exact: true }).waitFor({ state: 'visible' })
  await capture('01-neutral-authorized.png')
  await page.reload({ waitUntil: 'load' })
  const restored = await openCard()
  await restored.locator(authorized).waitFor({ state: 'visible' })
  await capture('02-neutral-authorization-restored.png')
}

/**
 * Launch an isolated Chromium profile and execute the packaged frontend, not a test-built UI.
 * @param readyUrl - Authentication URL from the smoke-owned Host's readiness message.
 * @param home - Private smoke directory for browser artifacts.
 * @param receipt - Per-run offline authorization receipt.
 * @param channel - Explicit installed Chromium channel, or Playwright's bundled Chromium when omitted.
 * @param evidenceDirectory - Optional run-owned screenshot directory.
 */
export async function smokeDesktopRuntimeBrowser(
  readyUrl: string,
  home: string,
  receipt: string,
  channel?: string,
  evidenceDirectory?: string,
): Promise<void> {
  const origin = desktopSmokeOrigin(readyUrl)
  const { chromium } = await import('playwright')
  mkdirSync(join(home, 'AppData', 'Local'), { recursive: true })
  mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })
  const browser = await chromium.launchPersistentContext(join(home, 'browser'), {
    headless: true,
    env: desktopSmokeEnvironment(home),
    ...(channel === undefined ? {} : { channel }),
    locale: 'en-US',
    viewport: { width: 1680, height: 1000 },
    downloadsPath: join(home, 'downloads'),
    tracesDir: join(home, 'traces'),
    serviceWorkers: 'block',
  })
  let browserPid: number | undefined
  try {
    if (process.platform === 'win32') {
      const session = await browser.browser()!.newBrowserCDPSession()
      try {
        const processes = await session.send('SystemInfo.getProcessInfo') as { processInfo: { type: string; id: number }[] }
        browserPid = processes.processInfo.find(entry => entry.type === 'browser')?.id
        if (browserPid === undefined || !Number.isSafeInteger(browserPid) || browserPid <= 0) {
          throw new Error('desktop smoke: Chromium did not report its owned browser process')
        }
      } finally { await session.detach() }
    }
    const failures: string[] = []
    await browser.route('**/*', async (route) => {
      if (new URL(route.request().url()).origin === origin) await route.continue()
      else {
        failures.push(`unexpected browser request origin: ${new URL(route.request().url()).origin}`)
        await route.abort('blockedbyclient')
      }
    })
    const page = await browser.newPage()
    page.on('pageerror', (error) => { failures.push(error.message) })
    await page.goto(readyUrl, { waitUntil: 'load' })
    try {
      await assertNeutralProviderInBrowser(page, receipt, 30_000, evidenceDirectory)
    } catch (error) {
      throw new Error(`desktop smoke: browser acceptance failed; ${JSON.stringify({
        pageErrors: failures,
        aria: await page.locator('body').ariaSnapshot(),
      })}`, { cause: error })
    }
    await page.close()
    const updatePage = await browser.newPage()
    updatePage.on('pageerror', (error) => { failures.push(error.message) })
    try {
      await assertDesktopUpdateNoticeInBrowser(updatePage, origin, 30_000, evidenceDirectory)
    } finally { await updatePage.close() }
    if (failures.length > 0) throw new Error(`desktop smoke: browser errors: ${failures.join('; ')}`)
    if (evidenceDirectory !== undefined) {
      writeFileSync(join(evidenceDirectory, 'browser-evidence.json'), JSON.stringify({
        origin,
        viewport: { width: 1680, height: 1000 },
        transport: 'official Web-backed Desktop Host; no byte-pipe proxy',
        capture: 'five screenshots from two acceptance pages in one isolated browser and Host run',
        states: ['provider unauthorized', 'neutral authorization succeeded', 'authorization restored after reload',
          'official update indicator and collapsed badge', 'official update error indicator in real dark theme'],
        realUpdateCheck: false,
        realUpdateDownload: false,
        realUpdateInstalled: false,
        realRestart: false,
        realModelRound: false,
        realAuthenticationService: false,
      }, undefined, 2) + '\n')
    }
  } finally {
    try {
      // Windows IME helpers can outlive a normal Chromium close and retain fixture files.
      if (browserPid !== undefined) await stopWindowsBrowserTree(browserPid, home)
    } finally { await browser.close() }
  }
}
