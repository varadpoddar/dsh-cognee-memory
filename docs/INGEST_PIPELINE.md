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
| `deploy/systemd/*` | nightly 02:30 timer + drain oneshot |

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

`dsh-cognify-queue.timer` runs `OnCalendar=*-*-* 02:30:00` with
`Persistent=true` (a missed night runs once on next boot) and
`RandomizedDelaySec=300`; the oneshot has `TimeoutStartSec=3h`,
`TimeoutStopSec=120`, `Nice=10`, `IOSchedulingClass=idle`, and reads
`/etc/dsh-varad/varad.env` with `DSH_HOME=/home/varad/.dsh`.

`--drain` for a manual run is just `memory queue drain --apply`.

**Deployment state: units installed and `systemd-analyze verify`-clean on CT 103,
timer intentionally NOT enabled.** The service `ExecStart` points at
`/opt/dsh-cognee-memory/lib/cli/main.js`, which does not exist yet — the package
(runtime deps included) has not been deployed there, and enabling a timer that
fails nightly would be worse than not scheduling it. Enabling is:

```
systemctl enable --now dsh-cognify-queue.timer
systemctl list-timers dsh-cognify-queue.timer
```

## Two endpoints

Two workers were exercised against **one** Cognee endpoint (39/39 split), which
proves the concurrency plumbing. A genuinely second model endpoint is not
available today; see the endpoint findings in the run report — the GGUF host has
a free GPU, but the second instance was not started, so the per-endpoint config is
verified by unit test rather than by a live second GPU.
