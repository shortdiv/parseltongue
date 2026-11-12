import { sequence, type SessionEvent, type SessionInfo } from './events.js'
import { callDraft } from './commands.js'
import { parseISO } from './util.js'

/**
 * Agents that keep sessions in a database instead of a log: the caller reads the
 * rows (only the fields below) and passes them in; each reader turns a row into events.
 * A row is updated in place, so it can be passed again as it changes: each reader keeps
 * a ledger of what it has emitted per id and only emits what's new.
 */

/**
 * opencode (~/.local/share/opencode/opencode.db): fields of message.data and
 * part.data. Times are epoch ms.
 */
export interface OpencodeMessage {
  /** message.id: without it, passing a message again emits it again. */
  id?: string
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
  /** Messages emitted, and calls started and settled. */
  const messages = new Set<string>()
  const started = new Set<string>()
  const settled = new Set<string>()
  return {
    info,
    /**
     * A reply is logged when it starts; it's at its completion time if it has one.
     * With an id, a reply waits until it has finished, so its tokens are final.
     */
    message(m: OpencodeMessage): SessionEvent[] {
      const you = m.role === 'user'
      const at = you ? m.created : (m.completed ?? m.created)
      if (at === undefined) return []
      if (m.id !== undefined) {
        if (messages.has(m.id) || (!you && m.completed === undefined && m.error === undefined)) return []
        messages.add(m.id)
      }
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
    /** A tool part: the call the first time it's seen, and its result once it has ended. */
    part(p: OpencodePart): SessionEvent[] {
      const call = p.callId
      if (p.type !== 'tool' || p.start === undefined || call === undefined || settled.has(call)) return []
      const events: SessionEvent[] = []
      if (!started.has(call)) {
        started.add(call)
        events.push(number(callDraft(p.start, call, p.tool ?? 'unknown')))
      }
      const status = p.status === 'completed' ? 'ok' : p.status === 'error' ? 'failed' : undefined
      if (status) {
        settled.add(call)
        events.push(number({ at: p.end ?? p.start, by: 'agent', k: 'result', call, status }))
      }
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
  /** <bubbleId> from the row key: without it, passing a bubble again emits it again. */
  bubbleId?: string
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
  /** Bubbles emitted, and those whose usage was. Cursor can fill in token counts later. */
  const bubbles = new Set<string>()
  const counted = new Set<string>()
  return {
    info,
    bubble(b: CursorBubble): SessionEvent[] {
      const at = parseISO(b.createdAt)
      if (at === undefined) return []
      const id = b.bubbleId
      const seen = id !== undefined && bubbles.has(id)
      if (id !== undefined) bubbles.add(id)
      if (b.type === 1) return seen ? [] : [number({ at, by: 'you', k: 'prompt', origin: 'typed' })]
      if (b.model && b.model !== 'default') info.model = b.model
      const events: SessionEvent[] = seen ? [] : [number({ at, by: 'agent', k: 'reply' })]
      if ((b.inputTokens || b.outputTokens) && !(id !== undefined && counted.has(id))) {
        if (id !== undefined) counted.add(id)
        events.push(number({ at, by: 'agent', k: 'usage', tokens: { input: b.inputTokens ?? 0, output: b.outputTokens ?? 0, cacheRead: 0, cacheWrite: 0 } }))
      }
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
  let last: string | undefined
  return {
    info,
    thread(t: ZedThread): SessionEvent[] {
      const at = parseISO(t.updatedAt)
      if (at === undefined || t.updatedAt === last) return []
      last = t.updatedAt
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
