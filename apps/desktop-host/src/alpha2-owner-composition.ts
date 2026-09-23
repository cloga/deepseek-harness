/** Desktop-only protected Web row audit before Include warnings and before Loader activation. */
import type { ProfileCompositionGuard } from '@deepseek-ai/dsh/profile-boot'

const protectedModules = {
  webserver: '@deepseek-ai/dsh-host-webserver',
  'web-runtime': '@deepseek-ai/dsh-web-app',
} as const

type ProtectedId = keyof typeof protectedModules
const protectedId = (value: unknown): value is ProtectedId => value === 'webserver' || value === 'web-runtime'
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const refuse = (): never => { throw new Error('desktop alpha2: protected Web carrier composition was replaced') }

/** An Insert may re-index an id so later name-qualified owner overrides are skipped with a warning. */
function beforeCompose(patches: readonly unknown[]): void {
  const counts = { webserver: 0, 'web-runtime': 0 }
  let remaining = 8192
  const visit = (value: unknown, depth: number, inserted: boolean): void => {
    if (--remaining < 0 || depth > 32) refuse()
    if (!record(value)) return
    if (protectedId(value.id)) {
      if (value.name !== undefined && value.name !== protectedModules[value.id]) refuse()
      if (inserted && ++counts[value.id] > 1) refuse()
    }
    if (Array.isArray(value.insert)) for (const child of value.insert) visit(child, depth + 1, true)
    if (Array.isArray(value.config)) for (const child of value.config) visit(child, depth + 1, true)
  }
  for (const patch of patches) visit(patch, 0, false)
  if (counts.webserver !== 1 || counts['web-runtime'] !== 1) refuse()
}

/** The effective rows must contain EXACTLY one official instance with immutable safe config. */
function afterCompose(entries: readonly unknown[]): void {
  const counts = { webserver: 0, 'web-runtime': 0 }
  let remaining = 8192
  const visit = (value: unknown, depth: number): void => {
    if (--remaining < 0 || depth > 32) refuse()
    if (!record(value)) return
    if (protectedId(value.id)) {
      const id = value.id
      const config: Record<string, unknown> = record(value.config) ? value.config : refuse()
      if (++counts[id] > 1 || value.name !== protectedModules[id] || value.disabled !== false
        || !Array.isArray(value.inject) || value.inject.length !== 1 || value.inject[0] !== 'webStartup') refuse()
      if (id === 'webserver') {
        if (config.host !== '127.0.0.1' || config.port !== 0 || config.compression !== 'gzip'
          || config.compressionLevel !== 1 || config.compressionThresholdBytes !== 1024
          || Object.keys(config).length !== 5) refuse()
      } else if (config.openBrowser !== false || config.printUrl !== false || config.surfaceContext !== false
        || !Array.isArray(config.trustedHosts) || config.trustedHosts.length !== 0
        || Object.keys(config).length !== 4) refuse()
    }
    if (value.group === true && Array.isArray(value.config)) {
      for (const child of value.config) visit(child, depth + 1)
    }
  }
  for (const entry of entries) visit(entry, 0)
  if (counts.webserver !== 1 || counts['web-runtime'] !== 1) refuse()
}

/** One application-owner guard, consumed by runProfile before composing/booting any Web row. */
export const alpha2OwnerCompositionGuard: ProfileCompositionGuard = { beforeCompose, afterCompose }
