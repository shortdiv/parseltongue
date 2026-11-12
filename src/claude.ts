import type { SessionAccumulator } from './accumulator.js'
import { classify } from './kinds.js'
import { isAskTool, isCommitCommand, isPushCommand, isTestCommand, type CallStep } from './timeline.js'
import { parseISO } from './types.js'

/**
 * Claude Code transcripts: ~/.claude/projects/<project>/<session>.jsonl.
 * Only the fields we read; anything may be absent.
 */
interface Line {
  type?: string
  subtype?: string
  timestamp?: string
  version?: string
  cwd?: string
  gitBranch?: string
  isMeta?: boolean
  isSidechain?: boolean
  isCompactSummary?: boolean
  /** Who a user line came from: "human" for what you typed, else e.g. "task-notification". Newer logs only. */
  origin?: { kind?: string }
  attachment?: { type?: string; commandMode?: string; prompt?: string | Block[] }
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
  content?: string | { text?: string }[]
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

export function ingestClaudeLine(acc: SessionAccumulator, raw: string) {
  let line: Line
  try {
    line = JSON.parse(raw)
  } catch {
    return
  }
  if (!line || typeof line !== 'object') return
  const at = parseISO(line.timestamp)
  if (at === undefined) return

  if (acc.projectPath === undefined && line.cwd) acc.projectPath = line.cwd
  if (line.version) acc.version = line.version
  if (line.gitBranch && line.gitBranch !== 'HEAD') acc.branch = line.gitBranch
  const typed = claudeTyped(line)
  const text = typed?.text
  acc.event(at, text !== undefined && !typed?.shell && !isInterrupt(text))
  countSignals(acc, line, typed, at)

  // One response is logged across several lines that repeat the same usage,
  // so count each message id once.
  const msg = line.message
  if (line.type === 'assistant' && msg?.usage) {
    if (msg.id) {
      if (acc.seenMessageIds.has(msg.id)) return
      acc.seenMessageIds.add(msg.id)
    }
    if (msg.model && !msg.model.startsWith('<')) acc.model = msg.model
    const u = msg.usage
    acc.addTokens(
      {
        input: u.input_tokens ?? 0,
        output: u.output_tokens ?? 0,
        cacheRead: u.cache_read_input_tokens ?? 0,
        cacheWrite: u.cache_creation_input_tokens ?? 0,
      },
      at,
    )
  }
}

function countSignals(acc: SessionAccumulator, line: Line, typed: ReturnType<typeof claudeTyped>, at: number) {
  const text = typed?.text
  const signals = acc.signals
  const timeline = acc.timeline
  if (line.type === 'system' && line.subtype === 'compact_boundary') {
    signals.compactions++
    timeline.push({ at, k: 'compact' })
  }
  if (isInterrupt(text)) {
    if (!acc.afterDecline) {
      signals.interrupts++
      timeline.push({ at, k: 'interrupt' })
    }
  } else if (typed?.shell) {
    timeline.push({ at, k: 'shell' })
  } else if (text !== undefined) {
    signals.prompts++
    timeline.push({ at, k: 'prompt' })
  }
  if (text !== undefined || line.type === 'assistant') acc.afterDecline = false
  if (line.isSidechain) return

  for (const block of blocks(line)) {
    if (block.type === 'tool_use') {
      if (!block.id || acc.seenToolIds.has(block.id)) continue
      acc.seenToolIds.add(block.id)
      if (block.name && isAskTool(block.name)) {
        acc.asks.add(block.id)
        timeline.push({ at, k: 'ask', call: block.id })
        continue
      }
      signals.toolCalls++
      const step: CallStep = { at, k: 'call', id: block.id, tool: block.name ?? 'unknown' }
      timeline.push(step)
      acc.pendingCalls.set(block.id, step)
      const input = block.input
      if (input?.command !== undefined) {
        if (isTestCommand(input.command)) step.test = true
        if (isCommitCommand(input.command)) step.commit = true
        if (isPushCommand(input.command)) step.push = true
      }
      classify(step, typeof input?.command === 'string' ? input.command : undefined)
      const file = input?.file_path ?? input?.notebook_path
      if (!input || !file) continue
      step.paths = [file]
      const edits = input.edits ?? [{ old_string: input.old_string, new_string: input.new_string ?? input.content }]
      for (const { old_string, new_string } of edits) {
        if (old_string !== undefined && acc.rework.isRework(old_string, file)) {
          signals.rework++
          step.rework = true
        }
        if (new_string !== undefined) acc.rework.wrote(new_string, file)
      }
    } else if (block.type === 'tool_result') {
      const step = block.tool_use_id ? acc.pendingCalls.get(block.tool_use_id) : undefined
      if (block.tool_use_id) acc.pendingCalls.delete(block.tool_use_id)
      const asked = block.tool_use_id !== undefined && acc.asks.delete(block.tool_use_id)
      const declined = block.is_error && resultText(block)?.includes("doesn't want to proceed")
      if (asked && !declined) {
        timeline.push({ at, k: 'answer', call: block.tool_use_id! })
        continue
      }
      if (!block.is_error) {
        if (step) step.ok = true
        continue
      }
      // A declined tool call comes back as an error carrying this message.
      const result = resultText(block)
      if (result?.includes("doesn't want to proceed")) {
        signals.rejections++
        acc.afterDecline = true
        if (step) acc.declined.add(step)
        timeline.push({ at, k: 'decline' })
      } else if (result?.startsWith('[Request interrupted')) {
        if (step) acc.interrupted.add(step)
      } else {
        signals.failedCalls++
        if (step) step.ok = false
      }
    }
  }
}
