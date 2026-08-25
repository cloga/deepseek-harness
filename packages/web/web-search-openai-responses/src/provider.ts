/**
 * OpenAI Responses-compatible web search over `POST /responses`. The auxiliary
 * model request is provider-private and does not register tools or use `ctx.llm`.
 * @module @deepseek-ai/dsh-web-search-openai-responses/provider
 */

import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-session'
import { WebError } from '@deepseek-ai/dsh-web'
import type {
  WebSearchProvider,
  WebSearchRequest,
  WebSearchResult,
  WebSearchSource,
} from '@deepseek-ai/dsh-web'
import type {
  OpenAiResponsesPayload,
  OutputText,
  ResponsesOutput,
  StructuredSource,
} from './types.ts'

/** Stable id this provider registers under. */
export const OPENAI_RESPONSES_PROVIDER_ID = 'openai-responses'

/** Default OpenAI Responses API base; `/responses` is appended. */
export const OPENAI_RESPONSES_DEFAULT_BASE_URL = 'https://api.openai.com/v1'

/** Default model with Responses web-search support. */
export const OPENAI_RESPONSES_DEFAULT_MODEL = 'gpt-5-mini'

/** Default generated-output token bound for one auxiliary search. */
export const OPENAI_RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS = 2048

/** Attribution header sent on every request. Bump with the package version. */
const USER_AGENT = 'deepseek-harness/0.0.1'

/**
 * Reject a base URL that is unsafe to persist as the secret-free request endpoint.
 * @param baseURL - configured Responses-compatible endpoint base.
 * @throws {TypeError} when the value is not absolute HTTP(S) or carries userinfo, query parameters, or a fragment.
 */
export function validateOpenAiResponsesBaseUrl(baseURL: string): void {
  if (!URL.canParse(baseURL)) throw new TypeError('baseURL must be an absolute HTTP(S) URL')
  const parsed = new URL(baseURL)
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TypeError('baseURL must be an absolute HTTP(S) URL')
  }
  if (
    parsed.username.length > 0
    || parsed.password.length > 0
    || baseURL.includes('?')
    || baseURL.includes('#')
  ) {
    throw new TypeError('baseURL must not contain credentials, query parameters, or a fragment')
  }
}

/** Exact secret-free request recorded immediately before dispatch. */
export interface OpenAiResponsesSearchRequest {
  /** Fully resolved Responses endpoint. */
  readonly endpoint: string
  /** Exact JSON body sent to the provider. */
  readonly body: {
    readonly model: string
    readonly input: string
    readonly tools: readonly [{ readonly type: 'web_search' }]
    readonly include: readonly ['web_search_call.action.sources']
    readonly max_output_tokens: number
    readonly stream: false
  }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Secret-free auxiliary OpenAI Responses search request recorded before dispatch. */
    'web/openai-responses-search-request': OpenAiResponsesSearchRequest
  }
}

/** Resolved options snapshotted once for each search. */
export interface OpenAiResponsesSearchProviderOptions {
  /** Literal API key; when present it wins over {@link resolveApiKey}. */
  readonly apiKey?: string
  /** Resolve the current API key for one search operation. */
  readonly resolveApiKey?: () => Promise<string | undefined>
  /** Credential reference named by missing-credential diagnostics. */
  readonly apiKeyEnv?: CredentialRef
  /** Endpoint base; `/responses` is appended after trailing-slash normalization. */
  readonly baseURL: string
  /** Responses-compatible model name. */
  readonly model: string
  /** Upper bound sent as `max_output_tokens`. */
  readonly maxOutputTokens: number
  /**
   * Record the exact secret-free request immediately before dispatch. A throw
   * prevents dispatch so auxiliary model input cannot escape session logging.
   */
  readonly recordRequest?: (request: OpenAiResponsesSearchRequest) => void
}

/**
 * Validate and map an OpenAI Responses-compatible success body.
 * @param payload - untrusted JSON returned by the configured endpoint.
 * @returns the final output text and structured, ordered, deduplicated sources.
 * @throws {@link WebError} when consumed response fields are malformed, final text is blank, or no structured source exists.
 */
export function mapOpenAiResponsesPayload(payload: unknown): WebSearchResult {
  let parsed: OpenAiResponsesPayload
  try {
    parsed = parsePayload(payload)
  } catch (error: unknown) {
    throw providerResponseError(
      `OpenAI Responses search returned an unprocessable response body: ${String(error)}`,
      error,
    )
  }
  const textParts: string[] = []
  const sources: WebSearchSource[] = []
  const sourceIndexes = new Map<string, number>()

  const mergeSource = (source: StructuredSource): void => {
    const existingIndex = sourceIndexes.get(source.url)
    if (existingIndex === undefined) {
      sourceIndexes.set(source.url, sources.length)
      sources.push(toWebSource(source))
      return
    }
    const existing = sources[existingIndex]
    if (existing === undefined) throw new Error('source index invariant violated')
    sources[existingIndex] = {
      ...existing,
      ...existing.title === undefined && source.title !== undefined ? { title: source.title } : {},
      ...existing.snippet === undefined && source.snippet !== undefined ? { snippet: source.snippet } : {},
    }
  }

  for (const output of parsed.output) {
    switch (output.type) {
      case 'web_search_call':
        for (const source of output.sources) mergeSource(source)
        break
      case 'message':
        for (const item of output.texts) {
          textParts.push(item.text)
          for (const source of item.citations) mergeSource(source)
        }
        break
      case 'other':
        break
      default:
        assertNever(output)
    }
  }

  const content = textParts.join('')
  if (content.trim().length === 0) {
    throw providerResponseError('OpenAI Responses search returned no usable final output text')
  }
  if (sources.length === 0) {
    throw providerResponseError('OpenAI Responses search returned no structured web search sources')
  }
  return { content, sources, truncated: false }
}

/** OpenAI Responses-compatible provider; credential-bearing redirects are rejected. */
export class OpenAiResponsesSearchProvider implements WebSearchProvider {
  readonly id = OPENAI_RESPONSES_PROVIDER_ID

  /**
   * @param resolveOptions - options for the next operation; `search()` snapshots the returned value before its first await.
   */
  constructor(private readonly resolveOptions: () => OpenAiResponsesSearchProviderOptions) {}

  /** @returns whether the current local configuration can attempt a search without network I/O. */
  available(): boolean {
    const options = this.resolveOptions()
    return ((options.apiKey?.length ?? 0) > 0 || options.resolveApiKey !== undefined)
      && safeBaseUrl(options.baseURL)
      && options.model.trim().length > 0
      && isPositiveInteger(options.maxOutputTokens)
  }

  /**
   * Run one non-streaming Responses request.
   * @param request - provider-neutral search request.
   * @param signal - caller cancellation forwarded to credential preflight and `fetch`.
   * @returns final provider text plus structured sources; `ctx.web` applies `maxResults`.
   */
  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const options = this.resolveOptions()
    validateOpenAiResponsesBaseUrl(options.baseURL)
    throwIfAborted(signal)
    const apiKey = await this.apiKey(options, signal)
    throwIfAborted(signal)

    const endpoint = `${normalizeBaseUrl(options.baseURL)}/responses`
    const body: OpenAiResponsesSearchRequest['body'] = {
      model: options.model,
      input: request.query,
      tools: [{ type: 'web_search' }],
      include: ['web_search_call.action.sources'],
      max_output_tokens: options.maxOutputTokens,
      stream: false,
    }
    options.recordRequest?.({ endpoint, body })
    throwIfAborted(signal)

    let response: Response
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'authorization': `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'accept': 'application/json',
          'user-agent': USER_AGENT,
        },
        body: JSON.stringify(body),
        ...signal === undefined ? {} : { signal },
      })
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(
        `OpenAI Responses search request failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }

    if (!response.ok) {
      const message = await httpErrorMessage(response, signal)
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }

    try {
      const payload: unknown = await response.json()
      return mapOpenAiResponsesPayload(payload)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      if (error instanceof WebError) throw error
      throw providerResponseError(`OpenAI Responses search returned an unprocessable response body: ${String(error)}`, error)
    }
  }

  /** Resolve one operation's credential without retaining it on the provider. */
  private async apiKey(
    options: OpenAiResponsesSearchProviderOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    if (options.apiKey !== undefined && options.apiKey.length > 0) return options.apiKey
    let resolved: string | undefined
    try {
      resolved = await abortable(options.resolveApiKey?.() ?? Promise.resolve(undefined), signal)
    } catch (error: unknown) {
      if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
      throw new WebError(
        `OpenAI Responses search credential resolution failed: ${String(error)}`,
        'WEB_PROVIDER_ERROR',
        { cause: error },
      )
    }
    if (resolved !== undefined && resolved.length > 0) return resolved
    const ref = options.apiKeyEnv ?? 'OPENAI_API_KEY'
    throw new WebError(
      `OpenAI Responses search has no API key for "${ref}"; store it through the credentials service,`
      + ' export it in the launching environment, or set "apiKey" in the'
      + ' web-search-openai-responses config',
      'WEB_PROVIDER_CREDENTIAL_MISSING',
    )
  }
}

/** Parse only the response fields this provider consumes. */
function parsePayload(value: unknown): OpenAiResponsesPayload {
  const root = requireRecord(value, '$')
  const status = optionalNonNullString(root.status, '$.status')
  if (status !== undefined && status !== 'completed') {
    throw new TypeError(`$.status must be "completed" when present; received ${JSON.stringify(status)}`)
  }
  const output = requireArray(root.output, '$.output')
  return { output: output.map((item, index) => parseOutput(item, `$.output[${String(index)}]`)) }
}

/** Validate one output item while leaving unrelated item kinds extensible. */
function parseOutput(value: unknown, path: string): ResponsesOutput {
  const item = requireRecord(value, path)
  const type = requireString(item.type, `${path}.type`)
  if (type === 'web_search_call') {
    const action = requireRecord(item.action, `${path}.action`)
    return {
      type,
      sources: action.sources === undefined
        ? []
        : requireArray(action.sources, `${path}.action.sources`)
          .map((source, index) => parseStructuredSource(source, `${path}.action.sources[${String(index)}]`)),
    }
  }
  if (type === 'message') {
    const content = requireArray(item.content, `${path}.content`)
    const texts: OutputText[] = []
    for (const [index, entry] of content.entries()) {
      const entryPath = `${path}.content[${String(index)}]`
      const block = requireRecord(entry, entryPath)
      const blockType = requireString(block.type, `${entryPath}.type`)
      if (blockType !== 'output_text') continue
      const text = requireString(block.text, `${entryPath}.text`)
      const annotations = block.annotations === undefined
        ? []
        : requireArray(block.annotations, `${entryPath}.annotations`)
      const citations: StructuredSource[] = []
      for (const [annotationIndex, annotation] of annotations.entries()) {
        const annotationPath = `${entryPath}.annotations[${String(annotationIndex)}]`
        const fields = requireRecord(annotation, annotationPath)
        const annotationType = requireString(fields.type, `${annotationPath}.type`)
        if (annotationType === 'url_citation') citations.push(parseStructuredSource(fields, annotationPath))
      }
      texts.push({ text, citations })
    }
    return { type, texts }
  }
  return { type: 'other' }
}

/** Validate source fields shared by action sources and URL citations. */
function parseStructuredSource(value: unknown, path: string): StructuredSource {
  const source = requireRecord(value, path)
  const url = requireString(source.url, `${path}.url`)
  if (!isHttpUrl(url)) throw new TypeError(`${path}.url must be an absolute HTTP(S) URL`)
  const title = optionalString(source.title, `${path}.title`)
  const snippet = optionalString(source.snippet, `${path}.snippet`)
  return {
    url,
    ...title === undefined || title.length === 0 ? {} : { title },
    ...snippet === undefined || snippet.length === 0 ? {} : { snippet },
  }
}

/** Convert validated provider metadata to the provider-neutral source type. */
function toWebSource(source: StructuredSource): WebSearchSource {
  return {
    url: source.url,
    ...source.title === undefined ? {} : { title: source.title },
    ...source.snippet === undefined ? {} : { snippet: source.snippet },
  }
}

/** Read a required JSON object without asserting an unvalidated wire type. */
function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`)
  return value
}

/** Read a required array. */
function requireArray(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`)
  return value
}

/** Read a required string. */
function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string') throw new TypeError(`${path} must be a string`)
  return value
}

/** Read an optional nullable string. */
function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireString(value, path)
}

/** Read an optional string whose wire field does not admit null. */
function optionalNonNullString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  return requireString(value, path)
}

/** Narrow a JSON object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** True for an absolute HTTP(S) URL. */
function isHttpUrl(value: string): boolean {
  if (!URL.canParse(value)) return false
  const protocol = new URL(value).protocol
  return protocol === 'http:' || protocol === 'https:'
}

/** Normalize one configured base so exactly one slash precedes `/responses`. */
function normalizeBaseUrl(baseURL: string): string {
  return baseURL.replace(/\/+$/u, '')
}

/** True when the base URL can be persisted without credential-bearing components. */
function safeBaseUrl(baseURL: string): boolean {
  try {
    validateOpenAiResponsesBaseUrl(baseURL)
    return true
  } catch {
    return false
  }
}

/** Extract a safe provider message from an HTTP error response. */
async function httpErrorMessage(response: Response, signal?: AbortSignal): Promise<string> {
  let message = `OpenAI Responses API error (HTTP ${String(response.status)})`
  try {
    const payload: unknown = await response.json()
    if (isRecord(payload)) {
      if (typeof payload.error === 'string' && payload.error.length > 0) message = payload.error
      else if (isRecord(payload.error) && typeof payload.error.message === 'string' && payload.error.message.length > 0) {
        message = payload.error.message
      } else if (typeof payload.message === 'string' && payload.message.length > 0) {
        message = payload.message
      }
    }
  } catch (error: unknown) {
    if (signal?.aborted === true || isAbortError(error)) throw aborted(signal, error)
    // The HTTP status remains authoritative when a gateway returns a non-JSON
    // or otherwise unreadable error body; only richer provider detail is lost.
  }
  return message
}

/** Race an asynchronous credential lookup against caller cancellation. */
function abortable<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation
  if (signal.aborted) return Promise.reject(aborted(signal))
  let onAbort: () => void = () => {}
  const cancellation = new Promise<never>((_resolve, reject) => {
    onAbort = () => { reject(aborted(signal)) }
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return Promise.race([operation, cancellation])
    .finally(() => { signal.removeEventListener('abort', onAbort) })
}

/** Throw the stable cancellation error before work starts or dispatches. */
function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted === true) throw aborted(signal)
}

/** Build the provider's stable cancellation error while retaining the caller reason. */
function aborted(signal?: AbortSignal, fallback?: unknown): WebError {
  return new WebError('OpenAI Responses search aborted', 'WEB_ABORTED', {
    cause: signal?.aborted === true ? signal.reason : fallback,
  })
}

/** True for a platform abort rejection. */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError'
}

/** Build a stable invalid-response error. */
function providerResponseError(message: string, cause?: unknown): WebError {
  return cause === undefined
    ? new WebError(message, 'WEB_PROVIDER_ERROR')
    : new WebError(message, 'WEB_PROVIDER_ERROR', { cause })
}

/** True for a token bound accepted by the Responses API. */
function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value > 0
}

/** Exhaustiveness guard for the validated output union. */
function assertNever(value: never): never {
  throw new Error(`unexpected Responses output: ${String(value)}`)
}
