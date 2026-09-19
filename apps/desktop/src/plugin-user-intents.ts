/** Durable user removal intent, distinct from source verification and release ownership. */
import { randomUUID } from 'node:crypto'
import { closeSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'

export const DESKTOP_PLUGIN_USER_INTENTS_FILE = 'desktop-plugin-user-intents.json'

/** The observed plan is diagnostic context only: a later plan never expires a user's removal choice. */
export interface DesktopPluginRemovalIntent {
  readonly observedPlanSha256?: string
}
export interface DesktopPluginUserIntents {
  readonly schemaVersion: 1
  readonly removed: Readonly<Record<string, DesktopPluginRemovalIntent>>
}
const MAX_BYTES = 1024 * 1024
const MAX_REMOVALS = 1024
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/u
const CANDIDATE_PARENT = /^\..+\.package-stage-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u
function fail(): never { throw new Error('desktop plugin user intents: invalid evidence or non-candidate write') }
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value) }
function packageName(name: string): void { if (name.length > 214 || !PACKAGE_NAME.test(name)) fail() }
function directories(path: string, allowMissing: boolean): void {
  if (!isAbsolute(path)) fail()
  let first = true
  for (let current = resolve(path); ; current = dirname(current)) {
    const stat = lstatSync(current, { throwIfNoEntry: false })
    if (stat === undefined) {
      if (!(allowMissing && first)) fail()
    } else if (!stat.isDirectory() || stat.isSymbolicLink()) fail()
    if (dirname(current) === current) break
    first = false
  }
}
function candidate(path: string): void {
  directories(path, false)
  if (basename(path) !== 'profile' || !CANDIDATE_PARENT.test(basename(dirname(path)))) fail()
}

/**
 * Read only explicit removal choices; absence is not proof of a fresh profile or release ownership.
 * @param profileDir - Real active or candidate profile directory supplied by its owner.
 * @returns A small owned record; unknown fields, unsafe paths and malformed evidence fail closed.
 */
export function readDesktopPluginUserIntents(profileDir: string): DesktopPluginUserIntents {
  directories(profileDir, true)
  const path = join(profileDir, DESKTOP_PLUGIN_USER_INTENTS_FILE)
  const stat = lstatSync(path, { throwIfNoEntry: false })
  const removed = Object.create(null) as Record<string, DesktopPluginRemovalIntent>
  if (stat === undefined) return { schemaVersion: 1, removed }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES) fail()
  const bytes = readFileSync(path)
  const text = bytes.toString('utf8')
  if (!Buffer.from(text).equals(bytes)) fail()
  const input: unknown = JSON.parse(text)
  if (!record(input) || input.schemaVersion !== 1 || !record(input.removed)
    || Object.keys(input).sort().join(',') !== 'removed,schemaVersion' || Object.keys(input.removed).length > MAX_REMOVALS) fail()
  for (const [name, value] of Object.entries(input.removed)) {
    packageName(name)
    if (!record(value) || Object.keys(value).some(key => key !== 'observedPlanSha256')
      || (value.observedPlanSha256 !== undefined && (typeof value.observedPlanSha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.observedPlanSha256)))) fail()
    removed[name] = value.observedPlanSha256 === undefined ? {} : { observedPlanSha256: value.observedPlanSha256 }
  }
  return { schemaVersion: 1, removed }
}

function writeCandidate(profileDir: string, removed: Readonly<Record<string, DesktopPluginRemovalIntent>>): void {
  candidate(profileDir)
  if (Object.keys(removed).length > MAX_REMOVALS) fail()
  const bytes = `${JSON.stringify({ schemaVersion: 1, removed }, undefined, 2)}\n`
  if (Buffer.byteLength(bytes) > MAX_BYTES) fail()
  const target = join(profileDir, DESKTOP_PLUGIN_USER_INTENTS_FILE)
  const temporary = join(profileDir, `.plugin-user-intents-${randomUUID()}.tmp`)
  const fd = openSync(temporary, 'wx', 0o600)
  let renamed = false
  try {
    try { writeFileSync(fd, bytes); fsyncSync(fd) } finally { closeSync(fd) }
    renameSync(temporary, target)
    renamed = true
    if (process.platform !== 'win32') {
      const directory = openSync(profileDir, 'r')
      try { fsyncSync(directory) } finally { closeSync(directory) }
    }
  } catch (error) {
    if (!renamed) {
      try { unlinkSync(temporary) } catch (cleanupError) {
        if ((cleanupError as NodeJS.ErrnoException).code !== 'ENOENT') throw new AggregateError([error, cleanupError], 'desktop plugin user intents: write and cleanup failed')
      }
    }
    throw error
  }
}

/**
 * Mark a manual removal in a private candidate under the caller's existing profile lease.
 * @param candidateDir - Transaction/profile directory whose ownership the backend already validated.
 * @param name - Removed package name.
 * @param observedPlanSha256 - Optional plan context, never an expiry or permission to reinstall.
 * @returns Whether a new intent was written; an existing intent is preserved across plan changes.
 */
export function markDesktopPluginRemoved(candidateDir: string, name: string, observedPlanSha256?: string): boolean {
  candidate(candidateDir); packageName(name)
  if (observedPlanSha256 !== undefined && !/^[a-f0-9]{64}$/u.test(observedPlanSha256)) fail()
  const previous = readDesktopPluginUserIntents(candidateDir)
  if (Object.hasOwn(previous.removed, name)) return false
  writeCandidate(candidateDir, { ...previous.removed, [name]: observedPlanSha256 === undefined ? {} : { observedPlanSha256 } })
  return true
}

/**
 * Clear only the installed target's removal intent in the candidate; activation commits it and rollback restores the old choice.
 * @param candidateDir - Backend-owned transaction/profile directory under its caller-held lease.
 * @param name - Explicitly reinstalled package name.
 * @returns Whether a recorded intent was removed.
 */
export function clearDesktopPluginRemoval(candidateDir: string, name: string): boolean {
  candidate(candidateDir); packageName(name)
  const previous = readDesktopPluginUserIntents(candidateDir)
  if (!Object.hasOwn(previous.removed, name)) return false
  writeCandidate(candidateDir, Object.fromEntries(Object.entries(previous.removed).filter(([key]) => key !== name)))
  return true
}
