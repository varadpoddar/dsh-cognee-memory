/**
 * Produce queue entries from DSH session transcripts.
 *
 * One queue item per committed human turn: the transcript's own message index
 * is the turn index, so a resumed backfill can be reasoned about against the
 * source file. The extraction policy is deliberately the same as the live hook
 * and `import-history` (see `cli/transcript.ts`): direct user input only, text
 * blocks only, synthetic runtime context excluded. Assistant turns are not
 * produced by this reader; that is a policy decision owned upstream, not a
 * silent filter here — callers see `role: 'user'` on every entry.
 */
import { existsSync } from 'node:fs'
import type { EnqueueEntry } from './store.js'
import { discoverTranscripts, readTranscript } from '../cli/transcript.js'

export interface ProducerOptions {
  readonly sessionsDir: string
  readonly scope: string
  /** Cap the number of *sessions* read, newest first. */
  readonly limitSessions?: number
  /** Cap the number of items produced. */
  readonly limitItems?: number
}

export interface ProducerReport {
  readonly entries: readonly EnqueueEntry[]
  readonly sessions: number
  readonly sessionsDir: string
  readonly skipped: { readonly synthetic: number; readonly tooLong: number; readonly notHuman: number }
  readonly missing: boolean
}

/**
 * Read transcripts and return them as queue entries, newest session first so a
 * `--limit-sessions 20` pilot covers recent history rather than 2024 leftovers.
 */
export function collectTranscriptEntries(options: ProducerOptions): ProducerReport {
  const { sessionsDir, scope } = options
  const files = discoverTranscripts(sessionsDir)
  const skipped = { synthetic: 0, tooLong: 0, notHuman: 0 }
  if (!existsSync(sessionsDir)) {
    return { entries: [], sessions: 0, sessionsDir, skipped, missing: true }
  }

  // Session directory names embed the creation time; the file path sorts the
  // same way, so reverse order is newest-first without reading every file.
  const ordered = [...files].reverse()
  const cap = options.limitSessions ?? Number.POSITIVE_INFINITY
  const entries: EnqueueEntry[] = []
  const seenSessions = new Set<string>()
  const itemCap = options.limitItems ?? Number.POSITIVE_INFINITY

  for (const file of ordered) {
    if (seenSessions.size >= cap) break
    let decoded
    try {
      decoded = readTranscript(file)
    } catch {
      continue
    }
    seenSessions.add(decoded.sessionId)
    skipped.synthetic += decoded.skips.synthetic
    skipped.tooLong += decoded.skips.tooLong
    skipped.notHuman += decoded.skips.notHuman
    for (const message of decoded.messages) {
      if (entries.length >= itemCap) break
      entries.push({
        text: message.text,
        scope,
        source: {
          sessionId: message.sessionId,
          turnIndex: message.messageIndex,
          role: 'user',
          timestamp: message.timestamp,
        },
      })
    }
  }
  entries.sort((a, b) => (a.source?.timestamp ?? '').localeCompare(b.source?.timestamp ?? ''))
  return { entries, sessions: seenSessions.size, sessionsDir, skipped, missing: false }
}
