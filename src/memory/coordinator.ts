import { MemoryError, isMemoryError, toMemoryError } from '../errors.js'
import type { CogneeMemoryConfig } from '../config/schema.js'
import type { Metrics } from '../telemetry/metrics.js'
import type {
  AdapterStatus,
  CallerIdentity,
  HealthResult,
  JsonValue,
  MemoryAdapter,
  Provenance,
  RecallHit,
  RememberResult,
  ScopeRef,
} from '../types.js'
import { buildAccessPolicy, type AccessPolicy } from '../security/access-policy.js'
import { safeEndpoint } from '../security/secrets.js'
import { DedupIndex, findNearDuplicate } from './deduplication.js'
import { RecallService, type RecallRequest } from './recall.js'
import { sameScope, scopeFromName, scopesForIdentity } from './scopes.js'
import { evaluateWrite } from './write-policy.js'

export interface CoordinatorDependencies {
  readonly adapter: MemoryAdapter
  readonly config: CogneeMemoryConfig
  readonly metrics?: Metrics
  readonly cwd?: string
  readonly clock?: () => Date
}

export interface RememberRequest {
  readonly text: string
  readonly identity: CallerIdentity
  readonly scopeName?: string
  readonly tags?: readonly string[]
  readonly provenance: Provenance
  readonly signal?: AbortSignal
}

export interface ForgetRequest {
  readonly id: string
  readonly identity: CallerIdentity
  readonly scopeName?: string
  readonly signal?: AbortSignal
}

export interface CoordinatorStatus {
  readonly adapter: AdapterStatus
  readonly transport: string
  readonly endpoint: string
  readonly authMode: string
  readonly failureMode: string
  readonly metrics: ReturnType<Metrics['snapshot']>
}

function sanitizeTags(tags: readonly string[] | undefined): readonly string[] | undefined {
  if (tags === undefined) return undefined
  const cleaned = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag !== ''))]
    .slice(0, 16)
    .map((tag) => tag.slice(0, 64))
  return cleaned.length === 0 ? undefined : cleaned
}

function nowIso(clock: () => Date): string {
  return clock().toISOString()
}

/**
 * Use-case level coordinator. It is the only object tools and hooks call, so
 * authorization, write policy, deduplication, and telemetry cannot be skipped
 * by a new caller.
 */
export class MemoryCoordinator {
  readonly recallService: RecallService
  private readonly adapter: MemoryAdapter
  private readonly config: CogneeMemoryConfig
  private readonly metrics: Metrics | undefined
  private readonly cwd: string | undefined
  private readonly clock: () => Date
  private readonly dedup = new DedupIndex()

  constructor(dependencies: CoordinatorDependencies) {
    this.adapter = dependencies.adapter
    this.config = dependencies.config
    this.metrics = dependencies.metrics
    this.cwd = dependencies.cwd
    this.clock = dependencies.clock ?? (() => new Date())
    this.recallService = new RecallService(dependencies, {
      ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
    })
  }

  policyFor(identity: CallerIdentity): AccessPolicy {
    return buildAccessPolicy(scopesForIdentity(identity, this.config, this.cwd))
  }

  resolveScope(identity: CallerIdentity, scopeName?: string): ScopeRef {
    const scope = scopeFromName(scopeName ?? 'project', identity, this.config)
    if (scope === undefined) {
      throw new MemoryError('FORBIDDEN', 'caller has no memory scope')
    }
    return scope
  }

  async remember(request: RememberRequest): Promise<RememberResult> {
    const scope = this.resolveScope(request.identity, request.scopeName)
    const policy = this.policyFor(request.identity)
    const decision = evaluateWrite({
      text: request.text,
      scope,
      provenance: request.provenance,
      policy,
      config: this.config,
    })
    if (!decision.allowed) throw decision.error

    this.metrics?.increment('remember.requests')
    try {
      const threshold = this.config.dedup.nearDuplicateThreshold
      const local = this.dedup.findNear(scope, decision.text, threshold)
      if (local !== undefined) {
        this.metrics?.increment('remember.deduplicated')
        return {
          id: local.id,
          scope,
          createdAt: local.createdAt ?? nowIso(this.clock),
          deduplicated: true,
        }
      }

      const candidates = await this.adapter
        .recall({
          text: decision.text,
          scopes: [scope],
          limit: this.config.dedup.candidateLimit,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
        .catch((error: unknown) => {
          // Dedup is best-effort; a read failure must not fabricate a duplicate.
          const normalized = toMemoryError(error, 'BACKEND')
          this.metrics?.recordError(normalized.code)
          return []
        })
      const duplicate = findNearDuplicate(
        decision.text,
        candidates
          .filter((hit) => sameScope(hit.record.scope, scope))
          .map((hit) => ({
            id: hit.record.id,
            text: hit.record.text,
            scope: hit.record.scope,
            createdAt: hit.record.createdAt,
          })),
        threshold,
      )
      if (duplicate !== undefined) {
        this.metrics?.increment('remember.deduplicated')
        return {
          id: duplicate.id,
          scope,
          createdAt: duplicate.createdAt ?? nowIso(this.clock),
          deduplicated: true,
        }
      }

      const tags = sanitizeTags(request.tags)
      const result = await this.adapter.remember({
        text: decision.text,
        scope,
        provenance: request.provenance,
        dedupeKey: decision.dedupeKey,
        ...(tags === undefined ? {} : { tags }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        metadata: {
          dedupeKey: decision.dedupeKey,
          provenanceKind: request.provenance.kind,
          ...(decision.redacted ? { redacted: true } : {}),
        },
      })
      this.dedup.add({ id: result.id, text: decision.text, scope, createdAt: result.createdAt })
      return result
    } catch (error) {
      this.metrics?.increment('remember.failures')
      const normalized = isMemoryError(error) ? error : toMemoryError(error, 'BACKEND')
      this.metrics?.recordError(normalized.code)
      throw normalized
    }
  }

  async recall(request: RecallRequest): Promise<RecallHit[]> {
    return this.recallService.recall(request)
  }

  async forget(request: ForgetRequest): Promise<{ id: string; scope: ScopeRef; forgotten: boolean }> {
    const id = request.id.trim()
    if (id === '') throw new MemoryError('VALIDATION', 'memory id must not be empty')
    const scope = this.resolveScope(request.identity, request.scopeName)
    this.policyFor(request.identity).assertWritable(scope)
    this.metrics?.increment('forget.requests')
    try {
      const result = await this.adapter.forget({
        id,
        scope,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
      return result
    } catch (error) {
      const normalized = toMemoryError(error, 'BACKEND')
      if (normalized.code === 'UNSUPPORTED_OPERATION') this.metrics?.increment('forget.unsupported')
      this.metrics?.recordError(normalized.code)
      throw normalized
    }
  }

  async status(signal?: AbortSignal): Promise<CoordinatorStatus> {
    const adapter = await this.adapter.status(signal)
    const details: Record<string, JsonValue> = {
      enabled: this.config.enabled,
      transport: adapter.transport,
      reachable: adapter.reachable,
      authMode: this.config.authMode,
      failureMode: this.config.failureMode,
      endpoint: safeEndpoint(this.config.apiBaseUrl),
    }
    return {
      adapter: { ...adapter, details: { ...adapter.details, ...details } },
      transport: adapter.transport,
      endpoint: safeEndpoint(this.config.apiBaseUrl),
      authMode: this.config.authMode,
      failureMode: this.config.failureMode,
      metrics: this.metrics?.snapshot() ?? { counters: {} },
    }
  }

  async health(): Promise<HealthResult> {
    return this.adapter.health()
  }
}
