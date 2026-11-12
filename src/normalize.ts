import type { PiEntry } from './pi.js'
import { readSession, type Harness } from './session.js'
import type { Step } from './timeline.js'

export const agentName = (agent: Harness | 'unknown') => ({ claude: 'Claude Code', codex: 'Codex', pi: 'Pi', unknown: 'Unknown' })[agent]

export interface Turn {
  at: number
  who: 'you' | 'agent'
  text: string
}

/**
 * The older whole-session shape that training and rating tools read: steps, plus
 * turns with text. Built from the same reader as parseSession.
 */
export interface NormalizedSession {
  id: string
  file: string
  agent: Harness | 'unknown'
  project: string
  /** The folder the session ran in, for reading its git history. */
  cwd?: string
  steps: Step[]
  turns: Turn[]
  parentSession?: string
  entryTree?: PiEntry[]
  warnings?: string[]
}

const basename = (path: string) => path.replace(/\/$/, '').split('/').pop() || path

/** Detects the harness from the log's content, as parseSession does; `file` only names the session. */
export function normalizeSession(raw: string, file = ''): NormalizedSession {
  const { session, text, acc, pi } = readSession(raw)
  const turns: Turn[] = []
  for (const e of session.events) {
    const words = text.get(e.id)
    if (e.k === 'prompt') turns.push({ at: e.at, who: 'you', text: words ?? '[non-text prompt]' })
    else if (e.k === 'reply' && words) turns.push({ at: e.at, who: 'agent', text: words })
  }
  return {
    // Preserve existing IDs so saved judgments still resolve.
    id: `${session.agent}:${pi?.metadata.id ?? basename(file).replace(/\.jsonl$/, '')}`,
    file,
    agent: session.agent,
    project: session.cwd ? basename(session.cwd) : '?',
    cwd: session.cwd,
    steps: acc.timeline,
    turns,
    parentSession: pi?.metadata.parentSession,
    entryTree: pi && [...pi.entries.values()],
    warnings: session.warnings.length ? session.warnings : undefined,
  }
}
