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

/**
 * The text behind prompt, answer, reply and think events, by event id: a plain object,
 * so it survives JSON. Event ids count up within a session; across sessions, key by
 * the session's id and the event's.
 */
export type SessionText = Record<string, string>

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
/** The harnesses that write logs, which `detect` recognises and `parseSession` reads. */
export type LogHarness = Extract<Harness, 'claude' | 'codex' | 'pi'>

export interface Session extends SessionInfo {
  agent: Harness
  /** In the order the log has them, not sorted: `at` can step backwards, e.g. between pi branches. */
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
  read(input: In): SessionEvent[]
  /** A snapshot of the session read so far: events, call statuses, info and warnings. */
  session(): Session
}

/** A log reader made with { text: true }: also the text behind each event read so far, by event id. */
export interface TextReader<In = string> extends Reader<In> {
  text: SessionText
}

/** What a reader keeps as it reads, before it's wrapped with session(). */
export interface Source<In> {
  info: SessionInfo
  read(input: In): SessionEvent[]
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
    if (words && text) text[event.id as string] = words
    return event as SessionEvent
  }
}

/**
 * Keeps emitted events and call statuses as they're read. A snapshot copies its
 * events and calls only when they're first used, so taking one after every line stays cheap.
 */
export function withSession<In>(agent: Harness, source: Source<In>): Reader<In> {
  const events: SessionEvent[] = []
  const calls: Record<string, Status> = Object.create(null)
  return {
    read(input) {
      const added = source.read(input)
      for (const e of added) {
        events.push(e)
        settle(calls, e)
      }
      return added
    },
    session() {
      const n = events.length
      let seen: SessionEvent[] | undefined
      let statuses: Record<string, Status> | undefined
      const session = { ...source.info, agent } as Session
      for (const k of Object.keys(session) as (keyof Session)[]) if (session[k] === undefined) delete session[k]
      return Object.defineProperties(session, {
        events: { enumerable: true, get: () => (seen ??= events.slice(0, n)) },
        // Later results change statuses, so a snapshot taken before them recounts its own events.
        calls: { enumerable: true, get: () => (statuses ??= events.length === n ? { ...calls } : outcomes(events.slice(0, n))) },
        warnings: { enumerable: true, value: [...source.warnings()] },
      })
    },
  }
}

/** Makes a JSONL reader from an adapter: parses each line, numbers its events, keeps text if asked. */
export function jsonlReader(agent: LogHarness, adapter: Adapter, opts: { text?: boolean } = {}): Reader & { text?: SessionText } {
  const text: SessionText = {}
  const number = sequence()
  let first = true
  const reader = withSession<string>(agent, {
    info: adapter.info,
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
  return opts.text ? { ...reader, text } : reader
}

/** Each call's final status: its result's, or unknown without one. */
export function outcomes(events: SessionEvent[]): Record<string, Status> {
  const calls: Record<string, Status> = Object.create(null)
  for (const e of events) settle(calls, e)
  return calls
}

function settle(calls: Record<string, Status>, e: SessionEvent) {
  if (e.k === 'call') calls[e.call] ??= 'unknown'
  else if (e.k === 'result' && e.call in calls) calls[e.call] = e.status
}
