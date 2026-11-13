import { claudeReader } from './claude.js'
import { codexReader } from './codex.js'
import { detect, FormatError } from './detect.js'
import { type Harness, type LogHarness, type Reader, type Session, type SessionText } from './events.js'
import { opencodeReader, cursorReader, zedReader, type OpencodeRow, type CursorBubble, type ZedThread } from './rows.js'
import { piReader, type PiReader } from './pi.js'

type Inputs = { claude: string; codex: string; pi: string; opencode: OpencodeRow; cursor: CursorBubble; zed: ZedThread }
type Options<H extends Harness> = H extends LogHarness ? { text?: boolean } : { id?: string }
/** text is there when { text: true } is passed, maybe there for a boolean, never otherwise. */
type WithText<O> = O extends { text: true } ? { text: SessionText } : 'text' extends keyof O ? { text?: SessionText } : {}
type ReaderFor<H extends Harness, O> = (H extends 'pi' ? PiReader : Reader<Inputs[H]>) & WithText<O>

const readers = {
  claude: claudeReader,
  codex: codexReader,
  pi: piReader,
  opencode: opencodeReader,
  cursor: cursorReader,
  zed: zedReader,
} satisfies Record<Harness, unknown>

/**
 * Reads one harness's log lines or database rows as the session is written.
 * Each event comes out once, finished: a call's outcome arrives later as its result.
 */
export function reader<H extends Harness, O extends Options<H> = {}>(agent: H, opts?: O): ReaderFor<H, O>
export function reader(agent: Harness, opts: { text?: boolean; id?: string } = {}): Reader<any> {
  if (!Object.hasOwn(readers, agent)) throw new TypeError(`Unsupported agent: ${String(agent)}`)
  return readers[agent](opts)
}

/**
 * A session as a list of events, without its text. With { text: true }, also the
 * text behind your prompts and answers and the agent's replies and reasoning, by event id.
 * Throws a FormatError when the log's harness is unknown; detect says so without throwing.
 */
export function parseSession(raw: string): Session
export function parseSession(raw: string, opts: { text: true }): Session & { text: SessionText }
export function parseSession(raw: string, opts?: { text?: boolean }): Session & { text?: SessionText }
export function parseSession(raw: string, opts: { text?: boolean } = {}): Session & { text?: SessionText } {
  const found = detect(raw)
  if (found.agent === 'unknown') throw new FormatError(found)
  const r = reader(found.agent, opts)
  for (const line of raw.split('\n')) r.read(line)
  return r.text ? { ...r.session(), text: r.text } : r.session()
}
