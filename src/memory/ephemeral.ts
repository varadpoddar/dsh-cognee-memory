import { createHash, randomUUID } from 'node:crypto'
import type {
  ForgetInput,
  ForgetResult,
  MemoryRecord,
  RecallHit,
  RecallQuery,
  RememberInput,
  RememberResult,
  ScopeRef,
} from '../types.js'

const MAX_RECORDS_PER_SESSION = 200
const MAX_SESSIONS = 64
const MAX_TEXT_CHARS = 4_000

interface StoredRecord {
  readonly record: MemoryRecord
  readonly tokens: ReadonlySet<string>
}

function tokenize(text: string): ReadonlySet<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .split(' ')
    .filter((token) => token.length >= 3)
  return new Set(tokens)
}

function score(query: ReadonlySet<string>, record: ReadonlySet<string>): number {
  if (query.size === 0 || record.size === 0) return 0
  let overlap = 0
  for (const token of query) if (record.has(token)) overlap += 1
  return Math.min(1, overlap / Math.max(1, Math.min(query.size, record.size)))
}

/**
 * In-process session memory. It is intentionally not backed by Cognee or any
 * other durable store: a DSH session id is ephemeral, so a restart must lose
 * everything written here. Durable scopes never enter this class.
 */
export class EphemeralSessionMemory {
  private readonly sessions = new Map<string, Map<string, StoredRecord[]>>()
  private readonly now: () => Date

  constructor(now: () => Date = () => new Date()) {
    this.now = now
  }

  private bucket(sessionId: string, scope: ScopeRef, create: boolean): StoredRecord[] | undefined {
    if (scope.scope !== 'session') return undefined
    let byScope = this.sessions.get(sessionId)
    if (byScope === undefined) {
      if (!create) return undefined
      byScope = new Map()
      this.sessions.set(sessionId, byScope)
      while (this.sessions.size > MAX_SESSIONS) {
        const oldest = this.sessions.keys().next().value
        if (oldest === undefined) break
        this.sessions.delete(oldest)
      }
    }
    let records = byScope.get(scope.id)
    if (records === undefined) {
      if (!create) return undefined
      records = []
      byScope.set(scope.id, records)
    }
    return records
  }

  remember(input: RememberInput): RememberResult {
    const sessionId = input.provenance.sessionId
    if (sessionId === undefined || sessionId === '') {
      throw new Error('ephemeral session memory requires a session id')
    }
    const bucket = this.bucket(sessionId, input.scope, true)
    if (bucket === undefined) throw new Error('ephemeral session memory only accepts session scope')
    const text = input.text.trim().slice(0, MAX_TEXT_CHARS)
    const existing = bucket.find((item) => item.record.text === text)
    if (existing !== undefined) {
      return {
        id: existing.record.id,
        scope: input.scope,
        createdAt: existing.record.createdAt,
        deduplicated: true,
      }
    }
    const createdAt = this.now().toISOString()
    const record: MemoryRecord = Object.freeze({
      id: `eph-${randomUUID()}`,
      text,
      scope: input.scope,
      createdAt,
      ...(input.tags === undefined ? {} : { tags: input.tags }),
      provenance: input.provenance,
    })
    bucket.push({ record, tokens: tokenize(text) })
    while (bucket.length > MAX_RECORDS_PER_SESSION) bucket.shift()
    return { id: record.id, scope: input.scope, createdAt, deduplicated: false }
  }

  recall(query: RecallQuery): readonly RecallHit[] {
    const queryTokens = tokenize(query.text)
    const hits: RecallHit[] = []
    for (const scope of query.scopes) {
      if (scope.scope !== 'session') continue
      for (const sessionId of this.sessions.keys()) {
        const bucket = this.bucket(sessionId, scope, false)
        if (bucket === undefined) continue
        for (const item of bucket) {
          const relevance = score(queryTokens, item.tokens)
          if (relevance <= 0) continue
          hits.push({ record: item.record, score: relevance })
        }
      }
    }
    return hits
      .sort((a, b) => b.score - a.score || Date.parse(b.record.createdAt) - Date.parse(a.record.createdAt))
      .slice(0, Math.max(1, query.limit))
  }

  forget(sessionId: string, input: ForgetInput): ForgetResult {
    const bucket = this.bucket(sessionId, input.scope, false)
    if (bucket === undefined) return { ...input, forgotten: false }
    const index = bucket.findIndex((item) => item.record.id === input.id)
    if (index < 0) return { ...input, forgotten: false }
    bucket.splice(index, 1)
    return { ...input, forgotten: true }
  }

  /** Forget by content match inside one session; used by the deterministic "forget…" command. */
  forgetByText(sessionId: string, scope: ScopeRef, text: string): string[] {
    const bucket = this.bucket(sessionId, scope, false)
    if (bucket === undefined) return []
    const needle = text.toLowerCase()
    const removed: string[] = []
    for (let index = bucket.length - 1; index >= 0; index -= 1) {
      const item = bucket[index]
      if (item !== undefined && item.record.text.toLowerCase().includes(needle)) {
        removed.push(item.record.id)
        bucket.splice(index, 1)
      }
    }
    return removed
  }

  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId)
  }

  get size(): number {
    let total = 0
    for (const byScope of this.sessions.values()) {
      for (const bucket of byScope.values()) total += bucket.length
    }
    return total
  }
}
