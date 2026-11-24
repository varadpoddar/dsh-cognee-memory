/**
 * Drain the ingest queue with N concurrent workers.
 *
 * One worker per model endpoint is the intended deployment (two workers, one
 * per Unsloth Studio endpoint), so a slow cognify on one GPU never serializes
 * the other. Workers claim one item at a time: a long cognify holds a single
 * lease, which keeps backoff accounting honest and makes `SIGTERM` cheap to
 * honour — the in-flight item finishes, everything else stays `pending`.
 *
 * The drain never blocks an interactive turn: it is a separate process reading
 * the same queue file, and it stops as soon as `shouldStop()` flips.
 */
import type { IngestQueue, QueueItem } from './store.js'
import { MemoryError } from '../errors.js'

/** One write destination: an authenticated client bound to an endpoint. */
export interface DrainTarget {
  readonly name: string
  /** Resolve when the item is ingestable and searchable, reject otherwise. */
  readonly write: (item: QueueItem) => Promise<void>
}

export type DrainEvent =
  | { readonly type: 'done'; readonly id: string; readonly target: string; readonly ms: number }
  | { readonly type: 'failed'; readonly id: string; readonly target: string; readonly error: string }
  | { readonly type: 'idle'; readonly target: string }

export interface DrainOptions {
  readonly queue: IngestQueue
  readonly targets: readonly DrainTarget[]
  readonly workers?: number
  readonly limit?: number
  readonly shouldStop?: () => boolean
  readonly onEvent?: (event: DrainEvent) => void
  readonly now?: () => number
}

export interface DrainSummary {
  readonly processed: number
  readonly failed: number
  readonly attempted: number
  readonly stopped: boolean
  readonly durationMs: number
  readonly byTarget: Readonly<Record<string, number>>
}

/** Run the drain to exhaustion, `limit`, or an external stop signal. */
export async function drainQueue(options: DrainOptions): Promise<DrainSummary> {
  const now = options.now ?? Date.now
  const started = now()
  const shouldStop = options.shouldStop ?? (() => false)
  const limit = options.limit ?? Number.POSITIVE_INFINITY
  const workers = Math.max(1, Math.min(options.workers ?? 2, options.targets.length))
  const byTarget: Record<string, number> = {}
  let processed = 0
  let failed = 0
  let stopped = false

  // Retry backoff (`resilience.sleep`) unrefs its timer so a plugin request
  // never pins the host process open. In a standalone drain that means a
  // transient failure mid-retry can empty the event loop and exit 0 while the
  // worker still awaits — the item stays `inflight` and the timer silently does
  // nothing. One ref'd keeper for the duration of the drain prevents that.
  const keepAlive = setInterval(() => {}, 1_000)

  const runWorker = async (target: DrainTarget): Promise<void> => {
    for (;;) {
      if (processed + failed >= limit) return
      if (shouldStop()) {
        stopped = true
        return
      }
      const claimed = options.queue.claim({ limit: 1, workerId: target.name })
      const item = claimed[0]
      if (item === undefined) {
        options.onEvent?.({ type: 'idle', target: target.name })
        return
      }
      const at = now()
      try {
        await target.write(item)
        options.queue.markDone(item.id)
        processed += 1
        byTarget[target.name] = (byTarget[target.name] ?? 0) + 1
        options.onEvent?.({ type: 'done', id: item.id, target: target.name, ms: now() - at })
      } catch (error) {
        failed += 1
        const message = error instanceof Error ? error.message : String(error)
        // A refused payload (authz/validation/4xx) will never succeed: keep it
        // visible as failed instead of retrying it every night forever.
        const permanent =
          error instanceof MemoryError &&
          ['FORBIDDEN', 'VALIDATION', 'UNAUTHORIZED', 'NOT_FOUND', 'UNSUPPORTED_OPERATION'].includes(error.code)
        options.queue.markFailed(item.id, message, { permanent })
        options.onEvent?.({ type: 'failed', id: item.id, target: target.name, error: message })
      }
    }
  }

  await Promise.all(options.targets.slice(0, workers).map((target) => runWorker(target)))
  clearInterval(keepAlive)

  return {
    processed,
    failed,
    attempted: processed + failed,
    stopped,
    durationMs: now() - started,
    byTarget,
  }
}
