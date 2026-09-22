/** Packaged command-only acceptance. Independent of the no-Session Copilot account smoke.
 * Run only on an interactive Windows CI desktop with a freshly packaged application.
 * No model prompt/sign-in/settings mutation; staging CAN use frozen pnpm and network.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { gzipSync } from 'node:zlib'
import type { Browser, Page } from 'playwright'
import type { SpawnedJobProcess } from '@deepseek-ai/dsh-win32-process/src/index.ts'
import {
  parseDesktopDevToolsPort, remainingDeadline, validateDesktopPageTitle, validateDesktopPluginCancelAudit,
  validateDesktopWindowCapture, waitForOwnedJobExit, withinDeadline,
} from './desktop-plugin-command-guards.ts'
import type { CommandDescriptor, CommandExecution } from '@deepseek-ai/dsh-commands/types'
import type { SessionEvent } from '@deepseek-ai/dsh-session/types'
import { parseSessionFormatLogFilename } from '@deepseek-ai/dsh-session-format/src/filename.ts'
import { desktopSmokeEnvironment } from '../../scripts/smoke-environment.ts'
import { removeOwnedDirectory } from '../../src/owned-directory.ts'

const APPLICATION_URL = 'dsh-app://app/index.html'
const PREPARED = 'Plugin change prepared. Review the native confirmation to restart the Desktop Host.'
const SAFE_FAILURE = 'Desktop could not prepare the plugin change. Review Desktop diagnostics for details.'
const BUSY = 'Another Desktop plugin, recovery, or update operation is in progress.'
const METADATA = [
  'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'desktop.cordis.yml',
  'desktop-runtime-state.json', 'desktop-plugin-receipts.json', 'desktop-plugin-package-locks.json',
  'desktop-plugin-provisioning-state.json', '.env', 'profile.env', 'desktop-packages-pending',
] as const

/**
 * Derive one monotonic work budget plus a cleanup-only reserve without resetting either deadline.
 * @param started - Monotonic fixture start timestamp.
 * @returns Absolute work and cleanup deadlines.
 */
export function desktopPluginAcceptanceDeadlines(started: number): { work: number; cleanup: number } {
  const work = started + 16 * 60_000
  return { work, cleanup: work + 3 * 60_000 }
}

/**
 * Return only handle kinds that have not already closed in the current epoch.
 * @param processClosed - Whether the process handle closed successfully.
 * @param jobClosed - Whether the Job handle closed successfully.
 * @returns Handle kinds still owned by cleanup.
 */
export function pendingDesktopPluginHandles(processClosed: boolean, jobClosed: boolean): readonly ('process' | 'job')[] {
  return [...(processClosed ? [] : ['process'] as const), ...(jobClosed ? [] : ['job'] as const)]
}

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

/** Build one deterministic prebuilt plugin archive without package-manager or lifecycle execution. */
function unrelatedPluginArchive(): Buffer {
  const files = new Map<string, Buffer>([
    ['package/package.json', Buffer.from(JSON.stringify({
      name: 'desktop-unrelated-fixture', version: '1.0.0',
      dsh: { bundle: { patch: 'bundle.yml' } },
    }))],
    ['package/bundle.yml', Buffer.from('[]\n')],
  ])
  const blocks: Buffer[] = []
  const octal = (value: number, width: number): Buffer => Buffer.from(`${value.toString(8).padStart(width - 1, '0')}\0`)
  for (const [name, body] of files) {
    const header = Buffer.alloc(512)
    header.write(name, 0, 100, 'utf8')
    octal(0o644, 8).copy(header, 100)
    octal(0, 8).copy(header, 108)
    octal(0, 8).copy(header, 116)
    octal(body.byteLength, 12).copy(header, 124)
    octal(0, 12).copy(header, 136)
    header.fill(0x20, 148, 156)
    header[156] = '0'.charCodeAt(0)
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    octal([...header].reduce((sum, byte) => sum + byte, 0), 8).copy(header, 148)
    blocks.push(header, body, Buffer.alloc((512 - body.byteLength % 512) % 512))
  }
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]))
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

function boundedFileTail(path: string, maximum = 16_384): string {
  const stat = lstatSync(path, { throwIfNoEntry: false })
  if (stat === undefined || !stat.isFile() || stat.isSymbolicLink()) return ''
  const length = Math.min(stat.size, maximum)
  const bytes = Buffer.alloc(length)
  const descriptor = openSync(path, 'r')
  try {
    const read = readSync(descriptor, bytes, 0, length, Math.max(0, stat.size - length))
    return bytes.subarray(0, read).toString('utf8')
  } finally { closeSync(descriptor) }
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
  const timeout = remainingDeadline(Math.min(deadline, performance.now() + 90_000))
  const prefix = join(home, `native-${randomUUID()}`)
  const input = `${prefix}.request.json`
  writeFileSync(input, JSON.stringify(request), { flag: 'wx', mode: 0o600 })
  const stdout = openSync(`${prefix}.stdout`, 'wx', 0o600)
  let stderr: number | undefined
  let spawnAttempted = false
  let closedNormally = false
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
        stderr: safeDiagnostic(readFileSync(`${prefix}.stderr`, 'utf8')) })}`)
    }
    remainingDeadline(deadline)
    const result = JSON.parse(readFileSync(`${prefix}.stdout`, 'utf8').replace(/^\uFEFF/u, '')) as T
    closedNormally = true
    return result
  } finally {
    // Add-Type may own a compiler child outside the app Job. Only normal helper completion
    // admits its synchronous compiler lifecycle; an abnormal parent close is NOT tree quiescence.
    if (spawnAttempted && !closedNormally) lifecycle.helperTreeUncertain = true
    closeSync(stdout)
    if (stderr !== undefined) closeSync(stderr)
  }
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

function auditNames(home: string): string[] {
  const directory = join(home, 'desktop', 'profile-operations')
  return existsSync(directory) ? readdirSync(directory).filter(name => name.endsWith('.json')).sort() : []
}

/**
 * Bind a started mutation to its exact committed target without inventing an early target.
 * @param records - Newly retained audit records for one fixture operation.
 * @param operation - Expected mutation kind.
 * @param target - Package name learned by the committed activation.
 * @returns Transaction identity and retained records for evidence.
 */
export function validateCommittedAudit(
  records: readonly Record<string, unknown>[],
  operation: 'plugin-add' | 'plugin-install',
  target: string,
): { transaction: string; records: readonly Record<string, unknown>[] } {
  const started = records.filter(record => record.operation === operation && record.outcome === 'started')
  assert.equal(started.length, 1, `Expected one ${operation} started audit`)
  const transaction = started[0]?.transaction
  assert(typeof transaction === 'string' && transaction !== '', 'Started audit must identify its transaction')
  const committed = records.filter(record => record.operation === operation && record.transaction === transaction
    && record.target === target && record.phase === 'activation' && record.outcome === 'committed')
  assert.equal(committed.length, 1, `Expected one committed ${operation} audit for ${target}`)
  assert.equal(records.some(record => record.transaction === transaction
    && (record.outcome === 'failed' || record.phase === 'rollback')), false,
  `Committed ${operation} transaction must contain no failed or rollback audit`)
  return { transaction, records }
}

async function exportTranscript(
  page: Page,
  home: string,
  sessionId: string,
  expected: readonly ExpectedCommand[],
  deadline = performance.now() + 30_000,
) {
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
  const extracted = join(directory, 'decoded')
  await withinDeadline(deadline, async () => {
    const extractZip = (await import('extract-zip')).default
    await extractZip(archive, { dir: extracted })
  })
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
  const application = resolve(options.application)
  const outputRoot = resolve(options.output)
  mkdirSync(outputRoot, { recursive: true })
  const output = mkdtempSync(join(outputRoot, 'desktop-plugin-command-'))
  const fixtureStarted = performance.now()
  const { work: fixtureWorkDeadline, cleanup: fixtureCleanupDeadline } = desktopPluginAcceptanceDeadlines(fixtureStarted)
  const { chromium } = await import('playwright')
  // Native Koffi and Win32 DLL loading is acceptance-only, never an import-time side effect.
  const win32 = await import('@deepseek-ai/dsh-win32-process/src/index.ts')
  const { buildCommandLine } = await import('@deepseek-ai/dsh-win32-process/src/process.ts')
  const api = win32.loadWin32ProcessBindings()
  const { parseDesktopForkReleasePlan } = await import('../../scripts/fork-release.ts')
  const { DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY, desktopPluginProvisioningPlanSha256,
    readDesktopPluginProvisioningPlan } = await import('../../src/plugin-provisioning.ts')
  const { assertDesktopProvisioningInventory } = await import('../../src/project-manager.ts')
  const { packagedDesktopRuntimeRoot, verifyPackagedDesktopRuntime, readPackagedDesktopRuntimeDescriptor } =
    await import('../../scripts/packaged-runtime.mjs')
  const reviewed = parseDesktopForkReleasePlan(JSON.parse(readFileSync(new URL('../../release/cloga-windows-x64.json', import.meta.url), 'utf8')))
  const resources = join(dirname(application), 'resources')
  const runtimeRoot = packagedDesktopRuntimeRoot(resources)
  const plan = readDesktopPluginProvisioningPlan(join(resources, 'desktop-provisioning', 'plan.json'))
  assert.deepEqual(plan, reviewed.desktopProvisioning)
  assert.equal(plan.mode, 'exact', 'Deterministic clean-profile inventory requires an exact plan')
  assert.equal(plan.schemaVersion, 2)
  assert.equal(plan.plugins.length, 1)
  const initialEntry = plan.plugins[0]!
  assert.equal(initialEntry.required, true)
  assert.equal(initialEntry.sourcePolicy, 'compatible-user-override')
  assert.equal(initialEntry.source.packageName, 'dsh-github-copilot')
  assert.equal(initialEntry.source.version, '0.4.0-alpha.35')
  const executableSha256 = createHash('sha256').update(readFileSync(application)).digest('hex')
  const planPath = join(resources, 'desktop-provisioning', 'plan.json')
  const provisioningPlanSha256 = createHash('sha256').update(readFileSync(planPath)).digest('hex')
  const provisioningPlanCanonicalSha256 = desktopPluginProvisioningPlanSha256(plan)
  const packagedCapability = JSON.parse(readFileSync(join(resources, 'managed-update', 'capability.json'), 'utf8')) as {
    provisioning: { capability: unknown; planSha256: string }
  }
  assert.deepEqual(packagedCapability.provisioning.capability, DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY)
  assert.equal(packagedCapability.provisioning.planSha256, provisioningPlanCanonicalSha256)
  const candidateCommit = execFileSync('git', ['rev-parse', 'HEAD'], {
    encoding: 'utf8', timeout: Math.min(10_000, remainingDeadline(fixtureWorkDeadline)),
  }).trim()
  const candidateTree = execFileSync('git', ['rev-parse', 'HEAD^{tree}'], {
    encoding: 'utf8', timeout: Math.min(10_000, remainingDeadline(fixtureWorkDeadline)),
  }).trim()
  assert.match(candidateCommit, /^[a-f0-9]{40}$/u)
  assert.match(candidateTree, /^[a-f0-9]{40}$/u)
  if (process.env.GITHUB_SHA !== undefined) assert.equal(candidateCommit, process.env.GITHUB_SHA)
  const alpha36DescriptorBytes = readFileSync(new URL('./copilot-alpha36-source.json', import.meta.url))
  const workflowRunId = process.env.GITHUB_RUN_ID
  const workflowRunAttempt = process.env.GITHUB_RUN_ATTEMPT
  const workflowJob = process.env.GITHUB_JOB
  assert(workflowRunId !== undefined && /^[1-9][0-9]*$/u.test(workflowRunId), 'Hosted run id is required')
  assert(workflowRunAttempt !== undefined && /^[1-9][0-9]*$/u.test(workflowRunAttempt), 'Hosted run attempt is required')
  assert(workflowJob !== undefined && workflowJob !== '', 'Hosted job identity is required')
  const sourceBinding = {
    candidateCommit, candidateTree, workflowRunId, workflowRunAttempt, workflowJob,
    lockfileSha256: createHash('sha256').update(readFileSync(resolve('pnpm-lock.yaml'))).digest('hex'),
    alpha36DescriptorSha256: createHash('sha256').update(alpha36DescriptorBytes).digest('hex'),
  }
  const scratch = resolve('.desktop-smoke')
  mkdirSync(scratch, { recursive: true })
  const home = mkdtempSync(join(scratch, 'packaged-plugin-command-'))
  let browser: Browser | undefined
  let owned: SpawnedJobProcess | undefined
  let spawnAttempted = false
  let processHandleClosed = false
  let jobHandleClosed = false
  const helperLifecycle: HelperLifecycle = { helperTreeUncertain: false, nativeObservations: [] }
  let ownership: Ownership | undefined
  let launchIdentity: { mainPid: number; application: string; launchedAfter: string; commandLine: string; port: number } | undefined
  let mainIdentity: ProcessIdentity | undefined
  let failure: unknown
  let acceptedEvidence: Record<string, unknown> | undefined
  const descriptors: number[] = []
  const stderrPaths: string[] = []
  let page: Page | undefined
  let quiescent = false
  const expected: ExpectedCommand[] = []
  const environment = desktopSmokeEnvironment(home)
  const profile = join(home, 'profiles', 'desktop')
  const workspace = join(home, 'workspace')
  const userData = join(home, 'electron-user-data')
  const evidence: Record<string, unknown> = { desktopVersion: reviewed.version, sequence: reviewed.sequence,
    executableSha256, provisioningPlanSha256, provisioningPlanCanonicalSha256,
    provisioningCapability: packagedCapability.provisioning.capability, sourceBinding,
    isolatedHome: true, modelPromptSubmitted: false, realOAuth: false, networkFreeClaimed: false,
    installedInstallerUpgradeVerified: false, differentRuntimeUpgradeVerified: false, liveOAuthOrModelVerified: false,
    deadline: { monotonicWorkMs: 16 * 60_000, cleanupReserveMs: 3 * 60_000 },
    nativeObservations: helperLifecycle.nativeObservations }
  const save = (name: string, value: unknown): void => {
    writeFileSync(join(output, name), `${JSON.stringify(value, undefined, 2)}\n`, { flag: 'wx', mode: 0o600 })
  }
  const boundedWorkDeadline = (deadline: number): number => Math.min(deadline, fixtureWorkDeadline)
  let launchGeneration = 0
  let firstMainIdentity: ProcessIdentity | undefined
  const launchOwnedRoot = async (): Promise<{
    browser: Browser
    owned: SpawnedJobProcess
    page: Page
    ownership: Ownership
    pageTitle: string
    launchIdentity: { mainPid: number; application: string; launchedAfter: string; commandLine: string; port: number }
    main: ProcessIdentity
  }> => {
    assert(owned === undefined && browser === undefined, 'Previous launch must be drained before another epoch')
    spawnAttempted = false
    processHandleClosed = false
    jobHandleClosed = false
    quiescent = false
    page = undefined
    ownership = undefined
    launchIdentity = undefined
    mainIdentity = undefined
    const generation = ++launchGeneration
    const launchHome = join(home, `launch-${generation}`)
    mkdirSync(launchHome)
    const descriptor = (path: string, flags: string): number => {
      const fd = openSync(path, flags, 0o600)
      descriptors.push(fd)
      return fd
    }
    const stdin = openDesktopPluginInput(launchHome)
    descriptors.push(stdin)
    const stderrPath = join(home, `electron-${generation}.stderr`)
    stderrPaths.push(stderrPath)
    const stdio = { stdin, stdout: descriptor(join(home, `electron-${generation}.stdout`), 'wx'), stderr: descriptor(stderrPath, 'wx') }
    const args = [`--user-data-dir=${userData}`, '--lang=en-US', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0']
    const commandLine = buildCommandLine(application, args)
    const launchedAfter = new Date().toISOString()
    const startupDeadline = boundedWorkDeadline(performance.now() + 300_000)
    const portFile = join(userData, 'DevToolsActivePort')
    if (existsSync(portFile)) unlinkSync(portFile)
    spawnAttempted = true
    const launched = win32.spawnCurrentTokenJobProcess(api, { applicationName: application, command: application, args,
      cwd: home, env: environment, stdio })
    owned = launched
    let devtools: ReturnType<typeof parseDesktopDevToolsPort> | undefined
    while (devtools === undefined) {
      remainingDeadline(startupDeadline)
      assert.equal(win32.pollProcessExit(api, launched.process), undefined, 'Owned root exited before CDP attach')
      const stat = lstatSync(portFile, { throwIfNoEntry: false })
      if (stat !== undefined) {
        assert(stat.isFile() && !stat.isSymbolicLink() && stat.size <= 1024, 'Unsafe private DevToolsActivePort')
        devtools = parseDesktopDevToolsPort(readFileSync(portFile, 'utf8'))
      } else await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(100, remainingDeadline(startupDeadline))))
    }
    const epochIdentity = { mainPid: launched.pid, application, launchedAfter, commandLine, port: devtools.port }
    launchIdentity = epochIdentity
    const listener = await nativeHelper<{ main: ProcessIdentity }>(home, environment,
      { action: 'listener', ...epochIdentity }, helperLifecycle, startupDeadline)
    mainIdentity = listener.main
    assert.equal(listener.main.pid, launched.pid)
    assert.equal(win32.pollProcessExit(api, launched.process), undefined)
    const connected = await chromium.connectOverCDP(devtools.endpoint, { timeout: remainingDeadline(startupDeadline) })
    browser = connected
    let launchedPage: Page | undefined
    while (launchedPage === undefined) {
      remainingDeadline(startupDeadline)
      const contexts = connected.contexts()
      assert.equal(contexts.length, 1, 'Expected exactly one owned browser context')
      const pages = contexts[0]!.pages()
      assert(pages.length <= 1, 'Unexpected extra root browser pages')
      launchedPage = pages[0]
      if (launchedPage === undefined) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(100, remainingDeadline(startupDeadline))))
      }
    }
    page = launchedPage
    await launchedPage.waitForFunction(() => {
      const error = document.querySelector<HTMLElement>('#error')
      return location.href === 'dsh-app://app/index.html' || Boolean(error && !error.hidden && error.textContent?.trim())
    }, undefined, { timeout: remainingDeadline(startupDeadline) })
    assert.equal(launchedPage.url(), APPLICATION_URL, 'Packaged application did not reach app-ready')
    const pageTitle = await withinDeadline(startupDeadline, () => launchedPage.title())
    validateDesktopPageTitle(pageTitle)
    const captured = await nativeHelper<Ownership>(home, environment, { action: 'capture', ...epochIdentity,
      main: listener.main, pageTitle, profile, home,
      hostEntry: join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js') }, helperLifecycle, startupDeadline)
    ownership = captured
    assert.deepEqual(captured.main, listener.main)
    validateDesktopWindowCapture(captured.mainWindow, launched.pid, pageTitle, captured.mainHwnd)
    return { browser: connected, owned: launched, page: launchedPage, ownership: captured, pageTitle,
      launchIdentity: epochIdentity, main: listener.main }
  }
  try {
    mkdirSync(profile, { recursive: true })
    mkdirSync(workspace)
    for (const path of [join(home, '.env'), join(profile, '.env')]) writeFileSync(path, '', { flag: 'wx', mode: 0o600 })
    // Every verifier child is synchronous/awaited and receives this fixture's private environment.
    await verifyPackagedDesktopRuntime(application, runtimeRoot, reviewed.upstreamVersion, { platform: 'win32', arch: 'x64' }, environment)
    const runtimeBytes = readPackagedDesktopRuntimeDescriptor(application, runtimeRoot, environment)
    evidence.runtimeSha256 = createHash('sha256').update(runtimeBytes).digest('hex')
    mkdirSync(userData)
    const firstLaunch = await launchOwnedRoot()
    const firstBrowser = firstLaunch.browser
    const firstOwned = firstLaunch.owned
    const firstPage = firstLaunch.page
    browser = firstBrowser; owned = firstOwned; page = firstPage; ownership = firstLaunch.ownership
    launchIdentity = firstLaunch.launchIdentity; mainIdentity = firstLaunch.main
    evidence.pageTitle = firstLaunch.pageTitle
    firstMainIdentity = ownership.main
    evidence.userDataIdentity = { userData, firstMainIdentity,
      basis: 'exact owned launch command line, private DevToolsActivePort and verified root listener' }
    evidence.firstEpoch = { launch: launchIdentity, listener: mainIdentity, host: ownership.host }
    evidence.ownership = ownership
    assertDesktopProvisioningInventory(profile, plan)
    const archivePath = join(home, 'desktop-unrelated-fixture.tgz')
    const archiveBytes = unrelatedPluginArchive()
    writeFileSync(archivePath, archiveBytes, { flag: 'wx', mode: 0o600 })
    const context = browser.contexts()[0]!
    const managerDeadline = boundedWorkDeadline(performance.now() + 30_000)
    const managerPagePromise = context.waitForEvent('page', { timeout: remainingDeadline(managerDeadline) })
    void managerPagePromise.catch(() => undefined)
    await withinDeadline(managerDeadline, async () => { await firstPage.keyboard.press('Control+,') })
    const managerPage = await managerPagePromise
    await managerPage.waitForURL('dsh-app://shell/plugin-manager.html', { timeout: remainingDeadline(managerDeadline) })
    await managerPage.locator('#package-spec').fill(archivePath, { timeout: remainingDeadline(managerDeadline) })
    const initialHostIdentity = ownership.host
    const auditsBeforeLocal = auditNames(home)
    const localApplyDeadline = boundedWorkDeadline(performance.now() + 300_000)
    await withinDeadline(localApplyDeadline, async () => { await managerPage.bringToFront() })
    const managerFocused = await withinDeadline(localApplyDeadline, () => managerPage.evaluate(() => document.hasFocus()))
    assert.equal(managerFocused, true, 'Plugin manager must own focus before preparation')
    await managerPage.locator('#install').click({ timeout: remainingDeadline(localApplyDeadline) })
    await managerPage.waitForFunction(() => !document.hasFocus(), undefined, { timeout: remainingDeadline(localApplyDeadline) })
    evidence.nativeApplyLocal = await nativeHelper(home, environment, { action: 'apply', ownership }, helperLifecycle,
      localApplyDeadline)
    await managerPage.locator('#status').filter({ hasText: 'Done. The Desktop backend has restarted.' })
      .waitFor({ timeout: remainingDeadline(localApplyDeadline) })
    await withinDeadline(boundedWorkDeadline(performance.now() + 10_000), async () => { await managerPage.close() })
    const localPageTitle = await withinDeadline(boundedWorkDeadline(performance.now() + 10_000), () => firstPage.title())
    ownership = await nativeHelper<Ownership>(
      home,
      environment,
      { action: 'capture', ...launchIdentity, main: mainIdentity, pageTitle: localPageTitle, profile, home,
        hostEntry: join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js') },
      helperLifecycle,
      boundedWorkDeadline(performance.now() + 90_000),
    )
    assert.notDeepEqual(ownership.host, initialHostIdentity, 'Local plugin Apply must replace the actual Host process')
    const localAudit = auditNames(home).filter(name => !auditsBeforeLocal.includes(name))
      .map(name => JSON.parse(readFileSync(join(home, 'desktop', 'profile-operations', name), 'utf8')) as Record<string, unknown>)
    evidence.localActivationAudit = validateCommittedAudit(localAudit, 'plugin-add', 'desktop-unrelated-fixture')
    const assertUnrelatedEvidence = (): Record<string, unknown> => {
      const locks = JSON.parse(readFileSync(join(profile, 'desktop-plugin-package-locks.json'), 'utf8')) as {
        packages: Record<string, { sha256: string; integrity: string; version: string }>
      }
      const lock = locks.packages['desktop-unrelated-fixture']
      assert(lock !== undefined, 'Unrelated local plugin lock must remain present')
      const artifact = readFileSync(join(profile, '.desktop-plugin-artifacts', `${lock.sha256}.tgz`))
      const inputSha256 = createHash('sha256').update(archiveBytes).digest('hex')
      const inputIntegrity = `sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`
      assert.equal(lock.sha256, inputSha256)
      assert.equal(lock.integrity, inputIntegrity)
      assert.deepEqual(artifact, archiveBytes)
      const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as {
        dependencies: Record<string, string>
        dsh: { profile: { bundles: string[] } }
      }
      assert.equal(manifest.dependencies['desktop-unrelated-fixture'], `file:.desktop-plugin-artifacts/${lock.sha256}.tgz`)
      assert(manifest.dsh.profile.bundles.includes('desktop-unrelated-fixture'), 'Unrelated local plugin must remain enabled')
      const installedRoot = join(profile, 'node_modules', 'desktop-unrelated-fixture')
      const packageBytes = readFileSync(join(installedRoot, 'package.json'))
      const installed = JSON.parse(packageBytes.toString('utf8')) as { version: string }
      assert.equal(installed.version, '1.0.0')
      const bundleBytes = readFileSync(join(installedRoot, 'bundle.yml'))
      return { lock, inputSha256, inputIntegrity, artifactBytes: artifact.byteLength,
        packageJsonSha256: createHash('sha256').update(packageBytes).digest('hex'),
        bundleSha256: createHash('sha256').update(bundleBytes).digest('hex'),
        dependency: manifest.dependencies['desktop-unrelated-fixture'], enabled: true }
    }
    const unrelatedBaseline = assertUnrelatedEvidence()
    evidence.unrelatedPluginBeforeOverride = unrelatedBaseline
    const target = plan.plugins.find(entry => entry.source.packageName === 'dsh-github-copilot')?.source
    assert(target !== undefined, 'Release plan must contain the Copilot source')
    evidence.target = { name: target.packageName, version: target.version }
    const expectedRows = [{ name: target.packageName, version: target.version },
      { name: 'desktop-unrelated-fixture', version: '1.0.0' }].sort((a, b) => a.name.localeCompare(b.name))
    const listText = expectedRows.map(row => `${row.name}@${row.version} — enabled`).join('\n')
    const sessionId = `desktop-plugin-command-${randomUUID()}`
    const created = await remote<{ sessionId: string }>(firstPage, 'session/create', { request: { cwd: workspace, sessionId } },
      boundedWorkDeadline(performance.now() + 300_000))
    assert.equal(created.sessionId, sessionId)
    const registry = await remote<readonly CommandDescriptor[]>(firstPage, 'commands/list', { agentId: sessionId },
      boundedWorkDeadline(performance.now() + 300_000))
    assert.equal(Array.isArray(registry), true, 'Expected command registry array')
    assert(registry.some(command => command.name === 'desktop-plugin'), 'Actual Host registry must contain desktop-plugin before execution')
    const execute = async (line: string, deadline = boundedWorkDeadline(performance.now() + 300_000)): Promise<CommandExecution> => {
      const execution = await remote<CommandExecution>(firstPage, 'commands/execute', {
        agentId: sessionId, line, submittedAttachments: [],
      }, deadline)
      assert(execution && typeof execution.commandId === 'string' && execution.result, 'RPC must return CommandExecution, not prompt fallback')
      expected.push({ line, execution })
      return execution
    }
    assert.deepEqual((await execute('/desktop-plugin list')).result, { kind: 'success', text: listText })
    const auditsBeforeInvalid = auditNames(home)
    const preInvalidProfile = snapshotDesktopPluginProfile(profile)
    const profilesBeforeInvalid = readdirSync(dirname(profile)).sort()
    assert.deepEqual((await execute('/desktop-plugin install release {}')).result, { kind: 'error', text: SAFE_FAILURE })
    assert.deepEqual(auditNames(home), auditsBeforeInvalid, 'Invalid release descriptor must fail before transaction/acquisition')
    assert.deepEqual(readdirSync(dirname(profile)).sort(), profilesBeforeInvalid, 'Invalid release must create no staged profile')
    assert.deepEqual(snapshotDesktopPluginProfile(profile), preInvalidProfile,
      'Invalid release descriptor must preserve profile metadata and artifact bytes')

    const { parseDesktopPluginSource } = await import('../../src/plugin-source.ts')
    const alpha36 = parseDesktopPluginSource(JSON.parse(alpha36DescriptorBytes.toString('utf8')) as unknown)
    assert(alpha36.type === 'githubRelease' && alpha36.checksumManifest !== undefined,
      'Alpha36 acceptance source must remain checksum-attested')
    const preOverrideHostIdentity = ownership.host
    const auditsBeforeOverride = auditNames(home)
    assert.deepEqual((await execute(`/desktop-plugin install release ${JSON.stringify(alpha36)}`,
      boundedWorkDeadline(performance.now() + 300_000))).result, { kind: 'success', text: PREPARED })
    evidence.beforeOverrideApplyTranscript = await exportTranscript(firstPage, home, sessionId, expected,
      boundedWorkDeadline(performance.now() + 30_000))
    const applyDeadline = boundedWorkDeadline(performance.now() + 300_000)
    let applyNavigations = 0
    const onApplyNavigation = (): void => { applyNavigations++ }
    firstPage.on('domcontentloaded', onApplyNavigation)
    const firstApplyNavigation = firstPage.waitForEvent('domcontentloaded', { timeout: remainingDeadline(applyDeadline) })
    void firstApplyNavigation.catch(() => undefined)
    try {
      evidence.nativeApplyOverride = await nativeHelper(home, environment, { action: 'apply', ownership }, helperLifecycle,
        applyDeadline)
      await firstApplyNavigation
      await firstPage.waitForURL(APPLICATION_URL, { timeout: remainingDeadline(applyDeadline) })
      await firstPage.getByRole('button', { name: 'Settings', exact: true }).waitFor({
        state: 'visible', timeout: remainingDeadline(applyDeadline),
      })
    } finally { firstPage.off('domcontentloaded', onApplyNavigation) }
    assert(applyNavigations > 0, 'Apply must navigate through the owned startup/application lifecycle')
    evidence.applyNavigations = applyNavigations
    const overrideListText = [
      'desktop-unrelated-fixture@1.0.0 — enabled',
      'dsh-github-copilot@0.4.0-alpha.36 — enabled',
    ].join('\n')
    assert.deepEqual((await execute('/desktop-plugin list', applyDeadline)).result,
      { kind: 'success', text: overrideListText })
    const overridePageTitle = await withinDeadline(boundedWorkDeadline(performance.now() + 10_000), () => firstPage.title())
    ownership = await nativeHelper<Ownership>(
      home,
      environment,
      { action: 'capture', ...launchIdentity, main: mainIdentity, pageTitle: overridePageTitle, profile, home,
        hostEntry: join(runtimeRoot, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js') },
      helperLifecycle,
      boundedWorkDeadline(performance.now() + 90_000),
    )
    assert.notDeepEqual(ownership.host, preOverrideHostIdentity, 'Verified override Apply must replace the actual Host process')
    const overrideAudit = auditNames(home).filter(name => !auditsBeforeOverride.includes(name))
      .map(name => JSON.parse(readFileSync(join(home, 'desktop', 'profile-operations', name), 'utf8')) as Record<string, unknown>)
    evidence.overrideActivationAudit = validateCommittedAudit(overrideAudit, 'plugin-install', 'dsh-github-copilot')
    const assertOverrideEvidence = (): Record<string, unknown> => {
      const state = JSON.parse(readFileSync(join(profile, 'desktop-plugin-provisioning-state.json'), 'utf8')) as {
        schemaVersion: number
        plugins: Array<{
          name: string
          sourcePolicy: string
          effective: string
          requestedSource: unknown
          effectiveSource: unknown
          receipt: unknown
        }>
      }
      const result = state.plugins.find(item => item.name === 'dsh-github-copilot')
      assert(result !== undefined, 'Provisioning state must include Copilot')
      const store = JSON.parse(readFileSync(join(profile, 'desktop-plugin-receipts.json'), 'utf8')) as {
        owners: Record<string, string>
        receipts: Record<string, {
          source: unknown
          releaseId: number
          assetId: number
          artifactSha256: string
          version: string
          states: unknown
        }>
      }
      const receipt = store.receipts['dsh-github-copilot']
      assert(receipt !== undefined, 'Receipt store must include Copilot')
      assert.equal(state.schemaVersion, 2)
      assert.equal(result.sourcePolicy, 'compatible-user-override')
      assert.equal(result.effective, 'user-override')
      assert.deepEqual(result.requestedSource, target)
      assert.deepEqual(result.effectiveSource, alpha36)
      assert.deepEqual(result.receipt, receipt)
      assert.deepEqual(receipt.source, alpha36)
      assert.equal(store.owners['dsh-github-copilot'], 'user')
      assert.equal(receipt.releaseId, 393317125)
      assert.equal(receipt.assetId, alpha36.assetId)
      assert.equal(receipt.artifactSha256, alpha36.sha256)
      assert.equal(receipt.version, alpha36.version)
      assert.deepEqual(receipt.states, { staged: true, health: 'passed', activated: true, rolledBack: false, verified: true })
      const artifact = readFileSync(join(profile, '.desktop-plugin-artifacts', `${alpha36.sha256}.tgz`))
      assert.equal(artifact.byteLength, alpha36.size)
      assert.equal(createHash('sha256').update(artifact).digest('hex'), alpha36.sha256)
      assert.equal(`sha512-${createHash('sha512').update(artifact).digest('base64')}`, alpha36.integrity)
      const profileManifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
      assert.equal(profileManifest.dependencies['dsh-github-copilot'], `file:.desktop-plugin-artifacts/${alpha36.sha256}.tgz`)
      const installedRoot = join(profile, 'node_modules', 'dsh-github-copilot')
      const installedBytes = readFileSync(join(installedRoot, 'package.json'))
      const installed = JSON.parse(installedBytes.toString('utf8')) as { version: string; dsh?: { bundle?: { patch?: string } } }
      assert.equal(installed.version, alpha36.version)
      const patch = installed.dsh?.bundle?.patch
      assert(typeof patch === 'string' && patch !== '', 'Installed Copilot must declare its bundle patch')
      const patchSha256 = createHash('sha256').update(readFileSync(join(installedRoot, patch))).digest('hex')
      const clientSha256 = createHash('sha256').update(readFileSync(join(installedRoot, 'lib', 'client.js'))).digest('hex')
      return { requestedSource: result.requestedSource, effectiveSource: result.effectiveSource,
        receiptSha256: createHash('sha256').update(JSON.stringify(receipt)).digest('hex'),
        artifactSha256: alpha36.sha256, artifactBytes: artifact.byteLength,
        installedPackageSha256: createHash('sha256').update(installedBytes).digest('hex'), patchSha256, clientSha256,
        materializedComparedToArchiveEntries: false }
    }
    const overrideBaseline = assertOverrideEvidence()
    evidence.overrideActivation = overrideBaseline
    assert.deepEqual(assertUnrelatedEvidence(), unrelatedBaseline,
      'Alpha36 override must preserve unrelated local input, lock, artifact and materialized bytes')
    evidence.unrelatedPluginAfterOverride = unrelatedBaseline
    const installedBaseline = snapshotDesktopPluginProfile(profile)
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dependencies: Record<string, string> }
    const manifestNames = Object.keys(manifest.dependencies).sort()
    const auditsBeforeStrict = auditNames(home)
    const profilesBeforeStrict = readdirSync(dirname(profile)).sort()
    const ownershipBeforeStrict = ownership
    assert.deepEqual((await execute(`/desktop-plugin disable ${target.packageName}`)).result, { kind: 'error', text: SAFE_FAILURE })
    assert.deepEqual(auditNames(home), auditsBeforeStrict, 'Strict planned disable must fail before transaction audit')
    assert.deepEqual(readdirSync(dirname(profile)).sort(), profilesBeforeStrict, 'Strict planned disable must create no staging directory')
    assert.deepEqual(snapshotDesktopPluginProfile(profile), installedBaseline, 'Strict planned disable must not change profile bytes')
    const strictIdentity = await nativeHelper<Ownership>(home, environment, { action: 'verify', ownership }, helperLifecycle,
      boundedWorkDeadline(performance.now() + 90_000))
    assert.deepEqual({ main: strictIdentity.main, host: strictIdentity.host },
      { main: ownershipBeforeStrict.main, host: ownershipBeforeStrict.host },
      'Strict planned disable must retain the same main and Host identities')

    const documentIdentity = await withinDeadline(boundedWorkDeadline(performance.now() + 10_000),
      () => firstPage.evaluate(() => performance.timeOrigin))
    let navigations = 0
    const onNavigation = (): void => { navigations++ }
    firstPage.on('domcontentloaded', onNavigation)
    const auditsBeforeToggle = auditNames(home)
    assert.deepEqual((await execute('/desktop-plugin disable desktop-unrelated-fixture')).result, { kind: 'success', text: PREPARED })
    evidence.beforeCancelTranscript = await exportTranscript(firstPage, home, sessionId, expected,
      boundedWorkDeadline(performance.now() + 30_000))
    evidence.nativeCancel = await nativeHelper(home, environment, { action: 'cancel', ownership }, helperLifecycle,
      boundedWorkDeadline(performance.now() + 90_000))
    const deadline = boundedWorkDeadline(performance.now() + 60_000)
    for (;;) {
      const listed = await execute('/desktop-plugin list', deadline)
      remainingDeadline(deadline)
      if (listed.result.kind === 'success') { assert.equal(listed.result.text, overrideListText); break }
      assert.equal(listed.result.text, BUSY, 'Only busy is transient while cancellation settles')
      await new Promise(resolveDelay => setTimeout(resolveDelay, Math.min(100, remainingDeadline(deadline))))
    }
    const after = snapshotDesktopPluginProfile(profile)
    assert.deepEqual(after, installedBaseline, 'Cancel must retain actual profile metadata and artifact bytes')
    const newAudits = auditNames(home).filter(name => !auditsBeforeToggle.includes(name))
    const records = newAudits.map(name => JSON.parse(readFileSync(join(home, 'desktop', 'profile-operations', name), 'utf8')) as unknown)
    validateDesktopPluginCancelAudit(records, 'desktop-unrelated-fixture', manifestNames)
    evidence.afterCancelIdentity = await nativeHelper(home, environment, { action: 'verify', ownership }, helperLifecycle,
      boundedWorkDeadline(performance.now() + 90_000))
    assert.equal(win32.pollProcessExit(api, owned.process), undefined, 'Cancel must retain the exact Job-created root')
    assert.equal(firstPage.url(), APPLICATION_URL)
    const afterCancelDocumentIdentity = await withinDeadline(boundedWorkDeadline(performance.now() + 10_000),
      () => firstPage.evaluate(() => performance.timeOrigin))
    assert.equal(afterCancelDocumentIdentity, documentIdentity, 'Cancel must not reload the app document')
    assert.equal(navigations, 0, 'Cancel must not navigate to startup/error or reload')
    const visibleErrors = await withinDeadline(boundedWorkDeadline(performance.now() + 10_000),
      () => firstPage.locator('#error:visible').count())
    assert.equal(visibleErrors, 0)
    firstPage.off('domcontentloaded', onNavigation)
    evidence.transcript = await exportTranscript(firstPage, home, sessionId, expected,
      boundedWorkDeadline(performance.now() + 30_000))
    evidence.transcriptInferenceAbsent = true
    evidence.commands = expected
    save('profile-hashes.json', { beforeColdStart: installedBaseline, afterCancel: after })
    save('cancel-audit.json', records)

    const preColdAudits = auditNames(home)
    const closeDeadline = boundedWorkDeadline(performance.now() + 60_000)
    evidence.firstNormalClose = await nativeHelper(home, environment, { action: 'close', ownership }, helperLifecycle, closeDeadline)
    const firstExitCode = await waitForOwnedJobExit(closeDeadline,
      () => win32.pollProcessExit(api, firstOwned.process), () => win32.isJobEmpty(api, firstOwned.job))
    assert.equal(firstExitCode, 0, 'First application teardown must exit successfully')
    quiescent = true
    await withinDeadline(boundedWorkDeadline(performance.now() + 10_000), async () => { await firstBrowser.close() })
    win32.closeHandleChecked(api, firstOwned.process, 'first fixture root process')
    processHandleClosed = true
    win32.closeHandleChecked(api, firstOwned.job, 'first fixture Job')
    jobHandleClosed = true
    owned = undefined; browser = undefined; page = undefined; ownership = undefined

    const coldLaunch = await launchOwnedRoot()
    const coldOwned = coldLaunch.owned
    const coldPage = coldLaunch.page
    browser = coldLaunch.browser; owned = coldOwned; page = coldPage; ownership = coldLaunch.ownership
    launchIdentity = coldLaunch.launchIdentity; mainIdentity = coldLaunch.main
    assert.notDeepEqual(ownership.main, firstMainIdentity,
      'Cold start must have a distinct process generation after epoch-A Job quiescence')
    assertDesktopProvisioningInventory(profile, plan)
    assert.deepEqual(snapshotDesktopPluginProfile(profile), installedBaseline,
      'Cold startup must reuse alpha36 and unrelated fixture without profile rewrite or downgrade')
    assert.deepEqual(auditNames(home), preColdAudits, 'Cold startup fast reuse must create no profile transaction audit')
    const coldDeadline = boundedWorkDeadline(performance.now() + 120_000)
    const coldSessionId = `desktop-plugin-cold-${randomUUID()}`
    const coldCreated = await remote<{ sessionId: string }>(coldPage, 'session/create',
      { request: { cwd: workspace, sessionId: coldSessionId } }, coldDeadline)
    assert.equal(coldCreated.sessionId, coldSessionId)
    const coldRegistry = await remote<readonly CommandDescriptor[]>(coldPage, 'commands/list', { agentId: coldSessionId }, coldDeadline)
    assert(coldRegistry.some(command => command.name === 'desktop-plugin'))
    const coldExecution = await remote<CommandExecution>(coldPage, 'commands/execute', {
      agentId: coldSessionId, line: '/desktop-plugin list', submittedAttachments: [],
    }, coldDeadline)
    assert.deepEqual(coldExecution.result, { kind: 'success', text: overrideListText })
    evidence.coldTranscript = await exportTranscript(coldPage, home, coldSessionId,
      [{ line: '/desktop-plugin list', execution: coldExecution }],
      Math.min(coldDeadline, boundedWorkDeadline(performance.now() + 30_000)))
    const coldOverride = assertOverrideEvidence()
    assert.deepEqual(coldOverride, overrideBaseline,
      'Cold startup must preserve exact effective receipt, artifact and selected materialized Copilot bytes')
    assert.deepEqual(assertUnrelatedEvidence(), unrelatedBaseline,
      'Cold startup must preserve unrelated local plugin lock, artifact, dependency and enabled bundle')
    evidence.coldStart = { secondMainIdentity: ownership.main,
      secondEpoch: { launch: launchIdentity, listener: mainIdentity, host: ownership.host }, override: coldOverride,
      unrelated: unrelatedBaseline, profileHashes: snapshotDesktopPluginProfile(profile),
      installedInstallerUpgradeVerified: false, differentRuntimeUpgradeVerified: false, liveOAuthOrModelVerified: false }
    const secondCloseDeadline = Math.min(performance.now() + 60_000, fixtureCleanupDeadline)
    evidence.secondNormalClose = await nativeHelper(home, environment, { action: 'close', ownership }, helperLifecycle, secondCloseDeadline)
    const secondExitCode = await waitForOwnedJobExit(secondCloseDeadline,
      () => win32.pollProcessExit(api, coldOwned.process), () => win32.isJobEmpty(api, coldOwned.job))
    quiescent = true
    assert.equal(secondExitCode, 0, 'Cold-start application teardown must exit successfully')
    evidence.quiescent = { firstExitCode, secondExitCode, jobEmpty: true, normalClose: true, helperTreeUncertain: false }
    evidence.timing = { workElapsedMs: performance.now() - fixtureStarted,
      workBudgetMs: fixtureWorkDeadline - fixtureStarted, cleanupReserveMs: fixtureCleanupDeadline - fixtureWorkDeadline }
    acceptedEvidence = { ...evidence }
  } catch (error) {
    failure = error
    save('failure.json', { ...evidence, quiescent: false, spawnAttempted,
      helperTreeUncertain: helperLifecycle.helperTreeUncertain, error: safeDiagnostic(error),
      stderrTail: safeDiagnostic(stderrPaths.map(path => boundedFileTail(path)).join('\n').slice(-32_768)),
      commands: expected, pageUrl: page?.url(), retainedHomeOnCleanupFailure: home })
    throw error
  } finally {
    const errors: unknown[] = []
    if (!quiescent && owned !== undefined) {
      // Covers every post-spawn failure, including absent CDP, app-ready or native identity capture.
      const cleanupOwned = owned
      try {
        win32.terminateJob(api, cleanupOwned.job, 1)
        const cleanupDeadline = Math.min(performance.now() + 60_000, fixtureCleanupDeadline)
        await waitForOwnedJobExit(cleanupDeadline,
          () => win32.pollProcessExit(api, cleanupOwned.process), () => win32.isJobEmpty(api, cleanupOwned.job))
        quiescent = true
      } catch (error) { errors.push(error) }
    } else if (owned === undefined && !spawnAttempted) quiescent = true
    if (spawnAttempted && owned === undefined) {
      errors.push(new Error(`Spawn threw without returned handles; child cleanup is unknown; retained private home: ${home}`))
    }
    if (helperLifecycle.helperTreeUncertain) {
      errors.push(new Error(`Native helper tree is uncertain after abnormal completion; retained private home: ${home}`))
    }
    // Never use a Playwright launcher or its PID-kill tree logic. A CDP connection is disconnected only
    // AFTER the retained Job proves quiescence (browser.close on connectOverCDP disconnects the client).
    if (quiescent) {
      try {
        await withinDeadline(Math.min(performance.now() + 10_000, fixtureCleanupDeadline), async () => {
          await browser?.close()
        })
      } catch (error) { errors.push(error) }
      if (owned !== undefined) {
        const pendingHandles = new Set(pendingDesktopPluginHandles(processHandleClosed, jobHandleClosed))
        if (pendingHandles.has('process')) {
          try {
            win32.closeHandleChecked(api, owned.process, 'fixture root process')
            processHandleClosed = true
          } catch (error) { errors.push(error) }
        }
        if (pendingHandles.has('job')) {
          try {
            win32.closeHandleChecked(api, owned.job, 'fixture Job')
            jobHandleClosed = true
          } catch (error) { errors.push(error) }
        }
      }
    } else errors.push(new Error(`Cannot prove process exit AND empty Job; retained handles and private home: ${home}`))
    for (const fd of descriptors) {
      try { closeSync(fd) } catch (error) { errors.push(error) }
    }
    if (canRemoveDesktopPluginHome({ spawnAttempted, jobOwned: owned !== undefined,
      jobQuiescent: quiescent, helperTreeUncertain: helperLifecycle.helperTreeUncertain }) && errors.length === 0) {
      try { removeOwnedDirectory(home) } catch (error) { errors.push(error) }
    }
    if (errors.length > 0) {
      save('cleanup-failure.json', { errors: errors.map(safeDiagnostic), home, quiescent: false,
        appJobQuiescent: quiescent, spawnAttempted, helperTreeUncertain: helperLifecycle.helperTreeUncertain })
      throw new AggregateError([...(failure === undefined ? [] : [failure]), ...errors], 'Packaged command acceptance cleanup failed')
    }
    if (acceptedEvidence !== undefined) save('acceptance.json', acceptedEvidence)
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { application: { type: 'string' }, output: { type: 'string' } }, allowPositionals: false })
  assert(values.application && values.output, 'Packaged application and evidence directory are required')
  await runPackagedDesktopPluginCommandAcceptance({ application: values.application, output: values.output })
}
