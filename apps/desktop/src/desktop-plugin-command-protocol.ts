/** Closed control-only plugin command messages; no framed Fetch transport or renderer authority. */

/** Source operation requested by the built-in Host command. */
export type DesktopPluginCommandOperation =
  | { readonly type: 'list' }
  | {
    readonly type: 'install'
    readonly source: { readonly type: 'npm'; readonly spec: string }
      | { readonly type: 'github'; readonly spec: string }
      | { readonly type: 'release'; readonly release: Record<string, unknown> }
  }
  | { readonly type: 'remove'; readonly name: string }
  | { readonly type: 'update'; readonly name: string; readonly version: string }
  | { readonly type: 'enable' | 'disable'; readonly name: string }
  | { readonly type: 'disable-all' }

/** Minimal actual installed package observation returned to a command. */
export interface DesktopPluginCommandListRow {
  readonly name: string
  readonly version: string
  readonly enabled: boolean
}

/** Result sent only to the exact requesting Host child. */
export type DesktopPluginCommandResponse =
  | { readonly kind: 'list'; readonly plugins: readonly DesktopPluginCommandListRow[] }
  | { readonly kind: 'prepared' }
  | { readonly kind: 'error'; readonly code: 'busy' | 'failed' | 'invalid' | 'stale' | 'unavailable' }

/** The three command message kinds, independent of URL readiness and update-task control. */
export type DesktopPluginCommandEvent =
  | {
    readonly type: 'plugin-command-request'
    readonly requestId: number
    readonly commandId: string
    readonly operation: DesktopPluginCommandOperation
  }
  | { readonly type: 'plugin-command-cancel'; readonly requestId: number }
  | { readonly type: 'plugin-command-settled'; readonly requestId: number; readonly commandId: string }

/** One validated operation request from a retained Host instance. */
export type DesktopPluginCommandRequest = Extract<DesktopPluginCommandEvent, { readonly type: 'plugin-command-request' }>

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function keys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => Object.hasOwn(value, field))
}
function bounded(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum
}
function publicText(value: unknown): value is string {
  return bounded(value, 256) && !/[\u0000-\u001f\u007f]/u.test(value)
}
function requestId(value: unknown): value is number { return Number.isSafeInteger(value) && Number(value) > 0 }

/**
 * Validate the closed operation before the shell interprets source data.
 * @param value - JSON received over the owned child IPC channel.
 * @returns Whether the operation is bounded and contains only its declared fields.
 */
export function isDesktopPluginCommandOperation(value: unknown): value is DesktopPluginCommandOperation {
  if (!record(value)) return false
  switch (value.type) {
    case 'list':
    case 'disable-all': return keys(value, ['type'])
    case 'remove':
    case 'enable':
    case 'disable': return keys(value, ['type', 'name']) && bounded(value.name, 256)
    case 'update': return keys(value, ['type', 'name', 'version']) && bounded(value.name, 256) && bounded(value.version, 256)
    case 'install': {
      if (!keys(value, ['type', 'source']) || !record(value.source)) return false
      const source = value.source
      if (source.type === 'npm' || source.type === 'github') {
        const maximum = source.type === 'github' ? 4096 : 1024 * 1024
        return keys(source, ['type', 'spec']) && bounded(source.spec, maximum)
          && new TextEncoder().encode(source.spec).length <= maximum
      }
      if (source.type !== 'release' || !keys(source, ['type', 'release']) || !record(source.release)) return false
      try { return new TextEncoder().encode(JSON.stringify(source.release)).length <= 1024 * 1024 }
      catch (_invalidJson) { return false }
    }
    default: return false
  }
}

/** @param value - Owned child message. @returns Whether this is exactly one admitted command event. */
export function isDesktopPluginCommandEvent(value: unknown): value is DesktopPluginCommandEvent {
  if (!record(value) || !requestId(value.requestId)) return false
  switch (value.type) {
    case 'plugin-command-request':
      return keys(value, ['type', 'requestId', 'commandId', 'operation']) && publicText(value.commandId)
        && isDesktopPluginCommandOperation(value.operation)
    case 'plugin-command-cancel': return keys(value, ['type', 'requestId'])
    case 'plugin-command-settled': return keys(value, ['type', 'requestId', 'commandId']) && publicText(value.commandId)
    default: return false
  }
}

/** @param value - Shell-owned reply. @returns Whether only bounded public command result fields are present. */
export function isDesktopPluginCommandResponse(value: unknown): value is DesktopPluginCommandResponse {
  if (!record(value)) return false
  if (value.kind === 'prepared') return keys(value, ['kind'])
  if (value.kind === 'error') return keys(value, ['kind', 'code'])
    && typeof value.code === 'string' && ['busy', 'failed', 'invalid', 'stale', 'unavailable'].includes(value.code)
  if (value.kind !== 'list' || !keys(value, ['kind', 'plugins']) || !Array.isArray(value.plugins) || value.plugins.length > 4096) return false
  const names = new Set<string>()
  return value.plugins.every((row: unknown) => {
    if (!record(row) || !keys(row, ['name', 'version', 'enabled']) || !publicText(row.name)
      || !publicText(row.version) || typeof row.enabled !== 'boolean' || names.has(row.name)) return false
    names.add(row.name)
    return true
  })
}
