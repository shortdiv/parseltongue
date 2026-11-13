import { describe, expect, it } from 'vitest'
import { detect, FormatError, parseSession, reader, type SessionEvent } from '../src/index.js'

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
  it('rejects unsupported agents instead of parsing them as Claude', () => {
    const uncheckedReader = reader as (agent: string) => unknown
    expect(() => uncheckedReader('gemini')).toThrow(new TypeError('Unsupported agent: gemini'))
  })

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

  it('leaves text out unless asked, and keeps it through JSON when asked', () => {
    const plain = parseSession(RAW)
    expect('text' in plain).toBe(false)
    for (const words of ['flaky billing', 'Looking at the test', 'Keep the retry', 'also run lint', 'ship it']) {
      expect(JSON.stringify(plain)).not.toContain(words)
    }
    const s = parseSession(RAW, { text: true })
    const textOf = (k: SessionEvent['k']) => s.events.filter((e) => e.k === k).map((e) => s.text[e.id])
    expect(textOf('prompt')).toEqual(['fix the flaky billing test', 'also run lint', 'thanks, ship it'])
    expect(textOf('answer')).toEqual(['Keep the retry'])
    expect(textOf('reply')).toEqual(['Looking at the test first.'])
    expect(JSON.parse(JSON.stringify(s))).toEqual(s)
  })

  it('throws on a log it can\'t place, never calling it Claude', () => {
    const pi = '{"type":"session","id":"p1","version":3}'
    // Gemini CLI and Qwen Code logs look a little like Claude's: they're named, but not read yet.
    const gemini = '{"sessionId":"g1","projectHash":"h","messages":[]}'
    const qwen = '{"type":"user","uuid":"u1","sessionId":"q1","timestamp":"2026-01-01T00:00:00Z","message":{"role":"user","parts":[{"text":"hi"}]}}'
    for (const [raw, code, formats, message] of [
      ['{"hello":"world"}', 'unrecognised_format', [], 'Unrecognised format'],
      [gemini, 'unsupported_format', ['gemini'], 'Gemini CLI logs aren\'t supported yet'],
      [qwen, 'unsupported_format', ['qwen'], 'Qwen Code logs aren\'t supported yet'],
      [`${pi}\n${RAW.split('\n')[0]}`, 'ambiguous_format', ['pi', 'claude'], 'Ambiguous format: looks like pi and Claude Code'],
    ] as const) {
      expect(detect(raw)).toEqual({ agent: 'unknown', code, formats, message })
      const error = (() => { try { parseSession(raw) } catch (e) { return e } })()
      expect(error).toBeInstanceOf(FormatError)
      expect(error).toMatchObject({ name: 'FormatError', code, formats, message })
    }
  })

  it('skips lines that are damaged or not JSON objects', () => {
    expect(parseSession('null\n[]\n{broken\n' + RAW).events).toEqual(parseSession(RAW).events)
  })

  it('reads a file that starts with a byte order mark, whole or a line at a time', () => {
    const pi = JSON.stringify({ type: 'session', version: 3, id: 'p1', timestamp: '2026-01-01T00:00:00Z', cwd: '/work' })
    const claude = JSON.stringify({ type: 'user', sessionId: 'c1', timestamp: '2026-01-01T00:00:00Z', message: { role: 'user', content: 'hi' } })
    const whole = parseSession('\uFEFF' + pi)
    expect([whole.agent, whole.id, whole.cwd, whole.warnings]).toEqual(['pi', 'p1', '/work', []])
    expect(parseSession('\uFEFF' + claude).events.map((e) => e.k)).toEqual(['prompt'])
    const r = reader('claude')
    expect(r.read('\uFEFF' + claude).map((e) => e.k)).toEqual(['prompt'])
  })

  it("keeps a session snapshot as it was when more rows arrive", () => {
    const r = reader('opencode', { id: 'saved-id' })
    const part = { type: 'tool', callId: 'c', tool: 'bash', start: 2 }
    const before = [...r.read({ message: { id: 'm', role: 'user', created: 1, directory: '/work' } }), ...r.read({ part })]
    const snapshot = r.session()
    const after = r.read({ part: { ...part, status: 'completed', end: 3 } })
    expect(snapshot).toEqual({ id: 'saved-id', agent: 'opencode', cwd: '/work', events: before, calls: { c: 'unknown' }, warnings: [] })
    expect(r.session()).toMatchObject({ events: [...before, ...after], calls: { c: 'ok' } })
  })
})
