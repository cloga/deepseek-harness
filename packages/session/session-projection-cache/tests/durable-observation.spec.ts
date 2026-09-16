import { afterEach, describe, expect, it, vi } from 'vitest'
import { SESSION_FORMAT_VERSION, SessionId, SessionLogOffset, SessionSeq } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import type { ProjectionSnapshot } from '@deepseek-ai/dsh-session-projection'
import { projectionDurableObservationOptions, waitForProjectionCheckpoint } from './durable-observation.ts'

afterEach(() => vi.useRealTimers())

describe('projection durable checkpoint observation', () => {
  it('rejects missing and creation-time cuts before observing the requested cut', async () => {
    vi.useFakeTimers()
    const session: Pick<Session, 'header' | 'inheritedEventCount'> = {
      header: { version: SESSION_FORMAT_VERSION, id: SessionId('observed'), createdAt: 1, isSeeded: false },
      inheritedEventCount: SessionLogOffset(0),
    }
    let snapshot: ProjectionSnapshot | undefined
    const cache = { cachedSnapshot: vi.fn(() => snapshot) }
    const observed = vi.fn()
    const wait = waitForProjectionCheckpoint(cache, session, SessionSeq(1)).then(observed)

    try {
      await vi.advanceTimersByTimeAsync(50)
      expect(observed).not.toHaveBeenCalled()
      snapshot = { asOfSeq: -1, values: {} }
      await vi.advanceTimersByTimeAsync(50)
      expect(observed).not.toHaveBeenCalled()
    } finally {
      snapshot = { asOfSeq: SessionSeq(1), values: {} }
      await vi.advanceTimersByTimeAsync(50)
      await wait
    }

    expect(observed).toHaveBeenCalledOnce()
    expect(cache.cachedSnapshot).toHaveBeenLastCalledWith(session.header, session.inheritedEventCount)
  })
})

describe('projection durable observation budget', () => {
  it('keeps the local floor and inherits a bounded coverage-lane budget', () => {
    expect(projectionDurableObservationOptions({})).toEqual({ timeout: 5_000 })
    expect(projectionDurableObservationOptions({ DSH_COVERAGE_TEST_TIMEOUT_MS: '1000' }))
      .toEqual({ timeout: 5_000 })
    expect(projectionDurableObservationOptions({ DSH_COVERAGE_TEST_TIMEOUT_MS: '90000' }))
      .toEqual({ timeout: 90_000 })
  })

  it('rejects invalid or excessive coverage-lane budgets', () => {
    for (const value of ['0', 'invalid', '90000ms']) {
      expect(() => projectionDurableObservationOptions({ DSH_COVERAGE_TEST_TIMEOUT_MS: value }))
        .toThrow('DSH_COVERAGE_TEST_TIMEOUT_MS must be a positive integer')
    }
    expect(() => projectionDurableObservationOptions({ DSH_COVERAGE_TEST_TIMEOUT_MS: '300001' }))
      .toThrow('DSH_COVERAGE_TEST_TIMEOUT_MS must not exceed 300000')
  })
})
