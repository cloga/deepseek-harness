import { describe, expect, it } from 'vitest'
import { projectionDurableObservationOptions } from './durable-observation.ts'

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
