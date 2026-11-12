import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  ingestClaudeLine,
  ingestCodexLine,
  ingestCursorBubble,
  ingestOpencodeMessage,
  ingestOpencodePart,
  ingestZedThread,
  isCommitCommand,
  isPushCommand,
  isTestCommand,
  kindOf,
  toolOf,
  normalizeSession,
  parsePiSession,
  parseSession,
  PiSessionParser,
  SessionAccumulator,
  shellKind,
  totalTokens,
  type CallStep,
  type Step,
} from '../src/index.js'

/** Every agent's parser, then what they share. Synthetic data only. */

let t = Date.parse('2026-10-26T10:00:00Z')
const at = () => new Date((t += 10_000)).toISOString()
const prompt = (text: string) => ({ type: 'user', timestamp: at(), message: { content: text } })
const call = (id: string, name: string, input: object) => ({
  type: 'assistant',
  timestamp: at(),
  message: { content: [{ type: 'tool_use', id, name, input }] },
})
const result = (id: string, is_error = false, content = '') => ({
  type: 'user',
  timestamp: at(),
  message: { content: [{ type: 'tool_result', tool_use_id: id, is_error, content }] },
})

function run(lines: object[]) {
  const acc = new SessionAccumulator()
  for (const l of lines) ingestClaudeLine(acc, JSON.stringify(l))
  return acc
}

/** What the parser read: counts, plus the tests and commits in its timeline. */
function read(acc: SessionAccumulator) {
  const calls = acc.timeline.filter((s): s is CallStep => s.k === 'call')
  const tests = calls.filter((c) => c.test)
  return {
    ...acc.signals,
    tests: tests.length,
    lastTestOk: tests.at(-1)?.ok,
    commits: calls.filter((c) => c.commit && c.ok !== false).length,
    lastCallOk: calls.at(-1)?.ok,
    last: acc.timeline.at(-1)?.k,
    declined: acc.timeline.some((s) => s.k === 'decline'),
  }
}

/** The files each call touched, in order. */
const paths = (acc: SessionAccumulator) =>
  acc.timeline.flatMap((s) => (s.k === 'call' && s.paths ? [s.paths] : []))

describe('claude code', () => {
  it('reads a session that ends badly', () => {
    const s = read(
      run([
        prompt('fix the login bug'),
        call('a', 'Bash', { command: 'npx vitest run' }),
        result('a', true, 'FAIL'),
        prompt('it still doesnt work wtf'),
        call('b', 'Bash', { command: 'rm -rf dist' }),
        result('b', true, "The user doesn't want to proceed with this tool use."),
        { type: 'user', timestamp: at(), message: { content: '[Request interrupted by user for tool use]' } },
      ]),
    )
    // A declined call has no outcome of its own; the decline is its own step.
    expect(s).toMatchObject({ tests: 1, lastTestOk: false, rejections: 1, interrupts: 0, lastCallOk: undefined })
    expect(s.declined).toBe(true)
  })

  it('records what each call did and the files it touched, from its command only for a shell tool', () => {
    const acc = run([
      call('a', 'Read', { file_path: 'x.ts' }),
      call('b', 'Edit', { file_path: 'x.ts', old_string: 'a', new_string: 'b' }),
      call('c', 'NotebookEdit', { notebook_path: 'n.ipynb' }),
      call('d', 'Grep', { pattern: 'x', path: 'src' }),
      call('e', 'Bash', { command: 'cat src/a.ts' }),
      call('f', 'mcp__notion__update_page', { command: 'update_content' }),
    ])
    expect(acc.timeline.map((c) => c.k === 'call' && [c.kind, c.paths])).toEqual([
      ['read', ['x.ts']], ['edit', ['x.ts']], ['edit', ['n.ipynb']], ['discover', undefined], ['read', ['src/a.ts']], ['mcp', undefined],
    ])
  })

  it('counts what you typed as prompts, not notifications, summaries or output', () => {
    const user = (content: string, extra: object = {}) => ({ type: 'user', timestamp: at(), message: { content }, ...extra })
    const raw = [
      user('fix the build', { origin: { kind: 'human' } }),
      user('<task-notification>agent finished</task-notification>', { origin: { kind: 'task-notification' } }),
      user('This session is being continued from a previous conversation', { isCompactSummary: true }),
      user('<bash-input>git status</bash-input>'),
      user('<bash-stdout>clean</bash-stdout>'),
      { type: 'attachment', timestamp: at(), attachment: { type: 'queued_command', commandMode: 'prompt', prompt: 'still broken' } },
      { type: 'attachment', timestamp: at(), attachment: { type: 'queued_command', commandMode: 'task-notification', prompt: 'done' } },
      user('thanks'),
    ].map((l) => JSON.stringify(l)).join('\n')
    const s = parseSession(raw, { text: true })
    const typed = s.events.filter((e) => e.k === 'prompt' || e.k === 'shell')
    expect(typed.map((e) => (e.k === 'prompt' ? s.text.get(e.id) : e.k))).toEqual(['fix the build', 'shell', 'still broken', 'thanks'])
    expect(s.events.filter((e) => e.k === 'system').map((e) => e.k === 'system' && `${e.what} ${e.tag}`)).toEqual([
      'user:task-notification context', 'user:compact-summary context', 'user:other context', 'attachment:queued_command context',
    ])
  })

})

describe('codex', () => {
  const cx = (type: string, payload: object) => ({ type, timestamp: at(), payload })
  const prompt = (text: string) =>
    cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
  let n = 0
  const command = (cmd: string, status: string) =>
    cx('event_msg', { type: 'item_completed', item: { id: `item${n++}`, type: 'CommandExecution', status, command: ['/bin/zsh', '-lc', cmd] } })

  it('reads how a Codex session ended', () => {
    const acc = new SessionAccumulator()
    for (const l of [
      prompt('<environment_context>injected</environment_context>'),
      prompt('make the tests pass'),
      command('pnpm test', 'failed'),
      cx('event_msg', { type: 'item_completed', item: { id: 'patch', type: 'FileChange', status: 'completed' } }),
      command('pnpm test', 'completed'),
      command('git commit -am fix', 'completed'),
      prompt('perfect, thanks'),
    ])
      ingestCodexLine(acc, JSON.stringify(l))
    expect(read(acc)).toMatchObject({ prompts: 2, toolCalls: 4, failedCalls: 1, tests: 2, lastTestOk: true, commits: 1, lastCallOk: true })
  })

  it('reads an older log from call records and output headers', () => {
    const call = (call_id: string, name: string, args: object) =>
      cx('response_item', { type: 'function_call', call_id, name, arguments: JSON.stringify(args) })
    const output = (call_id: string, output: string) => cx('response_item', { type: 'function_call_output', call_id, output })
    const patch = (call_id: string, input: string) => cx('response_item', { type: 'custom_tool_call', call_id, name: 'apply_patch', input })
    const acc = new SessionAccumulator()
    for (const l of [
      prompt('fix the parser'),
      call('a', 'exec_command', { cmd: 'pnpm test' }),
      output('a', 'Chunk ID: 1\nWall time: 2.0 seconds\nProcess exited with code 1\nOutput:\nFAIL'),
      patch('b', '*** Begin Patch\n*** Update File: x.ts\n@@\n-old line here\n+first attempt line\n*** End Patch'),
      cx('response_item', { type: 'custom_tool_call_output', call_id: 'b', output: 'Exit code: 0\nOutput:\nSuccess.' }),
      patch('c', '*** Begin Patch\n*** Update File: x.ts\n@@\n-first attempt line\n+second attempt line\n*** End Patch'),
      cx('response_item', { type: 'custom_tool_call_output', call_id: 'c', output: 'patch rejected by user' }),
      call('d', 'exec_command', { cmd: 'pnpm test' }),
      output('d', 'Wall time: 1.0 seconds\nProcess running with session ID 7\nOutput:'),
      call('e', 'write_stdin', { session_id: 7 }),
      output('e', 'Wall time: 3.0 seconds\nProcess exited with code 0\nOutput:\nok'),
    ])
      ingestCodexLine(acc, JSON.stringify(l))
    expect(read(acc)).toMatchObject({ toolCalls: 4, failedCalls: 1, rejections: 1, rework: 1, tests: 2, lastTestOk: true })
  })

  it('reads image views and tool searches as calls', () => {
    const acc = new SessionAccumulator()
    for (const l of [
      cx('event_msg', { type: 'item_completed', item: { id: 'img1', type: 'ImageView', path: '/repo/shot.png' } }),
      cx('response_item', { type: 'tool_search_call', call_id: 'ts1', status: 'completed', execution: 'client', arguments: {} }),
    ])
      ingestCodexLine(acc, JSON.stringify(l))
    const calls = acc.timeline.filter((s): s is CallStep => s.k === 'call')
    expect(calls.map((c) => [c.tool, c.kind, c.ok, c.paths])).toEqual([
      ['ImageView', 'read', true, ['/repo/shot.png']],
      ['tool_search', 'discover', true, undefined],
    ])
  })

  it('counts each web search once, however Codex logged it', () => {
    const acc = new SessionAccumulator()
    const item = (id: string, extra: object) => cx('event_msg', { type: 'item_completed', item: { id, ...extra } })
    for (const l of [
      cx('response_item', { type: 'web_search_call', status: 'completed', action: { type: 'search' } }),
      cx('response_item', { type: 'web_search_call', id: 'ws1', status: 'completed', action: { type: 'open_page' } }),
      item('ws1', { type: 'WebSearch', action: { type: 'open_page' } }),
      item('ws1', { type: 'Extension', kind: 'web.search', action: 'openPage' }),
      item('ws2', { type: 'WebSearch', action: { type: 'find_in_page' } }),
      item('ext', { type: 'Extension', kind: 'other.thing' }),
    ])
      ingestCodexLine(acc, JSON.stringify(l))
    const calls = acc.timeline.filter((s): s is CallStep => s.k === 'call')
    expect(calls.map((c) => [c.tool, c.kind, c.ok])).toEqual([
      ['web_search', 'web', true],
      ['web_search', 'web', true],
      ['web_search', 'web', true],
    ])
  })

  it('labels a question to you and your answer', () => {
    const acc = new SessionAccumulator()
    for (const l of [
      cx('response_item', { type: 'function_call', call_id: 'q', name: 'resolve_open_questions', arguments: '{}' }),
      cx('response_item', { type: 'function_call_output', call_id: 'q', output: 'answered' }),
    ])
      ingestCodexLine(acc, JSON.stringify(l))
    expect(acc.timeline.map((s) => s.k)).toEqual(['ask', 'answer'])
  })

  it('records a code-mode script as a call, with the calls it ran within it', () => {
    const raw = [
      cx('session_meta', { id: 'c1', cwd: '/work/app' }),
      cx('response_item', { type: 'custom_tool_call', call_id: 'cell', name: 'exec', input: 'await run("pnpm test")' }),
      cx('event_msg', { type: 'item_completed', item: { id: 'cmd', type: 'CommandExecution', status: 'failed', command: 'pnpm test' } }),
      cx('response_item', { type: 'custom_tool_call_output', call_id: 'cell', output: [{ type: 'input_text', text: 'Script failed\nError: tests failed' }] }),
    ].map((l) => JSON.stringify(l)).join('\n')
    const calls = parseSession(raw).events.filter((e) => e.k === 'call' || e.k === 'result')
    expect(calls).toMatchObject([
      { k: 'call', call: 'cell', tool: 'Code', name: 'exec', status: 'failed' },
      { k: 'call', call: 'cmd', tool: 'Shell', name: 'CommandExecution', kind: 'run', test: true, status: 'failed', within: 'cell' },
      { k: 'result', call: 'cell' },
    ])
  })

  it('counts each response\'s tokens once, from its usage record when the log has them', () => {
    const usage = (input: number, output: number) => ({ input_tokens: input, cached_input_tokens: 10, output_tokens: output })
    const raw = [
      cx('session_meta', { id: 'c1' }),
      { type: 'token_usage_record', timestamp: at(), payload: { usage: usage(100, 20) } },
      cx('event_msg', { type: 'token_count', info: { total_token_usage: usage(100, 20) } }),
      // A response whose token_count was never written.
      { type: 'token_usage_record', timestamp: at(), payload: { usage: usage(50, 5) } },
    ].map((l) => JSON.stringify(l)).join('\n')
    const s = parseSession(raw)
    expect(s.events.filter((e) => e.k === 'usage').map((e) => e.k === 'usage' && e.tokens)).toEqual([
      { input: 90, output: 20, cacheRead: 10, cacheWrite: 0 },
      { input: 40, output: 5, cacheRead: 10, cacheWrite: 0 },
    ])
    expect(s.events.filter((e) => e.k === 'system').map((e) => e.k === 'system' && e.what)).toEqual(['session_meta'])
  })

  it('records every file a patch touched', () => {
    const acc = new SessionAccumulator()
    const patch = '*** Begin Patch\n*** Update File: x.ts\n@@\n-a\n+b\n*** Add File: y.ts\n+c\n*** Update File: x.ts\n@@\n-d\n+e\n*** End Patch'
    ingestCodexLine(acc, JSON.stringify(cx('response_item', { type: 'custom_tool_call', call_id: 'p', name: 'apply_patch', input: patch })))
    expect(paths(acc)).toEqual([['x.ts', 'y.ts']])
  })
})

describe('detectors', () => {
  it('spots tests and commits', () => {
    expect(isTestCommand('cd app && pnpm test --run')).toBe(true)
    expect(isTestCommand('uv run pytest -x')).toBe(true)
    expect(isTestCommand('cargo nextest run')).toBe(true)
    expect(isTestCommand('cat test.txt')).toBe(false)
    expect(isCommitCommand('git -C repo commit -m x')).toBe(true)
    expect(isCommitCommand('git log --oneline')).toBe(false)
    expect(isPushCommand('git push -u origin main')).toBe(true)
    expect(isPushCommand('git -C repo push')).toBe(true)
    expect(isPushCommand('git pull')).toBe(false)
  })
})

describe('pi', () => {
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

  it('reads metadata, prompts, usage, cost, test outcomes and commits', () => {
    const s = session()
    s.entry('session_info', { name: 'Implement retry' })
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
    expect(a).toMatchObject({ projectPath: '/work/project', model: 'physical-model' })
    expect(a.signals).toMatchObject({ prompts: 2, toolCalls: 3, failedCalls: 1 })
    expect(a.timeline.filter(s => s.k === 'call')).toMatchObject([
      { test: true, ok: false }, { test: true, ok: true }, { commit: true, ok: true },
    ])
    expect(a.usage.map(u => u.tokens)).toEqual([{ input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }])
    expect(p.costUsd).toBeCloseTo(0.01)
  })

  it('counts every branch, but follows only the kept path', () => {
    const s = session()
    const fork = s.message('user', { content: 'research an approach' })
    s.call('failed-test', 'bash', { command: 'pnpm test' })
    s.result('failed-test', true)
    const abandoned = s.message('assistant', { content: [{ type: 'text', text: 'try something else' }] })
    const summary = s.entry('branch_summary', { fromId: abandoned, summary: 'research informed the solution', usage }, 'summary', fork)
    s.message('user', { content: 'use the other approach' })
    const kept = s.message('assistant', { content: [], usage })
    s.entry('compaction', { firstKeptEntryId: kept, tokensBefore: 50000, summary: 'not a new prompt', usage })
    const p = s.parse()
    expect(p.accumulator.signals).toMatchObject({ prompts: 2, toolCalls: 1, failedCalls: 1, compactions: 1 })
    expect(p.accumulator.usage.reduce((n, u) => n + totalTokens(u.tokens), 0)).toBe(300)
    const path = p.getPath()
    expect(path.complete).toBe(true)
    expect(path.entries.map(e => e.id)).toContain(summary)
    expect(path.entries.map(e => e.id)).not.toContain(abandoned)
    expect(p.getTimeline().some(s => s.k === 'call')).toBe(false)
    expect(p.getTimeline(abandoned).some(s => s.k === 'call')).toBe(true)
  })

  it('reads every edit shape and the files calls touched; rework only follows a successful write', () => {
    const s = session()
    s.call('r', 'read', { path: 'a.ts' })
    s.call('g', 'grep', { pattern: 'x', path: 'src' })
    s.call('bad-write', 'write', { path: 'a.ts', content: 'never actually written' })
    s.result('bad-write', true)
    s.call('edit0', 'edit', { path: 'a.ts', oldText: 'never actually written', newText: 'first successful line' })
    s.result('edit0')
    s.call('edit1', 'edit', { path: 'a.ts', old_string: 'first successful line', new_string: 'second successful line' })
    s.result('edit1')
    s.call('edit2', 'edit', { path: 'a.ts', edits: [{ oldText: 'second successful line', newText: 'third successful line' }] })
    s.result('edit2')
    const a = s.parse().accumulator
    expect(a.signals).toMatchObject({ rework: 2, failedCalls: 1 })
    expect(a.timeline.flatMap(t => (t.k === 'call' ? [t.paths] : []))).toEqual([['a.ts'], undefined, ['a.ts'], ['a.ts'], ['a.ts'], ['a.ts']])
  })

  it('separates aborts, failures, unknown results, your shell and injected messages', () => {
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
    s.message('toolResult', { toolCallId: 'missing', isError: false, usage })
    const p = s.parse()
    expect(p.accumulator.signals).toMatchObject({ prompts: 1, interrupts: 1, rejections: 0, failedCalls: 0, toolCalls: 2 })
    const calls = p.accumulator.timeline.filter(s => s.k === 'call')
    expect(calls).toMatchObject([{ tool: 'bash' }, { tool: 'read', ok: true }])
    expect(calls[0]).not.toHaveProperty('ok')
    expect(p.diagnostics.orphanResults).toBe(1)
    expect(JSON.stringify(p)).not.toMatch(/provider unavailable|not retained/)
  })

  it('tolerates duplicates, damaged lines, older linear logs and broken trees', () => {
    const s = session()
    s.message('user', { content: 'hello' })
    s.call('unmatched', 'bash', { command: 'pnpm test' })
    const p = s.parse()
    p.ingestLine(JSON.stringify(s.rows.at(-1)))
    p.ingestLine('{truncated')
    for (const v of [null, [], 1, { type: 'message' }, { type: 'message', id: 'broken', timestamp: 'invalid' }]) p.ingestLine(JSON.stringify(v))
    expect(p.accumulator.signals.toolCalls).toBe(1)
    expect(p.accumulator.timeline.at(-1)).not.toHaveProperty('ok')
    expect(p.diagnostics).toMatchObject({ duplicateEntries: 1, malformedLines: 1, ignoredLines: 5 })

    const linear = parsePiSession([
      JSON.stringify({ type: 'session', timestamp: new Date(start).toISOString() }),
      JSON.stringify({ type: 'message', timestamp: new Date(start + 1000).toISOString(), message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'message', timestamp: new Date(start + 2000).toISOString(), message: { role: 'assistant', content: [] } }),
    ])
    expect(linear.getPath()).toMatchObject({ complete: true, entries: { length: 2 } })
    const broken = new PiSessionParser()
    broken.ingestLine(JSON.stringify({ type: 'custom', id: 'a', parentId: 'missing', timestamp: new Date(start).toISOString() }))
    expect(broken.getPath().complete).toBe(false)
    expect(() => broken.getTimeline()).toThrow('Incomplete')
    // The missing parent arrives, pointing back at its child: a cycle, not an endless walk.
    broken.ingestLine(JSON.stringify({ type: 'custom', id: 'missing', parentId: 'a', timestamp: new Date(start).toISOString() }))
    expect(broken.getPath().complete).toBe(false)
  })

  it('records activity for messages, not metadata, at the entry time, not the message start time', () => {
    const p = parsePiSession([
      JSON.stringify({ type: 'message', id: 'a', parentId: null, timestamp: new Date(start).toISOString(), message: { role: 'user', content: 'hello' } }),
      JSON.stringify({ type: 'label', id: 'b', parentId: 'a', timestamp: new Date(start + 240_000).toISOString() }),
      JSON.stringify({ type: 'message', id: 'c', parentId: 'b', timestamp: new Date(start + 480_000).toISOString(), message: { role: 'assistant', timestamp: start, content: [], usage } }),
    ])
    expect(p.accumulator.activity).toEqual([{ at: start, by: 'you' }, { at: start + 480_000, by: 'agent' }])
  })
})

describe('opencode', () => {
  it('records your prompts, the reply at its completion time, its tokens and tool failures', () => {
    const acc = new SessionAccumulator()
    ingestOpencodeMessage(acc, { role: 'user', created: 1_000, directory: '/work/app' })
    ingestOpencodeMessage(acc, { role: 'assistant', created: 2_000, completed: 9_000, model: 'm', tokens: { input: 5, output: 3, reasoning: 2, cacheRead: 7 } })
    ingestOpencodeMessage(acc, { role: 'assistant', created: 10_000, error: 'MessageAbortedError' })
    ingestOpencodePart(acc, { type: 'tool', status: 'completed' })
    ingestOpencodePart(acc, { type: 'tool', status: 'error' })
    ingestOpencodePart(acc, { type: 'text' })
    expect(acc.activity).toEqual([{ at: 1_000, by: 'you' }, { at: 9_000, by: 'agent' }, { at: 10_000, by: 'agent' }])
    expect(acc.usage[0]).toEqual({ at: 9_000, tokens: { input: 5, output: 5, cacheRead: 7, cacheWrite: 0 } })
    expect(acc.timeline.map((s) => s.k)).toEqual(['prompt', 'interrupt'])
    expect(acc.signals).toMatchObject({ prompts: 1, interrupts: 1, toolCalls: 2, failedCalls: 1 })
    expect(acc).toMatchObject({ projectPath: '/work/app', model: 'm' })
  })
})

describe('cursor', () => {
  it('records you (type 1) and the agent, and tokens only when Cursor stored them', () => {
    const acc = new SessionAccumulator()
    ingestCursorBubble(acc, { createdAt: '2026-01-01T00:00:00Z', type: 1, model: 'default' })
    ingestCursorBubble(acc, { createdAt: '2026-01-01T00:00:30Z', type: 2, inputTokens: 4, outputTokens: 6, model: 'gpt' })
    expect(acc.activity.map((e) => e.by)).toEqual(['you', 'agent'])
    expect(acc.usage).toHaveLength(1)
    expect(acc.timeline.map((s) => s.k)).toEqual(['prompt'])
    expect(acc.model).toBe('gpt')
  })
})

describe('zed', () => {
  it('records each update as agent activity, in the first folder', () => {
    const acc = new SessionAccumulator()
    ingestZedThread(acc, { updatedAt: '2026-01-01T00:00:00Z', folders: '["/work/app","/work/lib"]' })
    ingestZedThread(acc, { updatedAt: '2026-01-01T00:01:00Z', folders: '/other' })
    expect(acc.activity.map((e) => e.by)).toEqual(['agent', 'agent'])
    expect(acc.projectPath).toBe('/work/app')
  })
})

describe('synthetic fixtures', () => {
  // Synthetic fixtures only. Private/sanitized real-session corpora stay in the consumer.
  const cases = [
    ['claude', 'shell-and-tools'],
    ['codex', 'shell-and-patches'],
    ['pi', 'tools-and-bash'],
  ] as const

  function line(s: Step, t0: number): string {
    const head = `+${(s.at - t0) / 1000}s`.padEnd(6)
    if (s.k !== 'call') return `${head} ${s.k}`
    const ok = s.ok === undefined ? '?' : s.ok ? 'ok' : 'failed'
    const flags = (['test', 'commit', 'push', 'rework'] as const).filter(f => s[f])
    return [head, 'call', s.tool, s.kind, ok, ...flags, ...(s.paths ?? [])].join(' ')
  }

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

describe('shellKind', () => {
  const cases: [string, string, string[]][] = [
    // reads
    ["sed -n '1,80p' src/fetch.ts", 'read', ['src/fetch.ts']],
    ['nl -ba src/fetch.ts | head -40', 'read', ['src/fetch.ts']],
    ["cd /work/app && sed -n '10,30p' src/a.ts && sed -n '1,5p' src/b.ts", 'read', ['src/a.ts', 'src/b.ts']],
    // searches
    ['rg -n "retry" src', 'discover', []],
    ['git grep -n fetch', 'discover', []],
    // a search then a read is a read
    ['rg -n "retry" src/a.ts || true\nsed -n \'80,180p\' src/a.ts', 'read', ['src/a.ts']],
    // edits
    ["cat > notes/plan.md <<'EOF'\nthe plan\nEOF", 'edit', ['notes/plan.md']],
    ["sed -i '' 's/a\\/b/c/' src/fetch.ts", 'edit', ['src/fetch.ts']],
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
    // web
    ['curl -s https://example.com/api', 'web', []],
    // Codex wraps commands in a login shell
    ["/bin/zsh -lc \"sed -n '1,80p' src/fetch.ts\"", 'read', ['src/fetch.ts']],
  ]
  it('judges a command by its programs', () => {
    expect(cases.map(([cmd]) => [cmd, shellKind(cmd)])).toEqual(cases.map(([cmd, kind, paths]) => [cmd, { kind, paths }]))
  })
})

describe('tool names', () => {
  it('names the same tool alike across harnesses, and gives its kind', () => {
    const cases = [
      ['TodoWrite', 'Todo', 'discover'], ['update_plan', 'Todo', 'discover'], ['Skill', 'Skill', 'discover'], ['Grep', 'Search', 'discover'],
      ['Read', 'Read', 'read'], ['ImageView', 'Read', 'read'],
      ['apply_patch', 'Patch', 'edit'], ['FileChange', 'Patch', 'edit'],
      ['Bash', 'Shell', 'run'], ['exec_command', 'Shell', 'run'], ['CommandExecution', 'Shell', 'run'], ['js', 'Code', 'run'],
      ['Agent', 'Task', 'delegate'], ['followup_task', 'Task', 'delegate'],
      ['mcp__linear__save_issue', 'Mcp', 'mcp'], ['plugin.search', 'Mcp', 'mcp'],
      ['Mystery', 'Other', 'other'],
    ]
    expect(cases.map(([name]) => [name, toolOf(name!), kindOf(name!)])).toEqual(cases)
  })
})
