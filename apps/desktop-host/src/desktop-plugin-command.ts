/** Dependency-light grammar and registration helpers for `/desktop-plugin`. */

const MAX_RAW_INPUT_BYTES = 1024 * 1024
const PACKAGE_NAME = String.raw`(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)`
const PACKAGE_NAME_PATTERN = new RegExp(`^${PACKAGE_NAME}$`, 'u')
const NPM_RANGE_PATTERN = /^[0-9A-Za-z.*+<>=~^|\s_-]+$/u
const GITHUB_SPEC_PATTERN = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)(?:#([^\s\\:]+))?$/u
const VERSION_PATTERN = new RegExp(
  String.raw`^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)`
  + String.raw`(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$`,
  'u',
)

/** Usage returned for every rejected grammar without echoing untrusted input. */
export const DESKTOP_PLUGIN_COMMAND_USAGE = 'Usage: /desktop-plugin list | install npm <spec> | install github <owner/repo[#ref]> | install release <verified-github-release-json> | remove <package> | update <package> <version> | enable <package> | disable <package> | disable-all'

/** JSON values admitted into an install-release operation. */
export type DesktopPluginJsonValue = null | boolean | number | string
  | readonly DesktopPluginJsonValue[]
  | { readonly [key: string]: DesktopPluginJsonValue }

/** Closed JSON-safe operation sent to the Desktop-owned request implementation. */
export type DesktopPluginCommandOperation =
  | { readonly type: 'list' }
  | { readonly type: 'install'; readonly source: { readonly type: 'npm'; readonly spec: string } }
  | { readonly type: 'install'; readonly source: { readonly type: 'github'; readonly spec: string } }
  | { readonly type: 'install'; readonly source: { readonly type: 'release'; readonly release: { readonly [key: string]: DesktopPluginJsonValue } } }
  | { readonly type: 'remove'; readonly name: string }
  | { readonly type: 'update'; readonly name: string; readonly version: string }
  | { readonly type: 'enable'; readonly name: string }
  | { readonly type: 'disable'; readonly name: string }
  | { readonly type: 'disable-all' }

/** Minimal installed-plugin fields needed by command output. */
export interface DesktopPluginCommandListRow {
  readonly name: string
  readonly version: string
  readonly enabled: boolean
}

/** Response returned by the injected Desktop request implementation. */
export type DesktopPluginCommandResponse =
  | { readonly type: 'list'; readonly rows: readonly DesktopPluginCommandListRow[] }
  | { readonly type: 'prepared' }
  | { readonly type: 'error'; readonly code: 'busy' | 'failed' | 'invalid' | 'stale' | 'unavailable' }

/** Request callback implemented by the Desktop Host integration. */
export type DesktopPluginCommandRequest = (
  operation: DesktopPluginCommandOperation,
  commandId: string,
  signal: AbortSignal,
) => Promise<DesktopPluginCommandResponse>

/** Structural invocation accepted from the commands service. */
export interface DesktopPluginCommandInvocation {
  readonly commandId: string
  readonly rawInput: string
  readonly signal: AbortSignal
}

/** Structural result returned to the commands service. */
export interface DesktopPluginCommandResult {
  readonly kind: 'success' | 'error'
  readonly text: string
}

/** Structural command definition, independent of commands package types. */
export interface DesktopPluginCommandDefinition {
  readonly name: string
  readonly description: string
  readonly input: { readonly hint: string }
  readonly handler: (invocation: DesktopPluginCommandInvocation) => Promise<DesktopPluginCommandResult>
}

/** Structural registry surface needed to install the command. */
export interface DesktopPluginCommandRegistry {
  register(definition: DesktopPluginCommandDefinition): () => void
}

function invalidCommand(): never {
  throw new Error(`Invalid /desktop-plugin command. ${DESKTOP_PLUGIN_COMMAND_USAGE}`)
}

function onePackage(value: string | undefined): string {
  if (value === undefined || value.length > 256 || !PACKAGE_NAME_PATTERN.test(value)) invalidCommand()
  return value
}

function npmSpec(value: string): string {
  if (value.length === 0 || value.length > MAX_RAW_INPUT_BYTES) invalidCommand()
  const separator = value.startsWith('@') ? value.indexOf('@', value.indexOf('/') + 1) : value.indexOf('@')
  const name = separator < 0 ? value : value.slice(0, separator)
  onePackage(name)
  if (separator >= 0) {
    const range = value.slice(separator + 1)
    if (range.length === 0 || !NPM_RANGE_PATTERN.test(range)) invalidCommand()
  }
  return value
}

function parseReleaseJson(source: string): { readonly [key: string]: DesktopPluginJsonValue } {
  let value: unknown
  try {
    value = JSON.parse(source)
  } catch (_error: unknown) {
    invalidCommand()
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalidCommand()
  return value as { readonly [key: string]: DesktopPluginJsonValue }
}

/**
 * Parse the exact `/desktop-plugin` remainder into a closed operation union.
 * The release object receives only JSON syntax validation; Electron remains the
 * authority for the verified-release schema and trust checks.
 * @param rawInput - Verbatim text after the slash-command name.
 * @returns A JSON-safe operation for the Desktop request callback.
 */
export function parseDesktopPluginCommand(rawInput: string): DesktopPluginCommandOperation {
  if (new TextEncoder().encode(rawInput).byteLength > MAX_RAW_INPUT_BYTES) invalidCommand()
  const input = rawInput.trim()
  if (input === 'list') return { type: 'list' }
  if (input === 'disable-all') return { type: 'disable-all' }

  const firstSpace = input.search(/\s/u)
  const verb = firstSpace < 0 ? input : input.slice(0, firstSpace)
  const remainder = firstSpace < 0 ? '' : input.slice(firstSpace).trim()

  if (verb === 'install') {
    const sourceSpace = remainder.search(/\s/u)
    if (sourceSpace < 0) invalidCommand()
    const sourceType = remainder.slice(0, sourceSpace)
    const sourceInput = remainder.slice(sourceSpace).trim()
    if (sourceType === 'npm') {
      return { type: 'install', source: { type: 'npm', spec: npmSpec(sourceInput) } }
    }
    if (sourceType === 'github') {
      if (sourceInput.length > 4096 || !GITHUB_SPEC_PATTERN.test(sourceInput)) invalidCommand()
      return { type: 'install', source: { type: 'github', spec: sourceInput } }
    }
    if (sourceType === 'release') {
      return { type: 'install', source: { type: 'release', release: parseReleaseJson(sourceInput) } }
    }
    invalidCommand()
  }

  const args = remainder === '' ? [] : remainder.split(/\s+/u)
  if (verb === 'remove' || verb === 'enable' || verb === 'disable') {
    if (args.length !== 1) invalidCommand()
    const name = onePackage(args[0])
    return verb === 'remove' ? { type: 'remove', name } : { type: verb, name }
  }
  if (verb === 'update') {
    const version = args[1]
    if (args.length !== 2 || version === undefined || version.length > 256 || !VERSION_PATTERN.test(version)) invalidCommand()
    return { type: 'update', name: onePackage(args[0]), version }
  }
  return invalidCommand()
}

/**
 * Format installed plugins as deterministic, concise rows.
 * @param rows - Installed plugin records returned by Desktop.
 * @returns Human-readable list output.
 */
export function formatDesktopPluginListRows(rows: readonly DesktopPluginCommandListRow[]): string {
  if (rows.length === 0) return 'No Desktop plugins installed.'
  return [...rows]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map(row => `${row.name}@${row.version} — ${row.enabled ? 'enabled' : 'disabled'}`)
    .join('\n')
}

function renderDesktopPluginCommandError(code: 'busy' | 'failed' | 'invalid' | 'stale' | 'unavailable'): string {
  switch (code) {
    case 'busy': return 'Another Desktop plugin, recovery, or update operation is in progress.'
    case 'invalid': return 'Desktop rejected the plugin request as invalid.'
    case 'stale': return 'Desktop rejected a stale plugin request.'
    case 'unavailable': return 'Desktop plugin management is unavailable.'
    case 'failed': return 'Desktop could not prepare the plugin change. Review Desktop diagnostics for details.'
    default: code satisfies never
  }
  return 'Desktop plugin request failed.'
}

/**
 * Create a structural `/desktop-plugin` command definition.
 * @param request - Desktop-owned operation callback.
 * @returns Definition suitable for the commands registry.
 */
export function createDesktopPluginCommandDefinition(request: DesktopPluginCommandRequest): DesktopPluginCommandDefinition {
  return {
    name: 'desktop-plugin',
    description: 'List or change Desktop Host plugins',
    input: { hint: 'list | install … | remove … | update … | enable … | disable … | disable-all' },
    async handler(invocation) {
      let operation: DesktopPluginCommandOperation
      try {
        operation = parseDesktopPluginCommand(invocation.rawInput)
      } catch (_error: unknown) {
        return { kind: 'error', text: `Invalid command. ${DESKTOP_PLUGIN_COMMAND_USAGE}` }
      }
      try {
        const response = await request(operation, invocation.commandId, invocation.signal)
        if (response.type === 'error') return { kind: 'error', text: renderDesktopPluginCommandError(response.code) }
        if (operation.type === 'list') {
          return response.type === 'list'
            ? { kind: 'success', text: formatDesktopPluginListRows(response.rows) }
            : { kind: 'error', text: 'Desktop plugin list failed.' }
        }
        return response.type === 'prepared'
          ? { kind: 'success', text: 'Plugin change prepared. Review the native confirmation to restart the Desktop Host.' }
          : { kind: 'error', text: 'Desktop plugin change failed.' }
      } catch (_error: unknown) {
        return { kind: 'error', text: 'Desktop plugin request failed.' }
      }
    },
  }
}

/** Structural lifecycle adapter owned by the active Desktop Host context. */
export interface DesktopPluginCommandRuntime {
  readonly commands: DesktopPluginCommandRegistry
  effect(register: () => () => void): void
  onSessionEvent(listener: (event: { readonly type: string; readonly data: Record<string, unknown> }) => void): void
}

/**
 * Register the built-in command and bind its durable lifecycle acknowledgement.
 * @param runtime - Active Desktop Host command registry and Session event adapter.
 * @param request - Exact-parent IPC request callback.
 * @param settled - Acknowledge the matching `command/done` event.
 */
export function registerDesktopPluginCommandRuntime(
  runtime: DesktopPluginCommandRuntime,
  request: DesktopPluginCommandRequest,
  settled: (commandId: string) => void,
): void {
  runtime.effect(() => registerDesktopPluginCommand(runtime.commands, request))
  runtime.onSessionEvent((event) => {
    if (event.type === 'command/done' && typeof event.data.commandId === 'string') settled(event.data.commandId)
  })
}

/**
 * Register `/desktop-plugin` through structural dependencies.
 * @param registry - Command registry supplied by the parent integration.
 * @param request - Desktop-owned operation callback.
 * @returns Disposer returned by the registry.
 */
export function registerDesktopPluginCommand(
  registry: DesktopPluginCommandRegistry,
  request: DesktopPluginCommandRequest,
): () => void {
  return registry.register(createDesktopPluginCommandDefinition(request))
}
