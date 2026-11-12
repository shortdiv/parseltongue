import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseSession, type SessionEvent } from '../src/index.js'

/**
 * The public API: one parse gives a text-free event list (always), and the text
 * behind those events only when asked for: { text: true }.
 */
// A short Claude Code session: what you typed, what Claude Code injected, and what the agent did.
const RAW = `
{"type":"user","timestamp":"2026-01-01T09:00:00Z","sessionId":"s1","cwd":"/work/app","origin":{"kind":"human"},"message":{"content":"fix the flaky billing test"}}
{"type":"assistant","timestamp":"2026-01-01T09:00:10Z","message":{"id":"m1","usage":{"input_tokens":100,"output_tokens":20},"content":[{"type":"text","text":"Looking at the test first."},{"type":"tool_use","id":"c1","name":"Bash","input":{"command":"pnpm test"}}]}}
{"type":"user","timestamp":"2026-01-01T09:00:20Z","message":{"content":[{"type":"tool_result","tool_use_id":"c1","is_error":true,"content":"FAIL billing.test.ts"}]}}
{"type":"assistant","timestamp":"2026-01-01T09:00:30Z","message":{"id":"m2","content":[{"type":"tool_use","id":"c2","name":"Edit","input":{"file_path":"/work/app/billing.ts","old_string":"a","new_string":"b"}}]}}
{"type":"user","timestamp":"2026-01-01T09:00:40Z","message":{"content":[{"type":"tool_result","tool_use_id":"c2","content":"ok"}]}}
{"type":"assistant","timestamp":"2026-01-01T09:00:50Z","message":{"id":"m3","content":[{"type":"tool_use","id":"q1","name":"AskUserQuestion","input":{"questions":[]}}]}}
{"type":"user","timestamp":"2026-01-01T09:01:00Z","message":{"content":[{"type":"tool_result","tool_use_id":"q1","content":"Keep the retry"}]}}
{"type":"attachment","timestamp":"2026-01-01T09:01:10Z","attachment":{"type":"queued_command","commandMode":"prompt","prompt":"also run lint"}}
{"type":"user","timestamp":"2026-01-01T09:01:20Z","origin":{"kind":"task-notification"},"message":{"content":"<task-notification>done</task-notification>"}}
{"type":"system","timestamp":"2026-01-01T09:01:30Z","subtype":"compact_boundary"}
{"type":"user","timestamp":"2026-01-01T09:01:40Z","origin":{"kind":"human"},"message":{"content":"thanks, ship it"}}
`.trim()

describe('parseSession', () => {
  it('gives one time-ordered list of labelled events', () => {
    const s = parseSession(RAW)
    expect(s).toMatchObject({ id: 's1', agent: 'claude', cwd: '/work/app' })
    expect(s.events.map((e) => (e.k === 'call' ? `call ${e.kind}` : e.k === 'result' ? `result ${e.status}` : e.k === 'prompt' ? `prompt ${e.origin}` : e.k)))
      .toEqual([
        'prompt typed',
        'reply', 'call run', 'usage',
        'result failed',
        'call edit',
        'result ok',
        'ask', 'answer',
        'prompt queued',
        'system',
        'compact',
        'prompt typed',
      ])
    expect(s.calls).toEqual({ c1: 'failed', c2: 'ok' })
    expect(s.events.map((e) => e.at)).toEqual([...s.events.map((e) => e.at)].sort((a, b) => a - b))
    expect(new Set(s.events.map((e) => e.id)).size).toBe(s.events.length)
  })

  it('says who did what', () => {
    const by = Object.fromEntries(parseSession(RAW).events.map((e) => [e.k, e.by]))
    expect(by).toMatchObject({ prompt: 'you', answer: 'you', reply: 'agent', call: 'agent', result: 'agent', ask: 'agent', usage: 'agent', compact: 'system', system: 'system' })
  })

  it('redacts text if text option is false or not passed in at all', () => {
    const s = parseSession(RAW)
    expect('text' in s).toBe(false)
    for (const words of ['flaky billing', 'Looking at the test', 'Keep the retry', 'also run lint', 'ship it']) {
      expect(JSON.stringify(s)).not.toContain(words)
    }
  })

  it('includes the text behind events and agent replies if text option is passed in and true', () => {
    const s = parseSession(RAW, { text: true })
    const textOf = (k: SessionEvent['k']) => s.events.filter((e) => e.k === k).map((e) => s.text.get(e.id))
    expect(textOf('prompt')).toEqual(['fix the flaky billing test', 'also run lint', 'thanks, ship it'])
    expect(textOf('answer')).toEqual(['Keep the retry'])
    expect(textOf('reply')).toEqual(['Looking at the test first.'])
  })

  it('calls a log it can\'t place unknown, never Claude', () => {
    const pi = '{"type":"session","id":"p1","version":3}'
    const gemini = '{"sessionId":"g1","projectHash":"h","messages":[]}'
    for (const [raw, warning] of [
      ['{"hello":"world"}', 'Unrecognised format'],
      [gemini, 'Gemini CLI logs aren\'t parsed into events; the viewer API reads them'],
      [`${pi}\n${RAW.split('\n')[0]}`, 'Ambiguous format: looks like pi and Claude Code'],
    ]) expect(parseSession(raw!)).toEqual({ id: '', agent: 'unknown', events: [], calls: {}, warnings: [warning] })
  })

  it('skips lines that are damaged or not JSON objects', () => {
    expect(parseSession('null\n[]\n{broken\n' + RAW).events).toEqual(parseSession(RAW).events)
  })

  // Every fixture, every harness: whatever text the parser can give, it never puts in the events.
  const DIR = join(import.meta.dirname, 'fixtures')
  for (const harness of readdirSync(DIR)) {
    for (const name of readdirSync(join(DIR, harness)).filter((f) => f.endsWith('.jsonl'))) {
      it(`keeps ${harness}/${name} text-free`, () => {
        const raw = readFileSync(join(DIR, harness, name), 'utf8')
        const events = JSON.stringify(parseSession(raw).events)
        for (const text of parseSession(raw, { text: true }).text.values()) {
          if (text.length >= 12) expect(events).not.toContain(text)
        }
      })
    }
  }
  it('reads a file that starts with a byte order mark', () => {
    const pi = parseSession('\uFEFF' + JSON.stringify({ type: 'session', version: 3, id: 'p1', timestamp: '2026-01-01T00:00:00Z', cwd: '/work' }))
    expect([pi.agent, pi.id, pi.cwd, pi.warnings]).toEqual(['pi', 'p1', '/work', []])
    const claude = parseSession('\uFEFF' + JSON.stringify({ type: 'user', sessionId: 'c1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } }))
    expect([claude.agent, claude.events.map((e) => e.k)]).toEqual(['claude', ['prompt']])
  })
})
