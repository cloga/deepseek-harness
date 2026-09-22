/** Fail-closed task-wide work arithmetic and producer lifetime invariants. */
import { describe, expect, it } from 'vitest'
import { TaskWorkAccounting } from '../src/work-accounting.ts'
import type { WorkMetric, WorkRoute, WorkSource } from '../src/work-accounting.ts'

const route: WorkRoute = { provider: 'fixture', model: 'small', reasoningEffort: 'low' }
const sources: readonly WorkSource[] = ['conversation', 'classifier', 'compaction', 'title', 'child', 'review']
function fixture(overrides: Partial<WorkMetric> = {}, cover = true): TaskWorkAccounting {
  const ledger = new TaskWorkAccounting({
    revision: 'tokens-v1', routes: [{ selection: route, weightPerToken: 2 }],
    maxCalls: 20, maxOperations: 20, ...overrides,
  })
  if (cover) sources.forEach((source) => { ledger.cover(source) })
  return ledger
}
function complete(ledger: TaskWorkAccounting, total = 10, source: WorkSource = 'conversation', selection: WorkRoute = route): void {
  const operation = ledger.beginOperation(source)
  const call = operation.beginCall(selection)
  call.usage(total)
  call.settle()
  operation.close()
}

describe('task work accounting', () => {
  it('requires coverage plus actual measurement and seals an immutable idempotent result', () => {
    const ledger = fixture()
    complete(ledger)
    const result = ledger.seal()
    expect(result).toEqual({ metricRevision: 'tokens-v1', complete: true, relativeWork: 20, calls: 1, gaps: [] })
    expect(ledger.seal()).toBe(result)
    expect(Object.isFrozen(result) && Object.isFrozen(result.gaps)).toBe(true)
    expect(() => ledger.beginOperation('child')).toThrow('sealed')
  })
  it('includes every retry and auxiliary source without interpreting settlement as task success', () => {
    const ledger = fixture()
    for (const source of sources) complete(ledger, 10, source)
    complete(ledger, 5)
    expect(ledger.seal()).toMatchObject({ relativeWork: 130, calls: 7 })
  })
  it('distinguishes authoritative zero from absent totals', () => {
    const known = fixture()
    complete(known, 0)
    expect(known.seal().relativeWork).toBe(0)
    const unknown = fixture()
    const operation = unknown.beginOperation('conversation')
    const call = operation.beginCall(route)
    call.usage(undefined)
    call.settle()
    operation.close()
    expect(unknown.seal().relativeWork).toBeNull()
    expect(unknown.seal().gaps).toContain('missing-usage')
  })
  it('refuses completeness when silent or uninstrumented producers exist', () => {
    const ledger = fixture({}, false)
    ledger.cover('conversation')
    complete(ledger)
    expect(ledger.seal()).toMatchObject({ gaps: ['coverage-unproven'], relativeWork: null })
  })
  it('does not repair previously unattributed work with late coverage', () => {
    const ledger = fixture({}, false)
    complete(ledger)
    sources.forEach((source) => { ledger.cover(source) })
    expect(ledger.seal().complete).toBe(false)
  })
  it('includes pre-dispatch operation leases and rejects mutation after incomplete sealing', () => {
    const ledger = fixture()
    complete(ledger)
    const child = ledger.beginOperation('child')
    const snapshot = ledger.seal()
    expect(snapshot.gaps).toContain('pending-work')
    expect(() => { child.close() }).toThrow('sealed')
    expect(snapshot.relativeWork).toBeNull()
  })
  it('cannot close an operation around unfinished calls and silently recover', () => {
    const ledger = fixture()
    const operation = ledger.beginOperation('review')
    const call = operation.beginCall(route)
    operation.close()
    call.usage(10)
    call.settle()
    expect(ledger.seal().gaps).toEqual(['invalid-lifecycle'])
  })
  it('detaches metric input and keys routes by exact effort including omission', () => {
    const mutableRoute = { ...route }
    const metric = { selection: mutableRoute, weightPerToken: 2 }
    const ledger = fixture({ routes: [metric] })
    mutableRoute.reasoningEffort = 'high'
    metric.weightPerToken = 100
    complete(ledger)
    expect(ledger.seal().relativeWork).toBe(20)
    const omitted = fixture()
    complete(omitted, 10, 'conversation', { provider: route.provider, model: route.model })
    expect(omitted.seal().gaps).toEqual(['unknown-route'])
  })
  it('does not guess a zero or default weight for an unknown route', () => {
    const ledger = fixture()
    complete(ledger, 10, 'child', { provider: 'other', model: 'small' })
    expect(ledger.seal().relativeWork).toBeNull()
  })
  it('rejects duplicate final usage rather than summing or replacing it', () => {
    const ledger = fixture()
    const operation = ledger.beginOperation('conversation')
    const call = operation.beginCall(route)
    call.usage(10)
    call.usage(10)
    call.settle()
    operation.close()
    expect(ledger.seal().gaps).toEqual(['invalid-usage'])
  })
  it.each([-1, 1.2, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid total %s', (value) => {
    const ledger = fixture()
    complete(ledger, value)
    expect(ledger.seal().relativeWork).toBeNull()
    expect(ledger.seal().gaps).toContain('invalid-usage')
  })
  it('does not call an interrupted stream complete merely because usage arrived', () => {
    const ledger = fixture()
    const operation = ledger.beginOperation('conversation')
    const call = operation.beginCall(route)
    call.usage(10)
    call.interrupt()
    operation.close()
    expect(ledger.seal().gaps).toEqual(['interrupted'])
  })
  it('taints duplicate settlement and attempts to dispatch under closed operations', () => {
    const ledger = fixture()
    const operation = ledger.beginOperation('conversation')
    const call = operation.beginCall(route)
    call.usage(10)
    call.settle()
    expect(() => { call.settle() }).toThrow('settled')
    operation.close()
    expect(() => operation.beginCall(route)).toThrow('closed')
    expect(ledger.seal().gaps).toEqual(['invalid-lifecycle'])
  })
  it('bounds reservations without counting rejected calls as admitted work', () => {
    const calls = fixture({ maxCalls: 1 })
    complete(calls)
    const operation = calls.beginOperation('child')
    expect(() => operation.beginCall(route)).toThrow('limit')
    operation.close()
    expect(calls.seal()).toMatchObject({ complete: false, calls: 1 })
    const operations = fixture({ maxOperations: 1 })
    complete(operations)
    expect(() => operations.beginOperation('title')).toThrow('limit')
    expect(operations.seal().complete).toBe(false)
  })
  it('rejects numeric overflow and floating-point absorption', () => {
    const overflow = fixture({ routes: [{ selection: route, weightPerToken: Number.MAX_VALUE }] })
    complete(overflow, 2)
    expect(overflow.seal().gaps).toEqual(['arithmetic-limit'])
    const tinyRoute = { ...route, model: 'tiny' }
    const absorbed = fixture({ routes: [
      { selection: route, weightPerToken: 1 }, { selection: tinyRoute, weightPerToken: Number.MIN_VALUE },
    ] })
    complete(absorbed, 10)
    complete(absorbed, 1, 'title', tinyRoute)
    expect(absorbed.seal().gaps).toEqual(['arithmetic-limit'])
  })
  it('does not turn no calls into a zero-work success sample', () => {
    expect(fixture().seal().gaps).toEqual(['missing-usage'])
  })
  it('keeps an explicit producer coverage gap even when every measured call completed', () => {
    const ledger = fixture()
    ledger.invalidate('coverage-unproven')
    complete(ledger)
    expect(ledger.seal()).toMatchObject({ complete: false, relativeWork: null, gaps: ['coverage-unproven'] })
    expect(() => { ledger.invalidate('missing-usage') }).toThrow('sealed')
  })
  it('rejects duplicate operation closure without decrementing another operation lease', () => {
    const ledger = fixture()
    const operation = ledger.beginOperation('conversation')
    const pending = ledger.beginOperation('title')
    operation.close()
    expect(() => { operation.close() }).toThrow('closed')
    expect(ledger.seal().gaps).toEqual(['invalid-lifecycle', 'missing-usage', 'pending-work'])
    expect(() => { pending.close() }).toThrow('sealed')
  })
  it('rejects invalid metrics and duplicate exact route keys', () => {
    expect(() => fixture({ routes: [{ selection: route, weightPerToken: 0 }] })).toThrow('invalid')
    expect(() => fixture({ routes: [
      { selection: route, weightPerToken: 1 }, { selection: { ...route }, weightPerToken: 2 },
    ] })).toThrow('invalid')
    expect(() => fixture({ maxCalls: 0 })).toThrow('invalid')
  })
})
