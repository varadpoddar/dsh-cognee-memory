import { promises as fs } from 'node:fs'
import path from 'node:path'
import { isMemoryError, MemoryError } from '../errors.js'
import { findSecrets } from '../security/redaction.js'
import type { MemoryCandidate } from './extraction.js'

export type QueueStatus = 'ingested' | 'failed' | 'forgotten'

interface CandidateRecord {
  readonly type: 'candidate'
  readonly candidate: MemoryCandidate
}

interface ResultRecord {
  readonly type: 'result'
  readonly id: string
  readonly idempotencyKey: string
  readonly status: QueueStatus
  readonly at: string
  readonly errorCode?: string
}

type QueueRecord = CandidateRecord | ResultRecord

export interface EnqueueResult {
  readonly accepted: boolean
  readonly reason?: 'duplicate' | 'secret' | 'full'
}

export interface DrainResult {
  readonly processed: number
  readonly ingested: number
  readonly failed: number
}

export interface CandidateQueueOptions {
  readonly dir: string
  readonly maxPending?: number
  readonly now?: () => number
}

export interface CandidateQueueStatus {
  readonly queued: number
  readonly ingested: number
  readonly failed: number
  readonly forgotten: number
  readonly total: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isCandidate(value: unknown): value is MemoryCandidate {
  if (!isRecord(value)) return false
  return (
    typeof value.id === 'string' &&
    typeof value.idempotencyKey === 'string' &&
    typeof value.content === 'string' &&
    typeof value.semanticKey === 'string' &&
    typeof value.principalId === 'string' &&
    (value.operation === 'remember' || value.operation === 'forget') &&
    isRecord(value.scope) &&
    typeof value.scope.scope === 'string' &&
    typeof value.scope.id === 'string'
  )
}

/**
 * Durable, append-only candidate spool. It is the "queued" state between a
 * committed user message and confirmed Cognee ingestion. A crash mid-ingest
 * leaves the candidate pending, so the next process retries it; completed ids
 * make retries idempotent. Content has already passed redaction, and every
 * enqueue re-checks for credentials before touching disk.
 */
export class CandidateQueue {
  private readonly dir: string
  private readonly file: string
  private readonly maxPending: number
  private readonly now: () => number
  private drained: Promise<DrainResult> = Promise.resolve({ processed: 0, ingested: 0, failed: 0 })

  constructor(options: CandidateQueueOptions) {
    this.dir = options.dir
    this.file = path.join(options.dir, 'candidates.jsonl')
    this.maxPending = options.maxPending ?? 100
    this.now = options.now ?? Date.now
  }

  get filePath(): string {
    return this.file
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

  private async records(): Promise<QueueRecord[]> {
    let text: string
    try {
      text = await fs.readFile(this.file, 'utf8')
    } catch {
      return []
    }
    const records: QueueRecord[] = []
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (!isRecord(parsed)) continue
        if (parsed.type === 'candidate' && isCandidate(parsed.candidate)) {
          records.push({ type: 'candidate', candidate: parsed.candidate })
        } else if (
          parsed.type === 'result' &&
          typeof parsed.id === 'string' &&
          typeof parsed.idempotencyKey === 'string' &&
          (parsed.status === 'ingested' || parsed.status === 'failed' || parsed.status === 'forgotten')
        ) {
          records.push({
            type: 'result',
            id: parsed.id,
            idempotencyKey: parsed.idempotencyKey,
            status: parsed.status,
            at: typeof parsed.at === 'string' ? parsed.at : new Date(this.now()).toISOString(),
            ...(typeof parsed.errorCode === 'string' ? { errorCode: parsed.errorCode } : {}),
          })
        }
      } catch {
        // A truncated line from a crash is ignored; it never blocks replay.
      }
    }
    return records
  }

  private async append(record: QueueRecord): Promise<void> {
    await fs.appendFile(this.file, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  async pending(): Promise<readonly MemoryCandidate[]> {
    const records = await this.records()
    const completed = new Set<string>()
    for (const record of records) {
      if (record.type === 'result') completed.add(record.idempotencyKey)
    }
    const pending: MemoryCandidate[] = []
    for (const record of records) {
      if (record.type !== 'candidate') continue
      if (completed.has(record.candidate.idempotencyKey)) continue
      if (pending.some((item) => item.idempotencyKey === record.candidate.idempotencyKey)) continue
      pending.push(record.candidate)
    }
    return pending
  }

  async enqueue(candidate: MemoryCandidate): Promise<EnqueueResult> {
    if (findSecrets(candidate.content).length > 0) return { accepted: false, reason: 'secret' }
    await this.ensureDir()
    const records = await this.records()
    const known = new Set<string>()
    for (const record of records) {
      if (record.type === 'result') known.add(record.idempotencyKey)
      else known.add(record.candidate.idempotencyKey)
    }
    if (known.has(candidate.idempotencyKey)) return { accepted: false, reason: 'duplicate' }
    const completed = new Set<string>()
    for (const record of records) {
      if (record.type === 'result') completed.add(record.idempotencyKey)
    }
    const pending = records.filter(
      (record) => record.type === 'candidate' && !completed.has(record.candidate.idempotencyKey),
    ).length
    if (pending >= this.maxPending) return { accepted: false, reason: 'full' }
    await this.append({ type: 'candidate', candidate })
    return { accepted: true }
  }

  async status(): Promise<CandidateQueueStatus> {
    const records = await this.records()
    let ingested = 0
    let failed = 0
    let forgotten = 0
    const completed = new Set<string>()
    for (const record of records) {
      if (record.type !== 'result') continue
      completed.add(record.idempotencyKey)
      if (record.status === 'ingested') ingested += 1
      else if (record.status === 'failed') failed += 1
      else forgotten += 1
    }
    const queued = await this.pending()
    return {
      queued: queued.length,
      ingested,
      failed,
      forgotten,
      total: records.filter((record) => record.type === 'candidate').length,
    }
  }

  /** Drain in order with one in-flight candidate; failures stay recorded and do not block later work. */
  async drain(
    sink: (candidate: MemoryCandidate) => Promise<{ status: QueueStatus; errorCode?: string }>,
  ): Promise<DrainResult> {
    const run = async (): Promise<DrainResult> => {
      await this.ensureDir()
      const queued = await this.pending()
      let processed = 0
      let ingested = 0
      let failed = 0
      for (const candidate of queued) {
        processed += 1
        const at = new Date(this.now()).toISOString()
        try {
          const result = await sink(candidate)
          if (result.status === 'ingested') ingested += 1
          await this.append({
            type: 'result',
            id: candidate.id,
            idempotencyKey: candidate.idempotencyKey,
            status: result.status,
            at,
            ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
          })
        } catch (error) {
          failed += 1
          const code = isMemoryError(error)
            ? error.code
            : error instanceof MemoryError
              ? error.code
              : 'INTERNAL'
          await this.append({
            type: 'result',
            id: candidate.id,
            idempotencyKey: candidate.idempotencyKey,
            status: 'failed',
            at,
            errorCode: code,
          })
        }
      }
      return { processed, ingested, failed }
    }
    const next = this.drained.then(run, run)
    this.drained = next.catch(() => ({ processed: 0, ingested: 0, failed: 0 }))
    return next
  }
}
