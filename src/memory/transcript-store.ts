/**
 * Lossless transcript store — the local evidence copy of every committed turn.
 *
 * WHY: the ingest queue holds conversation *tasks*, and a completed task is
 * pruned after a full ingest. A summary (or any later pointer) still has to be
 * resolvable back to the exact words that produced it. This store is that
 * evidence: one append-only JSONL file per session under the plugin state dir,
 * holding both sides of a conversation verbatim — no char cap, no chunking, no
 * trimming, no rewriting.
 *
 * ADDRESSING: rows are `{session_id, turn_index, role, text, timestamp,
 * char_start, char_end, content_hash}`. The canonical transcript text of a
 * session is every row in canonical order (`turn_index` ascending, `user`
 * before `assistant` in the same turn) joined by the two-character separator
 * `\n\n`. `char_start`/`char_end` are UTF-16 code-unit offsets into that string,
 * so `canonical.slice(char_start, char_end) === row.text` exactly. A pointer
 * (`src/memory/pointer.ts`) records a turn range plus that same char window.
 *
 * DURABILITY: appends take a cross-process lock (`<file>.lock`) and then
 * `write(2)` + `fsync(2)`, mirroring `queue/store.ts`, so a turn acknowledged on
 * disk is on disk before it returns. A torn trailing line is skipped by the
 * fold; reads recompute offsets from the texts, so an interrupted append can
 * never shift a later row.
 *
 * PRIVACY: this file is the conversation itself. It is 0600 under a 0700
 * directory and is never sent anywhere by this module. Retention is manual in
 * this slice (see docs/TRANSCRIPTS.md); nothing here expires rows.
 */
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { MemoryError } from '../errors.js'

/** Environment override for the transcripts directory. */
export const TRANSCRIPTS_DIR_ENV = 'COGNEE_MEMORY_TRANSCRIPTS_DIR'

/** Only these roles are conversation turns. */
export type TranscriptRole = 'user' | 'assistant'

/** One stored turn. `text` is verbatim. */
export interface TranscriptRow {
  readonly session_id: string
  readonly turn_index: number
  readonly role: TranscriptRole
  readonly text: string
  readonly timestamp: string
  /** UTF-16 offset of `text` in the canonical session transcript. */
  readonly char_start: number
  /** `char_start + text.length` (exclusive). */
  readonly char_end: number
  /** sha256 hex over the exact text bytes; no whitespace normalization. */
  readonly content_hash: string
}

export interface TranscriptStoreOptions {
  readonly dir?: string
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => Date
  /** `fdatasync` every appended row. Default true: a committed turn is durable. */
  readonly syncWrites?: boolean
  readonly logger?: (message: string) => void
}

export interface TranscriptAppendInput {
  readonly sessionId: string
  readonly turnIndex: number
  readonly role: TranscriptRole
  readonly text: string
  /** ISO timestamp; defaults to now. */
  readonly timestamp?: string
}

export interface TranscriptAppendResult {
  readonly row: TranscriptRow
  /** True when the exact same row (same key and hash) was already stored. */
  readonly duplicate: boolean
}

export interface TranscriptRangeQuery {
  readonly turnStart: number
  readonly turnEnd: number
  /** Optional window inside the selected turn range; clamped. */
  readonly charStart?: number
  /** Exclusive, clamped to the selected turn range. */
  readonly charEnd?: number
}

/** The exact text of one addressed range, with its own hash. */
export interface TranscriptRange {
  readonly sessionId: string
  readonly rows: readonly TranscriptRow[]
  readonly text: string
  readonly charStart: number
  readonly charEnd: number
  readonly contentHash: string
}

/** Directory of per-session transcript files for this process. */
export function resolveTranscriptsDir(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[TRANSCRIPTS_DIR_ENV]?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'plugins', 'cognee-memory', 'transcripts')
}

/** File name for one session; `encodeURIComponent` keeps ids path-safe. */
function sessionFileName(sessionId: string): string {
  if (sessionId.trim() === '' || sessionId === '.' || sessionId === '..') {
    throw new MemoryError('VALIDATION', 'invalid transcript session id')
  }
  const encoded = encodeURIComponent(sessionId)
  if (encoded === '' || encoded === '.' || encoded === '..' || encoded.includes('/')) {
    throw new MemoryError('VALIDATION', 'invalid transcript session id')
  }
  return `${encoded}.jsonl`
}

/** Path of one session's transcript file. */
export function transcriptPathFor(sessionId: string, dir: string = resolveTranscriptsDir()): string {
  return join(dir, sessionFileName(sessionId))
}

/** sha256 hex over exact text bytes, never normalized. */
export function transcriptHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

const ROLE_ORDER: Readonly<Record<TranscriptRole, number>> = Object.freeze({ user: 0, assistant: 1 })

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isRole(value: unknown): value is TranscriptRole {
  return value === 'user' || value === 'assistant'
}

/** Canonical order: turn index, then user before assistant in the same turn. */
function compareRows(
  a: { readonly turn_index: number; readonly role: TranscriptRole },
  b: { readonly turn_index: number; readonly role: TranscriptRole },
): number {
  if (a.turn_index !== b.turn_index) return a.turn_index - b.turn_index
  return ROLE_ORDER[a.role] - ROLE_ORDER[b.role]
}

/** Stored row as read from disk, before offsets are recomputed. */
type FoldedRow = Omit<TranscriptRow, 'char_start' | 'char_end'>

function asFoldedRow(value: unknown, sessionId: string): FoldedRow | undefined {
  if (!isRecord(value)) return undefined
  const { session_id, turn_index, role, text, timestamp, content_hash } = value
  if (session_id !== sessionId) return undefined
  if (typeof turn_index !== 'number' || !Number.isInteger(turn_index) || turn_index < 0) return undefined
  if (!isRole(role)) return undefined
  if (typeof text !== 'string' || text === '') return undefined
  if (typeof timestamp !== 'string' || !Number.isFinite(Date.parse(timestamp))) return undefined
  if (typeof content_hash !== 'string' || !/^[a-f0-9]{64}$/.test(content_hash)) return undefined
  return { session_id, turn_index, role, text, timestamp, content_hash }
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Fold the file, recompute canonical offsets, and drop corrupt lines. */
function fold(filePath: string, sessionId: string): TranscriptRow[] {
  if (!existsSync(filePath)) return []
  let body: string
  try {
    body = readFileSync(filePath, 'utf8')
  } catch {
    return []
  }
  const byKey = new Map<string, FoldedRow>()
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // A torn trailing line from an interrupted append: skip it.
      continue
    }
    const row = asFoldedRow(parsed, sessionId)
    if (row === undefined) continue
    byKey.set(`${row.turn_index}\u0000${row.role}`, row)
  }
  const ordered = [...byKey.values()].sort(compareRows)
  let offset = 0
  return ordered.map((row, index) => {
    const charStart = index === 0 ? 0 : offset + 2
    const charEnd = charStart + row.text.length
    offset = charEnd
    return { ...row, char_start: charStart, char_end: charEnd }
  })
}

/** Join rows into the canonical session text (same order as {@link fold}). */
function canonicalText(rows: readonly Pick<TranscriptRow, 'text'>[]): string {
  return rows.map((row) => row.text).join('\n\n')
}

/** Durable, append-only, per-session transcript store. */
export class TranscriptStore {
  readonly dir: string
  private readonly now: () => Date
  private readonly syncWrites: boolean
  private readonly logger: ((message: string) => void) | undefined
  private readonly env: NodeJS.ProcessEnv

  constructor(options: TranscriptStoreOptions = {}) {
    this.env = options.env ?? process.env
    this.dir = options.dir ?? resolveTranscriptsDir(this.env)
    this.now = options.now ?? (() => new Date())
    this.syncWrites = options.syncWrites ?? true
    this.logger = options.logger
  }

  /** Rows of one session in canonical order; corrupt lines are skipped. */
  private rowsOf(sessionId: string): TranscriptRow[] {
    try {
      return fold(transcriptPathFor(sessionId, this.dir), sessionId)
    } catch {
      return []
    }
  }

  private withLock<T>(filePath: string, fn: () => T): T {
    // The lock lives next to the log, so the directory must exist before the
    // first `wx` open; otherwise a missing dir would look like contention.
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    const lockPath = `${filePath}.lock`
    const deadline = Date.now() + 5_000
    for (;;) {
      try {
        const fd = openSync(lockPath, 'wx', 0o600)
        closeSync(fd)
        break
      } catch {
        try {
          if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
            unlinkSync(lockPath)
            continue
          }
        } catch {
          // Lock disappeared between the failed open and stat: retry.
        }
        if (Date.now() >= deadline) throw new Error(`transcript lock timeout: ${lockPath}`)
        sleepSync(25)
      }
    }
    try {
      return fn()
    } finally {
      try {
        unlinkSync(lockPath)
      } catch {
        // Another process already removed a stale lock.
      }
    }
  }

  private appendLine(filePath: string, row: TranscriptRow): void {
    mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
    const line = `${JSON.stringify(row)}\n`
    if (this.syncWrites) {
      const fd = openSync(filePath, 'a', 0o600)
      try {
        writeSync(fd, line)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } else {
      appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 })
    }
  }

  /**
   * Append one committed turn. Idempotent by `(session, turn_index, role)`:
   * the same content is a no-op, different content for the same key is a
   * conflict, and an append that would violate canonical order is refused
   * rather than silently rewriting history.
   */
  appendTurn(input: TranscriptAppendInput): TranscriptAppendResult {
    const { sessionId, turnIndex, role, text } = input
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      throw new MemoryError('VALIDATION', 'invalid transcript session id')
    }
    if (!Number.isInteger(turnIndex) || turnIndex < 0) {
      throw new MemoryError('VALIDATION', 'turn index must be a non-negative integer')
    }
    if (!isRole(role)) throw new MemoryError('VALIDATION', 'invalid transcript role')
    if (typeof text !== 'string' || text === '') {
      throw new MemoryError('VALIDATION', 'empty turn text')
    }
    const timestamp = input.timestamp ?? this.now().toISOString()
    if (!Number.isFinite(Date.parse(timestamp))) {
      throw new MemoryError('VALIDATION', 'invalid transcript timestamp')
    }
    const filePath = transcriptPathFor(sessionId, this.dir)
    const rows = fold(filePath, sessionId)
    const existing = rows.find((row) => row.turn_index === turnIndex && row.role === role)
    const contentHash = transcriptHash(text)
    if (existing !== undefined) {
      if (existing.content_hash === contentHash) return { row: existing, duplicate: true }
      throw new MemoryError('CONFLICT', 'transcript row already stored with different content')
    }
    const last = rows.at(-1)
    if (last !== undefined && compareRows(last, { turn_index: turnIndex, role }) >= 0) {
      throw new MemoryError('VALIDATION', 'out-of-order turn')
    }
    const charStart = rows.length === 0 ? 0 : canonicalText(rows).length + 2
    const row: TranscriptRow = {
      session_id: sessionId,
      turn_index: turnIndex,
      role,
      text,
      timestamp: new Date(timestamp).toISOString(),
      char_start: charStart,
      char_end: charStart + text.length,
      content_hash: contentHash,
    }
    this.withLock(filePath, () => this.appendLine(filePath, row))
    return { row, duplicate: false }
  }

  hasSession(sessionId: string): boolean {
    try {
      return existsSync(transcriptPathFor(sessionId, this.dir))
    } catch {
      return false
    }
  }

  /** One turn, optionally constrained to a role. */
  readTurn(sessionId: string, turnIndex: number, role?: TranscriptRole): TranscriptRow | undefined {
    if (!Number.isInteger(turnIndex) || turnIndex < 0) return undefined
    const rows = this.rowsOf(sessionId)
    return rows.find(
      (row) => row.turn_index === turnIndex && (role === undefined || row.role === role),
    )
  }

  /** Every row whose turn index falls in the inclusive range. */
  readTurns(sessionId: string, turnStart: number, turnEnd: number): TranscriptRow[] {
    if (!Number.isInteger(turnStart) || !Number.isInteger(turnEnd)) return []
    const low = Math.min(turnStart, turnEnd)
    const high = Math.max(turnStart, turnEnd)
    return this.rowsOf(sessionId).filter((row) => row.turn_index >= low && row.turn_index <= high)
  }

  /**
   * Resolve a turn range plus optional char window to the exact transcript
   * text. `undefined` when the session is absent or no turn intersects.
   */
  readRange(sessionId: string, query: TranscriptRangeQuery): TranscriptRange | undefined {
    const all = this.rowsOf(sessionId)
    if (all.length === 0) return undefined
    const selected = this.readTurns(sessionId, query.turnStart, query.turnEnd)
    if (selected.length === 0) return undefined
    const canonical = canonicalText(all)
    const selectedStart = selected[0]?.char_start ?? 0
    const selectedEnd = selected.at(-1)?.char_end ?? 0
    const start = Math.max(selectedStart, Math.min(query.charStart ?? selectedStart, selectedEnd))
    const end = Math.max(start, Math.min(query.charEnd ?? selectedEnd, selectedEnd))
    const text = canonical.slice(start, end)
    return {
      sessionId,
      rows: selected,
      text,
      charStart: start,
      charEnd: end,
      contentHash: transcriptHash(text),
    }
  }

  /** Session ids present on disk, sorted for determinism. */
  sessions(): string[] {
    if (!existsSync(this.dir)) return []
    let names: string[]
    try {
      names = readdirSync(this.dir)
    } catch {
      return []
    }
    const ids: string[] = []
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue
      const encoded = name.slice(0, -'.jsonl'.length)
      try {
        const decoded = decodeURIComponent(encoded)
        if (decoded !== '') ids.push(decoded)
      } catch {
        this.logger?.(`transcript file name not decodable: ${name}`)
      }
    }
    return ids.sort()
  }
}
