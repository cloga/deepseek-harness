import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import type { DesktopUpdatePresentation, DshDesktopProductApi } from '../src/ipc.ts'
import { installDesktopUpdateNoticeFixture } from '../scripts/smoke-update-notice.ts'

const fixtureVersion = '0.1.5-rc.3.cloga.7'

function mountFixture(storage = new Map<string, string>()) {
  const fixtureWindow = {} as {
    dshDesktop: DshDesktopProductApi
    __dshDesktopUpdateNoticeFixture: {
      readonly reviewCalls: number
      readonly snapshotReads: number
      readonly subscriberCount: number
      publish(state: DesktopUpdatePresentation): void
    }
  }
  // Playwright serializes this function into the page before navigation; no module closure survives.
  runInNewContext(`(${installDesktopUpdateNoticeFixture.toString()})(${JSON.stringify(fixtureVersion)})`, {
    window: fixtureWindow,
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value) },
    },
  })
  return { bridge: fixtureWindow.dshDesktop, fixture: fixtureWindow.__dshDesktopUpdateNoticeFixture, storage }
}

describe('Desktop update notice external-boundary fixture', () => {
  it('serializes standalone and exposes only the application notification API', async () => {
    const { bridge, fixture } = mountFixture()
    expect(bridge.protocolVersion).toBe(1)
    expect(Object.keys(bridge).sort()).toEqual(['protocolVersion', 'updates'])
    expect(Object.keys(bridge.updates).sort()).toEqual(['open', 'status', 'subscribe'])
    expect(await bridge.updates.status()).toEqual({ phase: 'idle' })
    expect(fixture.snapshotReads).toBe(1)
    expect(fixture.reviewCalls).toBe(0)
  })

  it('publishes simulated states, retains Later, and disposes subscriptions', async () => {
    const { bridge, fixture } = mountFixture()
    const listener = vi.fn()
    const off = bridge.updates.subscribe(listener)
    expect(fixture.subscriberCount).toBe(1)
    expect(listener).not.toHaveBeenCalled()
    const available = { phase: 'available', version: fixtureVersion } as const
    fixture.publish(available)
    expect(listener).toHaveBeenCalledExactlyOnceWith(available)
    await bridge.updates.open()
    expect(fixture.reviewCalls).toBe(1)
    expect(await bridge.updates.status()).toEqual(available)
    expect(listener).toHaveBeenCalledOnce()
    off()
    off()
    expect(fixture.subscriberCount).toBe(0)
    fixture.publish({ phase: 'idle' })
    expect(listener).toHaveBeenCalledOnce()
    expect(await bridge.updates.status()).toEqual({ phase: 'idle' })
  })

  it('restores available through the reload snapshot without synthesizing a subscription event', async () => {
    const first = mountFixture()
    first.fixture.publish({ phase: 'available', version: fixtureVersion })
    await first.bridge.updates.open()
    const reloaded = mountFixture(first.storage)
    const listener = vi.fn()
    reloaded.bridge.updates.subscribe(listener)
    expect(await reloaded.bridge.updates.status()).toEqual({ phase: 'available', version: fixtureVersion })
    expect(listener).not.toHaveBeenCalled()
    expect(reloaded.fixture.reviewCalls).toBe(0)
    reloaded.fixture.publish({ phase: 'idle' })
    expect(await mountFixture(first.storage).bridge.updates.status()).toEqual({ phase: 'idle' })
    expect([...first.storage.keys()]).toEqual(['__dshDesktopUpdateNoticeFixture.availableOnReload'])
  })
})
