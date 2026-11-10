import { emptySignals, ReworkTracker } from './signals.js'
import type { CallStep, Step } from './timeline.js'
import {
  addTokens,
  dayKey,
  emptyDay,
  emptyTokens,
  IDLE_THRESHOLD_MS,
  type DayStats,
  type Signals,
  type TokenCounts,
} from './types.js'

/** Everything known about one session so far. Fed one event at a time. */
export class SessionAccumulator {
  projectPath?: string
  branch?: string
  model?: string
  /** Harness version the log was written by, e.g. "2.1.311". */
  version?: string
  /** Codex: whether any turn could ask you to approve a call (approval_policy other than "never"). */
  asksApproval?: boolean
  firstEvent?: number
  lastEvent?: number
  days = new Map<string, DayStats>()
  signals: Signals = emptySignals()
  /** What happened, in order, no text. */
  timeline: Step[] = []

  // Parser bookkeeping
  seenMessageIds = new Set<string>()
  seenToolIds = new Set<string>()
  lastCumulative: TokenCounts = emptyTokens()
  rework = new ReworkTracker()
  /** Claude logs an interrupt line right after a declined tool call; it's part of the decline. */
  afterDecline = false
  /** Tool calls waiting for their result, by tool-use id. */
  pendingCalls = new Map<string, CallStep>()
  /** Calls whose outcome is known; the first outcome wins. */
  settledCalls = new WeakSet<CallStep>()
  /** Codex: commands still running, by session ID, and polls of them by call id. */
  processes = new Map<string, CallStep>()
  polls = new Map<string, string>()
  /** Codex code mode: scripts the model ran, and commands they ran that the log shows. */
  codeCells = 0
  innerCommands = 0

  private day(key: string): DayStats {
    let d = this.days.get(key)
    if (!d) this.days.set(key, (d = emptyDay()))
    return d
  }

  /**
   * Gap since the previous event: idle if long, otherwise yours if it ends
   * in a prompt you typed, else the agent's.
   */
  event(at: number, human: boolean) {
    if (this.lastEvent !== undefined) {
      const gap = at - this.lastEvent
      if (gap > 0 && gap <= IDLE_THRESHOLD_MS) {
        const d = this.day(dayKey(at))
        if (human) d.humanMs += gap
        else d.agentMs += gap
      }
    }
    if (this.firstEvent === undefined || at < this.firstEvent) this.firstEvent = at
    if (this.lastEvent === undefined || at > this.lastEvent) this.lastEvent = at
  }

  addTokens(t: TokenCounts, at: number) {
    const d = this.day(dayKey(at))
    d.tokens = addTokens(d.tokens, t)
  }
}
