/** Packaged command-only acceptance. Independent of the no-Session Copilot account smoke.
 * Run only on an interactive Windows CI desktop with a freshly packaged application.
 * No model prompt/sign-in/settings mutation; staging CAN use frozen pnpm and network.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import type { Browser, Page } from 'playwright'
import type { SpawnedJobProcess } from '@deepseek-ai/dsh-win32-process/src/index.ts'
import {
  createDesktopPluginCommandOutcome, finalizeDesktopPluginCommandAcceptance,
  parseDesktopDevToolsPort, remainingDeadline, validateDesktopPageTitle, validateDesktopPluginCancelAudit,
  validateDesktopPluginCommandRun, validateDesktopWindowCapture, waitForOwnedJobExit, withinDeadline,
} from './desktop-plugin-command-guards.ts'
import type { CommandDescriptor, CommandExecution } from '@deepseek-ai/dsh-commands/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { parseSessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'
import { desktopSmokeEnvironment } from '../../scripts/smoke-environment.ts'
import { removeOwnedDirectory } from '../../src/owned-directory.ts'

const APPLICATION_URL = 'dsh-app://app/'
const repository = fileURLToPath(new URL('../../../../', import.meta.url))
const PREPARED = 'Plugin change prepared. Review the native confirmation to restart the Desktop Host.'
const SAFE_FAILURE = 'Desktop could not prepare the plugin change. Review Desktop diagnostics for details.'
const BUSY = 'Another Desktop plugin, recovery, or update operation is in progress.'
const METADATA = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'desktop.cordis.yml',
  'desktop-runtime-state.json', 'desktop-plugin-receipts.json', 'desktop-plugin-package-locks.json',
  'desktop-plugin-provisioning-state.json', 'desktop-plugin-user-intents.json',
  'cordis.yml', 'cordis.patch.yml', '.env', 'profile.env', 'desktop-packages-pending',
] as const

/** Only a packaged executable and caller-selected evidence destination are accepted. */
export interface PackagedDesktopPluginCommandOptions {
  readonly application: string
  readonly output: string
}
interface ProcessIdentity { readonly pid: number; readonly created: string; readonly executable: string }
interface Ownership {
  readonly main: ProcessIdentity
  readonly host: ProcessIdentity
  readonly mainHwnd: string
  readonly mainWindow: unknown
  readonly home: string
  readonly hostEntry: string
  readonly profile: string
}
interface ExpectedCommand { readonly line: string; readonly execution: CommandExecution }
interface HelperLifecycle { helperTreeUncertain: boolean; nativeObservations: string[] }

/**
 * Provide EOF stdin without depending on Windows device-name normalization.
 * @param home - Existing fixture-owned private directory.
 * @returns Exclusively created empty-file descriptor; the caller must close it.
 */
export function openDesktopPluginInput(home: string): number {
  return openSync(join(home, 'electron.stdin'), 'wx+', 0o600)
}

/**
 * Admit home deletion only when every attempted launch has known, settled ownership.
 * @param state - App Job proof plus the independent native-helper uncertainty latch.
 * @returns Whether all fixture process ownership is sufficiently proved for home removal.
 */
export function canRemoveDesktopPluginHome(state: {
  readonly spawnAttempted: boolean
  readonly jobOwned: boolean
  readonly jobQuiescent: boolean
  readonly helperTreeUncertain: boolean
}): boolean {
  return !state.helperTreeUncertain && (state.jobOwned
    ? state.jobQuiescent
    : !state.spawnAttempted)
}

/**
 * Hash actual retained bytes, including absence, without traversing dependencies or links.
 * @param profile - Fixture-owned active Desktop profile.
 * @returns Canonical metadata/artifact names with SHA-256 values or explicit absence.
 */
export function snapshotDesktopPluginProfile(profile: string): Readonly<Record<string, string | null>> {
  const result: Record<string, string | null> = {}
  const hash = (name: string): void => {
    const path = join(profile, name)
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat === undefined) { result[name] = null; return }
    assert(stat.isFile() && !stat.isSymbolicLink(), `Expected regular owned metadata: ${name}`)
    result[name] = createHash('sha256').update(readFileSync(path)).digest('hex')
  }
  for (const name of METADATA) hash(name)
  const artifacts = join(profile, '.desktop-plugin-artifacts')
  const stat = lstatSync(artifacts, { throwIfNoEntry: false })
  result['.desktop-plugin-artifacts/'] = stat === undefined ? null : 'directory'
  if (stat !== undefined) {
    assert(stat.isDirectory() && !stat.isSymbolicLink(), 'Artifact directory must not be a link')
    for (const name of readdirSync(artifacts).sort()) hash(`.desktop-plugin-artifacts/${name}`)
  }
  return result
}

/**
 * Validate the exported root generation, ordered lifecycle pairing, and absence of all inference work.
 * @param filename - Root ZIP entry, parsed with the repository's canonical generation parser.
 * @param jsonl - Exported durable Session bytes decoded as UTF-8.
 * @param sessionId - Exact unique Session created by this fixture.
 * @param expected - Executions observed through the supported command RPC.
 * @returns A bounded summary; no guessed Session storage path is read.
 */
export function validateDesktopPluginTranscript(
  filename: string, jsonl: string, sessionId: string, expected: readonly ExpectedCommand[],
): { filename: string; sessionId: string; commands: number; eventTypes: string[]; sha256: string } {
  const version = parseSessionFormatLogFilename(filename)
  assert.notEqual(version, undefined, 'Export must contain a canonical root generation filename')
  const [header, ...events] = jsonl.trim().split('\n').map(line => JSON.parse(line) as unknown) as [
    { type: string; version: number; id: string; parentSession?: unknown }, ...SessionEvent[],
  ]
  assert.equal(header.type, 'session')
  assert.equal(header.version, version)
  assert.equal(header.id, sessionId)
  assert.equal(header.parentSession, undefined, 'Export must be the root Session, not a descendant')
  for (const event of events) {
    assert(!/^(?:user\/message|assistant\/|turn\/|step\/|request\/|model\/|llm\/|tool\/|task\/|task-run\/)/u.test(event.type),
      `Command-only Session unexpectedly contains ${event.type}`)
  }
  const lifecycle = events.filter(event => event.type === 'command/run' || event.type === 'command/done')
  assert.equal(lifecycle.length, expected.length * 2, 'Every invocation has exactly one run and one done; Cancel adds no second done')
  const ids = new Set<string>()
  expected.forEach(({ line, execution }, index) => {
    const run = lifecycle[index * 2]
    const done = lifecycle[index * 2 + 1]
    assert(run?.type === 'command/run' && done?.type === 'command/done')
    assert.equal(run.data.commandId, execution.commandId)
    assert.equal(done.data.commandId, execution.commandId)
    assert(!ids.has(execution.commandId), 'Command IDs must be unique')
    ids.add(execution.commandId)
    assert.equal(run.data.name, 'desktop-plugin')
    assert.equal(run.data.args, line.slice('/desktop-plugin'.length))
    assert.deepEqual(run.data.source, { kind: 'user' })
    assert.equal(done.data.kind, execution.result.kind)
    assert.equal(done.data.text, execution.result.text)
    assert(run.seq < done.seq, 'Completion follows its matching invocation')
  })
  return { filename, sessionId, commands: expected.length, eventTypes: [...new Set(events.map(event => event.type))],
    sha256: createHash('sha256').update(jsonl).digest('hex') }
}

function safeDiagnostic(value: unknown): string {
  return String(value).replace(/(https?:\/\/[^?\s"'<>]+)\?[^\s"'<>]*/gu, '$1?[redacted]')
    .replace(/((?:authorization|token|password|secret|api[_-]?key)\s*[:=]\s*)(?:bearer\s+|token\s+)?[^\s,"'<>]+/giu, '$1[redacted]')
}

/**
 * Read bounded fixture-only native scan evidence after the helper closes, including abnormal exits.
 * @param path - Observation file beside the exclusively created helper request.
 * @returns Sanitized JSONL text or a fixed read diagnostic, never success evidence or a replacement failure.
 */
export function readDesktopPluginNativeObservations(path: string): string {
  try {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (stat === undefined) return 'Native observation file absent'
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144) return 'Native observation file rejected: not bounded regular file'
    return safeDiagnostic(readFileSync(path, 'utf8'))
  } catch (_error: unknown) {
    // Best-effort evidence cannot replace the helper's independently observed exit/timeout.
    return 'Native observation file unreadable'
  }
}

/** Each helper owns one bounded child; output uses exclusive files, not ambient pipes or credentials. */
async function nativeHelper<T>(
  home: string, environment: Record<string, string>, request: object, lifecycle: HelperLifecycle,
  deadline = performance.now() + 90_000,
): Promise<T> {
  const timeout = remainingDeadline(deadline)
  const prefix = join(home, `native-${randomUUID()}`)
  const input = `${prefix}.request.json`
  writeFileSync(input, JSON.stringify(request), { flag: 'wx', mode: 0o600 })
  const stdout = openSync(`${prefix}.stdout`, 'wx', 0o600)
  let stderr: number | undefined
  let spawnAttempted = false
  let closedNormally = false
  const failure = createDesktopPluginCommandOutcome()
  let result!: T
  try {
    stderr = openSync(`${prefix}.stderr`, 'wx', 0o600)
    const executable = join(environment.SystemRoot ?? environment.SYSTEMROOT ?? 'C:\\Windows',
      'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
    spawnAttempted = true
    const child = spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'RemoteSigned', '-File',
      fileURLToPath(new URL('./desktop-plugin-native-cancel.ps1', import.meta.url)), '-RequestFile', input],
    { cwd: home, env: environment, stdio: ['ignore', stdout, stderr], windowsHide: true })
    let timedOut = false
    let spawnError: Error | undefined
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveClose) => {
      child.once('error', (error) => { spawnError = error })
      child.once('close', (code, signal) => { resolveClose({ code, signal }) })
    })
    // This external helper is independently owned; it is never counted as an app Job member.
    const timer = setTimeout(() => { timedOut = true; child.kill() }, timeout)
    let outcome: Awaited<typeof closed>
    try { outcome = await closed } finally { clearTimeout(timer) }
    const observations = `${input}.observations.jsonl`
    if (existsSync(observations)) lifecycle.nativeObservations.push(readDesktopPluginNativeObservations(observations))
    if (timedOut || spawnError !== undefined || outcome.signal !== null || outcome.code !== 0) {
      throw new Error(`Native helper failed after awaiting close: ${JSON.stringify({ timedOut,
        exitCode: outcome.code, signal: outcome.signal, spawnError: spawnError === undefined ? undefined : safeDiagnostic(spawnError),
        stderr: readDesktopPluginNativeObservations(`${prefix}.stderr`) })}`)
    }
    remainingDeadline(deadline)
    result = JSON.parse(readFileSync(`${prefix}.stdout`, 'utf8').replace(/^\uFEFF/u, '')) as T
    closedNormally = true
  } catch (error) {
    failure.retain(error)
  } finally {
    // Add-Type may own a compiler child outside the app Job. Only normal helper completion
    // admits its synchronous compiler lifecycle; an abnormal parent close is NOT tree quiescence.
    if (spawnAttempted && !closedNormally) lifecycle.helperTreeUncertain = true
    for (const fd of [stdout, stderr]) {
      if (fd !== undefined) {
        try { closeSync(fd) } catch (error) {
          lifecycle.helperTreeUncertain = true
          failure.retain(error)
        }
      }
    }
  }
  if (failure.failed) throw failure.primary
  return result
}

/** POST only known, supported generated unary routes; no prompt fallback. */
async function remote<T>(page: Page, method: 'session/create' | 'commands/list' | 'commands/execute', args: object,
  deadline = performance.now() + 300_000): Promise<T> {
  const rpcId = `desktop-plugin-smoke-${randomUUID()}`
  const body = await withinDeadline(deadline, remaining => page.evaluate(async ({ method, args, rpcId, remaining }) => {
    const response = await fetch(`dsh-app://app/api/${method}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(remaining),
      body: JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } }),
    })
    if (!response.ok) throw new Error(`${method}: HTTP ${response.status}`)
    return await response.json() as {
      type: string
      rpcId: string
      result: { ok: boolean; value?: unknown; error?: { code: string; message: string } }
    }
  }, { method, args, rpcId, remaining }))
  assert.equal(body.type, 'server-response', 'Expected supported unary RPC envelope')
  assert.equal(body.rpcId, rpcId, 'RPC response must match this exact invocation')
  assert.equal(body.result.ok, true, `${method}: ${safeDiagnostic(body.result.error?.code)}`)
  return body.result.value as T
}

function transactionNames(profile: string): string[] {
  return readdirSync(dirname(profile)).filter(name => name.startsWith('.desktop.package-stage-')).sort()
}

function readJournal(path: string): unknown {
  const stat = lstatSync(path)
  assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 16 * 1024 * 1024, 'Expected bounded regular private journal')
  return JSON.parse(readFileSync(path, 'utf8')) as unknown
}

async function exportTranscript(page: Page, home: string, sessionId: string, expected: readonly ExpectedCommand[]) {
  const deadline = performance.now() + 30_000
  const bytes = await withinDeadline(deadline, remaining => page.evaluate(async ({ id, remaining }) => {
    const response = await fetch(`dsh-app://app/api/session.export?sessionId=${encodeURIComponent(id)}&includeDescendants=false`,
      { signal: AbortSignal.timeout(remaining) })
    if (!response.ok || !response.headers.get('content-type')?.includes('application/zip')) throw new Error('Session ZIP export failed')
    const bytes = new Uint8Array(await response.arrayBuffer())
    if (bytes.length > 4 * 1024 * 1024) throw new Error('Command-only export unexpectedly large')
    return Array.from(bytes)
  }, { id: sessionId, remaining }))
  const directory = mkdtempSync(join(home, 'command-export-'))
  const archive = join(directory, 'export.zip')
  writeFileSync(archive, new Uint8Array(bytes), { flag: 'wx', mode: 0o600 })
  const extractZip = (await import('extract-zip')).default
  const extracted = join(directory, 'decoded')
  await extractZip(archive, { dir: extracted })
  const files = readdirSync(extracted)
  assert.equal(files.length, 1, 'Command-only root export must contain only its generation JSONL')
  const filename = files[0]
  assert(filename !== undefined)
  const log = readFileSync(join(extracted, filename), 'utf8')
  return validateDesktopPluginTranscript(filename, log, sessionId, expected)
}

/**
 * Real packaged Electron + supported browser RPC + ownership-bound Windows native Cancel.
 * @param options - Newly packaged executable and evidence destination (never the installed application).
 * @returns Resolves after acceptance and quiescent owned cleanup; hosted execution is required.
 */
export async function runPackagedDesktopPluginCommandAcceptance(options: PackagedDesktopPluginCommandOptions): Promise<void> {
  assert.equal(process.platform, 'win32', 'Native Cancel acceptance requires interactive Windows')
  const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim()
  const sourceTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repository, encoding: 'utf8' }).trim()
  const identity = validateDesktopPluginCommandRun(sourceCommit, sourceTree, process.env)
  const application = resolve(options.application)
  const outputRoot = resolve(options.output)
  mkdirSync(outputRoot, { recursive: true })
  const output = mkdtempSync(join(outputRoot, 'desktop-plugin-command-'))
  const { chromium } = await import('playwright')
  // Native Koffi and Win32 DLL loading is acceptance-only, never an import-time side effect.
  const win32 = await import('@deepseek-ai/dsh-win32-process/src/index.ts')
  const { buildCommandLine } = await import('@deepseek-ai/dsh-win32-process/src/process.ts')
  const api = win32.loadWin32ProcessBindings()
  const { parseDesktopForkReleasePlan, createDesktopForkReleaseCapability } = await import('../../scripts/fork-release.ts')
  const { readDesktopPluginProvisioningPlan } = await import('../../src/plugin-provisioning.ts')
  const { assertDesktopProvisioningInventory } = await import('../../src/plugin-receipts.ts')
  const { packagedDesktopRuntimeRoot, verifyPackagedDesktopRuntime, readPackagedDesktopRuntimeDescriptor } =
    await import('../../scripts/packaged-runtime.mjs')
  const planBytes = readFileSync(new URL('../../release/cloga-windows-x64.json', import.meta.url))
  const lockBytes = readFileSync(join(repository, 'pnpm-lock.yaml'))
  const reviewed = parseDesktopForkReleasePlan(JSON.parse(planBytes.toString('utf8')))
  const resources = join(dirname(application), 'resources')
  const capabilityBytes = readFileSync(join(resources, 'managed-update', 'capability.json'))
  assert.deepEqual(JSON.parse(capabilityBytes.toString('utf8')), createDesktopForkReleaseCapability(reviewed))
  const runtimeRoot = packagedDesktopRuntimeRoot(resources)
  const plan = readDesktopPluginProvisioningPlan(join(resources, 'desktop-provisioning', 'plan.json'))
  assert.deepEqual(plan, reviewed.desktopProvisioning)
  assert.equal(plan.mode, 'exact', 'Deterministic clean-profile inventory requires an exact plan')
  const executableSha256 = createHash('sha256').update(readFileSync(application)).digest('hex')
  const provisioningPlanSha256 = createHash('sha256').update(readFileSync(join(resources, 'desktop-provisioning', 'plan.json'))).digest('hex')
  const scratch = join(repository, '.desktop-smoke')
  mkdirSync(scratch, { recursive: true })
  const home = mkdtempSync(join(scratch, 'packaged-plugin-command-'))
  let browser: Browser | undefined
  let owned: SpawnedJobProcess | undefined
  let spawnAttempted = false
  const helperLifecycle: HelperLifecycle = { helperTreeUncertain: false, nativeObservations: [] }
  let ownership: Ownership | undefined
  const failure = createDesktopPluginCommandOutcome()
  let cleanupVerified = false
  const descriptors: number[] = []
  const stderrPath = join(home, 'electron.stderr')
  let page: Page | undefined
  let quiescent = false
  const expected: ExpectedCommand[] = []
  const environment = desktopSmokeEnvironment(home)
  const profile = join(home, 'profiles', 'desktop')
  const workspace = join(home, 'workspace')
  const userData = join(home, 'electron-user-data')
  const evidence: Record<string, unknown> = {
    schemaVersion: 1, scope: 'independent-packaged-plugin-command-and-native-cancel',
    sourceRepository: 'cloga/deepseek-harness', ...identity,
    desktopVersion: reviewed.version, upstreamVersion: reviewed.upstreamVersion, sequence: reviewed.sequence,
    planSha256: createHash('sha256').update(planBytes).digest('hex'),
    lockfileSha256: createHash('sha256').update(lockBytes).digest('hex'),
    capabilitySha256: createHash('sha256').update(capabilityBytes).digest('hex'),
    executableSha256, provisioningPlanSha256,
    isolatedHome: true, modelPromptSubmitted: false, realOAuth: false, networkFreeClaimed: false,
    nativeObservations: helperLifecycle.nativeObservations }
  const save = (name: string, value: unknown): void => {
    writeFileSync(join(output, name), `${JSON.stringify(value, undefined, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
  try {
    assert.equal(existsSync(profile), false, 'The shell must create the fresh Desktop profile')
    mkdirSync(workspace)
    writeFileSync(join(home, '.env'), '', { flag: 'wx', mode: 0o600 })
    // Every verifier child is synchronous/awaited and receives this fixture's private environment.
    await verifyPackagedDesktopRuntime(application, runtimeRoot, reviewed.upstreamVersion, { platform: 'win32', arch: 'x64' }, environment)
    const runtimeBytes = readPackagedDesktopRuntimeDescriptor(application, runtimeRoot, environment)
    evidence.runtimeSha256 = createHash('sha256').update(runtimeBytes).digest('hex')
    mkdirSync(userData)
    const descriptor = (path: string, flags: string): number => {
      const fd = openSync(path, flags, 0o600)
      descriptors.push(fd)
      return fd
    }
    const stdin = openDesktopPluginInput(home)
    descriptors.push(stdin)
    const stdio = { stdin, stdout: descriptor(join(home, 'electron.stdout'), 'wx'),
      stderr: descriptor(stderrPath, 'wx') }
    const args = [`--user-data-dir=${userData}`, '--lang=en-US', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0']
    const commandLine = buildCommandLine(application, args)
    const launchedAfter = new Date().toISOString()
    const startupDeadline = performance.now() + 300_000
    // Assignment to the nonbreakaway kill-on-close Job precedes resume; retain BOTH handles even if CDP fails.
    spawnAttempted = true
    owned = win32.spawnCurrentTokenJobProcess(api, { applicationName: application, command: application, args,
      cwd: home, env: environment, stdio })
    const portFile = join(userData, 'DevToolsActivePort')
    let devtools: ReturnType<typeof parseDesktopDevToolsPort> | undefined
    while (devtools === undefined) {
      remainingDeadline(startupDeadline)
      assert.equal(win32.pollProcessExit(api, owned.process), undefined, 'Owned root exited before CDP attach')
      const stat = lstatSync(portFile, { throwIfNoEntry: false })
      if (stat !== undefined) {
        assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024, 'Unsafe private DevToolsActivePort')
        devtools = parseDesktopDevToolsPort(readFileSync(portFile, 'utf8'))
      } else await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(100, remainingDeadline(startupDeadline))))
    }
    const launchIdentity = { mainPid: owned.pid, application, launchedAfter, commandLine, port: devtools.port }
    const listener = await nativeHelper<{ main: ProcessIdentity }>(home, environment,
      { action: 'listener', ...launchIdentity }, helperLifecycle, startupDeadline)
    assert.equal(listener.main.pid, owned.pid)
    assert.equal(win32.pollProcessExit(api, owned.process), undefined)
    browser = await chromium.connectOverCDP(devtools.endpoint, { timeout: remainingDeadline(startupDeadline) })
    remainingDeadline(startupDeadline)
    while (page === undefined) {
      remainingDeadline(startupDeadline)
      const contexts = browser.contexts()
      assert.equal(contexts.length, 1, 'Expected exactly one owned browser context')
      const pages = contexts[0]!.pages()
      assert(pages.length <= 1, 'Unexpected extra root browser pages')
      page = pages[0]
      if (page === undefined) await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(100, remainingDeadline(startupDeadline))))
    }
    await page.waitForFunction(() => {
      const error = document.querySelector<HTMLElement>('#error')
      return location.href === 'dsh-app://app/' || Boolean(error && !error.hidden && error.textContent?.trim())
    }, undefined, { timeout: remainingDeadline(startupDeadline) })
    remainingDeadline(startupDeadline)
    assert.equal(page.url(), APPLICATION_URL, 'Packaged application did not reach app-ready')
    await page.getByRole('button', { name: 'Settings', exact: true }).waitFor({
      state: 'visible', timeout: remainingDeadline(startupDeadline),
    })
    remainingDeadline(startupDeadline)
    const pageTitle = await withinDeadline(startupDeadline, () => page!.title())
    validateDesktopPageTitle(pageTitle)
    evidence.pageTitle = pageTitle
    ownership = await nativeHelper<Ownership>(home, environment, { action: 'capture', ...launchIdentity,
      main: listener.main, pageTitle, profile, home,
      hostEntry: join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js') }, helperLifecycle, startupDeadline)
    assert.deepEqual(ownership.main, listener.main)
    validateDesktopWindowCapture(ownership.mainWindow, owned.pid, pageTitle, ownership.mainHwnd)
    assert.equal(win32.pollProcessExit(api, owned.process), undefined, 'Owned root must remain alive at capture')
    evidence.userDataIdentity = { userData, argv: args, listenerPid: owned.pid, endpoint: devtools.endpoint,
      basis: 'exact owned launch command line, private DevToolsActivePort and verified root listener' }
    evidence.ownership = ownership
    assertDesktopProvisioningInventory(profile, plan)
    const baseline = snapshotDesktopPluginProfile(profile)
    const manifestText = readFileSync(join(profile, 'package.json'), 'utf8')
    const manifest = JSON.parse(manifestText) as { dependencies?: unknown; dsh: { profile: { bundles: string[] } } }
    assert(manifest.dependencies !== null && typeof manifest.dependencies === 'object' && !Array.isArray(manifest.dependencies))
    const expectedRows = plan.plugins.map(entry => ({ name: entry.source.packageName, version: entry.source.version }))
      .sort((a, b) => a.name.localeCompare(b.name))
    assert(expectedRows.length > 0, 'Release plan must provide an installed plugin to disable')
    const target = expectedRows[0]!
    const listText = expectedRows.map(row => `${row.name}@${row.version} — enabled`).join('\n')
    evidence.target = target
    const sessionId = `desktop-plugin-command-${randomUUID()}`
    const created = await remote<{ sessionId: string }>(page, 'session/create', { request: { cwd: workspace, sessionId } })
    assert.equal(created.sessionId, sessionId)
    const registry = await remote<readonly CommandDescriptor[]>(page, 'commands/list', { agentId: sessionId })
    assert.equal(Array.isArray(registry), true, 'Expected command registry array')
    assert(registry.some(command => command.name === 'desktop-plugin'), 'Actual Host registry must contain desktop-plugin before execution')
    let navigations = 0
    const onNavigation = (): void => { navigations++ }
    page.on('domcontentloaded', onNavigation)
    const documentIdentity = await page.evaluate(() => performance.timeOrigin)
    const execute = async (line: string, deadline = performance.now() + 300_000): Promise<CommandExecution> => {
      const execution = await remote<CommandExecution>(page!, 'commands/execute', { agentId: sessionId, line, submittedAttachments: [] }, deadline)
      assert(execution && typeof execution.commandId === 'string' && execution.result, 'RPC must return CommandExecution, not prompt fallback')
      expected.push({ line, execution })
      return execution
    }
    assert.deepEqual((await execute('/desktop-plugin list')).result, { kind: 'success', text: listText })
    const profilesBeforeInvalid = readdirSync(dirname(profile)).sort()
    assert.deepEqual((await execute('/desktop-plugin install release {}')).result, { kind: 'error', text: SAFE_FAILURE })
    assert.deepEqual(readdirSync(dirname(profile)).sort(), profilesBeforeInvalid, 'Invalid release must create no transaction/acquisition')
    assert.deepEqual(snapshotDesktopPluginProfile(profile), baseline)
    const transactionsBeforeToggle = transactionNames(profile)
    // Stage preparation may reconstruct dependencies with bundled frozen pnpm. This is NOT a zero-network smoke.
    const disable = await execute(`/desktop-plugin disable ${target.name}`)
    assert.deepEqual(disable.result, { kind: 'success', text: PREPARED })
    const createdTransactions = transactionNames(profile).filter(name => !transactionsBeforeToggle.includes(name))
    assert.equal(createdTransactions.length, 1, 'Exactly one command-owned candidate must be prepared')
    const transactionName = createdTransactions[0]!
    const transactionId = transactionName.slice('.desktop.package-stage-'.length)
    const transaction = join(dirname(profile), transactionName)
    const preparedBeforeCancel = readJournal(join(transaction, 'PREPARED.json'))
    const candidate = join(transaction, 'profile')
    const candidateSnapshot = snapshotDesktopPluginProfile(candidate)
    assert.deepEqual({ ...candidateSnapshot, 'package.json': baseline['package.json'] }, baseline,
      'Selection may change only bundle selection, not retained metadata/artifacts')
    const candidateManifest: unknown = JSON.parse(readFileSync(join(candidate, 'package.json'), 'utf8'))
    assert(manifest.dsh.profile.bundles.includes(target.name))
    assert.deepEqual(candidateManifest, { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh.profile,
      bundles: manifest.dsh.profile.bundles.filter(name => name !== target.name) } } })
    assert.equal(existsSync(join(transaction, 'DISCARDED.json')), false)
    assert.equal(existsSync(join(transaction, 'ACTIVATION.json')), false)
    evidence.beforeCancelTranscript = await exportTranscript(page, home, sessionId, expected)
    // Export flush proves prepared command/done durability before Cancel invocation, NOT independent native-dialog ordering.
    evidence.nativeCancel = await nativeHelper(home, environment, { action: 'cancel', ownership }, helperLifecycle)
    const deadline = performance.now() + 60_000
    for (;;) {
      const listed = await execute('/desktop-plugin list', deadline)
      remainingDeadline(deadline) // Late success must not silently bypass the 60-second settlement bound.
      if (listed.result.kind === 'success') { assert.equal(listed.result.text, listText); break }
      assert.equal(listed.result.text, BUSY, 'Only busy is transient while cancellation settles')
      await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(100, remainingDeadline(deadline))))
    }
    const after = snapshotDesktopPluginProfile(profile)
    assert.deepEqual(after, baseline, 'Cancel must retain actual profile metadata and artifact bytes')
    assert.deepEqual(transactionNames(profile), [...transactionsBeforeToggle, transactionName].sort())
    const records = { owner: readJournal(join(transaction, 'owner.json')),
      prepared: readJournal(join(transaction, 'PREPARED.json')),
      discarded: readJournal(join(transaction, 'DISCARDED.json')), retainedEntries: readdirSync(transaction).sort() }
    assert.deepEqual(records.prepared, preparedBeforeCancel, 'Cancel must not rewrite the prepared command identity')
    validateDesktopPluginCancelAudit(records, { transactionId, commandId: disable.commandId, target: target.name,
      profile: realpathSync(profile), runtimeDir: realpathSync(runtimeRoot), manifestText, baseline })
    evidence.afterCancelIdentity = await nativeHelper(home, environment, { action: 'verify', ownership }, helperLifecycle)
    assert.equal(win32.pollProcessExit(api, owned.process), undefined, 'Cancel must retain the exact Job-created root')
    assert.equal(page.url(), APPLICATION_URL)
    assert.equal(await page.evaluate(() => performance.timeOrigin), documentIdentity, 'Cancel must not reload the app document')
    assert.equal(navigations, 0, 'Cancel must not navigate to startup/error or reload')
    assert.equal(await page.locator('#error:visible').count(), 0)
    page.off('domcontentloaded', onNavigation)
    evidence.transcript = await exportTranscript(page, home, sessionId, expected)
    evidence.transcriptInferenceAbsent = true // Only after actual exported durable transcript validation.
    evidence.commands = expected
    evidence.profileUnchanged = true
    save('profile-hashes.json', { before: baseline, after })
    save('cancel-audit.json', records)
    const closeDeadline = performance.now() + 60_000
    evidence.normalClose = await nativeHelper(home, environment, { action: 'close', ownership }, helperLifecycle, closeDeadline)
    const exitCode = await waitForOwnedJobExit(closeDeadline,
      () => win32.pollProcessExit(api, owned!.process), () => win32.isJobEmpty(api, owned!.job))
    quiescent = true
    assert.equal(exitCode, 0, 'Normal application teardown must exit successfully without forced Job termination')
    assert(canRemoveDesktopPluginHome({ spawnAttempted, jobOwned: true, jobQuiescent: quiescent,
      helperTreeUncertain: helperLifecycle.helperTreeUncertain }), 'Independent helper tree is uncertain')
    evidence.quiescent = { rootExitCode: exitCode, jobEmpty: true, normalClose: true, helperTreeUncertain: false }
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repository, encoding: 'utf8' }).trim(), sourceCommit)
    assert.equal(execFileSync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: repository, encoding: 'utf8' }).trim(), sourceTree)
    for (const [path, sha256] of [
      [fileURLToPath(new URL('../../release/cloga-windows-x64.json', import.meta.url)), evidence.planSha256],
      [join(repository, 'pnpm-lock.yaml'), evidence.lockfileSha256],
      [join(resources, 'managed-update', 'capability.json'), evidence.capabilitySha256],
      [join(resources, 'desktop-provisioning', 'plan.json'), provisioningPlanSha256],
      [application, executableSha256],
    ] as const) assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'), sha256, 'Acceptance inputs changed during the run')
  } catch (error) {
    failure.retain(error)
    try {
      save('failure.json', { ...evidence, quiescent: false, spawnAttempted,
        helperTreeUncertain: helperLifecycle.helperTreeUncertain, error: safeDiagnostic(error),
        stderrTail: existsSync(stderrPath) ? safeDiagnostic(readFileSync(stderrPath, 'utf8').slice(-32_768)) : '',
        commands: expected, pageUrl: page?.url(), retainedHomeOnCleanupFailure: home })
    } catch (diagnosticError) { failure.retain(diagnosticError) }
  } finally {
    const errors: unknown[] = []
    const cleanupFailure = (error: unknown): void => { errors.push(error); failure.retain(error) }
    if (!quiescent && owned !== undefined) {
      // Covers every post-spawn failure, including absent CDP, app-ready or native identity capture.
      try {
        win32.terminateJob(api, owned.job, 1)
        await waitForOwnedJobExit(performance.now() + 60_000,
          () => win32.pollProcessExit(api, owned!.process), () => win32.isJobEmpty(api, owned!.job))
        quiescent = true
      } catch (error) { cleanupFailure(error) }
    } else if (owned === undefined && !spawnAttempted) quiescent = true
    if (spawnAttempted && owned === undefined) {
      cleanupFailure(new Error(`Spawn threw without returned handles; child cleanup is unknown; retained private home: ${home}`))
    }
    if (helperLifecycle.helperTreeUncertain) {
      cleanupFailure(new Error(`Native helper tree is uncertain after abnormal completion; retained private home: ${home}`))
    }
    // Never use a Playwright launcher or its PID-kill tree logic. A CDP connection is disconnected only
    // AFTER the retained Job proves quiescence (browser.close on connectOverCDP disconnects the client).
    if (quiescent) {
      try { await withinDeadline(performance.now() + 10_000, async () => { await browser?.close() }) }
      catch (error) { cleanupFailure(error) }
      if (owned !== undefined) {
        try { win32.closeHandleChecked(api, owned.process, 'fixture root process') } catch (error) { cleanupFailure(error) }
        try { win32.closeHandleChecked(api, owned.job, 'fixture Job') } catch (error) { cleanupFailure(error) }
      }
    } else cleanupFailure(new Error(`Cannot prove process exit AND empty Job; retained handles and private home: ${home}`))
    for (const fd of descriptors) {
      try { closeSync(fd) } catch (error) { cleanupFailure(error) }
    }
    if (canRemoveDesktopPluginHome({ spawnAttempted, jobOwned: owned !== undefined,
      jobQuiescent: quiescent, helperTreeUncertain: helperLifecycle.helperTreeUncertain }) && errors.length === 0) {
      try { removeOwnedDirectory(home) } catch (error) { cleanupFailure(error) }
    }
    if (errors.length > 0) {
      try {
        save('cleanup-failure.json', { errors: errors.map(safeDiagnostic), home, quiescent: false,
          appJobQuiescent: quiescent, spawnAttempted, helperTreeUncertain: helperLifecycle.helperTreeUncertain })
      } catch (diagnosticError) { failure.retain(diagnosticError) }
    }
    try {
      cleanupVerified = quiescent && !helperLifecycle.helperTreeUncertain && errors.length === 0 && !existsSync(home)
    } catch (error) { failure.retain(error) }
  }
  finalizeDesktopPluginCommandAcceptance(failure, cleanupVerified,
    () => { save('acceptance.json', { ...evidence, cleanupVerified: true, ownedHomeRemoved: true }) },
    (primary, secondary) => { save('final-failure.json', {
      ...evidence, cleanupVerified, error: safeDiagnostic(primary), secondaryErrors: secondary.map(safeDiagnostic),
    }) })
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { application: { type: 'string' }, output: { type: 'string' } }, allowPositionals: false })
  assert(values.application && values.output, 'Packaged application and evidence directory are required')
  await runPackagedDesktopPluginCommandAcceptance({ application: values.application, output: values.output })
}
