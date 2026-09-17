/** Browser-only loopback carrier for a smoke-owned Desktop Host; never an application server. */
import { once } from 'node:events'
import { execFile } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ReadableStream as NodeReadableStream } from 'node:stream/web'
import { promisify } from 'node:util'
import type { Locator, Page } from 'playwright'
import type { DesktopHostProcess } from '../src/host-process.ts'
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

/** A private listener forwarding browser bytes to the real Desktop pipe transport. */
export interface DesktopSmokeBridge {
  readonly origin: string
  readonly errors: readonly Error[]
  /** Abort owned streams and await listener/request quiescence. */
  close(): Promise<void>
}

/**
 * Bind one OS-assigned port; forward assets, unary RPC and streaming responses unchanged.
 * @param host - Host started with a smoke-owned profile, never a live Desktop Host.
 * @returns Listening fixture and its asynchronous disposer.
 */
export async function openDesktopSmokeBridge(host: Pick<DesktopHostProcess, 'fetch'>): Promise<DesktopSmokeBridge> {
  const errors: Error[] = []
  const requests = new Map<AbortController, Promise<void>>()
  const server = createServer((incoming, outgoing) => {
    const abort = new AbortController()
    outgoing.once('close', () => { abort.abort() })
    const work = (async () => {
      const method = incoming.method ?? 'GET'
      const headers = new Headers()
      for (let i = 0; i < incoming.rawHeaders.length; i += 2) {
        headers.append(incoming.rawHeaders[i]!, incoming.rawHeaders[i + 1]!)
      }
      const init: RequestInit & { duplex?: 'half' } = {
        method, headers, signal: abort.signal,
        ...(method === 'GET' || method === 'HEAD' ? {} : {
          body: Readable.toWeb(incoming) as ReadableStream<Uint8Array>,
          duplex: 'half' as const,
        }),
      }
      const response = await host.fetch(new Request(`dsh-app://app${incoming.url ?? '/'}`, init))
      outgoing.writeHead(response.status, Object.fromEntries(response.headers))
      if (response.body === null) outgoing.end()
      // Node and DOM declare different BYOB reader generics for the same runtime byte stream.
      else await pipeline(Readable.fromWeb(response.body as NodeReadableStream<Uint8Array>), outgoing)
    })().catch((error: unknown) => {
      if (!abort.signal.aborted) errors.push(error instanceof Error ? error : new Error(String(error)))
      outgoing.destroy()
    }).finally(() => { requests.delete(abort) })
    requests.set(abort, work)
  })
  try {
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
  } catch (error) {
    server.close()
    throw error
  }
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('desktop smoke: listener has no TCP address')
  let closing: Promise<void> | undefined
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    errors,
    close() {
      closing ??= (async () => {
        const closed = new Promise<void>((resolve, reject) => {
          server.close(error => error === undefined ? resolve() : reject(error))
        })
        for (const abort of requests.keys()) abort.abort()
        server.closeAllConnections()
        await Promise.all([...requests.values(), closed])
      })()
      return closing
    },
  }
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
 * @param host - Smoke-owned Host serving the materialized runtime.
 * @param home - Private smoke directory for browser artifacts.
 * @param receipt - Per-run offline authorization receipt.
 * @param channel - Explicit installed Chromium channel, or Playwright's bundled Chromium when omitted.
 * @param evidenceDirectory - Optional run-owned screenshot directory.
 */
export async function smokeDesktopRuntimeBrowser(
  host: Pick<DesktopHostProcess, 'fetch'>,
  home: string,
  receipt: string,
  channel?: string,
  evidenceDirectory?: string,
): Promise<void> {
  const { chromium } = await import('playwright')
  // Windows known-folder resolution expands USERPROFILE independently of APPDATA.
  mkdirSync(join(home, 'AppData', 'Local'), { recursive: true })
  mkdirSync(join(home, 'AppData', 'Roaming'), { recursive: true })
  const bridge = await openDesktopSmokeBridge(host)
  console.log('desktop smoke: launching isolated browser')
  try {
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
    console.log('desktop smoke: browser launched')
    let browserPid: number | undefined
    try {
      if (process.platform === 'win32') {
        const session = await browser.browser()!.newBrowserCDPSession()
        const processes = await session.send('SystemInfo.getProcessInfo') as {
          processInfo: { type: string; id: number }[]
        }
        browserPid = processes.processInfo.find(entry => entry.type === 'browser')?.id
        await session.detach()
        if (browserPid === undefined || !Number.isSafeInteger(browserPid) || browserPid <= 0) {
          throw new Error('desktop smoke: Chromium did not report its owned browser process')
        }
      }
      const failures: string[] = []
      await browser.route('**/*', async (route) => {
        if (new URL(route.request().url()).origin === bridge.origin) await route.continue()
        else {
          failures.push(`unexpected browser request: ${route.request().url()}`)
          await route.abort('blockedbyclient')
        }
      })
      const page = await browser.newPage()
      page.on('pageerror', (error) => { failures.push(error.message) })
      await page.goto(bridge.origin, { waitUntil: 'load' })
      console.log('desktop smoke: browser page loaded')
      try {
        await assertNeutralProviderInBrowser(page, receipt, 30_000, evidenceDirectory)
      } catch (error) {
        throw new Error(`desktop smoke: browser acceptance failed; ${JSON.stringify({
          pageErrors: failures,
          aria: await page.locator('body').ariaSnapshot(),
        })}`, { cause: error })
      }
      // Release the first document's streaming connections before opening the updater document.
      await page.close()
      const updatePage = await browser.newPage()
      updatePage.on('pageerror', (error) => { failures.push(error.message) })
      try {
        await assertDesktopUpdateNoticeInBrowser(updatePage, bridge.origin, 30_000, evidenceDirectory)
      } catch (error) {
        throw new Error(`desktop smoke: update notice acceptance failed (simulated updater, real compiled Web); ${JSON.stringify({
          pageErrors: failures,
          aria: await updatePage.locator('body').ariaSnapshot({ timeout: 1_000 })
            .catch((snapshotError: unknown) => `snapshot unavailable: ${String(snapshotError)}`),
        })}`, { cause: error })
      } finally {
        await updatePage.close()
      }
      if (failures.length > 0) throw new Error(`desktop smoke: browser errors: ${failures.join('; ')}`)
      if (bridge.errors.length > 0) throw new AggregateError(bridge.errors, 'desktop smoke: browser carrier failed')
      if (evidenceDirectory !== undefined) {
        writeFileSync(join(evidenceDirectory, 'browser-provenance.json'), JSON.stringify({
          origin: bridge.origin,
          viewport: { width: 1680, height: 1000 },
          capture: 'five screenshots from two acceptance pages in one isolated browser and Host run',
          states: [
            'provider visible and unauthorized', 'neutral authorization succeeded', 'authorized receipt restored after reload',
            'real compiled Web update notice with simulated available version 0.1.5-rc.3.cloga.7 after Later review',
            'available snapshot restored after reload; real theme responds to emulated dark color-scheme media',
          ],
          desktopUpdateNotice: {
            screenshot: '03-desktop-update-notice.png',
            darkScreenshot: '04-desktop-update-notice-dark.png',
            darkTheme: 'real theme media-query response; no injected CSS or token overrides',
            composition: 'real compiled full Web composition served by the isolated Desktop Host byte-pipe carrier',
            fixture: 'Electron window.dshDesktop protocol-v2 bridge only; simulated updater state and Later review',
            verified: ['idle absent', 'available status/version', 'composer focus retained', 'above main panel without overlap',
              'exactly one review and notice retained', 'available snapshot restored on reload',
              'dark theme notice without overlap', 'idle releases layout space'],
            realUpdateCheck: false,
            realUpdateDownload: false,
            realUpdateInstalled: false,
            realRestart: false,
          },
          continuousVideo: false,
          realModelRound: false,
          realAuthenticationService: false,
        }, undefined, 2) + '\n')
      }
    } finally {
      console.log('desktop smoke: closing browser')
      try {
        // Windows IME helpers can outlive a normal Chromium close and retain fixture files.
        if (browserPid !== undefined) await stopWindowsBrowserTree(browserPid, home)
      } finally {
        await browser.close()
      }
      console.log('desktop smoke: browser closed')
    }
  } finally {
    console.log('desktop smoke: closing bridge')
    await bridge.close()
    console.log('desktop smoke: bridge closed')
  }
}
