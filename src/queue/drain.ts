/**
 * Drain the ingest queue with N concurrent workers, optionally in batches.
 *
 * One worker per model endpoint is the intended deployment (two workers, one
 * per Unsloth Studio endpoint), so a slow cognify on one GPU never serializes
 * the other.
 *
 * Two write shapes:
 *  - per item (`batchSize: 1`, the default): claim one task, write it, mark it
 *    done. A long cognify holds a single lease, which keeps backoff accounting
 *    honest and makes `SIGTERM` cheap to honour.
 *  - batched (`batchSize > 1` and the target provides `writeBatch`): claim up
 *    to `batchSize` tasks and hand them to one backend pipeline run (`add` all,
 *    `cognify` once). Cognee charges ~45-60 s per cognify, so batching is what
 *    turns ~1.3 items/min into tens of items/min. Failure isolation stays per
 *    item: a task the batch reports as failed — or a whole batch that throws —
 *    is retried on its own, so one poison document cannot fail its neighbours.
 *    Every claimed task is resolved (`done` or back to `pending`/`failed`);
 *    nothing is left `inflight`.
 *
 * The drain never blocks an interactive turn: it is a separate process reading
 * the same queue file, and it stops as soon as `shouldStop()` flips.
 */
import type { IngestQueue, QueueItem } from './store.js'
import { MemoryError } from '../errors.js'

/** Outcome of one item inside a batch write. */
export type DrainItemResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string; readonly permanent?: boolean }

/** One write destination: an authenticated client bound to an endpoint. */
export interface DrainTarget {
  readonly name: string
  /** Resolve when the item is ingestable and searchable, reject otherwise. */
  readonly write: (item: QueueItem) => Promise<void>
  /**
   * Optional batched write: `add` every item, run one pipeline pass, and return
   * one result per item, positionally. A target without this always drains one
   * item at a time.
   */
  readonly writeBatch?: (items: readonly QueueItem[]) => Promise<readonly DrainItemResult[]>
}

export type DrainEvent =
  | {
      readonly type: 'done'
      readonly id: string
      readonly target: string
      readonly ms: number
      readonly batch?: number
    }
  | { readonly type: 'failed'; readonly id: string; readonly target: string; readonly error: string }
  | { readonly type: 'idle'; readonly target: string }

export interface DrainOptions {
  readonly queue: IngestQueue
  readonly targets: readonly DrainTarget[]
  readonly workers?: number
  readonly limit?: number
  /** Tasks per backend pipeline run; 1 keeps the per-item path. */
  readonly batchSize?: number
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
  readonly batchSize: number
  readonly batches: number
  readonly byTarget: Readonly<Record<string, number>>
}

/** Error codes a retry can never fix; the item stays visible as failed. */
const PERMANENT_CODES: ReadonlySet<string> = new Set([
  'FORBIDDEN',
  'VALIDATION',
  'UNAUTHORIZED',
  'NOT_FOUND',
  'UNSUPPORTED_OPERATION',
])

function isPermanent(error: unknown): boolean {
  return error instanceof MemoryError && PERMANENT_CODES.has(error.code)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Run the drain to exhaustion, `limit`, or an external stop signal. */
export async function drainQueue(options: DrainOptions): Promise<DrainSummary> {
  const now = options.now ?? Date.now
  const started = now()
  const shouldStop = options.shouldStop ?? (() => false)
  const limit = options.limit ?? Number.POSITIVE_INFINITY
  const workers = Math.max(1, Math.min(options.workers ?? 2, options.targets.length))
  const batchSize = Math.max(1, Math.floor(options.batchSize ?? 1))
  const byTarget: Record<string, number> = {}
  let processed = 0
  let failed = 0
  let stopped = false
  let batches = 0

  // Retry backoff (`resilience.sleep`) unrefs its timer so a plugin request
  // never pins the host process open. In a standalone drain that means a
  // transient failure mid-retry can empty the event loop and exit 0 while the
  // worker still awaits — the item stays `inflight` and the timer silently does
  // nothing. One ref'd keeper for the duration of the drain prevents that.
  const keepAlive = setInterval(() => {}, 1_000)

  /** Resolve one item, optionally after a batch already reported it failed. */
  const writeOne = async (
    target: DrainTarget,
    item: QueueItem,
    reported?: { readonly ok: false; readonly error: string; readonly permanent?: boolean },
  ): Promise<void> => {
    const at = now()
    try {
      await target.write(item)
      options.queue.markDone(item.id)
      processed += 1
      byTarget[target.name] = (byTarget[target.name] ?? 0) + 1
      options.onEvent?.({ type: 'done', id: item.id, target: target.name, ms: now() - at })
    } catch (error) {
      failed += 1
      const message = messageOf(error)
      // A refused payload (authz/validation/4xx) will never succeed: keep it
      // visible as failed instead of retrying it every night forever.
      const permanent = isPermanent(error) || reported?.permanent === true
      options.queue.markFailed(item.id, message, { permanent })
      options.onEvent?.({ type: 'failed', id: item.id, target: target.name, error: message })
    }
  }

  const runWorker = async (target: DrainTarget): Promise<void> => {
    const writeBatch = target.writeBatch
    for (;;) {
      const settled = processed + failed
      if (settled >= limit) return
      if (shouldStop()) {
        stopped = true
        return
      }
      const remaining = Number.isFinite(limit) ? Math.floor(limit - settled) : batchSize
      const want = writeBatch === undefined ? 1 : Math.max(1, Math.min(batchSize, remaining))
      const claimed = options.queue.claim({ limit: want, workerId: target.name })
      const first = claimed[0]
      if (first === undefined) {
        options.onEvent?.({ type: 'idle', target: target.name })
        return
      }

      if (writeBatch === undefined || claimed.length === 1) {
        await writeOne(target, first)
        continue
      }

      // Batched path: one backend call for the whole claim, then resolve every
      // item. A batch-level throw degrades to per-item writes, never lost work.
      batches += 1
      const at = now()
      let results: readonly DrainItemResult[]
      try {
        results = await writeBatch(claimed)
      } catch {
        results = []
      }
      const elapsed = now() - at
      for (let index = 0; index < claimed.length; index += 1) {
        const item = claimed[index]
        if (item === undefined) continue
        const result = results[index] ?? { ok: false as const, error: 'batch result missing' }
        if (result.ok) {
          options.queue.markDone(item.id)
          processed += 1
          byTarget[target.name] = (byTarget[target.name] ?? 0) + 1
          options.onEvent?.({
            type: 'done',
            id: item.id,
            target: target.name,
            ms: elapsed,
            batch: claimed.length,
          })
          continue
        }
        // Per-item failure isolation: retry alone so the batch's neighbours keep
        // their single pipeline run and the poison item gets its own verdict.
        await writeOne(target, item, result)
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
    batchSize,
    batches,
    byTarget,
  }
}
