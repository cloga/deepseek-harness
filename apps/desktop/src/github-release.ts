/** Shared GitHub Release transport and tag verification for Desktop-owned artifacts. */

const API_HOST = 'api.github.com'
const DOWNLOAD_HOSTS = new Set([
  API_HOST,
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
])
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u
const MAX_REDIRECTS = 5
const REQUEST_TIMEOUT_MS = 30_000

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`)
  }
  return value as Record<string, unknown>
}

function string(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || value === '' || (pattern !== undefined && !pattern.test(value))) {
    throw new Error(`${label} is invalid`)
  }
  return value
}

function validateRequestUrl(url: URL, download: boolean, subject: string): void {
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '') {
    throw new Error(`${subject}: GitHub request must use credential-free HTTPS`)
  }
  const allowed = download ? DOWNLOAD_HOSTS : new Set([API_HOST])
  if (!allowed.has(url.hostname)) throw new Error(`${subject}: rejected redirect host ${url.hostname}`)
}

/** HTTP refusal context from an already validated host; remote text and URL paths never enter diagnostics. */
function httpFailureContext(url: URL, response: Response): string {
  const path = url.pathname
  const operation = url.hostname !== API_HOST ? 'asset-download'
    : /^\/repos\/[^/]+\/[^/]+\/releases(?:\/tags\/[^/]+|\/\d+)?$/u.test(path) ? 'release-metadata'
      : /^\/repos\/[^/]+\/[^/]+\/git\/ref\/tags\/[^/]+$/u.test(path) ? 'tag-reference'
        : /^\/repos\/[^/]+\/[^/]+\/git\/tags\/[a-f0-9]{40}$/u.test(path) ? 'tag-object'
          : /^\/repos\/[^/]+\/[^/]+\/releases\/assets\/\d+$/u.test(path) ? 'release-asset' : 'other-api'
  const fields = [`host=${url.hostname}`, `operation=${operation}`]
  for (const [header, label] of [
    ['x-ratelimit-remaining', 'remaining'], ['x-ratelimit-limit', 'limit'],
    ['x-ratelimit-reset', 'reset'], ['retry-after', 'retryAfter'],
  ] as const) {
    const value = response.headers.get(header)
    // Canonical nonnegative decimal values only; omit arbitrary text and oversized remote fields.
    if (value !== null && /^(?:0|[1-9]\d{0,9})$/u.test(value)) fields.push(`${label}=${value}`)
  }
  return fields.join('; ')
}

/**
 * Fetch one GitHub API or asset response through the fixed Desktop redirect policy.
 * @param initial - Initial GitHub URL.
 * @param accept - GitHub media type.
 * @param download - Whether release download hosts are allowed.
 * @param fetcher - Fetch implementation.
 * @param subject - Diagnostic prefix owned by the caller.
 * @returns Successful final response.
 */
export async function requestDesktopGithubRelease(
  initial: URL,
  accept: string,
  download: boolean,
  fetcher: typeof fetch,
  subject: string,
): Promise<Response> {
  let url = initial
  for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
    validateRequestUrl(url, download, subject)
    const response = await fetcher(url, {
      headers: {
        accept,
        'user-agent': 'deepseek-harness-desktop',
        'x-github-api-version': '2026-03-10',
      },
      redirect: 'manual',
      credentials: 'omit',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    if (!REDIRECTS.has(response.status)) {
      if (!response.ok) {
        throw new Error(`${subject}: GitHub request failed with ${String(response.status)} (${httpFailureContext(url, response)})`)
      }
      return response
    }
    if (redirect === MAX_REDIRECTS) throw new Error(`${subject}: GitHub redirect limit exceeded`)
    const location = response.headers.get('location')
    if (location === null) throw new Error(`${subject}: GitHub redirect omitted its location`)
    await response.body?.cancel()
    url = new URL(location, url)
  }
  throw new Error(`${subject}: unreachable redirect state`)
}

/**
 * Read one GitHub API object.
 * @param url - Fixed GitHub API URL.
 * @param fetcher - Fetch implementation.
 * @param subject - Diagnostic prefix owned by the caller.
 * @returns Parsed response object.
 */
export async function readDesktopGithubReleaseJson(
  url: URL,
  fetcher: typeof fetch,
  subject: string,
): Promise<Record<string, unknown>> {
  const response = await requestDesktopGithubRelease(
    url,
    'application/vnd.github+json',
    false,
    fetcher,
    subject,
  )
  return record(await response.json(), `${subject}: GitHub response`)
}

/**
 * Resolve an annotated or lightweight Git tag to its commit.
 * @param owner - GitHub repository owner.
 * @param repository - GitHub repository name.
 * @param tag - Exact immutable release tag.
 * @param fetcher - Fetch implementation.
 * @param subject - Diagnostic prefix owned by the caller.
 * @returns Commit selected by the tag.
 */
export async function resolveDesktopGithubTagCommit(
  owner: string,
  repository: string,
  tag: string,
  fetcher: typeof fetch,
  subject: string,
): Promise<string> {
  const base = `https://${API_HOST}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repository)}`
  const reference = await readDesktopGithubReleaseJson(
    new URL(`${base}/git/ref/tags/${encodeURIComponent(tag)}`),
    fetcher,
    subject,
  )
  let object = reference.object
  for (let depth = 0; depth < 4; depth++) {
    const target = record(object, `${subject}: GitHub tag reference object`)
    const sha = string(target.sha, `${subject}: GitHub tag object SHA`, COMMIT_PATTERN)
    if (target.type === 'commit') return sha
    if (target.type !== 'tag') throw new Error(`${subject}: GitHub tag does not resolve to a commit`)
    const annotated = await readDesktopGithubReleaseJson(
      new URL(`${base}/git/tags/${sha}`),
      fetcher,
      subject,
    )
    object = annotated.object
  }
  throw new Error(`${subject}: GitHub tag indirection limit exceeded`)
}
