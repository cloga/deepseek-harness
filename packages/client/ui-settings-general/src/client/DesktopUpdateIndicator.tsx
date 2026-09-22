/** Optional Electron status presentation; the native shell owns actions and Web owns visible copy. */
import { IconDownloadOutline16, IconLoadingOutline16, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './DesktopUpdateIndicator.module.css'
import type { DesktopUpdateFailureKind, DesktopUpdatePresentation, DesktopUpdateView } from './desktop-update-bridge.ts'
import type { SettingsRootInjected } from './shell-contract.ts'

type SettingsTranslate = PropsLocale<'settings'>['t']

const BUSY_PHASES: ReadonlySet<DesktopUpdatePresentation['phase']> = new Set([
  'checking', 'downloading', 'verifying', 'installing',
])

function updateCopy(state: DesktopUpdatePresentation, t: SettingsTranslate): { label: string; detail: string } {
  if (state.baseline !== undefined && state.phase === 'idle') {
    return { label: t(state.baseline.status === 'preserved-user-choice' ? 'desktop.baseline.preserved' : 'desktop.baseline.pending'),
      detail: t('desktop.baseline.detail', { name: state.baseline.packageName }) }
  }
  const labels: Readonly<Record<DesktopUpdatePresentation['phase'], string>> = {
    idle: '',
    checking: t('desktop.update.checking'),
    available: t('desktop.update.available'),
    downloading: t('desktop.update.progress', { percent: state.percent ?? 0 }),
    verifying: t('desktop.update.verifying'),
    installing: t('desktop.update.installing'),
    ready: t(state.mode === 'github-release-managed' ? 'desktop.update.managedReady' : 'desktop.update.ready'),
    error: t('desktop.update.retry'),
  }
  const label = labels[state.phase]
  const channel = (detail: string): string => state.mode === 'github-release-managed'
    ? `${t('desktop.update.managedChannel')} — ${detail}` : detail
  if (state.phase === 'error') {
    const failures: Readonly<Record<DesktopUpdateFailureKind, string>> = {
      check: t('desktop.update.checkFailed'),
      'check-network': t('desktop.update.checkNetworkFailed'),
      download: t('desktop.update.downloadFailed'),
      'download-network': t('desktop.update.downloadNetworkFailed'),
      install: t('desktop.update.installFailed'),
      'install-network': t('desktop.update.installNetworkFailed'),
      'stop-failed': t('desktop.update.stopFailed'),
      'tasks-changed': t('desktop.update.tasksChanged'),
      'tasks-unavailable': t('desktop.update.tasksUnavailable'),
      'unsaved-input': t('desktop.update.unsavedInput'),
    }
    return { label, detail: channel(failures[state.failure ?? 'install']) }
  }
  if (state.phase === 'downloading' && state.version !== undefined) {
    return { label, detail: t('desktop.update.downloadDetail', { percent: state.percent ?? 0, version: state.version }) }
  }
  return { label, detail: channel(state.version === undefined
    ? label
    : t('desktop.update.versionDetail', { label, version: state.version })) }
}

/**
 * @param props - Connection priority, sidebar width, and localized bridge-failure copy.
 * @returns Desktop-only status beside the account button, or nothing in browsers.
 */
export function DesktopUpdateIndicator({ wide, hidden, t, view, onOpen }: {
  wide: boolean
  hidden: boolean
  t: SettingsTranslate
  view: DesktopUpdateView
  onOpen: () => void
}) {
  const { presentation: state, failed, opening } = view
  if (!wide || hidden || (!failed && (state === undefined || (state.phase === 'idle' && state.baseline === undefined)))) return null
  const retryLabel = t('desktop.update.retry')
  const copy = state === undefined ? { label: retryLabel, detail: retryLabel } : updateCopy(state, t)
  const label = failed ? retryLabel : copy.label
  const error = failed || state?.phase === 'error' || (state?.phase === 'idle' && state.baseline !== undefined)
  const busy = opening || (state !== undefined && BUSY_PHASES.has(state.phase))
  return <Tooltip label={failed ? retryLabel : copy.detail} side="top">
    <button type="button" className={css.indicator} data-error={error || undefined}
      aria-label={label} aria-disabled={busy} onClick={() => { if (!busy) onOpen() }}>
      {error ? <span className={css.errorDot} aria-hidden="true" />
        : busy ? <IconLoadingOutline16 className={css.spinner} size={16} /> : <IconDownloadOutline16 size={14} />}
      <span>{label}</span>
    </button>
  </Tooltip>
}

type BadgeProps = PropsRuntime<'sidebar.toggle.badge'> & PropsLocale<'settings'>
  & Pick<InjectFace<SettingsRootInjected>, 'useDesktopUpdate' | 'useConnectionState'>

/**
 * @param props - Framework-bound carrier and connection state.
 * @returns A non-interactive notification on the sidebar expand button.
 */
export function DesktopUpdateBadge({ useDesktopUpdate, useConnectionState, t }: BadgeProps) {
  const { presentation: state, failed } = useDesktopUpdate(value => value)
  const connection = useConnectionState(value => value)
  if (((connection === 'disconnected' || connection === 'connecting') && state?.phase !== 'installing')
    || (!failed && (state === undefined || (state.phase === 'idle' && state.baseline === undefined)))) return null
  const retryLabel = t('desktop.update.retry')
  const copy = state === undefined ? { label: retryLabel, detail: retryLabel } : updateCopy(state, t)
  const label = failed ? retryLabel : copy.label
  return <Tooltip label={failed ? label : copy.detail} side="right">
    <span role="img" aria-label={label} className={css.badge} data-error={failed || state?.phase === 'error' || (state?.phase === 'idle' && state.baseline !== undefined) || undefined} />
  </Tooltip>
}
