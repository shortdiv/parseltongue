import { describe, expect, it } from 'vitest'
import { SessionAccumulator } from '../src/accumulator.js'
import { ingestClaudeLine } from '../src/claude.js'
import { ingestCodexLine } from '../src/codex.js'
import { isCommitCommand, isPushCommand, isTestCommand, tone, type CallStep } from '../src/timeline.js'

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

/** What the parser read: counts, plus the tests, commits and tones in its timeline. */
function read(acc: SessionAccumulator) {
  const calls = acc.timeline.filter((s): s is CallStep => s.k === 'call')
  const tests = calls.filter((c) => c.test)
  const tones = acc.timeline.flatMap((s) => (s.k === 'prompt' ? [s.tone] : []))
  return {
    ...acc.signals,
    tests: tests.length,
    lastTestOk: tests.at(-1)?.ok,
    commits: calls.filter((c) => c.commit && c.ok !== false).length,
    lastTone: tones.at(-1),
    lastCallOk: calls.at(-1)?.ok,
    last: acc.timeline.at(-1)?.k,
    declined: acc.timeline.some((s) => s.k === 'decline'),
  }
}

/** The files each call touched, in order. */
const paths = (acc: SessionAccumulator) =>
  acc.timeline.flatMap((s) => (s.k === 'call' && s.paths ? [s.paths] : []))

describe('claude code', () => {
  it('reads a session that ends well', () => {
    const s = read(
      run([
        prompt('add a retry to the fetch'),
        call('a', 'Bash', { command: 'pnpm test' }),
        result('a', true, 'FAIL'),
        call('b', 'Edit', { file_path: 'x.ts', old_string: 'a', new_string: 'b' }),
        result('b'),
        call('c', 'Bash', { command: 'pnpm test' }),
        result('c'),
        call('d', 'Bash', { command: 'git add . && git commit -m "retry"' }),
        result('d'),
        prompt('perfect, thanks'),
      ]),
    )
    expect(s).toMatchObject({ prompts: 2, toolCalls: 4, failedCalls: 1, tests: 2, lastTestOk: true, commits: 1, lastTone: 'positive', lastCallOk: true })
  })

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
    expect(s).toMatchObject({ tests: 1, lastTestOk: false, lastTone: 'negative', rejections: 1, interrupts: 0, lastCallOk: undefined })
    expect(s.declined).toBe(true)
  })

  it('records the file each read and edit touched', () => {
    const acc = run([
      call('a', 'Read', { file_path: 'x.ts' }),
      call('b', 'Edit', { file_path: 'x.ts', old_string: 'a', new_string: 'b' }),
      call('c', 'NotebookEdit', { notebook_path: 'n.ipynb' }),
      call('d', 'Grep', { pattern: 'x', path: 'src' }),
    ])
    expect(paths(acc)).toEqual([['x.ts'], ['x.ts'], ['n.ipynb']])
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
    expect(read(acc)).toMatchObject({ prompts: 2, toolCalls: 4, failedCalls: 1, tests: 2, lastTestOk: true, commits: 1, lastTone: 'positive', lastCallOk: true })
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

  it('reads tone, frustration first', () => {
    expect(tone('thanks!')).toBe('positive')
    expect(tone('thanks but it still doesnt work')).toBe('negative')
    expect(tone('add a button')).toBeUndefined()
  })
})
