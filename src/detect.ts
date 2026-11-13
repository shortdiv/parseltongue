import type { LogHarness } from './events.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})

const CODEX_ITEMS = ['message', 'function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'reasoning']

/** Harnesses detected but not read yet: their logs are unknown, with a warning that names them. */
const UNSUPPORTED = { gemini: 'Gemini CLI', qwen: 'Qwen Code' } as const
const NAMES = { claude: 'Claude Code', codex: 'Codex', pi: 'pi', ...UNSUPPORTED } satisfies Record<DetectedFormat, string>

/** Every signature in a log's first 250 records: one JSON document (older Gemini exports) or JSON lines. */
function signatures(raw: string): DetectedFormat[] {
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
  const found = new Set<DetectedFormat>()
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

/** Why a log's harness is unknown: no signature, several, or a harness that isn't read yet. */
export type FormatCode = 'unrecognised_format' | 'ambiguous_format' | 'unsupported_format'
/** A format detect can name: a harness it reads, or one it recognises but doesn't read yet. */
export type DetectedFormat = LogHarness | 'gemini' | 'qwen'

/** Which harness wrote a log: one parseSession and reader read, or unknown with a code and the formats it saw. */
export type Detection =
  | { agent: LogHarness }
  | { agent: 'unknown'; code: FormatCode; formats: DetectedFormat[]; message: string }

/** parseSession's error for a log it can't read; the same code, formats and message detect returns. */
export class FormatError extends Error {
  override name = 'FormatError'
  readonly code: FormatCode
  readonly formats: DetectedFormat[]
  constructor({ code, formats, message }: Extract<Detection, { agent: 'unknown' }>) {
    super(message)
    this.code = code
    this.formats = formats
  }
}

/**
 * Which harness wrote a log, from the signatures in its first 250 records: its content,
 * never filenames or model names. A log that matches none, several, or a harness that
 * isn't read yet is unknown, with a code that says which.
 * Only logs are detected: database rows come from a database you already know.
 */
export function detect(raw: string): Detection {
  const formats = signatures(raw)
  const [format] = formats
  if (formats.length > 1) return { agent: 'unknown', code: 'ambiguous_format', formats, message: `Ambiguous format: looks like ${formats.map((f) => NAMES[f]).join(' and ')}` }
  if (format === undefined) return { agent: 'unknown', code: 'unrecognised_format', formats, message: 'Unrecognised format' }
  if (format === 'gemini' || format === 'qwen') return { agent: 'unknown', code: 'unsupported_format', formats, message: `${NAMES[format]} logs aren't supported yet` }
  return { agent: format }
}
