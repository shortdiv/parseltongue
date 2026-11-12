import type { Kind, Tool } from './kinds.js'
import type { TokenCounts } from './types.js'

export type By = 'you' | 'agent' | 'system'
/** How a call ended. A call with no result is unknown. */
export type Status = 'ok' | 'failed' | 'declined' | 'interrupted' | 'unknown'
export type Tag = 'context' | 'log'

/**
 * One thing that happened in a session, without its text. Every log line the
 * parser accepts becomes at least one event; lines that aren't input or work are
 * `system`, named by `what`. Events never change once read: what a call led to
 * arrives later, as its `result`.
 */
export type SessionEvent = { id: string; at: number; by: By } & (
  | { k: 'prompt'; origin: 'typed' | 'queued' }
  | { k: 'ask'; call: string }
  /** declined: you turned the question down instead of answering it. */
  | { k: 'answer'; call: string; declined?: true }
  | { k: 'shell' | 'interrupt' | 'reply' | 'think' | 'compact' }
  | {
      k: 'call'
      /** The tool call's own id; `result`, `ask` and `answer` events refer to it. */
      call: string
      tool: Tool
      /** The tool's name as the harness logged it, e.g. update_plan or mcp__linear__save_issue. */
      name: string
      kind: Kind
      /** Codex code mode: the script (an `exec` call) that ran this call. */
      within?: string
      test?: true
      commit?: true
      push?: true
      paths?: string[]
    }
  | {
      k: 'result'
      call: string
      /** unknown when the result arrived but doesn't say how the call went. */
      status: Status
      /** A successful edit that mostly replaces lines the agent itself wrote earlier in the session. */
      rework?: true
    }
  | { k: 'usage'; tokens: TokenCounts; /** USD, when the harness logs it. */ cost?: number }
  | {
      k: 'system'
      /** The line's own type, e.g. "event_msg:task_started" or "attachment:hook_success". */
      what: string
      /**
       * context: something the harness put in front of the model (reminders, environment,
       * instructions, notifications, command output). log: the harness's own records
       * (requests, file history, settings, titles). Untagged: everything else, including
       * lines this parser doesn't know yet.
       */
      tag?: Tag
    }
)

/** The text behind prompt, answer, reply and think events, by event id. */
export type SessionText = Map<string, string>

/** What a log says about its session, learned as lines are read. */
export interface SessionInfo {
  id?: string
  cwd?: string
  model?: string
  /** The harness version that wrote the log, e.g. "2.1.311". */
  version?: string
  /** A subagent's or fork's parent session. */
  parent?: { session: string; via: 'subagent' | 'fork' }
}

/** The harnesses supported by the event readers. */
export type Harness = 'claude' | 'codex' | 'pi' | 'opencode' | 'cursor' | 'zed'

export interface Session extends SessionInfo {
  id: string
  agent: Harness | 'unknown'
  events: SessionEvent[]
  /** Each call's final status, by call id: its result's, or unknown without one. */
  calls: Record<string, Status>
  warnings: string[]
}

/** An event before it has an id, with its text. */
export type Draft = (SessionEvent extends infer E ? (E extends unknown ? Omit<E, 'id'> : never) : never) & { text?: string }

export type Json = Record<string, any>

/** One agent's log format: what each record means. Keeps its own state between records. */
export interface Adapter {
  info: SessionInfo
  /** A record's events. Undefined when the record isn't accepted: no timestamp, a duplicate, a copy. */
  read(record: Json): { at: number; events: Draft[] } | undefined
  /** How to label a record that produced no other event. */
  label(record: Json): { what: string; tag?: Tag; by?: By }
  /** Called with the events a record produced, ids assigned. */
  emitted?(events: SessionEvent[]): void
  /** Problems found, once the log is read. */
  warnings?(): string[]
  /** A line that isn't a JSON object: not JSON at all, or JSON of another shape. */
  damaged?(json: boolean): void
  /** Called for every line, blank ones included. */
  line?(): void
}

/** Streams lines or database rows. Each event comes out once and never changes. */
export interface Reader<In = string> {
  info: SessionInfo
  read(input: In): SessionEvent[]
  /** A snapshot of the session read so far. */
  session(): Session
  /** With { text: true }: the text behind each event read so far, by event id. */
  text: SessionText
  warnings(): string[]
}

export const list = (v: unknown): Json[] => (Array.isArray(v) ? v : [])
export const blockText = (content: unknown, type = 'text', field = 'text') =>
  list(content).filter((b) => b?.type === type && typeof b[field] === 'string').map((b) => b[field]).join('\n')

/** Numbers events in the order they're read. */
export function sequence() {
  let n = 0
  return (draft: Draft, text?: SessionText): SessionEvent => {
    const { text: words, ...rest } = draft
    const event = { id: String(++n), ...rest } as Record<string, unknown>
    for (const k of Object.keys(event)) if (event[k] === undefined) delete event[k]
    if (words && text) text.set(event.id as string, words)
    return event as SessionEvent
  }
}

/** Keeps emitted events and builds a fresh session snapshot on demand. */
export function withSession<In>(agent: Harness, source: Omit<Reader<In>, 'session'>): Reader<In> {
  const events: SessionEvent[] = []
  return {
    ...source,
    read(input) {
      const added = source.read(input)
      events.push(...added)
      return added
    },
    session() {
      const session: Session = {
        ...source.info, id: source.info.id ?? '', agent,
        events: [...events], calls: outcomes(events), warnings: [...source.warnings()],
      }
      for (const k of Object.keys(session) as (keyof Session)[]) if (session[k] === undefined) delete session[k]
      return session
    },
  }
}

/** Wraps an adapter: parses each line, numbers its events, keeps text if asked. */
export function readWith(agent: Harness, adapter: Adapter, opts: { text?: boolean } = {}): Reader {
  const text: SessionText = new Map()
  const number = sequence()
  let first = true
  return withSession<string>(agent, {
    info: adapter.info,
    text,
    warnings: () => adapter.warnings?.() ?? [],
    read(line) {
      adapter.line?.()
      // Only the start of a file can carry a byte order mark.
      if (first) {
        first = false
        if (line.startsWith('﻿')) line = line.slice(1)
      }
      if (!line.trim()) return []
      let record: unknown
      let json = true
      try {
        record = JSON.parse(line)
      } catch {
        json = false
      }
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        adapter.damaged?.(json)
        return []
      }
      const read = adapter.read(record as Json)
      if (!read) return []
      const drafts = read.events
      if (!drafts.length) {
        const { what, tag, by = 'system' } = adapter.label(record as Json)
        drafts.push({ at: read.at, by, k: 'system', what, tag })
      }
      const events = drafts.map((d) => number(d, opts.text ? text : undefined))
      adapter.emitted?.(events)
      return events
    },
  })
}

/** Each call's final status: its result's, or unknown without one. */
export function outcomes(events: SessionEvent[]): Record<string, Status> {
  const calls: Record<string, Status> = {}
  for (const e of events) {
    if (e.k === 'call') calls[e.call] ??= 'unknown'
    else if (e.k === 'result' && e.call in calls) calls[e.call] = e.status
  }
  return calls
}
