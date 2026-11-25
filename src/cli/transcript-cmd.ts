/**
 * `memory transcript show` — read the lossless transcript store by hand.
 *
 *   memory transcript show --session <id> [--turns a..b] [--json]
 *
 * Read-only and offline: it opens the store under the plugin state dir, prints
 * the exact stored text with its char offsets and hash, and never contacts
 * Cognee. This is the manual counterpart of the authenticated
 * `/plugins/cognee-memory/transcript/<session>/<turn>` route.
 */
import { resolveTranscriptsDir, TranscriptStore, type TranscriptRow } from '../memory/transcript-store.js'
import { MemoryError } from '../errors.js'
import type { CliIo } from './main.js'

export interface TranscriptCliArgs {
  readonly values: Readonly<Record<string, string>>
  readonly flags: ReadonlySet<string>
}

/** `a..b` (inclusive), a single turn, or all turns when omitted. */
function parseTurns(raw: string | undefined): { readonly from: number; readonly to: number } | undefined {
  if (raw === undefined || raw.trim() === '') return undefined
  const text = raw.trim()
  if (!text.includes('..')) {
    const single = Number.parseInt(text, 10)
    if (!/^[0-9]{1,9}$/.test(text) || !Number.isFinite(single)) {
      throw new MemoryError('VALIDATION', `not a turn or range: ${raw}`)
    }
    return { from: single, to: single }
  }
  const [fromRaw, toRaw, ...rest] = text.split('..')
  if (rest.length > 0 || !/^[0-9]{1,9}$/.test(fromRaw ?? '') || !/^[0-9]{1,9}$/.test(toRaw ?? '')) {
    throw new MemoryError('VALIDATION', `not a turn range: ${raw}`)
  }
  const from = Number.parseInt(fromRaw ?? '', 10)
  const to = Number.parseInt(toRaw ?? '', 10)
  if (to < from) throw new MemoryError('VALIDATION', `turn range is reversed: ${raw}`)
  return { from, to }
}

function preview(text: string, limit = 80): string {
  const oneLine = text.replace(/\s+/g, ' ').trim()
  return oneLine.length <= limit ? oneLine : `${oneLine.slice(0, limit - 1)}…`
}

export async function runTranscript(args: TranscriptCliArgs, env: NodeJS.ProcessEnv, io: CliIo): Promise<number> {
  const sub = args.values['transcript-sub'] ?? 'show'
  if (sub !== 'show') throw new MemoryError('VALIDATION', `unknown transcript subcommand: ${sub}`)
  const sessionId = args.values.session?.trim() ?? ''
  if (sessionId === '') throw new MemoryError('VALIDATION', '--session is required')
  const turns = parseTurns(args.values.turns)
  const store = new TranscriptStore({ dir: resolveTranscriptsDir(env) })
  const from = turns?.from ?? 0
  const to = turns?.to ?? Number.MAX_SAFE_INTEGER
  const rows: TranscriptRow[] = store.readTurns(sessionId, from, to)
  if (rows.length === 0) {
    io.err(
      turns === undefined
        ? `no transcript for session ${sessionId}`
        : `no transcript for session ${sessionId} in turns ${turns.from}..${turns.to}`,
    )
    return 1
  }
  if (args.flags.has('json')) {
    io.out(JSON.stringify({ sessionId, turns: turns ?? null, rows }))
    return 0
  }
  io.out(
    `session: ${sessionId}  turns: ${turns === undefined ? 'all' : `${turns.from}..${turns.to}`}  rows: ${rows.length}`,
  )
  for (const row of rows) {
    io.out(
      `turn ${row.turn_index} ${row.role}  chars ${row.char_start}..${row.char_end}  sha256:${row.content_hash.slice(0, 12)}…  "${preview(row.text)}"`,
    )
  }
  return 0
}
