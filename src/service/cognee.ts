/**
 * Shared `ctx.cognee` service.
 *
 * Registration idiom: Cordis gives a plugin one fiber-owned way to publish a
 * named service — `ctx.provide(name, value)`; the value is unregistered when
 * the returned disposer runs or the providing fiber unloads
 * (`cordis/lib/types/context.d.ts:36-41`, `reflect.d.ts:33-41`). The `Service`
 * base class is a thin wrapper over exactly that call
 * (`service.d.ts:5-10,31-38` calls `ctx.reflect.provide(name, this, check)`),
 * but it cannot be imported here: `@deepseek-ai/cordis` is not resolvable from
 * the deployed profile (verified: ERR_MODULE_NOT_FOUND from
 * `$DSH_HOME/profiles/web`), so the service is a plain typed object registered
 * through the same underlying `ctx.provide` primitive.
 *
 * Every method delegates to the plugin's single `MemoryCoordinator`, so the
 * service cannot bypass scope authorization, write policy, deduplication,
 * budgets, or the ledger/provenance side effects. Read paths degrade like the
 * coordinator's `open` failure mode; writes surface typed `MemoryError`s.
 */
import { MemoryError, isMemoryError } from '../errors.js'
import type { CogneeMemoryConfig } from '../config/schema.js'
import type { MemoryCoordinator } from '../memory/coordinator.js'
import type { Metrics } from '../telemetry/metrics.js'
import type {
  CallerIdentity,
  PluginContextLike,
  Provenance,
  RecallHit,
  ScopeRef,
} from '../types.js'

/** Service name; consumers depend on it with `inject: ['cognee']`. */
export const COGNEE_SERVICE_NAME = 'cognee'

export interface CogneeRecallOptions {
  /** Caller identity; defaults to the deployment-resolved operator identity. */
  readonly identity?: CallerIdentity
  /** Narrow the recall to one readable scope (same rule as the tools). */
  readonly scopeName?: string
  readonly limit?: number
  readonly minScore?: number
  readonly signal?: AbortSignal
}

export interface CogneeRememberCandidate {
  readonly text: string
  readonly scopeName?: string
  readonly tags?: readonly string[]
  /** Caller-supplied authoritative provenance; defaults to a service call. */
  readonly provenance?: Provenance
  readonly dedupeKey?: string
  readonly semanticKey?: string
  readonly signal?: AbortSignal
}

export interface CogneeForgetOptions {
  readonly identity?: CallerIdentity
  readonly scopeName?: string
  readonly signal?: AbortSignal
}

export interface CogneeServiceStatus {
  readonly enabled: boolean
  readonly reachable: boolean
  readonly transport: string
  readonly endpoint: string
  readonly authMode: string
  readonly failureMode: string
  readonly scopes: {
    readonly readable: readonly ScopeRef[]
    readonly allowGlobal: boolean
    readonly defaultWriteScope: string
  }
  readonly metrics?: Readonly<Record<string, number>>
}

/** The typed surface published as `ctx.cognee`. */
export interface CogneeServiceApi {
  recall(query: string, options?: CogneeRecallOptions): Promise<readonly RecallHit[]>
  remember(
    candidate: CogneeRememberCandidate,
    options?: { readonly identity?: CallerIdentity },
  ): Promise<{ id: string; scope: ScopeRef; createdAt: string; deduplicated: boolean }>
  forget(
    id: string,
    options?: CogneeForgetOptions,
  ): Promise<{ id: string; scope: ScopeRef; forgotten: boolean }>
  status(): Promise<CogneeServiceStatus>
  scopesFor(identity: CallerIdentity): Promise<readonly ScopeRef[]>
}

export interface CogneeServiceDependencies {
  readonly coordinator: Pick<
    MemoryCoordinator,
    'resolveIdentity' | 'policyFor' | 'remember' | 'recall' | 'forget' | 'status'
  >
  readonly config: CogneeMemoryConfig
  readonly metrics?: Metrics
  readonly now?: () => Date
}

const DEGRADABLE_CODES = new Set([
  'UNAVAILABLE',
  'TIMEOUT',
  'BACKEND',
  'CIRCUIT_OPEN',
  'RATE_LIMITED',
])

/**
 * Read paths inherit `failureMode: open` (empty reads, no turn failure). An
 * authorization or validation failure is never swallowed: it is a caller bug,
 * not a backend outage.
 */
function isDegradable(error: unknown): boolean {
  return isMemoryError(error) && DEGRADABLE_CODES.has(error.code)
}

/**
 * Build the service object. It owns no transport: every call reaches Cognee
 * through the coordinator the plugin already configured.
 */
export function createCogneeService(deps: CogneeServiceDependencies): CogneeServiceApi {
  const clock = deps.now ?? (() => new Date())

  const service: CogneeServiceApi = {
    async recall(query, options = {}) {
      const text = query.trim()
      if (text === '') return []
      const identity = await deps.coordinator.resolveIdentity(options.identity ?? {})
      try {
        return await deps.coordinator.recall({
          text,
          identity,
          ...(options.limit === undefined ? {} : { limit: options.limit }),
          ...(options.minScore === undefined ? {} : { minScore: options.minScore }),
          ...(options.signal === undefined ? {} : { signal: options.signal }),
        })
      } catch (error) {
        if (isDegradable(error)) {
          deps.metrics?.increment('cognee.service.degraded')
          return []
        }
        throw error
      }
    },

    async remember(candidate, options = {}) {
      const text = candidate.text.trim()
      if (text === '') {
        throw new MemoryError('VALIDATION', 'memory text must not be empty')
      }
      const identity = await deps.coordinator.resolveIdentity(options.identity ?? {})
      return deps.coordinator.remember({
        text,
        identity,
        ...(candidate.scopeName === undefined ? {} : { scopeName: candidate.scopeName }),
        ...(candidate.tags === undefined ? {} : { tags: candidate.tags }),
        provenance: candidate.provenance ?? {
          kind: 'tool_call',
          source: `ctx.${COGNEE_SERVICE_NAME}`,
          recordedAt: clock().toISOString(),
        },
        ...(candidate.dedupeKey === undefined ? {} : { dedupeKey: candidate.dedupeKey }),
        ...(candidate.semanticKey === undefined ? {} : { semanticKey: candidate.semanticKey }),
        ...(candidate.signal === undefined ? {} : { signal: candidate.signal }),
      })
    },

    async forget(id, options = {}) {
      const identity = await deps.coordinator.resolveIdentity(options.identity ?? {})
      return deps.coordinator.forget({
        id,
        identity,
        ...(options.scopeName === undefined ? {} : { scopeName: options.scopeName }),
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    },

    async status() {
      const identity = await deps.coordinator.resolveIdentity({})
      const degraded: CogneeServiceStatus = {
        enabled: deps.config.enabled,
        reachable: false,
        transport: deps.config.transport,
        endpoint: deps.config.apiBaseUrl,
        authMode: deps.config.authMode,
        failureMode: deps.config.failureMode,
        scopes: {
          readable: [],
          allowGlobal: deps.config.scopes.allowGlobal,
          defaultWriteScope: deps.config.scopes.defaultWriteScope,
        },
      }
      try {
        const status = await deps.coordinator.status()
        const policy = await deps.coordinator.policyFor(identity)
        return {
          enabled: deps.config.enabled,
          reachable: status.adapter.reachable,
          transport: status.transport,
          endpoint: status.endpoint,
          authMode: status.authMode,
          failureMode: status.failureMode,
          scopes: {
            readable: policy.readableScopes,
            allowGlobal: deps.config.scopes.allowGlobal,
            defaultWriteScope: deps.config.scopes.defaultWriteScope,
          },
          metrics: status.metrics.counters,
        }
      } catch (error) {
        if (isDegradable(error)) {
          deps.metrics?.increment('cognee.service.degraded')
          return degraded
        }
        throw error
      }
    },

    async scopesFor(identity) {
      const policy = await deps.coordinator.policyFor(identity)
      return policy.readableScopes
    },
  }

  return Object.freeze(service)
}

/**
 * Publish the service on the plugin's own fiber. A context without `provide`
 * (plain structural test doubles) is a no-op rather than a crash; a duplicate
 * registration is reported to telemetry and leaves the existing provider in
 * place, so loading the plugin twice never takes the process down.
 */
export function registerCogneeService(
  ctx: PluginContextLike,
  deps: CogneeServiceDependencies,
): () => void {
  if (typeof ctx.provide !== 'function') return () => {}
  try {
    const dispose = ctx.provide(COGNEE_SERVICE_NAME, createCogneeService(deps))
    return typeof dispose === 'function' ? () => void dispose() : () => {}
  } catch {
    deps.metrics?.increment('cognee.service.conflict')
    return () => {}
  }
}
