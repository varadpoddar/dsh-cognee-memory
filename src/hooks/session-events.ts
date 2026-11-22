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
}

interface TurnMessage {
  readonly text: string
  readonly seq?: number
}

interface TurnBucket {
  readonly turn: number
  readonly messages: TurnMessage[]
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
    readonly extraction: Pick<ExtractionService, 'handleTurn'>
    readonly metrics?: Metrics
  },
): () => void {
  const buckets = new Map<string, TurnBucket>()

  const onSessionEvent = (session: SessionLike, event: SessionEventLike): void => {
    try {
      const sessionId = sessionIdOf(session)
      if (sessionId === undefined) return
      if (event.type === 'turn/start') {
        const turn = typeof event.turn === 'number' ? event.turn : 0
        buckets.set(sessionId, { turn, messages: [] })
        return
      }
      if (event.type === 'user/message') {
        const text = textFromMessage(event.message)
        if (text === '') return
        let bucket = buckets.get(sessionId)
        if (bucket === undefined) {
          bucket = { turn: typeof event.turn === 'number' ? event.turn : 0, messages: [] }
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

  const onDisposed = (session: SessionLike): void => {
    const sessionId = sessionIdOf(session)
    if (sessionId !== undefined) buckets.delete(sessionId)
  }

  const disposers: Array<() => unknown> = [
    ctx.on('session/event', onSessionEvent as never),
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
  }
}
