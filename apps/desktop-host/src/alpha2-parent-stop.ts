/** One reversible parent-channel and profile-shutdown lifetime for the dormant alpha2 Host. */

interface BootedApplication {
  readonly shutdown: { shutdown(code: number): Promise<void> }
}

/** The exact parent actions, supplied by the Node process entry (and inert tests). */
export interface Alpha2ParentStopPort {
  closeBridge(): void
  application(): Promise<BootedApplication> | undefined
  acknowledge(): Promise<void>
  connected(): boolean
  disconnect(): void
  detach(): void
}

/**
 * Coalesce shutdown; dispose the tree before ACK, then close IPC even if ACK
 * delivery fails. Never hide a failed tree cleanup behind a disconnect error.
 */
export function createAlpha2ParentStop(port: Alpha2ParentStopPort): () => Promise<void> {
  let pending: Promise<void> | undefined
  return () => pending ??= (async () => {
    const failures: unknown[] = []
    try {
      port.closeBridge()
      const running = await port.application()?.catch(() => undefined)
      await running?.shutdown.shutdown(0)
      if (port.connected()) await port.acknowledge().catch(() => {})
    } catch (error) { failures.push(error) }
    try { port.detach() } catch (error) { failures.push(error) }
    try { if (port.connected()) port.disconnect() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'desktop alpha2: parent and profile cleanup failed')
  })()
}
