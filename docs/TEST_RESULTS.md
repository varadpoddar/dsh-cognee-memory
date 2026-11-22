# Test results — dsh-cognee-memory

Measured on 2026-11-21/22. Numbers are from the commands shown, not estimates.
The live backend is Cognee `1.6.10-local` at `http://10.20.10.15:8000` with
`ENABLE_BACKEND_ACCESS_CONTROL=true`; DSH is `0.2.1-rc.5` on Node `v22.23.5`.

## Unit suite (mocks only)

```bash
npm run typecheck   # tsc --noEmit
npm run build       # tsc -p tsconfig.build.json
npx vitest run
```

| Check | Result |
| --- | --- |
| `tsc -p tsconfig.json --noEmit` | pass, 0 errors |
| `tsc -p tsconfig.build.json` (ESM + .d.ts to `lib/`) | pass |
| Vitest | **31 files / 265 tests passed** (Milestone 1 adds 22 prefetch/assembly cases) |

Adapter tests were rewritten against the observed wire format — real paths, multipart
writes, `searchType`/`datasetIds`/`topK`, grouped search results, dataset-UUID resolution,
`ownerId` guard, status-gated ingestion, and the `maxRecallLatencyMs` budget:

| Test | Assertion |
| --- | --- |
| dataset resolution | `GET /datasets` → `POST /datasets` before any write; body carries `datasetId`, never `datasetName`; header `X-Api-Key`; `multipart/form-data` |
| quirk-2 guard | a same-named dataset owned by another user → `FORBIDDEN`, zero `/remember` calls |
| ingestion gate | memory `staged` ×3 then `ready` → 4 status polls + 1 pipeline poll before success |
| ingestion timeout | never searchable → `TIMEOUT`, write not reported as success |
| search parsing | group shape mapped to the requested scope; foreign dataset dropped; `created_at` epoch-ms → ISO; score clamped; `tags` from `belongs_to_set` |
| recall budget | 600 ms server, 150 ms budget, `open` → `[]`; `closed` → `TIMEOUT` |
| forget | `{datasetId,dataId}` to `/forget`; non-UUID id never sent; no `DELETE` |

## Live suite (real Cognee)

```bash
COGNEE_API_KEY=<redacted> npm run test:live
```

| Test | Measured |
| --- | --- |
| `GET /users/me` + `/health` | 29.7 ms, `status: ready`, `1.6.10-local` |
| `remember` scope A (create dataset + write + pipeline gate) | **3292 ms** |
| `remember` scope B | **3194 ms** |
| `recall` scope A (CHUNKS) | **174.6 ms** |
| `recall` scope B for A's token (isolation) | **168.1 ms**, token absent |
| `forget` one record + search again | **319.2 ms**, record absent |
| Whole file | **8 tests passed** in 11.09 s |

Independent Cognee confirmation during the run: `state:"ready"`, `searchable:true`,
`cognify_pipeline:"DATASET_PROCESSING_COMPLETED"`, `processing-status` `1/1` complete,
and search returned the exact stored text.

## End-to-end on CT 103 (real harness)

See [`LIVE_INTEGRATION.md`](LIVE_INTEGRATION.md) §4–5 for commands and excerpts.

| # | Check | Result | Evidence |
| --- | --- | --- | --- |
| 10 | store decision via `memory_remember` in project scope `dsh/project/e2e`, confirm in Cognee | **PASS** | tool result `Memory stored (b535c3d9-…, project:project-4be96e7c2cdbb95a1ac9)`; `POST /search` returned `ADR-9001: e2e test decision 20261122T003615Z` |
| 11 | stop DSH, restart, new session calls `memory_recall` | **PASS** | `inactive`/0 procs → `active`; new session `session-5a9260a2-…` returned `- [project] ADR-9001: e2e test decision 20261122T003615Z` |
| 12 | different project scope must not recall it | **PASS** | scope `dsh/project/e2e-other` → `No memories recalled.` |
| 13 | disable plugin, DSH starts/works, re-enable resumes | **PASS** | web `active` with `disabled: true`, headless `OK` and `NO` (tool absent); after re-enable, new session `session-a41e1462-…` recalled the decision |

Plugin load in the real `web` profile: `systemctl is-active` → `active`, journal free of
plugin errors, `dsh --profile web --dump-config` contains `id: cognee-memory`, and the
agent tool list showed `memory_forget, memory_recall, memory_remember, memory_status`
with `memory_status` reporting `reachable: true`.

## Not covered

* Browser UI end-to-end: CT 103 has no LLM key (`MISSING_CREDENTIAL`), unrelated to the
  plugin; scripted sessions used a one-off LLM `--patch` overlay (see
  `LIVE_INTEGRATION.md` §5).
* Graph-completion recall id round-trip: those rows have no `document_id`, so `forget`
  intentionally returns `forgotten:false`.
* Concurrent multi-process writes to the same dataset (not exercised).


## Milestone 1 — first-turn retrieval (2026-11-22)

| Check | Result |
| --- | --- |
| `tsc -p tsconfig.json --noEmit` | pass |
| `tsc -p tsconfig.build.json` | pass |
| `npx vitest run` | **31 files / 265 tests passed** |
| `npx vitest run --config vitest.live.config.ts` (live Cognee) | **2 tests passed** — fixture `amber-otter-7731` / `CT 103` returned in 1.10 s; `dsh/project/other-scope` returned empty |
| Real harness, fresh process, 1 user message, 1 response, memory tools disabled | **PASS** — `Release codename: amber-otter-7731 / Deployment target: CT 103`; 1 turn, 1 step, 0 tool events |
| Memory tools absent in that run | **PASS** — `--dump-config` shows `tools: enabled: false`; model listed 25 builtin tools with no `memory_*` |
| Answer is not from config/context | **PASS** — different scope and plugin-disabled runs both answer "I don't have enough context…"; `grep` finds no fixture in any profile/overlay |

Details and exact outputs: `LIVE_INTEGRATION.md` §8.

### New coverage (`test/turn-prefetch.test.ts`, 22 cases)

Budget defaults (300/8/900/1500/1), 8-item and 300-token caps, 900-char query clamp,
claim dedupe, turn invalidation, hard-deadline expiry without stalling, pre-consumed
budget, one retry then degrade, zero-retry mode, empty results, aborted signal,
disabled prefetch, cached reuse across steps, first-assembly injection, unbound agent,
unavailable memory, runtime-context/assistant rejection, cross-agent isolation.

## Milestone 2 + 3 — stable identity and automatic extraction (2026-11-22)

Build sha256 `9710845eac3f65f3a9727f46ddca243462d540bcbba3852ad2ddb48a6b4a37d8`,
installed in the headless and web profiles on CT 103; the service restarted at
21:55 PST. Details, commands, and quoted output: `LIVE_INTEGRATION.md` §9.

| Check | Result |
| --- | --- |
| `tsc -p tsconfig.json --noEmit` | pass, 0 errors |
| `tsc -p tsconfig.build.json` | pass |
| `npx vitest run` | **37 files / 323 tests passed** |
| `npx vitest run --config vitest.live.config.ts` | **3 files / 12 tests passed** (real Cognee, read-only + write-then-delete) |
| One message, `tools.enabled: false`, explicit fact | **PASS** — `tool_events=0`; candidate `mem-803e6be8…` → result `ingested`; `/search` returned the exact text on poll 1 |
| New process, same principal, first response | **PASS** — new session id, `tool_events=0`, answer contained `silver-otter-5520` / `CT 103` |
| Different principal + project | **PASS** — "I don't have that information…" |
| Service restart | **PASS** — `ActiveEnterTimestamp 20:51:48 → 20:55:00`, `active`, zero plugin errors; new process still recalled the fact and Cognee still returned it |
| Agent scope isolation | **PASS** — `dsh-agent-agent-a` searchable; `agent-b` returned "I don't know its exact form…" |
| Global scope deny-by-default | **PASS** — unit: `scopeFromName('global')` throws unless `scopes.allowGlobal`; status namespaces omits `global` |

### New unit coverage

| File | Cases | Focus |
| --- | --- | --- |
| `test/identity.test.ts` | 9 | principal precedence (config → env → authenticated `/users/me`), never session-derived, probe failure/retry, restart-stable namespaces, principal/project/team/agent isolation, global opt-in |
| `test/ephemeral.test.ts` | 6 | session-only writes, lost on a new instance, durable scopes rejected, dedupe, forget by id/text, per-session clear |
| `test/extraction.test.ts` | 20 | all explicit command forms, correction/supersession, canonical keys, idempotency, principal/scope isolation, secrets, sensitivity, transcript/reasoning rejection, private-endpoint table, LLM disabled/default, external endpoint refused, model-inferred mapping, endpoint-down degradation |
| `test/candidate-queue.test.ts` | 8 | durable replay, dedupe across process, failed candidate does not block, forget result, secret refusal, corrupt-line skip, pending cap, 0600 mode/status |
| `test/extraction-service.test.ts` | 5 | extract → queue → ingest without a tool, forget path, replay idempotency, no principal refuses writes, disabled no-op |
| `test/session-extraction.test.ts` | 6 | committed-envelope parsing, awaited `llm/stream` + `turn-stopping` fallback (no duplicate), reasoning/assistant/runtime-context rejection, disposal, exact listener unwind |
| `test/live/identity-live.test.ts` | 2 | live authenticated principal, `/users/me` UUID namespaces, session-independent, no global by default |

The pre-existing M1 suite remains green; only expectations that encoded the old
session-derived agent scope and global-by-default behaviour were updated.

### Not covered

* Implicit LLM extraction against the live Studio endpoint (disabled by default;
  unit tests cover disablement, external-endpoint refusal, mapping, and failure).
* Multi-tenant operation with one shared Cognee API key; the deployment must set
  `identity.principalId` per tenant.
* Automatic retry of `failed` queue entries; they remain visible in
  `memory_status` for manual reconciliation.
