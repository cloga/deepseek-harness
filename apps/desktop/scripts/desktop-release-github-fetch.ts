/** Build/release-only GitHub metadata authentication; never imported by the packaged application. */

import {
  discoverDesktopManagedSourceRelease,
  type DesktopManagedUpdateSelection,
} from '../src/managed-update-coordinator.ts'
import type { DesktopManagedUpdateCapability } from '../src/managed-update-protocol.ts'

const API_PREFIX = 'https://api.github.com/repos/cloga/deepseek-harness/'
const TAG_REFERENCE = /^git\/ref\/tags\/dsh-desktop-v[A-Za-z0-9._-]+(?:%2B[A-Za-z0-9._-]+)?$/u
const TAG_OBJECT = /^git\/tags\/[a-f0-9]{40}$/u
const REDIRECTS = new Set([301, 302, 303, 307, 308])

function isReleaseMetadata(url: string): boolean {
  if (!url.startsWith(API_PREFIX)) return false
  const route = url.slice(API_PREFIX.length)
  return route === 'releases?per_page=100' || TAG_REFERENCE.test(route) || TAG_OBJECT.test(route)
}

class DesktopReleaseFetchError extends Error {}

function safeFailure(error: unknown, signal?: AbortSignal | null): Error {
  if (error instanceof DesktopReleaseFetchError) return error
  const name = signal?.aborted === true && signal.reason instanceof Error
    ? signal.reason.name
    : error instanceof Error ? error.name : undefined
  if (signal?.aborted === true || name === 'AbortError' || name === 'TimeoutError') {
    return new DOMException('Desktop release request cancelled', name === 'TimeoutError' ? 'TimeoutError' : 'AbortError')
  }
  return new DesktopReleaseFetchError('desktop release build: GitHub discovery failed; remote diagnostics withheld')
}

/**
 * Create an explicitly opted-in release-script fetch adapter. No environment or credential stores are read.
 * Strip caller Authorization and Cookie headers; only canonical GET release-list and tag-resolution URLs receive the token.
 * Authenticated redirects fail closed. Anonymous redirects remain subject to the discovery protocol's existing limits.
 * URL/Request objects are checked in their serialized form; raw strings are checked before URL normalization.
 * @param token - Dedicated CI metadata token, or undefined/empty for anonymous requests.
 * @param fetcher - Transport, injectable without global mutation or real credentials.
 * @returns Fetch implementation preserving request signals and forcing manual redirects and omitted credentials.
 */
export function createDesktopReleaseGithubFetch(token: string | undefined, fetcher: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const request = input instanceof Request ? input : undefined
    const signal = init?.signal === undefined ? request?.signal : init.signal
    try {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? request?.method ?? 'GET'
      const headers = new Headers(init?.headers ?? request?.headers)
      headers.delete('authorization')
      headers.delete('cookie')
      const authenticated = token !== undefined && token !== '' && method === 'GET' && isReleaseMetadata(url)
      if (authenticated) headers.set('authorization', `Bearer ${token}`)
      const response = await fetcher(input, { ...init, headers, redirect: 'manual', credentials: 'omit' })
      if (authenticated && REDIRECTS.has(response.status)) {
        await response.body?.cancel()
        throw new DesktopReleaseFetchError('desktop release build: authenticated metadata redirect rejected')
      }
      if (!response.ok && !REDIRECTS.has(response.status)) {
        await response.body?.cancel()
        throw new DesktopReleaseFetchError(`desktop release build: GitHub request failed with HTTP ${String(response.status)}`)
      }
      return response
    } catch (error) {
      // Transport errors can contain request headers or abort reasons; never retain a secret-bearing cause.
      throw safeFailure(error, signal)
    }
  }
}

/**
 * Run the public source discovery with build-only auth and sanitized transport, body, parsing, and redirect errors.
 * No token is added to the capability, selection, plan, or release receipts.
 * @param capability - Reviewed public discovery policy, unchanged by this adapter.
 * @param token - Explicit dedicated CI token; no implicit GH_TOKEN or account credentials.
 * @param fetcher - Injectable transport for deterministic source-unit tests.
 * @returns Highest accepted source release, or undefined before the source channel has a release.
 */
export async function discoverDesktopReleaseForBuild(
  capability: DesktopManagedUpdateCapability,
  token: string | undefined,
  fetcher: typeof fetch = fetch,
): Promise<DesktopManagedUpdateSelection | undefined> {
  try {
    return await discoverDesktopManagedSourceRelease(capability, 0, {
      fetch: createDesktopReleaseGithubFetch(token, fetcher),
    })
  } catch (error) {
    throw safeFailure(error)
  }
}
