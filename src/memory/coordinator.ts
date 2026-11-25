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
import { EphemeralSessionMemory } from './ephemeral.js'
import { IdentityResolver } from './identity.js'
import { RecallService, type RecallRequest } from './recall.js'
import { scopeFromName, sameScope, scopesForIdentity } from './scopes.js'
import { parseSummaryDocument } from './pointer.js'
import type { ProvenanceIndex } from './provenance-index.js'
import type { LedgerSourceRef, MemoryLedger } from './ledger.js'
import { evaluateWrite } from './write-policy.js'

export interface CoordinatorDependencies {
  readonly adapter: MemoryAdapter
  readonly config: CogneeMemoryConfig
  readonly metrics?: Metrics
  readonly cwd?: string
  readonly clock?: () => Date
  /** Live Cognee endpoint source; see `HttpJsonClientOptions.endpoint`. */
  readonly endpoint?: () => string
  readonly identityResolver?: IdentityResolver
  readonly ephemeral?: EphemeralSessionMemory
  /**
   * Optional provenance index. When present, a durable recall records what
   * surfaced each memory and a durable write records where it landed; the
   * authenticated detail route reads the same index. Never on the tool path.
   */
  readonly provenanceIndex?: Pick<ProvenanceIndex, 'recordRecall' | 'recordWrite' | 'markSuperseded'>
  /**
   * Optional durable record ledger. When present, every accepted durable write
   * is mirrored locally so `memory export` can produce a portable bundle
   * (Cognee exposes text only through search). Never on the tool path.
   */
  readonly ledger?: Pick<MemoryLedger, 'recordWrite' | 'markSuperseded'>
}

export interface RememberRequest {
  readonly text: string
  readonly identity: CallerIdentity
  readonly scopeName?: string
  readonly tags?: readonly string[]
  readonly provenance: Provenance
  /** Caller-supplied stable idempotency key (extraction pipeline); never model prose. */
  readonly dedupeKey?: string
  /** Extracted semantic key (extraction pipeline); never model prose. */
  readonly semanticKey?: string
  /** Id this write replaces (extraction pipeline). */
  readonly supersedes?: string
  /** Bounded source refs (session id + message index) for export/backfill. */
  readonly sourceRefs?: readonly LedgerSourceRef[]
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
  readonly namespaces: Readonly<Record<string, string>>
  readonly scopes: {
    readonly allowGlobal: boolean
    readonly defaultWriteScope: string
    readonly session: string
  }
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
  readonly endpointSource: (() => string) | undefined
  private readonly dedup = new DedupIndex()
  readonly identityResolver: IdentityResolver
  private readonly ephemeral: EphemeralSessionMemory
  private readonly provenanceIndex: Pick<
    ProvenanceIndex,
    'recordRecall' | 'recordWrite' | 'markSuperseded'
  > | undefined
  private readonly ledger: Pick<MemoryLedger, 'recordWrite' | 'markSuperseded'> | undefined

  constructor(dependencies: CoordinatorDependencies) {
    this.adapter = dependencies.adapter
    this.config = dependencies.config
    this.metrics = dependencies.metrics
    this.cwd = dependencies.cwd
    this.clock = dependencies.clock ?? (() => new Date())
    this.endpointSource = dependencies.endpoint
    this.provenanceIndex = dependencies.provenanceIndex
    this.ledger = dependencies.ledger
    this.ephemeral = dependencies.ephemeral ?? new EphemeralSessionMemory(() => this.clock())
    this.identityResolver =
      dependencies.identityResolver ??
      new IdentityResolver({
        config: this.config,
        adapter: this.adapter,
        ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
      })
    this.recallService = new RecallService(
      {
        adapter: this.adapter,
        config: this.config,
        metrics: this.metrics,
        identityResolver: this.identityResolver,
        ephemeral: this.ephemeral,
      },
      {
        ...(this.cwd === undefined ? {} : { cwd: this.cwd }),
        // Both recall paths (tools and prompt prefetch) go through this service,
        // so this is where "what surfaced this memory" is recorded.
        ...(this.provenanceIndex === undefined
          ? {}
          : { provenanceIndex: this.provenanceIndex }),
      },
    )
  }

  /**
   * Endpoint the next call will use. Reads the live settings source when the
   * plugin was wired with one, so `memory_status` never reports a stale target.
   */
  activeEndpoint(): string {
    return this.endpointSource?.() ?? this.config.apiBaseUrl
  }

  async resolveIdentity(identity: CallerIdentity): Promise<CallerIdentity> {
    return this.identityResolver.resolve(identity)
  }

  async policyFor(identity: CallerIdentity): Promise<AccessPolicy> {
    return buildAccessPolicy(await this.identityResolver.scopes(identity))
  }

  async resolveScope(identity: CallerIdentity, scopeName?: string): Promise<ScopeRef> {
    const resolved = await this.identityResolver.resolve(identity)
    const scope = scopeFromName(
      scopeName ?? this.config.scopes.defaultWriteScope,
      resolved,
      this.config,
    )
    if (scope === undefined) {
      throw new MemoryError('FORBIDDEN', 'caller has no memory scope')
    }
    return scope
  }

  async remember(request: RememberRequest): Promise<RememberResult> {
    const identity = await this.identityResolver.resolve(request.identity)
    const scope = await this.resolveScope(identity, request.scopeName)
    const policy = await this.policyFor(identity)
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
      if (scope.scope === 'session') {
        const sessionId = request.provenance.sessionId ?? identity.sessionId
        if (sessionId === undefined || sessionId === '') {
          throw new MemoryError('VALIDATION', 'session memory requires a session id')
        }
        this.metrics?.increment('remember.ephemeral')
        return this.ephemeral.remember({
          text: decision.text,
          scope,
          provenance: { ...request.provenance, sessionId },
          ...(request.tags === undefined ? {} : { tags: request.tags }),
        })
      }
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
        dedupeKey: request.dedupeKey ?? decision.dedupeKey,
        ...(tags === undefined ? {} : { tags }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
        metadata: {
          dedupeKey: request.dedupeKey ?? decision.dedupeKey,
          provenanceKind: request.provenance.kind,
          ...(decision.redacted ? { redacted: true } : {}),
        },
      })
      this.dedup.add({ id: result.id, text: decision.text, scope, createdAt: result.createdAt })
      if (this.provenanceIndex !== undefined) {
        try {
          // A segment summary carries its transcript pointer in the document
          // header. Indexing it is what gives the panel a Source section with
          // the exact turn/char range; without it the page can only name the
          // session.
          const summaryDocument = parseSummaryDocument(decision.text)
          this.provenanceIndex.recordWrite({
            id: result.id,
            scope,
            identity,
            createdAt: result.createdAt,
            text: decision.text,
            ...(summaryDocument === undefined ? {} : { pointer: summaryDocument.pointer }),
            ...(request.semanticKey === undefined ? {} : { semanticKey: request.semanticKey }),
            ...(request.supersedes === undefined ? {} : { supersedes: request.supersedes }),
            provenance: request.provenance,
            state: 'indexed',
          })
          if (request.supersedes !== undefined) {
            this.provenanceIndex.markSuperseded(request.supersedes, result.id)
          }
        } catch {
          this.metrics?.increment('provenance.record.failures')
        }
      }
      if (this.ledger !== undefined) {
        try {
          const sourceRefs =
            request.sourceRefs ??
            (request.provenance.sessionId === undefined
              ? []
              : [
                  {
                    sessionId: request.provenance.sessionId,
                    messageIndex: request.provenance.turn ?? 0,
                    producedAt: result.createdAt,
                  },
                ])
          this.ledger.recordWrite({
            recordId: result.id,
            scope,
            text: decision.text,
            ...(request.semanticKey === undefined ? {} : { semanticKey: request.semanticKey }),
            provenance: request.provenance,
            sourceRefs,
            createdAt: result.createdAt,
            ...(request.supersedes === undefined ? {} : { supersedes: request.supersedes }),
            ...(decision.redacted ? { redacted: true } : {}),
          })
          if (request.supersedes !== undefined) {
            this.ledger.markSuperseded(request.supersedes, result.id)
          }
        } catch {
          this.metrics?.increment('provenance.record.failures')
        }
      }
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

  /**
   * Deterministic "forget …" command. It recalls candidates in the caller's
   * chosen scope and forgets only exact scope matches, never another caller's
   * memory. Backends that cannot address synthetic ids simply report nothing
   * forgotten.
   */
  async forgetByText(request: {
    readonly text: string
    readonly identity: CallerIdentity
    readonly scopeName?: string
    readonly signal?: AbortSignal
  }): Promise<{ forgotten: number; ids: readonly string[] }> {
    const text = request.text.trim()
    if (text === '') return { forgotten: 0, ids: [] }
    const identity = await this.identityResolver.resolve(request.identity)
    const scope = await this.resolveScope(identity, request.scopeName)
    ;(await this.policyFor(identity)).assertWritable(scope)
    if (scope.scope === 'session') {
      if (identity.sessionId === undefined) return { forgotten: 0, ids: [] }
      const ids = this.ephemeral.forgetByText(identity.sessionId, scope, text)
      return { forgotten: ids.length, ids }
    }
    const hits = await this.recallService.recall({
      text,
      identity,
      limit: 10,
      ...(request.signal === undefined ? {} : { signal: request.signal }),
    })
    const ids: string[] = []
    for (const hit of hits) {
      if (!sameScope(hit.record.scope, scope)) continue
      if (!hit.record.id.startsWith('mem-') && !/^[0-9a-f-]{36}$/i.test(hit.record.id)) continue
      try {
        const result = await this.adapter.forget({
          id: hit.record.id,
          scope,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
        if (result.forgotten) ids.push(hit.record.id)
      } catch {
        // A single failed deletion does not abort the rest of the command.
      }
      if (ids.length >= 5) break
    }
    return { forgotten: ids.length, ids }
  }

  async forget(request: ForgetRequest): Promise<{ id: string; scope: ScopeRef; forgotten: boolean }> {
    const id = request.id.trim()
    if (id === '') throw new MemoryError('VALIDATION', 'memory id must not be empty')
    const identity = await this.identityResolver.resolve(request.identity)
    const scope = await this.resolveScope(identity, request.scopeName)
    ;(await this.policyFor(identity)).assertWritable(scope)
    this.metrics?.increment('forget.requests')
    try {
      if (scope.scope === 'session') {
        const sessionId = identity.sessionId
        if (sessionId === undefined) {
          throw new MemoryError('VALIDATION', 'session memory requires a session id')
        }
        return this.ephemeral.forget(sessionId, {
          id,
          scope,
          ...(request.signal === undefined ? {} : { signal: request.signal }),
        })
      }
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
      endpoint: safeEndpoint(this.activeEndpoint()),
    }
    return {
      adapter: { ...adapter, details: { ...adapter.details, ...details } },
      transport: adapter.transport,
      endpoint: safeEndpoint(this.activeEndpoint()),
      authMode: this.config.authMode,
      failureMode: this.config.failureMode,
      namespaces: await this.identityResolver.namespaces(),
      scopes: {
        allowGlobal: this.config.scopes.allowGlobal,
        defaultWriteScope: this.config.scopes.defaultWriteScope,
        session: 'ephemeral',
      },
      metrics: this.metrics?.snapshot() ?? {
        counters: {},
        samples: {
          'recall.latencyMs': { count: 0, p50: 0, p95: 0, max: 0, last: 0 },
          'prefetch.latencyMs': { count: 0, p50: 0, p95: 0, max: 0, last: 0 },
          'context.usage': { count: 0, p50: 0, p95: 0, max: 0, last: 0 },
          'extraction.llm.latencyMs': { count: 0, p50: 0, p95: 0, max: 0, last: 0 },
        },
      },
    }
  }

  async health(): Promise<HealthResult> {
    return this.adapter.health()
  }
}
