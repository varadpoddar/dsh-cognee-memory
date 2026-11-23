#!/usr/bin/env bash
# Application-consistent backup for the DSH <-> Cognee memory stack.
#
# Runs ON the host that owns the state (CT 106 for Cognee, CT 103 for DSH).
# It is driven from outside by scripts/backup-all.sh, which passes the shared
# --ts plus the version facts, so both halves land under one timestamp.
#
#   backup.sh --side cognee --ts 20261123T021500Z [--commit <sha>] [--plugin <ver>]
#   backup.sh --side dsh     --ts 20261123T021500Z [--commit <sha>] [--plugin <ver>]
#
# Exit codes: 0 ok, 2 usage, anything else = failure (and writers are un-paused
# by the EXIT trap before the process dies).
set -euo pipefail

SIDE=""
TS=""
COMMIT="unknown"
PLUGIN="unknown"

usage() {
  echo "usage: backup.sh --side <cognee|dsh> --ts <UTCSTAMP> [--commit <sha>] [--plugin <version>]" >&2
  exit 2
}

while [ $# -gt 0 ]; do
  case "$1" in
    --side)   SIDE="${2:-}"; shift 2 ;;
    --ts)     TS="${2:-}"; shift 2 ;;
    --commit) COMMIT="${2:-}"; shift 2 ;;
    --plugin) PLUGIN="${2:-}"; shift 2 ;;
    -h|--help) usage ;;
    *) echo "unknown argument: $1" >&2; usage ;;
  esac
done

[ -n "$SIDE" ] && [ -n "$TS" ] || usage
case "$TS" in
  [0-9]*T[0-9]*Z) ;;
  *) echo "bad --ts '$TS' (want e.g. 20261123T021500Z)" >&2; exit 2 ;;
esac

BACKUP_ROOT="/root/backups/dsh-cognee-$TS"

say() { printf '[backup:%s] %s\n' "$SIDE" "$*"; }
die() { printf '[backup:%s] ERROR: %s\n' "$SIDE" "$*" >&2; exit 1; }

# sha256 manifest over every regular file in $1 (excluding the manifest itself).
checksum_tree() {
  python3 - "$1" <<'PY'
import hashlib, os, sys
root = sys.argv[1]
lines = []
for dp, _dn, fns in os.walk(root):
    for fn in fns:
        p = os.path.join(dp, fn)
        rel = os.path.relpath(p, root)
        if rel in ("SHA256SUMS", "MANIFEST.json"):
            continue
        with open(p, "rb") as fh:
            lines.append("%s  %s" % (hashlib.sha256(fh.read()).hexdigest(), rel))
with open(os.path.join(root, "SHA256SUMS"), "w") as fh:
    fh.write("\n".join(sorted(lines)) + "\n")
print("%d files" % len(lines))
PY
}

# ---------------------------------------------------------------- Cognee side
side_cognee() {
  local stack=/opt/stacks/cognee
  local dest="$BACKUP_ROOT/cognee"
  local started ended

  [ -f "$stack/.env" ] || die "missing $stack/.env"
  [ -f "$stack/compose.yaml" ] || die "missing $stack/compose.yaml"

  # Parse only what we need: the file is a compose env_file and may hold values
  # (e.g. LLM_ARGS JSON) that are not safe to `source` as shell.
  envval() { grep -E "^$1=" "$stack/.env" | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
  DB_NAME=$(envval DB_NAME); DB_USERNAME=$(envval DB_USERNAME); DB_PASSWORD=$(envval DB_PASSWORD)
  : "${DB_NAME:?}" "${DB_USERNAME:?}" "${DB_PASSWORD:?}"

  mkdir -p "$dest"; chmod 0700 "$BACKUP_ROOT" "$dest"
  started=$(date -u +%s)

  say "waiting for cognee-db"
  for _ in $(seq 1 30); do
    docker exec cognee-db pg_isready -U "$DB_USERNAME" -d "$DB_NAME" >/dev/null 2>&1 && break
    sleep 1
  done
  docker exec cognee-db pg_isready -U "$DB_USERNAME" -d "$DB_NAME" >/dev/null 2>&1 \
    || die "cognee-db not ready"

  # Quiesce writers so the embedded ladybug graph file is not being rewritten
  # while we tar it. Postgres itself is transactionally safe for pg_dump, but it
  # keeps serving the (paused) API's connections, so we dump after the pause and
  # get one consistent cut across graph + relational.
  trap 'docker unpause cognee cognee-ui >/dev/null 2>&1 || true' EXIT
  say "pausing cognee, cognee-ui (writes quiesced)"
  docker pause cognee cognee-ui >/dev/null

  say "pg_dump -Fc $DB_NAME -> cognee_db.dump"
  docker exec -e PGPASSWORD="$DB_PASSWORD" cognee-db \
    pg_dump -U "$DB_USERNAME" -Fc "$DB_NAME" > "$dest/cognee_db.dump" \
    || die "pg_dump failed"

  say "copying storage dir (ladybug graph + file storage)"
  tar -czf "$dest/cognee-storage.tar.gz" -C "$stack/data" cognee \
    || die "storage tar failed"

  say "copying .env (mode preserved) and compose.yaml"
  cp -a "$stack/.env" "$dest/cognee.env"
  cp -a "$stack/compose.yaml" "$dest/compose.yaml"
  [ -f "$stack/.env.example" ] && cp -a "$stack/.env.example" "$dest/.env.example" || true
  chmod 0600 "$dest/cognee.env"

  say "unpausing writers"
  docker unpause cognee cognee-ui >/dev/null
  trap - EXIT

  # Exact counts from postgres (see docs/BACKUP.md: SQL, not API, so datasets
  # owned by non-DSH principals are included).
  local datasets items tables user_tables
  psql_q() {
    docker exec -e PGPASSWORD="$DB_PASSWORD" cognee-db \
      psql -U "$DB_USERNAME" -d "$DB_NAME" -Atc "$1"
  }
  datasets=$(psql_q "select count(*) from datasets") || die "count datasets"
  items=$(psql_q "select count(*) from data") || die "count data"
  user_tables=$(psql_q "select count(*) from information_schema.tables where table_schema='public'") \
    || die "count tables"
  tables=$(psql_q "select relname||'='||n_live_tup from pg_stat_user_tables order by relname" \
    | paste -sd, -)

  local version="unknown"
  version=$(docker logs cognee 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+-local' | tail -1 || true)
  if [ -z "$version" ] && [ -r /etc/dsh/cognee.env ]; then
    version=$(python3 - <<'PY' 2>/dev/null || true
import json, urllib.request
key = ""
for line in open("/etc/dsh/cognee.env"):
    if line.startswith("COGNEE_API_KEY"):
        key = line.split("=", 1)[1].strip().strip('"').strip("'")
req = urllib.request.Request("http://10.20.10.15:8000/health/detailed",
                             headers={"X-Api-Key": key})
print(json.load(urllib.request.urlopen(req, timeout=5)).get("version", ""))
PY
)
  fi
  [ -n "$version" ] || version="unknown"

  ended=$(date -u +%s)
  local dump_bytes storage_bytes
  dump_bytes=$(stat -c %s "$dest/cognee_db.dump")
  storage_bytes=$(stat -c %s "$dest/cognee-storage.tar.gz")
  local nfiles
  nfiles=$(checksum_tree "$dest" | cut -d" " -f1)

  cat > "$dest/MANIFEST.json" <<EOF
{
  "manifestVersion": 1,
  "side": "cognee",
  "timestamp": "$TS",
  "commitSha": "$COMMIT",
  "pluginVersion": "$PLUGIN",
  "cogneeVersion": "$version",
  "host": "CT106",
  "durationSeconds": $((ended - started)),
  "quiesce": "docker pause cognee cognee-ui around pg_dump + storage tar; auto-unpause on exit",
  "counts": {
    "datasets": $datasets,
    "dataItems": $items,
    "publicTables": $user_tables,
    "source": "postgres SQL (exact; includes datasets not visible to the DSH API key)"
  },
  "tableRowCounts": "$tables",
  "files": {
    "cognee_db.dump": { "bytes": $dump_bytes, "format": "pg_dump -Fc" },
    "cognee-storage.tar.gz": { "bytes": $storage_bytes, "contains": "data/cognee: ladybug graph, system/databases, local file storage" },
    "cognee.env": { "bytes": $(stat -c %s "$dest/cognee.env"), "note": "secrets; mode 0600" },
    "compose.yaml": { "bytes": $(stat -c %s "$dest/compose.yaml") }
  },
  "checksums": { "file": "SHA256SUMS", "files": $nfiles }
}
EOF

  say "done: $dest (dump ${dump_bytes}B, storage ${storage_bytes}B, ${nfiles} checksummed, $((ended - started))s)"
  say "counts: datasets=$datasets items=$items tables=$user_tables cognee=$version"
}

# ------------------------------------------------------------------- DSH side
side_dsh() {
  local home=/var/lib/deepseek-harness/.dsh
  local dest="$BACKUP_ROOT/dsh"
  local started ended

  [ -d "$home" ] || die "missing $home"
  mkdir -p "$dest" "$dest/etc-dsh"
  chmod 0700 "$BACKUP_ROOT" "$dest" "$dest/etc-dsh"
  started=$(date -u +%s)

  # Read as root is fine; nothing here writes inside $DSH_HOME, which stays
  # dsh-owned (root-owned files under .dsh have caused an outage before).
  say "archiving \$DSH_HOME (profiles, sessions, plugin ledger, credentials)"
  tar -czf "$dest/dsh-home.tar.gz" -C "$home" \
    profiles sessions plugins/cognee-memory \
    .credentials.yaml .anonymous-user-id \
    || die "dsh-home tar failed"
  chmod 0600 "$dest/dsh-home.tar.gz"

  say "copying /etc/dsh/*.env (mode 0640 root:dsh preserved)"
  cp -a /etc/dsh/*.env "$dest/etc-dsh/" || die "env copy failed"
  cp -a /etc/dsh/dsh.env.example "$dest/etc-dsh/" 2>/dev/null || true

  local ledger="$home/plugins/cognee-memory/provenance.json"
  local entries=0 datasets=0 profiles
  if [ -f "$ledger" ]; then
    read -r entries datasets < <(python3 - "$ledger" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
e = d.get("entries", [])
names = {(x.get("dataset") or {}).get("name") for x in e} - {None}
print(len(e), len(names))
PY
)
  fi
  profiles=$(ls -1 "$home/profiles" | wc -l | tr -d ' ')

  ended=$(date -u +%s)
  local nfiles
  nfiles=$(checksum_tree "$dest" | cut -d" " -f1)

  cat > "$dest/MANIFEST.json" <<EOF
{
  "manifestVersion": 1,
  "side": "dsh",
  "timestamp": "$TS",
  "commitSha": "$COMMIT",
  "pluginVersion": "$PLUGIN",
  "host": "CT103",
  "dshHome": "$home",
  "durationSeconds": $((ended - started)),
  "counts": {
    "ledgerEntries": ${entries:-0},
    "ledgerDistinctDatasets": ${datasets:-0},
    "profiles": ${profiles:-0},
    "source": "plugins/cognee-memory/provenance.json + profiles/ listing"
  },
  "files": {
    "dsh-home.tar.gz": { "bytes": $(stat -c %s "$dest/dsh-home.tar.gz"), "contains": "profiles/, sessions/, plugins/cognee-memory/, .credentials.yaml, .anonymous-user-id", "note": "contains credentials; mode 0600" },
    "etc-dsh/": { "files": $(ls -1 "$dest/etc-dsh" | wc -l | tr -d ' '), "note": "*.env at 0640 root:dsh" }
  },
  "checksums": { "file": "SHA256SUMS", "files": $nfiles }
}
EOF

  say "done: $dest ($(stat -c %s "$dest/dsh-home.tar.gz")B, ${nfiles} checksummed, $((ended - started))s)"
  say "ledger entries=$entries datasets=$datasets profiles=$profiles"
}

case "$SIDE" in
  cognee) side_cognee ;;
  dsh)    side_dsh ;;
  *) echo "bad --side '$SIDE'" >&2; usage ;;
esac
