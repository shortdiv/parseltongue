import type { CallStep } from './timeline.js'

/**
 * What a call did. A shell call gets its kind from its command (shellKind), since
 * `sed -n`, `cat`, `rg` and `git diff` all arrive as the same shell tool; any other
 * call gets it from the tool's name (kindOf).
 */
export type Kind = 'read' | 'search' | 'edit' | 'review' | 'run' | 'web' | 'delegate' | 'plan' | 'mcp' | 'other'

/** Claude Code names tools in PascalCase, Codex in snake_case, pi in lowercase. */
const KINDS: Record<string, Kind> = {
  read: 'read',
  grep: 'search', glob: 'search', find: 'search', ls: 'search',
  edit: 'edit', multiedit: 'edit', write: 'edit', notebookedit: 'edit', apply_patch: 'edit',
  bash: 'run', shell: 'run', exec_command: 'run', run: 'run',
  // Codex code mode: what a script did arrives as items named by type; js is its JavaScript runner.
  commandexecution: 'run', js: 'run', filechange: 'edit', mcptoolcall: 'mcp',
  webfetch: 'web', websearch: 'web', web_search: 'web',
  task: 'delegate', agent: 'delegate', spawn_agent: 'delegate', wait_agent: 'delegate',
  todowrite: 'plan', update_plan: 'plan', exitplanmode: 'plan', enterplanmode: 'plan',
}

export function kindOf(tool: string): Kind {
  // Claude names MCP tools mcp__server__tool; Codex names plugin tools server.tool.
  if (tool.startsWith('mcp__') || tool.includes('.')) return 'mcp'
  return KINDS[tool.toLowerCase()] ?? 'other'
}

/** A step's kind, falling back to its tool's name for steps parsed before kinds existed. */
export const callKind = (s: CallStep): Kind => s.kind ?? kindOf(s.tool)

/** Sets a call's kind and, for a shell call, the files its command read or wrote. */
export function classify(step: CallStep, command?: string) {
  if (command === undefined) {
    step.kind = kindOf(step.tool)
    return
  }
  const { kind, paths } = shellKind(command)
  step.kind = kind
  if (paths.length && !step.paths) step.paths = paths
}

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

const RANK: Kind[] = ['edit', 'run', 'web', 'review', 'read', 'search']

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

interface Part { words: string[]; writes: string[]; piped: boolean; body?: string }

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
    if (sub === 'grep' || sub === 'ls-files') return { kind: 'search', paths: [] }
    return { kind: 'run', paths: [] }
  }
  if (prog === 'apply_patch') return { kind: 'edit', paths: [...(body ?? '').matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map((m) => m[1]!.trim()) }
  if ((prog === 'sed' || prog === 'perl') && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place')) return { kind: 'edit', paths: files(prog, args) }
  if (READ.has(prog)) return { kind: 'read', paths: files(prog, args) }
  if (SEARCH.has(prog)) return { kind: 'search', paths: [] }
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

/** Splits a command into parts, quote-aware, dropping heredoc bodies (kept on the part for apply_patch). */
function split(command: string): Part[] {
  const parts: Part[] = []
  let part: Part = { words: [], writes: [], piped: false }
  let word: string | undefined
  let redirect = false
  let heredoc: string | undefined
  const endWord = () => {
    if (word === undefined) return
    if (redirect) {
      if (word !== '/dev/null') part.writes.push(word)
      redirect = false
    } else part.words.push(word)
    word = undefined
  }
  const endPart = (piped: boolean) => {
    endWord()
    if (part.words.length || part.writes.length) parts.push(part)
    part = { words: [], writes: [], piped }
  }
  const lines = command.split('\n')
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li]!
    for (let i = 0; i < line.length; i++) {
      const c = line[i]!
      const rest = line.slice(i)
      if (c === "'" || c === '"') {
        const close = line.indexOf(c, i + 1)
        const end = close < 0 ? line.length : close
        word = (word ?? '') + line.slice(i + 1, end)
        i = end
      } else if (c === '\\') word = (word ?? '') + (line[++i] ?? '')
      else if (/^<<-?\s*(['"]?)(\w+)\1/.test(rest)) {
        const m = /^<<-?\s*(['"]?)(\w+)\1/.exec(rest)!
        endWord()
        heredoc = m[2]
        i += m[0].length - 1
      } else if (/^\d?>>?(?!&)/.test(rest)) {
        endWord()
        redirect = true
        i += /^\d?>>?/.exec(rest)![0].length - 1
      } else if (/^(\d|&)?>&\d/.test(rest)) {
        endWord()
        i += /^(\d|&)?>&\d/.exec(rest)![0].length - 1
      } else if (rest.startsWith('&&') || rest.startsWith('||')) {
        endPart(false)
        i++
      } else if (c === ';' || c === '&') endPart(false)
      else if (c === '|') endPart(true)
      else if (c === '<') endWord()
      else if (/\s/.test(c)) endWord()
      else word = (word ?? '') + c
    }
    if (heredoc) {
      const body: string[] = []
      while (++li < lines.length && lines[li]!.trim() !== heredoc) body.push(lines[li]!)
      part.body = body.join('\n')
      heredoc = undefined
    }
    endPart(false)
  }
  return parts
}

const unquote = (s: string) => (/^(['"])[\s\S]*\1$/.test(s) ? s.slice(1, -1) : s)
