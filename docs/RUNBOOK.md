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

## 7. Reset the web profile to base (no plugin)

This is the procedure used to prove the 1.0.2 layer loads from a clean base. It
keeps the data and backs up the whole state directory first; it does not delete
Cognee datasets or the legacy tarballs.

```bash
# on the Proxmox host, into CT 103
TS=$(date +%s); B=/root/backups/dsh-pre-reset-$TS
pct exec 103 -- systemctl stop deepseek-harness
pct exec 103 -- bash -c "mkdir -p $B && cp -a /var/lib/deepseek-harness/.dsh $B/dsh \
  && (cd $B && find dsh -type f -print0 | sort -z | xargs -0 sha256sum > SHA256SUMS)"
```

Then, **as `dsh`**, remove `dsh-cognee-memory` from
`profiles/web/package.json` (`dependencies` and `dsh.profile.bundles`) and delete
its `- id: cognee-memory` row from `profiles/web/cordis.patch.yml` (keep
`cordis.patch.yml.bak-baseline`). Run `dsh plugin --profile web install`, restart,
and require `systemctl show -p SubState deepseek-harness.service` → `running`
with no `cognee-memory` row in `dsh --profile web --dump-config`. Re-add the
packed tarball with `dsh plugin --profile web add <tgz>` and restore the config
row; `--dump-config` must contain `- id: cognee-memory` again.

## 8. Check the 1.0.2 panel through Traefik

The operator token is in `/etc/dsh/cognee.env`; never print it. Pick an id from
the authenticated list, then check the public origin:

```bash
pct exec 103 -- bash -c 'set -a; . /etc/dsh/cognee.env; set +a; \
  ID=$(curl -s -H "Authorization: Bearer $COGNEE_MEMORY_SETTINGS_TOKEN" \
    https://dsh.nomad.opsc.io/plugins/cognee-memory/memories.json \
    | python3 -c "import json,sys; print(json.load(sys.stdin)[\"memories\"][0][\"id\"])"); \
  for u in "" "?format=page"; do \
    curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $COGNEE_MEMORY_SETTINGS_TOKEN" \
      "https://dsh.nomad.opsc.io/plugins/cognee-memory/memory/$ID$u"; \
  done'
# expect 200 200; without the header 401; a foreign id 404
```

The `Known context:` block now ends every line with the absolute panel URL. The
retrieval cap is still stable 300 + query 900; if the added URL would exceed it,
the formatter drops whole lower-ranked items rather than splitting a line.

## 9. Nightly ingest queue (deployed CLI, timer)

The archival pipeline runs as a standalone CLI from `/opt/dsh-cognee-memory`
(package 1.0.3, `npm install --omit=dev`, built `lib/`), as user `varad`, against
`DSH_HOME=/home/varad/.dsh` — the live `dsh` instance's home is not involved.

```bash
# state (read-only)
pct exec 103 -- su varad -s /bin/bash -c 'cd /opt/dsh-cognee-memory; set -a; \
  . /etc/dsh-varad/varad.env; set +a; export DSH_HOME=/home/varad/.dsh; \
  node lib/cli/main.js queue status --json'

# timer + last/next run
pct exec 103 -- systemctl list-timers dsh-cognify-queue.timer --no-pager

# manual drain (dry run first; `--apply` writes)
pct exec 103 -- su varad -s /bin/bash -c 'cd /opt/dsh-cognee-memory; set -a; \
  . /etc/dsh-varad/varad.env; set +a; \
  export DSH_HOME=/home/varad/.dsh COGNEE_MEMORY_API_BASE_URL=http://10.20.10.15:8000/api/v1; \
  node lib/cli/main.js queue drain --workers 2; \
  node lib/cli/main.js queue drain --apply --workers 2 --json'

# trigger one nightly run now (same env as the unit)
pct exec 103 -- systemctl start dsh-cognify-queue.service
pct exec 103 -- journalctl -u dsh-cognify-queue -n 20 --no-pager
```

Gotchas learned the hard way (2026-11-24):

- **Base URL.** The CLI reads `COGNEE_MEMORY_API_BASE_URL`, not the
  `COGNEE_BASE_URL` used by the MCP servers. Unset, it silently defaults to
  `http://127.0.0.1:8000` and retries; the unit now sets it explicitly.
- **Silent early exit.** Retry backoff sleeps unref their timer, so a standalone
  drain used to empty the event loop and exit 0 mid-retry with items left
  `inflight`. Fixed by a ref'd keep-alive for the duration of the drain; if you
  see `inflight` without a running node process, the lease reclaims after 15 min.
- **Dataset name vs scope name.** The dataset is `dsh-<scope>-<scopeId>`; the
  varad instance's project id carries a hash suffix
  (`varad-mac-history-5c5a11e6b8d6859e32a4`). Enqueueing `project:varad-mac-history`
  creates a *parallel* dataset and the live instance never recalls from it.
  Copy the id from `memory_status` or `provenance.json`, never from a doc summary.
- **Workers.** `--workers` is capped by the number of targets; two aliases of one
  base URL (`COGNEE_QUEUE_ENDPOINTS=a=url,b=url`) is how to run two workers
  against a single endpoint.

Backups written before the 2026-11-24 backfill in
`/home/varad/.dsh/plugins/cognee-memory/`: `ingest-queue.pre-backfill.bak` (pristine
247-item queue) and `ledger.pre-backfill.bak` (ledger snapshot). The queue log is
append-only JSONL; `queue status` folds it, `IngestQueue.compact()` is the only
truncation.

### Turn journal (conversations as tasks)

`ingestion.journal.enabled: true` makes the plugin append every conversation
part — your messages and the agent's answers — to `ingest-queue.jsonl` at
`turn/end`. The 04:00 drain ingests them; a task is deleted only after a
complete ingest and its hash is kept in `ingest-queue.jsonl.done`. Pending,
inflight and failed tasks survive restarts and prunes. Design and limits:
`docs/TURN_JOURNAL.md`.

```bash
# what is waiting (same numbers as the settings page "Conversation tasks")
pct exec 103 -- su varad -s /bin/bash -c 'cd /opt/dsh-cognee-memory; set -a; \
  . /etc/dsh-varad/varad.env; set +a; DSH_HOME=/home/varad/.dsh \
  node lib/cli/main.js queue status --json'

# drain now (prunes completed tasks at the end)
pct exec 103 -- su varad -s /bin/bash -c 'cd /opt/dsh-cognee-memory; set -a; \
  . /etc/dsh-varad/varad.env; set +a; \
  DSH_HOME=/home/varad/.dsh COGNEE_MEMORY_API_BASE_URL=http://10.20.10.15:8000/api/v1 \
  node lib/cli/main.js queue drain --apply --workers 2'
```

The journal writes to the **project scope named in the profile**
(`scopeDefaults.projectId`). On 2026-11-24 the varad `web` profile still pointed
at `varad/project/e2e` while the backfilled history lived in
`dsh-project-varad-mac-history-5c5a11e6b8d6859e32a4`; the public GUI recalled
neither. Both profiles now name `varad/mac-history`. Check with
`GET /plugins/cognee-memory/settings.json` → `inspection.scopes.project`.

## 10. Make the varad instance the default public workspace

`dsh.nomad.opsc.io` is a Traefik route (CT 104) to one plain-HTTP listener on
CT 103. Switching it from the `dsh` instance (3080) to `varad` (3081) is three
independent, reversible edits — do them in this order and probe after each:

```bash
# 1. varad must accept the public Host header, or every request gets 403
#    (/etc/systemd/system/deepseek-harness-varad.service)
#      --public-url https://dsh.nomad.opsc.io/
#      --trusted-host dsh.nomad.opsc.io
pct exec 103 -- systemctl daemon-reload
pct exec 103 -- systemctl restart deepseek-harness-varad
pct exec 103 -- curl -s -o /dev/null -w '%{http_code}\n' \
  -H 'Host: dsh.nomad.opsc.io' http://10.20.10.12:3081/api/health      # 401, not 403

# 2. nftables on CT 103: admit 3081 from Traefik only (mirror the 3080 rule)
grep -n 'dport 3081' /etc/nftables.conf    # add: ip saddr 10.20.10.13 tcp dport 3081 accept
pct exec 103 -- nft -f /etc/nftables.conf

# 3. Traefik service upstream (CT 104) — file provider reloads without restart
sed -i 's#http://10.20.10.12:3080#http://10.20.10.12:3081#' \
  /etc/traefik/dynamic/dsh.yml
```

Verify from CT 104 that the public host is served by varad — the settings token
is instance-specific, so it identifies the backend:

```bash
T=$(pct exec 103 -- grep -h COGNEE_MEMORY_SETTINGS_TOKEN /etc/dsh-varad/varad.env | cut -d= -f2)
pct exec 104 -- curl -sk -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $T" \
  https://dsh.nomad.opsc.io/plugins/cognee-memory/settings.json      # 200 = varad
```

Also update the varad web profile's `settings.publicBaseUrl` to
`https://dsh.nomad.opsc.io` (`profiles/web/cordis.patch.yml`) so panel links do
not point at the LAN-only URL, then restart varad. The per-instance login URL
and token are printed at startup: `journalctl -u deepseek-harness-varad | grep token`.

**Rollback** is the reverse: restore the three backups (`dsh.yml.bak-<ts>`,
`nftables.conf.bak-<ts>`, `varad.service.bak-<ts>` from `/root/backups`), reload
Traefik (automatic) and `nft -f`, `systemctl daemon-reload`, restart varad.

**What moved:** only *memories* (the extracted user turns in Cognee). Session
transcripts were not copied — the varad GUI starts with an empty conversation
list and full recall. Copying `sessions/` from the Mac would make old threads
visible, but their recorded cwd (`/Users/varad/…`) does not exist on CT 103, so
resuming them would run tools against a missing directory; recall is the
supported way to continue that history.

## 4. Ownership of the plugin state dir (silent memory loss)

The state directory `/home/varad/.dsh/plugins/cognee-memory/` must be owned by
`varad`. If a root-run process writes into it, the damage is **silent**:

- `ingest-queue.jsonl` becomes `root:root 0600`, so the varad service can no
  longer append a journal row — new turns are simply not queued, and the service
  logs nothing until it tries to journal one;
- a varad reconciler/backfill fails `enqueue` with
  `EACCES: permission denied, open '.../ingest-queue.jsonl'` and counts it as a
  per-segment `FAIL`, so the summaries it just paid for are dropped.

This has happened twice: once from a root `pnpm`/`mv` under the profile dir
(which also produced a `profiles/web` restart loop), and once from a root
`dsh --profile headless` verification run with `DSH_HOME=/home/varad/.dsh`.
**Never run `dsh`, `pnpm`, `mv` or a plugin script as root under a DSH home** —
use `su -s /bin/bash varad -c '...'`, and pass the token/env in, not `sudo`.

Diagnose and repair:

```bash
find /home/varad/.dsh/plugins/cognee-memory -not -user varad      # offenders
journalctl -t cognee-owner-guard -n 20 --no-pager                 # repairs
```

`dsh-cognee-owner-guard.timer` (installed by hand on CT 103, every 10 min)
re-owns anything `varad` does not own and logs every path it touched under
`cognee-owner-guard`. It is a safety net, not a licence to run as root: it
repairs *files*, not the lost work — segments whose enqueue failed must be
re-summarised (see §5).

```bash
systemctl list-timers dsh-cognee-owner-guard.timer --no-pager
```

## 5. Finishing an interrupted backfill

Two loops keep the queue moving while a producer runs. Both are plain scripts in
`/home/varad` and both are safe to re-run — enqueue dedupes, the drain uses
leases and tombstones, and 1.0.9 folds the on-disk log under the writer lock so a
concurrent prune cannot drop a row.

| Script | Does |
| --- | --- |
| `drain-watch.sh` | drains while `reconcile-summaries.mjs` or `backfill-apply.mjs` is alive, then one final drain |
| `finish-reconcile.sh` | waits for the primary reconcile to exit, rebuilds the known-hash set (`summaries.jsonl` + queue `done` + queue pending), re-runs the reconciler against it so **only** segments with no hash anywhere are summarised again, then drains to empty |

The known-hash set is what makes the tail cheap: a segment already admitted has
its `content_hash` in `summaries.jsonl` or the queue's `done` log, so it is
skipped; a segment whose enqueue failed has none, so it is exactly what gets
retried. Progress lands in `/home/varad/reconcile/finish.log`, and the tail
prints `retry rc=` and `finish complete pending=0` when it is done.

```bash
tail -f /home/varad/reconcile/apply2.log        # primary pass: progress N/918
tail -f /home/varad/reconcile/finish.log        # tail: retry + drain
tail -f /home/varad/drain-continuous.log        # per-batch drain output
```
