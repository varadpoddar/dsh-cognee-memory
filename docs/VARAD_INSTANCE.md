# `varad` userspace on CT 103 (2026-11-24)

A second, isolated DSH instance for OS user `varad`, sharing the Cognee backend
with the existing `dsh` instance but using its own Cognee principal and dataset
space. The existing `deepseek-harness.service` was not restarted or modified.

## Userspace and profiles

| Item | Value |
| --- | --- |
| OS user | `varad` (uid/gid 1000, home `/home/varad`, shell `nologin`) |
| DSH home | `/home/varad/.dsh` (owner `varad`) |
| Workspace | `/home/varad/workspace` |
| Plugin | `dsh-cognee-memory@1.0.2` installed from `/home/varad/dsh-cognee-memory-1.0.2.tgz` |
| Profiles | `web` (`base + web-app + plugin`) and `headless` (`base + headless`, plugin row inserted by patch) |

Installs ran as `su varad -s /bin/bash` (never root pnpm/plugin under a DSH
home). Config patches mirror the `dsh` deployment: local Qwen provider, model
default, Cognee REST at `http://10.20.10.15:8000/api/v1`, api-key auth.

## Cognee identity (varad-owned, not the `dsh` key)

- Registered via `POST /api/v1/auth/register`: **201**, user id
  `3b77c16c-a002-4da7-8760-39191eebac68`, email `varad@dsh.nomad.opsc.io`.
- `POST /api/v1/auth/login` → bearer token, then `POST /api/v1/auth/api-keys`
  created a **varad-owned API key** (no reuse of the `dsh` credential).
- Key + settings token live in `/etc/dsh-varad/varad.env` (mode 0640,
  `root:varad`; directory 0750). Account password for recovery is root-only at
  `/root/varad-cognee-credential` (0600).
- Verified: varad's key sees exactly **1** dataset, owned by
  `3b77c16c-…`; the 22 `dsh` datasets are not visible to it.

## Service

`deepseek-harness-varad.service` mirrors the `dsh` unit with `User=varad`,
`DSH_HOME=/home/varad/.dsh`, `ReadWritePaths=/home/varad`,
`EnvironmentFile=-/etc/dsh-varad/varad.env`, and
`dsh web --no-open --host 10.20.10.12 --port 3081 --public-url http://10.20.10.12:3081/`.
It is `enabled` and `active`, listening on `10.20.10.12:3081`.

## Verification

| Check | Result |
| --- | --- |
| Existing `deepseek-harness.service` | `active` / `running`, MainPID unchanged (133336) |
| Existing unit + web patch mtimes | unchanged (`2026-11-18`, `2026-11-23`); `dsh` profiles untouched |
| Settings page + `settings.json` with token | **200** / **200** |
| Headless turn via local Qwen | completed (model answered) |
| `memory_status` | `reachable: true`; namespaces `user: dsh-user-3b77c16c-a002-…` and `project: dsh-project-varad-mac-history-5c5a11e6b8d6859e32a4` |

`memory_status` prints the plugin's static token-source string
`/etc/dsh/cognee.env`; for this instance the token actually comes from
`/etc/dsh-varad/varad.env`. Cosmetic plugin text only.

## Mac-history import into varad's scope

Source ledger: `/tmp/dsh-backfill-home/plugins/cognee-memory/ledger.jsonl`
(9 Mac-origin records) → `/tmp/bundle-varad-mac.jsonl`.

| Step | Result |
| --- | --- |
| Dry run | records 9, imported 9, deduplicated 0, conflicts 0, refused 0 |
| Apply | 9 imported, target `project:varad/mac-history` (`--principal varad`, `--allow-scope project:varad/mac-history`) |
| Dataset | `dsh-project-varad-mac-history-5c5a11e6b8d6859e32a4`, 9 data records, owner `3b77c16c-…`, `ready`/`searchable` |
| Re-apply | imported 0, deduplicated 9 |

Scope mapping: source `project:varad/mac-backfill-6a6d3597542f8c736a35` →
target `project:varad/mac-history-5c5a11e6b8d6859e32a4` (bundle's own scope is
provenance only; the importer never adopts it).

## First-turn recall proof

Fresh `varad` headless process, **one** message, a patch with `tools.enabled:
false` and every built-in tool disabled:

- Question: "What is the deployment release codename and its target for this
  project? Reply with the values only."
- `tool_call` events: **0**.
- The fact first appears in the step-1 `thinking` event: "From the known
  context: 'The release codename for this deploy is amber-otter-7731, and the
  target is CT 103'…".
- Final: `amber-otter-7731 / CT 103`.

Evidence: `/home/varad/first-turn.jsonl` on CT 103 (and
`/home/varad/patch-no-tools.yml`).

## 2026-11-24 (later): 1.0.4, turn journal, scope alignment

- `dsh.nomad.opsc.io` now serves this instance: unit takes
  `--public-url https://dsh.nomad.opsc.io/ --trusted-host dsh.nomad.opsc.io`,
  nftables admits 3081 from Traefik only, Traefik upstream is `10.20.10.12:3081`.
  Verified by token ownership (varad 200 / dsh 401).
- Plugin 1.0.4 is installed in **both** profiles (`web`, `headless`), and
  `ingestion.journal.enabled: true` is set in both: every conversation part
  (user + agent) becomes a durable task, ingested by the 04:00 drain and deleted
  only after a complete ingest (`docs/TURN_JOURNAL.md`).
- Scope bug fixed: the `web` profile pointed at `varad/project/e2e`
  (`dsh-project-varad-project-e2e-d5ebb55aad47c7723684`) while the backfilled
  history is in `dsh-project-varad-mac-history-5c5a11e6b8d6859e32a4`. Both
  profiles now name `projectId: varad/mac-history`, so the public GUI recalls the
  backfilled corpus.
- Live proof: one headless turn produced 2 pending tasks, `queue drain --apply`
  ingested both (`ok 2`, 11.2 s) and pruned them; the queue then held only one
  permanent failure (`403` URL-leading payload, attempts 6, `permanent: true`).

