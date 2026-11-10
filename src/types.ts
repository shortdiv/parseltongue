/** Gaps longer than this between events count as idle and aren't tracked. */
export const IDLE_THRESHOLD_MS = 5 * 60 * 1000

export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** Time and tokens attributed to one local calendar day. */
export interface DayStats {
  humanMs: number
  agentMs: number
  tokens: TokenCounts
}

/** Observed events and heuristics, not a score or a judgment of session quality. */
export interface Signals {
  prompts: number
  interrupts: number
  rejections: number
  toolCalls: number
  failedCalls: number
  rework: number
  compactions: number
}

export const emptyTokens = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
export const emptyDay = (): DayStats => ({ humanMs: 0, agentMs: 0, tokens: emptyTokens() })

export const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

export const totalTokens = (t: TokenCounts) => t.input + t.output + t.cacheRead + t.cacheWrite
export const activeMs = (d: DayStats) => d.humanMs + d.agentMs

/** Local calendar day, e.g. "2026-10-21". */
export function dayKey(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** ISO 8601 at any fractional precision, including WebKit-compatible microsecond input. */
export function parseISO(s: unknown): number | undefined {
  if (typeof s !== 'string') return undefined
  const ms = Date.parse(s.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isNaN(ms) ? undefined : ms
}
