# Cognee 1.6.10-local — integration decision matrix

**Ground truth used:** official docs as of 2026-11-21, whose changelog top entry is **v1.6.10 (2026-11-18)**, plus the docs OpenAPI (`https://docs.cognee.ai/cognee_openapi_spec.json`, API version 1.0.0, 136 paths). The docs therefore describe the named release, not a newer major line. The live instance's `/openapi.json` was probed once and returned **401 from nginx**; per the task, the instance is treated as unreachable and every endpoint/response detail below is docs-derived, not instance-verified.

## D1 — Authentication

**Answer:** Yes, native auth exists over REST, but it is Cognee's own user store (fastapi-users): email/password → JWT, plus per-user API keys. No OIDC/OAuth/SAML/SSO/Authentik login is documented or present in the OpenAPI (only three schemes: `BearerAuth` JWT, `ApiKeyAuth: X-Api-Key`, `CookieAuth`). OAuth in Cognee is for third-party connectors, not for authenticating Cognee users.

- Enable with `ENABLE_BACKEND_ACCESS_CONTROL=true` (default) — `REQUIRE_AUTHENTICATION` inherits it; with EBAC on, auth is forced on. “`ENABLE_BACKEND_ACCESS_CONTROL=true # this is set to true by default`” — https://docs.cognee.ai/setup-configuration/permissions.md ; “Multi-tenant mode … API endpoints require an authenticated user” — https://docs.cognee.ai/setup-configuration/security.md.
- Create user: `POST /api/v1/auth/register` JSON `{email, password}` (returns 201 user; no token) — https://docs.cognee.ai/api-reference/auth/register:register.md. “Exchange email and password for an access token” — https://docs.cognee.ai/api-reference/auth/login.md.
- Get token: `POST /api/v1/auth/login` `application/x-www-form-urlencoded` `username` + `password` → `access_token`, `token_type` (also sets cookie). Use `Authorization: Bearer <jwt>` or cookie.
- API key: `POST /api/v1/auth/api-keys` with a Bearer JWT, body `{name?}` → key; use `X-Api-Key: <key>` (not Bearer). “API keys sent as `X-Api-Key` are not bound to the password” — https://docs.cognee.ai/setup-configuration/security.md.
- Storage: auth/users/API keys/ACL live in the **relational DB**, supported `SQLite, PostgreSQL`; no external identity DB. “The User model defines what gets stored in the SQL database” — https://docs.cognee.ai/core-concepts/multi-user-mode/permissions-system/users.md ; table — https://docs.cognee.ai/setup-configuration/security.md. For a shared multi-process server use Postgres; SQLite is “not a mechanism for sharing the database between multiple Cognee processes” — https://docs.cognee.ai/setup-configuration/relational-databases.md. Set one `FASTAPI_USERS_JWT_SECRET` on every process.
- **Authentik/OIDC:** cannot be plugged in as an IdP. A reverse proxy can front Cognee, but it must still inject a Cognee-issued JWT/API key; Authentik identity never reaches Cognee natively.

## D2 — Authorization

**Answer:** Dataset-scoped ACL with four permissions: `read`, `write`, `delete`, `share`. It is enforced **in the REST API as well as the SDK** (per-dataset DB routing plus permission checks); API keys carry the full user's rights, with no per-key scopes.

- “All permissions in Cognee are defined at the dataset level, never for individual documents” — https://docs.cognee.ai/core-concepts/multi-user-mode/permissions-system/datasets.md.
- Operations: `remember`/`improve`/`add`/`cognify` need `write`; `recall`/`search` need `read`; `forget`/dataset delete need `delete`; granting needs `share`.
- “When enabled, Cognee creates isolated storage per user + dataset combination and enforces permission checks on every read and write operation” — https://docs.cognee.ai/setup-configuration/security.md.
- REST denials are real: “A caller without write permission on the dataset gets 403” — https://docs.cognee.ai/api-reference/conflicts/choose-fact.md ; `GET /api/v1/datasets` returns only readable datasets.
- Grant/revoke: `POST|DELETE /api/v1/permissions/datasets/{principal_id}?permission_name=read|write|delete|share`, JSON body = array of dataset UUIDs. Principal may be user, role or tenant.
- Important: auth alone is not authorization. With `ENABLE_BACKEND_ACCESS_CONTROL=false`, dataset filters are ignored and there is no ACL enforcement.

## D3 — API surface (v1, prefix is `/api/v1`, not `/v1`)

“All Cognee API endpoints use the `/api/v1` prefix … The path `/api` without the version suffix … will return a 404” — https://docs.cognee.ai/api-reference/introduction.md.

| Operation | Method + path | Required / key payload |
|---|---|---|
| Add (low level) | `POST /api/v1/add` | multipart: `data[]` files and/or `raw_data[]` strings; `datasetName` or `datasetId` required; optional `labels`, `external_metadata`, `node_set`, `run_in_background` |
| Remember (add+cognify[+improve]) | `POST /api/v1/remember` | multipart: `data[]` and/or `raw_data[]`; `datasetName`/`datasetId`; `session_id` optional; `run_in_background` |
| Cognify | `POST /api/v1/cognify` | JSON: target via `datasets[]` or `datasetIds[]` (no schema-required field); optional `runInBackground` (default false), `graphModel`, `customPrompt`, `chunkSize`, `ontologyKey`, `chunksPerBatch`, `dataPerBatch` |
| Search | `POST /api/v1/search` | JSON: **`query` required**; `searchType`, `datasets`/`datasetIds`, `topK`, `sessionId`, `onlyContext`, `systemPrompt`, `nodeType`/`nodeName` |
| Recall | `POST /api/v1/recall` | JSON: **`query` required**; same as search plus `scope` (`auto`, `session`, `graph`, `trace`, `session_context`, `code`, `all`), `stream`, `responseSchema` |
| Improve (replaces memify) | `POST /api/v1/improve` | JSON: `datasetName`/`datasetId`; `sessionIds[]`, `buildGlobalContextIndex`, `buildTruthSubspace`, `reviewConflicts`, `feedbackAlpha` |
| Memify (deprecated) | `POST /api/v1/memify` | JSON optional `extractionTasks`, `enrichmentTasks`, `datasetName`/`datasetId`; “Deprecated and removed in the next release. Use `POST /api/v1/improve`” — https://docs.cognee.ai/api-reference/memify/memify.md |
| Delete one data item | `DELETE /api/v1/datasets/{dataset_id}/data/{data_id}` (same receipt as `POST /api/v1/forget` with `datasetId`+`dataId`) | path UUIDs; get `data_id` from `GET /api/v1/datasets/{dataset_id}/data` |
| Delete one dataset | `DELETE /api/v1/datasets/{dataset_id}` | path UUID |
| Delete all owned datasets | `DELETE /api/v1/datasets` | none; only “datasets that user created” (not datasets merely shared with them) |
| Status | `GET /api/v1/datasets/status?dataset=<uuid>&pipeline=cognify_pipeline`; `.../status/progress`; `.../status/memory`; `.../{dataset_id}/processing-status` | query UUIDs / pipeline names |
| Health | `GET /health`, `GET /health/detailed` | none |
| Datasets | `GET /api/v1/datasets`, `POST /api/v1/datasets` | create body `{name}` |

The older `DELETE /api/v1/delete?data_id=<uuid>&dataset_id=<uuid>` is **deprecated** — https://docs.cognee.ai/api-reference/delete/delete.md; use the dataset-data route.

OpenAPI is served: Swagger UI is documented at **`http://localhost:8000/docs`** — https://docs.cognee.ai/guides/deploy-rest-api-server.md. FastAPI's default **`/openapi.json`** is normally served by this app and is the source of the published `/cognee_openapi_spec.json`, but prose names only `/docs`; live confirmation was impossible (401).

## D4 — Native memory primitives (do not reimplement)

**Answer:** Cognee has a real memory model: permanent graph memory, short-term session memory, typed entries, and session-aware recall. A DSH plugin should call these, not build its own store.

- Session: “identified by `(user_id, session_id)` and stores an ordered list of recent interactions”; `remember(data, session_id=...)` writes the cache, `recall(..., session_id=...)` checks it first and falls through to the graph — https://docs.cognee.ai/core-concepts/sessions-and-caching.md.
- Permanent memory: datasets + graph + vectors; `POST /api/v1/remember` without `session_id` runs add+cognify(+improve).
- Typed entries: `POST /api/v1/remember/entry` takes a discriminated union of **QAEntry, TraceEntry, FeedbackEntry, SkillRunEntry** (`qa`, `trace`, `feedback`, `skill_run`), with required `session_id` for qa/trace/feedback — https://docs.cognee.ai/api-reference/remember/remember-a-session-entry-qa-trace-feedback-into-the-session-cache.md.
- Session-scoped recall: `POST /api/v1/recall` with `sessionId` + `scope`; default `auto` is session-first when a session is set; results are tagged `session`/`graph`/`trace`/`session_context`. `GET /api/v1/sessions`, `GET|DELETE /api/v1/sessions/{session_id}` (plus stats/cost routes); `GET /api/v1/datasets/status/memory` reports `ready`/`searchable`.
- Python-side equivalents: `cognee.session.get_session()`, `add_feedback()`, `delete_feedback()`, `delete_session()`, `improve(session_ids=[...])`.
- Object model: User → Agent user (`parent_user_id`) → Dataset → Data item; Session is `(user_id, session_id)` bound to one dataset; `node_set` is a logical tag for retrieval, explicitly **not** an access-control mechanism.
- **Do not build:** session cache/transcript store, conversation-history summarizer, session recall/history endpoints, typed-entry store, feedback store, dataset routing, or a second “memory namespace” abstraction. “Memory namespace” is not a native object — use user/agent identity + dataset (+ session / node_set).

## D5 — MCP

**Answer:** **Not in the documented `cognee/cognee` API image.** MCP is shipped as the **separate `cognee/cognee-mcp` package/image** and run as its own container/service (Compose `--profile mcp`); the API image docs never document an MCP entrypoint. It supports **Streamable HTTP**, not only stdio, and can run in API mode against the shared REST instance.

- “`cognee-mcp` package bundles the full Cognee library” — https://docs.cognee.ai/cognee-mcp/mcp-overview.md ; Docker quickstart uses `cognee/cognee-mcp:main` with `TRANSPORT_MODE=http` — https://docs.cognee.ai/cognee-mcp/mcp-quickstart.md ; Compose runs it as an optional `mcp` profile.
- HTTP: binds `127.0.0.1:8000` by default, endpoint **`/mcp`**; flags `--transport http|sse`, `--host`, `--port`, `--path`; Docker env `TRANSPORT_MODE=http` (or `sse` → `/sse`). “exposes a Streamable HTTP endpoint at `/mcp`” — https://docs.cognee.ai/cognee-mcp/mcp-local-setup.md. The Compose profile defaults to SSE on host port **8001** — https://docs.cognee.ai/how-to-guides/cognee-sdk/deployment/docker-compose-reference.md.
- Tools (7): `remember`, `recall`, `forget`, `code_search`, `cognify_status`, plus discovery `search_tools`/`call_tool`; mode `COGNEE_MCP_TOOL_MODE=default|minimal|all`. No dataset create/list, auth, session-list, or typed-entry tools — use REST for those — https://docs.cognee.ai/cognee-mcp/mcp-tools.md.
- API mode: `--api-url` + `--api-token` (env `COGNEE_BASE_URL`, `COGNEE_API_KEY`), with `--api-auth-scheme x-api-key` required for Cognee-issued API keys on a self-hosted backend; otherwise it sends Bearer and gets 401 — https://docs.cognee.ai/cognee-mcp/mcp-cloud-connection.md. “The API mode requires SSE or HTTP transport” — https://docs.cognee.ai/cognee-mcp/mcp-quickstart.md.
- **Security:** no inbound auth on the MCP `/mcp` or `/sse` endpoint is documented — only Host/Origin DNS-rebinding protection and CORS. Auth is outbound to Cognee. Bind loopback/private and front with an authenticated proxy; one MCP process per tenant/user, since it holds one backend token. HTTP/SSE callers count as network callers (local-file/database ingestion blocked unless enabled).

## D6 — Multi-tenancy for a shared instance

**Answer:** The supported isolation boundary is the **dataset**, not the tenant. Use one Cognee user (or agent sub-user) per app + datasets per app/scope; optionally one tenant per app for blanket grants. Do not use separate instances unless you need independent config/failure domains.

- “The isolation boundary is the **dataset**”; “a ‘workspace’ or ‘tenant’ is not a database boundary” — https://docs.cognee.ai/core-concepts/multi-user-mode/data-isolation-and-multi-tenancy.md.
- Physical per-dataset graph/vector stores require EBAC + a supported handler (`ladybug`, `pgvector`, etc.). Datasets are stamped with the creator's active tenant and that stamp never changes.
- Per-app identity: `POST /api/v1/agents/create?name=...` creates an agent sub-user + API key (`agentId`, `agentApiKey`); parent user inherits grants on agent-created datasets. Good for DSH/desktop apps and a read-only worker — https://docs.cognee.ai/api-reference/agent-management/create-agent-endpoint.md.
- **Read-only tenant:** yes — grant only `read` to the tenant principal on the dataset: `POST /api/v1/permissions/datasets/{tenant_id}?permission_name=read` with `[dataset_ids]`. “When a tenant is granted a permission on a dataset, all users in that tenant automatically inherit that permission” — https://docs.cognee.ai/core-concepts/multi-user-mode/permissions-system/tenants.md ; the supported read-only pattern is “Collaborator gets read-only — nothing else implied” — https://docs.cognee.ai/guides/permission-snippets.md. Caveats: dataset must belong to that tenant; grants are additive with no deny (to downgrade, revoke `write`); active-tenant filter means one recall per tenant; tenant deletion is not supported.
- A narrower read-only worker: dedicated user/agent with `read` on the specific datasets, plus a write-blocking policy at the plugin/proxy; API keys have no scopes.
- Do **not** use `node_set` for isolation: “Not an access-control mechanism” — https://docs.cognee.ai/api-reference/update/update.md.

## D7 — Deletion / update / supersede

**Answer:** Single items can be deleted exactly; documents can be updated in place. There is no soft delete, no undo, and no generic “replace memory entry” API. “Supersede” exists for extracted facts via conflict review, not for arbitrary memories.

- Delete one item: `DELETE /api/v1/datasets/{dataset_id}/data/{data_id}` or `POST /api/v1/forget` `{datasetId, dataId}`; delete dataset: `DELETE /api/v1/datasets/{dataset_id}` or `forget {dataset|datasetId}`; delete all: `DELETE /api/v1/datasets` or `forget {everything:true}`. `memoryOnly:true` clears graph+vectors but keeps raw data.
- Update document: `PATCH /api/v1/update?data_id=<uuid>&dataset_id=<uuid>` multipart `data=@newfile`; “New version of the document that replaces the existing one”; default `chunk_level_diff=true` re-extracts only touched chunks. Response `status` = `incremental|unchanged|full_rebuild|failed` — https://docs.cognee.ai/api-reference/update/update.md.
- Raw text has no filename: changed text is added as a new document, not linked to the old one; identical content is deduped.
- Facts: conflict review in `improve()` keeps old/new facts and marks them `current|superseded|conflicting`; resolve via `POST /api/v1/conflicts/{conflict_id}/resolve` `{datasetId, selectedFactId, reason?}`. “Cognee does not keep old copies of nodes or documents” and “There is no soft delete” — https://docs.cognee.ai/core-concepts/further-concepts/memory-versioning.md.
- Session QA/trace entries are append-only; there is no update endpoint. Correct one with a new FeedbackEntry, or delete the session.

## D8 — Ingestion lifecycle

**Answer:** `add`/`cognify` are **synchronous by default** (`run_in_background=false`); both support background/job mode and expose per-pipeline and per-item status. “Verified ingestion complete” is not a 200 — it is completed pipelines + `ready` memory + `completed == total` items (+ a recall smoke test).

- Cognify: “Whether to execute processing asynchronously. Defaults to False (blocking)” — https://docs.cognee.ai/api-reference/cognify/cognify-low-level:-build-the-knowledge-graph-from-already-added-data.md. Returns `{dataset_id: PipelineRunInfo}` with `status`, `pipeline_run_id`, `data_ids`.
- Pipeline statuses: `pending|running|completed|failed` via `GET /api/v1/datasets/status` (pipelines: `add_pipeline`, `indexing_pipeline`, `cognify_pipeline`, `code_graph_pipeline`); in-flight progress via `/status/progress`; per-item completion via `/{dataset_id}/processing-status` (`total`, `completed`, `pending`, `items`).
- Memory readiness: `GET /api/v1/datasets/status/memory` → `state` `empty|staged|indexing|indexed|extracting|ready|…`, `searchable` and `graph_ready` booleans; `ready` means graph + index are usable — https://docs.cognee.ai/api-reference/datasets/get-dataset-memory-status.md.
- Operational “verified complete”: (1) pipeline status `completed`; (2) memory `state=ready`/`searchable=true`; (3) `completed == total` on processing-status; optionally (4) `POST /api/v1/recall` with `onlyContext=true` or `topK=1` proves retrieval. Background jobs that fail may only surface in these statuses.
- `remember` with `session_id` is near-instant and cache-only; with `self_improvement` it may background an improve pass — completion of the write does not mean graph memory is ready.

## D9 — Embeddings / LLM configuration

**Answer:** Point the LLM at llama-server with `LLM_PROVIDER=custom` (or `llama_cpp` server mode) and an OpenAI base URL ending in `/v1`; point embeddings at llama-server with `EMBEDDING_PROVIDER=openai_compatible` (the engine appends `/v1` if missing). Both must be configured: configure only one and the other defaults to OpenAI, then `add()`/`remember()` fail with `ProviderConfigMismatchError`.

LLM (example; substitute real host/port/model):
```dotenv
LLM_PROVIDER="custom"
LLM_MODEL="openai/<model-id-from-/v1/models>"
LLM_ENDPOINT="http://ai-large:<port>/v1"
LLM_API_KEY="."                 # custom always sends a key; "." for no-auth
LLM_MAX_COMPLETION_TOKENS=16384 # also sizes cognify chunks (~half per chunk)
# LLM_TEMPERATURE=0.0
# LLM_ARGS='{"max_tokens":4096}'
```
- “`LLM_ENDPOINT` is the base URL (usually ending in `/v1`)” and custom requires `LLM_PROVIDER="custom"` — https://docs.cognee.ai/setup-configuration/llm-providers.md. `llama_cpp` server mode likewise uses `LLM_ENDPOINT="http://host:8000/v1"` and `LLM_MODEL="openai/<model>"`.

Embeddings (llama.cpp OpenAI-compatible):
```dotenv
EMBEDDING_PROVIDER="openai_compatible"
EMBEDDING_MODEL="default"       # or the model id your server reports
EMBEDDING_ENDPOINT="http://ai-mid:<port>/v1"
EMBEDDING_API_KEY="no-key-required"
EMBEDDING_DIMENSIONS=768        # MUST match the served model/vector store
# EMBEDDING_BATCH_SIZE=...
```
- The docs' llama.cpp recipe is exactly this; “automatically appends `/v1` to `EMBEDDING_ENDPOINT` if it is missing” — https://docs.cognee.ai/setup-configuration/embedding-providers.md.
- Structured output: default `STRUCTURED_OUTPUT_FRAMEWORK=litellm_native`. For custom/llama.cpp it uses the **JSON-object fallback** (schema injected into the prompt, validated, up to 3 retries), so native function calling / JSON-schema enforcement is **not required**; the server must return valid JSON. If weak, set `STRUCTURED_OUTPUT_FRAMEWORK=instructor` + `LLM_INSTRUCTOR_MODE=json_mode` (or `tool_call`) — https://docs.cognee.ai/setup-configuration/structured-output-backends.md.
- `LLM_MODEL` must include the LiteLLM routing prefix (`openai/…` for custom OpenAI-compatible); a bare id can fail with “LLM Provider NOT provided”.

## Decision matrix

| Capability | Cognee 1.6.10 | DSH plugin |
|---|---|---|
| User accounts, password login, JWT, API keys | **Provides** (own store) | Consume; never store passwords |
| External IdP / OIDC / Authentik / SSO | **Not supported** | Must front externally and still mint Cognee users/keys |
| Per-dataset read/write/delete/share ACL | **Provides**, REST + SDK | Map DSH scopes to datasets; treat Cognee as authority |
| Users, agents, tenants, roles, capabilities | **Provides** | Thin provisioning only |
| Per-key scopes / read-only API tokens | **Not supported** (keys are user-level) | Use separate agent user + read ACL |
| Dataset create/list, health, status | **Provides** | Call; cache ids, not names |
| add/cognify/remember/improve ingestion | **Provides** | Thin adapter; no pipeline |
| Background jobs + progress/completion | **Provides** | Poll status; define “verified complete” |
| search/recall, auto-routing, references | **Provides** | Thin adapter; optional prompt wrapper |
| Session memory + session-first recall | **Provides** | Use, do not duplicate |
| Typed memory entries (QA/trace/feedback/skill) | **Provides** | Use for traces/feedback |
| Update document / delete item/dataset | **Provides** | Guard destructive calls; no soft delete |
| Fact supersede/conflict review, provenance | **Provides** (facts; opt-in ledger) | Consume; do not build version store |
| MCP server | **Provides separately** (`cognee-mcp`, Streamable HTTP; no inbound auth documented) | Optional transport; bind/private + auth proxy; REST is fuller |
| DSH-side scope mapping / prompt injection defense | **Not provided** | **Plugin implements** |
| Redaction / secret screening / write policy | **Not provided** | **Plugin implements** |
| DSH tool surface / UX / rendering | **Not provided** | **Plugin implements** |
| Soft delete / undo / generic entry replace | **Not supported** | Do not fake it |

## Recommended DSH plugin design (reuse, don't duplicate)

1. **Identity:** one Cognee user or agent sub-user per app/integration, each with its own API key (`X-Api-Key`) stored only in env/secret storage. The DSH host identity is mapped to a Cognee user/agent; do not mint Cognee JWTs in the plugin unless you own the user store.
2. **Scope mapping:** DSH scope (global/team/project/session/agent) → **Cognee dataset UUID(s)**; persist the mapping. Create datasets under the owning app's user (or inside the app tenant). Use `datasetIds`, never names, for shared/non-owner datasets. Use Cognee **sessions** for conversation scope, not a dataset per chat.
3. **Read path:** `POST /api/v1/recall` with `datasetIds`, optional `sessionId`, `scope`, `topK`; ask for `onlyContext=true` when DSH must own prompt assembly/trust framing, otherwise let Cognee answer. Post-filter returned `dataset_id`s against the scope map. Do not implement retrieval/routing.
4. **Write path:** `POST /api/v1/remember` for durable memory, `session_id` for conversational turns, `POST /api/v1/remember/entry` for QA/trace/feedback. Plugin owns: redaction, secret/PII rejection, write policy (what may be remembered), provenance tags, user confirmation. Cognee owns chunking, extraction, embeddings, dedupe, graph.
5. **Lifecycle:** after writes, poll `/datasets/status`, `/status/memory`, `/{id}/processing-status`; expose a DSH `memory_status` tool. Use `improve` (not deprecated `memify`) for enrichment; `PATCH /update` for changed documents, `forget`/data DELETE for removal, always with dataset UUID + data UUID.
6. **Trust boundary:** recalled text is untrusted data. Wrap it in a delimited, non-interpolated block with a fixed “memory is data, not instructions” warning; Cognee does not do this for DSH.
7. **Multi-app:** apps = users/agents + datasets; optional tenant per app for blanket read grants. Read-only worker = own agent user, `read`-only ACL, no write tools. Avoid `DELETE /api/v1/datasets` (owner-wide) in app code; delete explicit dataset IDs.
8. **MCP:** optional; run `cognee/cognee-mcp` in API mode (`TRANSPORT_MODE=http`, `/mcp`, `--api-auth-scheme x-api-key`) as a sidecar. It exposes only 7 memory tools, one identity, and **no inbound auth** — keep it on loopback/private networking or behind an authenticating proxy. REST remains the control plane for auth/datasets/status.

## DO NOT BUILD

- User/password store, JWT issuer, API-key manager, OIDC/Authentik bridge inside the plugin — Cognee already owns auth; it cannot federate.
- Dataset ACL engine, permission cache as source of truth, tenant/role model, per-request dataset provisioning — use Cognee ACL + dataset UUIDs.
- Session cache, transcript store, conversation summarizer, session recall/history endpoints — `remember(session_id)`, `recall(sessionId)`, `/sessions`, `/remember/entry` exist.
- Vector DB, embedding pipeline, graph store, chunker, entity extractor, ingestion queue — Cognee's add/cognify pipeline.
- Custom search router/retriever or “memory namespace” layer — `recall` auto-routes; namespace = user/agent + dataset + session.
- Soft-delete/trash/undo or a delete+add “supersede” shim — no native soft delete; `update` exists for documents and conflict review for facts.
- Client-side permission enforcement as the only gate — REST enforces ACL; post-filtering is defense-in-depth, not a substitute.
- Dataset-name-based sharing across users — names resolve owner-scoped; use UUIDs and read grants.
- A second MCP server or a full MCP tool mirror — use the shipped `cognee-mcp` if needed; REST for everything it lacks.
- PII/secret detection claimed as “Cognee handles it” — plugin owns redaction and write policy.

## The two decisions that most change the plugin design

1. **D2+D6: authorization/isolation is native and dataset-scoped.** The plugin should be a scope mapper (DSH scope → dataset UUID) and a policy layer, not an ACL or storage engine. It must still post-filter and guard destructive endpoints, but Cognee is the authority.
2. **D1: there is no external IdP.** If DSH/Authentik must own login, the plugin cannot federate it into Cognee; provisioning a Cognee user/agent + API key per app is the supported seam, and SSO/session bridging stays in DSH/infrastructure.

## Version drift / risks

- Docs' top changelog entry is v1.6.10 (2026-11-18), matching the named instance, but the docs also describe “removed in the next release” behavior (memify, memify task args). Treat `memify` as deprecated and use `improve`.
- Live `/openapi.json` probe returned **401 (nginx)**; no endpoint, response shape, auth posture, or MCP sidecar was verified against the actual container. The proxy may hide `/docs`, `/openapi.json`, and `/health` too.
- Docs prose occasionally uses `/v1/...` (ACL example, status descriptions); the OpenAPI and API intro use **`/api/v1/...`**. Use `/api/v1`.
- `cognee/cognee` vs `cognee/cognee-mcp` are distinct images; a backend-only deployment has no MCP endpoint. MCP versions independently (`cognee-mcp` 0.5.x line), so its tools can drift from the backend API.
- Check the startup `auth posture: ...` log and `ENABLE_BACKEND_ACCESS_CONTROL`: a local instance may run with EBAC off (no auth, no isolation), which invalidates D1/D2 assumptions.
- OpenAPI spec is API 1.0.0; if the image predates/varies from 1.6.10, `remember`/`recall`, status, and memory endpoints may differ. Verify with `GET /openapi.json` once the proxy is fixed.
- `POST /search` and `/recall` require `query`; omitting it is a 400 in current docs, not the placeholder default of older builds.
