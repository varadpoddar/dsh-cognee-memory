# Nightly ingest pipeline

A durable queue of conversation turns, drained by LLM-backed workers, so
archival does not run inside an interactive turn.

## Why the unit of work is `remember`, not `add`

`docs/INGEST_COST.md` measured it: after `POST /add` a dataset reports
`searchable: false` and **every** search type — including `CHUNKS_LEXICAL` —
answers 404 `data is added but not processed: nothing is searchable yet`.
`add` = 872 ms, `cognify` = 12 512 ms for the same short document. So the
consumer's unit of work is `remember` (add + cognify + poll until searchable),
and the lever for cost is batching a drain window, not skipping the graph step.

## Layout

| file | role |
| --- | --- |
| `src/queue/store.ts` | append-only JSONL, last-write-wins fold, content-hash idempotency, lease recovery, exponential backoff, compaction |
| `src/queue/producer.ts` | turn-granular entries from session transcripts |
| `src/queue/drain.ts` | N workers, one leased item at a time, stop signal |
| `src/cli/queue-cmd.ts` | `queue enqueue / drain / status` |
| `src/security/ingest-redaction.ts` | secrets -> PII -> re-scan, applied in the drain write path |
| `deploy/systemd/*` | nightly 04:00 timer + drain oneshot |

## Operator surface

```
memory queue enqueue --from-sessions [--limit-sessions 20] [--limit 500] --apply
memory queue drain --apply [--workers 2] [--limit 50] [--json]
memory queue status
```

Dry run is the default for both writing commands. `--workers` is capped by the
number of targets; targets come from
`COGNEE_QUEUE_ENDPOINTS=gpu0=http://…,gpu1=http://…` and default to the single
configured `apiBaseUrl`.

Properties worth relying on:

- **Idempotent** — content hash over `scope + normalized text`; re-running a
  backfill reports `duplicates` and writes nothing.
- **Resumable** — every mutation is one appended line; a torn trailing line is
  skipped. A claimed item holds a 15-minute lease that `open()` reclaims, so a
  `kill -9` mid-drain resumes instead of losing or double-counting work.
- **Backoff** — 30 s base, doubling, 1 h cap, 6 attempts, then terminal
  `failed`. Retries only become claimable when `nextAttemptAt` passes.
- **Interrupt-safe** — `SIGTERM` lets the in-flight item finish and leaves the
  rest `pending`; nothing is left `inflight` past its lease.
- **Non-blocking** — the drain is a separate process reading the same file; an
  interactive turn never waits on it.

## Pilot (real Mac history, 2026-11-24)

| metric | value |
| --- | --- |
| sessions read | 20 (newest first) |
| items enqueued | 78 (18 122 chars) |
| messages skipped | 17 too long (>2 000 chars), 860 not human |
| workers | 2, splitting 39 / 39 |
| wall time | **645.6 s** (10 m 45 s) |
| outcome | **78 done**, 0 failed |
| transient failures | 1, recovered by backoff and completed in the same run |
| throughput | ~8.2 s/item wall (~440 items/h) |
| dataset | `dsh-project-pilot-20261124` (`a7cc17f0-e8e7-5cfb-badc-03a177c6fc72`) |

Verification on that dataset: `CHUNKS` returned 3 hits for each of `cognee`,
`redaction`, `queue`; `GRAPH_COMPLETION` returned a grounded paragraph, so the
pilot corpus is recallable, not merely stored.

## Full-corpus projection

| metric | value |
| --- | --- |
| sessions | 676 |
| items | 250 (155 754 chars, ~39 k tokens) |
| wall time at 2 workers | **~34 min** (250 x 8.2 s) |
| LLM graph calls | 250 cognify runs through `10.20.10.40:8888` |
| skips | 607 too long, 3 733 not human |

The corpus is small because the extractor is deliberately narrow: one item per
committed human turn, text blocks only. The projection is therefore dominated by
per-item fixed cost (~8 s), not by volume — batching `cognify` across a window is
the only thing that would move it materially.

## Scheduling

`dsh-cognify-queue.timer` runs `OnCalendar=*-*-* 04:00:00` (host time zone is
`America/Los_Angeles`, so 04:00 PST/PDT) with `Persistent=true` (a missed night
runs once on next boot) and `RandomizedDelaySec=300`; the oneshot has
`TimeoutStartSec=3h`, `TimeoutStopSec=120`, `Nice=10`, `IOSchedulingClass=idle`,
and reads `/etc/dsh-varad/varad.env` with `DSH_HOME=/home/varad/.dsh`.

`--drain` for a manual run is just `memory queue drain --apply`.

### What is on disk before consolidation

Three durable spools exist, all append-only JSONL in the instance's DSH home:

| file | written by | drained by |
| --- | --- | --- |
| `$DSH_HOME/cognee-memory/candidates.jsonl` | the plugin after every committed user turn (`CandidateQueue`, mode 0600, capped by `extraction.queue.maxPending`, default 100) | the plugin at activation/turn — i.e. next time that instance runs |
| `$DSH_HOME/cognee-memory/outbox.jsonl` | failed writes that must be replayed in order | the plugin's outbox flush |
| `$DSH_HOME/plugins/cognee-memory/ingest-queue.jsonl` | `memory queue enqueue` (backfills, scripted imports) | `dsh-cognify-queue.service` at 04:00, or `memory queue drain --apply` |

Turns are therefore journalled to disk before they reach Cognee, and a Cognee
outage does not lose them: candidates stay pending until the instance runs again,
queued batch items wait for the timer. Two limits matter: the candidate spool is
capped (`maxPending` 100 — a full spool rejects new candidates rather than
growing), and an `ingest-queue` item goes terminal `failed` after 6 attempts, so
an outage longer than one drain window needs a re-enqueue (idempotent) for those
items. No CLI command drains `candidates.jsonl`; that spool belongs to the plugin
process.

## Deployment (2026-11-24)

The CLI is installed and the timer is live:

| item | value |
| --- | --- |
| deploy path | `/opt/dsh-cognee-memory` (owner `varad`), package **1.0.3**, node 22.23.5 |
| runtime deps | `npm install --omit=dev --legacy-peer-deps` → `zod` only; built `lib/` ships in the tarball |
| units | `/etc/systemd/system/dsh-cognify-queue.{service,timer}`, `systemd-analyze verify`-clean |
| timer | **enabled/active**, next `Wed 2026-11-25 04:02:25 PST` (`04:00` + `RandomizedDelaySec`) |
| smoke | `queue status` + `queue drain` (dry) from `/opt`, then one real item: `ok … 14 717 ms`, `workers 1` |
| instances | `deepseek-harness` and `deepseek-harness-varad` both `active` during and after |

The oneshot needs three env values beyond `EnvironmentFile`:

```
Environment=COGNEE_MEMORY_API_BASE_URL=http://10.20.10.15:8000/api/v1
Environment=COGNEE_QUEUE_ENDPOINTS=cognee=http://10.20.10.15:8000/api/v1,cognee-2=http://10.20.10.15:8000/api/v1
Environment=COGNEE_PII_ENABLED=false
```

`COGNEE_MEMORY_API_BASE_URL` is the *settings* env name the CLI reads.
`COGNEE_BASE_URL` (the MCP servers' variable) is ignored: without the settings
name the drain falls back to `http://127.0.0.1:8000` and retries forever — that
was observed on the first deploy, together with a silent early exit caused by
retry sleeps whose timer is `unref`'d. Both are fixed (`drain.ts` keep-alive;
`README`/unit). `COGNEE_PII_ENABLED=false` is the 1.0.3 default (LLM PII pass
off); the deterministic shaped-secret scrub still runs unconditionally.

Manual run, same env as the unit:

```bash
systemctl enable --now dsh-cognify-queue.timer
systemctl list-timers dsh-cognify-queue.timer
systemctl start dsh-cognify-queue.service   # trigger the nightly job now
```

## Deployed backfill — full Mac history (2026-11-24)

| metric | value |
| --- | --- |
| source | Mac `~/.dsh/sessions` (read-only), 682 sessions |
| enqueued | **247 unique items** (250 produced, 3 content-hash duplicates; 614 too long, 3 753 not human) |
| target | `varad` instance project scope — dataset `dsh-project-varad-mac-history-5c5a11e6b8d6859e32a4` (`c74cc337-4d0c-5ac9-b85f-8d6560be37a1`) |
| workers | 2, two aliases of the **single** Cognee endpoint (123 / 122 split) |
| wall time | **3 106 433 ms = 51 m 46 s** (12.6 s/item wall) — projection was 34 min |
| outcome | **245 done** on first attempt, 2 terminal failures, 0 `inflight` left |
| failures | 2 items whose text *begins* with `http(s)://`: Cognee answers `403` (it treats the payload as an external URL), 6 attempts each → terminal `failed`. Re-enqueued with a `url: ` prefix and drained: both `done`, so 247 of 249 items ingested |
| retries | 12 failed attempts total, all from those 2 items; no transient retry on the 245 successes |
| records | **254** in the dataset (9 pre-existing + 245 new; 2 items deduplicated at write time) |
| redaction | PII pass off, shaped-secret scrub on (0 credential hits reported by the drain) |

Verification after the drain: 5 stored records sampled across the corpus were
re-retrieved through `CHUNKS` (ranks 1/1/1/2/3, scores 0.75–1.00), and 5 sampled
facts came back verbatim from the varad instance's `memory_recall`. A fresh
tools-off headless turn (one message, extraction off) answered "which branch and
constraint scoped the Task 1 baseline audit" with
`codex/auth-persistence-baseline` + "audit only, no commits" — a fact from an
older Mac conversation, injected through `Known context` without any tool call.

## Two workers, one endpoint

Two workers ran against **one** Cognee endpoint for the whole backfill (123/122
split), so the concurrency plumbing is exercised at real volume. A second GPU is
not available: `10.20.10.40:8888` is the only Unsloth endpoint, and starting a
second instance would not add throughput for *cognify*, which is Cognee-side.
The ~34 min projection assumed the pilot's 8.2 s/item; measured was 12.6 s/item,
so treat projections from a 78-item sample as optimistic for a 247-item run.
