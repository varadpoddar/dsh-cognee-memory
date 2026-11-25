/**
 * Read-only transcript access for `memory import-history` (M13).
 *
 * DSH persists each session as a concatenated-frame Zstandard container
 * (`$DSH_HOME/sessions/<project>/session-<id>/session.v4.jsonl.zstd`): one
 * independently decodable frame per appended batch, so a Node one-shot
 * decompressor stops at the first frame. This module locates frames by their
 * magic bytes and decodes each frame separately, then applies the same
 * human-message filter as the live extraction hook (M3): direct `user` input
 * only, text blocks only, no reasoning, no synthetic runtime context.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const JSONL_PATTERN = /^session\.v\d+\.jsonl(?:\.zstd)?$/
const MAX_MESSAGE_CHARS = 2_000
const SYNTHETIC_PREFIXES = ['Current runtime context.', 'Known context:'] as const

/** One decoded Zstandard stream. */
export interface DecodedStream {
  readonly text: string
  readonly frames: number
  /** True when the final frame was incomplete (an append was interrupted). */
  readonly torn: boolean
}

/** Decode a concatenated-frame Zstandard container. */
export function decodeZstdStream(buffer: Buffer): DecodedStream {
  let position = 0
  let frames = 0
  let torn = false
  const parts: string[] = []
  for (;;) {
    const start = buffer.indexOf(ZSTD_MAGIC, position)
    if (start < 0) break
    try {
      const plain = zstdDecompressSync(buffer.subarray(start))
      const text = plain.toString('utf8')
      // A frame always begins a JSON object in this container; a false magic
      // inside compressed data decodes to noise or throws, and is skipped.
      if (text.trimStart().startsWith('{')) {
        parts.push(text)
        frames += 1
      }
      position = start + ZSTD_MAGIC.length
    } catch {
      // Incomplete final frame (append torn) or a false magic: skip it.
      if (start === buffer.indexOf(ZSTD_MAGIC, start)) {
        const next = buffer.indexOf(ZSTD_MAGIC, start + ZSTD_MAGIC.length)
        if (next < 0) torn = true
      }
      position = start + ZSTD_MAGIC.length
    }
  }
  return { text: parts.join(''), frames, torn }
}

/** One committed human message in a transcript. */
export interface TranscriptMessage {
  readonly sessionId: string
  /** Durable message index inside the transcript (the event `seq`). */
  readonly messageIndex: number
  readonly text: string
  /** Event time as an ISO timestamp. */
  readonly timestamp: string
}

/** Why a message was not a candidate source; counted, never logged with text. */
export interface TranscriptSkips {
  synthetic: number
  tooLong: number
  notHuman: number
  malformed: number
}

/** One parsed session transcript. */
export interface DecodedTranscript {
  readonly filePath: string
  readonly sessionId: string
  readonly createdAt?: string
  readonly messages: readonly TranscriptMessage[]
  readonly skips: TranscriptSkips
  readonly frames: number
  readonly torn: boolean
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function textOfContent(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (!isRecord(block)) continue
    // Text only: reasoning/thinking blocks are never a source.
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n').trim()
}

function skipReason(text: string): keyof TranscriptSkips | undefined {
  if (text === '') return 'notHuman'
  if (text.length > MAX_MESSAGE_CHARS) return 'tooLong'
  if (SYNTHETIC_PREFIXES.some((prefix) => text.startsWith(prefix))) return 'synthetic'
  return undefined
}

/** Parse one decompressed transcript body into committed human messages. */
export function parseTranscript(
  filePath: string,
  body: string,
  fallbackSessionId: string,
): DecodedTranscript {
  const skips: TranscriptSkips = { synthetic: 0, tooLong: 0, notHuman: 0, malformed: 0 }
  const messages: TranscriptMessage[] = []
  let sessionId = fallbackSessionId
  let createdAt: string | undefined
  let runningIndex = 0
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      skips.malformed += 1
      continue
    }
    if (!isRecord(event)) {
      skips.malformed += 1
      continue
    }
    const type = event.type
    if (type === 'session') {
      if (typeof event.id === 'string' && event.id !== '') sessionId = event.id
      if (typeof event.createdAt === 'number') createdAt = new Date(event.createdAt).toISOString()
      continue
    }
    if (type !== 'user/message') continue
    runningIndex += 1
    const data = isRecord(event.data) ? event.data : undefined
    const source = data !== undefined && isRecord(data.source) ? data.source : undefined
    const form = source?.form
    // Only direct human input: synthetic context, relayed content, and tool
    // results are never extraction sources (M3 policy).
    if (source === undefined || source.kind !== 'user' || (form !== undefined && form !== 'notice')) {
      skips.notHuman += 1
      continue
    }
    const text = textOfContent(data?.content)
    const reason = skipReason(text)
    if (reason !== undefined) {
      skips[reason] += 1
      continue
    }
    const seq = typeof event.seq === 'number' && Number.isInteger(event.seq) ? event.seq : runningIndex
    const time = typeof event.time === 'number' ? event.time : undefined
    messages.push({
      sessionId,
      messageIndex: seq,
      text,
      timestamp: new Date(time ?? Date.parse(createdAt ?? '1970-01-01T00:00:00Z')).toISOString(),
    })
  }
  return { filePath, sessionId, ...(createdAt === undefined ? {} : { createdAt }), messages, skips, frames: 0, torn: false }
}

/** Read one transcript file, decompressing it when needed. */
export function readTranscript(filePath: string): DecodedTranscript {
  const bytes = readFileSync(filePath)
  const fallbackSessionId = filePath.split('/').at(-2) ?? filePath
  if (filePath.endsWith('.zstd')) {
    const decoded = decodeZstdStream(bytes)
    const parsed = parseTranscript(filePath, decoded.text, fallbackSessionId)
    return { ...parsed, frames: decoded.frames, torn: decoded.torn }
  }
  const body = bytes.toString('utf8')
  return parseTranscript(filePath, body, fallbackSessionId)
}

/** Every transcript file under `sessionsDir`, sorted by path for determinism. */
export function discoverTranscripts(sessionsDir: string): string[] {
  if (!existsSync(sessionsDir)) return []
  const found: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (depth > 3) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) walk(full, depth + 1)
      else if (entry.isFile() && JSONL_PATTERN.test(entry.name)) found.push(full)
    }
  }
  walk(sessionsDir, 0)
  return found.sort()
}

// ---------------------------------------------------------------------------
// Full-fidelity reading (1.0.6 slice 5f backfill)
//
// `parseTranscript` above is the import-history reader: human turns only, with
// the historical 2 000-char drop. The backfill must write the *whole*
// conversation into the lossless store — both roles, no truncation — so it uses
// the reader below. The default options of `parseTranscript` are unchanged.
// ---------------------------------------------------------------------------

/** Both conversation roles, in the order DSH committed them. */
export type TranscriptFullRole = 'user' | 'assistant'

/** One committed message of either role, verbatim. */
export interface TranscriptFullMessage {
  readonly sessionId: string
  /** Durable message index inside the transcript (the event `seq`). */
  readonly messageIndex: number
  readonly role: TranscriptFullRole
  /** 1-based turn number (DSH `turn/start` carries it; old logs are numbered per user message). */
  readonly turn: number
  readonly text: string
  readonly timestamp: string
}

/** Why a message was not part of the full transcript; counted, never logged with text. */
export interface TranscriptFullSkips {
  synthetic: number
  tooLong: number
  notHuman: number
  malformed: number
  /** Assistant messages whose only blocks were reasoning and/or tool calls. */
  reasoning: number
}

/** One parsed session transcript at full fidelity. */
export interface FullTranscript {
  readonly filePath: string
  readonly sessionId: string
  readonly createdAt?: string
  readonly messages: readonly TranscriptFullMessage[]
  readonly skips: TranscriptFullSkips
  readonly frames: number
  readonly torn: boolean
}

export interface TranscriptFullOptions {
  /** Include assistant text messages. Default true for the full reader. */
  readonly includeAssistant?: boolean
  /** `0`/absent = no cap (default); positive applies the import-history skip rule. */
  readonly maxMessageChars?: number
}

function payloadTurnOf(event: Record<string, unknown>, data: Record<string, unknown> | undefined): number | undefined {
  if (typeof event.turn === 'number' && Number.isInteger(event.turn)) return event.turn
  if (data !== undefined && typeof data.turn === 'number' && Number.isInteger(data.turn)) return data.turn
  return undefined
}

function contentBlocks(event: Record<string, unknown>, data: Record<string, unknown> | undefined): unknown {
  const message = event.message
  if (isRecord(message) && Array.isArray(message.content)) return message.content
  if (data !== undefined) {
    const nested = data.message
    if (isRecord(nested) && Array.isArray(nested.content)) return nested.content
    if (Array.isArray(data.content)) return data.content
  }
  return event.content
}

/** Text blocks joined with `\n\n`; reasoning and tool-call blocks are never text. */
function fullTextOf(content: unknown): { readonly text: string; readonly blocks: number } {
  if (!Array.isArray(content)) return { text: '', blocks: 0 }
  const parts: string[] = []
  let blocks = 0
  for (const block of content) {
    if (!isRecord(block)) continue
    blocks += 1
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return { text: parts.join('\n\n').trim(), blocks }
}

/**
 * Parse one decompressed transcript body into ordered user and assistant
 * messages, with no character cap unless `maxMessageChars` asks for one.
 *
 * Turn tracking: `turn/start` (and any envelope with `data.turn`) sets the
 * current 1-based turn, so a backfilled row carries the same coordinates the
 * live hook writes. A log with no turn events increments on each human user
 * message, which is the only boundary an old transcript preserves.
 */
export function parseTranscriptFull(
  filePath: string,
  body: string,
  fallbackSessionId: string,
  options: TranscriptFullOptions = {},
): FullTranscript {
  const includeAssistant = options.includeAssistant ?? true
  const maxChars = options.maxMessageChars ?? 0
  const skips: TranscriptFullSkips = { synthetic: 0, tooLong: 0, notHuman: 0, malformed: 0, reasoning: 0 }
  const messages: TranscriptFullMessage[] = []
  let sessionId = fallbackSessionId
  let createdAt: string | undefined
  let currentTurn = 0
  let turnEvents = 0
  let runningIndex = 0
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let event: unknown
    try {
      event = JSON.parse(trimmed)
    } catch {
      skips.malformed += 1
      continue
    }
    if (!isRecord(event)) {
      skips.malformed += 1
      continue
    }
    const type = event.type
    const data = isRecord(event.data) ? event.data : undefined
    if (type === 'session') {
      if (typeof event.id === 'string' && event.id !== '') sessionId = event.id
      if (typeof event.createdAt === 'number') createdAt = new Date(event.createdAt).toISOString()
      continue
    }
    const payloadTurn = payloadTurnOf(event, data)
    if (type === 'turn/start') {
      turnEvents += 1
      currentTurn = payloadTurn ?? currentTurn + 1
      continue
    }
    if (payloadTurn !== undefined) currentTurn = payloadTurn
    runningIndex += 1
    const messageIndex =
      typeof event.seq === 'number' && Number.isInteger(event.seq) ? event.seq : runningIndex
    const time = typeof event.time === 'number' ? event.time : undefined
    const timestamp = new Date(
      time ?? Date.parse(createdAt ?? '1970-01-01T00:00:00Z'),
    ).toISOString()

    if (type === 'user/message') {
      const source = data !== undefined && isRecord(data.source) ? data.source : undefined
      const form = source?.form
      // Same human filter as the import-history reader, but old logs that omit
      // `source` are still conversation and must not be lost.
      if (source !== undefined && (source.kind !== 'user' || (form !== undefined && form !== 'notice'))) {
        skips.notHuman += 1
        continue
      }
      const { text } = fullTextOf(contentBlocks(event, data))
      if (text === '') {
        skips.notHuman += 1
        continue
      }
      if (SYNTHETIC_PREFIXES.some((prefix) => text.startsWith(prefix))) {
        skips.synthetic += 1
        continue
      }
      if (maxChars > 0 && text.length > maxChars) {
        skips.tooLong += 1
        continue
      }
      // A log without the newer turn events gets one turn per human message.
      if (turnEvents === 0) currentTurn += 1
      messages.push({
        sessionId,
        messageIndex,
        role: 'user',
        turn: currentTurn === 0 ? 1 : currentTurn,
        text,
        timestamp,
      })
      continue
    }

    if (type === 'assistant/message') {
      if (!includeAssistant) continue
      const { text, blocks } = fullTextOf(contentBlocks(event, data))
      if (text === '') {
        if (blocks > 0) skips.reasoning += 1
        else skips.notHuman += 1
        continue
      }
      if (maxChars > 0 && text.length > maxChars) {
        skips.tooLong += 1
        continue
      }
      messages.push({
        sessionId,
        messageIndex,
        role: 'assistant',
        turn: currentTurn === 0 ? 1 : currentTurn,
        text,
        timestamp,
      })
      continue
    }
  }
  return {
    filePath,
    sessionId,
    ...(createdAt === undefined ? {} : { createdAt }),
    messages,
    skips,
    frames: 0,
    torn: false,
  }
}

/** Read one transcript file at full fidelity, decompressing it when needed. */
export function readTranscriptFull(filePath: string, options: TranscriptFullOptions = {}): FullTranscript {
  const bytes = readFileSync(filePath)
  const fallbackSessionId = filePath.split('/').at(-2) ?? filePath
  if (filePath.endsWith('.zstd')) {
    const decoded = decodeZstdStream(bytes)
    const parsed = parseTranscriptFull(filePath, decoded.text, fallbackSessionId, options)
    return { ...parsed, frames: decoded.frames, torn: decoded.torn }
  }
  const body = bytes.toString('utf8')
  return parseTranscriptFull(filePath, body, fallbackSessionId, options)
}
