/**
 * `memory export` / `memory import` — portable, secret-free bundles (M14).
 *
 * A bundle is newline-delimited JSON: one `bundle` header followed by one
 * `record` line per active durable memory. Records carry text, the canonical
 * semantic key, coarse confidence, timestamps, provenance, and bounded source
 * refs (session id + message index). No credential, token, or redacted secret
 * ever enters a bundle.
 *
 * Import is authorization-first: the caller supplies one target scope and the
 * set of scopes it is allowed to write; records are never written into the
 * scope a bundle claims. Dedupe is on the semantic key inside the target scope.
 * A different fact under an existing key is recorded as a conflict annotation
 * (append-only ledger) instead of overwriting the memory.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MemoryCoordinator } from '../memory/coordinator.js'
import {
  confidenceForProvenance,
  ledgerRecordId,
  type LedgerEntry,
  type LedgerSourceRef,
  type MemoryLedger,
} from '../memory/ledger.js'
import { sameScope } from '../memory/scopes.js'
import { findSecrets } from '../security/redaction.js'
import { MemoryError } from '../errors.js'
import type { CallerIdentity, Provenance, ScopeRef } from '../types.js'

/** Bundle format version. */
export const BUNDLE_VERSION = 1 as const

export interface BundleHeader {
  readonly version: typeof BUNDLE_VERSION
  readonly type: 'bundle'
  readonly exportedAt: string
  readonly sourceScope: ScopeRef
  readonly count: number
  readonly generator: 'dsh-cognee-memory'
}

export interface BundleRecord {
  readonly version: typeof BUNDLE_VERSION
  readonly type: 'record'
  readonly recordId: string
  readonly scope: ScopeRef
  readonly text: string
  readonly semanticKey: string
  readonly confidence: number
  readonly createdAt: string
  readonly provenance: Provenance
  readonly sourceRefs: readonly LedgerSourceRef[]
  readonly supersedes?: string
  readonly redacted?: boolean
}

export interface ExportResult {
  readonly path: string
  readonly count: number
  readonly skippedSecrets: number
  readonly scope: ScopeRef
}

function normalized(text: string): string {
  return text.normalize('NFKC').replace(/\s+/g, ' ').trim()
}

function recordLine(entry: LedgerEntry): BundleRecord {
  return {
    version: BUNDLE_VERSION,
    type: 'record',
    recordId: entry.recordId,
    scope: { scope: entry.scope.scope, id: entry.scope.id },
    text: entry.text,
    semanticKey: entry.semanticKey,
    confidence: entry.confidence,
    createdAt: entry.createdAt,
    provenance: entry.provenance,
    sourceRefs: entry.sourceRefs,
    ...(entry.supersedes === undefined ? {} : { supersedes: entry.supersedes }),
    ...(entry.redacted === true ? { redacted: true } : {}),
  }
}

/** Export every active record in one scope to a JSONL bundle. */
export function exportScope(options: {
  readonly ledger: Pick<MemoryLedger, 'recordsIn'>
  readonly scope: ScopeRef
  readonly outPath: string
  readonly now?: Date
}): ExportResult {
  const now = options.now ?? new Date()
  const entries = options.ledger.recordsIn(options.scope)
  const records: BundleRecord[] = []
  let skippedSecrets = 0
  for (const entry of entries) {
    if (findSecrets(entry.text).length > 0) {
      skippedSecrets += 1
      continue
    }
    records.push(recordLine(entry))
  }
  records.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const header: BundleHeader = {
    version: BUNDLE_VERSION,
    type: 'bundle',
    exportedAt: now.toISOString(),
    sourceScope: { scope: options.scope.scope, id: options.scope.id },
    count: records.length,
    generator: 'dsh-cognee-memory',
  }
  mkdirSync(dirname(options.outPath), { recursive: true, mode: 0o700 })
  const body = [header, ...records].map((line) => JSON.stringify(line)).join('\n')
  writeFileSync(options.outPath, `${body}\n`, { encoding: 'utf8', mode: 0o600 })
  return { path: options.outPath, count: records.length, skippedSecrets, scope: options.scope }
}

export interface ParsedBundle {
  readonly header: BundleHeader
  readonly records: readonly BundleRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function parseScope(value: unknown): ScopeRef | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.scope !== 'string' || typeof value.id !== 'string') return undefined
  return { scope: value.scope as ScopeRef['scope'], id: value.id }
}

/** Read and validate a bundle file. Throws VALIDATION on a malformed bundle. */
export function readBundle(path: string): ParsedBundle {
  if (!existsSync(path)) throw new MemoryError('VALIDATION', `bundle not found: ${path}`)
  const lines = readFileSync(path, 'utf8').split('\n').filter((line) => line.trim() !== '')
  if (lines.length === 0) throw new MemoryError('VALIDATION', 'bundle is empty')
  let header: BundleHeader | undefined
  const records: BundleRecord[] = []
  for (const [index, line] of lines.entries()) {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch {
      throw new MemoryError('VALIDATION', `bundle line ${index + 1} is not JSON`)
    }
    if (!isRecord(parsed)) throw new MemoryError('VALIDATION', `bundle line ${index + 1} is not an object`)
    if (parsed.type === 'bundle') {
      const scope = parseScope(parsed.sourceScope)
      if (
        index !== 0 ||
        parsed.version !== BUNDLE_VERSION ||
        scope === undefined ||
        typeof parsed.exportedAt !== 'string' ||
        typeof parsed.count !== 'number'
      ) {
        throw new MemoryError('VALIDATION', 'bundle header is malformed')
      }
      header = {
        version: BUNDLE_VERSION,
        type: 'bundle',
        exportedAt: parsed.exportedAt,
        sourceScope: scope,
        count: parsed.count,
        generator: 'dsh-cognee-memory',
      }
      continue
    }
    if (parsed.type !== 'record') {
      throw new MemoryError('VALIDATION', `bundle line ${index + 1} has unknown type`)
    }
    if (header === undefined) throw new MemoryError('VALIDATION', 'bundle header missing')
    const scope = parseScope(parsed.scope)
    const provenance = isRecord(parsed.provenance) ? parsed.provenance : undefined
    if (
      parsed.version !== BUNDLE_VERSION ||
      typeof parsed.recordId !== 'string' ||
      typeof parsed.text !== 'string' ||
      typeof parsed.semanticKey !== 'string' ||
      typeof parsed.createdAt !== 'string' ||
      scope === undefined ||
      provenance === undefined ||
      typeof provenance.kind !== 'string' ||
      typeof provenance.source !== 'string' ||
      typeof provenance.recordedAt !== 'string'
    ) {
      throw new MemoryError('VALIDATION', `bundle record on line ${index + 1} is malformed`)
    }
    const sourceRefs = Array.isArray(parsed.sourceRefs)
      ? (parsed.sourceRefs as unknown[])
          .filter((ref): ref is Record<string, unknown> => isRecord(ref))
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
    records.push({
      version: BUNDLE_VERSION,
      type: 'record',
      recordId: parsed.recordId,
      scope,
      text: parsed.text,
      semanticKey: parsed.semanticKey,
      confidence: typeof parsed.confidence === 'number' ? parsed.confidence : 0.5,
      createdAt: parsed.createdAt,
      provenance: provenance as unknown as Provenance,
      sourceRefs,
      ...(typeof parsed.supersedes === 'string' ? { supersedes: parsed.supersedes } : {}),
      ...(parsed.redacted === true ? { redacted: true } : {}),
    })
  }
  if (header === undefined) throw new MemoryError('VALIDATION', 'bundle header missing')
  return { header, records }
}

/** One import outcome per bundle record. */
export interface ImportRecordOutcome {
  readonly recordId: string
  readonly semanticKey: string
  readonly outcome: 'imported' | 'deduplicated' | 'conflict' | 'refused'
  readonly record?: string
}

export interface ImportResult {
  readonly dryRun: boolean
  readonly targetScope: ScopeRef
  readonly records: number
  readonly imported: number
  readonly deduplicated: number
  readonly conflicts: number
  readonly refused: number
  readonly outcomes: readonly ImportRecordOutcome[]
}

export interface ImportOptions {
  readonly bundlePath: string
  readonly ledger: Pick<MemoryLedger, 'recordsIn' | 'append'>
  readonly coordinator: Pick<MemoryCoordinator, 'remember'>
  readonly identity: CallerIdentity
  /** Scope that receives the records; never taken from the bundle. */
  readonly scope: ScopeRef
  /** Scopes the caller may write; a missing target refuses the whole bundle. */
  readonly allowedScopes: readonly ScopeRef[]
  readonly apply: boolean
  readonly now?: Date
  readonly signal?: AbortSignal
}

function assertWritable(scope: ScopeRef, allowed: readonly ScopeRef[]): void {
  if (!allowed.some((candidate) => sameScope(candidate, scope))) {
    throw new MemoryError(
      'FORBIDDEN',
      `target scope ${scope.scope}:${scope.id} is not writable by this importer`,
    )
  }
}

/** Import a bundle with dedupe, conflict annotation, and scope authorization. */
export async function importBundle(options: ImportOptions): Promise<ImportResult> {
  assertWritable(options.scope, options.allowedScopes)
  const now = options.now ?? new Date()
  const bundle = readBundle(options.bundlePath)
  const outcomes: ImportRecordOutcome[] = []
  let imported = 0
  let deduplicated = 0
  let conflicts = 0
  let refused = 0

  for (const record of bundle.records) {
    const text = normalized(record.text)
    if (text === '' || findSecrets(record.text).length > 0 || record.text.length > 2_000) {
      refused += 1
      outcomes.push({ recordId: record.recordId, semanticKey: record.semanticKey, outcome: 'refused' })
      continue
    }
    const existing = options.ledger
      .recordsIn(options.scope)
      .find((entry) => entry.semanticKey === record.semanticKey)
    if (existing !== undefined) {
      if (normalized(existing.text) === text) {
        deduplicated += 1
        outcomes.push({ recordId: record.recordId, semanticKey: record.semanticKey, outcome: 'deduplicated' })
        continue
      }
      conflicts += 1
      if (options.apply) {
        const conflictId = ledgerRecordId(options.scope, record.semanticKey, text)
        options.ledger.append({
          recordId: conflictId,
          scope: options.scope,
          text: record.text,
          semanticKey: record.semanticKey,
          confidence: record.confidence,
          provenance: { ...record.provenance, kind: 'import', source: 'memory-import' },
          sourceRefs: record.sourceRefs,
          createdAt: now.toISOString(),
          state: 'conflict',
          conflictOf: existing.recordId,
        })
      }
      outcomes.push({ recordId: record.recordId, semanticKey: record.semanticKey, outcome: 'conflict' })
      continue
    }
    if (!options.apply) {
      imported += 1
      outcomes.push({ recordId: record.recordId, semanticKey: record.semanticKey, outcome: 'imported' })
      continue
    }
    const dedupeKey = createHash('sha256')
      .update(`${options.scope.scope}\u0000${options.scope.id}\u0000${record.semanticKey}\u0000${text}`)
      .digest('hex')
    const result = await options.coordinator.remember({
      text: record.text,
      identity: options.identity,
      provenance: {
        kind: 'import',
        source: 'memory-import',
        recordedAt: now.toISOString(),
        evidence: `bundle:${record.recordId}`,
      },
      dedupeKey,
      semanticKey: record.semanticKey,
      sourceRefs: record.sourceRefs,
      tags: ['import'],
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    if (result.deduplicated) {
      deduplicated += 1
      outcomes.push({
        recordId: record.recordId,
        semanticKey: record.semanticKey,
        outcome: 'deduplicated',
        record: result.id,
      })
    } else {
      imported += 1
      outcomes.push({
        recordId: record.recordId,
        semanticKey: record.semanticKey,
        outcome: 'imported',
        record: result.id,
      })
    }
  }

  return {
    dryRun: !options.apply,
    targetScope: options.scope,
    records: bundle.records.length,
    imported,
    deduplicated,
    conflicts,
    refused,
    outcomes,
  }
}

/** Exported for the CLI: confidence for a provenance kind. */
export { confidenceForProvenance }
