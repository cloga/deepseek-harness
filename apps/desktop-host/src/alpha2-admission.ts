/** Generation-bound private-transport acknowledgment; not a native Core/receipt approval. */
import { randomUUID } from 'node:crypto'

export class Alpha2TransportAdmission {
  readonly generationId = randomUUID()
  private acknowledged = false

  /** Open update admission only after the owning parent accepted the transport packet. */
  async publish(send: () => Promise<void>): Promise<void> {
    await send()
    this.acknowledged = true
  }

  /** A missing, early, or stale generation can never unlock this Host. */
  mayUnlock(requestGeneration: unknown): boolean {
    return this.acknowledged && requestGeneration === this.generationId
  }
}
