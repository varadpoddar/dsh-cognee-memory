# PR: release 1.0.1 — backup/restore proven, permission guards, packaging

**Branch:** `feature/cognee-persistent-memory` → `main`  ·  **Status:** open, not pushed
**Artifact:** `dsh-cognee-memory-1.0.1.tgz` (366 KB, 292 files, sha256 `ec19b02d…d4fe5`)
**Scope:** operational tooling and tests around the plugin. No runtime behaviour,
tool surface, settings page or wire-contract change; no migration for existing installs.

## Why

The plugin shipped at 1.0.0, but "we have a plugin" and "we can lose CT 106 and
get the memory back" are different claims. This branch makes the second one
testable, and pins the on-disk invariants whose violation has already caused one
outage.

## What changed

### Backup (new)

`scripts/backup.sh`, `scripts/backup-all.sh`, `scripts/verify-backup.sh`,
`docs/BACKUP.md`.

Both halves of the memory stack are captured from one instant: writers are
quiesced with `docker pause`, then the relational dump and the embedded ladybug
graph file are taken, then writers are un-paused from an `EXIT` trap. The DSH
half copies `profiles/`, `sessions/`, the provenance ledger and `/etc/dsh/*.env`
with modes preserved. Each side writes a versioned `MANIFEST.json` (commit sha,
plugin and Cognee versions, exact SQL counts, per-table row counts, database
inventory) plus `SHA256SUMS`.

**The interesting bug:** the first implementation used `pg_dump` of `cognee_db`.
Cognee keeps *one postgres database per dataset* for the search path, so that
backup restores every dataset row and the entire graph — `/datasets/{id}/data`
still answers — while every `CHUNKS` search fails with
`database "<dataset-uuid>" does not exist`. The restore drill found it; the
backup now uses `pg_dumpall` (21 databases, 11.5 MB).

### Restore (new)

`scripts/restore-drill.sh`, `docs/RESTORE.md`.

The drill restores a backup into an isolated stack — own compose project, own pg
data dir, own storage dir, port 18001 — asserts the restored copy against
production, and tears itself down. Measured: **38 s** from empty to serving
(6 s db, 3 s dump replay, 28 s API boot), 21/21 databases, 20 datasets, 54 items,
4 users, 2 API keys, all six health components healthy, one known record
retrieved byte-identically and returned by `CHUNKS`. On the DSH side, a throwaway
`$DSH_HOME` restored from the same backup runs a headless first turn that
answers the seeded fixture, and the tool-free assembly recall returns it
(`FIXTURE_RECALLED=true`) alongside real pre-existing memories.

`docs/RESTORE.md` also documents the rollback path for every destructive step.

### Permissions (new)

`scripts/check-permissions.sh`, `test/permissions.test.ts`,
`test/helpers/permissions.ts`.

`/etc/dsh/*.env` must be `0640 root:dsh`; everything under `$DSH_HOME` must be
owned by `dsh`. The unit tests are pure functions over injected `stat` data, so a
root-owned profile manifest is testable without root, and the failure is a
`PermissionViolation` whose message names the path, diagnoses "a root-owned file
under `$DSH_HOME` means something ran as root where it must not", and prescribes
the fix. Run against CT 103, the checker immediately found a real violation:
`profiles/headless/cordis.patch.yml` is `root:root 0644`.

### Packaging and docs

- `npm pack` audited: no tests, no secrets, no `node_modules`; `dsh.bundle`
  present, version `1.0.1`.
- Installs from the tarball into a clean `DSH_HOME` as `dsh`, outside the
  checkout: registers in `dsh.profile.bundles` and composes as its own layer
  (`--dump-config` ends with `# == dsh-cognee-memory`).
- Internal hosts removed from `README.md`; no key/token/password/JWT material in
  anything shipped.

## Testing

| Suite | Result |
|---|---|
| `npm run build` | pass — `built lib/client.js (13402 bytes)` |
| `npm test` | **48 files, 466 tests, 5.09 s** |
| `test/permissions.test.ts` | 10/10 |
| Clean-consumer install of the tarball | import + metadata verified |
| `scripts/restore-drill.sh` | PASS (38 s, counts match production) |

## Reviewer notes / follow-ups

1. `profiles/headless/cordis.patch.yml` is root-owned on CT 103 — one `chown`
   away from fixed; deliberately not changed by this PR (production state).
2. Two superseded backups on CT 106 are single-database dumps that cannot restore
   search. They should be deleted **with approval**, not silently.
3. `profiles/web.bak-1795371453` (20 MB) and `profiles/web/node_modules.100-broken`
   (9.5 MB) are archived to `/root/backups/legacy-archaeology-<ts>.tar.gz`
   (sha256 `0f8c2e3b…1a65`) and recommended for deletion — also awaiting approval.
4. Settings 200/401/503 in a *clean* home is unverified: a freshly generated
   profile does not boot in an empty `DSH_HOME` in this harness build
   (`web-runtime` waits on `webServer`). Route behaviour is covered by unit tests
   and the live instance.

## Not in this PR

No `npm publish`. No production dataset modification. No deletion of any backup
or legacy directory.
