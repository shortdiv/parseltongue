import { claude } from './claude.js'
import { codex } from './codex.js'
import { detect } from './detect.js'
import { readWith, type Harness, type Reader, type Session, type SessionText } from './events.js'
import { opencodeReader, cursorReader, zedReader, type OpencodeRow, type CursorBubble, type ZedThread } from './rows.js'
import { piReader, type PiReader } from './pi.js'

type LogHarness = Extract<Harness, 'claude' | 'codex' | 'pi'>
type Inputs = { claude: string; codex: string; pi: string; opencode: OpencodeRow; cursor: CursorBubble; zed: ZedThread }
type Options<H extends Harness> = H extends LogHarness ? { text?: boolean } : { id?: string }

/**
 * Reads one harness's log lines or database rows as the session is written.
 * Each event comes out once, finished: a call's outcome arrives later as its result.
 */
export function reader(agent: 'pi', opts?: { text?: boolean }): PiReader
export function reader<H extends Harness>(agent: H, opts?: Options<H>): Reader<Inputs[H]>
export function reader(agent: Harness, opts: { text?: boolean; id?: string } = {}): Reader<any> {
  if (agent === 'pi') return piReader(opts)
  if (agent === 'opencode') return opencodeReader(opts)
  if (agent === 'cursor') return cursorReader(opts)
  if (agent === 'zed') return zedReader(opts)
  return readWith(agent, agent === 'codex' ? codex() : claude(), opts)
}

const NAMES = { claude: 'Claude Code', codex: 'Codex', pi: 'pi', gemini: 'Gemini CLI', qwen: 'Qwen Code' }

/** Which harness wrote a log, or why it's unknown. */
function harnessOf(raw: string): { agent: LogHarness | 'unknown'; warning?: string } {
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
  for (const line of raw.split('\n')) r.read(line)
  const session = r.session()
  session.warnings.unshift(...warnings)
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
