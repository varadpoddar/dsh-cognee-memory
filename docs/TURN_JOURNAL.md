# Turn journal — conversations as durable tasks

Feature decision (2026-11-24): every part of a conversation — your messages and
the agent's answers — becomes a **task** on the ingest queue. Tasks are ingested
by the nightly drain and **deleted only after a complete ingest**. There is no
daily cap and no pending cap: the backlog is allowed to grow, and a power cut or
a Cognee outage leaves work on disk instead of losing it.

## Why a journal next to extraction

`extraction` (docs/INGEST_PIPELINE.md) distils *facts*: deterministic commands
("remember that…") and an optional LLM pass. It is lossy on purpose — most turns
produce nothing — and it writes into Cognee during the turn. The journal is the
opposite trade-off: it records the conversation verbatim (both sides), spools it
to disk, and defers all ingestion to the nightly cycle. Extraction stays on; the
two paths share one queue, one drain and one redaction policy.

## Lifecycle

```
committed turn
  -> journal.recordTurn()          (plugin, at turn/end, fsync append)
  -> ingest-queue.jsonl task       pending
  -> nightly drain (04:00)         claim -> inflight (lease 15 min)
  -> Cognee remember + cognify     ok
  -> markDone                      done
  -> pruneDone                     task deleted, hash kept as a tombstone
```

- **pending / inflight / failed** rows survive restarts. A lease older than
  15 minutes returns an interrupted task to `pending` on the next open.
- **done** is transient: the drain prunes it at the end of the run. The content
  hash stays in `ingest-queue.jsonl.done` for `tombstoneRetentionDays` (30) so a
  replayed journal line or a re-run backfill is still a duplicate, not a
  re-ingest.
- **failures** retry forever with exponential backoff capped at
  `maxBackoffMs` (1 h) — a multi-day outage just leaves the task waiting.
  Permanent refusals (authz, validation, `403` payloads) are marked `failed`
  with `permanent: true` and are never claimed again; they stay visible.
- **order**: tasks are claimed oldest-first, so a backlog is ingested in the
  order it happened.

## Identity and dedupe

The content hash is seeded with `session:turn:seq:role:part` (`dedupeKey`), not
just the text. Two identical messages ("continue") are two tasks; replaying the
same journal line is one task. Extraction/backfill entries keep the old
text-only hash, so their re-runs remain idempotent.

Long messages are split at `chunkChars` (default 8 000) on line/space
boundaries. Nothing is truncated or dropped; each part is an independent task
with `source.partIndex`/`partOf`.

## Durability

- every append is `write(2)` + `fdatasync` (`ingestion.queue.syncWrites`), so an
  acknowledged turn is on disk before the turn returns;
- the log is append-only JSONL folded last-write-wins; a torn trailing line is
  skipped;
- enqueue and prune take a cross-process lock (`ingest-queue.jsonl.lock`), so
  the web process journaling a turn cannot race the drainer's prune rewrite.

## Transcript store (1.0.6)

The journal answers "what still has to be ingested"; it cannot answer "what were
the exact words of turn 12" once a task is pruned. A second, separate store does
that: `$DSH_HOME/plugins/cognee-memory/transcripts/<session>.jsonl`
(docs/TRANSCRIPTS.md). Both sides of every committed turn are appended verbatim,
with no character cap, fsynced under a cross-process lock. The journal's
`chunkChars` split and `redactAtEnqueue` policy do **not** apply to it: it is
the evidence copy, 0600 on the local disk. A pointer
`{session_id, turn_start, turn_end, segment_index, content_hash, char_start,
char_end}` names a range, and the detail page resolves it to the exact text (or
an honest "transcript unavailable" note). Summarization and backfill of that
store arrive in later slices.

## Configuration

```yaml
ingestion:
  journal:
    enabled: false        # opt-in; off preserves prior behaviour
    includeAssistant: true
    chunkChars: 8000
    redactAtEnqueue: true # shaped secrets scrubbed before disk (PII pass stays off)
    scope: project        # defaults to scopes.defaultWriteScope
  queue:
    syncWrites: true
    baseBackoffMs: 30000
    maxBackoffMs: 3600000
    maxAttempts: 1000000  # effectively unlimited
    tombstoneRetentionDays: 30
```

`memory queue status` shows the same numbers; the settings page gains a
**Conversation tasks** table (state, role, attempts, session/turn, preview) that
lists exactly the work that is not yet fully ingested.

## Cost

Measured: 12.6 s per item at 2 workers against one Cognee endpoint. A day of
conversation is tens of tasks (minutes); a year of heavy use is thousands
(hours spread over nights). Because completed tasks are pruned, the log stays
proportional to the *backlog*, not to history. The unit's `TimeoutStartSec=3h`
caps one night; whatever is left stays pending for the next night.

## Known limits

- No per-turn grouping: parts of one message are independent tasks, so a turn
  can be partially ingested. Re-running `remember` for a part is idempotent.
- Journaling stores conversation text on disk (0600) until the drain prunes it.
  Shaped secrets are redacted at enqueue; the LLM PII pass is off by default.
- One queue per DSH home. Two instances need two 04:00 drains, or a hand-off.
- The web process folds the queue once at activation; a long-running process
  does not see tombstone updates made by the drainer. The dedupe seed makes a
  duplicate practically impossible for journal entries.
