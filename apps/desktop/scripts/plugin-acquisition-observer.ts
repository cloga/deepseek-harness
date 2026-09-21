/** Read-only, bounded observations of Desktop's unchanged anonymous GitHub acquisition transport. */

/** Safe response facts; no URL, query, redirect target, response body, or arbitrary exception text is retained. */
export interface AcquisitionObservation {
  readonly route: 'release-metadata' | 'tag-reference' | 'tag-object' | 'package-asset' | 'checksum-asset' | 'asset-redirect'
  readonly host: string
  readonly status?: number
  readonly transportFailure?: true
  readonly rateLimitRemaining?: number
  readonly rateLimitReset?: number
  readonly retryAfter?: number | string
  readonly requestId?: string
}

/** Additional diagnostic-envelope refusals are distinct from an observed HTTP denial. */
export type AcquisitionObserverRejection = 'none' | 'request-limit' | 'request-url' | 'api-query' | 'api-route' | 'host' | 'authentication'

/** Exact non-secret identifiers needed to classify the existing acquisition requests. */
export interface AcquisitionTarget {
  readonly owner: string
  readonly repo: string
  readonly tag: string
  readonly assetId: number
  readonly checksumAssetId: number
}

function integer(value: string | null): number | undefined {
  if (value === null || !/^(?:0|[1-9]\d{0,14})$/u.test(value)) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) ? number : undefined
}

function responseFacts(headers: Headers): Pick<AcquisitionObservation,
  'rateLimitRemaining' | 'rateLimitReset' | 'retryAfter' | 'requestId'
> {
  const rateLimitRemaining = integer(headers.get('x-ratelimit-remaining'))
  const rateLimitReset = integer(headers.get('x-ratelimit-reset'))
  const rawRetry = headers.get('retry-after')
  let retryAfter: number | string | undefined = integer(rawRetry)
  if (retryAfter === undefined && rawRetry !== null
    && /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/u.test(rawRetry)) {
    const date = new Date(rawRetry)
    if (Number.isFinite(date.getTime()) && date.toUTCString() === rawRetry) retryAfter = rawRetry
  }
  const rawId = headers.get('x-github-request-id')
  const requestId = rawId !== null && /^[A-F0-9]{4}(?::[A-F0-9]{1,16}){3,4}$/iu.test(rawId) ? rawId : undefined
  return {
    ...(rateLimitRemaining === undefined ? {} : { rateLimitRemaining }),
    ...(rateLimitReset === undefined ? {} : { rateLimitReset }),
    ...(retryAfter === undefined ? {} : { retryAfter }),
    ...(requestId === undefined ? {} : { requestId }),
  }
}

/**
 * Wrap one acquisition's fetch seam without changing its request, headers, signals, redirects, or response.
 * @param target - The reviewed package lock's fixed route identifiers.
 * @param fetcher - Original transport; production uses global fetch, tests supply offline responses.
 * @returns Wrapped transport and bounded owned observations. The thirty-first request fails before transport.
 */
export function observePluginAcquisition(target: AcquisitionTarget, fetcher: typeof fetch): {
  fetch: typeof fetch
  observations: readonly AcquisitionObservation[]
  readonly rejection: AcquisitionObserverRejection
} {
  const observations: AcquisitionObservation[] = []
  let rejection: AcquisitionObserverRejection = 'none'
  const refuse = (reason: Exclude<AcquisitionObserverRejection, 'none'>): never => {
    rejection = reason
    throw new Error(`Diagnostic acquisition refused: ${reason}`)
  }
  const base = `/repos/${encodeURIComponent(target.owner)}/${encodeURIComponent(target.repo)}`
  const classify = (url: URL): AcquisitionObservation['route'] => {
    if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
      refuse('request-url')
    }
    if (url.hostname === 'api.github.com') {
      if (url.search !== '' || url.hash !== '') refuse('api-query')
      if (url.pathname === `${base}/releases/tags/${encodeURIComponent(target.tag)}`) return 'release-metadata'
      if (url.pathname === `${base}/git/ref/tags/${encodeURIComponent(target.tag)}`) return 'tag-reference'
      if (url.pathname.startsWith(`${base}/git/tags/`) && /^[a-f0-9]{40}$/u.test(url.pathname.slice(`${base}/git/tags/`.length))) {
        return 'tag-object'
      }
      if (url.pathname === `${base}/releases/assets/${String(target.assetId)}`) return 'package-asset'
      if (url.pathname === `${base}/releases/assets/${String(target.checksumAssetId)}`) return 'checksum-asset'
      return refuse('api-route')
    }
    if (['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'].includes(url.hostname)) {
      return 'asset-redirect'
    }
    return refuse('host')
  }
  return {
    observations,
    get rejection() { return rejection },
    fetch: async (input, init) => {
      if (observations.length >= 30) refuse('request-limit')
      let url: URL
      try { url = new URL(input instanceof Request ? input.url : input) } catch {
        return refuse('request-url')
      }
      const route = classify(url)
      const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined))
      if (headers.has('authorization') || headers.has('cookie')) refuse('authentication')
      let response: Response
      try {
        response = await fetcher(input, init)
      } catch {
        observations.push({ route, host: url.hostname, transportFailure: true })
        throw new Error('Diagnostic acquisition transport failed')
      }
      observations.push({ route, host: url.hostname, status: response.status, ...responseFacts(response.headers) })
      return response
    },
  }
}
