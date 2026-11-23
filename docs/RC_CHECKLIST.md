# Release candidate checklist — 1.0.1

Status: **candidate, not published.** Rows marked PASS were run on 2026-11-22/23;
the evidence command is given so a reviewer can re-run it. `N/A` and `BLOCKED`
are explicit, not silent omissions.

Artifact: `dsh-cognee-memory-1.0.1.tgz`, 366 KB, 292 files,
`sha256 ec19b02dcdd22dc73ba09964f97f62f3c1c6332dd720be54b5bfae7c3d0d4fe5`
(copy kept outside the checkout in `release-candidates/`; `*.tgz` is gitignored).

## 1. Package hygiene

| Gate | Result | Evidence |
|---|---|---|
| `npm pack` from a clean copy succeeds | PASS | `rsync` (no `node_modules`/`.git`/`lib`) → `npm ci` → `npm pack` |
| Tarball contains required files | PASS | `cordis.patch.yml`, `README.md`, `LICENSE`, `CHANGELOG.md`, `lib/index.js`, `docs/ARCHITECTURE.md` present |
| No tests shipped | PASS | `grep -Ei '^test/'` over `tar -tzf` → no match |
| No secrets shipped | PASS | no `.env`, no `.credentials`, no `*.tgz`; the only `secret` paths are the redaction module `lib/security/secrets.*` |
| No `node_modules` | PASS | 292 files, top dirs: `lib` 218, `src` 55, `scripts` 6, `docs` 4 |
| `dsh.bundle` declared | PASS | `{"patch":"./cordis.patch.yml"}` in the packed `package.json` |
| Version stamped | PASS | packed `package.json` → `1.0.1` |

## 2. Build and test

| Gate | Result | Evidence |
|---|---|---|
| Build | PASS | `npm run build` → `tsc -p tsconfig.build.json && node scripts/build-client.mjs`, `built lib/client.js (13402 bytes)` |
| Full suite | PASS | `npm test` → **50 files, 479 tests passed**, 11.22 s, exit 0 (2026-11-22, HEAD `998ebe6` build) |
| Live suite (`npm run test:live`) | N/A here | needs a repo checkout on CT 103 plus `/etc/dsh/*.env`; replaced by a live in-container recall check: `amber-otter-7731` returned in **597 ms**, and by the first-request capture in `docs/FIRST_TURN_PROOF.md` |
| Permission regression suite | PASS | `npx vitest run test/permissions.test.ts` → 10/10 |
| Coverage | N/A | no coverage provider is configured (`vitest run` only); counts above are the full suite. No percentage is claimed |
| Consumer install of the tarball | PASS | fresh `npm init` + `npm install <tgz>` → `version 1.0.1`, `bundle {"patch":"./cordis.patch.yml"}`, `import('dsh-cognee-memory')` exposes `name`, `inject`, `Config`, `parseConfig`, `MemoryCoordinator` |

## 3. Install as a bundle layer (CT 103, clean `DSH_HOME`)

| Gate | Result | Evidence |
|---|---|---|
| Installs outside the source checkout, as `dsh` | PASS | `DSH_HOME=/tmp/dsh-clean-<ts> dsh plugin --profile rc add /tmp/dsh-cognee-memory-1.0.1.tgz` → `+2 packages, done in 1.1s`, `exit=0` |
| Registers in `dsh.profile.bundles` | PASS | `bundles: [dsh-base, dsh-web-app, dsh-cognee-memory]`; dependency recorded as `file:.../dsh-cognee-memory-1.0.1.tgz` |
| Composes as its own bundle layer | PASS | `dsh --profile rc --dump-config` (1234 entries) ends with `# == dsh-cognee-memory` → `- id: cognee-memory` |
| Tools register / settings 200-401-503 in the clean home | **BLOCKED** | the freshly generated profile does not boot in an empty home: `web-runtime` waits on `webServer` (base/web bundles are not installed by `--from-default-profile` in this build). Harness bootstrap gap, not a plugin defect; route behaviour stays covered by `test/settings-*.test.ts` and the live instance |

## 4. First-turn recall — model-request proof

| Gate | Result | Evidence |
|---|---|---|
| Memory block present in the **first** model request of a fresh session | PASS | `docs/FIRST_TURN_PROOF.md`: request #1, 3 messages, `Known context:` in the `user` runtime-context snapshot, `amber-otter-7731` present; two independent fresh sessions (18:19:13, 18:20:18) |
| Memory tools disabled for the proof | PASS | that request offers 25 base tools and **zero** `memory_*` tools (`tools.enabled: false`) |
| Carried as lower-trust context, not a system instruction | PASS | amber text is in a `user`-role snapshot starting `Current runtime context…`; the `system` message contains only the data-not-instructions policy and no fixture text |
| Injected overhead | PASS | memory block 314 chars ≈ 79 tokens (chars/4); whole snapshot 859 chars ≈ 215 tokens |
| Latency | PASS (warm) | 597 ms in-process recall; 664 ms inside the first assembly; budget 1500 ms |
| Cold-start behaviour | **PARTIAL** | one first-ever run missed the block entirely (recall returned after the budget; provenance recorded the hits). Failure mode is open by design; documented in `docs/FIRST_TURN_PROOF.md` |

## 5. Export / import, isolated instance

| Gate | Result | Evidence |
|---|---|---|
| Import into an isolated scope | PASS | throwaway scope `project:wse-imp-20261122t182206`; `records 2 imported 2 deduplicated 0 conflicts 0` |
| Re-import deduplicates | PASS | same bundle → `imported 0 deduplicated 2 conflicts 0` |
| Changed fact is marked a conflict, not overwritten | PASS | same key, different text → `deduplicated 1 conflicts 1`; ledger appends a conflict annotation |
| Export is lossless and scoped | PASS | `memory export` → `records: 2`, file written, 3 ledger lines (2 active + 1 conflict annotation) |
| Cleanup | PASS | isolated Cognee dataset `dsh-project-wse-imp-…` deleted (`DELETE 200`); 18 datasets remain, 0 matching `wse-imp`; temp homes removed |

## 6. Backup and restore (see `docs/BACKUP.md`, `docs/RESTORE.md`)

| Gate | Result |
|---|---|
| Real backup taken, checksums verified | PASS — `/root/backups/dsh-cognee-20261123T012849Z/`, `sha256: all OK (5 files)` each side |
| Dump integrity | PASS — `gzip -t` OK, 11,473,734 B, **21** `CREATE DATABASE` |
| Isolated restore drill | PASS — 38 s to a serving copy, 21/21 databases, 20 datasets, 54 items, 4 users, 2 API keys, six healthy components, known record + `CHUNKS` hit |
| DSH-side restore | PASS — throwaway `$DSH_HOME`, ledger 104 entries, headless first turn answers `amber-otter-7731`, tool-free assembly recall `FIXTURE_RECALLED=true` |
| Teardown | PASS — isolated containers and scratch dirs removed; backups and evidence kept |

## 7. Deployment invariants (live, 2026-11-22)

| Gate | Result | Evidence |
|---|---|---|
| Service running | PASS | `systemctl show -p SubState deepseek-harness.service` → `running` after every change and after cleanup |
| `/etc/dsh/*.env` modes | PASS | `cognee.env`, `llm.env` → `root:dsh 0640` |
| `$DSH_HOME` ownership | PASS | `profiles/headless/cordis.patch.yml` now `dsh:dsh 0640` (the item flagged in the previous revision is fixed) |
| No leftover test state | PASS | proof home, proxy, isolated import homes and dataset removed; no production dataset written |

## 8. Open items (do not block the artifact)

1. **`profiles/headless/cordis.patch.yml` root-owned** — **resolved**: now
   `dsh:dsh 0640`.
2. **Two superseded backups** (`…T012354Z`, `…T012452Z`) are single-database dumps
   that cannot restore search. Keep or delete with approval; a restore from them
   silently loses the per-dataset databases.
3. **Legacy dirs** `profiles/web.bak-1795371453` (20 MB) and
   `profiles/web/node_modules.100-broken` (9.5 MB) are archived and await a
   deletion decision.
4. Settings-page 200/401/503 in a *clean* home (§3) — needs a bootable profile
   (harness bootstrap gap).
5. Cold-start first-turn miss (§4) — mitigation is a larger prefetch/retrieval
   budget or a warm-up; not changed in 1.0.1 because it would alter runtime
   behaviour.

## 9. Rollback

No npm publish, so rollback is `git revert` of the release commit plus removing
the artifact. For an installed host: `dsh plugin --profile <p> remove
dsh-cognee-memory`, restore the profile's `package.json` from
`/root/backups/dsh-cognee-<ts>/dsh/dsh-home.tar.gz`, restart and confirm
`systemctl show -p SubState deepseek-harness.service` = `running`.

Verdict and residual risks: `docs/RELEASE_VERDICT.md`.
