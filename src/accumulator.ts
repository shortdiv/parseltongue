import { emptySignals, ReworkTracker } from './signals.js'
import type { CallStep, Step } from './timeline.js'
import { emptyTokens, type Signals, type TokenCounts } from './types.js'

/**
 * A log event at `at`: something you typed (a prompt), or anything else (the
 * agent's output, tool calls and results). How events become time is up to the consumer.
 */
export interface Activity {
  at: number
  by: 'you' | 'agent'
}

/** Tokens one model response used, as logged. */
export interface Usage {
  at: number
  tokens: TokenCounts
}

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
  /** Every event, in log order. */
  activity: Activity[] = []
  /** Every token report, in log order. */
  usage: Usage[] = []
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
  /** Questions waiting for your answer, by tool-use id. */
  asks = new Set<string>()
  /** Tool calls waiting for their result, by tool-use id. */
  pendingCalls = new Map<string, CallStep>()
  /** Calls you declined, and calls cut short by an interrupt: neither succeeded nor failed. */
  declined = new WeakSet<CallStep>()
  interrupted = new WeakSet<CallStep>()
  /** Calls whose outcome is known; the first outcome wins. */
  settledCalls = new WeakSet<CallStep>()
  /** Codex: commands still running, by session ID, and polls of them by call id. */
  processes = new Map<string, CallStep>()
  polls = new Map<string, string>()
  /** Codex: the log records each response's usage, so token_count totals aren't needed. */
  usageRecords = false

  /** Records an event: `you` when it's something you typed. */
  event(at: number, you: boolean) {
    this.activity.push({ at, by: you ? 'you' : 'agent' })
    if (this.firstEvent === undefined || at < this.firstEvent) this.firstEvent = at
    if (this.lastEvent === undefined || at > this.lastEvent) this.lastEvent = at
  }

  addTokens(tokens: TokenCounts, at: number) {
    this.usage.push({ at, tokens })
  }
}
