/**
 * What a call did. discover is finding things out without reading a known file:
 * searching, listing, planning, looking up tools and skills. A shell call gets its kind from its command (shellKind), since
 * `sed -n`, `cat`, `rg` and `git diff` all arrive as the same shell tool; any other
 * call gets it from the tool's name (kindOf).
 */
export type Kind = 'read' | 'discover' | 'edit' | 'review' | 'run' | 'web' | 'delegate' | 'mcp' | 'other'

/**
 * The tool a call used, in one vocabulary across harnesses. A call's kind says what it
 * did; its tool says how: a Shell call that runs `rg` is discover, one that runs `cat` is read.
 */
export type Tool =
  | 'Shell' | 'Process' | 'Code' | 'Read' | 'Write' | 'Edit' | 'Patch' | 'Search' | 'Glob' | 'List'
  | 'WebFetch' | 'WebSearch' | 'Todo' | 'Plan' | 'Skill' | 'Task' | 'Question' | 'Mcp' | 'Other'

/** Claude Code names tools in PascalCase, Codex in snake_case, pi in lowercase. */
const TOOLS: Record<string, Tool> = {
  bash: 'Shell', shell: 'Shell', exec_command: 'Shell', run: 'Shell', commandexecution: 'Shell',
  write_stdin: 'Process', taskoutput: 'Process', bashoutput: 'Process', killshell: 'Process',
  // Codex code mode: exec runs a script, js is its JavaScript runner.
  exec: 'Code', js: 'Code', js_reset: 'Code',
  read: 'Read', imageview: 'Read', view_image: 'Read',
  write: 'Write',
  edit: 'Edit', multiedit: 'Edit', notebookedit: 'Edit',
  apply_patch: 'Patch', filechange: 'Patch',
  grep: 'Search',
  glob: 'Glob', find: 'Glob',
  ls: 'List',
  webfetch: 'WebFetch', websearch: 'WebSearch', web_search: 'WebSearch',
  todowrite: 'Todo', update_plan: 'Todo',
  exitplanmode: 'Plan', enterplanmode: 'Plan', get_goal: 'Plan',
  skill: 'Skill', toolsearch: 'Skill', tool_search: 'Skill',
  task: 'Task', agent: 'Task', spawn_agent: 'Task', wait_agent: 'Task', send_message: 'Task',
  followup_task: 'Task', list_agents: 'Task', taskstop: 'Task',
  askuserquestion: 'Question', request_user_input: 'Question', resolve_open_questions: 'Question',
  mcp: 'Mcp', mcptoolcall: 'Mcp', list_mcp_resources: 'Mcp', list_mcp_resource_templates: 'Mcp',
}

/** A tool's kind when the call itself says no more; a Shell call's kind comes from its command. */
const KINDS: Record<Tool, Kind> = {
  Shell: 'run', Process: 'run', Code: 'run',
  Read: 'read',
  Write: 'edit', Edit: 'edit', Patch: 'edit',
  Search: 'discover', Glob: 'discover', List: 'discover', Todo: 'discover', Plan: 'discover', Skill: 'discover',
  WebFetch: 'web', WebSearch: 'web',
  Task: 'delegate',
  Mcp: 'mcp',
  Question: 'other', Other: 'other',
}

export function toolOf(name: string): Tool {
  // Claude names MCP tools mcp__server__tool; Codex names plugin tools server.tool.
  if (name.startsWith('mcp__') || name.includes('.')) return 'Mcp'
  return TOOLS[name.toLowerCase()] ?? 'Other'
}

export const kindOf = (name: string): Kind => KINDS[toolOf(name)]

export interface ShellWork { kind: Kind; paths: string[] }

/**
 * What a shell command did, from its programs: `cd app && sed -n '1,80p' src/a.ts`
 * reads src/a.ts. Each part, split on `&&`, `||`, `;` and newlines, is judged by its
 * first program; a part after a pipe only filters what came before, unless it writes.
 * When parts differ, the strongest kind wins (RANK), and its parts give the paths.
 */
export function shellKind(command: string): ShellWork {
  const inner = SHELL_C.exec(command)
  if (inner) return shellKind(unquote(inner[1]!.trim()))
  const parts = split(command).map(judge).filter((p): p is ShellWork => p !== undefined)
  const kind = RANK.find((k) => parts.some((p) => p.kind === k)) ?? 'run'
  return { kind, paths: [...new Set(parts.filter((p) => p.kind === kind).flatMap((p) => p.paths))] }
}

const RANK: Kind[] = ['edit', 'run', 'web', 'review', 'read', 'discover']

/** `bash -lc '…'`, `/bin/zsh -lc …`: Codex wraps commands like this. */
const SHELL_C = /^\s*(?:\S*\/)?(?:ba|z|fi)?sh\s+-l?c\s+([\s\S]*)$/

const READ = new Set('cat nl head tail less more bat wc sed awk jq stat file diff cmp'.split(' '))
const SEARCH = new Set('rg grep egrep fgrep ag find fd ls tree'.split(' '))
const WRITE = new Set('tee touch mkdir rm rmdir mv cp ln chmod'.split(' '))
const WEB = new Set(['curl', 'wget'])
/** Parts that do nothing on their own. */
const NOISE = new Set('cd pushd popd echo printf true false set export source . : sleep pwd which'.split(' '))
const PREFIXES = new Set('sudo env time timeout nice command'.split(' '))
/** Programs whose first argument is a script or a pattern, not a file. */
const SCRIPT_FIRST = new Set('sed awk jq rg grep egrep fgrep ag'.split(' '))
const GIT_REVIEW = new Set('status diff show log blame'.split(' '))

/** words: every word, quoted or not. plain: the unquoted ones, which are code rather than data. */
interface Part { words: string[]; plain: string[]; writes: string[]; piped: boolean; body?: string }

function judge({ words, writes, piped, body }: Part): ShellWork | undefined {
  const w = [...words]
  while (w.length && (/^\w+=/.test(w[0]!) || PREFIXES.has(w[0]!))) w.shift()
  const prog = w[0]?.split('/').pop()
  const args = w.slice(1)
  if (writes.length) return { kind: 'edit', paths: writes }
  if (!prog || NOISE.has(prog)) return undefined
  if (piped && !WRITE.has(prog)) return undefined
  if (prog === 'git') {
    const sub = args.find((a, i) => !a.startsWith('-') && args[i - 1] !== '-C')
    if (sub && GIT_REVIEW.has(sub)) return { kind: 'review', paths: [] }
    if (sub === 'grep' || sub === 'ls-files') return { kind: 'discover', paths: [] }
    return { kind: 'run', paths: [] }
  }
  if (prog === 'apply_patch') return { kind: 'edit', paths: [...(body ?? '').matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim()) }
  if ((prog === 'sed' || prog === 'perl') && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place')) return { kind: 'edit', paths: files(prog, args) }
  if (READ.has(prog)) return { kind: 'read', paths: files(prog, args) }
  if (SEARCH.has(prog)) return { kind: 'discover', paths: [] }
  if (WRITE.has(prog)) return { kind: 'edit', paths: files(prog, args) }
  if (WEB.has(prog)) return { kind: 'web', paths: [] }
  return { kind: 'run', paths: [] }
}

/** The arguments that look like files: past the flags, the script, and any numbers. */
function files(prog: string, args: string[]): string[] {
  let script = SCRIPT_FIRST.has(prog)
  const out: string[] = []
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '-e' || a === '-f') {
      script = false
      i++
    } else if (a.startsWith('-') || a === '') continue
    else if (script) script = false
    else if (/\//.test(a) || /\.[A-Za-z0-9]{1,8}$/.test(a)) out.push(a)
  }
  return out
}

/** Splits a command into parts, quote-aware across lines, dropping heredoc bodies (kept on the part for apply_patch). */
function split(command: string): Part[] {
  const parts: Part[] = []
  let part: Part = { words: [], plain: [], writes: [], piped: false }
  let word: string | undefined
  let quoted = false
  let redirect = false
  let heredoc: string | undefined
  const endWord = () => {
    if (word === undefined) return
    if (redirect) {
      if (word !== '/dev/null') part.writes.push(word)
      redirect = false
    } else {
      part.words.push(word)
      if (!quoted) part.plain.push(word)
    }
    word = undefined
    quoted = false
  }
  const endPart = (piped: boolean) => {
    endWord()
    if (part.words.length || part.writes.length) parts.push(part)
    part = { words: [], plain: [], writes: [], piped }
  }
  const at = (re: RegExp, i: number) => {
    re.lastIndex = i
    return re.exec(command)
  }
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!
    let m: RegExpExecArray | null
    if (c === "'" || c === '"') {
      // A quoted string can run over several lines, like a commit message. Inside
      // double quotes, a backslash escapes the next character, \" included.
      let end = i + 1
      while (end < command.length && command[end] !== c) end += c === '"' && command[end] === '\\' ? 2 : 1
      end = Math.min(end, command.length)
      word = (word ?? '') + command.slice(i + 1, end)
      quoted = true
      i = end
    } else if (c === '\\') word = (word ?? '') + (command[++i] ?? '')
    else if (c === '#' && word === undefined) {
      // A comment runs to the end of the line; a quote inside it isn't one.
      const eol = command.indexOf('\n', i)
      i = (eol < 0 ? command.length : eol) - 1
    } else if ((m = at(HEREDOC, i))) {
      endWord()
      heredoc = m[2]
      i += m[0].length - 1
    } else if ((m = at(REDIRECT, i))) {
      endWord()
      redirect = true
      i += m[0].length - 1
    } else if ((m = at(DUP, i))) {
      endWord()
      i += m[0].length - 1
    } else if (command.startsWith('&&', i) || command.startsWith('||', i)) {
      endPart(false)
      i++
    } else if (c === '\n') {
      if (heredoc) {
        // The body runs to the line that is just the delimiter.
        const body: string[] = []
        let next = i + 1
        while (next < command.length) {
          const eol = command.indexOf('\n', next)
          const line = command.slice(next, eol < 0 ? command.length : eol)
          next = eol < 0 ? command.length : eol + 1
          if (line.trim() === heredoc) break
          body.push(line)
        }
        part.body = body.join('\n')
        heredoc = undefined
        i = next - 1
      }
      endPart(false)
    } else if (c === ';' || c === '&') endPart(false)
    else if (c === '|') endPart(true)
    else if (c === '<') endWord()
    else if (/\s/.test(c)) endWord()
    else word = (word ?? '') + c
  }
  endPart(false)
  return parts
}

const HEREDOC = /<<-?\s*(['"]?)(\w+)\1/y
const REDIRECT = /\d?>>?(?!&)/y
const DUP = /(\d|&)?>&\d/y

/**
 * The parts of a command as the shell would run them, each as its unquoted words:
 * quoted text (a commit message) and heredoc bodies are data, not commands.
 */
export function commandParts(command: string): string[] {
  const inner = SHELL_C.exec(command)
  if (inner) return commandParts(unquote(inner[1]!.trim()))
  return split(command).map((p) => p.plain.join(' '))
}

const unquote = (s: string) => (/^(['"])[\s\S]*\1$/.test(s) ? s.slice(1, -1) : s)
