/**
 * `memory backfill-transcripts` — one resumable pass from DSH session logs to
 * the lossless transcript store, turn segments, and `kind: "summary"` tasks.
 *
 * Pipeline per session:
 *   session JSONL (plain or concatenated-frame zstd)
 *     -> full-fidelity reader (both roles, no 2 000-char cap)
 *     -> lossless transcript store rows (idempotent per turn/role/hash)
 *     -> deterministic turn-boundary segments
 *     -> one summary per segment via the local Qwen (pinned prompt/model)
 *     -> one durable queue task `kind: "summary"` (header + prose)
 *
 * Idempotency: transcript rows dedupe on `(turn, role, content_hash)`; summary
 * tasks dedupe on `content_hash + prompt_version + model`. A second run of the
 * same history adds zero rows and zero tasks. `--dry-run` reads the store but
 * writes nothing and makes no model call.
 */
import type { CogneeMemoryConfig } from '../config/schema.js'
import { MemoryError, isMemoryError } from '../errors.js'
import { segmentTurns, type SegmentTurn, type TurnSegment } from '../memory/segmenter.js'
import { scopeKey } from '../memory/scopes.js'
import {
  enqueueSummary,
  estimateTokens,
  resolveSummaryRuntime,
  summarizeSegment,
  type SegmentSummary,
  type SummarizerOptions,
} from '../memory/summarizer.js'
import {
  resolveTranscriptsDir,
  TranscriptStore,
  type TranscriptRow,
} from '../memory/transcript-store.js'
import type { ScopeRef } from '../types.js'
import { IngestQueue, resolveQueuePath, type EnqueueReport } from '../queue/store.js'
import { queueOptionsFromEnv } from './queue-cmd.js'
import { discoverTranscripts, readTranscriptFull, type TranscriptFullMessage } from './transcript.js'

/**
 * Planning estimate for one local Qwen call. Measured on the Studio endpoint
 * (250k-context Qwen, ~700 output tokens) during the 1.0.6 slice; it is only
 * used for `--dry-run` reporting, never for behaviour.
 */
export const ESTIMATED_MS_PER_REQUEST = 15_000

/** One turn rebuilt from committed messages, ready for the store/segmenter. */
export interface BackfillTurn {
  readonly turn: number
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly timestamp: string
}

export interface BackfillIo {
  readonly out: (line: string) => void
  readonly err: (line: string) => void
}

export interface BackfillSessionReport {
  readonly sessionId: string
  readonly filePath: string
  readonly messages: number
  readonly turns: number
  readonly segments: number
  readonly newRows: number
  readonly duplicateRows: number
  readonly conflicts: number
  readonly summaries: number
  readonly enqueued: number
  readonly duplicateSummaries: number
  readonly error?: string
}

export interface BackfillReport {
  readonly dryRun: boolean
  readonly sessionsDir: string
  readonly sessions: number
  readonly skippedSessions: number
  readonly messages: number
  readonly turns: number
  readonly segments: number
  readonly newRows: number
  readonly duplicateRows: number
  readonly conflicts: number
  readonly summaries: number
  readonly enqueued: number
  readonly duplicateSummaries: number
  readonly estimatedInputTokens: number
  readonly estimatedOutputTokens: number
  readonly estimatedRequests: number
  readonly estimatedMs: number
  readonly failures: number
  readonly perSession: readonly BackfillSessionReport[]
}

export interface BackfillOptions {
  readonly sessionsDir: string
  readonly apply: boolean
  /** `both` (default) includes assistant text; `user` is user-only. */
  readonly roles?: 'both' | 'user'
  /** Process at most this many sessions, newest file paths last (sorted). */
  readonly limitSessions?: number
  readonly onlySessionId?: string
  readonly config: CogneeMemoryConfig
  readonly env: NodeJS.ProcessEnv
  readonly scope: ScopeRef
  readonly transcripts?: TranscriptStore
  readonly queue?: Pick<IngestQueue, 'enqueue'>
  /** Test seam: replaces the real Qwen call. */
  readonly summarizer?: (input: { sessionId: string; segment: TurnSegment }) => Promise<SegmentSummary>
  readonly concurrency?: number
  readonly io?: BackfillIo
}

function compareKeys(
  a: { readonly turn: number; readonly role: 'user' | 'assistant' },
  b: { readonly turn: number; readonly role: 'user' | 'assistant' },
): number {
  if (a.turn !== b.turn) return a.turn - b.turn
  const order = { user: 0, assistant: 1 } as const
  return order[a.role] - order[b.role]
}

/**
 * Group full messages into one row per `(turn, role)`. Texts inside a turn and
 * role are joined with `\n\n` (the same join the transcript store documents),
 * and rows are emitted in canonical order: turn ascending, user before
 * assistant.
 */
export function buildTurns(messages: readonly TranscriptFullMessage[]): BackfillTurn[] {
  const byKey = new Map<string, BackfillTurn>()
  for (const message of messages) {
    const key = `${message.turn}\u0000${message.role}`
    const existing = byKey.get(key)
    if (existing === undefined) {
      byKey.set(key, {
        turn: message.turn,
        role: message.role,
        text: message.text,
        timestamp: message.timestamp,
      })
    } else {
      byKey.set(key, { ...existing, text: `${existing.text}\n\n${message.text}` })
    }
  }
  return [...byKey.values()].sort(compareKeys)
}

/** Turn rows -> exact segmenter input (whole turns only). */
export function segmentsOf(
  turns: readonly BackfillTurn[],
  maxCharsPerSegment?: number,
): TurnSegment[] {
  const segmentInput: SegmentTurn[] = turns.map((turn) => ({
    turnIndex: turn.turn,
    role: turn.role,
    text: turn.text,
  }))
  return segmentTurns(
    segmentInput,
    maxCharsPerSegment === undefined ? {} : { maxCharsPerSegment },
  )
}

function existingRows(store: TranscriptStore, sessionId: string): Map<string, TranscriptRow> {
  const map = new Map<string, TranscriptRow>()
  for (const row of store.readTurns(sessionId, 0, Number.MAX_SAFE_INTEGER)) {
    map.set(`${row.turn_index}\u0000${row.role}`, row)
  }
  return map
}

function rowsToTurns(rows: Iterable<TranscriptRow>): BackfillTurn[] {
  return [...rows]
    .map((row) => ({
      turn: row.turn_index,
      role: row.role,
      text: row.text,
      timestamp: row.timestamp,
    }))
    .sort(compareKeys)
}

/**
 * Stored rows win over incoming ones. Segments are always built from this
 * union, so a pointer's char window matches the store's canonical text even
 * when the store was partially filled by an earlier role-limited run.
 */
function mergeTurns(
  stored: readonly BackfillTurn[],
  incoming: readonly BackfillTurn[],
): BackfillTurn[] {
  const byKey = new Map<string, BackfillTurn>()
  for (const turn of stored) byKey.set(`${turn.turn}\u0000${turn.role}`, turn)
  for (const turn of incoming) {
    const key = `${turn.turn}\u0000${turn.role}`
    if (!byKey.has(key)) byKey.set(key, turn)
  }
  return [...byKey.values()].sort(compareKeys)
}

interface StoreWriteResult {
  readonly newRows: number
  readonly duplicateRows: number
  readonly conflicts: number
}

/** Append missing rows only; never rewrite a stored row. */
function writeRows(
  store: TranscriptStore,
  sessionId: string,
  turns: readonly BackfillTurn[],
  apply: boolean,
): StoreWriteResult {
  const existing = existingRows(store, sessionId)
  let lastKey: { turn: number; role: 'user' | 'assistant' } | undefined
  for (const row of existing.values()) {
    const key = { turn: row.turn_index, role: row.role }
    if (lastKey === undefined || compareKeys(key, lastKey) > 0) lastKey = key
  }
  let newRows = 0
  let duplicateRows = 0
  let conflicts = 0
  for (const turn of turns) {
    const key = `${turn.turn}\u0000${turn.role}`
    const stored = existing.get(key)
    if (stored !== undefined) {
      if (stored.text === turn.text) duplicateRows += 1
      else conflicts += 1
      continue
    }
    if (lastKey !== undefined && compareKeys({ turn: turn.turn, role: turn.role }, lastKey) <= 0) {
      // A gap before already-stored rows: never rewrite history.
      conflicts += 1
      continue
    }
    if (!apply) {
      newRows += 1
      lastKey = { turn: turn.turn, role: turn.role }
      continue
    }
    try {
      store.appendTurn({
        sessionId,
        turnIndex: turn.turn,
        role: turn.role,
        text: turn.text,
        timestamp: turn.timestamp,
      })
      newRows += 1
      lastKey = { turn: turn.turn, role: turn.role }
    } catch (error) {
      if (isMemoryError(error) && error.code === 'CONFLICT') conflicts += 1
      else throw error
    }
  }
  return { newRows, duplicateRows, conflicts }
}

/** Run `fn` over items with at most `limit` in flight, preserving order. */
async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length)
  let cursor = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      if (index >= items.length) return
      results[index] = await fn(items[index] as T, index)
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, () => worker()))
  return results
}

function summarizerFor(
  options: BackfillOptions,
  runtime: ReturnType<typeof resolveSummaryRuntime>,
): ((input: { sessionId: string; segment: TurnSegment }) => Promise<SegmentSummary>) | undefined {
  if (options.summarizer !== undefined) return options.summarizer
  if (!runtime.enabled) return undefined
  const summarizerOptions: SummarizerOptions = {
    endpoint: runtime.endpoint,
    model: runtime.model,
    apiKey: runtime.apiKey,
    maxOutputTokens: runtime.maxOutputTokens,
    maxInputChars: runtime.maxInputChars,
    timeoutMs: runtime.timeoutMs,
    disableReasoning: runtime.disableReasoning,
    env: options.env,
  }
  return (input) => summarizeSegment(input, summarizerOptions)
}

/**
 * Execute one backfill pass. Pure with respect to the network when
 * `options.summarizer` is supplied (tests), and never writes when
 * `apply === false`.
 */
export async function runBackfill(options: BackfillOptions): Promise<BackfillReport> {
  const io = options.io
  const runtime = resolveSummaryRuntime(options.config, options.env)
  const summaryRuntime = options.summarizer === undefined ? runtime : { ...runtime, enabled: true }
  const summarizer = summarizerFor(options, runtime)
  if (options.apply && summarizer === undefined) {
    throw new MemoryError(
      'CONFIG',
      `summaries are not available (${runtime.reason}); set ingestion.summaries.enabled and the endpoint/key environment`,
      { retryable: false },
    )
  }
  const store =
    options.transcripts ??
    new TranscriptStore({ dir: resolveTranscriptsDir(options.env), env: options.env })
  const queue =
    options.queue ??
    IngestQueue.open({
      filePath: resolveQueuePath(options.env),
      ...queueOptionsFromEnv(options.env),
    })
  const scope = options.scope
  const scopeName = scopeKey(scope)
  const includeAssistant = (options.roles ?? 'both') === 'both'
  const files = discoverTranscripts(options.sessionsDir)
  const selected = options.limitSessions === undefined
    ? files
    : files.slice(0, Math.max(0, options.limitSessions))

  const report: BackfillSessionReport[] = []
  let skippedSessions = 0
  const totals = {
    messages: 0,
    turns: 0,
    segments: 0,
    newRows: 0,
    duplicateRows: 0,
    conflicts: 0,
    summaries: 0,
    enqueued: 0,
    duplicateSummaries: 0,
    estimatedInputTokens: 0,
    estimatedOutputTokens: 0,
    estimatedRequests: 0,
    failures: 0,
  }

  for (const filePath of selected) {
    const transcript = readTranscriptFull(filePath, { includeAssistant, maxMessageChars: 0 })
    if (options.onlySessionId !== undefined && transcript.sessionId !== options.onlySessionId) {
      skippedSessions += 1
      continue
    }
    if (transcript.messages.length === 0) {
      skippedSessions += 1
      continue
    }
    const incoming = buildTurns(transcript.messages)
    const storedBefore = rowsToTurns(existingRows(store, transcript.sessionId).values())
    const write = writeRows(store, transcript.sessionId, incoming, options.apply)
    const turns = mergeTurns(storedBefore, incoming)
    const segments = segmentsOf(turns, options.config.ingestion.summaries.maxCharsPerSegment)

    let summaries = 0
    let enqueued = 0
    let duplicateSummaries = 0
    let error: string | undefined
    let estimatedInputTokens = 0
    let estimatedOutputTokens = 0
    let estimatedRequests = 0
    for (const segment of segments) {
      const requests = Math.max(1, Math.ceil(segment.text.length / summaryRuntime.maxInputChars)) * 2 - 1
      estimatedRequests += requests
      estimatedInputTokens += estimateTokens(segment.text)
      estimatedOutputTokens += summaryRuntime.maxOutputTokens
    }

    if (options.apply && summarizer !== undefined) {
      try {
        const produced = await mapLimit(segments, options.concurrency ?? summaryRuntime.concurrency, (segment) =>
          summarizer({ sessionId: transcript.sessionId, segment }),
        )
        for (const summary of produced) {
          const result: EnqueueReport = enqueueSummary(queue, {
            summary,
            scope: scopeName,
            scopeRef: scope,
          })
          summaries += 1
          enqueued += result.added
          duplicateSummaries += result.duplicates
        }
      } catch (failure) {
        error = isMemoryError(failure)
          ? `${failure.code}: ${failure.message}`
          : failure instanceof Error
            ? failure.message
            : 'summary failed'
        totals.failures += 1
        io?.err(`backfill: ${transcript.sessionId}: ${error}`)
      }
    }

    totals.messages += transcript.messages.length
    totals.turns += turns.length
    totals.segments += segments.length
    totals.newRows += write.newRows
    totals.duplicateRows += write.duplicateRows
    totals.conflicts += write.conflicts
    totals.summaries += summaries
    totals.enqueued += enqueued
    totals.duplicateSummaries += duplicateSummaries
    totals.estimatedInputTokens += estimatedInputTokens
    totals.estimatedOutputTokens += estimatedOutputTokens
    totals.estimatedRequests += estimatedRequests
    report.push({
      sessionId: transcript.sessionId,
      filePath,
      messages: transcript.messages.length,
      turns: turns.length,
      segments: segments.length,
      newRows: write.newRows,
      duplicateRows: write.duplicateRows,
      conflicts: write.conflicts,
      summaries,
      enqueued,
      duplicateSummaries,
      ...(error === undefined ? {} : { error }),
    })
  }

  return {
    dryRun: !options.apply,
    sessionsDir: options.sessionsDir,
    sessions: report.length,
    skippedSessions,
    ...totals,
    estimatedMs: totals.estimatedRequests * ESTIMATED_MS_PER_REQUEST,
    perSession: report,
  }
}
