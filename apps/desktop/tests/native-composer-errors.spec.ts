import { EventEmitter } from 'node:events'
import type { Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { observeNativeComposerErrors } from './fixtures/native-composer-errors.ts'

const transportError = 'Failed to load resource: net::ERR_FAILED'
const consoleError = () => ({ type: () => 'error', text: () => transportError })

function fixture() {
  const events = new EventEmitter()
  // Real event dispatch/removal semantics, without starting a browser or imitating DOM.
  const page = events as unknown as Pick<Page, 'on' | 'off'>
  return { events, page }
}

describe('native composer error observation lifetime', () => {
  it('seals stable owned evidence before asynchronous shutdown events and preserves other listeners', async () => {
    const { events, page } = fixture()
    const otherConsoleListener = vi.fn()
    events.on('console', otherConsoleListener)
    const result = await observeNativeComposerErrors(page, async () => {
      expect(events.listenerCount('pageerror')).toBe(1)
      expect(events.listenerCount('console')).toBe(2)
      await Promise.resolve()
      return { measured: true }
    })
    expect(result.inspection).toEqual({ measured: true })
    expect(Object.isFrozen(result.rendererErrors)).toBe(true)
    expect(events.listenerCount('pageerror')).toBe(0)
    expect(events.listenerCount('console')).toBe(1)
    const evidence = { rendererErrors: result.rendererErrors }
    const firstFile = JSON.stringify(evidence)
    await Promise.resolve().then(() => {
      events.emit('console', consoleError())
      events.emit('pageerror', new Error('post-observation page shutdown'))
    })
    expect(otherConsoleListener).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(evidence)).toBe(firstFile)
    expect(result.rendererErrors).toEqual([])
    events.off('console', otherConsoleListener)
  })

  it('rejects the same transport text when delivered during the acceptance scope', async () => {
    const { events, page } = fixture()
    await expect(observeNativeComposerErrors(page, async () => {
      await Promise.resolve()
      events.emit('console', consoleError())
      return 'not accepted'
    })).rejects.toMatchObject({ actual: [transportError], expected: [] })
    expect(events.listenerCount('console')).toBe(0)
    expect(events.listenerCount('pageerror')).toBe(0)
  })

  it('retains every page and console error received before a deferred inspection completes', async () => {
    const { events, page } = fixture()
    const finish = Promise.withResolvers<undefined>()
    const result = observeNativeComposerErrors(page, async () => { await finish.promise; return 'completed' })
    const rejected = expect(result).rejects.toMatchObject({ actual: ['during inspection', transportError], expected: [] })
    events.emit('pageerror', new Error('during inspection'))
    events.emit('console', consoleError())
    finish.resolve(undefined)
    await rejected
    expect(events.listenerCount('console')).toBe(0)
    expect(events.listenerCount('pageerror')).toBe(0)
  })

  it('removes its callbacks and preserves an inspection failure without producing success evidence', async () => {
    const { events, page } = fixture()
    const failure = new Error('native dialog did not close')
    await expect(observeNativeComposerErrors(page, async () => { throw failure })).rejects.toBe(failure)
    expect(events.listenerCount('console')).toBe(0)
    expect(events.listenerCount('pageerror')).toBe(0)
  })
})
