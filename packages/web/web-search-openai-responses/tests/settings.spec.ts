import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'
import type {
  CredentialInfo,
  CredentialKey,
  CredentialRecord,
  CredentialRecordEntry,
  CredentialRecordInfo,
  CredentialRef,
  ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { SettingsProvider } from '@deepseek-ai/dsh-settings'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import WebRuntime from '@deepseek-ai/dsh-web'
import {
  OPENAI_RESPONSES_PROVIDER_ID,
  WEB_SEARCH_OPENAI_RESPONSES_SETTINGS_NAMESPACE,
} from '@deepseek-ai/dsh-web-search-openai-responses'
import * as responsesPlugin from '@deepseek-ai/dsh-web-search-openai-responses'

class MemorySettings extends SettingsProvider {
  doc: Record<string, unknown> = {}

  get writable(): boolean {
    return true
  }

  protected load(): Promise<Record<string, unknown>> {
    return Promise.resolve(structuredClone(this.doc))
  }

  protected persist(ns: SettingsNamespace, section: Record<string, unknown>): Promise<void> {
    this.doc = { ...this.doc, [ns]: structuredClone(section) }
    return Promise.resolve()
  }
}

class MemoryCredentials extends CredentialProvider {
  readonly values = new Map<CredentialRef, string>()

  resolve(ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    const value = this.values.get(ref)
    return Promise.resolve(value === undefined ? undefined : { value, source: 'memory' })
  }

  describe(ref: CredentialRef): Promise<CredentialInfo> {
    const configured = this.values.has(ref)
    return Promise.resolve({ configured, ...configured ? { source: 'memory' } : {}, writable: true })
  }

  set(ref: CredentialRef, value: string): Promise<void> {
    this.values.set(ref, value)
    this.ctx.emit('credentials/reference-updated', ref)
    return Promise.resolve()
  }

  unset(ref: CredentialRef): Promise<void> {
    this.values.delete(ref)
    this.ctx.emit('credentials/reference-updated', ref)
    return Promise.resolve()
  }

  readRecord(): Promise<CredentialRecord | undefined> {
    return Promise.resolve(undefined)
  }

  describeRecord(): Promise<CredentialRecordInfo> {
    return Promise.resolve({ configured: false, writable: true })
  }

  listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return Promise.resolve([])
  }

  modifyRecord(
    _key: CredentialKey,
    mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return mutate(undefined)
  }

  deleteRecord(): Promise<void> {
    return Promise.resolve()
  }
}

function response(): Response {
  return new Response(JSON.stringify({
    output: [
      { type: 'web_search_call', action: { sources: [{ url: 'https://source.test' }] } },
      {
        type: 'message',
        content: [{ type: 'output_text', text: 'answer', annotations: [] }],
      },
    ],
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('web-search-openai-responses settings and credentials', () => {
  it.each([
    'https://user:password@responses.test/v1',
    'https://responses.test/v1?api_key=secret',
    'https://responses.test/v1?',
    'https://responses.test/v1#secret',
    'https://responses.test/v1#',
  ])('rejects a base URL that could persist embedded secret material: %s', async (baseURL) => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: OPENAI_RESPONSES_PROVIDER_ID })
    await expect(ctx.plugin(responsesPlugin, {
      apiKey: 'separate-secret',
      baseURL,
    })).rejects.toThrow('baseURL must not contain credentials, query parameters, or a fragment')
    expect(fetchMock).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('applies settings to the next operation, restores entry config on detach, and releases its namespace', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response())
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: OPENAI_RESPONSES_PROVIDER_ID })
    const settingsFiber = ctx.plugin(MemorySettings)
    await settingsFiber.await()
    const pluginFiber = ctx.plugin(responsesPlugin, {
      apiKey: 'entry-key',
      baseURL: 'https://entry.test/v1',
      model: 'entry-model',
    })
    await pluginFiber.await()

    await ctx.settings.update(WEB_SEARCH_OPENAI_RESPONSES_SETTINGS_NAMESPACE, {
      baseURL: 'https://stored.test/api/',
      model: 'stored-model',
      maxOutputTokens: 321,
    })
    await ctx.web.search({ query: 'stored' })
    let [url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(url).toBe('https://stored.test/api/responses')
    expect(JSON.parse(init.body as string)).toMatchObject({
      model: 'stored-model',
      max_output_tokens: 321,
    })

    await settingsFiber.dispose()
    await ctx.web.search({ query: 'entry' })
    ;[url, init] = fetchMock.mock.calls.at(-1) as unknown as [string, RequestInit]
    expect(url).toBe('https://entry.test/v1/responses')
    expect(JSON.parse(init.body as string)).toMatchObject({ model: 'entry-model' })

    await pluginFiber.dispose()
    expect(ctx.get('settings')).toBeUndefined()
    await ctx.fiber.dispose()
  })

  it('redacts literal keys from every described settings layer', async () => {
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: OPENAI_RESPONSES_PROVIDER_ID })
    await ctx.plugin(MemorySettings)
    const pluginFiber = ctx.plugin(responsesPlugin, {
      apiKey: 'entry-secret',
      baseURL: 'https://entry.test/v1',
    })
    await pluginFiber.await()
    await ctx.settings.update(WEB_SEARCH_OPENAI_RESPONSES_SETTINGS_NAMESPACE, {
      apiKey: 'stored-secret',
    })
    const descriptor = ctx.settings.describe({ redactSecrets: true })
      .find(row => row.ns === WEB_SEARCH_OPENAI_RESPONSES_SETTINGS_NAMESPACE)
    expect(descriptor?.secrets).toEqual([{ path: ['apiKey'], set: true }])
    expect(JSON.stringify(descriptor)).not.toContain('entry-secret')
    expect(JSON.stringify(descriptor)).not.toContain('stored-secret')
    await pluginFiber.dispose()
    expect(ctx.settings.describe().map(row => row.ns))
      .not.toContain(WEB_SEARCH_OPENAI_RESPONSES_SETTINGS_NAMESPACE)
    await ctx.fiber.dispose()
  })

  it('resolves the credential reference for every operation and observes rotation', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response())
    vi.stubGlobal('fetch', fetchMock)
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: OPENAI_RESPONSES_PROVIDER_ID })
    await ctx.plugin(MemoryCredentials)
    await ctx.plugin(responsesPlugin, {
      apiKeyEnv: 'COPILOT2API_KEY',
      baseURL: 'https://copilot2api.test/v1',
    })
    const ref = credentialRef('COPILOT2API_KEY')

    await expect(ctx.web.search({ query: 'missing' })).rejects.toMatchObject({
      code: 'WEB_PROVIDER_CREDENTIAL_MISSING',
    })
    await ctx.credentials.set(ref, 'first-key')
    await ctx.web.search({ query: 'first' })
    await ctx.credentials.set(ref, 'rotated-key')
    await ctx.web.search({ query: 'second' })

    const authorizations = fetchMock.mock.calls.map(([, init]) =>
      ((init as RequestInit).headers as Record<string, string>)['authorization'])
    expect(authorizations).toEqual(['Bearer first-key', 'Bearer rotated-key'])
    await ctx.fiber.dispose()
  })

  it('rejects invalid stored endpoint and blank model without changing the active section', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response()))
    const ctx = new Context()
    await ctx.plugin(WebRuntime, { searchProvider: OPENAI_RESPONSES_PROVIDER_ID })
    await ctx.plugin(MemorySettings)
    await ctx.plugin(responsesPlugin, {
      apiKey: 'key',
      baseURL: 'https://valid.test/v1',
      model: 'valid-model',
    })
    await expect(ctx.settings.update(WEB_SEARCH_OPENAI_RESPONSES_SETTINGS_NAMESPACE, {
      baseURL: 'relative/path',
    })).rejects.toThrow('baseURL must be an absolute HTTP(S) URL')
    for (const baseURL of [
      'https://user:password@valid.test/v1',
      'https://valid.test/v1?api_key=secret',
      'https://valid.test/v1?',
      'https://valid.test/v1#secret',
      'https://valid.test/v1#',
    ]) {
      await expect(ctx.settings.update(WEB_SEARCH_OPENAI_RESPONSES_SETTINGS_NAMESPACE, {
        baseURL,
      })).rejects.toThrow('baseURL must not contain credentials, query parameters, or a fragment')
    }
    await expect(ctx.settings.update(WEB_SEARCH_OPENAI_RESPONSES_SETTINGS_NAMESPACE, {
      model: '   ',
    })).rejects.toThrow('model must not be blank')
    await expect(ctx.settings.update(WEB_SEARCH_OPENAI_RESPONSES_SETTINGS_NAMESPACE, {
      apiKeyEnv: 'not a credential ref',
    })).rejects.toThrow('must match')
    await ctx.web.search({ query: 'q' })
    await ctx.fiber.dispose()
  })
})
