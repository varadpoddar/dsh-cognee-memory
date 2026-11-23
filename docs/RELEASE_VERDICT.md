# Release verdict — dsh-cognee-memory 1.0.1

**Verdict: GO** for promoting the 1.0.1 artifact, with the conditions and
residual risks below. This is a **scoped** GO: 1.0.1 changes packaging, backup
and permission tooling; it does not change runtime behaviour, the tool surface,
the settings page or the Cognee wire contract. Nothing was published to npm.

Date: 2026-11-22 · Branch `feature/cognee-persistent-memory` · Artifact
`dsh-cognee-memory-1.0.1.tgz` (366 KB, 292 files, sha256 `ec19b02d…d4fe5`).

## What is proven

| Claim | Evidence |
|---|---|
| The memory block is in the **first** model request of a fresh one-message conversation, with memory tools disabled | `docs/FIRST_TURN_PROOF.md`: request #1 has `Known context:` / `amber-otter-7731` in a `user` runtime-context snapshot; 25 base tools, zero `memory_*`; two independent sessions |
| It is lower-trust context, not a system instruction | same: amber text only in the `user` snapshot; the system message carries the data-not-instructions policy and no fixture text |
| Full test suite green | `npm test` → 50 files, 479 tests, 11.22 s, exit 0 |
| Export/import round-trip on an isolated scope: import, dedupe, conflict marking, export | `2 imported` → `2 deduplicated` → `1 deduplicated + 1 conflict`; export `records: 2`; isolated dataset deleted (`DELETE 200`, 0 leftovers) |
| Backup/restore is real, not theoretical | `docs/RESTORE.md`: 38 s to a serving copy, 21/21 databases, 20 datasets, 54 items, 4 users, 2 API keys, six healthy components, known record via `CHUNKS`; DSH half restores a first turn that answers the fixture |
| Packaging is installable as a bundle layer with `dsh.bundle` | `RC_CHECKLIST.md` §3: `dsh plugin add` → `+2 packages`, `bundles: [… dsh-cognee-memory]`, `--dump-config` composes `- id: cognee-memory` |
| Deployment invariants hold on the live host | service `SubState=running`; `/etc/dsh/*.env` `root:dsh 0640`; `$DSH_HOME/profiles/headless/cordis.patch.yml` now `dsh:dsh 0640` |
| Historic incidents are pinned | `docs/REGRESSION_MATRIX.md`: 9 incidents, 6 GUARDED, 3 PARTIAL/UNGUARDED with named manual gates |

## What is not proven

- **Non-owner credential isolation — BLOCKED.** No test proves that a caller with
  a valid but non-owner credential cannot read or write another principal's
  scopes. Scope authorization is enforced in the plugin (`scopesForIdentity`,
  import `allow-scope`), but the cross-principal denial was not exercised against
  live Cognee. Do not claim "credential isolation verified".
- **Settings page 200/401/503 in a clean `DSH_HOME` — BLOCKED** by a harness
  bootstrap gap (`web-runtime` waits on `webServer` when base/web bundles are not
  installed). Covered instead by `test/settings-*.test.ts` and the live instance.
- **Cold-start first-turn recall is not reliable.** One first-ever run injected
  nothing; recall returned after the 1500 ms prefetch budget and the turn
  proceeded memory-free (open failure mode). Warm latency is 597–664 ms. Cause is
  inferred, not instrumented in that run.
- **Token numbers are estimates.** 314 chars ≈ 79 tokens for the block uses the
  plugin's chars/4 estimator, not the model tokenizer.
- **Coverage percentage — N/A.** No coverage provider is configured; only test
  counts are claimed.
- **Live suite from the repo (`npm run test:live`) was not run** (needs a checkout
  on CT 103 plus `/etc/dsh/*.env`); replaced by an in-container live recall and
  the first-request capture.

## Known limitations

- **Duplicate collapse without sessions.** Dedupe is on the semantic key inside a
  scope; two identical facts written from different sessions with no source refs
  collapse into one record, so provenance multiplicity is lost.
- **8 unrecoverable ledger-only datasets.** `docs/RECOVERY_MANIFEST.md`: the
  ledger knows 13 dataset names, only 5 exist in Cognee; 8 have metadata only (no
  dataset, no raw text, no graph) and cannot be reconstructed. Conversely 13
  Cognee datasets have no ledger entry, so the ledger is not a complete record.
- **COGX vector coverage caveat.** A COGX import can report success while the
  vector index was not populated (`index_vectors=False`, or an unrecognised
  embedding model). Graph-only restores look healthy but `CHUNKS` returns
  nothing. Always verify with a real recall after import.
- **Single-DB dumps are unsafe.** A `pg_dump` of `cognee_db` restores the graph but
  breaks every per-dataset search; only `pg_dumpall` backups are valid (two such
  superseded backups exist on the host and must not be used).
- **Stale Studio key is process, not code.** No automated test covers the 401
  rotation path; it lives in `docs/RUNBOOK.md` §3.

## Top three risks

1. **Cold-start first-turn miss.** A cold Cognee plus a 1500 ms prefetch budget
   yields a memory-free first answer with no error. Mitigation: raise
   `prefetch.timeoutMs`/`retrieval.budgetMs` toward `recall.maxRecallLatencyMs`
   (3000 ms) or warm the endpoint; decide before the next release.
2. **Unverified non-owner credential boundary.** Scope checks are unit-tested but
   not proven against live Cognee with a second principal; a regression here is a
   data-disclosure risk.
3. **Recovery gaps.** Eight ledger-only datasets are unrecoverable, and COGX
   imports can silently lack vectors — an operator can believe memory is backed
   up when it is not. The runbook and `RECOVERY_MANIFEST.md` say so explicitly.

## Conditions

- Do not publish to npm without owner sign-off; no publish was performed.
- Keep the artifact and its sha256 with this verdict; rollback is `git revert` of
  the release commit plus removing the tarball, or the profile-layer removal in
  `ROLLBACK.md`.
- Before the next runtime release, resolve risk 1 and run the non-owner
  authorization test (risk 2).
