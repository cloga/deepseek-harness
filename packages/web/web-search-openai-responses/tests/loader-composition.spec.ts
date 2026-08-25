/**
 * Product composition coverage through the actual Loader entry path. It
 * exercises namespace export unwrapping, config validation, request routing,
 * and Loader-owned disposal rather than mounting the namespace by hand.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import WebRuntime from '@deepseek-ai/dsh-web'
import * as ResponsesProvider from '@deepseek-ai/dsh-web-search-openai-responses'

let context: Context | undefined
let root: string | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllGlobals()
})

describe('web-search-openai-responses real Loader composition', () => {
  it('boots cordis.yml, routes a search, and unregisters on entry disposal', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      output: [
        {
          type: 'web_search_call',
          action: { sources: [{ url: 'https://loader-source.test', title: 'Loader source' }] },
        },
        {
          type: 'message',
          content: [{
            type: 'output_text',
            text: 'Loader answer',
            annotations: [],
          }],
        },
      ],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchMock)

    root = await mkdtemp(join(tmpdir(), 'dsh-responses-search-loader-'))
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      '- id: web',
      "  name: '@deepseek-ai/dsh-web'",
      '  config:',
      '    searchProvider: openai-responses',
      '- id: responses-provider',
      "  name: '@deepseek-ai/dsh-web-search-openai-responses'",
      '  config:',
      '    apiKey: loader-key',
      '    baseURL: https://loader.test/v1/',
      '    model: loader-model',
      '    maxOutputTokens: 88',
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = pathToFileURL(root).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-web', WebRuntime],
      ['@deepseek-ai/dsh-web-search-openai-responses', ResponsesProvider],
    ])
    const imports: string[] = []
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        imports.push(specifier)
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(configPath).href },
    })
    await ctx.loader.await()
    const unloaded = [...ctx.loader.entries()]
      .filter(entry => entry.fiber === undefined && !entry.disabled)
      .map(entry => entry.options.name)
    expect(unloaded).toEqual([])
    expect(imports).toEqual([
      '@deepseek-ai/dsh-web',
      '@deepseek-ai/dsh-web-search-openai-responses',
    ])
    await expect(ctx.web.search({ query: 'loader query' })).resolves.toEqual({
      content: 'Loader answer',
      sources: [{ url: 'https://loader-source.test', title: 'Loader source' }],
      truncated: false,
    })
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(JSON.parse(init.body as string)).toMatchInlineSnapshot(`
      {
        "include": [
          "web_search_call.action.sources",
        ],
        "input": "loader query",
        "max_output_tokens": 88,
        "model": "loader-model",
        "stream": false,
        "tools": [
          {
            "type": "web_search",
          },
        ],
      }
    `)

    const providerEntry = [...ctx.loader.entries()].find(
      entry => entry.options.name === '@deepseek-ai/dsh-web-search-openai-responses',
    )
    if (providerEntry?.fiber === undefined) throw new Error('Responses provider entry was not loaded')
    await providerEntry.fiber.dispose()
    await expect(ctx.web.search({ query: 'after disposal' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CONFIGURED_MISSING',
    })
  })
})
