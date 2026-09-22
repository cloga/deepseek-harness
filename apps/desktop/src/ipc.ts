/** Typed preload operations exposed only by the Electron shell. */

import type { IpcMainInvokeEvent } from 'electron'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  boot: 'dsh-desktop:boot',
  bootFailed: 'dsh-desktop:boot-failed',
  directoryPick: 'dsh-desktop:directory-pick',
  updatesStatus: 'dsh-desktop:updates-status',
  updatesOpen: 'dsh-desktop:updates-open',
  updatesPresentation: 'dsh-desktop:updates-presentation',
  updatesImpact: 'dsh-desktop:updates-impact',
  updatesImpactRequest: 'dsh-desktop:updates-impact-request',
  nativeThemeSet: 'dsh-desktop:native-theme-set',
  windowsAppearance: 'dsh-desktop:windows-appearance',
  windowsMenu: 'dsh-desktop:windows-menu',
} as const

/** Desktop release update state rendered by desktop-owned UI. */
export type DesktopUpdatePreparationFailureKind = 'stop-failed' | 'tasks-changed' | 'tasks-unavailable' | 'unsaved-input'

export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'error'
  readonly version?: string
  /** Fork-owned verified Release handoff; absence denotes the official signed updater. */
  readonly mode?: 'github-release-managed'
  readonly message?: string
  /** Main-owned diagnostics without subprocess output or credentials; hidden until expanded. */
  readonly technicalDetails?: string
  readonly percent?: number
  readonly failedOperation?: 'check' | 'download' | 'install'
  /** Main-owned preparation cause; UI wording is selected by the active locale. */
  readonly preparationFailure?: DesktopUpdatePreparationFailureKind
}

/** Classified failure copy selected by the Web locale without exposing raw updater diagnostics. */
export type DesktopUpdateFailureKind =
  | 'check'
  | 'check-network'
  | 'download'
  | 'download-network'
  | 'install'
  | 'install-network'
  | 'stop-failed'
  | 'tasks-changed'
  | 'tasks-unavailable'
  | 'unsaved-input'

/** Baseline qualification is separate from whether the user's current profile can run. */
export interface DesktopBaselineNotice {
  readonly status: 'preserved-user-choice' | 'pending'
  readonly packageName: string
}

/** Semantic status content; actions open main-process confirmation dialogs only. */
export interface DesktopUpdatePresentation {
  readonly phase: DesktopUpdateState['phase']
  readonly mode?: NonNullable<DesktopUpdateState['mode']>
  readonly version?: string
  readonly percent?: number
  readonly failure?: DesktopUpdateFailureKind
  readonly baseline?: DesktopBaselineNotice
}

/** Product documents cannot supply update versions, package URLs, or installation authorization. */
export interface DshDesktopProductApi {
  readonly protocolVersion: 1
  readonly updates: {
    status(): Promise<DesktopUpdatePresentation>
    open(): Promise<void>
    /** Optional fork safety extension; reports blockers but cannot authorize installation. */
    reportImpact?(impact: DesktopRendererUpdateImpact): void
    subscribe(listener: (state: DesktopUpdatePresentation) => void): () => void
  }
}

/** Aggregate of all mounted Conversation seats, never draft text or attachment content. */
export interface DesktopRendererUpdateImpact {
  readonly hasDraft: boolean
  readonly attachmentCount: number
  readonly submitting: boolean
}

/**
 * Validate the fixed renderer safety report without accepting executable or source fields.
 * @param value - Untrusted IPC payload.
 * @returns Only the three admitted scalar fields.
 */
export function parseDesktopRendererUpdateImpact(value: unknown): DesktopRendererUpdateImpact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('dsh desktop: invalid update impact')
  }
  const input = value as Record<string, unknown>
  if (Object.keys(input).length !== 3 || typeof input.hasDraft !== 'boolean' || typeof input.submitting !== 'boolean'
    || typeof input.attachmentCount !== 'number' || !Number.isSafeInteger(input.attachmentCount) || input.attachmentCount < 0) {
    throw new Error('dsh desktop: invalid update impact')
  }
  return { hasDraft: input.hasDraft, attachmentCount: input.attachmentCount, submitting: input.submitting }
}

/** Scheme of Desktop-owned application documents. */
export const SCHEME = 'dsh-app'

/**
 * Reject IPC outside the allowed Desktop document origins.
 * @param event - IPC caller whose frame URL supplies the origin.
 * @param hostnames - Desktop document hosts allowed for this operation.
 */
export function assertDesktopSender(event: Pick<IpcMainInvokeEvent, 'senderFrame'>, hostnames: readonly string[]): void {
  const senderFrame = event.senderFrame
  if (senderFrame === null) throw new Error('dsh desktop: rejected IPC without a sender frame')
  const url = new URL(senderFrame.url)
  if (url.protocol !== `${SCHEME}:` || !hostnames.includes(url.hostname)) {
    throw new Error('dsh desktop: rejected IPC from an unowned renderer')
  }
}
