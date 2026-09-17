/** Persistent, non-modal Desktop update notice above the main application panel. */
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { DesktopUpdateSnapshot } from './desktop-update-adapter.ts'
import css from './DesktopUpdateNotice.module.css'

/** Parent-projected notice data and explicit review callback. */
export type DesktopUpdateNoticeProps = PropsLocale<'layout'> & {
  readonly notice: DesktopUpdateSnapshot
  readonly review: () => Promise<void>
}

/** Render only an actionable update or installation state.
 * @param props - Framework-derived parent snapshot, review callback, and locale translator.
 * @returns Non-blocking status strip, or no element on ordinary Web pages.
 */
export function DesktopUpdateNotice({ t, notice, review }: DesktopUpdateNoticeProps) {
  const { state, reviewing, reviewFailed } = notice
  if (state === null || state.version === undefined || state.phase === 'idle' || state.phase === 'checking') return null

  const installing = state.phase === 'installing' || state.phase === 'ready'
  const title = state.phase === 'installing'
    ? t('desktopUpdate.installing')
    : state.phase === 'ready'
      ? t('desktopUpdate.ready')
      : state.phase === 'error'
        ? t('desktopUpdate.failed')
        : t('desktopUpdate.available')

  return (
    <div className={css.notice} data-desktop-update-notice>
      <svg className={css.icon} viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 16V8m-3 3 3-3 3 3" />
      </svg>
      <div className={css.status} role="status" aria-live="polite">
        <span className={css.title}>{title}</span>
        <span className={css.version}>{state.version}</span>
      </div>
      <span className={css.hint}>{t('desktopUpdate.safe')}</span>
      <button className={css.review} type="button" disabled={reviewing || installing} onClick={() => { void review() }}>
        {reviewing ? t('desktopUpdate.reviewing') : t('desktopUpdate.review')}
      </button>
      {reviewFailed && <p className={css.error} role="alert">{t('desktopUpdate.reviewFailed')}</p>}
    </div>
  )
}
