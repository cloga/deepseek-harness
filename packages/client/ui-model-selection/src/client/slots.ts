/** Model selector injection; the renderer binds the shared directory to useDirectory. */

import type { ModelSelection, ModelRoutingMode } from '@deepseek-ai/dsh-api-session-controller/types'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { ModelDirectoryState } from './directory.ts'

/** Registration-owned sources and callbacks for the composer model seat. */
export interface ModelSelectInjection {
  /** Whether this session supports Agent-bound model inspection and selection. */
  available: boolean
  /** The renderer alone subscribes to this per-session source. */
  hooks: { directory: SnapshotStore<ModelDirectoryState> }
  /** Ensure the shared advisory catalog is loaded (errors land on the store). */
  load: () => void
  /** Read the latest selection error after an operation settles. */
  selectionError: () => string | null
  /**
   * Select an explicit model and optional effort, leaving Auto mode.
   * @param selection - concrete provider/model selection.
   * @returns whether the Host accepted the selection.
   */
  select: (selection: ModelSelection) => Promise<boolean>
  /**
   * Select a task-aware model-and-effort tradeoff without inventing a concrete model.
   * @param mode - requested Auto optimization mode.
   * @returns whether the Host accepted the captured policy.
   */
  selectAuto: (mode: ModelRoutingMode) => Promise<boolean>
}

/** Component props derived from the registration's source-and-callback injection. */
export type ModelSelectInjected = InjectFace<ModelSelectInjection>
