/** Creation-time child model selection from exact direct-parent routes. */

import { symbols, type Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import z from '@deepseek-ai/schemastery'
import { mergeChildAgentOptions, parentAgentOptionsForDelegation } from './child-agent.ts'

/** One exact parent route and the child route used for new implicit delegations. */
export interface SubagentModelRule {
  /** Effective direct-parent provider and model ids. */
  readonly parent: {
    /** Registered provider id used by the direct parent. */
    readonly provider: string
    /** Exact provider-owned model id used by the direct parent. */
    readonly model: string
  }
  /** Exact child provider and model ids validated at creation. */
  readonly child: {
    /** Registered provider id selected for the new child. */
    readonly provider: string
    /** Exact provider-owned model id selected for the new child. */
    readonly model: string
  }
}

const routeSchema = z.object({
  provider: z.string().min(1).required(),
  model: z.string().min(1).required(),
})

/** Host settings schema; live model availability is checked only when a rule matches. */
export const SubagentModelRuleSchema: z<SubagentModelRule> = z.object({
  parent: routeSchema.required(),
  child: routeSchema.required(),
})

/**
 * Reject ambiguous or malformed model rules at the configuration boundary.
 * @param rules - Optional settings value; omission means no rules.
 */
export function assertSubagentModelRules(rules: unknown): void {
  if (rules === undefined) return
  if (!Array.isArray(rules)) throw new Error('subagent modelRules must be an array')
  const parents = new Map<string, Set<string>>()
  for (const candidate of rules as unknown[]) {
    const validated: unknown = z.resolve(candidate, SubagentModelRuleSchema, {})[0]
    // Schemastery's resolver validates this schema but does not type its output.
    const rule = validated as SubagentModelRule
    const models = parents.get(rule.parent.provider) ?? new Set<string>()
    if (models.has(rule.parent.model)) {
      throw new Error(`subagent modelRules repeats parent route "${rule.parent.provider}/${rule.parent.model}"`)
    }
    models.add(rule.parent.model)
    parents.set(rule.parent.provider, models)
  }
}

/** Captured creation input shared by the one-shot driver and continuation manager. */
export interface CapturedSubagentModelRule {
  /** Complete effective options; an absent effort must not be inherited again. */
  readonly agentOptions: AgentOptions
  /**
   * Validate the captured target without recapturing settings or parent state.
   * @param signal - Caller cancellation before child publication.
   * @returns Once the exact target passes live LLM validation.
   */
  preflight(signal: AbortSignal): Promise<void>
}

/**
 * Capture a matching rule and effective child options before asynchronous work.
 * @param ctx - Runtime context providing the optional LLM service.
 * @param rules - Current validated Host rules.
 * @param parent - Direct parent supplying effective delegation options.
 * @param requested - Caller-configured or explicit child options.
 * @returns Captured input, or undefined without any LLM read when no rule applies.
 */
export function captureSubagentModelRule(
  ctx: Context,
  rules: readonly SubagentModelRule[] | undefined,
  parent: Agent,
  requested: AgentOptions | undefined,
): CapturedSubagentModelRule | undefined {
  if (rules === undefined || rules.length === 0
    || requested?.provider !== undefined || requested?.model !== undefined
    || requested?.reasoningEffort !== undefined) return undefined
  const parentOptions = parentAgentOptionsForDelegation(parent)
  const rule = rules.find(candidate => candidate.parent.provider === parentOptions.provider
    && candidate.parent.model === parentOptions.model)
  if (rule === undefined) return undefined
  const provider = rule.child.provider
  const model = rule.child.model
  const agentOptions = mergeChildAgentOptions(parentOptions, { ...requested, provider, model })
  return {
    agentOptions,
    async preflight(signal) {
      signal.throwIfAborted()
      const llm = ctx.get('llm')
      if (llm === undefined) throw new Error('subagent modelRules require the llm service for a matched target')
      // Cordis returns a fresh traced receiver on each service read.
      const identity: unknown = Reflect.get(llm, symbols.original) ?? llm
      const topology = { changed: false }
      const dispose = ctx.on('llm/adapters-updated', () => { topology.changed = true })
      try {
        await llm.resolveCallConfig({
          provider,
          model,
          ...agentOptions.reasoningEffort === undefined ? {} : { reasoningEffort: agentOptions.reasoningEffort },
          ...agentOptions.maxTokens === undefined ? {} : { maxTokens: agentOptions.maxTokens },
        }, signal)
        signal.throwIfAborted()
        const current = ctx.get('llm')
        const currentIdentity: unknown = current === undefined ? undefined : Reflect.get(current, symbols.original) ?? current
        if (topology.changed || currentIdentity !== identity) {
          throw new Error('LLM catalog/provider changed during subagent model rule preflight; retry delegation')
        }
      } finally {
        dispose()
      }
    },
  }
}
