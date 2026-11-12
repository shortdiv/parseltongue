# Parseltongue

`@shortdiv/parseltongue` — speak session transcripts.

Zero-runtime-dependency, browser-safe TypeScript parsers for **Claude Code, Codex, and pi** session transcripts. Viewers, analytics tools, and other applications can share one implementation.

**Status:** initial extraction, unreleased. Gemini CLI and Qwen Code are planned; they are not supported yet. The unscoped npm name `parseltongue` is already taken by an unrelated S-expression parser.

## Scope

- Accept transcript strings or individual JSONL lines; no filesystem discovery.
- Turn each session into a time-ordered, text-free list of events, with the text available on request.
- Read a log a line at a time, pairing each tool call with its result.
- Preserve pi entry topology, fork metadata, and incomplete-ancestry diagnostics.
- No Node APIs, network, storage, UI, billing, scoring models, or classifier dependencies at runtime.

**This version is not yet a full-fidelity viewer parser.** The activity timeline omits full tool arguments/results, thinking, and unknown-event payloads. Keep the original file if you need them. Rich content blocks, source-line references, explicit format detection, and consistent validation diagnostics are follow-up work, not promises of this release.

## Parse a session

```ts
import { parseSession } from '@shortdiv/parseltongue'

const session = parseSession(rawJsonl)   // Claude Code, Codex or pi, detected from its content
session.events                           // SessionEvent[]: time-ordered and text-free
session.calls                            // each call's final status, by call id

const { text } = parseSession(rawJsonl, { text: true })
text.get(session.events[0].id)           // the text behind an event, by event id
```

Every event has an `id`, a timestamp `at`, who produced it (`by`: `you`, `agent` or `system`) and a label `k`:

| `k` | by | notes |
|---|---|---|
| `prompt` | you | `origin`: `typed` or `queued` |
| `shell`, `interrupt`, `answer` | you | `answer` refers to the agent's `ask` |
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
r.info                       // id, cwd, model, version, parent, as the log reveals them
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

`opencodeReader()`, `cursorReader()` and `zedReader()` turn rows you read from each tool's SQLite database into events. Each documents the fields it needs; read only those.

### Whole-session shape

```ts
import { normalizeSession } from '@shortdiv/parseltongue'

const session = normalizeSession(await file.text(), file.name)
session.events  // as parseSession
session.turns   // { at, who, text }[]: your prompts and the agent's replies
```

The second argument is a source label, not a file to open. Claude and Codex session ids keep a filename-based form; pi uses the header id.

## Compatibility and limitations

- Every API detects the format the same way (`detect`): content signatures in the first 250 records, never the filename. A log that matches no format, or more than one, is `unknown` with a warning, never Claude by default; so are Gemini CLI and Qwen Code logs, which only the viewer reads.
- Claude normalization omits sidechains, meta prompts, and tool-result-only turns. Codex omits user text considered injected context by the existing tag-prefix heuristic. pi normalization omits custom/system messages and thinking, but preserves chronological branch turns and text-free entry links.
- Invalid JSON lines are skipped. pi reports counts and ancestry warnings; Claude/Codex do not provide per-line diagnostics. This is **not a JSONL validator**.
- `reader(agent)` trusts the agent you name: syntactically valid JSON is not automatically a valid session record.
- No compressed `.jsonl.zst` decoding. Decode outside the library.
- No accounts, telemetry, uploads, agent launching, or session modification.

## Develop independently

This directory is self-contained and can be copied to its own repository. It has no workspace runtime dependencies. Requires Node 22+ and pnpm for development; runtime output is ES2022 ESM with declarations.

```sh
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm check:package
```

`check:package` builds and packs the library, installs that tarball into an isolated temporary consumer, checks its public ESM API and TypeScript declarations without Node types, and checks the publication allowlist. Runtime compilation also excludes all Node types.

Only synthetic fixtures live here. Real/sanitized local-session corpora remain outside this package. Tests and fixtures are not shipped in the npm tarball. Compiled source maps contain parser source, not transcripts.

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
