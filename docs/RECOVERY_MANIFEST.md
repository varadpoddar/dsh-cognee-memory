# Historical-memory recovery manifest — DSH–Cognee `1.6.10-local`

Workstream A, read-only against production. Collected 2026-11-23T01:06Z–01:21Z.
Hosts: CT 106 (stack, `/opt/stacks/cognee`), CT 103 (DSH, `/var/lib/deepseek-harness/.dsh`).
Export root (kept): `CT106:/root/cognee-recovery-20261123T010850Z/` (124 files, 50 MB).

## 1. Instance and backends (verified live)

| Fact | Value | Evidence |
|---|---|---|
| Version | `1.6.10-local` | `GET /health/detailed` → `version`, container log line `cognee_version=1.6.10-local` |
| Relational | postgres (ct `cognee-db`, `cognee_db`) | `/health/detailed` `relational_db.provider=postgres`; `DB_PROVIDER=postgres` in `.env` |
| Vector | pgvector, 4096 dims | `vector_db.provider=pgvector`; `VECTOR_DB_PROVIDER=pgvector`, `EMBEDDING_DIMENSIONS=4096` |
| Graph | ladybug (embedded, file-backed) | `graph_db.provider=ladybug`; `system/databases/cognee_graph_ladybug` (42 MB) |
| File storage | local bind `/opt/stacks/cognee/data/cognee` → `/cognee-storage` | `docker inspect cognee` mount; `file_storage.provider=local` |
| Auth | `REQUIRE_AUTHENTICATION=true`, ACL on | container env; API key in `/etc/dsh/cognee.env` (CT 103) |
| Per-dataset version stamp | `dataset_database.cognee_version = 1.6.10-local` for 19/20 datasets | SQL |

## 2. Dataset inventory (`GET /api/v1/datasets` + SQL)

`GET /api/v1/datasets` returns **18** datasets (owner-scoped to the DSH API key); the
relational table holds **20** (`owner_id` of `dsh/project/alpha` and `dsh/project/beta` is the
agent user `2fe3c07c…`, so they are not visible to the DSH owner key).
Record counts = rows in `data`; graph counts = `GET /api/v1/datasets/{id}/graph`.

| # | Dataset UUID | Name | Created (UTC) | Items | Source bytes | Graph n/e | Class |
|---|---|---|---|---|---|---|---|
| 1 | `59901fb9-7b88-5b6c-a899-e8fa6a42dfe9` | `dsh/project/alpha` | 2026-11-22T00:26:31Z | 1 | 288 | n/a¹ | exact-source-recoverable |
| 2 | `dde630f6-cc4d-598d-adee-fe9f4c69afcd` | `dsh/project/beta` | 2026-11-22T00:26:32Z | 0 | 0 | n/a¹ | empty (nothing ever stored) |
| 3 | `eccefbcc-b6b6-5980-a0e3-80ebea968787` | `dsh/agent/smoke` | 2026-11-22T00:28:37Z | 1 | 84 | 3/1 | exact-source-recoverable |
| 4 | `3d8d8ad8-41be-59c3-9310-7915c783e5ef` | `dsh_cognee_project_project-4be96e7c2cdbb95a1ac9` | 2026-11-22T00:36:44Z | 3 | 222 | 26/35 | exact-source-recoverable |
| 5 | `2f883a43-4f5a-5ed0-b736-87819d5aa963` | `dsh-project-m2m3-debug` | 2026-11-22T04:49:39Z | 1 | 15 | 4/3 | exact-source-recoverable |
| 6 | `91ac8783-371e-5cac-b7bf-d2fb43b1ce7b` | `dsh-project-m2m3-live` | 2026-11-22T04:50:39Z | 1 | 83 | 9/9 | exact-source-recoverable |
| 7 | `eee9e637-4cc3-55a0-9b2e-4828f26162ea` | `dsh-agent-agent-a` | 2026-11-22T04:52:48Z | 1 | 42 | 6/5 | exact-source-recoverable |
| 8 | `283077b0-c9f3-577c-8ade-a74b992195d8` | `dsh-project-m2m3-accept` | 2026-11-22T04:54:08Z | 1 | 72 | 3/1 | exact-source-recoverable |
| 9 | `77f07012-5812-526d-9fad-5e28e8ba193c` | `dsh-project-m4m6-accept-1795324415` | 2026-11-22T05:14:04Z | 1 | 69 | 3/1 | exact-source-recoverable |
| 10 | `abe25ad8-5ef6-5ecc-b3a3-9cc4a3e175a3` | `dsh-project-m4m6-probe-1795324518757` | 2026-11-22T05:15:18Z | 1 | 69 | 9/9 | exact-source-recoverable |
| 11 | `fac0f15f-0a95-5118-8977-2ff2b581758b` | `dsh-project-m4m6-probe-1795324561583` | 2026-11-22T05:16:01Z | 1 | 69 | 8/9 | exact-source-recoverable |
| 12 | `477ffbe9-6d35-55f0-9328-ee4df5bf1f4a` | `dsh-project-m4-task-accept-1795324605` | 2026-11-22T05:17:26Z | 1 | 226 | 4/3 | exact-source-recoverable |
| 13 | `e88a74ff-d05d-5f3c-a533-7b7d85be41cf` | `dsh-project-dsh-project-e2e-4be96e7c2cdbb95a1ac9` | 2026-11-22T05:59:56Z | 0 | 0 | 0/0 | empty (nothing ever stored) |
| 14 | `4849c2d0-3ea4-565d-a144-ebd214a01235` | `dsh-project-dsh-project-injection-probe-1795327388933-6663ff84d03a8efa90a0` | 2026-11-22T06:03:09Z | 1 | 205 | 3/1 | exact-source-recoverable |
| 15 | `40ac9f0f-a094-51c9-bc7e-eda337e5c921` | `dsh-project-dsh-project-injection-probe-1795327397942-39c28f605b0b8df0fa33` | 2026-11-22T06:03:18Z | 1 | 205 | 3/1 | exact-source-recoverable |
| 16 | `12294133-9f80-5d64-9618-7abd8004eeef` | `dsh-project-dsh-eval-m11-20261122t061318z-1c33bf87c0d5711383a8` | 2026-11-22T06:13:52Z | 5 | 299 | 35/51 | exact-source-recoverable |
| 17 | `9cb0c9ee-b050-5405-8f2e-dcc3ad601c3b` | `dsh-project-dsh-eval-m11-20261122t0627z-3b824e831f095c2e53ac` | 2026-11-22T06:22:09Z | 11 | 950 | 48/56 | exact-source-recoverable |
| 18 | `37041ccf-0990-5249-898c-c3671b55658e` | `dsh-user-eval-principal-a` | 2026-11-22T06:28:42Z | 1 | 59 | 3/1 | exact-source-recoverable |
| 19 | `d42accfc-6667-55f6-bc4b-981be501a735` | `dsh-project-dsh-eval-m11-20261122t0627z-other-7667c20b4d29019ce11a` | 2026-11-22T06:31:18Z | 1 | 51 | 3/1 | exact-source-recoverable |
| 20 | `33c24fce-6b16-55f0-b3ce-cbbdaf866dca` | `dsh-project-dsh-eval-m12-ranking-448fa9e891d5482a3889` | 2026-11-22T17:39:08Z | 21 | 1553 | 116/144 | exact-source-recoverable |

¹ owner-scoped out of the DSH API key's view (owned by agent user `2fe3c07c…`); source text is
present in the export (`raw_text/2fe3c07c…/`), graph only in the `graph_db/` ladybug copy.

Totals: **20 datasets**, **18 with content / 2 empty**, **54 data items**, **4,561 bytes** of
original UTF-8 text, **286 graph nodes / 331 edges** across the 18 API-visible graphs.

## 3. Memory ledger (DSH side) and datasets it knows about

Ledger: `CT103:/var/lib/deepseek-harness/.dsh/plugins/cognee-memory/provenance.json`
(96,779 B, mtime 2026-11-22T18:30Z), schema `{version:1, entries:[…]}` → **104 entries**,
`createdAt` range **2026-11-22T00:36:45Z → 2026-11-22T17:42:13Z**, **13 distinct dataset names**.
`settings.json` (149 B, 2026-11-22T03:46Z) is the plugin's settings file.

Only 5 of the 13 ledger dataset names exist in Cognee. **8 ledger-only datasets** — memory the
plugin believes it wrote but which no longer has a Cognee dataset row (deleted or never
created): `dsh-project-demo` (1 entry), `dsh-project-dsh-eval-m11-20261122t163300z-…` (5),
`…t163938z-…` (5), `…t164517z-…` (6), `…t165617z-…` (15), `…t170748z-…` (15),
`…t172337z-…` (15), `dsh-project-dsh-eval-seedtest-163844-…` (1). **Classification:
unrecoverable from Cognee; ledger metadata only** (no dataset, no raw files, no graph).
Conversely 13 Cognee datasets have no ledger entry (all pre-date or bypassed the ledger), so
the ledger is not a complete record either.

Datasets that predate the ledger's first entry (`00:36:45Z`): `dsh/project/alpha`,
`dsh/project/beta`. Datasets 3 and 4 start within one second of the first ledger entry.

## 4. Endpoint probes (live, this instance)

**Graph — present.** `GET /api/v1/datasets/{id}/graph` → HTTP 200, `{nodes[], edges[]}`.
Node = `{id, label, type, properties}`; edge = `{source, target, label}`.
Includes **chunk-level** text only (`DocumentChunk.properties.text`), never the whole document;
also carries `document_id`, `document_name`, `content_hash`, `source_content_hash`,
`source_pipeline`, `source_task`, `belongs_to_set`, `chunk_index`. Redacted sample
(`dsh-project-m2m3-debug`, source text `"The flag is on."`):

```json
{"nodes":[{"id":"54312310-8dd6-5073-8e4c-f131281065c9","label":"DocumentChunk_5431…","type":"DocumentChunk",
  "properties":{"text":"The flag is on.","chunk_size":8,"chunk_index":0,"cut_type":"sentence_end",
  "content_hash":"c3224818…","source_content_hash":"fa6e3246…","source_pipeline":"cognify_pipeline",
  "source_task":"extract_chunks_from_documents","source_user":"dsh+<owner-uuid>@cognee.agent",
  "belongs_to_set":["[\"flag\",\"status\"]"]}}],
 "edges":[{"source":"DocumentChunk_5431…","target":"text_fa6e3246…","label":"is_part_of"}]}
```

**`GET /api/v1/activity/export/{dataset_id}` — present.** Served by the installed build
(`/openapi.json`), and it is the **dataset markdown graph export**, not activity spans:

```
| Source | Relationship | Target |
| DocumentChunk_54312310-… | is_part_of | text_fa6e3246… |
| DocumentChunk_54312310-… | belongs_to_set | ["flag","status"] |
```

Also present in `/openapi.json` and used here: `GET /datasets/{id}/data`,
`GET /datasets/{id}/data/count`, `GET /datasets/{id}/data/{data_id}/raw`,
`POST /add`, `POST /cognify`, `POST /search`, `POST /recall`, `POST /remember`.
No HTTP route exports a whole dataset (COGX/GraphML export is Python-side only).

## 5. Python export surface in the installed image

`cognee.export` / `cognee.api.v1.export` exist (`cognee/modules/migration/`:
`archive.py`, `cogx.py`, `export.py`, `formats.py`, `import_source.py`, `loader.py`,
`snapshot.py`, `sources/`).

```
cognee.export(dataset='main_dataset', format='pydantic', destination=None, user=None,
              link_relations=False, include_permissions=False) -> ExportResult | GraphSnapshot
formats: 'pydantic' (lossless GraphSnapshot JSON) | 'cogx' (re-importable archive dir)
         | 'json' | 'graphml' | 'cypher'
```

COGX support: `COGXArchiveSource`, `COGXManifest`, `COGXRecord`, `pack_archive`,
`unpack_archive`, `read_archive`, `EXPORT_FORMATS`, `IMPORT_MODES`, `import_memory_source` —
i.e. COGX is **present in 1.6.10-local**, not upstream-only. GraphML also exists
(`format="graphml"`); upstream has an open invalid-XML bug for control characters
(issues 6646/6653). No `code_export`/`memory export` CLI verb was needed here.

## 6. Is the original text retained? — verdict: YES for every stored item

* `data.raw_data_location` and `data.original_data_location` point at
  `file:///cognee-storage/data/<owner_id>/text_<content_hash>.txt`; the bind mount
  `/opt/stacks/cognee/data/cognee/data` holds **54 `.txt` files for 54 `data` rows**.
* Byte-for-byte check of every row: `wc -c` of the file equals `data.data_size` for
  **54/54**, 0 mismatches, 0 missing. The filename embeds the content hash.
* Sample (dataset `dsh/project/alpha`): `ARCHITECTURE DECISION ADR-0007: the DSH memory plugin
  stores agent memory in Cognee datasets named dsh/project/<scope> …` — plain original text.
* The graph does **not** hold the original document: `DocumentChunk.text` is a chunk,
  `GlobalContextSummary`/`TextSummary` are LLM-derived, and entities are extracted. Chunk text
  is never a substitute for the source file, and no dataset's graph text totals more than the
  source it came from (max 1,608 chars in one node vs 1,553 bytes of source in the worst case,
  i.e. summary text is generated, not copied).
* Empty datasets (`dsh/project/beta`, `…-e2e-…`) have no rows and no files — nothing to recover,
  nothing lost.

**Counts:** exact-source-recoverable **18/20 datasets, 54/54 items, 4,561/4,561 bytes**;
derived-only (graph/summaries) present for all 18; partial **0**; unrecoverable **8 ledger-only
datasets** (metadata only) + 2 empty dataset shells.

## 7. Export contents — `CT106:/root/cognee-recovery-20261123T010850Z/`

| Path | Contents | Method |
|---|---|---|
| `raw_text/<owner_id>/text_<hash>.txt` | 54 original files, byte-identical | `cp -a` from the storage bind (read-only) |
| `graph_json/<dataset>.json` | 18 API graph dumps (nodes+edges, all properties, node IDs, hashes, timestamps) | `GET /datasets/{id}/graph` per dataset |
| `graph_markdown/<dataset>.md` | 18 markdown graph exports | `GET /activity/export/{id}` |
| `api/datasets.json`, `api/provenance-ledger.json`, `api/ledger-settings.json` | dataset list + the DSH ledger copy | `GET /datasets`, file copy |
| `sql/cognee_schema.sql`, `sql/cognee_data_only.sql` (7.0 MB) | full schema + data-only dump: `datasets`, `data` (UUIDs, hashes, `raw_data_location`, timestamps, `pipeline_status`), `dataset_database` (backend + version per dataset), `pipeline_runs`, `results`, `provenance_edge_evidence`, `acls`, `users` | `pg_dump` (read-only) |
| `graph_db/` | copy of `cognee_graph_ladybug` + WAL + `cache.db` (42 MB) — complete graph store, restorable by mounting | `cp -a` |

Restore path: mount `graph_db/` as `/cognee-storage/system/databases` in a fresh stack and
load `sql/cognee_data_only.sql` into a migrated DB; or rebuild from `raw_text/` with
`add()`+`cognify()`; or use the COGX archive produced during verification (§8).

## 8. Throwaway-instance import (verification, then torn down)

Separate compose project `cognee-tw` on CT 106: own `cognee-tw-db` (pgvector/pg16, fresh
volume), own `cognee-tw` on `10.20.10.15:18000`, storage in `/root/cognee-throwaway/data`,
`REQUIRE_AUTHENTICATION=false`, prod left untouched. Results:

1. Imported the recovered `text_84b054…txt` (ADR-0007, 288 B) into dataset `dsh/project/alpha`
   (`POST /add` → 200, `POST /cognify` → `PipelineRunCompleted`). Graph: 1 `DocumentChunk`.
   `POST /search {searchType:CHUNKS}` returned the source text containing
   `"Cognee owns chunking"` → **known record retrievable**.
2. COGX round-trip: `cognee.export(format="cogx")` → `ExportResult`, archive with
   `manifest.json`, `documents.jsonl`, `entities.jsonl`, `facts.jsonl`, `nodes.jsonl`
   (7,121 B zipped); `import_memory_source(COGXArchiveSource(dir), dataset_name=
   "dsh/project/alpha-restored")` → `RememberResult(status='completed')`; restored graph =
   1 `DocumentChunk` + 4 `Entity` + 3 `EntityType` + 1 `TextDocument` + 1 `TextSummary`;
   `CHUNKS` and `CHUNKS_LEXICAL` both returned `"Cognee owns chunking"`.
   Caveat: the import logged `ValueError: Unrecognized model in Qwen/Qwen3-Embedding-8B-GGUF`
   from the embedding client while still reporting success — vector coverage must be checked
   separately after any import.
3. Teardown: `docker compose down -v`, throwaway dir removed, port 18000 closed. Recovery
   directory kept.

## 9. Production unchanged (before/after)

| Check | Before (01:08Z) | After (01:21Z) |
|---|---|---|
| `datasets` rows | 20 | 20 |
| `data` rows | 54 | 54 |
| `dataset_database` rows | 19 | 19 |
| raw text files on disk | 54 | 54 |
| `GET /datasets` for the DSH key | 18 | 18 |
| `GET /datasets/2f883a43…/graph` | 4 nodes / 3 edges | 4 nodes / 3 edges |
| containers | `cognee`, `cognee-db`, `cognee-ui` up | same, uptime unchanged (no restart) |
| DSH service | `deepseek-harness.service` untouched | untouched (no writes under `.dsh`) |

No `mv`, no `pnpm`, no `dsh plugin`, no write of any kind inside `/var/lib/deepseek-harness/.dsh`;
all production access was `SELECT`/`GET`/file copy.

## 10. Caveats

* "Lossless" is claimed only for the 54 raw `.txt` items (size-verified). Graph nodes are
  derived artefacts; summaries are LLM output and must never be presented as source text.
* Two datasets are outside the DSH API key's owner scope; their graph is in `graph_db/` but was
  not exported through the API.
* 8 ledger-only datasets cannot be recovered from this instance — only their ledger metadata
  survives.
* The graph store is a single embedded Ladybug file with an exclusive lock: a second process
  (including a sidecar container) cannot open it while the API container runs — stop the API
  container first for any direct-store work.
