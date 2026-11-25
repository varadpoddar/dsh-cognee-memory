#!/usr/bin/env node
/**
 * Ingest the written infrastructure docs into Cognee memory.
 *
 * Why: the service register (addresses, S3 endpoints, where credentials live)
 * was discovered at deploy time and never appears in a conversation transcript,
 * so recall over summaries alone cannot answer "where is SeaweedFS / Infisical".
 * The docs carry the truth, so they are ingested as documents.
 *
 * Chunking follows the headings, but a chunk must also survive the model-facing
 * line budget: the injected `Known context:` line is the first ~240 characters
 * of the stored document, so a service address has to be near the start of its
 * own chunk. Therefore:
 *   - one chunk per H2 section (H3 starts a new chunk too);
 *   - a table with 3+ data rows becomes one chunk per row, so the row's address
 *     is the first thing the label carries;
 *   - long prose is grouped into ~1.2 KB chunks at paragraph boundaries.
 * Every chunk is rendered summary-style with a `[[dsh-memory-pointer …]]`
 * header, so the drain writes it through the same admission path as a segment
 * summary: redaction, dedup, provenance index and ledger row per chunk.
 *
 *   node scripts/ingest-docs.mjs --docs /home/varad/.dsh/docs [--apply]
 *
 * Dry run is the default; `--apply` appends to the durable ingest queue and the
 * normal drain (batched add+cognify) ingests the chunks. Re-running after a doc
 * edit is safe: an unchanged chunk is skipped by the queue's dedupe hash, a
 * changed one is enqueued again.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const LIB =
  process.env.COGNEE_MEMORY_LIB ??
  '/home/varad/.dsh/profiles/web/node_modules/dsh-cognee-memory/lib'
const { IngestQueue, resolveQueuePath } = await import(`${LIB}/queue/store.js`)
const { queueOptionsFromEnv } = await import(`${LIB}/cli/queue-cmd.js`)
const { makeScopeRef, scopeKey } = await import(`${LIB}/memory/scopes.js`)
const { parseSummaryDocument, pointerHash } = await import(`${LIB}/memory/pointer.js`)

const DOCS = [
  'ACHIEVEMENTS.md',
  'SEAWEEDFS.md',
  'INFISICAL.md',
  'BACKUP.md',
  'RESTORE.md',
  'RUNBOOK.md',
  'SUMMARY_PIPELINE.md',
  'TRANSCRIPTS.md',
  'TURN_JOURNAL.md',
]

/** Documented facts can be re-ingested by bumping this when chunking changes. */
const DOC_MODEL = 'markdown-doc'
const DOC_PROMPT_VERSION = 'docs-1'
/** Register docs whose table rows are themselves the retrievable fact. */
const ROW_SPLIT_DOCS = new Set(['ACHIEVEMENTS.md'])

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`)
  if (index === -1) return fallback
  const value = process.argv[index + 1]
  return value === undefined || value.startsWith('--') ? true : value
}

const docsDir = arg('docs', '/home/varad/.dsh/docs')
const apply = process.argv.includes('--apply')
const scope = makeScopeRef('project', 'varad/mac-history')
const scopeName = scopeKey(scope)

/** One markdown table: header cells plus data rows. */
function parseTable(lines) {
  if (lines.length < 2) return undefined
  const cells = (line) =>
    line
      .replace(/^\s*\|/, '')
      .replace(/\|\s*$/, '')
      .split('|')
      .map((cell) => cell.trim())
  const header = cells(lines[0])
  const rows = lines.slice(2)
  if (rows.length === 0) return undefined
  return { header, rows }
}

/** One row as `Header: value` lines, so a hit reads on its own. */
function rowText(header, row) {
  const cells = row
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())
  return cells
    .map((cell, index) => (header[index] === undefined ? cell : `${header[index]}: ${cell}`))
    .join('\n')
}

/** Cells joined for one-line context, without the markdown pipes. */
function rowLabel(header, row) {
  const cells = row
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())
    .filter((cell) => cell !== '')
  return cells.join(' · ').slice(0, 150)
}

/**
 * Split one markdown file into chunks. Default granularity is one chunk per H2
 * section (whole section: prose and tables), which is what a reader would cite.
 * The service register is the exception: its table rows are the addresses, and
 * the model-visible line is only the first ~240 characters of a chunk, so
 * `rowSplit` files emit one chunk per table row with the row's address leading.
 * Returns {heading, body, start, end, key} in file order.
 */
function chunksOf(file, text, rowSplit) {
  const lines = text.split('\n')
  const out = []
  let h1 = file
  let h2 = ''
  let buffer = []
  let bufferStart = 0
  let offset = 0
  let seq = 0

  const context = () => (h2 === '' ? `# ${file} · ${h1}` : `# ${file} · ${h2}`)
  const flush = () => {
    const body = buffer.join('\n').trim()
    if (body !== '') {
      out.push({ heading: context(), body, start: bufferStart, end: offset, key: h2 === '' ? '__preamble__' : h2 })
      seq += 1
    }
    buffer = []
  }

  let inFence = false
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const lineStart = offset
    offset += line.length + 1
    // A fenced code block may contain shell comments (`# ...`) that look like
    // headings; they must stay inside the surrounding chunk.
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence
      if (buffer.length === 0) bufferStart = lineStart
      buffer.push(line)
      continue
    }
    if (inFence) {
      if (buffer.length === 0) bufferStart = lineStart
      buffer.push(line)
      continue
    }
    if (line.startsWith('# ')) {
      flush()
      h1 = line.slice(2).trim()
      bufferStart = offset
      continue
    }
    if (line.startsWith('## ')) {
      flush()
      h2 = line.slice(3).trim()
      bufferStart = offset
      continue
    }
    if (rowSplit && line.trim().startsWith('|')) {
      const tableLines = [line]
      let cursor = index + 1
      let tableEnd = offset
      while (cursor < lines.length && lines[cursor].trim().startsWith('|')) {
        tableLines.push(lines[cursor])
        tableEnd += lines[cursor].length + 1
        cursor += 1
      }
      const table = parseTable(tableLines)
      if (table !== undefined && table.rows.length >= 3) {
        flush()
        table.rows.forEach((row, rowIndex) => {
          out.push({
            heading: `${context()} · ${rowLabel(table.header, row)}`,
            body: rowText(table.header, row),
            start: lineStart,
            end: tableEnd,
            key: `${h2}/row${rowIndex}`,
          })
        })
        index = cursor - 1
        offset = tableEnd
        bufferStart = offset
        continue
      }
    }
    if (buffer.length === 0) bufferStart = lineStart
    buffer.push(line)
  }
  flush()
  return out
}

let docs = 0
let chunks = 0
const entries = []
const plan = []
for (const name of DOCS) {
  const path = join(docsDir, name)
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    console.error(`missing doc: ${path}`)
    process.exitCode = 1
    continue
  }
  docs += 1
  const fileChunks = chunksOf(name, text, ROW_SPLIT_DOCS.has(name))
  plan.push({
    file: name,
    chunks: fileChunks.length,
    first_labels: fileChunks.slice(0, 2).map((c) => c.heading),
    ...(process.argv.includes('--labels') ? { labels: fileChunks.map((c) => c.heading.slice(0, 260)) } : {}),
  })
  fileChunks.forEach((chunk, index) => {
    const documentText = `${chunk.heading}\n\n${chunk.body}`
    const pointer = {
      session_id: `doc:${name}`,
      turn_start: 0,
      turn_end: 0,
      segment_index: index,
      content_hash: pointerHash(documentText),
      char_start: chunk.start,
      char_end: chunk.end ?? chunk.start + chunk.body.length,
      model: DOC_MODEL,
      prompt_version: DOC_PROMPT_VERSION,
    }
    const document = `[[dsh-memory-pointer ${JSON.stringify(pointer)}]]\n\n${documentText}`
    if (parseSummaryDocument(document) === undefined) {
      console.error(`pointer does not parse: ${name} § ${chunk.heading}`)
      process.exitCode = 1
      return
    }
    entries.push({
      text: document,
      scope: scopeName,
      scopeRef: scope,
      kind: 'summary',
      // Section/row identity, not content: an edited chunk re-enqueues with a
      // new content hash while an unchanged one stays deduped.
      dedupeKey: `doc:${name}:${chunk.key}`,
      source: { sessionId: `doc:${name}`, turnIndex: index, projectId: 'varad/mac-history' },
    })
    chunks += 1
  })
}

const queue = IngestQueue.open({ filePath: resolveQueuePath(process.env), ...queueOptionsFromEnv(process.env) })
const before = queue.status()
const report = apply ? queue.enqueue(entries) : { added: 0, duplicates: 0 }
const after = queue.status()
console.log(
  JSON.stringify({
    docs,
    chunks,
    apply,
    added: apply ? report.added : 0,
    duplicates: apply ? report.duplicates : 0,
    queue: {
      path: resolveQueuePath(process.env),
      pending_before: before.counts.pending,
      pending_after: after.counts.pending,
    },
    sections: plan,
  }),
)
