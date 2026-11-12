import type { SessionAccumulator } from './accumulator.js'
import { classify } from './kinds.js'
import { isAskTool, isCommitCommand, isPushCommand, isTestCommand, type CallStep } from './timeline.js'
import { parseISO, type TokenCounts } from './types.js'

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

/**
 * Codex also logs injected context as user messages: tags like
 * <environment_context>, and the contents of AGENTS.md.
 */
export const isInjectedCodexText = (text: string) => {
  const t = text.trimStart()
  return t.startsWith('<') || t.startsWith('# AGENTS.md instructions')
}

/** Your prompt's text, if this line is one. */
export function promptText(l: Line): string | undefined {
  const p = l.payload
  if (l.type !== 'response_item' || p?.type !== 'message' || p.role !== 'user') return undefined
  const text = p.content?.find((c) => c.type === 'input_text')?.text
  return text && !isInjectedCodexText(text) ? text : undefined
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
function patchEdits(patch: string, file?: string): { file: string; removed: string; added: string }[] {
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
  return edits.map((e) => ({ file: e.file, removed: e.removed.join('\n'), added: e.added.join('\n') }))
}

function startCall(acc: SessionAccumulator, at: number, id: string, tool: string, command?: string, patches: ReturnType<typeof patchEdits> = []) {
  if (acc.seenToolIds.has(id)) return acc.pendingCalls.get(id)
  acc.seenToolIds.add(id)
  acc.signals.toolCalls++
  const step: CallStep = { at, k: 'call', id, tool }
  acc.timeline.push(step)
  acc.pendingCalls.set(id, step)
  if (command !== undefined) {
    if (isTestCommand(command)) step.test = true
    if (isCommitCommand(command)) step.commit = true
    if (isPushCommand(command)) step.push = true
  }
  classify(step, command)
  if (patches.length) step.paths = [...new Set(patches.map((p) => p.file))]
  for (const { file, removed, added } of patches) {
    if (removed && acc.rework.isRework(removed, file)) {
      acc.signals.rework++
      step.rework = true
    }
    if (added) acc.rework.wrote(added, file)
  }
  return step
}

/** The first outcome we learn for a call wins. */
function settle(acc: SessionAccumulator, at: number, step: CallStep | undefined, outcome: Outcome | undefined) {
  if (!step || !outcome || acc.settledCalls.has(step)) return
  acc.settledCalls.add(step)
  if (outcome === 'ok') step.ok = true
  else if (outcome === 'failed') {
    step.ok = false
    acc.signals.failedCalls++
  } else {
    acc.signals.rejections++
    acc.declined.add(step)
    acc.timeline.push({ at, k: 'decline' })
  }
}

const argv = (c: string[] | string | undefined) => (Array.isArray(c) ? c.join(' ') : c)

const changesEdits = (changes: Changes | undefined) =>
  Object.entries(changes ?? {}).flatMap(([file, c]) =>
    c.unified_diff !== undefined ? patchEdits(c.unified_diff, file) : c.content ? [{ file, removed: '', added: c.content }] : [],
  )

/** One tool-call line: a call, a result, or an inner action of a code-mode script. */
function ingestTool(acc: SessionAccumulator, line: Line, at: number) {
  const p = line.payload
  if (!p) return
  const id = p.call_id

  if (line.type === 'response_item' && (p.type === 'function_call' || p.type === 'custom_tool_call') && id && p.name) {
    if (p.name === CODE_CELL) return
    let args: Record<string, unknown> = {}
    try {
      if (p.arguments) args = JSON.parse(p.arguments)
    } catch {}
    if (isAskTool(p.name)) {
      if (acc.seenToolIds.has(id)) return
      acc.seenToolIds.add(id)
      acc.asks.add(id)
      acc.timeline.push({ at, k: 'ask', call: id })
      return
    }
    if (POLLING.has(p.name)) {
      if (typeof args.session_id === 'string' || typeof args.session_id === 'number') acc.polls.set(id, String(args.session_id))
      return
    }
    // exec_command takes cmd, shell_command a string, the older shell an argv.
    const command = typeof args.cmd === 'string' ? args.cmd : argv(args.command as string[] | string | undefined)
    const patch = p.name === 'apply_patch' ? (p.input ?? (typeof args.input === 'string' ? args.input : undefined)) : undefined
    startCall(acc, at, id, p.name, command, patch ? patchEdits(patch) : [])
    return
  }

  if (line.type === 'response_item' && p.type === 'web_search_call') {
    const step = startCall(acc, at, p.id ?? `${WEB}:${acc.seenToolIds.size}`, WEB)
    settle(acc, at, step, statusOutcome(p))
    return
  }

  // Looking up which tools there are: the call carries its own status.
  if (line.type === 'response_item' && p.type === 'tool_search_call' && id) {
    settle(acc, at, startCall(acc, at, id, 'tool_search'), statusOutcome(p))
    return
  }

  if (line.type === 'response_item' && (p.type === 'function_call_output' || p.type === 'custom_tool_call_output') && id) {
    if (acc.asks.delete(id)) {
      acc.timeline.push({ at, k: 'answer', call: id })
      return
    }
    const { outcome, running } = readOutput(outputText(p.output))
    const polled = acc.polls.get(id)
    if (polled !== undefined) {
      // A poll's output finishes the command it was polling.
      settle(acc, at, acc.processes.get(polled), outcome)
      if (running !== undefined) acc.processes.set(running, acc.processes.get(polled)!)
      return
    }
    const step = acc.pendingCalls.get(id)
    if (running !== undefined && step) acc.processes.set(running, step)
    settle(acc, at, step, outcome)
    return
  }

  if (line.type !== 'event_msg') return
  // End events and items: settle a known call, or record an action a code-mode script ran.
  let item: { id?: string; tool: string; outcome?: Outcome; command?: string; changes?: Changes } | undefined
  if (p.type === 'exec_command_end' || p.type === 'patch_apply_end' || p.type === 'mcp_tool_call_end') {
    const outcome =
      p.type === 'mcp_tool_call_end'
        ? p.result?.Err !== undefined || p.result?.Ok?.isError
          ? 'failed'
          : p.result?.Ok
            ? 'ok'
            : undefined
        : statusOutcome(p)
    const tool = p.type === 'exec_command_end' ? 'exec_command' : p.type === 'patch_apply_end' ? 'apply_patch' : 'mcp'
    item = { id, tool, outcome, command: argv(p.command), changes: p.changes }
  } else if (p.type === 'item_completed' && p.item?.type && ACTION_ITEMS.has(p.item.type)) {
    const it = p.item
    item = { id: it.id, tool: it.tool ?? it.type!, outcome: statusOutcome(it), command: argv(it.command), changes: it.changes }
  } else if (p.type === 'item_completed' && p.item?.type === 'ImageView') {
    // The agent looked at an image; a completed item has no status of its own.
    const step = startCall(acc, at, p.item.id ?? `image:${acc.seenToolIds.size}`, 'ImageView')
    if (step && p.item.path) step.paths ??= [p.item.path]
    settle(acc, at, step, 'ok')
    return
  } else if (p.type === 'item_completed' && isWebItem(p.item)) {
    // A completed web item has no status of its own.
    item = { id: p.item!.id, tool: WEB, outcome: statusOutcome(p.item!) ?? 'ok' }
  }
  if (!item?.id) return
  if (!acc.pendingCalls.has(item.id)) {
    startCall(acc, at, item.id, item.tool, item.command, changesEdits(item.changes))
  }
  settle(acc, at, acc.pendingCalls.get(item.id), item.outcome)
}

/** Codex reports running totals for the whole session. */
function cumulativeTokens(l: Line): TokenCounts | undefined {
  const u = l.payload?.info?.total_token_usage
  return l.type === 'event_msg' && l.payload?.type === 'token_count' && u ? tokens(u) : undefined
}

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

/** Codex doesn't log the branch; the caller resolves it from the project folder. */
export function ingestCodexLine(acc: SessionAccumulator, raw: string) {
  let line: Line
  try {
    line = JSON.parse(raw)
  } catch {
    return
  }
  if (!line || typeof line !== 'object') return
  const at = parseISO(line.timestamp)
  if (at === undefined) return
  const p = line.payload

  if (p?.cwd && acc.projectPath === undefined) acc.projectPath = p.cwd
  if (line.type === 'turn_context' && p?.model) acc.model = p.model
  if (line.type === 'turn_context' && p?.approval_policy) acc.asksApproval ||= p.approval_policy !== 'never'
  if (line.type === 'session_meta' && p?.cli_version) acc.version = p.cli_version

  const prompt = promptText(line)
  acc.event(at, prompt !== undefined || (line.type === 'event_msg' && p?.type === 'user_message'))

  const signals = acc.signals
  const timeline = acc.timeline
  if (prompt !== undefined) {
    signals.prompts++
    timeline.push({ at, k: 'prompt' })
  }
  ingestTool(acc, line, at)
  if (line.type === 'event_msg' && p?.type === 'turn_aborted' && p.reason === 'interrupted') {
    signals.interrupts++
    timeline.push({ at, k: 'interrupt' })
  }
  if (line.type === 'compacted') {
    signals.compactions++
    timeline.push({ at, k: 'compact' })
  }

  // Newer logs record each response's usage; token_count then repeats it, and misses some.
  if (line.type === 'token_usage_record' && p?.usage) {
    acc.usageRecords = true
    acc.addTokens(tokens(p.usage), at)
    return
  }
  // Older logs: running totals, so record only what grew since the last report.
  const total = acc.usageRecords ? undefined : cumulativeTokens(line)
  if (total) {
    const prev = acc.lastCumulative
    acc.addTokens(
      {
        input: Math.max(0, total.input - prev.input),
        output: Math.max(0, total.output - prev.output),
        cacheRead: Math.max(0, total.cacheRead - prev.cacheRead),
        cacheWrite: Math.max(0, total.cacheWrite - prev.cacheWrite),
      },
      at,
    )
    acc.lastCumulative = total
  }
}
