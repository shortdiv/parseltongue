import type { Kind } from './kinds.js'

/**
 * The order things happened in a session, without any text. Moments are cut
 * from it by downstream consumers. Full tool arguments and output are not retained.
 */
export type Step =
  | { at: number; k: 'prompt' }
  | { at: number; k: 'interrupt' | 'decline' | 'compact' }
  /**
   * ask: the agent put a question to you. answer: your reply to it.
   * shell: a command you ran yourself (Claude Code's `!`, pi's bash execution).
   */
  | { at: number; k: 'ask' | 'answer'; call: string }
  | { at: number; k: 'shell' }
  | { at: number; k: 'call'; id?: string; tool: string; kind?: Kind; ok?: boolean; test?: true; commit?: true; push?: true; rework?: true; paths?: string[] }

export type CallStep = Extract<Step, { k: 'call' }>

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
