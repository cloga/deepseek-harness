/** Fail-closed unsent-input admission layered onto the official Host task lock. */
import { parseDesktopRendererUpdateImpact, type DesktopRendererUpdateImpact } from './ipc.ts'
import { DesktopUpdatePreparationError } from './update-error.ts'

/** One main-document generation's aggregate Conversation safety state. */
export class DesktopUpdateInputGuard {
  private impact: DesktopRendererUpdateImpact | undefined
  private revision = 0

  /** Invalidate a replaced, closed, or failed main document before accepting its replacement. */
  reset(): void {
    this.impact = undefined
    this.revision++
  }

  /** @param value - Fixed main-frame IPC report; rejected reports invalidate the previous safe state. */
  report(value: unknown): void {
    let impact: DesktopRendererUpdateImpact
    try { impact = parseDesktopRendererUpdateImpact(value) } catch (error) { this.reset(); throw error }
    if (this.impact?.hasDraft === impact.hasDraft && this.impact.attachmentCount === impact.attachmentCount
      && this.impact.submitting === impact.submitting) return
    this.impact = impact
    this.revision++
  }

  /**
   * Require a known empty document, optionally unchanged since confirmation.
   * @param message - Localized instruction to preserve input before retrying.
   * @param expected - Revision captured before the confirmation, when rechecking admission.
   * @returns Revision suitable for a later post-lock recheck.
   */
  check(message: string, expected?: number): number {
    if (this.impact === undefined || this.impact.hasDraft || this.impact.attachmentCount > 0 || this.impact.submitting
      || (expected !== undefined && expected !== this.revision)) {
      throw new DesktopUpdatePreparationError('unsaved-input', message)
    }
    return this.revision
  }
}
