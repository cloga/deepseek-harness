import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseProfilePreparedChange, parseProfileTransactionId, profilePackageLeaseTarget, withProfilePackageLease } from '../src/profile-package-transactions.ts'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })
function profile() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-profile-lease-'))
  roots.push(root)
  const active = join(root, 'desktop')
  mkdirSync(active)
  return { root, active }
}

it('keeps the same lease while the active directory is replaced and releases it after completion', async () => {
  const { root, active } = profile()
  const lease = profilePackageLeaseTarget(active)
  await withProfilePackageLease(active, async () => {
    expect(existsSync(`${lease}.lock`)).toBe(true)
    renameSync(active, join(root, 'rollback'))
    expect(profilePackageLeaseTarget(active)).toBe(lease)
    mkdirSync(active)
    expect(profilePackageLeaseTarget(active)).toBe(lease)
    expect(existsSync(`${lease}.lock`)).toBe(true)
  })
  expect(existsSync(`${lease}.lock`)).toBe(false)
})

it.skipIf(process.platform !== 'win32')('serializes Windows casing aliases through the same sibling lock', async () => {
  const { active } = profile()
  const alias = active.toUpperCase()
  let entered = false
  await withProfilePackageLease(active, async () => {
    // Windows may preserve parent-directory spelling in realpathSync; lock identity is filesystem identity.
    expect(existsSync(`${profilePackageLeaseTarget(alias)}.lock`)).toBe(true)
    await expect(withProfilePackageLease(alias, async () => { entered = true }, 0)).rejects.toThrow('timed out')
  })
  expect(entered).toBe(false)
  expect(existsSync(`${profilePackageLeaseTarget(active)}.lock`)).toBe(false)
  expect(existsSync(`${profilePackageLeaseTarget(alias)}.lock`)).toBe(false)
})

it.each(['win32', 'linux'] as const)('uses the %s basename policy without changing filesystem semantics', (platform) => {
  const { root } = profile()
  const active = join(root, 'MixedCaseProfile')
  mkdirSync(active)
  const canonical = realpathSync(active)
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  if (originalPlatform === undefined) throw new Error('Node must declare process.platform')
  // Only the synchronous basename policy is varied; native path/fs behavior stays that of the host.
  // The separate Windows-only case above checks actual filesystem casing aliases.
  try {
    Object.defineProperty(process, 'platform', { ...originalPlatform, value: platform })
    const name = platform === 'win32' ? basename(canonical).toLowerCase() : basename(canonical)
    expect(profilePackageLeaseTarget(active)).toBe(join(dirname(canonical), `.${name}.packages`))
  } finally {
    Object.defineProperty(process, 'platform', originalPlatform)
  }
})

it('rejects a regular file as an activation target without replacing it', () => {
  const { root } = profile()
  const file = join(root, 'not-a-profile')
  writeFileSync(file, 'preserve')
  expect(() => { profilePackageLeaseTarget(file) }).toThrow('real directory')
  expect(readFileSync(file, 'utf8')).toBe('preserve')
})

it('rejects a linked activation target rather than locking an alias', () => {
  const { root, active } = profile()
  const link = join(root, 'alias')
  symlinkSync(active, link, process.platform === 'win32' ? 'junction' : 'dir')
  expect(() => { profilePackageLeaseTarget(link) }).toThrow('real directory')
})

it('does not enter a mutation for an already cancelled request', async () => {
  const { active } = profile()
  const abort = new AbortController()
  abort.abort(new Error('cancelled'))
  let entered = false
  await expect(Promise.resolve().then(() => withProfilePackageLease(active, async () => { entered = true }, 1000, abort.signal)))
    .rejects.toThrow('cancelled')
  expect(entered).toBe(false)
})

it('checks cancellation again after asynchronous lease acquisition and releases the lock', async () => {
  const { active } = profile()
  const abort = new AbortController()
  const cancelled = new Error('cancelled while acquiring the lease')
  let entered = false
  const operation = withProfilePackageLease(active, async () => { entered = true }, 1000, abort.signal)
  abort.abort(cancelled)
  await expect(operation).rejects.toBe(cancelled)
  expect(entered).toBe(false)
  expect(existsSync(`${profilePackageLeaseTarget(active)}.lock`)).toBe(false)
})

it('returns the operation result with a live cancellation signal', async () => {
  const { active } = profile()
  const abort = new AbortController()
  await expect(withProfilePackageLease(active, async () => 'prepared', 1000, abort.signal)).resolves.toBe('prepared')
  expect(existsSync(`${profilePackageLeaseTarget(active)}.lock`)).toBe(false)
})

const transactionId = '12345678-1234-4234-8234-123456789abc'
const prepared = {
  transactionId,
  state: 'prepared',
  packageName: '@fixture/package',
  baseFingerprint: 'a'.repeat(64),
  health: 'pending',
} as const

it.each([undefined, null, 1, '', transactionId.toUpperCase(), `../${transactionId}`])(
  'rejects a noncanonical transaction identity %j', (value) => {
    expect(() => { parseProfileTransactionId(value) }).toThrow('invalid transaction id')
  },
)

it.each(['pending', 'passed'] as const)('copies a valid %s prepared record without claiming active health', (health) => {
  const input = Object.freeze({ ...prepared, health })
  const result = parseProfilePreparedChange(input)
  expect(result).toEqual(input)
  expect(result).not.toBe(input)
  expect(parseProfileTransactionId(result.transactionId)).toBe(transactionId)
})

it.each([
  { kind: 'undefined', value: undefined },
  { kind: 'null', value: null },
  { kind: 'boolean', value: true },
  { kind: 'number', value: 0 },
  { kind: 'string', value: 'prepared' },
  { kind: 'array', value: [] },
])('rejects a malformed prepared container $kind', ({ value }) => {
  expect(() => { parseProfilePreparedChange(value) }).toThrow('invalid prepared result')
})

it.each([
  ['missing field', { transactionId, state: 'prepared', packageName: 'package', baseFingerprint: 'a'.repeat(64) }],
  ['extra field', { ...prepared, active: true }],
  ['active state', { ...prepared, state: 'active' }],
  ['non-string package', { ...prepared, packageName: null }],
  ['invalid package', { ...prepared, packageName: '../package' }],
  ['non-string fingerprint', { ...prepared, baseFingerprint: null }],
  ['short fingerprint', { ...prepared, baseFingerprint: 'a'.repeat(63) }],
  ['uppercase fingerprint', { ...prepared, baseFingerprint: 'A'.repeat(64) }],
  ['invalid health', { ...prepared, health: 'healthy' }],
  ['non-string health', { ...prepared, health: null }],
] as const)('rejects a prepared record with %s', (_reason, value) => {
  expect(() => { parseProfilePreparedChange(value) }).toThrow('invalid prepared result')
})

it('rejects a malformed identity even when all other prepared fields are valid', () => {
  expect(() => { parseProfilePreparedChange({ ...prepared, transactionId: '../outside' }) }).toThrow('invalid transaction id')
})

it('accepts an unscoped package in a prepared record', () => {
  expect(parseProfilePreparedChange({ ...prepared, packageName: 'plain-package' })).toEqual({ ...prepared, packageName: 'plain-package' })
})
