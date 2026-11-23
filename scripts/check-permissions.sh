#!/usr/bin/env bash
# Assert the on-disk permissions the DSH <-> Cognee deployment depends on.
#
#   ./scripts/check-permissions.sh              # check this host
#   DSH_HOME=/var/lib/deepseek-harness/.dsh ./scripts/check-permissions.sh
#
# Exit 0 = all invariants hold. Exit 1 = at least one violation, printed with the
# exact fix. Safe to run repeatedly; reads only.
#
# Rules (see docs/DEPLOYMENT.md):
#   /etc/dsh/*.env   0640 root:dsh   — they carry the Cognee API key and LLM keys
#   $DSH_HOME/**     owned by the service user (dsh), never root
#   profile state    not group/world writable, not world readable
set -euo pipefail

DSH_HOME="${DSH_HOME:-/var/lib/deepseek-harness/.dsh}"
ETC_DIR="${ETC_DIR:-/etc/dsh}"
SERVICE_USER="${SERVICE_USER:-dsh}"
fails=0

fail() { printf 'FAIL %s\n     %s\n' "$1" "$2"; fails=$((fails + 1)); }
ok()   { printf 'ok   %s\n' "$1"; }

# --- /etc/dsh/*.env ---------------------------------------------------------
shopt -s nullglob
env_files=("$ETC_DIR"/*.env)
shopt -u nullglob
if [ ${#env_files[@]} -eq 0 ]; then
  fail "$ETC_DIR/*.env" "no env files found — is this the right host?"
fi
for f in "${env_files[@]}"; do
  mode=$(stat -c '%a' "$f"); owner=$(stat -c '%U:%G' "$f")
  if [ "$mode" = "640" ] && [ "$owner" = "root:$SERVICE_USER" ]; then
    ok "$f 0640 root:$SERVICE_USER"
  else
    fail "$f" "is $mode $owner, want 0640 root:$SERVICE_USER — fix: install -m 0640 -o root -g $SERVICE_USER $f"
  fi
done

# --- $DSH_HOME ownership ----------------------------------------------------
[ -d "$DSH_HOME" ] || { fail "$DSH_HOME" "missing"; echo; echo "$fails violation(s)"; exit 1; }
owner=$(stat -c '%U:%G' "$DSH_HOME")
if [ "$owner" = "$SERVICE_USER:$SERVICE_USER" ]; then
  ok "$DSH_HOME owned by $SERVICE_USER"
else
  fail "$DSH_HOME" "is owned by $owner, want $SERVICE_USER:$SERVICE_USER — fix: chown -R $SERVICE_USER:$SERVICE_USER $DSH_HOME (never run pnpm/dsh plugin as root here)"
fi

# Root-owned files under .dsh are the failure mode that has already caused an
# outage: the service can read them but not rewrite its own state.
root_owned=$(find "$DSH_HOME" -user root -print 2>/dev/null | head -5 || true)
if [ -n "$root_owned" ]; then
  while read -r p; do
    [ -n "$p" ] && fail "$p" "is owned by root — fix: chown $SERVICE_USER:$SERVICE_USER $p"
  done <<< "$root_owned"
else
  ok "$DSH_HOME has no root-owned entries"
fi

# --- profile state reachability --------------------------------------------
for p in "$DSH_HOME/profiles" "$DSH_HOME/sessions" "$DSH_HOME/plugins/cognee-memory"; do
  [ -e "$p" ] || { fail "$p" "missing"; continue; }
  mode=$(stat -c '%a' "$p")
  case "$mode" in
    *[1-7]) fail "$p" "mode $mode is world-accessible — fix: chmod -R o-rwx $p" ;;
    *) ok "$p mode $mode" ;;
  esac
done

if [ "$fails" -eq 0 ]; then
  echo "PASS: all permission invariants hold"
  exit 0
fi
echo
echo "$fails violation(s)"
exit 1
