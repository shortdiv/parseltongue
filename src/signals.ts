import type { Signals } from './types.js'

export const emptySignals = (): Signals => ({
  prompts: 0,
  interrupts: 0,
  rejections: 0,
  toolCalls: 0,
  failedCalls: 0,
  rework: 0,
  compactions: 0,
})

export function addSignals(a: Signals, b: Signals): Signals {
  const out = emptySignals()
  for (const k of Object.keys(out) as (keyof Signals)[]) out[k] = a[k] + b[k]
  return out
}

/**
 * In-session thrash check: remembers lines the agent wrote per file, and flags an
 * edit as rework when most of what it replaces is the agent's own earlier output.
 */
export class ReworkTracker {
  private written = new Map<string, Set<string>>()

  /** Lines short enough to be boilerplate (braces, blank, `}` etc.) don't count. */
  private static lines(text: string): string[] {
    return text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length >= 8)
  }

  wrote(text: string, file: string) {
    const set = this.written.get(file) ?? new Set<string>()
    for (const l of ReworkTracker.lines(text)) set.add(l)
    this.written.set(file, set)
  }

  /** Call before `wrote` for the same edit. */
  isRework(old: string, file: string): boolean {
    const lines = ReworkTracker.lines(old)
    const mine = this.written.get(file)
    if (!lines.length || !mine) return false
    return lines.filter((l) => mine.has(l)).length / lines.length >= 0.5
  }
}
