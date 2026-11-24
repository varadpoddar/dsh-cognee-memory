# Ingest cost: is `cognify` mandatory before anything is searchable?

**Answer: yes.** Episodic archival cannot be an embeddings-only cost. Measured
on 2026-11-24 against the live instance (`Cognee 1.6.10-local`,
`http://10.20.10.15:8000`, dataset isolated and deleted afterwards).

## Procedure

`scripts/experiments/cognee-nocognify-probe.py`:

1. create a fresh dataset, `POST /api/v1/add` one short document (multipart
   `raw_data` + `datasetId`),
2. immediately query `POST /api/v1/search` with `CHUNKS`, `CHUNKS_LEXICAL` and
   `GRAPH_COMPLETION`,
3. run `POST /api/v1/cognify` (`datasetIds`, `runInBackground: false`) and repeat
   the same three searches,
4. `POST /api/v1/forget` the data id, re-search, then `DELETE` the dataset.

## Result

| step | outcome | latency |
| --- | --- | --- |
| `POST /add` (ingest only) | `200`, data record created | **872 ms** |
| status after add | `state: staged`, `searchable: false`, `search_level: none` | — |
| search `CHUNKS` before cognify | **404** `data is added but not processed: nothing is searchable yet` | 196 ms |
| search `CHUNKS_LEXICAL` before cognify | **404**, same message | 61 ms |
| search `GRAPH_COMPLETION` before cognify | **404**, same message | 142 ms |
| `POST /cognify` (same dataset) | `200`, `PipelineRunCompleted` (blocking) | **12 512 ms** |
| status after cognify | `state: ready`, `searchable: true`, `search_level: graph` | — |
| search `CHUNKS` after | `200`, 1 hit containing the source text verbatim | 153 ms |
| search `CHUNKS_LEXICAL` after | `200`, 1 hit | 58 ms |
| search `GRAPH_COMPLETION` after | `200`, 1 synthesised hit | 3 991 ms |
| `POST /forget` (prune one data id) | `200`, `deleted_nodes: 11`, `deleted_edges: 13` | 237 ms |
| search after forget | no hits (`CHUNKS` empty, lexical/graph 404) | 44–146 ms |

## What this means

- **Even lexical, chunk-level retrieval is gated.** The 404 is a dataset-level
  searchability gate, not a per-retriever check: nothing in the dataset is
  searchable until `cognify` runs, so "store the text and search it with BM25"
  is not available as a cheap path.
- **Cost ratio is roughly 14×** for this document: 0.87 s to ingest vs 12.5 s to
  make it searchable. The delta is the LLM graph step (the instance cognifies
  through `http://10.20.10.40:8888/v1`), so archival cost scales with tokens
  through the model, not with embedding throughput.
- **`prune`/`forget` works and is cheap** (237 ms, real node/edge deletion), which
  is what makes a redaction mistake recoverable and makes a bounded archive
  practical.
- `GRAPH_COMPLETION` costs ~4 s per query even after the graph exists — that is
  a *query* cost, and it is why the plugin caps recall latency and reserves
  query capacity rather than using graph completion for every turn.

## Consequences for the pipeline

Because search requires the graph step, the queue's unit of work is
`remember` (add + cognify + poll until searchable), not `add`. `add` alone would
produce a dataset that silently answers 404 to every query — the failure mode
this experiment exists to rule out. Batched cognify per drain window is the
lever for cost, not skipping cognify.
