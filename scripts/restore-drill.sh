#!/usr/bin/env bash
# Isolated restore drill: restores a Cognee backup into a *separate* stack
# (own compose project, own pg data dir, own storage dir, port 18001) and
# asserts that the restored instance serves the same data as production.
#
#   COGNEE_API_KEY_FILE=/root/drill.key restore-drill.sh --ts 20261123T012452Z
#
# Runs as root ON CT 106. Production is never written to: the backup directory is
# only read, and the isolated stack (containers cognee-restore* + $R/pg and
# $R/cognee-storage) is torn down at the end unless --keep is passed. The backup
# itself is never modified or deleted.
set -euo pipefail

TS=""; PORT=18001; KEEP=0
while [ $# -gt 0 ]; do
  case "$1" in
    --ts)   TS="${2:-}"; shift 2 ;;
    --port) PORT="${2:-}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$TS" ] || { echo "usage: restore-drill.sh --ts <UTCSTAMP> [--port N] [--keep]" >&2; exit 2; }

BACKUP="/root/backups/dsh-cognee-$TS/cognee"
R="/root/restore-test-$TS"
PROJ=cognee-restore
EV="$R/evidence.txt"

die() { printf 'RESTORE FAIL: %s\n' "$*" >&2; exit 1; }
ev()  { printf '%s=%s\n' "$1" "$2" | tee -a "$EV"; }

# The key may be given inline or via a 0600 file (preferred: keeps it out of argv).
if [ -z "${COGNEE_API_KEY:-}" ] && [ -n "${COGNEE_API_KEY_FILE:-}" ]; then
  COGNEE_API_KEY=$(tr -d '\r\n' < "$COGNEE_API_KEY_FILE")
fi
: "${COGNEE_API_KEY:?set COGNEE_API_KEY or COGNEE_API_KEY_FILE}"
export COGNEE_API_KEY

[ -f "$BACKUP/cognee_db-all.sql.gz" ] || die "missing $BACKUP/cognee_db-all.sql.gz"
[ -f "$BACKUP/cognee-storage.tar.gz" ] || die "missing storage archive"
[ -f "$BACKUP/cognee.env" ] || die "missing cognee.env"

mkdir -p "$R/pg" "$R/cognee-storage"; chmod 0700 "$R"
: > "$EV"

envval() { grep -E "^$1=" "$BACKUP/cognee.env" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
DB_NAME=$(envval DB_NAME); DB_USER=$(envval DB_USERNAME)
[ -n "$DB_NAME" ] && [ -n "$DB_USER" ] || die "cannot read DB identity from backup .env"

# Same credentials and JWT secret as production, so this is a true clone: the
# DSH API key rows are restored and stay valid against the isolated instance.
cp "$BACKUP/cognee.env" "$R/restore.env"; chmod 0600 "$R/restore.env"
{
  # The cluster is initialised with a plain superuser: the dump is a pg_dumpall
  # that creates the `cognee` role and every database itself.
  printf 'POSTGRES_USER=postgres\n'
  printf 'POSTGRES_PASSWORD=%s\n' "$(envval DB_PASSWORD)"
  printf 'POSTGRES_DB=postgres\n'
} > "$R/db.env"
chmod 0600 "$R/db.env"

# The db service is deliberately also named `db`: the backed-up .env points
# DB_HOST/VECTOR_DB_HOST at that compose service name.
cat > "$R/compose.restore.yaml" <<YAML
name: $PROJ
services:
  db:
    image: pgvector/pgvector:pg16
    container_name: cognee-restore-db
    restart: "no"
    env_file: [db.env]
    volumes:
      - $R/pg:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U $DB_USER -d $DB_NAME"]
      interval: 5s
      timeout: 5s
      retries: 30
  cognee:
    image: cognee/cognee:latest
    container_name: cognee-restore
    restart: "no"
    env_file: [restore.env]
    ports:
      - "10.20.10.15:$PORT:8000"
    volumes:
      - $R/cognee-storage:/cognee-storage
    depends_on:
      db:
        condition: service_healthy
YAML

dc() { docker compose -p "$PROJ" -f "$R/compose.restore.yaml" "$@" </dev/null; }

T0=$(date -u +%s)
dc up -d --wait db >/dev/null || die "db did not become healthy"
T_DB=$(( $(date -u +%s) - T0 ))

# --- relational half -------------------------------------------------------
T1=$(date -u +%s)
# The dump is a whole-cluster pg_dumpall (cognee_db + one database per dataset +
# roles), so it is replayed with psql, not pg_restore.
gunzip -c "$BACKUP/cognee_db-all.sql.gz" \
  | docker exec -i cognee-restore-db psql -U postgres -d postgres -q \
      -v ON_ERROR_STOP=1 >"$R/psql.out" 2>"$R/pg_restore.err" \
  || { tail -5 "$R/pg_restore.err" >&2; die "pg_dumpall restore failed"; }
T_PG=$(( $(date -u +%s) - T1 ))

q() { docker exec -i cognee-restore-db psql -U postgres -d "$DB_NAME" -Atc "$1"; }
DBS=$(docker exec -i cognee-restore-db psql -U postgres -d postgres -Atc \
        "select count(*) from pg_database where datistemplate=false")
ev restored_databases "$DBS"
# Compare against production instead of a hardcoded number: not every dataset
# has a search database (an empty dataset never gets one), so the count is a
# property of the instance, not of the schema.
PROD_DBS=$(docker exec -i cognee-db psql -U cognee -d cognee_db -Atc \
            "select count(*) from pg_database where datistemplate=false")
ev prod_databases "$PROD_DBS"
[ "$DBS" = "$PROD_DBS" ] || die "database count differs: restored=$DBS prod=$PROD_DBS"
ev restored_datasets "$(q 'select count(*) from datasets')"
ev restored_data_items "$(q 'select count(*) from data')"
ev restored_users "$(q 'select count(*) from users')"
ev restored_principals "$(q 'select count(*) from principals')"
ev restored_api_keys "$(q 'select count(*) from user_api_key')"

# One known record. The `data` table holds metadata only; the text lives in file
# storage and is served by GET /datasets/{id}/data/{data_id}/raw.
REC=$(q "select d.id||'|'||x.id||'|'||d.name from data x join datasets d on d.id=x.dataset_id where d.name='dsh/agent/smoke' limit 1")
[ -n "$REC" ] || die "known record dsh/agent/smoke missing after restore"
REC_DS=${REC%%|*}; rest=${REC#*|}; REC_ID=${rest%%|*}; REC_NAME=${rest#*|}
ev known_record_dataset "$REC_NAME"
ev known_record_id "$REC_ID"

# --- graph/file half -------------------------------------------------------
T2=$(date -u +%s)
tar -xzf "$BACKUP/cognee-storage.tar.gz" -C "$R/cognee-storage" --strip-components=1
chown -R 1000:1000 "$R/cognee-storage"
GRAPH="$R/cognee-storage/system/databases/cognee_graph_ladybug"
[ -e "$GRAPH" ] || die "ladybug graph file not restored"
ev graph_bytes "$(du -sb "$GRAPH" | cut -f1)"
T_FILES=$(( $(date -u +%s) - T2 ))

# --- start the isolated API ----------------------------------------------
T3=$(date -u +%s)
dc up -d cognee >/dev/null || die "cognee-restore failed to start"
READY=0
for _ in $(seq 1 60); do
  if docker exec cognee-restore curl -sf http://localhost:8000/health >/dev/null 2>&1; then READY=1; break; fi
  sleep 5
done
[ "$READY" = 1 ] || { docker logs --tail 15 cognee-restore >&2; die "restored API did not become ready"; }
T_API=$(( $(date -u +%s) - T3 ))
T_TOTAL=$(( $(date -u +%s) - T0 ))
ev durations "db=${T_DB}s pg_restore=${T_PG}s files=${T_FILES}s api=${T_API}s total=${T_TOTAL}s"

# --- API-level assertions -------------------------------------------------
COGNEE_API_KEY="$COGNEE_API_KEY" python3 - "$PORT" "$REC_DS" "$REC_ID" <<'PY' | tee -a "$EV"
import json, os, sys, urllib.request
port, rec_ds, rec_id = sys.argv[1], sys.argv[2], sys.argv[3]
key = os.environ["COGNEE_API_KEY"]
base = "http://10.20.10.15:%s" % port
fails = []

def get_raw(path):
    req = urllib.request.Request(base + path, headers={"X-Api-Key": key})
    with urllib.request.urlopen(req, timeout=120) as r:
        return r.read()

def call(path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(base + path, data=data,
                                 headers={"X-Api-Key": key, "Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=180) as r:
        return json.loads(r.read())

health = call("/health/detailed")
comps = health.get("components", {})
print("version=%s" % health.get("version"))
print("components=%s" % ",".join("%s:%s" % (k, v.get("provider"))
                                 for k, v in sorted(comps.items())))
bad = [k for k, v in comps.items() if v.get("status") != "healthy"]
if bad:
    print("unhealthy_components=%s" % ",".join(bad))
    fails.append("components")
if health.get("version") != "1.6.10-local":
    fails.append("version")
if (comps.get("graph_db") or {}).get("provider") != "ladybug":
    fails.append("graph_provider")

ds = call("/api/v1/datasets")
if isinstance(ds, dict):
    ds = ds.get("datasets", ds)
print("api_datasets=%d" % len(ds))
if len(ds) != 18:          # 18 of 20 are visible to the DSH owner key
    fails.append("dataset_count")

items = call("/api/v1/datasets/%s/data" % rec_ds)
if isinstance(items, dict):
    items = items.get("data", items)
ids = {str(i.get("id")) for i in items if isinstance(i, dict)}
print("known_record_present=%s" % ("yes" if rec_id in ids else "no"))
if rec_id not in ids:
    fails.append("known_record_row")

body = get_raw("/api/v1/datasets/%s/data/%s/raw" % (rec_ds, rec_id))
try:
    parsed = json.loads(body)
    text = parsed.get("text", "") if isinstance(parsed, dict) else str(parsed)
except ValueError:
    text = body.decode("utf-8", "replace")     # documented: /raw may serve plain text
text = (text or "").strip()
print("raw_text_chars=%d" % len(text))
print("raw_text_head=%r" % text[:70])
if not text:
    fails.append("raw_text_empty")

query = " ".join(text.split()[:6]) or "memory"
res = call("/api/v1/search", {"query": query, "searchType": "CHUNKS",
                              "datasetIds": [rec_ds], "topK": 5})
rows = []
if isinstance(res, list):
    for r in res:
        rows += r.get("search_result") or []
elif isinstance(res, dict):
    rows = res.get("search_result") or res.get("results") or []
print("chunks_rows=%d" % len(rows))
joined = json.dumps(rows).lower()
hit = bool(rows) and (rec_id in joined or query.split()[0].lower() in joined)
print("chunks_hit=%s" % ("yes" if hit else "no"))
if not hit:
    fails.append("chunks_search")
print("RESULT=%s" % ("PASS" if not fails else "FAIL:" + ",".join(fails)))
PY

if [ "$KEEP" = 1 ]; then
  ev kept "compose project $PROJ on 10.20.10.15:$PORT (dir $R)"
else
  dc down -v >/dev/null 2>&1 || true
  rm -rf "$R/pg" "$R/cognee-storage" "$R/db.env" "$R/restore.env"
  ev teardown "containers removed, scratch data deleted; evidence kept at $EV"
fi
echo "RESTORE DONE ($(( $(date -u +%s) - T0 ))s)"
