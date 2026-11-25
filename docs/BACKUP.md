# Backup — DSH ↔ Cognee memory stack

Application-consistent backup of the two stateful halves of the memory feature:
the Cognee stack (CT 106) and the DSH home (CT 103). Designed for a
single-operator homelab: no backup server, no agents, no network transfer —
each host writes its own half under `/root/backups/`.

Restore is a separate procedure: see [RESTORE.md](./RESTORE.md).

> **2026-11-25 storage reset:** Cognee's files and graph now live in SeaweedFS
> S3 (`s3://dsh-corpus/cognee/...`), not in `/opt/stacks/cognee/data/cognee`.
> `pg_dumpall` remains the relational backup; the S3 objects need a SeaweedFS
> snapshot or `aws s3 sync` as described in
> [S3-backed layout](#s3-backed-layout-2026-11-25).

## What is backed up

| Side | Path in backup | Source | Why |
|---|---|---|---|
| Cognee | `cognee/cognee_db-all.sql.gz` | `pg_dumpall` | The whole cluster: `cognee_db` (`datasets` 20, `data` 54 items, `principals` 4, `users` 4, `user_api_key` 2, `queries`/`results` 785 each, `pipeline_runs` 3263, ACL rows) **plus one database per dataset** (19 of them) and the roles |
| Cognee | `cognee/cognee-storage.tar.gz` | **legacy** `/opt/stacks/cognee/data/cognee` | Before 2026-11-25 this held the embedded ladybug graph and local files. After the S3 reset this directory is empty; the graph and files are in `dsh-corpus`. Do not treat this tarball as a graph backup. |
| Cognee | not captured by `backup.sh` | SeaweedFS `s3://dsh-corpus/cognee/{data,system,cache}` | Authoritative corpus and per-dataset Ladybug graphs. Snapshot the filer/volume or `aws s3 sync` separately. |
| Cognee | `cognee/cognee.env` | `/opt/stacks/cognee/.env` (0600) | DB/vector credentials, `REQUIRE_AUTHENTICATION`, JWT secret, LLM/embedding config. Necessary to bring the stack back identically |
| Cognee | `cognee/compose.yaml`, `.env.example` | stack dir | Exact service topology (images, ports, bind mounts) |
| DSH | `dsh/dsh-home.tar.gz` | `$DSH_HOME/{profiles,sessions,plugins/cognee-memory,.credentials.yaml,.anonymous-user-id}` | Profiles (plugin row + `dsh.profile.bundles`), session history, the memory **provenance ledger** (`plugins/cognee-memory/provenance.json`, 104 entries / 13 datasets) and its settings |
| DSH | `dsh/etc-dsh/*.env` | `/etc/dsh/*.env` (0640 `root:dsh`) | `COGNEE_API_KEY`, DSH/LLM environment |
| both | `MANIFEST.json`, `SHA256SUMS` | generated | Versioned provenance and integrity |

Deliberately **not** backed up by these scripts: docker images (pulled from the
registry), `$DSH_HOME/.pnpm-store` (rebuildable cache),
`/opt/stacks/cognee/data/pg` (raw postgres data directory — a `pg_dump` is the
supported, portable form; copying a live data dir is unsafe), logs, and the
historical `backup-20261122-002228` directory. The SeaweedFS bucket is also
**not** covered by `scripts/backup.sh`; see the S3 section below.

Backups contain secrets (`cognee.env`, `*.env`, `.credentials.yaml`). Both
destination directories are mode `0700` and the secret members `0600`; they are
never copied off-host in plaintext by these scripts.

## S3-backed layout (2026-11-25)

The reset moved the file/graph half out of the container while leaving the
relational/vector half in Postgres:

| Layer | Location | Notes |
|---|---|---|
| Ingested documents | `s3://dsh-corpus/cognee/data/<user-uuid>/` | `S3FileStorage`, one object per uploaded file |
| Ladybug graph | `s3://dsh-corpus/cognee/system/databases/<user-uuid>/<dataset-uuid>.lbug` | pulled to a temp file, pushed after `add`/`cognify` |
| Cache prefix | `s3://dsh-corpus/cognee/cache/` | reserved; the active session cache is Postgres |
| Relational + pgvector | CT 106 `/opt/stacks/cognee/data/pg` (`cognee_db` + per-dataset DBs) | still local, still covered by `pg_dumpall` |
| Container local storage | `/opt/stacks/cognee/data/cognee` | empty; not authoritative |

Env names actually used (all in `/opt/stacks/cognee/.env`, 0600 `root:root`):
`STORAGE_BACKEND`, `STORAGE_BUCKET_NAME`, `DATA_ROOT_DIRECTORY`,
`SYSTEM_ROOT_DIRECTORY`, `CACHE_ROOT_DIRECTORY`, `AWS_ENDPOINT_URL`,
`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`,
`CACHE_BACKEND=postgres`, `GRAPH_DATABASE_SUBPROCESS_ENABLED=false`.

Cognee 1.6.10 does **not** read `ENABLE_S3`, `AWS_ENDPOINT_URL_S3`,
`AWS_S3_BUCKET_NAME`, `BUCKET_NAME`, or a Cognee path-style flag. The endpoint
is an IP, so botocore/s3fs use path-style automatically; writes to
`http://10.20.10.21:8333/dsh-corpus/...` are the proof. `S3_FORCE_PATH_STYLE`
exists only in `/root/seaweedfs-creds` for the AWS CLI.

Two non-obvious settings are required with an S3 system root:

* `CACHE_BACKEND=postgres` — the default SQLite session cache tries to create
  `cache.db` under the S3 database path and fails with `CacheConnectionError`.
  Postgres reuses `cognee_db`.
* `GRAPH_DATABASE_SUBPROCESS_ENABLED=false` — with the default subprocess mode,
  the Ladybug adapter resolves `s3://...` through `os.path.abspath()` into
  `/app/s3:/...` and writes the graph to the container layer, not S3.
  In-process mode takes the adapter's explicit S3 pull/push path.

`scripts/backup.sh` still implements only the Postgres dump, the now-empty local
directory tar, and the env/compose copy. Add a quiesced S3 snapshot (or
`aws s3 sync s3://dsh-corpus/cognee/ ...`) beside the dump until the script is
extended.

## Consistency order (and why)

Writes are quiesced **before** the relational dump and the S3 snapshot, so both
come from the same instant. Without the pause, a `remember` landing between the
two steps would leave a `data` row whose graph nodes exist only in the newer
snapshot (or vice versa) — the exact "dataset exists, content doesn't" failure
the recovery work in `docs/RECOVERY_MANIFEST.md` had to reason about.

```
CT 106                                   CT 103
------                                   ------
1. docker pause cognee cognee-ui
2. pg_dumpall (whole cluster)     ─┐
3. aws s3 sync / filer snapshot    │  both from the same paused instant
4. copy .env, compose.yaml        ─┘
5. docker unpause (trap, ALWAYS)
                                   ──→  6. tar $DSH_HOME (profiles, sessions,
                                            ledger, credentials)
                                         7. copy /etc/dsh/*.env
```

The current `scripts/backup.sh` performs steps 1, 2, 4 and 5; step 3 is still
manual. Until it is automated, take the S3 snapshot in the same paused window.

* `cognee-db` is **not** paused: `pg_dump` needs a live connection, and it is
  transactionally consistent on its own. Pausing only the API layer is what
  makes the *S3 object* half consistent.
* `docker pause` (SIGSTOP) rather than `stop`: no container restarts, no
  re-init of the graph adapter, sub-second window. Cost: the API healthcheck
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

## Pre-S3 reset courtesy dump (2026-11-25T10:12:46Z)

Created on CT 106 after pausing `cognee`/`cognee-ui` and before the wipe. It is
the rollback point for the storage reset:

```
/root/backups/cognee-pre-s3-reset-20261125T101246Z/
  cognee_db-all.sql.gz   126,448,184 B  8b622acce9a6aac89b8d5d2033a1e5dc0f4119225b89fd58e6023263a233c50e
  cognee-data.tar.gz     138,596,093 B  c37cfbff6a7ed2b89eb008f00ab092888eddfee0753563a56ad26f49bc915629
  cognee.env, compose.yaml, SHA256SUMS   (directory 0700; files 0600)
```

The dump contains 26 `CREATE DATABASE` statements; the data tar has 10,201
entries. Keep this directory until the user explicitly accepts the S3 layout.
It is a courtesy copy, not a scheduled backup.

## Rolling back to the pre-S3 layout

Use the dump above plus the pre-reset env. The full restore drill is in
`docs/RESTORE.md`; the order is:

1. `docker compose down` in `/opt/stacks/cognee`; empty `data/pg` and
   `data/cognee`.
2. Start `cognee-db` alone, drop the freshly initialised `cognee_db`, then
   restore the cluster with
   `zcat cognee_db-all.sql.gz | docker exec -i cognee-db psql -U cognee -d postgres`.
3. Extract `cognee-data.tar.gz` at `/opt/stacks/cognee` (it contains `data/`).
4. Restore `cognee.env` to `.env` as `0600 root:root`. That file predates the
   S3 block, so it removes `STORAGE_BACKEND`, the `s3://` roots, `CACHE_BACKEND`
   and `GRAPH_DATABASE_SUBPROCESS_ENABLED=false` in one step.
5. Restore the old consumer credentials on CT 103 if you also restore the old
   `user_api_key` rows:
   `/root/backups/dsh-cognee.env.pre-s3-20261125` (0640 `root:dsh`) and
   `/root/backups/dsh-varad-varad.env.pre-s3-20261125` (0640 `root:varad`),
   then restart both DSH units.
6. `docker compose up -d`; verify `/health/detailed` and a CHUNKS query against
   a restored dataset.

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
zcat cognee_db-all.sql.gz | grep -c '^CREATE DATABASE'              # one per dataset database
python3 -c 'import json;json.load(open("MANIFEST.json"))'            # manifest valid

# S3 half (separate from the tar since 2026-11-25); run on CT 2001
set -a; . /root/seaweedfs-creds; set +a
aws --endpoint-url "$S3_ENDPOINT_URL" s3 ls s3://dsh-corpus/cognee/ --recursive --summarize | tail -3
```

The old `tar -tzf cognee-storage.tar.gz | grep cognee_graph_ladybug` check is
obsolete: that archive is now empty. Graph presence must be checked in
`dsh-corpus/cognee/system/databases/`.

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

The 2026-11-25 pre-S3 courtesy dump is retained separately and on purpose. It is
larger than the routine backups (121 MB dump + 133 MB tar) and must not be
pruned until the S3 layout is accepted.
