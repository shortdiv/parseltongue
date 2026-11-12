export interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
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

export const addTokens = (a: TokenCounts, b: TokenCounts): TokenCounts => ({
  input: a.input + b.input,
  output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead,
  cacheWrite: a.cacheWrite + b.cacheWrite,
})

export const totalTokens = (t: TokenCounts) => t.input + t.output + t.cacheRead + t.cacheWrite

/** ISO 8601 at any fractional precision, including WebKit-compatible microsecond input. */
export function parseISO(s: unknown): number | undefined {
  if (typeof s !== 'string') return undefined
  const ms = Date.parse(s.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isNaN(ms) ? undefined : ms
}
