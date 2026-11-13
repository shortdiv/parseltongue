import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { detect, parseSession, reader, type Session, type SessionEvent } from '../src/index.js'

const fixture = (agent: string, name = 'real-sanitized.jsonl') => new URL(`./fixtures/${agent}/${name}`, import.meta.url)
const sample = (agent: string) => readFileSync(fixture(agent), 'utf8')
function label(e: SessionEvent, t0: number): string {
  const head = `+${(e.at - t0) / 1000}s`.padEnd(6)
  if (e.k === 'call') return [head, 'call', e.tool, e.name, e.kind, ...(['test', 'commit', 'push'] as const).filter((f) => e[f]), ...(e.paths ?? [])].join(' ')
  if (e.k === 'result') return [head, 'result', e.status, ...(e.rework ? ['rework'] : [])].join(' ')
  if (e.k === 'system') return [head, 'system', e.what, ...(e.tag ? [e.tag] : [])].join(' ')
  return `${head} ${e.k}`
}

describe('fixtures', () => {
  const files = (agent: string) => readdirSync(new URL(`./fixtures/${agent}/`, import.meta.url)).filter(f => f.endsWith('.jsonl'))
  const snapshot = (agent: string, name: string, session: Session) =>
    [`cwd ${session.cwd}`, ...session.events.map(e => label(e, session.events[0]!.at))].join('\n') + '\n'
  const matches = (agent: string, name: string, session: Session) =>
    expect(snapshot(agent, name, session)).toMatchFileSnapshot(fixture(agent, name.replace(/\.jsonl$/, '.events')).pathname)

  for (const agent of ['claude', 'codex', 'pi'] as const) {
    for (const name of files(agent)) {
      it(`${agent}/${name}: detection, text isolation, streaming and events`, async () => {
        const raw = readFileSync(fixture(agent, name), 'utf8')
        const { text, ...session } = parseSession(raw, { text: true })
        expect(detect(raw)).toEqual({ agent })
        expect(session.agent).toBe(agent)
        expect(session.warnings).toEqual([])
        expect(session.events.some(e => e.k === 'prompt' && e.id in text)).toBe(true)
        expect(parseSession(raw)).toEqual(session)
        const events = JSON.stringify(session.events)
        for (const words of Object.values(text)) if (words.length >= 12) expect(events).not.toContain(words)

        const live = reader(agent, { text: true })
        expect(live.session()).toEqual({ agent, events: [], calls: {}, warnings: [] })
        for (const line of raw.split('\n')) live.read(line)
        expect(live.session()).toEqual(session)
        expect(live.text).toEqual(text)
        await matches(agent, name, session)
      })
    }
  }

  for (const agent of ['opencode', 'cursor'] as const) {
    for (const name of files(agent)) {
      it(`${agent}/${name}: rows read once, however often they're passed, and events`, async () => {
        const rows = readFileSync(fixture(agent, name), 'utf8').trim().split('\n').map(line => JSON.parse(line))
        const r = reader(agent, { id: 'sample' })
        const first = rows.flatMap(row => r.read(row))
        expect(rows.flatMap(row => r.read(row))).toEqual([])
        const session = r.session()
        expect(session.events).toEqual(first)
        expect(session).toMatchObject({ id: 'sample', agent, warnings: [] })
        await matches(agent, name, session)
      })
    }
  }

  it('counts repeated Claude usage once across thinking and tool-use records', () => {
    const usage = parseSession(sample('claude')).events.filter(e => e.k === 'usage')
    expect(usage.map(e => e.tokens)).toEqual([
      { input: 10, output: 181, cacheRead: 0, cacheWrite: 20581 },
    ])
  })

  it('links the Codex code-mode action to its script and reads structured output blocks', () => {
    const session = parseSession(sample('codex'))
    const calls = session.events.filter(e => e.k === 'call')
    expect(calls).toHaveLength(2)
    expect(calls[0]).toMatchObject({ name: 'exec', tool: 'Code' })
    expect(calls[1]).toMatchObject({ name: 'CommandExecution', tool: 'Shell', within: calls[0]!.call })
    expect(session.events.filter(e => e.k === 'usage').map(e => e.tokens)).toEqual([
      { input: 4816, output: 180, cacheRead: 11904, cacheWrite: 0 },
    ])
  })

  it('keeps pi ancestry and correlates read/bash results', () => {
    const r = reader('pi')
    for (const line of sample('pi').split('\n')) r.read(line)
    expect(r.getPath().complete).toBe(true)
    expect(r.getPath().entries).toHaveLength(8)
    expect(r.leafId).toBe(r.getPath().entries.at(-1)?.id)
    expect(r.session().events.filter(e => e.k === 'call').map(e => e.name)).toEqual(['read', 'bash'])
    expect(r.diagnostics).toEqual({ malformedLines: 0, ignoredLines: 0, duplicateEntries: 0, orphanResults: 0 })
  })
})
