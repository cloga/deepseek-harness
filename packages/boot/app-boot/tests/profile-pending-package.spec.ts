import { describe, expect, it } from 'vitest'
import { parseProfilePendingChange, parseProfilePreparedChange } from '../src/profile-package-transactions.ts'
import type { ProfilePreparedBundleSelection, ProfilePreparedPackageChange } from '../src/types.ts'

const legacy: ProfilePreparedPackageChange = {
  transactionId: '12345678-1234-4234-8234-123456789abc', state: 'prepared', packageName: '@fixture/package',
  baseFingerprint: 'a'.repeat(64), health: 'pending',
}
const selection: ProfilePreparedBundleSelection = {
  schemaVersion: 2, kind: 'selection', transactionId: legacy.transactionId, state: 'prepared',
  packageNames: ['@fixture/a', '@fixture/b'], baseFingerprint: legacy.baseFingerprint, health: 'pending',
}

describe('versioned pending package inventory', () => {
  it.each(['pending', 'passed'] as const)('preserves the exact legacy five-field %s record and stage parser', (health) => {
    const input = Object.freeze({ ...legacy, health })
    const result = parseProfilePendingChange(input)
    expect(result).toEqual(input)
    expect(result).not.toBe(input)
    expect(Object.keys(result).sort()).toEqual(['baseFingerprint', 'health', 'packageName', 'state', 'transactionId'])
    expect(parseProfilePreparedChange(input)).toEqual(result)
  })

  it.each(['pending', 'passed'] as const)('copies every actual selection target without implying activation: %s', (health) => {
    const names = [...selection.packageNames]
    const input = { ...selection, health, packageNames: names }
    const before = JSON.stringify(input)
    const result = parseProfilePendingChange(input)
    expect(result).toEqual(input)
    expect(Object.keys(result).sort()).toEqual(['baseFingerprint', 'health', 'kind', 'packageNames', 'schemaVersion', 'state', 'transactionId'])
    expect(JSON.stringify(input)).toBe(before)
    expect('kind' in result).toBe(true)
    if (!('kind' in result)) throw new Error('Expected the explicit selection variant')
    expect(result.packageNames).not.toBe(names)
    names.push('later-mutation')
    expect(result.packageNames).toEqual(['@fixture/a', '@fixture/b'])
    expect(result).not.toHaveProperty('packageName')
    expect(() => parseProfilePreparedChange(input)).toThrow('invalid prepared result')
  })

  it('admits the exact target-count and package-length bounds without sorting caller data', () => {
    const names = Array.from({ length: 100 }, (_, index) => `package-${String(index).padStart(3, '0')}`)
    expect(parseProfilePendingChange({ ...selection, packageNames: names })).toMatchObject({ packageNames: names })
    expect(parseProfilePendingChange({ ...selection, packageNames: ['x'.repeat(214)] })).toMatchObject({ packageNames: ['x'.repeat(214)] })
    expect(parseProfilePendingChange({ ...selection, packageNames: ['@scope/pkg', 'a', 'z'] })).toMatchObject({ packageNames: ['@scope/pkg', 'a', 'z'] })
  })

  it.each([
    undefined, null, 1, '', [],
    { ...selection, schemaVersion: 1 }, { ...selection, schemaVersion: '2' }, { ...selection, schemaVersion: 3 },
    { ...selection, kind: 'install' }, { ...selection, state: 'active' },
    { ...selection, packageName: 'fake-single-target' }, { ...selection, extra: true },
    { schemaVersion: 2, kind: 'selection', ...legacy },
    { transactionId: legacy.transactionId, state: 'prepared', packageName: 'addon', baseFingerprint: legacy.baseFingerprint, extra: true },
    { ...selection, health: 'healthy' }, { ...selection, health: undefined },
    { ...selection, transactionId: 1 }, { ...selection, transactionId: '../escape' },
    { ...selection, transactionId: legacy.transactionId.toUpperCase() },
    { ...selection, transactionId: `${legacy.transactionId}\n` },
    { ...selection, baseFingerprint: 1 }, { ...selection, baseFingerprint: 'A'.repeat(64) },
    { ...selection, baseFingerprint: 'a'.repeat(63) },
    { ...selection, baseFingerprint: `${legacy.baseFingerprint}\n` },
    { ...selection, packageNames: null }, { ...selection, packageNames: 'a' }, { ...selection, packageNames: [] },
    { ...selection, packageNames: Array.from({ length: 101 }, (_, index) => `package-${String(index).padStart(3, '0')}`) },
    { ...selection, packageNames: ['a', 'a'] }, { ...selection, packageNames: ['z', 'a'] },
    { ...selection, packageNames: [''] }, { ...selection, packageNames: ['UPPER'] },
    { ...selection, packageNames: ['x'.repeat(215)] }, { ...selection, packageNames: ['../package'] },
    { ...selection, packageNames: ['@/package'] }, { ...selection, packageNames: ['@scope/_package'] },
    { ...selection, packageNames: ['a b'] }, { ...selection, packageNames: ['a\n'] },
    { ...selection, packageNames: [1] }, { ...selection, packageNames: [undefined] },
    { ...selection, packageNames: new Array(1) },
    { ...legacy, schemaVersion: 2 }, { ...legacy, kind: 'selection' }, { ...legacy, packageNames: ['a'] },
  ])('rejects malformed, mixed or falsely widened pending data %#', (input) => {
    expect(() => parseProfilePendingChange(input)).toThrow()
  })

  it.each(Object.keys(selection))('rejects a missing selection field %s', (field) => {
    const input = { ...selection }
    Reflect.deleteProperty(input, field)
    expect(() => parseProfilePendingChange(input)).toThrow()
  })

  it('rejects inherited required fields and extra symbol data', () => {
    const inherited = Object.assign(Object.create({ kind: 'selection' }), selection) as Record<string, unknown>
    Reflect.deleteProperty(inherited, 'kind')
    expect(() => parseProfilePendingChange(inherited)).toThrow()
    expect(() => parseProfilePendingChange({ ...selection, [Symbol('extra')]: true })).toThrow()
    const hidden = { ...selection }
    Object.defineProperty(hidden, 'health', { value: 'pending', enumerable: false })
    expect(() => parseProfilePendingChange(hidden)).toThrow()
  })
})
