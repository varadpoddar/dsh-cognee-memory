# Transcripts — the lossless local evidence store (1.0.6, slice 5a)

The ingest queue records conversation *tasks* and deletes them once Cognee has
them. A summary, a recalled memory, or any later pointer still has to resolve
back to the **exact words** it came from. This is that store: every committed
turn, both sides, verbatim, locally, with no character cap.

It is written by the same post-commit hook that feeds the turn journal
(`src/hooks/session-events.ts`, `session/event` + `agent/turn-stopping`), so it
sees only turns DSH has already committed to disk.

## Layout

```
$DSH_HOME/plugins/cognee-memory/transcripts/
  <encodeURIComponent(session_id)>.jsonl     # one file per session, 0600
```

One JSON object per line, append-only:

```json
{"session_id":"…","turn_index":12,"role":"user","text":"…verbatim…",
 "timestamp":"2026-11-24T18:20:00.000Z","char_start":8123,"char_end":11044,
 "content_hash":"<sha256 hex of text>"}
```

- The directory defaults to `$DSH_HOME/plugins/cognee-memory/transcripts` and is
  overridden with `COGNEE_MEMORY_TRANSCRIPTS_DIR` (tests and manual runs).
- One row per `(session_id, turn_index, role)`: a turn's several user messages
  are joined with `\n\n` into that turn's user row; assistant text blocks are
  joined the same way. Nothing is trimmed, chunked, or truncated.
- The plugin state dir already holds `ingest-queue.jsonl`, `provenance.json`,
  settings, and ledgers; transcripts sit beside them and reuse the same
  conventions (0700 dir, 0600 file, JSONL append, cross-process lock).

## Addressing

The **canonical transcript text** of a session is every row in canonical order
(`turn_index` ascending, `user` before `assistant` in the same turn) joined by
the two-character separator `\n\n`.

`char_start` / `char_end` are UTF-16 code-unit offsets into that string
(JavaScript `String.prototype.slice` units), so:

```js
canonical.slice(row.char_start, row.char_end) === row.text
```

`content_hash` is sha256 over the exact text bytes — no whitespace
normalization, so two identical messages keep distinct rows (their identity is
the turn/role key) while an edited message changes its hash.

Read APIs (`src/memory/transcript-store.ts`):

| Call | Returns |
| - | - |
| `appendTurn({sessionId, turnIndex, role, text, timestamp?})` | the stored row; idempotent for the same key+hash, `CONFLICT` for different text, `VALIDATION` for out-of-order turns |
| `readTurn(sessionId, turnIndex, role?)` | one row, recomputed offsets |
| `readTurns(sessionId, turnStart, turnEnd)` | rows in an inclusive turn range |
| `readRange(sessionId, {turnStart, turnEnd, charStart?, charEnd?})` | exact text slice + its sha256 + the rows it spans; `undefined` when the session/range is absent |
| `sessions()` | session ids present on disk |

Reads fold the file from disk and recompute offsets, so a torn trailing line
(the only failure mode of an append) is skipped and can never shift a later
row. A corrupt line that was hand-edited in is skipped too; appends continue.

## Durability and concurrency

Every append takes `<file>.lock` (the same `open(..., 'wx')` + 25 ms
`Atomics.wait` + 30 s stale-lock recovery as `queue/store.ts`), writes one line,
`fsync`s, and releases the lock. `syncWrites` defaults to `true`: an
acknowledged turn is durable before the turn returns. The web process and any
CLI/backfill process can therefore append concurrently without losing or
interleaving a line.

## Pointers

`src/memory/pointer.ts` is the schema that names a range:

```json
{"session_id":"…","turn_start":12,"turn_end":13,"segment_index":6,
 "content_hash":"<sha256 of the exact segment text>","char_start":8123,"char_end":11044}
```

`buildPointer` recomputes the hash from the turns (never trusts a supplied one),
`serializePointer`/`deserializePointer` are byte-stable and validate every
field, and `pointerMatches(pointer, text)` is the staleness check. The
turn-boundary segmenter (`src/memory/segmenter.ts`) cuts only at role changes;
`maxCharsPerSegment` is off by default and can only split *between* turns. A
pointer is therefore reproducible offline from the transcript store alone.

A memory record may carry one pointer (`ProvenanceIndex.setPointer`,
`recordWrite({pointer})`). The detail page then gains a **Source** section with
the session id, turn range, char offsets, and the exact text; a missing session
renders "transcript unavailable", and a hash mismatch is labelled stale instead
of silently pairing edited text. The same range is available programmatically:

```
GET /plugins/cognee-memory/transcript/<session_id>/<turn_index>
Authorization: Bearer $COGNEE_MEMORY_SETTINGS_TOKEN
```

| Condition | Answer |
| - | - |
| token unset | `503` |
| missing/wrong token | `401` |
| caller has no readable scope | `404` (generic, like the memory route) |
| store not configured in this process | `503` |
| unknown session, turn, or malformed path | `404` |
| found | `200` JSON: `session_id`, `turn_index`, `role`, `text`, `timestamp`, `char_start`, `char_end`, `content_hash` |

Manual, offline equivalent:

```
memory transcript show --session <id> [--turns 12..13] [--json]
```

## Retention

This slice deliberately has **no automatic deletion**. Transcripts are the
evidence layer; pruning them turns pointers into "transcript unavailable", so
retention is an operator decision, not a timer:

```bash
# inspect size
du -sh "$DSH_HOME/plugins/cognee-memory/transcripts"
# remove one session's evidence (the panel then says "transcript unavailable")
rm "$DSH_HOME/plugins/cognee-memory/transcripts/<encoded-session-id>.jsonl"
```

Deleting a session file does not touch the ingest queue, Cognee, or the
provenance index. A pointer's coordinates remain readable, but its text is gone.

## Size estimates (682 sessions)

Assumptions, stated so they can be re-checked with `du` after a live import:
20 turns per session (median), two rows per turn, ~1.05 KB of text per row, and
~210 bytes of JSON keys/timestamp/hash/offsets per row.

| Quantity | Value |
| - | - |
| rows | 682 × 20 × 2 ≈ 27 000 |
| text | ≈ 28 MB |
| JSONL overhead | ≈ 5–6 MB |
| total | **≈ 35 MB** |
| with a heavy tail (10% of sessions at 100 turns) | **≈ 45–50 MB** |

Per unit rate for planning: one turn (both sides) ≈ 2.4–2.7 KB on disk, so
10 000 turns ≈ 25 MB and 100 000 turns ≈ 250 MB. This is small next to the
Cognee graph; a 1 GB budget covers years of conversation. Growth is
proportional to history, unlike the queue (proportional to backlog).

## Privacy and limits

- **Verbatim by design.** Unlike the journal (which can shape-redact at
  enqueue), this store keeps the committed text exactly. It is 0600 under a
  0700 directory, never leaves the machine, is never logged, and is never sent
  to Cognee by this module. Treat the directory like the session files
  themselves.
- One row per role per turn; two distinct messages inside one turn are joined in
  that row rather than being separately addressable.
- Out-of-order appends are refused (`VALIDATION`) instead of rewriting earlier
  offsets; a replay of the same turn is idempotent.
- Summarization (5d) and backfill (5f) are not part of 1.0.6. Nothing here calls
  an LLM or Cognee, and no summary is written yet.
