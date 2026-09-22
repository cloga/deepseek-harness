/** Serializable Desktop failure diagnostics. */

import { DesktopProvisioningOverrideError } from './project-manager.ts'
import type { DesktopBackendState } from './backend-controller.ts'

/**
 * Preserve nested diagnostics when sending failures to a renderer.
 * @param error - Startup or runtime failure.
 * @returns Serializable error state.
 */
export function desktopErrorState(error: unknown): Extract<DesktopBackendState, { phase: 'error' }> {
  const message = error instanceof AggregateError
    ? [error.message, ...error.errors.map(item => desktopErrorState(item).message)].join('\n')
    : error instanceof Error ? error.message : String(error)
  if (error instanceof DesktopProvisioningOverrideError) {
    return { phase: 'error', message, recovery: {
      type: 'restore-planned-source', packageName: error.packageName, requestedVersion: error.requestedVersion,
    } }
  }
  if (error instanceof AggregateError) {
    const recoveries = error.errors.map(item => desktopErrorState(item).recovery).filter(item => item !== undefined)
    const unique = new Map(recoveries.map(item => [`${item.packageName}\0${item.requestedVersion}`, item]))
    const recovery = unique.size === 1 ? [...unique.values()][0] : undefined
    return { phase: 'error', message, ...(recovery === undefined ? {} : { recovery }) }
  }
  return { phase: 'error', message }
}
