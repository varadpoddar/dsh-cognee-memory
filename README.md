# dsh-cognee-memory

A DSH (DeepSeek Harness) Cordis plugin that gives agents **persistent memory
backed by Cognee**. It injects a bounded `Known context:` block into the system
prompt (memory as data, never instructions), exposes
`memory_recall` / `memory_remember` / `memory_forget` / `memory_status` tools,
writes explicit facts and task outcomes back automatically, serves an
authenticated settings page, and ships a memory-provenance side panel.

Version **1.0.0** — verified against DSH `0.2.1-rc.5` and Cognee
`1.6.10-local` on CT 103. No DSH core patch is needed.

```text
Known context:
- The maintenance window for this project is 03:00-04:00 UTC. · project · 2026-11-22
```

## What it does

- **First-turn recall without a tool call.** A bounded prefetch starts when the
  agent claims the user message, so the first model response already sees
  relevant memory. The two-layer coordinator reserves at least half of the item
  budget for question-specific hits, so stable context cannot crowd out a fact
  the user just asked about.
- **Bounded prompt overhead.** Stable layer ≤ 300 tokens, query layer ≤ 900,
  combined ≤ 1200 tokens, at most 8 items, and a 1500 ms wall-clock budget per
  turn (`retrieval.*` in the config). Oversized memories are dropped whole,
  never split.
- **Explicit memory tools.** Scoped remember/recall/forget plus a status
  snapshot; deny-by-default scope policy; exact + near duplicate suppression.
- **Automatic writes.** An explicit fact stated in a user message is extracted
  and ingested; committed task outcomes are written back. A durable outbox
  survives process exit.
- **Operator surfaces.** Authenticated settings page, provenance JSON/HTML per
  memory, memory list, and a right-sidebar provenance panel.

## Install

Prerequisites: Node **>= 22**, DSH `0.2.1-rc.5`, and a reachable Cognee instance
(REST, with access control on). The plugin mounts as one profile row; nothing in
DSH itself is patched.

```bash
# from the repo
npm pack                                  # → dsh-cognee-memory-1.0.0.tgz

# install into a profile (here: web); a profile is initialized on first use
dsh plugin --profile web add ./dsh-cognee-memory-1.0.0.tgz

# the composed plugin tree is read at boot — restart once
systemctl restart deepseek-harness        # or stop/start `dsh web` locally
```

For the exact CT 103 procedure (service account, env files, verification), see
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

## Configure

Configuration resolves in this order: **settings page > environment > profile
entry**. Credentials are read only from the environment; they are never stored
in the settings file, rendered on the page, or written to the provenance index.

| Variable | Purpose |
| --- | --- |
| `COGNEE_API_KEY` | Cognee API key (required for REST) |
| `COGNEE_MEMORY_API_BASE_URL` | Cognee base URL override, e.g. `http://cognee.internal:8000/api/v1` |
| `COGNEE_MEMORY_ENABLED` | `true`/`false` master switch |
| `COGNEE_MEMORY_AUTO_RECALL` | prefetch + prompt injection on/off |
| `COGNEE_MEMORY_AUTO_WRITE` | extraction / task-outcome write-back on/off |
| `COGNEE_MEMORY_MCP_URL` | optional MCP transport URL |
| `COGNEE_MEMORY_SETTINGS_TOKEN` | operator token for the settings/provenance routes |
| `COGNEE_MEMORY_SETTINGS_FILE` | override the settings JSON path |
| `COGNEE_MEMORY_PROVENANCE_FILE` | override the provenance JSON path |

On CT 103 the Cognee key lives in `/etc/dsh/cognee.env`, loaded by a systemd
drop-in, mode **0640 root:dsh** — never in YAML, the repo, or a shell history.
See [`docs/SETTINGS.md`](docs/SETTINGS.md) for precedence and hot-reload rules.

Minimal profile entry:

```yaml
- insert:
    - id: cognee-memory
      name: dsh-cognee-memory
      config:
        enabled: true
        transport: rest
        apiBaseUrl: http://cognee.internal:8000/api/v1
        authMode: api-key
        apiTokenEnv: COGNEE_API_KEY
        failureMode: open            # prompt recall degrades instead of failing turns
        scopeDefaults:
          projectId: dsh/project/e2e
        recall:
          searchType: CHUNKS         # CHUNKS ~0.2 s; GRAPH_COMPLETION ~4–6 s
        retrieval:
          stableTokens: 300
          queryTokens: 900
          maxItems: 8
          budgetMs: 1500
```

### Settings page

`GET|POST /plugins/cognee-memory/settings` (HTML) and
`GET /plugins/cognee-memory/settings.json` (JSON) require the operator token as
`?token=...` or `Authorization: Bearer ...`. An unset token answers `503`, a
wrong token `401`. A saved Cognee URL applies to the next memory call; no
restart is needed for the address alone.

## Operator CLI

The package ships a `memory` bin (run it from an installed profile):

```bash
DSH_HOME=/var/lib/deepseek-harness/.dsh \
  node <profile>/node_modules/dsh-cognee-memory/lib/cli/main.js <command> ...
```

`import-history` backfills existing local conversation history:

```bash
memory import-history --scope project:<rawId> [--session <id>] [--state-file <path>] [--apply]
```

It is a dry run unless `--apply` is passed. The dry run reports scanned
sessions/messages, candidate counts by operation, date range, target namespace,
and redaction/skip counts without writing. Extraction reuses the live M3 policy:
committed direct `user/message` text only, deterministic explicit commands
(`remember …`, `forget …`, `actually …`) only, never whole transcripts and never
hidden reasoning. Secrets are blocked before a write. Apply is idempotent and
resumable through a state file keyed by the extraction idempotency key and the
source ref (session id + message index); candidates are applied in timestamp
order so a later correction supersedes the earlier fact.

Bundles move records between instances or applications:

```bash
memory export --scope project:<rawId> --out bundle.jsonl
memory import --in bundle.jsonl --scope project:<rawId> [--allow-scope project:<rawId>] [--apply]
```

Export takes provenance, semantic keys, confidence, timestamps, and source refs;
a record that still contains a credential is refused rather than exported.
Import is a dry run unless `--apply` is passed, dedupes on the semantic key in
the target scope (re-import reports 0 new records), and marks a different fact
under an existing key as a conflict annotation instead of overwriting it. The
target scope must be in the deployment's writable set or explicitly granted with
`--allow-scope`; the scope a bundle claims is provenance only.

## Upgrade

```bash
dsh plugin --profile web add ./dsh-cognee-memory-<newer>.tgz
systemctl restart deepseek-harness
```

State lives outside the package and survives upgrades:
`$DSH_HOME/plugins/cognee-memory/settings.json` and
`$DSH_HOME/plugins/cognee-memory/provenance.json`. Delete either file to start
that store empty.

## Rollback

Stop the service, remove the plugin (or reinstall the previous tarball), restore
the profile backup, and restart. Full triggers and commands:
[`ROLLBACK.md`](ROLLBACK.md).

## Uninstall

```bash
dsh plugin --profile web remove dsh-cognee-memory
systemctl restart deepseek-harness
# optional: remove operator state and the credential
rm -rf /var/lib/deepseek-harness/.dsh/plugins/cognee-memory
rm -f /etc/dsh/cognee.env /etc/systemd/system/deepseek-harness.service.d/cognee.conf
systemctl daemon-reload && systemctl restart deepseek-harness
```

## Security notes

- **Memory is data, never instructions.** Recalled text is sanitized,
  one-line-bounded, tagged with scope and date, and covered by a system-prompt
  policy section. A hostile memory cannot close the block or change the rules.
- **Credentials are env-only.** `COGNEE_API_KEY` and the settings token are
  read from the process environment. `/etc/dsh/*.env` must be `0640 root:dsh`;
  the repo contains no secrets (verified by the redaction/secret tests).
- **Scope isolation is deny-by-default.** Every read passes the access policy;
  foreign dataset ids in a backend response are dropped, and unauthorized
  provenance ids answer a generic `404`.
- **Prompt budget is a hard cap.** The 1200-token/8-item block is enforced by
  whole-item budgeting; a slow backend degrades to no context rather than
  stalling the turn.
- **Fixtures are read-only.** The evaluation fixtures
  (`3d8d8ad8-41be-59c3-9310-7915c783e5ef`, codeword `amber-otter-7731`) are
  never modified or deleted by the plugin or its tests.

## Architecture (text)

```text
DSH agent turn
  │
  ├─ agent/inbox/claimed ──► TurnPrefetch (bounded, 1500 ms)
  │                              │
  │                              ▼
  │                     RetrievalCoordinator
  │                     ├─ stable layer: scope-derived query, 300 tokens, cached
  │                     ├─ query layer : real first user message, 900 tokens
  │                     └─ item reservation: query keeps ceil(maxItems/2) slots
  │                              │  whole-item budgeting, 8 items, 1200 tokens
  │                              ▼
  │                     RecallService.safeRecall ──► AccessPolicy (deny by default)
  │                              │
  │                              ▼
  │                     CogneeRestAdapter ──► Cognee REST /api/v1 (CHUNKS)
  │                              │              dataset-per-scope, EBAC
  │                              ▼
  └─ system-prompt/assemble ── "Known context:" block (data, not instructions)

Tools  memory_remember / memory_recall / memory_forget / memory_status
Write  extraction + task-outcome → candidate queue → durable outbox → Cognee
UI     settings page · provenance JSON/HTML · right-sidebar provenance panel
```

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Model calls return `401` (Studio/LLM) | Stale Studio key. Refresh `/etc/dsh/llm.env` from the key host (`ssh root@llm-host 'cat /root/.studio.key'`), keep it `0640 root:dsh`, restart the service. Web-profile sessions can also re-enter the provider key in the UI. |
| `permission denied` reading an env file, or service starts without the key | Env files must be `0640 root:dsh` (`install -o root -g dsh -m 0640 …`). systemd reads them as root before dropping to `User=dsh`. |
| Plugin installed but not mounted / tools missing | The composed tree is read at boot: `systemctl restart deepseek-harness`. Also confirm you installed into the service profile (`--profile web` with `DSH_HOME=/var/lib/deepseek-harness/.dsh`), not root's `/root/.dsh`. |
| Settings page returns `503` | `COGNEE_MEMORY_SETTINGS_TOKEN` is unset in the service environment. |
| Settings page returns `401` | Wrong/missing `?token=` or bearer token; the token is compared in constant time. |
| Recall finds nothing / prefetch block missing | Cognee unreachable or the scope is empty: check `memory_status`, the Cognee `/health`, and the project scope id. `failureMode: open` degrades quietly by design. |
| One fact is missing from the first response while older context appears | Check the item budget in `memory_status` (`memory.context.consumed`); the query layer is reserved half the slots in 1.0.0. |
| Upgraded but behavior unchanged | Restart was skipped, or the profile still pins the old tarball — `dsh plugin --profile web why dsh-cognee-memory`. |

## Build and test

```bash
npm ci
npm run build        # strict tsc + client bundle
npm test             # vitest: 45 files / 454 tests
npm run typecheck
npm run test:live    # real backend, skipped without COGNEE_API_KEY
```

## Evidence

| Path | Contents |
| --- | --- |
| [`docs/EVALUATION.md`](docs/EVALUATION.md) | Milestone 11 evaluation + the 1.0.0 ranking-fix before/after |
| [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) | exact CT 103 install/upgrade/verify commands |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | design, verified host contract, limitations |
| [`docs/SETTINGS.md`](docs/SETTINGS.md) | settings precedence and routes |
| [`docs/LIVE_INTEGRATION.md`](docs/LIVE_INTEGRATION.md) | live probes and observed Cognee shapes |
| [`docs/TEST_RESULTS.md`](docs/TEST_RESULTS.md) | measured unit + live numbers |
| [`CHANGELOG.md`](CHANGELOG.md) | milestones and release history |
| [`ROLLBACK.md`](ROLLBACK.md) | rollback runbook |
| [`docs/PR.md`](docs/PR.md) | prepared 1.0.0 pull-request description |

Remaining near-term items (retention execution, health endpoint, prompt tuning)
are listed in `docs/ARCHITECTURE.md` §8.
