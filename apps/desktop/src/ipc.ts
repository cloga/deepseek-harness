/** Typed preload operations exposed only by the Electron shell. */

import type { DesktopPluginRecord } from './project-manager.ts'
import {
  DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
  type DesktopPluginProvisionReceipt,
  type DesktopPluginSource,
} from './plugin-source.ts'
import { DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY } from './plugin-provisioning.ts'
import type { DesktopLocale } from './locale.ts'
import type { DesktopBackendState } from './backend-controller.ts'

/** IPC channel names kept private to the desktop application bundle. */
export const DESKTOP_IPC = {
  localeGet: 'dsh-desktop:locale-get',
  pluginsList: 'dsh-desktop:plugins-list',
  pluginsInstall: 'dsh-desktop:plugins-install',
  pluginsAdd: 'dsh-desktop:plugins-add',
  pluginsRemove: 'dsh-desktop:plugins-remove',
  pluginsUpdate: 'dsh-desktop:plugins-update',
  pluginsToggle: 'dsh-desktop:plugins-toggle',
  pluginsDisableAll: 'dsh-desktop:plugins-disable-all',
  backendStatus: 'dsh-desktop:backend-status',
  backendRetry: 'dsh-desktop:backend-retry',
  applicationRestart: 'dsh-desktop:application-restart',
  configurationReset: 'dsh-desktop:configuration-reset',
  backendState: 'dsh-desktop:backend-state',
  updatesStatus: 'dsh-desktop:updates-status',
  updatesCheck: 'dsh-desktop:updates-check',
  updatesInstall: 'dsh-desktop:updates-install',
  updatesState: 'dsh-desktop:updates-state',
  capabilitiesGet: 'dsh-desktop:capabilities-get',
  updatesImpactReport: 'dsh-desktop:updates-impact-report',
  pluginImpactRequest: 'dsh-desktop:plugin-impact-request',
  pluginImpactResponse: 'dsh-desktop:plugin-impact-response',
} as const

/** Unsaved application-document work reported through the fixed preload bridge. */
export interface DesktopRendererUpdateImpact {
  readonly hasDraft: boolean
  readonly attachmentCount: number
  readonly submitting: boolean
}

/** Validate the only application-document values accepted by the update confirmation. */
export function parseDesktopRendererUpdateImpact(value: unknown): DesktopRendererUpdateImpact {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('dsh desktop: invalid update impact report')
  }
  const impact = value as Record<string, unknown>
  if (Object.keys(impact).sort().join(',') !== 'attachmentCount,hasDraft,submitting'
    || typeof impact.hasDraft !== 'boolean' || typeof impact.submitting !== 'boolean'
    || !Number.isSafeInteger(impact.attachmentCount) || Number(impact.attachmentCount) < 0
    || Number(impact.attachmentCount) > 1000) {
    throw new Error('dsh desktop: invalid update impact report')
  }
  return {
    hasDraft: impact.hasDraft,
    attachmentCount: Number(impact.attachmentCount),
    submitting: impact.submitting,
  }
}

/** Desktop release update state rendered by desktop-owned UI. */
export interface DesktopUpdateState {
  readonly phase: 'idle' | 'checking' | 'available' | 'installing' | 'ready' | 'error'
  readonly version?: string
  readonly message?: string
  readonly mode?: 'native' | 'github-release-managed'
  readonly interactiveInstaller?: boolean
}

/** Narrow bridge exposed through context isolation. */
export interface DshDesktopApi {
  readonly protocolVersion: 2
  capabilities(): Promise<readonly [
    typeof DESKTOP_NATIVE_VERIFIED_RELEASE_CAPABILITY,
    typeof DESKTOP_NATIVE_PLUGIN_PROVISIONING_CAPABILITY,
  ]>
  locale(): Promise<DesktopLocale>
  readonly plugins: {
    list(): Promise<readonly DesktopPluginRecord[]>
    add(spec: string): Promise<void>
    install(source: DesktopPluginSource): Promise<DesktopPluginProvisionReceipt | undefined>
    remove(name: string): Promise<void>
    update(name: string, version: string): Promise<void>
    toggle(name: string, enabled: boolean): Promise<void>
    disableAll(): Promise<void>
  }
  readonly backend: {
    status(): Promise<DesktopBackendState>
    retry(): Promise<void>
    subscribe(listener: (state: DesktopBackendState) => void): () => void
  }
  readonly updates: {
    check(): Promise<DesktopUpdateState>
    install(): Promise<void>
    subscribe(listener: (state: DesktopUpdateState) => void): () => void
  }
}

/** Startup-page controls, unavailable to backend-provided application documents. */
export interface DshDesktopStartupApi extends Pick<DshDesktopApi, 'protocolVersion' | 'locale'> {
  readonly backend: Omit<DshDesktopApi['backend'], 'retry'>
  disablePlugins(): Promise<void>
  restart(): Promise<void>
  resetConfiguration(): Promise<void>
}

/** Minimal bridge available to the backend-provided application document. */
export interface DshDesktopApplicationApi {
  readonly protocolVersion: 2
  readonly updates: {
    reportImpact(impact: DesktopRendererUpdateImpact): void
    /** Read the retained notification, including updates discovered before this document loaded. */
    status(): Promise<DesktopUpdateState>
    /** Subscribe to notification changes; call status after subscribing for the initial snapshot. */
    subscribe(listener: (state: DesktopUpdateState) => void): () => void
    /** Open the native confirmation; managed updates recheck active work. Reject on check or installation failure. */
    review(): Promise<void>
  }
}
