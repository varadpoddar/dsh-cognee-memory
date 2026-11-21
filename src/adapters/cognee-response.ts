import { createHash } from 'node:crypto'
import type { JsonValue, MemoryRecord, RecallHit, ScopeRef } from '../types.js'
import { scopeKey } from '../memory/scopes.js'

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

export interface ParsedRecallRow {
  readonly record: MemoryRecord
  readonly score: number
}

/** Parse a Cognee add/remember response tolerantly without trusting its shape. */
export function parseRememberResponse(
  response: unknown,
  scope: ScopeRef,
  fallbackId: string,
  nowIso: string,
): { id: string; deduplicated: boolean; createdAt: string } {
  const containers: Record<string, unknown>[] = []
  if (isRecord(response)) {
    containers.push(response)
    if (isRecord(response.data)) containers.push(response.data)
    if (Array.isArray(response.items) && isRecord(response.items[0])) containers.push(response.items[0])
    if (Array.isArray(response.data) && isRecord(response.data[0])) containers.push(response.data[0])
  }
  let id: string | undefined
  for (const container of containers) {
    id = pickString(container, ID_KEYS)
    if (id !== undefined) break
  }
  const deduplicated =
    containers.some((container) => pickBoolean(container, ['deduplicated', 'duplicate']) === true)
  const createdAt =
    containers.map((container) => pickString(container, DATE_KEYS)).find((value) => value !== undefined) ??
    nowIso
  return { id: id ?? fallbackId, deduplicated, createdAt }
}

/** Parse a search response into scope-tagged hits. Unknown/foreign datasets are dropped. */
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
    const rawScore = pickNumber(row, SCORE_KEYS)
    const score = rawScore === undefined ? 0.5 : Math.min(1, Math.max(0, rawScore))
    const createdAt =
      pickString(row, DATE_KEYS) !== undefined &&
      !Number.isNaN(Date.parse(pickString(row, DATE_KEYS) as string))
        ? (pickString(row, DATE_KEYS) as string)
        : nowIso
    const rawTags = row.tags
    const tags = Array.isArray(rawTags)
      ? rawTags.filter((tag): tag is string => typeof tag === 'string').slice(0, 16)
      : undefined
    hits.push({
      record: {
        id,
        text,
        scope,
        createdAt,
        ...(tags === undefined || tags.length === 0 ? {} : { tags }),
      },
      score,
    })
    if (hits.length >= maxRows) break
  }
  return hits
}

/** Parse a delete response; only an explicit falsy delete marker means "not forgotten". */
export function parseForgetResponse(response: unknown): boolean {
  if (!isRecord(response)) return true
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
