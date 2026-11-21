import { MemoryError, isMemoryError, toMemoryError } from '../errors.js'
import type { CogneeMemoryConfig } from '../config/schema.js'
import type { Metrics } from '../telemetry/metrics.js'
import type { CallerIdentity, MemoryAdapter, RecallHit, RecallQuery, ScopeRef } from '../types.js'
import { buildAccessPolicy, type AccessPolicy } from '../security/access-policy.js'
import { formatScope, sameScope, scopesForIdentity } from './scopes.js'

export interface RecallDependencies {
  readonly adapter: MemoryAdapter
  readonly config: CogneeMemoryConfig
  readonly metrics?: Metrics
}

export interface RecallRequest {
  readonly text: string
  readonly identity: CallerIdentity
  readonly limit?: number
  readonly minScore?: number
  readonly signal?: AbortSignal
}

export interface RecallServiceOptions {
  readonly cwd?: string
}

function clampScore(score: number): number {
  if (!Number.isFinite(score)) return 0
  return Math.min(1, Math.max(0, score))
}

function dedupeHits(hits: readonly RecallHit[]): RecallHit[] {
  const seen = new Set<string>()
  const unique: RecallHit[] = []
  for (const hit of hits) {
    const key = `${formatScope(hit.record.scope)}\u0000${hit.record.id}`
    if (seen.has(key)) continue
    seen.add(key)
    unique.push(hit)
  }
  return unique
}

/** Retrieval orchestration: scope policy first, then ranking and a hard result cap. */
export class RecallService {
  private readonly adapter: MemoryAdapter
  private readonly config: CogneeMemoryConfig
  private readonly metrics: Metrics | undefined
  private readonly cwd: string | undefined

  constructor(dependencies: RecallDependencies, options: RecallServiceOptions = {}) {
    this.adapter = dependencies.adapter
    this.config = dependencies.config
    this.metrics = dependencies.metrics
    this.cwd = options.cwd
  }

  policyFor(identity: CallerIdentity): AccessPolicy {
    return buildAccessPolicy(scopesForIdentity(identity, this.config, this.cwd))
  }

  async recall(request: RecallRequest): Promise<RecallHit[]> {
    if (!this.config.enabled) {
      throw new MemoryError('DISABLED', 'cognee memory is disabled')
    }
    const text = request.text.trim()
    if (text === '') {
      throw new MemoryError('VALIDATION', 'recall query must not be empty')
    }
    const limit = Math.max(1, Math.min(request.limit ?? 5, 50))
    const policy = this.policyFor(request.identity)
    const scopes: readonly ScopeRef[] = policy.readableScopes
    const query: RecallQuery = {
      text,
      scopes,
      limit: Math.min(100, limit * 3),
      ...(request.minScore === undefined ? {} : { minScore: request.minScore }),
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    }

    this.metrics?.increment('recall.requests')
    try {
      const raw = await this.adapter.recall(query)
      const filtered = dedupeHits(raw)
        .filter((hit) => hit.record.text.trim() !== '' && hit.record.id.trim() !== '')
        .filter((hit) => policy.canRead(hit.record.scope))
        .filter((hit) => scopes.some((scope) => sameScope(scope, hit.record.scope)))
        .map((hit) => ({ record: hit.record, score: clampScore(hit.score) }))
        .filter((hit) => request.minScore === undefined || hit.score >= request.minScore)
        .sort((a, b) => {
          if (b.score !== a.score) return b.score - a.score
          return Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt)
        })
        .slice(0, limit)
      return filtered
    } catch (error) {
      this.metrics?.increment('recall.failures')
      const normalized = toMemoryError(error, 'BACKEND')
      this.metrics?.recordError(normalized.code)
      throw normalized
    }
  }

  /** Prompt-side lookup: failures degrade to no context in `open` failure mode. */
  async safeRecall(request: RecallRequest): Promise<RecallHit[]> {
    try {
      return await this.recall(request)
    } catch (error) {
      if (this.config.failureMode === 'open') return []
      throw isMemoryError(error) ? error : new MemoryError('BACKEND', 'memory recall failed')
    }
  }
}
