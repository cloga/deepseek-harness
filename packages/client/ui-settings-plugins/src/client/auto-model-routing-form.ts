/** Browser-owned staged Auto settings values; Host validation remains authoritative. */

import type { ModelProviderGroup } from '@deepseek-ai/dsh-api-remotes/client'

/** Policy tradeoffs stored in the Host settings document. */
export type AutoRoutingMode = 'efficiency' | 'balanced' | 'intelligence'
/** Task classes whose quality floors the user configures. */
export type AutoRoutingComplexity = 'routine' | 'standard' | 'complex'
/** Curated ordinal quality, never inferred from a provider or model name. */
export type AutoRoutingQuality = 1 | 2 | 3
/** Classifier limits rendered as explicit form fields. */
export type AutoRoutingBudget = 'maxInputBytes' | 'maxOutputTokens' | 'maxOutputBytes' | 'timeoutMs'

/** One exact stored model-and-effort combination. */
export interface AutoRoutingSelection {
  readonly provider: string
  readonly model: string
  readonly reasoningEffort?: string
}

/** Credential-free JSON fields owned by the model-routing settings namespace. */
export interface AutoRoutingSettings {
  readonly enabled: boolean
  readonly policy?: {
    readonly candidates: readonly {
      readonly id: string
      readonly selection: AutoRoutingSelection
      readonly quality: AutoRoutingQuality
      readonly relativeCost: number
    }[]
    readonly qualityFloors: Readonly<Record<AutoRoutingMode, Readonly<Record<AutoRoutingComplexity, AutoRoutingQuality>>>>
    readonly minConfidence: number
    readonly conservativeCandidateId: string
  }
  readonly classifier?: {
    readonly selection: AutoRoutingSelection
    readonly maxInputBytes: number
    readonly maxOutputTokens: number
    readonly maxOutputBytes: number
    readonly timeoutMs: number
  }
}

/** Text drafts preserve invalid edits until the user corrects or discards them. */
export interface AutoRoutingCandidateDraft {
  readonly key: string
  id: string
  selection: AutoRoutingSelection
  quality: string
  relativeCost: string
}

/** Entire staged form, including whether optional configuration exists. */
export interface AutoRoutingDraft {
  enabled: boolean
  hasPolicy: boolean
  hasClassifier: boolean
  candidates: AutoRoutingCandidateDraft[]
  conservativeCandidateId: string
  minConfidence: string
  qualityFloors: Record<AutoRoutingMode, Record<AutoRoutingComplexity, string>>
  classifierSelection: AutoRoutingSelection
  budgets: Record<AutoRoutingBudget, string>
}

/** One model option, including retained saved routes missing from the current catalog. */
export interface AutoRoutingModelOption {
  readonly key: string
  readonly provider: string
  readonly model: string
  readonly providerName: string
  readonly modelName: string
  readonly available: boolean
  readonly efforts: readonly { readonly id: string; readonly name: string }[]
  readonly defaultEffort?: string
}

/** Stable diagnostic codes; no raw Host or provider error text reaches the form. */
export type AutoRoutingFormError =
  | 'required' | 'candidate-id' | 'candidate-route' | 'duplicate' | 'quality' | 'cost'
  | 'conservative' | 'floors' | 'confidence' | 'classifier-route' | 'budgets' | 'effort'

/** Either complete JSON settings or one localized validation diagnostic. */
export type AutoRoutingFormResult =
  | { readonly settings: AutoRoutingSettings; readonly error?: never }
  | { readonly error: AutoRoutingFormError; readonly settings?: never }

/** Closed protocol identifiers used to render the floor matrix. */
export const AUTO_ROUTING_MODES = ['efficiency', 'balanced', 'intelligence'] as const
/** Closed task identifiers used to render the floor matrix. */
export const AUTO_ROUTING_COMPLEXITIES = ['routine', 'standard', 'complex'] as const
/** Classifier budget fields accepted by the Host. */
export const AUTO_ROUTING_BUDGETS = ['maxInputBytes', 'maxOutputTokens', 'maxOutputBytes', 'timeoutMs'] as const

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
}

function selection(value: unknown): AutoRoutingSelection {
  const source = record(value)
  return {
    provider: typeof source.provider === 'string' ? source.provider : '',
    model: typeof source.model === 'string' ? source.model : '',
    ...typeof source.reasoningEffort !== 'string' ? {} : { reasoningEffort: source.reasoningEffort },
  }
}

/**
 * Narrow a settings/base snapshot into safe editable fields without adopting arbitrary objects.
 * @param value - Resolved settings or unknown composition-layer metadata.
 * @returns A detached form with blank fields where no configured value exists.
 */
export function autoRoutingDraft(value: unknown): AutoRoutingDraft {
  const source = record(value)
  const policy = record(source.policy)
  const classifier = record(source.classifier)
  const floors = record(policy.qualityFloors)
  const floor = (mode: AutoRoutingMode) => {
    const values = record(floors[mode])
    return { routine: text(values.routine), standard: text(values.standard), complex: text(values.complex) }
  }
  return {
    enabled: source.enabled === true,
    hasPolicy: source.policy !== undefined,
    hasClassifier: source.classifier !== undefined,
    candidates: Array.isArray(policy.candidates) ? policy.candidates.map((value: unknown, index) => {
      const candidate = record(value)
      return {
        key: `stored-${String(index)}`, id: text(candidate.id), selection: selection(candidate.selection),
        quality: text(candidate.quality), relativeCost: text(candidate.relativeCost),
      }
    }) : [],
    conservativeCandidateId: text(policy.conservativeCandidateId),
    minConfidence: text(policy.minConfidence),
    qualityFloors: { efficiency: floor('efficiency'), balanced: floor('balanced'), intelligence: floor('intelligence') },
    classifierSelection: selection(classifier.selection),
    budgets: {
      maxInputBytes: text(classifier.maxInputBytes), maxOutputTokens: text(classifier.maxOutputTokens),
      maxOutputBytes: text(classifier.maxOutputBytes), timeoutMs: text(classifier.timeoutMs),
    },
  }
}

/**
 * Identify an exact provider/model option without parsing user-facing labels.
 * @param route - Exact route fields.
 * @returns An opaque stable option key.
 */
export function autoRoutingModelKey(route: AutoRoutingSelection): string {
  return JSON.stringify([route.provider, route.model])
}

/**
 * Join advertised models with saved/draft routes so disappeared choices remain repairable.
 * @param groups - Last accepted Host model directory.
 * @param retained - Exact selections still present in saved or draft settings.
 * @returns Owned model options; missing catalog entries are explicitly unavailable.
 */
export function autoRoutingModelOptions(
  groups: readonly ModelProviderGroup[],
  retained: readonly AutoRoutingSelection[],
): AutoRoutingModelOption[] {
  const options = new Map<string, AutoRoutingModelOption>()
  for (const group of groups) {
    for (const model of group.models) {
      const route = { provider: group.id, model: model.id }
      const key = autoRoutingModelKey(route)
      options.set(key, {
        key, ...route, providerName: group.name, modelName: model.name, available: true,
        efforts: model.reasoning?.efforts.map(effort => ({ id: effort.id, name: effort.name })) ?? [],
        ...model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort },
      })
    }
  }
  for (const route of retained) {
    if (route.provider.length === 0 || route.model.length === 0) continue
    const key = autoRoutingModelKey(route)
    if (options.has(key)) continue
    options.set(key, {
      key, provider: route.provider, model: route.model,
      providerName: route.provider, modelName: route.model, available: false, efforts: [],
    })
  }
  return [...options.values()]
}

function validRoute(route: AutoRoutingSelection): boolean {
  return route.provider.trim().length > 0 && route.model.trim().length > 0
    && (route.reasoningEffort === undefined || route.reasoningEffort.trim().length > 0)
}

function quality(value: string): AutoRoutingQuality | undefined {
  return value === '1' ? 1 : value === '2' ? 2 : value === '3' ? 3 : undefined
}

function positiveInteger(value: string): number | undefined {
  const number = value.trim() === '' ? NaN : Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

/**
 * Validate untrusted text drafts for useful feedback before the authoritative Host write.
 * Catalog absence stays advisory; a known model's unsupported explicit effort blocks enabling.
 * @param draft - Current staged form.
 * @param options - Model metadata used only for known effort compatibility.
 * @returns Exact complete settings, or one closed validation code.
 */
export function resolveAutoRoutingDraft(
  draft: AutoRoutingDraft,
  options: readonly AutoRoutingModelOption[],
): AutoRoutingFormResult {
  if (draft.enabled && (!draft.hasPolicy || !draft.hasClassifier)) return { error: 'required' }
  const compatible = (route: AutoRoutingSelection): boolean => {
    if (!draft.enabled || route.reasoningEffort === undefined) return true
    const model = options.find(option => option.key === autoRoutingModelKey(route))
    return model === undefined || !model.available || model.efforts.some(effort => effort.id === route.reasoningEffort)
  }
  let policy: AutoRoutingSettings['policy']
  if (draft.hasPolicy) {
    if (draft.candidates.length === 0) return { error: 'required' }
    const ids = new Set<string>()
    const routes = new Set<string>()
    const candidates: NonNullable<AutoRoutingSettings['policy']>['candidates'][number][] = []
    for (const candidate of draft.candidates) {
      if (candidate.id.trim().length === 0 || ids.has(candidate.id)) return { error: 'candidate-id' }
      ids.add(candidate.id)
      if (!validRoute(candidate.selection)) return { error: 'candidate-route' }
      const route = JSON.stringify([candidate.selection.provider, candidate.selection.model, candidate.selection.reasoningEffort ?? null])
      if (routes.has(route)) return { error: 'duplicate' }
      routes.add(route)
      const rank = quality(candidate.quality)
      if (rank === undefined) return { error: 'quality' }
      const cost = candidate.relativeCost.trim() === '' ? NaN : Number(candidate.relativeCost)
      if (!Number.isFinite(cost) || cost <= 0) return { error: 'cost' }
      if (!compatible(candidate.selection)) return { error: 'effort' }
      candidates.push({ id: candidate.id, selection: { ...candidate.selection }, quality: rank, relativeCost: cost })
    }
    const conservative = candidates.find(candidate => candidate.id === draft.conservativeCandidateId)
    if (conservative === undefined || candidates.some(candidate => candidate.quality > conservative.quality)) {
      return { error: 'conservative' }
    }
    const floors = {} as Record<AutoRoutingMode, Record<AutoRoutingComplexity, AutoRoutingQuality>>
    for (const mode of AUTO_ROUTING_MODES) {
      const row = {} as Record<AutoRoutingComplexity, AutoRoutingQuality>
      for (const complexity of AUTO_ROUTING_COMPLEXITIES) {
        const value = quality(draft.qualityFloors[mode][complexity])
        if (value === undefined || !candidates.some(candidate => candidate.quality >= value)) return { error: 'floors' }
        row[complexity] = value
      }
      floors[mode] = row
    }
    const confidence = draft.minConfidence.trim() === '' ? NaN : Number(draft.minConfidence)
    if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return { error: 'confidence' }
    policy = { candidates, qualityFloors: floors, minConfidence: confidence, conservativeCandidateId: conservative.id }
  }
  let classifier: AutoRoutingSettings['classifier']
  if (draft.hasClassifier) {
    if (!validRoute(draft.classifierSelection)) return { error: 'classifier-route' }
    if (!compatible(draft.classifierSelection)) return { error: 'effort' }
    const maxInputBytes = positiveInteger(draft.budgets.maxInputBytes)
    const maxOutputTokens = positiveInteger(draft.budgets.maxOutputTokens)
    const maxOutputBytes = positiveInteger(draft.budgets.maxOutputBytes)
    const timeoutMs = positiveInteger(draft.budgets.timeoutMs)
    if (maxInputBytes === undefined || maxOutputTokens === undefined || maxOutputBytes === undefined
      || timeoutMs === undefined || timeoutMs > 2_147_483_647) return { error: 'budgets' }
    classifier = { selection: { ...draft.classifierSelection }, maxInputBytes, maxOutputTokens, maxOutputBytes, timeoutMs }
  }
  return {
    settings: {
      enabled: draft.enabled,
      ...policy === undefined ? {} : { policy },
      ...classifier === undefined ? {} : { classifier },
    },
  }
}
