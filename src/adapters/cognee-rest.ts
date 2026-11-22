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
  MemoryInventory,
  RecallHit,
  RecallQuery,
  RememberInput,
  RememberResult,
  ScopeRef,
} from '../types.js'
import {
  DatasetRegistry,
  isUuid,
  parseDatasetList,
  type CogneeDataset,
} from './cognee-datasets.js'
import { COGNEE_PATHS } from './cognee-paths.js'
import {
  contentHashOf,
  isRecord,
  localId,
  parseDataList,
  parseForgetResponse,
  parseMemoryStatus,
  parsePipelineStatus,
  parseRememberResponse,
  parseSearchResponse,
  pickString,
} from './cognee-response.js'
import { HttpJsonClient } from './http-client.js'
import { sleep as defaultSleep } from './resilience.js'

export interface CogneeAdapterRuntime {
  readonly config: CogneeMemoryConfig
  readonly env?: NodeJS.ProcessEnv
  readonly fetchImpl?: typeof fetch
  readonly now?: () => number
  readonly sleep?: (delayMs: number, signal?: AbortSignal) => Promise<void>
  readonly random?: () => number
  readonly metrics?: Metrics
  /** Live endpoint source; see `HttpJsonClientOptions.endpoint`. */
  readonly endpoint?: () => string
}

function fallbackId(input: RememberInput): string {
  return localId(input.scope, input.text, input.dedupeKey)
}

function isTimeoutLike(error: unknown): boolean {
  return isMemoryError(error) && (error.code === 'TIMEOUT' || error.code === 'UNAVAILABLE')
}

/**
 * REST adapter for Cognee 1.6.10-local, verified against the live instance.
 *
 * Contract notes that differ from earlier assumptions:
 *  - `/remember` and `/add` are `multipart/form-data`; a JSON body is ignored
 *    and the request fails with "Either datasetId or datasetName must be
 *    provided".
 *  - Writes always target a dataset UUID resolved by {@link DatasetRegistry}.
 *    A name the caller does not own would be silently re-created instead.
 *  - A 2xx from `/remember` is not completion: the adapter polls
 *    `status/memory` + `status?pipeline=cognify_pipeline` before returning.
 *  - `/search` answers per-dataset groups; recall is capped by
 *    `recall.maxRecallLatencyMs` and degrades to no hits in `open` mode.
 */
export class CogneeRestAdapter implements MemoryAdapter {
  readonly transport = 'rest' as const
  private readonly client: HttpJsonClient
  private readonly config: CogneeMemoryConfig
  private readonly now: () => number
  private readonly sleep: (delayMs: number, signal?: AbortSignal) => Promise<void>
  private readonly metrics: Metrics | undefined
  private readonly registry: DatasetRegistry

  constructor(runtime: CogneeAdapterRuntime) {
    this.config = runtime.config
    this.client = new HttpJsonClient(runtime)
    this.now = runtime.now ?? Date.now
    this.sleep = runtime.sleep ?? defaultSleep
    this.metrics = runtime.metrics
    this.registry = new DatasetRegistry({
      client: this.client,
      config: runtime.config,
      now: this.now,
    })
  }

  /** Authenticated Cognee user behind the API key; used for stable namespaces. */
  async probePrincipal(): Promise<string | undefined> {
    return this.registry.currentUserId()
  }

  async remember(input: RememberInput): Promise<RememberResult> {
    if (input.scope.scope === 'session') {
      throw new MemoryError('VALIDATION', 'session memory is ephemeral and never written to Cognee')
    }
    const nowIso = new Date(this.now()).toISOString()
    const dataset = await this.registry.ensure(input.scope, input.signal)
    const before = await this.listDataIds(dataset.id, input.signal)

    const form = new FormData()
    form.set('raw_data', input.text)
    form.set('datasetId', dataset.id)
    if (input.tags !== undefined && input.tags.length > 0) {
      form.set('node_set', JSON.stringify(input.tags))
    }

    let response: unknown
    try {
      response = await this.client.requestJson({
        method: 'POST',
        path: COGNEE_PATHS.remember,
        form,
        operation: 'remember',
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      })
    } catch (error) {
      // A vanished dataset (deleted out-of-band) invalidates the cached mapping.
      const normalized = toMemoryError(error, 'BACKEND')
      if (normalized.code === 'NOT_FOUND' || normalized.code === 'FORBIDDEN') this.registry.invalidate()
      throw normalized
    }

    const parsed = parseRememberResponse(response, input.scope, fallbackId(input), nowIso)
    if (parsed.datasetId !== undefined && parsed.datasetId !== dataset.id) {
      throw new MemoryError(
        'BACKEND',
        'Cognee acknowledged a write against a different dataset than the one requested',
        { details: { requested: dataset.id } },
      )
    }

    // Completion is derived from pipeline/memory status, never from the 2xx.
    await this.awaitIngestion(dataset.id, input.signal)

    let id = parsed.dataIds.find((candidate) => !before.has(candidate))
    let deduplicated = false
    if (id === undefined) {
      const after = await this.listData(dataset.id, input.signal)
      const match = after.find((item) => item.contentHash === contentHashOf(input.text))
      if (match !== undefined) {
        id = match.id
        deduplicated = before.has(match.id)
      }
    }
    return {
      id: id ?? parsed.id ?? fallbackId(input),
      scope: input.scope,
      createdAt: parsed.createdAt,
      deduplicated,
    }
  }

  async recall(query: RecallQuery): Promise<readonly RecallHit[]> {
    const scopeByDatasetId = new Map<string, ScopeRef>()
    const datasetIds: string[] = []
    for (const scope of query.scopes) {
      if (scope.scope === 'session') continue
      const dataset = await this.registry.lookup(scope, query.signal)
      if (dataset !== undefined) {
        datasetIds.push(dataset.id)
        scopeByDatasetId.set(dataset.id, scope)
      }
      const legacy = await this.registry.lookupLegacy(scope, query.signal)
      if (legacy !== undefined && !datasetIds.includes(legacy.id)) {
        datasetIds.push(legacy.id)
        scopeByDatasetId.set(legacy.id, scope)
      }
    }
    // Read paths never create datasets: an empty scope is simply empty.
    if (datasetIds.length === 0) return []

    const budget = this.config.recall.maxRecallLatencyMs
    let response: unknown
    try {
      response = await this.client.requestJson({
        method: 'POST',
        path: COGNEE_PATHS.search,
        operation: 'recall',
        body: {
          query: query.text,
          searchType: this.config.recall.searchType,
          datasetIds,
          topK: query.limit,
        },
        timeoutMs: budget,
        maxRetries: 0,
        ...(query.signal === undefined ? {} : { signal: query.signal }),
      })
    } catch (error) {
      if (this.config.failureMode === 'open' && isTimeoutLike(error)) {
        // Degrade quietly: a slow graph search must not stall the turn.
        this.metrics?.increment('recall.degraded')
        return []
      }
      throw error
    }

    const nowIso = new Date(this.now()).toISOString()
    // CHUNKS rows carry a vector distance; convert it to the plugin's
    // similarity contract so higher always means more relevant.
    return parseSearchResponse(
      response,
      query.scopes,
      nowIso,
      query.limit,
      scopeByDatasetId,
      this.config.recall.searchType === 'CHUNKS',
    )
  }

  async forget(input: ForgetInput): Promise<ForgetResult> {
    const dataset = await this.registry.lookup(input.scope, input.signal)
    if (dataset === undefined) {
      return { id: input.id, scope: input.scope, forgotten: false }
    }
    // Never send a synthetic id (e.g. a graph-completion hash) to the backend.
    if (!isUuid(input.id)) {
      return { id: input.id, scope: input.scope, forgotten: false }
    }
    const response = await this.client.requestJson({
      method: 'POST',
      path: COGNEE_PATHS.forget,
      operation: 'forget',
      unsupportedStatuses: [404, 405, 501],
      body: { datasetId: dataset.id, dataId: input.id },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    })
    return {
      id: input.id,
      scope: input.scope,
      forgotten: parseForgetResponse(response),
    }
  }

  /** Read-only dataset and record inventory for the settings page (Milestone 9). */
  async inventory(signal?: AbortSignal): Promise<MemoryInventory> {
    const checkedAt = new Date(this.now()).toISOString()
    const response = await this.client.requestJson<unknown>({
      method: 'GET',
      path: COGNEE_PATHS.datasets,
      operation: 'datasets.inventory',
      ...(signal === undefined ? {} : { signal }),
    })
    const all = parseDatasetList(response)
    const bounded = all.slice(0, 10)
    const counts = await Promise.all(
      bounded.map(async (dataset) => {
        try {
          return (await this.listData(dataset.id, signal)).length
        } catch {
          return undefined
        }
      }),
    )
    const datasets = bounded.map((dataset, index) => {
      const dataCount = counts[index]
      return {
        id: dataset.id,
        name: dataset.name,
        ...(dataCount === undefined ? {} : { dataCount }),
      }
    })
    const complete = datasets.every((dataset) => dataset.dataCount !== undefined)
    const totalRecords = complete
      ? datasets.reduce((sum, dataset) => sum + (dataset.dataCount ?? 0), 0)
      : undefined
    return {
      datasets,
      ...(totalRecords === undefined ? {} : { totalRecords }),
      checkedAt,
      ...(all.length > bounded.length ? { truncated: true } : {}),
    }
  }

  /** Exact-name dataset lookup for the provenance detail view (UUID is backend-assigned). */
  async lookupDataset(
    name: string,
    signal?: AbortSignal,
  ): Promise<{ id: string; name: string } | undefined> {
    const wanted = name.trim()
    if (wanted === '') return undefined
    const response = await this.client.requestJson<unknown>({
      method: 'GET',
      path: COGNEE_PATHS.datasets,
      operation: 'datasets.lookup',
      ...(signal === undefined ? {} : { signal }),
    })
    const found = parseDatasetList(response).find((dataset) => dataset.name === wanted)
    return found === undefined ? undefined : { id: found.id, name: found.name }
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
      const list = parseDataListOrDatasets(response)
      return {
        transport: 'rest',
        reachable: true,
        checkedAt,
        details: {
          endpointPath: '/api/v1',
          datasetCount: list.length,
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
      const result = await this.client.request({
        method: 'GET',
        path: COGNEE_PATHS.health,
        originRelative: true,
        operation: 'health',
        timeoutMs: this.config.connectionTimeoutMs,
        maxRetries: 0,
      })
      const latencyMs = Math.max(0, this.now() - started)
      let status: string | undefined
      let version: string | undefined
      try {
        const body: unknown = JSON.parse(result.text)
        if (isRecord(body)) {
          status = pickString(body, ['status', 'health'])
          version = pickString(body, ['version'])
        }
      } catch {
        // A 200 with a non-JSON body still proves reachability.
      }
      const healthy = status === undefined || /ready|ok|healthy/i.test(status)
      return {
        ok: healthy,
        latencyMs,
        ...(version === undefined ? {} : { message: `cognee ${version}` }),
      }
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

  private async listData(datasetId: string, signal?: AbortSignal) {
    const response = await this.client.requestJson<unknown>({
      method: 'GET',
      path: COGNEE_PATHS.datasetData(datasetId),
      operation: 'dataset.data',
      timeoutMs: 10_000,
      maxRetries: 0,
      ...(signal === undefined ? {} : { signal }),
    })
    return parseDataList(response)
  }

  private async listDataIds(datasetId: string, signal?: AbortSignal): Promise<Set<string>> {
    try {
      const items = await this.listData(datasetId, signal)
      return new Set(items.map((item) => item.id))
    } catch {
      // Listing is only used to disambiguate the new data id; never fail a write on it.
      return new Set()
    }
  }

  /**
   * Poll until Cognee reports the dataset searchable and the cognify pipeline
   * complete. Throws BACKEND on a reported failure and TIMEOUT on budget expiry,
   * because a write that is not searchable is not a completed write.
   */
  private async awaitIngestion(datasetId: string, signal?: AbortSignal): Promise<void> {
    const deadline = this.now() + this.config.ingestion.timeoutMs
    let lastState: string | undefined
    for (;;) {
      const memoryResponse = await this.client.requestJson<unknown>({
        method: 'GET',
        path: COGNEE_PATHS.memoryStatus,
        operation: 'ingestion.memory',
        query: { dataset: datasetId },
        timeoutMs: 10_000,
        maxRetries: 0,
        ...(signal === undefined ? {} : { signal }),
      })
      const memory = parseMemoryStatus(memoryResponse, datasetId)
      lastState = memory.state
      if (memory.errorMessage !== undefined) {
        throw new MemoryError('BACKEND', 'Cognee reported an ingestion error for the dataset', {
          details: { datasetId, state: memory.state },
        })
      }
      if (memory.searchable) {
        const pipelineResponse = await this.client.requestJson<unknown>({
          method: 'GET',
          path: COGNEE_PATHS.pipelineStatus,
          operation: 'ingestion.pipeline',
          query: { dataset: datasetId, pipeline: 'cognify_pipeline' },
          timeoutMs: 10_000,
          maxRetries: 0,
          ...(signal === undefined ? {} : { signal }),
        })
        const pipeline = parsePipelineStatus(pipelineResponse, datasetId)
        if (pipeline === undefined || /fail|error|cancel/i.test(pipeline)) {
          throw new MemoryError('BACKEND', 'Cognee cognify pipeline did not complete for the dataset', {
            details: { datasetId, pipeline: pipeline ?? 'missing' },
          })
        }
        if (/completed/i.test(pipeline)) return
      }
      if (this.now() >= deadline) {
        throw new MemoryError('TIMEOUT', 'timed out waiting for Cognee to make the memory searchable', {
          retryable: true,
          details: { datasetId, lastState: lastState ?? 'unknown' },
        })
      }
      await this.sleep(this.config.ingestion.pollMs, signal)
    }
  }
}

function parseDataListOrDatasets(value: unknown): unknown[] {
  if (Array.isArray(value)) return value
  if (isRecord(value)) {
    for (const key of ['data', 'datasets']) {
      if (Array.isArray(value[key])) return value[key] as unknown[]
    }
  }
  return []
}

export function createCogneeRestAdapter(runtime: CogneeAdapterRuntime): CogneeRestAdapter {
  return new CogneeRestAdapter(runtime)
}

export type { CogneeDataset }
