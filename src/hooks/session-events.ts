import type { ExtractionService } from '../memory/extraction-service.js'
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

interface TurnBucket {
  readonly turn: number
  readonly messages: TurnMessage[]
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
  const text = parts.join('\n').trim()
  return text.length > 2_000 ? '' : text
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
    readonly extraction: Pick<ExtractionService, 'handleTurn' | 'settle'>
    readonly metrics?: Metrics
  },
): () => void {
  const buckets = new Map<string, TurnBucket>()
  const sessions = new Map<string, SessionLike>()

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
        buckets.set(sessionId, { turn: payloadTurn ?? 0, messages: [] })
        return
      }
      if (event.type === 'user/message') {
        // The committed log envelope puts the message under `data`; accept the
        // flat test shape as well so unit doubles stay readable.
        const text = textFromMessage(event.message ?? data)
        if (text === '') return
        deps.metrics?.increment('extraction.userMessages')
        let bucket = buckets.get(sessionId)
        if (bucket === undefined) {
          bucket = { turn: payloadTurn ?? 0, messages: [] }
          buckets.set(sessionId, bucket)
        }
        bucket.messages.push({
          text,
          ...(typeof event.seq === 'number' ? { seq: event.seq } : {}),
        })
        return
      }
      if (event.type === 'turn/end') {
        const bucket = buckets.get(sessionId)
        buckets.delete(sessionId)
        if (bucket === undefined || bucket.messages.length === 0) return
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
    options: LlmStreamOptions,
    next: () => AsyncIterable<unknown>,
  ): AsyncIterable<unknown> => {
    return (async function* streamAfterExtraction() {
      deps.metrics?.increment('extraction.streams')
      const sessionId = typeof options.sessionId === 'string' ? options.sessionId : undefined
      let drained = false
      if (sessionId !== undefined) {
        const bucket = buckets.get(sessionId)
        const session = sessions.get(sessionId)
        const streamPreset = session?.header?.agentPreset
        if (bucket !== undefined && bucket.messages.length > 0) {
          deps.metrics?.increment('extraction.streamsWithBucket')
          buckets.delete(sessionId)
          drained = true
          // Fast path only: deterministic commands are queued/ingested before
          // the first token; the LLM pass is deferred behind the response.
          try {
            await deps.extraction.handleTurn(
              {
                sessionId,
                turn: bucket.turn,
                messages: bucket.messages,
                ...(typeof streamPreset === 'string' && streamPreset !== ''
                  ? { agentPreset: streamPreset }
                  : {}),
              },
              { llm: 'defer' },
            )
          } catch {
            deps.metrics?.increment('extraction.failed')
          }
        }
      }
      try {
        yield* next()
      } finally {
        // After the response is streamed (never before the first token): bound
        // the wait so a slow local extractor cannot delay the turn. This is
        // also what guarantees a one-shot headless run ingests its candidate.
        if (sessionId !== undefined && drained) {
          try {
            await deps.extraction.settle(sessionId)
          } catch {
            deps.metrics?.increment('extraction.failed')
          }
        }
      }
    })()
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
    try {
      // Runs after the response is produced, so deferring the LLM here costs
      // no first-token latency; `settle` then bounds the boundary wait.
      if (bucket !== undefined && bucket.messages.length > 0) {
        buckets.delete(sessionId)
        await deps.extraction.handleTurn(
          {
            sessionId,
            turn: typeof payload.turn === 'number' ? payload.turn : bucket.turn,
            messages: bucket.messages,
            ...(typeof preset === 'string' && preset !== '' ? { agentPreset: preset } : {}),
          },
          { llm: 'defer' },
        )
      }
      await deps.extraction.settle(sessionId)
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
