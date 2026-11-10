import { describe, expect, it } from 'vitest'
import { parsePiSession, PiSessionParser } from '../src/pi.js'
import { totalTokens } from '../src/types.js'

const start = Date.parse('2026-11-02T14:00:00Z')
function session() {
  const rows: object[] = [{ type: 'session', version: 3, id: 'session-id', cwd: '/work/project', parentSession: '/parent.jsonl', timestamp: new Date(start).toISOString() }]
  let parent: string | null = null
  let clock = start
  const entry = (type: string, fields: object = {}, id = `e${rows.length}`, parentId = parent) => {
    clock += 10_000
    rows.push({ type, id, parentId, timestamp: new Date(clock).toISOString(), ...fields })
    parent = id
    return id
  }
  const message = (role: string, fields: object = {}, id?: string, parentId = parent) => entry('message', { message: { role, timestamp: clock, ...fields } }, id, parentId)
  const call = (id: string, name: string, args: object) => message('assistant', { content: [{ type: 'toolCall', id, name, arguments: args }] })
  const result = (id: string, isError = false, content = 'ok') => message('toolResult', { toolCallId: id, isError, content: [{ type: 'text', text: content }] })
  const parse = () => parsePiSession(rows.map(r => JSON.stringify(r)))
  return { rows, entry, message, call, result, parse }
}

const usage = { input: 10, output: 20, cacheRead: 30, cacheWrite: 40, reasoning: 7, cacheWrite1h: 9, totalTokens: 100, cost: { total: 0.01 } }

describe('Pi sessions', () => {
  it('reads metadata, prompts, native usage, test outcomes, commits and time', () => {
    const s = session()
    s.entry('session_info', { name: 'Implement retry' })
    s.entry('model_change', { modelId: 'first-model' })
    s.message('system', { content: 'injected instructions' })
    s.message('user', { content: [{ type: 'text', text: 'fix retry' }] })
    s.call('test1', 'bash', { command: 'pnpm test' })
    s.result('test1', true, 'Command exited with code 1')
    s.call('test2', 'bash', { cmd: 'pnpm test' })
    s.result('test2')
    s.call('commit', 'bash', { command: 'git commit -am retry' })
    s.result('commit')
    s.message('assistant', { model: 'physical-model', content: [], usage })
    s.message('user', { content: 'perfect, thanks' })
    const p = s.parse()
    const a = p.accumulator
    expect(p.metadata).toMatchObject({ id: 'session-id', formatVersion: 3, parentSession: '/parent.jsonl', name: 'Implement retry' })
    expect(a.projectPath).toBe('/work/project')
    expect(a.model).toBe('physical-model')
    expect(a.version).toBeUndefined()
    expect(a.asksApproval).toBe(false)
    expect(a.signals).toMatchObject({ prompts: 2, toolCalls: 3, failedCalls: 1, rejections: 0 })
    expect(a.timeline.filter(s => s.k === 'call')).toMatchObject([
      { test: true, ok: false }, { test: true, ok: true }, { commit: true, ok: true },
    ])
    expect(a.timeline.at(-1)).toMatchObject({ k: 'prompt', tone: 'positive' })
    const day = [...a.days.values()][0]!
    expect(day.tokens).toEqual({ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 })
    expect(day.humanMs).toBe(10_000)
    expect(day.agentMs).toBe(70_000)
    expect(p.costUsd).toBeCloseTo(0.01)
  })

  it('accounts for every branch but selects ancestry without copying abandoned tests', () => {
    const s = session()
    const fork = s.message('user', { content: 'research an approach' })
    s.call('failed-test', 'bash', { command: 'pnpm test' })
    s.result('failed-test', true)
    const abandoned = s.message('assistant', { content: [{ type: 'text', text: 'try something else' }] })
    const summary = s.entry('branch_summary', { fromId: abandoned, summary: 'research informed the solution', usage }, 'summary', fork)
    s.message('user', { content: 'use the other approach' })
    const kept = s.message('assistant', { content: [], usage })
    s.entry('compaction', { firstKeptEntryId: kept, tokensBefore: 50000, summary: 'not a new prompt', usage })
    s.entry('context_edit', { targetId: fork, replacement: null })
    const p = s.parse()
    expect(p.accumulator.signals).toMatchObject({ prompts: 2, toolCalls: 1, failedCalls: 1, compactions: 1 })
    expect(p.getPath().entries.map(e => e.id)).toContain(summary)
    expect(p.getPath().entries.map(e => e.id)).not.toContain(abandoned)
    expect(p.entries.get(summary)?.fromId).toBe(abandoned)
    expect(p.getTimeline().some(s => s.k === 'call')).toBe(false)
    expect(p.getTimeline(abandoned).some(s => s.k === 'call')).toBe(true)
    expect(p.getTimeline().filter(s => s.k === 'prompt')).toHaveLength(2)
    expect([...p.accumulator.days.values()].reduce((n, d) => n + totalTokens(d.tokens), 0)).toBe(300)
    expect(p.costUsd).toBeCloseTo(0.03)
    expect(p.getPath().complete).toBe(true)
  })

  it('supports all observed edit shapes and only remembers successful writes', () => {
    const s = session()
    s.call('bad-write', 'write', { path: 'a.ts', content: 'never actually written' })
    s.result('bad-write', true)
    s.call('edit0', 'edit', { path: 'a.ts', oldText: 'never actually written', newText: 'first successful line' })
    s.result('edit0')
    s.call('edit1', 'edit', { path: 'a.ts', old_string: 'first successful line', new_string: 'second successful line' })
    s.result('edit1')
    s.call('edit2', 'edit', { path: 'a.ts', edits: [{ oldText: 'second successful line', newText: 'third successful line' }] })
    s.result('edit2')
    s.call('bad-edit', 'edit', { path: 'a.ts', oldText: 'third successful line', newText: 'not applied' })
    s.result('bad-edit', true)
    expect(s.parse().accumulator.signals).toMatchObject({ rework: 2, failedCalls: 2, toolCalls: 5 })
  })

  it('records the file each read, edit and write touched, not folders', () => {
    const s = session()
    s.call('r', 'read', { path: 'a.ts' })
    s.call('w', 'write', { path: 'b.ts', content: 'x' })
    s.call('g', 'grep', { pattern: 'x', path: 'src' })
    const calls = s.parse().accumulator.timeline.flatMap(t => (t.k === 'call' ? [t.paths] : []))
    expect(calls).toEqual([['a.ts'], ['b.ts'], undefined])
  })

  it('separates aborts, failures, unknown results, human shell and injected messages', () => {
    const s = session()
    s.message('custom', { content: 'not a user prompt' })
    s.entry('custom_message', { content: 'not a user prompt either' })
    s.message('bashExecution', { command: 'pnpm test', output: 'ok', exitCode: 0 })
    s.message('user', { content: [{ type: 'image', data: 'not retained' }] })
    s.call('cancel', 'bash', { command: 'pnpm test' })
    s.result('cancel', true, 'Command aborted')
    s.message('assistant', { stopReason: 'aborted', content: [], usage })
    s.call('missing', 'read', { path: 'a.ts' })
    s.result('orphan', true)
    s.message('assistant', { stopReason: 'error', errorMessage: 'provider unavailable', content: [] })
    s.entry('usage', { kind: 'unknown-future-kind', usage })
    s.message('toolResult', { toolCallId: 'missing', isError: false, usage })
    const p = s.parse()
    expect(p.accumulator.signals).toMatchObject({ prompts: 1, interrupts: 1, rejections: 0, failedCalls: 0, toolCalls: 2 })
    const calls = p.accumulator.timeline.filter(s => s.k === 'call')
    expect(calls).toMatchObject([{ tool: 'bash' }, { tool: 'read', ok: true }])
    expect(calls[0]).not.toHaveProperty('ok')
    expect(p.diagnostics.orphanResults).toBe(1)
    expect(p.costUsd).toBeCloseTo(0.03)
    expect(JSON.stringify(p)).not.toContain('provider unavailable')
    expect(JSON.stringify(p)).not.toContain('not retained')
  })

  it('deduplicates entries, tolerates damaged lines and keeps unmatched calls unknown', () => {
    const s = session()
    s.message('user', { content: 'hello' })
    s.call('unmatched', 'bash', { command: 'pnpm test' })
    const p = s.parse()
    p.ingestLine(JSON.stringify(s.rows.at(-1)))
    p.ingestLine('{truncated')
    for (const v of [null, [], 1, { type: 'message' }, { type: 'message', id: 'broken', timestamp: 'invalid' }]) p.ingestLine(JSON.stringify(v))
    expect(p.accumulator.signals.toolCalls).toBe(1)
    expect(p.accumulator.pendingCalls.size).toBe(1)
    expect(p.accumulator.timeline.at(-1)).not.toHaveProperty('ok')
    expect(p.diagnostics).toMatchObject({ duplicateEntries: 1, malformedLines: 1, ignoredLines: 5 })
  })

  it('supports legacy linear sessions and explicitly reports missing parents/cycles', () => {
    const p = parsePiSession([
      JSON.stringify({ type: 'session', timestamp: new Date(start).toISOString() }),
      JSON.stringify({ type: 'message', timestamp: new Date(start + 1000).toISOString(), message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'message', timestamp: new Date(start + 2000).toISOString(), message: { role: 'assistant', content: [] } }),
    ])
    expect(p.getPath().complete).toBe(true)
    expect(p.getPath().entries).toHaveLength(2)
    const broken = new PiSessionParser()
    broken.ingestLine(JSON.stringify({ type: 'custom', id: 'a', parentId: 'missing', timestamp: new Date(start).toISOString() }))
    expect(broken.getPath().complete).toBe(false)
    expect(() => broken.getTimeline()).toThrow('Incomplete')
    broken.ingestLine(JSON.stringify({ type: 'custom', id: 'missing', parentId: 'a', timestamp: new Date(start).toISOString() }))
    expect(broken.getPath().complete).toBe(false)
  })

  it('does not let metadata turn idle time into active time, or use message start times', () => {
    const p = parsePiSession([
      JSON.stringify({ type: 'message', id: 'a', parentId: null, timestamp: new Date(start).toISOString(), message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'label', id: 'b', parentId: 'a', timestamp: new Date(start + 240_000).toISOString() }),
      JSON.stringify({ type: 'message', id: 'c', parentId: 'b', timestamp: new Date(start + 480_000).toISOString(), message: { role: 'assistant', timestamp: start, content: [], usage } }),
    ])
    expect([...p.accumulator.days.values()][0]?.agentMs).toBe(0)
    expect(p.accumulator.lastEvent).toBe(start + 480_000)
  })
})
