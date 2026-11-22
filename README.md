# dsh-cognee-memory

A DSH (DeepSeek Harness) Cordis plugin that gives agents **persistent memory
backed by Cognee** — a bounded `Known context:` block injected as data, explicit
remember/recall/forget/status tools, authoritative task-outcome write-back, a
memory-provenance side panel, and an authenticated settings page.

## Status: live-verified against Cognee 1.6.10-local

Version `0.2.0`. The REST adapter is verified against the real instance at
`http://10.20.10.15:8000/api/v1` (Cognee `1.6.10-local`, Postgres + pgvector,
`ENABLE_BACKEND_ACCESS_CONTROL=true`) and is installed in the real DSH
`0.2.1-rc.5` profile on CT 103. Every request/response shape in
[`src/adapters/cognee-paths.ts`](src/adapters/cognee-paths.ts) was observed, not
assumed:

- writes are multipart `/remember` calls addressed by **dataset UUID** (a
  `datasetName` the caller does not own would silently create a new dataset);
- ingestion completion is derived from `status/memory` +
  `status?pipeline=cognify_pipeline`, never from a 2xx;
- recall uses `/search` with `datasetIds`, a `maxRecallLatencyMs` budget, and
  degrades to no hits in `open` failure mode.

Evidence: [`docs/LIVE_INTEGRATION.md`](docs/LIVE_INTEGRATION.md) (commands,
redacted payloads, timings, E2E) and [`docs/TEST_RESULTS.md`](docs/TEST_RESULTS.md).

## Install, upgrade, rollback

The plugin mounts as one profile row; nothing in DSH itself is patched.

```bash
# install (a profile is any DSH profile name, e.g. `web`)
dsh plugin --profile web add ./dsh-cognee-memory-0.2.0.tgz
# restart the harness process once: the composed tree is read at boot
systemctl restart deepseek-harness        # or stop/start `dsh web` locally

# upgrade: install the newer tarball, restart the same way
dsh plugin --profile web add ./dsh-cognee-memory-0.3.0.tgz
systemctl restart deepseek-harness

# rollback: install the previous tarball and restart
dsh plugin --profile web add ./dsh-cognee-memory-0.1.0.tgz
systemctl restart deepseek-harness
```

State lives outside the package and survives install/upgrade/rollback:
`$DSH_HOME/plugins/cognee-memory/settings.json` (the settings page's file) and
`$DSH_HOME/plugins/cognee-memory/provenance.json` (bounded provenance metadata).
Delete either file to start that store empty. Credentials are never in either
file: the Cognee key and the settings token come from the environment
(`COGNEE_API_KEY`, `COGNEE_MEMORY_SETTINGS_TOKEN`).

## UI surfaces

| Surface | Where | Auth |
| --- | --- | --- |
| Settings page | `GET/POST /plugins/cognee-memory/settings` | settings token (`503` unset, `401` wrong) |
| Settings JSON | `GET /plugins/cognee-memory/settings.json` | settings token |
| Provenance JSON / page | `GET /plugins/cognee-memory/memory/<id>` (`?format=html` for the page) | settings token + recall scope policy; unauthorized ids are `404` |
| Memory list | `GET /plugins/cognee-memory/memories.json` | settings token + recall scope policy |
| Memory-provenance side panel | Right Sidebar tab type `cognee-memory.memory`, listed on the right Sidebar guide page | the token is entered in the panel and held in memory only |

Why these are the right extension points — and the exact client registration
API with installed-tree citations — is in
[`docs/UI_INTEGRATION.md`](docs/UI_INTEGRATION.md).

## Read first

- **[`docs/RESEARCH.md`](docs/RESEARCH.md)** — verified DSH 0.2.1-rc.5 plugin
  contract with `file:line` citations.
- **[`docs/COGNEE_DECISIONS.md`](docs/COGNEE_DECISIONS.md)** — Cognee API/auth
  decision matrix.
- **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)** — design, security model,
  roadmap.
- **[`docs/LIVE_INTEGRATION.md`](docs/LIVE_INTEGRATION.md)** — live verification
  and the CT 103 install/E2E record.
- **[`docs/SETTINGS.md`](docs/SETTINGS.md)** — the runtime-editable Cognee address:
  page URL, precedence, hot-reload matrix, and what is never exposed.
- **[`docs/WEB_PROFILE_VISIBILITY.md`](docs/WEB_PROFILE_VISIBILITY.md)** — why an
  installed plugin can be missing from the long-running `web` profile, and how to
  confirm it in one command.
- **[`docs/UI_INTEGRATION.md`](docs/UI_INTEGRATION.md)** — the installed DSH's
  client extension points, the side-panel verdict, and the security model of the
  provenance route.

## Runtime settings (no file editing, no restart for the address)

The plugin serves its own settings page through the only web extension point
0.2.1-rc.5 offers a package, `ctx.webServer.register`:

- `GET|POST /plugins/cognee-memory/settings` — HTML form (URL, optional MCP URL, enable toggle)
- `GET /plugins/cognee-memory/settings.json` — JSON status

Both require `COGNEE_MEMORY_SETTINGS_TOKEN` (`?token=...` or `Authorization: Bearer ...`)
and answer `503` when it is unset, so nothing is writable by default. Settings persist to
`$DSH_HOME/plugins/cognee-memory/settings.json` and outrank the environment, which
outranks the profile entry. A saved URL applies to the **next** memory call — the HTTP
client resolves the endpoint per request. The Cognee key is never stored, rendered, or
logged: the page shows only `set`/`unset` for `COGNEE_API_KEY`.


## What works today

| Area | Behavior |
| --- | --- |
| Plugin | ESM Cordis plugin: `name`, `inject = ['tools','systemPrompt']`, zod `Config` (Standard Schema), `apply()` |
| Tools | `memory_recall`, `memory_remember`, `memory_forget`, `memory_status` — verified registered and executed by a real DSH agent |
| Prompt | Per-agent `ctx.systemPrompt.context()` block, bounded by items/tokens, explicitly untrusted, injection-neutralized, silently degrades |
| Memory | Stable hashed scopes (session/agent/project/team/global), deny-by-default filtering, exact + near dedup, retention planning |
| Datasets | Create-if-missing by name, `ownerId` verified against `/users/me`, UUID cached and reused; no name-only writes |
| Ingestion | Polls memory + cognify pipeline status under `ingestion.timeoutMs` before a write is reported complete |
| Security | env-only tokens (`COGNEE_API_KEY`), header/endpoint redaction, pre-write credential rejection/redaction |
| Transports | Verified Cognee REST adapter; Streamable-HTTP MCP adapter kept as an unverified alternative |
| Tests | Vitest: 25 files / 209 unit tests + 8 live tests (`test/live`, skipped without `COGNEE_API_KEY`) |

## Build and test

Requires Node >= 22 and pnpm.

```bash
pnpm install
pnpm build       # strict tsc, ESM declarations to lib/
pnpm test        # vitest run — 25 files / 209 tests
pnpm typecheck   # tsc --noEmit
COGNEE_API_KEY=... npm run test:live   # real HTTP against the live backend
```

## Configuration sketch

```yaml
- insert:
    - id: cognee-memory
      name: dsh-cognee-memory
      config:
        enabled: true
        transport: rest
        apiBaseUrl: http://10.20.10.15:8000/api/v1
        authMode: api-key            # none | bearer | api-key
        apiTokenEnv: COGNEE_API_KEY
        failureMode: open            # open: prompt recall degrades; closed: surface errors
        scopeDefaults:
          projectId: dsh/project/e2e
        recall:
          searchType: CHUNKS         # CHUNKS 0.2 s / GRAPH_COMPLETION ~4-6 s
          maxRecallLatencyMs: 3000
        ingestion:
          timeoutMs: 180000
          pollMs: 500
```

Secrets are read **only** from the configured environment variable. On CT 103 the
key lives in `/etc/dsh/cognee.env` (mode 0600) referenced by a systemd drop-in,
never in YAML or git. Do not overwrite a profile's `cordis.patch.yml`; merge an
`insert:` entry instead (see `docs/RESEARCH.md` §7).

## Evidence

| Path | Contents |
| --- | --- |
| [`docs/RESEARCH.md`](docs/RESEARCH.md) | verified DSH plugin contract + open blockers |
| [`docs/COGNEE_DECISIONS.md`](docs/COGNEE_DECISIONS.md) | Cognee auth/API/ACL decision matrix |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | architecture + limitations |
| [`docs/LIVE_INTEGRATION.md`](docs/LIVE_INTEGRATION.md) | live probes, install path, E2E steps 10–13 |
| [`docs/TEST_RESULTS.md`](docs/TEST_RESULTS.md) | measured unit + live numbers |
| [`docs/research/`](docs/research/) | verbatim `--dump-config`, CLI help, patch schema, upstream docs |

## Roadmap

Remaining work is listed in `docs/ARCHITECTURE.md` §8; the near-term items are
prune/retention execution, a health endpoint for the UI, and prompt tuning on
real sessions.
