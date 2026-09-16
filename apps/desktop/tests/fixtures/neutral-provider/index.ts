/** Offline provider and authorization fixture, loaded by the packaged Desktop Host. */
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import { credentialKey } from '@deepseek-ai/dsh-credentials'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-client-connection'

export const name = 'desktop-runtime-smoke-plugin'
export const inject = ['llm', 'settings', 'credentials', 'connection']
export interface Config {
  receipt: string
}
export const Config = z.object({ receipt: z.string().required() })

const provider = 'desktop-neutral'
const namespace = 'desktop-neutral-provider'
const key = credentialKey('desktop-runtime-smoke-plugin', provider)

class NeutralAdapter extends LlmAdapter {
  override providerInfo() {
    return { id: provider, name: 'Desktop neutral provider' }
  }

  async *stream(): AsyncIterable<StreamChunk> {
    throw new Error('desktop smoke: model requests are forbidden')
  }
}

/** Register real provider/settings contributions and an offline credential-writing action. */
export function apply(ctx: Context, config: Config): void {
  if (!(ctx instanceof Context)) throw new Error('desktop runtime: external plugin loaded another Cordis instance')
  if (process.env.DSH_HOME === undefined) throw new Error('desktop smoke: fixture home is required')
  const evidence = join(process.env.DSH_HOME, 'neutral-auth-result.json')
  let attempts = 0
  writeFileSync(evidence, JSON.stringify({ sharedCordis: true, attempts, status: 'unauthorized' }))
  ctx.llm.registerAdapter([provider], new NeutralAdapter())
  ctx.llm.registerConfigurableProviders([
    { provider, displayName: 'Desktop neutral provider', settingsNs: namespace, settingsPath: [] },
  ])
  ctx.settings.register(namespace, z.object({}), { base: {} })
  for (const action of ['status', 'authorize']) ctx.effect(() => ctx.connection.fetch.register({
    path: `/api/desktop-neutral/${action}`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch() {
      if (action === 'authorize') {
        attempts++
        await ctx.credentials.modifyRecord(key, async () => ({
          kind: 'grant',
          payload: { fixture: true, receipt: config.receipt },
        }))
      }
      const record = await ctx.credentials.readRecord(key)
      const status = record?.kind === 'grant'
        && typeof record.payload === 'object' && record.payload !== null
        && 'receipt' in record.payload && record.payload.receipt === config.receipt
        ? 'authorized'
        : 'unauthorized'
      const result = { provider, status, receipt: status === 'authorized' ? config.receipt : null, attempts, sharedCordis: true }
      writeFileSync(evidence, JSON.stringify(result))
      return Response.json({ ok: true, value: result })
    },
  }))
}
