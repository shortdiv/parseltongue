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

/** What one edit replaced and wrote in a file. */
export interface Edit {
  file: string
  old?: string
  next?: string
}

/** Whether a successful call's edits rework the agent's own lines; then remembers what they wrote. */
export function reworks(tracker: ReworkTracker, edits: Edit[]): true | undefined {
  let rework = false
  for (const { file, old, next } of edits) {
    if (old && tracker.isRework(old, file)) rework = true
    if (next) tracker.wrote(next, file)
  }
  return rework || undefined
}
