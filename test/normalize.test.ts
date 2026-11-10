import { describe, expect, it } from 'vitest'
import { normalizeSession } from '../src/normalize.js'

const at = (n: number) => new Date(Date.UTC(2026, 10, 2, 14, 0, n)).toISOString()
const jsonl = (rows: object[]) => rows.map(r => JSON.stringify(r)).join('\n')
const header = { type: 'session', version: 3, id: 'pi-id', cwd: '/work/client', parentSession: '/parent.jsonl', timestamp: at(0) }
const pi = (id: string, parentId: string | null, n: number, message: object) => ({ type: 'message', id, parentId, timestamp: at(n), message })

export const fixtures = [
  jsonl([
    header,
    pi('p1', null, 1, { role: 'user', content: 'fix it' }),
    pi('a1', 'p1', 2, { role: 'assistant', content: [{ type: 'toolCall', id: 'c', name: 'bash', arguments: { command: 'git commit -am fix' } }] }),
    pi('r1', 'a1', 3, { role: 'toolResult', toolCallId: 'c', isError: false }),
    pi('a2', 'r1', 4, { role: 'assistant', content: [{ type: 'text', text: 'done' }] }),
    pi('p2', 'a2', 5, { role: 'user', content: 'now document it' }),
  ]),
  jsonl([
    { type: 'user', timestamp: at(1), cwd: '/work/client', message: { content: 'fix it' } },
    { type: 'assistant', timestamp: at(2), message: { content: [{ type: 'tool_use', id: 'c', name: 'Bash', input: { command: 'git commit -am fix' } }] } },
    { type: 'user', timestamp: at(3), message: { content: [{ type: 'tool_result', tool_use_id: 'c' }] } },
    { type: 'assistant', timestamp: at(4), message: { content: [{ type: 'text', text: 'done' }] } },
    { type: 'user', timestamp: at(5), message: { content: 'now document it' } },
  ]),
  jsonl([
    { type: 'session_meta', timestamp: at(0), payload: { cwd: '/work/client' } },
    { type: 'response_item', timestamp: at(1), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix it' }] } },
    { type: 'response_item', timestamp: at(2), payload: { type: 'function_call', call_id: 'c', name: 'exec_command', arguments: JSON.stringify({ cmd: 'git commit -am fix' }) } },
    { type: 'response_item', timestamp: at(3), payload: { type: 'function_call_output', call_id: 'c', output: 'Exit code: 0' } },
    { type: 'response_item', timestamp: at(4), payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] } },
    { type: 'response_item', timestamp: at(5), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'now document it' }] } },
  ]),
]

describe('normalization', () => {
  it('normalizes copied Pi, Claude and Codex into a common conversation', () => {
    const all = fixtures.map(raw => normalizeSession(raw, '/copied/session.jsonl'))
    const conversation = all[0]!.turns.map(({ at, who, text }) => ({ at, who, text }))
    expect(all.map(s => s.agent)).toEqual(['pi', 'claude', 'codex'])
    expect(all.map(s => s.id)).toEqual(['pi:pi-id', 'claude:session', 'codex:session'])
    for (const s of all) {
      expect(s.project).toBe('client')
      expect(s.turns.map(({ at, who, text }) => ({ at, who, text }))).toEqual(conversation)
      expect(s.steps.filter(s => s.k === 'prompt')).toHaveLength(2)
      expect(s.steps.find(s => s.k === 'call')).toMatchObject({ commit: true, ok: true })
    }
  })

  it('retains useful abandoned work and branch provenance, not injected prompts or reasoning', () => {
    const s = normalizeSession(jsonl([
      header,
      pi('p', null, 1, { role: 'user', content: 'research' }),
      pi('abandoned', 'p', 2, { role: 'assistant', content: [{ type: 'text', text: 'useful dead end' }] }),
      { type: 'branch_summary', id: 'summary', parentId: 'p', fromId: 'abandoned', timestamp: at(3), summary: 'not a user prompt' },
      pi('p2', 'summary', 4, { role: 'user', content: 'use that learning' }),
      pi('a2', 'p2', 5, { role: 'assistant', content: [{ type: 'thinking', thinking: 'private reasoning' }, { type: 'text', text: 'solution' }] }),
      pi('injected', 'a2', 6, { role: 'custom', content: 'not typed by you' }),
    ]))
    expect(s.turns.map(t => t.text)).toEqual(['research', 'useful dead end', 'use that learning', 'solution'])
    expect(s.parentSession).toBe('/parent.jsonl')
    expect(s.entryTree?.find(e => e.id === 'summary')).toMatchObject({ parentId: 'p', fromId: 'abandoned' })
    expect(s.turns[1]).toMatchObject({ entryId: 'abandoned', parentId: 'p' })
    expect(JSON.stringify(s)).not.toContain('private reasoning')
  })

  it('deduplicates Pi entries, preserves image-only prompts and reports damaged input', () => {
    const prompt = pi('p', null, 1, { role: 'user', content: [{ type: 'image', data: 'not exported' }] })
    const s = normalizeSession(jsonl([header, prompt, prompt]) + '\n{truncated')
    expect(s.turns).toHaveLength(1)
    expect(s.turns[0]!.text).toBe('[non-text prompt]')
    expect(s.warnings).toContain('1 malformed JSONL lines skipped')
    const broken = normalizeSession(jsonl([header, pi('a', 'missing', 2, { role: 'user', content: 'hello' })]))
    expect(broken.warnings?.[0]).toContain('Incomplete')
  })

  it('tolerates malformed/non-object lines in Claude logs', () => {
    const s = normalizeSession('null\n[]\n{broken\n' + fixtures[1])
    expect(s.turns).toHaveLength(3)
  })
})
