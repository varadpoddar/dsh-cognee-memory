# Cognee historical-memory recovery

Scope: can the DSH–Cognee deployment (`1.6.10-local`, CT 106 stack `/opt/stacks/cognee`)
give back what was stored before the plugin kept its own ledger? This document records the
upstream reference material and what was verified against the live instance on
2026-11-22/23 (Workstream A, read-only against production).

Local evidence and per-dataset classification: [`RECOVERY_MANIFEST.md`](./RECOVERY_MANIFEST.md).

## upstream references

1. **Releases / version changes** — <https://github.com/topoteretes/cognee/releases>.
   Latest published tags are `v1.6.10` (2026-11-18), `v1.6.9` (2026-11-18), `v1.6.8`
   (2026-11-12), `v1.6.7`, `v1.6.6` (2026-10-29). Our build string `1.6.10-local` is a local
   image of the `v1.6.10` line (same major/minor, image `cognee/cognee:latest`).
   Release notes are also rendered in the docs changelog at
   <https://docs.cognee.ai/changelog> (`llms-full.txt` was the machine-readable copy used here).

2. **Dataset graph operations** — <https://docs.cognee.ai/api-reference/datasets/get-dataset-graph>
   (`GET /api/v1/datasets/{dataset_id}/graph`). Returns a JSON object `{nodes[], edges[]}`;
   each node is `{id, label, type, properties{}}`, each edge `{source, target, label}`.
   Node types seen locally: `TextDocument`, `DocumentChunk`, `Entity`, `EntityType`,
   `NodeSet`, `GlobalContextSummary`, `TextSummary`. Chunk-level `text` is present in
   `DocumentChunk.properties.text`; document-level original text is **not** in the graph.

3. **Dataset markdown graph export** — <https://docs.cognee.ai/api-reference/activity/export-dataset-markdown>
   (`GET /api/v1/activity/export/{dataset_id}`). Despite the `activity` prefix it returns a
   **markdown relationship table** for the dataset's graph (`| Source | Relationship | Target |`),
   i.e. the graph as markdown, not activity spans. Present in our build.
   A GraphML/file export also exists Python-side (see §5 of the manifest).

4. **Import / remember API** — <https://docs.cognee.ai/core-concepts/main-operations/remember>
   and <https://docs.cognee.ai/api-reference/add>. `POST /api/v1/add` (multipart `data`,
   plus `raw_data` for strings) then `POST /api/v1/cognify` (`{datasets:[name|uuid]}`) is the
   v1 path; `POST /api/v1/remember` wraps add+cognify and additionally accepts
   `content_type="cogx-archive"` uploads. Note the local gotcha: `cognify` takes a dataset
   **name** for a name-addressed dataset — passing the UUID string made our build create a
   *new* dataset named after the UUID.

5. **COGX format design** — <https://docs.cognee.ai/core-concepts/further-concepts/cogx>.
   COGX ("Cognee eXchange format") is the shared import/export record model behind
   `cognee.remember()` and `cognee.export()`. Record kinds: Document, Episode, Entity, Fact,
   Memory, Memory block, Raw node (verbatim graph node kept so nothing is lost); typed records
   carry scope (`user_id`, `agent_id`, `session_id`, `run_id`) and timestamps, plus an OMP
   header since COGX 0.2. On export it is an **archive directory** containing
   `manifest.json`, `documents.jsonl`, `entities.jsonl`, `facts.jsonl`, `nodes.jsonl`
   (observed locally, 5 files for a one-chunk dataset).

6. **Known COGX import backend-compatibility issue** — no upstream issue was found that is
   *specifically* titled COGX-import-vs-backend (searched GitHub issues for `cogx import`,
   `cogx ladybug/kuzu`, `cogx graph-only`). The confirmed adjacent issues are:
   <https://github.com/topoteretes/cognee/issues/5042> — "ladybug: `get_graph_data()`
   fabricates SELF edges for edgeless graphs, other backends return none" (graph read differs
   per backend; ladybug is our backend); <https://github.com/topoteretes/cognee/issues/6646>
   and <https://github.com/topoteretes/cognee/issues/6653> — GraphML export writes invalid XML
   when a property contains a control character. The documented import limitation is instead
   *graph-only restore*: importing with `index_vectors=False` persists the graph without a
   vector engine, after which only vector-independent search (`CHUNKS_LEXICAL`, graph
   traversal) reaches the data. Observed locally: a COGX import completed
   (`RememberResult(status='completed')`) while the embedding client logged
   `ValueError: Unrecognized model in Qwen/Qwen3-Embedding-8B-GGUF` — so verify the vector
   index separately after any import rather than trusting the import status.

### exists in 1.6.10-local vs upstream main

| Item | 1.6.10-local (verified live) | Upstream (v1.6.10 = current main line) |
|---|---|---|
| `GET /datasets/{id}/graph` | present, `{nodes,edges}` with chunk `text` | present |
| `GET /activity/export/{id}` (markdown graph) | present, returns relationship table | present |
| `POST /add`, `/cognify`, `/remember`, `/recall` | present | present |
| `cognee.export(dataset, format=...)` | present; `pydantic`, `cogx`, `json`, `graphml`, `cypher` all accepted | present |
| COGX archive export (directory + `manifest.json`/`*.jsonl`) | present, `ExportResult` returned | present |
| COGX archive import (`COGXArchiveSource`) | present, `import_memory_source()` + `RememberResult` | present |
| `GET /datasets/{id}/data/{data_id}/raw` (original text) | present (not probed for payload, source files verified on disk) | present |
| HTTP export endpoint for a whole dataset (COGX download) | **absent** — export is Python/CLI-side only | absent |
| GraphML export | present Python-side; known invalid-XML bug open upstream | same |
