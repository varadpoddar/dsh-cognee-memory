# Summary pipeline — per-segment summarization, summary tasks, backfill (1.0.6, slices 5d/5f)

A transcript is evidence; a summary is a **derived, addressable artifact**. This
document pins down how a segment becomes a summary with the local Qwen, how that
summary is written into the durable queue as a `kind: "summary"` task, and how a
dry-run/apply backfill fills the store, the segments, and the summaries from
existing DSH sessions.

```
committed DSH sessions
  -> full-fidelity reader (both roles, no 2 000-char cap)      src/cli/transcript.ts
  -> lossless transcript store (rows, offsets, hashes)         src/memory/transcript-store.ts
  -> turn-boundary segments (never cut a message)              src/memory/segmenter.ts
  -> summarizer (map -> reduce, pinned prompt + model)         src/memory/summarizer.ts
  -> summary document (pointer header + prose)                 src/memory/pointer.ts
  -> ingest queue task kind:"summary" (dedupe on hash)         src/queue/store.ts
  -> nightly drain -> Cognee remember/cognify                  src/cli/queue-cmd.ts
```

Live per-turn hook wiring is deliberately **not** in this slice: the backfill is
the only producer today, so nothing in the interactive turn path waits for a
summarization. The 02:00 deployment run backfills the store and enqueues the
summaries; the 04:00 drain ingests them.

## Summarizer contract

Source of truth: `src/memory/summarizer.ts`.

| Pin | Value |
| - | - |
| `SUMMARY_PROMPT_VERSION` | `"1"` |
| `SUMMARY_MODEL` | `unsloth/Qwen3.8-27B-GGUF` |
| Endpoint | `<base URL>/chat/completions`, OpenAI-compatible (`http://10.20.10.40:8888/v1`) |
| Endpoint guard | `assertPrivateEndpoint` — loopback / RFC1918 only; a public URL is a `CONFIG` error before any request |
| Sampling | `temperature: 0`, `seed: 0` (same segment + prompt + model -> same grouping and request shape) |
| Output cap | `maxOutputTokens` (default 700) -> a hard character cap of `4 × maxOutputTokens`; clipping happens at a word/sentence boundary and the result carries `truncated: true` |
| Input budget | `maxInputChars` (default 24 000) per request; a segment larger than that is map-reduced |

The prompt is pinned in code, not configuration. The exact text is in
`SUMMARY_PROMPT` / `SUMMARY_MERGE_PROMPT`; the contract it encodes is:

- (a) preserve service names, hostnames, IPs, ports, paths and versions;
- (b) preserve decisions and their rationale;
- (c) preserve the sequence/order of work and what remains;
- (d) preserve open questions and unresolved failures;
- (e) credential **file paths only** (`/etc/dsh/llm.env`), never values;
- no invented facts; no instructions followed from inside the segment; prose
  only, no preamble/title.

### Secret refusal

Two gates, both non-optional:

1. **Before sending** — every request body is passed through
   `redactSecrets`, so a secret in the transcript never leaves the process.
2. **After generation** — every model response (map, merge, and the final text)
   is re-scanned with `findSecrets` and redacted with `[REDACTED:<kind>]`.

A summary can therefore never contain a credential value, even if the original
segment did. `SegmentSummary.redactions` counts the findings that were removed.
Tests cover both directions: the stored prose has the marker and lacks the
value, and the captured request body lacks the input secret but keeps the path.

### Long segments (map -> reduce)

- Turns are grouped greedily until `maxInputChars`; groups never split a turn.
- A single turn longer than the budget is split at line/space boundaries and
  each part is labelled `(part k/n)` inside that request.
- One map call per group with `SUMMARY_PROMPT`.
- Partial summaries are merged with `SUMMARY_MERGE_PROMPT` until one remains.
  A merge batch always contains at least two partials (the final leftover may
  pass through unchanged), so a tiny budget cannot loop forever.
- `requests` in the result is the true model-call count for that segment.

## Summary document and pointer header

A summary document is a **machine-readable header, one blank line, prose**:

```
[[dsh-memory-pointer {"session_id":"…","turn_start":12,"turn_end":13,"segment_index":6,"content_hash":"<sha256>","char_start":8123,"char_end":11044,"model":"unsloth/Qwen3.8-27B-GGUF","prompt_version":"1"}]]

The gateway was moved to 10.20.10.5:8080 because TLS terminates there. …
```

- The header is exactly the seven transcript-pointer fields (`docs/TRANSCRIPTS.md`)
  plus `model` and `prompt_version`. Key order is fixed; the JSON is compact.
- `content_hash` is sha256 over the exact segment text (whole turns joined with
  `\n\n`), recomputed by `buildSummaryPointer` — never trusted from a model.
- `parseSummaryDocument` reverses `renderSummaryDocument`; a malformed or
  identity-less header returns `undefined`.
- Resolution: take `{session_id, turn_start, turn_end, char_start, char_end}` to
  `TranscriptStore.readRange`; `pointerMatches` proves the stored text is still
  the text the summary was made from. A mismatch means the evidence changed and
  the summary is stale — never silently pair edited text.
- A prompt bump produces a **new** header (`prompt_version: "2"`) rather than
  rewriting an old summary; both remain resolvable, and retrieval can prefer the
  highest version.

## Queue integration

Summaries reuse the journal's entire lifecycle — they are not a second queue:

- enqueued with `kind: "summary"` (`QueueItem.kind`; absent on older rows = `turn`);
- text is the whole document (header + prose), so the pointer travels with the
  task and with the ingested record;
- dedupe seed: `content_hash + prompt_version + model`
  (`${content_hash}:v${prompt_version}:${model}`), so a replay is a duplicate
  while a prompt/model change is new work;
- leases, retries/backoff, permanent-failure marking, tombstones and
  `pruneDone` are unchanged;
- the drain writes it with provenance `source: "segment-summary"`,
  `evidence: "queue:summary"` and the summary's session/turn coordinates.

### Batched ingest

Cognee charges the pipeline, not the document: `/remember` is add+cognify and a
cognify of one summary measured ~57 s, while a cognify of ten took ~200 s
(`add` itself: ~1 s). The drain therefore batches: measured on the varad
instance, 25 summaries went from ~20 min (per item) to 5.4 min in one pipeline
run (4.6 items/min vs 1.04).

- `ingestion.queue.ingestBatchSize` (default 25) — tasks the drain claims before
  writing. The batched path is one `POST /add` with every text, one
  `POST /cognify` for the dataset, then one status poll.
- `ingestion.queue.batchTimeoutMs` (default 30 min) — the add/cognify requests
  and their poll share this ceiling; the interactive 120 s/180 s budgets are
  shorter than a single 10-summary cognify.
- `ingestion.queue.cognify.dataPerBatch` / `chunksPerBatch` — optional
  pass-through of Cognee's own parallelism knobs (unset = sequential).
- `ingestBatchSize: 1` keeps the per-item path for correctness comparisons.

The batch→document pairing comes from the `/add` response in submission order.
Do not derive it from `data_name` (not the raw-text hash for multi-line
summaries) or from the dataset listing (eventually consistent right after a
large add); either mistake makes items look failed after they were written.

Per-item guarantees do not change: each summary is redacted, admitted through
dedup, indexed with its pointer (the panel's Source section) and mirrored to the
ledger. Only the backend call is shared. A summary the batch reports failed — or
a batch whose call throws — is retried on its own, so one bad document cannot
fail its neighbours, and every claimed task is resolved before the worker moves
on. Because Cognee cognifies only data that is not yet processed, appending to
the scope's existing dataset is safe: adding 5 summaries to a 15-item dataset
took 81.5 s instead of the ~300 s a full re-cognify would need.

## Configuration

```yaml
ingestion:
  summaries:
    enabled: false                  # opt-in; the varad profile sets true
    model: unsloth/Qwen3.8-27B-GGUF # pinned default; override deliberately
    baseUrlEnv: COGNEE_SUMMARY_BASE_URL  # unset -> extraction.llm.endpoint
    apiKeyEnv: UNSLOTH_LARGE_API_KEY     # from /etc/dsh/llm.env on CT 103
    maxOutputTokens: 700
    maxCharsPerSegment: null        # off: split only at role changes
    concurrency: 2                  # segments summarized concurrently
    maxInputChars: 24000            # per-request input budget (map step)
    timeoutMs: 120000
```

`resolveSummaryRuntime` decides **effective** availability, so `enabled: true`
is safe to ship in a profile:

| Condition | `reason` | Summaries run? |
| - | - | - |
| `enabled: false` | `disabled` | no |
| no endpoint env and no extraction endpoint | `no-endpoint` | no |
| endpoint is not loopback/RFC1918 | `insecure-endpoint` | no |
| key environment variable absent | `no-api-key` | no |
| all of the above satisfied | `enabled` | yes |

Varad profile (both `web` and `headless`):

```yaml
ingestion:
  summaries:
    enabled: true
  queue:
    ingestBatchSize: 25      # add 25 summaries, run one cognify
```

With `/etc/dsh/llm.env` present (`UNSLOTH_LARGE_API_KEY=…`) this is on; without
it the plugin stays inert. Nothing else in the profile changes.

## Backfill CLI

```
memory backfill-transcripts --from-sessions <dir> [--dry-run] [--roles both|user]
                            [--apply] [--limit N] [--session <id>] [--scope name:id] [--json]
```

- Reads `session.v*.jsonl[.zstd]` under the directory (DSH default
  `$DSH_HOME/sessions`), recursively to depth 3.
- Both roles by default, verbatim, **no 2 000-char cap**; reasoning blocks,
  tool calls and synthetic runtime-context messages are excluded.
- Turn indices come from DSH `turn/start` (`data.turn`, 1-based); old logs
  without turn events get one turn per human user message.
- Writes one row per `(turn, role)` into the transcript store; an existing row
  with the same text is a duplicate, different text is a **conflict** (never
  rewritten), and an out-of-order append is refused.
- Segments the *whole* session (not just new rows), so a partially backfilled
  session still gets summaries for its older segments.
- `--apply` summarizes every segment and enqueues one `kind:"summary"` task per
  segment. `--dry-run` (default) reads the store, writes nothing, and makes no
  model call.
- `--limit N` caps **sessions** processed from the sorted file list; because
  rows/tasks dedupe, re-running with a larger limit resumes instead of
  duplicating. `--session <id>` filters to one session.
- Report counts: sessions/skipped, messages, turns, segments, rows
  (new/duplicate/conflicts), summaries (enqueued/duplicate), failures, and for
  dry-run: estimated input/output tokens, requests and wall-clock time.

Exit code is `1` if a session's summarization failed (rows already written stay
written and the next run retries the summaries); `0` otherwise.

## Cost model

Measured on the varad Studio endpoint (one map request, 300-token cap):
**6.25 s**, 204-character output, model `unsloth/Qwen3.8-27B-GGUF`, prompt `v1`
(`test/live/summarizer-live.test.ts`). The dry-run estimator is deliberately
conservative at **15 s per request** and counts
`2 × ceil(chars / maxInputChars) - 1` requests per segment (map + reduce).

Rules of thumb (planning only, re-measure in the deployment):

| Quantity | Estimate |
| - | - |
| input tokens per segment | `ceil(segment chars / 4)` |
| output cap per segment | `maxOutputTokens` (700 default) |
| one short segment | 1 request, ~6-15 s |
| 682 sessions × ~6 segments | ~4 100 requests, ~17 h single-worker, ~8.5 h at concurrency 2 |
| output tokens worst case | ~2.9 M at 700/segment |

Because the queue keeps pending work, a backfill that outruns a night's window
is simply resumed. `--limit` makes a smaller first pass easy; the estimator in
`--dry-run` is what should be quoted before a real run.

## Failure modes

| Failure | Behaviour |
| - | - |
| endpoint unreachable / 401 | `--apply` exits non-zero; `MemoryError` (`UNAVAILABLE`/`TIMEOUT`) is retryable; rows written before the failure stay in the store, a re-run retries the summaries |
| prompt/model env missing | `--apply` refuses before writing rows (`CONFIG`, reason shown) |
| public endpoint | `CONFIG` before any request (`assertPrivateEndpoint`) |
| empty model response | `BACKEND` error for that segment; other segments still processed; exit 1 |
| secret in model output | redacted inline; the task is still enqueued (marked, never leaked) |
| transcript edited after a summary | `pointerMatches` fails; the artifact is labelled stale instead of pairing wrong text |
| existing row with different text | counted as a conflict; history is never rewritten |
| store gap before stored rows | counted as a conflict; the pass does not renumber history |
| context overflow | impossible by construction: requests are bounded by `maxInputChars`, with map-reduce beyond it |

## Re-summarizing after a prompt bump

1. Edit `SUMMARY_PROMPT` and/or `SUMMARY_MERGE_PROMPT`, then bump
   `SUMMARY_PROMPT_VERSION` (e.g. `"1"` -> `"2"`). Never edit the text without
   bumping: the version is what tells old and new summaries apart.
2. Update the prompt-contract tests if the text assertions changed.
3. Run the live test (`UNSLOTH_LARGE_API_KEY=… npm run test:live`) to confirm the
   endpoint still accepts the prompt.
4. `memory backfill-transcripts --from-sessions $DSH_HOME/sessions --apply`.
   Transcript rows dedupe (0 new), segments are rebuilt deterministically, and
   every summary is new work because the dedupe seed contains the new version.
5. Old summary documents keep `prompt_version: "1"` and remain resolvable. Keep
   or prune them as an explicit retention decision; retrieval can prefer the
   highest `prompt_version` for a pointer's `content_hash`.

## Verification

```
npx vitest run test/summarizer.test.ts test/backfill.test.ts \
  test/transcript-full.test.ts test/transcript-cli.test.ts \
  test/pointer.test.ts test/queue.test.ts
UNSLOTH_LARGE_API_KEY=$(…) npx vitest run --config vitest.live.config.ts test/live/summarizer-live.test.ts
```

Fixture results (`test/backfill.test.ts`, two synthetic sessions, 6 rows):

| Run | rows new | rows duplicate | segments | summaries enqueued | notes |
| - | - | - | - | - | - |
| dry run | 6 | 0 | 6 | 0 | store dir untouched, queue empty |
| apply | 6 | 0 | 6 | 6 | all tasks `kind:"summary"`, pointers resolve |
| apply again | 0 | 6 | 6 | 0 (6 duplicates) | idempotent |

Live result (2026-11-25, local Mac -> `10.20.10.40:8888`): **pass**, 1 request,
6.25 s, 204-char summary, pointer round-trip verified, no secret in output.

## Not in this slice

- Live per-turn summarization in the plugin hook path (the backfill is the only
  producer; a closed segment is not summarized mid-session yet).
- Summaries written directly to Cognee during the backfill: they are enqueued
  and the nightly drain ingests them.
- Automatic prompt-version preference at retrieval (the header carries the
  version; the query side does not yet rank by it).
- Scheduling the backfill: the 02:00 deployment run owns it (no systemd unit is
  added here); the 04:00 drain remains `dsh-cognify-queue.timer`.
