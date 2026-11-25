# Cognee gaps: code graph, long-term memory model, and what we would build

**Status:** research report, 2026-11-25. Nothing was ingested, cognified, upgraded,
deployed, or committed. All Cognee API calls were `GET` only; every write-shaped
claim below is read from the installed package source or the OpenAPI schema, not
from a live write.

Audience: whoever plans the next milestone of `dsh-cognee-memory`. T1 owns
architecture; this document supplies verified capability facts and a prioritised
build proposal.

---

## 0. Method, and one thing that went wrong

The live API was **not reachable during this audit**. CT 106 is wedged:
PID 1 is stuck in uninterruptible I/O sleep, so `pct exec` hangs and the service
answers nothing.

```
$ pct status 106
status: running
$ pct exec 106 -- /bin/true          # rc=124 (timed out)
$ pct exec 106 -- sh -c 'echo probe_ok'   # rc=124
$ grep -E '^(Name|State|Threads|VmRSS)' /proc/3894420/status
Name:	systemd
State:	D (disk sleep)
$ curl -s --max-time 6 -o /dev/null -w "%{http_code}" http://10.20.10.15:8000/   # 000 (exit 28)
$ curl -s --max-time 6 -o /dev/null -w "%{http_code}" http://10.20.10.15:3000/   # 000 (exit 28)
$ uptime
 13:09:37 up 147 days, 22:49, 13 users,  load average: 39.19, 36.21, 34.06
```

The `curl` failures were reproduced **from CT 103** (`exit=28`) and **from the
Proxmox host itself** (`000`), so this is not a routing problem from one
container. Both :8000 (API) and :3000 (UI) are dead while `ping` to 10.20.10.15
still succeeds — a hung userspace, not a down network.

Because of that I used two substitute sources, both read-only:

1. **A cached OpenAPI document already on CT 103**, fetched from this server at
   03:28 the same morning:
   ```
   $ stat -c "mtime=%y size=%s" /tmp/oa.json
   mtime=2026-11-25 03:28:24.569027673 -0800 size=396918
   $ python3 -c "...print(d['info']['version'], len(d['paths']))"
   info.version= 1.0.0
   paths= 136
   ```
   The spec's `info.version` is the *document* version (1.0.0), not the product
   version — a distinction this repo already records in
   [MIGRATION.md](MIGRATION.md#L84-L85). That the cache is current is
   corroborated by this repo's own prior live audit, which recorded
   "Live `/openapi.json` — 136 paths"
   ([CONVERSATION_SUMMARIES.md](CONVERSATION_SUMMARIES.md#L139)): same count.
2. **The installed package, read straight off the container rootfs** through
   `/proc/3894420/root/...`, which works even when the container's userspace is
   frozen. Read-only, no mount, no exec inside CT 106.

The container runs from `/opt/stacks/cognee/compose.yaml`:

```yaml
  cognee:
    image: cognee/cognee:latest
    container_name: cognee
    ports:
      - "10.20.10.15:8000:8000"
    volumes:
      - ./data/cognee:/cognee-storage
```

**If the deployment being down is news, that is the first thing to act on.**
Everything below is capability analysis that assumes the service can be revived.
Reviving it is a state change and was deliberately out of scope here.

---

## 1. Verified server capabilities

### 1.1 Version

```
$ grep -E '^(Name|Version):' .../app/.venv/lib/python3.12/site-packages/cognee-1.6.10.dist-info/METADATA
Name: cognee
Version: 1.6.10
```

Installed package is **cognee 1.6.10**, Python 3.12, at
`/app/.venv/lib/python3.12/site-packages/cognee`. The runtime string
`1.6.10-local` (a locally built image) is recorded by this repo from
`GET /health/detailed` and from `dataset_database.cognee_version`
([RECOVERY_MANIFEST.md](RECOVERY_MANIFEST.md#L11-L17)); I could not re-read
`/health` live, so treat `1.6.10` as the package version I verified and
`1.6.10-local` as the deployment's self-reported label.

### 1.2 Routes — all present (from `/openapi.json`, 136 paths)

| Route | Methods | Present | Evidence / note |
|---|---|---|---|
| `/api/v1/remember` | POST | **yes** | multipart; summary "Remember: ingest data and build the knowledge graph (add + cognify + improve)" |
| `/api/v1/remember/entry` | POST | **yes** | "Remember a session entry (QA, trace, feedback) into the session cache" |
| `/api/v1/recall` | **GET, POST** | **yes** | POST "Recall: query memory with auto-routed search type and session-first lookup"; GET "List the caller's recent recall history" |
| `/api/v1/improve` | POST | **yes** | `ImprovePayloadDTO` |
| `/api/v1/update` | PATCH | **yes** | `data_id`, `dataset_id`, `chunk_level_diff` |
| `/api/v1/sessions` | GET | **yes** | params `range,status,limit,offset,order_by,descending` |
| `/api/v1/sessions/{id}`, `/sessions/stats`, `/sessions/cost-by-model`, `/sessions/cost-by-user-agent`, `/sessions/with-agent-info` | GET | **yes** | |
| `/api/v1/permissions/*` | various | **yes** | 15 routes: tenants, roles, capabilities, per-principal datasets |
| `/api/v1/skills`, `/skills/`, `/skills/{skill_id}` | POST, GET, GET, DELETE | **yes** | `SkillIngestRequest{skills_text, skill_name, dataset_name, dataset_id}` |
| `/api/v1/conflicts`, `/conflicts/{conflict_id}/resolve` | GET, POST | **yes** | GET requires `dataset_id` |
| `/api/v1/memify` | POST | **yes** | `MemifyPayloadDTO` |
| `/api/v1/sync`, `/sync/status` | POST, GET | **yes** | `SyncRequest{datasetIds}` |
| `/api/v1/provenance/{anchor,entry/{id},history/{id},export,statistics,status,verify,anchors/verify}` | mixed | **yes** | `history/{entity_id}` = "Version history of one entity" |
| `/api/v1/datasets/{dataset_id}/graph` | GET | **yes** | |
| `/api/v1/search`, `/api/v1/search/history` | POST, GET, DELETE | **yes** | |
| `/api/v1/add`, `/api/v1/cognify`, `/api/v1/forget`, `/api/v1/delete` | POST/DELETE | **yes** | the four we already use/avoid |
| `/api/v1/activity/*`, `/api/v1/visualize/*`, `/api/v1/ontologies`, `/api/v1/datasets/{id}/sparql` | mixed | **yes** | unexamined |

### 1.3 Parameters — the ones that matter

`POST /api/v1/remember` (multipart) properties, verbatim from the spec:

```
- data: array
- raw_data: array|null
- labels, external_metadata, datasetName, datasetId, session_id, node_set
- self_improvement: boolean|null
- run_in_background: boolean|null  default=False
- custom_prompt: string|null       default=''
- chunk_size: integer|null         default=4096
- chunks_per_batch: integer|null   default=36
- ontology_key: array|null
- graph_model: string|null
- content_type: string|null          <-- exists
- import_mode: string|null
- skills_text: string|null
- skill_name: string|null
- index_vectors: boolean|null      default=False
```

`POST /api/v1/recall` (`RecallPayloadDTO`), verbatim:

```
- searchType: SearchType|null      - datasets, datasetIds
- query: string (required)         - systemPrompt (default 'Answer the question using the provided context. Be as brief as possible.')
- nodeType, nodeName              - topK: integer default=15
- onlyContext: boolean default=False
- verbose, includeReferences      - sessionId: string|null
- scope: string|array|null        <-- exists
- toolConnections: array|null      - stream: boolean|null
- toolsTrigger: string default='always'
- codeQuery: object|null          <-- exists
- contextProfile: string default='qa'
- responseSchema: object|null      - retrieverSpecificConfig: object|null
```

`POST /api/v1/improve` (`ImprovePayloadDTO`): `extractionTasks`,
`enrichmentTasks`, `data`, `datasetName`, `datasetId`, `nodeName`,
`runInBackground`, `buildGlobalContextIndex`, **`buildTruthSubspace`**,
**`reviewConflicts`**, `feedbackAlpha`, `sessionIds`.

`SearchType` enum (22 values, verbatim) — note **`CODE`** and `TEMPORAL`,
`SKILLS`, `GRAPH_REPORT`, `BROAD`, `TRIPLET_COMPLETION`, `CHUNKS_LEXICAL`,
`AGENTIC_COMPLETION`, `CODING_RULES`, plus the twelve completion variants we
already knew.

`POST /api/v1/remember/entry` takes a **discriminated union**:
`QAEntry | TraceEntry | FeedbackEntry | SkillRunEntry`, keyed on `type`
(`qa`, `trace`, `feedback`, `skill_run`).

`scope` accepts `graph`, `session`, `code`, `tools`, `auto`, `all`,
`session_first` (counted from `recall.py`).

### 1.4 Deployment configuration (non-secret keys, from `/opt/stacks/cognee/.env`)

```
DB_PROVIDER=postgres
VECTOR_DB_PROVIDER=pgvector
ENABLE_BACKEND_ACCESS_CONTROL=true
LLM_PROVIDER=custom
EMBEDDING_PROVIDER=openai_compatible
```

39 keys total. Notably **absent**: `ALLOW_HTTP_REQUESTS`, `ACCEPT_LOCAL_FILE_PATH`,
`COGNEE_ALLOWED_LOCAL_FILE_ROOTS`, `GRAPH_DATABASE_PROVIDER`.
`GRAPH_DATABASE_SUBPROCESS_ENABLED` is present.

Two corrections to the brief we were given: the deployment sets
`VECTOR_DB_PROVIDER=pgvector` (no LanceDB key anywhere), and the graph has no
explicit provider override — this repo's earlier audit names the graph component
`ladybug` and reports `nodes` = 0 rows in Postgres because the graph is the
embedded Ladybug store ([CONVERSATION_SUMMARIES.md](CONVERSATION_SUMMARIES.md#L156-L161)).

---

## 2. Code graph — verdict

**Verdict: the enola pipeline is fully present in our 1.6.10 install, is
deterministic (no LLM, no embeddings), and is unusable from our API today for
config reasons, not version reasons. No upgrade is required.**

### 2.1 It is really there (package evidence)

```
$ ls .../site-packages/cognee/tasks/code_graph
__init__.py  cluster.py  code_files.py  code_repo.py  enola.py
extract_code_graph.py  models.py  resolve_repo.py

$ grep -ril 'enola' .../site-packages/cognee
cognee/tasks/code_graph/enola.py
cognee/tasks/code_graph/code_repo.py
cognee/tasks/code_graph/resolve_repo.py
cognee/infrastructure/loaders/core/code_loader.py
cognee/memify_pipelines/cognify_code_docs.py
```

The external tool is installed in the image:

```
$ find .../250cace5.../ -maxdepth 5 -name 'enola*'
.../app/cognee/tasks/code_graph/enola.py
.../app/.venv/bin/enola
```

`content_type` is a **two-value literal**, and `"code"` is one of them:

```python
# cognee/api/v1/remember/remember.py:124
content_type: Literal["skills", "code"]
# :1772
if content_type not in (None, "skills", "code"):
    raise ValueError("Unsupported remember content_type. Supported values: 'skills', 'code'.")
```

So `content_type="code"` **exists in our version**. The pi-cognee README's
"≥ 1.5.4" floor is plausible but irrelevant to us: we are on 1.6.10 and need no
upgrade.

### 2.2 It is genuinely LLM-free and embedding-free

```python
# cognee/tasks/code_graph/code_files.py:10
code graph pipeline on it — no LLM or embedding calls.
# :139
"""The cognify CODE-route task list: one adapter task, no LLM stages."""
# :140
return [Task(extract_code_files_graph, needs_llm=False)]
```

```python
# cognee/modules/retrieval/code_retriever.py:1-6 (module docstring)
"""Deterministic queries over an Enola-derived Cognee code graph.
The retriever intentionally uses only the graph adapter.  It does not invoke an
LLM, an embedding engine, or vector search."""
```

Embeddings for code facts are **opt-in and off by default**, which is exactly why
`index_vectors` defaults to `False`:

```python
# remember.py:1778-1779
if index_vectors is not None and content_type != "code":
    raise ValueError("index_vectors is supported only for content_type='code'.")
```

There is one honest caveat the marketing summary omits: **document files inside a
repo** (README, docs) do need an LLM, so they are *skipped* when no LLM key is
present, rather than failing the run:

```python
# code_repo.py:306-311
elif documents and not get_llm_config().llm_api_key:
    "No LLM API key configured (LLM_API_KEY): excluding %d document file(s) of "
    "the code project from processing — their pipelines need an LLM (image "
    ... "unaffected (enola is LLM-free)."
```

We do have an LLM key, so repo docs would be processed too — that part *would*
cost model calls. The symbol/call/import graph itself does not.

### 2.3 The operations are richer than the README claims

`code_query` is not described in the OpenAPI (it is typed `object`), so the
operation set has to be read from the retriever. The README lists six; the
server has **fifteen**:

```python
# cognee/modules/retrieval/code_retriever.py:90-106
_OPERATIONS = {
    "query_facts", "explore", "traverse", "find_path", "impact_analysis",
    "insights", "architecture", "delta", "capabilities", "search",
    "neighbors", "subgraph", "flows", "hubs", "ask",
}
_UNDRAWABLE_OPERATIONS = {"capabilities", "search", "flows", "hubs", "ask"}
```

Recognised argument names in that module: `operation`, `seeds`, `repo`, `depth`,
`max_depth`, `node_types`, `relation_types`, `kinds`, `symbol`, `source`,
`target`, `from`, `to`, `path`, `question`, `limit`.

Node model (`tasks/code_graph/models.py`): `CodeRepository`, `CodeModule`,
`CodeSymbol`, `ApiEndpoint`, `StorageResource`, `ExternalDependency`,
`CodeService`, `CodeTestReference`, `CodeFileReference`, `CodeInsight`,
`CodeFlow`, `CodeIntent`, `CodeExtractionAccount`, `CodeAssociation`,
`CodeLintFinding`. So "what calls X" (`neighbors`/`traverse`), "what breaks if I
change X" (`impact_analysis` on `seeds`), and "how does a request reach the DB"
(`flows`, `find_path`) are all answerable.

### 2.4 The exact request shape that would work

Ingest one repo, deterministic graph only, no vectors, no LLM on the symbol path:

```
POST /api/v1/remember            multipart/form-data
  raw_data        = https://github.com/<org>/<repo>.git   (one entry per repo)
  content_type    = code
  datasetName     = code-<repo>          (our choice; see 2.6)
  index_vectors   = false                 (default; keep it)
  run_in_background = true
```

Then query:

```
POST /api/v1/recall              application/json
{
  "query": "what breaks if I change UserService",
  "scope": ["code"],
  "codeQuery": { "operation": "impact_analysis", "seeds": ["UserService"] },
  "onlyContext": true,
  "datasetIds": ["<code dataset id>"]
}
```

`scope` **must** contain `"code"`; the server refuses otherwise, with a message
worth quoting because it documents the contract:

```python
# recall.py:601-608
if code_query is not None and "code" not in sources:
    raise CogneeValidationError(message=(
        "code_query requires the 'code' scope — pass scope=['code'] or "
        "scope=['graph', 'code'] ('code' is never implied by 'auto' or 'all')."),
        name="InvalidCodeQueryError")
```

Because I could not reach the live server I did **not** get the 422 probe that
would prove this at runtime. The schema field (`content_type`, `codeQuery`,
`scope`) plus the literal type plus the operation table is stronger evidence than
a 422 anyway, but it is not the same thing, and §5 says so.

### 2.5 Two config gates stand between us and this — and they are closed

Both ingestion routes are refused on our server as configured.

**Git URL** needs `ALLOW_HTTP_REQUESTS`; it is unset, and unset means *deny for
API callers*. From `cognee/tasks/web_scraper/ssrf_protection.py`:

> `ALLOW_HTTP_REQUESTS` gates outbound URL fetching and remote repository
> cloning. Unset or blank, API requests are refused and SDK/CLI/MCP calls are
> allowed. … only `true`, `1`, `yes` or `on` enable fetching, any other value (a
> misspelling included) disables it.

and the refusal it raises (403 `SSRFProtectionError`):

> Outbound HTTP requests are disabled by default for API requests because
> ALLOW_HTTP_REQUESTS is unset. … Set ALLOW_HTTP_REQUESTS=true in the Cognee
> environment (on the server for API calls) to enable URL ingestion and remote
> repository cloning.

**Even with that flipped, an internal git host will not work.** The same module
resolves the hostname and rejects the request if *any* resolved address is
loopback, private, link-local, reserved, multicast or unspecified. A repo served
from `10.20.10.x` (or from the Mac over the LAN) is a private address and is
blocked by design. Practical options are therefore: a **public** git URL, or a
**local path inside CT 106**.

**Local path** requires `ACCEPT_LOCAL_FILE_PATH` for local-file ingestion (unset
here), and containment inside `COGNEE_ALLOWED_LOCAL_FILE_ROOTS` *only when that
is set* (also unset here):

> Repo specs can arrive from outside the SDK (CLI arguments, API callers), so
> local paths take the same containment check as ingestion's local-file reads
> (enforced only when `COGNEE_ALLOWED_LOCAL_FILE_ROOTS` is set).
> — `resolve_repo.py:330-333`, and its refusal at :336:
> `Repository path '{spec}' is outside the allowed local roots. Add its root to COGNEE_ALLOWED_LOCAL_FILE_ROOTS to index it.`

Since `COGNEE_ALLOWED_LOCAL_FILE_ROOTS` is unset, the containment check is a
no-op; whether the code path *also* enforces `ACCEPT_LOCAL_FILE_PATH` (the router
docstring says local paths require it) is something I could not exercise —
flagged in §5.

**Net:** enabling the code graph is a two-line `.env` change plus a container
restart, i.e. a deployment action, not a code change. I did not perform it.

### 2.6 Local path vs git URL — and that dataset-name claim

`resolve_repo.py` accepts both; clones land under
`BaseConfig.repos_root_directory` (`~/.cognee/repos` by default), are reused
across calls and refreshed with a best-effort `git pull`, and `branch` gives each
branch its own directory.

```python
# remember.py:1814-1818
if not repo_specs or not all(isinstance(spec, (str, _Path)) for spec in repo_specs):
    raise ValueError("content_type='code' expects a repository path or git URL "
                     "(or a list of them) as data.")
```

The README's `codebase-<repo>-<digest>` naming is **not server behaviour** — the
string `codebase-` does not occur anywhere in the package. Per-repo identity is
`data_id = get_unique_data_id(f"code_repo:{identity or directory}", ...)` with
label `code_repo:{directory.name}` (`code_repo.py:324,349`). The dataset name is
whatever the caller passes. If we want `codebase-<repo>-<digest>`, that is a
client-side convention we would implement ourselves.

For us: our repos live on the Mac, not on CT 106. So the realistic path is a
public URL (needs the flag, and only works for public repos), or a deliberate
`git clone` into a directory inside CT 106 mounted at a stable path and passed as
a local path (needs `ACCEPT_LOCAL_FILE_PATH`). Neither is a "just works" today.

### 2.7 What it buys us

- "What calls X / what breaks if I change X" becomes a **deterministic graph
  query with no model call** — cheap enough to run on every turn, unlike our
  current summary+vector path.
- Answers carry no hallucination risk on the *structure* (the graph is extracted
  from syntax), only on the summarising step if we add one.
- It is orthogonal to our existing document memory: separate dataset, separate
  `scope`, so it cannot pollute semantic recall.

Costs and risks: enola parses on CT 106's 2 cores / 4 GB while our ingest queue
already saturates the LLM; the graph write takes the dataset lock
(`dataset_lock`), so a code index concurrent with `cognify` will serialise; and
`delta` needs the `CodeRepository` snapshot id to be meaningful.

---

## 3. Nowledge Mem vs Cognee 1.6.10

Nowledge Mem's own docs are served as markdown, which is what the quotes below
come from (`/docs/...md`). Cognee columns cite the spec or package evidence in
§1–§2.

### 3.1 What Mem's memory model actually is

- **Unit** — a *memory*: Title, Content (markdown), Type, Labels, Importance,
  Created (https://mem.nowledge.co/docs/memories). Eight types: `fact`,
  `preference`, `decision`, `plan`, `procedure`, `learning`, `context`, `event`
  (same page). Importance is 0.1–1.0, default 0.5.
- **Threads** — "your conversation layer … the original flow of what happened in
  an AI session" (https://mem.nowledge.co/docs/threads). Distillation extracts
  memories from a thread, each with its own title/labels/importance.
- **Timeline** — the capture surface and the chronological view; "Type into the
  input at the top and press Enter"
  (https://mem.nowledge.co/docs/memories), and activities appear as
  "Timeline-style events" (https://mem.nowledge.co/docs/nowledge-fs).
- **Graph** — interactive network with a **timeline slider that filters by date**,
  Louvain communities, `RELATES_TO` edges "with their temporal context",
  PageRank/bridges (https://mem.nowledge.co/docs/knowledge-graph).
- **Library** — documents "parsed, split into searchable segments, and indexed",
  searched alongside memories (https://mem.nowledge.co/docs/library).
- **Tree / Nowledge FS** — "path-first layer … everything you know appears in one
  familiar tree" (https://mem.nowledge.co/docs/nowledge-fs). Explicitly early:
  "the mount, source-fragment, SQL/Cypher, replay, and tail phases are still
  being designed" (same page). Their own docs call it "the first public shape".
- **Skills** — "a repeatable way of performing a task, written down so an agent
  can do it the way you would … Every Skill traces back to the work that earned
  it, and every Skill stays off until you turn it on."
  (https://mem.nowledge.co/docs/concepts/skills). Proposed by background
  intelligence when a procedure recurs.
- **Context** — a *preview* of what a connected AI receives: profile, AI
  identity, rules, space, Working Memory, delivered as a "Context Bundle" at
  session start (https://mem.nowledge.co/docs/ai-context).
- **Storage** — thread transcripts are JSONL, one message per line; library docs
  render as markdown (https://mem.nowledge.co/docs/nowledge-fs). Export is
  "Open Knowledge Format (OKF) … an open, vendor-neutral markdown standard"
  (https://mem.nowledge.co/docs/concepts/open-knowledge-format).
- **Local-first** — "a local-first memory and knowledge layer"
  (https://mem.nowledge.co/llms.txt); Mem Vault is "One purchase, a perpetual
  local license. No account, no server, your memory and software stay on your
  machine" (https://mem.nowledge.co/docs/mem-vault). Cloud is opt-in: "One
  graph-powered memory for your AI tools, on your machine or in the cloud. You
  choose what to bring into Cloud." (https://mem.nowledge.co/cloud).
- **MCP** — six tools: `memory_search`, `memory_add`, `memory_update`,
  `memory_delete`, `list_memory_labels`, `read_working_memory`
  (https://mem.nowledge.co/docs/memories).

### 3.2 The lifecycle machinery — this is the interesting part

| Mechanism | What Mem does (verbatim / paraphrase) | Source |
|---|---|---|
| **Consolidation** | "A Crystal is a memory, but a special kind. It is synthesized from three or more source memories that independently touch the same topic … the synthesis is evaluated for quality before anything is created." Not auto-summaries: requires convergence from independent sources. | https://mem.nowledge.co/docs/concepts/crystals |
| **Decay / salience** | Two independent scores. Decay = exponential recency (half-life "measured in weeks") blended with a log frequency boost. Confidence "never decreases", fed by six signals. | https://mem.nowledge.co/docs/concepts/memory-decay |
| **Importance floor** | Decay "will never fall below a minimum threshold tied to the memory's importance level", to prevent "ghost memories". | same |
| **Forgetting** | "The refresh itself never archives, deletes, merges, or rewrites memories." Removal is explicit only; "Forgetting or deletion is always an explicit action." | same |
| **Lifecycle states** | Active / Archived / Removed; "Stored = Active + Archived". Archived happens when superseded, and stays searchable in history. | https://mem.nowledge.co/docs/concepts/memory-lifecycle |
| **Versioning** | EVOLVES: four relations — `Replaces`, `Enriches`, `Confirms`, `Challenges`. Progression vs validation split; labels propagate through progression chains. | https://mem.nowledge.co/docs/concepts/evolves |
| **Contradiction resolution** | Detected, surfaced, **not auto-resolved**: "Automated conflict resolution would require the system to judge which version of your knowledge is 'right.' That judgment belongs to you." | same |
| **Dedup** | Six search strategies; superseded versions dropped from default results; "teaches the agent … when to update an existing memory instead of creating a duplicate". | https://mem.nowledge.co/docs/concepts/search-architecture , /docs/memories |
| **Bi-temporal** | Two independent timestamps per memory: **event time** and **record time**, with explicit date precision ("will not pretend to know the month"). Temporal matching is a ranking boost, "Time is a signal, not a filter." | https://mem.nowledge.co/docs/concepts/search-architecture , https://mem.nowledge.co/docs/use-cases/bi-temporal |
| **Session→thread linking** | "Every result includes a `source_thread_id` when available." | https://mem.nowledge.co/docs/concepts/search-architecture |

### 3.3 Capability matrix: Mem → Cognee 1.6.10 on **our** server

Verdicts are about what the server accepts today, not what upstream Cognee may do
in a newer release.

| # | Capability | Nowledge Mem | Cognee 1.6.10 (ours) | Verdict |
|---|---|---|---|---|
| 1 | Typed memory unit | 8 types, importance 0.1–1.0, labels (docs/memories) | No type/importance field in `remember` or `recall`. We encode type in our pointer header. | **ABSENT** |
| 2 | Importance / salience score | explicit field driving ranking | no such field in `RememberEntryRequest`, `RecallPayloadDTO`, `SearchPayloadDTO` | **ABSENT** |
| 3 | Decay ranking | recency + frequency, daily recalc | not exposed in any payload; unverified internally | **ABSENT** (verifiable surface) |
| 4 | Consolidation across sources | Crystals, 3+ sources, quality-gated | no crystal concept; `improve.enrichmentTasks` + `buildGlobalContextIndex` are the nearest knobs, semantics unverified | **ABSENT / must build** |
| 5 | Contradiction handling | `Challenges` links, surfaced not resolved | routes exist: `GET /conflicts?dataset_id=`, `POST /conflicts/{id}/resolve`, `improve.reviewConflicts`, `buildTruthSubspace` | **EXISTS, unexplored** |
| 6 | Version chains / supersede | EVOLVES `replaces`/`enriches` | `GET /provenance/history/{entity_id}` = "Version history of one entity"; `update` PATCH exists | **PARTIAL** |
| 7 | Bi-temporal facts | event time + record time + precision | `TEMPORAL` SearchType exists; **no** valid_from/valid_to or as-of parameter anywhere in the spec | **PARTIAL → ABSENT** |
| 8 | Chronological timeline | first-class Timeline view + graph slider | nothing chronological on the retrieval side; `GET /sessions?order_by=&descending=` orders *sessions*, not facts | **ABSENT** |
| 9 | Session/thread capture | Threads, exact turns, `source_thread_id` | `POST /remember/entry` (QA/Trace/Feedback/SkillRun) + `recall` `sessionId` + `scope=["session"]` | **EXISTS, unexplored** |
| 10 | Thread distillation → memories | explicit "Distill" action | `improve(sessionIds=[...])` "optionally bridging sessions into it" | **EXISTS, unexplored** |
| 11 | Knowledge graph query | graph UI, Louvain, RELATES_TO, PageRank | `GET /datasets/{id}/graph`, `visualize/*`, `GRAPH_*` search types; no PageRank/community API | **PARTIAL** |
| 12 | Document library | Library, parsed + chunked + cited | `add`/`remember` documents + `CHUNKS` search — what we already do | **EXISTS (ours)** |
| 13 | Tree / path-first FS | Knowledge Tree over Nowledge FS (early: mount/SQL/replay "still being designed") | no filesystem-over-memory concept | **ABSENT** |
| 14 | Skills | proposed procedures, off until enabled | `POST /skills`, `GET /skills/`, `SearchType.SKILLS`, `content_type="skills"`, `skill_improvement` | **EXISTS, unexplored** |
| 15 | Context packing per task | Context Bundle + Working Memory, previewed | `onlyContext`, `topK`, `systemPrompt`, `contextProfile='qa'` — knobs, not a policy; packing is ours (`context-format.ts`) | **PARTIAL** |
| 16 | MCP interface | 6 tools | `cognee_remember`, `cognee_recall`, `cognee_forget`, `cognee_status` via our adapter; server-side MCP tools unspecified | **EXISTS** |
| 17 | Multi-agent sharing / grants | Spaces, AI identities, Cloud teams | 15 `/permissions/*` routes, tenants/roles/capabilities, EBAC on | **EXISTS, unexplored** |
| 18 | Local-first | yes, Mem Vault perpetual license | fully self-hosted on CT 106 | **EXISTS** |
| 19 | Portable export | OKF markdown bundle | `provenance/export`, `datasets/{id}/data/{data_id}/raw` | **PARTIAL** |

**The honest summary:** Mem's differentiators are not its *retrieval* — we can
match that — they are its **memory lifecycle** (typed + scored + aged + versioned
memories) and its **chronological spine** (timeline/threads). Cognee 1.6.10 has
lifecycle *substrate* we have never touched (conflicts, provenance history,
improve/truth-subspace, skills, session entries) but almost none of it is
lifecycle *policy*. Nobody in Cognee assigns importance, decays anything, or
orders facts by time.

---

## 4. Build plan

Ordered by value per unit of risk. Column "cost" = model calls introduced.

### 4.0 Already there, just wire it

| Item | Endpoint / seam | Work | Cost |
|---|---|---|---|
| **Code graph** | `POST /remember` `content_type=code`; `POST /recall` `scope=["code"]` + `codeQuery` | flip `ALLOW_HTTP_REQUESTS` (public URL) or `ACCEPT_LOCAL_FILE_PATH` (local path); new tool + queue kind | **none** (enola is LLM-free; embeddings off) |
| **Session/trace tier** | `POST /remember/entry`; `recall` with `sessionId` + `scope=["session"]` | new queue task; map our segments to `QAEntry`s | none |
| **Consolidation pass** | `POST /improve` with `sessionIds`, `enrichmentTasks`, `reviewConflicts` | new queue kind, debounced | **LLM** |
| **Contradiction review** | `GET /conflicts?dataset_id=` → `POST /conflicts/{id}/resolve` | read-only surface first, then resolve | LLM only on resolve |
| **Entity version history** | `GET /provenance/history/{entity_id}` | replace part of our hand-rolled `provenance-index.ts` | none |
| **Chronological ordering** | *none needed* — sort locally by `(timestamp, turn_index)` already stored | change `recall.ts` post-processing | none |
| **Skills** | `POST /skills`, `SearchType.SKILLS` | later; unclear payoff for us | LLM |

### 4.1 (a) Code graph for the repos we work in — **highest value**

Would answer "what calls X / what breaks if I change X" deterministically, which
we can afford to run on *every* turn, unlike our summary path.

1. **Deployment prerequisites** (must be a deliberate ops change, not smuggled in):
   - public remotes → `ALLOW_HTTP_REQUESTS=true` in `/opt/stacks/cognee/.env`;
   - private/local repos → clone into CT 106 (e.g. `/srv/repos/<name>`) and set
     `ACCEPT_LOCAL_FILE_PATH=true`; optionally `COGNEE_ALLOWED_LOCAL_FILE_ROOTS=/srv/repos`.
   - Restart the `cognee` container. Note the SSRF guard means an internal git
     host is blocked even with the flag on — local path is the only route for
     internal repos.
2. **New config** (`src/config/schema.ts`): `codeGraph: { enabled, repos: string[],
   dataset: string, defaultOperation }`.
3. **New queue kind**: `'code'` in `QueueKind = 'turn' | 'summary' | 'code'`
   (`src/queue/store.ts:51`), so repo indexing is retried/idempotent like the rest.
4. **New adapter path** in `cognee-paths.ts`: `recall` already exists; add
   `codeRecall` and a `rememberCode()` that posts multipart with
   `content_type=code`, `index_vectors=false`.
5. **New tool** `memory_code_query` in `src/tools/` — deliberately a *tool*, not
   prompt injection: it is only called when the agent asks a structural question,
   so it costs nothing on ordinary turns.
6. **Prompt seam**: none by default. If we later auto-inject, put it behind the
   existing bounded block in `prompt-context.ts`, never unbounded.
7. **Risk**: enola CPU on 2 cores; `dataset_lock` serialises against `cognify`;
   stale graphs after branch changes (`delta` needs snapshot ids).

### 4.2 (b) Session cache + traces vs our summary-document approach

**Verdict: build it, but as a *complement* to summaries, not a replacement.**

What we do now: LLM-summarise each segment, ingest the summary as a document with
a `[[dsh-memory-pointer]]` header, retrieve by vector similarity. Cost: one LLM
call per segment (~35 s each per [ACCEPTANCE.md](ACCEPTANCE.md#L73-L76)), and the
summary is lossy by construction — it is a *narration of* turns, not the turns.

What `/remember/entry` + `/recall` offer: a session cache holding `QAEntry` /
`TraceEntry` records keyed by `sessionId`, recallable with `scope=["session"]`
and `sessionId`, short-circuiting the graph. Deterministic, no summarisation, and
the entry is the turn.

For "recall everything, with a link to the exact turn range", the session tier is
**better on fidelity and cost** and worse on cross-session semantic reach (a
session cache answers about *that* session). So:

- keep summaries for cross-session semantic recall (that is what fixed Q1–Q3 in
  ACCEPTANCE);
- add `/remember/entry` per turn for exact-turn recovery inside a session;
- our pointer already carries `session_id`, `turn_index`, `char_start`,
  `char_end` — the exact link the requirement asks for, so nothing is lost by
  having both.

Unverified: whether session-cache recall ranks by vector, lexical, or recency,
and whether `includeReferences` returns the turn range. **Do not assume it does**
— that is the first thing to measure when the server is back.

### 4.3 (c) The two known weaknesses

**Weakness 1 — no chronological ordering** ([ACCEPTANCE.md](ACCEPTANCE.md#L52-L69)).
This is *not* a Cognee gap; it is a retrieval-policy gap in our plugin. We already
store `timestamp`, `turn_index`, `char_start`, `char_end` on every row.
Plan: add an intent gate in `recall.ts` — for "in what order", "timeline",
"history", "what happened first" — switch from score-ordering
(`recall.ts:132-135` already sorts by score then `createdAt`) to
`(timestamp, turn_index)` ordering, merge consecutive ranges within a session, and
optionally add a per-day rollup document so a long arc is one hit.
**Cost: zero model calls. Risk: low.** Nothing in Cognee needs to change.

**Weakness 2 — no consolidation/dedup across segments.** Two candidate routes:
1. **Ours** (`src/memory/deduplication.ts` already exists): hash-based dedup at
   ingest — cheap, but only catches exact/near-exact repeats.
2. **Cognee's**: a debounced `POST /improve` with `sessionIds` +
   `reviewConflicts`, then read `GET /conflicts` and resolve deliberately. This is
   the only path to *semantic* merging, at LLM cost, and its semantics are
   unverified — `buildTruthSubspace` in particular is undocumented in the spec.

Recommendation: ship (1) now, prototype (2) behind a config flag and measure
precision before enabling. Do **not** model it on Crystals (3+ independent
sources, quality-gated) until we can afford the evaluation step.

### 4.4 Explicitly out of scope

- Upgrading Cognee: unnecessary — the code pipeline is already in 1.6.10.
- Adopting Mem's decay/importance scoring wholesale: it is a ranking tweak, and
  our failure mode is *ordering*, not ranking. Fix ordering first.
- Knowledge Tree / Nowledge FS: Mem's own docs call the interesting phases
  undesigned; nothing to copy.

---

## 5. What I could not verify

1. **Any live API response.** CT 106 was wedged for the whole session (§0). No
   `/health`, no 422 probe, no `/openapi.json` fetched live. Everything route- and
   parameter-shaped comes from the 03:28 cached spec plus package source. The
   136-path count matches this repo's earlier live audit, which is corroboration,
   not proof.
2. **The 422 route-existence probe** the brief suggested. I chose the stronger
   on-disk evidence instead, but the runtime behaviour of `POST /remember` with
   `content_type=code` is unproven on our box.
3. **Runtime effect of the config gates.** `ALLOW_HTTP_REQUESTS` unset ⇒ API
   refusal is read from `ssrf_protection.py`, not observed. Whether the
   `content_type=code` *local-path* route independently enforces
   `ACCEPT_LOCAL_FILE_PATH` (vs. only the `COGNEE_ALLOWED_LOCAL_FILE_ROOTS`
   containment check, which is a no-op here) is genuinely unresolved.
4. **Whether `SearchType.CODE` is wired to `code_retriever`.** Both exist; the
   binding is inferred from naming and from the `scope="code"` branch, not traced.
5. **`code_query` argument shapes per operation.** I have the 15 operation names
   and the union of accepted argument names, not each operation's required
   arguments (`find_path` vs `traverse` vs `delta` differ). Reading
   `code_retriever.py`'s per-op validators would settle it.
6. **Semantics of `/improve`, `/conflicts`, `buildTruthSubspace`,
   `enrichmentTasks`.** Routes confirmed; behaviour not.
7. **Whether Cognee ranks by recency or importance anywhere internally.** Not in
   any DTO I read; not proven absent from the retriever internals.
8. **Session-cache ranking + `includeReferences` payload shape** — central to
   plan (b), unmeasured.
9. **The `1.6.10-local` runtime string.** dist-info says `1.6.10`; the `-local`
   suffix is this repo's recorded observation, not something I re-read from
   `/health`.
10. **Mem's `/cloud` product page** has no markdown docs variant
    (`/docs/cloud.md` → 404); I read the HTML landing copy only. Same for
    `/integrations` and `/use-cases`, which I skimmed for claims rather than read
    in full.
11. **Mem pricing / plan details beyond Mem Vault** (Free 50-memory cap, Plus,
    Max) come from a single page, https://mem.nowledge.co/docs/mem-vault.

---

## 6. One-paragraph answer

Cognee 1.6.10 already contains everything the pi-cognee README advertises about
code graphs — enola, `content_type="code"`, `scope=["code"]`, `codeQuery` — and
more operations than the README lists (15, not 6), with the LLM-free claim
confirmed in source and the `enola` binary present in our image. **No upgrade is
needed.** What blocks it is two unset env flags plus an SSRF guard that forbids
internal git hosts, i.e. a deliberate ops change. Against Nowledge Mem, Cognee has
the *substrate* for long-term memory (conflicts, provenance history, improve,
skills, session entries, multi-tenant permissions) but almost no *policy*:
nothing types memories, scores importance, decays, versions or orders them by
time. Our two known weaknesses are therefore mostly ours to fix: chronological
ordering is a zero-cost local sort over data we already store, and consolidation
is either hash dedup (now) or a measured `/improve` + `/conflicts` loop (later).
The highest-value next step is wiring the code graph behind a tool, and the
highest-risk fact in this report is that the server was down while we planned it.

---

## 7. Addendum — live re-verification after the server recovered

§5 item 1 said no live API response was obtained because CT 106 was wedged. That
was true for the research session; it is no longer true. After the container was
restarted (see the operational note below), the central claims were re-checked
against the running server at 13:35 PT on 2026-11-25:

```
$ curl -s -H "X-Api-Key: $COGNEE_API_KEY" http://10.20.10.15:8000/openapi.json
openapi 200 396918B
paths: 136
.info.version: "1.0.0"        # server string; package dist-info says 1.6.10
```

**`content_type='code'` is confirmed by the server itself**, not just by package
source — the schema description, quoted verbatim from the live document:

> Set to 'skills' to ingest SKILL.md files as dataset-scoped Skill nodes, or
> 'code' to index whole code repositories (pass git URLs or server-local repo
> paths via 'raw_data') as an architectural code graph through the enola-backed
> pipeline. Leave empty for normal ingestion.

Routes observed in the live spec (all previously inferred from cache + source):

```
/api/v1/remember          /api/v1/remember/entry    /api/v1/recall
/api/v1/improve           /api/v1/conflicts         /api/v1/conflicts/{id}/resolve
/api/v1/skills            /api/v1/skills/           /api/v1/skills/{id}
/api/v1/update            /api/v1/sessions          /api/v1/sessions/stats
/api/v1/provenance/*      /api/v1/permissions/*     (15 routes)
```

So §5 items 1 and 2 are **resolved**: the code pipeline and the lifecycle
substrate are present on our server. Items 3–8 stand — the config gates were not
flipped, `code_query`'s per-operation argument shapes were not exercised, and
`/improve` / `buildTruthSubspace` semantics remain unmeasured.

### Why the server was down, and what it cost

CT 106's PID 1 sat in `D` (uninterruptible I/O) state; `pct exec` hung, the API
answered `000`, `ping` still worked. Host-wide I/O pressure was **77 % `some` /
57 % `full`** with 26 `D`-state tasks and load ~40 — a disk-saturation event, not
a crash. Postgres autovacuum workers and the single gunicorn worker were the
visible consumers, i.e. write amplification from re-ingesting the same corpus
repeatedly (docs, re-summaries, duplicates) plus autovacuum catching up.

Two design facts turned a slow disk into an outage:

1. **Cognee runs one gunicorn worker** (`-w 1`, `-t 30000`). One request stuck on
   I/O blocks the whole API, including `/health` — so every client saw a dead
   server, and our drain's circuit breaker opened and failed whole batches
   (`drained: ok 0 failed 150`, six pipeline runs each ~7 min) while doing nothing.
2. **The drain had three supervisors** (`drain-watch.sh`, a leftover
   `backfill-drain` loop, `finish-reconcile.sh`) plus the nightly systemd unit, so
   concurrent drains fought over the queue lock
   (`queue lock timeout: ...ingest-queue.jsonl.lock`, counted as segment `FAIL`).

Fix applied: stopped every ad-hoc supervisor, kept only
`dsh-cognify-queue.service`, force-restarted CT 106, and let it recover. I/O
pressure went 77 % → **0.4 %**, load 41 → 0.6, `/health` 200 in 26 ms, and the
drain resumed ingesting (**711 → 813 data items in ~15 min**, ledger rows
landing `ok ... 664ms`).

Lesson for the build plan: the code-graph index (§4.1) and any `/improve`
consolidation (§4.3) take the same dataset lock and the same 2 cores / 4 GB, so
they must be **serialised against the drain** — never run concurrently with a
backfill — and the drain must stay single-supervisor.
