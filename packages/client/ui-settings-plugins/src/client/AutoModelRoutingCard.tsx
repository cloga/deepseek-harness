/** Bounded Auto routing settings presentation; mutations belong to the injected controller. */

import { Button, Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { AutoModelRoutingCardFace } from './auto-model-routing-card-controller.ts'
import {
  AUTO_ROUTING_BUDGETS, AUTO_ROUTING_COMPLEXITIES, AUTO_ROUTING_MODES, autoRoutingModelKey,
} from './auto-model-routing-form.ts'
import type {
  AutoRoutingBudget, AutoRoutingComplexity, AutoRoutingFormError, AutoRoutingMode, AutoRoutingSelection,
} from './auto-model-routing-form.ts'
import type { PluginsSettingsLocaleKey } from './locales.ts'
import type {} from './slot-contract.ts'
import { PluginCard } from './PluginCard.tsx'
import css from './AutoModelRoutingCard.module.css'

/** Renderer-derived inputs for the Auto routing card. */
export type AutoModelRoutingCardProps =
  PropsRuntime<'settings.plugin.item'>
  & PropsLocale<'settings.plugins'>
  & InjectFace<AutoModelRoutingCardFace>

const errorKeys: Record<AutoRoutingFormError, PluginsSettingsLocaleKey> = {
  required: 'autoRoutingErrorRequired',
  'candidate-id': 'autoRoutingErrorCandidateId',
  'candidate-route': 'autoRoutingErrorCandidateRoute',
  duplicate: 'autoRoutingErrorDuplicate',
  quality: 'autoRoutingErrorQuality',
  cost: 'autoRoutingErrorCost',
  conservative: 'autoRoutingErrorConservative',
  floors: 'autoRoutingErrorFloors',
  confidence: 'autoRoutingErrorConfidence',
  'classifier-route': 'autoRoutingErrorClassifierRoute',
  budgets: 'autoRoutingErrorBudgets',
  effort: 'autoRoutingErrorEffort',
}
const modeKeys: Record<AutoRoutingMode, PluginsSettingsLocaleKey> = {
  efficiency: 'autoRoutingEfficiency', balanced: 'autoRoutingBalanced', intelligence: 'autoRoutingIntelligence',
}
const complexityKeys: Record<AutoRoutingComplexity, PluginsSettingsLocaleKey> = {
  routine: 'autoRoutingRoutine', standard: 'autoRoutingStandard', complex: 'autoRoutingComplex',
}
const budgetKeys: Record<AutoRoutingBudget, PluginsSettingsLocaleKey> = {
  maxInputBytes: 'autoRoutingMaxInputBytes', maxOutputTokens: 'autoRoutingMaxOutputTokens',
  maxOutputBytes: 'autoRoutingMaxOutputBytes', timeoutMs: 'autoRoutingTimeoutMs',
}

/**
 * Render staged routing choices without invoking classification or deriving routing policy.
 * @param props - Framework-bound snapshot, localized copy, and explicit edit actions.
 * @returns The settings card, hidden when its namespace is unavailable.
 */
export function AutoModelRoutingCard(props: AutoModelRoutingCardProps) {
  const { t } = props
  const state = props.useAutoModelRoutingCard(snapshot => snapshot)
  const { draft } = state
  const disabled = !state.writable || state.saving
  const renderRoute = (
    selection: AutoRoutingSelection,
    selectModel: (key: string) => void,
    selectEffort: (effort: string) => void,
  ) => {
    const key = autoRoutingModelKey(selection)
    const model = state.models.find(option => option.key === key)
    const effort = selection.reasoningEffort ?? ''
    const missingEffort = effort !== '' && !model?.efforts.some(option => option.id === effort)
    const defaultEffortName = model?.efforts.find(option => option.id === model.defaultEffort)?.name ?? model?.defaultEffort
    return (
      <>
        <label className={css.field}>
          <span>{t('autoRoutingModel')}</span>
          <select value={key} disabled={disabled} onChange={(event) => { selectModel(event.target.value) }}>
            <option value={autoRoutingModelKey({ provider: '', model: '' })} disabled>{t('autoRoutingChooseModel')}</option>
            {state.models.map(option => (
              <option key={option.key} value={option.key}>
                {`${option.providerName} · ${option.modelName} (${option.provider}/${option.model})${option.available ? '' : ` · ${t('autoRoutingUnavailable')}`}`}
              </option>
            ))}
          </select>
        </label>
        <label className={css.field}>
          <span>{t('autoRoutingEffort')}</span>
          <select value={effort} disabled={disabled} onChange={(event) => { selectEffort(event.target.value) }}>
            <option value="">{`${t('autoRoutingProviderDefault')}${defaultEffortName === undefined ? '' : ` (${defaultEffortName})`}`}</option>
            {model?.efforts.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}
            {missingEffort ? <option value={effort}>{`${effort} · ${t('autoRoutingUnavailable')}`}</option> : null}
          </select>
        </label>
        {model?.available === false || missingEffort
          ? <p className={css.notice}>{t('autoRoutingUnavailableHint')}</p>
          : null}
      </>
    )
  }
  const qualityOptions = () => (
    <>
      <option value="" disabled>{t('autoRoutingChooseQuality')}</option>
      {[1, 2, 3].map(rank => <option key={rank} value={rank}>{rank}</option>)}
    </>
  )
  return (
    <PluginCard
      t={t}
      titleKey="autoRoutingTitle"
      descriptionKey="autoRoutingDescription"
      state={state}
      onSave={props.save}
      onDiscard={props.discard}
    >
      <div className={css.form}>
        <div className={css.toggleRow}>
          <span>{t('autoRoutingEnabled')}</span>
          <Switch label={t('autoRoutingEnabled')} checked={draft.enabled} disabled={disabled} onChange={props.toggleEnabled} />
        </div>
        <p className={css.hint}>{t('autoRoutingScopeHint')}</p>
        <p className={css.hint}>{t('autoRoutingSafetyHint')}</p>
        {!draft.enabled ? <p className={css.notice}>{t('autoRoutingDisabledHint')}</p> : null}
        {state.catalogStatus === 'loading' ? <p className={css.notice} role="status">{t('autoRoutingLoading')}</p> : null}
        {state.catalogStatus === 'error' ? <p className={css.invalid} role="alert">{t('autoRoutingLoadFailed')}</p> : null}
        {state.catalogPartial ? <p className={css.notice} role="status">{t('autoRoutingPartial')}</p> : null}
        {state.catalogStatus === 'ready' && !state.models.some(model => model.available)
          ? <p className={css.notice}>{t('autoRoutingEmpty')}</p>
          : null}
        <div className={css.actions}>
          <Button size="sm" disabled={disabled || state.catalogStatus === 'loading'} onClick={props.retryCatalog}>{t('autoRoutingRetry')}</Button>
        </div>
        <fieldset className={css.section}>
          <legend>{t('autoRoutingCandidates')}</legend>
          <p className={css.hint}>{t('autoRoutingWeightsHint')}</p>
          <p className={css.hint}>{t('autoRoutingEffortHint')}</p>
          {draft.candidates.map((candidate, index) => (
            <fieldset className={css.candidate} key={candidate.key}>
              <legend>{`${t('autoRoutingCandidate')} ${String(index + 1)}`}</legend>
              <div className={css.fields}>
                <label className={css.field}>
                  <span>{t('autoRoutingCandidateId')}</span>
                  <Input
                    value={candidate.id}
                    disabled={disabled}
                    onChange={(event) => { props.editCandidate(candidate.key, 'id', event.target.value) }}
                  />
                </label>
                {renderRoute(candidate.selection,
                  (modelKey) => { props.selectCandidateModel(candidate.key, modelKey) },
                  (effort) => { props.selectCandidateEffort(candidate.key, effort) })}
                <label className={css.field}>
                  <span>{t('autoRoutingQuality')}</span>
                  <select
                    value={candidate.quality}
                    disabled={disabled}
                    onChange={(event) => { props.editCandidate(candidate.key, 'quality', event.target.value) }}
                  >
                    {qualityOptions()}
                  </select>
                </label>
                <label className={css.field}>
                  <span>{t('autoRoutingCost')}</span>
                  <Input
                    type="number"
                    min="0"
                    step="any"
                    value={candidate.relativeCost}
                    disabled={disabled}
                    onChange={(event) => { props.editCandidate(candidate.key, 'relativeCost', event.target.value) }}
                  />
                </label>
              </div>
              <div className={css.actions}>
                <Button size="sm" disabled={disabled} onClick={() => { props.removeCandidate(candidate.key) }}>{t('autoRoutingRemoveCandidate')}</Button>
              </div>
            </fieldset>
          ))}
          <div className={css.actions}>
            <Button size="sm" disabled={disabled} onClick={props.addCandidate}>{t('autoRoutingAddCandidate')}</Button>
          </div>
          <label className={css.field}>
            <span>{t('autoRoutingConservative')}</span>
            <select
              value={draft.conservativeCandidateId}
              disabled={disabled}
              onChange={(event) => { props.editPolicy('conservativeCandidateId', event.target.value) }}
            >
              <option value="" disabled>{t('autoRoutingChooseConservative')}</option>
              {draft.candidates.filter(candidate => candidate.id !== '').map(candidate => <option key={candidate.key} value={candidate.id}>{candidate.id}</option>)}
              {draft.conservativeCandidateId !== '' && !draft.candidates.some(candidate => candidate.id === draft.conservativeCandidateId)
                ? <option value={draft.conservativeCandidateId}>{`${draft.conservativeCandidateId} · ${t('autoRoutingUnavailable')}`}</option>
                : null}
            </select>
          </label>
          <p className={css.hint}>{t('autoRoutingConservativeHint')}</p>
        </fieldset>
        <fieldset className={css.section}>
          <legend>{t('autoRoutingClassifier')}</legend>
          <p className={css.hint}>{t('autoRoutingClassifierHint')}</p>
          <div className={css.fields}>
            {renderRoute(draft.classifierSelection, props.selectClassifierModel, props.selectClassifierEffort)}
            {AUTO_ROUTING_BUDGETS.map(field => (
              <label className={css.field} key={field}>
                <span>{t(budgetKeys[field])}</span>
                <Input
                  type="number"
                  min="1"
                  step="1"
                  value={draft.budgets[field]}
                  disabled={disabled}
                  onChange={(event) => { props.editBudget(field, event.target.value) }}
                />
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className={css.section}>
          <legend>{t('autoRoutingFloors')}</legend>
          <p className={css.hint}>{t('autoRoutingFloorsHint')}</p>
          <div className={css.matrixScroll}>
            <table className={css.matrix}>
              <thead>
                <tr>
                  <th scope="col">{t('autoRoutingMode')}</th>
                  {AUTO_ROUTING_COMPLEXITIES.map(complexity => (
                    <th scope="col" key={complexity}>{t(complexityKeys[complexity])}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {AUTO_ROUTING_MODES.map(mode => (
                  <tr key={mode}>
                    <th scope="row">{t(modeKeys[mode])}</th>
                    {AUTO_ROUTING_COMPLEXITIES.map(complexity => (
                      <td key={complexity}>
                        <select
                          aria-label={`${t(modeKeys[mode])} / ${t(complexityKeys[complexity])}`}
                          value={draft.qualityFloors[mode][complexity]}
                          disabled={disabled}
                          onChange={(event) => { props.editFloor(mode, complexity, event.target.value) }}
                        >
                          {qualityOptions()}
                        </select>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <label className={css.field}>
            <span>{t('autoRoutingMinConfidence')}</span>
            <Input
              type="number"
              min="0"
              max="1"
              step="any"
              value={draft.minConfidence}
              disabled={disabled}
              onChange={(event) => { props.editPolicy('minConfidence', event.target.value) }}
            />
          </label>
          <p className={css.hint}>{t('autoRoutingConfidenceHint')}</p>
        </fieldset>
        <div className={css.actions}>
          <Button size="sm" disabled={disabled} onClick={props.applySuggestions}>{t('autoRoutingSuggestions')}</Button>
          <Button size="sm" disabled={disabled} onClick={props.reset}>{t('autoRoutingReset')}</Button>
        </div>
        <p className={css.hint}>{t('autoRoutingSuggestionsHint')}</p>
        {state.resetPending ? <p className={css.notice} role="status">{t('autoRoutingResetPending')}</p> : null}
        {state.error === undefined ? null : <p className={css.invalid} role="alert">{t(errorKeys[state.error])}</p>}
        {state.conflicted ? <p className={css.invalid} role="status">{t('autoRoutingConflict')}</p> : null}
      </div>
    </PluginCard>
  )
}
