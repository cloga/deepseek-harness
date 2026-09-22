import { describe, expect, it } from 'vitest'
import {
  isDesktopPluginCommandEvent, isDesktopPluginCommandOperation, isDesktopPluginCommandResponse,
} from '../src/desktop-plugin-command-protocol.ts'

const request = { type: 'plugin-command-request', requestId: 1, commandId: 'owned-command', operation: { type: 'list' } }

describe('control-only Desktop plugin command messages', () => {
  it.each([
    { type: 'list' }, { type: 'disable-all' },
    { type: 'install', source: { type: 'npm', spec: '@scope/plugin@1.0.0' } },
    { type: 'install', source: { type: 'github', spec: 'owner/repo#main' } },
    { type: 'install', source: { type: 'release', release: { schemaVersion: 1, type: 'githubRelease' } } },
    { type: 'remove', name: 'plugin' }, { type: 'update', name: 'plugin', version: '1.2.3+build' },
    { type: 'enable', name: 'plugin' }, { type: 'disable', name: 'plugin' },
  ])('admits only the existing closed operation %j', (operation) => {
    expect(isDesktopPluginCommandOperation(operation)).toBe(true)
    expect(isDesktopPluginCommandEvent({ ...request, operation })).toBe(true)
  })

  it.each([
    null, [], {}, { type: 'list', extra: true }, { type: 'disable-all', names: [] },
    { type: 'install', source: { type: 'file', spec: './plugin' } },
    { type: 'install', source: { type: 'npm', spec: '' } },
    { type: 'install', source: { type: 'github', spec: 'x'.repeat(4097) } },
    { type: 'install', source: { type: 'npm', spec: 'x'.repeat(1024 * 1024 + 1) } },
    { type: 'install', source: { type: 'npm', spec: '界'.repeat(400_000) } },
    { type: 'install', source: { type: 'release', release: [] } },
    { type: 'install', source: { type: 'release', release: null } },
    { type: 'install', source: { type: 'release', release: {}, path: 'untrusted' } },
    { type: 'install', source: { type: 'release', release: { data: 'x'.repeat(1024 * 1024) } } },
    { type: 'remove', name: '' }, { type: 'enable', name: 'x'.repeat(257) },
    { type: 'update', name: 'plugin', version: '' }, { type: 'update', name: 'plugin', version: '1', path: 'untrusted' },
    { type: 'toggle', name: 'plugin', enabled: true },
  ])('refuses widened or malformed operation case %#', (operation) => {
    expect(isDesktopPluginCommandOperation(operation)).toBe(false)
  })

  it('rejects a nonserializable Release object without interpreting it', () => {
    const release: Record<string, unknown> = {}
    release.self = release
    expect(isDesktopPluginCommandOperation({ type: 'install', source: { type: 'release', release } })).toBe(false)
  })

  it.each([
    request,
    { type: 'plugin-command-cancel', requestId: 1 },
    { type: 'plugin-command-settled', requestId: 1, commandId: 'owned-command' },
  ])('recognizes a distinct command event %j', (event) => { expect(isDesktopPluginCommandEvent(event)).toBe(true) })

  it.each([
    null, [], {}, { type: 'ready', url: 'http://127.0.0.1/' }, { type: 'shutdown-complete' },
    { type: 'update-tasks', requestId: 1, active: false },
    ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', undefined].map(requestId => ({ ...request, requestId })),
    { ...request, commandId: '' }, { ...request, commandId: 'x'.repeat(257) }, { ...request, commandId: 'line\nbreak' },
    { ...request, authority: true }, { type: 'plugin-command-cancel', requestId: 1, commandId: 'wrong-field' },
    { type: 'plugin-command-settled', requestId: 1 },
  ])('keeps malformed commands and other alpha2 control families separate: %j', (event) => {
    expect(isDesktopPluginCommandEvent(event)).toBe(false)
  })

  it.each([
    { kind: 'prepared' }, { kind: 'list', plugins: [] },
    { kind: 'list', plugins: [{ name: 'plugin', version: '1.0.0', enabled: false }] },
    ...['busy', 'failed', 'invalid', 'stale', 'unavailable'].map(code => ({ kind: 'error', code })),
  ])('admits bounded public response %j', (response) => { expect(isDesktopPluginCommandResponse(response)).toBe(true) })

  it.each([
    null, [], {}, { kind: 'prepared', directory: 'secret' }, { kind: 'error', code: 'unknown' },
    { kind: 'error', code: 'failed', diagnostic: 'secret' }, { kind: 'list', plugins: [{}] },
    { kind: 'list', plugins: [{ name: 'p', version: '1', enabled: true, source: {} }] },
    { kind: 'list', plugins: [{ name: '', version: '1', enabled: true }] },
    { kind: 'list', plugins: [{ name: 'p', version: '1', enabled: 'true' }] },
    { kind: 'list', plugins: [{ name: 'p', version: '1\nsecret', enabled: true }] },
    { kind: 'list', plugins: [{ name: 'p', version: '1', enabled: true }, { name: 'p', version: '2', enabled: false }] },
    { kind: 'list', plugins: Array.from({ length: 4097 }, () => ({ name: 'p', version: '1', enabled: true })) },
  ])('refuses private, malformed or oversized response case %#', (response) => {
    expect(isDesktopPluginCommandResponse(response)).toBe(false)
  })
})
