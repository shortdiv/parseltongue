import type { SessionAccumulator } from './accumulator.js'
import { parseISO } from './types.js'

/**
 * Cursor keeps each chat message as a `bubbleId:<composerId>:<bubbleId>` row in its
 * global state DB. The caller reads the rows (and only these fields: the same table
 * holds credentials). Cursor rarely stores token counts locally.
 */
export interface CursorBubble {
  /** $.createdAt, ISO 8601 */
  createdAt?: string
  /** $.type: 1 is you, 2 the agent */
  type?: number
  /** $.tokenCount.inputTokens */
  inputTokens?: number
  /** $.tokenCount.outputTokens */
  outputTokens?: number
  /** $.modelInfo.modelName */
  model?: string
}

export function ingestCursorBubble(acc: SessionAccumulator, b: CursorBubble) {
  const at = parseISO(b.createdAt)
  if (at === undefined) return
  const you = b.type === 1
  acc.event(at, you)
  if (you) {
    acc.signals.prompts++
    acc.timeline.push({ at, k: 'prompt' })
  }
  if (b.model && b.model !== 'default') acc.model = b.model
  if (b.inputTokens || b.outputTokens) acc.addTokens({ input: b.inputTokens ?? 0, output: b.outputTokens ?? 0, cacheRead: 0, cacheWrite: 0 }, at)
}
