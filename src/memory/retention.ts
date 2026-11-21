import type { MemoryRecord } from '../types.js'
import { scopeKey } from './scopes.js'

export interface RetentionPolicy {
  readonly maxAgeDays: number
  readonly maxRecordsPerScope: number
}

export interface RetentionPlan {
  readonly keep: readonly MemoryRecord[]
  readonly evict: readonly MemoryRecord[]
}

export function isExpired(record: Pick<MemoryRecord, 'createdAt'>, now: Date, maxAgeDays: number): boolean {
  if (!Number.isFinite(maxAgeDays) || maxAgeDays < 0) return false
  const timestamp = Date.parse(record.createdAt)
  if (Number.isNaN(timestamp)) return true
  const ageMs = now.getTime() - timestamp
  return ageMs > maxAgeDays * 24 * 60 * 60 * 1000
}

/**
 * Deterministic retention: drop expired or undated records, then evict the
 * oldest records above the per-scope cap. Never mutates the input.
 */
export function planRetention(
  records: readonly MemoryRecord[],
  policy: RetentionPolicy,
  now: Date = new Date(),
): RetentionPlan {
  const keep: MemoryRecord[] = []
  const evict: MemoryRecord[] = []
  const byScope = new Map<string, MemoryRecord[]>()

  for (const record of records) {
    if (isExpired(record, now, policy.maxAgeDays)) {
      evict.push(record)
      continue
    }
    const key = scopeKey(record.scope)
    const bucket = byScope.get(key)
    if (bucket === undefined) byScope.set(key, [record])
    else bucket.push(record)
  }

  for (const bucket of byScope.values()) {
    const sorted = [...bucket].sort((a, b) => {
      const delta = Date.parse(a.createdAt) - Date.parse(b.createdAt)
      return delta !== 0 ? delta : a.id.localeCompare(b.id)
    })
    const overflow = sorted.length - Math.max(1, Math.trunc(policy.maxRecordsPerScope))
    if (overflow <= 0) {
      keep.push(...bucket)
      continue
    }
    const evictedIds = new Set(sorted.slice(0, overflow).map((record) => record.id))
    for (const record of bucket) {
      if (evictedIds.has(record.id)) evict.push(record)
      else keep.push(record)
    }
  }

  // Preserve the caller's order for both partitions.
  const keepIds = new Set(keep.map((record) => record.id))
  return {
    keep: records.filter((record) => keepIds.has(record.id)),
    evict: records.filter((record) => !keepIds.has(record.id)),
  }
}
