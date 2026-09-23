/** The private Host packet refuses unbounded or unserializable Client boot rows. */
import type { IndexInjection } from '@deepseek-ai/dsh-host-webserver'
import { expect, it } from 'vitest'
import { assertAlpha2Injections, MAX_ALPHA2_INJECTION_BYTES } from '../src/alpha2-injections.ts'

it('accepts a bounded official Web injection without copying its value into diagnostics', () => {
  expect(() => assertAlpha2Injections([
    { kind: 'global', name: '__SAFE_BOOT__', value: { enabled: true } },
    { kind: 'script-src', placement: 'head', src: '/plugins/ui/client.js' },
  ])).not.toThrow()
})

it('refuses circular data using a fixed message that does not expose its marker', () => {
  const value: { marker: string; self?: unknown } = { marker: 'private-sentinel' }
  value.self = value
  expect(() => assertAlpha2Injections([{ kind: 'global', name: 'x', value }]))
    .toThrow('desktop alpha2: client module table is invalid')
  try { assertAlpha2Injections([{ kind: 'global', name: 'x', value }]) }
  catch (error) { expect(String(error)).not.toContain('private-sentinel') }
})

it('refuses too many rows before traversing their values', () => {
  const rows: IndexInjection[] = Array.from({ length: 4097 }, () => ({ kind: 'global', name: 'x', value: undefined }))
  expect(() => assertAlpha2Injections(rows)).toThrow('client module table exceeds its bound')
})

it('refuses oversized script text before transferring it to the parent IPC', () => {
  expect(() => assertAlpha2Injections([{ kind: 'script', placement: 'head', text: 'x'.repeat(MAX_ALPHA2_INJECTION_BYTES) }]))
    .toThrow('client module table exceeds its byte bound')
})
