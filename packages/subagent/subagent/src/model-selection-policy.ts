/** Exact child LLM route authority shared by delegation consumers and creation. */

import z from '@deepseek-ai/schemastery'

/** One exact child LLM route authorized by a user setting. */
export interface AllowedModelRoute {
  readonly provider: string
  readonly model: string
}

/** Schema shared by the Host setting and its deployment base. */
export const AllowedModelRouteSchema: z<AllowedModelRoute> = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

/** Route-selection authority captured by one delegation definition. */
export interface ModelSelectionPolicy {
  readonly routes: readonly AllowedModelRoute[]
}

/**
 * Identify one exact provider/model pair.
 * @param route - Authorized route.
 * @returns Opaque equality key.
 */
export function modelRouteKey(route: AllowedModelRoute): string {
  return `${route.provider}\0${route.model}`
}

/**
 * Validate a route list at a settings or durable-data boundary.
 * @param routes - Unknown exact-route list.
 * @returns An assertion that every entry is valid and unique.
 */
export function assertAllowedModelRoutes(routes: unknown): asserts routes is readonly AllowedModelRoute[] {
  if (!Array.isArray(routes)) throw new Error('subagent model selection requires an array of routes')
  const seen = new Set<string>()
  const candidates: readonly unknown[] = routes
  for (const candidate of candidates) {
    if (typeof candidate !== 'object' || candidate === null || Array.isArray(candidate)
      || !('provider' in candidate) || typeof candidate.provider !== 'string'
      || !('model' in candidate) || typeof candidate.model !== 'string'
      || candidate.provider.length === 0 || candidate.model.length === 0) {
      throw new Error('subagent model selection requires non-empty provider and model ids')
    }
    const route = { provider: candidate.provider, model: candidate.model }
    const key = modelRouteKey(route)
    if (seen.has(key)) throw new Error(`subagent model selection repeats route "${route.provider}/${route.model}"`)
    seen.add(key)
  }
}
