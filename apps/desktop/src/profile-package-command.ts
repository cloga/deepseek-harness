/** Shell-private command data parsing; admission and consent remain owned by the active Electron shell. */
import { valid } from 'semver'
import type { ProfilePackageMutation } from '@deepseek-ai/dsh-app-boot'

const PACKAGE_NAME = /^(?:@[a-z0-9._~-]+\/)?[a-z0-9][a-z0-9._~-]*$/u
const GENERATION = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u

/** Data identifying a command origin; parsing it does not authenticate its authority. */
export interface DesktopPackageCommandOrigin {
  readonly kind: 'desktop-command'
  readonly generation: string
  readonly requestId: number
  readonly commandId: string
}

/** Requested bundle selection; all is a disable-only request, not a stored target set. */
export interface DesktopPackageSelectionRequest {
  readonly names: readonly string[] | 'all'
  readonly enabled: boolean
}

/** Canonical concrete selection recorded by the shell's staging owner. */
export interface DesktopPackageSelectionMutation {
  readonly kind: 'selection'
  readonly packageNames: readonly string[]
  readonly enabled: boolean
}

/** Shell-private command work; ordinary package mutation parsing belongs to the existing staging owner. */
export type DesktopPackageCommandRequest =
  | { readonly kind: 'mutation'; readonly mutation: ProfilePackageMutation }
  | ({ readonly kind: 'selection' } & DesktopPackageSelectionRequest)
  | { readonly kind: 'registry-update'; readonly name: string; readonly version: string }

function fail(subject: string): never {
  throw new Error(`desktop package command: invalid ${subject}`)
}

function fields(value: unknown, expected: readonly string[], subject: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(subject)
  const own = Reflect.ownKeys(value)
  if (own.length !== expected.length || expected.some(key => !Object.hasOwn(value, key))) fail(subject)
  return Object.fromEntries(expected.map((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor?.enumerable !== true || !Object.hasOwn(descriptor, 'value')) fail(subject)
    const leaf: unknown = descriptor.value
    return [key, leaf]
  }))
}

function packageName(value: unknown): string {
  if (typeof value !== 'string' || value.length > 214 || !PACKAGE_NAME.test(value)) fail('package name')
  return value
}

function packageNames(value: unknown, requireSorted: boolean): readonly string[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 100
    || Reflect.ownKeys(value).length !== value.length + 1) fail('selection targets')
  const names: string[] = []
  for (let index = 0; index < value.length; index++) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
    if (descriptor === undefined || !Object.hasOwn(descriptor, 'value')) fail('selection targets')
    const item: unknown = descriptor.value
    names.push(packageName(item))
  }
  if (new Set(names).size !== names.length) fail('duplicate selection targets')
  const sorted = [...names].sort()
  if (requireSorted && names.some((name, index) => name !== sorted[index])) fail('noncanonical selection targets')
  return Object.freeze(sorted)
}

/**
 * Validate and snapshot the exact command-origin data, without granting activation authority.
 * @param value - Untrusted private record.
 * @returns Owned command-origin fields; the shell must independently bind the current generation and command.
 */
export function parseDesktopPackageCommandOrigin(value: unknown): DesktopPackageCommandOrigin {
  const input = fields(value, ['kind', 'generation', 'requestId', 'commandId'], 'command origin')
  if (input.kind !== 'desktop-command' || typeof input.generation !== 'string' || !GENERATION.test(input.generation)
    || typeof input.requestId !== 'number' || !Number.isSafeInteger(input.requestId) || input.requestId <= 0
    || typeof input.commandId !== 'string' || input.commandId.length < 1 || input.commandId.length > 256) fail('command origin')
  return Object.freeze({ kind: 'desktop-command', generation: input.generation, requestId: input.requestId, commandId: input.commandId })
}

/**
 * Validate requested names and take a canonical owned target snapshot.
 * @param value - Exact names/enabled request; all is accepted only for disabling.
 * @returns Owned selection request, without checking installation or ownership.
 */
export function parseDesktopPackageSelectionRequest(value: unknown): DesktopPackageSelectionRequest {
  const input = fields(value, ['names', 'enabled'], 'selection request')
  if (typeof input.enabled !== 'boolean') fail('selection request')
  if (input.names === 'all') {
    if (input.enabled) fail('enable-all request')
    return Object.freeze({ names: 'all', enabled: false })
  }
  return Object.freeze({ names: packageNames(input.names, false), enabled: input.enabled })
}

/**
 * Validate an already-canonical concrete journal mutation, never converting all into an invented package name.
 * @param value - Exact kind/packageNames/enabled record.
 * @returns Owned selection mutation; unsorted or duplicate stored targets are rejected.
 */
export function parseDesktopPackageSelectionMutation(value: unknown): DesktopPackageSelectionMutation {
  const input = fields(value, ['kind', 'packageNames', 'enabled'], 'selection mutation')
  if (input.kind !== 'selection' || typeof input.enabled !== 'boolean') fail('selection mutation')
  return Object.freeze({ kind: 'selection', packageNames: packageNames(input.packageNames, true), enabled: input.enabled })
}

/**
 * Parse a registry update without accepting a source selector or normalized version spelling.
 * @param name - Exact installed package name; installation and source ownership are checked by the staging owner.
 * @param version - Canonical semantic version, not a tag, range or source specification.
 * @returns Owned registry-update request; this does not permit replacing source-owned packages with registry packages.
 */
export function parseDesktopRegistryUpdate(
  name: unknown, version: unknown,
): Extract<DesktopPackageCommandRequest, { kind: 'registry-update' }> {
  const target = packageName(name)
  if (typeof version !== 'string' || version.length > 256 || version.trim() !== version) fail('registry update version')
  const normalized = valid(version)
  if (normalized === null || normalized !== version.split('+')[0]) fail('registry update version')
  return Object.freeze({ kind: 'registry-update', name: target, version })
}
