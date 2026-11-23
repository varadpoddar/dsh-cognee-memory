/** Bounded, secret-free runtime counters for the memory subsystem. */

export type MetricName =
  | 'recall.requests'
  | 'recall.failures'
  | 'recall.degraded'
  | 'remember.requests'
  | 'remember.failures'
  | 'remember.deduplicated'
  | 'remember.ephemeral'
  | 'extraction.events'
  | 'extraction.userMessages'
  | 'extraction.streams'
  | 'extraction.streamsWithBucket'
  | 'extraction.turns'
  | 'extraction.candidates'
  | 'extraction.queued'
  | 'extraction.ingested'
  | 'extraction.failed'
  | 'extraction.llm.requests'
  | 'extraction.llm.failures'
  | 'extraction.llm.deferred'
  | 'extraction.llm.settled'
  | 'extraction.llm.settleTimeouts'
  | 'cognee.service.degraded'
  | 'cognee.service.conflict'
  | 'forget.requests'
  | 'forget.unsupported'
  | 'redaction.blocked'
  | 'prompt.refresh'
  | 'prompt.failures'
  | 'prefetch.begin'
  | 'prefetch.hits'
  | 'prefetch.empty'
  | 'prefetch.inject'
  | 'prefetch.timeout'
  | 'prefetch.aborted'
  | 'prefetch.failures'
  | 'circuit.open'
  | 'retry.attempts'
  | 'adapter.timeouts'
  | 'retrieval.hits'
  | 'retrieval.empty'
  | 'retrieval.failures'
  | 'memory.context.consumed'
  | 'recall.firstTurnHits'
  | 'recall.firstTurnMisses'
  | 'outbox.enqueued'
  | 'outbox.completed'
  | 'outbox.retried'
  | 'outbox.failed'
  | 'outbox.recovered'
  | 'task.recorded'
  | 'task.failed'
  | 'provenance.record.failures'

const METRIC_NAMES: readonly MetricName[] = [
  'recall.requests',
  'recall.failures',
  'recall.degraded',
  'remember.requests',
  'remember.failures',
  'remember.deduplicated',
  'remember.ephemeral',
  'extraction.events',
  'extraction.userMessages',
  'extraction.streams',
  'extraction.streamsWithBucket',
  'extraction.turns',
  'extraction.candidates',
  'extraction.queued',
  'extraction.ingested',
  'extraction.failed',
  'extraction.llm.requests',
  'extraction.llm.failures',
  'extraction.llm.deferred',
  'extraction.llm.settled',
  'extraction.llm.settleTimeouts',
  'cognee.service.degraded',
  'cognee.service.conflict',
  'forget.requests',
  'forget.unsupported',
  'redaction.blocked',
  'prompt.refresh',
  'prompt.failures',
  'prefetch.begin',
  'prefetch.hits',
  'prefetch.empty',
  'prefetch.inject',
  'prefetch.timeout',
  'prefetch.aborted',
  'prefetch.failures',
  'circuit.open',
  'retry.attempts',
  'adapter.timeouts',
  'retrieval.hits',
  'retrieval.empty',
  'retrieval.failures',
  'memory.context.consumed',
  'recall.firstTurnHits',
  'recall.firstTurnMisses',
  'outbox.enqueued',
  'outbox.completed',
  'outbox.retried',
  'outbox.failed',
  'outbox.recovered',
  'task.recorded',
  'task.failed',
  'provenance.record.failures',
]

/**
 * Latency and size samples kept in a bounded in-process reservoir. Settings
 * reports p50/p95 from these; nothing is exported off-process and no sample
 * ever contains memory text.
 */
export type SampleName =
  | 'recall.latencyMs'
  | 'prefetch.latencyMs'
  | 'context.usage'
  | 'extraction.llm.latencyMs'

export const SAMPLE_NAMES: readonly SampleName[] = [
  'recall.latencyMs',
  'prefetch.latencyMs',
  'context.usage',
  'extraction.llm.latencyMs',
]

const SAMPLE_CAPACITY = 256

export interface SampleSummary {
  readonly count: number
  readonly p50: number
  readonly p95: number
  readonly max: number
  readonly last: number
}

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>
  readonly samples: Readonly<Record<SampleName, SampleSummary>>
  readonly lastErrorCode?: string
  readonly lastErrorAt?: string
}

function summarize(values: readonly number[]): SampleSummary {
  if (values.length === 0) return { count: 0, p50: 0, p95: 0, max: 0, last: 0 }
  const sorted = [...values].sort((a, b) => a - b)
  const at = (quantile: number): number => {
    const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(quantile * sorted.length) - 1))
    return Math.round(sorted[index] ?? 0)
  }
  return {
    count: sorted.length,
    p50: at(0.5),
    p95: at(0.95),
    max: Math.round(sorted[sorted.length - 1] ?? 0),
    last: Math.round(sorted[sorted.length - 1] ?? 0),
  }
}

export class Metrics {
  private readonly counters = new Map<MetricName, number>()
  private readonly samples = new Map<SampleName, number[]>()
  private lastErrorCode: string | undefined
  private lastErrorAt: string | undefined
  private readonly clock: () => Date

  constructor(clock: () => Date = () => new Date()) {
    this.clock = clock
  }

  increment(name: MetricName, by = 1): void {
    if (!METRIC_NAMES.includes(name)) return
    const next = (this.counters.get(name) ?? 0) + by
    this.counters.set(name, next)
  }

  recordError(code: string): void {
    this.lastErrorCode = code
    this.lastErrorAt = this.clock().toISOString()
  }

  /** Record one bounded sample (latency in ms, or a size). Never throws. */
  observe(name: SampleName, value: number): void {
    if (!Number.isFinite(value) || value < 0) return
    const bucket = this.samples.get(name) ?? []
    bucket.push(value)
    if (bucket.length > SAMPLE_CAPACITY) bucket.splice(0, bucket.length - SAMPLE_CAPACITY)
    this.samples.set(name, bucket)
  }

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {}
    for (const name of METRIC_NAMES) {
      counters[name] = this.counters.get(name) ?? 0
    }
    const samples = {} as Record<SampleName, SampleSummary>
    for (const name of SAMPLE_NAMES) samples[name] = summarize(this.samples.get(name) ?? [])
    return {
      counters,
      samples,
      ...(this.lastErrorCode === undefined ? {} : { lastErrorCode: this.lastErrorCode }),
      ...(this.lastErrorAt === undefined ? {} : { lastErrorAt: this.lastErrorAt }),
    }
  }

  reset(): void {
    this.counters.clear()
    this.samples.clear()
    this.lastErrorCode = undefined
    this.lastErrorAt = undefined
  }
}
