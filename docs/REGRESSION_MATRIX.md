# Regression matrix

Every incident this plugin has produced or been bitten by, with the commit that
fixed it and the check that now fails if it comes back. "GUARDED" means an
automated test fails on regression; "PARTIAL" means the guard is a manual script
or checklist gate; "UNGUARDED" means only documentation/process covers it.

| # | Incident | Symptom | Root cause | Fix | Guard | Status |
|---|---|---|---|---|---|---|
| 1 | One-step-late recall | Fresh conversation's first model call has no memory; recall shows up a step later or not at all | Recall was fetched at `agent/pre-step`, after the prompt had already assembled | `0d8891f` prefetch on `agent/inbox/claimed` + awaited `system-prompt/assemble` waterfall | `test/agent-lifecycle.test.ts` (hook wiring, "starts a refresh from the last user text…"); `test/retrieval.test.ts` (two-layer first-turn block); live `test/live/first-turn-live.test.ts`; model-request proof in `docs/FIRST_TURN_PROOF.md` | GUARDED (cold-start miss observed, see below) |
| 2 | CHUNKS distance-vs-score inversion | Nearest memories ranked last / scores backwards | Cognee CHUNKS returns a vector distance (0 = identical); adapter treated it as similarity | `90a5e03` normalise distance to similarity | `test/cognee-rest.test.ts:288` "converts CHUNKS distance scores to similarity and keeps the closest first" | GUARDED |
| 3 | `dsh.bundle` missing | `dsh plugin add` installs the package but no bundle layer composes; no tools/settings | `package.json` lacked `dsh.bundle`, so it was not a profile layer | `68cd5d0` declare `dsh.bundle` → `./cordis.patch.yml` | `npm pack` + clean-home install gate in `docs/RC_CHECKLIST.md` §3 (tarball `package.json` inspected); no unit test | PARTIAL |
| 4 | Root-owned profile EACCES | Service fails to read a profile file; harness unavailable | A file under `$DSH_HOME` written by root (`profiles/headless/cordis.patch.yml` was `root:root`) | `81de0c7` ownership/mode pins; operational `chown -R dsh:dsh` | `test/permissions.test.ts` (ownership + mode verdicts); `scripts/check-permissions.sh` | GUARDED |
| 5 | Service-readable env 0600 | Service cannot read `COGNEE_API_KEY`/model key; recall and model calls fail | `/etc/dsh/*.env` created `0600 root:root` instead of `0640 root:dsh` | `81de0c7` pins the mode and the `install -m 0640` fix | `test/permissions.test.ts` ("accepts 0640 root:dsh", rejects 0600/group unreadable) | GUARDED |
| 6 | Stale Studio key (401) | Model calls return 401 after key rotation; headless/eval fail | `/etc/dsh/llm.env` held a revoked key | No code change — operational rotation (`docs/DEPLOYMENT.md` §8) | None automated | UNGUARDED (documented runbook step) |
| 7 | `memory_recall` non-lossless JSON | DSH rejects the tool value / fields disappear on round-trip | Tool returned `ScopeRef` objects that did not survive strict JSON serialization | `08676fd` project scopes to lossless JSON before returning | `test/tools-lossless-output.test.ts` ("never returns a raw ScopeRef", round-trip check) | GUARDED |
| 8 | Single-DB `pg_dump` defect | Backup restores every dataset row and graph, but every `CHUNKS` search fails (`database "<uuid>" does not exist`) | Cognee keeps one postgres database per dataset; `pg_dump cognee_db` captured only the catalog | `bbf8ee7` full-cluster `pg_dumpall` backup + verify + drill | `scripts/verify-backup.sh` (checks ≥2 `CREATE DATABASE`, `gzip -t`, checksums) and `scripts/restore-drill.sh`; no unit test | PARTIAL |
| 9 | COGX import silent vector failure | COGX import reports success, graph is present, vector search returns nothing | Import runs with `index_vectors=False` or the embedding model is unrecognised (`Qwen/Qwen3-Embedding-8B-GGUF`); status does not reflect vector coverage | No code fix — upstream limitation, documented | `docs/RECOVERY_MANIFEST.md` (verdict + "verify the vector index separately"); no automated check | UNGUARDED (upstream caveat) |

## Re-run

```bash
npx vitest run test/agent-lifecycle.test.ts test/retrieval.test.ts \
  test/cognee-rest.test.ts test/tools-lossless-output.test.ts \
  test/permissions.test.ts test/bundle.test.ts
COGNEE_API_KEY=… npm run test:live        # needs live Cognee, skipped without the key
./scripts/check-permissions.sh            # on CT 103, as dsh
./scripts/verify-backup.sh <backup-dir>   # on the backup host
```

## Notes

- **#1 cold start.** The ordering defect is fixed and proven by a captured first
  request (`docs/FIRST_TURN_PROOF.md`). One cold run still missed: the prefetch
  budget (1500 ms) can expire before a cold Cognee answers, and the run then
  proceeds memory-free by design. Not a regression of `0d8891f`, but a real
  liveness gap; raise `prefetch.timeoutMs`/`retrieval.budgetMs` if it matters.
- **#4 current state.** `profiles/headless/cordis.patch.yml` is now `dsh:dsh 0640`
  on CT 103, so the item flagged in the earlier checklist is resolved.
- **#8 evidence.** Restore drill: 21/21 databases, 20 datasets, 54 items, 4 users,
  2 API keys, six healthy components, known record and `CHUNKS` hit
  (`docs/RESTORE.md`).
- **#9 mitigation.** After any COGX import, run one recall and confirm hits; do not
  trust an import status of `completed`.
