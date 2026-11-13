import { describe, expect, it } from 'vitest'
import { parseSession, reader, type Harness, type SessionEvent } from '../src/index.js'
import { isCommitCommand, isPushCommand, isTestCommand } from '../src/commands.js'
import { outcomes } from '../src/events.js'
import { kindOf, shellKind, toolOf } from '../src/kinds.js'
import type { TokenCounts } from '../src/types.js'

/** Every agent's parser, then what they share. Synthetic data only. */

const totalTokens = (t: TokenCounts) => t.input + t.output + t.cacheRead + t.cacheWrite

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

/** Reads lines with one agent's reader, as a live consumer would. */
function read(agent: Extract<Harness, 'claude' | 'codex' | 'pi'>, lines: (object | string)[]) {
  const r = reader(agent, { text: true })
  const events = lines.flatMap((l) => r.read(typeof l === 'string' ? l : JSON.stringify(l)))
  return { events, calls: outcomes(events), text: r.text, info: r.session() }
}

/** Events as short labels: a call's tool name, a result's status and rework. */
const label = (e: SessionEvent) =>
  e.k === 'call' ? `call ${e.name}` : e.k === 'result' ? `result ${e.status}${e.rework ? ' rework' : ''}` : e.k === 'system' ? `system ${e.what}` : e.k

const only = <K extends SessionEvent['k']>(events: SessionEvent[], k: K) => events.filter((e): e is Extract<SessionEvent, { k: K }> => e.k === k)

describe('claude code', () => {
  it('reads a session that ends badly', () => {
    const { events } = read('claude', [
      prompt('fix the login bug'),
      call('a', 'Bash', { command: 'npx vitest run' }),
      result('a', true, 'FAIL'),
      prompt('it still doesnt work wtf'),
      call('b', 'Bash', { command: 'rm -rf dist' }),
      result('b', true, "The user doesn't want to proceed with this tool use."),
      // Logged right after a decline; part of it, not an interrupt of its own.
      { type: 'user', timestamp: at(), message: { content: '[Request interrupted by user for tool use]' } },
    ])
    expect(events.map(label)).toEqual(['prompt', 'call Bash', 'result failed', 'prompt', 'call Bash', 'result declined', 'system user:other'])
    expect(only(events, 'call')[0]).toMatchObject({ test: true })
  })

  it('reads a subagent\'s own file as its work, and a subagent inline in its parent\'s file as the subagent\'s', () => {
    const side = (agentId: string, l: object) => ({ ...l, isSidechain: true, sessionId: 'parent', agentId })
    const subagent = [
      side('a1', { type: 'user', timestamp: at(), message: { content: 'find the retry logic' } }),
      side('a1', call('c', 'Grep', { pattern: 'retry' })),
      side('a1', result('c')),
      side('a1', { type: 'assistant', timestamp: at(), message: { content: [{ type: 'text', text: 'It is in fetch.ts.' }] } }),
    ]
    const own = read('claude', subagent)
    expect(own.info).toMatchObject({ id: 'a1', parent: { session: 'parent', via: 'subagent' } })
    // The task is the parent agent's instruction, not something you typed.
    expect(own.events.map(label)).toEqual(['system user:other', 'call Grep', 'result ok', 'reply'])

    const parent = read('claude', [{ ...prompt('fix retry'), sessionId: 'parent' }, ...subagent])
    expect(parent.events.map(label)).toEqual(['prompt', 'system subagent', 'system subagent', 'system subagent', 'system subagent'])
  })

  it('counts a response once across its lines, keeping usage that grew as it streamed', () => {
    const part = (output: number) => ({ type: 'assistant', timestamp: at(), message: { id: 'm', content: [], usage: { input_tokens: 10, output_tokens: output } } })
    const { events } = read('claude', [part(8), part(8), part(412)])
    expect(only(events, 'usage').map((e) => e.tokens)).toEqual([
      { input: 10, output: 8, cacheRead: 0, cacheWrite: 0 },
      { input: 0, output: 404, cacheRead: 0, cacheWrite: 0 },
    ])
  })

  it('excludes inline subagent usage and model changes, but keeps them in the subagent file', () => {
    const child = {
      type: 'assistant', timestamp: at(), sessionId: 'parent', isSidechain: true, agentId: 'child',
      message: { id: 'child-msg', model: 'child-model', content: [], usage: { input_tokens: 123, output_tokens: 45 } },
    }
    const parent = read('claude', [
      { ...prompt('hello'), sessionId: 'parent' },
      { type: 'assistant', timestamp: at(), message: { id: 'parent-msg', model: 'parent-model', content: [], usage: { input_tokens: 10 } } },
      child,
    ])
    expect(parent.info.model).toBe('parent-model')
    expect(only(parent.events, 'usage').map((e) => e.tokens.input)).toEqual([10])
    const own = read('claude', [child])
    expect(own.info.model).toBe('child-model')
    expect(only(own.events, 'usage').map((e) => e.tokens.input)).toEqual([123])
  })

  it('skips invalid content blocks without losing later records', () => {
    const { events, text } = read('claude', [
      { type: 'assistant', timestamp: at(), message: { content: [null, 42, [], { type: 'text', text: 'kept' }] } },
      { type: 'user', timestamp: at(), message: { content: [null, { type: 'text', text: 'hello' }] } },
      call('c', 'Read', {}),
      { type: 'user', timestamp: at(), message: { content: [null, { type: 'tool_result', tool_use_id: 'c', content: [null, { type: 'text', text: 'ok' }] }] } },
      prompt('continue'),
    ])
    expect(events.map(label)).toEqual(['reply', 'prompt', 'call Read', 'result ok', 'prompt'])
    expect(Object.values(text)).toEqual(['kept', 'hello', 'continue'])
  })

  it('keeps a question you declined', () => {
    const { events } = read('claude', [
      call('q', 'AskUserQuestion', { questions: [] }),
      result('q', true, "The user doesn't want to proceed with this tool use."),
    ])
    expect(events.slice(-2)).toMatchObject([{ k: 'ask', call: 'q' }, { k: 'answer', call: 'q', by: 'you', declined: true }])
  })

  it('records what each call did and the files it touched, from its command only for a shell tool', () => {
    const { events } = read('claude', [
      call('a', 'Read', { file_path: 'x.ts' }),
      call('b', 'Edit', { file_path: 'x.ts', old_string: 'a', new_string: 'b' }),
      call('c', 'NotebookEdit', { notebook_path: 'n.ipynb' }),
      call('d', 'Grep', { pattern: 'x', path: 'src' }),
      call('e', 'Bash', { command: 'cat src/a.ts' }),
      call('f', 'mcp__notion__update_page', { command: 'update_content' }),
    ])
    expect(only(events, 'call').map((c) => [c.kind, c.paths])).toEqual([
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
    expect(typed.map((e) => (e.k === 'prompt' ? s.text[e.id] : e.k))).toEqual(['fix the build', 'shell', 'still broken', 'thanks'])
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

  it.each(['null', '[]', '42', '"text"', '{broken'])('tolerates non-object call arguments: %s', (args) => {
    const { events } = read('codex', [
      cx('response_item', { type: 'function_call', call_id: 'c', name: 'exec_command', arguments: args }),
      cx('response_item', { type: 'function_call_output', call_id: 'c', output: 'Exit code: 0' }),
      prompt('continue'),
    ])
    expect(events.map(label)).toEqual(['call exec_command', 'result ok', 'prompt'])
  })

  it('reads how a Codex session ended', () => {
    const { events, calls } = read('codex', [
      prompt('<environment_context>injected</environment_context>'),
      prompt('make the tests pass'),
      command('pnpm test', 'failed'),
      cx('event_msg', { type: 'item_completed', item: { id: 'patch', type: 'FileChange', status: 'completed' } }),
      command('pnpm test', 'completed'),
      command('git commit -am fix', 'completed'),
      prompt('perfect, thanks'),
    ])
    expect(events.filter((e) => e.k === 'prompt')).toHaveLength(2)
    expect(only(events, 'call').map((c) => [c.name, c.test ?? c.commit, calls[c.call]])).toEqual([
      ['CommandExecution', true, 'failed'], ['FileChange', undefined, 'ok'], ['CommandExecution', true, 'ok'], ['CommandExecution', true, 'ok'],
    ])
  })

  it('reads an older log from call records and output headers, waiting on running commands', () => {
    const call = (call_id: string, name: string, args: object) =>
      cx('response_item', { type: 'function_call', call_id, name, arguments: JSON.stringify(args) })
    const output = (call_id: string, output: string) => cx('response_item', { type: 'function_call_output', call_id, output })
    const patch = (call_id: string, input: string) => cx('response_item', { type: 'custom_tool_call', call_id, name: 'apply_patch', input })
    const { events } = read('codex', [
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
    // A rejected patch isn't rework; d's result waits for the poll that saw it exit.
    expect(events.map(label)).toEqual([
      'prompt', 'call exec_command', 'result failed', 'call apply_patch', 'result ok', 'call apply_patch', 'result declined',
      'call exec_command', 'system response_item:function_call_output', 'system response_item:function_call', 'result ok',
    ])
    expect(only(events, 'result').at(-1)).toMatchObject({ call: 'd' })
  })

  it('reads image views and tool searches as calls that settle on their own line', () => {
    const { events } = read('codex', [
      cx('event_msg', { type: 'item_completed', item: { id: 'img1', type: 'ImageView', path: '/repo/shot.png' } }),
      cx('response_item', { type: 'tool_search_call', call_id: 'ts1', status: 'completed', execution: 'client', arguments: {} }),
    ])
    expect(events.map((e) => (e.k === 'call' ? [e.tool, e.kind, e.paths] : label(e)))).toEqual([
      ['Read', 'read', ['/repo/shot.png']], 'result ok', ['Skill', 'discover', undefined], 'result ok',
    ])
  })

  it('counts each web search once, however Codex logged it', () => {
    const item = (id: string, extra: object) => cx('event_msg', { type: 'item_completed', item: { id, ...extra } })
    const { events } = read('codex', [
      cx('response_item', { type: 'web_search_call', status: 'completed', action: { type: 'search' } }),
      cx('response_item', { type: 'web_search_call', id: 'ws1', status: 'completed', action: { type: 'open_page' } }),
      item('ws1', { type: 'WebSearch', action: { type: 'open_page' } }),
      item('ws1', { type: 'Extension', kind: 'web.search', action: 'openPage' }),
      item('ws2', { type: 'WebSearch', action: { type: 'find_in_page' } }),
      item('ext', { type: 'Extension', kind: 'other.thing' }),
    ])
    expect(only(events, 'call').map((c) => [c.tool, c.kind])).toEqual([['WebSearch', 'web'], ['WebSearch', 'web'], ['WebSearch', 'web']])
    expect(only(events, 'result').map((r) => r.status)).toEqual(['ok', 'ok', 'ok'])
  })

  it('tells your prompts from injected context, even when they start with <', () => {
    const user = (...content: object[]) => cx('response_item', { type: 'message', role: 'user', content })
    const text = (t: string) => ({ type: 'input_text', text: t })
    const { events, text: words } = read('codex', [
      user(text('<environment_context>\n  <cwd>/work/app</cwd>\n</environment_context>')),
      user(text("<div> isn't centering")),
      user(text('<image name=[Image #1]>'), { type: 'input_image', image_url: 'data:' }, text('</image>'), text('what is wrong here?')),
      user(text('<user_shell_command>\n<command>\ngit status\n</command>\n<result>\nclean\n</result>\n</user_shell_command>')),
    ])
    expect(events.map((e) => [label(e), words[e.id]])).toEqual([
      ['system response_item:message:user', undefined],
      ['prompt', "<div> isn't centering"],
      ['prompt', 'what is wrong here?'],
      ['shell', undefined],
    ])
  })

  it('labels a question to you and your answer', () => {
    const { events } = read('codex', [
      cx('response_item', { type: 'function_call', call_id: 'q', name: 'resolve_open_questions', arguments: '{}' }),
      cx('response_item', { type: 'function_call_output', call_id: 'q', output: 'answered' }),
    ])
    expect(events.map(label)).toEqual(['ask', 'answer'])
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
      { k: 'call', call: 'cell', tool: 'Code', name: 'exec' },
      { k: 'call', call: 'cmd', tool: 'Shell', name: 'CommandExecution', kind: 'run', test: true, within: 'cell' },
      { k: 'result', call: 'cmd', status: 'failed' },
      { k: 'result', call: 'cell', status: 'failed' },
    ])
  })

  it('ends a code-mode script cut off before its output at the abort or next prompt', () => {
    const item = (id: string) => cx('event_msg', { type: 'item_completed', item: { id, type: 'CommandExecution', status: 'completed', command: 'ls' } })
    const cell = (id: string) => cx('response_item', { type: 'custom_tool_call', call_id: id, name: 'exec', input: 'await run("ls")' })
    const prompt = cx('response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'go on' }] })
    const { events, calls } = read('codex', [
      cell('s1'), item('a'), cx('event_msg', { type: 'turn_aborted', reason: 'interrupted' }), item('b'),
      cell('s2'), item('c'), prompt, item('d'),
    ])
    expect(events.filter((e) => e.k === 'call').map((e) => [e.call, e.within])).toEqual([
      ['s1', undefined], ['a', 's1'], ['b', undefined], ['s2', undefined], ['c', 's2'], ['d', undefined],
    ])
    expect([calls.s1, calls.s2]).toEqual(['unknown', 'unknown'])
  })

  it('reads MCP calls a code-mode script ran as Mcp', () => {
    const { events } = read('codex', [
      cx('event_msg', { type: 'mcp_tool_call_end', call_id: 'a', invocation: { server: 'linear', tool: 'save_issue' }, result: { Ok: {} } }),
      cx('event_msg', { type: 'mcp_tool_call_end', call_id: 'b', result: { Err: 'down' } }),
      cx('event_msg', { type: 'item_completed', item: { id: 'c', type: 'McpToolCall', server: 'notion', tool: 'search', status: 'completed' } }),
      cx('event_msg', { type: 'mcp_tool_call_end', call_id: 'd', invocation: { server: 'my-server', tool: 'my.tool' }, result: { Ok: {} } }),
      cx('event_msg', { type: 'mcp_tool_call_end', call_id: 'e', invocation: { tool: 'plugin.search' }, result: { Ok: {} } }),
    ])
    expect(only(events, 'call').map((e) => [e.name, e.tool, e.kind])).toEqual([
      ['mcp__linear__save_issue', 'Mcp', 'mcp'], ['mcp', 'Mcp', 'mcp'], ['mcp__notion__search', 'Mcp', 'mcp'],
      // A dotted tool keeps its server when Codex gives one, and stays server.tool when it doesn't.
      ['mcp__my-server__my.tool', 'Mcp', 'mcp'], ['plugin.search', 'Mcp', 'mcp'],
    ])
    expect(outcomes(events)).toEqual({ a: 'ok', b: 'failed', c: 'ok', d: 'ok', e: 'ok' })
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
    const patch = '*** Begin Patch\n*** Update File: x.ts\n@@\n-a\n+b\n*** Add File: y.ts\n+c\n*** Update File: x.ts\n@@\n-d\n+e\n*** End Patch'
    const { events } = read('codex', [cx('response_item', { type: 'custom_tool_call', call_id: 'p', name: 'apply_patch', input: patch })])
    expect(only(events, 'call')[0]!.paths).toEqual(['x.ts', 'y.ts'])
  })
})

describe('call statuses', () => {
  it('treats prototype property names as ordinary call IDs', () => {
    const r = reader('opencode')
    for (const callId of ['toString', '__proto__', 'constructor']) r.read({ part: { type: 'tool', callId, tool: 'bash', start: 1 } })
    const before = r.session()
    expect(Object.keys(before.calls)).toEqual(['toString', '__proto__', 'constructor'])
    expect(Object.values(before.calls)).toEqual(['unknown', 'unknown', 'unknown'])
    for (const callId of Object.keys(before.calls)) r.read({ part: { type: 'tool', callId, start: 1, status: 'completed' } })
    expect(Object.values(r.session().calls)).toEqual(['ok', 'ok', 'ok'])
    expect(Object.values(before.calls)).toEqual(['unknown', 'unknown', 'unknown'])
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
    // Quoted text is data: a commit message or an echo that names a command doesn't run it.
    expect(isTestCommand('git commit -m "Fix retry\n\nrun pytest after"')).toBe(false)
    expect(isPushCommand('git commit -m "then git push" && echo done')).toBe(false)
    expect(isTestCommand('echo "pnpm test"')).toBe(false)
  })
})

describe('pi', () => {
  it('keeps leafId live as entries are appended', () => {
    const r = reader('pi')
    expect(r.leafId).toBeUndefined()
    r.read(JSON.stringify({ type: 'session', version: 3, id: 's', timestamp: at() }))
    for (const [id, parentId] of [['a', null], ['b', 'a']] as const) {
      r.read(JSON.stringify({ type: 'message', id, parentId, timestamp: at(), message: { role: 'user', content: 'hello' } }))
      expect(r.leafId).toBe(id)
      expect(r.getPath().entries.at(-1)?.id).toBe(id)
    }
  })

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
    const parse = () => {
      const r = reader('pi', { text: true })
      const events = rows.flatMap((row) => r.read(JSON.stringify(row)))
      return { r, events, calls: outcomes(events) }
    }
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
    const { r, events, calls } = s.parse()
    expect(r.metadata).toMatchObject({ id: 'session-id', formatVersion: 3, parentSession: '/parent.jsonl', name: 'Implement retry' })
    expect(r.session()).toMatchObject({ id: 'session-id', cwd: '/work/project', model: 'physical-model', parent: { session: '/parent.jsonl', via: 'fork' } })
    expect(only(events, 'prompt')).toHaveLength(2)
    expect(only(events, 'call').map((c) => [c.test ?? c.commit, calls[c.call]])).toEqual([[true, 'failed'], [true, 'ok'], [true, 'ok']])
    expect(only(events, 'usage')).toMatchObject([{ tokens: { input: 10, output: 20, cacheRead: 30, cacheWrite: 40 }, cost: 0.01 }])
  })

  it('reads every branch, and follows the kept one', () => {
    const s = session()
    const fork = s.message('user', { content: 'research an approach' })
    s.call('failed-test', 'bash', { command: 'pnpm test' })
    s.result('failed-test', true)
    const abandoned = s.message('assistant', { content: [{ type: 'text', text: 'try something else' }] })
    const summary = s.entry('branch_summary', { fromId: abandoned, summary: 'research informed the solution', usage }, 'summary', fork)
    s.message('user', { content: 'use the other approach' })
    const kept = s.message('assistant', { content: [], usage })
    s.entry('compaction', { firstKeptEntryId: kept, tokensBefore: 50000, summary: 'not a new prompt', usage })
    const { r, events } = s.parse()
    expect(events.map(label).filter((l) => !l.startsWith('system'))).toEqual(['prompt', 'call bash', 'result failed', 'reply', 'usage', 'prompt', 'usage', 'compact', 'usage'])
    expect(only(events, 'usage').reduce((n, u) => n + totalTokens(u.tokens), 0)).toBe(300)
    const onPath = (leaf?: string) => new Set(r.getPath(leaf).entries.flatMap((e) => e.events))
    expect(r.getPath().complete).toBe(true)
    expect(r.getPath().entries.map((e) => e.id)).toContain(summary)
    expect(events.filter((e) => onPath().has(e.id)).some((e) => e.k === 'call')).toBe(false)
    expect(events.filter((e) => onPath(abandoned).has(e.id)).some((e) => e.k === 'call')).toBe(true)
  })

  it('reads every edit shape and the files calls touched', () => {
    const s = session()
    s.call('r', 'read', { path: 'a.ts' })
    s.call('g', 'grep', { pattern: 'x', path: 'src' })
    s.call('w', 'write', { path: 'a.ts', content: 'x' })
    s.call('e1', 'edit', { path: 'a.ts', oldText: 'a', newText: 'b' })
    s.call('e2', 'edit', { path: 'a.ts', old_string: 'a', new_string: 'b' })
    s.call('e3', 'edit', { path: 'a.ts', edits: [{ oldText: 'a', newText: 'b' }] })
    expect(only(s.parse().events, 'call').map((c) => [c.kind, c.paths])).toEqual([
      ['read', ['a.ts']], ['discover', undefined], ['edit', ['a.ts']], ['edit', ['a.ts']], ['edit', ['a.ts']], ['edit', ['a.ts']],
    ])
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
    s.message('toolResult', { toolCallId: 'missing', usage })
    const { r, events } = s.parse()
    expect(events.map(label).filter((l) => !l.startsWith('system'))).toEqual([
      'shell', 'prompt', 'call bash', 'result interrupted', 'interrupt', 'usage', 'call read', 'result unknown', 'usage',
    ])
    expect(r.diagnostics.orphanResults).toBe(1)
    expect(r.session().warnings).toContain('1 tool results without a matching call skipped')
    expect(JSON.stringify([events, r.text])).not.toMatch(/provider unavailable|not retained/)
  })

  it('tolerates duplicates, damaged lines, older linear logs and broken trees', () => {
    const s = session()
    s.message('user', { content: 'hello' })
    s.call('unmatched', 'bash', { command: 'pnpm test' })
    const { r, events } = s.parse()
    const more = [JSON.stringify(s.rows.at(-1)), '{truncated', ...[null, [], 1, { type: 'message' }, { type: 'message', id: 'broken', timestamp: 'invalid' }].map((v) => JSON.stringify(v))]
    expect(more.flatMap((l) => r.read(l))).toEqual([])
    expect(outcomes(events)).toEqual({ unmatched: 'unknown' })
    expect(r.diagnostics).toMatchObject({ duplicateEntries: 1, malformedLines: 1, ignoredLines: 5 })
    expect(r.session().warnings).toContain('1 duplicate entries skipped')

    const linear = reader('pi')
    for (const l of [
      { type: 'session', timestamp: new Date(start).toISOString() },
      { type: 'message', timestamp: new Date(start + 1000).toISOString(), message: { role: 'user', content: 'hello' } },
      { type: 'message', timestamp: new Date(start + 2000).toISOString(), message: { role: 'assistant', content: [] } },
    ]) linear.read(JSON.stringify(l))
    expect(linear.getPath()).toMatchObject({ complete: true, entries: { length: 2 } })

    const broken = reader('pi')
    broken.read(JSON.stringify({ type: 'custom', id: 'a', parentId: 'missing', timestamp: new Date(start).toISOString() }))
    expect(broken.getPath().complete).toBe(false)
    expect(broken.session().warnings).toContain('Incomplete or cyclic ancestry; every branch retained')
    // The missing parent arrives, pointing back at its child: a cycle, not an endless walk.
    broken.read(JSON.stringify({ type: 'custom', id: 'missing', parentId: 'a', timestamp: new Date(start).toISOString() }))
    expect(broken.getPath().complete).toBe(false)
  })

  it('times events by the entry, not the message start', () => {
    const r = reader('pi')
    const events = [
      { type: 'message', id: 'a', parentId: null, timestamp: new Date(start).toISOString(), message: { role: 'user', content: 'hello' } },
      { type: 'label', id: 'b', parentId: 'a', timestamp: new Date(start + 240_000).toISOString() },
      { type: 'message', id: 'c', parentId: 'b', timestamp: new Date(start + 480_000).toISOString(), message: { role: 'assistant', timestamp: start, content: [], usage } },
    ].flatMap((l) => r.read(JSON.stringify(l)))
    expect(events.map((e) => [e.at - start, e.by, label(e)])).toEqual([[0, 'you', 'prompt'], [240_000, 'system', 'system label'], [480_000, 'agent', 'usage']])
  })
})

describe('rework', () => {
  // The same story in each agent's log: the agent writes a line, an edit of it fails,
  // then an edit of it succeeds. Only the successful one is rework.
  const line = 'const retries = computeRetries(config)'
  it('claude code', () => {
    const { events } = read('claude', [
      call('w', 'Write', { file_path: 'a.ts', content: line }), result('w'),
      call('x', 'Edit', { file_path: 'a.ts', old_string: line, new_string: 'x' }), result('x', true, 'String not found'),
      call('y', 'Edit', { file_path: 'a.ts', old_string: line, new_string: 'y' }), result('y'),
    ])
    expect(only(events, 'result').map(label)).toEqual(['result ok', 'result failed', 'result ok rework'])
  })
  it('codex', () => {
    const cx = (type: string, payload: object) => ({ type, timestamp: at(), payload })
    const patch = (id: string, body: string) => cx('response_item', { type: 'custom_tool_call', call_id: id, name: 'apply_patch', input: `*** Begin Patch\n*** Update File: a.ts\n@@\n${body}\n*** End Patch` })
    const done = (id: string, output: string) => cx('response_item', { type: 'custom_tool_call_output', call_id: id, output })
    const { events } = read('codex', [
      patch('w', `+${line}`), done('w', 'Exit code: 0'),
      patch('x', `-${line}\n+x`), done('x', 'apply_patch verification failed'),
      patch('y', `-${line}\n+y`), done('y', 'Exit code: 0'),
    ])
    expect(only(events, 'result').map(label)).toEqual(['result ok', 'result failed', 'result ok rework'])
  })
  it('pi', () => {
    let clock = Date.parse('2026-11-02T14:00:00Z')
    const msg = (message: object) => ({ type: 'message', id: `m${clock}`, parentId: null, timestamp: new Date((clock += 1000)).toISOString(), message })
    const call = (id: string, name: string, args: object) => msg({ role: 'assistant', content: [{ type: 'toolCall', id, name, arguments: args }] })
    const done = (id: string, isError = false) => msg({ role: 'toolResult', toolCallId: id, isError, content: [] })
    const { events } = read('pi', [
      { type: 'session', version: 1, id: 's', timestamp: new Date(clock).toISOString() },
      call('w', 'write', { path: 'a.ts', content: line }), done('w'),
      call('x', 'edit', { path: 'a.ts', oldText: line, newText: 'x' }), done('x', true),
      call('y', 'edit', { path: 'a.ts', oldText: line, newText: 'y' }), done('y'),
    ])
    expect(only(events, 'result').map(label)).toEqual(['result ok', 'result failed', 'result ok rework'])
  })
})

describe('opencode', () => {
  it('reads your prompts, the reply at its completion time, its tokens, and tool calls with their results', () => {
    const r = reader('opencode')
    const events = [
      ...r.read({ message: { role: 'user', created: 1_000, directory: '/work/app' } }),
      ...r.read({ message: { role: 'assistant', created: 2_000, completed: 9_000, model: 'm', tokens: { input: 5, output: 3, reasoning: 2, cacheRead: 7 } } }),
      ...r.read({ message: { role: 'assistant', created: 10_000, error: 'MessageAbortedError' } }),
      ...r.read({ part: { type: 'tool', callId: 't1', tool: 'bash', status: 'completed', start: 3_000, end: 4_000 } }),
      ...r.read({ part: { type: 'tool', callId: 't2', tool: 'read', status: 'error', start: 5_000, end: 6_000 } }),
      ...r.read({ part: { type: 'text' } }),
    ]
    expect(events.map((e) => [e.at, e.by, label(e)])).toEqual([
      [1_000, 'you', 'prompt'], [9_000, 'agent', 'reply'], [9_000, 'agent', 'usage'], [10_000, 'agent', 'reply'], [10_000, 'you', 'interrupt'], [10_000, 'agent', 'usage'],
      [3_000, 'agent', 'call bash'], [4_000, 'agent', 'result ok'], [5_000, 'agent', 'call read'], [6_000, 'agent', 'result failed'],
    ])
    expect(only(events, 'usage')[0]!.tokens).toEqual({ input: 5, output: 5, cacheRead: 7, cacheWrite: 0 })
    expect(r.session()).toMatchObject({ cwd: '/work/app', model: 'm' })
    expect(r.session()).not.toHaveProperty('id')
  })

  it('emits each row once however often it is passed: a call, then its result when it ends', () => {
    const r = reader('opencode')
    const part = (status: string) => r.read({ part: { type: 'tool', callId: 't1', tool: 'bash', status, start: 3_000, end: status === 'running' ? undefined : 4_000 } })
    const reply = (completed?: number) => r.read({ message: { id: 'm2', role: 'assistant', created: 2_000, completed, tokens: { input: 5 } } })
    const events = [
      ...r.read({ message: { id: 'm1', role: 'user', created: 1_000 } }), ...r.read({ message: { id: 'm1', role: 'user', created: 1_000 } }),
      ...reply(), ...part('running'), ...part('running'), ...part('completed'), ...part('completed'), ...reply(9_000), ...reply(9_000),
    ]
    expect(events.map((e) => [e.at, label(e)])).toEqual([[1_000, 'prompt'], [3_000, 'call bash'], [4_000, 'result ok'], [9_000, 'reply'], [9_000, 'usage']])
  })
})

describe('cursor', () => {
  it('reads you (type 1) and the agent, and tokens only when Cursor stored them', () => {
    const r = reader('cursor')
    const events = [
      ...r.read({ createdAt: '2026-01-01T00:00:00Z', type: 1, model: 'default' }),
      ...r.read({ createdAt: '2026-01-01T00:00:30Z', type: 2, inputTokens: 4, outputTokens: 6, model: 'gpt' }),
    ]
    expect(events.map((e) => [e.by, e.k])).toEqual([['you', 'prompt'], ['agent', 'reply'], ['agent', 'usage']])
    expect(r.session().model).toBe('gpt')
  })

  it('emits a bubble once, and its usage once Cursor has stored tokens', () => {
    const r = reader('cursor')
    const bubble = (inputTokens?: number) => r.read({ bubbleId: 'b1', createdAt: '2026-01-01T00:00:30Z', type: 2, inputTokens })
    expect([...bubble(), ...bubble(), ...bubble(4), ...bubble(4)].map((e) => e.k)).toEqual(['reply', 'usage'])
  })
})

describe('zed', () => {
  it('reads each update as a system event, in the first folder', () => {
    const r = reader('zed')
    const events = [
      ...r.read({ updatedAt: '2026-01-01T00:00:00Z', folders: '["/work/app","/work/lib"]' }),
      ...r.read({ updatedAt: '2026-01-01T00:01:00Z', folders: '/other' }),
    ]
    expect(events.map((e) => [e.by, label(e)])).toEqual([['system', 'system thread_updated'], ['system', 'system thread_updated']])
    expect(r.session().cwd).toBe('/work/app')
  })

  it('waits for a real folder when the list is empty', () => {
    const r = reader('zed')
    r.read({ updatedAt: '2026-01-01T00:00:00Z', folders: '[]' })
    expect(r.session().cwd).toBeUndefined()
    r.read({ updatedAt: '2026-01-01T00:01:00Z', folders: '["/work/app"]' })
    expect(r.session().cwd).toBe('/work/app')
  })

  it('skips a thread passed again with no change', () => {
    const r = reader('zed')
    expect([...r.read({ updatedAt: '2026-01-01T00:00:00Z' }), ...r.read({ updatedAt: '2026-01-01T00:00:00Z' })]).toHaveLength(1)
  })
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
    ['rm -rf dist', 'edit', []],
    // review
    ['git status --short && git diff --stat', 'review', []],
    ['git -C repo log --oneline -5', 'review', []],
    // runs
    ['pnpm test 2>&1 | grep FAIL', 'run', []],
    ['git commit -am "fix" && git push', 'run', []],
    // a commit message's lines are part of the message, however they read
    ["git commit -m 'Fix retry\n\nrm -rf dist > out.log'", 'run', []],
    ['git commit -m "Say \\"retry\\" once\n\nCo-Authored-By: A <a@example.com>"', 'run', []],
    // a quote inside a comment isn't one
    ["# don't build yet\ncat src/a.ts", 'read', ['src/a.ts']],
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
