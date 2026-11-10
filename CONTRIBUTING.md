# Contributing

## Checks

Run `pnpm install`, `pnpm typecheck`, `pnpm test`, and `pnpm check:package` from the repo root.

## Parser changes

- Keep runtime imports local and browser-safe. Filesystem access, decompression, workers, persistence, rendering, and models belong to consumers.
- Preserve native IDs, append order, and branch provenance. Do not merge unrelated branches into an invented conversation.
- Distinguish unknown outcomes from success/failure. Never invent tool results.
- Keep existing normalization IDs and accounting semantics stable, or document and test an explicit migration.
- Add fixtures for the specific format version/event shape being supported. Gemini CLI and Antigravity are not interchangeable formats.
- A richer viewer event model should preserve original-record references, unknown events, arguments/results, and diagnostics. Do not silently expand the existing text-free accounting structures to contain sensitive content.

## Fixtures and privacy

Use small **synthetic** logs with invented prompts, paths, IDs, outputs, and credentials. Do not copy local agent history, real client work, or a "sanitized" transcript without a deliberate privacy review. The package currently includes only three named synthetic fixture files; publication uses an allowlist excluding all tests/fixtures.

Regenerate this package's `.steps` snapshots with `pnpm exec vitest run -u` and review the diffs.

## Licensing

Contributions must be compatible with MIT. Retain required attribution when reusing code from other projects. Before public release, confirm the license/ownership of all extracted source and choose the final registry name.
