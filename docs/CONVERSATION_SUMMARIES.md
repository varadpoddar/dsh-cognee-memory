# Conversation summaries — does Cognee already do this?

**Question.** Does Cognee already provide "ingest whole conversation → segment by turns →
summarize per segment → link summary to its location", so that we do not build it?

**Answer.** **No — not the whole chain, and not turn-aware.** Cognee natively does
*per-chunk summarization at ingest, storage, embedding, and retrieval by summary*, with a
backlink from summary to chunk. It does **not** segment by conversation turns, does **not**
carry a location pointer (`turn_start`/`turn_end`/`segment_index`/`content_hash`) on a
summary, and does **not** expose a per-run summarization prompt or model over the API.
Roughly **40% of the chain exists**; the turn-aware segmentation, the pointer, and the
lossless transcript backlook are ours to build.

Verified against two sources on 2026-11-24:

| Source | What it is |
| - | - |
| **Upstream docs** | `docs.cognee.ai` (Mintlify; page markdown fetched via `<page>.md`) |
| **Installed** | CT 106, `docker exec cognee`, `cognee.__version__ == "1.6.10-local"`, Postgres + pgvector + embedded Ladybug, local Qwen `openai/unsloth/Qwen3.8-27B-GGUF` |

Upstream docs describe the `dev` branch, which is **ahead of** 1.6.10-local. Where they
disagree, the installed behaviour wins and is marked as such.

---

## Part 1 — What upstream Cognee documents

### 1. Chunk summarization inside `cognify` — **EXISTS**

The standard pipeline writes **one `TextSummary` per chunk**. Since the default changed to
`summary_method="from_extraction"`, that summary is assembled from the chunk's own extracted
types and relations and **makes no LLM call**; `summary_method="llm"` restores one LLM call
per chunk. A chunk whose extraction produced no relations gets **no summary at all**.

Storage: `TextSummary` DataPoints, written to the vector store (embedded on `text`) and the
graph — *not* a relational `summaries` table. Linkage: the summary's id is
`uuid5(chunk.id, "TextSummary")` so it "still pairs with its chunk", and the object holds
`made_from` → `DocumentChunk` plus `source_chunk_id`.

> "The standard pipeline writes one `TextSummary` per chunk. By default
> (`summary_method="from_extraction"`) that summary is built from the graph the chunk's
> extraction already produced — **no LLM call is made for summaries**."

> "The summary keeps the same id it has on the LLM path (`uuid5(chunk.id, "TextSummary")`),
> so it still pairs with its chunk, and it is embedded like any other summary."

Citations: *Cognify (Python API)* — §"Chunk summaries from extraction"
<https://docs.cognee.ai/python-api/cognify#chunk-summaries-from-extraction> · *Cognify
(legacy operation)* <https://docs.cognee.ai/core-concepts/main-operations/legacy-operations/cognify>

### 2. `SearchType.SUMMARIES` — **EXISTS, but provenance-poor**

Deterministic, non-generative vector search over the summaries stored at cognify time; it
"always returns summary records rather than a conversational acknowledgement", makes no LLM
call, opts out of session-turn preparation, and takes no `retriever_specific_config` keys.
The docs **never** promise `chunk_id`, `document_id` or `content_hash` on a returned summary
record — the returned field set is not documented at all. Provenance is therefore
**documented as absent, present in practice as `source_chunk_id` only** (see §10).

Related types confirmed upstream: `SUMMARIES`, `CHUNKS`, `CHUNKS_LEXICAL`, `RAG_COMPLETION`,
`HYBRID_COMPLETION`, `GRAPH_COMPLETION`, `GRAPH_SUMMARY_COMPLETION`, `GRAPH_COMPLETION_COT`,
`GRAPH_COMPLETION_CONTEXT_EXTENSION`, `TEMPORAL`, `CYPHER`, `NATURAL_LANGUAGE`,
`FEELING_LUCKY`, plus decomposition/coding/skills variants.

Citation: *Search Types* <https://docs.cognee.ai/python-api/search-type>

### 3. Session memory APIs — **PARTIAL** (a Q&A cache, not a conversation model)

`session_id` creates or continues a **conversation thread**: Cognee keeps the previous
questions and answers and re-injects them into the completion prompt, so follow-ups resolve
pronouns. That is short-term memory **at recall time**, keyed by `session_id`, expiring with
the cache — not an ingested, segmentable conversation document. `improve()` bridges a session
into the permanent graph (distillation of accepted guidance; the `dev` docs also mention
"one summary document per session under `session_summaries`").

There **is** a documented data model, but it is the *session*, not the *turn*: `remember(...,
session_id=…)` accepts typed entries (`method_params` / `method_return_value`, `node_set`),
and `cognify(session_ids=[...])` is a memify-side persistence path. There is no documented
`Conversation`/`Turn` entity with `turn_index` and role ordering.

Citations: *Persistent Memory Across Sessions*
<https://docs.cognee.ai/guides/persistent-memory-across-sessions> · *Sessions and Caching*
<https://docs.cognee.ai/core-concepts/sessions-and-caching> · *Session Distillation*
<https://docs.cognee.ai/guides/session-distillation>

### 4. Native conversation ingestion — **PARTIAL** (a cookbook recipe, not a loader)

No chat/transcript loader. The *Import Agent Sessions* cookbook reads harness session files,
writes **one Markdown file per session** (folder, branch, start time, title, then its turns),
and remembers those files with a `node_set` per agent — turn boundaries survive only as
Markdown prose, and chunking is token-based, so turns are split mid-message. `add()` takes no
`metadata` argument upstream; scoping is `node_set`, and `SearchType` honours node-set scope
via `node_type=NodeSet` / `node_name`.

Citations: *Import Agent Sessions* <https://docs.cognee.ai/cookbooks/import-agent-sessions> ·
*Session Node Sets* <https://docs.cognee.ai/guides/session-node-sets> · *Agent Session Traces*
<https://docs.cognee.ai/guides/agent-session-traces>

### 5. Custom summarization prompts / model — **PARTIAL** (model yes, prompt no)

The summarization prompt is a **fixed file**, `summarize_content.txt`, and unlike graph
extraction it "has no environment variable". Two escape hatches: change the *output shape*
with `cognee.config.set_summarization_model(...)` (or `summarization_model=` on
`summarize_text`), or change the *prompt* only by replacing the pipeline — run
`extract_graph_from_data`, then your own task calling `LLMGateway.acreate_structured_output`,
then `add_data_points`. No per-`cognify`-run summarization-model knob is documented.

Citation: *Cognify (legacy operation)* — accordion "Summarization task and prompt"
<https://docs.cognee.ai/core-concepts/main-operations/legacy-operations/cognify>

### 6. Temporal awareness — **EXISTS** (as graph timestamps; the *flag* is gone)

Dates in ingested text become `Timestamp` nodes by default ("No ingestion flag is needed"),
attached to the entity they date and linked from the chunk via `contains`;
`SearchType.TEMPORAL` answers before/after/between questions. There is **no
`temporal_awareness` flag** — the docs reference only an example *script* of that name, and
the old `temporal_cognify=True` switch is deprecated: since 1.6.3 it "has no effect".

Citations: *Temporal Knowledge Graph*
<https://docs.cognee.ai/guides/temporal-knowledge-graph> · installed `cognify.py`
(`TEMPORAL_COGNIFY_DEPRECATED`)

### 7. Summarization at ingest vs query time — **EXISTS, both, and they are distinct**

- **Ingest time:** the per-chunk `TextSummary` of §1.
- **Query time:** `GRAPH_SUMMARY_COMPLETION` "summarizes the retrieved graph context before
  completion; reads **no stored summaries**"; `GRAPH_COMPLETION_CONTEXT_EXTENSION` iterates
  retrieve → generate → re-query for up to `context_extension_rounds=4`. Both are extra LLM
  calls per query.
- `RAG_COMPLETION` does **not** summarize: "retrieve chunks by semantic similarity, then LLM
  answer".

Citation: *Search Types* <https://docs.cognee.ai/python-api/search-type>

---

## Part 2 — What the installed 1.6.10-local actually has

### 8. Live `/openapi.json` — 136 paths, **no summary endpoint**

`SearchType` enum (22 values) includes `SUMMARIES`, `CHUNKS`, `CHUNKS_LEXICAL`,
`RAG_COMPLETION`, `HYBRID_COMPLETION`, `GRAPH_COMPLETION`, `GRAPH_SUMMARY_COMPLETION`,
`GRAPH_COMPLETION_CONTEXT_EXTENSION`, `TEMPORAL`, `FEELING_LUCKY`. `SearchResultKind` includes
`summary`. Summary-flavoured endpoints that exist are **not** chunk summaries:
`GET /api/v1/datasets/graph-summary` (node/edge counts) and
`GET /api/v1/visualize/brains-summary`. Sessions are first class: `GET /api/v1/sessions`,
`/sessions/{id}`, `/sessions/stats`, `/sessions/cost-by-model`. Also present: `/remember`,
`/cognify`, `/search`, `/search/history`.

**`CognifyPayloadDTO` has no summarization field.** Its knobs are `datasets`, `datasetIds`,
`runInBackground`, `graphModel`, `customPrompt`, `chunkSize`, `ontologyKey`,
`chunksPerBatch`, `dataPerBatch` — and `customPrompt` "replaces the default **entity-extraction**
prompt", not the summarization prompt. So §5's HTTP gap is confirmed at runtime: **there is no
API-accepted custom summarization prompt.**

### 9. Summaries are not in Postgres

34 tables, none named `summaries`/`text_summaries` (`relation "summaries" does not exist`);
the `nodes` table holds **0 rows** because the graph is the embedded **Ladybug** store. Summary
vectors and the summary graph nodes live there, not in a relational table, so "inspect the
summaries table" has no Postgres answer.

Provenance measured on returned payloads (both datasets):

| Field | On summary record | On chunk record |
| - | - | - |
| `source_chunk_id` | **set** (`c4a41c46-…`) — backlink to chunk | `null` |
| `document_id` | **`null`** | set (`1e496902-…`) |
| `document_name` | `null` | set (`text_14f1e3fc…`) |
| `chunk_index` | `null` | `0` |
| `source_content_hash` | **`null`** | **`null`** |

So summary → document is a **two-hop** resolution (summary → `source_chunk_id` → chunk →
`document_id`), and **no content hash is carried on either node**. `session_records` in
Postgres holds session *accounting* only (`session_id`, `user_id`, status, timestamps, tokens,
cost) — no turn text.

### 10. Isolated experiment (4 messages / 575 chars, 2 user + 2 assistant turns)

Ingested one conversation-shaped text into throwaway datasets, cognified, then searched.
**Result: 4 messages became ONE chunk (`chunk_index: 0`) and ONE summary** — no turn
awareness whatsoever.

- **(a) `SUMMARIES`** returns the summary record with `source_chunk_id` set, `document_id`,
  `chunk_index`, `source_content_hash` all `null`.
- **(b) `CHUNKS`** returns the whole transcript as one text blob with `document_id`,
  `document_name`, `chunk_index: 0`.
- **(c) Backlinks:** the summary *does* carry a chunk backlink (`source_chunk_id`, plus a
  `made_from` edge in code). It carries **no** document link and **no** location range.
- **(d) Custom summarization prompt via API: rejected** — no field exists (§8).

Default `from_extraction` summary text was not prose at all:

```
software: billing service, postgres 17
extension: pgvector
event: q1 migration of the billing service to postgres 17
The billing service is planned to migrate to Postgres 17 in Q1.
…
```

With `summary_method="llm"` the *same* chunk produced a real prose summary
("This chunk is about: - People: User, Assistant - Systems: Billing service, Postgres 17,
pgvector … Facts: …"), still with `source_chunk_id` set and `document_id` null. Both datasets
were deleted afterwards (`t2_probe_conv_*`); production datasets were never touched.

### 11. Configurability in this build — `SUMMARY_METHOD` only

| Mechanism | Status in 1.6.10-local |
| - | - |
| `summary_method="llm"` on `cognify()` | **works** (verified end-to-end, §10) |
| `SUMMARY_METHOD=llm` env | **works** — `get_cognify_config().summary_method == "llm"` in a fresh process |
| `config.set_summarization_model(...)` | exists (global, process-wide) |
| `SUMMARIZATION_MODEL`, `COGNEE_SUMMARIZE_*` | **absent** (grep over `/app/cognee`: no hits) |
| `chunk_summaries` as a payload/env knob | **absent** as a knob; internally it is only the hybrid-retriever merge key |
| summarization field in the HTTP cognify body | **absent** — env-only for API callers |
| Caveat | config is cached per process: set `SUMMARY_METHOD` **before** the first `cognify()` |

---

## Part 3 — Gap analysis and design

### 14. What Cognee already does (build only the remainder)

| Capability | Cognee | Us |
| - | - | - |
| Per-chunk summary at ingest | ✅ (LLM or extraction-derived) | — |
| Summary storage + embedding + semantic retrieval by summary | ✅ | — |
| Summary → chunk backlink | ✅ `source_chunk_id` | — |
| Chunk → document link | ✅ `document_id` | — |
| Turn-aware segmentation | ❌ token-based chunker only | **build** |
| Location pointer (`turn_start/turn_end/segment_index/content_hash`) | ❌ | **build** |
| `content_hash` for dedupe | ❌ (`null` everywhere) | **build** |
| Lossless whole-transcript document + range resolution | ❌ (`document_id` null on summaries) | **build** |
| Per-run summarization prompt / model over HTTP | ❌ | **build** (or use env + custom pipeline) |
| Session/Q&A history plumbing | ✅ `session_id`, node sets | reuse |
| Temporal timestamps | ✅ `Timestamp` nodes, `TEMPORAL` | reuse |

**We build ~60%: segmentation, pointer, backlook, panel resolution. We reuse ~40%.**

### 12. Design

**Ingest (lossless, no caps).** The whole transcript is stored once as a `TextDocument` in
its own dataset with `node_set=["conv:", "conv:<session_id>"]`. The existing journal already
guarantees this property: "Long messages are split at `chunkChars`; **nothing is truncated or
dropped**" (`src/memory/turn-journal.ts`), with identity seeded `session:turn:seq:role:part`.
No char cap is introduced anywhere; the raw text stays authoritative on disk as well.

**Segment deterministically at turn boundaries.** Group the journal's turns into segments of
`S` turns (default: 1 segment = 1 turn pair, or a token-budget-bounded run of whole turns).
Segmentation is a pure function of `(session_id, turn indices, segment_size)` — never of LLM
output — so it is reproducible offline and re-derivable after any failure.

**Summarize per segment with the local LLM.** One call per segment to
`openai/unsloth/Qwen3.8-27B-GGUF` at `http://10.20.10.40:8888/v1`, with our own prompt
(Cognee's `summarize_content.txt` is fixed and not API-configurable). Store the summary text
plus the pointer.

**Pointer schema (stable, hash-addressed).**

```json
{
  "schema": "dsh.convsum.v1",
  "session_id": "3f2c…",
  "turn_start": 12,
  "turn_end": 13,
  "segment_index": 6,
  "role_span": ["user", "assistant"],
  "content_hash": "sha256:9b1e…",
  "source_chunk_ids": ["c4a41c46-…"],
  "transcript": { "dataset": "conversations", "document_id": "1e496902-…",
                  "char_start": 8123, "char_end": 11044 },
  "model": "openai/unsloth/Qwen3.8-27B-GGUF",
  "prompt_version": "convsum-p1",
  "created_at": "2026-11-24T18:20:00Z"
}
```

`content_hash` is over the exact segment text (concatenated turns, `\n\n`-joined, with role
markers), which is what makes dedupe and re-summarization decisions cheap and deterministic.

**Ingest the summaries into Cognee.** Each segment summary is written as its own short
document in a `conversation_summaries` dataset with
`node_set=["convsum", "convsum:<session_id>"]`, the pointer serialised into a leading header
block of the document text, and `summary_method="from_extraction"` (we already wrote the
prose; no need to pay a second LLM call per chunk). Retrieval then uses `SUMMARIES` /
`CHUNKS` scoped by `node_name` + `node_type=NodeSet`. Whether `external_metadata` can carry the
pointer structurally (as opposed to in-text) is **UNVERIFIED** in this build — no `add()`
`metadata` argument exists.

**Retrieval + panel.** `SUMMARIES` returns summary hits; the panel parses the pointer,
resolves `(session_id, turn_start..turn_end)` against the local transcript store (or the
transcript document range), and renders the **exact** transcript slice beside the summary —
summary as the navigational index, transcript as the evidence. Degrade gracefully: if the
pointer's `content_hash` no longer matches the stored range, show the summary flagged stale
rather than silently pairing it with edited text.

### 13. Effort, queue interaction, risks

**Effort (single developer, including tests): ≈ 9–10 dev-days.**

| Work item | Days |
| - | - |
| Pointer schema + deterministic segmenter (pure functions, property tests) | 1.5 |
| Segment summarizer (local-LLM client reuse, prompt, `prompt_version`) | 1.0 |
| Ingest path: summary documents, node sets, pointer header | 1.5 |
| Retrieval + panel pointer→range resolution, stale-pointer handling | 2.0 |
| Journal/queue integration: summary tasks, dedupe, lease/backoff reuse | 1.5 |
| Tests (unit + one live isolated-dataset run) | 1.5 |
| Docs, rollout notes, env knobs | 0.5 |

**Interaction with the existing ingest queue/journal (plugin 1.0.5).** The journal already
emits one task per message part with identity `session:turn:seq:role:part` and keeps content
hashes as tombstones for 30 days (`tombstoneRetentionDays`). Add a **derived task kind**
(`kind: "summary"`) enqueued only after the segment's raw parts reach `done`, carrying
`{session_id, turn_start, turn_end, segment_index, content_hash}`. Reuse the existing
machinery unchanged: oldest-first claim, 15-minute inflight lease with interrupted-task
recovery, exponential backoff capped at 1 h, `permanent: true` for authz/validation refusals,
`pruneDone` + hash tombstone. Because a summary task's identity is its segment hash, a replayed
journal line or a re-run backfill is a dedupe, not a re-summarize.

**Risks.**

- **Summary drift.** Model or prompt changes silently invalidate old summaries. Mitigation:
  store `model` + `prompt_version` in the pointer; re-summarize by `prompt_version` bump;
  never treat a summary as evidence when its hash mismatches.
- **LLM cost per segment.** One call per segment on top of the extraction pass. Local Qwen
  makes this a latency/GPU cost rather than a dollar cost; batch segments and cap
  concurrency, and skip segments below a minimum token size.
- **Re-summarization on edit.** An edited turn changes only its own segment's hash if
  segmentation is boundary-stable by turn index; a changed turn *count* shifts every later
  `segment_index`, so key dedupe on `content_hash`, not `segment_index`.
- **Dedupe collisions.** Identical short segments ("ok", "continue") collapse if the hash is
  text-only — mirror the journal and seed with `session:turn_start:turn_end`.
- **Provenance gaps we inherit.** Summaries carry no `document_id` and no `content_hash`
  (§9), so the pointer must be authoritative and the summary→document hop goes through
  `source_chunk_id`.
- **Embedded Ladybug is single-writer.** Out-of-process graph reads fail
  (`Could not set lock on file … Lock is held by PID 92`); all inspection and cleanup must go
  through the API or the owning process. Plan the drain accordingly — no second process
  opening the graph.
- **`SUMMARY_METHOD` is process-cached.** Set it before the first `cognify()` in any worker.

### Explicit non-goals

No change to production datasets; no reliance on `search_summaries` returning provenance it
does not have; no second summarization pass inside Cognee for text we already summarized.
