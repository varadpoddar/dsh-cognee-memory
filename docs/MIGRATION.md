# Migration — 0.2.1 → 1.0.x

The 1.0.1 release changes packaging and operations, not memory semantics. An
existing 0.2.1 install upgrades by replacing the profile dependency; no data
migration, re-indexing, or config rewrite is required.

## What changed for an operator

| Area | 0.2.1 | 1.0.x |
|---|---|---|
| Install shape | profile row inserts the plugin directly | npm package declaring `dsh.bundle` → `./cordis.patch.yml`, installable as its own profile layer |
| Settings | profile config / env only | authenticated settings page with a stored file, retargeting the live adapter without a restart |
| Ledger | append-only JSONL, same path and shape | unchanged (new entries only: import conflict annotations, `conflictOf`) |
| Backup | none | `scripts/backup*.sh`, `verify-backup.sh`, `restore-drill.sh`; `pg_dumpall` (not `pg_dump`) |
| Permissions | implicit | pinned: `/etc/dsh/*.env` `0640 root:dsh`, `$DSH_HOME` owned by `dsh` |
| Plugin id / config keys | `cognee-memory` | **same id and keys** — no renames |

No config key was renamed between 0.2.1 and 1.0.x. New optional keys (`prompt`,
`prefetch`, `retrieval`, `taskMemory`, `outbox`, `dedup`, `retention`,
`security`, `tools`, `telemetry`) have defaults, so an old config keeps working.

## Profile entry

```yaml
- insert:
    - id: cognee-memory
      name: dsh-cognee-memory
      config:
        enabled: true
        transport: rest
        apiBaseUrl: http://<cognee-host>:8000/api/v1
        authMode: api-key
        apiTokenEnv: COGNEE_API_KEY
        failureMode: open
        scopeDefaults:
          projectId: <project>
```

Install the layer as the service user (never root) and restart:

```bash
su dsh -s /bin/bash -c 'DSH_HOME=/var/lib/deepseek-harness/.dsh \
  dsh plugin --profile web add /path/dsh-cognee-memory-1.0.1.tgz'
systemctl restart deepseek-harness
systemctl show -p SubState deepseek-harness.service    # running
```

## Bundle metadata

`package.json` now declares:

```json
"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
```

Without it the plugin installs but never composes as a layer (no tools, no
settings page). This was incident #3 in `docs/REGRESSION_MATRIX.md`. A consumer
install can verify it with:

```bash
node -p "require('dsh-cognee-memory/package.json').dsh.bundle"
# { patch: './cordis.patch.yml' }
```

## Settings file

Stored settings live at `$DSH_HOME/plugins/cognee-memory/settings.json`
(override with `COGNEE_MEMORY_SETTINGS_FILE`). Precedence is stored > environment
(`COGNEE_MEMORY_API_BASE_URL`, `COGNEE_MEMORY_MCP_URL`, `COGNEE_MEMORY_ENABLED`,
`COGNEE_MEMORY_AUTO_RECALL`, `COGNEE_MEMORY_AUTO_WRITE`) > profile/default. The
file is created on first save; an upgrade does not create or rewrite it.

## Ledger

`$DSH_HOME/plugins/cognee-memory/ledger.jsonl` (override `COGNEE_MEMORY_LEDGER_FILE`).
Append-only JSONL; 1.0.x only appends new entry kinds (`conflict` annotations with
`conflictOf`, import provenance), so an existing ledger is read as-is. Back it up
with the DSH half (`docs/BACKUP.md`); it is **not** rebuilt from Cognee, and there
is no lossless reconstruct for records whose source messages were pruned — see
the eight ledger-only datasets in `docs/RECOVERY_MANIFEST.md`.

## Cognee compatibility

Verified against **Cognee 1.6.10-local** (`GET /health/detailed` →
`"version":"1.6.10-local"`), spec document version `1.0.0` (not the product
version — see `docs/COMPATIBILITY.md`). The plugin uses `/api/v1` REST
(datasets, add, cognify, search with `CHUNKS`, recall, forget, status) plus
optional MCP transports. No support claim is made for other Cognee versions:
check the endpoint table in `docs/COMPATIBILITY.md` before upgrading Cognee, and
run one recall after the upgrade.

COGX import/export is a **Python/CLI-side** capability without an HTTP endpoint;
importing a COGX archive does not guarantee vector coverage (incident #9).
After any import, verify with a real recall rather than trusting the job status.

## Upgrade and downgrade

Upgrade: back up first (`scripts/backup-all.sh`), replace the tarball, restart,
then confirm one headless recall answers the fixture. Downgrade: reinstall the
0.2.1 tarball, restart; the ledger and Cognee data stay readable (new entry
kinds are ignored by older code). What is *not* migrated: dataset scope ids are
derived from raw scope ids, so changing `scopeDefaults` points at a different
dataset; settings saved in 1.0.x are not read by 0.2.1; backups are not
downgraded.
