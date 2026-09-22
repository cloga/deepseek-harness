/** Non-GUI guards for the independent packaged command acceptance fixture. */
import { createHash } from 'node:crypto'
import { closeSync, fstatSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CommandExecution } from '@deepseek-ai/dsh-commands/types'
import { removeOwnedDirectory } from '../src/owned-directory.ts'

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, lstatSync: vi.fn(actual.lstatSync), readFileSync: vi.fn(actual.readFileSync) }
})
vi.mock('playwright', () => { throw new Error('Import safety: Playwright must not load on fixture import') })
vi.mock('@deepseek-ai/dsh-win32-process/src/index.ts', () => { throw new Error('Import safety: Win32/Koffi loader must remain lazy') })
vi.mock('@deepseek-ai/dsh-win32-process/src/process.ts', () => { throw new Error('Import safety: native process module must remain lazy') })
vi.mock('../scripts/packaged-runtime.mjs', () => { throw new Error('Import safety: packaged verifier must remain lazy') })
vi.mock('node:child_process', () => ({
  spawn: () => { throw new Error('Import safety: no subprocess may start') },
  execFileSync: () => { throw new Error('Import safety: no source process may start') },
}))

import {
  canRemoveDesktopPluginHome,
  openDesktopPluginInput,
  readDesktopPluginNativeObservations,
  runPackagedDesktopPluginCommandAcceptance,
  snapshotDesktopPluginProfile,
  validateDesktopPluginTranscript,
} from './fixtures/desktop-plugin-command-smoke.ts'

import {
  createDesktopPluginCommandOutcome, finalizeDesktopPluginCommandAcceptance,
  parseDesktopDevToolsPort, remainingDeadline, selectOwnedDesktopWindow, validateDesktopPageTitle,
  validateDesktopPluginCommandRun, validateDesktopPluginCancelAudit, validateDesktopWindowCapture, waitForOwnedJobExit, withinDeadline,
} from './fixtures/desktop-plugin-command-guards.ts'

const sessionId = 'command-only-test'
const commandId = 'command-1' as CommandExecution['commandId']
const result = { kind: 'success', text: 'Plugin change prepared. Review the native confirmation to restart the Desktop Host.' } as const
const expected = [{ line: '/desktop-plugin disable example', execution: { commandId, result } }]
function transcript(extra: object[] = []): string {
  return [
    { type: 'session', id: sessionId, version: 2 },
    { type: 'command/run', seq: 1, data: { commandId, name: 'desktop-plugin', args: ' disable example', source: { kind: 'user' } } },
    { type: 'command/done', seq: 2, data: { commandId, ...result } },
    ...extra,
  ].map(value => JSON.stringify(value)).join('\n') + '\n'
}

const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
const manifestText = JSON.stringify({ dependencies: { '@example/a': '1.0.0' }, dsh: { profile: { bundles: ['@example/a'] } } })
const auditContext = { transactionId: '11111111-2222-3333-4444-555555555555', commandId: 'command-1', target: '@example/a',
  profile: 'C:/owned/profile', runtimeDir: 'C:/owned/runtime', manifestText,
  baseline: { 'package.json': hash(manifestText), 'pnpm-lock.yaml': 'a'.repeat(64), '.env': null } }
function cancellationAudit() {
  const owner = { profile: auditContext.profile, runtimeDir: auditContext.runtimeDir, installAnchor: 'C:/owned',
    runtimeFingerprint: 'b'.repeat(64), dependencyRegistry: 'https://registry.example/', configPaths: [] }
  const baseFiles = [{ path: 'package.json', kind: 'file', sha256: hash(manifestText) },
    { path: 'pnpm-lock.yaml', kind: 'file', sha256: 'a'.repeat(64) }]
  const baseInputs: unknown[] = []
  const mutation = { kind: 'selection', packageNames: ['@example/a'], enabled: false }
  const commandOrigin = { kind: 'desktop-command', generation: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', requestId: 3, commandId: 'command-1' }
  const commandRequest = { kind: 'selection', names: ['@example/a'], enabled: false }
  const prepared: Record<string, unknown> = { schemaVersion: 2, owner, baseFiles, baseInputs,
    selectionBaseManifest: manifestText, baseGraphFingerprint: 'c'.repeat(64), candidateFingerprint: 'd'.repeat(64),
    mutation, commandOrigin, commandRequest,
    result: { schemaVersion: 2, kind: 'selection', transactionId: auditContext.transactionId, state: 'prepared',
      packageNames: ['@example/a'], baseFingerprint: hash(JSON.stringify({ owner, files: baseFiles, inputs: baseInputs })), health: 'pending' },
    requestFingerprint: hash(JSON.stringify({ mutation, commandOrigin, commandRequest })) }
  const discarded: Record<string, unknown> = { schemaVersion: 1, transactionId: auditContext.transactionId,
    ownerFingerprint: hash(JSON.stringify(owner)), requestFingerprint: prepared.requestFingerprint,
    candidateFingerprint: prepared.candidateFingerprint, state: 'discarded' }
  return { owner, prepared, discarded, retainedEntries: ['DISCARDED.json', 'PREPARED.json', 'owner.json'] }
}
const validateAudit = (value: ReturnType<typeof cancellationAudit>): void => { validateDesktopPluginCancelAudit(value, auditContext) }
const rehashAudit = (value: ReturnType<typeof cancellationAudit>): void => {
  const { prepared, discarded, owner } = value
  prepared.requestFingerprint = hash(JSON.stringify({ mutation: prepared.mutation,
    commandOrigin: prepared.commandOrigin, commandRequest: prepared.commandRequest }))
  const result = prepared.result as Record<string, unknown>
  result.baseFingerprint = hash(JSON.stringify({ owner, files: prepared.baseFiles, inputs: prepared.baseInputs }))
  discarded.requestFingerprint = prepared.requestFingerprint
  discarded.ownerFingerprint = hash(JSON.stringify(owner))
}

describe('packaged desktop-plugin command fixture (no GUI)', () => {
  const rootWindow = { hwnd: '1234', pid: 123, title: 'Actual app title', owner: '0', rootOwner: '1234',
    width: 1000, height: 700, visible: true, minimized: false }
  const selectWindow = (candidates: unknown) => selectOwnedDesktopWindow(candidates, rootWindow.pid, rootWindow.title)
  const capture = () => ({ hwnd: rootWindow.hwnd, title: rootWindow.title, showRequested: false,
    initialCandidates: [rootWindow], readyCandidates: [rootWindow] })
  const validateCapture = (value: unknown): void => {
    validateDesktopWindowCapture(value, rootWindow.pid, rootWindow.title, rootWindow.hwnd)
  }

  it('binds the command-only evidence to its exact hosted source and run before allocation', () => {
    const source = 'a'.repeat(40), tree = 'b'.repeat(40)
    const environment = { GITHUB_ACTIONS: 'true', GITHUB_REPOSITORY: 'cloga/deepseek-harness',
      RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_OS: 'Windows', GITHUB_SHA: source,
      GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2' }
    expect(validateDesktopPluginCommandRun(source, tree, environment)).toEqual({
      sourceCommit: source, sourceTree: tree, runId: '123', runAttempt: '2',
    })
    for (const [key, value] of Object.entries(environment)) {
      expect(() => validateDesktopPluginCommandRun(source, tree, { ...environment, [key]: value + '\n' })).toThrow()
    }
    for (const candidate of ['', source.toUpperCase(), source + '\n', 'c'.repeat(39)]) {
      expect(() => validateDesktopPluginCommandRun(candidate, tree, environment)).toThrow()
      expect(() => validateDesktopPluginCommandRun(source, candidate, environment)).toThrow()
    }
    expect(() => validateDesktopPluginCommandRun('c'.repeat(40), tree, environment)).toThrow()
    expect(() => validateDesktopPluginCommandRun(source, tree, { ...environment, GITHUB_RUN_ID: '0' })).toThrow()
  })

  it.each([new Error('primary'), undefined, null])('keeps the actual primary %# through diagnostics and cleanup failures', (primary) => {
    const outcome = createDesktopPluginCommandOutcome()
    const cleanup = new Error('owned cleanup'), diagnostics = new Error('failure report')
    outcome.retain(primary)
    outcome.retain(cleanup)
    const publish = vi.fn()
    let caught = false
    try {
      finalizeDesktopPluginCommandAcceptance(outcome, false, publish, (error, secondary) => {
        expect(error).toBe(primary)
        expect(secondary).toContain(cleanup)
        throw diagnostics
      })
    } catch (error) { caught = true; expect(error).toBe(primary) }
    expect(caught).toBe(true)
    expect(outcome.failed).toBe(true)
    expect(outcome.secondary).toContain(diagnostics)
    expect(publish).not.toHaveBeenCalled()
  })

  it.each([new Error('cleanup'), undefined, null])('fails cleanup-only %# rather than publishing success', (error) => {
    const outcome = createDesktopPluginCommandOutcome()
    outcome.retain(error)
    const publish = vi.fn(), report = vi.fn()
    let rejected = false
    try { finalizeDesktopPluginCommandAcceptance(outcome, false, publish, report) }
    catch (caught) { rejected = true; expect(caught).toBe(error) }
    expect(rejected).toBe(true)
    expect(publish).not.toHaveBeenCalled()
    expect(report).toHaveBeenCalledOnce()
  })

  it('requires positive cleanup before publication and preserves a failed exclusive success write', () => {
    const absent = createDesktopPluginCommandOutcome()
    const publish = vi.fn(), report = vi.fn()
    expect(() => { finalizeDesktopPluginCommandAcceptance(absent, false, publish, report) }).toThrow('cleanup is unconfirmed')
    expect(publish).not.toHaveBeenCalled()
    const complete = createDesktopPluginCommandOutcome()
    finalizeDesktopPluginCommandAcceptance(complete, true, publish, report)
    expect(publish).toHaveBeenCalledOnce()
    const failedWrite = createDesktopPluginCommandOutcome()
    let rejected = false
    try { finalizeDesktopPluginCommandAcceptance(failedWrite, true, () => { throw undefined }, () => { throw new Error('diagnostic') }) }
    catch (error) { rejected = true; expect(error).toBeUndefined() }
    expect(rejected).toBe(true)
    expect(failedWrite.failed).toBe(true)
  })

  it('requires bounded nonempty actual title without trimming or normalizing identity', () => {
    for (const title of [undefined, null, 123, '', '   ', '\n', 'App\u0000title', 'App\rtitle', 'a'.repeat(1025)]) {
      expect(() => { validateDesktopPageTitle(title) }).toThrow('bounded nonempty')
    }
    expect(() => { validateDesktopPageTitle('a'.repeat(1024)) }).not.toThrow()
    expect(() => { validateDesktopPageTitle('应用程序 – Actual title') }).not.toThrow()
    expect(selectWindow([{ ...rootWindow, title: ` ${rootWindow.title} ` }])).toBeUndefined()
    expect(selectWindow([{ ...rootWindow, title: rootWindow.title.toUpperCase() }])).toBeUndefined()
  })

  it('selects only exact PID/title, unowned root-owner self and nonempty client rectangle', () => {
    const unrelated = [
      { ...rootWindow, pid: 999 }, { ...rootWindow, title: 'Other title' },
      { ...rootWindow, owner: '5678' }, { ...rootWindow, rootOwner: '5678' },
      { ...rootWindow, width: 0 }, { ...rootWindow, height: -1 }, { ...rootWindow, hwnd: '0' },
    ]
    expect(selectWindow(unrelated)).toBeUndefined()
    expect(selectWindow([...unrelated, rootWindow])).toEqual(rootWindow)
    expect(selectWindow([rootWindow, ...unrelated])).toEqual(rootWindow)
    expect(selectWindow([])).toBeUndefined() // No inference of hidden vs not yet observable.
  })

  it('does not filter hidden/minimized roots or choose a visible/first candidate amid ambiguity', () => {
    for (const visibility of [{ visible: false, minimized: false }, { visible: true, minimized: true }]) {
      const hiddenOrMinimized = { ...rootWindow, ...visibility }
      expect(selectWindow([hiddenOrMinimized])).toEqual(hiddenOrMinimized)
      const other = { ...hiddenOrMinimized, hwnd: '5678', rootOwner: '5678' }
      for (const windows of [[rootWindow, other], [other, rootWindow]]) {
        expect(() => selectWindow(windows)).toThrow('Ambiguous')
      }
    }
    expect(() => selectWindow([rootWindow, rootWindow])).toThrow('Ambiguous')
  })

  it('bounds and validates helper observation evidence rather than trusting missing fields', () => {
    for (const candidates of [null, {}, Array.from({ length: 257 }, () => rootWindow),
      [{ ...rootWindow, visible: undefined }], [{ ...rootWindow, minimized: 'false' }],
      [{ ...rootWindow, hwnd: 'guess' }], [{ ...rootWindow, width: null }],
      [{ ...rootWindow, pid: 1.5 }], [{ ...rootWindow, title: 'a'.repeat(1025) }]]) {
      expect(() => selectWindow(candidates)).toThrow()
    }
  })

  it('retains initial hidden/minimized observations while requiring the same visible ready HWND', () => {
    expect(() => { validateCapture(capture()) }).not.toThrow()
    for (const visibility of [{ visible: false, minimized: false }, { visible: true, minimized: true }]) {
      const value = { ...capture(), showRequested: true, initialCandidates: [{ ...rootWindow, ...visibility }] }
      expect(() => { validateCapture(value) }).not.toThrow()
      expect(value.initialCandidates[0]).toMatchObject(visibility)
      expect(() => { validateCapture({ ...value, readyCandidates: value.initialCandidates }) }).toThrow('not visible')
    }
  })

  it('rejects missing, replaced, ambiguous or differently titled captured window evidence', () => {
    const replacement = { ...rootWindow, hwnd: '5678', rootOwner: '5678' }
    for (const value of [null, { ...capture(), title: 'Guessed title' }, { ...capture(), hwnd: '5678' },
      { ...capture(), showRequested: undefined }, { ...capture(), initialCandidates: [] },
      { ...capture(), readyCandidates: [] }, { ...capture(), readyCandidates: [replacement] },
      { ...capture(), initialCandidates: [replacement] },
      { ...capture(), readyCandidates: [rootWindow, replacement] }]) {
      expect(() => { validateCapture(value) }).toThrow()
    }
  })

  it('reads bounded native scan diagnostics without treating them as acceptance', () => {
    const home = mkdtempSync(join(tmpdir(), 'desktop-native-observations-'))
    const file = join(home, 'scan.jsonl')
    try {
      expect(readDesktopPluginNativeObservations(file)).toBe('Native observation file absent')
      expect(readDesktopPluginNativeObservations(home)).toContain('rejected')
      writeFileSync(file, '{"stage":"owned-controls","cancelCount":0}\n')
      expect(readDesktopPluginNativeObservations(file)).toBe('{"stage":"owned-controls","cancelCount":0}\n')
      writeFileSync(file, 'token=private-value https://example.test/owned?secret=private-value')
      expect(readDesktopPluginNativeObservations(file)).not.toContain('private-value')
      writeFileSync(file, 'x'.repeat(262_144))
      expect(readDesktopPluginNativeObservations(file)).toHaveLength(262_144)
      writeFileSync(file, 'x'.repeat(262_145))
      expect(readDesktopPluginNativeObservations(file)).toContain('rejected')
    } finally { removeOwnedDirectory(home) }
  })

  it('contains observation stat and read errors without exposing them or replacing helper outcomes', () => {
    const home = mkdtempSync(join(tmpdir(), 'desktop-native-observations-errors-'))
    const file = join(home, 'scan.jsonl')
    try {
      writeFileSync(file, '{}\n')
      vi.mocked(lstatSync).mockImplementationOnce(() => { throw new Error('private stat error') })
      expect(readDesktopPluginNativeObservations(file)).toBe('Native observation file unreadable')
      vi.mocked(readFileSync).mockImplementationOnce(() => { throw new Error('private read error') })
      expect(readDesktopPluginNativeObservations(file)).toBe('Native observation file unreadable')
      expect(readDesktopPluginNativeObservations(file)).toBe('{}\n')
    } finally {
      vi.mocked(lstatSync).mockReset()
      vi.mocked(readFileSync).mockReset()
      removeOwnedDirectory(home)
    }
  })

  it('supplies real EOF stdin from an exclusive private file rather than a DOS device name', () => {
    const home = mkdtempSync(join(tmpdir(), 'desktop-plugin-input-'))
    let fd: number | undefined
    try {
      fd = openDesktopPluginInput(home)
      expect(fstatSync(fd).isFile()).toBe(true)
      expect(readFileSync(join(home, 'electron.stdin')).length).toBe(0)
      expect(readSync(fd, Buffer.alloc(1), 0, 1, null)).toBe(0)
      expect(() => openDesktopPluginInput(home)).toThrow()
    } finally {
      if (fd !== undefined) closeSync(fd)
      removeOwnedDirectory(home)
    }
  })

  it('does not truncate an existing input path', () => {
    const home = mkdtempSync(join(tmpdir(), 'desktop-plugin-input-existing-'))
    try {
      const file = join(home, 'electron.stdin')
      writeFileSync(file, 'preserve')
      expect(() => openDesktopPluginInput(home)).toThrow()
      expect(readFileSync(file, 'utf8')).toBe('preserve')
    } finally { removeOwnedDirectory(home) }
  })
  it('retains home after spawn throws without returning ownership, even with a stale quiescence flag', () => {
    for (const jobQuiescent of [false, true]) {
      expect(canRemoveDesktopPluginHome({ spawnAttempted: true, jobOwned: false,
        jobQuiescent, helperTreeUncertain: false })).toBe(false)
    }
  })

  it('retains home after helper uncertainty even when root exited and app Job is empty', () => {
    expect(canRemoveDesktopPluginHome({ spawnAttempted: true, jobOwned: true,
      jobQuiescent: true, helperTreeUncertain: true })).toBe(false)
    expect(canRemoveDesktopPluginHome({ spawnAttempted: false, jobOwned: false,
      jobQuiescent: true, helperTreeUncertain: true })).toBe(false)
    expect(canRemoveDesktopPluginHome({ spawnAttempted: true, jobOwned: true,
      jobQuiescent: false, helperTreeUncertain: false })).toBe(false)
  })

  it('admits cleanup only before any app launch or with settled Job and normally closed helpers', () => {
    expect(canRemoveDesktopPluginHome({ spawnAttempted: false, jobOwned: false,
      jobQuiescent: false, helperTreeUncertain: false })).toBe(true)
    expect(canRemoveDesktopPluginHome({ spawnAttempted: true, jobOwned: true,
      jobQuiescent: true, helperTreeUncertain: false })).toBe(true)
  })

  it('requires an actual command-owned PREPARED2 and completed same-transaction discard', () => {
    expect(() => { validateAudit(cancellationAudit()) }).not.toThrow()
    const independent = cancellationAudit()
    ;(independent.prepared.commandOrigin as Record<string, unknown>).generation = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'
    ;(independent.prepared.commandOrigin as Record<string, unknown>).requestId = 9
    rehashAudit(independent)
    expect(() => { validateAudit(independent) }).not.toThrow()
  })

  it.each(['schemaVersion', 'owner', 'requestFingerprint', 'result', 'baseFiles', 'baseInputs', 'baseGraphFingerprint',
    'candidateFingerprint', 'mutation', 'commandOrigin', 'commandRequest', 'selectionBaseManifest'])(
    'rejects missing prepared field %s rather than undefined equality', (field) => {
      const value = cancellationAudit()
      value.prepared = Object.fromEntries(Object.entries(value.prepared).filter(([key]) => key !== field))
      expect(() => { validateAudit(value) }).toThrow()
    },
  )

  it.each([undefined, null, {}, [], [{ path: 'package.json', kind: 'file', sha256: 'invalid' }]])(
    'rejects malformed private base inventory %#', (files) => {
      const value = cancellationAudit()
      value.prepared.baseFiles = files
      expect(() => { validateAudit(value) }).toThrow()
    },
  )

  it('rejects rehashed semantic target, origin, manifest, metadata and owner substitutions', () => {
    const changes: ((value: ReturnType<typeof cancellationAudit>) => void)[] = [
      (value) => { (value.prepared.mutation as Record<string, unknown>).enabled = true },
      (value) => { (value.prepared.mutation as Record<string, unknown>).packageNames = ['@example/b'] },
      (value) => { (value.prepared.commandRequest as Record<string, unknown>).names = 'all' },
      (value) => { (value.prepared.commandOrigin as Record<string, unknown>).commandId = 'another-command' },
      (value) => { (value.prepared.commandOrigin as Record<string, unknown>).requestId = 0 },
      (value) => { value.prepared.selectionBaseManifest = manifestText + '\n' },
      (value) => { (value.prepared.baseFiles as Record<string, unknown>[])[1]!.sha256 = 'e'.repeat(64) },
      (value) => { value.owner.profile = 'C:/foreign/profile' },
      (value) => { value.prepared.provisioning = { schemaVersion: 1 } },
      (value) => { (value.prepared.result as Record<string, unknown>).packageNames = ['@example/b'] },
    ]
    for (const change of changes) {
      const value = cancellationAudit()
      change(value); rehashAudit(value)
      expect(() => { validateAudit(value) }).toThrow()
    }
  })

  it('rejects missing, incomplete, foreign or unbound discard and retained candidate/activation state', () => {
    for (const [field, replacement] of [['state', 'discarding'], ['state', 'committed'],
      ['transactionId', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'], ['ownerFingerprint', 'f'.repeat(64)],
      ['requestFingerprint', 'f'.repeat(64)], ['candidateFingerprint', 'f'.repeat(64)]]) {
      const value = cancellationAudit()
      value.discarded[field!] = replacement
      expect(() => { validateAudit(value) }).toThrow()
    }
    for (const field of Object.keys(cancellationAudit().discarded)) {
      const value = cancellationAudit()
      value.discarded = Object.fromEntries(Object.entries(value.discarded).filter(([key]) => key !== field))
      expect(() => { validateAudit(value) }).toThrow()
    }
    for (const entry of ['profile', 'ACTIVATION.json', 'rollback', 'store', 'acquisition', 'environment', 'registry-resolution-cache']) {
      const value = cancellationAudit()
      value.retainedEntries.push(entry)
      expect(() => { validateAudit(value) }).toThrow()
    }
  })

  it('validates private CDP port/path without accepting remote hosts or arbitrary websocket paths', () => {
    expect(parseDesktopDevToolsPort('9222\n/devtools/browser/abc-123\n')).toEqual({
      port: 9222, path: '/devtools/browser/abc-123', endpoint: 'ws://127.0.0.1:9222/devtools/browser/abc-123',
    })
    for (const text of ['0\n/devtools/browser/a', '65536\n/devtools/browser/a', '9222\nws://evil/a',
      '9222\n/devtools/browser/a?remote=x', '9222\n/devtools/browser/a\nextra', '9222\n/devtools/page/a']) {
      expect(() => parseDesktopDevToolsPort(text)).toThrow()
    }
  })

  it('passes remaining budget and rejects expired and late-success operations', async () => {
    expect(remainingDeadline(60_000, 59_950)).toBe(50)
    expect(() => remainingDeadline(60_000, 60_000)).toThrow('deadline')
    const clock = vi.spyOn(performance, 'now').mockReturnValue(100)
    try {
      expect(await withinDeadline(200, async (remaining) => { expect(remaining).toBe(100); return 'ok' })).toBe('ok')
      await expect(withinDeadline(200, async () => { clock.mockReturnValue(201); return 'late success' })).rejects.toThrow('deadline')
      const operation = vi.fn(async () => 'must not run')
      await expect(withinDeadline(200, operation)).rejects.toThrow('deadline')
      expect(operation).not.toHaveBeenCalled()
    } finally { clock.mockRestore() }
  })

  it('bounds an unresponsive operation instead of letting a 300-second RPC defeat cancellation settlement', async () => {
    vi.useFakeTimers()
    try {
      const operation = withinDeadline(performance.now() + 60_000, async (remaining) => {
        expect(remaining).toBeLessThanOrEqual(60_000)
        return await new Promise<never>(() => {})
      })
      const rejected = expect(operation).rejects.toThrow('deadline')
      await vi.advanceTimersByTimeAsync(60_001)
      await rejected
    } finally { vi.useRealTimers() }
  })

  it('waits for both root exit and Job emptiness, including late descendants after root exit', async () => {
    let poll = 0
    const exit = vi.fn(() => poll >= 1 ? 0 : undefined)
    const empty = vi.fn(() => poll >= 3)
    const result = await waitForOwnedJobExit(performance.now() + 1000, exit, empty, async () => { poll++ })
    expect(result).toBe(0)
    expect(poll).toBe(3)
    expect(empty).toHaveBeenCalledTimes(4)
    await expect(waitForOwnedJobExit(performance.now() - 1, () => 0, () => true)).rejects.toThrow('deadline')
  })

  it('imports without loading Electron, verifying a package, or spawning a helper', () => {
    expect(typeof runPackagedDesktopPluginCommandAcceptance).toBe('function')
  })

  it.each([2, 3])('accepts canonical generation %s durable prepared success without claiming installation', (version) => {
    const filename = `session.v${version}.jsonl`
    expect(validateDesktopPluginTranscript(filename, transcript().replace('"version":2', `"version":${version}`), sessionId, expected)).toMatchObject({
      filename, sessionId, commands: 1, eventTypes: ['command/run', 'command/done'],
    })
  })

  it.each(['user/message', 'assistant/message', 'turn/start', 'step/start', 'request/header', 'model/start', 'llm/request', 'tool/call', 'tool/result', 'task-run/start'])(
    'rejects inference or tool evidence: %s', (type) => {
      expect(() => validateDesktopPluginTranscript('session.v2.jsonl', transcript([{ type, seq: 3, data: {} }]), sessionId, expected))
        .toThrow('unexpectedly contains')
    },
  )

  it('rejects a second cancelled completion, unpaired ids, and changed command results', () => {
    expect(() => validateDesktopPluginTranscript('session.v2.jsonl', transcript([
      { type: 'command/done', seq: 3, data: { commandId, kind: 'error', text: 'cancelled' } },
    ]), sessionId, expected)).toThrow('exactly one run and one done')
    expect(() => validateDesktopPluginTranscript('session.v2.jsonl', transcript().replace(
      `"commandId":"${commandId}","kind"`, '"commandId":"other","kind"'), sessionId, expected)).toThrow()
    expect(() => validateDesktopPluginTranscript('session.v2.jsonl', transcript().replace(result.text, 'Installed successfully'), sessionId, expected)).toThrow()
  })

  it('rejects guessed/non-root generations and a wrong Session', () => {
    for (const filename of ['session.v0.jsonl', 'session.1.v2.jsonl', 'nested/session.v2.jsonl', 'session.v3.jsonl']) {
      expect(() => validateDesktopPluginTranscript(filename, transcript(), sessionId, expected)).toThrow()
    }
    expect(() => validateDesktopPluginTranscript('session.v2.jsonl', transcript(), 'wrong', expected)).toThrow()
    expect(() => validateDesktopPluginTranscript('session.v2.jsonl', transcript().replace('"version":2', '"version":2,"parentSession":{}'), sessionId, expected)).toThrow()
  })

  it('hashes exact metadata/artifact bytes and absence, excluding legitimate Session/audit churn', () => {
    const home = mkdtempSync(join(tmpdir(), 'desktop-command-profile-test-'))
    try {
      const profile = join(home, 'profile')
      mkdirSync(profile)
      mkdirSync(join(profile, '.desktop-plugin-artifacts'))
      writeFileSync(join(profile, 'package.json'), '{"dependencies":{}}\n')
      writeFileSync(join(profile, '.env'), '')
      writeFileSync(join(profile, '.desktop-plugin-artifacts', 'example.tgz'), new Uint8Array([0, 255, 1]))
      const before = snapshotDesktopPluginProfile(profile)
      expect(before['desktop-packages-pending']).toBeNull()
      writeFileSync(join(home, 'session.v2.jsonl'), 'legitimate Session change')
      expect(snapshotDesktopPluginProfile(profile)).toEqual(before)
      writeFileSync(join(profile, 'package.json'), '{"dependencies":{}}')
      expect(snapshotDesktopPluginProfile(profile)).not.toEqual(before)
      writeFileSync(join(profile, 'package.json'), '{"dependencies":{}}\n')
      writeFileSync(join(profile, '.desktop-plugin-artifacts', 'example.tgz'), new Uint8Array([0, 255, 2]))
      expect(snapshotDesktopPluginProfile(profile)).not.toEqual(before)
      writeFileSync(join(profile, '.desktop-plugin-artifacts', 'example.tgz'), new Uint8Array([0, 255, 1]))
      writeFileSync(join(profile, 'desktop-packages-pending'), '')
      expect(snapshotDesktopPluginProfile(profile)).not.toEqual(before)
    } finally { removeOwnedDirectory(home) }
  })
})
