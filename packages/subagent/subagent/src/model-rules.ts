/** Deterministic creation-time rules keyed by the exact direct-parent LLM route. */

import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { mergeChildAgentOptions } from './child-agent.ts'

/** User-authored exact parent-to-child route mapping for implicit native delegation. */
export interface SubagentModelRule {
  /** Exact direct-parent route that selects this rule when no child route or effort was requested. */
  readonly parent: {
    /** LLM provider name of the direct parent. */
    readonly provider: string
    /** Exact model id selected by the direct parent. */
    readonly model: string
  }
  /** Child route applied when the parent matches; availability is checked at delegation time. */
  readonly child: {
    /** LLM provider name for the child. */
    readonly provider: string
    /** Exact model id for the child. */
    readonly model: string
  }
}

const routeSchema = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

/** Settings schema; exact target availability is checked only when the rule matches. */
export const SubagentModelRuleSchema: z<SubagentModelRule> = z.object({
  parent: routeSchema.required(),
  child: routeSchema.required(),
})

/**
 * Reject ambiguous or malformed rules at the settings boundary.
 * @param rules - Optional unknown rule list; omission means none.
 */
export function assertSubagentModelRules(rules: unknown): void {
  if (rules === undefined) return
  if (!Array.isArray(rules)) throw new Error('subagent modelRules must be an array')
  const parents = new Map<string, Set<string>>()
  for (const candidate of rules as unknown[]) {
    const validated: unknown = z.resolve(candidate, SubagentModelRuleSchema, {})[0]
    const rule = validated as SubagentModelRule
    const models = parents.get(rule.parent.provider) ?? new Set<string>()
    if (models.has(rule.parent.model)) {
      throw new Error(`subagent modelRules repeats parent route "${rule.parent.provider}/${rule.parent.model}"`)
    }
    models.add(rule.parent.model)
    parents.set(rule.parent.provider, models)
  }
}

/**
 * Capture the exact matching rule over already-captured direct-parent options.
 * Any requested provider, model, or effort suppresses rule selection.
 * @param rules - Validated user-authored rules.
 * @param parentOptions - Actual parent route captured before asynchronous work.
 * @param requested - Configured or explicit child options.
 * @returns Complete detached child options, or undefined when no rule applies.
 */
export function captureSubagentModelRule(
  rules: readonly SubagentModelRule[] | undefined,
  parentOptions: AgentOptions,
  requested: AgentOptions | undefined,
): AgentOptions | undefined {
  if (rules === undefined || rules.length === 0 || requested?.provider !== undefined
    || requested?.model !== undefined || requested?.reasoningEffort !== undefined) return undefined
  const rule = rules.find(candidate => candidate.parent.provider === parentOptions.provider
    && candidate.parent.model === parentOptions.model)
  return rule === undefined ? undefined : mergeChildAgentOptions(parentOptions, {
    ...requested, provider: rule.child.provider, model: rule.child.model,
  })
}
