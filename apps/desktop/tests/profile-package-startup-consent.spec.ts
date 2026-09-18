import { expect, it } from 'vitest'
import { mayAuthorizeDesktopStartupPackage, type DesktopStartupPackageConsent } from '../src/profile-package-startup-consent.ts'

const transactionId = '12345678-1234-4234-8234-123456789abc'
const initial: DesktopStartupPackageConsent = {
  transactionId, startupTransactionId: transactionId, initialRecovery: true,
  everStartedHost: false, hostPresent: false, recoveryTransactionIds: [], privateProvisioning: true,
  preparedPlanSha256: 'a'.repeat(64), packagedPlanSha256: 'a'.repeat(64),
}

it('allows only the backend-bound fixed baseline before any Host spawn', () => {
  expect(mayAuthorizeDesktopStartupPackage(initial)).toBe(true)
})

type OptionalConsentField = 'startupTransactionId' | 'preparedPlanSha256' | 'packagedPlanSha256'
it.each<[string, Partial<DesktopStartupPackageConsent>, OptionalConsentField[]?]>([
  ['manual transaction', {}, ['startupTransactionId']],
  ['different transaction', { startupTransactionId: '87654321-4321-4321-8321-cba987654321' }],
  ['ordinary review', { initialRecovery: false }],
  ['partial failed spawn with no surviving Host', { everStartedHost: true, hostPresent: false }],
  ['live Host', { hostPresent: true }],
  ['same transaction recovery', { recoveryTransactionIds: [transactionId] }],
  ['another unfinished recovery', { recoveryTransactionIds: ['87654321-4321-4321-8321-cba987654321'] }],
  ['manual purpose with matching name', { privateProvisioning: false }],
  ['missing immutable resource', {}, ['preparedPlanSha256']],
  ['different packaged plan', { preparedPlanSha256: 'b'.repeat(64) }],
  ['no managed capability', {}, ['preparedPlanSha256', 'packagedPlanSha256']],
  ['malformed plan identity', { preparedPlanSha256: 'not-a-hash', packagedPlanSha256: 'not-a-hash' }],
])('requires native confirmation for %s', (_label, change, omitted = []) => {
  const input = { ...initial, ...change }
  for (const key of omitted) delete input[key]
  expect(mayAuthorizeDesktopStartupPackage(input)).toBe(false)
})
