# PR: dsh-cognee-memory 1.0.0 — ranking fix and release

> Prepared description only. **Not pushed and no PR opened** from this branch.

## Summary

This branch takes `dsh-cognee-memory` from 0.2.1 to a 1.0.0 release and fixes the
recall-ranking defect documented in `docs/EVALUATION.md` (Milestone 11, scenario
D). Two cooperating bugs made a tools-disabled first turn miss a fact the user
had just stored:

1. **Budget crowd-out.** The two-layer retrieval coordinator let the stable
   layer take all `retrieval.maxItems` (8) slots, so the query layer received
   `max(0, 8 - stable.length)` slots — usually zero.
2. **Inverted relevance.** Cognee `/search` with `CHUNKS` returns ascending
   vector *distance* in `score` (live observation: exact match `0.0486`,
   unrelated memories `0.39–0.49`), while `RecallService` sorts by descending
   `score`. The memory Cognee ranked first was therefore ranked last inside the
   plugin.

## Changes

### Ranking (`src/memory/retrieval.ts`, `src/adapters/cognee-response.ts`)

- Query layer reserves `ceil(maxItems / 2)` item slots; unused reservation flows
  back to the stable layer; stable candidates backfill slots the query layer did
  not need. Per-layer token caps (300 / 900), combined cap (1200), item cap (8)
  and deadline (1500 ms) are unchanged.
- CHUNKS distance is converted to similarity at the adapter boundary
  (`1 - distance`); other search types keep their score. `minScore`, confidence
  labels and ordering now use one consistent "higher is better" contract.
- Regression tests: `test/retrieval.test.ts` (fails on the previous coordinator)
  and `test/cognee-rest.test.ts` (distance rows keep the closest first).

### Release engineering

- `package.json`: version 1.0.0; complete `files`/`exports`, `engines.node
  >=22`, DSH peer dependencies, repository/homepage/bugs, MIT license, keywords,
  `sideEffects: false`; `test/` is no longer shipped in the tarball.
- `README.md`: what it does, install (`dsh plugin add`), configure (env +
  settings page), upgrade, rollback, uninstall, security notes, text
  architecture diagram, troubleshooting (stale Studio 401, env 0640 root:dsh,
  service profile vs `/root`).
- `docs/DEPLOYMENT.md`: exact CT 103 commands, service account, env files,
  restart requirement, verification, fresh-install smoke.
- `ROLLBACK.md`: stop → plugin remove → restore profile backup → restart.
- `CHANGELOG.md`: 1.0.0 entry plus the milestone table.
- `docs/EVALUATION.md`: before/after evidence for the ranking fix.

## Test plan / verification

- `npm ci && npm run build && npm test` from a clean checkout of the repository:
  **45 files / 455 tests passed**.
- `npm pack` → install `dsh-cognee-memory-1.0.0.tgz` into a clean throwaway
  `DSH_HOME` on CT 103 (`/var/lib/deepseek-harness/.dsh-smoke`): plugin mounts,
  all four tools register, the settings page answers `200` with the operator
  token, and a tools-disabled first response recalls the maintenance fixture.
- Live scenario D (prefetch-only, all tools disabled, fresh process, real
  Cognee):
  - **before** (0.2.1): `final: Not defined — no maintenance window is specified
    anywhere in this project's context…` (query layer got 0 slots).
  - **after** (1.0.0): `final: m12-rank-window-0300-0400` with **zero** memory
    tool calls; injected block 284 tokens, 8 items, 415 ms.
- Fixtures were not modified: dataset `3d8d8ad8-41be-59c3-9310-7915c783e5ef`
  and codeword `amber-otter-7731` remain read-only.

## Risk and rollback

- Risk is confined to prompt-context selection and score ordering. A deployment
  that returns similarity (not distance) from a non-CHUNKS search type is
  unaffected; CHUNKS is the configured search type on CT 103.
- Rollback: stop service, `dsh plugin --profile web remove dsh-cognee-memory`,
  restore the profile backup, restart (`ROLLBACK.md`). Memory data and operator
  settings are never deleted by the rollback.

## Checklist

- [x] Ranking regression reproduces the crowd-out and fails on the old code
- [x] Distance→similarity regression covers the observed live scores
- [x] Full unit suite green from a clean checkout
- [x] Tarball fresh-install smoke on CT 103 (clean `DSH_HOME`, removed after)
- [x] Docs: README, DEPLOYMENT, ROLLBACK, CHANGELOG, EVALUATION
- [x] No secrets in the diff; fixtures untouched; no DSH core patch
- [ ] Real PR opened / pushed — intentionally out of scope for this branch

## Evidence

`docs/EVALUATION.md` (M11 report + 1.0.0 ranking-fix section),
`docs/DEPLOYMENT.md` (commands), `ROLLBACK.md` (recovery).
