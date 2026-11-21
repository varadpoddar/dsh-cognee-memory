import { createHash } from 'node:crypto'
import type { MemoryRecord, ScopeRef } from '../types.js'
import { sameScope } from './scopes.js'

/** Canonical text form for exact-duplicate detection. */
export function normalizeMemoryText(text: string): string {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Stable key for one exact memory within one scope. */
export function dedupeKey(scope: ScopeRef, text: string): string {
  const normalized = normalizeMemoryText(text)
  return createHash('sha256')
    .update(`${scope.scope}\u0000${scope.id}\u0000${normalized}`)
    .digest('hex')
}

export function tokenSet(text: string): Set<string> {
  const normalized = normalizeMemoryText(text)
  if (normalized === '') return new Set()
  return new Set(normalized.split(' ').filter((token) => token.length > 1))
}

/** Jaccard similarity in [0, 1]; empty/empty is 1, one empty is 0. */
export function jaccardSimilarity(a: string, b: string): number {
  const left = tokenSet(a)
  const right = tokenSet(b)
  if (left.size === 0 && right.size === 0) return 1
  if (left.size === 0 || right.size === 0) return 0
  let intersection = 0
  for (const token of left) if (right.has(token)) intersection += 1
  return intersection / (left.size + right.size - intersection)
}

export interface DedupCandidate {
  readonly id: string
  readonly text: string
  readonly scope: ScopeRef
  readonly createdAt?: string
}

/** Find the closest candidate at or above `threshold`; exact matches win. */
export function findNearDuplicate(
  text: string,
  candidates: readonly DedupCandidate[],
  threshold: number,
): DedupCandidate | undefined {
  const normalized = normalizeMemoryText(text)
  let best: DedupCandidate | undefined
  let bestScore = 0
  for (const candidate of candidates) {
    if (normalizeMemoryText(candidate.text) === normalized) return candidate
    const score = jaccardSimilarity(text, candidate.text)
    if (score >= threshold && score > bestScore) {
      best = candidate
      bestScore = score
    }
  }
  return best
}

/** Small process-local index to avoid a backend round trip on obvious repeats. */
export class DedupIndex {
  private readonly exact = new Map<string, string>()
  private readonly records = new Map<string, DedupCandidate[]>()

  add(record: Pick<MemoryRecord, 'id' | 'text' | 'scope' | 'createdAt'>): void {
    const key = dedupeKey(record.scope, record.text)
    this.exact.set(key, record.id)
    const candidate: DedupCandidate = {
      id: record.id,
      text: record.text,
      scope: record.scope,
      createdAt: record.createdAt,
    }
    const bucket = this.records.get(key)
    if (bucket === undefined) this.records.set(key, [candidate])
    else bucket.push(candidate)
  }

  findExact(scope: ScopeRef, text: string): string | undefined {
    return this.exact.get(dedupeKey(scope, text))
  }

  findNear(scope: ScopeRef, text: string, threshold: number): DedupCandidate | undefined {
    const buckets = this.records.get(dedupeKey(scope, text))
    if (buckets !== undefined) return buckets.find((item) => sameScope(item.scope, scope))
    const candidates: DedupCandidate[] = []
    for (const entries of this.records.values()) {
      for (const entry of entries) if (sameScope(entry.scope, scope)) candidates.push(entry)
    }
    return findNearDuplicate(text, candidates, threshold)
  }

  size(): number {
    return this.exact.size
  }

  clear(): void {
    this.exact.clear()
    this.records.clear()
  }
}
