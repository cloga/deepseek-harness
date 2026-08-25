import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  mapOpenAiResponsesPayload,
  OpenAiResponsesSearchProvider,
  OPENAI_RESPONSES_PROVIDER_ID,
} from '@deepseek-ai/dsh-web-search-openai-responses'
import type {
  OpenAiResponsesSearchProviderOptions,
  OpenAiResponsesSearchRequest,
} from '@deepseek-ai/dsh-web-search-openai-responses'
import * as responsesPlugin from '@deepseek-ai/dsh-web-search-openai-responses'

const BASE_OPTIONS = {
  baseURL: 'https://responses.test/v1/',
  model: 'search-model',
  maxOutputTokens: 777,
} satisfies OpenAiResponsesSearchProviderOptions

const OPTIONS: OpenAiResponsesSearchProviderOptions = {
  ...BASE_OPTIONS,
  apiKey: 'responses-key',
}

function provider(options: OpenAiResponsesSearchProviderOptions): OpenAiResponsesSearchProvider {
  return new OpenAiResponsesSearchProvider(() => options)
}

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function successPayload(): Record<string, unknown> {
  return {
    id: 'resp_1',
    output: [
      {
        type: 'web_search_call',
        action: {
          type: 'search',
          query: 'q',
          sources: [
            { type: 'url', url: 'https://a.test/article' },
            { type: 'url', url: 'https://b.test/page', title: 'B first' },
          ],
        },
      },
      {
        type: 'message',
        role: 'assistant',
        content: [{
          type: 'output_text',
          text: 'Provider final answer.',
          annotations: [
            {
              type: 'url_citation',
              url: 'https://a.test/article',
              title: 'A enriched',
              snippet: 'A structured excerpt',
            },
            { type: 'url_citation', url: 'https://c.test/new', title: 'C' },
            {
              type: 'url_citation',
              url: 'https://b.test/page',
              title: 'B later',
              snippet: 'B excerpt',
            },
          ],
        }],
      },
    ],
  }
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('mapOpenAiResponsesPayload', () => {
  it('uses final output text and ordered structured sources with later enrichment', () => {
    expect(mapOpenAiResponsesPayload(successPayload())).toEqual({
      content: 'Provider final answer.',
      sources: [
        {
          url: 'https://a.test/article',
          title: 'A enriched',
          snippet: 'A structured excerpt',
        },
        { url: 'https://b.test/page', title: 'B first', snippet: 'B excerpt' },
        { url: 'https://c.test/new', title: 'C' },
      ],
      truncated: false,
    })
  })

  it('preserves citation-first order and enriches it from a later search action', () => {
    const result = mapOpenAiResponsesPayload({
      output: [
        {
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'answer',
            annotations: [{ type: 'url_citation', url: 'https://first.test' }],
          }],
        },
        {
          type: 'web_search_call',
          action: {
            sources: [
              { url: 'https://first.test', title: 'First title', snippet: 'First snippet' },
              { url: 'https://second.test' },
            ],
          },
        },
      ],
    })
    expect(result.sources).toEqual([
      { url: 'https://first.test', title: 'First title', snippet: 'First snippet' },
      { url: 'https://second.test' },
    ])
  })

  it('concatenates output_text blocks and ignores non-citation annotations and unrelated outputs', () => {
    const result = mapOpenAiResponsesPayload({
      output: [
        { type: 'reasoning', summary: [] },
        {
          type: 'message',
          content: [
            {
              type: 'output_text',
              text: 'part one',
              annotations: [{ type: 'file_citation', filename: 'ignored' }],
            },
            {
              type: 'output_text',
              text: ' and two',
              annotations: [{ type: 'url_citation', url: 'https://source.test' }],
            },
          ],
        },
      ],
    })
    expect(result).toEqual({
      content: 'part one and two',
      sources: [{ url: 'https://source.test' }],
      truncated: false,
    })
  })

  it.each([
    { label: 'non-object root', value: [] },
    { label: 'missing output', value: {} },
    { label: 'non-array output', value: { output: {} } },
    { label: 'non-object output item', value: { output: [null] } },
    { label: 'missing output type', value: { output: [{}] } },
    {
      label: 'malformed search action',
      value: { output: [{ type: 'web_search_call', action: 'search' }] },
    },
    {
      label: 'malformed source array',
      value: { output: [{ type: 'web_search_call', action: { sources: {} } }] },
    },
    {
      label: 'malformed source URL',
      value: {
        output: [
          { type: 'web_search_call', action: { sources: [{ url: '/relative' }] } },
          {
            type: 'message',
            content: [{ type: 'output_text', text: 'answer', annotations: [] }],
          },
        ],
      },
    },
    {
      label: 'malformed message content',
      value: { output: [{ type: 'message', content: {} }] },
    },
    {
      label: 'malformed output text',
      value: {
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 42, annotations: [] }],
        }],
      },
    },
    {
      label: 'malformed annotations',
      value: {
        output: [{
          type: 'message',
          content: [{ type: 'output_text', text: 'answer', annotations: {} }],
        }],
      },
    },
  ])('rejects $label at the external JSON boundary', ({ value }) => {
    expect(() => mapOpenAiResponsesPayload(value))
      .toThrow(expect.objectContaining({ code: 'WEB_PROVIDER_ERROR' }))
  })

  it('rejects a response without usable final text', () => {
    expect(() => mapOpenAiResponsesPayload({
      output: [
        { type: 'web_search_call', action: { sources: [{ url: 'https://source.test' }] } },
        {
          type: 'message',
          content: [{ type: 'output_text', text: '   ', annotations: [] }],
        },
      ],
    })).toThrow(expect.objectContaining({
      code: 'WEB_PROVIDER_ERROR',
      message: 'OpenAI Responses search returned no usable final output text',
    }))
  })

  it('rejects prose without a structured source', () => {
    expect(() => mapOpenAiResponsesPayload({
      output: [{
        type: 'message',
        content: [{ type: 'output_text', text: 'https://not-scraped.test', annotations: [] }],
      }],
    })).toThrow(expect.objectContaining({
      code: 'WEB_PROVIDER_ERROR',
      message: 'OpenAI Responses search returned no structured web search sources',
    }))
  })

  it.each(['incomplete', 'failed', 'cancelled', 'in_progress'])(
    'rejects a non-completed Responses status: %s',
    (status) => {
      expect(() => mapOpenAiResponsesPayload({
        status,
        incomplete_details: { reason: 'max_output_tokens' },
        ...successPayload(),
      })).toThrow('$.status must be "completed" when present')
    },
  )

  it('rejects a null Responses status', () => {
    expect(() => mapOpenAiResponsesPayload({
      status: null,
      ...successPayload(),
    })).toThrow('$.status must be a string')
  })

  it('accepts an explicit completed status', () => {
    expect(mapOpenAiResponsesPayload({
      status: 'completed',
      ...successPayload(),
    }).content).toBe('Provider final answer.')
  })
})

describe('OpenAiResponsesSearchProvider request', () => {
  it.each([
    'https://user:password@responses.test/v1',
    'https://responses.test/v1?api_key=secret',
    'https://responses.test/v1?',
    'https://responses.test/v1#secret',
    'https://responses.test/v1#',
  ])('rejects an unsafe direct-provider base URL before credentials, logging, or dispatch: %s', async (baseURL) => {
    const resolveApiKey = vi.fn(async () => 'resolved-secret')
    const recordRequest = vi.fn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const direct = provider({
      ...BASE_OPTIONS,
      baseURL,
      resolveApiKey,
      recordRequest,
    })
    expect(direct.available()).toBe(false)
    await expect(direct.search({ query: 'private query' }))
      .rejects.toThrow('baseURL must not contain credentials, query parameters, or a fragment')
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(recordRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('records and posts the same normalized non-streaming Responses request without secrets', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(successPayload()))
    const recordRequest = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await provider({ ...OPTIONS, recordRequest }).search({ query: 'private query', maxResults: 1 })

    expect(fetchMock).toHaveBeenCalledOnce()
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://responses.test/v1/responses')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' })
    expect(init.signal).toBeUndefined()
    expect(init.headers).toMatchObject({
      'content-type': 'application/json',
      'accept': 'application/json',
      'user-agent': 'deepseek-harness/0.0.1',
    })
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer responses-key')
    const body: OpenAiResponsesSearchRequest['body'] = {
      model: 'search-model',
      input: 'private query',
      tools: [{ type: 'web_search' }],
      include: ['web_search_call.action.sources'],
      max_output_tokens: 777,
      stream: false,
    }
    expect(JSON.parse(init.body as string)).toEqual(body)
    expect(recordRequest).toHaveBeenCalledWith({ endpoint: url, body })
    expect(JSON.stringify(recordRequest.mock.calls)).not.toContain('responses-key')
    expect(recordRequest.mock.invocationCallOrder[0])
      .toBeLessThan(fetchMock.mock.invocationCallOrder[0] ?? 0)
  })

  it('forwards the exact abort signal to fetch', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(successPayload()))
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    await provider(OPTIONS).search({ query: 'q' }, controller.signal)
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(init.signal).toBe(controller.signal)
  })

  it('snapshots endpoint, model, output bound, resolver, and logger before credential await', async () => {
    const beforeLogger = vi.fn()
    const afterLogger = vi.fn()
    let release: ((value: string) => void) | undefined
    const before = {
      ...BASE_OPTIONS,
      baseURL: 'https://before.test/v1',
      model: 'before-model',
      maxOutputTokens: 101,
      resolveApiKey: () => new Promise<string>((resolve) => { release = resolve }),
      recordRequest: beforeLogger,
    }
    const after = {
      ...BASE_OPTIONS,
      baseURL: 'https://after.test/v1',
      model: 'after-model',
      maxOutputTokens: 909,
      resolveApiKey: async () => 'after-key',
      recordRequest: afterLogger,
    }
    let current: OpenAiResponsesSearchProviderOptions = before
    const fetchMock = vi.fn(async () => jsonResponse(successPayload()))
    vi.stubGlobal('fetch', fetchMock)

    const search = new OpenAiResponsesSearchProvider(() => current).search({ query: 'q' })
    await vi.waitFor(() => { expect(release).toBeTypeOf('function') })
    current = after
    release?.('before-key')
    await search

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://before.test/v1/responses')
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer before-key')
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'before-model',
      max_output_tokens: 101,
    })
    expect(beforeLogger).toHaveBeenCalledOnce()
    expect(afterLogger).not.toHaveBeenCalled()
  })
})

describe('OpenAiResponsesSearchProvider errors and cancellation', () => {
  it('does not resolve credentials, log, or fetch when pre-aborted', async () => {
    const resolveApiKey = vi.fn(async () => 'unused')
    const recordRequest = vi.fn()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    controller.abort(new Error('stopped'))
    await expect(provider({
      ...BASE_OPTIONS,
      resolveApiKey,
      recordRequest,
    }).search({ query: 'q' }, controller.signal))
      .rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(resolveApiKey).not.toHaveBeenCalled()
    expect(recordRequest).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('cancels an uncooperative credential resolver without dispatch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const controller = new AbortController()
    const search = provider({
      ...BASE_OPTIONS,
      resolveApiKey: () => new Promise<string>(() => {}),
    }).search({ query: 'q' }, controller.signal)
    controller.abort(new Error('deadline'))
    await expect(search).rejects.toMatchObject({ code: 'WEB_ABORTED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('maps credential resolution rejection to WEB_PROVIDER_ERROR', async () => {
    await expect(provider({
      ...BASE_OPTIONS,
      resolveApiKey: () => Promise.reject(new Error('credential backend failed')),
    }).search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'OpenAI Responses search credential resolution failed: Error: credential backend failed',
    })
  })

  it('reports the configured credential reference when no key resolves', async () => {
    await expect(provider({
      ...BASE_OPTIONS,
    }).search({ query: 'q' })).rejects.toThrow('OpenAI Responses search has no API key for "OPENAI_API_KEY"')
  })

  it('maps provider, status-only, network, malformed JSON, and abort failures', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(
      { error: { message: 'rate limited' } },
      { status: 429 },
    )))
    await expect(provider(OPTIONS).search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'rate limited',
    })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway', { status: 503 })))
    await expect(provider(OPTIONS).search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
      message: 'OpenAI Responses API error (HTTP 503)',
    })

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new TypeError('offline'))))
    await expect(provider(OPTIONS).search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
    })

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not JSON', { status: 200 })))
    await expect(provider(OPTIONS).search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_ERROR',
    })

    vi.stubGlobal('fetch', vi.fn(() => Promise.reject(new DOMException('aborted', 'AbortError'))))
    await expect(provider(OPTIONS).search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_ABORTED',
    })
  })
})

describe('web-search-openai-responses plugin', () => {
  it('registers only a search provider and disposes it with the plugin fiber', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(successPayload())))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: OPENAI_RESPONSES_PROVIDER_ID })
    const fiber = await ctx.plugin(responsesPlugin, { apiKey: 'key' })
    await expect(ctx.web.search({ query: 'q' })).resolves.toMatchObject({
      content: 'Provider final answer.',
    })
    await fiber.dispose()
    await expect(ctx.web.search({ query: 'q' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_MISSING',
    })
    await ctx.fiber.dispose()
  })

  it('has the function-plugin namespace and no default export', () => {
    expect(responsesPlugin.name).toBe('web-search-openai-responses')
    expect(responsesPlugin.inject).toEqual(['web'])
    expect(typeof responsesPlugin.apply).toBe('function')
    expect('default' in responsesPlugin).toBe(false)
  })

  it('records the exact request in the initiating session and excludes credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(successPayload())))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: OPENAI_RESPONSES_PROVIDER_ID })
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(responsesPlugin, {
      apiKey: 'session-secret',
      baseURL: 'https://session.test/v1/',
      model: 'session-model',
      maxOutputTokens: 123,
    })
    const owner = testAgent(ctx)
    await ctx.agents.withInitiator(owner, () => ctx.web.search({ query: 'logged query' }))

    const event = owner.session.events.find(
      candidate => candidate.type === 'web/openai-responses-search-request',
    )
    expect(event?.data).toEqual({
      endpoint: 'https://session.test/v1/responses',
      body: {
        model: 'session-model',
        input: 'logged query',
        tools: [{ type: 'web_search' }],
        include: ['web_search_call.action.sources'],
        max_output_tokens: 123,
        stream: false,
      },
    })
    expect(JSON.stringify(event)).not.toContain('session-secret')
    await ctx.fiber.dispose()
  })

  it('uses the default base, model, and output bound with an ambient key', async () => {
    vi.stubEnv('OPENAI_API_KEY', 'ambient-key')
    const fetchMock = vi.fn(async () => jsonResponse(successPayload()))
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: OPENAI_RESPONSES_PROVIDER_ID })
    await ctx.plugin(responsesPlugin, {})
    await ctx.web.search({ query: 'q' })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.openai.com/v1/responses')
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer ambient-key')
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'gpt-5-mini',
      max_output_tokens: 2048,
    })
    await ctx.fiber.dispose()
  })
})

/** Construct a registered initiating Agent with a real in-memory Session. */
function testAgent(ctx: Context): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('responses-provider-agent')
  const session = Session.create(id)
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, {
      inserted: () => {},
      discarded: () => {},
      claimed: () => {},
    }),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel: () => {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}
