# Installed Cognee compatibility (Gate 0)

**Installed version:** `1.6.10-local` — `GET /health/detailed` → `"version":"1.6.10-local"`
(2026-11-21T04:09:31Z; `relational_db: postgres`, `vector_db: pgvector`, `graph_db: ladybug`,
`llm_provider: custom`, `embedding_service: configured`).
**Spec API version:** `1.0.0` (`info.version` in `/openapi.json` — this is the FastAPI document
version, **not** the product version; do not read it as `1.6.10`).
**Evidence:** live `GET /openapi.json` with `X-Api-Key` → HTTP 200, 136 paths, 396,918 bytes.
Everything below is read from that installed document; no doc-only claim is counted.

Reproduce:

```bash
curl -s -H "X-Api-Key: $COGNEE_API_KEY" http://10.20.10.15:8000/openapi.json -o /tmp/c.json
curl -s -H "X-Api-Key: $COGNEE_API_KEY" http://10.20.10.15:8000/health/detailed | jq -r .version
python3 -c "import json;d=json.load(open('/tmp/c.json'));print(len(d['paths']), d['info']['version'])"
```

## 1. Session memory — PRESENT

| Route | Method | Key fields |
|---|---|---|
| `/api/v1/remember` | POST | `session_id` (multipart) — cache write |
| `/api/v1/recall` | POST | `sessionId`, `scope` (`auto`, `session_first`, `session`, `session_context`, `trace`, `graph`, `tools`, `code`, `all`; single string **or** array) |
| `/api/v1/sessions` | GET | `range`, `status`, `limit`, `offset`, `order_by`, `descending` |
| `/api/v1/sessions/{session_id}` | GET, DELETE | path `session_id` |
| `/api/v1/sessions/stats`, `/cost-by-model`, `/cost-by-user-agent`, `/with-agent-info` | GET | — |

## 2. Typed entries — PRESENT

`POST /api/v1/remember/entry`, body `{entry, dataset_name, dataset_id, session_id,
self_improvement, skill_improvement}`; `entry` is a discriminated union on `type`:

| Member | Required | Notable optional fields |
|---|---|---|
| `QAEntry` (`qa`) | `question`, `answer` | `node_set`, `context`, `feedback_text`, `feedback_score`, `used_graph_element_ids` |
| `TraceEntry` (`trace`) | `origin_function` | `node_set`, `status`, `memory_query`, `memory_context`, `generate_feedback_with_llm` |
| `FeedbackEntry` (`feedback`) | `qa_id` | `feedback_text`, `feedback_score` |
| `SkillRunEntry` (`skill_run`) | `selected_skill_id` | `node_set`, `run_id`, `tool_trace`, `latency_ms` |

Drift: the request body has **no `required` list**, so `session_id` is accepted but not
schema-enforced (docs/COGNEE_DECISIONS.md D4 says it is required for qa/trace/feedback).

## 3. Node sets — PRESENT on writes only

`node_set` exists on `POST /api/v1/add`, `POST /api/v1/remember`,
`PATCH /api/v1/update`, and on `QAEntry`/`TraceEntry`/`SkillRunEntry`.
It is **absent** from `POST /api/v1/search` and `POST /api/v1/recall` (those accept
`nodeType` + `nodeName`, not `node_set`). Retrieval is by dataset/session, not by node set.

## 4. `improve` — PRESENT

`POST /api/v1/improve`, body `{extractionTasks, enrichmentTasks, data, datasetName,
datasetId, nodeName, runInBackground, buildGlobalContextIndex, buildTruthSubspace,
reviewConflicts, feedbackAlpha, sessionIds}`. No `required` list (all optional).
`POST /api/v1/memify` still exists alongside it (deprecated upstream, not removed here).

## 5. Conflict / truth review — PRESENT

| Route | Method | Fields |
|---|---|---|
| `/api/v1/conflicts` | GET | query `dataset_id`, `status` |
| `/api/v1/conflicts/{conflict_id}/resolve` | POST | `datasetId`, `selectedFactId`, `reason?` |
| `/api/v1/proposals/{proposal_id}` | GET | path `proposal_id` |
| `/api/v1/provenance/*` | GET/POST | `anchor`, `verify`, `history/{entity_id}`, `entry/{entity_id}`, `export`, `statistics`, `status` |

## 6. Item-level `forget(dataset_id, data_id)` — PRESENT (two equivalent routes)

| Route | Method | Fields |
|---|---|---|
| `/api/v1/datasets/{dataset_id}/data/{data_id}` | DELETE | path UUIDs (exact item) |
| `/api/v1/forget` | POST | `{dataId, dataset, datasetId, everything, memoryOnly, cleanHistory}` — `dataId` + `datasetId` for an item |
| `/api/v1/datasets/{dataset_id}` | DELETE | whole dataset |
| `/api/v1/datasets` | DELETE | every dataset the caller owns |
| `/api/v1/delete` | DELETE | legacy/deprecated route, still served |

`memoryOnly:true` clears graph+vectors but keeps raw data; `everything:true` is owner-wide.

## 7. `remember` / `recall` v1 request fields — PRESENT, wider than documented

`POST /api/v1/remember` is **multipart/form-data**, fields: `data`, `raw_data`, `labels`,
`external_metadata`, `datasetName`, `datasetId`, `session_id`, `node_set`, `self_improvement`,
`run_in_background`, `custom_prompt`, `chunk_size`, `chunks_per_batch`, `ontology_key`,
`graph_model`, `content_type`, `import_mode`, `skills_text`, `skill_name`, `index_vectors`.
No `required` list; exactly one of `datasetName`/`datasetId` is expected.

`POST /api/v1/recall` is **application/json**, fields: `searchType`, `datasets`,
`datasetIds`, `query`, `systemPrompt`, `nodeType`, `nodeName`, `topK` (default **15**),
`onlyContext`, `verbose`, `includeReferences`, `sessionId`, `scope`, `toolConnections`,
`stream`, `toolsTrigger`, `codeQuery`, `contextProfile`, `responseSchema`,
`retrieverSpecificConfig`. **`query` is not schema-required** but is the documented
semantic input.

`SearchType` enum in the installed build has 22 values, incl. `CHUNKS`,
`GRAPH_COMPLETION`, `HYBRID_COMPLETION`, `RAG_COMPLETION`, `SUMMARIES`, plus new
`HYBRID_COMPLETION_DECOMPOSITION`, `GRAPH_SUMMARY_COMPLETION`, `AGENTIC_COMPLETION`,
`CHUNKS_LEXICAL`, `TRIPLET_COMPLETION`, `SKILLS`, `CODE`, `BROAD`, `TEMPORAL`, `FEELING_LUCKY`.

## Drift vs docs/COGNEE_DECISIONS.md (observed, installed spec only)

1. `recall.scope` gains `session_first` and `tools`, and accepts an **array** of scopes.
2. `recall.topK` defaults to **15**, not the docs' implicit smaller default.
3. `remember` accepts `self_improvement`, `custom_prompt`, `ontology_key`, `graph_model`,
   `index_vectors` — none listed in D3.
4. `node_set` is **write-only**; D3's search/recall description implies broader use.
5. `remember/entry` and `remember` bodies have no schema-required fields, so
   "`session_id` required" (D4) is enforcement-in-code, not in the contract.
6. `/memify` is still served (D3 called it deprecated but present — consistent).
7. Extra non-doc surface exists: `integrations/*`, `skills/*`, `activity/*`, `llm/*`,
   `datasets/{id}/schema`, `datasets/{id}/sparql`, `visualize/*`, `checks/connection`.

**Gate 0 verdict:** the installed build supports every memory primitive Milestone 1 needs
(session-scoped recall via `POST /api/v1/recall` with `datasetIds` + `query` + `topK` +
`onlyContext`). No upgrade required, and none was performed.
