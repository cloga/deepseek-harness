/** The new internal Host must not read a profile or begin boot when Electron does not own private IPC. */
import { expect, it } from 'vitest'
import { runAlpha2DesktopHost } from '../src/alpha2-entry.ts'

it('rejects an orphaned Desktop process before registering listeners or opening a profile', async () => {
  const previousConnected = Object.getOwnPropertyDescriptor(process, 'connected')
  const previousSend = Object.getOwnPropertyDescriptor(process, 'send')
  const messagesBefore = process.listenerCount('message')
  const disconnectBefore = process.listenerCount('disconnect')
  try {
    Object.defineProperty(process, 'connected', { configurable: true, value: false })
    Object.defineProperty(process, 'send', { configurable: true, value: undefined })
    await expect(runAlpha2DesktopHost()).rejects.toThrow('desktop alpha2: private shell IPC is required')
    expect(process.listenerCount('message')).toBe(messagesBefore)
    expect(process.listenerCount('disconnect')).toBe(disconnectBefore)
  } finally {
    for (const [key, previous] of [['connected', previousConnected], ['send', previousSend]] as const) {
      if (previous === undefined) Reflect.deleteProperty(process, key)
      else Object.defineProperty(process, key, previous)
    }
  }
})
