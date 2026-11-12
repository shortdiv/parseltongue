import { callDraft, isAskTool } from './commands.js'
import { blockText, type Adapter, type Draft, type Status } from './events.js'
import { reworks, ReworkTracker, type Edit } from './rework.js'
import { parseISO } from './util.js'

/**
 * Claude Code transcripts: ~/.claude/projects/<project>/<session>.jsonl, and a
 * subagent's under <session>/subagents/. Only the fields we read; anything may be absent.
 */
interface Line {
  type?: string
  subtype?: string
  timestamp?: string
  version?: string
  cwd?: string
  sessionId?: string
  agentId?: string
  parentSessionId?: string
  isMeta?: boolean
  isSidechain?: boolean
  isCompactSummary?: boolean
  /** Who a user line came from: "human" for what you typed, else e.g. "task-notification". Newer logs only. */
  origin?: { kind?: string }
  attachment?: { type?: string; commandMode?: string; prompt?: string | Block[] }
  operation?: string
  message?: {
    id?: string
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
    content?: string | Block[]
  }
}

interface Block {
  type?: string
  text?: string
  id?: string
  name?: string
  tool_use_id?: string
  is_error?: boolean
  input?: {
    command?: string
    file_path?: string
    notebook_path?: string
    old_string?: string
    new_string?: string
    content?: string
    edits?: { old_string?: string; new_string?: string }[]
  }
  // tool_result content is a string or a list of text parts.
  content?: string | { type?: string; text?: string }[]
}

const blocks = (l: Line): Block[] => (Array.isArray(l.message?.content) ? l.message.content : [])

const textOf = (c: string | Block[] | undefined) =>
  typeof c === 'string' ? c : (c ?? []).map((b) => b.text).filter((t): t is string => typeof t === 'string').join('\n')

/** Text of a user line that isn't tool results. */
function userText(l: Line): string | undefined {
  if (l.type !== 'user' || l.isMeta || l.isSidechain) return undefined
  const c = l.message?.content
  if (Array.isArray(c) && c.some((b) => b.type === 'tool_result')) return undefined
  return textOf(c) || undefined
}

/** A shell command you ran yourself with `!`. */
const SHELL_INPUT = /^\s*<bash-input>/
/** User lines that are output or notifications, in logs older than origin.kind. */
const NOT_TYPED = /^\s*<(task-notification|bash-stdout|bash-stderr|local-command-stdout|local-command-caveat)>/

/**
 * Something you typed: a prompt (or an interrupt marker), or a shell command you
 * ran yourself. Claude Code also logs compaction summaries, background-task
 * notifications and command output as user lines, and logs a message you send
 * while the agent is busy as a queued_command attachment instead.
 */
export function claudeTyped(l: Line): { text: string; shell?: true } | undefined {
  if (l.isSidechain) return undefined
  const q = l.attachment
  if (l.type === 'attachment') {
    const text = q?.type === 'queued_command' && q.commandMode === 'prompt' ? textOf(q.prompt) : ''
    return text ? { text } : undefined
  }
  const text = userText(l)
  if (text === undefined || l.isCompactSummary) return undefined
  if (SHELL_INPUT.test(text)) return { text, shell: true }
  if (l.origin) return l.origin.kind === 'human' ? { text } : undefined
  return NOT_TYPED.test(text) ? undefined : { text }
}

/** Claude Code logs your Esc as a user line: "[Request interrupted by user…]". */
const isInterrupt = (text: string | undefined) => text?.startsWith('[Request interrupted') === true

function resultText(b: Block): string | undefined {
  if (typeof b.content === 'string') return b.content
  if (Array.isArray(b.content)) return b.content.map((p) => p.text ?? '').join('\n')
  return undefined
}

/** A declined tool call comes back as an error carrying this message. */
const DECLINED = "doesn't want to proceed"

const LOGS = new Set([
  'api-request', 'api-request-blob', 'api-request-shape', 'frame-link', 'file-history-snapshot', 'file-history-delta',
  'mode', 'permission-mode', 'atis-latch', 'last-prompt', 'ai-title', 'summary', 'cost-state', 'queue-operation',
  'fork-context-ref', 'artifact-comment-monitor', 'artifact-autoreact-ledger',
])
const SYSTEM_LOGS = new Set(['informational', 'local_command', 'stop_hook_summary'])

export function claude(): Adapter {
  const info: Adapter['info'] = {}
  const messages = new Set<string>()
  const calls = new Set<string>()
  /** Calls waiting for their result, with the edits they'd make. */
  const open = new Map<string, Edit[]>()
  /** Questions waiting for your answer, by tool-use id. */
  const asks = new Set<string>()
  const tracker = new ReworkTracker()
  /** Claude Code logs an interrupt line right after a declined tool call; it's part of the decline. */
  let afterDecline = false
  /**
   * A line of this session's own work. Older logs keep a subagent's lines inside the
   * parent's file, as sidechain lines: those are the subagent's, not this session's.
   */
  const mine = (l: Line) => !l.isSidechain || (l.agentId !== undefined && l.agentId === info.id)

  return {
    info,
    read(l: Line) {
      // A subagent's own file is all sidechain lines (after a fork-context-ref, for a fork),
      // named for its agentId.
      info.id ||= ((l.isSidechain || l.type === 'fork-context-ref') && l.agentId) || l.sessionId || undefined
      if (l.type === 'fork-context-ref' && l.parentSessionId) info.parent = { session: l.parentSessionId, via: 'fork' }
      // A subagent's own file: its lines carry the parent's sessionId. (Older logs keep
      // subagent lines inside the parent's file, under the parent's own id.)
      if (l.isSidechain && l.sessionId && l.sessionId !== info.id && !info.parent) info.parent = { session: l.sessionId, via: 'subagent' }
      const at = parseISO(l.timestamp)
      if (at === undefined) return undefined
      if (info.cwd === undefined && l.cwd) info.cwd = l.cwd
      if (l.version) info.version = l.version

      const events: Draft[] = []
      const own = mine(l)
      if (l.type === 'assistant' && own) {
        if (blocks(l).some((b) => b.type === 'thinking')) events.push({ at, by: 'agent', k: 'think', text: blockText(l.message?.content, 'thinking', 'thinking') })
        const reply = blockText(l.message?.content)
        if (reply) events.push({ at, by: 'agent', k: 'reply', text: reply })
      }
      if (l.type === 'system' && l.subtype === 'compact_boundary') events.push({ at, by: 'system', k: 'compact' })

      const typed = claudeTyped(l)
      if (isInterrupt(typed?.text)) {
        if (!afterDecline) events.push({ at, by: 'you', k: 'interrupt' })
      } else if (typed?.shell) events.push({ at, by: 'you', k: 'shell' })
      else if (typed) events.push({ at, by: 'you', k: 'prompt', origin: l.type === 'attachment' ? 'queued' : 'typed', text: typed.text })
      if (typed || l.type === 'assistant') afterDecline = false

      if (own) {
        for (const b of blocks(l)) {
          if (b.type === 'tool_use') {
            if (!b.id || calls.has(b.id)) continue
            calls.add(b.id)
            if (b.name && isAskTool(b.name)) {
              asks.add(b.id)
              events.push({ at, by: 'agent', k: 'ask', call: b.id })
              continue
            }
            const input = b.input ?? {}
            const command = typeof input.command === 'string' ? input.command : undefined
            const file = input.file_path ?? input.notebook_path
            events.push(callDraft(at, b.id, b.name ?? 'unknown', command, file ? [file] : undefined))
            const edits = file ? (input.edits ?? [{ old_string: input.old_string, new_string: input.new_string ?? input.content }]) : []
            open.set(b.id, edits.map((e) => ({ file: file!, old: e.old_string, next: e.new_string })))
          } else if (b.type === 'tool_result' && b.tool_use_id) {
            const id = b.tool_use_id
            const result = resultText(b)
            const declined = b.is_error === true && result?.includes(DECLINED) === true
            if (declined) afterDecline = true
            if (asks.delete(id)) {
              events.push(declined
                ? { at, by: 'you', k: 'answer', call: id, declined: true }
                : { at, by: 'you', k: 'answer', call: id, text: typeof b.content === 'string' ? b.content : blockText(b.content) })
              continue
            }
            const edits = open.get(id)
            if (!edits) continue
            open.delete(id)
            const status: Status = !b.is_error ? 'ok' : declined ? 'declined' : result?.startsWith('[Request interrupted') ? 'interrupted' : 'failed'
            events.push({ at, by: 'agent', k: 'result', call: id, status, rework: status === 'ok' ? reworks(tracker, edits) : undefined })
          }
        }
      }

      // One response is logged across several lines that repeat the same usage, so count each message once.
      const msg = l.message
      if (l.type === 'assistant' && msg?.usage && !(msg.id && messages.has(msg.id))) {
        if (msg.id) messages.add(msg.id)
        if (msg.model && !msg.model.startsWith('<')) info.model = msg.model
        const u = msg.usage
        events.push({
          at, by: 'agent', k: 'usage',
          tokens: { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0 },
        })
      }
      return { at, events }
    },
    label: (l: Line) => ({
      what: !mine(l) ? 'subagent'
        : l.type === 'user' ? `user:${l.isCompactSummary ? 'compact-summary' : l.origin?.kind ?? (l.isMeta ? 'meta' : 'other')}`
        : [l.type, l.subtype ?? l.attachment?.type ?? l.operation].filter(Boolean).join(':'),
      tag: !mine(l) ? undefined
        : l.type === 'user' || (l.type === 'attachment' && l.attachment?.type !== 'hook_success') ? 'context'
        : LOGS.has(l.type!) || l.type === 'attachment' || (l.type === 'system' && SYSTEM_LOGS.has(l.subtype!)) ? 'log'
        : undefined,
      by: !mine(l) ? 'agent' : 'system',
    }),
  }
}
