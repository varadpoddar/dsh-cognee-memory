import { describe, expect, it } from 'vitest'
import { registerSessionExtraction } from '../src/hooks/session-events.js'
import type { ExtractionTurnInput } from '../src/memory/extraction-service.js'
import { createFakePluginContext } from './helpers/fake-context.js'

function harness() {
  const fake = createFakePluginContext()
  const turns: ExtractionTurnInput[] = []
  const dispose = registerSessionExtraction(fake.ctx, {
    extraction: {
      async handleTurn(input) {
        turns.push(input)
      },
    },
  })
  const emit = (name: string, ...args: unknown[]): void => {
    for (const entry of fake.listeners) {
      if (entry.name === name) entry.listener(...(args as never[]))
    }
  }
  const emitAsync = async (name: string, ...args: unknown[]): Promise<void> => {
    for (const entry of fake.listeners) {
      if (entry.name === name) await (entry.listener(...(args as never[])) as Promise<void>)
    }
  }
  return { fake, turns, emit, emitAsync, dispose }
}

const session = { id: 'session-a', header: { agentPreset: 'worker' } }

function userMessage(text: string) {
  return {
    role: 'user',
    source: { kind: 'user' },
    content: [{ type: 'text', text }],
  }
}

describe('committed session extraction hook', () => {
  it('extracts only at turn end from committed user messages', async () => {
    const h = harness()
    h.emit('session/event', session, { type: 'turn/start', turn: 2 })
    h.emit('session/event', session, { type: 'user/message', turn: 2, seq: 7, message: userMessage('Remember that the flag is on.') })
    expect(h.turns).toHaveLength(0)
    h.emit('session/event', session, { type: 'turn/end', turn: 2 })
    await Promise.resolve()
    expect(h.turns).toHaveLength(1)
    expect(h.turns[0]).toMatchObject({
      sessionId: 'session-a',
      turn: 2,
      agentPreset: 'worker',
      messages: [{ text: 'Remember that the flag is on.', seq: 7 }],
    })
  })

  it('awaits extraction before the first model stream of a turn', async () => {
    const h = harness()
    h.emit('session/event', session, { type: 'turn/start', turn: 5 })
    h.emit('session/event', session, {
      type: 'user/message',
      turn: 5,
      message: userMessage('Remember that the flag is on.'),
    })
    const chunks: unknown[] = []
    const stream = (function () {
      const entry = h.fake.listeners.find((item) => item.name === 'llm/stream')
      return (entry?.listener as unknown as (
        options: { sessionId: string },
        next: () => Generator<string>,
      ) => AsyncIterable<unknown>)({ sessionId: 'session-a' }, function* () {
        yield 'chunk'
      })
    })()
    for await (const chunk of stream) chunks.push(chunk)
    expect(chunks).toEqual(['chunk'])
    expect(h.turns).toHaveLength(1)
    // The fallback must not extract the same turn twice.
    await h.emitAsync('agent/turn-stopping', { agent: session, turn: 5 })
    expect(h.turns).toHaveLength(1)
  })

  it('reads the real committed envelope (data field, no top-level turn)', async () => {
    const h = harness()
    h.emit('session/event', session, { type: 'turn/start', data: { turn: 9 } })
    h.emit('session/event', session, {
      type: 'user/message',
      seq: 21,
      data: { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Remember that the flag is on.' }] },
    })
    await h.emitAsync('agent/turn-stopping', { agent: session, turn: 9 })
    expect(h.turns[0]).toMatchObject({ turn: 9, messages: [{ text: 'Remember that the flag is on.', seq: 21 }] })
  })

  it('awaits extraction before the turn boundary via turn-stopping', async () => {
    const h = harness()
    h.emit('session/event', session, { type: 'turn/start', turn: 4 })
    h.emit('session/event', session, {
      type: 'user/message',
      turn: 4,
      message: userMessage('Remember that the flag is on.'),
    })
    await h.emitAsync('agent/turn-stopping', { agent: session, turn: 4 })
    expect(h.turns).toHaveLength(1)
    expect(h.turns[0]).toMatchObject({ sessionId: 'session-a', turn: 4 })
    h.emit('session/event', session, { type: 'turn/end', turn: 4 })
    await Promise.resolve()
    expect(h.turns).toHaveLength(1)
  })

  it('ignores assistant reasoning, tool results, and synthetic context', async () => {
    const h = harness()
    h.emit('session/event', session, { type: 'turn/start', turn: 1 })
    h.emit('session/event', session, {
      type: 'user/message',
      turn: 1,
      message: { role: 'user', source: { kind: 'runtime-context' }, content: [{ type: 'text', text: 'injected' }] },
    })
    h.emit('session/event', session, {
      type: 'user/message',
      turn: 1,
      message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'Remember that X' }] },
    })
    h.emit('session/event', session, {
      type: 'assistant/message',
      turn: 1,
      message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'reasoning', text: 'secret' }] },
    })
    h.emit('session/event', session, { type: 'turn/end', turn: 1 })
    await Promise.resolve()
    expect(h.turns).toHaveLength(0)
  })

  it('extracts only text blocks and drops reasoning parts', async () => {
    const h = harness()
    h.emit('session/event', session, { type: 'turn/start', turn: 1 })
    h.emit('session/event', session, {
      type: 'user/message',
      turn: 1,
      message: {
        role: 'user',
        source: { kind: 'user' },
        content: [
          { type: 'reasoning', text: 'hidden chain of thought' },
          { type: 'text', text: 'Remember that the target is CT 103.' },
        ],
      },
    })
    h.emit('session/event', session, { type: 'turn/end', turn: 1 })
    await Promise.resolve()
    expect(h.turns[0]?.messages[0]?.text).toBe('Remember that the target is CT 103.')
  })

  it('drops the buffer on session disposal', async () => {
    const h = harness()
    h.emit('session/event', session, { type: 'turn/start', turn: 1 })
    h.emit('session/event', session, {
      type: 'user/message',
      turn: 1,
      message: userMessage('Remember that the flag is on.'),
    })
    h.emit('session/disposed', session)
    h.emit('session/event', session, { type: 'turn/end', turn: 1 })
    await Promise.resolve()
    expect(h.turns).toHaveLength(0)
  })

  it('unregisters both listeners exactly once', () => {
    const h = harness()
    h.dispose()
    expect(h.fake.listeners).toEqual([])
  })
})
