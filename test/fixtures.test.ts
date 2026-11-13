import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { detect, parseSession, reader, type Session, type SessionEvent } from '../src/index.js'

const fixture = (agent: string, name = 'real-sanitized.jsonl') => new URL(`./fixtures/${agent}/${name}`, import.meta.url)
/** One line per event: what it is, and enough detail to see a change in tokens or which script ran a call. */
function label(e: SessionEvent, t0: number, names: Map<string, string>): string {
  const head = `+${(e.at - t0) / 1000}s`.padEnd(6)
  if (e.k === 'call') {
    const within = e.within ? ['within', names.get(e.within) ?? e.within] : []
    return [head, 'call', e.tool, e.name, e.kind, ...(['test', 'commit', 'push'] as const).filter((f) => e[f]), ...(e.paths ?? []), ...within].join(' ')
  }
  if (e.k === 'usage') return [head, 'usage', `in ${e.tokens.input}`, `out ${e.tokens.output}`, `cache read ${e.tokens.cacheRead}`, `write ${e.tokens.cacheWrite}`].join(' ')
  if (e.k === 'result') return [head, 'result', e.status, ...(e.rework ? ['rework'] : [])].join(' ')
  if (e.k === 'system') return [head, 'system', e.what, ...(e.tag ? [e.tag] : [])].join(' ')
  return `${head} ${e.k}`
}

describe('fixtures', () => {
  const files = (agent: string) => readdirSync(new URL(`./fixtures/${agent}/`, import.meta.url)).filter(f => f.endsWith('.jsonl'))
  const snapshot = (agent: string, name: string, session: Session) => {
    const names = new Map(session.events.flatMap(e => (e.k === 'call' ? [[e.call, e.name] as const] : [])))
    return [`cwd ${session.cwd}`, ...session.events.map(e => label(e, session.events[0]!.at, names))].join('\n') + '\n'
  }
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
})
