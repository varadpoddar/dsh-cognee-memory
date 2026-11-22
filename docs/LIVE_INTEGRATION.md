# Live integration — Cognee 1.6.10-local + DSH 0.2.1-rc.5 on CT 103

Everything below was produced by real HTTP calls to the live Cognee instance and real
`dsh` processes. No mock server is involved in any result in this file. The API key is
never printed; where a credential appeared it is shown as `<redacted>`.

| Fact | Value |
| --- | --- |
| Cognee | `1.6.10-local`, Postgres + pgvector, `ENABLE_BACKEND_ACCESS_CONTROL=true` |
| Base URL | `http://10.20.10.15:8000/api/v1` (health at `http://10.20.10.15:8000/health`) |
| Auth | `X-Api-Key` header, agent user `dsh+2fe3c07c-…@cognee.agent` (parent `2fe3c07c-…`) |
| DSH host | CT 103 on `control.nomad.opsc.io` (`10.20.10.12`), DSH `0.2.1-rc.5`, Node `v22.23.5` |
| Date | 2026-11-21 / 2026-11-22 UTC |

## 1. Verified request/response shapes

Captured with `curl` against the live instance. Bodies are verbatim except for the key
and long ids where marked.

### Auth and health

```http
GET /api/v1/users/me            -> 200 in 24 ms
{"id":"05a6c959-3357-4a6d-a52a-1ad79ab16d8e",
 "email":"dsh+2fe3c07c-…@cognee.agent","is_active":true,"is_superuser":false,
 "is_verified":false,"tenant_id":null,"parent_user_id":"2fe3c07c-…"}

GET /health                     -> 200 in 19 ms (origin, NOT under /api/v1)
{"status":"ready","health":"healthy","version":"1.6.10-local"}

GET /api/v1/datasets with a bad key -> 401
{"detail":"Authentication required (auth posture: explicit REQUIRE_AUTHENTICATION). …"}
```

### Datasets

```http
GET  /api/v1/datasets -> 200
[{"id":"eccefbcc-…","name":"dsh/agent/smoke","createdAt":"2026-11-22T00:28:37.530205Z",
  "updatedAt":null,"ownerId":"05a6c959-…"}]

POST /api/v1/datasets {"name":"dsh_cognee_project_probe_20261121"} -> 200
{"id":"a163ddb0-…","name":"dsh_cognee_project_probe_20261121",
 "createdAt":"2026-11-22T00:29:44.233522Z","updatedAt":null,"ownerId":"05a6c959-…"}
```

The list/create shape is `{id,name,createdAt,updatedAt,ownerId}`. `ownerId` is what the
adapter compares with `/users/me` before it writes (quirk-2 guard).

### Writes

Writes are **multipart only**:

```http
POST /api/v1/add  (JSON body {"data":"x","datasetId":"…"}) -> 400
{"error":"Either datasetId or datasetName must be provided.","detail":null}

POST /api/v1/add  -F raw_data=… -F datasetId=<uuid> -F node_set=probe -> 200
{"status":"PipelineRunCompleted","pipeline_run_id":"ab6f887a-…",
 "dataset_id":"a163ddb0-…","dataset_name":"dsh_cognee_project_probe_20261121",
 "payload":null,
 "data_ingestion_info":[{"run_info":{…},"data_id":"eae28da0-…",
   "data_name":"text_8a3ccc321596348fd358b8d088c4ea44","data_location":null,"data_label":null}],
 "data_ids":["eae28da0-…"]}

POST /api/v1/remember -F raw_data=… -F datasetId=<uuid> -> 200 in 2.00 s
{"status":"completed","dataset_name":"dsh_cognee_project_probe_20261121",
 "dataset_id":"a163ddb0-…","pipeline_run_id":"c958173d-…",
 "items_processed":2,"elapsed_seconds":1.3850499745458364,
 "items":[{"id":"ec3e326f-…"},{"id":"eae28da0-…"}],"improve":{…}}
```

The adapter uses `/remember` (add+cognify in one call), then proves completion with the
status endpoints below. `/add` and `/cognify` answer `PipelineRunCompleted` per dataset;
`/remember` answers `completed`; the status endpoint answers
`DATASET_PROCESSING_COMPLETED` — all three are accepted, a 200 alone is not.

### Ingestion status (the completion gate)

```http
GET /api/v1/datasets/status?dataset=<uuid>&pipeline=cognify_pipeline -> 200
{"a163ddb0-…":"DATASET_PROCESSING_COMPLETED"}

GET /api/v1/datasets/status/memory?dataset=<uuid> -> 200
{"a163ddb0-…":{"state":"ready","search_level":"graph","searchable":true,
 "graph_ready":true,"message":"Memory is fully built: chunks, entities and relationships are searchable.",
 "indexing_status":"DATASET_PROCESSING_COMPLETED","cognify_status":"DATASET_PROCESSING_COMPLETED",
 "error_class":null,"error_message":null}}

# same call between /add and /cognify:
{"…":{"state":"staged","search_level":"none","searchable":false,"graph_ready":false,
 "message":"Data is added but not processed: nothing is searchable yet. Run cognify() (or remember()) to build memory.", …}}

GET /api/v1/datasets/<uuid>/processing-status -> 200
{"total":1,"completed":1,"pending":0,"items":[{"id":"eae28da0-…","name":"text_8a3ccc…","completed":true}]}
```

### Reads

```http
POST /api/v1/search {"query":"ADR-9001 …","searchType":"CHUNKS",
                     "datasetIds":["<uuid>"],"topK":5} -> 200 in 0.209 s
[{"dataset_id":"a163ddb0-…","dataset_name":"dsh_cognee_project_probe_20261121",
  "dataset_tenant_id":null,
  "search_result":[
    {"id":"77f00379-…","created_at":1795307390969,"updated_at":1795307390969,
     "type":"IndexSchema","belongs_to_set":["probe"],"text":"ADR-9001 probe: the plugin uses dataset UUIDs.",
     "document_id":"eae28da0-…","document_name":"text_8a3ccc…","chunk_index":0,
     "external_metadata":"{\"node_set\": [\"probe\"]}","score":0.1495712478395439}]}]
```

`search_result` rows are objects for `CHUNKS` and **plain strings** for
`GRAPH_COMPLETION` (4.20 s):

```json
[{"dataset_id":"…","dataset_name":"…","search_result":["ADR-9001 is an architecture decision record …"]}]
```

`POST /recall` (5.63 s) returns a flatter, already-answered shape; the plugin does not use
it because `CHUNKS` gives scored text plus the `document_id` needed by `forget`:

```json
[{"kind":"graph_completion","search_type":"HYBRID_COMPLETION",
  "text":"ADR-9001 is a probe concerning a plugin that uses dataset UUIDs.",
  "system_prompt":null,"score":null,"dataset_id":"a163ddb0-…",
  "dataset_name":"…","metadata":{},"raw":{"value":"…"},"structured":null,"source":"graph"}]
```

### Deletion

```http
POST /api/v1/forget {"datasetId":"<uuid>","dataId":"<uuid>"} -> 200 in 0.49 s
{"status":"success","dataset_id":"a163ddb0-…","data_id":"ec3e326f-…",
 "data_record_found":true,"deleted_nodes":2,"deleted_edges":1,
 "data_remaining":false,"dataset_deleted":false,"search_history_removed":false,"history_cleaned":false}

DELETE /api/v1/datasets/<uuid> -> 200   body: null   (used only by the live test's cleanup)
```

### Data records

```http
GET /api/v1/datasets/<uuid>/data -> 200
[{"id":"eae28da0-…","name":"text_8a3ccc321596348fd358b8d088c4ea44",
  "createdAt":"2026-11-22T00:29:47.693674Z","updatedAt":"…",
  "extension":"txt","mimeType":"text/plain","rawDataLocation":"file:///cognee-storage/data/…",
  "datasetId":"a163ddb0-…","label":null,
  "externalMetadata":{"node_set":["probe"]},"dataSize":46,
  "contentHash":"8a3ccc321596348fd358b8d088c4ea44","structure":null}]
```

`contentHash` is the **md5 of the raw text** (verified: md5 of the probe sentence equals
`8a3ccc321596348fd358b8d088c4ea44`). The adapter uses that to recognise a deduplicated
write and to return the existing `data_id`.

## 2. Adapter changes forced by the live responses

| Was (assumption) | Live reality | Fix |
| --- | --- | --- |
| `POST /add` with JSON `{data, datasetName, nodeSet}` | multipart only; JSON → 400; `datasetName` silently creates a same-named dataset | `/remember` multipart with `raw_data` + resolved `datasetId` |
| dataset addressed by name | shared datasets are only addressable by UUID; non-owned names re-create | `DatasetRegistry`: list → match name → verify `ownerId` vs `/users/me` → create-if-missing → cache UUID |
| `/api/v1/delete?data_id=` | deprecated | `POST /forget {datasetId,dataId}` |
| `/search` body `search_type`, `datasets`, `top_k` | `searchType`, `datasetIds`, `topK` (camelCase) | request body corrected |
| search results = flat rows with `text`/`score` | array of `{dataset_id,dataset_name,search_result:[…]}`; rows differ per mode | `parseSearchGroups` + per-dataset scope map; unknown datasets dropped |
| `id` from search row | `document_id` is the data id `forget` needs; `id` is a chunk id | prefer `document_id`; non-UUID graph ids are never sent to `forget` |
| 200 from `/add` means ingestion done | job/pipeline based; memory `staged` until cognify | poll `status/memory` + `status?pipeline=cognify_pipeline`, budget `ingestion.timeoutMs` |
| recall unbounded 15 s | CHUNKS 0.21 s vs GRAPH_COMPLETION 4.2 s vs recall 5.6 s | `recall.maxRecallLatencyMs` (default 3000) + `maxRetries: 0`; `open` mode returns no hits |
| `GET /api/v1/health` | health is `GET /health` at the origin | `originRelative` request |
| defaults `authMode: none` | EBAC forces auth on every endpoint | default `api-key` + `COGNEE_API_KEY`; requests 120 s |

Dataset naming stays the deterministic hashed scope key from `scopeKey()`, e.g. project
scope `dsh/project/e2e` → scope id `project-4be96e7c2cdbb95a1ac9` → dataset name
`dsh_cognee_project_project-4be96e7c2cdbb95a1ac9`.

## 3. Live test run (real network, real backend)

```bash
COGNEE_API_KEY=<redacted> npm run test:live
```

```
 ✓ test/live/cognee-live.test.ts (8 tests) 11088ms
[live] timings(ms) {"me":29.7,"rememberA":3292.3,"rememberB":3193.9,
                    "recallA":174.6,"recallBForA":168.1,"forget":319.2}
```

What the 8 tests assert, in order: authenticated `/users/me` + `/health`; write to
project scope A and independent confirmation (`state:"ready"`, `searchable:true`,
pipeline `DATASET_PROCESSING_COMPLETED`, `completed==total==1`); a second scope B;
recall A contains the token with scope A and a non-zero score; B never returns A's token
and A never returns B's token while B returns its own; `forget` removes exactly that
`data_id` from `/datasets/{id}/data` and from search; status/health; timings recorded.
The suite deletes the two datasets it created in `afterAll`.

## 4. Install into the real harness (CT 103)

1. Package: `npm run build && npm pack` → `dsh-cognee-memory-0.1.0.tgz` (92,093 bytes,
   sha256 `b7f830dd…9246`, built from the committed tree), copied to `/root/`.
   The package was installed by removing/re-adding it so pnpm did not reuse the
   earlier cached tarball; the installed `lib/adapters/cognee-response.js` mtime
   and contents were checked against the local build.
2. Supported mechanism (from `dsh plugin --help` + `@deepseek-ai/dsh-plugin-manager`):
   `dsh plugin --profile <name> add <spec>` runs pnpm in the profile directory.
   ```bash
   dsh plugin --profile web add /root/dsh-cognee-memory-0.1.0.tgz
   # + dsh-cognee-memory file:/root/dsh-cognee-memory-0.1.0.tgz
   # dsh: warning: dsh-cognee-memory declares no dsh.bundle — installed as a plain
   #       dependency, not a profile layer
   ```
   Same command for `headless`. The warning is expected: this plugin is mounted by a
   patch `insert:` entry, not as a bundle.
3. `cordis.patch.yml` merged (backup written next to it, entry appended; file never
   overwritten wholesale):
   ```yaml
   - insert:
       - id: cognee-memory
         name: dsh-cognee-memory
         config:
           enabled: true
           transport: rest
           apiBaseUrl: http://10.20.10.15:8000/api/v1
           authMode: api-key
           apiTokenEnv: COGNEE_API_KEY
           failureMode: open
           scopeDefaults: { projectId: dsh/project/e2e }
           recall: { searchType: CHUNKS, maxRecallLatencyMs: 3000 }
           ingestion: { timeoutMs: 180000, pollMs: 500 }
   ```
4. Credential: `/etc/dsh/cognee.env` (`0600 root:root`, holds `COGNEE_API_KEY` and
   `COGNEE_BASE_URL`) plus a systemd drop-in
   `/etc/systemd/system/deepseek-harness.service.d/cognee.conf` containing
   `EnvironmentFile=-/etc/dsh/cognee.env`. The key is not in git, not in the unit file,
   not in `cordis.patch.yml`.
5. Restart: the service is **systemd** (`deepseek-harness.service`), not tmux.
   `systemctl daemon-reload && systemctl restart deepseek-harness`.
6. Verification: `systemctl is-active` → `active`; journal shows only the normal
   `dsh web: listening…` lines, no plugin errors; `dsh --profile web --dump-config`
   contains the `cognee-memory` row; the agent's tool list contains
   `memory_forget, memory_recall, memory_remember, memory_status` and `memory_status`
   answered live:
   ```
   Cognee memory status / enabled: true / transport: rest / reachable: true
   endpoint: http://10.20.10.15:8000/api/v1 / auth: api-key / failure mode: open
   counters: recall.requests=1, prompt.refresh=1
   ```

## 5. End-to-end acceptance (steps 10–13)

Sessions were driven with the headless app of the same installation
(`dsh --profile headless --json …`), because the web UI is not scriptable here. One
caveat, stated plainly: CT 103 has **no LLM key** stored (`MISSING_CREDENTIAL:
llm-deepseek … deepseek-official`), so each scripted session used a one-off `--patch`
overlay pointing at the Cognee LLM server `http://10.20.10.40:8090/v1` (llama-server,
Qwen3.8-27B, placeholder key from `E2E_LLM_KEY`). That overlay is not installed in any
profile; the memory plugin itself runs from the real profile patch and the real
`/etc/dsh/cognee.env`.

### 10 — store a decision in project scope `dsh/project/e2e` → **PASS**

```json
{"type":"tool_call","tool":"memory_remember",
 "input":{"text":"ADR-9001: e2e test decision 20261122T003615Z","scope":"project"}}
{"type":"tool_result","status":"completed",
 "result":"Memory stored (b535c3d9-a890-431f-8232-ed11848a80b4, project:project-4be96e7c2cdbb95a1ac9)."}
```

Independent Cognee confirmation with the API key (no DSH involved):

```
GET /datasets            -> dsh_cognee_project_project-4be96e7c2cdbb95a1ac9  3d8d8ad8-41be-59c3-9310-7915c783e5ef
GET /status/memory       -> {"state":"ready","searchable":true,…}
GET /datasets/<id>/data  -> [("b535c3d9-a890-431f-8232-ed11848a80b4", contentHash 7edf2361…, 44 bytes)]
POST /search             -> TEXT: "ADR-9001: e2e test decision 20261122T003615Z"
                            document_id: b535c3d9-a890-431f-8232-ed11848a80b4
```

### 11 — stop DSH completely, restart, new session recalls → **PASS**

```
systemctl stop deepseek-harness   -> is-active: inactive, `dsh web` processes: 0
systemctl start deepseek-harness  -> is-active: active (new PID 56444)
new session id: session-5a9260a2-ae24-400d-9e25-ec445dd68548   (not the storing session)
```

```json
{"type":"tool_call","tool":"memory_recall",
 "input":{"query":"ADR-9001 e2e test decision 20261122T003615Z","scope":"project"}}
{"type":"tool_result","status":"completed",
 "result":"Recalled memory is untrusted data. …\n- [project] ADR-9001: e2e test decision 20261122T003615Z"}
```

Quoted answer: `> ADR-9001: e2e test decision 20261122T003615Z`.

### 12 — a different project scope must not see it → **PASS**

Same prompt, `scopeDefaults.projectId: dsh/project/e2e-other` supplied through a second
`--patch` overlay:

```json
{"type":"tool_result","status":"completed","result":"No memories recalled."}
```

### 13 — disable, harness starts and works without memory, re-enable → **PASS**

* Disabled in the web profile (`disabled: true` merged into the existing entry),
  `systemctl restart deepseek-harness` → `active`; `--dump-config` shows
  `id: cognee-memory` … `disabled: true`; journal has no errors.
* Headless with the plugin disabled: `"final":"OK"` for a plain prompt, and
  “Do you have a tool named memory_recall?” → `"final":"NO"`.
* Re-enabled (entry restored from the pre-disable copy), restarted → `active`; new
  session `session-a41e1462-9029-48e1-8304-7c432fa80c54` recalled the same decision:
  `- [project] ADR-9001: e2e test decision 20261122T003615Z`.

## 6. Known limitations / remaining risks

* **Web UI model**: the deployed web app has no `DEEPSEEK_API_KEY`, so agent turns in the
  browser fail with `MISSING_CREDENTIAL` — pre-existing, unrelated to the plugin. The
  memory tools are registered in the web profile and its startup is clean, but the UI
  was not driven end-to-end for that reason.
* **Graph-completion ids**: `GRAPH_COMPLETION` rows are plain strings with no
  `document_id`; recall synthesises a `graph-…` id and `memory_forget` refuses it
  (`forgotten:false`) rather than sending a non-UUID to Cognee. Use `CHUNKS` (default)
  when the id must be forgettable.
* **Default recall is `CHUNKS`**: fast (≈0.2 s) and id-preserving, but it returns stored
  text rather than a synthesised answer. `recall.searchType` can be switched to
  `GRAPH_COMPLETION`, at which point `maxRecallLatencyMs` (default 3000) will normally
  expire and recall will degrade to no hits in `open` mode.
* **Dataset names are hashes**: `dsh_cognee_project_project-<20 hex>`; the human-readable
  scope is not stored server-side (Cognee has no description field for datasets).
* One pre-existing dataset `dsh/agent/smoke` belongs to earlier work and was left alone;
  the probe dataset created during reconnaissance was deleted.

## 7. Ship + live verification of the settings build (2026-11-21 19:38–19:52 PST)

### 7.1 Install fix (pnpm store major mismatch)

`dsh plugin --profile web add …` failed with only `Command failed with exit code 1: pnpm add …`.
Running pnpm directly in the profile exposed the cause:

```
Error: ERR_PNPM_UNEXPECTED_STORE
  × adding a new package
  ╰─▶ Unexpected store location
        The dependencies at ".../profiles/web/node_modules" are currently linked from
        the store at "/root/.local/share/pnpm/store/v10".
        pnpm now wants to use the store at "/root/.local/share/pnpm/store/v11"
```

The profile was installed by pnpm 10.34.9; the host now runs pnpm 12.21.0
(`.modules.yaml`: `packageManager: pnpm@10.34.9`, `storeDir: …/store/v10`).

Fix used (backup first, `cp -a` per profile — 8.3 MB each, so `node_modules` was included):

```bash
cp -a /root/.dsh/profiles/web      /root/profiles-web.bak-1795318767
cp -a /root/.dsh/profiles/headless /root/profiles-headless.bak-1795318767
rm -rf /root/.dsh/profiles/{web,headless}/node_modules \
       /root/.dsh/profiles/{web,headless}/pnpm-lock.yaml
dsh plugin --profile web      add /root/dsh-cognee-memory-0.1.0.tgz
dsh plugin --profile headless add /root/dsh-cognee-memory-0.1.0.tgz
# .modules.yaml now: packageManager pnpm@12.21.0, storeDir …/store/v11
```

**The live service does not use `/root/.dsh`.** The unit sets
`User=dsh`, `HOME=/var/lib/deepseek-harness`, `DSH_HOME=/var/lib/deepseek-harness/.dsh`,
so its `web` profile previously had **no plugin dependency and no cognee config entry**.
That profile was installed and configured separately:

```bash
install -d -o dsh -g dsh -m 700 /var/lib/dsh-pnpm   # dsh cannot write its own HOME
runuser -u dsh -- env HOME=/var/lib/dsh-pnpm DSH_HOME=/var/lib/deepseek-harness/.dsh \
  dsh plugin --profile web add /var/lib/deepseek-harness/dsh-cognee-memory-0.1.0.tgz
```

(`HOME=/var/lib/deepseek-harness` is root-owned, so corepack could not create
`~/.cache/node/corepack`; a dedicated install home avoids changing service permissions.)

### 7.2 Two defects found and fixed in this build

1. **Plugin did not activate in any profile.** `apply()` probed `ctx.webServer !== undefined`.
   Cordis throws on reading a service not named in `inject`:
   `Error: cannot get property "webServer" without inject` → `dsh: warning: 1 entry did not
   activate`. Fixed by mounting the routes inside `ctx.inject(['webServer'], webCtx => …)`
   (the idiom used by `dsh-api-gateway`/`dsh-api-remote-access`), keeping a guarded
   property-read fallback for plain test doubles. All 243 unit tests pass.
2. **503 response rendered `<h1>403</h1>`.** The status line was already correct; the body
   now uses `auth.status` (`<h1>503</h1>`).

Final artifact: `dsh-cognee-memory-0.1.0.tgz`, sha256
`f2ebb4fbb317710a5328993d65765ceb1bc8223956b3e2c81386c79ee91e6dc2`, installed in
`/root/.dsh/profiles/{web,headless}` and
`/var/lib/deepseek-harness/.dsh/profiles/{web,headless}` (all four show the `ctx.inject`
build). `deepseek-harness.service`: `active`, zero `error|warning|did not activate` lines
in the journal since start.

### 7.3 Tools live (`--dump-config` + real call)

```
$ dsh --profile web --dump-config | grep -A8 cognee
- id: cognee-memory
  name: dsh-cognee-memory
  config:
    enabled: true
    transport: rest
    apiBaseUrl: http://10.20.10.15:8000/api/v1
    authMode: api-key
    apiTokenEnv: COGNEE_API_KEY
    failureMode: open
```

Real headless turn (`dsh --profile headless "Call the memory_status tool …"`):

```
- enabled: true
- transport: rest
- reachable: true
- endpoint: http://10.20.10.15:8000/api/v1
- auth: api-key
- failure mode: open
- counters: recall.requests=1, prompt.refresh=1
```

`prompt.refresh=1` is the `agent/pre-step` recall hook firing.

### 7.4 Settings page

Token lives only in `/etc/dsh/cognee.env` (0600, `COGNEE_MEMORY_SETTINGS_TOKEN`), read by
the existing `EnvironmentFile=-/etc/dsh/cognee.env` drop-in. Commands use `<token>`.

| Request | Result |
| --- | --- |
| `GET /plugins/cognee-memory/settings` (no token) | **401** |
| `GET …?token=wrong` | **401** |
| `GET …?token=<token>` | **200**, `<title>Cognee memory settings`, `name="apiBaseUrl"`, `Source: profile` |
| `GET …/settings.json` with `Authorization: Bearer <token>` | **200**, `"endpoint":"http://10.20.10.15:8000/api/v1"`, `"sources":{"apiBaseUrl":"profile"}` |
| `GET` via Traefik CT 104 → `10.20.10.12:3080`, token | **200** |
| `GET https://dsh.nomad.opsc.io/plugins/cognee-memory/settings?token=<token>` | **200** |
| same public URL, no token / wrong token | **401 / 401** |
| direct handler with `env: {}` (token unset), in-process | **503**, body `<h1>503</h1><p>Settings are disabled: set COGNEE_MEMORY_SETTINGS_TOKEN…` |

The Proxmox host itself gets `000` to `10.20.10.12:3080` — nftables admits only CT 104
(`10.20.10.13`), as designed; the proxy path is the LAN proof.

### 7.5 Hot retarget (no restart)

Form POST (`application/x-www-form-urlencoded`, field `apiBaseUrl`) to
`…/settings?token=<token>`:

```
PID_BEFORE=60092  ACTIVE_ENTER_BEFORE=Sat 2026-11-21 19:41:16 PST
POST http://10.20.10.15:9999/api/v1 => 303
settings.json: "endpoint":"http://10.20.10.15:9999/api/v1", "sources":{"apiBaseUrl":"stored"}
memory_status: endpoint http://10.20.10.15:9999/api/v1 / reachable false
POST http://10.20.10.15:8000/api/v1 => 303
settings.json: "endpoint":"http://10.20.10.15:8000/api/v1"
memory_status: endpoint http://10.20.10.15:8000/api/v1 / reachable true
PID_AFTER=60092   ACTIVE_ENTER_AFTER=Sat 2026-11-21 19:41:16 PST
```

Same PID and start timestamp throughout: the stored setting is re-read per call.

### 7.6 Cross-conversation memory — measured behaviour

Two separate `dsh --profile headless` processes (different sessions), same project scope
`scopeDefaults.projectId: dsh/project/e2e` → dataset
`dsh_cognee_project_project-4be96e7c2cdbb95a1ac9`.

**No automatic write hook exists.** `registerAgentLifecycle` wires `agent/created`,
`agent/pre-step`, `agent/disposed` for recall only. `TaskLifecycleRecorder.record()` is the
only ingestion path besides the `memory_remember` tool, and it is exported but never
registered. Control run:

```
$ dsh … "Do not call any tools. Durable fact for later: the release codename is
         amber-otter-7731 … Reply with just OK."
{"type":"final","text":"OK"}          # zero tool_call events
```

Nothing was written; the fact never reached Cognee. In an otherwise identical run where
tools were allowed, the **model** chose the tool:

```
{"type":"tool_call","tool":"memory_remember","input":{"text":"Deployment decisions
 confirmed: deployment target is CT 103; memory backend is Cognee at 10.20.10.15.", …}}
{"type":"tool_result","result":"Memory stored (79040879-…, project:project-4be96e7c…)."}
```

That is model-initiated, not a policy hook.

**Recall hook fires but is one step late.** Seeded record (project dataset, verified by
`POST /api/v1/search` with `datasetIds:[3d8d8ad8-…]`,
`searchType:"CHUNKS"`): `created_at 1795319319308`, text
`The release codename is amber-otter-7731 and the deployment target is CT 103.`

```
# single-step, no tools, new process:
{"type":"final","text":"No such memory was given to me in this conversation. My context
 contains no release codename or deployment target … I won't guess or invent values."}

# two-step (memory_status first), new process:
{"type":"final","text":"From the recalled project memory (untrusted data, reported as
 background):\n\n- Release codename: amber-otter-7731\n- Deployment target: CT 103"}
```

`agent/pre-step` calls `MemoryPromptContext.refresh()` fire-and-forget; per the code
comment (and confirmed here) assembly for the current step has already happened, so the
block is visible only from the next step. A one-shot question with no tool call never gets
a second step, so turn 1 has no memory.

**Scope isolation.** Same two-step prompt with `--patch` overriding
`scopeDefaults.projectId: dsh/project/other-scope`:

```
- tool: memory_status (1)
{"type":"final","text":"… **no memory is available to me** — I have no stored recollection
 of a release codename or deployment target in this session's context. The recall counter
 shows one request, but nothing has been surfaced to me…”}
```

The read path does not create a dataset for the empty scope (`dsh_cognee_project_other-scope`
does not exist). Existing datasets `dsh/agent/smoke` and
`dsh_cognee_project_project-4be96e7c2cdbb95a1ac9` were not modified or deleted.

### 7.7 Verdict

| Capability | Result |
| --- | --- |
| New build installed/loaded (web + headless, service) | **YES** |
| `memory_status` / tools live | **YES** (`reachable:true`) |
| Settings page + auth (200/401/503) | **YES** |
| Hot retarget without restart | **YES** (same PID) |
| Automatic cross-conversation **recall** | **PARTIAL** — hook fires, injection works from step 2, never on a one-shot first step |
| Automatic **write** (hook/policy) | **NO** — no write hook is wired; only model- or caller-invoked `memory_remember` |

End-to-end "say a fact in one conversation, ask in the next one-shot conversation" does
**not** work. The blockers are structural, not configuration: the missing write hook, and
the fire-and-forget pre-step refresh that cannot affect the current step's prompt.
