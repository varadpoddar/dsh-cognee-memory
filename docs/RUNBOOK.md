# Runbook — dsh-cognee-memory in production

Operations for the CT 103 harness and its CT 106 Cognee backend. Every command is
read-only unless it says otherwise. Run host commands from your workstation with
`KEY=~/.ssh/dsh PVE=root@control.nomad.opsc.io` (the scripts assume both).

Facts this runbook relies on: DSH user `dsh`, `DSH_HOME=/var/lib/deepseek-harness/.dsh`,
unit `deepseek-harness.service`; Cognee at `http://10.20.10.15:8000/api/v1`
(CT 106, `/opt/stacks/cognee`); keys in `/etc/dsh/cognee.env` and
`/etc/dsh/llm.env`, both `0640 root:dsh`.

**Never** run `mv`, `pnpm`, or `dsh plugin` as root under `$DSH_HOME`. Use
`su dsh -s /bin/bash -c '…'`. After any change confirm
`systemctl show -p SubState deepseek-harness.service` → `running`.

## 1. Health checks

```bash
# service
pct exec 103 -- systemctl is-active deepseek-harness
pct exec 103 -- systemctl show -p SubState deepseek-harness.service

# recent errors
pct exec 103 -- journalctl -u deepseek-harness -n 100 --no-pager | tail -40

# Cognee answers and owns data
pct exec 103 -- su dsh -s /bin/bash -c 'set -a; . /etc/dsh/cognee.env; set +a; \
  curl -s -H "X-Api-Key: $COGNEE_API_KEY" http://10.20.10.15:8000/api/v1/datasets \
  | python3 -c "import json,sys; print(len(json.load(sys.stdin)))"'

# end-to-end: one fresh headless turn must recall the fixture
pct exec 103 -- su dsh -s /bin/bash -c 'set -a; . /etc/dsh/cognee.env; . /etc/dsh/llm.env; set +a; \
  DSH_HOME=/var/lib/deepseek-harness/.dsh timeout 120 dsh headless \
  "What is the release codename? Reply with only the codename."'
# expect: amber-otter-7731

# on-disk invariants (ownership + modes)
DSH_HOME=/var/lib/deepseek-harness/.dsh ./scripts/check-permissions.sh
```

Memory state and counts live on the settings page
(`/plugins/cognee-memory/settings.json`, needs `COGNEE_MEMORY_SETTINGS_TOKEN`) and
in the provenance sidecar `$DSH_HOME/plugins/cognee-memory/provenance.json`.

## 2. Common failures

| Symptom | Diagnosis | Fix |
|---|---|---|
| Unit not `running` after a profile edit | Bad YAML or a hook threw during load | `journalctl -u deepseek-harness -n 200`; fix the patch file; `systemctl restart deepseek-harness` |
| `EACCES` on a profile file, service down | A root-owned file under `$DSH_HOME` | `chown -R dsh:dsh /var/lib/deepseek-harness/.dsh` — never edit as root |
| Service cannot read a key, recall/model dead | `/etc/dsh/*.env` is `0600` or root-only | `install -o root -g dsh -m 0640 <new> /etc/dsh/cognee.env` (same for `llm.env`), then restart |
| Model calls `401` | Stale Studio key | rotate `llm.env` (§3), restart |
| Recall empty, first turn only | Cognee cold/slow; prefetch budget (1500 ms) expired — fails open by design | warm the endpoint; consider raising `prefetch.timeoutMs`/`retrieval.budgetMs` (see `docs/FIRST_TURN_PROOF.md`) |
| Recall slow on every turn | Cognee load or oversized dataset | check CT 106 resources, `recall.maxRecallLatencyMs`, dataset size; failure mode is `open`, so turns still answer |
| Cognee unreachable | CT 106 stack down | `pct exec 106 -- docker compose -f /opt/stacks/cognee/compose.yaml ps`; restart that stack, then the harness |
| Plugin not loaded: no tools, no memory block | profile bundle missing or entry disabled | `dsh --profile web --dump-config \| grep cognee-memory`; reinstall the layer (§5) |
| Settings page `401` | missing/incorrect `COGNEE_MEMORY_SETTINGS_TOKEN` | pass `?token=…` or `Authorization: Bearer …`; token lives in the harness environment |
| Settings page `503` | Cognee or the plugin is not ready | check service and Cognee health first; do not rotate keys to "fix" it |
| Disk filling | `sessions/`, `storages/`, backups | `du -sh $DSH_HOME/* /root/backups/*`; prune **only** with approval — backups are never deleted automatically |

## 3. Rotate keys

Cognee key (CT 106 → CT 103). Write a temp file, install with the right mode,
remove the temp, restart, verify:

```bash
pct exec 103 -- bash -c 'umask 077; printf "COGNEE_API_KEY=%s\n" "<new-key>" > /etc/dsh/cognee.env.new'
pct exec 103 -- install -o root -g dsh -m 0640 /etc/dsh/cognee.env.new /etc/dsh/cognee.env
pct exec 103 -- rm -f /etc/dsh/cognee.env.new
pct exec 103 -- systemctl restart deepseek-harness
pct exec 103 -- systemctl show -p SubState deepseek-harness.service   # running
```

Model/Studio key (401 recovery):

```bash
pct exec 103 -- bash -c "ssh root@10.20.10.30 'cat /root/.studio.key' > /etc/dsh/llm.env.new"
pct exec 103 -- install -o root -g dsh -m 0640 /etc/dsh/llm.env.new /etc/dsh/llm.env
pct exec 103 -- rm -f /etc/dsh/llm.env.new
pct exec 103 -- systemctl restart deepseek-harness
```

The web profile can also re-enter the provider key in the UI; DSH stores provider
keys, this plugin does not.

## 4. Re-point Cognee

Precedence: stored settings > environment > profile default
(`docs/SETTINGS.md`). Preferred: the settings page → save → it retargets the
running adapter without a restart; confirm with a status read and one recall.
Config-file route: `/var/lib/deepseek-harness/.dsh/plugins/cognee-memory/settings.json`
(owned by `dsh`), or the profile's `cognee-memory` config entry, then restart.
In-flight recalls fail open and the next turn uses the new endpoint. Changing the
endpoint does **not** migrate data; scopes resolve to datasets on the new backend.

## 5. Backup and restore

Full procedure: `docs/BACKUP.md`, `docs/RESTORE.md`. Cadence: before any upgrade,
before changing scopes, and at least daily if memory matters.

```bash
PVE=root@control.nomad.opsc.io KEY=~/.ssh/dsh scripts/backup-all.sh   # both halves, one timestamp
./scripts/verify-backup.sh --side cognee --ts <STAMP>                  # run ON CT 106
./scripts/verify-backup.sh --side dsh     --ts <STAMP>                  # run ON CT 103
```

Restore drill (never touches production): `scripts/restore-drill.sh --ts <STAMP>`
on CT 106, port 18001, tears itself down; measured 38 s to a serving copy
(`docs/RESTORE.md`). Restore must use the `pg_dumpall` dump — a single-DB dump
restores the graph but breaks every `CHUNKS` search. Never delete a backup or the
`/root/restore-test-*` evidence without approval.

## 6. Roll back a release

No npm publish, so the artifact is the tarball in `release-candidates/`.

1. Remove the layer: `su dsh -s /bin/bash -c 'DSH_HOME=… dsh plugin --profile web remove dsh-cognee-memory'`.
2. Restore the profile's `package.json` from the backup
   `/root/backups/dsh-cognee-<ts>/dsh/dsh-home.tar.gz` (or `git`-tracked source).
3. `systemctl restart deepseek-harness`; confirm `SubState=running` and one
   headless recall answers the fixture.
4. Memory data is preserved: the plugin never deletes Cognee datasets on
   rollback. Full detail and triggers: `ROLLBACK.md`.
