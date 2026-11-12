# Parseltongue

`@shortdiv/parseltongue` — speak session transcripts.

Zero-runtime-dependency, browser-safe TypeScript parsers for **Claude Code, Codex, and pi** session transcripts. Viewers, analytics tools, and other applications can share one implementation.

**Status:** initial extraction, unreleased. Gemini CLI and Qwen Code are planned; they are not supported yet. The unscoped npm name `parseltongue` is already taken by an unrelated S-expression parser.

## Scope

- Accept transcript strings or individual JSONL lines; no filesystem discovery.
- Normalize chronological user/assistant text and a text-free activity timeline.
- Incrementally correlate tool calls/results for outcomes and usage/activity accounting.
- Preserve pi entry topology, fork metadata, and incomplete-ancestry diagnostics.
- No Node APIs, network, storage, UI, billing, scoring models, or classifier dependencies at runtime.

**This version is not yet a full-fidelity viewer parser.** The activity timeline omits full tool arguments/results, thinking, and unknown-event payloads. Keep the original file if you need them. Rich content blocks, source-line references, explicit format detection, and consistent validation diagnostics are follow-up work, not promises of this release.

## Parse a session

```ts
import { parseSession, type SessionEvent } from '@shortdiv/parseltongue'

const session = parseSession(rawJsonl)   // Claude Code, Codex or pi, detected from its content
session.events                           // SessionEvent[]: time-ordered and text-free

const { text } = parseSession(rawJsonl, { text: true })
text.get(session.events[0].id)           // SessionText: the text behind an event, by event id
```

Every event has an `id`, a timestamp `at`, who produced it (`by`: `you`, `agent` or `system`) and a label `k`:

| `k` | by | notes |
|---|---|---|
| `prompt` | you | `origin`: `typed` or `queued` |
| `shell`, `interrupt`, `answer` | you | `answer` refers to the agent's `ask` |
| `reply`, `think`, `ask`, `result`, `usage` | agent | `usage` carries token counts |
| `call` | agent | `tool`, raw `name`, `kind`, `status`, and `paths`, `test`, `commit`, `push` when known |
| `compact`, `system` | system | `system` lines tagged `context` (injected) or `log` (bookkeeping) can be dropped |

A call's `tool` is one name across harnesses (`Shell`, `Read`, `Patch`, `Todo`, `Mcp`…); its `kind` is what it did (`read`, `discover`, `edit`, `review`, `run`, `web`, `delegate`, `mcp`, `other`), taken from the command for shell calls. `status` is `ok`, `failed`, `declined`, `interrupted` or `unknown`. The parser only labels: what counts as your time or the agent's is up to the consumer.

## Use

After building this package, import its ESM entry point:

```ts
import { normalizeSession } from '@shortdiv/parseltongue'

// A browser File is supplied by your own drop zone/file picker.
const session = normalizeSession(await file.text(), file.name)

console.log(session.agent)  // 'claude' | 'codex' | 'pi'
console.log(session.turns)  // { at, who, text }[]
console.log(session.steps)  // prompts, tool calls/outcomes, interrupts, compactions
console.log(session.warnings)
```

The second argument is a source label/path, not a file to open. Claude/Codex session IDs retain filename-based behavior; pi prefers the native header ID. Always provide a stable source label if IDs matter. Slash-separated path handling is retained from the original parsers.

### Incremental Claude/Codex ingestion

```ts
import {
  SessionAccumulator,
  ingestClaudeLine,
  ingestCodexLine,
} from '@shortdiv/parseltongue'

const acc = new SessionAccumulator()
for (const line of jsonlLines) ingestClaudeLine(acc, line)
// Use ingestCodexLine(acc, line) for Codex rollouts instead.

console.log(acc.timeline, acc.signals, acc.activity, acc.usage)
```

These APIs intentionally emit text-free analytics. The accumulator must be per session. Call outcomes are absent/unknown until the log supplies sufficient evidence. The parser doesn't turn events into time: `activity` lists each event with its timestamp and whether you or the agent produced it, and `usage` lists each token report, for the consumer to total however it bills. Test/commit detection and rework are heuristics, not assessments of quality.

### pi branches and diagnostics

```ts
import { parsePiSession } from '@shortdiv/parseltongue'

const parser = parsePiSession(rawJsonl) // also accepts Iterable<string>
console.log(parser.metadata, parser.diagnostics)
const path = parser.getPath() // { entries, complete }
if (path.complete) console.log(parser.getTimeline())
```

`PiSessionParser.ingestLine(line)` supports incremental use. Versions 1 (linear), 2, and 3 (tree) are handled. Accounting includes all append-ordered branches; `getPath(leafId)` and `getTimeline(leafId)` select an ancestry. The last persisted entry approximates the leaf: navigation without an append is not recorded. Compactions/context edits do not erase historical work. This is not model-context replay or cross-file fork deduplication.

## Compatibility and limitations

- Every API detects the format the same way (`detect`): content signatures in the first 250 records, never the filename. A log that matches no format, or more than one, is `unknown` with a warning, never Claude by default; so are Gemini CLI and Qwen Code logs, which only the viewer reads.
- Claude normalization omits sidechains, meta prompts, and tool-result-only turns. Codex omits user text considered injected context by the existing tag-prefix heuristic. pi normalization omits custom/system messages and thinking, but preserves chronological branch turns and text-free entry links.
- Invalid JSON lines are skipped by the existing ingestion/normalization APIs. pi reports counts and ancestry warnings; Claude/Codex do not provide per-line diagnostics. This is **not a JSONL validator**.
- Direct low-level ingestion expects agent-shaped JSON objects; syntactically valid JSON is not automatically a valid session record.
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
