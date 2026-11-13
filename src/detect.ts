import type { LogHarness } from './events.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})

const CODEX_ITEMS = ['message', 'function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'reasoning']

/** Harnesses detected but not read yet: their logs are unknown, with a warning that names them. */
const UNSUPPORTED = { gemini: 'Gemini CLI', qwen: 'Qwen Code' } as const
const NAMES = { claude: 'Claude Code', codex: 'Codex', pi: 'pi', ...UNSUPPORTED }
type Signature = keyof typeof NAMES

/** Every signature in a log's first 250 records: one JSON document (older Gemini exports) or JSON lines. */
function signatures(raw: string): Signature[] {
  raw = raw.replace(/^\uFEFF/, '')
  const records: unknown[] = []
  try {
    records.push(JSON.parse(raw))
  } catch {
    for (const line of raw.split('\n')) {
      if (records.length === 250) break
      if (!line.trim()) continue
      try {
        records.push(JSON.parse(line))
      } catch {
        records.push(undefined)
      }
    }
  }
  const found = new Set<Signature>()
  for (const record of records) {
    const l = object(record)
    const m = object(l.message)
    if (l.type === 'session' && typeof l.id === 'string' && (typeof l.version === 'number' || typeof l.cwd === 'string')) found.add('pi')
    if (l.type === 'session_meta' && typeof l.payload === 'object') found.add('codex')
    if (l.type === 'response_item' && CODEX_ITEMS.includes(String(object(l.payload).type))) found.add('codex')
    if (['user', 'assistant'].includes(String(l.type)) && typeof l.timestamp === 'string' && 'content' in m && !('parts' in m)) found.add('claude')
    if (typeof l.sessionId === 'string' && typeof l.projectHash === 'string') found.add('gemini')
    if (l.type === 'gemini' && typeof l.id === 'string' && ('content' in l || 'toolCalls' in l)) found.add('gemini')
    if (typeof l.uuid === 'string' && typeof l.sessionId === 'string' && (Array.isArray(m.parts) || 'toolCallResult' in l)) found.add('qwen')
  }
  return [...found]
}

/** Which harness wrote a log: one parseSession and reader read, or unknown with the reason. */
export interface Detection {
  agent: LogHarness | 'unknown'
  warning?: string
}

/**
 * Which harness wrote a log, from the signatures in its first 250 records: its content,
 * never filenames or model names. A log that matches none, several, or a harness that
 * isn't read yet is unknown, with a warning that says which.
 * Only logs are detected: database rows come from a database you already know.
 */
export function detect(raw: string): Detection {
  const found = signatures(raw)
  if (found.length > 1) return { agent: 'unknown', warning: `Ambiguous format: looks like ${found.map((f) => NAMES[f]).join(' and ')}` }
  const [format] = found
  if (format === undefined) return { agent: 'unknown', warning: 'Unrecognised format' }
  if (format in UNSUPPORTED) return { agent: 'unknown', warning: `${NAMES[format]} logs aren't supported yet` }
  return { agent: format as LogHarness }
}
