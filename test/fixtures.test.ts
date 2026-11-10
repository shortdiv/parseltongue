import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeSession, type Step } from '../src/index.js'

// Synthetic fixtures only. Private/sanitized real-session corpora stay in the consumer.
const cases = [
  ['claude', 'shell-and-tools'],
  ['codex', 'shell-and-patches'],
  ['pi', 'tools-and-bash'],
] as const

function line(s: Step, t0: number): string {
  const head = `+${(s.at - t0) / 1000}s`.padEnd(6)
  if (s.k !== 'call') return `${head} ${s.k}${s.k === 'prompt' && s.tone ? ` ${s.tone}` : ''}`
  const ok = s.ok === undefined ? '?' : s.ok ? 'ok' : 'failed'
  const flags = (['test', 'commit', 'push', 'rework'] as const).filter(f => s[f])
  return [head, 'call', s.tool, s.kind, ok, ...flags, ...(s.paths ?? [])].join(' ')
}

describe('standalone synthetic fixtures', () => {
  for (const [harness, name] of cases) {
    it(`${harness}/${name}`, async () => {
      const url = new URL(`./fixtures/${harness}/${name}.jsonl`, import.meta.url)
      const session = normalizeSession(readFileSync(url, 'utf8'), url.pathname)
      expect(session.agent).toBe(harness)
      expect(session.steps.length).toBeGreaterThan(0)
      expect(session.turns.length).toBeGreaterThan(0)
      const t0 = session.steps[0]!.at
      const output = [`cwd ${session.cwd}`, ...session.steps.map(s => line(s, t0))].join('\n') + '\n'
      await expect(output).toMatchFileSnapshot(url.pathname.replace(/\.jsonl$/, '.steps'))
    })
  }
})
