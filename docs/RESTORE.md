# Restore — DSH ↔ Cognee memory stack

How to rebuild the memory stack from a backup, and how to back out. Backup
contents and the consistency order are in [BACKUP.md](./BACKUP.md).

Everything here was executed end-to-end on 2026-11-23 against a real backup
(`dsh-cognee-20261123T012849Z`); the measured numbers in §5 are from that run,
not estimates.

## 0. What you are restoring

| Piece | Restored from | Lands in |
|---|---|---|
| Cognee relational state **and** one postgres database per dataset | `cognee/cognee_db-all.sql.gz` (`pg_dumpall`) | a fresh `pgvector/pgvector:pg16` cluster |
| Ladybug graph + local file storage | `cognee/cognee-storage.tar.gz` | `/cognee-storage` (bind mount) |
| Stack config and secrets | `cognee/cognee.env` (0600), `compose.yaml` | stack directory |
| DSH profiles, sessions, memory ledger, credentials | `dsh/dsh-home.tar.gz` | `$DSH_HOME` |
| DSH secrets | `dsh/etc-dsh/*.env` (0640 root:dsh) | `/etc/dsh/` |

**The one thing that breaks a naive restore:** Cognee keeps *one postgres
database per dataset*, named by the dataset UUID, for the vector/search path,
in addition to `cognee_db`. Restoring only a `pg_dump` of `cognee_db` brings back
every dataset row and every graph node, and `/datasets/{id}/data` still answers —
but every `CHUNKS` search fails with `database "<dataset-uuid>" does not exist`.
That is why the backup uses `pg_dumpall`. This was found by running the drill,
not by reading code.

## 1. Prerequisites

- Docker + compose v2 on the target host; images `pgvector/pgvector:pg16` and
  `cognee/cognee:latest` (4 GB) available or pullable.
- The backup directory for one timestamp, both halves, on the host that will
  serve it.
- The Cognee API key (it lives in `/etc/dsh/cognee.env` as `COGNEE_API_KEY`).
  After restore the key keeps working, because `user_api_key` rows and
  `FASTAPI_USERS_JWT_SECRET` are both inside the backup.
- Free space: ~1 GB is plenty (dump 11.5 MB, storage 474 KB, DSH home 9.5 MB;
  the restored postgres cluster grows to ~190 MB when live).

## 2. Restore Cognee (disaster recovery, in place)

Run as root on the Cognee host. `$TS` is the backup timestamp.

```bash
TS=20261123T012849Z
B=/root/backups/dsh-cognee-$TS/cognee
STACK=/opt/stacks/cognee

cd $STACK

# 1. verify the backup before touching anything
cd $B && sha256sum -c SHA256SUMS && gzip -t cognee_db-all.sql.gz && cd $STACK

# 2. stop the stack (containers only; data dirs stay)
docker compose -f compose.yaml down

# 3. put the config back exactly as it was
cp $B/cognee.env $STACK/.env && chmod 600 $STACK/.env
cp $B/compose.yaml $STACK/compose.yaml

# 4. reset the postgres data dir and start a bare cluster. The dump is a
#    whole-cluster pg_dumpall, so initialise with a plain superuser and let the
#    dump create the `cognee` role and every database itself.
mv $STACK/data/pg $STACK/data/pg.before-restore-$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p $STACK/data/pg
docker compose -f compose.yaml up -d db
until docker exec cognee-db pg_isready -U cognee -d cognee_db; do sleep 2; done

# 5. replay the cluster dump as the superuser
gunzip -c $B/cognee_db-all.sql.gz | \
  docker exec -i cognee-db psql -U postgres -d postgres -v ON_ERROR_STOP=1

# 6. restore the graph + file storage
rm -rf $STACK/data/cognee
mkdir -p $STACK/data/cognee
tar -xzf $B/cognee-storage.tar.gz -C $STACK/data/cognee --strip-components=1
chown -R 1000:1000 $STACK/data/cognee

# 7. start the API and wait for health
docker compose -f compose.yaml up -d
until docker exec cognee curl -sf http://localhost:8000/health; do sleep 5; done
```

If the `.env` in the backup names a different DB host (a compose service name
such as `db`), keep the compose service name identical or edit `DB_HOST` /
`VECTOR_DB_HOST` in the restored `.env`.

## 3. Verify the restored Cognee

Expected values come from `MANIFEST.json` in the same backup directory; compare,
do not assume.

```bash
docker exec -i cognee-db psql -U cognee -d cognee_db -Atc \
  "select 'datasets='||count(*) from datasets" \
  -c "select 'items='||count(*) from data" \
  -c "select 'users='||count(*) from users" \
  -c "select 'api_keys='||count(*) from user_api_key"
# datasets=20 items=54 users=4 api_keys=2

docker exec -i cognee-db psql -U postgres -d postgres -Atc \
  "select count(*) from pg_database where datistemplate=false"          # 21
```

Then, with `K` = the API key:

```bash
curl -s -H "X-Api-Key: $K" http://127.0.0.1:8000/health/detailed | \
  jq -r '.version, (.components|to_entries[]|"\(.key)=\(.value.provider):\(.value.status)")'
# 1.6.10-local
# graph_db=ladybug:healthy   relational_db=postgres:healthy
# vector_db=pgvector:healthy file_storage=local:healthy  (+ llm, embedding)

curl -s -H "X-Api-Key: $K" http://127.0.0.1:8000/api/v1/datasets | jq 'length'   # 18
```

`18` (API, owner-scoped to the DSH key) and `20` (SQL, all owners) are both
correct — see BACKUP.md §Manifest.

One known record, end to end (this is the drill's assertion):

```bash
DS=dsh/agent/smoke                    # dataset name
# id of its single item
docker exec -i cognee-db psql -U cognee -d cognee_db -Atc \
 "select x.id from data x join datasets d on d.id=x.dataset_id where d.name='$DS'"
curl -s -H "X-Api-Key: $K" \
 "http://127.0.0.1:8000/api/v1/datasets/<dsId>/data/<dataId>/raw"
# → "DSH smoke fact: the memory plugin must never store secrets, only redacted …"
curl -s -H "X-Api-Key: $K" -H 'Content-Type: application/json' \
 -d "{\"query\":\"DSH smoke fact\",\"searchType\":\"CHUNKS\",\"datasetIds\":[\"<dsId>\"],\"topK\":5}" \
 http://127.0.0.1:8000/api/v1/search | jq '.[0].search_result|length'   # ≥1
```

## 4. Restore the DSH side

```bash
TS=20261123T012849Z
B=/root/backups/dsh-cognee-$TS/dsh
# 1. stop the harness (the ledger and profiles must not be written mid-copy)
systemctl stop deepseek-harness.service
# 2. keep the old home
mv /var/lib/deepseek-harness/.dsh /var/lib/deepseek-harness/.dsh.before-restore-$(date -u +%Y%m%dT%H%M%SZ)
install -d -o dsh -g dsh -m 0700 /var/lib/deepseek-harness/.dsh
# 3. unpack as dsh — NEVER as root (root-owned files under .dsh have caused an outage)
su -s /bin/bash dsh -c "tar -xzf $B/dsh-home.tar.gz -C /var/lib/deepseek-harness/.dsh"
# 4. secrets back, owner/mode preserved
cp -a $B/etc-dsh/*.env /etc/dsh/ && chown root:dsh /etc/dsh/*.env && chmod 0640 /etc/dsh/*.env
# 5. start and confirm
systemctl start deepseek-harness.service
systemctl show -p SubState deepseek-harness.service      # SubState=running
```

Rehearse this against a throwaway home first (no service restart, no downtime):

```bash
R=/tmp/dsh-restore-$TS
mkdir -p $R && tar -xzf $B/dsh-home.tar.gz -C $R && chown -R dsh:dsh $R
su -s /bin/bash dsh -c "set -a; . /etc/dsh/dsh.env; . /etc/dsh/llm.env; . /etc/dsh/cognee.env; set +a; \
  DSH_HOME=$R dsh --profile headless 'What is the release codename for this DSH release?'"
```

Point a *copy* of the profile at the restored API (`apiBaseUrl`) if production
Cognee is still the live one; never edit the live profile for a rehearsal.

## 5. The drill: measured results

`scripts/restore-drill.sh` (runs on the Cognee host, restores into a separate
compose project on `10.20.10.15:18001` with its own pg data dir and storage,
then tears it down) was run against `dsh-cognee-20261123T012849Z`:

| Step | Result |
|---|---|
| fresh postgres → healthy | 6 s |
| replay `pg_dumpall` (21 databases) | 3 s |
| extract graph + storage | <1 s |
| API up and serving (`/health` ready) | 28 s |
| **total, empty machine → serving restored copy** | **38 s** (cold run: 46–55 s) |
| databases restored | 21 = production 21 |
| datasets / data items | 20 / 54 (production: 20 / 54) |
| users / principals / API keys | 4 / 4 / 2 (production: same) |
| health components | relational postgres, vector pgvector, graph ladybug, file local, llm custom, embedding configured — all `healthy`, version `1.6.10-local` |
| dataset list via API | 18 (owner-scoped, as production) |
| known record `dsh/agent/smoke` | row present, raw text 84 chars, matches production |
| `CHUNKS` search on the restored data | 1 row, hit |
| missing | nothing |

DSH side, same backup: `$DSH_HOME` restored into a throwaway `/tmp` home
(profiles, sessions, ledger 104 entries / 13 datasets, credentials), profile
repointed at the restored API.

| Check | Result |
|---|---|
| headless first turn, tools available | exit 0; `amber-otter-7731` in the answer; the model's `memory_recall` returned the fixture **from the restored instance** |
| tool-free assembly recall (plugin's own `CogneeRestAdapter.recall`, no model, no tools) | 4 hits, `FIXTURE_RECALLED=true`, including pre-existing production memories (`ADR-9001`, deployment decisions) |

The second row is the meaningful one for "tools-off": it drives the same
recall path the pre-turn prefetch uses and never involves a tool call. The
fixture (`amber-otter-7731`) is not production data — it was written into the
restored instance for the drill and the instance was destroyed afterwards.

Evidence kept: `CT106:/root/backups/restore-evidence-<ts>.txt` and
`CT103:/root/backups/dsh-headless-recall-<ts>.json`.

## 6. Rollback

Every step above is reversible; nothing deletes production data.

| Stage | Undo |
|---|---|
| Before restoring | Backups and the pre-existing `/opt/stacks/cognee/backup-20261122-002228` are untouched; nothing to undo |
| Postgres reset (§2 step 4) | `mv data/pg.before-restore-<ts> data/pg` and start the old stack |
| Storage replaced (§2 step 6) | keep the old `data/cognee` copied aside first; move it back |
| Restored cluster is wrong | `docker compose down`, restore `data/pg` + `data/cognee` from the pre-restore copies, `docker compose up -d` |
| DSH home replaced (§4) | `systemctl stop`, `mv .dsh.before-restore-<ts> .dsh`, `systemctl start` |
| Abandon a drill | `scripts/restore-drill.sh` removes its own containers and scratch dirs; the backup is never touched |

Verify after any rollback: `systemctl show -p SubState deepseek-harness.service`
= `running`, all three containers `healthy`, and
`/health/detailed` version `1.6.10-local`.

## 7. Known gotchas

1. **Per-dataset databases** — see §0. `pg_dump` of `cognee_db` alone is not a
   restorable backup for search.
2. **Cluster restore needs a superuser** — initialise the fresh cluster with
   `POSTGRES_USER=postgres`; the dump creates the `cognee` role (with its
   password hash) and `cognee_db` itself. Pre-creating `cognee_db` makes
   `CREATE DATABASE` fail.
3. **Graph file lives in the storage tar, not postgres** — `cognee_graph_ladybug`
   plus its `.wal` sidecar. Copy both; the graph replays the WAL on open.
4. **Restore the DSH home as `dsh`** — root-owned files under `.dsh` have taken
   the service down before.
5. **Paused containers look `unhealthy`** for about one probe cycle after a
   backup's `docker pause`; the API itself stays `ready`. Do not "fix" it.
