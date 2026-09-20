/** Non-GUI guards for the independent packaged command acceptance fixture. */
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { CommandExecution } from '@deepseek-ai/dsh-commands/types'
import { removeOwnedDirectory } from '../src/owned-directory.ts'

vi.mock('playwright', () => { throw new Error('Import safety: Playwright must not load on fixture import') })
vi.mock('@deepseek-ai/dsh-win32-process/src/index.ts', () => { throw new Error('Import safety: Win32/Koffi loader must remain lazy') })
vi.mock('@deepseek-ai/dsh-win32-process/src/process.ts', () => { throw new Error('Import safety: native process module must remain lazy') })
vi.mock('../scripts/packaged-runtime.mjs', () => { throw new Error('Import safety: packaged verifier must remain lazy') })
vi.mock('node:child_process', () => ({ spawn: () => { throw new Error('Import safety: no subprocess may start') } }))

import {
  canRemoveDesktopPluginHome,
  runPackagedDesktopPluginCommandAcceptance,
  snapshotDesktopPluginProfile,
  validateDesktopPluginTranscript,
} from './fixtures/desktop-plugin-command-smoke.ts'

import {
  parseDesktopDevToolsPort, remainingDeadline, validateDesktopPluginCancelAudit, waitForOwnedJobExit, withinDeadline,
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

function cancellationAudit(): Record<string, unknown>[] {
  const inventory = { sha256: 'a'.repeat(64), names: ['@example/a', '@example/b'] }
  const common = { schemaVersion: 1, transaction: '.desktop-transaction-Ab1234', target: '@example/a',
    operation: 'plugin-toggle', phase: 'preparation', before: inventory }
  return [
    { ...common, recordedAt: '2026-01-01T00:00:00.000Z', outcome: 'started', after: null },
    { ...common, recordedAt: '2026-01-01T00:00:01.000Z', outcome: 'failed', after: inventory },
  ]
}
const auditNames = ['@example/a', '@example/b']
const validateAudit = (values: unknown[]): void => { validateDesktopPluginCancelAudit(values, '@example/a', auditNames) }

describe('packaged desktop-plugin command fixture (no GUI)', () => {
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

  it('requires a same-transaction started/failed pair retaining known nonempty inventory', () => {
    expect(() => { validateAudit(cancellationAudit()) }).not.toThrow()
    expect(() => { validateAudit([]) }).toThrow()
    expect(() => { validateAudit(cancellationAudit().slice(1)) }).toThrow()
  })

  it.each(['transaction', 'before', 'after', 'schemaVersion', 'recordedAt'])(
    'rejects missing audit field %s rather than undefined equality', (field) => {
      const records = cancellationAudit().map(record => Object.fromEntries(Object.entries(record).filter(([key]) => key !== field)))
      expect(() => { validateAudit(records) }).toThrow()
    },
  )

  it.each([undefined, null, {}, { sha256: 'not-a-digest', names: auditNames },
    { sha256: 'a'.repeat(64), names: [] }, { names: auditNames },
    { sha256: 'a'.repeat(64), names: [...auditNames].reverse() },
    { sha256: 'a'.repeat(64), names: ['unknown'] }])('rejects malformed inventory %#', (inventory) => {
    const records = cancellationAudit()
    records[0]!.before = inventory
    records[1]!.before = inventory
    records[1]!.after = inventory
    expect(() => { validateAudit(records) }).toThrow()
  })

  it('rejects committed, different transaction/target, missing start, and changed retained digest', () => {
    for (const [field, value] of [['outcome', 'committed'], ['transaction', '.desktop-transaction-other'],
      ['target', '@example/b'], ['outcome', 'started'], ['after', { sha256: 'b'.repeat(64), names: auditNames }]] as const) {
      const records = cancellationAudit()
      records[1]![field] = value
      expect(() => { validateAudit(records) }).toThrow()
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

  it('accepts durable prepared success without pretending that Cancel is installed success', () => {
    expect(validateDesktopPluginTranscript('session.v2.jsonl', transcript(), sessionId, expected)).toMatchObject({
      filename: 'session.v2.jsonl', sessionId, commands: 1, eventTypes: ['command/run', 'command/done'],
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
