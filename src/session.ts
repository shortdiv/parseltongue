import { claude } from './claude.js'
import { codex } from './codex.js'
import { detect } from './detect.js'
import { outcomes, readWith, type Reader, type SessionEvent, type SessionInfo, type SessionText, type Status } from './events.js'
import { piReader, type PiReader } from './pi.js'

/** The harnesses parseSession reads. A log from any other, or one it can't tell, is unknown. */
export type Harness = 'claude' | 'codex' | 'pi'

export interface Session extends SessionInfo {
  id: string
  agent: Harness | 'unknown'
  events: SessionEvent[]
  /** Each call's final status, by call id: its result's, or unknown without one. */
  calls: Record<string, Status>
  warnings: string[]
}

/**
 * Reads one harness's log a line at a time, for following a session as it's written.
 * Each event comes out once, finished: a call's outcome arrives later as its result.
 */
export function reader(agent: 'pi', opts?: { text?: boolean }): PiReader
export function reader(agent: Harness, opts?: { text?: boolean }): Reader
export function reader(agent: Harness, opts: { text?: boolean } = {}): Reader {
  if (agent === 'pi') return piReader(opts)
  return readWith(agent === 'codex' ? codex() : claude(), opts)
}

const NAMES = { claude: 'Claude Code', codex: 'Codex', pi: 'pi', gemini: 'Gemini CLI', qwen: 'Qwen Code' }

/** Which harness wrote a log, or why it's unknown. */
function harnessOf(raw: string): { agent: Harness | 'unknown'; warning?: string } {
  const found = detect(raw)
  if (found.length > 1) return { agent: 'unknown', warning: `Ambiguous format: looks like ${found.map((f) => NAMES[f]).join(' and ')}` }
  const [format] = found
  if (format === undefined) return { agent: 'unknown', warning: 'Unrecognised format' }
  if (format === 'gemini' || format === 'qwen') return { agent: 'unknown', warning: `${NAMES[format]} logs aren't parsed into events; the viewer API reads them` }
  return { agent: format }
}

/** Reads a whole log for parseSession; internal, not exported from the package. */
export function readSession(raw: string) {
  const { agent, warning } = harnessOf(raw)
  const warnings = warning ? [warning] : []
  if (agent === 'unknown') return { session: { id: '', agent, events: [], calls: {}, warnings } as Session, text: new Map() as SessionText }
  const r = reader(agent, { text: true })
  const events = raw.split('\n').flatMap((line) => r.read(line))
  const session: Session = { ...r.info, id: r.info.id ?? '', agent, events, calls: outcomes(events), warnings: [...warnings, ...r.warnings()] }
  for (const k of Object.keys(session) as (keyof Session)[]) if (session[k] === undefined) delete session[k]
  return { session, text: r.text, pi: agent === 'pi' ? (r as PiReader) : undefined }
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
