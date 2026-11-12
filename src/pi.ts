import { SessionAccumulator } from './accumulator.js'
import { classify } from './kinds.js'
import { isCommitCommand, isPushCommand, isTestCommand, type CallStep, type Step } from './timeline.js'
import { parseISO } from './types.js'

type Json = Record<string, unknown>
const object = (v: unknown): Json => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {}
const string = (v: unknown): string | undefined => typeof v === 'string' ? v : undefined
const number = (v: unknown): number => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : 0
const blocks = (v: unknown): Json[] => Array.isArray(v) ? v.map(object) : []
const text = (v: unknown): string => typeof v === 'string' ? v : blocks(v).filter(b => b.type === 'text').map(b => string(b.text) ?? '').join('\n')

export interface PiMetadata {
  id?: string
  /** Session schema version, NOT the Pi package/harness version. */
  formatVersion?: number
  parentSession?: string
  name?: string
}

/** Text-free topology. No prompts, arguments, summaries or tool output retained. */
export interface PiEntry {
  id: string
  parentId: string | null
  type: string
  at: number
  role?: string
  fromId?: string
  firstKeptEntryId?: string
  timelineStart: number
  timelineEnd: number
}

interface Edit {
  file: string
  old?: string
  next?: string
}

/**
 * Incremental Pi JSONL parser (v1 linear and v2/v3 tree sessions).
 *
 * The accumulator accounts for ALL entries in append order, including abandoned
 * branches. Compaction/context edits change model context, not work already done.
 * getPath/getTimeline select a tree path without classifying other paths as waste.
 * No filesystem or Pi SDK dependency; safe to share with desktop and training.
 */
export class PiSessionParser {
  readonly accumulator = new SessionAccumulator()
  readonly metadata: PiMetadata = {}
  readonly entries = new Map<string, PiEntry>()
  readonly diagnostics = { malformedLines: 0, ignoredLines: 0, duplicateEntries: 0, orphanResults: 0 }
  costUsd = 0
  /** Last persisted entry; navigation without an append isn't recorded by JSONL. */
  leafId?: string
  private lineNumber = 0
  private pendingEdits = new Map<string, Edit[]>()

  ingestLine(raw: string): void {
    this.lineNumber++
    if (!raw.trim()) return
    let line: Json
    try {
      line = object(JSON.parse(raw))
    } catch {
      this.diagnostics.malformedLines++
      return
    }
    const type = string(line.type)
    const at = parseISO(line.timestamp)
    if (!type || at === undefined) {
      this.diagnostics.ignoredLines++
      return
    }
    const acc = this.accumulator
    if (type === 'session') {
      this.metadata.id = string(line.id)
      this.metadata.formatVersion = typeof line.version === 'number' ? line.version : 1
      this.metadata.parentSession = string(line.parentSession)
      acc.projectPath = string(line.cwd)
      // Pi's default tools do not request approvals. Never interpret zero
      // rejections as evidence that the user approved all of this work.
      acc.asksApproval = false
      return
    }

    const legacy = this.metadata.formatVersion === 1
    const id = string(line.id) ?? (legacy ? `legacy:${this.lineNumber}` : undefined)
    if (!id || (!legacy && line.parentId !== null && typeof line.parentId !== 'string')) {
      this.diagnostics.ignoredLines++
      return
    }
    if (this.entries.has(id)) {
      this.diagnostics.duplicateEntries++
      return
    }
    const msg = object(line.message)
    const role = string(msg.role)
    const entry: PiEntry = {
      id,
      parentId: legacy ? this.leafId ?? null : line.parentId as string | null,
      type,
      at,
      role,
      fromId: string(line.fromId),
      firstKeptEntryId: string(line.firstKeptEntryId),
      timelineStart: acc.timeline.length,
      timelineEnd: acc.timeline.length,
    }
    this.entries.set(id, entry)
    this.leafId = id

    if (type === 'session_info') this.metadata.name = string(line.name)
    if (type === 'model_change' && typeof line.modelId === 'string') acc.model = line.modelId
    // Metadata entries (labels, settings) aren't activity.
    const activity = type === 'compaction' || type === 'branch_summary' || type === 'usage'
      || (type === 'message' && (role === 'user' || role === 'assistant' || role === 'toolResult' || role === 'bashExecution'))
    if (activity) acc.event(at, type === 'message' && role === 'user')

    if (type === 'compaction') {
      acc.signals.compactions++
      acc.timeline.push({ at, k: 'compact' })
    }
    if (type === 'usage' || type === 'compaction' || type === 'branch_summary') this.usage(line.usage, at)
    if (type === 'message') {
      if (role === 'user') {
        acc.signals.prompts++ // Image-only prompts count too; custom/system messages do not.
        acc.timeline.push({ at, k: 'prompt' })
      } else if (role === 'assistant') {
        if (typeof msg.model === 'string') acc.model = msg.model
        this.usage(msg.usage, at)
        for (const block of blocks(msg.content)) {
          if (block.type === 'toolCall') this.call(block, at)
        }
        if (msg.stopReason === 'aborted') {
          acc.signals.interrupts++
          acc.timeline.push({ at, k: 'interrupt' })
        }
      } else if (role === 'toolResult') {
        this.usage(msg.usage, at) // Optional nested model work, not main-call usage.
        this.result(msg)
      } else if (role === 'bashExecution') {
        // A shell command you ran yourself, not an agent tool or prompt.
        acc.timeline.push({ at, k: 'shell' })
      }
    }
    entry.timelineEnd = acc.timeline.length
  }

  private usage(value: unknown, at: number) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return
    const u = object(value)
    this.accumulator.addTokens({ input: number(u.input), output: number(u.output), cacheRead: number(u.cacheRead), cacheWrite: number(u.cacheWrite) }, at)
    // reasoning is already in output; cacheWrite1h is already in cacheWrite.
    this.costUsd += number(object(u.cost).total)
  }

  private call(block: Json, at: number) {
    const acc = this.accumulator
    const id = string(block.id)
    if (!id || acc.seenToolIds.has(id)) return
    acc.seenToolIds.add(id)
    acc.signals.toolCalls++
    const tool = string(block.name) || 'unknown'
    const step: CallStep = { at, k: 'call', id, tool }
    acc.timeline.push(step)
    acc.pendingCalls.set(id, step)
    const args = object(block.arguments)
    const cmd = tool === 'bash' ? (string(args.command) ?? string(args.cmd)) : undefined
    if (cmd && isTestCommand(cmd)) step.test = true
    if (cmd && isCommitCommand(cmd)) step.commit = true
    if (cmd && isPushCommand(cmd)) step.push = true
    classify(step, cmd)
    const file = string(args.path)
    if (!file) return
    if (tool === 'read' || tool === 'edit' || tool === 'write') step.paths = [file]
    let edits: Edit[] = []
    if (tool === 'write') {
      edits = [{ file, next: string(args.content) }]
    } else if (tool === 'edit') {
      const changes = Array.isArray(args.edits) ? blocks(args.edits) : [args]
      edits = changes.map(e => ({ file, old: string(e.oldText) ?? string(e.old_string), next: string(e.newText) ?? string(e.new_string) }))
    }
    if (edits.length) this.pendingEdits.set(id, edits)
  }

  private result(msg: Json) {
    const acc = this.accumulator
    const id = string(msg.toolCallId)
    const step = id ? acc.pendingCalls.get(id) : undefined
    if (!id || !step) {
      this.diagnostics.orphanResults++
      return
    }
    acc.pendingCalls.delete(id)
    const edits = this.pendingEdits.get(id) ?? []
    this.pendingEdits.delete(id)
    // Cancellation is not a failed test/commit. The assistant's aborted message
    // records the interrupt; don't count it again for each cancelled tool.
    const cancelled = msg.isError === true && /^(?:command|tool execution|operation) aborted\.?$/i.test(text(msg.content).trim())
    if (cancelled) acc.interrupted.add(step)
    if (cancelled || typeof msg.isError !== 'boolean') return
    step.ok = !msg.isError
    if (!step.ok) {
      acc.signals.failedCalls++
      return
    }
    // Only successful edits establish authorship. A failed write must not make
    // a later edit appear to rewrite the agent's own output.
    for (const edit of edits) {
      if (edit.old !== undefined && acc.rework.isRework(edit.old, edit.file)) {
        acc.signals.rework++
        step.rework = true
      }
      if (edit.next !== undefined) acc.rework.wrote(edit.next, edit.file)
    }
  }

  /** Full ancestry, not the compacted LLM context. Missing links/cycles are explicit. */
  getPath(leafId = this.leafId): { entries: PiEntry[]; complete: boolean } {
    const path: PiEntry[] = []
    const seen = new Set<string>()
    let id: string | null | undefined = leafId
    while (id != null) {
      const entry = this.entries.get(id)
      if (!entry || seen.has(id)) return { entries: path.reverse(), complete: false }
      seen.add(id)
      path.push(entry)
      id = entry.parentId
    }
    return { entries: path.reverse(), complete: true }
  }

  /** Branch-path signals; full-session time/tokens remain in accumulator. */
  getTimeline(leafId = this.leafId): Step[] {
    const path = this.getPath(leafId)
    if (!path.complete) throw new Error('Incomplete or cyclic Pi entry path')
    return path.entries.flatMap(e => this.accumulator.timeline.slice(e.timelineStart, e.timelineEnd))
  }
}

export function parsePiSession(jsonl: string | Iterable<string>): PiSessionParser {
  const parser = new PiSessionParser()
  for (const raw of typeof jsonl === 'string' ? jsonl.split('\n') : jsonl) parser.ingestLine(raw)
  return parser
}
