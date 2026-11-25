import { describe, expect, it } from 'vitest'
import { MemoryError } from '../src/errors.js'
import {
  buildPointer,
  buildPointerFromSegment,
  deserializePointer,
  pointerHash,
  pointerMatches,
  serializePointer,
} from '../src/memory/pointer.js'
import { segmentTurns, type SegmentTurn } from '../src/memory/segmenter.js'

function turn(turnIndex: number, role: 'user' | 'assistant', text: string): SegmentTurn {
  return { turnIndex, role, text }
}

const TURNS: SegmentTurn[] = [turn(4, 'user', 'question 👋'), turn(4, 'assistant', 'answer 世界')]

function pointer() {
  return buildPointer({
    sessionId: 'session-1',
    segmentIndex: 2,
    turns: TURNS,
    charStart: 100,
    charEnd: 140,
  })
}

describe('transcript pointer', () => {
  it('builds the seven fields with a hash over the exact segment text', () => {
    const built = pointer()
    expect(built).toEqual({
      session_id: 'session-1',
      turn_start: 4,
      turn_end: 4,
      segment_index: 2,
      content_hash: pointerHash('question 👋\n\nanswer 世界'),
      char_start: 100,
      char_end: 140,
    })
    expect(pointerMatches(built, 'question 👋\n\nanswer 世界')).toBe(true)
    expect(pointerMatches(built, 'edited')).toBe(false)
  })

  it('serializes in a fixed key order and round-trips byte-stably', () => {
    const built = pointer()
    const json = serializePointer(built)
    expect(json).toContain(
      '"session_id":"session-1","turn_start":4,"turn_end":4,"segment_index":2,"content_hash":"',
    )
    const parsed = deserializePointer(json)
    expect(parsed).toEqual(built)
    expect(serializePointer(parsed as NonNullable<typeof parsed>)).toBe(json)
    expect(deserializePointer(built)).toEqual(built)
  })

  it('derives the turn range from the first and last turn', () => {
    const built = buildPointer({
      sessionId: 's',
      segmentIndex: 0,
      turns: [turn(3, 'user', 'a'), turn(9, 'user', 'b')],
      charStart: 0,
      charEnd: 3,
    })
    expect(built.turn_start).toBe(3)
    expect(built.turn_end).toBe(9)
  })

  it('builds the same pointer from a segment and from its turns', () => {
    const [segment] = segmentTurns(TURNS)
    expect(segment).toBeDefined()
    if (segment === undefined) return
    expect(buildPointerFromSegment('session-1', segment)).toEqual(
      buildPointer({
        sessionId: 'session-1',
        segmentIndex: segment.segmentIndex,
        turns: segment.turns,
        charStart: segment.charStart,
        charEnd: segment.charEnd,
      }),
    )
  })

  it('changes the hash but not the offsets when one character changes', () => {
    const base = pointer()
    const edited = buildPointer({
      sessionId: 'session-1',
      segmentIndex: 2,
      turns: [turn(4, 'user', 'questioN 👋'), turn(4, 'assistant', 'answer 世界')],
      charStart: 100,
      charEnd: 140,
    })
    expect(edited.content_hash).not.toBe(base.content_hash)
    expect(edited.char_start).toBe(100)
    expect(edited.char_end).toBe(140)
    expect(edited.turn_start).toBe(base.turn_start)
  })

  it('is stable across repeated builds', () => {
    expect(pointer()).toEqual(pointer())
    expect(serializePointer(pointer())).toBe(serializePointer(pointer()))
  })

  it('rejects invalid build input with VALIDATION', () => {
    expect(() =>
      buildPointer({ sessionId: '', segmentIndex: 0, turns: TURNS, charStart: 0, charEnd: 1 }),
    ).toThrow(MemoryError)
    expect(() =>
      buildPointer({ sessionId: 's', segmentIndex: -1, turns: TURNS, charStart: 0, charEnd: 1 }),
    ).toThrow(MemoryError)
    expect(() =>
      buildPointer({ sessionId: 's', segmentIndex: 0, turns: [], charStart: 0, charEnd: 1 }),
    ).toThrow(MemoryError)
    expect(() =>
      buildPointer({ sessionId: 's', segmentIndex: 0, turns: TURNS, charStart: 5, charEnd: 4 }),
    ).toThrow(MemoryError)
    expect(() =>
      buildPointer({
        sessionId: 's',
        segmentIndex: 0,
        turns: [turn(1, 'user', 'a'), turn(0, 'user', 'b')],
        charStart: 0,
        charEnd: 1,
      }),
    ).toThrow(MemoryError)
  })

  it('deserializes only complete, well-typed pointers', () => {
    const valid = pointer()
    expect(deserializePointer('not json')).toBeUndefined()
    expect(deserializePointer(null)).toBeUndefined()
    expect(deserializePointer([])).toBeUndefined()
    expect(deserializePointer({})).toBeUndefined()
    expect(deserializePointer({ ...valid, content_hash: 'nope' })).toBeUndefined()
    expect(deserializePointer({ ...valid, content_hash: valid.content_hash.toUpperCase() })).toBeUndefined()
    expect(deserializePointer({ ...valid, turn_start: -1 })).toBeUndefined()
    expect(deserializePointer({ ...valid, turn_start: 1.5 })).toBeUndefined()
    expect(deserializePointer({ ...valid, turn_end: 3 })).toBeUndefined()
    expect(deserializePointer({ ...valid, char_end: 99 })).toBeUndefined()
    expect(deserializePointer({ ...valid, session_id: '' })).toBeUndefined()
    expect(deserializePointer({ ...valid, segment_index: -2 })).toBeUndefined()
    const { content_hash: _omitted, ...missing } = valid
    expect(deserializePointer(missing)).toBeUndefined()
  })

  it('ignores extra fields on deserialize', () => {
    const parsed = deserializePointer({ ...pointer(), model: 'local-qwen' })
    expect(parsed).toBeDefined()
    expect(Object.keys(parsed ?? {})).toHaveLength(7)
  })
})
