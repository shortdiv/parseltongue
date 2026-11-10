import { describe, expect, it } from 'vitest'
import { kindOf, shellKind } from '../src/index.js'

describe('shellKind', () => {
  const cases: [string, string, string[]][] = [
    // reads
    ["sed -n '1,80p' src/fetch.ts", 'read', ['src/fetch.ts']],
    ['cat src/http.ts', 'read', ['src/http.ts']],
    ['nl -ba src/fetch.ts | head -40', 'read', ['src/fetch.ts']],
    ["cd /work/app && sed -n '10,30p' src/a.ts && sed -n '1,5p' src/b.ts", 'read', ['src/a.ts', 'src/b.ts']],
    ['wc -l docs/plan.md', 'read', ['docs/plan.md']],
    ["awk '{print $1}' data.csv", 'read', ['data.csv']],
    ['head -n 40 README.md', 'read', ['README.md']],
    // searches
    ['rg -n "retry" src', 'search', []],
    ['ls src && find src -name "*.test.ts"', 'search', []],
    ['git grep -n fetch', 'search', []],
    // a search then a read is a read
    ['rg -n "retry" src/a.ts || true\nsed -n \'80,180p\' src/a.ts', 'read', ['src/a.ts']],
    // edits
    ["cat > notes/plan.md <<'EOF'\nthe plan\nEOF", 'edit', ['notes/plan.md']],
    ["sed -i '' 's/a\\/b/c/' src/fetch.ts", 'edit', ['src/fetch.ts']],
    ['echo done >> log.txt', 'edit', ['log.txt']],
    ['mkdir -p src/lib && touch src/lib/index.ts', 'edit', ['src/lib', 'src/lib/index.ts']],
    ["apply_patch <<'EOF'\n*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** End Patch\nEOF", 'edit', ['src/a.ts']],
    ['pnpm build > build.log 2>&1', 'edit', ['build.log']],
    // review
    ['git status --short && git diff --stat', 'review', []],
    ['git -C repo log --oneline -5', 'review', []],
    // runs
    ['pnpm test 2>&1 | grep FAIL', 'run', []],
    ['git commit -am "fix" && git push', 'run', []],
    ["python3 - <<'EOF'\nprint(open('a.txt').read())\nEOF", 'run', []],
    ['pnpm test 2>/dev/null', 'run', []],
    ['echo hi', 'run', []],
    // web
    ['curl -s https://example.com/api', 'web', []],
    // Codex wraps commands in a login shell
    ["/bin/zsh -lc \"sed -n '1,80p' src/fetch.ts\"", 'read', ['src/fetch.ts']],
    ["bash -lc 'rg -n x src'", 'search', []],
  ]
  for (const [cmd, kind, paths] of cases)
    it(JSON.stringify(cmd), () => expect(shellKind(cmd)).toEqual({ kind, paths }))
})

describe('kindOf', () => {
  it('names tools across harnesses', () => {
    expect(['Read', 'read', 'Grep', 'apply_patch', 'FileChange', 'CommandExecution', 'js', 'spawn_agent', 'mcp__x__y', 'plugin.search', 'Mystery'].map(kindOf))
      .toEqual(['read', 'read', 'search', 'edit', 'edit', 'run', 'run', 'delegate', 'mcp', 'mcp', 'other'])
  })
})
