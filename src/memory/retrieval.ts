import type { CogneeMemoryConfig } from '../config/schema.js'
import type { Metrics } from '../telemetry/metrics.js'
import type { CallerIdentity, RecallHit } from '../types.js'
import type { RecallService } from './recall.js'
import { scopesForIdentity } from './scopes.js'
import {
  estimateTokens,
  filterActiveHits,
  formatMemoryBlock,
  memoryItemLine,
  withTimeout,
} from './context-format.js'

/**
 * Two-layer retrieval coordinator (Milestone 6).
 *
 * Layer 1 — stable: principal/project context that does not depend on the
 * current question. Its query is derived from the authorized scope descriptors
 * (never from user text), it is capped at `retrieval.stableTokens`, and it is
 * cached for `retrieval.stableRefreshMs` so later steps in the same turn reuse
 * it instead of paying another backend round trip.
 *
 * Layer 2 — query: the real first user message, capped at
 * `retrieval.queryTokens`. `agent/inbox/claimed` supplies the exact message the
 * loop is about to answer.
 *
 * Both layers share one hard deadline (`retrieval.budgetMs`), one item cap
 * (`retrieval.maxItems`), and one strict combined token cap
 * (`stableTokens + queryTokens`). Only scopes authorized for the caller are
 * searched because every read goes through `RecallService.safeRecall`.
 * Superseded / expired / revoked records are dropped before ranking.
 */
export interface RetrievalDependencies {
  readonly recall: Pick<RecallService, 'safeRecall'>
  readonly config: CogneeMemoryConfig
  readonly identity: CallerIdentity
  readonly metrics?: Metrics
  readonly now?: () => number
}

export interface RetrievalRequest {
  /** Sanitized first user message for this turn. */
  readonly query: string
  readonly turn: number
  readonly signal?: AbortSignal
}

export interface RetrievalOutcome {
  readonly block: string
  readonly hits: readonly RecallHit[]
  /** Query-layer hits that survived filtering and budgeting. */
  readonly queryHits: number
  readonly tokens: number
  readonly elapsedMs: number
  readonly degraded: boolean
}

interface StableCache {
  readonly key: string
  readonly at: number
  readonly hits: readonly RecallHit[]
}

function sortHits(hits: readonly RecallHit[]): RecallHit[] {
  return [...hits].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    return Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt)
  })
}

function dedupe(hits: readonly RecallHit[]): RecallHit[] {
  const seen = new Set<string>()
  const unique: RecallHit[] = []
  for (const hit of sortHits(hits)) {
    const key = `${hit.record.scope.scope}\u0000${hit.record.scope.id}\u0000${hit.record.id}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(hit)
  }
  return unique
}

/** Take whole items while the layer budget and the global item cap fit. */
function takeWithin(
  hits: readonly RecallHit[],
  maxTokens: number,
  remainingItems: number,
): { readonly hits: RecallHit[]; readonly tokens: number } {
  const taken: RecallHit[] = []
  let used = 0
  for (const hit of hits) {
    if (taken.length >= remainingItems) break
    if (hit.record.text.trim() === '') continue
    const lineTokens = estimateTokens(memoryItemLine(hit))
    if (used + lineTokens > maxTokens) break
    taken.push(hit)
    used += lineTokens
  }
  return { hits: taken, tokens: used }
}

export class RetrievalCoordinator {
  private readonly recall: Pick<RecallService, 'safeRecall'>
  private readonly config: CogneeMemoryConfig
  private readonly identity: CallerIdentity
  private readonly metrics: Metrics | undefined
  private readonly now: () => number
  private stableCache: StableCache | undefined

  constructor(dependencies: RetrievalDependencies) {
    this.recall = dependencies.recall
    this.config = dependencies.config
    this.identity = dependencies.identity
    this.metrics = dependencies.metrics
    this.now = dependencies.now ?? Date.now
  }

  /** Authorized scopes decide which datasets may be searched; never user text. */
  private scopeFingerprint(): string {
    return scopesForIdentity(this.identity, this.config)
      .map((scope) => `${scope.scope}:${scope.id}`)
      .join('|')
  }

  private stableQuery(): string {
    const scopes = scopesForIdentity(this.identity, this.config)
    const labels = scopes.map((scope) => `${scope.scope} ${scope.id}`).join(', ')
    return `Durable context for ${labels}: decisions, conventions, preferences, ongoing work, and prior outcomes.`
  }

  private async fetchLayer(
    text: string,
    timeoutMs: number,
    signal: AbortSignal | undefined,
  ): Promise<{ readonly hits: readonly RecallHit[]; readonly failed: boolean }> {
    const started = this.now()
    try {
      const hits = await withTimeout(
        this.recall.safeRecall({
          text,
          identity: this.identity,
          limit: Math.max(1, this.config.retrieval.maxItems * 2),
          ...(signal === undefined ? {} : { signal }),
        }),
        Math.max(1, timeoutMs),
      )
      this.metrics?.observe('recall.latencyMs', this.now() - started)
      return { hits: filterActiveHits(hits, this.now()), failed: false }
    } catch {
      this.metrics?.observe('recall.latencyMs', this.now() - started)
      this.metrics?.increment('retrieval.failures')
      return { hits: [], failed: true }
    }
  }

  async retrieve(request: RetrievalRequest): Promise<RetrievalOutcome> {
    const started = this.now()
    const budget = this.config.retrieval
    const deadline = started + budget.budgetMs
    const combinedCap = budget.stableTokens + budget.queryTokens
    const scopesKey = this.scopeFingerprint()
    let degraded = false

    // Layer 1: cached principal/project context.
    let stableHits: readonly RecallHit[] = []
    const cached = this.stableCache
    if (
      cached !== undefined &&
      cached.key === scopesKey &&
      this.now() - cached.at < budget.stableRefreshMs
    ) {
      stableHits = cached.hits
    } else {
      const stableDeadline = Math.min(deadline, started + Math.floor(budget.budgetMs * 0.4))
      const layer = await this.fetchLayer(
        this.stableQuery(),
        stableDeadline - this.now(),
        request.signal,
      )
      degraded = degraded || layer.failed
      stableHits = layer.hits
      // Never cache a failed layer: the next attempt should really retry it.
      if (!layer.failed) this.stableCache = { key: scopesKey, at: this.now(), hits: layer.hits }
    }

    // Layer 2: the real first user message for this turn.
    const query = request.query.trim()
    let queryHits: readonly RecallHit[] = []
    if (query !== '' && !request.signal?.aborted) {
      const layer = await this.fetchLayer(query, deadline - this.now(), request.signal)
      degraded = degraded || layer.failed
      queryHits = layer.hits
    }

    const stable = takeWithin(
      dedupe(stableHits),
      budget.stableTokens,
      budget.maxItems,
    )
    const queryOnly = dedupe(queryHits).filter(
      (hit) =>
        !stable.hits.some(
          (chosen) =>
            chosen.record.id === hit.record.id &&
            chosen.record.scope.scope === hit.record.scope.scope &&
            chosen.record.scope.id === hit.record.scope.id,
        ),
    )
    const specific = takeWithin(
      queryOnly,
      budget.queryTokens,
      Math.max(0, budget.maxItems - stable.hits.length),
    )
    const selected = [...stable.hits, ...specific.hits]
    const block = formatMemoryBlock(selected, {
      maxTokens: combinedCap,
      maxItems: budget.maxItems,
    })

    const elapsedMs = this.now() - started
    if (block.text === '') this.metrics?.increment('retrieval.empty')
    else this.metrics?.increment('retrieval.hits')
    if (block.tokens > 0) {
      this.metrics?.observe('context.usage', block.tokens)
      this.metrics?.increment('memory.context.consumed', block.tokens)
    }
    if (request.turn === 1) {
      this.metrics?.increment(specific.hits.length > 0 ? 'recall.firstTurnHits' : 'recall.firstTurnMisses')
    }

    return {
      block: block.text,
      hits: selected,
      queryHits: specific.hits.length,
      tokens: block.tokens,
      elapsedMs,
      degraded,
    }
  }

  clear(): void {
    this.stableCache = undefined
  }
}
