import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { expect, it, onTestFinished } from 'vitest'

const desktopRequire = createRequire(new URL('../package.json', import.meta.url))

interface DocumentObservation {
  url: string
  documentId: string
  nodeAvailable: boolean
}

interface Receipt {
  timedOut: boolean
  stage: string
  electronVersion: string
  packaged: boolean
  preferences: { sandbox: boolean; contextIsolation: boolean; nodeIntegration: boolean }
  initialDocument: DocumentObservation
  ownedDocument: DocumentObservation
  cases: {
    name: string
    externalUrls: string[]
    navigationEvents: { url: string; prevented: boolean }[]
    rendererResult: boolean | null
    document: DocumentObservation
    windowCount: number
  }[]
  createdWindows: number
  blockedRequests: string[]
  openFailures: number
  recoveries: string[]
  remainingWindows: number
  error?: string
}

interface Exit {
  code: number | null
  signal: NodeJS.Signals | null
  error?: Error
}

async function bounded<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => { reject(new Error(message)) }, milliseconds)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}

function isolatedEnvironment(root: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {}
  // Allowlist only OS plumbing: no credentials, NODE_OPTIONS, Electron overrides, or inherited DSH state.
  const allowed = /^(?:systemroot|systemdrive|windir|comspec|path|pathext|number_of_processors|processor_architecture|os)$/iu
  for (const [key, value] of Object.entries(process.env)) {
    if (allowed.test(key)) environment[key] = value
  }
  return {
    ...environment,
    HOME: root,
    USERPROFILE: root,
    APPDATA: join(root, 'app-data'),
    LOCALAPPDATA: join(root, 'local-app-data'),
    TEMP: join(root, 'tmp'),
    TMP: join(root, 'tmp'),
    DSH_HOME: join(root, 'harness-home'),
  }
}

async function developmentElectron(): Promise<{ binary: string; version: string }> {
  const lock = await readFile(new URL('../../../pnpm-lock.yaml', import.meta.url), 'utf8')
  const version = /^ {6}electron:\r?\n {8}specifier: [^\r\n]+\r?\n {8}version: ([\d.]+)/mu.exec(lock)?.[1]
  if (!version) throw new Error('The Electron version must be declared in pnpm-lock.yaml')
  // Electron 44's npm entry auto-downloads missing binaries. Resolve metadata only; never require('electron').
  const binary = process.env.DSH_DESKTOP_NAVIGATION_ELECTRON_BINARY
    ?? join(dirname(desktopRequire.resolve('electron/package.json')), 'dist', 'electron.exe')
  if (basename(binary).toLowerCase() !== 'electron.exe') {
    throw new Error('DSH_DESKTOP_NAVIGATION_ELECTRON_BINARY must name a development electron.exe, not the installed app')
  }
  try {
    await access(binary)
    await access(join(dirname(binary), 'resources', 'default_app.asar'))
    const materializedVersion = (await readFile(join(dirname(binary), 'version'), 'utf8')).trim().replace(/^v/u, '')
    expect(materializedVersion, 'Development Electron must match the current lockfile').toBe(version)
  } catch (error) {
    throw new Error(`Matching development Electron is not prepared at ${binary}; prepare it explicitly, never use the installed Desktop`, { cause: error })
  }
  return { binary, version }
}

// This Windows release acceptance lane does not assume a display server on Linux/macOS CI.
// Other platforms retain policy unit coverage; a Windows missing-binary error is never a skip.
it.skipIf(process.platform !== 'win32')('dispatches real Electron navigation through the production policy without launching an OS browser', {
  // Nested bounds: fixture 45s, process 60s, tree teardown <=15s, outer test 90s.
  timeout: 90_000,
}, async () => {
  const { binary, version } = await developmentElectron()
  const root = await mkdtemp(join(tmpdir(), 'dsh-navigation-electron-'))
  let child: ChildProcess | undefined
  let closed: Promise<Exit> | undefined
  let cleanupPromise: Promise<void> | undefined
  const cleanup = (): Promise<void> => cleanupPromise ??= (async () => {
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT
      if (!systemRoot) throw new Error('SystemRoot is required to terminate the owned Electron process tree')
      const kill = spawnSync(join(systemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, stdio: 'ignore', timeout: 10_000,
      })
      if (kill.error) throw kill.error
      // The child can exit between the state check and taskkill; its close event remains authoritative.
    }
    if (closed) await bounded(closed, 5_000, 'Owned Electron process did not reach teardown quiescence')
    // NTFS can release Chromium file handles asynchronously after process exit.
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
  })()
  onTestFinished(cleanup, 20_000)

  try {
    await chmod(root, 0o700)
    for (const directory of ['app-data', 'local-app-data', 'tmp', 'harness-home', 'user-data', 'session-data', 'logs', 'crash-dumps']) {
      await mkdir(join(root, directory), { mode: 0o700 })
    }
    // Source-plane fixture: transpile ONLY the current registration helper, never build/load Core or main.ts.
    const { default: ts } = await import('typescript')
    const source = await readFile(new URL('../src/window-navigation.ts', import.meta.url), 'utf8')
    const transformed = ts.transpileModule(source, {
      fileName: 'window-navigation.ts',
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      reportDiagnostics: true,
    })
    expect(transformed.diagnostics?.filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error)).toEqual([])
    await writeFile(join(root, 'window-navigation.mjs'), transformed.outputText, { flag: 'wx', mode: 0o600 })
    const fixture = await readFile(new URL('./fixtures/window-navigation-electron.mjs', import.meta.url), 'utf8')
    const entry = join(root, 'fixture.mjs')
    await writeFile(entry, fixture, { flag: 'wx', mode: 0o600 })
    child = spawn(binary, [entry, root, version], {
      cwd: root, env: isolatedEnvironment(root), stdio: 'ignore', windowsHide: true,
    })
    closed = new Promise<Exit>((resolve) => {
      child!.once('error', (error) => { resolve({ code: null, signal: null, error }) })
      child!.once('close', (code, signal) => { resolve({ code, signal }) })
    })
    // A deadline rejects separately, before any exit-status assertion; finally kills and awaits the owned tree.
    const exit = await bounded(closed, 60_000, 'Electron navigation fixture exceeded its process deadline')
    expect(exit.error).toBeUndefined()
    expect(exit.signal, 'Electron must exit normally, not through cancellation').toBeNull()
    // Read the owned file externally, rather than trusting console output or a component success message.
    const receipt = JSON.parse(await readFile(join(root, 'receipt.json'), 'utf8')) as Receipt
    expect(receipt.timedOut, `Electron fixture deadline during ${receipt.stage}`).toBe(false)
    expect(receipt.error).toBeUndefined()
    expect(exit.code, 'Electron fixture must exit successfully').toBe(0)
    expect(receipt.electronVersion).toBe(version)
    expect(receipt.packaged).toBe(false)
    expect(receipt.preferences).toEqual({ sandbox: true, contextIsolation: true, nodeIntegration: false })
    expect(receipt.initialDocument).toEqual({
      url: 'dsh-app://navigation-test/index.html', documentId: '1', nodeAvailable: false,
    })
    const externalCases = [
      ['chat-https', 'https://example.invalid/chat'],
      ['chat-http', 'http://example.invalid/chat'],
      ['oauth-https', 'https://example.invalid/device'],
      ['oauth-http', 'http://example.invalid/device'],
      ['window-open-https', 'https://example.invalid/script'],
      ['window-open-http', 'http://example.invalid/script'],
    ]
    expect(receipt.cases.map(result => result.name)).toEqual([
      ...externalCases.map(([name]) => name), 'popup-about', 'popup-data', 'blocked-self',
    ])
    for (const [name, url] of externalCases) {
      const result = receipt.cases.find(result => result.name === name)!
      expect(result.externalUrls, `${name}: exactly one OS-opener invocation`).toEqual([url])
      expect(result.navigationEvents).toEqual(name!.startsWith('oauth-') ? [{ url, prevented: true }] : [])
    }
    for (const result of receipt.cases) {
      expect(result.document, `${result.name}: preserve the app document`).toEqual(receipt.initialDocument)
      expect(result.windowCount).toBe(1)
      if (result.name.startsWith('window-open-') || result.name.startsWith('popup-')) {
        expect(result.rendererResult, `${result.name}: Chromium must receive a denied popup`).toBe(true)
      }
      if (result.name.startsWith('popup-') || result.name === 'blocked-self') expect(result.externalUrls).toEqual([])
    }
    expect(receipt.cases.find(result => result.name === 'blocked-self')!.navigationEvents).toEqual([
      { url: 'navigation-forbidden://navigation-test/blocked', prevented: true },
    ])
    expect(receipt.ownedDocument).toEqual({
      url: 'dsh-app://navigation-test/next.html', documentId: '2', nodeAvailable: false,
    })
    expect(receipt.createdWindows).toBe(0)
    expect(receipt.blockedRequests, 'No network request should reach even the fixture safety net').toEqual([])
    expect(receipt.openFailures).toBe(0)
    expect(receipt.recoveries).toEqual([])
    expect(receipt.remainingWindows).toBe(0)
  } finally {
    await cleanup()
  }
})
