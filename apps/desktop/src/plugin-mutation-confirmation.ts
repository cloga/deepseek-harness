/** Fresh active-work consent at the serialized plugin transaction's interruption point. */
import type { DesktopUpdateImpact } from './host-process.ts'
import type { DesktopRendererUpdateImpact } from './ipc.ts'
import { formatDesktopMessage, type DesktopMessages } from './locale.ts'

/** Minimal work snapshot; identities detect replacement while a native dialog is open. */
export interface DesktopPluginMutationImpact {
  readonly host: DesktopUpdateImpact
  readonly renderer: DesktopRendererUpdateImpact
  readonly hostIdentity: unknown
  readonly rendererIdentity: unknown
}

/** A declined mutation must not enter activation or replace the running application page. */
export class DesktopPluginMutationCancelled extends Error {}

function unchanged(left: DesktopPluginMutationImpact, right: DesktopPluginMutationImpact): boolean {
  return left.hostIdentity === right.hostIdentity && left.rendererIdentity === right.rendererIdentity
    && left.host.runningSessions === right.host.runningSessions
    && left.host.queuedMessages === right.host.queuedMessages
    && left.host.runningJobs === right.host.runningJobs
    && left.renderer.hasDraft === right.renderer.hasDraft
    && left.renderer.attachmentCount === right.renderer.attachmentCount
    && left.renderer.submitting === right.renderer.submitting
}

/**
 * Confirm a plugin mutation against work read immediately before interruption.
 * @param options - Fresh readers, native-dialog callback and shell lifetime.
 * @returns After the user accepts an unchanged snapshot; rejects on cancellation or unreadable impact.
 */
export async function confirmDesktopPluginMutation(options: {
  readonly messages: DesktopMessages
  readonly readImpact: (signal: AbortSignal) => Promise<DesktopPluginMutationImpact>
  readonly confirm: (detail: string) => Promise<boolean>
  readonly cancelled: () => boolean
  readonly signal?: AbortSignal
}): Promise<void> {
  const { messages, readImpact, confirm, signal } = options
  const cancelled = (): boolean => options.cancelled() || signal?.aborted === true
  const read = async (): Promise<DesktopPluginMutationImpact> => {
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted === true) abort()
    const timer = setTimeout(abort, 5000)
    try { return await readImpact(controller.signal) } catch (_error) {
      if (cancelled()) throw new DesktopPluginMutationCancelled(messages.pluginMutationCancelled)
      throw new Error(messages.pluginImpactUnavailable)
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }
  if (cancelled()) throw new DesktopPluginMutationCancelled(messages.pluginMutationCancelled)
  let impact = await read()
  for (;;) {
    if (cancelled()) throw new DesktopPluginMutationCancelled(messages.pluginMutationCancelled)
    const accepted = await confirm(formatDesktopMessage(messages.pluginMutationDetail, {
      runningSessions: String(impact.host.runningSessions), queuedMessages: String(impact.host.queuedMessages),
      runningJobs: String(impact.host.runningJobs), draft: impact.renderer.hasDraft ? messages.yes : messages.no,
      attachments: String(impact.renderer.attachmentCount), submitting: impact.renderer.submitting ? messages.yes : messages.no,
    }))
    if (!accepted || cancelled()) throw new DesktopPluginMutationCancelled(messages.pluginMutationCancelled)
    const current = await read()
    if (cancelled()) throw new DesktopPluginMutationCancelled(messages.pluginMutationCancelled)
    if (unchanged(impact, current)) return
    impact = current
  }
}
