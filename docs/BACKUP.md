# Backup — DSH ↔ Cognee memory stack

Application-consistent backup of the two stateful halves of the memory feature:
the Cognee stack (CT 106) and the DSH home (CT 103). Designed for a
single-operator homelab: no backup server, no agents, no network transfer —
each host writes its own half under `/root/backups/`.

Restore is a separate procedure: see [RESTORE.md](./RESTORE.md).

## What is backed up

| Side | Path in backup | Source | Why |
|---|---|---|---|
| Cognee | `cognee/cognee_db-all.sql.gz` | `pg_dumpall` | The whole cluster: `cognee_db` (`datasets` 20, `data` 54 items, `principals` 4, `users` 4, `user_api_key` 2, `queries`/`results` 785 each, `pipeline_runs` 3263, ACL rows) **plus one database per dataset** (19 of them) and the roles |
| Cognee | `cognee/cognee-storage.tar.gz` | `/opt/stacks/cognee/data/cognee` | `/cognee-storage`: the **embedded ladybug graph file** (`system/databases/cognee_graph_ladybug`) and local file storage. The graph is *not* in postgres — without this file the relational rows point at a graph that no longer exists |
| Cognee | `cognee/cognee.env` | `/opt/stacks/cognee/.env` (0600) | DB/vector credentials, `REQUIRE_AUTHENTICATION`, JWT secret, LLM/embedding config. Necessary to bring the stack back identically |
| Cognee | `cognee/compose.yaml`, `.env.example` | stack dir | Exact service topology (images, ports, bind mounts) |
| DSH | `dsh/dsh-home.tar.gz` | `$DSH_HOME/{profiles,sessions,plugins/cognee-memory,.credentials.yaml,.anonymous-user-id}` | Profiles (plugin row + `dsh.profile.bundles`), session history, the memory **provenance ledger** (`plugins/cognee-memory/provenance.json`, 104 entries / 13 datasets) and its settings |
| DSH | `dsh/etc-dsh/*.env` | `/etc/dsh/*.env` (0640 `root:dsh`) | `COGNEE_API_KEY`, DSH/LLM environment |
| both | `MANIFEST.json`, `SHA256SUMS` | generated | Versioned provenance and integrity |

Deliberately **not** backed up: docker images (pulled from the registry),
`$DSH_HOME/.pnpm-store` (rebuildable cache), `/opt/stacks/cognee/data/pg`
(raw postgres data directory — a `pg_dump` is the supported, portable form;
copying a live data dir is unsafe), logs, and the historical
`backup-20261122-002228` directory.

Backups contain secrets (`cognee.env`, `*.env`, `.credentials.yaml`). Both
destination directories are mode `0700` and the secret members `0600`; they are
never copied off-host in plaintext by these scripts.

## Consistency order (and why)

Writes are quiesced **before** the relational dump and the graph copy, so both
come from the same instant. Without the pause, a `remember` landing between the
two steps would leave a `data` row whose graph nodes exist only in the newer
file (or vice versa) — the exact "dataset exists, content doesn't" failure the
recovery work in `docs/RECOVERY_MANIFEST.md` had to reason about.

```
CT 106                                   CT 103
------                                   ------
1. docker pause cognee cognee-ui
2. pg_dumpall (whole cluster)     ─┐
3. tar data/cognee (ladybug+files) │  both from the same paused instant
4. copy .env, compose.yaml        ─┘
5. docker unpause (trap, ALWAYS)
                                   ──→  6. tar $DSH_HOME (profiles, sessions,
                                            ledger, credentials)
                                         7. copy /etc/dsh/*.env
```

* `cognee-db` is **not** paused: `pg_dump` needs a live connection, and it is
  transactionally consistent on its own. Pausing only the API layer is what
  makes the *file* half consistent.
* `docker pause` (SIGSTOP) rather than `stop`: no container restarts, no
  re-init of the embedded graph, sub-second window. Cost: the API healthcheck
  goes `unhealthy` after ~3 failed probes and flips back to `healthy` on the
  next successful probe (observed: ~1 minute of stale `unhealthy` in
  `docker ps`, API itself returned `{"status":"ready"}` throughout).
* The un-pause lives in an `EXIT` trap, so a failed `pg_dump` still leaves the
  stack serving.

### Why `pg_dumpall` and not `pg_dump`

Cognee creates **one postgres database per dataset**, named by the dataset UUID,
for the vector/search path — 19 of them here, alongside `cognee_db`. A
`pg_dump` of `cognee_db` alone restores all metadata, every `data` row and the
whole graph, and `/datasets/{id}/data` answers correctly; but every `CHUNKS`
search then fails with `database "<uuid>" does not exist`. The first version of
this script made exactly that mistake, and the isolated restore drill
(`docs/RESTORE.md` §5) is what caught it. `pg_dumpall` captures the databases and
the roles in one consistent pass and is restored with `psql`, not `pg_restore`.

## Running it

From a workstation that can SSH to the Proxmox host (key `~/.ssh/dsh`):

```bash
cd dsh-cognee-memory
PVE=root@control.nomad.opsc.io KEY=~/.ssh/dsh scripts/backup-all.sh
```

The driver assigns one UTC timestamp, pushes `scripts/backup.sh` into both
containers, runs the matching half (`--side cognee` / `--side dsh`), then
verifies checksums, lists the dump with `pg_restore -l`, and checks that
`deepseek-harness.service` is still `running` and all three containers are up.

Output is one line per step; a healthy run looks like:

```
[backup] ts=20261123T012452Z commit=e443a3d plugin=1.0.0
[backup:cognee] done: /root/backups/dsh-cognee-<ts>/cognee (dump 11473734B, storage 473903B, 5 checksummed, 8s)
[backup:cognee] counts: datasets=20 items=54 tables=36 cognee=1.6.10-local
[backup:dsh]    done: /root/backups/dsh-cognee-<ts>/dsh (9514097B, 5 checksummed, 2s)
[backup:dsh]    ledger entries=104 datasets=13 profiles=3
sha256: all OK / pg_restore -l: OK
```

Each half can also run standalone on its own host:

```bash
backup.sh --side cognee --ts 20261123T012452Z
backup.sh --side dsh     --ts 20261123T012452Z
```

The script is idempotent per timestamp but never overwrites: a second run reuses
the same `--ts` only if invoked so explicitly; the driver always makes a new one.

## Manifest

`MANIFEST.json` (`manifestVersion: 1`) is written next to the data on each side:

```json
{ "manifestVersion": 1, "side": "cognee", "timestamp": "…Z",
  "commitSha": "…", "pluginVersion": "…", "cogneeVersion": "1.6.10-local",
  "durationSeconds": 2,
  "counts": { "datasets": 20, "dataItems": 54, "publicTables": 36,
              "source": "postgres SQL (exact; …)" },
  "tableRowCounts": "datasets=20,data=54,users=4,…",
  "databases": { "count": 21, "names": "…" },
  "files": { "cognee_db-all.sql.gz": {"bytes": …}, … },
  "checksums": { "file": "SHA256SUMS", "files": 5 } }
```

Counts come from **SQL, not the API**, so datasets owned by a non-DSH principal
(`dsh/project/alpha`, `dsh/project/beta`, owned by the agent user) are included —
`GET /api/v1/datasets` reports 18 for the DSH key while the table holds 20. Both
numbers are "correct"; the manifest says which one it recorded and how. The DSH
half records ledger entries (104), distinct dataset names in the ledger (13) and
profiles (3).

## Verifying a backup

```bash
# on the host that owns it
cd /root/backups/dsh-cognee-<ts>/cognee
bash /root/verify-backup.sh --side cognee --ts <ts>                 # sha256 + gzip -t + contents
zcat cognee_db-all.sql.gz | grep -c '^CREATE DATABASE'              # 21 ⇒ all databases captured
tar -tzf cognee-storage.tar.gz | grep cognee_graph_ladybug           # graph present
python3 -c 'import json;json.load(open("MANIFEST.json"))'            # manifest valid
```

`SHA256SUMS` covers every payload file but **not** `MANIFEST.json` or
`SHA256SUMS` itself, so the manifest can be annotated after the fact.

## Retention

Keep the last **7** timestamped directories per side (~11 MB per run), plus any
directory referenced by an open incident. Deletion is manual and requires
explicit approval — nothing in these scripts prunes. Known backups as of
2026-11-23: `dsh-cognee-20261123T012354Z` and `…T012452Z` (single-database
dumps — **superseded, not restorable for search**; kept only as history),
`dsh-cognee-20261123T012849Z` (**authoritative**: full `pg_dumpall`, restore
drill passed), and the pre-existing `/opt/stacks/cognee/backup-20261122-002228`
(untouched). Delete the two superseded ones once you no longer need the audit
trail — they are ~1.5 MB each, and a restore from them silently loses search.
