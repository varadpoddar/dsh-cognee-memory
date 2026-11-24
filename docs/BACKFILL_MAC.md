# Mac history backfill into Cognee (2026-11-24)

Plugin `dsh-cognee-memory@1.0.2`, repo HEAD `85079d9`. The backfill ran under a
throwaway home (`/tmp/dsh-backfill-home`) against the shared Cognee
(`http://10.20.10.15:8000/api/v1`). The live `~/.dsh` was opened read-only for
`sessions/`; no live profile, service, or ledger was written.

## Reconciliation before applying

- No `import-history` state file existed under the backfill home and no
  `varad/mac-backfill` dataset existed in Cognee (21 datasets, none matching),
  so **0 records had been ingested** out of **0 extracted candidates**.
- Fresh dry run over the real transcripts (673 sessions, 246 direct human
  messages): **0 candidates, 0 pending, 0 already imported**. Namespace
  `dsh-project-varad-mac-backfill-6a6d3597542f8c736a35`.
- Redaction hits (`secrets`): **0**. Skipped: `tooLong 606`, `notHuman 3715`,
  `noCommand 246`, `synthetic 0`, `malformed 0`.
- The real transcripts contain no explicit `remember …` / `forget …` /
  `actually …` commands, so the session extractor legitimately yields nothing.

## Apply

Because the session extractor had no candidates, the preserved Mac-origin
capture bundle (`/tmp/bundle-20261123223521.jsonl`, 9 records from the
2026-11-23 Mac headless capture) was used as the Mac source set to finish the
backfill:

| Step | Result |
| --- | --- |
| Bundle import dry run → `project:varad/mac-backfill` | records 9, imported 9, deduplicated 0, conflicts 0, refused 0 |
| Apply | 9 imported; dataset `dsh-project-varad-mac-backfill-6a6d3597542f8c736a35` created |
| Dataset state | 9 data records; `state=ready`, `searchable=true`, `DATASET_PROCESSING_COMPLETED` |
| Re-apply (idempotency) | imported 0, deduplicated 9, conflicts 0 |
| `import-history --apply` then re-dry-run | ingested 0 / nothing to ingest; 0 candidates, 0 pending |

Ledger: `/tmp/dsh-backfill-home/plugins/cognee-memory/ledger.jsonl`, 9 rows.
State: `/tmp/dsh-backfill-home/import-history.state.json`.

## Checks

- 3 sampled recall queries all returned Mac-origin facts:
  release codename `amber-otter-7731` + target `CT 103`; deploy target CT 103;
  settings-page URL.
- Ledger secret scan: `findSecrets` 0 hits; supplementary regex
  (`sk-…`, `ghp_…`, `AKIA…`, JWT, 40+ hex) 0 hits.
- Live `~/.dsh` sessions untouched; existing Cognee datasets unmodified; the
  new dataset is the only artifact added to Cognee by this backfill.
