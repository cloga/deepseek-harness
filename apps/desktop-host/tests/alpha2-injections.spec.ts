/** Exact private IPC snapshot: the original Webserver event rows never cross the parent channel. */
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { expect, it } from 'vitest'
import { parseBootManifest } from '@deepseek-ai/dsh-client-modules/client'
import { MAX_ALPHA2_INJECTION_BYTES, snapshotAlpha2Injections } from '../src/alpha2-injections.ts'

it('owns bounded JSON values and leaves the parent snapshot unchanged after producer mutation', () => {
  const source = { enabled: true, values: ['first'] }
  const rows: IndexInjection[] = [
    { kind: 'global', name: '__SAFE_BOOT__', value: source },
    { kind: 'script-src', placement: 'head', src: '/plugins/ui/client.js' },
  ]
  const owned = snapshotAlpha2Injections(rows)
  expect(Object.isFrozen(owned)).toBe(true)
  expect(Object.isFrozen(owned[0])).toBe(true)
  source.enabled = false
  source.values[0] = 'changed'
  rows[1] = { kind: 'script-src', placement: 'head', src: '/new.js' }
  expect(owned).toEqual([
    { kind: 'global', name: '__SAFE_BOOT__', value: { enabled: true, values: ['first'] } },
    { kind: 'script-src', placement: 'head', src: '/plugins/ui/client.js' },
  ])
  expect(Buffer.byteLength(JSON.stringify(owned), 'utf8')).toBeLessThan(MAX_ALPHA2_INJECTION_BYTES)
})

it('preserves the actual modules boot-graph wire shape and both bootstrap script kinds', () => {
  const loader = '@deepseek-ai/dsh-client-modules'
  const layout = '@deepseek-ai/dsh-client-ui-layout'
  const graph = {
    rev: 'graph-rev',
    entries: [
      { id: loader, url: '/plugins/bootstrap.js', rev: 'b1', immediately: true },
      { id: layout, url: '/plugins/application.js', rev: 'a1', inject: [loader] },
    ],
    batches: [
      { phase: 'bootstrap', url: '/plugins/bootstrap.js', rev: 'b1', entries: [loader] },
      { phase: 'application', url: '/plugins/application.js', rev: 'a1', entries: [layout] },
    ],
  }
  const owned = snapshotAlpha2Injections([
    { kind: 'script', placement: 'head', text: 'globalThis.__ModuleLoader__={mode:"queue"}' },
    { kind: 'script-preload', src: '/plugins/application.js' },
    { kind: 'script-src', placement: 'head', src: '/plugins/bootstrap.js' },
    { kind: 'global', name: '__DSH_BOOT__', value: graph },
  ])
  const boot = owned.find(row => row.kind === 'global')
  if (boot?.kind !== 'global') throw new Error('Producer graph was not retained')
  expect(parseBootManifest(boot.value)).toMatchObject({
    rev: 'graph-rev', modules: [{ id: loader }, { id: layout }], plugins: [{ id: loader }, { id: layout }],
  })
  expect(Object.isFrozen(boot.value)).toBe(true)
})

it('refuses an accessor at a top-level array index without invoking it', () => {
  let used = false
  const rows: IndexInjection[] = [{ kind: 'global', name: 'x', value: null }]
  Object.defineProperty(rows, '0', {
    configurable: true, enumerable: true, get() { used = true; return { kind: 'global', name: 'x', value: null } },
  })
  expect(() => snapshotAlpha2Injections(rows)).toThrow('client module table is invalid')
  expect(used).toBe(false)
})

it('refuses circular data using a fixed message without exposing its marker', () => {
  const value: { marker: string; self?: unknown } = { marker: 'private-sentinel' }
  value.self = value
  expect(() => snapshotAlpha2Injections([{ kind: 'global', name: 'x', value }]))
    .toThrow('desktop alpha2: client module table is invalid')
  try { snapshotAlpha2Injections([{ kind: 'global', name: 'x', value }]) }
  catch (error) { expect(String(error)).not.toContain('private-sentinel') }
})

it('never invokes a user toJSON or getter while refusing non-JSON global data', () => {
  let used = false
  const withToJSON = { marker: 'private-sentinel', toJSON() { used = true; return 'private-sentinel' } }
  expect(() => snapshotAlpha2Injections([{ kind: 'global', name: 'x', value: withToJSON }]))
    .toThrow('client module table is invalid')
  expect(used).toBe(false)
  const getter = Object.defineProperty({ marker: 'private-sentinel' }, 'credential', {
    enumerable: true, get() { used = true; return 'private-sentinel' },
  })
  expect(() => snapshotAlpha2Injections([{ kind: 'global', name: 'x', value: getter }]))
    .toThrow('client module table is invalid')
  expect(used).toBe(false)
})

it('rejects a custom-prototype service rather than enumerating its leaves', () => {
  class ServiceLike { readonly credential = 'private-sentinel' }
  expect(() => snapshotAlpha2Injections([{ kind: 'global', name: 'x', value: new ServiceLike() }]))
    .toThrow('client module table is invalid')
})

it('refuses too many rows before reading their values', () => {
  const rows: IndexInjection[] = Array.from({ length: 4097 }, () => ({ kind: 'global', name: 'x', value: undefined }))
  expect(() => snapshotAlpha2Injections(rows)).toThrow('client module table exceeds its bound')
})

it('refuses oversized script text before transferring it to the parent IPC', () => {
  expect(() => snapshotAlpha2Injections([{ kind: 'script', placement: 'head', text: 'x'.repeat(MAX_ALPHA2_INJECTION_BYTES) }]))
    .toThrow('client module table exceeds its byte bound')
})
