# Memory Linking: Provenance, References and Graph Traversal in the Installed Cognee

**Status:** research report (no production changes)
**Date:** 2026-11-24
**Target under test:** Cognee **1.6.10-local** (Python 3.12.14), Postgres + pgvector + embedded Ladybug graph
**Method:** verified against the running instance, not against documentation. Every claim below is
tagged **VERIFIED** (observed on the live system), **PARTIAL** (partly observed) or **NOT-VERIFIABLE**
(could not be exercised, with the reason stated).

## 0. What was verified, and how

The `-local` suffix is not decorative: the installed build tracks upstream **v1.6.10** (released
2026-11-18). Every version-specific claim was cross-checked against the tag `v1.6.10` upstream, so
"present in 1.6.10-local" and "present upstream at v1.6.10" are usually the same statement.

Read-only discipline: all relational access was `SELECT`/schema introspection; two throwaway
datasets were created to exercise write paths and both were deleted (see §10).

| Surface | How it was read |
| --- | --- |
| Python SDK | `docker exec cognee python …` inside the cognee container |
| HTTP API | `GET /openapi.json` (note: **not** under `/api/v1`), `/api/v1/datasets/{id}/graph`, `/api/v1/recall` |
| Relational | `psql` against `cognee-db`, `SELECT` only |
| Source | installed package at `/app/cognee` (also `.venv/lib/python3.12/site-packages/cognee`) |

One structural fact governs the whole report: **the graph is a single, exclusively-locked Ladybug
file** at `/cognee-storage/system/databases/cognee_graph_ladybug`, not a per-dataset store. The
relational `nodes` and `edges` tables are **empty** (0 rows) — they are not the graph store here.

## 1. Answers in one line each

1. **Provenance chain — VERIFIED.** A retrieved chunk does trace to its document: `DocumentChunk`
   →`is_part_of`→ `TextDocument`, and the chunk metadata carries `data_id`/`chunk_id`/`chunk_index`/
   `document_name`. But the graph node type is **`TextDocument`**, and `raw_data_location`,
   `content_hash`, `chunk_index` live **relationally**, not on the graph node.
2. **`include_references` — VERIFIED (API supports it; structured payload is thin).** SDK takes
   `include_references=False` (default), HTTP takes `includeReferences`. It populates
   `metadata["evidence"]` **only on completion retrievers**; `GRAPH_COMPLETION` returns entries with
   `kind="graph_node"` and chunk ids, but `data_id`/`chunk_id`/`document_name` are `None` there — the
   readable identifiers appear only in the rendered `Evidence:` text block.
3. **`PROVENANCE_TRACKING` — VERIFIED.** Exists, **default off**, and records an append-only
   hash-chained audit ledger in `provenance_entries`. It is **off in this deployment** (0 rows) and is
   one of *five* separate provenance systems — do not confuse it with the edge-evidence sidecar,
   which is **on** and holds 968 rows.
4. **`get_graph_engine()` chunk→Document — NOT-VERIFIABLE directly.** The method set exists
   (`get_document_subgraph`, `get_neighbors`, `get_neighborhood`, …) but a second process cannot open
   the Ladybug file while the API server holds it (`Could not set lock … Lock is held by PID 92`, 5
   attempts). The equivalent traversal **works over HTTP** and is demonstrated in §4.
5. **Entity canonicalization — VERIFIED.** Entities get deterministic ids from `name`
   (`identity_fields=["name"]` → `Entity:<name>`); four mentions of "Ada Lovelace" across two
   documents collapsed into a single `ada lovelace` node.
6. **Ontology — VERIFIED.** Supported. Default mode `annotate` = **enrichment**; `strict` = validation
   (drops ungrounded entities). With no resolver configured, nodes record `ontology_valid=False`.
7. **`improve` / session→permanent — PARTIAL.** Signature and all 9 stages verified from source; every
   stage is session-scoped, which is *why* duplicate collapse needs session ids. Not executed live.
8. **Hybrid retrieval — VERIFIED.** Two lanes (vector chunks + entity/fact graph). Depth **is**
   configurable (`neighborhood_depth`, `neighborhood_seed_top_k`), plus `chunks_top_k`,
   `entities_top_k`, `max_edges_per_entity` via `retriever_specific_config` — but `neighborhood_depth`
   is **absent from the HTTP `RecallPayloadDTO`**, so HTTP callers must use `retrieverSpecificConfig`.

## 2. Provenance chain: result → document

### 2.1 Graph endpoint (live)

`GET /api/v1/datasets/{dataset_id}/graph` (auth required) returns `GraphDTO`:
`nodes[{id,label,type,properties}]`, `edges[{source,target,label}]`. For the isolated test dataset:
**21 nodes, 31 edges**.

Node types observed (exact `type` values):

```
DocumentChunk  DocumentChunk_e068e0a9-…      TextDocument   text_a1582049d70d7ba8173b289d2136d028
DocumentChunk  DocumentChunk_23150ca4-…      TextDocument   text_93a9d0fc29ca4a496581b52dc868edf2
TextSummary    TextSummary_fa725a90-…         Entity         ada lovelace
EntityType     person / project / system      Timestamp      2026-11-20
```

Edge labels: `contains` (11), `is_a` (8), `is_part_of` (2), `made_from` (2), `stores` (2),
`reviewed`, `reviewed_at`, `confirmed_landed`, `part_of`, `met`, `met_at`.

The structural edges are exactly one per chunk:

```json
{"source": "e068e0a9-c3fb-5a45-bbfb-029ec9181a5c",
 "target": "f8165d94-f727-4ace-aeca-27dc08e1bade", "label": "is_part_of"}
```

Note there is both a structural `is_part_of` (chunk→document, one per chunk) and a semantic
`part_of` from LLM extraction — do not treat the latter as provenance.

A `DocumentChunk` node's real properties:

```json
{"type": "DocumentChunk", "version": 1, "topological_rank": 2,
 "source_pipeline": "cognify_pipeline", "source_task": "extract_chunks_from_documents",
 "source_user": "default_user@example.com",
 "source_content_hash": "a1582049d70d7ba8173b289d2136d028",
 "ontology_valid": false, "ontology_uri": null,
 "metadata": {"index_fields": ["text"]}, "text": "Project Atlas notes. …"}
```

**What is *not* on the node:** no `raw_data_location`, no `document_id`, no `chunk_index`. The node
carries `source_*` attribution and the content hash only.

### 2.2 Relational side

`data` (one row per document) has the locators the graph omits:

| column | example |
| --- | --- |
| `id` | `0e28cb50-aa15-4d74-b020-ae525fc718ec` — **the document node id** |
| `name` | `text_84b054f958ffc6c7419a0fe4a052a990` — the document node label |
| `content_hash` | `84b054f958ffc6c7419a0fe4a052a990…` (16-prefix shown) |
| `raw_data_location` | `file:///cognee-storage/data/<user>/…` |
| `dataset_id` | the owning dataset |

`provenance_edge_evidence` (the edge→chunk sidecar, 968 rows in production) closes the loop with
`chunk_id`, `chunk_index`, `edge_id`, `source_node_id`, `destination_node_id`, `data_id`,
`dataset_id`, `relationship_name`, `evidence_kind`, `source_task`, `created_at`. A real row:

```
chunk 05a11374-… (chunk_index 0) --is_part_of--> 0e28cb50-… (== data.id)
evidence_kind=structural  source_task=extract_chunks_from_documents  data_id=0e28cb50-…
```

### 2.3 The traceable chain

```
recall hit → metadata.data_id / chunk_id / chunk_index / document_name
           → data.id (raw_data_location, content_hash)   [document identity]
           → graph edge chunk --is_part_of--> document node
           → provenance_edge_evidence (edge id, chunk_index, pipeline_run_id)
```

**VERIFIED.** The join key is `chunk.source_content_hash` ≡ `data.content_hash`, and the document
node id ≡ `data.id`. Practical consequence: `chunk_index` and `raw_data_location` require a
relational lookup; they are not obtainable from the graph endpoint alone.

## 3. `include_references=True`

### 3.1 Existence

| Surface | Name | Default |
| --- | --- | --- |
| Python SDK `cognee.recall` / `cognee.search` | `include_references` | `False` |
| HTTP `POST /api/v1/recall` (`RecallPayloadDTO`) | `includeReferences` | `false` |

Both appear in the live `/openapi.json`. The SDK is snake_case, the HTTP body is camelCase — a
straight port of an SDK call to HTTP will silently drop the flag.

### 3.2 What it actually does

`SearchResultPayload.evidence` is filled from the retriever's `get_context_evidence(retrieved_objects,
dataset_id)` hook **when `include_references=True`**. The default implementation returns `[]`, and
only completion-style retrievers override it. `EvidenceReference` is deliberately identifier-only:

```python
EvidenceKind = Literal["segment", "graph_node", "graph_edge", "triplet"]
EvidenceRole = Literal["used_as_context", "supports_assertion"]
# kind, artifact_id, role, dataset_id, source_ref_key, data_id, chunk_id,
# chunk_index, document_name, source_node_id, target_node_id,
# relationship_name, assertion_id, label, rank, score
```

### 3.3 Observed payloads (isolated dataset, 2 documents)

`GRAPH_COMPLETION`, `include_references=True` — `metadata["evidence"]` is populated:

```json
{"kind": "graph_node", "artifact_id": "36114955-3707-5de2-ac0f-23037afa6227",
 "role": "used_as_context", "dataset_id": "a725704c-…",
 "data_id": null, "chunk_id": null, "chunk_index": null, "document_name": null,
 "source_ref_key": null, "target_node_id": null, "relationship_name": null,
 "assertion_id": null, "label": null, "rank": 0, "score": null}
```

The **rendered** answer is where the human-readable identifiers land:

```
Evidence:
- chunk 1 of document text_711ed914424729503eea844c0ad367d8
  (data_id: 72fc5eea-…, chunk_id: bacd8741-…): "Project Atlas notes. …"
```

`HYBRID_COMPLETION`, `include_references=True` — **`metadata` is `{}`** although the `text` also
carries the `Evidence:` block. This independently reproduces the still-open upstream issue
[#5160 “return structured context evidence from HYBRID_COMPLETION”](https://github.com/topoteretes/cognee/pull/5160).

`CHUNKS` (retrieval-only, no completion) — with and without the flag the result is **byte-identical**,
and `metadata` already contains the locators:

```json
{"data_id": "f8165d94-…", "chunk_id": "e068e0a9-…", "chunk_index": 0,
 "document_name": "text_a1582049d70d7ba8173b289d2136d028"}
```

**Verdict: VERIFIED, with a caveat that matters for UI work.** Chunk-level provenance does not
depend on `include_references` at all — it is always in `metadata`. `include_references` additionally
yields a structured `evidence` list on completion paths, but for `graph_node` entries the document
identifiers are `None`; only `artifact_id` (the chunk node id) and `rank` are usable. Upstream
[#6659 “name references by document title and link”](https://github.com/topoteretes/cognee/pull/6659)
(closed, merged 2026-11-11) is the change that made titles/links available, and
[#6238 “Expose data ids in recall”](https://github.com/topoteretes/cognee/pull/6238) is why `data_id`
and `chunk_id` now appear at all.

## 4. `get_graph_engine()` traversal, chunk → Document

The handle returned is `_GraphEngineHandle` exposing (abridged) `get_document_subgraph`,
`get_neighbors`, `get_successors`, `get_predecessors`, `get_neighborhood`,
`iter_bounded_neighborhood`, `get_id_filtered_graph_data`, `get_nodeset_subgraph`, `query`,
`supports_cypher_queries`.

**Direct call is NOT-VERIFIABLE in this deployment.** Five attempts, across the session, failed
identically:

```
RuntimeError: IO exception: Could not set lock on file :
/cognee-storage/system/databases/cognee_graph_ladybug
(Lock is held by PID 92) (Error: Resource temporarily unavailable)
```

PID 92 is the running API server, which holds the embedded graph exclusively. A sidecar process
cannot open it while the service is up. (One earlier read succeeded during a window in which the
ingest worker held the handle, which is why this is a *lock* problem and not a permissions problem.)

**Working path, exact calls** (HTTP, no lock contention):

```
POST /api/v1/auth/login                      → bearer token
GET  /api/v1/datasets/{dataset_id}/graph    → {nodes:[{id,label,type,properties}], edges:[{source,target,label}]}
filter edges  where label == "is_part_of" and source == chunk_id
              → target == document node id == data.id
GET  /api/v1/datasets/{dataset_id}/data     → document rows (name, content_hash, raw_data_location)
```

If a process-local traversal is genuinely required, the calls to use once the server releases the
file are `engine = await get_graph_engine()`, then `await engine.get_document_subgraph(chunk_id)` or
`await engine.get_neighbors(chunk_id)` — signatures were confirmed present but not executed.

## 5. Entity canonicalization

Mechanism (source, `/app/cognee/modules/engine/models/Entity.py`):

```python
class Entity(DataPoint):
    name: str
    is_a: EntityType | tuple | None = None
    metadata: dict = {"index_fields": ["name"], "identity_fields": ["name"]}
```

`identity_fields=["name"]` makes the node id deterministic and namespaced by class — the same value
`Entity.id_for(name)` produces — which the docstring explicitly calls out as the fix for "the
random-uuid4 footgun". Duplicate mentions therefore collapse at write time because they hash to the
**same node id**, not because a dedupe pass merges them afterwards.

Observed: two documents, four textual mentions of "Ada Lovelace", one `Entity` node named
`ada lovelace`. Canonicalization includes name normalisation (case folding) — the stored name is
lowercase.

There is **no dedicated canonicalization API or view**. The canonical node and its mentions are
observable through the dataset graph: entity nodes typed `Entity`, their class via `is_a` →
`EntityType`, and mentions via the chunk-side edges (`contains`, `reviewed`, `met`, …). A "mentions"
listing must be derived by filtering edges whose target is the entity id.

## 6. Ontology support

`cognify(..., config=cognee.modules.ontology.ontology_config.Config)` accepts
`OntologyConfig(TypedDict)`:

| key | meaning |
| --- | --- |
| `ontology_resolver` | resolver instance; **omitting it turns the ontology off for that call** |
| `ontology_mode` | `"annotate"` (default) or `"strict"` |
| `authoritative_sources` | which schema tables are system of record; stamped on `realizes` edges |
| `ontology_reasoning` | `"none"` (default) or `"owl_rl"` (needs optional `owlrl`) |

`DEFAULT_ONTOLOGY_MODE = "annotate"`; `strict` "drops extracted entities with no ontology
grounding". So the ontology adds **enrichment by default and validation on request** — it is not
merely either. With no resolver configured on this deployment, nodes carry `ontology_valid: false`
and `ontology_uri: null`; the hooks are present and inactive. Export surface exists at
`GET /api/v1/ontologies/{ontology_key}/export`.

## 7. `improve` / session → permanent

```python
improve(dataset="main_dataset", *, run_in_background=False, node_name=None,
        session_ids: list[str] | None = None, build_global_context_index=None,
        build_truth_subspace=False, review_conflicts=None, **ImproveKwargs) -> ImproveResult
```

`ImproveResult` fields: `dataset_id, dataset_name, session_ids, stages, background, finished, error,
legacy_memify_run`.

Stage registry, in execution order: `FeedbackWeightsStage`, `PersistSessionQAStage`,
`PersistAgentTracesStage`, `ExtractAgentContextStage`, `DistillSessionsStage`,
`UpdateUserPreferencesStage`, `BuildTruthSubspaceStage`, `ReviewConflictsStage`,
`GlobalContextIndexStage`. `persist_session_qa` is the **single fatal stage** (policy D2 — losing
session Q&A is data loss); every other stage fails open and the next still runs.

**The already-observed limitation follows structurally:** every stage consumes session records
(`DistillSessions`, `PersistSessionQA`, `ExtractAgentContext`). Duplicate collapse is a *distillation*
over sessions, so with `session_ids=None` there is nothing to distil and nothing to collapse.
`review_conflicts=True` additionally materialises `FactConflict` nodes for human resolution.

**PARTIAL:** signatures, stage list and contracts verified from installed source; no live `improve`
run was performed (it needs populated session memory plus LLM budget, and would have hit the same
graph lock).

## 8. Hybrid vector + graph retrieval

`HybridRetriever` runs two lanes and fuses them:

- **vector lane** — `retrieve_hybrid_chunks` / `search_collection` over chunk collections;
- **entity/fact lane** — `search_entities`, `FactCandidates`, `edge_rank_by_id` over the graph;
- plus `build_entities`, `pin_grounded_entities` and optional ontology grounding
  (`ground`, `with_grounding_block`).

Tunables, read from `retriever_specific_config`:

| knob | default | effect |
| --- | --- | --- |
| `chunks_top_k` | `top_k` | vector lane width |
| `entities_top_k` | `top_k` | graph lane width |
| `max_edges_per_entity` | `10` | **graph breadth** per entity |
| `neighborhood_depth` (SDK recall) | unset | traversal depth (hops) for triplet neighbourhood expansion |
| `neighborhood_seed_top_k` (SDK recall) | unset | seeds expanded per query |

`neighborhood_depth` is a real recall parameter: where set, it is forwarded as
`brute_force_triplet_search(..., depth=neighborhood_depth)`. (The `>= 1` validation seen in
`subgraph_data.py` belongs to the visualization subgraph path, not to recall — do not assume recall
rejects `0`.)

**Asymmetry worth knowing:** `RecallPayloadDTO` in `/openapi.json` does **not** expose
`neighborhood_depth`. Over HTTP, depth is reachable only indirectly through `retrieverSpecificConfig`.
`SearchType` offers 22 values; the graph-forward ones are `GRAPH_COMPLETION`,
`GRAPH_COMPLETION_DECOMPOSITION`, `GRAPH_COMPLETION_COT`, `GRAPH_COMPLETION_CONTEXT_EXTENSION`,
`GRAPH_SUMMARY_COMPLETION`, `TRIPLET_COMPLETION`, `CYPHER`, `NATURAL_LANGUAGE`, `TEMPORAL`.

## 9. External upstream references

All accessed 2026-11-24. Version-pinned to `v1.6.10` where a file is cited, because the installed
build is that tag.

| # | Title | URL |
| --- | --- | --- |
| 1 | Cognee v1.6.10 release notes — "Reliability & Observability Improvements", 2026-11-18; compat: Python `>=3.10,<3.15`, pydantic `>=2.13`, litellm `>=1.102.2,<2`, fastapi `>=0.116.2,<1`, sqlalchemy `>=2.0.39,<3`, lancedb `>=0.39,<0.40`, **ladybug `==0.22.3`**; "stricter validation and centralized stamping of chunks so stored chunks are reliably identified" | <https://github.com/topoteretes/cognee/releases/tag/v1.6.10> |
| 2 | `docs/recall-vs-search.md` — recall vs search, `only_context`, session-as-source semantics | <https://github.com/topoteretes/cognee/blob/v1.6.10/docs/recall-vs-search.md> |
| 3 | `docs/resolve-conflicts.md` — "Conflict review (`improve(review_conflicts=True)`) creates `FactConflict` nodes" | <https://github.com/topoteretes/cognee/blob/v1.6.10/docs/resolve-conflicts.md> |
| 4 | `cognee/modules/migration/cogx.py` — "COGX — the Cognee eXchange format for portable memory"; `COGX_VERSION = "0.2"`; archive = `manifest.json` + one JSONL per record kind, records discriminated by `kind`; hub format for Mem0 / Zep-Graphiti / Letta importers | <https://github.com/topoteretes/cognee/blob/v1.6.10/cognee/modules/migration/cogx.py> |
| 5 | `cognee/api/v1/datasets/routers/get_datasets_router.py` — `@router.get("/{dataset_id}/graph", response_model=GraphDTO)` | <https://github.com/topoteretes/cognee/blob/v1.6.10/cognee/api/v1/datasets/routers/get_datasets_router.py> |
| 6 | PR #5160 (open) — "return structured context evidence from HYBRID_COMPLETION"; `evidence` filled from `get_context_evidence` when `include_references=True` | <https://github.com/topoteretes/cognee/pull/5160> |
| 7 | PR #6659 (closed, merged) — "name references by document title and link (SDK-1500)"; title/url live on the data record's `system_metadata`, not on chunks | <https://github.com/topoteretes/cognee/pull/6659> |
| 8 | PR #6238 (closed, merged) — "feat(mcp): Expose data ids in recall (SDK-1215)"; `recall` previously surfaced neither `data_id` nor `dataset_id` | <https://github.com/topoteretes/cognee/pull/6238> |
| 9 | PR #6452 (open) — "inspect COGX archives before memory import"; inspector checks **manifest compatibility**, record schemas, declared counts, checksums | <https://github.com/topoteretes/cognee/pull/6452> |
| 10 | PR #6564 / #5873 / #6631 — COGX OMP header retention, OMP header fields in COGX 0.2, OMP v0.6 memory object | <https://github.com/topoteretes/cognee/pull/6564> |
| 11 | Issue #6646 (open) — "GraphML export writes invalid XML when a value contains a control character" — **GraphML**, distinct from markdown export | <https://github.com/topoteretes/cognee/issues/6646> |
| 12 | `.agents/skills/cognee-migrations/SKILL.md` — two migration chains (Alembic relational + graph/vector data), `dataset_database.migration_revision` | <https://github.com/topoteretes/cognee/blob/v1.6.10/.agents/skills/cognee-migrations/SKILL.md> |
| 13 | `docs/supply_chain_provenance.md` — **build** provenance (SLSA/PEP 740 attestations), *not* runtime data provenance; cited only to avoid the name collision | <https://github.com/topoteretes/cognee/blob/v1.6.10/docs/supply_chain_provenance.md> |

### Feature table

| Feature | Upstream docs claim | Present in 1.6.10-local | Evidence |
| --- | --- | --- | --- |
| `include_references` | yes (recall/search) | **yes** — `include_references` (SDK), `includeReferences` (HTTP) | `inspect.signature`, `RecallPayloadDTO` in live `/openapi.json` |
| Structured `evidence` on completion | yes | **yes for `GRAPH_COMPLETION`; empty `metadata` for `HYBRID_COMPLETION`** | live `metadata["evidence"]` dump; upstream #5160 still open |
| Document identifiers inside evidence | title+link after #6659 | **no** — `data_id/chunk_id/document_name` are `None` for `graph_node`; only in rendered text | live payload §3.3 |
| `DocumentChunk` / `Document` nodes | "Document"/"DocumentChunk" | **`DocumentChunk` + `TextDocument`** (no `Document` type) | live graph endpoint, 21 nodes |
| `is_part_of` chunk→doc edge | yes | **yes**, one per chunk, `evidence_kind=structural` | live edges + `provenance_edge_evidence` |
| `raw_data_location` / `content_hash` on the node | implied | **no** — relational only (`data.raw_data_location`, `data.content_hash`) | node property dump vs `data` schema |
| `PROVENANCE_TRACKING` | audit ledger, default off | **present, off** (0 rows) | `provenance/tracking.py`; table counts |
| Edge-evidence sidecar | default on | **on** (968 rows) | `EDGE_EVIDENCE_ENABLED`, `provenance_edge_evidence` sample |
| `get_graph_engine()` traversal | yes | **methods present, blocked by exclusive Ladybug lock** | `dir()`; 5× `Could not set lock … PID 92` |
| Entity canonicalization | name-identity | **yes**, `identity_fields=["name"]` | `Entity.py`; single `ada lovelace` node |
| Ontology | annotate/strict | **yes**; `annotate` default, `strict` validates | `ontology_config.py`, `DEFAULT_ONTOLOGY_MODE` |
| Markdown graph export | yes | **yes** — `GET /api/v1/activity/export/{dataset_id}` (`text/markdown`) | `export_dataset_markdown` in activity router |
| COGX format | yes, v0.2 | **yes** — `cognee/modules/migration/cogx.py` | installed source; upstream #6452 |
| COGX import vs backend incompatibility | issue expected | **NOT FOUND** — searched 50 COGX issues; nearest is manifest-compatibility *inspection* (#6452), no backend-mismatch report | GitHub issue search, GAP |

## 10. Constraints honoured, and cleanup proof

- **Read-only on production:** relational work was `SELECT`/`information_schema` only. No production
  dataset, user, ACL or graph object was modified.
- **Isolated test datasets only, deleted after:** `dsh-memlink-probe-20261124191710`
  (`13071141-…`) and `dsh-memlink-ev-192135` (`a725704c-…`), both removed via
  `DELETE /api/v1/datasets/{id}` → HTTP 200.
- **Verification after deletion:** `datasets where name like 'dsh-memlink%'` = **0**; `data` rows for
  either id = **0**; `provenance_edge_evidence` rows for either id = **0**; orphaned evidence rows
  (`dataset_id` with no `datasets` row) = **0**; `datasets` total back to **26**.
- **No secrets in this report.** Credentials are referred to by env-var name only
  (`DEFAULT_USER_PASSWORD`, `DB_PASSWORD`, `LLM_API_KEY`, …); no value is reproduced.
- One caveat worth stating plainly: the global `provenance_edge_evidence` count moved 968 → 994
  during the session while every row attributable to the two test datasets was removed, so that delta
  is concurrent activity on *other* datasets, not residue.

## 11. What this means for DSH–Cognee

Today the per-memory panel links memories by id only. The gap to a navigable memory graph is smaller
than it looks, because the identifiers needed are **already in every recall hit** and the graph
endpoint already returns the edges.

### 11.1 Chunk → Document → Session navigation  (effort: **M**, risk: **low**)

Every recall hit already carries `data_id`, `chunk_id`, `chunk_index`, `document_name` in `metadata`
— no `include_references` needed. Combine that with:

- `GET /datasets/{id}/graph` filtered on `label == "is_part_of" and source == chunk_id` → the parent
  `TextDocument` node;
- `GET /datasets/{id}/data` for `raw_data_location` and `content_hash` (the fields the graph omits);
- `GET /datasets/{id}/data/{data_id}/raw` to open the source text;
- the session id already attached to the turn, for the third hop.

Work is a resolver plus panel state, not new ingestion. **Risk:** graph reads need the bearer-token
flow (camelCase body, snake_case SDK — easy to get wrong), and the graph endpoint is one call per
dataset, so cache it per dataset rather than per hit. Do **not** open the Ladybug file from a Node
sidecar: it is exclusively locked while the API server runs.

### 11.2 "Related memories" via shared entities  (effort: **M**, risk: **medium**)

Entities are canonical and deterministic, so two memories that mention the same entity literally
share a node id — a genuine join, not fuzzy similarity. Build it as: hit → its chunk's entity edges
(`contains`, `reviewed`, `met`, …) → those entity ids → other chunks/documents pointing at the same
entity.

**Risk:** entity nodes carry no `dataset_id`, so the entity→dataset mapping must be reconstructed
through chunk membership, and a shared entity across datasets is a **cross-tenant leak vector** — gate
strictly on the caller's dataset scope. Second risk: `contains`/`met` edge labels come from LLM
extraction and are not normalised, so the edge set is unstable release to release.

### 11.3 Provenance panel driven by edge evidence  (effort: **S**, risk: **medium**)

`provenance_edge_evidence` answers "which chunk, which index, which pipeline run produced this edge"
and is **on by default** in this deployment (968 rows) while `PROVENANCE_TRACKING` is off. A small
read-only view over that table gives per-edge provenance without enabling anything.

**Risk:** it is a Postgres table, so the plugin needs a relational path it may not currently have
(today's provenance work goes through HTTP). Also `provenance_entries` — the audit ledger — is empty
here; a panel that assumes the ledger exists will render blank. Prefer the sidecar, and treat
`PROVENANCE_TRACKING` as an explicit opt-in with its own cost story.

### 11.4 Explicitly not recommended yet

- **`include_references` as the provenance backbone.** For `graph_node` artefacts the structured
  fields are `None`; you would be parsing the `Evidence:` prose block. Use hit `metadata` (§3.3)
  until upstream #5160 lands.
- **`improve` for dedupe.** All stages are session-scoped; without populated session ids it has
  nothing to collapse. Treat it as a session-memory distillation feature, not a dataset cleaner.
