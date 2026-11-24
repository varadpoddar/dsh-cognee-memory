/**
 * Turn journal — every text part of a conversation becomes a durable task.
 *
 * This is deliberately *not* the extraction path. Extraction distils facts
 * ("remember that…", or an LLM pass) and writes them into Cognee during the
 * turn. The journal instead appends the conversation itself — your messages and
 * the agent's answers — to the ingest queue as one task per message part, and
 * the nightly drain ingests it later. Consequences, by design:
 *
 *   - a task exists on disk before it exists in Cognee (fsync on every append),
 *   - a task is removed only after a complete ingest (`pruneDone`),
 *   - pending/in-flight/failed tasks survive restarts and power cuts,
 *   - there is no daily cap and no pending cap: the backlog is the queue.
 *
 * Identity: a journal task's content hash is seeded with
 * `session:turn:seq:role:part`, so two identical messages ("continue") remain
 * two tasks while a replayed journal line still dedupes through the tombstones.
 * Long messages are split at `chunkChars`; nothing is truncated or dropped.
 */
import type { CogneeMemoryConfig } from '../config/schema.js'
import type { Metrics } from '../telemetry/metrics.js'
import {
  contentHashOf,
  resolveQueuePath,
  type EnqueueEntry,
  type IngestQueue,
} from '../queue/store.js'
import { redactSecrets } from '../security/redaction.js'
import { makeScopeRef } from './scopes.js'
import type { MemoryScope } from '../types.js'

export interface JournalMessage {
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly seq?: number
}

export interface JournalTurnInput {
  readonly sessionId: string
  readonly turn: number
  readonly messages: readonly JournalMessage[]
  readonly recordedAt?: string
}

export interface JournalReport {
  readonly added: number
  readonly duplicates: number
  readonly skipped: number
}

/** Split text into chunks of at most `max` chars, preferring line/space breaks. */
export function chunkText(text: string, max: number): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  if (trimmed.length <= max) return [trimmed]
  const chunks: string[] = []
  let rest = trimmed
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const breakAt = Math.max(
      window.lastIndexOf('\n'),
      window.lastIndexOf('. '),
      window.lastIndexOf(' '),
    )
    const cut = breakAt > max * 0.5 ? breakAt + 1 : max
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest !== '') chunks.push(rest)
  return chunks
}

export interface TurnJournalOptions {
  readonly config: CogneeMemoryConfig
  readonly queue: IngestQueue
  readonly env?: NodeJS.ProcessEnv
  readonly metrics?: Metrics
}

export class TurnJournal {
  private readonly config: CogneeMemoryConfig
  private readonly queue: IngestQueue
  private readonly metrics: Metrics | undefined

  constructor(options: TurnJournalOptions) {
    this.config = options.config
    this.queue = options.queue
    this.metrics = options.metrics
  }

  get enabled(): boolean {
    return this.config.ingestion.journal.enabled
  }

  /** Scope the journal writes to; `undefined` when the deployment cannot name one. */
  scope(): { scopeRef: ReturnType<typeof makeScopeRef>; scope: string } | undefined {
    const configured = this.config.ingestion.journal.scope ?? this.config.scopes.defaultWriteScope
    const projectId = this.config.scopeDefaults.projectId?.trim()
    const teamId = this.config.scopeDefaults.teamId?.trim()
    let raw: string | undefined
    if (configured === 'project') raw = projectId
    else if (configured === 'team') raw = teamId
    else if (configured === 'user') raw = this.config.identity.principalId ?? projectId
    else if (configured === 'agent') raw = this.config.identity.agentId ?? projectId
    if (raw === undefined || raw === '') return undefined
    const scopeRef = makeScopeRef(configured as MemoryScope, raw)
    return { scopeRef, scope: `dsh-${scopeRef.scope}-${scopeRef.id}` }
  }

  recordTurn(input: JournalTurnInput): JournalReport {
    if (!this.enabled) return { added: 0, duplicates: 0, skipped: 0 }
    const target = this.scope()
    if (target === undefined) {
      this.metrics?.increment('journal.skipped.noScope')
      return { added: 0, duplicates: 0, skipped: input.messages.length }
    }
    const journal = this.config.ingestion.journal
    const entries: EnqueueEntry[] = []
    let skipped = 0
    for (const message of input.messages) {
      if (message.role === 'assistant' && !journal.includeAssistant) {
        skipped += 1
        continue
      }
      let text = message.text
      if (journal.redactAtEnqueue) {
        const redacted = redactSecrets(text)
        text = redacted.text
        if (redacted.redacted) this.metrics?.increment('journal.redacted')
      }
      const parts = chunkText(text, journal.chunkChars)
      if (parts.length === 0) {
        skipped += 1
        continue
      }
      parts.forEach((part, index) => {
        const seq = message.seq === undefined ? 'x' : String(message.seq)
        entries.push({
          text: part,
          scope: target.scope,
          scopeRef: target.scopeRef,
          // Coordinates make the hash stable across replays but unique per part.
          dedupeKey: `${input.sessionId}:${input.turn}:${seq}:${message.role}:${index}`,
          source: {
            sessionId: input.sessionId,
            turnIndex: input.turn,
            role: message.role,
            ...(parts.length > 1 ? { partIndex: index, partOf: parts.length } : {}),
            ...(input.recordedAt === undefined ? {} : { timestamp: input.recordedAt }),
          },
        })
      })
    }
    if (entries.length === 0) return { added: 0, duplicates: 0, skipped }
    const report = this.queue.enqueue(entries)
    this.metrics?.increment('journal.enqueued', report.added)
    if (report.duplicates > 0) this.metrics?.increment('journal.duplicates', report.duplicates)
    return { added: report.added, duplicates: report.duplicates, skipped }
  }
}

/** Queue path for the journal: config override, env override, then DSH_HOME. */
export function journalQueuePath(config: CogneeMemoryConfig, env: NodeJS.ProcessEnv): string {
  return config.ingestion.queue.path ?? resolveQueuePath(env)
}

/** Stable hash helper re-exported for tests that assert journal identity. */
export function journalHash(scope: string, text: string, dedupeKey: string): string {
  return contentHashOf(scope, text, dedupeKey)
}
