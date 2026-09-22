/** Pure owning controls: no Playwright, Host, network or filesystem mutation. */
import assert from 'node:assert/strict'
import { test } from 'vitest'
import { finishCreatorRoute, type CreatorRoutePrimaryOutcome } from './creator-route-ownership.ts'

const success: CreatorRoutePrimaryOutcome = { failed: false }
const failures = [
  ['Error', new Error('owned fixture failure')],
  ['string', 'owned fixture failure'],
  ['undefined', undefined],
  ['null', null],
] as const
async function outcome(operation: Promise<void>): Promise<CreatorRoutePrimaryOutcome> {
  try { await operation; return { failed: false } }
  catch (error: unknown) { return { failed: true, error } }
}
function fail(error: unknown, mode: 'synchronous' | 'immediately-rejected'): () => Promise<void> {
  if (mode === 'synchronous') return () => { throw error }
  return async () => { throw error }
}

test('continues the exact owned route once, then removes its handler', async () => {
  const events: string[] = []
  await finishCreatorRoute(success, {
    continue: async () => { events.push('continue') },
  }, async () => { events.push('remove') })
  assert.deepEqual(events, ['continue', 'remove'])
})

test('does not remove interception while its owned continuation is pending', async () => {
  const entered = Promise.withResolvers<undefined>()
  const continuation = Promise.withResolvers<undefined>()
  const events: string[] = []
  const settled = outcome(finishCreatorRoute(success, {
    continue() { events.push('continue'); entered.resolve(undefined); return continuation.promise },
  }, async () => { events.push('remove') }))
  try {
    await entered.promise
    assert.deepEqual(events, ['continue'])
  } finally {
    continuation.resolve(undefined)
  }
  assert.deepEqual(await settled, { failed: false })
  assert.deepEqual(events, ['continue', 'remove'])
})

test('removes an uncaptured registration without inventing a continuation', async () => {
  let removed = 0
  await finishCreatorRoute(success, undefined, async () => { removed++ })
  assert.equal(removed, 1)
})

test('starts removal before yielding when no route was captured', async () => {
  const removed = Promise.withResolvers<undefined>()
  let registered = true
  const settled = outcome(finishCreatorRoute(success, undefined, () => {
    registered = false
    return removed.promise
  }))
  try {
    assert.equal(registered, false)
  } finally {
    removed.resolve(undefined)
  }
  assert.deepEqual(await settled, { failed: false })
})

for (const [label, error] of failures) {
  test(`retains primary ${label} identity after successful cleanup`, async () => {
    const events: string[] = []
    const settled = await outcome(finishCreatorRoute({ failed: true, error }, {
      continue: async () => { events.push('continue') },
    }, async () => { events.push('remove') }))
    assert(settled.failed)
    assert.equal(settled.error, error)
    assert.deepEqual(events, ['continue', 'remove'])
  })

  test(`retains pre-capture ${label} failure and still removes the registration`, async () => {
    let removed = 0
    const settled = await outcome(finishCreatorRoute({ failed: true, error }, undefined, async () => { removed++ }))
    assert(settled.failed)
    assert.equal(settled.error, error)
    assert.equal(removed, 1)
  })

  for (const mode of ['synchronous', 'immediately-rejected'] as const) {
    test(`observes ${mode} continuation ${label} failure and always removes the handler`, async () => {
      let removed = 0
      const settled = await outcome(finishCreatorRoute(success, { continue: fail(error, mode) }, async () => { removed++ }))
      assert(settled.failed)
      assert.equal(settled.error, error)
      assert.equal(removed, 1)
    })

    test(`retains ${mode} removal ${label} failure after a successful continuation`, async () => {
      let continued = 0
      const settled = await outcome(finishCreatorRoute(success, {
        continue: async () => { continued++ },
      }, fail(error, mode)))
      assert(settled.failed)
      assert.equal(settled.error, error)
      assert.equal(continued, 1)
    })
  }
}

for (const [label, primary] of failures) {
  for (const where of ['continue', 'remove', 'both'] as const) {
    test(`preserves primary ${label} and ${where} cleanup identities in order`, async () => {
      const continuation = new Error('continuation failed')
      const removal = new Error('removal failed')
      let removed = 0
      const cleanup = [
        ...(where === 'remove' ? [] : [continuation]),
        ...(where === 'continue' ? [] : [removal]),
      ]
      const settled = await outcome(finishCreatorRoute({ failed: true, error: primary }, {
        continue: where === 'remove' ? async () => {} : fail(continuation, 'immediately-rejected'),
      }, async () => {
        removed++
        if (where !== 'continue') throw removal
      }))
      assert(settled.failed)
      assert(settled.error instanceof AggregateError)
      assert.equal(settled.error.cause, primary)
      assert(Object.hasOwn(settled.error, 'cause'))
      const errors: readonly unknown[] = settled.error.errors
      assert.equal(errors.length, cleanup.length + 1)
      for (const [index, error] of [primary, ...cleanup].entries()) assert.equal(errors[index], error)
      assert.equal(removed, 1)
    })
  }
}

test('retains both cleanup failures without inventing a primary failure', async () => {
  const removal = new Error('removal failed')
  const settled = await outcome(finishCreatorRoute(success, {
    continue: fail(undefined, 'immediately-rejected'),
  }, fail(removal, 'synchronous')))
  assert(settled.failed)
  assert(settled.error instanceof AggregateError)
  const errors: readonly unknown[] = settled.error.errors
  assert.equal(errors.length, 2)
  assert.equal(errors[0], undefined)
  assert.equal(errors[1], removal)
  assert(Object.hasOwn(settled.error, 'cause'))
  assert.equal(settled.error.cause, undefined)
})

test('preserves failed registration and failed removal when no route was captured', async () => {
  const primary = new Error('registration failed')
  const cleanup = new Error('removal failed')
  const settled = await outcome(finishCreatorRoute({ failed: true, error: primary }, undefined, fail(cleanup, 'synchronous')))
  assert(settled.failed)
  assert(settled.error instanceof AggregateError)
  const errors: readonly unknown[] = settled.error.errors
  assert.equal(errors[0], primary)
  assert.equal(errors[1], cleanup)
  assert.equal(settled.error.cause, primary)
})
