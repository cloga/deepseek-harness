import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { LlmRuntime } from '@deepseek-ai/dsh-llm'
import { FileSettingsProvider } from '@deepseek-ai/dsh-settings-file'
import { LocalCredentialProvider } from '@deepseek-ai/dsh-credentials-local'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import * as connection from '@deepseek-ai/dsh-client-connection'
import { expect, it, vi } from 'vitest'
import * as fixture from './fixtures/neutral-provider/index.ts'

it('registers a neutral provider and settings namespace and commits only its own authorization grant', async () => {
  const scratch = resolve('.desktop-smoke')
  mkdirSync(scratch, { recursive: true })
  const home = mkdtempSync(join(scratch, 'provider-'))
  const ctx = new Context()
  vi.stubEnv('DSH_HOME', home)
  try {
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(FileSettingsProvider, { path: join(home, 'settings.yaml'), watch: false })
    await ctx.plugin(LocalCredentialProvider, { path: join(home, '.credentials.yaml'), watch: false })
    await ctx.plugin(connection)
    ctx.connection.rpc.intercept('/api', endpoint => endpoint === 'fixture/gateway', async () => ({
      ok: true, value: 'gateway-preserved',
    }))
    await ctx.plugin(fixture, { receipt: 'this-offline-attempt' })
    expect(ctx.llm.listProviders()).toContainEqual({ id: 'desktop-neutral', name: 'Desktop neutral provider' })
    expect(ctx.llm.listConfigurableProviders()).toContainEqual({
      provider: 'desktop-neutral', displayName: 'Desktop neutral provider',
      settingsNs: 'desktop-neutral-provider', settingsPath: [],
    })
    expect(ctx.settings.describe().map(view => view.ns)).toContain('desktop-neutral-provider')
    const api = ctx.connection.createSharedFetchHandler('/api')
    const invoke = async (method: string): Promise<unknown> => {
      const response = await api.fetch(new Request(`http://127.0.0.1/api/desktop-neutral/${method}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: 'fixture', method: `desktop-neutral/${method}`, payload: {} }),
      }))
      return response.json()
    }
    expect(await invoke('status')).toMatchObject({ ok: true, value: { status: 'unauthorized', attempts: 0 } })
    expect(await invoke('authorize')).toMatchObject({
      ok: true, value: { status: 'authorized', attempts: 1, receipt: 'this-offline-attempt', sharedCordis: true },
    })
    expect(await ctx.credentials.readRecord(credentialKey('desktop-runtime-smoke-plugin', 'desktop-neutral')))
      .toEqual({ kind: 'grant', payload: { fixture: true, receipt: 'this-offline-attempt' } })
    const gateway = await api.fetch(new Request('http://127.0.0.1/api/fixture/gateway', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'client-request', rpcId: 'gateway', method: 'fixture/gateway', payload: {} }),
    }))
    expect(await gateway.json()).toMatchObject({ result: { ok: true, value: 'gateway-preserved' } })
    expect(JSON.parse(readFileSync(join(home, 'neutral-auth-result.json'), 'utf8'))).toMatchObject({
      attempts: 1, receipt: 'this-offline-attempt', sharedCordis: true,
    })
  } finally {
    try { await ctx.fiber.dispose() } finally {
      vi.unstubAllEnvs()
      rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    }
  }
})
