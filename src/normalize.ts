import { SessionAccumulator } from './accumulator.js'
import { ingestClaudeLine } from './claude.js'
import { ingestCodexLine, isInjectedCodexText } from './codex.js'
import { PiSessionParser, type PiEntry } from './pi.js'
import type { Step } from './timeline.js'
import { parseISO } from './types.js'

export type Harness = 'claude' | 'codex' | 'pi'
export const agentName = (agent: Harness) => ({ claude: 'Claude Code', codex: 'Codex', pi: 'Pi' })[agent]

export interface Turn {
  at: number
  who: 'you' | 'agent'
  text: string
  entryId?: string
  parentId?: string | null
}

/** Common input to moment construction; no filesystem, rating store or UI dependency. */
export interface NormalizedSession {
  id: string
  file: string
  agent: Harness
  project: string
  /** The folder the session ran in, for reading its git history. */
  cwd?: string
  steps: Step[]
  turns: Turn[]
  parentSession?: string
  entryTree?: PiEntry[]
  warnings?: string[]
}

type Json = Record<string, any>
function* lines(raw: string): Generator<{ raw: string; value: Json }> {
  for (const line of raw.split('\n')) {
    try {
      const value = JSON.parse(line)
      if (value && typeof value === 'object' && !Array.isArray(value)) yield { raw: line, value }
    } catch {}
  }
}
const basename = (path: string) => path.replace(/\/$/, '').split('/').pop() || path
const contentText = (content: unknown): string => typeof content === 'string' ? content : (Array.isArray(content) ? content : [])
  .filter(b => b?.type === 'text' && typeof b.text === 'string').map(b => b.text).join('\n')

/** Detect by header first, so copied corpora needn't live in a harness's home directory. */
export function normalizeSession(raw: string, file = ''): NormalizedSession {
  const header = lines(raw).next().value?.value
  if (header?.type === 'session') return normalizePi(raw, file)
  const codex = header?.type === 'session_meta' || file.includes('/.codex/')
  const acc = new SessionAccumulator()
  const turns: Turn[] = []
  for (const { raw: line, value: l } of lines(raw)) {
    if (codex) ingestCodexLine(acc, line)
    else ingestClaudeLine(acc, line)
    const at = parseISO(l.timestamp)
    if (at === undefined) continue
    if (codex) {
      const p = l.payload
      if (l.type !== 'response_item' || p?.type !== 'message') continue
      const kind = p.role === 'user' ? 'input_text' : p.role === 'assistant' ? 'output_text' : undefined
      const text = (Array.isArray(p.content) ? p.content : []).filter((b: any) => b?.type === kind && typeof b.text === 'string').map((b: any) => b.text).join('\n')
      if (text && kind && !(p.role === 'user' && isInjectedCodexText(text))) turns.push({ at, who: p.role === 'user' ? 'you' : 'agent', text })
    } else {
      if (l.isSidechain) continue
      const c = l.message?.content
      if (l.type === 'user' && !l.isMeta) {
        if (Array.isArray(c) && c.some(b => b?.type === 'tool_result')) continue
        const text = contentText(c)
        if (text && !text.startsWith('[Request interrupted')) turns.push({ at, who: 'you', text })
      } else if (l.type === 'assistant') {
        const text = contentText(c)
        if (text) turns.push({ at, who: 'agent', text })
      }
    }
  }
  return {
    // Preserve existing Claude/Codex IDs so saved judgments still resolve.
    id: `${codex ? 'codex' : 'claude'}:${basename(file).replace(/\.jsonl$/, '')}`,
    file,
    agent: codex ? 'codex' : 'claude',
    project: acc.projectPath ? basename(acc.projectPath) : '?',
    cwd: acc.projectPath,
    steps: acc.timeline,
    turns,
  }
}

function normalizePi(raw: string, file: string): NormalizedSession {
  const parser = new PiSessionParser()
  const turns: Turn[] = []
  for (const line of raw.split('\n')) {
    const before = parser.entries.size
    parser.ingestLine(line)
    if (parser.entries.size === before) continue
    const entry = parser.entries.get(parser.leafId!)!
    if (entry.type !== 'message' || (entry.role !== 'user' && entry.role !== 'assistant')) continue
    const text = contentText(JSON.parse(line).message.content)
    if (text || entry.role === 'user') turns.push({
      at: entry.at, who: entry.role === 'user' ? 'you' : 'agent', text: text || '[non-text prompt]',
      entryId: entry.id, parentId: entry.parentId,
    })
  }
  const warnings: string[] = []
  if (parser.diagnostics.malformedLines) warnings.push(`${parser.diagnostics.malformedLines} malformed JSONL lines skipped`)
  if (parser.diagnostics.ignoredLines) warnings.push(`${parser.diagnostics.ignoredLines} invalid entries skipped`)
  if (!parser.getPath().complete) warnings.push('Incomplete or cyclic ancestry; chronological work retained')
  return {
    id: `pi:${parser.metadata.id ?? basename(file).replace(/\.jsonl$/, '')}`,
    file,
    agent: 'pi',
    project: parser.accumulator.projectPath ? basename(parser.accumulator.projectPath) : '?',
    cwd: parser.accumulator.projectPath,
    steps: parser.accumulator.timeline,
    turns,
    parentSession: parser.metadata.parentSession,
    entryTree: [...parser.entries.values()],
    warnings: warnings.length ? warnings : undefined,
  }
}
