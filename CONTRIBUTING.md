# Contributing

## Checks

Run `pnpm install`, `pnpm typecheck`, `pnpm test`, and `pnpm check:package` from the repo root.

## Parser changes

- Keep runtime imports local and browser-safe. Filesystem access, decompression, workers, persistence, rendering, and models belong to consumers.
- Preserve native IDs, append order, and branch provenance. Do not merge unrelated branches into an invented conversation.
- Distinguish unknown outcomes from success/failure. Never invent tool results.
- Keep event shapes and labels stable. A change to them is a breaking change: note it in the changelog and update the `.events` snapshots.
- Add fixtures for the specific format version/event shape being supported.
- Do not add text or other sensitive content to the text-free events.

## Fixtures and privacy

Use small **synthetic** logs with invented prompts, paths, IDs, outputs, and credentials. Do not copy local agent history, real client work, or a "sanitized" transcript without a deliberate privacy review. Each fixture is a `.jsonl` file with an `.events` snapshot next to it; `vitest -u` writes a new fixture's snapshot, and you review it like code. The `real-sanitized` fixtures are privacy-reviewed excerpts of real sessions (Claude Code, Codex, pi, opencode, Cursor); every other fixture is synthetic. Publication uses an allowlist excluding all tests/fixtures.

Regenerate this package's `.events` snapshots with `pnpm exec vitest run -u` and review the diffs.

## Licensing

Contributions must be compatible with MIT. Retain required attribution when reusing code from other projects. Before public release, confirm the license/ownership of all extracted source and choose the final registry name.
