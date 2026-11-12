import type { TokenCounts } from './types.js'

export const emptyTokens = (): TokenCounts => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })

/** ISO 8601 at any fractional precision, including WebKit-compatible microsecond input. */
export function parseISO(s: unknown): number | undefined {
  if (typeof s !== 'string') return undefined
  const ms = Date.parse(s.replace(/(\.\d{3})\d+/, '$1'))
  return Number.isNaN(ms) ? undefined : ms
}
