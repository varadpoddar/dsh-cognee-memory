/**
 * Deterministic turn-boundary segmentation for conversation transcripts.
 *
 * A segment is a run of whole turns. Cuts happen ONLY where the role changes
 * (`user` -> `assistant` and back), never inside a message and never because of
 * a token or character counter. The optional `maxCharsPerSegment` is off by
 * default; when set it can only start a new segment *before* a turn, so a single
 * long turn still stays whole.
 *
 * The function is pure: same ordered turns -> deep-equal segments, with no
 * clock, randomness, I/O, or model call. `charStart`/`charEnd` are UTF-16
 * code-unit offsets into the canonical whole-input text (all turn texts joined
 * with `\n\n` in input order), so `canonical.slice(charStart, charEnd)` is the
 * segment text exactly. `contentHash` is sha256 over that exact text.
 */
import { createHash } from 'node:crypto'

export type SegmentRole = 'user' | 'assistant'

/** One ordered conversation turn, verbatim. */
export interface SegmentTurn {
  readonly turnIndex: number
  readonly role: SegmentRole
  readonly text: string
}

/** One emitted segment: whole turns only, with its exact transcript range. */
export interface TurnSegment {
  readonly segmentIndex: number
  readonly turnStart: number
  readonly turnEnd: number
  readonly turns: readonly SegmentTurn[]
  readonly text: string
  readonly charStart: number
  readonly charEnd: number
  readonly contentHash: string
}

export interface SegmentOptions {
  /**
   * Off by default (`undefined` or `<= 0`). When positive, a new segment starts
   * before a turn only if adding it would exceed this many chars. A turn longer
   * than this limit is never split.
   */
  readonly maxCharsPerSegment?: number
}

/** sha256 hex over exact text bytes (the segment hash). */
export function segmentHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function joinTurns(turns: readonly SegmentTurn[]): string {
  return turns.map((turn) => turn.text).join('\n\n')
}

/**
 * Segment ordered turns at role changes. Input order is preserved; duplicate
 * or non-contiguous turn indices are kept exactly as given (the caller owns
 * ordering). An empty input yields no segments.
 */
export function segmentTurns(
  turns: readonly SegmentTurn[],
  options: SegmentOptions = {},
): TurnSegment[] {
  const maxChars = options.maxCharsPerSegment
  const limited = maxChars !== undefined && maxChars > 0

  // Canonical offsets over the whole input, computed once.
  const offsets: Array<{ charStart: number; charEnd: number }> = []
  let offset = 0
  turns.forEach((turn, index) => {
    const charStart = index === 0 ? 0 : offset + 2
    const charEnd = charStart + turn.text.length
    offsets.push({ charStart, charEnd })
    offset = charEnd
  })

  const segments: TurnSegment[] = []
  let startIndex = 0
  let currentLength = 0

  const flush = (endIndex: number): void => {
    if (endIndex < startIndex) return
    const slice = turns.slice(startIndex, endIndex + 1)
    const first = slice[0]
    const last = slice.at(-1)
    const start = offsets[startIndex]
    const end = offsets[endIndex]
    if (first === undefined || last === undefined || start === undefined || end === undefined) return
    const text = joinTurns(slice)
    segments.push({
      segmentIndex: segments.length,
      turnStart: first.turnIndex,
      turnEnd: last.turnIndex,
      turns: slice,
      text,
      charStart: start.charStart,
      charEnd: end.charEnd,
      contentHash: segmentHash(text),
    })
  }

  for (let index = 0; index < turns.length; index += 1) {
    const turn = turns[index]
    if (turn === undefined) continue
    const previous = index > startIndex ? turns[index - 1] : undefined
    const roleChanged = previous !== undefined && previous.role !== turn.role
    const wouldExceed =
      limited && index > startIndex && currentLength + 2 + turn.text.length > (maxChars ?? 0)
    if (index > startIndex && (roleChanged || wouldExceed)) {
      flush(index - 1)
      startIndex = index
      currentLength = turn.text.length
      continue
    }
    currentLength = index === startIndex ? turn.text.length : currentLength + 2 + turn.text.length
  }
  if (turns.length > 0) flush(turns.length - 1)
  return segments
}
