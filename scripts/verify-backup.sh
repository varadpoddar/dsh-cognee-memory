#!/usr/bin/env bash
# Verify one side of a backup in place. Runs ON the host that owns the files.
#
#   verify-backup.sh --side cognee --ts 20261123T014500Z
#   verify-backup.sh --side dsh     --ts 20261123T014500Z
#
# Exit 0 only if checksums match, the payload parses, and the manifest is valid.
set -euo pipefail

SIDE=""; TS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --side) SIDE="${2:-}"; shift 2 ;;
    --ts)   TS="${2:-}"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ -n "$SIDE" ] && [ -n "$TS" ] || { echo "usage: verify-backup.sh --side <cognee|dsh> --ts <STAMP>" >&2; exit 2; }

DEST="/root/backups/dsh-cognee-$TS/$SIDE"
[ -d "$DEST" ] || { echo "FAIL: $DEST missing" >&2; exit 1; }
cd "$DEST"

checksums() {
  python3 - <<'PY'
import hashlib, sys
bad = 0
for line in open("SHA256SUMS"):
    line = line.rstrip("\n")
    if not line:
        continue
    want, rel = line.split("  ", 1)
    got = hashlib.sha256(open(rel, "rb").read()).hexdigest()
    if got != want:
        bad += 1
        print("MISMATCH %s" % rel)
print("sha256: %s (%d files)" % ("all OK" if bad == 0 else "%d BAD" % bad,
                                 sum(1 for _ in open("SHA256SUMS"))))
sys.exit(1 if bad else 0)
PY
}

manifest_summary() {
  python3 - <<'PY'
import json
d = json.load(open("MANIFEST.json"))
assert d["manifestVersion"] == 1
c = d["counts"]
print("manifest: side=%s ts=%s commit=%s plugin=%s" %
      (d["side"], d["timestamp"], d["commitSha"], d["pluginVersion"]))
print("manifest counts: " + ",".join("%s=%s" % (k, v) for k, v in c.items()
                                     if k != "source"))
print("manifest duration: %ss" % d.get("durationSeconds"))
PY
}

case "$SIDE" in
  cognee)
    checksums
    manifest_summary
    gzip -t cognee_db-all.sql.gz
    echo "gzip -t: OK ($(stat -c %s cognee_db-all.sql.gz) B)"
    echo "databases in dump: $(zcat cognee_db-all.sql.gz | grep -c '^CREATE DATABASE')"
    tar -tzf cognee-storage.tar.gz > /tmp/vb-storage.txt
    echo "storage entries: $(wc -l < /tmp/vb-storage.txt), graph: $(grep -c 'cognee_graph_ladybug' /tmp/vb-storage.txt)"
    rm -f /tmp/vb-storage.txt
    [ -e cognee.env ] && stat -c 'env mode: %a %U:%G %n' cognee.env
    ;;
  dsh)
    checksums
    manifest_summary
    tar -tzf dsh-home.tar.gz > /tmp/vb-home.txt
    echo "dsh-home entries: $(wc -l < /tmp/vb-home.txt)"
    echo "  ledger: $(grep -c 'provenance.json$' /tmp/vb-home.txt), profiles: $(grep -c '^profiles/' /tmp/vb-home.txt)"
    rm -f /tmp/vb-home.txt
    stat -c 'env mode: %a %U:%G %n' etc-dsh/*.env
    ;;
  *) echo "bad side" >&2; exit 2 ;;
esac
echo "VERIFY OK ($SIDE)"
