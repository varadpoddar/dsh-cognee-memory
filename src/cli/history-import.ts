/**
 * `memory import-history` — backfill durable memories from existing local DSH
 * conversation transcripts (M13).
 *
 * Extraction is the same policy as the live M3 hook: only committed direct user
 * messages are read, only the deterministic explicit-command extractor runs
 * ("remember …", "forget …", "actually …"), whole transcripts and hidden
 * reasoning are never candidates, and secrets are blocked before a write.
 *
 * Idempotency: each candidate carries the extraction idempotency key derived
 * from principal + scope + semantic key + operation + normalized fact, and a
 * source ref of (session id, message index). A state file records what already
 * landed, so a re-run is a no-op and an interrupted run resumes.
 *
 * Ordering: candidates are applied in transcript timestamp order so a later
 * correction supersedes the earlier fact instead of racing it.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { MemoryCoordinator } from '../memory/coordinator.js'
import {
  extractDeterministicCandidates,
  type MemoryCandidate,
} from '../memory/extraction.js'
import { findSecrets } from '../security/redaction.js'
import { scopeKey } from '../memory/scopes.js'
import type { CallerIdentity, ScopeRef } from '../types.js'
import {
  discoverTranscripts,
  readTranscript,
  type DecodedTranscript,
  type TranscriptSkips,
} from './transcript.js'

/** Environment variable naming the resumable import state file. */
export const IMPORT_STATE_ENV = 'COGNEE_MEMORY_IMPORT_STATE_FILE'
/** Import-state format version. */
export const IMPORT_STATE_VERSION = 1 as const

/** Resumable state for `import-history`. */
export interface HistoryImportState {
  readonly version: typeof IMPORT_STATE_VERSION
  readonly updatedAt: string
  /** Transcript cursor per session, for reporting and a cheap resume short-circuit. */
  readonly sessions: Readonly<Record<string, { readonly lastSeq: number; readonly messages: number }>>
  /** Idempotency key -> the durable record it produced. */
  readonly records: Readonly<Record<string, { readonly recordId: string; readonly writtenAt: string }>>
}

export function emptyImportState(now = new Date()): HistoryImportState {
  return { version: IMPORT_STATE_VERSION, updatedAt: now.toISOString(), sessions: {}, records: {} }
}

/** Absolute path of the import state file for this process. */
export function resolveImportStatePath(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env[IMPORT_STATE_ENV]?.trim()
  if (explicit !== undefined && explicit !== '') return explicit
  const home = env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  return join(home, 'plugins', 'cognee-memory', 'import-history.state.json')
}

export function loadImportState(filePath: string, now = new Date()): HistoryImportState {
  if (!existsSync(filePath)) return emptyImportState(now)
  try {
    const parsed: unknown = JSON.parse(readFileSync(filePath, 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return emptyImportState(now)
    const row = parsed as Record<string, unknown>
    if (row.version !== IMPORT_STATE_VERSION) return emptyImportState(now)
    return {
      version: IMPORT_STATE_VERSION,
      updatedAt: typeof row.updatedAt === 'string' ? row.updatedAt : now.toISOString(),
      sessions:
        row.sessions !== null && typeof row.sessions === 'object'
          ? (row.sessions as HistoryImportState['sessions'])
          : {},
      records:
        row.records !== null && typeof row.records === 'object'
          ? (row.records as HistoryImportState['records'])
          : {},
    }
  } catch {
    return emptyImportState(now)
  }
}

export function saveImportState(filePath: string, state: HistoryImportState): void {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporary = `${filePath}.tmp-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(state, undefined, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  renameSync(temporary, filePath)
}

/** One candidate plus the transcript coordinates it came from. */
export interface HistoryCandidate {
  readonly candidate: MemoryCandidate
  readonly sessionId: string
  readonly messageIndex: number
  readonly timestamp: string
}

/** Everything a dry run reports and an apply needs. */
export interface HistoryPlan {
  readonly sessionsDir: string
  readonly sessions: number
  readonly messages: number
  readonly candidates: readonly HistoryCandidate[]
  readonly pending: readonly HistoryCandidate[]
  readonly alreadyImported: number
  readonly skipped: TranscriptSkips & { readonly noCommand: number; readonly secrets: number }
  readonly byOperation: Readonly<Record<string, number>>
  readonly namespaces: readonly string[]
  readonly scope: ScopeRef
  readonly dateRange?: { readonly from: string; readonly to: string }
  readonly state: HistoryImportState
  readonly transcripts: readonly DecodedTranscript[]
}

export interface HistoryPlanOptions {
  readonly sessionsDir: string
  readonly scope: ScopeRef
  readonly principalId: string
  readonly state?: HistoryImportState
  readonly now?: Date
  /** Bound the plan for a first verification run (sessions, not messages). */
  readonly limitSessions?: number
  /** Restrict to one session id (first-run verification). */
  readonly onlySessionId?: string
}

/** Caller identity whose matching scope field is the target scope's raw id. */
function identityFor(scope: ScopeRef, sessionId: string, principalId: string): CallerIdentity {
  return {
    sessionId,
    principalId,
    ...(scope.scope === 'agent' ? { agentId: scope.id } : {}),
    ...(scope.scope === 'project' ? { projectId: scope.id } : {}),
    ...(scope.scope === 'team' ? { teamId: scope.id } : {}),
  }
}

/** Extract explicit-command candidates from every readable transcript. */
export function planHistoryImport(options: HistoryPlanOptions): HistoryPlan {
  const now = options.now ?? new Date()
  const state = options.state ?? emptyImportState(now)
  const files = discoverTranscripts(options.sessionsDir)
  const limited = options.limitSessions === undefined ? files : files.slice(0, options.limitSessions)
  const skipped = { synthetic: 0, tooLong: 0, notHuman: 0, malformed: 0, noCommand: 0, secrets: 0 }
  const candidates: HistoryCandidate[] = []
  const transcripts: DecodedTranscript[] = []
  let messages = 0

  for (const file of limited) {
    const transcript = readTranscript(file)
    if (options.onlySessionId !== undefined && transcript.sessionId !== options.onlySessionId) continue
    transcripts.push(transcript)
    for (const key of ['synthetic', 'tooLong', 'notHuman', 'malformed'] as const) {
      skipped[key] += transcript.skips[key]
    }
    messages += transcript.messages.length
    const previous: MemoryCandidate[] = []
    for (const message of transcript.messages) {
      if (findSecrets(message.text).length > 0) {
        skipped.secrets += 1
        continue
      }
      const identity = identityFor(options.scope, transcript.sessionId, options.principalId)
      const extracted = extractDeterministicCandidates({
        text: message.text,
        identity,
        scope: options.scope,
        principalId: options.principalId,
        turn: message.messageIndex,
        seq: message.messageIndex,
        now: new Date(message.timestamp),
        previous: previous.slice(-8),
      })
      if (extracted.length === 0) {
        skipped.noCommand += 1
        continue
      }
      for (const candidate of extracted) {
        candidates.push({
          candidate,
          sessionId: transcript.sessionId,
          messageIndex: message.messageIndex,
          timestamp: message.timestamp,
        })
        previous.push(candidate)
      }
    }
  }

  // Deterministic, timestamp-ascending order: supersession follows real time.
  candidates.sort((a, b) =>
    a.timestamp === b.timestamp
      ? a.sessionId === b.sessionId
        ? a.messageIndex - b.messageIndex
        : a.sessionId.localeCompare(b.sessionId)
      : a.timestamp.localeCompare(b.timestamp),
  )

  const byOperation: Record<string, number> = {}
  const pending: HistoryCandidate[] = []
  let alreadyImported = 0
  for (const entry of candidates) {
    byOperation[entry.candidate.operation] = (byOperation[entry.candidate.operation] ?? 0) + 1
    if (state.records[entry.candidate.idempotencyKey] !== undefined) {
      alreadyImported += 1
      continue
    }
    pending.push(entry)
  }
  const dates = candidates.map((entry) => entry.timestamp).sort()
  const from = dates[0]
  const to = dates[dates.length - 1]
  return {
    sessionsDir: options.sessionsDir,
    sessions: transcripts.length,
    messages,
    candidates,
    pending,
    alreadyImported,
    skipped,
    byOperation,
    namespaces: [scopeKey(options.scope)],
    scope: options.scope,
    ...(from === undefined || to === undefined ? {} : { dateRange: { from, to } }),
    state,
    transcripts,
  }
}

/** One successfully ingested or deduplicated record, for operator evidence. */
export interface AppliedHistoryRecord {
  readonly recordId: string
  readonly semanticKey: string
  readonly text: string
  readonly sessionId: string
  readonly messageIndex: number
  readonly createdAt: string
  readonly deduplicated: boolean
}

export interface HistoryApplyResult {
  readonly ingested: number
  readonly deduplicated: number
  readonly failed: number
  readonly failures: readonly { readonly semanticKey: string; readonly code: string }[]
  readonly records: readonly AppliedHistoryRecord[]
  readonly stateFile: string
  readonly state: HistoryImportState
}

export interface HistoryApplyOptions {
  readonly plan: HistoryPlan
  readonly coordinator: Pick<MemoryCoordinator, 'remember' | 'resolveIdentity'>
  readonly stateFile: string
  readonly signal?: AbortSignal
  readonly now?: Date
  /** Persist state after every write (default) or only at the end. */
  readonly saveEvery?: number
}

/** Apply a plan in timestamp order, recording each write in the state file. */
export async function applyHistoryImport(options: HistoryApplyOptions): Promise<HistoryApplyResult> {
  const now = options.now ?? new Date()
  const records = new Map(Object.entries(options.plan.state.records))
  const sessions = new Map(Object.entries(options.plan.state.sessions))
  const idToRecordId = new Map<string, string>()
  for (const [key, value] of records) idToRecordId.set(`mem-${key.slice(0, 32)}`, value.recordId)

  const applied: AppliedHistoryRecord[] = []
  const failures: { semanticKey: string; code: string }[] = []
  let ingested = 0
  let deduplicated = 0
  let failed = 0
  let sinceSave = 0
  const saveEvery = options.saveEvery ?? 1

  const persist = (): HistoryImportState => {
    const next: HistoryImportState = {
      version: IMPORT_STATE_VERSION,
      updatedAt: now.toISOString(),
      sessions: Object.fromEntries(sessions),
      records: Object.fromEntries(records),
    }
    saveImportState(options.stateFile, next)
    return next
  }

  for (const entry of options.plan.pending) {
    const candidate = entry.candidate
    const identity = await options.coordinator.resolveIdentity(
      identityFor(options.plan.scope, entry.sessionId, candidate.principalId),
    )
    const supersedes = candidate.supersedes === undefined ? undefined : idToRecordId.get(candidate.supersedes)
    try {
      const result = await options.coordinator.remember({
        text: candidate.content,
        identity,
        provenance: {
          kind: 'session_event',
          source: 'import-history',
          recordedAt: candidate.createdAt,
          sessionId: entry.sessionId,
          turn: entry.messageIndex,
          evidence: `session:${entry.sessionId}#${entry.messageIndex}`,
        },
        dedupeKey: candidate.idempotencyKey,
        semanticKey: candidate.semanticKey,
        ...(supersedes === undefined ? {} : { supersedes }),
        sourceRefs: [
          { sessionId: entry.sessionId, messageIndex: entry.messageIndex, producedAt: candidate.createdAt },
        ],
        tags: ['import-history'],
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
      records.set(candidate.idempotencyKey, { recordId: result.id, writtenAt: now.toISOString() })
      idToRecordId.set(candidate.id, result.id)
      const cursor = sessions.get(entry.sessionId)
      sessions.set(entry.sessionId, {
        lastSeq: Math.max(cursor?.lastSeq ?? -1, entry.messageIndex),
        messages: (cursor?.messages ?? 0) + 1,
      })
      if (result.deduplicated) deduplicated += 1
      else ingested += 1
      applied.push({
        recordId: result.id,
        semanticKey: candidate.semanticKey,
        text: candidate.content,
        sessionId: entry.sessionId,
        messageIndex: entry.messageIndex,
        createdAt: candidate.createdAt,
        deduplicated: result.deduplicated,
      })
    } catch (error) {
      failed += 1
      const code =
        error !== null && typeof error === 'object' && 'code' in error && typeof error.code === 'string'
          ? error.code
          : 'UNKNOWN'
      failures.push({ semanticKey: candidate.semanticKey, code })
      // Configuration/authorization faults abort; transient backend faults are
      // retried by a later run because the candidate was never recorded.
      if (code === 'FORBIDDEN' || code === 'VALIDATION') break
    }
    sinceSave += 1
    if (sinceSave >= saveEvery) {
      persist()
      sinceSave = 0
    }
  }

  const state = persist()
  return {
    ingested,
    deduplicated,
    failed,
    failures,
    records: applied,
    stateFile: options.stateFile,
    state,
  }
}
