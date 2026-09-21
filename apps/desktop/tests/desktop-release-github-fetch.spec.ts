import { createHash } from 'node:crypto'
import { inspect } from 'node:util'
import { describe, expect, it, vi } from 'vitest'
import {
  createDesktopReleaseGithubFetch,
  discoverDesktopReleaseForBuild,
} from '../scripts/desktop-release-github-fetch.ts'
import { discoverDesktopManagedSourceRelease } from '../src/managed-update-coordinator.ts'
import {
  MANAGED_COMMIT,
  MANAGED_TAG,
  managedCapability,
  managedManifest,
} from './managed-update-fixture.ts'

const TOKEN = 'github_pat_FAKE_BUILD_ONLY_SECRET_0123456789'
const API = 'https://api.github.com/repos/cloga/deepseek-harness'
const LIST = `${API}/releases?per_page=100`
const REF = `${API}/git/ref/tags/${MANAGED_TAG}`
const TAG = `${API}/git/tags/${'a'.repeat(40)}`
const MANIFEST = `https://github.com/cloga/deepseek-harness/releases/download/${MANAGED_TAG}/release.json`

function requestUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
}

function capturedFetch() {
  return vi.fn<typeof fetch>(async () => new Response('[]'))
}

function assertNoSecret(error: unknown): void {
  expect(error).toBeInstanceOf(Error)
  expect(inspect(error)).not.toContain(TOKEN)
  expect(error).not.toHaveProperty('cause')
}

describe('build/release-only GitHub metadata fetch', () => {
  it.each([LIST, REF, TAG, `${API}/git/ref/tags/dsh-desktop-v1.2.3%2Bbuild.1`])('authenticates canonical GET %s', async (url) => {
    const transport = capturedFetch()
    const controller = new AbortController()
    const headers = { accept: 'application/vnd.github+json', 'user-agent': 'desktop-test', authorization: 'caller-token' }
    const init: RequestInit = { headers, signal: controller.signal, redirect: 'follow', credentials: 'include' }
    await createDesktopReleaseGithubFetch(TOKEN, transport)(url, init)
    const sent = transport.mock.calls[0]?.[1]
    expect(new Headers(sent?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`)
    expect(new Headers(sent?.headers).get('accept')).toBe(headers.accept)
    expect(new Headers(sent?.headers).get('user-agent')).toBe(headers['user-agent'])
    expect(sent?.signal).toBe(controller.signal)
    expect(sent?.redirect).toBe('manual')
    expect(sent?.credentials).toBe('omit')
    expect(init).toEqual({ headers, signal: controller.signal, redirect: 'follow', credentials: 'include' })
    expect(headers.authorization).toBe('caller-token')
  })

  it.each([
    MANIFEST,
    'https://objects.githubusercontent.com/release.json',
    'https://release-assets.githubusercontent.com/release.json',
    LIST.replace('api.github.com', 'github.com'),
    LIST.replace('api.github.com', 'api.github.com.evil.test'),
    LIST.replace('api.github.com', 'evil.test'),
    LIST.replace('api.github.com', 'api.github.com.'),
    LIST.replace('https:', 'http:'),
    LIST.replace('api.github.com', 'user:password@api.github.com'),
    LIST.replace('api.github.com', 'api.github.com:443'),
    LIST.replace('api.github.com', 'api.github.com:8443'),
    LIST.replace('api.github.com', 'API.GITHUB.COM'),
    LIST.replace('/repos/', '/x/../repos/'),
    LIST.replace('/repos/', '/%2e%2e/repos/'),
    LIST.replace('/repos/', '//repos/'),
    LIST.replace('/repos/', '/repos\\'),
    LIST.replace('cloga/', 'other/'),
    LIST.replace('deepseek-harness/', 'dsh-github-copilot/'),
    `${API}/releases`,
    `${API}/releases?per_page=100&page=2`,
    `${API}/releases?per_page=100&token=ignored`,
    `${API}/releases/latest`,
    `${API}/releases/tags/${MANAGED_TAG}`,
    `${API}/releases/assets/123`,
    `${API}/git/ref/tags/other-v1.0.0`,
    `${REF}%2Fextra`,
    `${REF}%252Fextra`,
    `${REF}/extra`,
    `${REF}?unexpected=1`,
    `${TAG}0`,
    TAG.replace(/a{40}$/u, 'A'.repeat(40)),
    `${LIST}#fragment`,
    ` ${LIST}`,
    `${LIST}\n`,
    `${REF}\n`,
    `${TAG}\n`,
  ])('omits dedicated and caller Authorization for %s', async (url) => {
    const transport = capturedFetch()
    await createDesktopReleaseGithubFetch(TOKEN, transport)(url, { headers: { Authorization: 'caller-secret' } })
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false)
    expect(inspect(transport.mock.calls)).not.toContain(TOKEN)
  })

  it.each([LIST, MANIFEST, 'https://evil.test/'])('strips explicit Cookie headers for %s even with included credentials', async (url) => {
    const transport = capturedFetch()
    const adapter = createDesktopReleaseGithubFetch(TOKEN, transport)
    const headers = new Headers({ Cookie: 'session=caller-secret', Authorization: 'caller-secret' })
    await adapter(url, { headers, credentials: 'include' })
    await adapter(new Request(url, { headers, credentials: 'include' }))
    for (const [, init] of transport.mock.calls) {
      const sent = new Headers(init?.headers)
      expect(sent.has('cookie')).toBe(false)
      expect(sent.get('authorization')).toBe(url === LIST ? `Bearer ${TOKEN}` : null)
      expect(init?.credentials).toBe('omit')
    }
    expect(headers.get('cookie')).toBe('session=caller-secret')
  })

  it.each(['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'get'])('does not authenticate method %s', async (method) => {
    const transport = capturedFetch()
    await createDesktopReleaseGithubFetch(TOKEN, transport)(LIST, { method, headers: [['Authorization', 'caller-secret']] })
    expect(transport.mock.calls[0]?.[1]?.method).toBe(method)
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false)
  })

  it('uses Request headers/method unless explicitly overridden, stripping inherited Authorization', async () => {
    const transport = capturedFetch()
    const adapter = createDesktopReleaseGithubFetch(TOKEN, transport)
    const request = new Request(LIST, { method: 'POST', headers: { Authorization: 'caller-secret', accept: 'application/json' } })
    await adapter(request)
    await adapter(request, { method: 'GET' })
    await adapter(new Request(MANIFEST, { headers: request.headers }))
    const headers = transport.mock.calls.map(([, init]) => new Headers(init?.headers))
    expect(headers.map(header => header.get('authorization'))).toEqual([null, `Bearer ${TOKEN}`, null])
    expect(headers[0]?.get('accept')).toBe('application/json')
    expect(request.headers.get('authorization')).toBe('caller-secret')
  })

  it.each([undefined, ''])('stays anonymous without an explicit nonempty token (%s)', async (token) => {
    const transport = capturedFetch()
    const adapter = createDesktopReleaseGithubFetch(token, transport)
    await adapter(new URL(LIST), { headers: { authorization: 'caller-secret' } })
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false)
    await expect(discoverDesktopReleaseForBuild(managedCapability(), token, transport)).resolves.toBeUndefined()
    expect(transport.mock.calls).toHaveLength(2)
    expect(inspect(transport.mock.calls)).not.toContain(TOKEN)
  })

  it.each([301, 302, 303, 307, 308])('rejects authenticated HTTP %s redirects without following or reading diagnostic text', async (status) => {
    for (const location of [LIST, REF, MANIFEST, 'https://evil.test/', `https://${TOKEN}.evil.test/`]) {
      const cancel = vi.fn()
      const response = new Response(new ReadableStream({ cancel }), {
        status,
        headers: { location, 'x-github-request-id': TOKEN, 'x-ratelimit-remaining': TOKEN },
      })
      const transport = vi.fn<typeof fetch>(async () => response)
      const error: unknown = await createDesktopReleaseGithubFetch(TOKEN, transport)(LIST).catch((error: unknown) => error)
      expect(error).toMatchObject({ message: 'desktop release build: authenticated metadata redirect rejected' })
      assertNoSecret(error)
      expect(transport).toHaveBeenCalledOnce()
      expect(cancel).toHaveBeenCalledOnce()
      expect(transport.mock.calls[0]?.[1]?.redirect).toBe('manual')
    }
  })

  it('keeps anonymous redirects manual for the existing discovery policy', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: LIST } }))
    const response = await createDesktopReleaseGithubFetch(undefined, transport)(LIST)
    expect(response.status).toBe(302)
    expect(transport.mock.calls[0]?.[1]?.redirect).toBe('manual')
    expect(transport).toHaveBeenCalledOnce()
  })

  it('reports only numeric HTTP status, not status text, headers or body, and never retries a 403', async () => {
    const transport = vi.fn<typeof fetch>(async () => new Response(TOKEN, {
      status: 403,
      statusText: TOKEN,
      headers: { 'x-github-request-id': TOKEN, 'x-ratelimit-remaining': TOKEN, 'retry-after': TOKEN },
    }))
    const error: unknown = await discoverDesktopReleaseForBuild(managedCapability(), TOKEN, transport).catch((error: unknown) => error)
    expect(error).toMatchObject({ message: 'desktop release build: GitHub request failed with HTTP 403' })
    assertNoSecret(error)
    expect(transport).toHaveBeenCalledOnce()
  })

  it.each(['fetch', 'json', 'stream', 'redirect-cancel'])('sanitizes token-bearing %s errors without retaining a cause', async (stage) => {
    const secretError = new Error(`Authorization: Bearer ${TOKEN}`, { cause: new Error(TOKEN) })
    const transport = vi.fn<typeof fetch>(async () => {
      if (stage === 'fetch') throw secretError
      if (stage === 'json') return new Response(`invalid JSON ${TOKEN}`)
      if (stage === 'stream') return new Response(new ReadableStream({ start(controller) { controller.error(secretError) } }))
      return new Response(new ReadableStream({ cancel() { throw secretError } }), { status: 302, headers: { location: REF } })
    })
    const error: unknown = await discoverDesktopReleaseForBuild(managedCapability(), TOKEN, transport).catch((error: unknown) => error)
    expect(error).toMatchObject({ message: 'desktop release build: GitHub discovery failed; remote diagnostics withheld' })
    assertNoSecret(error)
  })

  it.each(['before', 'during'])('preserves cancellation %s transport without exposing the abort reason', async (when) => {
    const controller = new AbortController()
    const reason = new Error(TOKEN)
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBe(controller.signal)
      return await new Promise<Response>((_resolve, reject) => {
        const abort = () => {
          expect(controller.signal.reason).toBe(reason)
          reject(reason)
        }
        if (controller.signal.aborted) abort()
        else controller.signal.addEventListener('abort', abort, { once: true })
      })
    })
    if (when === 'before') controller.abort(reason)
    const pending = createDesktopReleaseGithubFetch(TOKEN, transport)(LIST, { signal: controller.signal })
    if (when === 'during') controller.abort(reason)
    const error: unknown = await pending.catch((error: unknown) => error)
    expect(error).toMatchObject({ name: 'AbortError', message: 'Desktop release request cancelled' })
    assertNoSecret(error)
    expect(transport).toHaveBeenCalledOnce()
  })

  it('honors an explicit null signal override instead of classifying an inherited aborted Request as cancellation', async () => {
    const request = new Request(LIST, { signal: AbortSignal.abort(new Error(TOKEN)) })
    const transport = vi.fn<typeof fetch>(async (_input, init) => {
      expect(init?.signal).toBeNull()
      throw new Error(TOKEN)
    })
    const error: unknown = await createDesktopReleaseGithubFetch(TOKEN, transport)(request, { signal: null })
      .catch((error: unknown) => error)
    expect(error).toMatchObject({ name: 'Error', message: 'desktop release build: GitHub discovery failed; remote diagnostics withheld' })
    assertNoSecret(error)
  })

  it.each(['TimeoutError', 'AbortError'])('preserves %s classification through the discovery wrapper while scrubbing its message', async (name) => {
    const transport = vi.fn<typeof fetch>(async () => { throw new DOMException(TOKEN, name) })
    const error: unknown = await discoverDesktopReleaseForBuild(managedCapability(), TOKEN, transport).catch((error: unknown) => error)
    expect(error).toMatchObject({ name })
    assertNoSecret(error)
  })

  it('authenticates real discovery list, lightweight/annotated tag metadata but not manifest/CDN downloads or outputs', async () => {
    const manifest = managedManifest()
    const body = JSON.stringify(manifest)
    const digest = createHash('sha256').update(body).digest('hex')
    const cdn = 'https://release-assets.githubusercontent.com/release.json'
    for (const annotated of [false, true]) {
      const transport = vi.fn<typeof fetch>(async (input, init) => {
        const url = requestUrl(input)
        expect(init?.redirect).toBe('manual')
        expect(init?.credentials).toBe('omit')
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        expect(new Headers(init?.headers).get('authorization')).toBe([LIST, REF, TAG].includes(url) ? `Bearer ${TOKEN}` : null)
        if (url === LIST) return Response.json([{
          tag_name: MANAGED_TAG, target_commitish: MANAGED_COMMIT, draft: false, immutable: true,
          assets: [{ name: 'release.json', state: 'uploaded', digest: `sha256:${digest}` }],
        }])
        if (url === REF) return Response.json({ object: { type: annotated ? 'tag' : 'commit', sha: annotated ? 'a'.repeat(40) : MANAGED_COMMIT } })
        if (url === TAG) return Response.json({ object: { type: 'commit', sha: MANAGED_COMMIT } })
        if (url === MANIFEST) return new Response(null, { status: 302, headers: { location: cdn } })
        if (url === cdn) return new Response(body)
        throw new Error('unexpected request')
      })
      const capability = managedCapability()
      const before = JSON.stringify(capability)
      const selected = await discoverDesktopReleaseForBuild(capability, TOKEN, transport)
      expect(selected).toMatchObject({ manifest: { source: { commit: MANAGED_COMMIT } } })
      expect(transport.mock.calls.map(([input]) => requestUrl(input))).toEqual(annotated
        ? [LIST, MANIFEST, cdn, REF, TAG] : [LIST, MANIFEST, cdn, REF])
      expect(JSON.stringify(capability)).toBe(before)
      expect(JSON.stringify(selected)).not.toContain(TOKEN)
    }
  })

  it('retains the public source discovery anonymous fetch seam', async () => {
    const transport = capturedFetch()
    await expect(discoverDesktopManagedSourceRelease(managedCapability(), 0, { fetch: transport })).resolves.toBeUndefined()
    expect(requestUrl(transport.mock.calls[0]![0])).toBe(LIST)
    expect(new Headers(transport.mock.calls[0]?.[1]?.headers).has('authorization')).toBe(false)
  })

  it('preserves the one-page and anonymous redirect bounds without retries', async () => {
    const paginated = vi.fn<typeof fetch>(async () => new Response('[]', { headers: { link: '<next>; rel="next"' } }))
    await expect(discoverDesktopReleaseForBuild(managedCapability(), TOKEN, paginated)).rejects.toThrow(/discovery failed/u)
    expect(paginated).toHaveBeenCalledOnce()
    const redirected = vi.fn<typeof fetch>(async () => new Response(null, { status: 302, headers: { location: LIST } }))
    await expect(discoverDesktopReleaseForBuild(managedCapability(), undefined, redirected)).rejects.toThrow(/discovery failed/u)
    expect(redirected).toHaveBeenCalledTimes(6)
  })
})
