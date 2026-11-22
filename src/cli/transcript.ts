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
