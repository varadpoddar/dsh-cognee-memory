#!/usr/bin/env bash
# Driver: takes one application-consistent backup of the DSH <-> Cognee stack
# from a workstation, with a single shared timestamp for both halves.
#
#   PVE=root@control.nomad.opsc.io KEY=~/.ssh/dsh scripts/backup-all.sh
#
# It pushes scripts/backup.sh into CT 106 (Cognee) and CT 103 (DSH) and runs the
# matching half in each. Nothing is deleted; each run creates a new directory
# /root/backups/dsh-cognee-<ts>/ on both containers and never overwrites one.
set -euo pipefail

PVE="${PVE:-root@control.nomad.opsc.io}"
KEY="${KEY:-$HOME/.ssh/dsh}"
SSH=(ssh -o StrictHostKeyChecking=no -o ConnectTimeout=10 -i "$KEY" "$PVE")
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
COMMIT="$(git -C "$repo" rev-parse --short HEAD 2>/dev/null || echo unknown)"
PLUGIN="$(node -p "require('$repo/package.json').version" 2>/dev/null || echo unknown)"

echo "[backup] ts=$TS commit=$COMMIT plugin=$PLUGIN"

"${SSH[@]}" "cat > /tmp/backup.sh" < "$here/backup.sh"
"${SSH[@]}" "pct push 106 /tmp/backup.sh /root/backup.sh --perms 0755 && \
             pct push 103 /tmp/backup.sh /root/backup.sh --perms 0755"

echo "[backup] CT106 cognee side"
"${SSH[@]}" "pct exec 106 -- bash /root/backup.sh --side cognee --ts '$TS' \
               --commit '$COMMIT' --plugin '$PLUGIN'" 2>&1 | tail -6

echo "[backup] CT103 dsh side"
"${SSH[@]}" "pct exec 103 -- bash /root/backup.sh --side dsh --ts '$TS' \
               --commit '$COMMIT' --plugin '$PLUGIN'" 2>&1 | tail -6

echo "[backup] verifying checksums and dump listing"
"${SSH[@]}" "pct exec 106 -- bash -c '
  set -e
  d=/root/backups/dsh-cognee-$TS/cognee
  cd \$d
  python3 - <<PY
import hashlib
bad = 0
for line in open(\"SHA256SUMS\"):
    want, rel = line.rstrip().split(\"  \", 1)
    got = hashlib.sha256(open(rel, \"rb\").read()).hexdigest()
    if got != want:
        bad += 1
        print(\"MISMATCH\", rel)
print(\"sha256: all OK\" if bad == 0 else \"sha256: %d BAD\" % bad)
PY
  docker exec -i cognee-db pg_restore -l < \$d/cognee_db.dump > /tmp/pglist.txt
  python3 - <<PY
lines = open("/tmp/pglist.txt").read().splitlines()
kinds = ("TABLE DATA", "TABLE", "SEQUENCE", "CONSTRAINT", "INDEX")
objs = [l for l in lines if any(" %s " % k in l for k in kinds)]
tdata = [l for l in lines if " TABLE DATA " in l]
print("pg_restore -l: OK (%d objects, %d table-data entries)" % (len(objs), len(tdata)))
PY
  rm -f /tmp/pglist.txt
'"

"${SSH[@]}" "pct exec 103 -- bash -c '
  cd /root/backups/dsh-cognee-$TS/dsh
  python3 - <<PY
import hashlib
bad = 0
for line in open(\"SHA256SUMS\"):
    want, rel = line.rstrip().split(\"  \", 1)
    got = hashlib.sha256(open(rel, \"rb\").read()).hexdigest()
    if got != want:
        bad += 1
        print(\"MISMATCH\", rel)
print(\"sha256: all OK\" if bad == 0 else \"sha256: %d BAD\" % bad)
PY
  systemctl show -p SubState deepseek-harness.service
'"

"${SSH[@]}" "pct exec 106 -- docker ps --format '{{.Names}} {{.Status}}'"
echo "[backup] manifest: /root/backups/dsh-cognee-$TS/{cognee,dsh}/MANIFEST.json"
