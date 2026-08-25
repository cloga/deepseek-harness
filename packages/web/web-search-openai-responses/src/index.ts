/**
 * Register an OpenAI Responses-compatible `WebSearchProvider` in `ctx.web`.
 * The function plugin contributes no model-facing tool.
 * @module @deepseek-ai/dsh-web-search-openai-responses
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import type {} from '@deepseek-ai/dsh-session'
import { installSettingsSection, settingsNamespace } from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-web'
import z from '@deepseek-ai/schemastery'
import {
  OpenAiResponsesSearchProvider,
  OPENAI_RESPONSES_DEFAULT_BASE_URL,
  OPENAI_RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS,
  OPENAI_RESPONSES_DEFAULT_MODEL,
  validateOpenAiResponsesBaseUrl,
} from './provider.ts'
import type { OpenAiResponsesSearchProviderOptions } from './provider.ts'

export {
  mapOpenAiResponsesPayload,
  OpenAiResponsesSearchProvider,
  OPENAI_RESPONSES_DEFAULT_BASE_URL,
  OPENAI_RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS,
  OPENAI_RESPONSES_DEFAULT_MODEL,
  OPENAI_RESPONSES_PROVIDER_ID,
  validateOpenAiResponsesBaseUrl,
} from './provider.ts'
export type {
  OpenAiResponsesSearchProviderOptions,
  OpenAiResponsesSearchRequest,
} from './provider.ts'

/** Cordis plugin name used by Loader diagnostics. */
export const name = 'web-search-openai-responses'

/** The web seam this provider registers into. */
export const inject = ['web']

const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY'

/** Plugin configuration; defaults are resolved by the schema and by direct programmatic use. */
export interface Config {
  /** Literal API key; prefer {@link apiKeyEnv} so no secret enters configuration files. */
  apiKey?: string
  /** Credential reference resolved for each search. */
  apiKeyEnv?: string
  /** Absolute HTTP(S) endpoint base without userinfo, query, or fragment; `/responses` is appended. */
  baseURL?: string
  /** Responses-compatible model name. */
  model?: string
  /** Positive generated-output token bound sent as `max_output_tokens`. */
  maxOutputTokens?: number
}

export const Config: z<Config> = z.object({
  apiKey: z.string().role('secret'),
  apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_API_KEY_ENV),
  baseURL: z.string().default(OPENAI_RESPONSES_DEFAULT_BASE_URL),
  model: z.string().default(OPENAI_RESPONSES_DEFAULT_MODEL),
  maxOutputTokens: z.number().step(1).min(1).default(OPENAI_RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS),
})

/** Settings namespace for the endpoint, model, output bound, and credential reference. */
export const WEB_SEARCH_OPENAI_RESPONSES_SETTINGS_NAMESPACE =
  settingsNamespace('web-search-openai-responses')

/** Resolve one immutable operation snapshot from the current settings section. */
function resolveOptions(ctx: Context, config: Config): OpenAiResponsesSearchProviderOptions {
  const apiKeyEnv = credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const literalApiKey = config.apiKey !== undefined && config.apiKey.length > 0
    ? config.apiKey
    : undefined
  return {
    ...literalApiKey === undefined ? {} : { apiKey: literalApiKey },
    resolveApiKey: () => resolveCredential(ctx, apiKeyEnv),
    apiKeyEnv,
    baseURL: config.baseURL ?? OPENAI_RESPONSES_DEFAULT_BASE_URL,
    model: config.model ?? OPENAI_RESPONSES_DEFAULT_MODEL,
    maxOutputTokens: config.maxOutputTokens ?? OPENAI_RESPONSES_DEFAULT_MAX_OUTPUT_TOKENS,
    recordRequest: (request) => {
      ctx.get('agents')?.currentInitiator()?.session.append(
        'web/openai-responses-search-request',
        request,
      )
    },
  }
}

/** Resolve one snapshotted reference from the active credential plane. */
async function resolveCredential(
  ctx: Context,
  apiKeyEnv: ReturnType<typeof credentialRef>,
): Promise<string | undefined> {
  const credentials = ctx.get('credentials')
  if (credentials !== undefined) return (await credentials.resolve(apiKeyEnv))?.value
  const ambient = launchEnvironmentOf(ctx).get(apiKeyEnv)
  return ambient !== undefined && ambient.value.length > 0 ? ambient.value : undefined
}

/** Reject resolved settings the provider cannot use. */
function validateConfig(config: Config): void {
  credentialRef(config.apiKeyEnv ?? DEFAULT_API_KEY_ENV)
  const baseURL = config.baseURL ?? OPENAI_RESPONSES_DEFAULT_BASE_URL
  validateOpenAiResponsesBaseUrl(baseURL)
  if ((config.model ?? OPENAI_RESPONSES_DEFAULT_MODEL).trim().length === 0) {
    throw new TypeError('model must not be blank')
  }
}

/**
 * Register the Responses search provider with `ctx.web`.
 * @param ctx - plugin context carrying the Web capability and optional settings, credentials, and Agent services.
 * @param config - composition-layer provider configuration.
 */
export function apply(ctx: Context, config: Config): void {
  validateConfig(config)
  let current: () => Config = () => config
  installSettingsSection(
    ctx,
    WEB_SEARCH_OPENAI_RESPONSES_SETTINGS_NAMESPACE,
    Config,
    config,
    {
      setSource: (source) => { current = source },
      onChange: () => {},
      validate: validateConfig,
    },
  )
  ctx.web.registerSearchProvider(new OpenAiResponsesSearchProvider(() => resolveOptions(ctx, current())))
}
