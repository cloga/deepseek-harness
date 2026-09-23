/** Shared Auto mode rows for the slash-command popup and composer menu. */

import type { ModelRoutingMode } from '@deepseek-ai/dsh-api-session-controller/types'
import type { ModelKey } from './locales.ts'

/** Locale keys for the closed Host-owned mode vocabulary. */
export const AUTO_MODE_LABELS = {
  efficiency: 'auto.efficiency',
  balanced: 'auto.balanced',
  intelligence: 'auto.intelligence',
} as const satisfies Record<ModelRoutingMode, ModelKey>

/** Opaque command-row identities, never provider or model identifiers. */
export const AUTO_MODE_ROWS = [
  { id: 'auto-mode:efficiency', mode: 'efficiency', detail: 'auto.efficiencyDetail' },
  { id: 'auto-mode:balanced', mode: 'balanced', detail: 'auto.balancedDetail' },
  { id: 'auto-mode:intelligence', mode: 'intelligence', detail: 'auto.intelligenceDetail' },
] as const satisfies readonly { id: string; mode: ModelRoutingMode; detail: ModelKey }[]
