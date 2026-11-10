# Changelog

## 0.1.0 — Unreleased

- Claude Code, Codex, and pi parsing and chronological normalization.
- Preserve the existing incremental ingestion APIs, session IDs, timing/token accounting, and pi ancestry diagnostics.
- Isolate the runtime from filesystem, UI, billing, classifier, and model dependencies.
- Give every tool call a `kind` (read, search, edit, review, run, web, delegate, plan, mcp, other). Shell calls get theirs from the command (`shellKind`: `sed -n`, `cat`, `rg`, `cat >`, `sed -i`, `git diff`…) along with the files they read or wrote; other calls from the tool's name (`kindOf`).
- Provide ESM JavaScript and TypeScript declarations, standalone tests, synthetic fixtures, and MIT licensing.

This first extraction is analytics-oriented, not a full-fidelity transcript/event model. Gemini CLI and Qwen Code are planned, not supported yet.
