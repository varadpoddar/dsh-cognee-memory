import { createHash } from 'node:crypto'
import type { JsonValue, MemoryRecord, RecallHit, ScopeRef } from '../types.js'
import { legacyScopeKey, scopeKey } from '../memory/scopes.js'
import { isPipelineComplete, isPipelineFailed } from './cognee-paths.js'

/** True for a lossless JSON object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function pickString(
  record: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim() !== '') return value
  }
  return undefined
}

export function pickNumber(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '') {
      const parsed = Number(value)
      if (Number.isFinite(parsed)) return parsed
    }
  }
  return undefined
}

export function pickBoolean(
  record: Record<string, unknown>,
  keys: readonly string[],
): boolean | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'boolean') return value
  }
  return undefined
}

const TEXT_KEYS = ['text', 'content', 'value', 'answer', 'memory', 'search_result', 'result'] as const
const ID_KEYS = ['id', 'data_id', 'dataId', 'memory_id', 'memoryId', 'uuid'] as const
const DATE_KEYS = ['createdAt', 'created_at', 'timestamp', 'time'] as const
const SCORE_KEYS = ['score', 'similarity', 'relevance', 'distance'] as const
const DATASET_KEYS = [
  'datasetName',
  'dataset_name',
  'dataset',
  'datasetKey',
  'dataset_id',
  'datasetNameKey',
  'scope',
  'scopeKey',
] as const

function textFrom(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim() !== '') return value
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => {
        if (typeof item === 'string') return item
        if (isRecord(item) && typeof item.text === 'string') return item.text
        return ''
      })
      .filter((part) => part !== '')
    return parts.length === 0 ? undefined : parts.join('\n')
  }
  if (isRecord(value)) return pickString(value, TEXT_KEYS)
  return undefined
}

export function extractRows(response: unknown): unknown[] {
  if (Array.isArray(response)) return response
  if (!isRecord(response)) return []
  for (const key of ['results', 'data', 'items', 'hits', 'memories', 'result']) {
    const value = response[key]
    if (Array.isArray(value)) return value
    if (isRecord(value)) {
      for (const nested of ['results', 'data', 'items', 'hits', 'memories']) {
        if (Array.isArray(value[nested])) return value[nested] as unknown[]
      }
      if (pickString(value, TEXT_KEYS) !== undefined) return [value]
    }
  }
  if (pickString(response, TEXT_KEYS) !== undefined) return [response]
  return []
}

function normalizeDatasetName(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

function matchScope(name: string | undefined, scopes: readonly ScopeRef[]): ScopeRef | undefined {
  if (name === undefined) return scopes.length === 1 ? scopes[0] : undefined
  const normalized = normalizeDatasetName(name)
  for (const scope of scopes) {
    if (
      normalized === scopeKey(scope) ||
      normalized === legacyScopeKey(scope) ||
      normalized === scope.id ||
      normalized === `${scope.scope}:${scope.id}` ||
      normalized === `${scope.scope}/${scope.id}`
    ) {
      return scope
    }
  }
  // Never label an unknown dataset as an authorized scope: the caller would
  // then treat foreign data as its own. Dropping the row is the safe default.
  return undefined
}

function scoreOf(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

/**
 * Cognee `/search` with `CHUNKS` ranks by vector *distance* in `score`
 * (observed 2026-11-22 on Cognee 1.6.10-local: an exact match scored
 * 0.0486, unrelated memories 0.39–0.49, and the backend returned ascending
 * distance). The plugin's contract is similarity — higher is better — and
 * `RecallService` sorts descending, so a raw distance would put the *least*
 * relevant memory first. Convert at the boundary.
 */
function similarityFromDistance(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, 1 - value))
}

function createdAtOf(value: unknown, fallback: string): string {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Observed live: `created_at` is epoch milliseconds (e.g. 1795307390969).
    const ms = value > 1e12 ? value : value * 1000
    const date = new Date(ms)
    return Number.isNaN(date.getTime()) ? fallback : date.toISOString()
  }
  if (typeof value === 'string' && !Number.isNaN(Date.parse(value))) return value
  return fallback
}

export interface ParsedRemember {
  readonly id: string
  readonly deduplicated: boolean
  readonly createdAt: string
  readonly datasetId?: string
  readonly pipelineRunId?: string
  readonly status?: string
  readonly dataIds: readonly string[]
}

/**
 * Parse a Cognee `/remember` (or `/add`, `/cognify`) response.
 *
 * Observed `/remember` shape (live, 2026-11-21):
 * `{status:"completed", dataset_name, dataset_id, pipeline_run_id,
 *   items_processed, elapsed_seconds, items:[{id}], improve:{...}}`
 * `/add` and `/cognify` answer `{status:"PipelineRunCompleted", dataset_id,
 *   pipeline_run_id, data_ingestion_info:[...], data_ids:[uuid]}` keyed by
 * dataset for `/cognify`.
 */
export function parseRememberResponse(
  response: unknown,
  scope: ScopeRef,
  fallbackId: string,
  nowIso: string,
): ParsedRemember {
  const containers: Record<string, unknown>[] = []
  if (isRecord(response)) {
    containers.push(response)
    if (isRecord(response.data)) containers.push(response.data)
    // `/cognify` answers `{<dataset_id>: PipelineRunInfo}`.
    for (const value of Object.values(response)) {
      if (isRecord(value) && value !== response.data) containers.push(value)
    }
    if (Array.isArray(response.items) && isRecord(response.items[0])) containers.push(response.items[0])
    if (Array.isArray(response.data) && isRecord(response.data[0])) containers.push(response.data[0])
  }
  const dataIds: string[] = []
  for (const container of containers) {
    for (const key of ['items', 'data_ids']) {
      const list = container[key]
      if (!Array.isArray(list)) continue
      for (const entry of list) {
        if (typeof entry === 'string' && entry !== '') dataIds.push(entry)
        else if (isRecord(entry)) {
          const id = pickString(entry, ID_KEYS)
          if (id !== undefined) dataIds.push(id)
        }
      }
    }
  }
  let id: string | undefined = dataIds[0]
  if (id === undefined) {
    for (const container of containers) {
      id = pickString(container, ID_KEYS)
      if (id !== undefined) break
    }
  }
  const deduplicated =
    containers.some((container) => pickBoolean(container, ['deduplicated', 'duplicate']) === true)
  const createdAt =
    containers.map((container) => pickString(container, DATE_KEYS)).find((value) => value !== undefined) ??
    nowIso
  let datasetId: string | undefined
  let pipelineRunId: string | undefined
  let status: string | undefined
  for (const container of containers) {
    datasetId ??= pickString(container, ['dataset_id', 'datasetId'])
    pipelineRunId ??= pickString(container, ['pipeline_run_id', 'pipelineRunId'])
    status ??= pickString(container, ['status'])
  }
  return {
    id: id ?? fallbackId,
    deduplicated,
    createdAt,
    dataIds,
    ...(datasetId === undefined ? {} : { datasetId }),
    ...(pipelineRunId === undefined ? {} : { pipelineRunId }),
    ...(status === undefined ? {} : { status }),
  }
}

export interface SearchGroup {
  readonly datasetId?: string
  readonly datasetName?: string
  readonly rows: readonly unknown[]
}

/**
 * Split a `/search` response into dataset groups.
 *
 * Observed live shape:
 * `[{dataset_id, dataset_name, dataset_tenant_id, search_result: [row, ...]}]`
 * where a row is either an object (CHUNKS: `{id, text, score, document_id,
 * document_name, created_at, belongs_to_set, ...}`) or a plain string
 * (GRAPH_COMPLETION: the synthesized answer).
 */
export function parseSearchGroups(response: unknown): SearchGroup[] {
  if (Array.isArray(response)) {
    const groups: SearchGroup[] = []
    let grouped = false
    for (const entry of response) {
      if (
        isRecord(entry) &&
        (entry.dataset_id !== undefined || entry.dataset_name !== undefined) &&
        Array.isArray(entry.search_result)
      ) {
        grouped = true
        const datasetId = pickString(entry, ['dataset_id', 'datasetId'])
        const datasetName = pickString(entry, ['dataset_name', 'datasetName'])
        groups.push({
          rows: entry.search_result as unknown[],
          ...(datasetId === undefined ? {} : { datasetId }),
          ...(datasetName === undefined ? {} : { datasetName }),
        })
      }
    }
    if (grouped) return groups
    // Flat row list (legacy/other transports).
    return [{ rows: response }]
  }
  return [{ rows: extractRows(response) }]
}

/**
 * Parse `/search` into scope-tagged hits. Rows are only accepted when their
 * dataset resolves to a scope the caller asked for; anything else is dropped,
 * so a foreign dataset can never be mislabeled as authorized.
 */
export function parseSearchResponse(
  response: unknown,
  scopes: readonly ScopeRef[],
  nowIso: string,
  maxRows = 100,
  scopeByDatasetId?: ReadonlyMap<string, ScopeRef>,
  scoreIsDistance = false,
): RecallHit[] {
  const hits: RecallHit[] = []
  for (const group of parseSearchGroups(response)) {
    const byId = group.datasetId === undefined ? undefined : scopeByDatasetId?.get(group.datasetId)
    const scope = byId ?? matchScope(group.datasetName, scopes)
    if (scope === undefined) continue
    // The backend names and UUID-identifies the dataset each group came from.
    // Carry it on the record so the provenance view can address the exact
    // dataset (the local scope map only derives a name).
    const datasetMetadata =
      group.datasetId === undefined && group.datasetName === undefined
        ? undefined
        : {
            ...(group.datasetId === undefined ? {} : { datasetId: group.datasetId }),
            ...(group.datasetName === undefined ? {} : { datasetName: group.datasetName }),
          }
    group.rows.forEach((row, index) => {
      if (hits.length >= maxRows) return
      if (typeof row === 'string') {
        if (row.trim() === '') return
        hits.push({
          record: {
            id: `graph-${createHash('sha256').update(`${scopeKey(scope)}\u0000${row}`).digest('hex').slice(0, 24)}`,
            text: row,
            scope,
            createdAt: nowIso,
            ...(datasetMetadata === undefined ? {} : { metadata: datasetMetadata }),
          },
          score: Math.max(0.05, 1 - index * 0.05),
        })
        return
      }
      if (!isRecord(row)) return
      const text = textFrom(row.text) ?? textFrom(row.content)
      if (text === undefined || text.trim() === '') return
      const dataId = pickString(row, ['document_id', 'documentId', 'data_id', 'dataId'])
      const rowId = pickString(row, ID_KEYS)
      const id =
        dataId ??
        rowId ??
        `chunk-${createHash('sha256').update(`${scopeKey(scope)}\u0000${text}`).digest('hex').slice(0, 24)}`
      const tags = Array.isArray(row.belongs_to_set)
        ? row.belongs_to_set.filter((tag): tag is string => typeof tag === 'string').slice(0, 16)
        : isRecord(row.external_metadata) && Array.isArray(row.external_metadata.node_set)
          ? (row.external_metadata.node_set as unknown[])
              .filter((tag): tag is string => typeof tag === 'string')
              .slice(0, 16)
          : undefined
      hits.push({
        record: {
          id,
          text,
          scope,
          createdAt: createdAtOf(row.created_at ?? row.createdAt, nowIso),
          ...(tags === undefined || tags.length === 0 ? {} : { tags }),
          ...(datasetMetadata === undefined
            ? {}
            : {
                metadata: {
                  ...datasetMetadata,
                  ...(tags === undefined || tags.length === 0 ? {} : { tags }),
                },
              }),
        },
        score: scoreIsDistance
          ? similarityFromDistance(pickNumber(row, SCORE_KEYS))
          : scoreOf(pickNumber(row, SCORE_KEYS)),
      })
    })
  }
  return hits
}

/** Legacy flat-row parser kept for the MCP transport, which may return plain JSON. */
export function parseRecallResponse(
  response: unknown,
  scopes: readonly ScopeRef[],
  nowIso: string,
  maxRows = 100,
): RecallHit[] {
  const hits: RecallHit[] = []
  for (const row of extractRows(response)) {
    if (!isRecord(row)) continue
    const scope = matchScope(pickString(row, DATASET_KEYS), scopes)
    if (scope === undefined) continue
    const text = textFrom(pickString(row, TEXT_KEYS)) ?? textFrom(row.content)
    if (text === undefined || text.trim() === '') continue
    const id =
      pickString(row, ID_KEYS) ??
      `row-${createHash('sha256')
        .update(`${scopeKey(scope)}\u0000${text}`)
        .digest('hex')
        .slice(0, 24)}`
    hits.push({
      record: {
        id,
        text,
        scope,
        createdAt: createdAtOf(row.created_at ?? row.createdAt, nowIso),
      },
      score: scoreOf(pickNumber(row, SCORE_KEYS)),
    })
    if (hits.length >= maxRows) break
  }
  return hits
}

export interface MemoryStatusSnapshot {
  readonly state?: string
  readonly searchable: boolean
  readonly graphReady: boolean
  readonly errorMessage?: string
  readonly indexingStatus?: string
  readonly cognifyStatus?: string
}

/**
 * Parse `GET /datasets/status/memory?dataset=`.
 *
 * Observed live: `{<dataset_id>:{state:"ready",search_level:"graph",
 * searchable:true,graph_ready:true,message,indexing_status,cognify_status,
 * error_class,error_message}}`; `staged` with `searchable:false` before cognify.
 */
export function parseMemoryStatus(response: unknown, datasetId: string): MemoryStatusSnapshot {
  let body: unknown = response
  if (isRecord(response) && isRecord(response[datasetId])) body = response[datasetId]
  if (!isRecord(body)) return { searchable: false, graphReady: false }
  const errorMessage = pickString(body, ['error_message', 'errorMessage'])
  return {
    ...(pickString(body, ['state']) === undefined ? {} : { state: pickString(body, ['state']) }),
    searchable: pickBoolean(body, ['searchable']) === true,
    graphReady: pickBoolean(body, ['graph_ready', 'graphReady']) === true,
    ...(errorMessage === undefined ? {} : { errorMessage }),
    ...(pickString(body, ['indexing_status', 'indexingStatus']) === undefined
      ? {}
      : { indexingStatus: pickString(body, ['indexing_status', 'indexingStatus']) }),
    ...(pickString(body, ['cognify_status', 'cognifyStatus']) === undefined
      ? {}
      : { cognifyStatus: pickString(body, ['cognify_status', 'cognifyStatus']) }),
  }
}

/**
 * Parse `GET /datasets/status?dataset=&pipeline=`, which answers
 * `{<dataset_id>:"DATASET_PROCESSING_COMPLETED"}` on the live instance.
 */
export function parsePipelineStatus(response: unknown, datasetId: string): string | undefined {
  if (isRecord(response)) {
    const direct = response[datasetId]
    if (typeof direct === 'string') return direct
    if (isRecord(direct)) return pickString(direct, ['status', 'pipeline_status'])
    const status = pickString(response, ['status', 'pipeline_status'])
    if (status !== undefined) return status
  }
  return typeof response === 'string' ? response : undefined
}

/** Parse `GET /datasets/{id}/processing-status` -> `{total,completed,pending,items}`. */
export function parseProcessingStatus(
  response: unknown,
): { total?: number; completed?: number; pending?: number } {
  if (!isRecord(response)) return {}
  return {
    ...(pickNumber(response, ['total']) === undefined ? {} : { total: pickNumber(response, ['total']) }),
    ...(pickNumber(response, ['completed']) === undefined
      ? {}
      : { completed: pickNumber(response, ['completed']) }),
    ...(pickNumber(response, ['pending']) === undefined ? {} : { pending: pickNumber(response, ['pending']) }),
  }
}

export interface DataItem {
  readonly id: string
  readonly name?: string
  readonly contentHash?: string
}

/** Parse `GET /datasets/{id}/data` -> `[{id,name,contentHash,...}]`. */
export function parseDataList(response: unknown): DataItem[] {
  const rows = Array.isArray(response)
    ? response
    : isRecord(response) && Array.isArray(response.data)
      ? response.data
      : []
  const items: DataItem[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const id = pickString(row, ['id', 'data_id'])
    if (id === undefined) continue
    items.push({
      id,
      ...(pickString(row, ['name']) === undefined ? {} : { name: pickString(row, ['name']) }),
      ...(pickString(row, ['contentHash', 'content_hash']) === undefined
        ? {}
        : { contentHash: pickString(row, ['contentHash', 'content_hash']) }),
    })
  }
  return items
}

/**
 * Data ids in the order the documents were submitted.
 *
 * Observed `/add` shape: `data_ingestion_info: [{run_info: {...}, data_id,
 * data_name: "text_<hash>"}]` plus `data_ids: [...]`, one entry per submitted
 * document. `data_name` is NOT reliably `text_<md5(raw text)>` for multi-line
 * summaries (measured: it matches for short ASCII text and does not for real
 * 3 KB summaries), so the response order is the authoritative mapping. Never
 * derive the batch→id pairing from the dataset listing: it is eventually
 * consistent and can still miss rows right after a large add.
 */
export function dataIdsInOrder(response: unknown): string[] {
  const ids: string[] = []
  if (!isRecord(response)) return ids
  const info = response.data_ingestion_info
  if (Array.isArray(info)) {
    for (const entry of info) {
      if (!isRecord(entry)) continue
      const id = pickString(entry, ['data_id', 'dataId', 'id'])
      if (id !== undefined) ids.push(id)
    }
  }
  if (ids.length > 0) return ids
  const flat = response.data_ids
  if (Array.isArray(flat)) {
    for (const entry of flat) {
      if (typeof entry === 'string' && entry !== '') ids.push(entry)
    }
  }
  return ids
}

/** The live instance stores `contentHash = md5(raw text)`; used to find a deduped write. */
export function contentHashOf(text: string): string {
  return createHash('md5').update(text).digest('hex')
}

/**
 * Parse a `/forget` response. Live shape:
 * `{status:"success", dataset_id, data_id, data_record_found:true,
 *   deleted_nodes, deleted_edges, data_remaining:false, dataset_deleted:false}`.
 * A missing record is reported as `data_record_found:false` with HTTP 200.
 */
export function parseForgetResponse(response: unknown): boolean {
  if (!isRecord(response)) return true
  if (pickBoolean(response, ['data_record_found', 'dataRecordFound']) === false) return false
  const status = pickString(response, ['status', 'result'])
  if (status !== undefined) return /success|deleted|forgotten|ok/i.test(status)
  const deleted = pickBoolean(response, ['deleted', 'forgotten', 'success'])
  return deleted !== false
}

/** JSON-value fallback for a deterministic local id when the backend omits one. */
export function localId(scope: ScopeRef, text: string, dedupeKey?: string): string {
  const digest = createHash('sha256')
    .update(`${scopeKey(scope)}\u0000${dedupeKey ?? text}`)
    .digest('hex')
  return `local-${digest.slice(0, 32)}`
}

/** Ensure an adapter-supplied metadata object is lossless JSON. */
export function jsonMetadata(
  metadata: Readonly<Record<string, JsonValue>> | undefined,
): JsonValue | undefined {
  return metadata === undefined ? undefined : (metadata as JsonValue)
}

export { isPipelineComplete, isPipelineFailed }
