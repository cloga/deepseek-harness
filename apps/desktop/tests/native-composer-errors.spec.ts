import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { runInNewContext } from 'node:vm'
import type { Page } from 'playwright'
import { describe, expect, it, vi } from 'vitest'
import { observeNativeComposerErrors } from './fixtures/native-composer-errors.ts'

describe('actual seeder resource-owner body with inert persistence ports', () => {
  it.each(['success', 'append', 'undefined-append', 'close', 'dispose', 'append-and-cleanups'] as const)(
    'publishes only after all resource owners settle: %s', async (stage) => {
      const source = readFileSync(new URL('./fixtures/seed-native-composer.mjs', import.meta.url), 'utf8')
      const marker = 'const ctx = new Context()'
      expect(source.split(marker)).toHaveLength(2)
      // Execute the unchanged resource-owner tail, not the Electron import/persistence implementation.
      const body = source.slice(source.indexOf(marker))
      const trace: string[] = []
      const primary = stage === 'undefined-append' ? undefined : new Error(stage)
      class Context {
        fiber = { dispose: async () => {
          trace.push('dispose')
          if (stage === 'dispose' || stage === 'append-and-cleanups') throw stage === 'dispose' ? primary : new Error('dispose secondary')
        } }

        async plugin(): Promise<void> { await Promise.resolve() }
        get(name: string) {
          if (name === 'sessionPersistence') return { create: async () => ({
            append: async () => {
              trace.push('append')
              if (stage === 'append' || stage === 'undefined-append' || stage === 'append-and-cleanups') throw primary
            },
            close: async () => {
              trace.push('close')
              if (stage === 'close' || stage === 'append-and-cleanups') throw stage === 'close' ? primary : new Error('close secondary')
            },
          }) }
          return { create: async () => ({ sessionIds: ['owned-id'], attachSession: async () => { trace.push('attach') } }) }
        }
      }
      const run = runInNewContext(`(async () => { ${body} })()`, {
        Context, assert, join, home: 'owned-home', id: 'owned-id', header: {}, events: [], workspace: 'owned-workspace',
        JsonlSessionPersistence: {}, Storage: {}, StorageJson: {}, StorageDomain: {}, WorkspaceRegistry: {},
        console: { log: () => { trace.push('published') } },
      }) as Promise<void>
      if (stage === 'success') {
        await run
        expect(trace).toEqual(['append', 'close', 'attach', 'dispose', 'published'])
      } else {
        await expect(run).rejects.toBe(primary)
        expect(trace).not.toContain('published')
        expect(trace.indexOf('close')).toBeGreaterThan(trace.indexOf('append'))
        expect(trace.at(-1)).toBe('dispose')
      }
    },
  )
})

const transportError = 'Failed to load resource: net::ERR_FAILED'
const consoleError = () => ({ type: () => 'error', text: () => transportError })

function fixture() {
  const events = new EventEmitter()
  // Real event dispatch/removal semantics, without starting a browser or imitating DOM.
  const page = events as unknown as Pick<Page, 'on' | 'off'>
  return { events, page }
}

type EventName = 'pageerror' | 'console'

function faultyFixture(options: {
  registration?: EventName
  attachBeforeRegistrationFailure?: boolean
  removalErrors?: Partial<Record<EventName, unknown>>
} = {}) {
  const { events, page } = fixture()
  const register = events.on.bind(events)
  const remove = events.off.bind(events)
  const registrationFailure = new Error('registration failed')
  const removed: (string | symbol)[] = []
  vi.spyOn(events, 'on').mockImplementation((event, listener) => {
    if (event === options.registration && !options.attachBeforeRegistrationFailure) throw registrationFailure
    const result = register(event, listener)
    if (event === options.registration) throw registrationFailure
    return result
  })
  vi.spyOn(events, 'off').mockImplementation((event, listener) => {
    removed.push(event)
    if (options.removalErrors !== undefined && Object.hasOwn(options.removalErrors, event)) {
      throw options.removalErrors[event as EventName]
    }
    return remove(event, listener)
  })
  return { events, page, removed, registrationFailure }
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

  it.each(['pageerror', 'console'] as const)('attempts both removals and rejects a cleanup-only %s failure', async (event) => {
    const failure = new Error(`remove ${event}`)
    const { events, page, removed } = faultyFixture({ removalErrors: { [event]: failure } })
    const reported = vi.fn()
    const other = vi.fn()
    events.on('console', other)
    try {
      await expect(observeNativeComposerErrors(page, async () => 'complete', reported)).rejects.toBe(failure)
      expect(removed).toEqual(['pageerror', 'console'])
      expect(reported).toHaveBeenCalledExactlyOnceWith(failure)
      expect(events.listeners('console')).toContain(other)
      // A listener whose removal failed must be inactive, including before reading error properties.
      const late = { type: vi.fn(() => 'error'), text: vi.fn(() => 'late error') }
      events.emit('console', late)
      events.emit('pageerror', undefined)
      expect(late.type).not.toHaveBeenCalled()
      expect(late.text).not.toHaveBeenCalled()
      expect(other).toHaveBeenCalledExactlyOnceWith(late)
    } finally { events.removeAllListeners() }
  })

  it.each([false, true])('reports both removal failures without letting reporting mask cleanup (reporter throws=%s)', async (throws) => {
    const first = new Error('first removal')
    const second = new Error('second removal')
    const { events, page, removed } = faultyFixture({ removalErrors: { pageerror: first, console: second } })
    const reported: unknown[] = []
    try {
      await expect(observeNativeComposerErrors(page, async () => 'complete', (error) => {
        reported.push(error)
        if (throws) throw new Error('reporting failed')
      })).rejects.toBe(first)
      expect(removed).toEqual(['pageerror', 'console'])
      expect(reported).toEqual([first, second])
    } finally { events.removeAllListeners() }
  })

  it('rejects a removal failure without requiring an owner reporting callback', async () => {
    const failure = new Error('unreported removal')
    const { events, page, removed } = faultyFixture({ removalErrors: { console: failure } })
    try {
      await expect(observeNativeComposerErrors(page, async () => undefined)).rejects.toBe(failure)
      expect(removed).toEqual(['pageerror', 'console'])
    } finally { events.removeAllListeners() }
  })

  it('deactivates callbacks before either removal can synchronously deliver another event', async () => {
    const { events, page } = fixture()
    const remove = events.off.bind(events)
    const late = { type: vi.fn(() => 'error'), text: vi.fn(() => 'teardown event') }
    vi.spyOn(events, 'off').mockImplementation((event, listener) => {
      events.emit('console', late)
      events.emit('pageerror', undefined)
      return remove(event, listener)
    })
    const result = await observeNativeComposerErrors(page, async () => undefined)
    expect(result).toEqual({ inspection: undefined, rendererErrors: [] })
    expect(Object.isFrozen(result.rendererErrors)).toBe(true)
    expect(late.type).not.toHaveBeenCalled()
    expect(late.text).not.toHaveBeenCalled()
    expect(events.listenerCount('console')).toBe(0)
    expect(events.listenerCount('pageerror')).toBe(0)
  })

  it('retains a thrown undefined cleanup failure instead of returning successful observations', async () => {
    const { events, page, removed } = faultyFixture({ removalErrors: { pageerror: undefined } })
    const reported = vi.fn()
    try {
      await expect(observeNativeComposerErrors(page, async () => 'complete', reported)).rejects.toBeUndefined()
      expect(removed).toEqual(['pageerror', 'console'])
      expect(reported).toHaveBeenCalledExactlyOnceWith(undefined)
    } finally { events.removeAllListeners() }
  })

  it.each(['sync', 'async', 'undefined'] as const)('keeps the %s inspection primary through cleanup and reporting', async (mode) => {
    const primary = mode === 'undefined' ? undefined : new Error(`${mode} inspection`)
    const cleanup = [new Error('remove pageerror'), new Error('remove console')]
    const { events, page, removed } = faultyFixture({ removalErrors: { pageerror: cleanup[0], console: cleanup[1] } })
    const reported: unknown[] = []
    const inspect = mode === 'sync' ? (): Promise<never> => { throw primary } : async () => { await Promise.resolve(); throw primary }
    try {
      await expect(observeNativeComposerErrors(page, inspect, (error) => {
        reported.push(error)
        throw new Error('secondary report failure')
      })).rejects.toBe(primary)
      expect(reported).toEqual(cleanup)
      expect(removed).toEqual(['pageerror', 'console'])
      events.emit('pageerror', undefined)
      events.emit('console', undefined)
    } finally { events.removeAllListeners() }
  })

  it.each([
    { event: 'pageerror', attached: false }, { event: 'pageerror', attached: true },
    { event: 'console', attached: false }, { event: 'console', attached: true },
  ] as const)('retains $event registration failure and cleans partial attachment (attached=$attached)', async ({ event, attached }) => {
    const { events, page, removed, registrationFailure } = faultyFixture({
      registration: event, attachBeforeRegistrationFailure: attached,
    })
    const inspect = vi.fn(async () => 'must not inspect')
    await expect(observeNativeComposerErrors(page, inspect)).rejects.toBe(registrationFailure)
    expect(inspect).not.toHaveBeenCalled()
    expect(removed).toEqual(['pageerror', 'console'])
    expect(events.listenerCount('pageerror')).toBe(0)
    expect(events.listenerCount('console')).toBe(0)
  })

  it('keeps a partial-registration primary when removal and secondary reporting also fail', async () => {
    const removal = new Error('registration cleanup failed')
    const { events, page, removed, registrationFailure } = faultyFixture({
      registration: 'console', attachBeforeRegistrationFailure: true, removalErrors: { pageerror: removal },
    })
    const inspect = vi.fn(async () => 'must not inspect')
    const reported = vi.fn(() => { throw new Error('report failed') })
    try {
      await expect(observeNativeComposerErrors(page, inspect, reported)).rejects.toBe(registrationFailure)
      expect(inspect).not.toHaveBeenCalled()
      expect(removed).toEqual(['pageerror', 'console'])
      expect(reported).toHaveBeenCalledExactlyOnceWith(removal)
      events.emit('pageerror', undefined)
    } finally { events.removeAllListeners() }
  })

  it('keeps renderer errors primary and immutable even when both removals fail', async () => {
    const { events, page, removed } = faultyFixture({ removalErrors: { pageerror: new Error('first'), console: new Error('second') } })
    const reported = vi.fn()
    let primary: unknown
    try {
      try {
        await observeNativeComposerErrors(page, async () => {
          events.emit('pageerror', new Error('observed page failure'))
          events.emit('console', consoleError())
          return 'not accepted'
        }, reported)
      } catch (error) { primary = error }
      expect(primary).toMatchObject({ actual: ['observed page failure', transportError], expected: [] })
      const actual = (primary as { actual: readonly string[] }).actual
      expect(Object.isFrozen(actual)).toBe(true)
      events.emit('pageerror', undefined)
      events.emit('console', undefined)
      expect(actual).toEqual(['observed page failure', transportError])
      expect(removed).toEqual(['pageerror', 'console'])
      expect(reported).toHaveBeenCalledTimes(2)
    } finally { events.removeAllListeners() }
  })

  it('reports cleanup only as secondary before the owner catches the exact inspection primary', async () => {
    const primary = new Error('inspection primary')
    const cleanup = new Error('secondary cleanup')
    const { events, page } = faultyFixture({ removalErrors: { console: cleanup } })
    const secondary: unknown[] = []
    let caught: unknown
    try {
      try {
        await observeNativeComposerErrors(page, async () => { throw primary }, (error) => { secondary.push(error) })
      } catch (error) { caught = error }
      expect(secondary).toEqual([cleanup])
      expect(caught).toBe(primary)
    } finally { events.removeAllListeners() }
  })

  it('removes its callbacks and preserves an inspection failure without producing success evidence', async () => {
    const { events, page } = fixture()
    const failure = new Error('native dialog did not close')
    await expect(observeNativeComposerErrors(page, async () => { throw failure })).rejects.toBe(failure)
    expect(events.listenerCount('console')).toBe(0)
    expect(events.listenerCount('pageerror')).toBe(0)
  })
})
