/**
 * Durable ingest queue for the nightly cognify pipeline.
 *
 * Storage is an append-only JSONL log folded last-write-wins by item id. Every
 * mutation is a single `appendFileSync` of one line, so a kill -9 at any point
 * leaves at most one torn trailing line, which the loader skips. Nothing is
 * rewritten in place except during {@link IngestQueue.compact}, which writes a
 * temp file and renames it over the log.
 *
 * Idempotency is by content hash over `scope + normalized text`: enqueueing the
 * same turn twice (a resumed backfill, an overlapping timer) is a no-op that
 * reports `duplicates`.
 *
 * Interruption safety: a claimed item is `inflight` with a lease. `open()`
 * returns every lease older than `leaseMs` to `pending`, so a worker killed
 * mid-drain resumes instead of losing work or double-counting it as done.
 */
import { createHash, randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MemoryScope } from '../types.js'

/** Queue log format version, stamped on the first line. */
export const QUEUE_VERSION = 1 as const
/** Environment override for the queue log path. */
export const QUEUE_PATH_ENV = 'COGNEE_MEMORY_QUEUE_FILE'

export type QueueState = 'pending' | 'inflight' | 'done' | 'failed'

/** Where a queued chunk came from. Kept for provenance, never used for routing. */
export interface QueueSource {
  readonly sessionId?: string
  readonly turnIndex?: number
  readonly role?: 'user' | 'assistant' | 'system'
  readonly timestamp?: string
  readonly projectId?: string
}

/** One queued unit of ingest. */
export interface QueueItem {
  readonly id: string
  readonly contentHash: string
  readonly scope: string
  readonly text: string
  readonly source: QueueSource
  readonly state: QueueState
  readonly attempts: number
  /** Epoch ms before which a `failed` item must not be retried. */
  readonly nextAttemptAt: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastError?: string
  readonly endpoint?: string
  /** Scope coordinates, so a drain can rebuild the write identity exactly. */
  readonly scopeRef?: { readonly scope: MemoryScope; readonly id: string }
}

/** Retry policy for a failed ingest. */
export interface BackoffPolicy {
  readonly baseMs: number
  readonly capMs: number
  readonly maxAttempts: number
}

export const DEFAULT_BACKOFF: BackoffPolicy = Object.freeze({
  baseMs: 30_000,
  capMs: 60 * 60_000,
  maxAttempts: 6,
})

/** Default lease; a worker that dies holding an item releases it after this. */
export const DEFAULT_LEASE_MS = 15 * 60_000

export interface QueueOptions {
  readonly filePath: string
  readonly now?: () => number
  readonly backoff?: BackoffPolicy
  readonly leaseMs?: number
}

/** Newest-wins map of the log, plus bookkeeping for compaction. */
interface Folded {
  readonly items: Map<string, QueueItem>
  lines: number
}

function queueLineCount(filePath: string): number {
  if (!existsSync(filePath)) return 0
  try {
    return readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim() !== '').length
  } catch {
    return 0
  }
}

/** Stable hash over scope and whitespace-normalized text. */
export function contentHashOf(scope: string, text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return createHash('sha256').update(`${scope}\u0000${normalized}`).digest('hex')
}

export function resolveQueuePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[QUEUE_PATH_ENV]?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'plugins', 'cognee-memory', 'ingest-queue.jsonl')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function asItem(value: unknown): QueueItem | undefined {
  if (!isRecord(value)) return undefined
  const { id, contentHash, scope, text, state } = value
  if (typeof id !== 'string' || typeof contentHash !== 'string') return undefined
  if (typeof scope !== 'string' || typeof text !== 'string') return undefined
  if (state !== 'pending' && state !== 'inflight' && state !== 'done' && state !== 'failed') return undefined
  return value as unknown as QueueItem
}

function fold(filePath: string): Folded {
  const items = new Map<string, QueueItem>()
  if (!existsSync(filePath)) return { items, lines: 0 }
  let lines = 0
  let body: string
  try {
    body = readFileSync(filePath, 'utf8')
  } catch {
    return { items, lines: 0 }
  }
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    lines += 1
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // A torn trailing line from an interrupted append: drop it.
      continue
    }
    if (isRecord(parsed) && parsed.queueVersion !== undefined) continue
    const item = asItem(parsed)
    if (item !== undefined) items.set(item.id, item)
  }
  return { items, lines }
}

/** Exponential backoff with a cap, jitter-free so runs are reproducible. */
export function backoffDelayMs(attempts: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  const exponent = Math.max(0, attempts - 1)
  return Math.min(policy.capMs, policy.baseMs * 2 ** exponent)
}

export interface EnqueueEntry {
  readonly text: string
  readonly scope: string
  readonly source?: QueueSource
  readonly scopeRef?: { readonly scope: MemoryScope; readonly id: string }
}

export interface EnqueueReport {
  readonly added: number
  readonly duplicates: number
  readonly ids: readonly string[]
}

export interface ClaimOptions {
  readonly limit: number
  readonly workerId: string
}

export interface QueueStatus {
  readonly filePath: string
  readonly total: number
  readonly counts: Readonly<Record<QueueState, number>>
  readonly dueNow: number
  readonly nextAttemptAt?: string
  readonly oldestPendingAt?: string
  readonly lines: number
}

export class IngestQueue {
  readonly filePath: string
  private readonly now: () => number
  private readonly backoff: BackoffPolicy
  private readonly leaseMs: number
  private readonly items: Map<string, QueueItem>
  private readonly byHash: Map<string, string>
  private lines: number

  private constructor(options: QueueOptions, folded: Folded) {
    this.filePath = options.filePath
    this.now = options.now ?? Date.now
    this.backoff = options.backoff ?? DEFAULT_BACKOFF
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.items = folded.items
    this.lines = folded.lines
    this.byHash = new Map()
    for (const item of this.items.values()) this.byHash.set(item.contentHash, item.id)
  }

  /**
   * Open the queue, returning stale leases to `pending`. Call this once per
   * worker process; a second process draining concurrently would race the log,
   * which is why the systemd unit never runs two drains.
   */
  static open(options: QueueOptions): IngestQueue {
    mkdirSync(dirname(options.filePath), { recursive: true, mode: 0o700 })
    const folded = fold(options.filePath)
    const queue = new IngestQueue(options, folded)
    queue.releaseStale()
    return queue
  }

  private append(item: QueueItem): void {
    appendFileSync(this.filePath, `${JSON.stringify(item)}\n`, { encoding: 'utf8', mode: 0o600 })
    this.lines += 1
    this.items.set(item.id, item)
  }

  private releaseStale(): void {
    const cutoff = this.now() - this.leaseMs
    for (const item of [...this.items.values()]) {
      if (item.state !== 'inflight') continue
      if (Date.parse(item.updatedAt) > cutoff) continue
      this.append({
        ...item,
        state: 'pending',
        updatedAt: new Date(this.now()).toISOString(),
        lastError: 'lease expired; requeued',
      })
    }
  }

  /** Add chunks, skipping any whose content hash is already queued or done. */
  enqueue(entries: readonly EnqueueEntry[], options: { readonly dryRun?: boolean } = {}): EnqueueReport {
    const ids: string[] = []
    let added = 0
    let duplicates = 0
    const stamp = new Date(this.now()).toISOString()
    for (const entry of entries) {
      const text = entry.text.trim()
      if (text === '') continue
      const contentHash = contentHashOf(entry.scope, text)
      if (this.byHash.has(contentHash)) {
        duplicates += 1
        continue
      }
      const id = randomUUID()
      const item: QueueItem = {
        id,
        contentHash,
        scope: entry.scope,
        text,
        source: entry.source ?? {},
        ...(entry.scopeRef === undefined ? {} : { scopeRef: entry.scopeRef }),
        state: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: stamp,
        updatedAt: stamp,
      }
      if (options.dryRun !== true) {
        this.append(item)
        this.byHash.set(contentHash, id)
      }
      ids.push(id)
      added += 1
    }
    return { added, duplicates, ids }
  }

  /**
   * Lease up to `limit` due items to one worker. Attempts are incremented at
   * claim time, so a crash mid-flight still counts against the retry budget.
   */
  claim({ limit, workerId }: ClaimOptions): QueueItem[] {
    const now = this.now()
    const due: QueueItem[] = []
    for (const item of this.items.values()) {
      if (item.state === 'pending' && item.nextAttemptAt <= now) due.push(item)
      else if (item.state === 'failed' && item.nextAttemptAt <= now && item.attempts < this.backoff.maxAttempts) {
        due.push(item)
      }
      if (due.length >= limit) break
    }
    due.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const claimed: QueueItem[] = []
    for (const item of due) {
      const updated: QueueItem = {
        ...item,
        state: 'inflight',
        attempts: item.attempts + 1,
        updatedAt: new Date(now).toISOString(),
        endpoint: workerId,
      }
      this.append(updated)
      claimed.push(updated)
    }
    return claimed
  }

  markDone(id: string): void {
    this.transition(id, (item) => ({
      ...item,
      state: 'done',
      updatedAt: new Date(this.now()).toISOString(),
      nextAttemptAt: 0,
    }))
    this.maybeCompact()
  }

  /** Record a failure; terminal after `maxAttempts`, otherwise scheduled backoff. */
  markFailed(id: string, error: string): void {
    this.transition(id, (item) => {
      const terminal = item.attempts >= this.backoff.maxAttempts
      const updatedAt = new Date(this.now()).toISOString()
      return {
        ...item,
        state: terminal ? 'failed' : 'pending',
        lastError: error.slice(0, 300),
        nextAttemptAt: terminal ? 0 : this.now() + backoffDelayMs(item.attempts, this.backoff),
        updatedAt,
      }
    })
    this.maybeCompact()
  }

  private transition(id: string, update: (item: QueueItem) => QueueItem): void {
    const current = this.items.get(id)
    if (current === undefined) return
    this.append(update(current))
  }

  get(id: string): QueueItem | undefined {
    return this.items.get(id)
  }

  status(): QueueStatus {
    const counts: Record<QueueState, number> = { pending: 0, inflight: 0, done: 0, failed: 0 }
    let dueNow = 0
    let next: number | undefined
    let oldestPending: string | undefined
    const now = this.now()
    for (const item of this.items.values()) {
      counts[item.state] += 1
      if (item.state === 'pending' || item.state === 'failed') {
        if (item.nextAttemptAt <= now) dueNow += 1
        else if (next === undefined || item.nextAttemptAt < next) next = item.nextAttemptAt
        if (item.state === 'pending' && (oldestPending === undefined || item.createdAt < oldestPending)) {
          oldestPending = item.createdAt
        }
      }
    }
    return {
      filePath: this.filePath,
      total: this.items.size,
      counts,
      dueNow,
      ...(next === undefined ? {} : { nextAttemptAt: new Date(next).toISOString() }),
      ...(oldestPending === undefined ? {} : { oldestPendingAt: oldestPending }),
      lines: this.lines,
    }
  }

  /**
   * Rewrite the log with one line per live item once it is mostly history.
   * Atomic: temp file plus rename, so an interrupted compaction keeps the
   * original log intact and loses nothing.
   */
  compact(): { readonly before: number; readonly after: number } {
    const before = this.lines
    const body = [...this.items.values()].map((item) => JSON.stringify(item)).join('\n')
    const temporary = `${this.filePath}.tmp-${process.pid}`
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    writeFileSync(temporary, body === '' ? '' : `${body}\n`, { encoding: 'utf8', mode: 0o600 })
    renameSync(temporary, this.filePath)
    this.lines = this.items.size
    return { before, after: this.items.size }
  }

  private maybeCompact(): void {
    if (this.lines > Math.max(256, this.items.size * 4)) this.compact()
  }

  /** Live items, for status/JSON reporting. */
  list(state?: QueueState): QueueItem[] {
    const all = [...this.items.values()]
    return (state === undefined ? all : all.filter((item) => item.state === state)).sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    )
  }
}

/** Count lines without opening the queue, for cheap `--status` output. */
export function queueLineCountFor(filePath: string): number {
  return queueLineCount(filePath)
}
