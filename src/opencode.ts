import type { SessionAccumulator } from './accumulator.js'

/**
 * opencode keeps sessions in SQLite (~/.local/share/opencode/opencode.db). The
 * caller reads the rows; these read one message's or part's fields from message.data
 * and part.data. Times are epoch ms.
 */
export interface OpencodeMessage {
  /** session.directory */
  directory?: string
  /** message.time_created */
  created?: number
  /** $.role */
  role?: string
  /** $.time.completed */
  completed?: number
  /** $.tokens */
  tokens?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }
  /** $.modelID */
  model?: string
  /** $.error.name */
  error?: string
}

export interface OpencodePart {
  /** $.type */
  type?: string
  /** $.state.status */
  status?: string
}

/** A reply is logged when it starts; it's at its completion time if it has one. */
export function ingestOpencodeMessage(acc: SessionAccumulator, m: OpencodeMessage) {
  const you = m.role === 'user'
  const at = you ? m.created : (m.completed ?? m.created)
  if (at === undefined) return
  if (acc.projectPath === undefined && m.directory) acc.projectPath = m.directory
  acc.event(at, you)
  if (you) {
    acc.signals.prompts++
    acc.timeline.push({ at, k: 'prompt' })
  }
  if (m.error === 'MessageAbortedError') {
    acc.signals.interrupts++
    acc.timeline.push({ at, k: 'interrupt' })
  }
  if (you) return
  if (m.model) acc.model = m.model
  const t = m.tokens ?? {}
  // Reasoning tokens are output tokens.
  acc.addTokens({ input: t.input ?? 0, output: (t.output ?? 0) + (t.reasoning ?? 0), cacheRead: t.cacheRead ?? 0, cacheWrite: t.cacheWrite ?? 0 }, at)
}

/** Parts hold tool calls; only whether each one failed is read. */
export function ingestOpencodePart(acc: SessionAccumulator, p: OpencodePart) {
  if (p.type !== 'tool') return
  acc.signals.toolCalls++
  if (p.status === 'error') acc.signals.failedCalls++
}
