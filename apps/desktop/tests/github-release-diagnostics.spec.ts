import { describe, expect, it, vi } from 'vitest'
import { requestDesktopGithubRelease } from '../src/github-release.ts'

const subject = 'desktop plugin source'
const endpoint = new URL('https://api.github.com/repos/example/plugin/releases/tags/v1.0.0?token=private-url-value')

describe('Desktop GitHub failure diagnostics', () => {
  it('reports bounded rate headers without changing credential or retry behavior', async () => {
    const response = new Response('private-response-body', { status: 403, headers: {
      'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '1800000000', 'retry-after': '60',
      'set-cookie': 'private-cookie', 'x-github-request-id': 'private-request-id',
    } })
    const cancel = vi.spyOn(response.body!, 'cancel')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
    await expect(requestDesktopGithubRelease(endpoint, 'application/vnd.github+json', false, fetcher, subject))
      .rejects.toMatchObject({ message: 'desktop plugin source: GitHub request failed with 403 (request=release-metadata, rateRemaining=0, rateReset=1800000000, retryAfter=60)' })
    expect(fetcher).toHaveBeenCalledOnce()
    expect(cancel).toHaveBeenCalledOnce()
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'manual', credentials: 'omit' })
    expect(fetcher.mock.calls[0]?.[1]?.headers).not.toHaveProperty('authorization')
  })

  it.each(['private-token', '-1', '1.5', '1e6', '9999999999999', '10, private-token', ''])('omits unsafe numeric header value %j', async (value) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-body', { status: 403, headers: {
      'x-ratelimit-remaining': value, 'x-ratelimit-reset': value, 'retry-after': value,
      'location': 'https://example.invalid/?token=private-redirect',
    } }))
    await expect(requestDesktopGithubRelease(endpoint, 'application/json', false, fetcher, subject))
      .rejects.toThrow(/^desktop plugin source: GitHub request failed with 403 \(request=release-metadata\)$/u)
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it.each([
    ['https://api.github.com/repos/example/plugin/git/ref/tags/v1', false, 'tag-reference'],
    ['https://api.github.com/repos/example/plugin/git/tags/abcdef', false, 'annotated-tag'],
    ['https://api.github.com/repos/example/plugin', false, 'api'],
    ['https://github.com/example/plugin/releases/download/v1/plugin.tgz?signature=private', true, 'asset-download'],
  ] as const)('reports category without echoing the URL: %s', async (url, download, category) => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('private-body', { status: 403 }))
    await expect(requestDesktopGithubRelease(new URL(url), 'application/json', download, fetcher, subject))
      .rejects.toMatchObject({ message: `desktop plugin source: GitHub request failed with 403 (request=${category})` })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('keeps the HTTP failure when response-body cleanup also fails', async () => {
    const response = new Response('private-body', { status: 429, headers: { 'retry-after': '1' } })
    vi.spyOn(response.body!, 'cancel').mockRejectedValue(new Error('private-cleanup-detail'))
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
    await expect(requestDesktopGithubRelease(endpoint, 'application/json', false, fetcher, subject))
      .rejects.toMatchObject({ message: 'desktop plugin source: GitHub request failed with 429 (request=release-metadata, retryAfter=1)' })
    expect(fetcher).toHaveBeenCalledOnce()
  })

  it('does not inspect or cancel successful response content', async () => {
    const response = new Response('{"ok":true}', { status: 200 })
    const cancel = vi.spyOn(response.body!, 'cancel')
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response)
    expect(await requestDesktopGithubRelease(endpoint, 'application/json', false, fetcher, subject)).toBe(response)
    expect(cancel).not.toHaveBeenCalled()
    expect(await response.json()).toEqual({ ok: true })
  })
})
