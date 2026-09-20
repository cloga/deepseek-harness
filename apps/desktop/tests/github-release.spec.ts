import { inspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import { requestDesktopGithubRelease } from '../src/github-release.ts'
import { desktopUpdateNetworkDetails, withDesktopUpdateNetworkError } from '../src/update-network-error.ts'

const API = 'https://api.github.com/repos/example/project'
const SECRET = 'github_pat_FAKE_RESPONSE_SECRET_0123456789'
const subject = 'desktop plugin source'
const accept = 'application/vnd.github+json'

async function failure(url: string, headers: HeadersInit = {}, status = 403, download = false): Promise<Error> {
  const response = new Response(SECRET, { status, statusText: SECRET, headers })
  const transport = vi.fn<typeof fetch>(async () => response)
  const error: unknown = await requestDesktopGithubRelease(new URL(url), accept, download, transport, subject)
    .catch((reason: unknown) => reason)
  expect(error).toBeInstanceOf(Error)
  expect(inspect(error)).not.toContain(SECRET)
  expect(error).not.toHaveProperty('cause')
  expect(transport).toHaveBeenCalledOnce()
  expect(response.bodyUsed).toBe(false)
  const sent = transport.mock.calls[0]?.[1]
  expect(sent?.redirect).toBe('manual')
  expect(sent?.credentials).toBe('omit')
  expect(sent?.signal).toBeInstanceOf(AbortSignal)
  expect(new Headers(sent?.headers).has('authorization')).toBe(false)
  expect(new Headers(sent?.headers).has('cookie')).toBe(false)
  return error as Error
}

describe('Desktop GitHub HTTP failure diagnostics', () => {
  it('retains status with bounded decimal rate-limit evidence without classifying the refusal', async () => {
    const error = await failure(`${API}/releases/tags/v1?token=${SECRET}`, {
      'x-ratelimit-remaining': '0', 'x-ratelimit-limit': '60', 'x-ratelimit-reset': '1790000000', 'retry-after': '120',
      'x-github-request-id': SECRET, location: `https://example.invalid/${SECRET}`,
    })
    expect(error.message).toBe('desktop plugin source: GitHub request failed with 403'
      + ' (host=api.github.com; operation=release-metadata; remaining=0; limit=60; reset=1790000000; retryAfter=120)')
    expect(error.message).not.toContain('rate limited')
  })

  it('includes the ten-digit bound while omitting independent invalid fields', async () => {
    const error = await failure(`${API}/releases`, {
      'x-ratelimit-remaining': SECRET, 'x-ratelimit-limit': '9999999999',
      'x-ratelimit-reset': '10000000000', 'retry-after': '0',
    })
    expect(error.message).toBe('desktop plugin source: GitHub request failed with 403'
      + ' (host=api.github.com; operation=release-metadata; limit=9999999999; retryAfter=0)')
  })

  it.each(['', '-1', '1.5', '1e3', '00', '12secret', '10000000000', 'Wed, 21 Oct 2015 07:28:00 GMT', SECRET])(
    'omits noncanonical or oversized numeric response fields: %j', async (value) => {
      const error = await failure(`${API}/releases`, {
        'x-ratelimit-remaining': value, 'x-ratelimit-limit': value, 'x-ratelimit-reset': value, 'retry-after': value,
      })
      expect(error.message).toBe('desktop plugin source: GitHub request failed with 403 (host=api.github.com; operation=release-metadata)')
    },
  )

  it.each([
    [`${API}/releases`, 'release-metadata'],
    [`${API}/releases/tags/${SECRET}`, 'release-metadata'],
    [`${API}/releases/123`, 'release-metadata'],
    [`${API}/git/ref/tags/${SECRET}`, 'tag-reference'],
    [`${API}/git/tags/${'a'.repeat(40)}`, 'tag-object'],
    [`${API}/releases/assets/123`, 'release-asset'],
    [`${API}/${SECRET}`, 'other-api'],
  ])('reports only an operation category for %s', async (url, operation) => {
    const error = await failure(`${url}?token=${SECRET}`)
    expect(error.message).toBe(`desktop plugin source: GitHub request failed with 403 (host=api.github.com; operation=${operation})`)
    expect(error.message).not.toContain('/repos/')
  })

  it.each(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'])(
    'reports the final approved download host %s without signed URL bytes', async (host) => {
      const transport = vi.fn<typeof fetch>()
        .mockResolvedValueOnce(new Response(null, { status: 302, headers: { location: `https://${host}/${SECRET}?token=${SECRET}` } }))
        .mockResolvedValueOnce(new Response(SECRET, { status: 403, headers: { 'retry-after': '2' } }))
      const error: unknown = await requestDesktopGithubRelease(new URL(`${API}/releases/assets/123`), accept, true, transport, subject)
        .catch((reason: unknown) => reason)
      expect(error).toMatchObject({ message: `desktop plugin source: GitHub request failed with 403 (host=${host}; operation=asset-download; retryAfter=2)` })
      expect(inspect(error)).not.toContain(SECRET)
      expect(transport).toHaveBeenCalledTimes(2)
    },
  )

  it.each([401, 403, 404, 429, 500])('preserves HTTP %s as failure without retry or fallback', async (status) => {
    const error = await failure(`${API}/releases`, {}, status)
    expect(error.message).toBe(`desktop plugin source: GitHub request failed with ${status} (host=api.github.com; operation=release-metadata)`)
  })

  it('preserves the HTTP error identity through typed network-error handling', async () => {
    const error = await failure(`${API}/releases`, { 'x-ratelimit-remaining': '0' })
    await expect(withDesktopUpdateNetworkError('release-list', () => Promise.reject(error))).rejects.toBe(error)
    expect(desktopUpdateNetworkDetails(error)).toBeUndefined()
  })

  it('still rejects an unapproved redirect before contacting that host', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(null, {
      status: 302, headers: { location: `https://example.invalid/${SECRET}` },
    }))
    await expect(requestDesktopGithubRelease(new URL(`${API}/releases/assets/123`), accept, true, transport, subject))
      .rejects.toThrow('rejected redirect host example.invalid')
    expect(transport).toHaveBeenCalledOnce()
  })

  it('returns a successful response unchanged without reading diagnostic headers or body', async () => {
    const response = new Response('[]')
    const headers = vi.spyOn(response.headers, 'get')
    const transport = vi.fn<typeof fetch>(async () => response)
    expect(await requestDesktopGithubRelease(new URL(`${API}/releases`), accept, false, transport, subject)).toBe(response)
    expect(headers).not.toHaveBeenCalled()
    expect(response.bodyUsed).toBe(false)
    expect(transport).toHaveBeenCalledOnce()
  })
})
