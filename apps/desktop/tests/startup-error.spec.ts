import { expect, it } from 'vitest'
import { DesktopProvisioningOverrideError, DesktopProvisioningOverrideHealthError } from '../src/project-manager.ts'
import { desktopErrorState } from '../src/startup-error.ts'

it('publishes one retained recovery suggestion without inventing health causality', () => {
  const failure = new DesktopProvisioningOverrideHealthError('provider', '1.0.0', new Error('unrelated graph failure'))
  const state = desktopErrorState(failure)
  expect(state.message).toContain('health failed while user override provider was active')
  expect(state.recovery).toEqual({
    type: 'restore-planned-source', packageName: 'provider', requestedVersion: '1.0.0',
  })
})

it('does not choose arbitrarily between different nested package recoveries', () => {
  const first = new DesktopProvisioningOverrideError('first', '1.0.0')
  const second = new DesktopProvisioningOverrideError('second', '2.0.0')
  expect(desktopErrorState(new AggregateError([first, second], 'several failures')).recovery).toBeUndefined()
  expect(desktopErrorState(new AggregateError([first, first], 'same failure')).recovery)
    .toEqual({ type: 'restore-planned-source', packageName: 'first', requestedVersion: '1.0.0' })
})
