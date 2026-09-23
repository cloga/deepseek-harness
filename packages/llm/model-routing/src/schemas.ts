/** Shared validation of captured Auto configuration at durable projection boundaries. */

import { z } from 'zod'
import { parseRoutingPolicy } from './policy.ts'
import { parseRoutingClassifierConfig } from './classifier.ts'
import type { AutoSelection } from './routing-state.ts'

/** A complete captured user preference with detached, validated model policies. */
export const autoSelectionSchema: z.ZodType<AutoSelection> = z.object({
  mode: z.enum(['efficiency', 'balanced', 'intelligence']),
  policy: z.unknown().transform(parseRoutingPolicy),
  classifier: z.unknown().transform(parseRoutingClassifierConfig),
}).strict()
