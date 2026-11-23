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
"${SSH[@]}" "cat > /tmp/verify-backup.sh" < "$here/verify-backup.sh"
"${SSH[@]}" "pct push 106 /tmp/backup.sh /root/backup.sh --perms 0755 && \
             pct push 103 /tmp/backup.sh /root/backup.sh --perms 0755"

echo "[backup] CT106 cognee side"
"${SSH[@]}" "pct exec 106 -- bash /root/backup.sh --side cognee --ts '$TS' \
               --commit '$COMMIT' --plugin '$PLUGIN'" 2>&1 | tail -6

echo "[backup] CT103 dsh side"
"${SSH[@]}" "pct exec 103 -- bash /root/backup.sh --side dsh --ts '$TS' \
               --commit '$COMMIT' --plugin '$PLUGIN'" 2>&1 | tail -6

echo "[backup] verifying both sides"
"${SSH[@]}" "pct push 106 /tmp/verify-backup.sh /root/verify-backup.sh --perms 0700 \
             && pct push 103 /tmp/verify-backup.sh /root/verify-backup.sh --perms 0700"
"${SSH[@]}" "pct exec 106 -- bash /root/verify-backup.sh --side cognee --ts '$TS'" 2>&1 | tail -10
"${SSH[@]}" "pct exec 103 -- bash /root/verify-backup.sh --side dsh --ts '$TS'" 2>&1 | tail -10

echo "[backup] post-run health"
"${SSH[@]}" "pct exec 106 -- docker ps --format '{{.Names}} {{.Status}}'"
"${SSH[@]}" "pct exec 103 -- systemctl show -p SubState deepseek-harness.service"
echo "[backup] manifest: /root/backups/dsh-cognee-$TS/{cognee,dsh}/MANIFEST.json"
