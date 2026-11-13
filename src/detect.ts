import type { LogHarness } from './events.js'

type Json = Record<string, unknown>
const object = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})

const CODEX_ITEMS = ['message', 'function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'reasoning']

/**
 * The harnesses whose signatures appear in a log's first 250 lines, from their content,
 * never filenames or model names. None means unknown; more than one means ambiguous.
 * Only logs are detected: database rows come from a database you already know.
 */
export function detect(raw: string): LogHarness[] {
  const found = new Set<LogHarness>()
  let read = 0
  for (const line of raw.replace(/^﻿/, '').split('\n')) {
    if (read === 250) break
    if (!line.trim()) continue
    read++
    let l: Json
    try {
      l = object(JSON.parse(line))
    } catch {
      continue
    }
    const m = object(l.message)
    if (l.type === 'session' && typeof l.id === 'string' && (typeof l.version === 'number' || typeof l.cwd === 'string')) found.add('pi')
    if (l.type === 'session_meta' && typeof l.payload === 'object') found.add('codex')
    if (l.type === 'response_item' && CODEX_ITEMS.includes(String(object(l.payload).type))) found.add('codex')
    if (['user', 'assistant'].includes(String(l.type)) && typeof l.timestamp === 'string' && 'content' in m && !('parts' in m)) found.add('claude')
  }
  return [...found]
}
