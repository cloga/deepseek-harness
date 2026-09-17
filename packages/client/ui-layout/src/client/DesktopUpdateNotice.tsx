/** Persistent, non-modal Desktop update notice above the main application panel. */
import { useEffect, useRef, useState } from 'react'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import css from './DesktopUpdateNotice.module.css'

interface UpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'installing' | 'ready' | 'error'
  readonly version?: string
}

interface UpdateBridge {
  status(): Promise<UpdateState>
  subscribe(listener: (state: UpdateState) => void): () => void
  review(): Promise<void>
}

function desktopBridge(): UpdateBridge | undefined {
  const desktop = (window as Window & {
    readonly dshDesktop?: { readonly protocolVersion?: number; readonly updates?: Partial<UpdateBridge> }
  }).dshDesktop
  const updates = desktop?.updates
  if (desktop?.protocolVersion !== 2 || updates === undefined
    || typeof updates.status !== 'function' || typeof updates.subscribe !== 'function'
    || typeof updates.review !== 'function') return undefined
  return updates as UpdateBridge
}

/** Render only when the Desktop bridge has an actionable update or installation state.
 * @param props - Layout-owned locale translator.
 * @returns Non-blocking status strip, or no element on ordinary Web pages.
 */
export function DesktopUpdateNotice({ t }: PropsLocale<'layout'>) {
  const [bridge] = useState(desktopBridge)
  const [state, setState] = useState<UpdateState>()
  const [reviewing, setReviewing] = useState(false)
  const [reviewFailed, setReviewFailed] = useState(false)
  const mounted = useRef(false)
  const pending = useRef(false)

  useEffect(() => {
    if (bridge === undefined) return
    mounted.current = true
    let active = true
    let receivedEvent = false
    const off = bridge.subscribe((next) => {
      if (!active) return
      receivedEvent = true
      setState(next)
      setReviewFailed(false)
    })
    void bridge.status().then((initial) => {
      // A later event wins over a delayed initial IPC snapshot.
      if (active && !receivedEvent) setState(initial)
    }).catch(() => {
      // Snapshot errors do not create an update claim; a later event can recover.
    })
    return () => {
      active = false
      mounted.current = false
      off()
    }
  }, [bridge])

  if (state === undefined || bridge === undefined || state.version === undefined
    || state.phase === 'idle' || state.phase === 'checking') return null

  const installing = state.phase === 'installing' || state.phase === 'ready'
  const title = state.phase === 'installing'
    ? t('desktopUpdate.installing')
    : state.phase === 'ready'
      ? t('desktopUpdate.ready')
      : state.phase === 'error'
        ? t('desktopUpdate.failed')
        : t('desktopUpdate.available')

  const review = async (): Promise<void> => {
    if (pending.current || installing) return
    pending.current = true
    setReviewing(true)
    setReviewFailed(false)
    try {
      await bridge.review()
    } catch {
      if (mounted.current) setReviewFailed(true)
    } finally {
      pending.current = false
      if (mounted.current) setReviewing(false)
    }
  }

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
