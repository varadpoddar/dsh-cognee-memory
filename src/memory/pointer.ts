/**
 * Stable transcript pointer — the join between a derived artifact (a segment
 * summary) and the exact words it came from.
 *
 * STABILITY GUARANTEES:
 *   - `content_hash` is sha256 over the exact segment text (whole turns joined
 *     with `\n\n`), so equal text -> equal hash and any edit changes it;
 *   - `segment_index` is derived from the ordered turn sequence (role-run
 *     index, 0-based) and is preserved verbatim by build/serialize/deserialize;
 *   - `turn_start`/`turn_end` come from the first/last turn in input order, and
 *     `char_start`/`char_end` are UTF-16 code units into the same canonical
 *     transcript text the lossless store uses;
 *   - serialization uses one fixed key order, so a round trip is byte-stable.
 *
 * The base pointer field set is the seven transcript fields below. A summary
 * pointer (`SummaryPointer`) adds the two fields that make a derived summary
 * reproducible — `model` and `prompt_version` — and those are what the
 * machine-readable header at the top of every summary document carries.
 */
import { createHash } from 'node:crypto'
import { MemoryError } from '../errors.js'
import { segmentHash, type SegmentTurn, type TurnSegment } from './segmenter.js'

/** One addressable transcript range. */
export interface TranscriptPointer {
  readonly session_id: string
  readonly turn_start: number
  readonly turn_end: number
  readonly segment_index: number
  /** sha256 hex over the exact segment text. */
  readonly content_hash: string
  readonly char_start: number
  readonly char_end: number
}

const HASH_PATTERN = /^[a-f0-9]{64}$/

/** sha256 hex over exact text bytes (the pointer hash). */
export function pointerHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function fail(message: string): never {
  throw new MemoryError('VALIDATION', message)
}

function segmentText(turns: readonly SegmentTurn[]): string {
  return turns.map((turn) => turn.text).join('\n\n')
}

/** Build a pointer from ordered turns, recomputing the hash from the text. */
export function buildPointer(input: {
  readonly sessionId: string
  readonly segmentIndex: number
  readonly turns: readonly SegmentTurn[]
  readonly charStart: number
  readonly charEnd: number
}): TranscriptPointer {
  const { sessionId, segmentIndex, turns, charStart, charEnd } = input
  if (typeof sessionId !== 'string' || sessionId.trim() === '') fail('pointer session id is required')
  if (!isNonNegativeInteger(segmentIndex)) fail('pointer segment index must be a non-negative integer')
  if (turns.length === 0) fail('pointer needs at least one turn')
  if (!isNonNegativeInteger(charStart) || !isNonNegativeInteger(charEnd) || charEnd < charStart) {
    fail('pointer char range is invalid')
  }
  const first = turns[0]
  const last = turns.at(-1)
  if (first === undefined || last === undefined) fail('pointer needs at least one turn')
  if (!isNonNegativeInteger(first.turnIndex) || !isNonNegativeInteger(last.turnIndex)) {
    fail('pointer turn indices must be non-negative integers')
  }
  if (last.turnIndex < first.turnIndex) fail('pointer turn range is reversed')
  return {
    session_id: sessionId,
    turn_start: first.turnIndex,
    turn_end: last.turnIndex,
    segment_index: segmentIndex,
    content_hash: pointerHash(segmentText(turns)),
    char_start: charStart,
    char_end: charEnd,
  }
}

/** Build a pointer for one already-segmented range. */
export function buildPointerFromSegment(
  sessionId: string,
  segment: TurnSegment,
): TranscriptPointer {
  if (segment.contentHash !== segmentHash(segment.text)) {
    fail('segment hash does not match its text')
  }
  return buildPointer({
    sessionId,
    segmentIndex: segment.segmentIndex,
    turns: segment.turns,
    charStart: segment.charStart,
    charEnd: segment.charEnd,
  })
}

/** Stable, compact JSON in the documented key order. */
export function serializePointer(pointer: TranscriptPointer): string {
  const ordered: TranscriptPointer = {
    session_id: pointer.session_id,
    turn_start: pointer.turn_start,
    turn_end: pointer.turn_end,
    segment_index: pointer.segment_index,
    content_hash: pointer.content_hash,
    char_start: pointer.char_start,
    char_end: pointer.char_end,
  }
  return JSON.stringify(ordered)
}

/** Parse and validate a pointer; `undefined` for anything malformed. */
export function deserializePointer(raw: string | unknown): TranscriptPointer | undefined {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const row = value as Record<string, unknown>
  const { session_id, turn_start, turn_end, segment_index, content_hash, char_start, char_end } = row
  if (typeof session_id !== 'string' || session_id.trim() === '') return undefined
  if (!isNonNegativeInteger(turn_start) || !isNonNegativeInteger(turn_end)) return undefined
  if (turn_end < turn_start) return undefined
  if (!isNonNegativeInteger(segment_index)) return undefined
  if (typeof content_hash !== 'string' || !HASH_PATTERN.test(content_hash)) return undefined
  if (!isNonNegativeInteger(char_start) || !isNonNegativeInteger(char_end)) return undefined
  if (char_end < char_start) return undefined
  return {
    session_id,
    turn_start,
    turn_end,
    segment_index,
    content_hash,
    char_start,
    char_end,
  }
}

/** Whether a resolved range text is still exactly the pointed-at text. */
export function pointerMatches(pointer: TranscriptPointer, text: string): boolean {
  return pointerHash(text) === pointer.content_hash
}

// ---------------------------------------------------------------------------
// Summary pointers — a transcript pointer plus the pinned model + prompt
// version that produced a summary. They serialize into the summary document's
// machine-readable header, so retrieval can resolve a summary back to the
// exact turns and can tell whether a prompt bump invalidated it.
// ---------------------------------------------------------------------------

/** A pointer to the source turns of one summary, plus its generation identity. */
export interface SummaryPointer extends TranscriptPointer {
  /** Model string actually used for the generation (e.g. `unsloth/Qwen3.8-27B-GGUF`). */
  readonly model: string
  /** Pinned prompt version (`SUMMARY_PROMPT_VERSION`); a bump means re-summarize. */
  readonly prompt_version: string
}

/** Marks the start of the machine-readable header in a summary document. */
export const SUMMARY_HEADER_PREFIX = '[[dsh-memory-pointer '
/** Marks the start of the prose immediately after the header JSON. */
export const SUMMARY_HEADER_SUFFIX = ']]'

export interface BuildSummaryPointerInput {
  readonly sessionId: string
  readonly segmentIndex: number
  readonly turns: readonly SegmentTurn[]
  readonly charStart: number
  readonly charEnd: number
  readonly model: string
  readonly promptVersion: string
}

function identityField(value: string, field: string): string {
  if (typeof value !== 'string' || value.trim() === '') fail(`summary pointer ${field} is required`)
  const trimmed = value.trim()
  if (trimmed.includes('\n')) fail(`summary pointer ${field} must be one line`)
  return trimmed
}

/** Build a summary pointer from ordered turns, recomputing the hash from the text. */
export function buildSummaryPointer(input: BuildSummaryPointerInput): SummaryPointer {
  const pointer = buildPointer({
    sessionId: input.sessionId,
    segmentIndex: input.segmentIndex,
    turns: input.turns,
    charStart: input.charStart,
    charEnd: input.charEnd,
  })
  return {
    ...pointer,
    model: identityField(input.model, 'model'),
    prompt_version: identityField(input.promptVersion, 'prompt_version'),
  }
}

/** Build a summary pointer for one already-segmented range. */
export function buildSummaryPointerFromSegment(
  sessionId: string,
  segment: TurnSegment,
  model: string,
  promptVersion: string,
): SummaryPointer {
  if (segment.contentHash !== segmentHash(segment.text)) fail('segment hash does not match its text')
  return buildSummaryPointer({
    sessionId,
    segmentIndex: segment.segmentIndex,
    turns: segment.turns,
    charStart: segment.charStart,
    charEnd: segment.charEnd,
    model,
    promptVersion,
  })
}

/** Stable, compact JSON in the documented key order (base fields, then model, prompt_version). */
export function serializeSummaryPointer(pointer: SummaryPointer): string {
  const ordered: SummaryPointer = {
    session_id: pointer.session_id,
    turn_start: pointer.turn_start,
    turn_end: pointer.turn_end,
    segment_index: pointer.segment_index,
    content_hash: pointer.content_hash,
    char_start: pointer.char_start,
    char_end: pointer.char_end,
    model: pointer.model,
    prompt_version: pointer.prompt_version,
  }
  return JSON.stringify(ordered)
}

/** Parse and validate a summary pointer; `undefined` for anything malformed. */
export function parseSummaryPointer(raw: string | unknown): SummaryPointer | undefined {
  let value: unknown = raw
  if (typeof raw === 'string') {
    try {
      value = JSON.parse(raw)
    } catch {
      return undefined
    }
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const base = deserializePointer(value)
  if (base === undefined) return undefined
  const row = value as Record<string, unknown>
  const { model, prompt_version } = row
  if (typeof model !== 'string' || model.trim() === '' || model.includes('\n')) return undefined
  if (
    typeof prompt_version !== 'string' ||
    prompt_version.trim() === '' ||
    prompt_version.includes('\n')
  ) {
    return undefined
  }
  return { ...base, model: model.trim(), prompt_version: prompt_version.trim() }
}

/** The header line/JSON for one summary document. */
export function renderSummaryHeader(pointer: SummaryPointer): string {
  return `${SUMMARY_HEADER_PREFIX}${serializeSummaryPointer(pointer)}${SUMMARY_HEADER_SUFFIX}`
}

/** A summary document: the header, one blank line, then the prose. */
export function renderSummaryDocument(pointer: SummaryPointer, summaryText: string): string {
  return `${renderSummaryHeader(pointer)}\n\n${summaryText}`
}

/**
 * Split a summary document into its pointer and prose. The header must start at
 * offset 0 and parse as a valid summary pointer; everything after the closing
 * `]]` (with the first blank-line separator removed) is the prose verbatim.
 */
export function parseSummaryDocument(
  document: string,
): { readonly pointer: SummaryPointer; readonly summaryText: string } | undefined {
  if (!document.startsWith(SUMMARY_HEADER_PREFIX)) return undefined
  const end = document.indexOf(SUMMARY_HEADER_SUFFIX, SUMMARY_HEADER_PREFIX.length)
  if (end < 0) return undefined
  const pointer = parseSummaryPointer(
    document.slice(SUMMARY_HEADER_PREFIX.length, end),
  )
  if (pointer === undefined) return undefined
  let summaryText = document.slice(end + SUMMARY_HEADER_SUFFIX.length)
  if (summaryText.startsWith('\r\n\r\n')) summaryText = summaryText.slice(4)
  else if (summaryText.startsWith('\n\n')) summaryText = summaryText.slice(2)
  else if (summaryText.startsWith('\r\n')) summaryText = summaryText.slice(2)
  else if (summaryText.startsWith('\n')) summaryText = summaryText.slice(1)
  return { pointer, summaryText }
}
