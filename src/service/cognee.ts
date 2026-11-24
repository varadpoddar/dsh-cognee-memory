/**
 * Shared `ctx.cognee` service.
 *
 * Cordis 4 exports a `Service` base class whose constructor owns publication:
 * `super(ctx, name)` calls `ctx.reflect.provide(name, this, check)`, and the
 * registration is removed with the providing fiber. DSH 0.2.1-rc.5 bundles
 * `@deepseek-ai/cordis@4.0.5`; the plugin declares that exact version as a
 * required peer so the deployed profile links one copy and the class identity
 * is shared with the host.
 *
 * Every method delegates to the plugin's single `MemoryCoordinator`, so the
 * service cannot bypass scope authorization, write policy, deduplication,
 * budgets, or the ledger/provenance side effects. Read paths degrade like the
 * coordinator's `open` failure mode; writes surface typed `MemoryError`s.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import { MemoryError, isMemoryError } from '../errors.js'
import type { CogneeMemoryConfig } from '../config/schema.js'
import type { MemoryCoordinator } from '../memory/coordinator.js'
import type { Metrics } from '../telemetry/metrics.js'
import type {
  CallerIdentity,
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
 * Build and publish the class-backed `ctx.cognee` service. `Service` owns
 * registration and automatic removal with the providing fiber; there is no
 * manual disposer to leak.
 *
 * The API is constructed before `super()` because Cordis may activate a
 * dependent synchronously while `provide()` runs. The class methods close over
 * that API rather than a field initialized after `super()`, so a dependent can
 * call `ctx.cognee` the moment it becomes visible.
 */
export function createCogneeServiceRegistration(
  ctx: Context,
  deps: CogneeServiceDependencies,
): CogneeServiceApi {
  const api = createCogneeService(deps)
  class CogneeService extends Service implements CogneeServiceApi {
    recall(query: string, options?: CogneeRecallOptions): Promise<readonly RecallHit[]> {
      return api.recall(query, options)
    }

    remember(
      candidate: CogneeRememberCandidate,
      options?: { readonly identity?: CallerIdentity },
    ): Promise<{ id: string; scope: ScopeRef; createdAt: string; deduplicated: boolean }> {
      return api.remember(candidate, options)
    }

    forget(
      id: string,
      options?: CogneeForgetOptions,
    ): Promise<{ id: string; scope: ScopeRef; forgotten: boolean }> {
      return api.forget(id, options)
    }

    status(): Promise<CogneeServiceStatus> {
      return api.status()
    }

    scopesFor(identity: CallerIdentity): Promise<readonly ScopeRef[]> {
      return api.scopesFor(identity)
    }
  }
  return new CogneeService(ctx, COGNEE_SERVICE_NAME)
}
