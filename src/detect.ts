/** Every format Parseltongue can recognise. parseSession reads the first three; the viewer reads all of them. */
export const FORMATS = ['claude', 'codex', 'pi', 'gemini', 'qwen'] as const
export type Format = (typeof FORMATS)[number]

type Json = Record<string, unknown>
const object = (value: unknown): Json => (value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})

const CODEX_ITEMS = ['message', 'function_call', 'custom_tool_call', 'function_call_output', 'custom_tool_call_output', 'reasoning']

/**
 * The formats whose signatures appear in a log's first 250 records, from their content,
 * never filenames or model names. None means unknown; more than one means ambiguous.
 */
export function detectFormats(records: unknown[]): Format[] {
  const found = new Set<Format>()
  for (const record of records.slice(0, 250)) {
    const l = object(record)
    const m = object(l.message)
    if (l.type === 'session' && typeof l.id === 'string' && (typeof l.version === 'number' || typeof l.cwd === 'string')) found.add('pi')
    if (l.type === 'session_meta' && typeof l.payload === 'object') found.add('codex')
    if (l.type === 'response_item' && CODEX_ITEMS.includes(String(object(l.payload).type))) found.add('codex')
    if (typeof l.sessionId === 'string' && typeof l.projectHash === 'string') found.add('gemini')
    if (l.type === 'gemini' && typeof l.id === 'string' && ('content' in l || 'toolCalls' in l)) found.add('gemini')
    if (typeof l.uuid === 'string' && typeof l.sessionId === 'string' && (Array.isArray(m.parts) || 'toolCallResult' in l)) found.add('qwen')
    if (['user', 'assistant'].includes(String(l.type)) && typeof l.timestamp === 'string' && 'content' in m && !('parts' in m)) found.add('claude')
  }
  return [...found]
}

/** detectFormats for a raw log: one JSON document (older Gemini exports) or JSON lines. */
export function detect(raw: string): Format[] {
  raw = raw.replace(/^﻿/, '')
  try {
    return detectFormats([JSON.parse(raw)])
  } catch {}
  const records: unknown[] = []
  for (const line of raw.split('\n')) {
    if (records.length === 250) break
    if (!line.trim()) continue
    try {
      records.push(JSON.parse(line))
    } catch {
      records.push(undefined)
    }
  }
  return detectFormats(records)
}
