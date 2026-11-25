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
import {
  appendFileSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MemoryScope } from '../types.js'

/** Queue log format version, stamped on the first line. */
export const QUEUE_VERSION = 1 as const
/** Environment override for the queue log path. */
export const QUEUE_PATH_ENV = 'COGNEE_MEMORY_QUEUE_FILE'

export type QueueState = 'pending' | 'inflight' | 'done' | 'failed'

/**
 * What kind of task this is. `turn` (the default when absent on older rows) is
 * one part of a conversation; `summary` is one rendered segment-summary
 * document, which the drain writes like prose but with its own provenance. The
 * kind never changes the lifecycle: leases, tombstones, retries and dedupe are
 * shared.
 */
export type QueueKind = 'turn' | 'summary'

/** Where a queued chunk came from. Kept for provenance, never used for routing. */
export interface QueueSource {
  readonly sessionId?: string
  readonly turnIndex?: number
  readonly role?: 'user' | 'assistant' | 'system'
  readonly timestamp?: string
  readonly projectId?: string
  /** Part index and count when one long message was split into tasks. */
  readonly partIndex?: number
  readonly partOf?: number
}

/** One queued unit of ingest. */
export interface QueueItem {
  readonly id: string
  readonly contentHash: string
  readonly scope: string
  readonly text: string
  readonly source: QueueSource
  /** `summary` for a rendered segment summary; absent means `turn`. */
  readonly kind?: QueueKind
  readonly state: QueueState
  readonly attempts: number
  /** Epoch ms before which a `failed` item must not be retried. */
  readonly nextAttemptAt: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly lastError?: string
  readonly endpoint?: string
  /**
   * Set when the failure is not retryable (authz, validation, a payload the
   * backend refuses). The item stays visible as `failed` and is never claimed
   * again, instead of disappearing or burning a retry every night.
   */
  readonly permanent?: boolean
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
  /**
   * `fdatasync` every appended line. On for the turn journal: a power cut must
   * not cost the last conversation turn (a torn trailing line is skipped by
   * the fold, which is only safe if the line that was acknowledged is durable).
   */
  readonly syncWrites?: boolean
  /** How long a completed item's hash stays in the dedupe tombstone set. */
  readonly tombstoneRetentionMs?: number
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

/** Stable hash over scope, an optional identity seed, and normalized text. */
export function contentHashOf(scope: string, text: string, dedupeKey?: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  const seed = dedupeKey === undefined || dedupeKey === '' ? '' : `${dedupeKey}\u0000`
  return createHash('sha256').update(`${scope}\u0000${seed}${normalized}`).digest('hex')
}

/** Sleep without a timer handle, so a sync lock wait cannot outlive the caller. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
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
  /** Task kind; defaults to `turn` when omitted. */
  readonly kind?: QueueKind
  /**
   * Identity seed mixed into the content hash. The turn journal uses
   * `session:turn:seq:role:part` so two identical messages ("continue") stay
   * two tasks, while a replayed journal line still dedupes.
   */
  readonly dedupeKey?: string
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
  private readonly syncWrites: boolean
  private readonly tombstoneRetentionMs: number
  private readonly items: Map<string, QueueItem>
  private readonly byHash: Map<string, string>
  private readonly completedHashes: Map<string, number>
  private lines: number
  /** True while this instance holds the cross-process writer lock. */
  private locked = false

  private constructor(options: QueueOptions, folded: Folded) {
    this.filePath = options.filePath
    this.now = options.now ?? Date.now
    this.backoff = options.backoff ?? DEFAULT_BACKOFF
    this.leaseMs = options.leaseMs ?? DEFAULT_LEASE_MS
    this.syncWrites = options.syncWrites ?? false
    this.tombstoneRetentionMs = options.tombstoneRetentionMs ?? 30 * 24 * 60 * 60_000
    this.items = folded.items
    this.lines = folded.lines
    this.byHash = new Map()
    for (const item of this.items.values()) this.byHash.set(item.contentHash, item.id)
    this.completedHashes = new Map()
    for (const [hash, at] of this.tombstones()) this.completedHashes.set(hash, at)
  }

  /** Path of the completed-hash tombstone log (kept out of the task list). */
  get tombstonePath(): string {
    return `${this.filePath}.done`
  }

  private tombstones(): Array<[string, number]> {
    if (!existsSync(this.tombstonePath)) return []
    const entries: Array<[string, number]> = []
    try {
      for (const line of readFileSync(this.tombstonePath, 'utf8').split('\n')) {
        if (line.trim() === '') continue
        const record = JSON.parse(line) as { hash?: unknown; at?: unknown }
        if (typeof record.hash !== 'string') continue
        entries.push([record.hash, typeof record.at === 'number' ? record.at : 0])
      }
    } catch {
      return []
    }
    return entries
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

  /**
   * Take the cross-process writer lock. The journal (web process) and the
   * nightly drainer (CLI) both append and the drainer rewrites the log when it
   * prunes; a lock is what keeps a prune from discarding a concurrent append.
   */
  private withLock<T>(fn: () => T): T {
    // Re-entrant for one instance: a prune/compact calls append() while it
    // already holds the file lock, and taking it twice would deadlock.
    if (this.locked) return fn()
    const lockPath = `${this.filePath}.lock`
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
        if (Date.now() >= deadline) throw new Error(`queue lock timeout: ${lockPath}`)
        sleepSync(25)
      }
    }
    this.locked = true
    try {
      return fn()
    } finally {
      this.locked = false
      try {
        unlinkSync(lockPath)
      } catch {
        // Another process already removed a stale lock.
      }
    }
  }

  /**
   * Append one line under the writer lock. The lock matters even though each
   * write is a single O_APPEND: a concurrent prune/compact renames a fresh file
   * over the log, and an append that opened the old inode around that rename
   * would land in an unlinked file and vanish.
   */
  private append(item: QueueItem): void {
    if (this.locked) {
      this.appendNow(item)
      return
    }
    this.withLock(() => this.appendNow(item))
  }

  private appendNow(item: QueueItem): void {
    const line = `${JSON.stringify(item)}\n`
    if (this.syncWrites) {
      const fd = openSync(this.filePath, 'a', 0o600)
      try {
        writeSync(fd, line)
        fsyncSync(fd)
      } finally {
        closeSync(fd)
      }
    } else {
      appendFileSync(this.filePath, line, { encoding: 'utf8', mode: 0o600 })
    }
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
    const pendingItems: QueueItem[] = []
    for (const entry of entries) {
      const text = entry.text.trim()
      if (text === '') continue
      const contentHash = contentHashOf(entry.scope, text, entry.dedupeKey)
      if (this.byHash.has(contentHash) || this.completedHashes.has(contentHash)) {
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
        ...(entry.kind === undefined ? {} : { kind: entry.kind }),
        ...(entry.scopeRef === undefined ? {} : { scopeRef: entry.scopeRef }),
        state: 'pending',
        attempts: 0,
        nextAttemptAt: 0,
        createdAt: stamp,
        updatedAt: stamp,
      }
      if (options.dryRun !== true) {
        pendingItems.push(item)
        this.byHash.set(contentHash, id)
      }
      ids.push(id)
      added += 1
    }
    if (pendingItems.length > 0) {
      this.withLock(() => {
        for (const item of pendingItems) this.append(item)
      })
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
      else if (
        item.state === 'failed' &&
        item.permanent !== true &&
        item.nextAttemptAt <= now &&
        item.attempts < this.backoff.maxAttempts
      ) {
        due.push(item)
      }
      if (due.length >= limit) break
    }
    due.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    const claimed: QueueItem[] = []
    this.withLock(() => {
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
    })
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

  /**
   * Record a failure. Retryable errors go back to `pending` with exponential
   * backoff and, when `maxAttempts` is Infinity, retry forever. Permanent
   * errors (authz/validation/a payload the backend refuses) stay visible as
   * `failed` and are never claimed again.
   */
  markFailed(id: string, error: string, options: { readonly permanent?: boolean } = {}): void {
    const permanent = options.permanent === true
    this.transition(id, (item) => {
      const terminal = permanent || item.attempts >= this.backoff.maxAttempts
      const updatedAt = new Date(this.now()).toISOString()
      return {
        ...item,
        state: terminal ? 'failed' : 'pending',
        lastError: error.slice(0, 300),
        nextAttemptAt: terminal ? 0 : this.now() + backoffDelayMs(item.attempts, this.backoff),
        updatedAt,
        ...(permanent ? { permanent: true } : {}),
      }
    })
    this.maybeCompact()
  }

  /**
   * Fold the on-disk log into this instance before a rewrite. The drainer and
   * the journal are separate processes: rows appended by the other one after
   * this process opened are invisible here, and pruning from a stale snapshot
   * deleted them (the 1.0.8 varad summary loss). Newest `updatedAt` wins for
   * rows both sides know about.
   */
  private absorbDisk(): void {
    const folded = fold(this.filePath)
    for (const item of folded.items.values()) {
      const mine = this.items.get(item.id)
      if (mine === undefined || item.updatedAt > mine.updatedAt) {
        this.items.set(item.id, item)
        this.byHash.set(item.contentHash, item.id)
      }
    }
    this.lines = Math.max(this.lines, folded.lines)
  }

  /**
   * Remove fully-ingested tasks from the log and remember their hashes so a
   * replay stays idempotent. This is the "removed only once completely
   * ingested" half of the task lifecycle: pending, inflight and failed rows
   * survive, `done` rows do not.
   *
   * The rewrite re-reads the log under the writer lock and carries over every
   * row this process has not seen, so a concurrent append is never dropped.
   */
  pruneDone(): { readonly removed: number; readonly remaining: number } {
    const hasDone = [...this.items.values()].some((item) => item.state === 'done')
    if (!hasDone) return { removed: 0, remaining: this.items.size }
    return this.withLock(() => {
      this.absorbDisk()
      const done = [...this.items.values()].filter((item) => item.state === 'done')
      if (done.length === 0) return { removed: 0, remaining: this.items.size }
      const stamp = this.now()
      for (const item of done) {
        this.completedHashes.set(item.contentHash, stamp)
        this.items.delete(item.id)
        this.byHash.delete(item.contentHash)
      }
      const body = [...this.items.values()].map((item) => JSON.stringify(item)).join('\n')
      const temporary = `${this.filePath}.tmp-${process.pid}`
      writeFileSync(temporary, body === '' ? '' : `${body}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.filePath)
      this.lines = this.items.size
      // Another process may have tombstoned rows since this one opened; keep
      // its entries so a replay stays idempotent across writers.
      for (const [hash, at] of this.tombstones()) {
        if (!this.completedHashes.has(hash)) this.completedHashes.set(hash, at)
      }
      const cutoff = stamp - this.tombstoneRetentionMs
      const kept = [...this.completedHashes.entries()].filter((entry) => entry[1] >= cutoff)
      this.completedHashes.clear()
      for (const [hash, at] of kept) this.completedHashes.set(hash, at)
      writeFileSync(
        this.tombstonePath,
        kept.map(([hash, at]) => JSON.stringify({ hash, at })).join('\n') + (kept.length === 0 ? '' : '\n'),
        { encoding: 'utf8', mode: 0o600 },
      )
      return { removed: done.length, remaining: this.items.size }
    })
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
      if (item.state === 'pending' || (item.state === 'failed' && item.permanent !== true)) {
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
   * Atomic *and* lossless: it holds the writer lock and folds the on-disk log
   * first, so rows another process appended since this one opened survive.
   */
  compact(): { readonly before: number; readonly after: number } {
    return this.withLock(() => {
      const before = this.lines
      this.absorbDisk()
      const body = [...this.items.values()].map((item) => JSON.stringify(item)).join('\n')
      const temporary = `${this.filePath}.tmp-${process.pid}`
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      writeFileSync(temporary, body === '' ? '' : `${body}\n`, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.filePath)
      this.lines = this.items.size
      return { before, after: this.items.size }
    })
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

/** A read-only view of the queue as it is on disk right now. */
export interface QueueSnapshot {
  readonly status: QueueStatus
  readonly items: readonly QueueItem[]
}

/**
 * Fold the log without opening the queue: no lease release, no writes. The
 * settings page uses this so a task pruned by the drainer disappears from the
 * list immediately instead of waiting for the web process to restart.
 */
export function readQueueSnapshot(filePath: string, now = Date.now()): QueueSnapshot {
  const folded = fold(filePath)
  const items = [...folded.items.values()]
  const counts: Record<QueueState, number> = { pending: 0, inflight: 0, done: 0, failed: 0 }
  let dueNow = 0
  let oldestPending: string | undefined
  for (const item of items) {
    counts[item.state] += 1
    if (item.state === 'pending' || (item.state === 'failed' && item.permanent !== true)) {
      if (item.nextAttemptAt <= now) dueNow += 1
    }
    if (item.state === 'pending' && (oldestPending === undefined || item.createdAt < oldestPending)) {
      oldestPending = item.createdAt
    }
  }
  return {
    status: {
      filePath,
      total: items.length,
      counts,
      dueNow,
      ...(oldestPending === undefined ? {} : { oldestPendingAt: oldestPending }),
      lines: folded.lines,
    },
    items,
  }
}

/** Count lines without opening the queue, for cheap `--status` output. */
export function queueLineCountFor(filePath: string): number {
  return queueLineCount(filePath)
}
