import { describe, expect, it } from 'vitest'
import {
  segmentHash,
  segmentTurns,
  type SegmentTurn,
} from '../src/memory/segmenter.js'

function turn(turnIndex: number, role: 'user' | 'assistant', text: string): SegmentTurn {
  return { turnIndex, role, text }
}

const ALTERNATING: SegmentTurn[] = [
  turn(0, 'user', 'first question'),
  turn(0, 'assistant', 'first answer'),
  turn(1, 'user', 'second question'),
  turn(1, 'assistant', 'second answer'),
]

describe('segmentTurns', () => {
  it('cuts at every role change for an alternating conversation', () => {
    const segments = segmentTurns(ALTERNATING)
    expect(segments).toHaveLength(4)
    expect(segments.map((segment) => segment.segmentIndex)).toEqual([0, 1, 2, 3])
    expect(segments.map((segment) => segment.turnStart)).toEqual([0, 0, 1, 1])
    expect(segments.map((segment) => segment.text)).toEqual([
      'first question',
      'first answer',
      'second question',
      'second answer',
    ])
    const canonical = ALTERNATING.map((entry) => entry.text).join('\n\n')
    for (const segment of segments) {
      expect(canonical.slice(segment.charStart, segment.charEnd)).toBe(segment.text)
      expect(segment.contentHash).toBe(segmentHash(segment.text))
    }
    expect(segments[1]?.charStart).toBe('first question'.length + 2)
  })

  it('merges consecutive same-role turns into one segment', () => {
    const segments = segmentTurns([
      turn(0, 'user', 'one'),
      turn(1, 'user', 'two'),
      turn(2, 'assistant', 'three'),
      turn(3, 'user', 'four'),
    ])
    expect(segments).toHaveLength(3)
    expect(segments[0]?.turns.map((entry) => entry.turnIndex)).toEqual([0, 1])
    expect(segments[0]?.text).toBe('one\n\ntwo')
    expect(segments[0]?.turnStart).toBe(0)
    expect(segments[0]?.turnEnd).toBe(1)
    expect(segments[1]?.text).toBe('three')
    expect(segments[2]?.text).toBe('four')
  })

  it('keeps a single turn as one whole segment', () => {
    const segments = segmentTurns([turn(7, 'user', 'only')])
    expect(segments).toHaveLength(1)
    expect(segments[0]).toMatchObject({
      segmentIndex: 0,
      turnStart: 7,
      turnEnd: 7,
      charStart: 0,
      charEnd: 'only'.length,
    })
  })

  it('returns no segments for an empty session', () => {
    expect(segmentTurns([])).toEqual([])
  })

  it('keeps unicode offsets slice-exact', () => {
    const turns = [turn(0, 'user', 'héllo 👋 世界'), turn(1, 'assistant', '🙂 ok')]
    const segments = segmentTurns(turns)
    const canonical = turns.map((entry) => entry.text).join('\n\n')
    expect(segments).toHaveLength(2)
    expect(segments[0]?.charEnd).toBe('héllo 👋 世界'.length)
    expect(segments[1]?.charStart).toBe('héllo 👋 世界'.length + 2)
    for (const segment of segments) {
      expect(canonical.slice(segment.charStart, segment.charEnd)).toBe(segment.text)
    }
  })

  it('never splits a very long turn even when max chars are tiny', () => {
    const long = 'z'.repeat(50_000)
    const segments = segmentTurns([turn(0, 'user', long)], { maxCharsPerSegment: 100 })
    expect(segments).toHaveLength(1)
    expect(segments[0]?.text).toBe(long)
    expect(segments[0]?.charEnd).toBe(50_000)
  })

  it('splits only at turn boundaries when a max is set', () => {
    const turns = [
      turn(0, 'user', 'aaaa'),
      turn(1, 'user', 'bbbb'),
      turn(2, 'user', 'cccc'),
      turn(3, 'assistant', 'dddd'),
    ]
    const segments = segmentTurns(turns, { maxCharsPerSegment: 10 })
    expect(segments.map((segment) => segment.text)).toEqual(['aaaa\n\nbbbb', 'cccc', 'dddd'])
    expect(segments.map((segment) => segment.segmentIndex)).toEqual([0, 1, 2])
    const whole = new Set(turns.map((entry) => entry.text))
    for (const segment of segments) {
      for (const piece of segment.text.split('\n\n')) expect(whole.has(piece)).toBe(true)
    }
  })

  it('is deterministic and preserves duplicate turn indices', () => {
    const turns = [turn(0, 'user', 'a'), turn(0, 'user', 'b'), turn(0, 'assistant', 'c')]
    expect(segmentTurns(turns)).toEqual(segmentTurns(turns))
    expect(segmentTurns(turns)[0]?.turns.map((entry) => entry.text)).toEqual(['a', 'b'])
    expect(segmentTurns(turns)[1]?.turnEnd).toBe(0)
  })

  it('treats a non-positive max as off', () => {
    const turns = [turn(0, 'user', 'a'), turn(1, 'user', 'b')]
    expect(segmentTurns(turns, { maxCharsPerSegment: 0 })).toHaveLength(1)
    expect(segmentTurns(turns, { maxCharsPerSegment: -5 })).toHaveLength(1)
  })
})
