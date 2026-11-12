import { sequence, type SessionEvent, type SessionInfo } from './events.js'
import { callDraft } from './commands.js'
import { parseISO } from './types.js'

/**
 * Agents that keep sessions in a database instead of a log: the caller reads the
 * rows (only the fields below) and passes them in; each reader turns a row into events.
 */

/**
 * opencode (~/.local/share/opencode/opencode.db): fields of message.data and
 * part.data. Times are epoch ms.
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
  /** $.callID */
  callId?: string
  /** $.tool */
  tool?: string
  /** $.state.status */
  status?: string
  /** $.state.time.start and $.state.time.end */
  start?: number
  end?: number
}

export function opencodeReader() {
  const info: SessionInfo = {}
  const number = sequence()
  let calls = 0
  return {
    info,
    /** A reply is logged when it starts; it's at its completion time if it has one. */
    message(m: OpencodeMessage): SessionEvent[] {
      const you = m.role === 'user'
      const at = you ? m.created : (m.completed ?? m.created)
      if (at === undefined) return []
      if (info.cwd === undefined && m.directory) info.cwd = m.directory
      if (you) return [number({ at, by: 'you', k: 'prompt', origin: 'typed' })]
      if (m.model) info.model = m.model
      const t = m.tokens ?? {}
      return [
        number({ at, by: 'agent', k: 'reply' }),
        ...(m.error === 'MessageAbortedError' ? [number({ at, by: 'you', k: 'interrupt' })] : []),
        // Reasoning tokens are output tokens.
        number({ at, by: 'agent', k: 'usage', tokens: { input: t.input ?? 0, output: (t.output ?? 0) + (t.reasoning ?? 0), cacheRead: t.cacheRead ?? 0, cacheWrite: t.cacheWrite ?? 0 } }),
      ]
    },
    /** A tool part: the call when it started, and its result when it ended. */
    part(p: OpencodePart): SessionEvent[] {
      if (p.type !== 'tool' || p.start === undefined) return []
      const call = p.callId ?? `call-${++calls}`
      const events = [number(callDraft(p.start, call, p.tool ?? 'unknown'))]
      const status = p.status === 'completed' ? 'ok' : p.status === 'error' ? 'failed' : undefined
      if (status) events.push(number({ at: p.end ?? p.start, by: 'agent', k: 'result', call, status }))
      return events
    },
  }
}

/**
 * Cursor keeps each chat message as a `bubbleId:<composerId>:<bubbleId>` row in its
 * global state DB. Read only these fields: the same table holds credentials.
 * Cursor rarely stores token counts locally.
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

export function cursorReader() {
  const info: SessionInfo = {}
  const number = sequence()
  return {
    info,
    bubble(b: CursorBubble): SessionEvent[] {
      const at = parseISO(b.createdAt)
      if (at === undefined) return []
      if (b.type === 1) return [number({ at, by: 'you', k: 'prompt', origin: 'typed' })]
      if (b.model && b.model !== 'default') info.model = b.model
      const events = [number({ at, by: 'agent', k: 'reply' })]
      if (b.inputTokens || b.outputTokens) events.push(number({ at, by: 'agent', k: 'usage', tokens: { input: b.inputTokens ?? 0, output: b.outputTokens ?? 0, cacheRead: 0, cacheWrite: 0 } }))
      return events
    },
  }
}

/**
 * Zed's agent threads (threads.db) don't timestamp messages, so the only event is
 * the thread's updated_at changing. Pass the row each time it changes.
 */
export interface ZedThread {
  /** updated_at, ISO 8601 */
  updatedAt?: string
  /** folder_paths: a JSON list or newline-separated */
  folders?: string
}

export function zedReader() {
  const info: SessionInfo = {}
  const number = sequence()
  return {
    info,
    thread(t: ZedThread): SessionEvent[] {
      const at = parseISO(t.updatedAt)
      if (at === undefined) return []
      if (info.cwd === undefined && t.folders) info.cwd = firstFolder(t.folders)
      return [number({ at, by: 'agent', k: 'system', what: 'thread_updated' })]
    },
  }
}

function firstFolder(raw: string): string | undefined {
  if (raw.startsWith('[')) {
    try {
      const list = JSON.parse(raw) as unknown
      if (Array.isArray(list) && typeof list[0] === 'string') return list[0]
    } catch {
      // Fall through to newline-separated.
    }
  }
  return raw.split('\n')[0] || undefined
}
