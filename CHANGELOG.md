# Changelog

## 0.1.0 — Unreleased

- Parse Claude Code, Codex and pi sessions. No runtime dependencies; browser-safe ESM with TypeScript declarations.
- `parseSession(raw)`: one time-ordered list of text-free events, each with a timestamp and who produced it. Text is opt-in with `{ text: true }`.
- `reader(agent)`: the same events a line at a time, for live sessions. One adapter per agent; events never change once read.
- Calls carry a normalized `tool`, the raw `name` and a `kind` (read, discover, edit, review, run, web, delegate, mcp, other); a shell call's kind and files come from its command. How a call went arrives later as its `result`, with `status` and, for a successful edit, `rework`.
- Codex: only its own injected tags count as context, so a prompt that starts with `<` stays a prompt; `!` commands are `shell` events.
- System events are tagged `context` or `log` so consumers can drop them.
- Only labels, no accounting: time, tone and day buckets are left to the consumer.
- Readers for opencode, Cursor and Zed database rows.
- `detect(raw)` lists every log harness a log's content matches, never using its filename: `[]` for none. `parseSession` calls a log that matches none, or several, `unknown` with a warning instead of defaulting to Claude.
- A small public API: `parseSession`, `reader`, `detect` and `isInjectedCodexText`, with every public type in `types.ts`. One `reader(agent)` for all six harnesses reads log lines or database rows; `session()` returns the events, call statuses, info and warnings read so far. A reader has `text` only when made with `{ text: true }`, and an id the log doesn't give is left out, not empty.
