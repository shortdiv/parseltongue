import { kindOf, shellKind, toolOf } from './kinds.js'
import type { Draft } from './events.js'

const TEST =
  /\b(pytest|vitest|jest|mocha|rspec|phpunit|tox|unittest|go test|cargo (test|nextest)|swift test|dotnet test|mvn( \S+)* test|gradlew? test|(npm|pnpm|yarn|bun)( run)? test\S*|make (test|check))\b/
const COMMIT = /\bgit\s+(-C\s+\S+\s+)?commit\b/
const PUSH = /\bgit\s+(-C\s+\S+\s+)?push\b/

/** Tools that put a question to you rather than do work. */
const ASK = new Set(['AskUserQuestion', 'request_user_input', 'resolve_open_questions'])
export const isAskTool = (tool: string) => ASK.has(tool)

export const isTestCommand = (cmd: string) => TEST.test(cmd)
export const isCommitCommand = (cmd: string) => COMMIT.test(cmd)
export const isPushCommand = (cmd: string) => PUSH.test(cmd)

/**
 * A call event: what it did (from its command, for a shell tool), the files it
 * touched, and whether it ran tests, committed or pushed. `paths` the call names
 * itself win over the ones read from its command.
 */
export function callDraft(at: number, call: string, name: string, command?: string, paths?: string[]): Draft {
  const shell = command !== undefined && toolOf(name) === 'Shell' ? shellKind(command) : undefined
  const touched = paths?.length ? paths : shell?.paths.length ? shell.paths : undefined
  return {
    at, by: 'agent', k: 'call', call, tool: toolOf(name), name, kind: shell?.kind ?? kindOf(name),
    test: command !== undefined && isTestCommand(command) ? true : undefined,
    commit: command !== undefined && isCommitCommand(command) ? true : undefined,
    push: command !== undefined && isPushCommand(command) ? true : undefined,
    paths: touched,
  }
}
