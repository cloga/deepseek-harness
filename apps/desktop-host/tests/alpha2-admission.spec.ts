/** A pending or failed private packet cannot unlock the Desktop HTTP admission gate. */
import { expect, it } from 'vitest'
import { Alpha2TransportAdmission } from '../src/alpha2-admission.ts'

it('refuses early and stale unlock, including while the transport send awaits ACK', async () => {
  const owner = new Alpha2TransportAdmission()
  const previous = new Alpha2TransportAdmission()
  expect(previous.generationId).not.toBe(owner.generationId)
  expect(owner.mayUnlock(owner.generationId)).toBe(false)
  expect(owner.mayUnlock(previous.generationId)).toBe(false)
  expect(owner.mayUnlock(undefined)).toBe(false)
  const sent = Promise.withResolvers<undefined>()
  const publishing = owner.publish(() => sent.promise)
  expect(owner.mayUnlock(owner.generationId)).toBe(false)
  sent.resolve(undefined)
  await publishing
  expect(owner.mayUnlock(owner.generationId)).toBe(true)
  expect(owner.mayUnlock(previous.generationId)).toBe(false)
  expect(owner.mayUnlock(undefined)).toBe(false)
})

it('leaves admission closed when the parent rejects the transport packet', async () => {
  const owner = new Alpha2TransportAdmission()
  const denied = new Error('parent IPC send failed')
  await expect(owner.publish(() => Promise.reject(denied))).rejects.toBe(denied)
  expect(owner.mayUnlock(owner.generationId)).toBe(false)
})
