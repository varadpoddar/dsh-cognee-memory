/**
 * Durable, bounded record ledger for portable export/import (M14) and
 * conversation-history backfill (M13).
 *
 * WHY: Cognee stores memory text inside the graph/vector index and exposes it
 * only through `/search`; `GET /datasets/{id}/data` answers ids and content
 * hashes, not the raw text. A portable bundle therefore needs a local source of
 * truth that mirrors every write the plugin accepted: text, semantic key,
 * provenance, confidence, timestamps, and source refs.
 *
 * WHAT IS STORED: only text the write policy already accepted (secrets are
 * blocked before this module is called and re-redacted here as a second line of
 * defence), one bounded text per record (<= 2 000 chars), and metadata. The file
 * is 0600 in a 0700 directory and never contains a credential.
 *
 * The ledger is append-only: a supersession or an import conflict appends an
 * update for the same record id, and readers fold the latest entry per id.
 */
import { createHash } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { redactSecrets } from '../security/redaction.js'
import { sameScope } from './scopes.js'
import type { Provenance, ScopeRef } from '../types.js'

/** Environment variable naming the ledger file. */
export const LEDGER_FILE_ENV = 'COGNEE_MEMORY_LEDGER_FILE'

/** File format version. */
export const LEDGER_VERSION = 1 as const

/** Upper bound on one stored record text. */
export const LEDGER_MAX_TEXT_CHARS = 2_000

/** Upper bound on retained records; oldest entries are evicted by readers. */
export const LEDGER_MAX_RECORDS = 20_000

export type LedgerState = 'active' | 'superseded' | 'conflict' | 'deleted'

/** One bounded pointer back to the conversation message that produced a fact. */
export interface LedgerSourceRef {
  readonly sessionId: string
  /** Zero-based message index inside the session transcript. */
  readonly messageIndex: number
  readonly producedAt: string
}

/** One durable, portable memory record. */
export interface LedgerEntry {
  readonly version: typeof LEDGER_VERSION
  readonly recordId: string
  readonly scope: ScopeRef
  readonly text: string
  readonly semanticKey: string
  /** Coarse 0..1 confidence derived from the provenance kind. */
  readonly confidence: number
  readonly provenance: Provenance
  readonly sourceRefs: readonly LedgerSourceRef[]
  readonly createdAt: string
  readonly state: LedgerState
  readonly supersedes?: string
  readonly supersededBy?: string
  /** Existing record this import conflicted with; no overwrite happened. */
  readonly conflictOf?: string
  readonly redacted?: boolean
  readonly updatedAt: string
}

export interface MemoryLedgerOptions {
  readonly filePath?: string
  readonly env?: NodeJS.ProcessEnv
  readonly now?: () => Date
}

/** Absolute path of the ledger file for this process. */
export function resolveLedgerPath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[LEDGER_FILE_ENV]?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'plugins', 'cognee-memory', 'ledger.jsonl')
}

/** Coarse confidence for a provenance kind; never derived from model text. */
export function confidenceForProvenance(kind: Provenance['kind']): number {
  switch (kind) {
    case 'user_explicit':
      return 0.95
    case 'tool_call':
      return 0.9
    case 'task_outcome':
      return 0.85
    case 'session_event':
      return 0.7
    case 'import':
      return 0.6
    default:
      return 0.5
  }
}

/** Stable id for a record keyed by scope + semantic key + normalized text. */
export function ledgerRecordId(scope: ScopeRef, semanticKey: string, text: string): string {
  const hash = createHash('sha256')
    .update(`${scope.scope}\u0000${scope.id}\u0000${semanticKey}\u0000${text.normalize('NFKC').trim()}`)
    .digest('hex')
  return `mem-${hash.slice(0, 32)}`
}

function normalizeText(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function bounded(text: string): { readonly text: string; readonly redacted: boolean } {
  const clipped = text.length > LEDGER_MAX_TEXT_CHARS ? text.slice(0, LEDGER_MAX_TEXT_CHARS) : text
  const { text: safe, findings } = redactSecrets(clipped)
  return { text: safe, redacted: findings.length > 0 }
}

function parseEntry(line: string): LedgerEntry | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== 'object') return undefined
  const row = parsed as Record<string, unknown>
  const scopeRaw = row.scope as { scope?: unknown; id?: unknown } | undefined
  if (
    row.version !== LEDGER_VERSION ||
    typeof row.recordId !== 'string' ||
    typeof row.text !== 'string' ||
    typeof row.semanticKey !== 'string' ||
    typeof row.createdAt !== 'string' ||
    typeof row.updatedAt !== 'string' ||
    typeof row.state !== 'string' ||
    scopeRaw === undefined ||
    typeof scopeRaw.scope !== 'string' ||
    typeof scopeRaw.id !== 'string'
  ) {
    return undefined
  }
  const provenanceRaw = (row.provenance ?? {}) as Record<string, unknown>
  const provenance: Provenance = {
    kind: (typeof provenanceRaw.kind === 'string' ? provenanceRaw.kind : 'import') as Provenance['kind'],
    source: typeof provenanceRaw.source === 'string' ? provenanceRaw.source : 'ledger',
    recordedAt: typeof provenanceRaw.recordedAt === 'string' ? provenanceRaw.recordedAt : row.createdAt,
    ...(typeof provenanceRaw.sessionId === 'string' ? { sessionId: provenanceRaw.sessionId } : {}),
    ...(typeof provenanceRaw.evidence === 'string' ? { evidence: provenanceRaw.evidence } : {}),
    ...(typeof provenanceRaw.turn === 'number' ? { turn: provenanceRaw.turn } : {}),
  }
  const sourceRefs = Array.isArray(row.sourceRefs)
    ? (row.sourceRefs as unknown[])
        .filter((ref): ref is Record<string, unknown> => ref !== null && typeof ref === 'object')
        .filter(
          (ref) =>
            typeof ref.sessionId === 'string' &&
            typeof ref.messageIndex === 'number' &&
            typeof ref.producedAt === 'string',
        )
        .map((ref) => ({
          sessionId: ref.sessionId as string,
          messageIndex: ref.messageIndex as number,
          producedAt: ref.producedAt as string,
        }))
    : []
  return {
    version: LEDGER_VERSION,
    recordId: row.recordId,
    scope: { scope: scopeRaw.scope as ScopeRef['scope'], id: scopeRaw.id },
    text: row.text,
    semanticKey: row.semanticKey,
    confidence: typeof row.confidence === 'number' ? row.confidence : 0.5,
    provenance,
    sourceRefs,
    createdAt: row.createdAt,
    state: row.state as LedgerState,
    ...(typeof row.supersedes === 'string' ? { supersedes: row.supersedes } : {}),
    ...(typeof row.supersededBy === 'string' ? { supersededBy: row.supersededBy } : {}),
    ...(typeof row.conflictOf === 'string' ? { conflictOf: row.conflictOf } : {}),
    ...(row.redacted === true ? { redacted: true } : {}),
    updatedAt: row.updatedAt,
  }
}

/**
 * Append-only ledger of durable memory records. All methods are synchronous and
 * bounded: a corrupt line is skipped rather than failing a caller.
 */
export class MemoryLedger {
  readonly filePath: string
  private readonly now: () => Date

  constructor(options: MemoryLedgerOptions = {}) {
    this.filePath = options.filePath ?? resolveLedgerPath(options.env ?? process.env)
    this.now = options.now ?? (() => new Date())
  }

  /** Append one write, supersession, or conflict annotation. */
  append(entry: Omit<LedgerEntry, 'version' | 'updatedAt'> & { readonly updatedAt?: string }): void {
    const boundedText = bounded(entry.text)
    const record: LedgerEntry = {
      version: LEDGER_VERSION,
      ...entry,
      text: boundedText.text,
      ...(entry.redacted === true || boundedText.redacted ? { redacted: true } : {}),
      updatedAt: entry.updatedAt ?? this.now().toISOString(),
    }
    mkdirSync(dirname(this.filePath), { recursive: true, mode: 0o700 })
    appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 })
  }

  /** Record a fresh durable write. */
  recordWrite(input: {
    readonly recordId: string
    readonly scope: ScopeRef
    readonly text: string
    readonly semanticKey?: string
    readonly provenance: Provenance
    readonly sourceRefs?: readonly LedgerSourceRef[]
    readonly createdAt: string
    readonly supersedes?: string
    readonly confidence?: number
    readonly redacted?: boolean
  }): void {
    const semanticKey = input.semanticKey?.trim() !== undefined && input.semanticKey.trim() !== ''
      ? input.semanticKey.trim()
      : ledgerSemanticKey(input.text)
    this.append({
      recordId: input.recordId,
      scope: input.scope,
      text: input.text,
      semanticKey,
      confidence: input.confidence ?? confidenceForProvenance(input.provenance.kind),
      provenance: input.provenance,
      sourceRefs: input.sourceRefs ?? [],
      createdAt: input.createdAt,
      state: 'active',
      ...(input.supersedes === undefined ? {} : { supersedes: input.supersedes }),
      ...(input.redacted === true ? { redacted: true } : {}),
    })
  }

  /** Mark an earlier record as replaced; the old text is retained for audit. */
  markSuperseded(recordId: string, supersededBy: string): void {
    const previous = this.all().find((entry) => entry.recordId === recordId && entry.state === 'active')
    if (previous === undefined) return
    this.append({ ...previous, state: 'superseded', supersededBy })
  }

  /** Every parsed entry in file order. Malformed lines are skipped. */
  all(): LedgerEntry[] {
    if (!existsSync(this.filePath)) return []
    const body = readFileSync(this.filePath, 'utf8')
    const entries: LedgerEntry[] = []
    for (const line of body.split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      const entry = parseEntry(trimmed)
      if (entry !== undefined) entries.push(entry)
    }
    return entries
  }

  /** Latest view of every record, oldest write first, capped at {@link LEDGER_MAX_RECORDS}. */
  folded(): LedgerEntry[] {
    const byId = new Map<string, LedgerEntry>()
    for (const entry of this.all()) byId.set(entry.recordId, entry)
    const folded = [...byId.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    return folded.length > LEDGER_MAX_RECORDS ? folded.slice(folded.length - LEDGER_MAX_RECORDS) : folded
  }

  /** Live records in a scope, optionally including conflict annotations. */
  recordsIn(scope: ScopeRef, options: { readonly includeConflicts?: boolean } = {}): LedgerEntry[] {
    return this.folded().filter(
      (entry) =>
        sameScope(entry.scope, scope) &&
        (entry.state === 'active' || (options.includeConflicts === true && entry.state === 'conflict')),
    )
  }

  /** Active record with this semantic key in a scope, if any. */
  findBySemanticKey(scope: ScopeRef, semanticKey: string): LedgerEntry | undefined {
    return this.recordsIn(scope).find((entry) => entry.semanticKey === semanticKey)
  }
}

/** Semantic key fallback that avoids importing the extraction module at runtime. */
function ledgerSemanticKey(text: string): string {
  const slug = normalizeText(text)
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
  return slug === '' ? `x-${createHash('sha256').update(text).digest('hex').slice(0, 6)}` : slug
}
