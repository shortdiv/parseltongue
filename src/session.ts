import { SessionAccumulator } from './accumulator.js'
import { claudeTyped, ingestClaudeLine } from './claude.js'
import { ingestCodexLine, outputText, promptText, readOutput } from './codex.js'
import { PiSessionParser } from './pi.js'
import type { CallStep } from './timeline.js'
import { toolOf, type Kind, type Tool } from './kinds.js'
import { parseISO, type TokenCounts } from './types.js'

export type Harness = 'claude' | 'codex' | 'pi'
export type By = 'you' | 'agent' | 'system'
export type Status = 'ok' | 'failed' | 'declined' | 'interrupted' | 'unknown'

/**
 * One thing that happened in a session, without its text. Every log line the
 * parser accepts becomes at least one event; lines that aren't input or work are
 * `system`, named by `what`.
 */
export type SessionEvent = { id: string; at: number; by: By } & (
  | { k: 'prompt'; origin: 'typed' | 'queued' }
  | { k: 'ask' | 'answer'; call: string }
  | { k: 'shell' | 'interrupt' | 'reply' | 'think' | 'compact' }
  | {
      k: 'call'
      /** The tool call's own id; `result` and `ask` events refer to it. */
      call: string
      tool: Tool
      /** The tool's name as the harness logged it, e.g. update_plan or mcp__linear__save_issue. */
      name: string
      kind: Kind
      status: Status
      /** Codex code mode: the script (an `exec` call) that ran this call. */
      within?: string
      test?: true
      commit?: true
      push?: true
      rework?: true
      paths?: string[]
    }
  | { k: 'result'; call: string }
  | { k: 'usage'; tokens: TokenCounts }
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

export type Tag = 'context' | 'log'

export interface Session {
  id: string
  agent: Harness
  cwd?: string
  /** A subagent's or fork's parent session. */
  parent?: { session: string; via: 'subagent' | 'fork' }
  events: SessionEvent[]
  warnings: string[]
}

/** The text behind prompt, answer, reply and think events, by event id. */
export type SessionText = Map<string, string>

type Json = Record<string, any>
type Draft<E = SessionEvent> = E extends unknown ? Omit<E, 'id'> : never
const list = (v: unknown): Json[] => (Array.isArray(v) ? v : [])
const blockText = (content: unknown, type = 'text', field = 'text') =>
  list(content).filter((b) => b?.type === type && typeof b[field] === 'string').map((b) => b[field]).join('\n')

/** What differs between harnesses: how to feed a line in, and where its text, results and labels are. */
interface Harnessed {
  acc: SessionAccumulator
  ingest(line: string): void
  /** When the line happened, if the parser took it (it skips damaged lines and duplicate entries). */
  at(l: Json): number | undefined
  prompt(l: Json): string | undefined
  reply(l: Json): string | undefined
  /** Reasoning on this line: its text, or '' when it's encrypted or summarised away. */
  think(l: Json): string | undefined
  answer(l: Json, call: string): string | undefined
  /** Ids of calls whose result arrives on this line. */
  results(l: Json): string[]
  /** A second record of something another line already logged. */
  duplicate?(l: Json): boolean
  queued?(l: Json): boolean
  what(l: Json): string
  tag(l: Json): Tag | undefined
  meta(l: Json, s: Session): void
}

const CLAUDE_LOGS = new Set([
  'api-request', 'api-request-blob', 'api-request-shape', 'frame-link', 'file-history-snapshot', 'file-history-delta',
  'mode', 'permission-mode', 'atis-latch', 'last-prompt', 'ai-title', 'summary', 'cost-state', 'queue-operation',
  'fork-context-ref', 'artifact-comment-monitor', 'artifact-autoreact-ledger',
])
const CLAUDE_SYSTEM_LOGS = new Set(['informational', 'local_command', 'stop_hook_summary'])
const CODEX_LOGS = new Set(['session_meta', 'turn_context', 'token_usage_record', 'inter_agent_communication_metadata'])
const CODEX_EVENT_LOGS = new Set(['thread_settings_applied', 'token_count'])

function claude(): Harnessed {
  const acc = new SessionAccumulator()
  const blocks = (l: Json) => list(l.message?.content)
  return {
    acc,
    ingest: (line) => ingestClaudeLine(acc, line),
    at: (l) => parseISO(l.timestamp),
    prompt: (l) => claudeTyped(l)?.text,
    reply: (l) => (l.type === 'assistant' && !l.isSidechain ? blockText(l.message?.content) : undefined),
    think: (l) => (l.type === 'assistant' && !l.isSidechain && blocks(l).some((b) => b?.type === 'thinking') ? blockText(l.message?.content, 'thinking', 'thinking') : undefined),
    answer: (l, call) => {
      const b = blocks(l).find((b) => b?.tool_use_id === call)
      return typeof b?.content === 'string' ? b.content : blockText(b?.content)
    },
    results: (l) => (l.isSidechain ? [] : blocks(l).filter((b) => b?.type === 'tool_result' && b.tool_use_id).map((b) => b.tool_use_id)),
    queued: (l) => l.type === 'attachment',
    tag: (l) =>
      l.isSidechain ? undefined
      : l.type === 'user' || (l.type === 'attachment' && l.attachment?.type !== 'hook_success') ? 'context'
      : CLAUDE_LOGS.has(l.type) || l.type === 'attachment' || (l.type === 'system' && CLAUDE_SYSTEM_LOGS.has(l.subtype)) ? 'log'
      : undefined,
    what: (l) =>
      l.isSidechain ? 'subagent'
      : l.type === 'user' ? `user:${l.isCompactSummary ? 'compact-summary' : l.origin?.kind ?? (l.isMeta ? 'meta' : 'other')}`
      : [l.type, l.subtype ?? l.attachment?.type ?? l.operation].filter(Boolean).join(':'),
    meta: (l, s) => {
      s.id ||= (l.isSidechain && l.agentId) || l.sessionId || ''
      if (l.type === 'fork-context-ref' && l.parentSessionId) s.parent = { session: l.parentSessionId, via: 'fork' }
      // A subagent's own file: its lines carry the parent's sessionId. (Older logs keep
      // subagent lines inside the parent's file, under the parent's own id.)
      if (l.isSidechain && l.sessionId && l.sessionId !== s.id && !s.parent) s.parent = { session: l.sessionId, via: 'subagent' }
    },
  }
}

/**
 * Codex logs a prompt, reply or reasoning as a response item and again as an event or
 * item, and a response's usage as a token_usage_record and again in token_count.
 */
const CODEX_COPIES = new Set(['user_message', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content'])
const CODEX_ITEM_COPIES = new Set(['UserMessage', 'AgentMessage', 'Reasoning'])

function codex(): Harnessed {
  const acc = new SessionAccumulator()
  const p = (l: Json): Json => l.payload ?? {}
  return {
    acc,
    ingest: (line) => ingestCodexLine(acc, line),
    at: (l) => parseISO(l.timestamp),
    prompt: (l) => promptText(l),
    reply: (l) => (l.type === 'response_item' && p(l).type === 'message' && p(l).role === 'assistant' ? blockText(p(l).content, 'output_text') : undefined),
    think: (l) => (l.type === 'response_item' && p(l).type === 'reasoning' ? blockText(p(l).summary, 'summary_text') : undefined),
    answer: (l, call) => (p(l).call_id === call ? outputText(p(l).output) : undefined),
    results: (l) => {
      const id = p(l).call_id ?? p(l).item?.id
      if (!id) return []
      // A poll's output is the result of the command it polled.
      const polled = acc.polls.get(id)
      return [polled !== undefined ? acc.processes.get(polled)?.id ?? id : id]
    },
    duplicate: (l) =>
      l.type === 'event_msg' &&
      (CODEX_COPIES.has(p(l).type) || (p(l).type === 'item_completed' && CODEX_ITEM_COPIES.has(p(l).item?.type)) || (p(l).type === 'token_count' && acc.usageRecords)),
    what: (l) => [l.type, p(l).type, p(l).role ?? p(l).item?.type].filter(Boolean).join(':'),
    tag: (l) =>
      (l.type === 'response_item' && p(l).type === 'message') || l.type === 'world_state' ? 'context'
      : CODEX_LOGS.has(l.type) || (l.type === 'event_msg' && CODEX_EVENT_LOGS.has(p(l).type)) ? 'log'
      : undefined,
    meta: (l, s) => {
      // A subagent's file repeats its parent's session_meta after its own; the first is the session's.
      if (l.type !== 'session_meta' || s.id) return
      s.id = p(l).id ?? ''
      const parent = p(l).source?.subagent?.thread_spawn?.parent_thread_id
      if (parent) s.parent = { session: parent, via: 'subagent' }
    },
  }
}

function pi(): Harnessed & { parser: PiSessionParser } {
  const parser = new PiSessionParser()
  const content = (l: Json, role: string) => (l.type === 'message' && l.message?.role === role ? l.message.content : undefined)
  let entries = 0
  return {
    parser,
    acc: parser.accumulator,
    ingest: (line) => parser.ingestLine(line),
    at: () => {
      if (parser.entries.size === entries) return undefined
      entries = parser.entries.size
      return parser.entries.get(parser.leafId!)!.at
    },
    prompt: (l) => {
      const c = content(l, 'user')
      return (typeof c === 'string' ? c : blockText(c)) || undefined
    },
    reply: (l) => blockText(content(l, 'assistant')),
    think: (l) => (list(content(l, 'assistant')).some((b) => b?.type === 'thinking') ? blockText(content(l, 'assistant'), 'thinking', 'thinking') : undefined),
    answer: () => undefined,
    results: (l) => (content(l, 'toolResult') !== undefined && l.message.toolCallId ? [l.message.toolCallId] : []),
    what: (l) => [l.type, l.message?.role].filter(Boolean).join(':'),
    tag: (l) => (l.type === 'message' ? 'context' : l.type === 'session_info' || l.type === 'label' ? 'log' : undefined),
    meta: (l, s) => {
      if (l.type !== 'session') return
      s.id = l.id ?? ''
      if (l.parentSession) s.parent = { session: l.parentSession, via: 'fork' }
    },
  }
}

/** Which harness wrote a log, from its first line. */
function detect(raw: string): Harness {
  const first = raw.slice(0, raw.indexOf('\n') + 1 || undefined)
  let type: unknown
  try {
    type = JSON.parse(first).type
  } catch {}
  if (type === 'session') return 'pi'
  if (type === 'session_meta' || type === 'response_item' || type === 'turn_context' || type === 'event_msg') return 'codex'
  return 'claude'
}

const statusOf = (acc: SessionAccumulator, c: CallStep): Status =>
  acc.declined.has(c) ? 'declined' : acc.interrupted.has(c) ? 'interrupted' : c.ok === true ? 'ok' : c.ok === false ? 'failed' : 'unknown'

type CallEvent = SessionEvent & { k: 'call' }

/** Reads a whole log. Shared by parseSession and normalizeSession. */
export function readSession(raw: string, agent: Harness = detect(raw)) {
  const piParser = agent === 'pi' ? pi() : undefined
  const h = piParser ?? (agent === 'codex' ? codex() : claude())
  const acc = h.acc
  const session: Session = { id: '', agent, events: [], warnings: [] }
  const text: SessionText = new Map()
  /** Call events by tool call id, with the step that settles their status. */
  const calls = new Map<string, { event: CallEvent; step?: CallStep }>()
  /** Calls whose result has arrived: Codex can log it twice (an end event and the output). */
  const resulted = new Set<string>()
  /** Codex code mode: the script running now, if any. */
  let cell: string | undefined
  const push = (e: Draft, words?: string) => {
    const event = { id: String(session.events.length + 1), ...e } as SessionEvent
    session.events.push(event)
    if (words) text.set(event.id, words)
    return event
  }

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let l: Json | undefined
    try {
      l = JSON.parse(line)
    } catch {}
    const [steps, usage] = [acc.timeline.length, acc.usage.length]
    h.ingest(line)
    if (!l || typeof l !== 'object' || Array.isArray(l)) continue
    h.meta(l, session)
    const at = h.at(l)
    if (at === undefined || h.duplicate?.(l)) continue
    const before = session.events.length
    const known = new Set(calls.keys())

    const think = h.think(l)
    if (think !== undefined) push({ at, by: 'agent', k: 'think' }, think)
    const reply = h.reply(l)
    if (reply) push({ at, by: 'agent', k: 'reply' }, reply)
    // Codex code mode: the script is a call; the calls it makes are within it.
    if (agent === 'codex' && l.type === 'response_item' && l.payload?.type === 'custom_tool_call' && l.payload.name === 'exec' && l.payload.call_id) {
      cell = l.payload.call_id as string
      const event = push({ at, by: 'agent', k: 'call', call: cell, tool: 'Code', name: 'exec', kind: 'run', status: 'unknown' }) as CallEvent
      calls.set(cell, { event })
    }
    for (const s of acc.timeline.slice(steps)) {
      if (s.k === 'prompt') push({ at: s.at, by: 'you', k: 'prompt', origin: h.queued?.(l) ? 'queued' : 'typed' }, h.prompt(l))
      else if (s.k === 'answer') push({ at: s.at, by: 'you', k: 'answer', call: s.call }, h.answer(l, s.call))
      else if (s.k === 'ask') push({ at: s.at, by: 'agent', k: 'ask', call: s.call })
      else if (s.k === 'shell' || s.k === 'interrupt') push({ at: s.at, by: 'you', k: s.k })
      else if (s.k === 'compact') push({ at: s.at, by: 'system', k: 'compact' })
      else if (s.k === 'call') {
        const { at, id = `call-${session.events.length + 1}`, tool, test, commit, push: pushed, rework, paths } = s
        const within = cell !== undefined && cell !== id ? cell : undefined
        const event = push({ at, by: 'agent', k: 'call', call: id, tool: toolOf(tool), name: tool, kind: s.kind ?? 'other', status: 'unknown', within, test, commit, push: pushed, rework, paths }) as CallEvent
        calls.set(id, { event, step: s })
      }
      // A decline is the declined call's status, not an event of its own.
    }
    // Results for calls made on an earlier line; a call settled on its own line has none.
    for (const id of new Set(h.results(l))) {
      if (!known.has(id) || resulted.has(id)) continue
      resulted.add(id)
      push({ at, by: 'agent', k: 'result', call: id })
      if (id === cell) {
        const { outcome } = readOutput(outputText(l.payload?.output))
        calls.get(id)!.event.status = outcome === 'declined' ? 'declined' : outcome === 'failed' ? 'failed' : outcome === 'ok' ? 'ok' : 'unknown'
        cell = undefined
      }
    }
    for (const u of acc.usage.slice(usage)) push({ at: u.at, by: 'agent', k: 'usage', tokens: u.tokens })
    if (session.events.length === before) push({ at, by: h.what(l) === 'subagent' ? 'agent' : 'system', k: 'system', what: h.what(l), tag: h.tag(l) })
  }

  // Outcomes arrive after their calls.
  for (const { event, step } of calls.values()) if (step) event.status = statusOf(acc, step)
  for (const e of session.events) for (const k of Object.keys(e) as (keyof typeof e)[]) if (e[k] === undefined) delete e[k]
  session.cwd = acc.projectPath
  const parser = piParser?.parser
  if (parser) {
    const d = parser.diagnostics
    if (d.malformedLines) session.warnings.push(`${d.malformedLines} malformed JSONL lines skipped`)
    if (d.ignoredLines) session.warnings.push(`${d.ignoredLines} invalid entries skipped`)
    if (!parser.getPath().complete) session.warnings.push('Incomplete or cyclic ancestry; chronological work retained')
  }
  return { session, text, acc, pi: parser }
}

/**
 * A session as a list of events, without its text. With { text: true }, also the
 * text behind your prompts and answers and the agent's replies and reasoning, by event id.
 */
export function parseSession(raw: string): Session
export function parseSession(raw: string, opts: { text: true }): Session & { text: SessionText }
export function parseSession(raw: string, opts?: { text?: boolean }): Session | (Session & { text: SessionText }) {
  const { session, text } = readSession(raw)
  return opts?.text ? { ...session, text } : session
}
