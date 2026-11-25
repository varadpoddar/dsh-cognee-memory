import type { ExtractionService } from '../memory/extraction-service.js'
import type { JournalMessage, TurnJournal } from '../memory/turn-journal.js'
import type { Metrics } from '../telemetry/metrics.js'
import type { PluginContextLike } from '../types.js'

interface SessionLike {
  readonly id?: unknown
  readonly header?: { readonly agentPreset?: unknown }
}

interface SessionEventLike {
  readonly type?: unknown
  readonly turn?: unknown
  readonly seq?: unknown
  readonly message?: unknown
  readonly data?: unknown
}

interface TurnMessage {
  readonly text: string
  readonly seq?: number
}

/**
 * Minimal surface of the lossless transcript store the hook needs. Kept
 * structural so this hook does not import the store's fs/lock machinery.
 */
interface TranscriptWriter {
  appendTurn(input: {
    readonly sessionId: string
    readonly turnIndex: number
    readonly role: 'user' | 'assistant'
    readonly text: string
    readonly timestamp?: string
  }): unknown
}

interface TurnBucket {
  readonly turn: number
  readonly messages: TurnMessage[]
  /** Agent text answers; the journal records these, extraction never does. */
  readonly answers: TurnMessage[]
}

interface TurnStoppingPayload {
  readonly agent?: SessionLike
  readonly turn?: unknown
}

interface LlmStreamOptions {
  readonly sessionId?: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function textFromMessage(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const source = (message as { readonly source?: { readonly kind?: unknown; readonly form?: unknown } })
    .source
  // Only direct human input. Synthetic context, relayed content, tool results,
  // and assistant output are never extraction sources.
  if (source === undefined || source.kind !== 'user') return ''
  if (source.form !== undefined && source.form !== 'notice') return ''
  const content = (message as { readonly content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const typed = block as { readonly type?: unknown; readonly text?: unknown }
    // Text only: reasoning blocks are never persisted or extracted.
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
  }
  // Verbatim: the transcript store has no char cap, and extraction bounds its
  // own facts (`MAX_FACT_CHARS`). A long committed message is never dropped.
  return parts.join('\n').trim()
}

/**
 * Agent-answer text. Only `text` blocks count: reasoning and tool payloads are
 * not part of the conversation the user saw, and the journal stores exactly
 * what was shown.
 */
function textFromAnswer(message: unknown): string {
  if (message === null || typeof message !== 'object') return ''
  const source = (message as { readonly source?: { readonly kind?: unknown } }).source
  // Live envelopes use source.kind "model"; test doubles may say "assistant".
  if (source !== undefined && source.kind !== undefined && source.kind !== 'model' && source.kind !== 'assistant') {
    return ''
  }
  const content = (message as { readonly content?: unknown }).content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const typed = block as { readonly type?: unknown; readonly text?: unknown }
    if (typed.type === 'text' && typeof typed.text === 'string') parts.push(typed.text)
  }
  return parts.join('\n').trim()
}

function sessionIdOf(session: SessionLike): string | undefined {
  const id = session.id
  return typeof id === 'string' ? id : typeof id === 'number' ? String(id) : undefined
}

/**
 * Subscribe to the post-commit session feed. `session/event` runs after the
 * append is durable (unlike stream fragments), so extraction never sees a
 * message that could still be replaced or rolled back. Deterministic commands
 * are extracted at `turn/end`; the optional LLM only fills implicit cases.
 */
export function registerSessionExtraction(
  ctx: PluginContextLike,
  deps: {
    readonly extraction: Pick<ExtractionService, 'handleTurn'>
    /** Optional turn journal: every conversation part becomes a durable task. */
    readonly journal?: Pick<TurnJournal, 'enabled' | 'recordTurn'>
    /**
     * Lossless transcript store: every committed turn (both sides) is appended
     * verbatim, with no char cap, so a later pointer can resolve to exact text.
     */
    readonly transcripts?: TranscriptWriter
    readonly metrics?: Metrics
    /**
     * Upper bound on how long the serial turn boundary waits for extraction
     * after the response. A timed-out pass keeps running in the background; a
     * one-shot headless profile sets this high enough to finish ingesting.
     */
    readonly settleMs?: number
  },
): () => void {
  const buckets = new Map<string, TurnBucket>()
  const sessions = new Map<string, SessionLike>()
  /** Session+turn already written to the journal, so the fallback cannot duplicate. */
  const journaled = new Set<string>()

  /**
   * Append this turn's conversation to the lossless transcript store. One row
   * per role per turn, both sides verbatim; the store itself is idempotent, so
   * a fallback path repeating a turn writes nothing twice. Synchronous because
   * the append is fsynced; a failure never breaks the turn.
   */
  const recordTranscript = (sessionId: string, turn: number, bucket: TurnBucket): void => {
    const transcripts = deps.transcripts
    if (transcripts === undefined) return
    const timestamp = new Date().toISOString()
    const textOf = (entries: readonly TurnMessage[]): string =>
      entries.map((entry) => entry.text).join('\n\n')
    try {
      if (bucket.messages.length > 0) {
        transcripts.appendTurn({
          sessionId,
          turnIndex: turn,
          role: 'user',
          text: textOf(bucket.messages),
          timestamp,
        })
        deps.metrics?.increment('transcript.appended')
      }
      if (bucket.answers.length > 0) {
        transcripts.appendTurn({
          sessionId,
          turnIndex: turn,
          role: 'assistant',
          text: textOf(bucket.answers),
          timestamp,
        })
        deps.metrics?.increment('transcript.appended')
      }
    } catch {
      deps.metrics?.increment('transcript.failed')
    }
  }

  /**
   * Append this turn's conversation parts to the durable queue. Synchronous on
   * purpose: the append is fsynced, so once the turn is committed on disk the
   * task is on disk too. Failures never break the turn.
   */
  const journalTurn = (sessionId: string, turn: number, bucket: TurnBucket): void => {
    recordTranscript(sessionId, turn, bucket)
    const journal = deps.journal
    if (journal === undefined || !journal.enabled) return
    const key = `${sessionId}:${turn}`
    if (journaled.has(key)) return
    journaled.add(key)
    const toMessage = (role: 'user' | 'assistant') => (entry: TurnMessage): JournalMessage => ({
      role,
      text: entry.text,
      ...(entry.seq === undefined ? {} : { seq: entry.seq }),
    })
    const messages: JournalMessage[] = [
      ...bucket.messages.map(toMessage('user')),
      ...bucket.answers.map(toMessage('assistant')),
    ]
    if (messages.length === 0) return
    try {
      journal.recordTurn({ sessionId, turn, messages, recordedAt: new Date().toISOString() })
    } catch {
      deps.metrics?.increment('journal.failed')
    }
  }

  const onSessionEvent = (session: SessionLike, event: SessionEventLike): void => {
    try {
      deps.metrics?.increment('extraction.events')
      const sessionId = sessionIdOf(session)
      if (sessionId === undefined) return
      sessions.set(sessionId, session)
      const data = isRecord(event.data) ? event.data : undefined
      const payloadTurn =
        typeof event.turn === 'number'
          ? event.turn
          : data !== undefined && typeof data.turn === 'number'
            ? data.turn
            : undefined
      if (event.type === 'turn/start') {
        buckets.set(sessionId, { turn: payloadTurn ?? 0, messages: [], answers: [] })
        return
      }
      if (event.type === 'user/message') {
        // The committed log envelope puts the message under `data`; accept the
        // flat test shape as well so unit doubles stay readable.
        const text = textFromMessage(event.message ?? (isRecord(data) && data.message !== undefined ? data.message : data))
        if (text === '') return
        deps.metrics?.increment('extraction.userMessages')
        let bucket = buckets.get(sessionId)
        if (bucket === undefined) {
          bucket = { turn: payloadTurn ?? 0, messages: [], answers: [] }
          buckets.set(sessionId, bucket)
        }
        bucket.messages.push({
          text,
          ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
        })
        return
      }
      if (event.type === 'assistant/message') {
        const text = textFromAnswer(event.message ?? (isRecord(data) && data.message !== undefined ? data.message : data))
        if (text === '') return
        deps.metrics?.increment('journal.answers')
        let bucket = buckets.get(sessionId)
        if (bucket === undefined) {
          bucket = { turn: payloadTurn ?? 0, messages: [], answers: [] }
          buckets.set(sessionId, bucket)
        }
        bucket.answers.push({
          text,
          ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
        })
        return
      }
      if (event.type === 'turn/end') {
        const bucket = buckets.get(sessionId)
        buckets.delete(sessionId)
        if (bucket === undefined) return
        journalTurn(sessionId, bucket.turn, bucket)
        if (bucket.messages.length === 0) return
        const preset = session.header?.agentPreset
        void deps.extraction
          .handleTurn({
            sessionId,
            turn: bucket.turn,
            messages: bucket.messages,
            ...(typeof preset === 'string' && preset !== '' ? { agentPreset: preset } : {}),
          })
          .catch(() => {
            deps.metrics?.increment('extraction.failed')
          })
      }
    } catch {
      deps.metrics?.increment('extraction.failed')
    }
  }

  /**
   * The loop appends the committed user/message events before it asks the LLM
   * for the first stream chunk. Awaiting extraction here guarantees a one-shot
   * headless process never exits before the candidate is queued and Cognee
   * confirms ingestion, while still reading only committed session records.
   */
  const onLlmStream = (
    _options: LlmStreamOptions,
    next: () => AsyncIterable<unknown>,
  ): AsyncIterable<unknown> => {
    // Deliberately a pass-through: extraction never runs before the first
    // token and never competes with the turn's own model request. It starts
    // after the response at `turn/end` / `agent/turn-stopping`.
    deps.metrics?.increment('extraction.streams')
    return next()
  }

  /**
   * Fallback for hosts that reach a turn boundary without a model stream.
   * The loop awaits this serial hook before the boundary commits.
   */
  const onTurnStopping = async (payload: TurnStoppingPayload): Promise<void> => {
    deps.metrics?.increment('extraction.turns')
    const session = payload.agent
    if (session === undefined) return
    const sessionId = sessionIdOf(session)
    if (sessionId === undefined) return
    const bucket = buckets.get(sessionId)
    const preset = session.header?.agentPreset
    if (bucket !== undefined) {
      journalTurn(sessionId, typeof payload.turn === 'number' ? payload.turn : bucket.turn, bucket)
    }
    try {
      // Runs after the response is produced. This is the awaited-after-response
      // path that guarantees a one-shot process finishes extraction + ingest.
      if (bucket !== undefined && bucket.messages.length > 0) {
        buckets.delete(sessionId)
        const pass = deps.extraction.handleTurn({
          sessionId,
          turn: typeof payload.turn === 'number' ? payload.turn : bucket.turn,
          messages: bucket.messages,
          ...(typeof preset === 'string' && preset !== '' ? { agentPreset: preset } : {}),
        })
        let timer: ReturnType<typeof setTimeout> | undefined
        const budget = deps.settleMs ?? 1_000
        await Promise.race([
          pass,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, budget)
            ;(timer as { unref?: () => void }).unref?.()
          }),
        ])
        if (timer !== undefined) clearTimeout(timer)
        // Keep the pass from becoming an unhandled rejection after a timeout.
        void pass.catch(() => {
          deps.metrics?.increment('extraction.failed')
        })
      }
    } catch {
      deps.metrics?.increment('extraction.failed')
    }
  }

  const onDisposed = (session: SessionLike): void => {
    const sessionId = sessionIdOf(session)
    if (sessionId !== undefined) {
      buckets.delete(sessionId)
      sessions.delete(sessionId)
    }
  }

  const disposers: Array<() => unknown> = [
    ctx.on('session/event', onSessionEvent as never),
    ctx.on('llm/stream', onLlmStream as never),
    ctx.on('agent/turn-stopping', onTurnStopping as never),
    ctx.on('session/disposed', onDisposed as never),
  ]
  return () => {
    for (const dispose of disposers.splice(0).reverse()) {
      try {
        dispose()
      } catch {
        // Unwinding one listener must not prevent the other from being removed.
      }
    }
    buckets.clear()
    sessions.clear()
  }
}
