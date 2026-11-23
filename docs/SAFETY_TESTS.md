# Safety tests — deferred M7/M8 and crash/recovery matrix

Executed **2026-11-23** against the live stack: Cognee `1.6.10-local` on CT 106
(`http://10.20.10.15:8000/api/v1`, `ENABLE_BACKEND_ACCESS_CONTROL=true`) and DSH
`0.2.1-rc.5` on CT 103 (`deepseek-harness.service`). All writes went to datasets
named `dsh/eval/c-<test>-<ts>` (or, through the plugin, the scope-derived
`dsh-project-dsh-eval-c-<test>-<ts>-<hash>`). No production dataset was read for
write, modified, or deleted; `dsh/agent/smoke`,
`dsh-project-dsh-project-e2e-4be96e7c2cdbb95a1ac9`, the recovered-history datasets
and every pre-existing fixture were left untouched.

Every dataset created for this work was deleted at the end (10 datasets, all
`200`; `total=18` again, the pre-work baseline, `remaining_test_datasets=0`). The
credentials used were read from `/etc/dsh/cognee.env` on CT 103; nothing was
copied off-host.

## Method

- **API tests (21, 22, 26, 27)** — `curl` on CT 103 as `dsh`, `X-Api-Key` from
  `/etc/dsh/cognee.env`, `python3`/`jq` for shape checks. Scripts lived in
  `/tmp/dsh-safety-c` (scratch, not committed).
- **Crash tests (23, 24)** — a test-only Node proxy on `127.0.0.1:18099`
  forwarding to Cognee, plus a `--patch` overlay that sets the isolated
  `scopeDefaults.projectId`, `outbox.leaseMs: 2000` and the proxy endpoint. The
  proxy can hold a write **before** forwarding (`hold-before`) or hold the
  `200` **after** Cognee accepted it (`hold-write`), which makes the crash
  window deterministic. A real `dsh --profile headless` runtime (same
  `$DSH_HOME`, same plugin, same outbox) was `kill -9`'d at the marker, then a
  second runtime was started to exercise `ExtractionService.start()` recovery.
  The systemd unit itself was separately `SIGKILL`ed and recovered (below) but
  never had a write in flight, so the write-window evidence comes from the
  headless runtime. That limitation is stated rather than papered over.
- **Settings test (25)** — the live settings page on the running service,
  `POST /plugins/cognee-memory/settings?token=…`, restored in a `trap` so the
  endpoint cannot be left pointing at a dead port.

Overlay used (deleted afterwards; `/var/lib/deepseek-harness/c-safety.yml`):

```yaml
- id: cognee-memory
  config:
    apiBaseUrl: http://127.0.0.1:18099/api/v1
    scopeDefaults: { projectId: dsh/eval/c-c23-<ts> }
    outbox: { leaseMs: 2000 }
    ingestion: { timeoutMs: 180000, pollMs: 500 }
```

## 21. M7 — targeted deletion (PASS)

Dataset `dsh/eval/c-m7-delete-1795399219` (`1c128722-02f7-5272-908c-d20824c74dae`).
Three memories written through `POST /remember` (gate: `memory ready`), then one
deleted by data id:

```bash
curl -X DELETE -H "X-Api-Key: $K" $API/datasets/$DS/data/81c2fbe3-c123-4318-b56b-31ecc6f436d9
```

| Check | Result | Evidence (≤2 lines) |
|---|---|---|
| 3 records after 3 writes | PASS | `count_after_write=3` |
| `DELETE /datasets/{id}/data/{id}` | PASS | `200 {"status":"success",…,"dataRecordFound":true,"deletedNodes":7,…}` |
| Siblings survive, deleted id gone | PASS | `2 records remain`; `deleted data id absent from GET /datasets/{id}/data` |
| `CHUNKS` / `CHUNKS_LEXICAL` | PASS | A and C retrievable, `C21B-…` absent from both |
| `GRAPH_COMPLETION` | PASS | A → `Thursday`; C → `Ninety seconds`; deleted → `Not mentioned in the provided context.` |
| `/recall` | PASS | deleted token absent from the answer |
| No dataset removed | PASS | `dataset count grew by exactly 1 (20 -> 21)`; `dataset … still exists` |

The graph answers are model output, so the assertion is semantic (the deleted
fact must not be answerable) rather than token equality.

## 22. M8 — consolidation through Cognee `improve` (PARTIAL: contradiction PASS, dedupe FAIL)

Dataset `dsh/eval/c-m8-improve-1795399313` (`b7b3b01e-…`): 5 near-duplicate facts
about rack B7 plus 1 contradictory fact (rack C2), six `POST /remember` calls,
then:

```bash
curl -X POST -H 'content-type: application/json' \
  -d '{"datasetId":"…","reviewConflicts":true,"buildTruthSubspace":true}' $API/improve
```

| Question | Result | Evidence |
|---|---|---|
| Is `improve` usable in 1.6.10-local? | PASS | `status: completed`, 5 s, `review_conflicts` stage ran |
| Is the contradiction flagged, not silently overwritten? | PASS | `FactConflict` node, conflict `status: unresolved`, `kind: fixed`, text “B7 by some sources and C2 by others” |
| Do both facts survive with provenance? | PASS | 5 facts, each `status: conflicting`, each with `sources[{chunk_id}]` |
| Does provenance survive the pass? | PASS | 6/6 chunk rows still carry `document_id`/`document_name`; all 6 source records intact (`data=6`) |
| Do duplicates collapse? | **FAIL** | `chunks_after=6 mentions` (same as before), no merged fact node; `build_truth_subspace` stage `skipped, reason=no_session_ids` |

Session-scoped follow-up (`dsh/eval/c-m8-dedupe-1795399378`): five writes that
shared one `session_id` produced only **2** data records before `improve`, and
the pass ended with `conflicts 0` and `review_conflicts … {"entities_failed":1}`.
So the session path deduplicates at ingestion, but it does not produce the
conflict review M8 expects. **Recorded as a product limitation, not worked
around.**

## 23. Crash after the durable enqueue, before Cognee accepted the write (PASS)

Scope `dsh/eval/c-c23-1795399875`, token `C23-1795399875`. The proxy held
`POST /api/v1/remember` *before* forwarding; the runtime was `kill -9`'d on the
hold marker.

| Check | Result | Evidence |
|---|---|---|
| Write was durably queued at the kill | PASS | outbox `state: pending` → `processing, attempts:1`; `records_at_kill=0` |
| Backend never saw it | PASS | proxy `held-before-forward`; dataset absent/0 records |
| Restart recovers exactly once | PASS | recovery `pending, attempts:1` → `processing, attempts:2` → `complete` with `dataRef` |
| No partial, no duplicate | PASS | `records=1 chunks=1`; one `dataRef` |

Raw outbox excerpt (2 of 74 lines):

```text
{"type":"operation","operation":{…,"state":"processing","attempts":1,…}}
{"type":"operation","operation":{…,"state":"complete","attempts":2,…,"dataRef":"cognee:dsh-project-dsh-eval-c-c23-1795399875-…#…"}}
```

## 24. Crash after Cognee accepted, before the acknowledgment (PASS)

Scope `dsh/eval/c-c24-1795399893`, token `C24-1795399893`. The proxy forwarded
the write, got `200`, wrote the marker, and held the response; the runtime was
`kill -9`'d while the client still believed the write was in flight.

| Check | Result | Evidence |
|---|---|---|
| Cognee had accepted exactly one record at the kill | PASS | marker `POST /api/v1/remember 200`; `records_at_kill=1`; outbox `processing` |
| Restart retried the same operation | PASS | `attempts=2`, `state=complete`, same `dataRef` |
| Exactly one record after the retry (idempotency proof) | PASS | `records=1 chunks=1` |

**Duplicates observed: none.** The retry re-sent identical content and Cognee’s
per-dataset `contentHash` dedupe collapsed it (independently shown by test 26),
so the at-least-once outbox behaves as exactly-once here. This is a backend
guarantee on identical bytes, not a plugin-side dedupe of the retry.

## 25. Dead endpoint via the settings page, then live reconnect (PASS)

```bash
curl -X POST -d 'apiBaseUrl=http://127.0.0.1:18099/api/v1&mcpUrl=&enabled=on&autoRecall=on&autoWrite=on' \
  "http://10.20.10.12:3080/plugins/cognee-memory/settings?token=$TOK"   # 303
curl -X POST -d 'apiBaseUrl=http://10.20.10.15:8000/api/v1&…' "…/settings?token=$TOK"  # 303
```

| Check | Result | Evidence |
|---|---|---|
| Retarget persisted | PASS | `settings.json` on disk: `"apiBaseUrl": "http://127.0.0.1:18099/api/v1"` |
| Graceful degradation | PASS | page `200` with `inventory: backend did not answer within the inspection deadline`; `SubState=running` |
| No restart | PASS | `MainPID=86626` before, during and after |
| Reconnect without restart | PASS | after restore, same PID, page `200`, warnings `[]`, readable scopes `2` |
| Restored | PASS | on-disk value back to `http://10.20.10.15:8000/api/v1` |

The live adapter reads `store.current().apiBaseUrl` on every request
(`HttpJsonClient({ endpoint })`), which `test/settings-retarget.test.ts` pins
offline; the run above shows it end-to-end.

## 26. Duplicate write with the same semantic key (PASS)

Dataset `dsh/eval/c-dupe-1795399454`: the identical sentence written twice
through `POST /remember`.

| Check | Result | Evidence |
|---|---|---|
| Records after the second identical write | PASS | `records_after_1=1 records_after_2=1`; one `contentHash` |
| Searchable copies | PASS | `chunk_hits=1` |

The plugin also keys the outbox by `idempotencyKey` (normalized text + scope),
so a duplicate turn never reaches the backend twice; that half is covered by
`test/outbox.test.ts` and `test/candidate-queue.test.ts`.

## 27. Authorization and scope isolation (PASS where testable, one BLOCKED)

| Check | Result | Evidence |
|---|---|---|
| Unauthenticated delete | PASS | `no-key delete=401` |
| Unauthenticated inventory / search | PASS | `datasets=401 search=401` |
| Foreign (invalid) key delete / search | PASS | `bad-key delete=401 search=401` |
| No cross-scope leakage | PASS | searching scope A for scope B’s token: `cross_dataset_hits=0` |
| Cross-dataset data-id delete does not remove data | PASS | `200 {"status":"not_found","dataRecordFound":false}`; `records A=2->2 B=1->1` |
| **Non-owner key → 403/404** | **BLOCKED** | `POST /api/v1/auth/api-keys` only mints a key for the *authenticated* user; the API exposes no user-creation route, and the two pre-existing keys are hashed (`HASH_API_KEY=true`) with unknown plaintext. Minting a second key for the same user would not be a non-owner test, and creating a production user was out of scope. |

Note for the record: the cross-dataset delete answers **HTTP 200** with
`status:"not_found"` instead of `404`. It is a no-op (no record removed), but a
caller checking only the status code would misread it.

## Regression fix — root-owned `cordis.patch.yml` (FIXED)

RC checklist open item 1 was still present on CT 103:
`-rw-r--r-- 1 root root … profiles/headless/cordis.patch.yml`.

```bash
chown dsh:dsh /var/lib/deepseek-harness/.dsh/profiles/headless/cordis.patch.yml
chmod 0640 /var/lib/deepseek-harness/.dsh/profiles/headless/cordis.patch.yml
```

Result: `-rw-r----- 1 dsh dsh …`; `SubState=running`; `scripts/check-permissions.sh`
→ `PASS: all permission invariants hold` (after the fix; the same script is what
flagged the violation). The regression test for this class already existed —
`test/permissions.test.ts` (“fails loudly on a root-owned profile manifest”) and
it was left unchanged.

## Service crash recovery (supporting evidence)

```bash
systemctl kill -s SIGKILL deepseek-harness.service
```

`SubState=auto-restart` for ~4 s, then `running` at t+5 s with `MainPID=108612`;
the plugin settings file still pointed at the production endpoint. No write was
in flight, so this proves unit recovery only — the write-window crash evidence
is tests 23/24 above.

## Regression tests added

`test/safety-crash-recovery.test.ts` (3 tests, offline, no backend):

1. a **completed** operation is not replayed after a restart (fresh `Outbox` on
   the same dir: `recover()=0`, drain calls no sink, `complete:1/total:1`);
2. a **durably queued** (pending, never attempted) operation is drained exactly
   once after a restart, and a third process drains nothing;
3. a **crashed in-flight** (`processing`, expired lease) operation is re-queued
   by the first `recover()` only, and completes with `attempts:2`.

Full suite after the changes: `npx tsc -p tsconfig.json --noEmit` clean,
`npx vitest run` → **50 files / 479 tests passed** (5.4 s).

## Open items / risks

1. **Non-owner credential test is BLOCKED** (see 27); needs a second Cognee user
   and key, which the deployed API does not let an operator mint.
2. **M8 dedupe does not exist without a session** (`build_truth_subspace` skips
   with `no_session_ids`), and the session path flags no conflict. Product
   decision needed; not worked around.
3. Graph-completion answers are LLM output; test 21’s graph assertions are
   semantic (fact not answerable), not token matching.
4. Crash windows were driven through a headless DSH runtime sharing the
   production `$DSH_HOME`; the systemd unit was SIGKILLed separately without an
   in-flight write.
5. Cross-dataset data-id delete returns `200 / not_found` rather than `404`.
