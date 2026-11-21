import { MemoryError, isMemoryError, toMemoryError } from '../errors.js'
import type { CogneeMemoryConfig } from '../config/schema.js'
import { scopeKey } from '../memory/scopes.js'
import type { Metrics } from '../telemetry/metrics.js'
import type {
  AdapterStatus,
  ForgetInput,
  ForgetResult,
  HealthResult,
  MemoryAdapter,
  RecallHit,
  RecallQuery,
  RememberInput,
  RememberResult,
} from '../types.js'
import { COGNEE_PATHS } from './cognee-paths.js'
import { localId, parseForgetResponse, parseRecallResponse, parseRememberResponse } from './cognee-response.js'
import { HttpJsonClient } from './http-client.js'

export interface CogneeAdapterRuntime {
  readonly config: CogneeMemoryConfig
  readonly env?: NodeJS.ProcessEnv
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  readonly random?: () => number
  readonly metrics?: Metrics
}

function fallbackId(input: RememberInput): string {
  return localId(input.scope, input.text, input.dedupeKey)
}

/** REST adapter for Cognee 1.6. Paths are UNVERIFIED; see cognee-paths.ts. */
export class CogneeRestAdapter implements MemoryAdapter {
  readonly transport = 'rest' as const
  private readonly client: HttpJsonClient
  private readonly config: CogneeMemoryConfig
  private readonly now: () => number
  private readonly metrics: Metrics | undefined

  constructor(runtime: CogneeAdapterRuntime) {
    this.config = runtime.config
    this.client = new HttpJsonClient(runtime)
    this.now = runtime.now ?? Date.now
    this.metrics = runtime.metrics
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    const nowIso = new Date(this.now()).toISOString()
    const response = await this.client.requestJson({
      method: 'POST',
      path: COGNEE_PATHS.add,
      operation: 'remember',
      body: {
        data: input.text,
        datasetName: scopeKey(input.scope),
        ...(input.tags === undefined ? {} : { nodeSet: input.tags }),
        ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
        ...(input.dedupeKey === undefined ? {} : { dedupeKey: input.dedupeKey }),
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    const parsed = parseRememberResponse(response, input.scope, fallbackId(input), nowIso)
    return {
      id: parsed.id,
      scope: input.scope,
      createdAt: parsed.createdAt,
      deduplicated: parsed.deduplicated,
    }
  }

  async recall(query: RecallQuery): Promise<readonly RecallHit[]> {
    const response = await this.client.requestJson({
      method: 'POST',
      path: COGNEE_PATHS.search,
      operation: 'recall',
      body: {
        query: query.text,
        search_type: 'GRAPH_COMPLETION',
        datasets: query.scopes.map(scopeKey),
        top_k: query.limit,
        ...(query.minScore === undefined ? {} : { min_score: query.minScore }),
      },
      ...(query.signal === undefined ? {} : { signal: query.signal }),
    })
    const nowIso = new Date(this.now()).toISOString()
    return parseRecallResponse(response, query.scopes, nowIso, Math.min(100, query.limit * 5))
  }

  async forget(input: ForgetInput): Promise<ForgetResult> {
    const response = await this.client.requestJson({
      method: 'DELETE',
      path: COGNEE_PATHS.delete,
      operation: 'forget',
      // 404/405/501 surface as UNSUPPORTED_OPERATION; never delete a dataset.
      unsupportedStatuses: [404, 405, 501],
      body: { dataId: input.id, datasetName: scopeKey(input.scope) },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    return {
      id: input.id,
      scope: input.scope,
      forgotten: parseForgetResponse(response),
    }
  }

  async status(signal?: AbortSignal): Promise<AdapterStatus> {
    const checkedAt = new Date(this.now()).toISOString()
    try {
      const response = await this.client.requestJson<unknown>({
        method: 'GET',
        path: COGNEE_PATHS.datasets,
        operation: 'status',
        ...(signal === undefined ? {} : { signal }),
      })
      const count = Array.isArray(response)
        ? response.length
        : response !== null && typeof response === 'object' && Array.isArray((response as { data?: unknown }).data)
          ? ((response as { data: unknown[] }).data.length)
          : undefined
      return {
        transport: 'rest',
        reachable: true,
        checkedAt,
        details: {
          ...(count === undefined ? {} : { datasetCount: count }),
          circuit: this.breakerState(),
        },
      }
    } catch (error) {
      const normalized = toMemoryError(error, 'UNAVAILABLE')
      return {
        transport: 'rest',
        reachable: false,
        checkedAt,
        details: { errorCode: normalized.code, circuit: this.breakerState() },
      }
    }
  }

  async health(): Promise<HealthResult> {
    const started = this.now()
    try {
      await this.client.request({
        method: 'GET',
        path: COGNEE_PATHS.health,
        operation: 'health',
        timeoutMs: this.config.connectionTimeoutMs,
      })
      return { ok: true, latencyMs: Math.max(0, this.now() - started) }
    } catch (error) {
      const normalized = isMemoryError(error) ? error : new MemoryError('UNAVAILABLE', 'memory backend is unavailable')
      return {
        ok: false,
        latencyMs: Math.max(0, this.now() - started),
        message: normalized.code,
      }
    }
  }

  private breakerState(): string {
    return this.client.breakerSnapshot()?.state ?? 'disabled'
  }
}

export function createCogneeRestAdapter(runtime: CogneeAdapterRuntime): CogneeRestAdapter {
  return new CogneeRestAdapter(runtime)
}
