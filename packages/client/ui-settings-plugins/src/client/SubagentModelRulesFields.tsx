/** Exact parent-to-child model defaults within the native Subagent card. */
import { useId } from 'react'
import { Button } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { SubagentLimitsCardFace, SubagentLimitsCardState } from './subagent-limits-card-controller.ts'
import css from './SubagentModelRulesFields.module.css'

/** Plain namespace state and callbacks from the owning card. */
export type SubagentModelRulesFieldsProps = PropsLocale<'settings.plugins'>
  & Pick<SubagentLimitsCardFace, 'addRule' | 'removeRule' | 'editRule' | 'retryRulesCatalog'>
  & { state: SubagentLimitsCardState }

/**
 * Render native selectors without substituting unavailable saved IDs.
 * @param props - Localized copy, staged state, and namespace actions.
 * @returns Rule rows, catalog notices, and explicit settings settlement.
 */
export function SubagentModelRulesFields(props: SubagentModelRulesFieldsProps) {
  const { t, state } = props
  const { rules } = state
  const id = useId()
  const disabled = !state.available || !state.writable || state.saving || !rules.supported
  return (
    <div className={css.editor}>
      <p className={css.hint}>{t('subagentRulesHint')}</p>
      <p className={css.hint}>{t('subagentRulesPriority')}</p>
      <p className={css.hint}>{t('subagentRulesForkHint')}</p>
      {!rules.supported ? <p role="status">{t('subagentRulesUnsupported')}</p> : null}
      {rules.rows.length === 0 ? <p className={css.hint}>{t('subagentRulesEmpty')}</p> : null}
      {rules.catalogStatus === 'loading' ? <p role="status">{t('subagentModelSelectionLoading')}</p> : null}
      {rules.catalogStatus === 'error' || rules.catalogPartial ? (
        <div className={css.notice} role="status">
          <span>{t(rules.catalogPartial ? 'subagentModelSelectionPartial' : 'subagentModelSelectionLoadFailed')}</span>
          <Button size="sm" disabled={state.saving} onClick={props.retryRulesCatalog}>{t('subagentModelSelectionRetry')}</Button>
        </div>
      ) : null}
      {rules.catalogStatus === 'ready' && rules.groups.every(group => group.models.length === 0)
        ? <p className={css.hint}>{t('subagentModelSelectionEmpty')}</p> : null}
      {rules.rows.map((row, index) => (
        <div className={css.row} key={index}>
          <div className={css.routes}>
            {(['parent', 'child'] as const).map((side) => {
              const route = row[side]
              const group = rules.groups.find(group => group.id === route.provider)
              const missingProvider = route.provider !== '' && group === undefined
              const missingModel = route.model !== '' && !group?.models.some(model => model.id === route.model)
              const incomplete = !route.provider || !route.model
              const duplicate = side === 'parent' && rules.rows.some((other, otherIndex) => otherIndex !== index
                && other.parent.provider === route.provider && other.parent.model === route.model)
              const invalid = incomplete || duplicate
              const messageId = `${id}-${index}-${side}`
              return (
                <fieldset className={css.route} key={side} disabled={disabled}>
                  <legend>{t(side === 'parent' ? 'subagentRulesParent' : 'subagentRulesChild')}</legend>
                  <label>
                    <span>{t('subagentRulesProvider')}</span>
                    <select value={route.provider} aria-invalid={invalid} aria-describedby={invalid ? `${id}-validation` : undefined}
                      onChange={(event) => { props.editRule(index, side, 'provider', event.target.value) }}>
                      <option value="">{t('subagentRulesChoose')}</option>
                      {rules.groups.map(group => <option key={group.id} value={group.id}>{`${group.name} (${group.id})`}</option>)}
                      {missingProvider ? <option value={route.provider}>{`${route.provider} — ${t('subagentModelSelectionUnavailable')}`}</option> : null}
                    </select>
                  </label>
                  <label>
                    <span>{t('subagentRulesModel')}</span>
                    <select value={route.model} disabled={disabled || !route.provider} aria-invalid={invalid}
                      aria-describedby={invalid ? `${id}-validation` : missingModel ? messageId : undefined}
                      onChange={(event) => { props.editRule(index, side, 'model', event.target.value) }}>
                      <option value="">{t('subagentRulesChoose')}</option>
                      {group?.models.map(model => <option key={model.id} value={model.id}>{`${model.name} (${model.id})`}</option>)}
                      {missingModel ? <option value={route.model}>{`${route.model} — ${t('subagentModelSelectionUnavailable')}`}</option> : null}
                    </select>
                  </label>
                  {missingProvider || missingModel ? <p className={css.hint} id={messageId}>{t('subagentRulesUnavailable')}</p> : null}
                </fieldset>
              )
            })}
          </div>
          <Button size="sm" disabled={disabled} onClick={() => { props.removeRule(index) }}>{t('subagentRulesRemove')}</Button>
        </div>
      ))}
      <div id={`${id}-validation`} className={css.invalid} role={rules.incomplete || rules.duplicate ? 'alert' : undefined}>
        {rules.incomplete ? <p>{t('subagentRulesIncomplete')}</p> : null}
        {rules.duplicate ? <p>{t('subagentRulesDuplicate')}</p> : null}
      </div>
      <div className={css.notice}>
        <Button variant="outline" size="sm" disabled={disabled} onClick={props.addRule}>{t('subagentRulesAdd')}</Button>
        {rules.supported ? <span role="status">{t(state.saving ? 'saving' : rules.dirty ? 'subagentRulesUnsaved' : 'subagentRulesSaved')}</span> : null}
      </div>
    </div>
  )
}
