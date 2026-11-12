import { callDraft, isAskTool } from './commands.js'
import { blockText, type Adapter, type Draft, type Status } from './events.js'
import { reworks, ReworkTracker, type Edit } from './rework.js'
import { emptyTokens, parseISO, type TokenCounts } from './types.js'

/**
 * Codex rollouts (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl): every line is
 * {timestamp, type, payload}. Payload shape varies by type.
 *
 * Tool calls are read the same way in every version: each call is a
 * `response_item` (`function_call` or `custom_tool_call`) with a `call_id`, and
 * its outcome is whichever result Codex saved for that id. Which result events
 * get saved changed between versions (codex-rs/rollout/src/policy.rs), so we
 * take the first of: an end event or `item_completed` with a status, or the
 * header Codex writes at the top of the call's output.
 */
export interface Line {
  type?: string
  timestamp?: string
  payload?: {
    type?: string
    role?: string
    summary?: { type?: string; text?: string }[]
    source?: { subagent?: { thread_spawn?: { parent_thread_id?: string } } }
    cwd?: string
    model?: string
    cli_version?: string
    approval_policy?: string
    content?: { type?: string; text?: string }[]
    info?: { total_token_usage?: Usage }
    /** token_usage_record: one model response's usage. */
    usage?: Usage
    item?: {
      type?: string
      id?: string
      path?: string
      kind?: string
      status?: string
      tool?: string
      command?: string[] | string
      changes?: Changes
    }
    reason?: string
    // Tool calls and their results
    id?: string
    name?: string
    call_id?: string
    arguments?: string
    input?: string
    output?: unknown
    status?: string
    exit_code?: number
    success?: boolean
    changes?: Changes
    command?: string[] | string
    result?: { Ok?: { isError?: boolean }; Err?: unknown }
  }
}

interface Usage {
  input_tokens?: number
  cached_input_tokens?: number
  cache_write_input_tokens?: number
  output_tokens?: number
}

/** Files a patch event touched, each with a unified diff (or the new file's content). */
type Changes = Record<string, { unified_diff?: string; content?: string }>

/** Polling a command that's already running; its result belongs to that command. */
const POLLING = new Set(['write_stdin', 'wait'])
/** Code mode: the model writes a script that runs commands. The commands are the calls. */
const CODE_CELL = 'exec'
/** Inner actions that `item_completed` reports in code mode. */
const ACTION_ITEMS = new Set(['CommandExecution', 'FileChange', 'McpToolCall'])
/**
 * Web activity: a search, an opened page or a find in page. Codex logs it as a
 * `web_search_call` (no call_id, older ones no id at all), a `WebSearch` item, or an
 * `Extension` item of kind web.search, often more than one of these under the same id.
 */
const WEB = 'web_search'
const isWebItem = (it: { type?: string; kind?: string } | undefined) =>
  it?.type === 'WebSearch' || (it?.type === 'Extension' && it.kind?.startsWith('web.') === true)

type Outcome = 'ok' | 'failed' | 'declined'

/** Tags Codex wraps the context it injects in. Newer ones are snake_case, like most of these. */
const INJECTED_TAGS = new Set(['environment_context', 'user_instructions', 'skill', 'recommended_plugins', 'turn_aborted', 'system_instruction', 'codex_internal_context', 'user_action'])

/**
 * Codex logs the context it injects as user messages: AGENTS.md, or a message that opens
 * with one of its tags, like <environment_context>. A prompt you typed that merely starts
 * with `<` (pasted HTML, `<div> isn't centering`) is yours.
 */
export const isInjectedCodexText = (text: string) => {
  const t = text.trim()
  if (t.startsWith('# AGENTS.md instructions')) return true
  const tag = /^<([a-z][a-z0-9_]*)[\s>]/.exec(t)?.[1]
  return tag !== undefined && (INJECTED_TAGS.has(tag) || tag.includes('_'))
}

/** A shell command you ran yourself (`!` in Codex), logged as a user message with its output. */
export const isUserShell = (l: Line) =>
  l.type === 'response_item' && l.payload?.type === 'message' && l.payload.role === 'user' &&
  /^\s*<user_shell_command>/.test(l.payload.content?.find((c) => c.type === 'input_text')?.text ?? '')

/** An attached image is logged as text parts around it: <image name=[Image #1]> and </image>. */
const IMAGE_WRAPPER = /^\s*<\/?image\b[^>]*>\s*$/

/** Your prompt's text, if this line is one: '' for an image with no text. */
export function promptText(l: Line): string | undefined {
  const p = l.payload
  if (l.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user' || isUserShell(l)) return undefined
  const parts = p.content ?? []
  const text = parts.filter((c) => c.type === 'input_text' && typeof c.text === 'string' && !IMAGE_WRAPPER.test(c.text)).map((c) => c.text).join('\n')
  if (text) return isInjectedCodexText(text) ? undefined : text
  return parts.some((c) => c.type === 'input_image') ? '' : undefined
}

export const outputText = (o: unknown): string =>
  typeof o === 'string'
    ? o
    : Array.isArray(o)
      ? o.map((p) => (typeof p?.text === 'string' ? p.text : '')).join('\n')
      : ''

/**
 * What a call's output says about how it went, from the header Codex puts at the
 * top (codex-rs/core/src/tools): "Exit code: N", "Process exited with code N", "Script completed",
 * "... rejected by user", "apply_patch verification failed". Older versions
 * wrote JSON with metadata.exit_code. A command still running names its session
 * ID instead, and a later write_stdin output gives the exit code.
 */
export function readOutput(text: string): { outcome?: Outcome; running?: string } {
  const head = text.trimStart().split('\n', 6).join('\n')
  if (/^(exec command|patch) rejected by user/.test(head)) return { outcome: 'declined' }
  if (/^apply_patch verification failed/m.test(head)) return { outcome: 'failed' }
  // A code-mode script's output starts with how the script ended.
  const script = /^Script (completed|failed)\b/m.exec(head)
  if (script) return { outcome: script[1] === 'completed' ? 'ok' : 'failed' }
  const code = /^(?:Exit code: |Process exited with code )(-?\d+)/m.exec(head)
  if (code) return { outcome: code[1] === '0' ? 'ok' : 'failed' }
  const running = /^Process running with session ID (\S+)/m.exec(head)
  if (running) return { running: running[1] }
  if (head.startsWith('{')) {
    try {
      const exit = JSON.parse(text)?.metadata?.exit_code
      if (typeof exit === 'number') return { outcome: exit === 0 ? 'ok' : 'failed' }
    } catch {}
  }
  return {}
}

/** An end event's or item's status, falling back to its exit code or success flag. */
export function statusOutcome(p: { status?: string; exit_code?: number; success?: boolean }): Outcome | undefined {
  if (p.status === 'declined') return 'declined'
  if (p.status === 'failed') return 'failed'
  if (p.status === 'completed') return 'ok'
  if (p.exit_code !== undefined) return p.exit_code === 0 ? 'ok' : 'failed'
  if (p.success !== undefined) return p.success ? 'ok' : 'failed'
  return undefined
}

/** Lines each file loses and gains, from apply_patch's format or a unified diff. */
function patchEdits(patch: string, file?: string): Edit[] {
  const edits: { file: string; removed: string[]; added: string[] }[] = []
  let cur = file ? { file, removed: [] as string[], added: [] as string[] } : undefined
  if (cur) edits.push(cur)
  for (const line of patch.split('\n')) {
    const header = /^\*\*\* (?:Update|Add) File: (.+)$/.exec(line)
    if (header) edits.push((cur = { file: header[1]!.trim(), removed: [], added: [] }))
    else if (!cur || line.startsWith('---') || line.startsWith('+++')) continue
    else if (line.startsWith('-')) cur.removed.push(line.slice(1))
    else if (line.startsWith('+')) cur.added.push(line.slice(1))
  }
  return edits.map((e) => ({ file: e.file, old: e.removed.join('\n'), next: e.added.join('\n') }))
}

const argv = (c: string[] | string | undefined) => (Array.isArray(c) ? c.join(' ') : c)

const changesEdits = (changes: Changes | undefined) =>
  Object.entries(changes ?? {}).flatMap(([file, c]) =>
    c.unified_diff !== undefined ? patchEdits(c.unified_diff, file) : c.content ? [{ file, next: c.content }] : [],
  )

/** Codex counts cached input inside input_tokens. */
function tokens(u: Usage): TokenCounts {
  const cached = u.cached_input_tokens ?? 0
  return {
    input: Math.max(0, (u.input_tokens ?? 0) - cached),
    output: u.output_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: u.cache_write_input_tokens ?? 0,
  }
}

/**
 * Codex logs a prompt, reply or reasoning as a response item and again as an event or
 * item, and a response's usage as a token_usage_record and again in token_count.
 */
const COPIES = new Set(['user_message', 'agent_message', 'agent_reasoning', 'agent_reasoning_raw_content'])
const ITEM_COPIES = new Set(['UserMessage', 'AgentMessage', 'Reasoning'])
const LOGS = new Set(['session_meta', 'turn_context', 'token_usage_record', 'inter_agent_communication_metadata'])
const EVENT_LOGS = new Set(['thread_settings_applied', 'token_count'])

const statusOf = (o: Outcome | undefined): Status => o ?? 'unknown'

/** Codex doesn't log the branch; the caller resolves it from the project folder. */
export function codex(): Adapter {
  const info: Adapter['info'] = {}
  const calls = new Set<string>()
  /** Calls waiting for how they went, with the edits they'd make. */
  const open = new Map<string, Edit[]>()
  /** Questions waiting for your answer, by call id. */
  const asks = new Set<string>()
  /** Commands still running, by session ID, and polls of them by call id. */
  const processes = new Map<string, string>()
  const polls = new Map<string, string>()
  const tracker = new ReworkTracker()
  /** The log records each response's usage, so token_count totals aren't needed. */
  let usageRecords = false
  let lastTotal = emptyTokens()
  /** Code mode: the script running now, if any. */
  let cell: string | undefined

  return {
    info,
    read(l: Line) {
      const p = l.payload ?? {}
      // A subagent's file repeats its parent's session_meta after its own; the first is the session's.
      if (l.type === 'session_meta' && !info.id) {
        info.id = p.id ?? ''
        const parent = p.source?.subagent?.thread_spawn?.parent_thread_id
        if (parent) info.parent = { session: parent, via: 'subagent' }
      }
      const at = parseISO(l.timestamp)
      if (at === undefined) return undefined
      if (l.type === 'event_msg' && (COPIES.has(p.type!) || (p.type === 'item_completed' && ITEM_COPIES.has(p.item?.type!)) || (p.type === 'token_count' && usageRecords))) return undefined
      if (p.cwd && info.cwd === undefined) info.cwd = p.cwd
      if (l.type === 'turn_context' && p.model) info.model = p.model
      if (l.type === 'session_meta' && p.cli_version) info.version = p.cli_version

      const events: Draft[] = []
      /** A call the line starts; a call it already started is left as it was. */
      const start = (id: string, name: string, command?: string, edits: Edit[] = [], paths?: string[]) => {
        if (calls.has(id)) return
        calls.add(id)
        const draft = callDraft(at, id, name, command, paths ?? (edits.length ? [...new Set(edits.map((e) => e.file))] : undefined))
        if (draft.k === 'call' && cell !== undefined && cell !== id) draft.within = cell
        events.push(draft)
        open.set(id, edits)
      }
      /** How a call went: the first result wins. */
      const settle = (id: string | undefined, status: Status) => {
        const edits = id === undefined ? undefined : open.get(id)
        if (!edits) return
        open.delete(id!)
        events.push({ at, by: 'agent', k: 'result', call: id!, status, rework: status === 'ok' ? reworks(tracker, edits) : undefined })
      }

      if (l.type === 'response_item' && p.type === 'reasoning') events.push({ at, by: 'agent', k: 'think', text: blockText(p.summary, 'summary_text') })
      if (l.type === 'response_item' && p.type === 'message' && p.role === 'assistant') {
        const reply = blockText(p.content, 'output_text')
        if (reply) events.push({ at, by: 'agent', k: 'reply', text: reply })
      }
      const prompt = promptText(l)
      if (prompt !== undefined) events.push({ at, by: 'you', k: 'prompt', origin: 'typed', text: prompt || undefined })
      if (isUserShell(l)) events.push({ at, by: 'you', k: 'shell' })

      const id = p.call_id
      if (l.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call') && id && p.name) {
        let args: Record<string, unknown> = {}
        try {
          if (p.arguments) args = JSON.parse(p.arguments)
        } catch {}
        if (p.name === CODE_CELL) {
          // Code mode: the script is a call; the calls it makes are within it.
          start(id, p.name)
          cell = id
        } else if (isAskTool(p.name)) {
          if (!calls.has(id)) {
            calls.add(id)
            asks.add(id)
            events.push({ at, by: 'agent', k: 'ask', call: id })
          }
        } else if (POLLING.has(p.name)) {
          if (typeof args.session_id === 'string' || typeof args.session_id === 'number') polls.set(id, String(args.session_id))
        } else {
          // exec_command takes cmd, shell_command a string, the older shell an argv.
          const command = typeof args.cmd === 'string' ? args.cmd : argv(args.command as string[] | string | undefined)
          const patch = p.name === 'apply_patch' ? (p.input ?? (typeof args.input === 'string' ? args.input : undefined)) : undefined
          start(id, p.name, command, patch ? patchEdits(patch) : [])
        }
      } else if (l.type === 'response_item' && p.type === 'web_search_call') {
        const web = p.id ?? `${WEB}:${calls.size}`
        start(web, WEB)
        const o = statusOutcome(p)
        if (o) settle(web, o)
      } else if (l.type === 'response_item' && p.type === 'tool_search_call' && id) {
        // Looking up which tools there are: the call carries its own status.
        start(id, 'tool_search')
        const o = statusOutcome(p)
        if (o) settle(id, o)
      } else if (l.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && id) {
        if (asks.delete(id)) {
          events.push({ at, by: 'you', k: 'answer', call: id, text: outputText(p.output) })
        } else {
          const { outcome, running } = readOutput(outputText(p.output))
          // A poll's output is about the command it polled.
          const polled = polls.get(id)
          const target = polled !== undefined ? processes.get(polled) : id
          if (running !== undefined && target !== undefined) processes.set(running, target)
          // A command still running has no result yet.
          else if (target !== undefined) settle(target, statusOf(outcome))
          if (id === cell) cell = undefined
        }
      } else if (l.type === 'event_msg') {
        // End events and items: settle a known call, or record an action a code-mode script ran.
        let item: { id?: string; tool: string; outcome?: Outcome; command?: string; changes?: Changes; path?: string } | undefined
        if (p.type === 'exec_command_end' || p.type === 'patch_apply_end' || p.type === 'mcp_tool_call_end') {
          const outcome =
            p.type === 'mcp_tool_call_end'
              ? p.result?.Err !== undefined || p.result?.Ok?.isError ? 'failed' : p.result?.Ok ? 'ok' : undefined
              : statusOutcome(p)
          const tool = p.type === 'exec_command_end' ? 'exec_command' : p.type === 'patch_apply_end' ? 'apply_patch' : 'mcp'
          item = { id, tool, outcome, command: argv(p.command), changes: p.changes }
        } else if (p.type === 'item_completed' && p.item?.type && ACTION_ITEMS.has(p.item.type)) {
          const it = p.item
          item = { id: it.id, tool: it.tool ?? it.type!, outcome: statusOutcome(it), command: argv(it.command), changes: it.changes }
        } else if (p.type === 'item_completed' && p.item?.type === 'ImageView') {
          // The agent looked at an image; a completed item has no status of its own.
          item = { id: p.item.id ?? `image:${calls.size}`, tool: 'ImageView', outcome: 'ok', path: p.item.path }
        } else if (p.type === 'item_completed' && isWebItem(p.item)) {
          // A completed web item has no status of its own.
          item = { id: p.item!.id, tool: WEB, outcome: statusOutcome(p.item!) ?? 'ok' }
        }
        if (item?.id) {
          start(item.id, item.tool, item.command, changesEdits(item.changes), item.path ? [item.path] : undefined)
          if (item.outcome) settle(item.id, item.outcome)
        }
        if (p.type === 'turn_aborted' && p.reason === 'interrupted') events.push({ at, by: 'you', k: 'interrupt' })
      }
      if (l.type === 'compacted') events.push({ at, by: 'system', k: 'compact' })

      if (l.type === 'token_usage_record' && p.usage) {
        // Newer logs record each response's usage; token_count then repeats it, and misses some.
        usageRecords = true
        events.push({ at, by: 'agent', k: 'usage', tokens: tokens(p.usage) })
      } else if (l.type === 'event_msg' && p.type === 'token_count' && p.info?.total_token_usage) {
        // Older logs: running totals, so record only what grew since the last report.
        const total = tokens(p.info.total_token_usage)
        events.push({
          at, by: 'agent', k: 'usage',
          tokens: {
            input: Math.max(0, total.input - lastTotal.input),
            output: Math.max(0, total.output - lastTotal.output),
            cacheRead: Math.max(0, total.cacheRead - lastTotal.cacheRead),
            cacheWrite: Math.max(0, total.cacheWrite - lastTotal.cacheWrite),
          },
        })
        lastTotal = total
      }
      return { at, events }
    },
    label: (l: Line) => {
      const p = l.payload ?? {}
      return {
        what: [l.type, p.type, p.role ?? p.item?.type].filter(Boolean).join(':'),
        tag: (l.type === 'response_item' && p.type === 'message') || l.type === 'world_state' ? 'context'
          : LOGS.has(l.type!) || (l.type === 'event_msg' && EVENT_LOGS.has(p.type!)) ? 'log'
          : undefined,
      }
    },
  }
}
