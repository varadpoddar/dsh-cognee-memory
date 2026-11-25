#!/usr/bin/env node
/**
 * Reconcile segment summaries after the 1.0.8 queue-loss incident.
 *
 * 1.0.8's drain rewrote the queue log from a pre-append snapshot, so summary
 * rows appended by the concurrent backfill were silently discarded. Only the
 * rows that survived to Cognee can be recovered; every other segment must be
 * summarised again, but only once and without re-summarising what is already
 * there.
 *
 * This tool is deterministic: it walks the same sessions in the same order as
 * `backfill-transcripts`, rebuilds the same segments from the (complete)
 * transcript store, skips every segment whose pointer hash is in the recovered
 * manifest, and summarises the rest.
 *
 *   node scripts/reconcile-summaries.mjs --recovered <file.jsonl> --stop <session-id> --plan
 *   node scripts/reconcile-summaries.mjs --recovered <file.jsonl> --stop <session-id> --apply
 *
 * `--stop` is the session the interrupted backfill was last working on: every
 * earlier session is complete (those summaries are either recovered or lost),
 * the stop session and later ones are still being produced by that process and
 * are therefore left alone. `--limit N` bounds a run for verification.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const LIB = process.env.RECONCILE_LIB ?? '/home/varad/.dsh/profiles/web/node_modules/dsh-cognee-memory/lib'
const { parseConfig } = await import(`${LIB}/config/schema.js`)
const { discoverTranscripts, readTranscriptFull } = await import(`${LIB}/cli/transcript.js`)
const { segmentsOf } = await import(`${LIB}/cli/backfill-transcripts.js`)
const { TranscriptStore, resolveTranscriptsDir } = await import(`${LIB}/memory/transcript-store.js`)
const { summarizeSegment, resolveSummaryRuntime, enqueueSummary } = await import(`${LIB}/memory/summarizer.js`)
const { makeScopeRef, scopeKey } = await import(`${LIB}/memory/scopes.js`)
const { IngestQueue, resolveQueuePath } = await import(`${LIB}/queue/store.js`)

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}

const recoveredPath = arg('recovered', '/home/varad/reconcile/summaries.jsonl')
const stopSession = arg('stop', undefined)
const apply = process.argv.includes('--apply')
const limit = Number(arg('limit', 0))
const sessionsDir = arg('sessions', '/home/varad/import/mac-sessions')
const outDir = arg('out', '/home/varad/reconcile')
const concurrency = Number(arg('concurrency', 2))

const env = process.env
const config = parseConfig({
  enabled: true,
  scopeDefaults: { projectId: 'varad/mac-history' },
  ingestion: { summaries: { enabled: true, maxOutputTokens: 1000 } },
})
const runtime = resolveSummaryRuntime(config, env)
if (!runtime.enabled) {
  console.error(`summaries unavailable: ${runtime.reason}`)
  process.exit(2)
}
const scope = makeScopeRef('project', 'varad/mac-history')
const scopeName = scopeKey(scope)

const recovered = new Set()
if (existsSync(recoveredPath)) {
  for (const line of readFileSync(recoveredPath, 'utf8').split('\n')) {
    if (line.trim() === '') continue
    try {
      const row = JSON.parse(line)
      if (typeof row.content_hash === 'string') recovered.add(row.content_hash)
    } catch {
      // skip a torn line
    }
  }
}

const store = new TranscriptStore({ dir: resolveTranscriptsDir(env), env })
const turnsFor = (sessionId) => {
  const rows = store.readTurns(sessionId, 0, Number.MAX_SAFE_INTEGER)
  return rows
    .map((row) => ({ turn: row.turn_index, role: row.role, text: row.text, timestamp: row.timestamp }))
    .sort((a, b) =>
      a.turn !== b.turn ? a.turn - b.turn : (a.role === 'user' ? 0 : 1) - (b.role === 'user' ? 0 : 1),
    )
}

const missing = []
let sessions = 0
let segments = 0
let skippedRecovered = 0
let stopped = false
for (const filePath of discoverTranscripts(sessionsDir)) {
  if (stopped) break
  const transcript = readTranscriptFull(filePath, { includeAssistant: true, maxMessageChars: 0 })
  if (transcript.messages.length === 0) continue
  if (stopSession !== undefined && transcript.sessionId === stopSession) break
  const turns = turnsFor(transcript.sessionId)
  if (turns.length === 0) continue
  sessions += 1
  for (const segment of segmentsOf(turns, config.ingestion.summaries.maxCharsPerSegment)) {
    segments += 1
    if (recovered.has(segment.contentHash)) {
      skippedRecovered += 1
      continue
    }
    missing.push({ sessionId: transcript.sessionId, segment })
  }
}

const plan = {
  sessions,
  segments,
  recovered_present: skippedRecovered,
  recovered_manifest: recovered.size,
  missing: missing.length,
  apply,
  stop_session: stopSession,
}
console.log(`PLAN ${JSON.stringify(plan)}`)

const manifest = `${outDir}/missing-segments.jsonl`
mkdirSync(dirname(manifest), { recursive: true })
writeFileSync(
  manifest,
  missing
    .map((row) =>
      JSON.stringify({
        session_id: row.sessionId,
        segment_index: row.segment.segmentIndex,
        turn_start: row.segment.turnStart,
        turn_end: row.segment.turnEnd,
        content_hash: row.segment.contentHash,
      }),
    )
    .join('\n') + (missing.length === 0 ? '' : '\n'),
)
console.log(`MANIFEST ${manifest}`)

if (!apply) process.exit(0)

const queue = IngestQueue.open({ filePath: resolveQueuePath(env) })
const selected = limit > 0 ? missing.slice(0, limit) : missing
let summarised = 0
let enqueued = 0
let duplicates = 0
let failed = 0
let cursor = 0
const startedAt = Date.now()
async function worker() {
  for (;;) {
    const index = cursor
    cursor += 1
    if (index >= selected.length) return
    const item = selected[index]
    try {
      const summary = await summarizeSegment(
        { sessionId: item.sessionId, segment: item.segment },
        {
          endpoint: runtime.endpoint,
          model: runtime.model,
          apiKey: runtime.apiKey,
          maxOutputTokens: runtime.maxOutputTokens,
          maxInputChars: runtime.maxInputChars,
          disableReasoning: runtime.disableReasoning,
          timeoutMs: runtime.timeoutMs,
          env,
        },
      )
      summarised += 1
      const report = enqueueSummary(queue, { summary, scope: scopeName, scopeRef: scope })
      enqueued += report.added
      duplicates += report.duplicates
    } catch (error) {
      failed += 1
      console.error(`FAIL ${item.sessionId} ${item.segment.segmentIndex}: ${error instanceof Error ? error.message : error}`)
    }
    if (summarised % 10 === 0) {
      const elapsed = Math.round((Date.now() - startedAt) / 1000)
      console.log(`progress ${summarised}/${selected.length} enqueued=${enqueued} dup=${duplicates} fail=${failed} ${elapsed}s`)
    }
  }
}
await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => worker()))
const report = {
  ...plan,
  run_segments: selected.length,
  re_summarised: summarised,
  enqueued,
  duplicates,
  failed,
  wallSeconds: Math.round((Date.now() - startedAt) / 1000),
}
writeFileSync(`${outDir}/reconcile-report.json`, JSON.stringify(report, null, 2))
console.log(`RESULT ${JSON.stringify(report)}`)
