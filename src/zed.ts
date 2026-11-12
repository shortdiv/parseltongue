import type { SessionAccumulator } from './accumulator.js'
import { parseISO } from './types.js'

/**
 * Zed's agent threads (threads.db) don't timestamp messages, so the only event is
 * the thread's updated_at changing. The caller reads the row each time it changes.
 */
export interface ZedThread {
  /** updated_at, ISO 8601 */
  updatedAt?: string
  /** folder_paths: a JSON list or newline-separated */
  folders?: string
}

export function ingestZedThread(acc: SessionAccumulator, t: ZedThread) {
  const at = parseISO(t.updatedAt)
  if (at === undefined) return
  if (acc.projectPath === undefined && t.folders) acc.projectPath = firstFolder(t.folders)
  acc.event(at, false)
}

function firstFolder(raw: string): string | undefined {
  if (raw.startsWith('[')) {
    try {
      const list = JSON.parse(raw) as unknown
      if (Array.isArray(list) && typeof list[0] === 'string') return list[0]
    } catch {
      // Fall through to newline-separated.
    }
  }
  return raw.split('\n')[0] || undefined
}
