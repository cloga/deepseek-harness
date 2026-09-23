/** Own JSON-only Webserver boot rows once before sending private Desktop IPC. */
import { renderIndexInjections, type IndexInjection } from '@deepseek-ai/dsh-host-webserver'

export const MAX_ALPHA2_INJECTION_BYTES = 4 * 1024 * 1024
const MAX_ROWS = 4096
const MAX_NODES = 8192
const MAX_DEPTH = 16

const invalid = (): never => { throw new Error('desktop alpha2: client module table is invalid') }
const tooLarge = (): never => { throw new Error('desktop alpha2: client module table exceeds its byte bound') }

interface Budget { bytes: number; nodes: number }

function text(value: unknown, budget: Budget): string {
  if (typeof value !== 'string') return invalid()
  budget.bytes -= Buffer.byteLength(value, 'utf8')
  if (budget.bytes < 0) tooLarge()
  return value
}

/** Read own data DESCRIPTORS, not accessors/toJSON or inherited Cordis objects. */
function fields(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalid()
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) invalid()
  const owned: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  const descriptors = Object.getOwnPropertyDescriptors(value)
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') return invalid()
    const descriptor = descriptors[key]
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) invalid()
    owned[key] = descriptor.value
  }
  return owned
}

function keysAre(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value)
  return keys.length === expected.length && expected.every(key => Object.hasOwn(value, key))
}

function placement(value: unknown): 'head' | 'body' {
  return value === 'head' || value === 'body' ? value : invalid()
}

/** Snapshot only bounded JSON leaves. No live Service, Session, getter or user toJSON is invoked. */
function ownJson(value: unknown, budget: Budget, active: WeakSet<object>, depth: number): unknown {
  if (value === null || typeof value === 'boolean' || value === undefined) return value
  if (typeof value === 'string') return text(value, budget)
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) invalid()
    return value
  }
  if (typeof value !== 'object' || ++depth > MAX_DEPTH || --budget.nodes < 0 || active.has(value)) invalid()
  active.add(value)
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || value.length > MAX_NODES) invalid()
      const keys = Reflect.ownKeys(value)
      if (keys.length !== value.length + 1 || keys.some(key => typeof key !== 'string')) invalid()
      const result: unknown[] = []
      for (let index = 0; index < value.length; index++) {
        const element = Object.getOwnPropertyDescriptor(value, String(index))
        if (element === undefined || !('value' in element)) return invalid()
        result.push(ownJson(element.value === undefined ? null : element.value, budget, active, depth))
      }
      return Object.freeze(result)
    }
    const source = fields(value)
    const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>
    for (const [key, child] of Object.entries(source)) {
      text(key, budget)
      if (--budget.nodes < 0) invalid()
      // JSON drops optional undefined object fields. Never run source toJSON.
      if (child !== undefined) result[key] = ownJson(child, budget, active, depth)
    }
    return Object.freeze(result)
  } finally { active.delete(value) }
}

function snapshotRow(value: IndexInjection, budget: Budget, active: WeakSet<object>): IndexInjection {
  if (--budget.nodes < 0) invalid()
  const row = fields(value)
  switch (row.kind) {
    case 'global':
      if (!keysAre(row, ['kind', 'name', 'value'])) invalid()
      return Object.freeze({ kind: 'global', name: text(row.name, budget),
        value: ownJson(row.value, budget, active, 0) })
    case 'script':
      if (!keysAre(row, ['kind', 'placement', 'text'])) return invalid()
      return Object.freeze({ kind: 'script', placement: placement(row.placement), text: text(row.text, budget) })
    case 'script-src':
      if (!keysAre(row, ['kind', 'placement', 'src'])) return invalid()
      return Object.freeze({ kind: 'script-src', placement: placement(row.placement), src: text(row.src, budget) })
    case 'script-preload':
      if (!keysAre(row, ['kind', 'src'])) invalid()
      return Object.freeze({ kind: 'script-preload', src: text(row.src, budget) })
    case 'style':
      if (!keysAre(row, ['kind', 'text'])) invalid()
      return Object.freeze({ kind: 'style', text: text(row.text, budget) })
    case 'html':
      if (!keysAre(row, ['kind', 'placement', 'html'])) return invalid()
      return Object.freeze({ kind: 'html', placement: placement(row.placement), html: text(row.html, budget) })
    default: return invalid()
  }
}

/**
 * Return an IMMUTABLE owned table and bound its JSON serialization and
 * official HTML rendering. This does not bound the whole parent packet's
 * separate URL/package-health fields. Never transfer mutable event rows.
 */
export function snapshotAlpha2Injections(rows: readonly IndexInjection[]): readonly IndexInjection[] {
  if (!Array.isArray(rows) || Object.getPrototypeOf(rows) !== Array.prototype) return invalid()
  if (rows.length > MAX_ROWS) throw new Error('desktop alpha2: client module table exceeds its bound')
  const keys = Reflect.ownKeys(rows)
  if (keys.length !== rows.length + 1 || keys.some(key => typeof key !== 'string')) return invalid()
  const budget: Budget = { bytes: MAX_ALPHA2_INJECTION_BYTES, nodes: MAX_NODES }
  const active = new WeakSet<object>()
  const owned: IndexInjection[] = []
  for (let index = 0; index < rows.length; index++) {
    const element = Object.getOwnPropertyDescriptor(rows, String(index))
    if (element === undefined || !('value' in element)) return invalid()
    owned.push(snapshotRow(element.value as IndexInjection, budget, active))
  }
  const snapshot = Object.freeze(owned)
  let serialized: string
  let html: string
  try {
    serialized = JSON.stringify(snapshot)
    html = renderIndexInjections('<html><head></head><body></body></html>', snapshot)
  } catch { return invalid() }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ALPHA2_INJECTION_BYTES
    || Buffer.byteLength(html, 'utf8') > MAX_ALPHA2_INJECTION_BYTES) tooLarge()
  return snapshot
}
