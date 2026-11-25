import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseTranscript, parseTranscriptFull, readTranscriptFull } from '../src/cli/transcript.js'

function event(value: Record<string, unknown>): string {
  return JSON.stringify(value)
}

function bodyOf(events: readonly Record<string, unknown>[]): string {
  return `${events.map(event).join('\n')}\n`
}

const LONG_USER = `user-${'u'.repeat(5_000)}`
const LONG_ASSISTANT = `answer-${'a'.repeat(4_000)}`

function sessionBody(): string {
  return bodyOf([
    { type: 'session', id: 's-full', createdAt: 1_700_000_000_000 },
    { type: 'turn/start', seq: 1, data: { turn: 1 } },
    {
      type: 'user/message',
      seq: 2,
      time: 1_700_000_001_000,
      data: { content: [{ type: 'text', text: LONG_USER }], source: { kind: 'user' } },
    },
    { type: 'turn/end', seq: 3, data: { turn: 1 } },
    { type: 'turn/start', seq: 4, data: { turn: 2 } },
    {
      type: 'user/message',
      seq: 5,
      time: 1_700_000_002_000,
      data: { content: [{ type: 'text', text: 'second question' }], source: { kind: 'user' } },
    },
    {
      type: 'assistant/message',
      seq: 6,
      time: 1_700_000_003_000,
      data: {
        turn: 2,
        message: {
          role: 'assistant',
          content: [
            { type: 'reasoning', text: 'private chain of thought' },
            { type: 'tool-call', id: 'c1', name: 'bash', arguments: '{}' },
            { type: 'text', text: LONG_ASSISTANT },
            { type: 'text', text: 'second answer paragraph' },
          ],
        },
      },
    },
    {
      type: 'assistant/message',
      seq: 7,
      time: 1_700_000_004_000,
      data: { turn: 2, message: { role: 'assistant', content: [{ type: 'reasoning', text: 'only thinking' }] } },
    },
  ])
}

describe('full-fidelity transcript reader', () => {
  it('keeps both roles and the whole text with no 2 000-char cap', () => {
    const parsed = parseTranscriptFull('session.v4.jsonl', sessionBody(), 'fallback')
    expect(parsed.sessionId).toBe('s-full')
    expect(parsed.messages).toHaveLength(3)
    const [firstUser, secondUser, assistant] = parsed.messages
    expect(firstUser?.role).toBe('user')
    expect(firstUser?.text).toBe(LONG_USER)
    expect(firstUser?.turn).toBe(1)
    expect(secondUser?.text).toBe('second question')
    expect(secondUser?.turn).toBe(2)
    expect(assistant?.role).toBe('assistant')
    expect(assistant?.turn).toBe(2)
    expect(assistant?.text).toBe(`${LONG_ASSISTANT}\n\nsecond answer paragraph`)
    expect(parsed.skips.tooLong).toBe(0)
    expect(parsed.messages.some((message) => message.text.includes('reasoning'))).toBe(false)
    expect(parsed.skips.reasoning).toBe(1)
  })

  it('skips synthetic runtime context but keeps old logs without a source field', () => {
    const body = bodyOf([
      { type: 'session', id: 's-old' },
      { type: 'user/message', seq: 1, data: { content: [{ type: 'text', text: 'Current runtime context. today' }] } },
      { type: 'user/message', seq: 2, data: { content: [{ type: 'text', text: 'real prompt' }] } },
    ])
    const parsed = parseTranscriptFull('session.v1.jsonl', body, 'fallback')
    expect(parsed.messages).toHaveLength(1)
    expect(parsed.messages[0]?.text).toBe('real prompt')
    expect(parsed.messages[0]?.turn).toBe(1)
    expect(parsed.skips.synthetic).toBe(1)
  })

  it('honours includeAssistant: false and still numbers turns', () => {
    const parsed = parseTranscriptFull('session.v4.jsonl', sessionBody(), 'fallback', {
      includeAssistant: false,
    })
    expect(parsed.messages.map((message) => message.role)).toEqual(['user', 'user'])
    expect(parsed.messages.map((message) => message.turn)).toEqual([1, 2])
  })

  it('keeps the import-history reader capped at 2 000 chars', () => {
    const parsed = parseTranscript('session.v4.jsonl', sessionBody(), 'fallback')
    expect(parsed.messages).toHaveLength(1)
    expect(parsed.skips.tooLong).toBe(1)
    expect(parsed.messages[0]?.text).toBe('second question')
  })

  it('reads a plain session file from disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dsh-transcript-full-'))
    const filePath = join(dir, 'session.v4.jsonl')
    writeFileSync(filePath, sessionBody())
    const parsed = readTranscriptFull(filePath)
    expect(parsed.filePath).toBe(filePath)
    expect(parsed.messages).toHaveLength(3)
  })
})
