import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ManagedUpdateTransferError,
  managedUpdateTransferPolicy,
  managedUpdateTransferDiagnostic,
  readManagedUpdateMetadata,
  withManagedUpdateResponse,
  type ManagedUpdateNetworkOperations,
} from '../src/managed-update-network.ts'

const url = 'https://github.com/cloga/deepseek-harness/releases/download/v1.2.3/release.json'
const consume = (response: Response, transfer: Parameters<typeof readManagedUpdateMetadata>[2]) =>
  readManagedUpdateMetadata(response, 1024, transfer)

afterEach(() => vi.useRealTimers())

describe('managed update bounded transfers', () => {
  it.each(['name', 'code', 'cause', 'prototype', 'revoked', 'forged', 'cycle'] as const)(
    'preserves the original unclassified %s failure without retrying or leaking timers', async (kind) => {
      vi.useFakeTimers()
      const secret = new Error('private getter diagnostic')
      let failure: object = {}
      if (kind === 'prototype') failure = new Proxy({}, { getPrototypeOf() { throw secret } })
      else if (kind === 'revoked') {
        const revocable = Proxy.revocable({}, {})
        revocable.revoke()
        failure = revocable.proxy
      } else if (kind === 'forged') {
        failure = { errorType: 'private category', retryable: true }
        Object.setPrototypeOf(failure, ManagedUpdateTransferError.prototype)
      } else if (kind === 'cycle') Object.defineProperty(failure, 'cause', { value: failure })
      else Object.defineProperty(failure, kind, { get() { throw secret } })
      const operations = { fetch: vi.fn<ManagedUpdateNetworkOperations['fetch']>().mockRejectedValue(failure), sleep: vi.fn(async () => {}) }
      const observed = await withManagedUpdateResponse(url, 'metadata', operations, consume)
        .then(() => false, (error: unknown) => error === failure)
      expect(observed).toBe(true)
      expect(operations.fetch).toHaveBeenCalledOnce()
      expect(operations.sleep).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    },
  )

  it('reads each transport field once and never revisits a cyclic cause', async () => {
    const name = vi.fn(() => 'Error')
    const code = vi.fn().mockReturnValueOnce('ECONNRESET').mockImplementation(() => { throw new Error('second read secret') })
    const cause = vi.fn(() => { throw new Error('unused cause secret') })
    const failure = Object.defineProperties({}, { name: { get: name }, code: { get: code }, cause: { get: cause } })
    const operations = {
      fetch: vi.fn<ManagedUpdateNetworkOperations['fetch']>().mockRejectedValueOnce(failure).mockResolvedValue(new Response('ok')),
      sleep: vi.fn(async () => {}),
    }
    expect(await withManagedUpdateResponse(url, 'metadata', operations, consume)).toEqual(Buffer.from('ok'))
    expect(name).toHaveBeenCalledOnce()
    expect(code).toHaveBeenCalledOnce()
    expect(cause).not.toHaveBeenCalled()
    expect(operations.fetch).toHaveBeenCalledTimes(2)
    const cycle = {}
    const cycleCause = vi.fn(() => cycle)
    Object.defineProperty(cycle, 'cause', { get: cycleCause })
    operations.fetch.mockRejectedValue(cycle)
    expect(await withManagedUpdateResponse(url, 'metadata', operations, consume).then(() => false, (error: unknown) => error === cycle)).toBe(true)
    expect(cycleCause).toHaveBeenCalledOnce()
  })

  it('classifies a safe timeout code even when another diagnostic field is unreadable', async () => {
    const failure = Object.defineProperty({ code: 'ETIMEDOUT' }, 'name', { get() { throw new Error('private name') } })
    const operations = { fetch: vi.fn<ManagedUpdateNetworkOperations['fetch']>().mockRejectedValue(failure), sleep: vi.fn(async () => {}) }
    await expect(withManagedUpdateResponse(url, 'metadata', operations, consume)).rejects.toMatchObject({ errorType: 'timeout' })
    expect(operations.fetch).toHaveBeenCalledTimes(3)
    expect(operations.sleep.mock.calls).toEqual([[500], [1000]])
  })

  it('uses immutable constructor-owned retry facts instead of changed public error properties', async () => {
    const failure = new ManagedUpdateTransferError('integrity')
    const read = vi.fn(() => { throw new Error('private transfer property') })
    Object.defineProperties(failure, { errorType: { get: read }, retryable: { get: read }, status: { get: read } })
    failure.cause = { code: 'ECONNRESET' }
    const diagnostic = managedUpdateTransferDiagnostic(failure)
    expect(diagnostic).toEqual({ errorType: 'integrity', retryable: false })
    expect(Object.isFrozen(diagnostic)).toBe(true)
    const operations = { fetch: vi.fn<ManagedUpdateNetworkOperations['fetch']>().mockRejectedValue(failure), sleep: vi.fn(async () => {}) }
    expect(await withManagedUpdateResponse(url, 'metadata', operations, consume).then(() => false, (error: unknown) => error === failure)).toBe(true)
    expect(read).not.toHaveBeenCalled()
    expect(operations.fetch).toHaveBeenCalledOnce()
    expect(operations.sleep).not.toHaveBeenCalled()
    expect(managedUpdateTransferDiagnostic(null)).toBeUndefined()
    expect(managedUpdateTransferDiagnostic('private text')).toBeUndefined()
  })

  it('retains the owned transient retry budget and status after public fields are overwritten', async () => {
    const failure = new ManagedUpdateTransferError('http', true, 503)
    Object.defineProperties(failure, { errorType: { value: 'private category' }, retryable: { value: false }, status: { value: 200 } })
    const operations = { fetch: vi.fn<ManagedUpdateNetworkOperations['fetch']>().mockRejectedValue(failure), sleep: vi.fn(async () => {}) }
    expect(await withManagedUpdateResponse(url, 'metadata', operations, consume).then(() => false, (error: unknown) => error === failure)).toBe(true)
    expect(managedUpdateTransferDiagnostic(failure)).toEqual({ errorType: 'http', retryable: true, status: 503 })
    expect(operations.fetch).toHaveBeenCalledTimes(3)
    expect(operations.sleep.mock.calls).toEqual([[500], [1000]])
  })

  it.each([408, 429, 500, 502, 503, 504])('limits transient HTTP %s to three total attempts', async (status) => {
    const operations = { fetch: vi.fn(async () => new Response('', { status })), sleep: vi.fn(async () => {}) }
    await expect(withManagedUpdateResponse(url, 'metadata', operations, consume)).rejects.toMatchObject({ errorType: 'http', status })
    expect(operations.fetch).toHaveBeenCalledTimes(3)
    expect(operations.sleep.mock.calls).toEqual([[500], [1000]])
  })

  it.each([400, 401, 403, 404, 410, 501])('does not retry terminal HTTP %s', async (status) => {
    const operations = { fetch: vi.fn(async () => new Response('', { status })), sleep: vi.fn(async () => {}) }
    await expect(withManagedUpdateResponse(url, 'metadata', operations, consume)).rejects.toMatchObject({ errorType: 'http' })
    expect(operations.fetch).toHaveBeenCalledOnce()
    expect(operations.sleep).not.toHaveBeenCalled()
  })

  it.each(['ECONNRESET', 'EPIPE', 'UND_ERR_SOCKET', 'ETIMEDOUT', 'UND_ERR_BODY_TIMEOUT'])('retries classified nested %s transport errors', async (code) => {
    const operations = {
      fetch: vi.fn<ManagedUpdateNetworkOperations['fetch']>().mockRejectedValueOnce(new TypeError('unsafe transport message', { cause: { code } }))
        .mockResolvedValueOnce(new Response('ok')),
      sleep: vi.fn(async () => {}),
    }
    expect(await withManagedUpdateResponse(url, 'metadata', operations, consume)).toEqual(Buffer.from('ok'))
    expect(operations.fetch).toHaveBeenCalledTimes(2)
  })

  it('does not retry arbitrary failures, invalid sizes, or credential-bearing redirect targets', async () => {
    for (const result of [
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.resolve(new Response('large', { headers: { 'content-length': '2048' } })),
      () => Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://name:secret@release-assets.githubusercontent.com/file?sig=secret' } })),
      () => Promise.resolve(new Response(null, { status: 302, headers: { location: 'https://evil.test/file' } })),
    ]) {
      const operations = { fetch: vi.fn(result), sleep: vi.fn(async () => {}) }
      await expect(withManagedUpdateResponse(url, 'metadata', operations, consume)).rejects.toBeInstanceOf(Error)
      expect(operations.fetch).toHaveBeenCalledOnce()
    }
  })

  it('follows only allowed redirects without forwarding credentials or authorization', async () => {
    const redirected = 'https://release-assets.githubusercontent.com/github-production-release-asset/file?sig=private'
    const operations = {
      fetch: vi.fn<ManagedUpdateNetworkOperations['fetch']>().mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: redirected } }))
        .mockResolvedValueOnce(new Response('ok')),
      sleep: vi.fn(async () => {}),
    }
    await withManagedUpdateResponse(url, 'metadata', operations, consume)
    expect(operations.fetch.mock.calls.map(([target]) => target)).toEqual([url, redirected])
    for (const [, init] of operations.fetch.mock.calls) {
      expect(init).toMatchObject({ method: 'GET', credentials: 'omit', redirect: 'manual' })
      expect(init.headers).toBeUndefined()
    }
  })

  it('aborts stalled metadata bodies and retries only three times', async () => {
    vi.useFakeTimers()
    const cancelled = vi.fn()
    const operations = {
      fetch: vi.fn(async () => new Response(new ReadableStream<Uint8Array>({ cancel: cancelled }))),
      sleep: vi.fn(async () => {}),
    }
    const pending = withManagedUpdateResponse(url, 'metadata', operations, consume)
    const assertion = expect(pending).rejects.toMatchObject({ errorType: 'timeout' })
    await vi.advanceTimersByTimeAsync(managedUpdateTransferPolicy.metadata.inactivityMs * 3)
    await assertion
    expect(operations.fetch).toHaveBeenCalledTimes(3)
    expect(cancelled).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('allows an active installer body beyond 30 seconds but bounds the total attempt', async () => {
    vi.useFakeTimers()
    const operations = { fetch: vi.fn(async () => new Response('ok')), sleep: vi.fn(async () => {}) }
    const pending = withManagedUpdateResponse(url, 'installer', operations, async (_response, transfer) => {
      for (let elapsed = 0; elapsed < managedUpdateTransferPolicy.installer.totalMs; elapsed += 40_000) {
        await vi.advanceTimersByTimeAsync(40_000)
        transfer.signal.throwIfAborted()
        transfer.progress()
      }
      return 'unexpected'
    })
    await expect(pending).rejects.toMatchObject({ errorType: 'timeout' })
    expect(operations.fetch).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not retry integrity errors even when their nested cause is transient', async () => {
    const operations = { fetch: vi.fn(async () => new Response('ok')), sleep: vi.fn(async () => {}) }
    const error = new ManagedUpdateTransferError('integrity')
    error.cause = { code: 'ECONNRESET' }
    await expect(withManagedUpdateResponse(url, 'metadata', operations, async () => { throw error })).rejects.toBe(error)
    expect(operations.fetch).toHaveBeenCalledOnce()
  })
})
