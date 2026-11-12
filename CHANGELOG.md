# Changelog

## 0.1.0 — Unreleased

- Parse Claude Code, Codex and pi sessions. No runtime dependencies; browser-safe ESM with TypeScript declarations.
- `parseSession(raw)`: one time-ordered list of text-free events, each with a timestamp and who produced it. Text is opt-in with `{ text: true }`.
- Calls carry a normalized `tool`, the raw `name`, a `kind` (read, discover, edit, review, run, web, delegate, mcp, other) and a `status`. A shell call's kind and files come from its command.
- System events are tagged `context` or `log` so consumers can drop them.
- Only labels, no accounting: time, tone and day buckets are left to the consumer.
- Row parsers for opencode, Cursor and Zed.
