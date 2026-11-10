import type { Kind } from './kinds.js'

/**
 * The order things happened in a session, without any text. Moments are cut
 * from it by downstream consumers. Full tool arguments and output are not retained.
 */
export type Step =
  | { at: number; k: 'prompt'; tone?: Tone }
  | { at: number; k: 'interrupt' | 'decline' | 'compact' }
  | { at: number; k: 'call'; tool: string; kind?: Kind; ok?: boolean; test?: true; commit?: true; push?: true; rework?: true; paths?: string[] }

export type CallStep = Extract<Step, { k: 'call' }>

/** Your prompt reads as pleased ("thanks, works") or frustrated ("still broken", swearing). */
export type Tone = 'positive' | 'negative'

const NEGATIVE =
  /\b(fuck\w*|shit\w*|wtf|damn\w*|ugh+|useless|give up|forget it|never ?mind|still (not|broken|failing|wrong|doesn'?t)|(doesn'?t|does not|isn'?t|not) work(ing)?|that'?s wrong|you broke)\b/i
const POSITIVE =
  /\b(thanks?|thank you|thx|ty|perfect|great|awesome|amazing|excellent|nice|lgtm|looks good|works( now)?|that worked)\b/i

/** Frustration wins over politeness: "thanks but it still doesn't work" is negative. */
export function tone(text: string): Tone | undefined {
  if (NEGATIVE.test(text)) return 'negative'
  if (POSITIVE.test(text)) return 'positive'
  return undefined
}

const TEST =
  /\b(pytest|vitest|jest|mocha|rspec|phpunit|tox|unittest|go test|cargo (test|nextest)|swift test|dotnet test|mvn( \S+)* test|gradlew? test|(npm|pnpm|yarn|bun)( run)? test\S*|make (test|check))\b/
const COMMIT = /\bgit\s+(-C\s+\S+\s+)?commit\b/
const PUSH = /\bgit\s+(-C\s+\S+\s+)?push\b/

export const isTestCommand = (cmd: string) => TEST.test(cmd)
export const isCommitCommand = (cmd: string) => COMMIT.test(cmd)
export const isPushCommand = (cmd: string) => PUSH.test(cmd)
