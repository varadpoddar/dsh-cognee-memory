import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isMemoryError } from '../errors.js'
import { findSecrets } from '../security/redaction.js'
import type { Metrics } from '../telemetry/metrics.js'

/**
 * Durable write outbox (Milestone 5).
 *
 * One append-only JSONL file records every write operation and each state
 * transition. Folding the log by `operationId` gives the current state, so a
 * crash between "sent the write" and "recorded the result" leaves the operation
 * `processing` and `recover()` re-queues it once its lease expires.
 *
 * States: `pending` → `processing` → `complete` | `failed`.
 * `failed` keeps `attempts`, `reason` (an error code only) and `retryable`.
 * Transient failures get an exponential `nextAttemptAt`; permanent failures
 * (authorization, validation, redaction) are terminal on the first attempt.
 *
 * A write is only reported complete with a non-empty `dataRef` — the Cognee
 * record reference returned after the adapter confirmed ingestion (searchable
 * + DATASET_PROCESSING_COMPLETED). A 2xx without that proof is a failure.
 *
 * UI state vocabulary used by the settings page maps as follows:
 *   candidate/approved  → the candidate spool (not yet an operation)
 *   queued              → pending
 *   ingesting           → processing
 *   indexed             → complete
 *   failed              → failed
 *   recall-verified / superseded / deleted are derived from read-side evidence.
 */

export type OutboxState = 'pending' | 'processing' | 'complete' | 'failed'
export type OutboxOperationKind = 'remember' | 'forget'

export interface OutboxOperation {
  readonly operationId: string
  readonly idempotencyKey: string
  readonly dataset: string
  readonly operation: OutboxOperationKind
  readonly content: string
  readonly candidateVersion: number
  readonly state: OutboxState
  readonly attempts: number
  readonly createdAt: string
  readonly updatedAt: string
  readonly reason?: string
  readonly retryable?: boolean
  readonly nextAttemptAt?: number
  readonly dataRef?: string
}

export interface OutboxEnqueueInput {
  readonly idempotencyKey: string
  readonly dataset: string
  readonly operation: OutboxOperationKind
  readonly content: string
  readonly candidateVersion?: number
}

export interface OutboxStatus {
  readonly pending: number
  readonly processing: number
  readonly complete: number
  readonly failed: number
  readonly total: number
  /** Bounded, secret-free view for the settings page (newest 50). */
  readonly operations: readonly OutboxOperationView[]
}

export interface OutboxOperationView {
  readonly operationId: string
  readonly operation: OutboxOperationKind
  readonly dataset: string
  readonly state: OutboxState
  readonly attempts: number
  readonly reason?: string
  readonly dataRef?: string
  readonly updatedAt: string
}

export type OutboxSinkResult =
  | { readonly status: 'complete'; readonly dataRef: string }
  | { readonly status: 'failed'; readonly reason: string; readonly retryable: boolean }

export interface OutboxOptions {
  readonly dir: string
  readonly maxAttempts?: number
  readonly baseBackoffMs?: number
  readonly maxBackoffMs?: number
  readonly leaseMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly metrics?: Metrics
}

export interface OutboxDrainResult {
  readonly processed: number
  readonly completed: number
  readonly failed: number
}

const PERMANENT_CODES = new Set([
  'CONFIG',
  'VALIDATION',
  'UNAUTHORIZED',
  'FORBIDDEN',
  'UNSUPPORTED_OPERATION',
  'REDACTION_BLOCKED',
  'DISABLED',
])

const PERMANENT_HINTS = /auth|forbid|unauthor|permission|credential|validation|invalid|redact|schema|unsupported/i

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function operationIdFor(idempotencyKey: string, candidateVersion: number): string {
  return `op-${createHash('sha256').update(`${idempotencyKey}\u0000${candidateVersion}`).digest('hex').slice(0, 32)}`
}

function isOperation(value: unknown): value is OutboxOperation {
  if (!isRecord(value)) return false
  return (
    typeof value.operationId === 'string' &&
    typeof value.idempotencyKey === 'string' &&
    typeof value.dataset === 'string' &&
    typeof value.content === 'string' &&
    (value.operation === 'remember' || value.operation === 'forget') &&
    typeof value.candidateVersion === 'number' &&
    (value.state === 'pending' ||
      value.state === 'processing' ||
      value.state === 'complete' ||
      value.state === 'failed') &&
    typeof value.attempts === 'number' &&
    typeof value.createdAt === 'string' &&
    typeof value.updatedAt === 'string'
  )
}

export class Outbox {
  private readonly dir: string
  private readonly file: string
  private readonly maxAttempts: number
  private readonly baseBackoffMs: number
  private readonly maxBackoffMs: number
  private readonly leaseMs: number
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly metrics: Metrics | undefined
  private chain: Promise<unknown> = Promise.resolve()

  constructor(options: OutboxOptions) {
    this.dir = options.dir
    this.file = path.join(options.dir, 'outbox.jsonl')
    this.maxAttempts = options.maxAttempts ?? 3
    this.baseBackoffMs = options.baseBackoffMs ?? 500
    this.maxBackoffMs = options.maxBackoffMs ?? 30_000
    this.leaseMs = options.leaseMs ?? 60_000
    this.now = options.now ?? Date.now
    this.sleep =
      options.sleep ??
      ((ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms)
          ;(timer as { unref?: () => void }).unref?.()
        }))
    this.metrics = options.metrics
  }

  get filePath(): string {
    return this.file
  }

  private iso(): string {
    return new Date(this.now()).toISOString()
  }

  private backoffFor(attempts: number): number {
    const delay = this.baseBackoffMs * 2 ** Math.max(0, attempts - 1)
    return Math.min(this.maxBackoffMs, Math.max(this.baseBackoffMs, delay))
  }

  private async ensureDir(): Promise<void> {
    await fs.mkdir(this.dir, { recursive: true, mode: 0o700 })
    try {
      const handle = await fs.open(this.file, 'a', 0o600)
      await handle.close()
      await fs.chmod(this.file, 0o600)
    } catch {
      // A read-only or racing filesystem still surfaces on the write itself.
    }
  }

  private async fold(): Promise<OutboxOperation[]> {
    let text: string
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch {
      return []
    }
    const latest = new Map<string, OutboxOperation>()
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        const value = isRecord(parsed) && parsed.type === 'operation' ? parsed.operation : parsed
        if (!isOperation(value)) continue
        latest.set(value.operationId, value)
      } catch {
        // A truncated line from a crash is ignored; it never blocks replay.
      }
    }
    return [...latest.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
  }

  private async append(operation: OutboxOperation): Promise<void> {
    await fs.appendFile(
      this.file,
      `${JSON.stringify({ type: 'operation', operation })}\n`,
      { encoding: 'utf8', mode: 0o600 },
    )
  }

  async enqueue(input: OutboxEnqueueInput): Promise<{
    readonly accepted: boolean
    readonly operationId: string
    readonly reason?: 'duplicate' | 'secret'
  }> {
    const candidateVersion = input.candidateVersion ?? 1
    const operationId = operationIdFor(input.idempotencyKey, candidateVersion)
    if (findSecrets(input.content).length > 0) {
      return { accepted: false, operationId, reason: 'secret' }
    }
    if (input.idempotencyKey.trim() === '' || input.dataset.trim() === '') {
      throw new Error('outbox enqueue requires idempotencyKey and dataset')
    }
    const existing = await this.fold()
    if (existing.some((operation) => operation.operationId === operationId)) {
      return { accepted: false, operationId, reason: 'duplicate' }
    }
    const at = this.iso()
    await this.ensureDir()
    await this.append({
      operationId,
      idempotencyKey: input.idempotencyKey,
      dataset: input.dataset,
      operation: input.operation,
      content: input.content,
      candidateVersion,
      state: 'pending',
      attempts: 0,
      createdAt: at,
      updatedAt: at,
    })
    this.metrics?.increment('outbox.enqueued')
    return { accepted: true, operationId }
  }

  /**
   * Startup recovery: a `processing` entry whose lease expired belongs to a
   * process that died before recording an outcome. Re-queue it. Safe to call
   * repeatedly; only expired leases move.
   */
  async recover(): Promise<{ readonly recovered: number }> {
    await this.ensureDir()
    const operations = await this.fold()
    let recovered = 0
    for (const operation of operations) {
      if (operation.state !== 'processing') continue
      if (this.now() - Date.parse(operation.updatedAt) < this.leaseMs) continue
      await this.append({
        ...operation,
        state: 'pending',
        updatedAt: this.iso(),
      })
      recovered += 1
    }
    if (recovered > 0) this.metrics?.increment('outbox.recovered', recovered)
    return { recovered }
  }

  private isDue(operation: OutboxOperation, now: number): boolean {
    if (operation.state === 'pending') return true
    if (operation.state !== 'failed') return false
    if (operation.retryable !== true) return false
    if (operation.attempts >= this.maxAttempts) return false
    return (operation.nextAttemptAt ?? 0) <= now
  }

  private classify(error: unknown): OutboxSinkResult {
    if (isMemoryError(error)) {
      const permanent = PERMANENT_CODES.has(error.code) || !error.retryable
      return { status: 'failed', reason: error.code, retryable: !permanent }
    }
    const message = error instanceof Error ? error.message : String(error)
    return {
      status: 'failed',
      reason: PERMANENT_HINTS.test(message) ? 'PERMANENT' : 'INTERNAL',
      retryable: !PERMANENT_HINTS.test(message),
    }
  }

  /**
   * Drive every due operation through `sink`, serially. Transient failures
   * schedule an exponential backoff; when the wait fits in `maxWaitMs` this
   * same call sleeps and retries, otherwise the operation stays `failed` with
   * `retryable: true` for the next drain or process.
   */
  async drain(
    sink: (operation: OutboxOperation) => Promise<OutboxSinkResult>,
    options: { readonly maxWaitMs?: number } = {},
  ): Promise<OutboxDrainResult> {
    const run = async (): Promise<OutboxDrainResult> => {
      await this.ensureDir()
      const maxWaitMs = options.maxWaitMs ?? 5_000
      let processed = 0
      let completed = 0
      let failed = 0
      for (;;) {
        const now = this.now()
        const operations = await this.fold()
        const due = operations.filter((operation) => this.isDue(operation, now))
        if (due.length === 0) {
          const waiting = operations.filter(
            (operation) =>
              operation.state === 'failed' &&
              operation.retryable === true &&
              operation.attempts < this.maxAttempts &&
              (operation.nextAttemptAt ?? 0) > now,
          )
          if (waiting.length === 0) break
          const delay = Math.min(...waiting.map((operation) => (operation.nextAttemptAt ?? 0) - now))
          if (delay > maxWaitMs) break
          await this.sleep(Math.max(1, delay))
          continue
        }
        const operation = due[0] as OutboxOperation
        processed += 1
        const attempted: OutboxOperation = {
          ...operation,
          state: 'processing',
          attempts: operation.attempts + 1,
          updatedAt: this.iso(),
        }
        delete (attempted as { nextAttemptAt?: number }).nextAttemptAt
        delete (attempted as { reason?: string }).reason
        delete (attempted as { retryable?: boolean }).retryable
        await this.append(attempted)

        let outcome: OutboxSinkResult
        try {
          outcome = await sink(attempted)
        } catch (error) {
          outcome = this.classify(error)
        }
        if (outcome.status === 'complete' && outcome.dataRef.trim() !== '') {
          await this.append({
            ...attempted,
            state: 'complete',
            dataRef: outcome.dataRef,
            updatedAt: this.iso(),
          })
          completed += 1
          this.metrics?.increment('outbox.completed')
          continue
        }
        const failure: { reason: string; retryable: boolean } =
          outcome.status === 'complete'
            ? { reason: 'MISSING_DATA_REF', retryable: true }
            : { reason: outcome.reason, retryable: outcome.retryable }
        const retry = failure.retryable && attempted.attempts < this.maxAttempts
        await this.append({
          ...attempted,
          state: 'failed',
          reason: failure.reason,
          retryable: retry,
          ...(retry
            ? { nextAttemptAt: this.now() + this.backoffFor(attempted.attempts) }
            : {}),
          updatedAt: this.iso(),
        })
        if (retry) this.metrics?.increment('outbox.retried')
        else {
          failed += 1
          this.metrics?.increment('outbox.failed')
        }
      }
      return { processed, completed, failed }
    }
    const next = this.chain.then(run, run)
    this.chain = next.catch(() => ({ processed: 0, completed: 0, failed: 0 }))
    return next
  }

  /** Latest state for one candidate, used to reconcile the candidate spool. */
  async operationFor(idempotencyKey: string, candidateVersion = 1): Promise<OutboxOperation | undefined> {
    const id = operationIdFor(idempotencyKey, candidateVersion)
    const operations = await this.fold()
    return operations.find((operation) => operation.operationId === id)
  }

  async status(): Promise<OutboxStatus> {
    const operations = await this.fold()
    const counts = { pending: 0, processing: 0, complete: 0, failed: 0 }
    for (const operation of operations) counts[operation.state] += 1
    const operationsView = [...operations]
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
      .slice(0, 50)
      .map((operation) => ({
        operationId: operation.operationId,
        operation: operation.operation,
        dataset: operation.dataset,
        state: operation.state,
        attempts: operation.attempts,
        ...(operation.reason === undefined ? {} : { reason: operation.reason }),
        ...(operation.dataRef === undefined ? {} : { dataRef: operation.dataRef }),
        updatedAt: operation.updatedAt,
      }))
    return {
      ...counts,
      total: operations.length,
      operations: operationsView,
    }
  }
}
