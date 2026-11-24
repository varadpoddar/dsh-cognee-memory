/**
 * Read-only inspection snapshot for the Milestone 9 settings page.
 *
 * Everything here is derived from counters, bounded queue/outbox views, and an
 * optional dataset inventory. It never mutates memory, never deletes, never
 * corrects, and never reads a credential. Memory text appears only as a
 * bounded preview on an authenticated page.
 */
import type { CandidateQueueStatus } from '../memory/candidate-queue.js'
import type { QueueItem, QueueSnapshot, QueueStatus } from '../queue/store.js'
import type { PendingCandidateView } from '../memory/extraction-service.js'
import type { OutboxStatus } from '../memory/outbox.js'
import { scopeKey } from '../memory/scopes.js'
import { withTimeout } from '../memory/context-format.js'
import type { CallerIdentity, MemoryInventory, ScopeRef } from '../types.js'
import type { SettingsStatus, SettingsStore } from './store.js'

/** Every state the page may display. Only evidenced states appear per row. */
export const MEMORY_INSPECTION_STATES = [
  'candidate',
  'approved',
  'queued',
  'ingesting',
  'indexed',
  'recall-verified',
  'failed',
  'superseded',
  'deleted',
] as const

export type MemoryInspectionState = (typeof MEMORY_INSPECTION_STATES)[number]

export interface MemoryInspectionRow {
  readonly id: string
  readonly dataset: string
  readonly state: MemoryInspectionState
  readonly preview: string
  readonly operation?: string
  readonly attempts?: number
  readonly reason?: string
  readonly dataRef?: string
  readonly updatedAt?: string
}

export interface ScopedDataset {
  readonly scope: string
  readonly id: string
  readonly dataset: string
}

export interface SettingsInspection {
  readonly toggles: {
    readonly autoRecall: boolean
    readonly autoWrite: boolean
    readonly sources: SettingsStatus['sources']
  }
  readonly scopes: {
    readonly principal: string
    readonly project: string
    readonly defaultWriteScope: string
    readonly readable: readonly ScopedDataset[]
  }
  readonly candidates: CandidateQueueStatus & {
    readonly operations: OutboxStatus['operations']
  }
  readonly ingestion: {
    readonly succeeded: number
    readonly failed: number
  }
  readonly recall: {
    readonly firstTurn: {
      readonly attempts: number
      readonly hits: number
      readonly misses: number
      readonly hitRate: number
    }
    readonly latency: {
      readonly recall: { readonly count: number; readonly p50: number; readonly p95: number }
      readonly prefetch: { readonly count: number; readonly p50: number; readonly p95: number }
    }
    readonly contextTokens: {
      readonly last: number
      readonly p95: number
      readonly total: number
    }
  }
  readonly memory: {
    readonly count: number | null
    readonly datasets: MemoryInventory['datasets']
    readonly checkedAt?: string
    readonly degraded?: string
  }
  /**
   * Durable conversation tasks (turn journal). Present only when the journal is
   * enabled, because otherwise there is no queue to show.
   */
  readonly tasks?: {
    readonly total: number
    readonly pending: number
    readonly inflight: number
    readonly failed: number
    readonly dueNow: number
    readonly oldestPendingAt?: string
    readonly rows: ReadonlyArray<{
      readonly id: string
      readonly state: QueueItem['state']
      readonly role: string
      readonly attempts: number
      readonly preview: string
      readonly sessionId?: string
      readonly turn?: number
      readonly lastError?: string
    }>
  }
  readonly memories: readonly MemoryInspectionRow[]
  readonly stateCounts: Readonly<Record<MemoryInspectionState, number>>
  readonly warnings: readonly string[]
  readonly inspectedAt: string
}

export interface InspectionDependencies {
  readonly store: Pick<SettingsStore, 'status'>
  readonly metrics: {
    snapshot(): {
      readonly counters: Readonly<Record<string, number>>
      readonly samples: Readonly<
        Record<
          string,
          { readonly count: number; readonly p50: number; readonly p95: number; readonly last?: number }
        >
      >
    }
  }
  readonly coordinator: {
    resolveIdentity(identity: CallerIdentity): Promise<CallerIdentity>
    policyFor?(identity: CallerIdentity): Promise<{ readonly readableScopes: readonly ScopeRef[] }>
  }
  readonly identity: CallerIdentity
  readonly defaultWriteScope?: string
  readonly extraction?: {
    status(): Promise<{
      readonly queue: CandidateQueueStatus
      readonly outbox: OutboxStatus
      readonly pendingCandidates: readonly PendingCandidateView[]
    }>
  }
  readonly inventory?: () => Promise<MemoryInventory | undefined>
  /** Turn-journal queue snapshot, read from disk on every inspection. */
  readonly queue?: () => QueueSnapshot
  readonly verification?: { has(id: string): boolean }
  readonly now?: () => number
  readonly timeoutMs?: number
}

function counter(counters: Readonly<Record<string, number>>, name: string): number {
  const value = counters[name]
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

async function settle<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  try {
    return await withTimeout(promise, timeoutMs)
  } catch {
    return undefined
  }
}

function recordIdFromDataRef(dataRef: string | undefined): string | undefined {
  if (dataRef === undefined) return undefined
  const hash = dataRef.lastIndexOf('#')
  if (hash < 0) return undefined
  const id = dataRef.slice(hash + 1)
  return id === '' || id.startsWith('forget:') ? undefined : id
}

/** Build the inspection snapshot. Never throws; unavailable sections degrade. */
export async function buildInspection(dependencies: InspectionDependencies): Promise<SettingsInspection> {
  const now = dependencies.now ?? Date.now
  const timeoutMs = dependencies.timeoutMs ?? 2_000
  const status = dependencies.store.status()
  const snapshot = dependencies.metrics.snapshot()
  const counters = snapshot.counters
  const warnings = [...status.warnings]

  const resolved = (await settle(dependencies.coordinator.resolveIdentity(dependencies.identity), timeoutMs)) ?? {}
  const policy =
    dependencies.coordinator.policyFor === undefined
      ? undefined
      : await settle(dependencies.coordinator.policyFor(resolved), timeoutMs)
  const readable = (policy?.readableScopes ?? []).map((scope) => ({
    scope: scope.scope,
    id: scope.id,
    dataset: scopeKey(scope),
  }))
  const projectScope = readable.find((scope) => scope.scope === 'project')

  const extraction = dependencies.extraction === undefined
    ? undefined
    : await settle(dependencies.extraction.status(), timeoutMs)
  const inventory = dependencies.inventory === undefined
    ? undefined
    : await settle(dependencies.inventory(), timeoutMs)
  if (dependencies.inventory !== undefined && inventory === undefined) {
    warnings.push('inventory: backend did not answer within the inspection deadline')
  }

  const queue = extraction?.queue ?? { queued: 0, ingested: 0, failed: 0, forgotten: 0, total: 0 }
  const outbox = extraction?.outbox ?? { pending: 0, processing: 0, complete: 0, failed: 0, total: 0, operations: [] }
  const pendingCandidates = extraction?.pendingCandidates ?? []

  const rows: MemoryInspectionRow[] = []
  const seen = new Set<string>()
  for (const candidate of pendingCandidates) {
    const operation = outbox.operations.find(
      (entry) => entry.idempotencyKey === candidate.idempotencyKey,
    )
    const key = candidate.id
    if (seen.has(key)) continue
    seen.add(key)
    const state: MemoryInspectionState =
      operation === undefined
        ? 'candidate'
        : operation.state === 'pending'
          ? 'queued'
          : operation.state === 'processing'
            ? 'ingesting'
            : operation.state === 'failed'
              ? 'failed'
              : 'indexed'
    rows.push({
      id: candidate.id,
      dataset: operation?.dataset ?? projectScope?.dataset ?? '',
      state,
      preview: candidate.preview,
      operation: candidate.operation,
      ...(operation === undefined ? {} : { attempts: operation.attempts }),
    })
  }
  for (const operation of outbox.operations) {
    if (seen.has(operation.operationId)) continue
    seen.add(operation.operationId)
    const recordId = recordIdFromDataRef(operation.dataRef)
    const verified = recordId !== undefined && dependencies.verification?.has(recordId) === true
    const state: MemoryInspectionState =
      operation.state === 'pending'
       ? 'queued'
        : operation.state === 'processing'
          ? 'ingesting'
          : operation.state === 'failed'
            ? 'failed'
            : verified
              ? 'recall-verified'
              : 'indexed'
    rows.push({
      id: operation.operationId,
      dataset: operation.dataset,
      state,
      preview: operation.preview,
      operation: operation.operation,
      attempts: operation.attempts,
      ...(operation.reason === undefined ? {} : { reason: operation.reason }),
      ...(operation.dataRef === undefined ? {} : { dataRef: operation.dataRef }),
      updatedAt: operation.updatedAt,
    })
  }

  const stateCounts = Object.fromEntries(
    MEMORY_INSPECTION_STATES.map((state) => [state, 0]),
  ) as Record<MemoryInspectionState, number>
  for (const row of rows) stateCounts[row.state] += 1

  const hits = counter(counters, 'recall.firstTurnHits')
  const misses = counter(counters, 'recall.firstTurnMisses')
  const attempts = hits + misses
  const recallSamples = snapshot.samples['recall.latencyMs'] ?? { count: 0, p50: 0, p95: 0 }
  const prefetchSamples = snapshot.samples['prefetch.latencyMs'] ?? { count: 0, p50: 0, p95: 0 }
  const contextSamples = snapshot.samples['context.usage'] ?? { count: 0, p50: 0, p95: 0 }

  const queueSnapshot = dependencies.queue?.()
  const queueStatus: QueueStatus | undefined = queueSnapshot?.status
  const queueRows =
    queueSnapshot === undefined
      ? undefined
      : queueSnapshot.items
          .slice()
          .filter((item) => item.state !== 'done')
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
          .slice(0, 50)
          .map((item) => ({
            id: item.id,
            state: item.state,
            role: item.source.role ?? 'user',
            attempts: item.attempts,
            preview: item.text.slice(0, 90),
            ...(item.source.sessionId === undefined ? {} : { sessionId: item.source.sessionId }),
            ...(item.source.turnIndex === undefined ? {} : { turn: item.source.turnIndex }),
            ...(item.lastError === undefined ? {} : { lastError: item.lastError }),
          }))

  return {
    ...(queueStatus === undefined
      ? {}
      : {
          tasks: {
            total: queueStatus.total,
            pending: queueStatus.counts.pending,
            inflight: queueStatus.counts.inflight,
            failed: queueStatus.counts.failed,
            dueNow: queueStatus.dueNow,
            ...(queueStatus.oldestPendingAt === undefined
              ? {}
              : { oldestPendingAt: queueStatus.oldestPendingAt }),
            rows: queueRows ?? [],
          },
        }),
    toggles: {
      autoRecall: status.autoRecall,
      autoWrite: status.autoWrite,
      sources: status.sources,
    },
    scopes: {
      principal:
        resolved.principalId === undefined || resolved.principalId === ''
          ? 'unknown'
          : resolved.principalId,
      project: projectScope?.dataset ?? 'unknown',
      defaultWriteScope: dependencies.defaultWriteScope ?? 'project',
      readable,
    },
    candidates: {
      ...queue,
      operations: outbox.operations,
    },
    ingestion: {
      succeeded: counter(counters, 'outbox.completed'),
      failed: counter(counters, 'outbox.failed'),
    },
    recall: {
      firstTurn: { attempts, hits, misses, hitRate: attempts === 0 ? 0 : hits / attempts },
      latency: {
        recall: { count: recallSamples.count, p50: recallSamples.p50, p95: recallSamples.p95 },
        prefetch: {
          count: prefetchSamples.count,
          p50: prefetchSamples.p50,
          p95: prefetchSamples.p95,
        },
      },
      contextTokens: {
        last: contextSamples.count === 0 ? 0 : (contextSamples.last ?? contextSamples.p50),
        p95: contextSamples.p95,
        total: counter(counters, 'memory.context.consumed'),
      },
    },
    memory: {
      count: inventory?.totalRecords ?? null,
      datasets: inventory?.datasets ?? [],
      ...(inventory?.checkedAt === undefined ? {} : { checkedAt: inventory.checkedAt }),
      ...(inventory === undefined && dependencies.inventory !== undefined
        ? { degraded: 'inventory unavailable' }
        : {}),
    },
    memories: rows,
    stateCounts,
    warnings,
    inspectedAt: new Date(now()).toISOString(),
  }
}
