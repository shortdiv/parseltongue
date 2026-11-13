# Parseltongue

`@shortdiv/parseltongue` — speak session transcripts.

Zero-runtime-dependency, browser-safe TypeScript parsers for coding-agent sessions. It **reads Claude Code, Codex and pi logs, and opencode, Cursor and Zed database rows** into one text-free list of events. Viewers and analytics tools can share its format knowledge instead of each writing their own.

**Status:** unreleased. It is tested on synthetic records and on privacy-reviewed excerpts of real Claude Code, Codex, pi, opencode and Cursor sessions; Zed is tested on synthetic rows only. Upstream formats change between versions.

## Scope

- Accept transcript strings, individual JSONL lines, or database rows you read yourself; no filesystem or database access.
- Turn each session into a text-free list of events in log order, with the text available on request.
- Read a log a line at a time, pairing each tool call with its result.
- Preserve pi entry topology, fork metadata, and incomplete-ancestry diagnostics.
- No Node APIs, network, storage, UI, billing, scoring models, or classifier dependencies at runtime.

**It's analytics-oriented:** its events never hold tool arguments, results or unknown payloads, and text (prompts, answers, replies, reasoning) is returned only when asked for. It does not promise agent-context replay.

## Parse a session

```ts
import { parseSession } from '@shortdiv/parseltongue'

const session = parseSession(rawJsonl)   // Claude Code, Codex or pi, detected from its content
session.agent                            // 'claude', 'codex' or 'pi'; a log it can't read throws a FormatError
session.events                           // SessionEvent[]: text-free, in the order the log has them
session.calls                            // each call's final status, by call id

const { text } = parseSession(rawJsonl, { text: true })
text[session.events[0].id]               // the text behind an event, by event id; a plain object, so JSON keeps it
```

Events come in the order the log has them, not sorted by time: `at` can step backwards (opencode stamps a reply when it finished, pi appends branches one after another), so sort by `at` yourself if you need time order.

Every event has an `id`, a timestamp `at`, who produced it (`by`: `you`, `agent` or `system`) and a label `k`:

| `k` | by | notes |
|---|---|---|
| `prompt` | you | `origin`: `typed` or `queued` |
| `shell`, `interrupt`, `answer` | you | `answer` refers to the agent's `ask`, and is `declined` when you turned the question down |
| `reply`, `think`, `ask` | agent | |
| `call` | agent | `tool`, raw `name`, `kind`, and `paths`, `test`, `commit`, `push` when known |
| `result` | agent | the call's `status`: `ok`, `failed`, `declined`, `interrupted`, or `unknown` when the result doesn't say; `rework` on a successful edit that mostly replaces lines the agent wrote earlier |
| `usage` | agent | token counts, and `cost` when the harness logs it |
| `compact`, `system` | system | `system` lines tagged `context` (injected) or `log` (bookkeeping) can be dropped |

A call's `tool` is one name across harnesses (`Shell`, `Read`, `Patch`, `Todo`, `Mcp`…); its `kind` is what it did (`read`, `discover`, `edit`, `review`, `run`, `web`, `delegate`, `mcp`, `other`), taken from the command for shell calls. Events never change once read: how a call went arrives later, as its `result`, and `session.calls` gives each call's final status, `unknown` for a call with no result. The parser only labels: what counts as your time or the agent's is up to the consumer.

## Follow a live session

```ts
import { reader } from '@shortdiv/parseltongue'

const r = reader('claude')   // or 'codex', 'pi'; with { text: true }, r.text keeps the text
for await (const line of lines) render(r.read(line))   // the events each line adds
r.session()                  // snapshot: events read so far, call statuses, warnings, and the
                             // id, cwd, model, version and parent as the log reveals them
```

Each event comes out once and stays as it was, so a live view never has to revise what it showed.

### pi branches and diagnostics

```ts
const r = reader('pi')
for (const line of lines) r.read(line)
console.log(r.metadata, r.diagnostics)
const path = r.getPath()     // { entries, complete }: each entry lists the ids of its events
```

Versions 1 (linear), 2 and 3 (tree) are handled. Events come from every branch in append order; `getPath(leafId)` selects one ancestry. The last persisted entry approximates the leaf: navigation without an append is not recorded. Compactions and context edits don't erase work already done. This is not model-context replay or cross-file fork deduplication.

### Databases: opencode, Cursor and Zed

Use the same `reader(agent)` API for rows you read from each tool's SQLite database:

```ts
const opencode = reader('opencode', { id: 'session-id' })
opencode.read({ message: { id: 'm1', role: 'user', created: 1_000 } })
opencode.read({ part: { type: 'tool', callId: 't1', tool: 'bash', start: 2_000 } })
const session = opencode.session() // events, call statuses, info and warnings

const cursor = reader('cursor', { id: 'composer-id' })
cursor.read({ bubbleId: 'b1', createdAt: '2026-01-01T00:00:00Z', type: 1 })

const zed = reader('zed', { id: 'thread-id' })
zed.read({ updatedAt: '2026-01-01T00:00:00Z', folders: '["/work/app"]' })
```

The optional `id` supplies the session id; without it, `session()` has no `id`. Inputs are `OpencodeRow` (`{ message } | { part }`), `CursorBubble` and `ZedThread`; their types document the fields to read. Read only those fields, especially in Cursor's database, which also holds credentials. These readers do not open databases or retain text.

Rows change in place, so pass a row again whenever it changes: with its id (`callId`, `id`, `bubbleId`), each reader emits only what's new, like a tool part's result once it ends. Zed emits an event when the thread's update timestamp changes. Older Cursor versions didn't store a time per bubble (`createdAt`); those bubbles produce no events, because there's no honest time to give them.

## Public API

Functions: `parseSession`, `reader`, `detect` and `isInjectedCodexText`, plus the `FormatError` class. Every public type is exported from [`src/types.ts`](src/types.ts); everything else is internal.

## Compatibility and limitations

- `detect(raw)` says which harness wrote a log, from content signatures in the first 250 records, never the filename: `{ agent }` with `claude`, `codex` or `pi`, which `reader(agent)` takes, or `{ agent: 'unknown', code, formats, message }`. The code is `unrecognised_format` (no signature), `ambiguous_format` (several) or `unsupported_format` (Gemini CLI and Qwen Code, recognised but not read yet), and `formats` lists what was seen; a log is never Claude by default. `parseSession` throws a `FormatError` with the same `code`, `formats` and `message`, so call `detect` first if you'd rather not catch; `reader` itself doesn't detect, it reads the harness you name.
- Claude prompts exclude meta prompts, injected text and subagent lines from a parent's file. Codex excludes user text that opens with its own injected tags. pi excludes custom/system messages from prompts and keeps every branch's events.
- Invalid JSON lines are skipped. pi reports counts and ancestry warnings; Claude/Codex do not provide per-line diagnostics. This is **not a JSONL validator**.
- `reader(agent)` trusts the agent you name: syntactically valid JSON is not automatically a valid session record.
- No compressed `.jsonl.zst` decoding. Decode outside the library.
- No accounts, telemetry, uploads, agent launching, or session modification.

## Develop independently

It has no runtime dependencies. Requires Node 22+ and pnpm for development; runtime output is ES2022 ESM with declarations.

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm check:package
```

`check:package` builds and packs the library, installs that tarball into an isolated temporary consumer, checks its public ESM API and TypeScript declarations without Node types, and checks the publication allowlist. Runtime compilation also excludes all Node types.

Fixtures are tiny, privacy-reviewed excerpts of real Claude Code, Codex, pi, opencode and Cursor sessions, with every prompt, path, id and output replaced. Original sessions and private corpora remain outside the repository. Tests and fixtures are not shipped in the npm tarball. Compiled source maps contain parser source, not transcripts.

## Release

1. Confirm the package name/scope, MIT license, and ownership of all extracted contributions before making the repository public.
2. Set the final name, repository metadata, and release version.
3. Run `pnpm typecheck`, `pnpm test`, and `pnpm check:package`.
4. Inspect `npm pack --dry-run` and the public repository for private session data.
5. Publish deliberately with `npm publish --access public` when ready.

Nothing in this extraction publishes a package or creates a public repository.

## Contribute

See [CONTRIBUTING.md](CONTRIBUTING.md) for adapter and fixture guidance.

## License

[MIT](LICENSE).
