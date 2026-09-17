import { spawn } from 'node:child_process'
import { afterEach, expect, it, vi, type TestAPI } from 'vitest'
import { ProjectFixtureWork, trackProjectFixtureTests } from './fixtures/project-fixture-work.ts'

afterEach(() => { vi.useRealTimers() })

it('returns original operation values and errors while retaining bounded phase evidence', async () => {
  const work = new ProjectFixtureWork()
  work.begin()
  const failure = new Error('expected fixture failure')
  await expect(work.track('success', async () => 7)).resolves.toBe(7)
  await expect(work.track('expected rejection', async () => { throw failure })).rejects.toBe(failure)
  for (let index = 0; index < 30; index++) await work.track('completed operation', async () => {})
  await work.close()
  const snapshot = work.snapshot()
  expect(snapshot).toMatchObject({ pending: 0, children: 0 })
  const phases: unknown = (snapshot as { phases: unknown }).phases
  expect(Array.isArray(phases)).toBe(true)
  expect(phases).toHaveLength(24)
})

it('waits for held work before allowing mock restoration or root cleanup', async () => {
  const work = new ProjectFixtureWork()
  work.begin()
  const held = Promise.withResolvers<undefined>()
  const operation = work.track('held transaction', () => held.promise)
  let cleaned = false
  const cleanup = work.close().then(() => { cleaned = true })
  try {
    await Promise.resolve()
    expect(cleaned).toBe(false)
    expect(() => work.track('late transaction', async () => {})).toThrow('stopped new work')
    held.resolve(undefined)
    await operation
    await cleanup
    expect(cleaned).toBe(true)
    work.begin()
    expect(work.snapshot()).toEqual({ pending: 0, children: 0, phases: [] })
  } finally {
    held.resolve(undefined)
    await Promise.allSettled([operation, cleanup])
  }
})

it('tracks the complete original test continuation through registration wrappers', async () => {
  const work = new ProjectFixtureWork()
  work.begin()
  let callback: ((value: unknown) => Promise<unknown>) | undefined
  const register = ((_name: string, run: typeof callback) => { callback = run }) as unknown as TestAPI
  const wrapped = trackProjectFixtureTests(register, work)
  const held = Promise.withResolvers<undefined>()
  let completed = false
  wrapped('wrapped case', async () => { await held.promise; completed = true })
  const running = callback!(undefined)
  let cleaned = false
  const closing = work.close().then(() => { cleaned = true })
  try {
    await Promise.resolve()
    expect(completed).toBe(false)
    expect(cleaned).toBe(false)
    held.resolve(undefined)
    await running
    await closing
    expect(completed).toBe(true)
    expect(cleaned).toBe(true)
  } finally {
    held.resolve(undefined)
    await Promise.allSettled([running, closing])
  }
})

it('owns and stops a late child registered after cleanup has begun', async () => {
  const work = new ProjectFixtureWork()
  work.begin()
  const held = Promise.withResolvers<undefined>()
  const running = work.track('held transaction', () => held.promise)
  const closing = work.close(10_000)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', env: {}, windowsHide: true,
  })
  const closed = new Promise<void>(resolve => child.once('close', () => { resolve() }))
  work.child(child, 'late owned child')
  try {
    await closed
    held.resolve(undefined)
    await running
    await closing
    expect(work.snapshot()).toMatchObject({ pending: 0, children: 0 })
  } finally {
    held.resolve(undefined)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.allSettled([running, closing, closed])
  }
})

it('bounds incomplete cleanup and prevents later cases from using the unquiesced fixture', async () => {
  vi.useFakeTimers()
  const work = new ProjectFixtureWork()
  work.begin()
  const held = Promise.withResolvers<undefined>()
  const operation = work.track('unsettled transaction', () => held.promise)
  let cleaned = false
  const closing = work.close(100).then(() => { cleaned = true })
  const rejected = expect(closing).rejects.toThrow('cleanup did not reach quiescence')
  try {
    await vi.advanceTimersByTimeAsync(99)
    expect(cleaned).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    await rejected
    expect(cleaned).toBe(false)
    expect(() => { work.begin() }).toThrow('cleanup did not reach quiescence')
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    held.resolve(undefined)
    await Promise.allSettled([operation, closing, rejected])
  }
})

it('terminates only its owned child and waits for the close event before completing cleanup', async () => {
  const work = new ProjectFixtureWork()
  work.begin()
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: 'ignore', env: {}, windowsHide: true,
  })
  work.child(child, 'held pnpm child')
  let closed = false
  child.once('close', () => { closed = true })
  try {
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
    await work.close(10_000)
    expect(closed).toBe(true)
    expect(work.snapshot()).toMatchObject({ pending: 0, children: 0 })
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await work.close(10_000)
  }
})
