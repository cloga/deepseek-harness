/** Parent IPC ACK/disconnect order is checked without touching the operator's process. */
import { expect, it } from 'vitest'
import { createAlpha2ParentStop, type Alpha2ParentStopPort } from '../src/alpha2-parent-stop.ts'

function fixture(options: { ackFailure?: Error; cleanupFailure?: Error; disconnectFailure?: Error } = {}) {
  const events: string[] = []
  let connected = true
  const port: Alpha2ParentStopPort = {
    closeBridge: () => { events.push('bridge-close') },
    application: async () => ({
      shutdown: {
        async shutdown(code: number) {
          events.push(`profile-shutdown:${String(code)}`)
          if (options.cleanupFailure !== undefined) throw options.cleanupFailure
        },
      },
    }),
    async acknowledge() {
      events.push('shutdown-complete')
      if (options.ackFailure !== undefined) throw options.ackFailure
    },
    connected: () => connected,
    disconnect: () => {
      events.push('disconnect')
      if (options.disconnectFailure !== undefined) throw options.disconnectFailure
      connected = false
    },
    detach: () => { events.push('remove-listeners') },
  }
  return { events, stop: createAlpha2ParentStop(port) }
}

it('coalesces shutdown, ACKs only after profile cleanup, and disconnects once', async () => {
  const { events, stop } = fixture()
  const first = stop()
  expect(stop()).toBe(first)
  await first
  await stop()
  expect(events).toEqual(['bridge-close', 'profile-shutdown:0', 'shutdown-complete', 'remove-listeners', 'disconnect'])
})

it('still closes the parent channel when its shutdown ACK cannot be delivered', async () => {
  const { events, stop } = fixture({ ackFailure: new Error('IPC send rejected') })
  await stop()
  expect(events).toEqual(['bridge-close', 'profile-shutdown:0', 'shutdown-complete', 'remove-listeners', 'disconnect'])
})

it('never sends a success ACK after failed profile cleanup, but releases the IPC', async () => {
  const cleanupFailure = new Error('profile dispose failed')
  const { events, stop } = fixture({ cleanupFailure })
  await expect(stop()).rejects.toBe(cleanupFailure)
  expect(events).toEqual(['bridge-close', 'profile-shutdown:0', 'remove-listeners', 'disconnect'])
})

it('retains both a tree failure and a failing disconnect instead of masking either', async () => {
  const cleanupFailure = new Error('profile dispose failed')
  const disconnectFailure = new Error('IPC disconnect failed')
  const { events, stop } = fixture({ cleanupFailure, disconnectFailure })
  await expect(stop()).rejects.toMatchObject({
    errors: [cleanupFailure, disconnectFailure],
  })
  expect(events).toEqual(['bridge-close', 'profile-shutdown:0', 'remove-listeners', 'disconnect'])
})
