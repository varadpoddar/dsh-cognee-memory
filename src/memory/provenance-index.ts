/**
 * Durable, bounded provenance index for recalled memory.
 *
 * WHY: a memory id alone cannot answer "where did this come from?" once the
 * prompt block has been rendered. The prompt line is `label · scope · date`,
 * and the authenticated detail view
 * (`/plugins/cognee-memory/memory/<id>`, see `settings/provenance-http.ts`)
 * needs the dataset, the document/data id, the ingest state, the search type
 * that surfaced it, its coarse confidence, the semantic key, supersession refs,
 * and bounded source refs.
 *
 * WHAT IS STORED: metadata only — ids, names, states, timestamps, and one
 * bounded excerpt (<= 280 chars, sanitized and secret-redacted). No API key,
 * no Authorization header, no full body beyond that excerpt.
 *
 * AUTHORIZATION IS NOT DECIDED HERE: `get()`/`list()` require the caller's
 * `{ principalId, readableScopes }` and return nothing otherwise, so the HTTP
 * layer can answer 404 without ever learning whether an id exists.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { confidenceFor, sanitizeMemoryText, type Confidence } from './context-format.js'
import { deserializePointer, type TranscriptPointer } from './pointer.js'
import { sameScope, scopeKey } from './scopes.js'
import { redactSecrets } from '../security/redaction.js'
import type { CallerIdentity, MemoryScope, RecallHit, ScopeRef } from '../types.js'
import { isMemoryScope } from './scopes.js'

/** Environment variable naming the provenance file. */
export const PROVENANCE_FILE_ENV = 'COGNEE_MEMORY_PROVENANCE_FILE'

/** File format version. */
export const PROVENANCE_INDEX_VERSION = 1 as const

/** Upper bound on retained entries; oldest `updatedAt` is evicted first. */
export const PROVENANCE_MAX_ENTRIES = 1_000

/** Upper bound on the stored excerpt. */
export const PROVENANCE_EXCERPT_CHARS = 280

/** Ingest/verification states the index may report. */
export type ProvenanceIngestState =
  | 'candidate'
  | 'approved'
  | 'queued'
  | 'ingesting'
  | 'indexed'
  | 'recall-verified'
  | 'failed'
  | 'superseded'
  | 'deleted'

/** One bounded pointer back to the evidence that produced the memory. */
export interface ProvenanceSourceRef {
  readonly kind: 'task' | 'session' | 'tool' | 'user' | 'import'
  readonly ref: string
}

/** What surfaced a memory, and with what coarse confidence. */
export interface ProvenanceSurfaced {
  readonly searchType?: string
  readonly confidence: Confidence
  readonly at: string
}

/** One index entry, keyed by memory id. */
export interface ProvenanceEntry {
  readonly id: string
  readonly principalId: string
  readonly scope: ScopeRef
  readonly dataset: { readonly name: string; readonly id?: string }
  readonly documentId?: string
  readonly createdAt?: string
  readonly ingest: {
    readonly state: ProvenanceIngestState
    readonly attempts?: number
    readonly reason?: string
  }
  readonly surfaced?: ProvenanceSurfaced
  readonly semanticKey?: string
  readonly supersedes?: string
  readonly supersededBy?: string
  readonly sources: readonly ProvenanceSourceRef[]
  readonly excerpt: string
  /**
   * Optional pointer to the exact transcript range this memory came from. The
   * detail page resolves it against the lossless transcript store; an entry
   * without one simply has no Source section.
   */
  readonly pointer?: TranscriptPointer
  readonly updatedAt: string
}

/** The caller's authorization facts; nothing is served without them. */
export interface ProvenanceAccess {
  readonly principalId?: string
  readonly readableScopes: readonly ScopeRef[]
}

/** Absolute path of the provenance file for this process. */
export function resolveProvenancePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[PROVENANCE_FILE_ENV]?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'plugins', 'cognee-memory', 'provenance.json')
}

/** Ids that may appear in a URL path segment; anything else is not addressable. */
const ID_PATTERN = /^[A-Za-z0-9._:-]{1,200}$/

/** Whether an id is safe to look up (no path traversal, no control characters). */
export function isAddressableMemoryId(value: unknown): value is string {
  return typeof value === 'string' && ID_PATTERN.test(value) && value !== '.' && value !== '..'
}

function metadataString(record: RecallHit['record'], key: string): string | undefined {
  const value = record.metadata?.[key]
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function boundedExcerpt(text: string): string {
  const sanitized = sanitizeMemoryText(text).replace(/\s*\n+\s*/g, ' ').trim()
  const redacted = redactSecrets(sanitized).text
  if (redacted.length <= PROVENANCE_EXCERPT_CHARS) return redacted
  return `${redacted.slice(0, PROVENANCE_EXCERPT_CHARS - 1).trimEnd()}…`
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Date.parse(value))
}

function sourceRefsFromProvenance(
  provenance: { readonly kind: string; readonly taskId?: string; readonly sessionId?: string; readonly source?: string } | undefined,
): ProvenanceSourceRef[] {
  if (provenance === undefined) return []
  const refs: ProvenanceSourceRef[] = []
  const taskId = provenance.taskId?.trim()
  const sessionId = provenance.sessionId?.trim()
  if (taskId !== undefined && taskId !== '') refs.push({ kind: 'task', ref: taskId })
  if (sessionId !== undefined && sessionId !== '') refs.push({ kind: 'session', ref: sessionId })
  // The generic `source` string (`tool:remember`, `hook:session/event`, …) adds
  // a pointer the specific task/session refs above already carry; keep it only
  // where it is the sole evidence of origin.
  if (taskId === undefined && provenance.source !== undefined && provenance.source.trim() !== '') {
    const kind =
      provenance.kind === 'tool_call'
        ? 'tool'
        : provenance.kind === 'user_explicit'
          ? 'user'
          : provenance.kind === 'import'
            ? 'import'
            : 'session'
    refs.push({ kind, ref: provenance.source.trim() })
  }
  return refs
}

function principalOf(identity: CallerIdentity | undefined): string {
  const value = identity?.principalId
  return typeof value === 'string' ? value.trim() : ''
}

/** Durable provenance index; every mutation is an atomic, best-effort write. */
export class ProvenanceIndex {
  readonly filePath: string
  private readonly now: () => Date
  private readonly maxEntries: number
  private readonly logger: ((message: string) => void) | undefined
  private readonly entries = new Map<string, ProvenanceEntry>()
  private loaded = false

  constructor(options: {
    readonly filePath?: string
    readonly env?: NodeJS.ProcessEnv
    readonly now?: () => Date
    readonly maxEntries?: number
    readonly logger?: (message: string) => void
  } = {}) {
    this.filePath = options.filePath ?? resolveProvenancePath(options.env ?? process.env)
    this.now = options.now ?? (() => new Date())
    this.maxEntries = Math.max(1, options.maxEntries ?? PROVENANCE_MAX_ENTRIES)
    this.logger = options.logger
  }

  /** Number of retained entries. */
  size(): number {
    this.ensureLoaded()
    return this.entries.size
  }

  /** Every entry the caller may see, newest first. Never throws. */
  list(access: ProvenanceAccess, limit = 100): ProvenanceEntry[] {
    this.ensureLoaded()
    const visible: ProvenanceEntry[] = []
    for (const entry of this.entries.values()) {
      if (this.canRead(entry, access)) visible.push(entry)
    }
    visible.sort((a, b) => (a.updatedAt === b.updatedAt ? a.id.localeCompare(b.id) : a.updatedAt < b.updatedAt ? 1 : -1))
    return visible.slice(0, Math.max(0, Math.min(limit, this.maxEntries)))
  }

  /** One entry when — and only when — the caller may read its principal and scope. */
  get(id: string, access: ProvenanceAccess): ProvenanceEntry | undefined {
    this.ensureLoaded()
    if (!isAddressableMemoryId(id)) return undefined
    const entry = this.entries.get(id)
    if (entry === undefined) return undefined
    return this.canRead(entry, access) ? entry : undefined
  }

  /**
   * Record the memories a recall actually surfaced. `datasetIds` maps a
   * dataset name (`scopeKey`) to the backend UUID when an inventory knows it.
   */
  recordRecall(
    hits: readonly RecallHit[],
    context: {
      readonly identity?: CallerIdentity
      readonly searchType?: string
      readonly datasetIds?: Readonly<Record<string, string>>
      readonly documentIds?: Readonly<Record<string, string>>
    } = {},
  ): void {
    this.ensureLoaded()
    const at = this.now().toISOString()
    const principalId = principalOf(context.identity)
    let changed = false
    for (const hit of hits) {
      const id = hit.record.id
      if (!isAddressableMemoryId(id)) continue
      if (hit.record.scope.scope === 'session') continue
      const existing = this.entries.get(id)
      const metaDatasetName = metadataString(hit.record, 'datasetName')
      const metaDatasetId = metadataString(hit.record, 'datasetId')
      const datasetName = metaDatasetName ?? scopeKey(hit.record.scope)
      const datasetId =
        metaDatasetId ?? context.datasetIds?.[datasetName] ?? context.datasetIds?.[scopeKey(hit.record.scope)]
      const documentId = context.documentIds?.[id]
      const next: ProvenanceEntry = {
        id,
        principalId: existing?.principalId ?? principalId,
        scope: freezeScope(hit.record.scope),
        dataset: {
          name: datasetName,
          ...(datasetId ?? existing?.dataset.id
            ? { id: datasetId ?? existing?.dataset.id }
            : {}),
        },
        ...(documentId ?? existing?.documentId ? { documentId: documentId ?? existing?.documentId } : {}),
        ...(isTimestamp(hit.record.createdAt)
          ? { createdAt: hit.record.createdAt }
          : existing?.createdAt === undefined
            ? {}
            : { createdAt: existing.createdAt }),
        ingest: {
          state:
            existing?.ingest.state === 'failed' || existing?.ingest.state === 'superseded'
              ? existing.ingest.state
              : 'indexed',
          ...(existing?.ingest.attempts === undefined ? {} : { attempts: existing.ingest.attempts }),
          ...(existing?.ingest.reason === undefined ? {} : { reason: existing.ingest.reason }),
        },
        surfaced: {
          ...(context.searchType === undefined || context.searchType.trim() === ''
            ? {}
            : { searchType: context.searchType.trim() }),
          confidence: confidenceFor(hit.score),
          at,
        },
        ...(existing?.semanticKey === undefined ? {} : { semanticKey: existing.semanticKey }),
        ...(existing?.supersedes === undefined ? {} : { supersedes: existing.supersedes }),
        ...(existing?.supersededBy === undefined ? {} : { supersededBy: existing.supersededBy }),
        sources: existing?.sources ?? [],
        excerpt: boundedExcerpt(hit.record.text),
        ...(existing?.pointer === undefined ? {} : { pointer: existing.pointer }),
        updatedAt: at,
      }
      this.entries.set(id, Object.freeze(next))
      changed = true
    }
    if (changed) {
      this.evict()
      this.persist()
    }
  }

  /** Record a memory this plugin wrote after the backend accepted it. */
  recordWrite(input: {
    readonly id: string
    readonly scope: ScopeRef
    readonly identity?: CallerIdentity
    readonly createdAt?: string
    readonly text?: string
    readonly semanticKey?: string
    readonly supersedes?: string
    readonly documentId?: string
    readonly datasetId?: string
    readonly provenance?: {
      readonly kind: string
      readonly source?: string
      readonly taskId?: string
      readonly sessionId?: string
    }
    /** Exact transcript range this memory came from, when known. */
    readonly pointer?: TranscriptPointer
    readonly state?: ProvenanceIngestState
  }): void {
    this.ensureLoaded()
    if (!isAddressableMemoryId(input.id) || input.scope.scope === 'session') return
    const at = this.now().toISOString()
    const existing = this.entries.get(input.id)
    const datasetName = scopeKey(input.scope)
    const entry: ProvenanceEntry = {
      id: input.id,
      principalId: existing?.principalId ?? principalOf(input.identity),
      scope: freezeScope(input.scope),
      dataset: {
        name: datasetName,
        ...(input.datasetId ?? existing?.dataset.id ? { id: input.datasetId ?? existing?.dataset.id } : {}),
      },
      ...(input.documentId ?? existing?.documentId ? { documentId: input.documentId ?? existing?.documentId } : {}),
      ...(isTimestamp(input.createdAt)
        ? { createdAt: input.createdAt }
        : existing?.createdAt === undefined
          ? {}
          : { createdAt: existing.createdAt }),
      ingest: { state: input.state ?? existing?.ingest.state ?? 'indexed' },
      ...(existing?.surfaced === undefined ? {} : { surfaced: existing.surfaced }),
      ...(input.semanticKey ?? existing?.semanticKey ? { semanticKey: input.semanticKey ?? existing?.semanticKey } : {}),
      ...(input.supersedes ?? existing?.supersedes ? { supersedes: input.supersedes ?? existing?.supersedes } : {}),
      ...(existing?.supersededBy === undefined ? {} : { supersededBy: existing.supersededBy }),
      sources: dedupeSources([
        ...(existing?.sources ?? []),
        ...sourceRefsFromProvenance(input.provenance),
      ]),
      excerpt: input.text !== undefined && input.text.trim() !== '' ? boundedExcerpt(input.text) : existing?.excerpt ?? '',
      ...((input.pointer ?? existing?.pointer) === undefined
        ? {}
        : { pointer: input.pointer ?? existing?.pointer }),
      updatedAt: at,
    }
    this.entries.set(input.id, Object.freeze(entry))
    this.evict()
    this.persist()
  }

  /**
   * Attach the backend dataset UUID once an inventory resolves the dataset
   * name (Cognee assigns UUIDs, the local scope map only knows names).
   */
  setDatasetId(memoryId: string, datasetId: string): void {
    this.ensureLoaded()
    if (!isAddressableMemoryId(memoryId) || datasetId.trim() === '') return
    const existing = this.entries.get(memoryId)
    if (existing === undefined || existing.dataset.id === datasetId) return
    this.entries.set(
      memoryId,
      Object.freeze({
        ...existing,
        dataset: { name: existing.dataset.name, id: datasetId.trim() },
        updatedAt: this.now().toISOString(),
      }),
    )
    this.persist()
  }

  /**
   * Attach or replace the transcript pointer for one memory. Used by the
   * summarization slice; a no-op for an unknown id.
   */
  setPointer(memoryId: string, pointer: TranscriptPointer): void {
    this.ensureLoaded()
    if (!isAddressableMemoryId(memoryId)) return
    const existing = this.entries.get(memoryId)
    if (existing === undefined || existing.pointer === pointer) return
    this.entries.set(
      memoryId,
      Object.freeze({ ...existing, pointer: Object.freeze({ ...pointer }), updatedAt: this.now().toISOString() }),
    )
    this.persist()
  }

  /** Link an older memory to the record that replaced it. */
  markSuperseded(oldId: string, newId: string): void {
    this.ensureLoaded()
    if (!isAddressableMemoryId(oldId) || !isAddressableMemoryId(newId)) return
    const existing = this.entries.get(oldId)
    if (existing === undefined) return
    const at = this.now().toISOString()
    this.entries.set(
      oldId,
      Object.freeze({ ...existing, supersededBy: newId, ingest: { state: 'superseded' as const }, updatedAt: at }),
    )
    const replacement = this.entries.get(newId)
    if (replacement !== undefined) {
      this.entries.set(newId, Object.freeze({ ...replacement, supersedes: oldId, updatedAt: at }))
    }
    this.persist()
  }

  private canRead(entry: ProvenanceEntry, access: ProvenanceAccess): boolean {
    const principal = access.principalId?.trim() ?? ''
    if (entry.principalId !== principal) return false
    return access.readableScopes.some((scope) => sameScope(scope, entry.scope))
  }

  private evict(): void {
    if (this.entries.size <= this.maxEntries) return
    const ordered = [...this.entries.values()].sort((a, b) => (a.updatedAt < b.updatedAt ? -1 : 1))
    while (ordered.length > this.maxEntries) {
      const oldest = ordered.shift()
      if (oldest === undefined) break
      this.entries.delete(oldest.id)
    }
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.filePath)) return
    try {
      const stat = statSync(this.filePath)
      if (!stat.isFile() || stat.size > 4 * 1024 * 1024) return
      const parsed: unknown = JSON.parse(readFileSync(this.filePath, 'utf8'))
      if (parsed === null || typeof parsed !== 'object') return
      const rows = (parsed as { entries?: unknown }).entries
      if (!Array.isArray(rows)) return
      for (const row of rows) {
        const entry = normalizeEntry(row)
        if (entry !== undefined) this.entries.set(entry.id, entry)
      }
    } catch (error) {
      this.logger?.(
        `provenance index unreadable; starting empty (${error instanceof Error ? error.name : 'unknown error'})`,
      )
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
      const body = JSON.stringify(
        { version: PROVENANCE_INDEX_VERSION, entries: [...this.entries.values()] },
        null,
        2,
      )
      const temporary = `${this.filePath}.tmp-${process.pid}`
      writeFileSync(temporary, body, { encoding: 'utf8', mode: 0o600 })
      renameSync(temporary, this.filePath)
    } catch (error) {
      this.logger?.(
        `provenance index write failed (${error instanceof Error ? error.name : 'unknown error'})`,
      )
    }
  }
}

function freezeScope(scope: ScopeRef): ScopeRef {
  return Object.freeze({ scope: scope.scope, id: scope.id })
}

function dedupeSources(sources: readonly ProvenanceSourceRef[]): ProvenanceSourceRef[] {
  const seen = new Set<string>()
  const result: ProvenanceSourceRef[] = []
  for (const source of sources) {
    const key = `${source.kind}\u0000${source.ref}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(Object.freeze({ kind: source.kind, ref: source.ref }))
  }
  return Object.freeze(result) as ProvenanceSourceRef[]
}

function normalizeEntry(value: unknown): ProvenanceEntry | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (!isAddressableMemoryId(row.id)) return undefined
  const scope = row.scope as { scope?: unknown; id?: unknown } | undefined
  if (scope === undefined || !isMemoryScope(scope.scope) || typeof scope.id !== 'string') return undefined
  if (typeof row.excerpt !== 'string' || typeof row.updatedAt !== 'string') return undefined
  const dataset = row.dataset as { name?: unknown; id?: unknown } | undefined
  const ingest = row.ingest as { state?: unknown; attempts?: unknown; reason?: unknown } | undefined
  const surfaced = row.surfaced as { searchType?: unknown; confidence?: unknown; at?: unknown } | undefined
  const pointer = deserializePointer(row.pointer)
  return Object.freeze({
    id: row.id,
    principalId: typeof row.principalId === 'string' ? row.principalId : '',
    scope: freezeScope({ scope: scope.scope as MemoryScope, id: scope.id }),
    dataset: {
      name: typeof dataset?.name === 'string' ? dataset.name : scopeKey({ scope: scope.scope as MemoryScope, id: scope.id }),
      ...(typeof dataset?.id === 'string' ? { id: dataset.id } : {}),
    },
    ...(typeof row.documentId === 'string' ? { documentId: row.documentId } : {}),
    ...(isTimestamp(row.createdAt) ? { createdAt: row.createdAt } : {}),
    ingest: {
      state: normalizeState(ingest?.state),
      ...(typeof ingest?.attempts === 'number' ? { attempts: ingest.attempts } : {}),
      ...(typeof ingest?.reason === 'string' ? { reason: ingest.reason } : {}),
    },
    ...(surfaced !== undefined && typeof surfaced.at === 'string' && typeof surfaced.confidence === 'string'
      ? {
          surfaced: {
            ...(typeof surfaced.searchType === 'string' ? { searchType: surfaced.searchType } : {}),
            confidence: surfaced.confidence as Confidence,
            at: surfaced.at,
          },
        }
      : {}),
    ...(typeof row.semanticKey === 'string' ? { semanticKey: row.semanticKey } : {}),
    ...(typeof row.supersedes === 'string' ? { supersedes: row.supersedes } : {}),
    ...(typeof row.supersededBy === 'string' ? { supersededBy: row.supersededBy } : {}),
    sources: Array.isArray(row.sources)
      ? dedupeSources(
          row.sources.filter(
            (source): source is ProvenanceSourceRef =>
              source !== null &&
              typeof source === 'object' &&
              typeof (source as { ref?: unknown }).ref === 'string' &&
              typeof (source as { kind?: unknown }).kind === 'string',
          ),
        )
      : [],
    excerpt: row.excerpt,
    ...(pointer === undefined ? {} : { pointer }),
    updatedAt: row.updatedAt,
  })
}

const INGEST_STATES = new Set<string>([
  'candidate',
  'approved',
  'queued',
  'ingesting',
  'indexed',
  'recall-verified',
  'failed',
  'superseded',
  'deleted',
])

function normalizeState(value: unknown): ProvenanceIngestState {
  return typeof value === 'string' && INGEST_STATES.has(value)
    ? (value as ProvenanceIngestState)
    : 'indexed'
}
