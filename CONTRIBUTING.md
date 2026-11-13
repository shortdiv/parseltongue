# Contributing

## Checks

Run `pnpm install`, `pnpm typecheck`, `pnpm test`, and `pnpm check:package` from the repo root.

## Parser changes

- Keep runtime imports local and browser-safe. Filesystem access, decompression, workers, persistence, rendering, and models belong to consumers.
- Preserve native IDs, append order, and branch provenance. Do not merge unrelated branches into an invented conversation.
- Distinguish unknown outcomes from success/failure. Never invent tool results.
- Keep event shapes and labels stable. A change to them is a breaking change: note it in the changelog and update the `.events` snapshots.
- Test a new format or event shape with a few inline records in `test/agents.test.ts`.
- Do not add text or other sensitive content to the text-free events.

## Fixtures and privacy

Tests use **synthetic** records with invented prompts, paths, IDs, outputs, and credentials, written inline in the tests. Do not copy local agent history, real client work, or a "sanitized" transcript without a deliberate privacy review.

The only fixture files are one `real-sanitized.jsonl` per harness: a few records of a real session, privacy-reviewed, with every prompt, path, id and output replaced. Each has an `.events` snapshot next to it; regenerate them with `pnpm exec vitest run -u` and review the diff like code. Publication uses an allowlist excluding all tests and fixtures.

## Releasing

1. Update the version in `package.json` and date its section in `CHANGELOG.md`.
2. Run `pnpm typecheck`, `pnpm test` and `pnpm check:package`, and read `npm pack --dry-run`: only `dist/`, the README, the changelog and the license should ship.
3. Commit, tag `vX.Y.Z`, push the commit and the tag.
4. `npm publish`. `prepublishOnly` reruns the checks, and `publishConfig` makes the scoped package public.

## Licensing

Contributions must be compatible with MIT. Retain required attribution when reusing code from other projects. Before public release, confirm the license/ownership of all extracted source and choose the final registry name.
