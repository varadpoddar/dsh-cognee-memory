# Cross-instance portability test (Mac → CT 103)

Date: 2026-11-23. Plugin `dsh-cognee-memory@1.0.2` (repo HEAD `b23999e`,
`feature/cognee-persistent-memory`). Local Mac run used a throwaway
`DSH_HOME=/tmp/dsh-xsite-<ts>`; the user's live `~/.dsh` was not modified and no
local web process was started. CT 103 ran as user `dsh` with
`DSH_HOME=/var/lib/deepseek-harness/.dsh`; `deepseek-harness.service` was not
restarted and stayed `SubState=running`.

## Result summary

| Check | Result |
| --- | --- |
| Local `memory_status` (throwaway home) | `enabled`, `reachable: true` |
| Local ledger after 6 headless capture turns | 9 active records (`project:varad-xsite-local-<ts>-07b5…`) |
| `memory export` | 9 records, 0 refused-for-secrets |
| Secret scan of bundle | 0 real credential values; 3 prose matches for the word "token" |
| Import dry run (CT 103) | `records 9 imported 9 deduplicated 0 conflicts 0 refused 0` |
| Import apply | 9 imported, ids returned per record |
| Fresh CT 103 headless, tools off, 1 message | `Release codename: **amber-otter-7731** · Deployment target: **CT 103**`; 0 tool events; fact first appears in the step-1 `thinking` event |
| Re-import same bundle | `imported 0 deduplicated 9` |
| Import contradicting value for one key | `conflicts 1`, original `amber-otter-7731` retained and served; conflicting text stored as `state:"conflict"` |
| Import without `--allow-scope` | `FORBIDDEN: target scope … is not writable by this importer` |
| Cleanup | both test datasets deleted (Cognee API), test-scope ledger rows removed, CT temp overlays/scripts removed, throwaway home removed; bundle + proof evidence kept outside the repo |

## Mapping required (finding)

The importer never takes a target scope from the bundle, so an operator must
supply all three:

1. **Identity** — `--principal dsh` on CT 103 (the Mac run captured under the
   local `varad` identity). The plugin's project scope id is a slug-hashed
   namespace, so the raw project id is the only stable join key.
2. **Scope** — source `project:varad/xsite-local-<ts>` →
   target `project:dsh/xsite-<ts>`.
3. **Authorization** — `--allow-scope project:dsh/xsite-<ts>`; without it the
   import is refused with `FORBIDDEN` even though the bundle itself is valid.

Raw ids are normalized: `dsh/xsite-<ts>` becomes
`dsh-xsite-<ts>-5fef0c2f2c4933ceb82c` (slash lossy → stable hash suffix), and
the resulting Cognee dataset is
`dsh-project-dsh-xsite-<ts>-5fef0c2f2c4933ceb82c`.

## Limitations observed

- LLM extraction produced two semantic keys for the same codename fact (one
  deterministic, one extracted); both were imported and both recall correctly.
  Expect near-duplicate keys when a fact is stated explicitly and also inferred.
- One fact (settings page URL) was only captured reliably after an explicit
  "remember that…" turn; the implicit turn's extraction focused on an
  adjacent assistant sentence. Deterministic `remember` remains the reliable
  path for URL/identifier-style facts.
- The plugin intentionally exposes no dataset-delete path; cleanup of the test
  dataset used the Cognee REST endpoint `DELETE /api/v1/datasets/{id}`.

## Evidence

Kept outside the repo (not committed):

- `/tmp/bundle-20261123223521.jsonl` (9 records, sha256 `a805d2d8acc78da7…`)
- `/tmp/bundle-conflict-20261123223521.jsonl` (single contradicting record)
- `/tmp/xsite-ct-proof.jsonl` (CT 103 `--json` event log, sha256 `6513a28a40aad136…`)
