/** Localized native review of a backend-validated registry resolution. */
import { formatDesktopMessage, type DesktopMessages } from './locale.ts'
import type { DesktopPreparedRegistryTarget } from './profile-package-staging.ts'

/**
 * Display exact prepared identity without exposing an artifact URL's path or query.
 * @param target - Shell-private resolution already validated against the sealed candidate.
 * @param messages - Active native locale.
 * @returns Review details, or undefined for non-registry transactions.
 */
export function desktopRegistryConfirmationDetail(
  target: DesktopPreparedRegistryTarget | undefined,
  messages: DesktopMessages,
): string | undefined {
  if (target === undefined) return undefined
  const selection = formatDesktopMessage(messages.packageRegistrySelection, {
    spec: target.requestedSpec, name: target.packageName, version: target.version,
    registry: target.registry, integrity: target.integrity,
  })
  const artifactOrigin = target.tarball === undefined ? undefined : new URL(target.tarball).origin
  if (artifactOrigin === undefined || artifactOrigin === new URL(target.registry).origin) return selection
  return `${selection}\n\n${formatDesktopMessage(messages.packageRegistryArtifactOrigin, { origin: artifactOrigin })}`
}
