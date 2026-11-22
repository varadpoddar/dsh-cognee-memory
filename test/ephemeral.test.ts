import { describe, expect, it } from 'vitest'
import { EphemeralSessionMemory } from '../src/memory/ephemeral.js'
import { makeScopeRef } from '../src/memory/scopes.js'
import type { Provenance } from '../src/types.js'

const provenance: Provenance = {
  kind: 'session_event',
  source: 'test',
  recordedAt: '2026-01-01T00:00:00.000Z',
  sessionId: 's1',
  turn: 1,
}
const sessionScope = makeScopeRef('session', 's1')

describe('ephemeral session memory', () => {
  it('stores and recalls only inside the same session', () => {
    const memory = new EphemeralSessionMemory(() => new Date('2026-01-01T00:00:00Z'))
    memory.remember({ text: 'the codename is blue fox', scope: sessionScope, provenance })
    const hits = memory.recall({ text: 'codename', scopes: [sessionScope], limit: 5 })
    expect(hits.map((hit) => hit.record.text)).toEqual(['the codename is blue fox'])
    expect(hits[0]?.record.id).toMatch(/^eph-/)
  })

  it('is lost on a new process-like instance', () => {
    const first = new EphemeralSessionMemory()
    first.remember({ text: 'ephemeral fact', scope: sessionScope, provenance })
    expect(first.size).toBe(1)
    expect(new EphemeralSessionMemory().size).toBe(0)
  })

  it('rejects durable scopes by construction', () => {
    const memory = new EphemeralSessionMemory()
    expect(() =>
      memory.remember({
        text: 'not session',
        scope: makeScopeRef('project', 'e2e'),
        provenance,
      }),
    ).toThrow(/session scope/)
  })

  it('deduplicates identical session text', () => {
    const memory = new EphemeralSessionMemory()
    const first = memory.remember({ text: 'same', scope: sessionScope, provenance })
    const second = memory.remember({ text: 'same', scope: sessionScope, provenance })
    expect(second.deduplicated).toBe(true)
    expect(second.id).toBe(first.id)
  })

  it('forgets by id and by text', () => {
    const memory = new EphemeralSessionMemory()
    const stored = memory.remember({ text: 'forget me please', scope: sessionScope, provenance })
    expect(memory.forget('s1', { id: stored.id, scope: sessionScope }).forgotten).toBe(true)
    memory.remember({ text: 'old release codename', scope: sessionScope, provenance })
    expect(memory.forgetByText('s1', sessionScope, 'release codename')).toHaveLength(1)
  })

  it('clears one session without touching another', () => {
    const memory = new EphemeralSessionMemory()
    memory.remember({ text: 'alpha fact', scope: makeScopeRef('session', 'a'), provenance: { ...provenance, sessionId: 'a' } })
    memory.remember({ text: 'beta fact', scope: makeScopeRef('session', 'b'), provenance: { ...provenance, sessionId: 'b' } })
    memory.clearSession('a')
    expect(memory.recall({ text: 'alpha', scopes: [makeScopeRef('session', 'a')], limit: 5 })).toEqual([])
    expect(memory.recall({ text: 'beta', scopes: [makeScopeRef('session', 'b')], limit: 5 })).toHaveLength(1)
  })
})
