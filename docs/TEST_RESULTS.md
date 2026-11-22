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

## Milestones 4, 5, 6, 9 — the reliability half (2026-11-22)

Build `dsh-cognee-memory-0.1.0.tgz` sha256
`d36af1b51a864376178967d3ff3c4647e4589b7f9d339e6e046fda425eea97f6`,
installed into `/var/lib/deepseek-harness/.dsh/profiles/{web,headless}` on CT 103
(pnpm 12.21.0, store v11); `deepseek-harness.service` restarted and `active`.
The final small fix (first-turn hit metric) was re-packed as the same path and
re-installed by removing each profile's `node_modules`/`pnpm-lock.yaml` first;
the installed `lib/memory/retrieval.js` carries the new comment.

| Check | Result |
| --- | --- |
| `tsc -p tsconfig.json --noEmit` | pass, 0 errors |
| `tsc -p tsconfig.build.json` (`npm run build`) | pass |
| `npx vitest run` | **40 files / 393 tests passed** |
| `npx vitest run --config vitest.live.config.ts` | **4 files / 13 tests passed** (33.5 s; real Cognee) |
| Service after install | `active`, journal free of `error|did not activate` for the plugin |

### Milestone 6 — measured search-type comparison (read-only, existing fixtures)

`test/live/search-type-compare.test.ts`, `topK=8`, 3 runs per strategy, dataset
`dsh_cognee_project_project-4be96e7c2cdbb95a1ac9`:

```
SEARCH-TYPE COMPARISON 2026-11-22T05:11:51.323Z
| strategy         | runs | median ms | p95 ms | items | amber rank | CT103 rank | fixture |
| CHUNKS           |    3 |       165 |    939 |     3 |          1 |          1 | yes     |
| GRAPH_COMPLETION |    3 |      4566 |   5072 |     0 |          - |          - | no      |
| recall           |    3 |       382 |    443 |     1 |          1 |          1 | yes     |
```

A second full-suite run measured CHUNKS 158/173 ms, GRAPH_COMPLETION 6987/7988 ms
(0 items, fixture absent), recall 373/384 ms. **CHUNKS ranks best for our data:
fixture at rank 1, ~27x faster than GRAPH_COMPLETION, which returned nothing for
this dataset.** The coordinator therefore keeps `recall.searchType: CHUNKS` as
the default; the measurement is reproducible rather than assumed.

### Milestone 4 + 5 — unit coverage

| File | Cases | Focus |
| --- | --- | --- |
| `test/outbox.test.ts` | 14 | stable op id, cross-process idempotency, state machine, dataRef required for success, permanent authz never retried, transient backoff then success, maxAttempts exhaustion, lease-expiry recovery, fresh lease untouched, corrupt lines, secret refusal, 0600/0700, bounded secret-free view, candidate version keying |
| `test/extraction-service.test.ts` | 10 (5 new) | outbox complete with Cognee dataRef, `autoWrite:false` drains accepted work, startup recovery of an expired `processing` lease, permanent failure recorded truthfully, transient retry |
| `test/task-lifecycle.test.ts` | 22 | all six record kinds, completion vs failed/blocked, authority+evidence required, commit sha validation, idempotency per task+version+payload, version bump, per-task cap, disabled no-op, verified `subagent/end` + `workflow/agent-end` subscriptions, `lastAssistantMessage` never persisted, listener isolation |
| `test/retrieval.test.ts` | 12 | stable layer reuse/refresh, strict 300+900 token cap, 8-item cap, superseded/revoked/expired filtering, budget expiry without throwing, stable-only failure, first-turn hit/miss, latency/context samples, ledger, source+confidence labels |
| `test/inspector.test.ts` | 11 | toggles+sources, principal/scope inspection, queue/ingestion counts, hit-rate math, p50/p95, context tokens, inventory count/degradation, all nine memory states, recall-verified, no credential material |

`test/prompt-context.test.ts`, `test/turn-prefetch.test.ts`, `test/agent-lifecycle.test.ts`,
`test/settings-http.test.ts`, `test/settings-plugin.test.ts`, `test/plugin.test.ts`
and `test/metrics.test.ts` were updated to the new M6 budget/presentation, the
two new lifecycle listeners, the system-policy section, and the added settings
fields; all their previous 401/401/200/503, escaping, and hot-retarget cases remain.

### Milestone 9 — live inspection numbers (real run)

Probe process (`node` in the installed `web` profile) wrote one fact through the
outbox and recalled it in an isolated project scope, then built the same
inspection the page serves:

```
outbox   pending 0 / processing 0 / complete 1 / failed 0
dataRef  cognee:dsh-project-m4m6-probe-…-#b97bb9fc-74ee-4df5-af00-ad73ecd61339
block    Known context (recalled memory; may be incomplete):
         - [project · medium] the probe marker is probe-marker-… and the host is CT 103
toggles  {autoRecall:true, autoWrite:true}
scopes   principal 05a6c959-3357-4a6d-a52a-1ad79ab16d8e,
         project dsh-project-m4m6-probe-…
queue    {queued:0, ingested:1, failed:0, total:1}
ingest   {succeeded:1, failed:0}
hitRate  {attempts:1, hits:1, misses:0, hitRate:1}
latency  recall {count:2, p50:188 ms, p95:196 ms}
tokens   {last:48, p95:48, total:48}
memory   {count:11, datasets:9, checkedAt:2026-11-22T05:16:14.258Z}
states   {indexed:0, recall-verified:1, …}
```

The authenticated page in the running service (`settings.json`, token-protected)
reported `memory.count: 11`, `datasets: 9`, queue `{ingested: 2}`, and an
`indexed` memory row with its real preview; tokenless GET returned **401**.
Its ingestion/recall panels are per-process and read 0 until that process itself
writes/recalls — the probe numbers above are from a process that did.

### Milestone 4 — live subagent settlement

A real headless run with tools enabled asked the model to spawn one subagent
(prompt: "reply with the single word OK"). The plugin's `subagent/end`
subscription recorded a completion in the isolated project dataset
`dsh-project-m4-task-accept-1795324605`, verified by a CHUNKS search:

```
HIT task subagent:5a891112-a444-4e53-a510-b3fe8e524544 v1: completed — provider spawn
    run ended with stopReason=completed (child 3e9f90c5-…) [evidence: subagent/end:5a891112-…]
```

No assistant text from the child was stored; only the terminal `stopReason`,
run identity, and evidence pointer.

### End-to-end on CT 103 (headless, tools off, isolated scopes)

| # | Check | Result |
| --- | --- | --- |
| 4 | tools-off write `Remember that the acceptance marker is verde-fox-1503 …` | candidate `mem-d88ac993…` → queue `ingested`; outbox op `complete` with dataRef; 0 tool events |
| 5 | new process, same project scope, first response | `- **Acceptance marker:** verde-fox-1503 / - **Target host:** CT 103`, 0 tool events |
| 6 | different project scope | "I don't have any information about an acceptance marker or a target host…" |

### Deferred in this pass (explicitly not run)

* Item-level deletion/correction and consolidation (`DELETE /datasets/{id}/data/{id}`).
* `kill -9` crash injection on the real service. Recovery is covered by unit
  tests over a second outbox instance and an expired lease; not by killing the service.
* Browser UI walk-through; all harness runs were headless/one-shot.

## Regression: `memory_recall` returned `value is not lossless JSON` (0.2.1)

Symptom on CT 103, harness 0.2.1-rc.5, plugin 0.2.0: `memory_status` and prefetch
injection worked, every `memory_recall` call failed with
`Error: tool "memory_recall" returned invalid output: value is not lossless JSON`
(reproduced three times in one headless turn, and once more directly:
`dsh headless "call memory_recall for project scope and show raw output"`).

Diagnosis: the installed build was instrumented with a walker that mirrors DSH's
`isJsonValue` rules and records the first offending path. The tool value itself was
fine except for one path per hit:

```json
{"diagnostics":["value.memories[0].scope.legacyName:nonenum",
                 "value.memories[1].scope.legacyName:nonenum",
                 "value.memories[2].scope.legacyName:nonenum"]}
```

`makeScopeRef` (`src/memory/scopes.ts`) keeps the M1 dataset name on the scope as a
**non-enumerable** own property (`Object.defineProperty(ref, 'legacyName', { enumerable: false })`).
The tools copied `hit.record.scope` / `result.scope` straight into their output.
`JSON.stringify` drops non-enumerable keys, so DSH's lossless check (which requires
every own key to be an enumerable string key) rejects the value even though the
wire text looks correct. `memory_remember` and `memory_forget` had the same defect;
only recall was exercised because it is the read path.

Fix: `scopeValue()` in `src/tools/shared.ts` projects a scope to `{scope, id}`;
`memory_recall`, `memory_remember` and `memory_forget` now use it. No DSH core change.

Evidence after rebuild + reinstall into both profiles + `systemctl restart deepseek-harness`:

```text
# installed value checked against the host's own validator (node on CT 103)
{"value":{"count":1,"memories":[{"id":"mem-1","text":"release codename is amber-otter-7731",
  "scope":{"scope":"project","id":"workspace-demo-project-68dc569cd61ed69d8968"}, …}],
  "dshIsJsonValue":true,"ownKeys":["scope","id"]}

# live harness, new process
- [project] Deployment decisions confirmed: deployment target is CT 103; …
- [project] ADR-9001: e2e test decision 20261122T003615Z
- [project] The release codename is amber-otter-7731 and the deployment target is CT 103.
```

Regression test: `test/tools-lossless-output.test.ts` (5 tests) mirrors the DSH
walker (`test/helpers/lossless-json.ts`) and asserts all three tool values are
lossless, JSON-round-trip stable, and expose exactly `{scope, id}`.
