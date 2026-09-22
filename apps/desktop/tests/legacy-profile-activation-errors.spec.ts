/** Real inert directories with injected inspection/close faults, never product or operator state. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { assertNoLegacyDesktopActivation, DesktopLegacyActivationRefusal, isDesktopLegacyActivationRefusal, isDesktopLegacyActivationFailure } from '../src/legacy-profile-activation.ts'
import { resolveDesktopPaths } from '../src/paths.ts'
import { retainedTree } from './legacy-activation-fixture.ts'

const faults = vi.hoisted(() => ({
  inspect: false, read: false, close: false,
  primary: undefined as unknown, secondary: undefined as unknown, closes: 0, opens: 0,
}))
vi.mock('node:fs', async (original) => {
  const fs = await original<typeof import('node:fs')>()
  return {
    ...fs,
    lstatSync: (...args: Parameters<typeof fs.lstatSync>) => {
      if (faults.inspect) throw faults.primary
      return fs.lstatSync(...args)
    },
    opendirSync: (...args: Parameters<typeof fs.opendirSync>) => {
      const directory = fs.opendirSync(...args)
      faults.opens++
      const read = directory.readSync.bind(directory)
      const close = directory.closeSync.bind(directory)
      directory.readSync = () => {
        if (faults.read) throw faults.primary
        return read()
      }
      directory.closeSync = () => {
        close()
        faults.closes++
        if (faults.close) throw faults.secondary
      }
      return directory
    },
  }
})
const roots: string[] = []
beforeEach(() => {
  Object.assign(faults, { inspect: false, read: false, close: false, primary: undefined, secondary: undefined, closes: 0, opens: 0 })
})
afterEach(() => {
  faults.inspect = false
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})
function fixture() {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'legacy-inspection-failure-')))
  roots.push(root)
  const paths = resolveDesktopPaths(root)
  mkdirSync(dirname(paths.profile))
  return { root, paths }
}
function failureOf(operation: () => void): unknown {
  try { operation() } catch (error) { return error }
  throw new Error('Expected legacy inspection to refuse')
}

it.each(['error', 'undefined', 'typed'] as const)('preserves first %s scan failure when closing also fails', (kind) => {
  const f = fixture()
  const before = retainedTree(f.root)
  const primary = kind === 'error' ? new Error('scan failed')
    : kind === 'typed' ? new DesktopLegacyActivationRefusal('retained evidence') : undefined
  const secondary = new Error('close failed')
  Object.assign(faults, { read: true, close: true, primary, secondary })
  const error = failureOf(() => { assertNoLegacyDesktopActivation(f.paths) })
  expect(isDesktopLegacyActivationRefusal(error)).toBe(true)
  if (!isDesktopLegacyActivationRefusal(error)) throw new Error('Expected typed refusal')
  if (kind === 'typed') expect(error).toBe(primary)
  else {
    expect(Object.hasOwn(error, 'cause')).toBe(true)
    expect(error.cause).toBe(primary)
    expect(error.cause).not.toBe(secondary)
  }
  expect(faults.closes).toBe(1)
  expect(retainedTree(f.root)).toEqual(before)
})

it('keeps an actual policy refusal ahead of a later directory-close failure', () => {
  const f = fixture()
  mkdirSync(join(dirname(f.paths.profile), '.desktop-transaction-ambiguous_name'))
  const before = retainedTree(f.root)
  Object.assign(faults, { close: true, secondary: new Error('secondary close') })
  const error = failureOf(() => { assertNoLegacyDesktopActivation(f.paths) })
  expect(isDesktopLegacyActivationRefusal(error)).toBe(true)
  if (!isDesktopLegacyActivationRefusal(error)) throw new Error('Expected typed refusal')
  expect(error.message).toContain('ambiguous alpha1 transaction name')
  expect(Object.hasOwn(error, 'cause')).toBe(false)
  expect(faults.closes).toBe(1)
  expect(retainedTree(f.root)).toEqual(before)
})

it('surfaces a close-only failure as unsafe legacy inspection with its original cause', () => {
  const f = fixture()
  const before = retainedTree(f.root)
  const secondary = new Error('close only')
  Object.assign(faults, { close: true, secondary })
  const error = failureOf(() => { assertNoLegacyDesktopActivation(f.paths) })
  expect(isDesktopLegacyActivationRefusal(error)).toBe(true)
  if (!isDesktopLegacyActivationRefusal(error)) throw new Error('Expected typed refusal')
  expect(error.cause).toBe(secondary)
  expect(faults.closes).toBe(1)
  expect(retainedTree(f.root)).toEqual(before)
})

it('classifies only errors from within legacy inspection and retains their cause', () => {
  const f = fixture()
  const before = retainedTree(f.root)
  const primary = new Error('unreadable legacy ancestor')
  Object.assign(faults, { inspect: true, primary })
  const error = failureOf(() => { assertNoLegacyDesktopActivation(f.paths) })
  faults.inspect = false
  expect(isDesktopLegacyActivationRefusal(error)).toBe(true)
  if (!isDesktopLegacyActivationRefusal(error)) throw new Error('Expected typed refusal')
  expect(error.cause).toBe(primary)
  expect(faults.opens).toBe(0)
  expect(retainedTree(f.root)).toEqual(before)
  expect(isDesktopLegacyActivationRefusal(primary)).toBe(false)
  expect(isDesktopLegacyActivationRefusal(new Error('desktop legacy activation: same words'))).toBe(false)
  expect(isDesktopLegacyActivationRefusal({ name: 'DesktopLegacyActivationRefusal' })).toBe(false)
})

it('classifies the actual staging cleanup wrapper without changing its original causes', () => {
  const primary = new DesktopLegacyActivationRefusal('retained legacy evidence')
  const cleanup = new Error('private stage cleanup failed')
  const error = new AggregateError([primary, cleanup],
    'desktop package staging: preparation failed and cleanup is incomplete', { cause: primary })
  expect(isDesktopLegacyActivationRefusal(error)).toBe(false)
  expect(isDesktopLegacyActivationFailure(primary)).toBe(true)
  expect(isDesktopLegacyActivationFailure(error)).toBe(true)
  expect(error.cause).toBe(primary)
  expect(error.errors[0]).toBe(primary)
  expect(error.errors[1]).toBe(cleanup)
})

it.each(['network', 'stale', 'nested', 'inherited', 'accessor', 'errors-only', 'lookalike', 'ordinary-error'] as const)(
  'does not broaden aggregate classification to %s causes or invoke getters', (kind) => {
    const primary = new DesktopLegacyActivationRefusal('typed leaf')
    const getter = vi.fn(() => primary)
    const error = new AggregateError([], 'desktop legacy activation: message is not authority')
    let value: unknown = error
    if (kind === 'accessor') Object.defineProperty(error, 'cause', { get: getter })
    else if (kind === 'inherited') {
      Object.setPrototypeOf(error, new AggregateError([], 'inherited cause', { cause: primary }))
    } else if (kind === 'lookalike') value = { name: 'AggregateError', cause: primary, errors: [primary] }
    else if (kind === 'ordinary-error') value = new Error('ordinary error with a typed cause', { cause: primary })
    else if (kind === 'errors-only') value = new AggregateError([primary], 'only the errors list mentions the refusal')
    else Object.defineProperty(error, 'cause', { value: kind === 'nested'
      ? new AggregateError([primary], 'nested aggregate', { cause: primary }) : new Error(kind) })
    expect(isDesktopLegacyActivationFailure(value)).toBe(false)
    expect(getter).not.toHaveBeenCalled()
  },
)
