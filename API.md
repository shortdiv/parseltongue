# API reference

Everything `@shortdiv/parseltongue` exports. Four functions, one error class, and the types they use. Every type is exported from [`src/types.ts`](src/types.ts); anything not listed here is internal.

```ts
import { parseSession, reader, detect, isInjectedCodexText, FormatError } from '@shortdiv/parseltongue'
import type { Session, SessionEvent, Reader /* … */ } from '@shortdiv/parseltongue'
```

## Functions

### `parseSession(raw, opts?)`

```ts
function parseSession(raw: string): Session
function parseSession(raw: string, opts: { text: true }): Session & { text: SessionText }
```

Reads a whole Claude Code, Codex or pi log. The harness is detected from the log's content. Throws a [`FormatError`](#formaterror) when the harness is unknown, ambiguous, or not read yet. With `{ text: true }`, also returns the text behind the session's events.

### `reader(agent, opts?)`

```ts
function reader(agent: 'claude' | 'codex' | 'pi', opts?: { text?: boolean }): Reader<string>   // PiReader for 'pi'
function reader(agent: 'opencode', opts?: { id?: string }): Reader<OpencodeRow>
function reader(agent: 'cursor', opts?: { id?: string }): Reader<CursorBubble>
function reader(agent: 'zed', opts?: { id?: string }): Reader<ZedThread>
```

Reads one session as it's written: log lines for Claude Code, Codex and pi, or database rows for opencode, Cursor and Zed. It doesn't detect anything; it reads the harness you name, and throws a `TypeError` for any other name.

- **Log readers:** `{ text: true }` adds `text` to the reader ([`TextReader`](#reader)).
- **Database readers:** `{ id }` sets the session's id, which rows don't carry.

### `detect(raw)`

```ts
function detect(raw: string): Detection
```

Which harness wrote a log, from the signatures in its first 250 records. It never reads the filename and never throws. Database rows aren't detected.

### `isInjectedCodexText(text)`

```ts
function isInjectedCodexText(text: string): boolean
```

Whether a Codex user message is context Codex injected, which opens with one of its own tags like `<environment_context>`, rather than something you typed. The parser already uses it. It's exported for tools that read Codex logs themselves.

## Errors

### `FormatError`

```ts
class FormatError extends Error {
  name: 'FormatError'
  code: FormatCode
  formats: DetectedFormat[]
}
```

Thrown by `parseSession` for a log it can't read. It has the same `code`, `formats` and `message` as `detect` returns.

| `code` | Meaning | `formats` |
|---|---|---|
| `unrecognised_format` | No harness's signature found | `[]` |
| `ambiguous_format` | Signatures of more than one harness | e.g. `['pi', 'claude']` |
| `unsupported_format` | Recognised, but not read yet | `['gemini']` or `['qwen']` |

## Sessions

### `Session`

```ts
interface Session extends SessionInfo {
  agent: Harness
  events: SessionEvent[]
  calls: Record<string, Status>   // each call's final status, by call id
  warnings: string[]
}

interface SessionInfo {
  id?: string
  cwd?: string
  model?: string
  version?: string                // the harness version that wrote the log
  parent?: { session: string; via: 'subagent' | 'fork' }
}
```

Info fields appear as the log reveals them, and are absent when it doesn't. A call with no result is `unknown` in `calls`.

### `SessionEvent`

Every event has:

| Field | Type | |
|---|---|---|
| `id` | `string` | Counts up from `'1'` within a session. Across sessions, key by `session.id` and `event.id`. |
| `at` | `number` | Epoch milliseconds. Events are in log order, which isn't always time order. |
| `by` | `'you' \| 'agent' \| 'system'` | Who produced it. |
| `k` | see below | What happened. |

Fields by `k`:

| `k` | Extra fields |
|---|---|
| `prompt` | `origin: 'typed' \| 'queued'` |
| `shell`, `interrupt`, `reply`, `think`, `compact` | — |
| `ask` | `call`: the question's call id |
| `answer` | `call`; `declined?: true` when you turned the question down |
| `call` | `call` (its id), `tool: Tool`, `name` (as logged), `kind: Kind`; when known: `paths`, `test`, `commit`, `push`, `within` (a Codex code-mode script's call id) |
| `result` | `call`, `status: Status`; `rework?: true` on a successful edit that mostly replaces lines the agent wrote earlier in the session |
| `usage` | `tokens: TokenCounts`; `cost?` in USD when the harness logs it |
| `system` | `what` (the line's own type, e.g. `event_msg:task_started`); `tag?: 'context' \| 'log'` |

Events never hold text, tool arguments or tool output. How a call went arrives later, as its `result`.

### Labels

```ts
type Harness = 'claude' | 'codex' | 'pi' | 'opencode' | 'cursor' | 'zed'
type LogHarness = 'claude' | 'codex' | 'pi'
type By = 'you' | 'agent' | 'system'
type Status = 'ok' | 'failed' | 'declined' | 'interrupted' | 'unknown'
type Tag = 'context' | 'log'          // context: injected in front of the model; log: the harness's bookkeeping
type Kind = 'read' | 'discover' | 'edit' | 'review' | 'run' | 'web' | 'delegate' | 'mcp' | 'other'
type Tool = 'Shell' | 'Process' | 'Code' | 'Read' | 'Write' | 'Edit' | 'Patch' | 'Search' | 'Glob' | 'List'
  | 'WebFetch' | 'WebSearch' | 'Todo' | 'Plan' | 'Skill' | 'Task' | 'Question' | 'Mcp' | 'Other'

interface TokenCounts { input: number; output: number; cacheRead: number; cacheWrite: number }
```

`tool` is one name for the same tool across harnesses; `kind` is what the call did. For shell calls, `kind` comes from the command.

### `SessionText`

```ts
type SessionText = Record<string, string>
```

The text behind `prompt`, `answer`, `reply` and `think` events, keyed by event id. It's a plain object, so `JSON.stringify` keeps it. You only get it when you ask with `{ text: true }`.

## Readers

### `Reader`

```ts
interface Reader<In = string> {
  read(input: In): SessionEvent[]   // the events this line or row adds
  session(): Session                // a snapshot of everything read so far
}

interface TextReader<In = string> extends Reader<In> {
  text: SessionText
}
```

Each event comes out once and never changes. A snapshot stays as it was when more input arrives. Database rows change in place, so pass a row again whenever it changes, and the reader emits only what's new.

### `PiReader`

```ts
interface PiReader extends Reader {
  readonly metadata: PiMetadata
  readonly entries: Map<string, PiEntry>
  readonly diagnostics: { malformedLines: number; ignoredLines: number; duplicateEntries: number; orphanResults: number }
  readonly leafId?: string                                       // the last entry appended
  getPath(leafId?: string): { entries: PiEntry[]; complete: boolean }
}

interface PiMetadata { id?: string; formatVersion?: number; parentSession?: string; name?: string }
interface PiEntry {
  id: string
  parentId: string | null
  type: string
  at: number
  role?: string
  fromId?: string
  firstKeptEntryId?: string
  events: string[]                 // the ids of the events this entry produced
}
```

`reader('pi')` returns a `PiReader`. Events come from every branch, in append order. `getPath()` follows one branch's ancestry, and `complete` is `false` when a parent is missing or the links form a cycle.

## Database rows

You read these fields from each tool's SQLite database yourself, and nothing else. The comments name where each field comes from. Times in opencode rows are epoch milliseconds.

```ts
// opencode: ~/.local/share/opencode/opencode.db
type OpencodeRow = { message: OpencodeMessage } | { part: OpencodePart }

interface OpencodeMessage {
  id?: string                      // message.id; without it, passing a message again emits it again
  directory?: string               // session.directory
  created?: number                 // message.time_created
  role?: string                    // $.role
  completed?: number               // $.time.completed
  tokens?: { input?: number; output?: number; reasoning?: number; cacheRead?: number; cacheWrite?: number }  // $.tokens
  model?: string                   // $.modelID
  error?: string                   // $.error.name
}

interface OpencodePart {
  type?: string                    // $.type; only 'tool' parts are read
  callId?: string                  // $.callID
  tool?: string                    // $.tool
  status?: string                  // $.state.status
  start?: number                   // $.state.time.start
  end?: number                     // $.state.time.end
}

// Cursor: …/Cursor/User/globalStorage/state.vscdb, cursorDiskKV rows keyed bubbleId:<composer>:<bubble>
interface CursorBubble {
  bubbleId?: string                // <bubble> from the key
  createdAt?: string               // $.createdAt, ISO 8601; bubbles without it are skipped
  type?: number                    // $.type: 1 is you, 2 the agent
  inputTokens?: number             // $.tokenCount.inputTokens
  outputTokens?: number            // $.tokenCount.outputTokens
  model?: string                   // $.modelInfo.modelName
}

// Zed: threads.db
interface ZedThread {
  updatedAt?: string               // updated_at, ISO 8601
  folders?: string                 // folder_paths: a JSON list or newline-separated
}
```

Read only these fields. Cursor's database also holds credentials.

## Detection

```ts
type Detection =
  | { agent: LogHarness }
  | { agent: 'unknown'; code: FormatCode; formats: DetectedFormat[]; message: string }

type FormatCode = 'unrecognised_format' | 'ambiguous_format' | 'unsupported_format'
type DetectedFormat = 'claude' | 'codex' | 'pi' | 'gemini' | 'qwen'
```

When `agent` isn't `'unknown'`, you can pass it straight to `reader(agent)`.
