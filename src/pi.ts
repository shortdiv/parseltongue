import { callDraft } from './commands.js'
import { blockText, readWith, type Adapter, type Draft, type Reader, type SessionEvent, type Status } from './events.js'
import { reworks, ReworkTracker, type Edit } from './rework.js'
import { parseISO } from './util.js'

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

/** Text-free topology: each entry, its parent, and the ids of the events it produced. */
export interface PiEntry {
  id: string
  parentId: string | null
  type: string
  at: number
  role?: string
  fromId?: string
  firstKeptEntryId?: string
  events: string[]
}

/** A pi reader also keeps the session's tree, to follow one branch of it. */
export interface PiReader extends Reader {
  readonly metadata: PiMetadata
  readonly entries: Map<string, PiEntry>
  readonly diagnostics: { malformedLines: number; ignoredLines: number; duplicateEntries: number; orphanResults: number }
  /** Last persisted entry; navigation without an append isn't recorded by JSONL. */
  readonly leafId?: string
  /** Full ancestry of an entry, not the compacted model context. Missing links and cycles are explicit. */
  getPath(leafId?: string): { entries: PiEntry[]; complete: boolean }
}

/**
 * pi JSONL (v1 linear and v2/v3 tree sessions). Events come from every entry in
 * append order, abandoned branches included: compaction and context edits change
 * what the model sees, not work already done. getPath selects one branch.
 */
export function piReader(opts: { text?: boolean } = {}): PiReader {
  const metadata: PiMetadata = {}
  const entries = new Map<string, PiEntry>()
  const diagnostics = { malformedLines: 0, ignoredLines: 0, duplicateEntries: 0, orphanResults: 0 }
  const calls = new Set<string>()
  /** Calls waiting for their result, with the edits they'd make. */
  const open = new Map<string, Edit[]>()
  const tracker = new ReworkTracker()
  let leaf: PiEntry | undefined
  let lineNumber = 0

  const usage = (value: unknown, at: number): Draft[] => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return []
    const u = object(value)
    // reasoning is already in output; cacheWrite1h is already in cacheWrite.
    const cost = number(object(u.cost).total)
    return [{ at, by: 'agent', k: 'usage', tokens: { input: number(u.input), output: number(u.output), cacheRead: number(u.cacheRead), cacheWrite: number(u.cacheWrite) }, cost: cost || undefined }]
  }

  const adapter: Adapter = {
    info: {},
    line: () => lineNumber++,
    damaged: (json) => (json ? diagnostics.ignoredLines++ : diagnostics.malformedLines++),
    read(line) {
      const type = string(line.type)
      const at = parseISO(line.timestamp)
      if (!type || at === undefined) {
        diagnostics.ignoredLines++
        return undefined
      }
      if (type === 'session') {
        metadata.id = string(line.id)
        metadata.formatVersion = typeof line.version === 'number' ? line.version : 1
        metadata.parentSession = string(line.parentSession)
        adapter.info.id = metadata.id ?? ''
        adapter.info.cwd = string(line.cwd)
        if (metadata.parentSession) adapter.info.parent = { session: metadata.parentSession, via: 'fork' }
        return undefined
      }

      const legacy = metadata.formatVersion === 1
      const id = string(line.id) ?? (legacy ? `legacy:${lineNumber}` : undefined)
      if (!id || (!legacy && line.parentId !== null && typeof line.parentId !== 'string')) {
        diagnostics.ignoredLines++
        return undefined
      }
      if (entries.has(id)) {
        diagnostics.duplicateEntries++
        return undefined
      }
      const msg = object(line.message)
      const role = string(msg.role)
      leaf = {
        id,
        parentId: legacy ? leaf?.id ?? null : line.parentId as string | null,
        type,
        at,
        role,
        fromId: string(line.fromId),
        firstKeptEntryId: string(line.firstKeptEntryId),
        events: [],
      }
      entries.set(id, leaf)

      const events: Draft[] = []
      if (type === 'session_info') metadata.name = string(line.name)
      if (type === 'model_change' && typeof line.modelId === 'string') adapter.info.model = line.modelId
      if (type === 'compaction') events.push({ at, by: 'system', k: 'compact' })
      if (type === 'usage' || type === 'compaction' || type === 'branch_summary') events.push(...usage(line.usage, at))
      if (type === 'message') {
        if (role === 'user') {
          // Image-only prompts count too; custom and system messages don't.
          const c = msg.content
          events.push({ at, by: 'you', k: 'prompt', origin: 'typed', text: (typeof c === 'string' ? c : blockText(c)) || undefined })
        } else if (role === 'assistant') {
          if (typeof msg.model === 'string') adapter.info.model = msg.model
          if (blocks(msg.content).some((b) => b.type === 'thinking')) events.push({ at, by: 'agent', k: 'think', text: blockText(msg.content, 'thinking', 'thinking') })
          const reply = blockText(msg.content)
          if (reply) events.push({ at, by: 'agent', k: 'reply', text: reply })
          for (const block of blocks(msg.content)) if (block.type === 'toolCall') events.push(...call(block, at))
          if (msg.stopReason === 'aborted') events.push({ at, by: 'you', k: 'interrupt' })
          events.push(...usage(msg.usage, at))
        } else if (role === 'toolResult') {
          events.push(...result(msg, at))
          events.push(...usage(msg.usage, at)) // Optional nested model work, not main-call usage.
        } else if (role === 'bashExecution') {
          // A shell command you ran yourself, not an agent tool or prompt.
          events.push({ at, by: 'you', k: 'shell' })
        }
      }
      return { at, events }
    },
    emitted: (events: SessionEvent[]) => leaf?.events.push(...events.map((e) => e.id)),
    label: (l) => ({
      what: [l.type, l.message?.role].filter(Boolean).join(':'),
      tag: l.type === 'message' ? 'context' : l.type === 'session_info' || l.type === 'label' ? 'log' : undefined,
    }),
    warnings: () => [
      ...(diagnostics.malformedLines ? [`${diagnostics.malformedLines} malformed JSONL lines skipped`] : []),
      ...(diagnostics.ignoredLines ? [`${diagnostics.ignoredLines} invalid entries skipped`] : []),
      ...(getPath().complete ? [] : ['Incomplete or cyclic ancestry; every branch retained']),
    ],
  }

  function call(block: Json, at: number): Draft[] {
    const id = string(block.id)
    if (!id || calls.has(id)) return []
    calls.add(id)
    const tool = string(block.name) || 'unknown'
    const args = object(block.arguments)
    const command = tool === 'bash' ? (string(args.command) ?? string(args.cmd)) : undefined
    const file = string(args.path)
    const named = file && (tool === 'read' || tool === 'edit' || tool === 'write') ? [file] : undefined
    let edits: Edit[] = []
    if (file && tool === 'write') edits = [{ file, next: string(args.content) }]
    else if (file && tool === 'edit') {
      const changes = Array.isArray(args.edits) ? blocks(args.edits) : [args]
      edits = changes.map(e => ({ file, old: string(e.oldText) ?? string(e.old_string), next: string(e.newText) ?? string(e.new_string) }))
    }
    open.set(id, edits)
    return [callDraft(at, id, tool, command, named)]
  }

  function result(msg: Json, at: number): Draft[] {
    const id = string(msg.toolCallId)
    const edits = id ? open.get(id) : undefined
    if (!id || !edits) {
      diagnostics.orphanResults++
      return []
    }
    open.delete(id)
    // Cancellation is not a failure: the assistant's aborted message records the interrupt.
    const cancelled = msg.isError === true && /^(?:command|tool execution|operation) aborted\.?$/i.test(text(msg.content).trim())
    const status: Status = cancelled ? 'interrupted' : typeof msg.isError !== 'boolean' ? 'unknown' : msg.isError ? 'failed' : 'ok'
    // Only successful edits establish authorship: a failed write mustn't make a later edit look like rework.
    return [{ at, by: 'agent', k: 'result', call: id, status, rework: status === 'ok' ? reworks(tracker, edits) : undefined }]
  }

  function getPath(leafId = leaf?.id): { entries: PiEntry[]; complete: boolean } {
    const path: PiEntry[] = []
    const seen = new Set<string>()
    let id: string | null | undefined = leafId
    while (id != null) {
      const entry = entries.get(id)
      if (!entry || seen.has(id)) return { entries: path.reverse(), complete: false }
      seen.add(id)
      path.push(entry)
      id = entry.parentId
    }
    return { entries: path.reverse(), complete: true }
  }

  const reader = readWith('pi', adapter, opts)
  return {
    ...reader,
    metadata,
    entries,
    diagnostics,
    getPath,
    get leafId() {
      return leaf?.id
    },
  }
}
