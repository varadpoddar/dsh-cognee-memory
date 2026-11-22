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
]

export interface MetricsSnapshot {
  readonly counters: Readonly<Record<string, number>>
  readonly lastErrorCode?: string
  readonly lastErrorAt?: string
}

export class Metrics {
  private readonly counters = new Map<MetricName, number>()
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

  snapshot(): MetricsSnapshot {
    const counters: Record<string, number> = {}
    for (const name of METRIC_NAMES) {
      counters[name] = this.counters.get(name) ?? 0
    }
    return {
      counters,
      ...(this.lastErrorCode === undefined ? {} : { lastErrorCode: this.lastErrorCode }),
      ...(this.lastErrorAt === undefined ? {} : { lastErrorAt: this.lastErrorAt }),
    }
  }

  reset(): void {
    this.counters.clear()
    this.lastErrorCode = undefined
    this.lastErrorAt = undefined
  }
}
